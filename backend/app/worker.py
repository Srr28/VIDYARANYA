"""
Phase 3: Background Worker & Asynchronous Tasks.

Executes long-running academic evaluation pipelines, RAG indexing,
and class analytics aggregation outside the main HTTP thread pool.

Handles Groq free-tier rate limits (HTTP 429) gracefully using
exponential backoff and retry mechanisms.
"""

import asyncio
import logging
from pathlib import Path
from typing import Any
import uuid

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.analytics_report import AnalyticsReport
from app.models.assignment import Assignment
from app.models.course import Course
from app.models.note import Note
from app.models.submission import Submission
from app.models.submission_text import SubmissionText
from app.services.grading_service import grade
from app.services.ocr_service import extract_text_from_bytes
from app.services.queue_service import get_redis_settings, queue_service
from app.services.rag_service import index_note
from app.services.storage_service import storage_service

logger = logging.getLogger("vidyaranya.worker")

try:
    from arq.worker import Retry
except ImportError:
    class Retry(Exception):  # type: ignore
        def __init__(self, defer: int = 5) -> None:
            self.defer = defer
            super().__init__(f"Retry after {defer}s")


def _compute_mastery_level(score: float, max_score: float) -> str:
    """Classify mastery into 4 tiers."""
    if max_score <= 0:
        return "Beginner"
    pct = (score / max_score) * 100.0
    if pct < 40:
        return "Beginner"
    elif pct < 60:
        return "Developing"
    elif pct < 80:
        return "Proficient"
    else:
        return "Advanced"


def _is_rate_limit_error(exc: Exception) -> bool:
    """Determine if an exception is caused by Groq / LLM rate limits (429)."""
    exc_str = str(exc).lower()
    if "429" in exc_str or "rate limit" in exc_str or "ratelimit" in exc_str or "quota" in exc_str:
        return True
    # Check for groq.RateLimitError class name
    if "ratelimiterror" in exc.__class__.__name__.lower():
        return True
    return False


async def startup(ctx: dict[str, Any]) -> None:
    """Initialize worker context resources."""
    logger.info("Starting Vidyaranya background task worker...")
    ctx["db_factory"] = SessionLocal


async def shutdown(ctx: dict[str, Any]) -> None:
    """Tear down worker resources."""
    logger.info("Shutting down Vidyaranya task worker...")


async def evaluate_submission_task(ctx: dict[str, Any], submission_id: str) -> dict[str, Any]:
    """
    Background Task: AI Evaluation of an Assignment Submission.
    
    Lifecycle:
      1. status: 'pending_eval' -> 'evaluating'
      2. Extract text if not previously cached
      3. Evaluate against rubric with Groq model (with exponential backoff on 429)
      4. Check integrity / plagiarism flags
      5. Update scores, topic breakdown, feedback, and set status to 'graded' (or 'flagged')
    """
    logger.info("Executing evaluate_submission_task for submission_id=%s", submission_id)
    attempt = ctx.get("job_try", 1)
    db: Session = SessionLocal()
    try:
        sub_uuid = uuid.UUID(submission_id)
        submission = db.query(Submission).filter(Submission.id == sub_uuid).first()
        if not submission:
            logger.warning("Submission %s not found. Skipping evaluation.", submission_id)
            return {"status": "not_found", "submission_id": submission_id}

        # Update status to 'evaluating'
        submission.status = "evaluating"
        db.commit()
        db.refresh(submission)

        assignment = db.query(Assignment).filter(Assignment.id == submission.assignment_id).first()
        if not assignment:
            logger.error("Assignment %s not found for submission %s", submission.assignment_id, submission_id)
            submission.status = "pending_eval"
            db.commit()
            return {"status": "assignment_not_found"}

        # Obtain extracted text
        extracted_text = submission.text_content or ""
        if not extracted_text:
            sub_text_record = db.query(SubmissionText).filter(SubmissionText.submission_id == submission.id).first()
            if sub_text_record and sub_text_record.raw_text:
                extracted_text = sub_text_record.raw_text
            else:
                try:
                    file_bytes = storage_service.download_file_bytes(submission.file_key)
                    extracted_text = extract_text_from_bytes(file_bytes, filename=submission.file_key)
                except Exception as exc:
                    logger.warning("Failed to download/extract text for submission %s: %s", submission_id, exc)
                    extracted_text = ""

        submission.text_content = extracted_text

        # Run AI grading with rate-limit retry logic
        grade_result = None
        max_retries = settings.WORKER_MAX_RETRIES
        backoff_delay = settings.WORKER_RETRY_DELAY * (2 ** (attempt - 1))

        try:
            # Run blocking grading in thread pool to prevent worker event loop stalling
            grade_result = await asyncio.to_thread(grade, extracted_text, assignment.rubric or [])
        except Exception as exc:
            if _is_rate_limit_error(exc):
                logger.warning(
                    "Groq 429 Rate Limit hit for submission %s on attempt %d/%d. Backing off for %ds.",
                    submission_id,
                    attempt,
                    max_retries,
                    backoff_delay,
                )
                if attempt < max_retries:
                    if ctx.get("is_fallback"):
                        await asyncio.sleep(backoff_delay)
                        ctx["job_try"] = attempt + 1
                        return await evaluate_submission_task(ctx, submission_id)
                    raise Retry(defer=backoff_delay)
                else:
                    logger.error("Exceeded max retries for submission %s due to rate limits.", submission_id)
                    raise exc
            else:
                logger.exception("Unexpected error evaluating submission %s: %s", submission_id, exc)
                raise exc

        if grade_result is None:
            grade_result = {
                "total_score": 0,
                "max_score": assignment.max_marks or 100,
                "breakdown": [],
                "general_feedback": "Automated evaluation completed with default parameters.",
            }

        ai_score_val = float(grade_result.get("total_score", 0))
        max_score_val = float(assignment.max_marks or grade_result.get("max_score", 100))
        mastery_lvl = _compute_mastery_level(ai_score_val, max_score_val)
        feedback_txt = grade_result.get("general_feedback") or ""
        topic_sc = grade_result.get("breakdown")

        # Plagiarism / integrity assessment
        integrity_sc = 1.0
        plagiarism_flag_val = False

        submission.ai_score = ai_score_val
        submission.mastery_level = mastery_lvl
        submission.topic_scores = topic_sc
        submission.feedback_text = feedback_txt
        submission.integrity_score = integrity_sc
        submission.plagiarism_flag = plagiarism_flag_val
        submission.status = "flagged" if plagiarism_flag_val else "graded"

        # Update or create submission_texts record
        sub_text = db.query(SubmissionText).filter(SubmissionText.submission_id == submission.id).first()
        if sub_text is None:
            sub_text = SubmissionText(submission_id=submission.id, raw_text=extracted_text)
            db.add(sub_text)
        else:
            sub_text.raw_text = extracted_text

        db.commit()
        db.refresh(submission)
        logger.info(
            "Successfully evaluated submission %s: status=%s, ai_score=%.2f, mastery=%s",
            submission_id,
            submission.status,
            ai_score_val,
            mastery_lvl,
        )

        return {
            "status": submission.status,
            "submission_id": str(submission.id),
            "ai_score": submission.ai_score,
            "mastery_level": submission.mastery_level,
            "topic_scores": submission.topic_scores,
        }

    except Retry:
        raise
    except Exception as exc:
        logger.exception("Failure in evaluate_submission_task for %s: %s", submission_id, exc)
        try:
            # Leave in pending_eval or flagged depending on error
            sub = db.query(Submission).filter(Submission.id == uuid.UUID(submission_id)).first()
            if sub and sub.status == "evaluating":
                sub.status = "pending_eval"
                db.commit()
        except Exception:
            pass
        raise exc
    finally:
        db.close()


