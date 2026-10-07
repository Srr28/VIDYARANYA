"""
Phase 3: Asynchronous Task Queue Service.

Decouples heavy processing (AI grading, note vectorization, analytics generation)
from synchronous HTTP request/response loops.

Supports:
  1. ARQ + Redis (local Redis container or Upstash serverless Redis via rediss://)
  2. Resilient In-Process Async Fallback (when Redis is offline, unconfigured, or QUEUE_MODE="in_process")
"""

import asyncio
import logging
import ssl
from typing import Any, Callable
from urllib.parse import urlparse
import uuid

from app.core.config import settings

logger = logging.getLogger("vidyaranya.queue")

try:
    from arq import create_pool
    from arq.connections import ArqRedis, RedisSettings
    ARQ_AVAILABLE = True
except ImportError:
    create_pool = None
    ArqRedis = Any  # type: ignore
    RedisSettings = Any  # type: ignore
    ARQ_AVAILABLE = False


def parse_redis_url(url: str) -> dict[str, Any]:
    """Parse a redis:// or rediss:// connection URL into RedisSettings kwargs."""
    parsed = urlparse(url)
    is_ssl = parsed.scheme == "rediss"
    
    host = parsed.hostname or "localhost"
    port = parsed.port or 6379
    password = parsed.password
    
    db = 0
    if parsed.path and parsed.path.lstrip("/").isdigit():
        db = int(parsed.path.lstrip("/"))
        
    ssl_context = None
    if is_ssl:
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

    return {
        "host": host,
        "port": port,
        "database": db,
        "password": password,
        "ssl": ssl_context if is_ssl else None,
    }


def get_redis_settings() -> Any:
    """Construct ARQ RedisSettings from the application configuration."""
    if not ARQ_AVAILABLE:
        return None
    
    redis_kwargs = parse_redis_url(settings.REDIS_URL)
    return RedisSettings(
        host=redis_kwargs["host"],
        port=redis_kwargs["port"],
        database=redis_kwargs["database"],
        password=redis_kwargs["password"],
        ssl=redis_kwargs["ssl"],
        conn_timeout=10,
    )


class QueueService:
    """Manages task enqueuing and pool lifecycle with graceful fallback."""

    def __init__(self) -> None:
        self._pool: Any | None = None
        self._lock = asyncio.Lock()
        self._fallback_handlers: dict[str, Callable] = {}

    def register_fallback_handler(self, task_name: str, handler: Callable) -> None:
        """Register a Python callable to execute tasks locally if Redis is not used."""
        self._fallback_handlers[task_name] = handler

    async def get_pool(self) -> Any | None:
        """Get or initialize the ARQ Redis pool. Returns None if unreachable or disabled."""
        if settings.QUEUE_MODE == "in_process" or not ARQ_AVAILABLE:
            return None

        if self._pool is not None:
            return self._pool

        async with self._lock:
            if self._pool is not None:
                return self._pool
            try:
                redis_settings = get_redis_settings()
                if redis_settings:
                    self._pool = await create_pool(redis_settings)
                    logger.info("Connected to ARQ Redis task queue at %s", settings.REDIS_URL)
                    return self._pool
            except Exception as exc:
                logger.warning(
                    "Redis queue connection failed (%s); operating in in-process fallback mode.",
                    exc,
                )
                self._pool = None
                return None

    async def close(self) -> None:
        """Close the active Redis connection pool."""
        if self._pool is not None:
            try:
                await self._pool.close()
            except Exception as exc:
                logger.debug("Error closing Redis pool: %s", exc)
            self._pool = None

    async def enqueue_task(self, task_name: str, *args: Any, **kwargs: Any) -> str:
        """
        Enqueue a job by name.
        Uses Redis if available; otherwise dispatches asynchronously in-process.
        """
        job_id = kwargs.pop("job_id", None) or f"{task_name}_{uuid.uuid4().hex[:12]}"
        
        pool = await self.get_pool()
        if pool is not None:
            try:
                job = await pool.enqueue_job(task_name, *args, _job_id=job_id, **kwargs)
                if job:
                    return job.job_id
            except Exception as exc:
                logger.warning(
                    "Failed to enqueue '%s' to Redis (%s); executing via in-process background worker.",
                    task_name,
                    exc,
                )

        # Fallback: In-process async execution
        handler = self._fallback_handlers.get(task_name)
        if handler:
            ctx = {"job_id": job_id, "job_try": 1, "is_fallback": True}
            asyncio.create_task(self._run_fallback(handler, ctx, *args, **kwargs))
        else:
            logger.error("No handler registered for task '%s' in fallback mode", task_name)

        return job_id

    async def _run_fallback(self, handler: Callable, ctx: dict[str, Any], *args: Any, **kwargs: Any) -> None:
        try:
            if asyncio.iscoroutinefunction(handler):
                await handler(ctx, *args, **kwargs)
            else:
                await asyncio.to_thread(handler, ctx, *args, **kwargs)
        except Exception as exc:
            logger.exception("In-process task '%s' failed: %s", getattr(handler, "__name__", str(handler)), exc)

    async def enqueue_submission_evaluation(self, submission_id: str | uuid.UUID) -> str:
        """Enqueue an assignment submission for AI evaluation."""
        return await self.enqueue_task("evaluate_submission_task", str(submission_id))

    async def enqueue_note_indexing(self, note_id: str | uuid.UUID) -> str:
        """Enqueue a course note / lecture material for vectorization and indexing."""
        return await self.enqueue_task("index_note_task", str(note_id))

    async def enqueue_class_analytics(self, assignment_id: str | uuid.UUID) -> str:
        """Enqueue class-level analytics computation for an assignment."""
        return await self.enqueue_task("generate_class_analytics_task", str(assignment_id))


queue_service = QueueService()
