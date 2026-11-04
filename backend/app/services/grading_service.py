import json
import re

from groq import Groq

from app.core.config import settings

try:
    GROQ_CLIENT = Groq(api_key=settings.GROQ_API_KEY) if settings.GROQ_API_KEY else None
except Exception:
    GROQ_CLIENT = None


def _extract_json_block(text: str) -> str:
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        return match.group(0)
    return text


def grade(submission_text: str, rubric: list) -> dict:
    criteria = [item for item in rubric if isinstance(item, dict)]
    max_score = 0.0
    for item in criteria:
        try:
            max_score += max(0.0, float(item.get("max_points", 0) or 0))
        except (TypeError, ValueError):
            continue
    if not criteria:
        criteria = [{"criterion": "Overall quality", "max_points": 100}]
        max_score = 100

    if GROQ_CLIENT is None:
        return {
            "total_score": 0,
            "max_score": max_score,
            "breakdown": [],
            "general_feedback": "AI grading is temporarily unavailable due to model client configuration.",
        }

    system_prompt = (
        "You are a fair, strict academic grader. Grade the student's full submission once against the "
        "provided rubric. Award credit only for demonstrated understanding, while accepting correct "
        "alternative approaches. Return only valid JSON, with no Markdown. Use each rubric criterion's "
        "exact name and maximum points. Include concise evidence and specific missing elements for each criterion. "
        "Set total_score to the sum of criterion scores. Rate conceptual depth from 1 to 5 and choose one label: "
        "surface, understanding, applied, analytical, or evaluative. Required shape: "
        '{"total_score":0,"max_score":100,"breakdown":[{"criterion":"name","score":0,'
        '"max_points":10,"feedback":"specific comment","evidence":[],"missing":[]}],'
        '"depth_score":1,"depth_label":"surface","general_feedback":"summary"}'
    )
    user_prompt = (
        f"Rubric: {json.dumps(criteria, ensure_ascii=False)}\n\n"
        f"Student submission:\n{submission_text}"
    )

    completion = GROQ_CLIENT.chat.completions.create(
        model=settings.GROQ_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.1,
    )

    content = (completion.choices[0].message.content or "").strip()
    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        result = json.loads(_extract_json_block(content))
    if not isinstance(result, dict):
        raise ValueError("The grader returned a non-object JSON response")

    returned = result.get("breakdown") if isinstance(result.get("breakdown"), list) else []
    returned_by_name = {
        str(item.get("criterion") or item.get("topic") or "").strip().casefold(): item
        for item in returned
        if isinstance(item, dict)
    }
    normalized_breakdown = []
    for index, criterion in enumerate(criteria):
        name = str(criterion.get("criterion") or criterion.get("topic") or f"Criterion {index + 1}").strip()
        try:
            points = max(0.0, float(criterion.get("max_points", 0) or 0))
        except (TypeError, ValueError):
            points = 0.0
        item = returned_by_name.get(name.casefold())
        if item is None and index < len(returned) and isinstance(returned[index], dict):
            item = returned[index]
        try:
            score = float((item or {}).get("score", 0) or 0)
        except (TypeError, ValueError):
            score = 0.0
        normalized_breakdown.append({
            "topic": name,
            "criterion": name,
            "score": round(max(0.0, min(points, score)), 2),
            "max_points": points,
            "feedback": str((item or {}).get("feedback") or "").strip(),
            "evidence": [str(value).strip() for value in (item or {}).get("evidence", []) if str(value).strip()]
            if isinstance((item or {}).get("evidence", []), list) else [],
            "missing": [str(value).strip() for value in (item or {}).get("missing", []) if str(value).strip()]
            if isinstance((item or {}).get("missing", []), list) else [],
        })

    score_sum = sum(item["score"] for item in normalized_breakdown)
    try:
        depth_score = max(1.0, min(5.0, float(result.get("depth_score", 1) or 1)))
    except (TypeError, ValueError):
        depth_score = 1.0
    depth_label = str(result.get("depth_label", "surface")).strip().lower()
    if depth_label not in {"surface", "understanding", "applied", "analytical", "evaluative"}:
        depth_label = "surface"

    return {
        "total_score": round(score_sum, 2),
        "max_score": max_score,
        "breakdown": normalized_breakdown,
        "depth_score": depth_score,
        "depth_label": depth_label,
        "general_feedback": str(result.get("general_feedback") or "").strip(),
    }