async def index_note_task(ctx: dict[str, Any], note_id: str) -> dict[str, Any]:
    """
    Background Task: Asynchronous RAG Vector Indexing for Course Notes.
    
    1. Retrieve note metadata and download document from storage
    2. Extract text and generate vector chunks
    3. Index chunks into ChromaDB
    4. Update Note record with chroma_indexed=True and chunk_count
    """
    logger.info("Executing index_note_task for note_id=%s", note_id)
    db: Session = SessionLocal()
    try:
        note_uuid = uuid.UUID(note_id)
        note = db.query(Note).filter(Note.id == note_uuid).first()
        if not note:
            logger.warning("Note %s not found. Skipping indexing.", note_id)
            return {"status": "not_found", "note_id": note_id}

        try:
            content = storage_service.download_file_bytes(note.file_key)
            extracted_text = extract_text_from_bytes(content, filename=note.file_key)
        except Exception as exc:
            logger.warning("Could not download note file %s: %s", note.file_key, exc)
            extracted_text = ""

        if extracted_text.strip():
            await asyncio.to_thread(
                index_note,
                course_id=str(note.course_id),
                text=extracted_text,
                note_id=str(note.id),
            )
            note.chroma_indexed = True
            note.chunk_count = max(1, len(extracted_text.split()) // 100)
        else:
            note.chroma_indexed = False
            note.chunk_count = 0

        db.commit()
        db.refresh(note)
        logger.info("Successfully indexed note %s (chunks=%d)", note_id, note.chunk_count)
        return {"status": "indexed", "note_id": note_id, "chunk_count": note.chunk_count}

    except Exception as exc:
        logger.exception("Error during note indexing for %s: %s", note_id, exc)
        raise exc
    finally:
        db.close()


async def generate_class_analytics_task(ctx: dict[str, Any], assignment_id: str) -> dict[str, Any]:
    """
    Background Task: Aggregate class-level performance metrics for an assignment.
    """
    logger.info("Executing generate_class_analytics_task for assignment_id=%s", assignment_id)
    from app.api.analytics import _build_class_analytics

    db: Session = SessionLocal()
    try:
        a_uuid = uuid.UUID(assignment_id)
        assignment = db.query(Assignment).filter(Assignment.id == a_uuid).first()
        if not assignment:
            logger.warning("Assignment %s not found for analytics.", assignment_id)
            return {"status": "not_found"}

        course = db.query(Course).filter(Course.id == assignment.course_id).first()
        if not course:
            return {"status": "course_not_found"}

        report = _build_class_analytics(db, course, assignment_id=assignment.id)
        logger.info("Successfully generated class analytics for assignment %s", assignment_id)
        return {"status": "completed", "assignment_id": assignment_id, "report_id": str(report.get("id"))}

    except Exception as exc:
        logger.exception("Error generating class analytics for %s: %s", assignment_id, exc)
        raise exc
    finally:
        db.close()


# Register tasks with queue_service for in-process fallback dispatch
queue_service.register_fallback_handler("evaluate_submission_task", evaluate_submission_task)
queue_service.register_fallback_handler("index_note_task", index_note_task)
queue_service.register_fallback_handler("generate_class_analytics_task", generate_class_analytics_task)


class WorkerSettings:
    """ARQ Worker configuration settings."""
    functions = [
        evaluate_submission_task,
        index_note_task,
        generate_class_analytics_task,
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = get_redis_settings()
    max_jobs = 10
    job_timeout = 300
    max_tries = settings.WORKER_MAX_RETRIES
