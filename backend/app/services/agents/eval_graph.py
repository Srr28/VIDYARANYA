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
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from pydantic import BaseModel, Field, ValidationError

from app.core.config import settings
from app.services.agents.context_cache import get_compact_rubric, get_reference_digest
from app.services.agents.state import EvaluationState
from app.services.rag_service import CHROMA_CLIENT, MODEL, _encode_texts

logger = logging.getLogger("vidyaranya.evaluation")
MAX_GROQ_USER_CHARS = 12000
SUBMISSION_CHUNK_CHARS = 4500
SUBMISSION_CHUNK_OVERLAP = 350
@dataclass
class _TokenReservation:
    created_at: float
    tokens: int


_GROQ_TOKEN_RESERVATIONS: dict[str, deque[_TokenReservation]] = {}
_GROQ_PROVIDER_LIMITS: dict[str, tuple[int, float]] = {}
_GROQ_RATE_LIMIT_LOCK = threading.Lock()
_GROQ_STATS_LOCAL = threading.local()
_INTEGRITY_INDEX_LOCK = threading.Lock()
_REDIS_LOCK_CLIENT: Any | None = None
_REDIS_LOCK_CLIENT_GUARD = threading.Lock()
_GROQ_REDIS_CLIENT: Any | None = None
_GROQ_REDIS_CLIENT_GUARD = threading.Lock()

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
    """Serialize each assignment's Chroma lookup-and-upsert across worker processes."""
    global _REDIS_LOCK_CLIENT
    if redis is None:
        raise RuntimeError("redis-py is required for cross-process plagiarism locking")

    with _INTEGRITY_INDEX_LOCK:
        if _REDIS_LOCK_CLIENT is None:
            with _REDIS_LOCK_CLIENT_GUARD:
                if _REDIS_LOCK_CLIENT is None:
                    _REDIS_LOCK_CLIENT = redis.Redis.from_url(
                        settings.REDIS_URL,
                        socket_connect_timeout=5,
                        socket_timeout=10,
                    )

        lock = _REDIS_LOCK_CLIENT.lock(
            f"vidyaranya:plagiarism:{assignment_id}",
            timeout=300,
            blocking_timeout=300,
            sleep=0.2,
            thread_local=False,
        )
        if not lock.acquire(blocking=True):
            raise TimeoutError(
                f"Timed out waiting for plagiarism lock for assignment {assignment_id}"
            )
        try:
            yield
        finally:
            # Redis verifies the token, so this cannot release a lock acquired by
            # another worker if this lock's lease has expired.
            lock.release()


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


class GroqDailyBudgetDeferred(Exception):
    """Evaluation should remain queued until the daily Groq budget resets."""

    def __init__(self, defer_seconds: int) -> None:
        self.defer_seconds = max(1, min(3600, int(defer_seconds)))
        super().__init__("Groq daily token budget is nearly exhausted")


def _norm_criterion(value: Any) -> str:
    """Normalize criterion labels for case- and whitespace-insensitive matching."""
    return " ".join(str(value or "").split()).casefold()


def _client():
    if Groq is None or not settings.GROQ_API_KEY:
        return None
    return Groq(api_key=settings.GROQ_API_KEY, max_retries=0)


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


def _reserve_groq_token_budget(
    system: str,
    user: str,
    model: str | None = None,
    max_completion_tokens: int = 900,
) -> tuple[_TokenReservation, float]:
    """Reserve estimated tokens in a model-specific sliding minute window."""
    model_name = model or settings.GROQ_MODEL
    estimated_tokens = math.ceil((len(system) + len(user)) / 4) + max_completion_tokens
    budget = int(settings.GROQ_TPM_BUDGET)
    started_waiting = time.monotonic()
    while True:
        with _GROQ_RATE_LIMIT_LOCK:
            now = time.monotonic()
            reservations = _GROQ_TOKEN_RESERVATIONS.setdefault(model_name, deque())
            while reservations and now - reservations[0].created_at >= 60:
                reservations.popleft()
            used_tokens = sum(item.tokens for item in reservations)
            provider = _GROQ_PROVIDER_LIMITS.get(model_name)
            if provider and now < provider[1] and provider[0] < estimated_tokens:
                wait_seconds = max(0.05, provider[1] - now)
            elif used_tokens + estimated_tokens <= budget or (not reservations and estimated_tokens > budget):
                reservation = _TokenReservation(now, estimated_tokens)
                reservations.append(reservation)
                if estimated_tokens > budget:
                    logger.warning("Groq request estimate (%d) exceeds configured minute budget (%d)", estimated_tokens, budget)
                return reservation, time.monotonic() - started_waiting
            else:
                wait_seconds = max(0.05, 60 - (now - reservations[0].created_at) + 0.05)
        logger.info("Waiting %.2fs for the %s Groq token budget", wait_seconds, model_name)
        time.sleep(wait_seconds)


