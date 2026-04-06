import json
import re

import requests
from sqlalchemy.orm import Session, joinedload

from app.core.config import settings
from app.models.benchmark import Benchmark
from app.models.course import Course
from app.models.evaluation import Evaluation
from app.models.project import Project
from app.models.project_submission import ProjectSubmission
from app.services.rag_service import retrieve_course_context


def _extract_json_block(text: str) -> str:
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        return match.group(0)
    return text


def _clamp_score(value: float | int | None) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(100.0, round(numeric, 2)))


def _call_groq_json(messages: list[dict[str, str]]) -> dict:
    api_key = (settings.GROQ_API_KEY or "").strip()
    if not api_key:
        raise RuntimeError("Groq API key is not configured")

    response = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": settings.GROQ_MODEL,
            "messages": messages,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        },
        timeout=60,
    )
    response.raise_for_status()

    payload = response.json()
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not choices:
        raise ValueError("Groq response did not include choices")

    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = str(message.get("content") if isinstance(message, dict) else "").strip()
    if not content:
        raise ValueError("Groq response was empty")

    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return json.loads(_extract_json_block(content))


def _select_applicable_benchmarks(benchmarks: list[Benchmark], stage: int) -> list[Benchmark]:
    applicable = [item for item in benchmarks if item.expected_stage <= stage]
    return applicable or benchmarks


def _build_prompt(
    project: Project,
    submission: ProjectSubmission,
    previous_submission: ProjectSubmission | None,
    benchmarks: list[Benchmark],
    course_context: list[str],
) -> list[dict[str, str]]:
    benchmark_payload = [
        {
            "title": item.title,
            "description": item.description,
            "weight": item.weight,
            "expected_stage": item.expected_stage,
        }
        for item in benchmarks
    ]
    context_text = "\n\n".join(course_context) if course_context else "No relevant course material retrieved."
    previous_text = previous_submission.submission_text if previous_submission else "No previous submission."

    system_prompt = (
        "You are a strict academic project evaluator.\n"
        "Evaluate the current submission against the project brief and active benchmarks.\n"
        "Be objective and conservative. Do not inflate scores.\n"
        "Drift must be true when the submission is materially diverging from the project topic.\n"
        "Return only valid JSON with this exact shape:\n"
        "{\n"
        '  "alignment_score": number,\n'
        '  "benchmark_scores": [{"title": "string", "score": number}],\n'
        '  "progress_score": number,\n'
        '  "final_score": number,\n'
        '  "drift": boolean,\n'
        '  "feedback": "string"\n'
        "}\n"
        "Rules:\n"
        "- Every benchmark title must match exactly one provided benchmark title.\n"
        "- Scores must be between 0 and 100.\n"
        "- progress_score must be 0 when no previous submission exists.\n"
        "- final_score must still be provided, even though the backend will recompute it.\n"
        "- Feedback must be actionable, specific, and mention strengths plus the most important gaps."
    )

    user_prompt = json.dumps(
        {
            "project": {
                "title": project.title,
                "description": project.description,
                "course_id": project.course_id,
            },
            "current_submission": {
                "stage": submission.stage,
                "submission_text": submission.submission_text,
            },
            "previous_submission": {
                "stage": previous_submission.stage,
                "submission_text": previous_submission.submission_text,
            }
            if previous_submission
            else None,
            "active_benchmarks": benchmark_payload,
            "course_material_context": context_text,
        },
        ensure_ascii=True,
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
        {
            "role": "user",
            "content": (
                "Relevant previous submission for progress comparison:\n"
                f"{previous_text}\n\n"
                "Now produce the evaluation JSON."
            ),
        },
    ]


