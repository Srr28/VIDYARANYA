"""Shared Groq client and conservative, cross-process request pacing."""

from __future__ import annotations

import logging
import math
import threading
import time
import uuid
from collections import deque
from typing import Any

from app.core.config import settings

logger = logging.getLogger("vidyaranya.groq")

try:
    from groq import Groq
except ImportError:  # pragma: no cover - dependency is installed in production images
    Groq = None  # type: ignore[assignment,misc]

try:
    import redis
except ImportError:  # pragma: no cover - dependency is installed in production images
    redis = None  # type: ignore[assignment]


class GroqConfigurationError(RuntimeError):
    """Groq cannot be called because the SDK or API key is unavailable."""


class GroqRequestTooLarge(ValueError):
    """The estimated request itself exceeds the app's token budget."""


class GroqRateLimitDeferred(RuntimeError):
    """The request was deferred to stay within the configured account budget."""

    def __init__(self, wait_seconds: float) -> None:
        self.wait_seconds = max(1.0, float(wait_seconds))
        super().__init__(f"Groq request deferred for {self.wait_seconds:.1f}s by the shared rate limiter")


_WINDOW_SECONDS = 60.0
_DAY_SECONDS = 24.0 * 60.0 * 60.0
_LOCAL_LOCK = threading.Lock()
_LOCAL_USAGE: deque[tuple[float, int]] = deque()
_CLIENT_LOCK = threading.Lock()
_GROQ_CLIENT: Any | None = None
_GROQ_CLIENT_KEY: str | None = None
_REDIS_CLIENT: Any | None = None
_REDIS_UNAVAILABLE_UNTIL = 0.0
_REDIS_WARNING_LOGGED = False


_RESERVE_SCRIPT = r"""
local key = KEYS[1]
local requested_tokens = tonumber(ARGV[1])
local tpm_budget = tonumber(ARGV[2])
local rpm_budget = tonumber(ARGV[3])
local rpd_budget = tonumber(ARGV[4])
local member = ARGV[5]
local minute_ms = 60000
local day_ms = 86400000
local now_parts = redis.call('TIME')
local now_ms = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms - day_ms)
local all = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
local day_count = #all / 2
local recent = {}
local recent_count = 0
local recent_tokens = 0

for index = 1, #all, 2 do
  local entry_member = all[index]
  local score = tonumber(all[index + 1])
  if score > now_ms - minute_ms then
    local token_count = tonumber(string.match(entry_member, '|(%d+)$')) or 0
    recent_count = recent_count + 1
    recent_tokens = recent_tokens + token_count
    recent[recent_count] = {score = score, tokens = token_count}
  end
end

local wait_ms = 0
if recent_count >= rpm_budget then
  local entries_to_expire = recent_count - rpm_budget + 1
  wait_ms = math.max(wait_ms, recent[entries_to_expire].score + minute_ms - now_ms)
end

if recent_tokens + requested_tokens > tpm_budget then
  local remaining = recent_tokens
  for index = 1, recent_count do
    remaining = remaining - recent[index].tokens
    if remaining + requested_tokens <= tpm_budget then
      wait_ms = math.max(wait_ms, recent[index].score + minute_ms - now_ms)
      break
    end
  end
end

if day_count >= rpd_budget then
  local entries_to_expire = day_count - rpd_budget + 1
  local oldest_needed_score = tonumber(all[(entries_to_expire - 1) * 2 + 2])
  wait_ms = math.max(wait_ms, oldest_needed_score + day_ms - now_ms)
end

if wait_ms > 0 then
  return {0, wait_ms}
end

redis.call('ZADD', key, now_ms, member)
redis.call('PEXPIRE', key, day_ms + minute_ms)
return {1, 0}
"""