def _reconcile_groq_reservation(reservation: _TokenReservation, actual_tokens: int) -> None:
    with _GROQ_RATE_LIMIT_LOCK:
        for reservations in _GROQ_TOKEN_RESERVATIONS.values():
            for item in reservations:
                if item is reservation:
                    item.tokens = max(0, int(actual_tokens))
                    return


def _parse_reset_seconds(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    composite = re.fullmatch(r"(?:(\d+)m)?(\d+(?:\.\d+)?)s", text)
    if composite:
        return int(composite.group(1) or 0) * 60 + float(composite.group(2))
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(ms|s|m)?", text)
    if not match:
        return None
    quantity = float(match.group(1))
    unit = match.group(2) or "s"
    return quantity / 1000 if unit == "ms" else quantity * 60 if unit == "m" else quantity


def _read_rate_headers(headers: Any, model: str) -> None:
    if not headers:
        return
    remaining = None
    reset_seconds = None
    try:
        raw_remaining = headers.get("x-ratelimit-remaining-tokens")
        remaining = int(raw_remaining) if raw_remaining is not None else None
    except (TypeError, ValueError):
        remaining = None
    try:
        reset_seconds = _parse_reset_seconds(headers.get("x-ratelimit-reset-tokens"))
        if reset_seconds is None:
            reset_seconds = _parse_reset_seconds(headers.get("retry-after"))
    except (TypeError, ValueError):
        reset_seconds = None
    if reset_seconds is not None:
        with _GROQ_RATE_LIMIT_LOCK:
            _GROQ_PROVIDER_LIMITS[model] = (
                max(0, remaining) if remaining is not None else 0,
                time.monotonic() + max(0.0, reset_seconds),
            )


def _groq_redis():
    global _GROQ_REDIS_CLIENT
    if redis is None:
        return None
    if _GROQ_REDIS_CLIENT is None:
        with _GROQ_REDIS_CLIENT_GUARD:
            if _GROQ_REDIS_CLIENT is None:
                _GROQ_REDIS_CLIENT = redis.Redis.from_url(
                    settings.REDIS_URL, socket_connect_timeout=1, socket_timeout=2
                )
    return _GROQ_REDIS_CLIENT


def _daily_counter_key(now: datetime | None = None) -> str:
    return f"vidyaranya:groq:tpd:{(now or datetime.now(timezone.utc)).astimezone(timezone.utc):%Y-%m-%d}"


def _read_daily_token_usage() -> int | None:
    try:
        client = _groq_redis()
        if client is None:
            return None
        value = client.get(_daily_counter_key())
        return int(value or 0)
    except Exception:
        logger.warning("Could not read Groq daily token counter; allowing evaluation", exc_info=True)
        return None


def _check_daily_token_budget() -> None:
    used = _read_daily_token_usage()
    if used is None:
        return
    budget = int(settings.GROQ_DAILY_TOKEN_BUDGET)
    if used > budget * 0.85:
        now = datetime.now(timezone.utc)
        midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        raise GroqDailyBudgetDeferred(min(3600, max(1, int((midnight - now).total_seconds()))))


def _record_daily_token_usage(actual_tokens: int) -> None:
    if actual_tokens <= 0:
        return
    try:
        client = _groq_redis()
        if client is None:
            return
        key = _daily_counter_key()
        total = int(client.incrby(key, int(actual_tokens)))
        if total <= actual_tokens:
            client.expire(key, 26 * 60 * 60)
    except Exception:
        logger.warning("Could not update Groq daily token counter", exc_info=True)


def _evaluation_fingerprint(state: EvaluationState) -> str:
    payload = "\0".join((
        str(state.get("raw_text") or ""),
        json.dumps(state.get("rubric") or [], ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        str(state.get("reference_digest") or state.get("reference_solution") or ""),
    ))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _checkpoint_key(state: EvaluationState, step: str) -> str | None:
    submission_id = state.get("submission_id")
    if not submission_id:
        return None
    return f"vidyaranya:evalckpt:{submission_id}:{_evaluation_fingerprint(state)}:{step}"


def _load_checkpoint(state: EvaluationState, step: str) -> dict[str, Any] | None:
    key = _checkpoint_key(state, step)
    if not key:
        return None
    try:
        client = _groq_redis()
        raw = client.get(key) if client is not None else None
        value = json.loads(raw) if raw else None
        if isinstance(value, dict):
            stats = getattr(_GROQ_STATS_LOCAL, "value", None)
            if stats is not None:
                stats["checkpoint_hits"] += 1
            return value
    except Exception:
        logger.warning("Could not read evaluation checkpoint %s; continuing without it", step, exc_info=True)
    return None


def _save_checkpoint(state: EvaluationState, step: str, value: dict[str, Any]) -> None:
    key = _checkpoint_key(state, step)
    if not key:
        return
    try:
        client = _groq_redis()
        if client is not None:
            client.set(key, json.dumps(value, ensure_ascii=False, separators=(",", ":")), ex=2 * 60 * 60)
    except Exception:
        logger.warning("Could not write evaluation checkpoint %s; continuing without it", step, exc_info=True)


def _checkpointed_json(
    state: EvaluationState,
    step: str,
    model: str,
    system: str,
    user: str,
    *,
    max_completion_tokens: int = 900,
) -> dict[str, Any]:
    cached = _load_checkpoint(state, step)
    if cached is not None:
        return cached
    value = _ask_json(model, system, user, max_completion_tokens=max_completion_tokens)
    _save_checkpoint(state, step, value)
    return value


def delete_evaluation_checkpoints(state: EvaluationState) -> None:
    """Remove all checkpoints for a submission after its final DB commit."""
    submission_id = state.get("submission_id")
    if not submission_id:
        return
    try:
        client = _groq_redis()
        if client is None:
            return
        keys = list(client.scan_iter(match=f"vidyaranya:evalckpt:{submission_id}:*"))
        if keys:
            client.delete(*keys)
    except Exception:
        logger.warning("Could not delete completed evaluation checkpoints for %s", submission_id, exc_info=True)


def _ask_json(
    model: str,
    system: str,
    user: str,
    *,
    max_completion_tokens: int = 900,
) -> dict[str, Any]:
    client = _client()
    if client is None:
        return {}
    if len(user) > MAX_GROQ_USER_CHARS:
        logger.warning("Large evaluation request for model %s (%d chars); student text remains intact", model, len(user))
    reservation, waited = _reserve_groq_token_budget(system, user, model, max_completion_tokens)
    try:
        response = client.chat.completions.with_raw_response.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0,
            reasoning_effort="low",
            max_completion_tokens=max_completion_tokens,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        error_response = getattr(exc, "response", None)
        _read_rate_headers(getattr(error_response, "headers", None), model)
        raise
    _read_rate_headers(response.headers, model)
    completion = response.parse()
    usage = getattr(completion, "usage", None)
    prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    total_tokens = int(getattr(usage, "total_tokens", 0) or prompt_tokens + completion_tokens)
    _reconcile_groq_reservation(reservation, total_tokens)
    _record_daily_token_usage(total_tokens)
    stats = getattr(_GROQ_STATS_LOCAL, "value", None)
    if stats is not None:
        stats["llm_calls"] += 1
        stats["prompt_tokens"] += prompt_tokens
        stats["completion_tokens"] += completion_tokens
        stats["total_tokens"] += total_tokens
        stats["seconds_spent_waiting_on_limiter"] += waited
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


def prepare_node(state: EvaluationState) -> EvaluationState:
    """Validate and deterministically prepare the grading plan without an LLM call."""
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
    feedback_step = "rag_feedback" if course_material_count > 0 else "rubric_feedback"
    plan = ["integrity", "grade", feedback_step]
    rubric = state.get("rubric") or []
    reference_solution = str(state.get("reference_solution") or "")
    compact_rubric = get_compact_rubric(rubric)
    reference_digest = get_reference_digest(reference_solution)
    submission_chunks = _chunk_submission(state.get("raw_text", ""))

    logger.info(
        "Evaluation preparation selected plan for submission %s: %s",
        state["submission_id"],
        plan,
    )
    return {
        "execution_plan": plan,
        "execution_step": 0,
        "course_material_count": int(course_material_count),
        "feedback_mode": "rag" if course_material_count > 0 else "rubric",
        "compact_rubric": compact_rubric,
        "reference_digest": reference_digest,
        "submission_chunks": submission_chunks,
    }


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


_GRADE_SYSTEM = (
    "Grade academic work fairly against the supplied rubric. Accept valid alternative approaches. "
    "Return JSON only: {\"c\":[{\"t\":\"criterion\",\"s\":0,\"e\":[],\"m\":[]}],"
    "\"b\":{\"s\":1,\"l\":\"surface\"}}. Include every criterion exactly once. Scores are 0-10. "
    "Give at most 2 evidence strings and 2 concrete missing rubric elements per criterion, each at most 120 chars. "
    "Do not use vague missing notes. Bloom labels: surface, understanding, applied, analytical, evaluative."
)
_SYNTHESIS_SYSTEM = (
    "Consolidate compact evidence from every part of one submission. Ignore overlap. Return JSON only using "
    "the same c and b schema as grading, and an optional f string containing concise Markdown feedback. "
    "Score each criterion 0-10 across the whole submission, include at most 2 evidence and 2 concrete missing "
    "items per criterion (each <=120 chars), and do not infer evidence that is absent. If any criterion is partial, "
    "write a short feedback draft in f; otherwise omit f."
)


def _mastery_level(score: float, maximum: float) -> str:
    percentage = (score / maximum * 100) if maximum else 0
    if percentage < 40:
        return "Beginner"
    if percentage < 60:
        return "Developing"
    if percentage < 80:
        return "Proficient"
    return "Advanced"


def _rubric_topics(state: EvaluationState) -> list[str]:
    rubric_topics = [
        " ".join(str(item.get("criterion") or "").split())
        for item in state.get("rubric", [])
        if isinstance(item, dict) and str(item.get("criterion") or "").strip()
    ]
    course_topics = [
        " ".join(str(topic).split())
        for topic in (state.get("topics_list") or [])
        if topic is not None and str(topic).strip()
    ]
    return list(dict.fromkeys(rubric_topics or course_topics or ["General"]))


def _compact_rubric(state: EvaluationState, topics: list[str]) -> str:
    if state.get("compact_rubric"):
        return str(state["compact_rubric"])
    rubric = state.get("rubric", [])
    lines = []
    for index, item in enumerate(rubric, 1):
        if not isinstance(item, dict):
            continue
        criterion = " ".join(str(item.get("criterion") or "").split())
        if not criterion:
            continue
        description = " ".join(str(item.get("description") or "").split())[:160]
        points = item.get("max_points", item.get("max_score", 0))
        lines.append(f"{index}. {criterion} ({points} pts): {description}".rstrip())
    return "\n".join(lines) or "; ".join(topics)


def _map_compact_coverage(
    result: dict[str, Any], topics: list[str], submission_id: str, stage: str
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    raw_criteria = result.get("c")
    # Accept the previous long-form key while old checkpoint entries expire.
    if not isinstance(raw_criteria, list):
        raw_criteria = result.get("topics")
    by_name = {_norm_criterion(topic): topic for topic in topics}
    coverage: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_criteria if isinstance(raw_criteria, list) else []):
        if not isinstance(raw, dict):
            continue
        label = raw.get("t", raw.get("topic", ""))
        canonical = by_name.get(_norm_criterion(label))
        if canonical is None and len(raw_criteria) == len(topics) and index < len(topics):
            canonical = topics[index]
        if canonical is None:
            continue
        try:
            score = float(raw.get("s", raw.get("score", 0)) or 0)
        except (ValueError, TypeError):
            score = 0.0
        score = max(0.0, min(10.0, score)) if math.isfinite(score) else 0.0
        evidence = raw.get("e", raw.get("evidence", []))
        missing = raw.get("m", raw.get("missing", []))
        evidence = evidence if isinstance(evidence, list) else []
        missing = missing if isinstance(missing, list) else []
        coverage.append({
            "topic": canonical,
            "score": score,
            "evidence": [str(value).strip()[:120] for value in evidence[:2] if str(value).strip()],
            "missing": [str(value).strip()[:120] for value in missing[:2] if str(value).strip()],
        })
    mapped = { _norm_criterion(item["topic"]): item for item in coverage }
    complete = [mapped.get(_norm_criterion(topic), {
        "topic": topic, "score": 0.0, "evidence": [], "missing": ["No structured evaluation result"]
    }) for topic in topics]
    complete = _clamp_coverage_scores({"topics": complete}, submission_id, stage)["topics"]
    bloom = result.get("b") if isinstance(result.get("b"), dict) else {}
    # Old long-form depth keys are accepted only for cached/compat data.
    bloom_score = bloom.get("s", bloom.get("score", 1))
    bloom_label = bloom.get("l", bloom.get("label", "surface"))
    try:
        depth = BloomDepth(score=float(bloom_score), label=str(bloom_label)).model_dump()
    except (ValidationError, TypeError, ValueError):
        depth = {"score": 1.0, "label": "surface"}
    feedback_draft = str(result.get("f") or "").strip()
    return complete, {**depth, "feedback_draft": feedback_draft}


def _build_mastery(state: EvaluationState, coverage: list[dict[str, Any]], depth: dict[str, Any]) -> dict[str, Any]:
    rubric = state.get("rubric", [])
    maximum = float(state.get("max_score") or sum(float(item.get("max_points", 0)) for item in rubric) or 100)
    by_topic = {_norm_criterion(item.get("topic")): item for item in coverage}
    topic_scores: list[dict[str, Any]] = []
    total = 0.0
    score_items = rubric or [{"criterion": item.get("topic", "General"), "max_points": maximum} for item in coverage]
    for item in score_items:
        topic = str(item.get("criterion") or item.get("topic") or "General")
        max_points = float(item.get("max_points", item.get("max_score", 0)) or 0)
        match = by_topic.get(_norm_criterion(topic), {})
        coverage_score = float(match.get("score", 0) or 0)
        awarded = max_points * max(0.0, min(10.0, coverage_score)) / 10.0
        total += awarded
        topic_scores.append({
            "topic": topic, "score": round(awarded, 2), "max_points": max_points,
            "coverage_score": coverage_score, "evidence": match.get("evidence", []), "missing": match.get("missing", []),
        })
    return {
        "total_score": round(total, 2), "max_score": maximum,
        "mastery_level": _mastery_level(total, maximum), "topic_scores": topic_scores,
        "depth_score": depth.get("score", 1.0), "depth_label": depth.get("label", "surface"),
    }


def grade_node(state: EvaluationState) -> EvaluationState:
    """Score each text chunk once, synthesize only multi-chunk work, then map to the stable result shape."""
    cached_grade = _load_checkpoint(state, "grade_result")
    if cached_grade is not None:
        return cached_grade
    topics = _rubric_topics(state)
    chunks = list(state.get("submission_chunks") or _chunk_submission(state.get("raw_text", "")))
    if not chunks:
        coverage = [{"topic": topic, "score": 0.0, "evidence": [], "missing": ["No readable submission text was extracted"]} for topic in topics]
        return {"topic_coverage": coverage, "mastery_result": _build_mastery(state, coverage, {"score": 1.0, "label": "surface"})}

    rubric_text = _compact_rubric(state, topics)[:1800]
    topics_text = json.dumps(state.get("topics_list", []), ensure_ascii=False)[:400]
    reference = str(state.get("reference_digest") or state.get("reference_solution") or "")[:900]
    static_context = (
        f"Rubric:\n{rubric_text}\nTopics: {topics_text}\nReference guidance:\n{reference}\n"
        f"Criteria (exact names): {json.dumps(topics, ensure_ascii=False)}"
    )
    per_chunk: list[list[dict[str, Any]]] = []
    depths: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks, start=1):
        user = f"{static_context}\nSubmission part {index}/{len(chunks)} (score evidence in this part only):\n{chunk}"
        result = _checkpointed_json(state, f"grade_chunk_{index}", settings.GROQ_MODEL, _GRADE_SYSTEM, user)
        coverage, depth = _map_compact_coverage(result, topics, str(state.get("submission_id", "unknown")), f"chunk {index}")
        if not result.get("c") and not result.get("topics"):
            logger.warning("Invalid grading JSON for submission %s chunk %d; retrying once strictly", state.get("submission_id"), index)
            strict = _checkpointed_json(
                state, f"grade_chunk_{index}_strict", settings.GROQ_MODEL,
                _GRADE_SYSTEM + " Your prior JSON was invalid. Return a non-empty c array and b object exactly as specified.",
                user,
            )
            if strict.get("c") or strict.get("topics"):
                result = strict
                coverage, depth = _map_compact_coverage(result, topics, str(state.get("submission_id", "unknown")), f"chunk {index} retry")
            else:
                coverage = [{"topic": topic, "score": 0.0, "evidence": [], "missing": ["Evaluation response could not be parsed"]} for topic in topics]
                depth = {"score": 1.0, "label": "surface", "feedback_draft": ""}
        per_chunk.append(coverage)
        depths.append(depth)

    merged: list[dict[str, Any]] = []
    synthesis_input: list[dict[str, Any]] = []
    for topic in topics:
        matches = [item for chunk_result in per_chunk for item in chunk_result if _norm_criterion(item["topic"]) == _norm_criterion(topic)]
        strongest = max(matches, key=lambda item: float(item.get("score", 0) or 0), default={})
        evidence = list(dict.fromkeys(value for item in matches for value in item.get("evidence", [])))[:2]
        missing = list(dict.fromkeys(value for item in matches for value in item.get("missing", [])))[:2]
        merged.append({"topic": topic, "score": float(strongest.get("score", 0) or 0), "evidence": evidence, "missing": missing})
        synthesis_input.append({"t": topic, "s": [item.get("score", 0) for item in matches], "e": evidence, "m": missing})

    final_depth = depths[0] if depths else {"score": 1.0, "label": "surface"}
    feedback_draft = ""
    if len(chunks) > 1:
        synthesis_user = "\n".join((static_context, "Evidence by criterion from all parts (overlap may repeat):", json.dumps(synthesis_input, ensure_ascii=False)))
        for evidence_limit in (2, 1, 0):
            compact = [{"t": item["t"], "s": item["s"], "e": item["e"][:evidence_limit], "m": item["m"][:2]} for item in synthesis_input]
            synthesis_user = "\n".join((static_context, "Evidence by criterion from all parts (overlap may repeat):", json.dumps(compact, ensure_ascii=False)))
            if len(synthesis_user) <= MAX_GROQ_USER_CHARS:
                break
        synthesis = _checkpointed_json(
            state, "grade_synthesis", settings.GROQ_MODEL, _SYNTHESIS_SYSTEM, synthesis_user,
            max_completion_tokens=700,
        )
        synthesized, final_depth = _map_compact_coverage(synthesis, topics, str(state.get("submission_id", "unknown")), "synthesis")
        synth_by_topic = {_norm_criterion(item["topic"]): item for item in synthesized}
        for item in merged:
            final = synth_by_topic.get(_norm_criterion(item["topic"]))
            if final:
                # Preserve positive chunk evidence if synthesis returned none.
                if final.get("evidence") or not item.get("evidence"):
                    item.update(final)
        feedback_draft = str(synthesis.get("f") or "").strip()

    mastery = _build_mastery(state, merged, final_depth)
    updates = {"topic_coverage": merged, "mastery_result": mastery, "feedback_draft": feedback_draft}
    _save_checkpoint(state, "grade_result", updates)
    return updates


def _feedback_node(
    state: EvaluationState,
    use_course_materials: bool,
) -> EvaluationState:
    cached_feedback = _load_checkpoint(state, "feedback_result")
    if cached_feedback is not None:
        return cached_feedback
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

    retrieved_count = 0
    if collection is not None:
        for item in weak_topics:
            if retrieved_count >= 3:
                break
            topic = str(item.get("topic", "General"))
            try:
                result = collection.query(
                    query_embeddings=[_encode_texts([topic])[0]],
                    n_results=3,
                    include=["documents", "metadatas"],
                )
                documents = (result.get("documents") or [[]])[0]
                metadatas = (result.get("metadatas") or [[]])[0]
                selected = []
                for index, document in enumerate(documents):
                    if not document or retrieved_count >= 3:
                        continue
                    metadata = metadatas[index] if index < len(metadatas) and isinstance(metadatas[index], dict) else {}
                    selected.append({
                        "text": str(document)[:400],
                        "source": str(metadata.get("source", "course material"))[:100],
                    })
                    retrieved_count += 1
                retrieved[topic] = selected
            except Exception:
                retrieved[topic] = []

    context = "\n\n".join(
        f"[{topic}] {chunk['text']} (Source: {chunk['source']})"
        for topic, chunks in retrieved.items() for chunk in chunks
    )
    if not partial_topics:
        feedback = "## What You Did Well\nYour submission covered the assessed criteria."
    elif state.get("feedback_draft"):
        feedback = str(state["feedback_draft"]).strip()
    elif len(state.get("submission_chunks") or _chunk_submission(state.get("raw_text", ""))) > 1:
        # Multi-chunk synthesis already consumed the per-submission feedback
        # call budget. Keep feedback useful without a fifth Groq request.
        feedback = "## Conceptual Gaps & Misconceptions\nReview the specific rubric items listed below."
    elif weak_topics:
        feedback_criteria = [
            {
                "topic": item.get("topic"),
                "score": item.get("score"),
                "max_points": item.get("max_points"),
                "missing": [str(value)[:120] for value in (item.get("missing") or [])[:2]],
            }
            for item in partial_topics
        ]
        result = _checkpointed_json(
            state,
            "feedback",
            settings.GROQ_MODEL,
            "Write accurate academic feedback in Markdown. Return JSON only with a feedback_markdown string. "
            "Include What You Did Well, Conceptual Gaps & Misconceptions, and a Targeted Action Plan. "
            "Distinguish between criteria fully met and partially met, and name concrete unmet rubric elements. "
            + (
                "Use the supplied course context to ground recommendations and cite its source labels when used."
                if retrieved
                else "Use only the supplied rubric evidence; do not invent course materials or citations."
            ),
            f"Partial rubric criteria only: {json.dumps(feedback_criteria, ensure_ascii=False)}\nCourse context (max 3 chunks, 400 chars each):\n{context}",
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

    updates = {"retrieved_chunks": retrieved, "feedback_markdown": feedback}
    _save_checkpoint(state, "feedback_result", updates)
    return updates


def rag_feedback_node(state: EvaluationState) -> EvaluationState:
    return _feedback_node(state, use_course_materials=True)


def rubric_feedback_node(state: EvaluationState) -> EvaluationState:
    return _feedback_node(state, use_course_materials=False)


def feedback_node(state: EvaluationState) -> EvaluationState:
    return _feedback_node(state, use_course_materials=state.get("feedback_mode") == "rag")


def finalize_node(state: EvaluationState) -> EvaluationState:
    return {"final_status": "flagged" if state.get("plagiarism_flag") else "graded"}


_EVALUATION_STEPS: dict[str, Callable[[EvaluationState], EvaluationState]] = {
    "integrity": integrity_node,
    "grade": grade_node,
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
    state.update(prepare_node(state))
    # Equivalent to the LangGraph supersteps, preserving node behavior and
    # state merge semantics when the optional LangGraph package is unavailable.
    state.update(integrity_node(state))
    state.update(grade_node(state))
    state.update(feedback_node(state))
    state.update(finalize_node(state))
    state["execution_step"] = len(state.get("execution_plan", []))
    return state


def build_evaluation_graph():
    if StateGraph is None:
        return None
    graph = StateGraph(EvaluationState)
    graph.add_node("prepare", prepare_node)
    graph.add_node("integrity", integrity_node)
    graph.add_node("grade", grade_node)
    graph.add_node("feedback", feedback_node)
    graph.add_node("finalize", finalize_node)
    graph.set_entry_point("prepare")
    graph.add_edge("prepare", "integrity")
    graph.add_edge("prepare", "grade")
    graph.add_edge(["integrity", "grade"], "feedback")
    graph.add_edge("feedback", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()


EVALUATION_GRAPH = build_evaluation_graph()


def run_evaluation_graph(initial: EvaluationState) -> EvaluationState:
    """Run the compiled Phase 4 graph and return its final state."""
    _check_daily_token_budget()
    if EVALUATION_GRAPH is None:
        return _run_sequential(initial)
    return EVALUATION_GRAPH.invoke(initial)
