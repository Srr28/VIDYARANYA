"""Process-local request pacing shared by all Groq-backed app features."""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from typing import Any

from app.core.config import settings

logger = logging.getLogger("vidyaranya.groq_limiter")
_LOCK = threading.Lock()
_CALL_TIMES: deque[float] = deque()
_LAST_CALL_AT = 0.0
_COOLDOWN_UNTIL = 0.0
_WINDOW_SECONDS = 60.0


def pace_groq_call() -> None:
    """Reserve a request in the rolling RPM window and honor active cooldowns."""
    global _LAST_CALL_AT
    while True:
        with _LOCK:
            now = time.monotonic()
            while _CALL_TIMES and now - _CALL_TIMES[0] >= _WINDOW_SECONDS:
                _CALL_TIMES.popleft()

            max_calls = max(1, int(settings.GROQ_MAX_CALLS_PER_MINUTE))
            min_interval = _WINDOW_SECONDS / max_calls
            wait_for = max(0.0, _COOLDOWN_UNTIL - now)
            if _LAST_CALL_AT:
                wait_for = max(wait_for, min_interval - (now - _LAST_CALL_AT))
            if len(_CALL_TIMES) >= max_calls:
                wait_for = max(wait_for, _CALL_TIMES[0] + _WINDOW_SECONDS - now + 0.001)

            if wait_for <= 0:
                _CALL_TIMES.append(now)
                _LAST_CALL_AT = now
                return

        logger.info("Waiting %.1fs to stay within Groq request pacing", wait_for)
        time.sleep(wait_for)


def set_groq_cooldown(seconds: float) -> None:
    """Stop new Groq requests in this process until the provider cooldown ends."""
    global _COOLDOWN_UNTIL
    with _LOCK:
        _COOLDOWN_UNTIL = max(_COOLDOWN_UNTIL, time.monotonic() + max(0.0, float(seconds)))


def _retry_after_seconds(headers: Any, message: str = "") -> int:
    retry_after = (headers or {}).get("retry-after")
    if retry_after is not None:
        try:
            return max(1, int(float(retry_after) + 1))
        except (TypeError, ValueError):
            match = re.search(r"(?:(\d+)m)?(\d+(?:\.\d+)?)s", str(retry_after), re.IGNORECASE)
            if match:
                return max(1, int(int(match.group(1) or 0) * 60 + float(match.group(2) or 0) + 1))

    match = re.search(r"try again in\s+(?:(\d+)m)?(\d+(?:\.\d+)?)s", message, re.IGNORECASE)
    if match:
        return max(1, int(int(match.group(1) or 0) * 60 + float(match.group(2) or 0) + 1))
    return max(1, settings.WORKER_RATE_LIMIT_DEFAULT_RETRY_SECONDS)


def cool_down_after_groq_error(exc: Exception) -> None:
    """Share 429 cooldowns from SDK calls with later requests in this process."""
    response = getattr(exc, "response", None)
    status_code = getattr(exc, "status_code", None) or getattr(response, "status_code", None)
    if status_code == 429 or "429" in str(exc) or "ratelimiterror" in exc.__class__.__name__.lower():
        set_groq_cooldown(_retry_after_seconds(getattr(response, "headers", {}), str(exc)))


def cool_down_after_groq_response(response: Any) -> None:
    """Share 429 cooldowns from direct HTTP calls with later requests."""
    if getattr(response, "status_code", None) == 429:
        set_groq_cooldown(_retry_after_seconds(getattr(response, "headers", {}), str(response.text)))
