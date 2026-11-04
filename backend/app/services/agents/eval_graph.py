"""Phase 4 LangGraph evaluation pipeline.

The graph deliberately keeps provider-specific calls behind small helpers so
the worker can retry the complete evaluation on Groq rate limits. When the
optional LangGraph package is unavailable, the same nodes execute sequentially
as a compatibility fallback; rebuilding the backend enables the real graph.
"""

from __future__ import annotations

import json
import hashlib
import logging
import math
import re
import threading
import time
from collections import deque
from contextlib import contextmanager
from typing import Any, Callable

from pydantic import BaseModel, Field, ValidationError

from app.core.config import settings
from app.services.agents.state import EvaluationState
from app.services.rag_service import CHROMA_CLIENT, MODEL, _encode_texts

logger = logging.getLogger("vidyaranya.evaluation")
MAX_GROQ_USER_CHARS = 12000
SUBMISSION_CHUNK_CHARS = 4500
SUBMISSION_CHUNK_OVERLAP = 350
GROQ_ESTIMATED_TPM_BUDGET = 6500
_GROQ_TOKEN_RESERVATIONS: deque[tuple[float, int]] = deque()
_GROQ_RATE_LIMIT_LOCK = threading.Lock()
_INTEGRITY_INDEX_LOCK = threading.Lock()
_REDIS_LOCK_CLIENT: Any | None = None
_REDIS_LOCK_CLIENT_GUARD = threading.Lock()

try:
    from langgraph.graph import END, StateGraph
except ImportError:  # pragma: no cover - used before the image is rebuilt
    END = "__end__"
    StateGraph = None

try:
    from groq import Groq
except ImportError:  # pragma: no cover
    Groq = None

try:
    import redis
except ImportError:  # pragma: no cover
    redis = None


@contextmanager
def _assignment_integrity_lock(assignment_id: str):
    """Use Redis across processes when configured, otherwise serialize locally."""
    global _REDIS_LOCK_CLIENT
    with _INTEGRITY_INDEX_LOCK:
        if redis is None or settings.QUEUE_MODE == "in_process":
            yield
            return

        lock = None
        acquired = False
        redis_unavailable = False
        try:
            if _REDIS_LOCK_CLIENT is None:
                with _REDIS_LOCK_CLIENT_GUARD:
                    if _REDIS_LOCK_CLIENT is None:
                        _REDIS_LOCK_CLIENT = redis.Redis.from_url(
                            settings.REDIS_URL,
                            socket_connect_timeout=3,
                            socket_timeout=5,
                        )
            lock = _REDIS_LOCK_CLIENT.lock(
                f"vidyaranya:plagiarism:{assignment_id}",
                timeout=300,
                blocking_timeout=10,
                sleep=0.2,
                thread_local=False,
            )
            acquired = bool(lock.acquire(blocking=True))
        except Exception as exc:
            redis_unavailable = True
            logger.warning(
                "Redis integrity lock unavailable (%s); using this process's lock for assignment %s",
                exc.__class__.__name__,
                assignment_id,
            )
        if lock is not None and not acquired and not redis_unavailable:
            # A reachable Redis lock held by another process must not be bypassed.
            raise TimeoutError(f"Timed out waiting for plagiarism lock for assignment {assignment_id}")
        try:
            yield
        finally:
            if acquired and lock is not None:
                try:
                    # Redis verifies the token, so this cannot release another process's lock.
                    lock.release()
                except Exception:
                    logger.warning("Could not release Redis integrity lock for assignment %s", assignment_id)


class TopicCoverage(BaseModel):
    topic: str
    score: float = Field(ge=0, le=10)
    evidence: list[str] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)


class TopicCoverageList(BaseModel):
    topics: list[TopicCoverage] = Field(default_factory=list)


class BloomDepth(BaseModel):
    score: float = Field(default=1, ge=1, le=5)
    label: str = "surface"