def _validate_benchmark_scores(payload: list, benchmarks: list[Benchmark]) -> list[dict[str, float | str]]:
    if not isinstance(payload, list):
        raise ValueError("benchmark_scores must be a list")

    benchmark_map = {item.title: item for item in benchmarks}
    normalized: list[dict[str, float | str]] = []

    for item in payload:
        if not isinstance(item, dict):
            raise ValueError("Each benchmark score must be an object")
        title = str(item.get("title", "")).strip()
        if title not in benchmark_map:
            raise ValueError(f"Unexpected benchmark title: {title}")
        normalized.append(
            {
                "title": title,
                "score": _clamp_score(item.get("score")),
            }
        )

    if len(normalized) != len(benchmarks):
        raise ValueError("benchmark_scores count did not match active benchmarks")

    seen_titles = {str(item["title"]) for item in normalized}
    if seen_titles != set(benchmark_map):
        raise ValueError("benchmark_scores titles did not match active benchmarks")

    return normalized


def _weighted_benchmark_score(benchmark_scores: list[dict[str, float | str]], benchmarks: list[Benchmark]) -> float:
    benchmark_map = {item.title: item for item in benchmarks}
    total_weight = sum(max(float(item.weight), 0.0) for item in benchmarks)
    if total_weight <= 0:
        raise ValueError("Benchmark weights must sum to more than 0")

    weighted_total = 0.0
    for score_row in benchmark_scores:
        benchmark = benchmark_map[str(score_row["title"])]
        weighted_total += float(score_row["score"]) * float(benchmark.weight)
    return _clamp_score(weighted_total / total_weight)


def evaluate_submission(
    db: Session,
    submission: ProjectSubmission,
) -> Evaluation:
    project = (
        db.query(Project)
        .options(joinedload(Project.benchmarks), joinedload(Project.course))
        .filter(Project.id == submission.project_id)
        .first()
    )
    if not project:
        raise ValueError("Project not found")
    if not isinstance(project.course, Course):
        raise ValueError("Project course not found")

    if not project.benchmarks:
        raise ValueError("Project has no benchmarks configured")

    active_benchmarks = _select_applicable_benchmarks(list(project.benchmarks), submission.stage)
    previous_submission = (
        db.query(ProjectSubmission)
        .filter(
            ProjectSubmission.project_id == submission.project_id,
            ProjectSubmission.student_id == submission.student_id,
            ProjectSubmission.id != submission.id,
        )
        .order_by(ProjectSubmission.stage.desc(), ProjectSubmission.created_at.desc(), ProjectSubmission.id.desc())
        .first()
    )

    rag_query = "\n\n".join(
        part
        for part in [
            project.title,
            project.description,
            submission.submission_text,
            previous_submission.submission_text if previous_submission else "",
        ]
        if part
    )
    course_context = retrieve_course_context(project.course_id, rag_query, max_chunks=6)
    llm_payload = _call_groq_json(
        _build_prompt(project, submission, previous_submission, active_benchmarks, course_context)
    )

    required_fields = {
        "alignment_score",
        "benchmark_scores",
        "progress_score",
        "final_score",
        "drift",
        "feedback",
    }
    if not required_fields.issubset(llm_payload):
        missing = sorted(required_fields.difference(llm_payload))
        raise ValueError(f"Evaluation response missing fields: {', '.join(missing)}")

    benchmark_scores = _validate_benchmark_scores(llm_payload.get("benchmark_scores"), active_benchmarks)
    alignment_score = _clamp_score(llm_payload.get("alignment_score"))
    progress_score = _clamp_score(llm_payload.get("progress_score")) if previous_submission else 0.0
    benchmark_score = _weighted_benchmark_score(benchmark_scores, active_benchmarks)
    feedback = str(llm_payload.get("feedback", "")).strip()
    if not feedback:
        raise ValueError("Evaluation response feedback was empty")

    if previous_submission:
        final_score = _clamp_score(
            (0.5 * benchmark_score) + (0.3 * alignment_score) + (0.2 * progress_score)
        )
    else:
        final_score = _clamp_score((0.7 * benchmark_score) + (0.3 * alignment_score))

    evaluation = Evaluation(
        project_id=project.id,
        submission_id=submission.id,
        student_id=submission.student_id,
        alignment_score=alignment_score,
        benchmark_score=benchmark_score,
        benchmark_scores=benchmark_scores,
        progress_score=progress_score,
        final_score=final_score,
        drift=bool(llm_payload.get("drift")),
        feedback=feedback,
        raw_response=llm_payload,
    )
    db.add(evaluation)
    db.flush()
    return evaluation