def _messages_char_count(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        content = message.get("content", "")
        if isinstance(content, str):
            total += len(content)
        else:
            total += len(str(content))
    return total


def estimate_request_tokens(messages: list[dict[str, Any]], max_output_tokens: int) -> int:
    """Reserve prompt plus completion capacity before any agent sends a request."""
    # 3.5 chars/token leaves headroom for code, JSON, and punctuation-heavy prompts.
    return max(1, math.ceil(_messages_char_count(messages) / 3.5) + max(1, max_output_tokens))


def _get_redis_client() -> Any | None:
    global _REDIS_CLIENT, _REDIS_UNAVAILABLE_UNTIL, _REDIS_WARNING_LOGGED
    if redis is None or time.monotonic() < _REDIS_UNAVAILABLE_UNTIL:
        return None
    if _REDIS_CLIENT is not None:
        return _REDIS_CLIENT

    with _CLIENT_LOCK:
        if _REDIS_CLIENT is not None:
            return _REDIS_CLIENT
        try:
            _REDIS_CLIENT = redis.Redis.from_url(
                settings.REDIS_URL,
                decode_responses=True,
                socket_connect_timeout=0.4,
                socket_timeout=0.6,
                health_check_interval=30,
            )
            _REDIS_CLIENT.ping()
            return _REDIS_CLIENT
        except Exception as exc:
            _REDIS_CLIENT = None
            _REDIS_UNAVAILABLE_UNTIL = time.monotonic() + 30
            if not _REDIS_WARNING_LOGGED:
                logger.warning("Shared Groq pacing is unavailable; using a per-process fallback: %s", exc)
                _REDIS_WARNING_LOGGED = True
            return None


def _reserve_local(tokens: int, max_wait_seconds: float) -> float:
    """Fallback sliding-window limiter used when Redis is not reachable."""
    tpm_budget = int(settings.GROQ_TPM_BUDGET)
    rpm_budget = int(settings.GROQ_RPM_BUDGET)
    rpd_budget = int(settings.GROQ_RPD_BUDGET)
    if tokens > tpm_budget:
        raise GroqRequestTooLarge(
            f"Estimated Groq request is {tokens} tokens; configured per-minute budget is {tpm_budget}"
        )

    while True:
        with _LOCAL_LOCK:
            now = time.monotonic()
            while _LOCAL_USAGE and now - _LOCAL_USAGE[0][0] >= _DAY_SECONDS:
                _LOCAL_USAGE.popleft()

            day_events = list(_LOCAL_USAGE)
            minute_events = [(timestamp, count) for timestamp, count in day_events if now - timestamp < _WINDOW_SECONDS]
            minute_tokens = sum(count for _, count in minute_events)
            waits: list[float] = []

            if len(minute_events) >= rpm_budget:
                index = len(minute_events) - rpm_budget
                waits.append(minute_events[index][0] + _WINDOW_SECONDS - now)

            if minute_tokens + tokens > tpm_budget:
                remaining = minute_tokens
                for timestamp, count in minute_events:
                    remaining -= count
                    if remaining + tokens <= tpm_budget:
                        waits.append(timestamp + _WINDOW_SECONDS - now)
                        break

            if len(day_events) >= rpd_budget:
                index = len(day_events) - rpd_budget
                waits.append(day_events[index][0] + _DAY_SECONDS - now)

            wait = max(waits, default=0.0)
            if wait <= 0:
                _LOCAL_USAGE.append((now, tokens))
                return 0.0
            if wait > max_wait_seconds:
                raise GroqRateLimitDeferred(wait)
        time.sleep(max(0.05, min(wait, max_wait_seconds)))


def reserve_groq_usage(
    messages: list[dict[str, Any]],
    *,
    max_output_tokens: int,
    max_wait_seconds: float = 5.0,
) -> int:
    """Reserve shared request, token, and daily capacity before a Groq call.

    Redis makes limits consistent between the web service and ARQ workers. If
    Redis is unavailable, a conservative process-local sliding window remains
    active instead of disabling pacing.
    """
    tokens = estimate_request_tokens(messages, max_output_tokens)
    tpm_budget = int(settings.GROQ_TPM_BUDGET)
    if tokens > tpm_budget:
        raise GroqRequestTooLarge(
            f"Estimated Groq request is {tokens} tokens; configured per-minute budget is {tpm_budget}"
        )

    client = _get_redis_client()
    if client is None:
        _reserve_local(tokens, max_wait_seconds)
        return tokens

    started = time.monotonic()
    member = f"{uuid.uuid4().hex}|{tokens}"
    key = "vidyaranya:groq:usage:v1"
    while True:
        try:
            result = client.eval(
                _RESERVE_SCRIPT,
                1,
                key,
                tokens,
                settings.GROQ_TPM_BUDGET,
                settings.GROQ_RPM_BUDGET,
                settings.GROQ_RPD_BUDGET,
                member,
            )
        except Exception as exc:
            global _REDIS_CLIENT, _REDIS_UNAVAILABLE_UNTIL
            _REDIS_CLIENT = None
            _REDIS_UNAVAILABLE_UNTIL = time.monotonic() + 30
            logger.warning("Shared Groq pacing failed; applying local pacing for this process: %s", exc)
            _reserve_local(tokens, max_wait_seconds)
            return tokens

        reserved = int(result[0])
        wait_seconds = max(0.05, float(result[1]) / 1000.0)
        if reserved:
            return tokens
        if time.monotonic() - started + wait_seconds > max_wait_seconds:
            raise GroqRateLimitDeferred(wait_seconds)
        logger.info("Waiting %.1fs for the shared Groq request/token budget", wait_seconds)
        time.sleep(wait_seconds + 0.025)


def _get_groq_client() -> Any:
    global _GROQ_CLIENT, _GROQ_CLIENT_KEY
    api_key = (settings.GROQ_API_KEY or "").strip()
    if not api_key:
        raise GroqConfigurationError("GROQ_API_KEY is not configured")
    if Groq is None:
        raise GroqConfigurationError("The Groq Python package is not installed")

    if _GROQ_CLIENT is None or _GROQ_CLIENT_KEY != api_key:
        with _CLIENT_LOCK:
            if _GROQ_CLIENT is None or _GROQ_CLIENT_KEY != api_key:
                _GROQ_CLIENT = Groq(api_key=api_key, max_retries=0, timeout=60.0)
                _GROQ_CLIENT_KEY = api_key
    return _GROQ_CLIENT


def groq_chat_completion(
    messages: list[dict[str, Any]],
    *,
    max_output_tokens: int,
    temperature: float = 0.1,
    response_format: dict[str, Any] | None = None,
    max_wait_seconds: float = 5.0,
) -> Any:
    """Call the configured model with a shared budget and a reusable client."""
    client = _get_groq_client()
    reserve_groq_usage(
        messages,
        max_output_tokens=max_output_tokens,
        max_wait_seconds=max_wait_seconds,
    )
    kwargs: dict[str, Any] = {
        "model": settings.GROQ_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_output_tokens,
    }
    if response_format is not None:
        kwargs["response_format"] = response_format
    return client.chat.completions.create(**kwargs)


def groq_chat_stream(
    messages: list[dict[str, Any]],
    *,
    max_output_tokens: int,
    temperature: float = 0.2,
    max_wait_seconds: float = 5.0,
) -> Any:
    """Open a streamed completion after reserving the same shared budget."""
    client = _get_groq_client()
    reserve_groq_usage(
        messages,
        max_output_tokens=max_output_tokens,
        max_wait_seconds=max_wait_seconds,
    )
    return client.chat.completions.create(
        model=settings.GROQ_MODEL,
        messages=messages,
        temperature=temperature,
        max_tokens=max_output_tokens,
        stream=True,
    )


def retry_after_seconds(exc: Exception) -> int | None:
    """Read a provider Retry-After header before trying to parse its message."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) or {}
    for key in ("retry-after", "Retry-After"):
        value = headers.get(key)
        if value:
            try:
                return max(1, math.ceil(float(value)))
            except (TypeError, ValueError):
                pass
    return None