def _client():
    if Groq is None or not settings.GROQ_API_KEY:
        return None
    return Groq(api_key=settings.GROQ_API_KEY)


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    try:
        value = json.loads(cleaned)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
        if not match:
            return {}
        try:
            value = json.loads(match.group(0))
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}


def _reserve_groq_token_budget(system: str, user: str) -> None:
    """Pace this worker below the observed provider TPM ceiling."""
    # Character-based estimate reserves room for the model's JSON response.
    estimated_tokens = math.ceil((len(system) + len(user)) / 4) + 700
    if estimated_tokens > GROQ_ESTIMATED_TPM_BUDGET:
        logger.warning("Single evaluation request estimate exceeds the local Groq pacing budget")
        return

    while True:
        wait_seconds = 0.0
        with _GROQ_RATE_LIMIT_LOCK:
            now = time.monotonic()
            while _GROQ_TOKEN_RESERVATIONS and now - _GROQ_TOKEN_RESERVATIONS[0][0] >= 60:
                _GROQ_TOKEN_RESERVATIONS.popleft()
            used_tokens = sum(tokens for _, tokens in _GROQ_TOKEN_RESERVATIONS)
            if used_tokens + estimated_tokens <= GROQ_ESTIMATED_TPM_BUDGET:
                _GROQ_TOKEN_RESERVATIONS.append((now, estimated_tokens))
                return
            wait_seconds = max(0.25, 60 - (now - _GROQ_TOKEN_RESERVATIONS[0][0]) + 0.1)
        logger.info("Waiting %.1fs for Groq token budget before the next grading pass", wait_seconds)
        time.sleep(wait_seconds)


def _ask_json(model: str, system: str, user: str) -> dict[str, Any]:
    client = _client()
    if client is None:
        return {}
    if len(user) > MAX_GROQ_USER_CHARS:
        logger.warning(
            "Truncating evaluation prompt for model %s from %d to %d characters",
            model,
            len(user),
            MAX_GROQ_USER_CHARS,
        )
        user = user[: MAX_GROQ_USER_CHARS - 32] + "\n[Input truncated for token limits.]"
    _reserve_groq_token_budget(system, user)
    completion = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.1,
    )
    return _extract_json(completion.choices[0].message.content or "")


