"""Assignment-level prompt context compression cached in Redis."""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger("vidyaranya.evaluation.context")
RUBRIC_CACHE_TTL = 180 * 24 * 60 * 60
REFERENCE_DIGEST_CACHE_TTL = 180 * 24 * 60 * 60
MAX_REFERENCE_DIGEST_CHARS = 900


def _redis_client():
    # Import lazily to avoid a module cycle: eval_graph imports these helpers.
    from app.services.agents.eval_graph import _groq_redis

    return _groq_redis()


def _rubric_key(rubric: list[dict[str, Any]]) -> str:
    canonical = json.dumps(rubric or [], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"vidyaranya:rubric:{digest}"


def _reference_digest_key(reference_text: str) -> str:
    digest = hashlib.sha256(reference_text.encode("utf-8")).hexdigest()
    return f"vidyaranya:refdigest:{digest}"


def build_compact_rubric(rubric: list[dict[str, Any]]) -> str:
    """Build a stable short rubric with descriptions capped at 160 characters."""
    lines = []
    for index, item in enumerate(rubric or [], start=1):
        if not isinstance(item, dict):
            continue
        criterion = " ".join(str(item.get("criterion") or "").split())
        if not criterion:
            continue
        description = " ".join(str(item.get("description") or "").split())[:160]
        points = item.get("max_points", item.get("max_score", 0))
        lines.append(f"{index}. {criterion} ({points} pts): {description}".rstrip())
    return "\n".join(lines)


def get_compact_rubric(rubric: list[dict[str, Any]]) -> str:
    key = _rubric_key(rubric)
    try:
        client = _redis_client()
        cached = client.get(key) if client is not None else None
        if cached:
            value = cached.decode("utf-8") if isinstance(cached, bytes) else str(cached)
            return value
    except Exception:
        logger.warning("Could not read compact rubric cache; rebuilding locally", exc_info=True)
    compact = build_compact_rubric(rubric)
    try:
        client = _redis_client()
        if client is not None:
            client.set(key, compact, ex=RUBRIC_CACHE_TTL)
    except Exception:
        logger.warning("Could not cache compact rubric; continuing with local value", exc_info=True)
    return compact


def get_reference_digest(reference_text: str) -> str:
    """Read the assignment digest without making an LLM call during grading."""
    if not reference_text:
        return ""
    try:
        client = _redis_client()
        cached = client.get(_reference_digest_key(reference_text)) if client is not None else None
        if cached:
            value = cached.decode("utf-8") if isinstance(cached, bytes) else str(cached)
            return value[:MAX_REFERENCE_DIGEST_CHARS]
    except Exception:
        logger.warning("Could not read reference digest cache; using short source excerpt", exc_info=True)
    return reference_text[:MAX_REFERENCE_DIGEST_CHARS]


def warm_reference_digest(reference_text: str) -> str:
    """Generate and cache a short answer-key digest in a background task."""
    source = (reference_text or "").strip()
    if not source:
        return ""
    key = _reference_digest_key(source)
    try:
        client = _redis_client()
        cached = client.get(key) if client is not None else None
        if cached:
            value = cached.decode("utf-8") if isinstance(cached, bytes) else str(cached)
            return value[:MAX_REFERENCE_DIGEST_CHARS]
    except Exception:
        logger.warning("Could not inspect reference digest cache before warming", exc_info=True)

    # Keep very large answer keys bounded so warming never reserves an
    # unbounded share of the free-tier minute budget.
    source_for_digest = source[:12_000]
    model = settings.GROQ_LIGHT_MODEL.strip() or settings.GROQ_MODEL
    system = (
        "Create a compact grading digest of a teacher answer key. Preserve the core facts, valid methods, "
        "important alternatives, and common misconceptions. Return JSON only as {\"digest\":\"...\"}; "
        "the digest must be at most 900 characters."
    )
    try:
        from app.services.agents.eval_graph import _ask_json

        result = _ask_json(
            model,
            system,
            "Answer key to compress:\n" + source_for_digest,
            max_completion_tokens=400,
        )
        digest = " ".join(str(result.get("digest") or "").split())[:MAX_REFERENCE_DIGEST_CHARS]
        if not digest:
            return source[:MAX_REFERENCE_DIGEST_CHARS]
        client = _redis_client()
        if client is not None:
            client.set(key, digest, ex=REFERENCE_DIGEST_CACHE_TTL)
        return digest
    except Exception:
        logger.warning("Could not generate reference digest; grading will use a short source excerpt", exc_info=True)
        return source[:MAX_REFERENCE_DIGEST_CHARS]


def warm_assignment_context(rubric: list[dict[str, Any]], reference_text: str = "") -> None:
    """Warm cheap rubric formatting and answer-key digest after assignment writes."""
    get_compact_rubric(rubric or [])
    if reference_text:
        warm_reference_digest(reference_text)