def _chunk_submission(text: str) -> list[str]:
    """Split all extracted text into overlapping chunks without dropping its tail."""
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    if len(cleaned) <= SUBMISSION_CHUNK_CHARS:
        return [cleaned]

    chunks: list[str] = []
    start = 0
    while start < len(cleaned):
        end = min(start + SUBMISSION_CHUNK_CHARS, len(cleaned))
        if end < len(cleaned):
            # Prefer a paragraph/line/word boundary near the end of the window.
            boundary_floor = start + int(SUBMISSION_CHUNK_CHARS * 0.65)
            boundary = max(
                cleaned.rfind("\n\n", boundary_floor, end),
                cleaned.rfind("\n", boundary_floor, end),
                cleaned.rfind(" ", boundary_floor, end),
            )
            if boundary > start:
                end = boundary
        chunk = cleaned[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(cleaned):
            break
        start = max(start + 1, end - SUBMISSION_CHUNK_OVERLAP)
    return chunks


def _clamp_coverage_scores(result: dict[str, Any], submission_id: str, stage: str) -> dict[str, Any]:
    """Keep otherwise valid model evidence when a score drifts outside 0–10."""
    topics = result.get("topics")
    if not isinstance(topics, list):
        return result

    normalized: list[Any] = []
    for topic_index, topic in enumerate(topics):
        if not isinstance(topic, dict):
            normalized.append(topic)
            continue
        item = dict(topic)
        score = item.get("score")
        try:
            numeric_score = float(score)
        except (TypeError, ValueError):
            normalized.append(item)
            continue
        if not math.isfinite(numeric_score):
            normalized.append(item)
            continue
        bounded_score = max(0.0, min(10.0, numeric_score))
        if bounded_score != numeric_score:
            logger.warning(
                "Clamped coverage score for submission %s at %s topic %d from %s to %.1f",
                submission_id,
                stage,
                topic_index + 1,
                score,
                bounded_score,
            )
            item["score"] = bounded_score
        normalized.append(item)
    result["topics"] = normalized
    return result


def router_node(state: EvaluationState) -> EvaluationState:
    required = ["submission_id", "assignment_id", "course_id", "raw_text"]
    missing = [key for key in required if not state.get(key)]
    if missing:
        raise ValueError(f"Evaluation payload is missing: {', '.join(missing)}")

    try:
        course_material_count = CHROMA_CLIENT.get_collection(
            name=f"course_{state['course_id']}"
        ).count()
    except Exception:
        course_material_count = 0

    result = _ask_json(
        settings.GROQ_MODEL,
        "You are an evaluation workflow router. Return JSON only with an execution_plan array. "
        "The plan must include integrity, coverage, and mastery exactly once, in that dependency order. "
        "Then choose exactly one feedback step: rag_feedback if course materials are available and can "
        "help explain likely learning gaps, otherwise rubric_feedback. Never include unknown steps.",
        f"Topics: {state.get('topics_list', [])}\nRubric: {state.get('rubric', [])}\n"
        f"Teacher reference solution supplied: {bool(state.get('reference_solution'))}\n"
        f"Indexed course material chunks available: {course_material_count}",
    )
    requested = result.get("execution_plan") if isinstance(result.get("execution_plan"), list) else []
    requested = [str(item).strip().lower() for item in requested]
    required = {"integrity", "coverage", "mastery"}
    valid_steps = required | {"rag_feedback", "rubric_feedback"}
    has_valid_steps = (
        len(requested) == len(set(requested))
        and set(requested).issubset(valid_steps)
        and required.issubset(requested)
        and requested.index("integrity") < requested.index("coverage") < requested.index("mastery")
        and requested.index("mastery") < len(requested) - 1
        and requested[-1] in {"rag_feedback", "rubric_feedback"}
        and ("rag_feedback" in requested) != ("rubric_feedback" in requested)
    )
    if has_valid_steps:
        plan = requested
    else:
        # If the model cannot return a safe plan, use grounded feedback whenever
        # indexed materials exist, and rubric-only feedback otherwise.
        feedback_step = "rag_feedback" if course_material_count else "rubric_feedback"
        plan = ["integrity", "coverage", "mastery", feedback_step]

    if not course_material_count and "rag_feedback" in plan:
        plan = [step for step in plan if step != "rag_feedback"] + ["rubric_feedback"]

    logger.info(
        "Evaluation router selected plan for submission %s: %s",
        state["submission_id"],
        plan,
    )
    return {"execution_plan": plan, "execution_step": 0}


def integrity_node(state: EvaluationState) -> EvaluationState:
    text = state.get("raw_text", "").strip()
    if not text:
        return {"integrity_score": 1.0, "plagiarism_flag": False, "plagiarism_matches": []}

    collection = CHROMA_CLIENT.get_or_create_collection(name=f"submissions_{state['assignment_id']}")
    embedding = _encode_texts([text])[0]
    normalized_text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    content_hash = hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()
    matches_by_id: dict[str, float] = {}

    def cosine_similarity(left: list[float], right: Any) -> float:
        right_values = [float(value) for value in right]
        left_values = [float(value) for value in left]
        if len(left_values) != len(right_values):
            return 0.0
        denominator = math.sqrt(sum(value * value for value in left_values)) * math.sqrt(
            sum(value * value for value in right_values)
        )
        if denominator <= 0:
            return 0.0
        return max(-1.0, min(1.0, sum(a * b for a, b in zip(left_values, right_values)) / denominator))

    # Search and store atomically under a Redis lock shared by every worker.
    # The process-local lock avoids needless Redis contention between threads.
    with _assignment_integrity_lock(str(state["assignment_id"])):
        try:
            exact = collection.get(where={"content_hash": content_hash}, include=["metadatas"])
            for metadata in exact.get("metadatas") or []:
                matched_id = str((metadata or {}).get("submission_id", ""))
                if matched_id and matched_id != state["submission_id"]:
                    matches_by_id[matched_id] = 1.0
        except Exception as exc:
            logger.warning("Exact integrity lookup failed for %s: %s", state["submission_id"], exc)

        try:
            result = collection.query(
                query_embeddings=[embedding],
                n_results=5,
                include=["embeddings", "metadatas"],
            )
            metadatas = (result.get("metadatas") or [[]])[0]
            all_candidate_vectors = result.get("embeddings")
            candidate_vectors = all_candidate_vectors[0] if all_candidate_vectors is not None and len(all_candidate_vectors) else []
            for index, metadata in enumerate(metadatas):
                matched_id = str((metadata or {}).get("submission_id", ""))
                if not matched_id or matched_id == state["submission_id"]:
                    continue
                if matched_id in matches_by_id:
                    continue
                if index >= len(candidate_vectors):
                    continue
                similarity = cosine_similarity(embedding, candidate_vectors[index])
                if similarity > 0:
                    matches_by_id[matched_id] = round(similarity, 4)
        except Exception as exc:
            logger.warning("Integrity vector lookup failed for %s: %s", state["submission_id"], exc)

        try:
            # upsert refreshes older entries that were originally stored without
            # the exact-content fingerprint.
            collection.upsert(
                ids=[state["submission_id"]],
                embeddings=[embedding],
                metadatas=[{"submission_id": state["submission_id"], "content_hash": content_hash}],
            )
        except Exception:
            logger.warning("Could not store integrity fingerprint for %s", state["submission_id"], exc_info=True)

    matches = [
        {"submission_id": matched_id, "similarity": similarity}
        for matched_id, similarity in matches_by_id.items()
    ]
    best_similarity = max(matches_by_id.values(), default=0.0)
    logger.info(
        "Integrity check submission=%s candidates=%d best_similarity=%.4f flagged=%s",
        state["submission_id"],
        len(matches),
        best_similarity,
        best_similarity > 0.85,
    )

    return {
        "integrity_score": round(1.0 - best_similarity, 4),
        "plagiarism_flag": best_similarity > 0.85,
        "plagiarism_matches": matches,
    }


def coverage_node(state: EvaluationState) -> EvaluationState:
    rubric = state.get("rubric", [])
    # Rubric criterion names are the canonical scoring keys. Assignment topic
    # tags are useful context, but often differ from the criterion wording and
    # must not be used as dictionary keys for rubric scores.
    rubric_topics = [
        " ".join(str(item.get("criterion") or "").split())
        for item in rubric
        if isinstance(item, dict) and str(item.get("criterion") or "").strip()
    ]
    course_topics = [
        " ".join(str(topic).split())
        for topic in (state.get("topics_list") or [])
        if topic is not None and str(topic).strip()
    ]
    topics = list(dict.fromkeys(rubric_topics or course_topics or ["General"]))
    reference = state.get("reference_solution", "")
    chunks = _chunk_submission(state.get("raw_text", ""))
    if not chunks:
        return {
            "topic_coverage": [
                {"topic": topic, "score": 0.0, "evidence": [], "missing": ["No readable submission text was extracted"]}
                for topic in topics
            ]
        }
    logger.info(
        "Evaluating submission %s using %d text chunk(s) (%d extracted characters)",
        state.get("submission_id"),
        len(chunks),
        len(state.get("raw_text", "")),
    )

    # Keep the full chunk in every request. Bound supplementary context first,
    # so the generic prompt-size guard can never lop off the end of student work.
    rubric_text = json.dumps(rubric, ensure_ascii=False)[:2000]
    topics_text = json.dumps(course_topics, ensure_ascii=False)[:600]
    criteria_text = json.dumps(topics, ensure_ascii=False)[:1000]
    reference_text = reference[:3000]
    per_chunk: list[list[dict[str, Any]]] = []
    system = (
        "You are a fair academic grader. Apply the rubric and award credit for valid alternative approaches. "
        "This is one part of a possibly longer submission: score evidence in this part only and do not say "
        "a criterion is missing merely because it may appear in another part. Return JSON only in the form "
        '{"topics":[{"topic":"...","score":0,"evidence":[],"missing":[]}]}. '
        "Return exactly one result for each evaluation criterion, using its exact name. Use the teacher reference "
        "solution as a guide to recognize correct content, while accepting equivalent valid answers. "
        "Score each criterion from 0 to 10 based on evidence in this part. For any criterion below 10, "
        "name the specific required element not evidenced in this part in missing; do not use vague labels."
    )

    for index, chunk in enumerate(chunks, start=1):
        user = (
            f"Evaluation criteria (use these exact names): {criteria_text}\nRubric: {rubric_text}\n"
            f"Assignment topic context: {topics_text}\n"
            f"Teacher reference solution (grading guidance): {reference_text}\n"
            f"Submission part {index} of {len(chunks)}:\n{chunk}"
        )
        # Supplementary context is bounded above; 4,500 characters of actual
        # submission plus labels remain below MAX_GROQ_USER_CHARS.
        result = _ask_json(settings.GROQ_MODEL, system, user)
        if not isinstance(result.get("topics"), list) or not result.get("topics"):
            logger.warning(
                "Coverage response was empty for submission %s, chunk %d/%d; retrying with strict JSON instructions",
                state.get("submission_id"), index, len(chunks),
            )
            result = _ask_json(
                settings.GROQ_MODEL,
                system + " Your previous response was empty or invalid. Return a non-empty topics array with one item per evaluation criterion, even if a criterion receives 0.",
                user,
            )
        result = _clamp_coverage_scores(result, str(state.get("submission_id", "unknown")), f"chunk {index}/{len(chunks)}")
        try:
            parsed = TopicCoverageList.model_validate(result)
            if not parsed.topics:
                logger.warning(
                    "Empty coverage result for submission %s, chunk %d/%d; response keys=%s",
                    state.get("submission_id"),
                    index,
                    len(chunks),
                    sorted(result.keys()),
                )
                per_chunk.append([])
                continue
            parsed_topics = [item.model_dump() for item in parsed.topics]
            expected = {topic.casefold(): topic for topic in topics}
            # Models sometimes echo an assignment tag or the literal "None"
            # instead of a rubric criterion. Keep results by exact name where
            # possible, and use response order only when counts align.
            for topic_index, item in enumerate(parsed_topics):
                label = str(item.get("topic") or "").strip()
                canonical = expected.get(label.casefold())
                if canonical is None and len(parsed_topics) == len(topics) and topic_index < len(topics):
                    canonical = topics[topic_index]
                if canonical is not None:
                    item["topic"] = canonical
            per_chunk.append(parsed_topics)
        except ValidationError as exc:
            logger.warning(
                "Could not parse coverage result for submission %s, chunk %d/%d; validation_errors=%s; response_keys=%s",
                state.get("submission_id"),
                index,
                len(chunks),
                json.dumps(exc.errors(include_input=False), ensure_ascii=False),
                sorted(result.keys()),
            )
            per_chunk.append([])

    # Merge all parts: take the strongest supported score per criterion, collect
    # evidence from every part. A final synthesis pass reconciles evidence that
    # spans multiple parts instead of treating a per-part score as the final one.
    coverage: list[dict[str, Any]] = []
    synthesis: list[dict[str, Any]] = []
    for topic in topics:
        matches = [
            item
            for chunk_result in per_chunk
            for item in chunk_result
            if str(item.get("topic", "")).strip().lower() == str(topic).strip().lower()
        ]
        if not matches:
            coverage.append({"topic": topic, "score": 0.0, "evidence": [], "missing": ["No structured coverage result"]})
            synthesis.append({"topic": topic, "part_scores": [], "evidence": [], "part_missing": []})
            continue
        strongest = max(matches, key=lambda item: float(item.get("score", 0) or 0))
        evidence: list[str] = []
        for match in matches:
            for item in match.get("evidence", []):
                value = str(item).strip()
                if value and value not in evidence:
                    evidence.append(value)
                if len(evidence) >= 8:
                    break
            if len(evidence) >= 8:
                break
        coverage.append({
            "topic": topic,
            "score": float(strongest.get("score", 0) or 0),
            "evidence": evidence,
            "missing": strongest.get("missing", []),
        })
        missing_observations: list[str] = []
        for match in matches:
            for item in match.get("missing", []):
                value = str(item).strip()
                if value and value not in missing_observations:
                    missing_observations.append(value)
        synthesis.append({
            "topic": topic,
            "part_scores": sorted(
                [round(float(item.get("score", 0) or 0), 2) for item in matches],
                reverse=True,
            )[:5],
            "evidence": evidence,
            "part_missing": missing_observations[:5],
        })

    if len(chunks) > 1 or reference_text.strip():
        final_system = (
            "You are consolidating evidence from every part of one student's complete submission. "
            "Use the rubric and reference as guidance, accept valid alternative approaches, and judge each "
            "criterion across the combined evidence. Part-level missing notes are not final: evidence may "
            "appear in another part. Ignore repeated evidence caused by overlapping chunks. Return JSON only "
            'in the form {"topics":[{"topic":"...","score":0,"evidence":[],"missing":[]}]}. '
            "Give a final 0-to-10 criterion score based on the whole submission. For each criterion below 10, "
            "list the concrete rubric elements still missing from the complete submission; never leave missing "
            "empty for a partially met criterion."
        )
        final_user = ""
        for evidence_limit in (5, 3, 1, 0):
            compact = [
                {
                    "topic": item["topic"],
                    "part_scores": item["part_scores"],
                    "evidence": [value[:180] for value in item["evidence"][:evidence_limit]],
                    "part_missing": item["part_missing"][:2],
                }
                for item in synthesis
            ]
            final_user = (
                f"Evaluation criteria (use these exact names): {criteria_text}\nRubric: {rubric_text}\n"
                f"Assignment topic context: {topics_text}\n"
                f"Teacher reference solution (grading guidance): {reference_text[:1800]}\n"
                f"Evidence gathered from all submission parts: {json.dumps(compact, ensure_ascii=False)}"
            )
            if len(final_user) <= MAX_GROQ_USER_CHARS:
                break
        if len(final_user) <= MAX_GROQ_USER_CHARS:
            final_result = _ask_json(settings.GROQ_MODEL, final_system, final_user)
            final_result = _clamp_coverage_scores(final_result, str(state.get("submission_id", "unknown")), "final synthesis")
            try:
                final_coverage = TopicCoverageList.model_validate(final_result).topics
                final_by_topic = {item.topic.strip().lower(): item for item in final_coverage}
                for topic_index, item in enumerate(coverage):
                    final_item = final_by_topic.get(str(item["topic"]).strip().lower())
                    if final_item is None and len(final_coverage) == len(coverage) and topic_index < len(final_coverage):
                        final_item = final_coverage[topic_index]
                    if final_item is not None:
                        final_evidence = [value.strip() for value in final_item.evidence if value.strip()]
                        # A synthesis response that drops evidence must not
                        # erase a positive, evidence-backed chunk score.
                        if final_evidence or not item.get("evidence"):
                            item["score"] = final_item.score
                            item["missing"] = [
                                value for value in final_item.missing
                                if value.strip().casefold() not in {"none", "n/a", "not applicable"}
                            ]
            except ValidationError:
                logger.warning("Could not parse final coverage synthesis for submission %s", state.get("submission_id"))
    return {"topic_coverage": coverage}


def _mastery_level(score: float, maximum: float) -> str:
    percentage = (score / maximum * 100) if maximum else 0
    if percentage < 40:
        return "Beginner"
    if percentage < 60:
        return "Developing"
    if percentage < 80:
        return "Proficient"
    return "Advanced"


def mastery_node(state: EvaluationState) -> EvaluationState:
    coverage = state.get("topic_coverage", [])
    rubric = state.get("rubric", [])
    maximum = float(state.get("max_score") or sum(float(item.get("max_points", 0)) for item in rubric) or 100)
    by_topic = {str(item.get("topic", "")).strip().lower(): item for item in coverage}
    topic_scores: list[dict[str, Any]] = []
    total = 0.0
    for item in rubric or [{"criterion": item.get("topic", "General"), "max_points": maximum} for item in coverage]:
        topic = str(item.get("criterion") or item.get("topic") or "General")
        max_points = float(item.get("max_points", item.get("max_score", 0)) or 0)
        match = by_topic.get(topic.lower(), {})
        coverage_score = float(match.get("score", 0) or 0)
        awarded = max_points * max(0.0, min(10.0, coverage_score)) / 10.0
        total += awarded
        topic_scores.append({
            "topic": topic,
            "score": round(awarded, 2),
            "max_points": max_points,
            "coverage_score": coverage_score,
            "evidence": match.get("evidence", []),
            "missing": match.get("missing", []),
        })

    depth_result = _ask_json(
        settings.GROQ_MODEL,
        "Rate the Bloom conceptual depth of this submission. Return JSON only: "
        '{"score":1-5,"label":"surface|understanding|applied|analytical|evaluative"}.',
        json.dumps(
            [
                {
                    "topic": item.get("topic"),
                    "score": item.get("score"),
                    "evidence": item.get("evidence", []),
                    "missing": item.get("missing", []),
                }
                for item in coverage
            ],
            ensure_ascii=False,
        ),
    )
    try:
        depth = BloomDepth.model_validate(depth_result).model_dump()
    except ValidationError:
        depth = {"score": 1.0, "label": "surface"}

    return {
        "mastery_result": {
            "total_score": round(total, 2),
            "max_score": maximum,
            "mastery_level": _mastery_level(total, maximum),
            "topic_scores": topic_scores,
            "depth_score": depth["score"],
            "depth_label": depth["label"],
        }
    }


def _feedback_node(
    state: EvaluationState,
    use_course_materials: bool,
) -> EvaluationState:
    mastery = state.get("mastery_result", {})
    topic_scores = mastery.get("topic_scores", [])
    weak_topics = [
        item for item in topic_scores
        if float(item.get("coverage_score", 0)) * 10 < 70
    ]
    partial_topics = [
        item for item in topic_scores
        if float(item.get("score", 0) or 0) < float(item.get("max_points", 0) or 0)
        or item.get("missing")
    ]
    retrieved: dict[str, list[dict[str, Any]]] = {}
    collection = None
    if use_course_materials:
        try:
            collection = CHROMA_CLIENT.get_collection(name=f"course_{state['course_id']}")
        except Exception:
            pass

    if collection is not None:
        for item in weak_topics:
            topic = str(item.get("topic", "General"))
            try:
                result = collection.query(
                    query_embeddings=[_encode_texts([topic])[0]],
                    n_results=3,
                    include=["documents", "metadatas"],
                )
                documents = (result.get("documents") or [[]])[0]
                metadatas = (result.get("metadatas") or [[]])[0]
                retrieved[topic] = [
                    {"text": str(document), "source": (metadatas[index] if index < len(metadatas) else {}).get("source", "course material")}
                    for index, document in enumerate(documents)
                    if document
                ]
            except Exception:
                retrieved[topic] = []

    context = "\n\n".join(
        f"[{topic}] {chunk['text']} (Source: {chunk['source']})"
        for topic, chunks in retrieved.items() for chunk in chunks
    )
    if not partial_topics:
        feedback = "## What You Did Well\nYour submission covered the assessed criteria."
    elif weak_topics:
        result = _ask_json(
            settings.GROQ_MODEL,
            "Write accurate academic feedback in Markdown. Return JSON only with a feedback_markdown string. "
            "Include What You Did Well, Conceptual Gaps & Misconceptions, and a Targeted Action Plan. "
            "Distinguish between criteria fully met and partially met, and name concrete unmet rubric elements. "
            + (
                "Use the supplied course context to ground recommendations and cite its source labels when used."
                if retrieved
                else "Use only the supplied rubric evidence; do not invent course materials or citations."
            ),
            f"Topics needing review (with rubric evidence and missing elements): {partial_topics}\nCourse context:\n{context}",
        )
        feedback = str(result.get("feedback_markdown", "")).strip()
        if not feedback:
            feedback = "## Conceptual Gaps & Misconceptions\nReview: " + ", ".join(item["topic"] for item in weak_topics)
    else:
        feedback = "## What You Did Well\nYour submission met most criteria, with some areas receiving partial credit."

    # Ground the written feedback in every partially scored criterion. This also
    # covers topics that score 7/10 or higher and were excluded from weak_topics.
    review_lines: list[str] = []
    for item in partial_topics:
        topic = str(item.get("topic", "Topic"))
        missing = [str(value).strip() for value in (item.get("missing") or []) if str(value).strip()]
        if missing:
            review_lines.extend(f"- **{topic}:** {value}" for value in missing)
        else:
            review_lines.append(
                f"- **{topic}:** {item.get('score', 0)}/{item.get('max_points', 0)} points awarded; "
                "the evaluator did not identify a specific missing element. Review this criterion with your teacher."
            )
    if review_lines:
        feedback += "\n\n## Specific Items to Review\n" + "\n".join(review_lines)

    return {"retrieved_chunks": retrieved, "feedback_markdown": feedback}


def rag_feedback_node(state: EvaluationState) -> EvaluationState:
    return _feedback_node(state, use_course_materials=True)


def rubric_feedback_node(state: EvaluationState) -> EvaluationState:
    return _feedback_node(state, use_course_materials=False)


def finalize_node(state: EvaluationState) -> EvaluationState:
    return {"final_status": "flagged" if state.get("plagiarism_flag") else "graded"}


_EVALUATION_STEPS: dict[str, Callable[[EvaluationState], EvaluationState]] = {
    "integrity": integrity_node,
    "coverage": coverage_node,
    "mastery": mastery_node,
    "rag_feedback": rag_feedback_node,
    "rubric_feedback": rubric_feedback_node,
}


def execute_plan_node(state: EvaluationState) -> EvaluationState:
    plan = state.get("execution_plan", [])
    step = int(state.get("execution_step", 0))
    if step >= len(plan):
        return {}
    step_name = plan[step]
    node = _EVALUATION_STEPS.get(step_name)
    if node is None:
        raise ValueError(f"Unsupported evaluation step: {step_name}")
    updates = node(state)
    return {**updates, "execution_step": step + 1}


def _next_plan_route(state: EvaluationState) -> str:
    return "finalize" if int(state.get("execution_step", 0)) >= len(state.get("execution_plan", [])) else "execute_plan"


def _run_sequential(initial: EvaluationState) -> EvaluationState:
    state = dict(initial)
    state.update(router_node(state))
    while int(state.get("execution_step", 0)) < len(state.get("execution_plan", [])):
        state.update(execute_plan_node(state))
    state.update(finalize_node(state))
    return state


def build_evaluation_graph():
    if StateGraph is None:
        return None
    graph = StateGraph(EvaluationState)
    graph.add_node("router", router_node)
    graph.add_node("execute_plan", execute_plan_node)
    graph.add_node("finalize", finalize_node)
    graph.set_entry_point("router")
    graph.add_edge("router", "execute_plan")
    graph.add_conditional_edges(
        "execute_plan",
        _next_plan_route,
        {"execute_plan": "execute_plan", "finalize": "finalize"},
    )
    graph.add_edge("finalize", END)
    return graph.compile()


EVALUATION_GRAPH = build_evaluation_graph()


def run_evaluation_graph(initial: EvaluationState) -> EvaluationState:
    """Run the compiled Phase 4 graph and return its final state."""
    if EVALUATION_GRAPH is None:
        return _run_sequential(initial)
    return EVALUATION_GRAPH.invoke(initial)
