"""
Phase 3: Background Worker & Asynchronous Tasks.

Executes long-running academic evaluation pipelines, RAG indexing,
and class analytics aggregation outside the main HTTP thread pool.

Handles Groq free-tier rate limits (HTTP 429) gracefully using
exponential backoff and retry mechanisms.
"""

import asyncio
from functools import lru_cache
import json
import logging
import math
from pathlib import Path
import re
from datetime import datetime, timezone
from typing import Any
import uuid

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.db.phase4_schema import ensure_submission_depth_columns
from app.models.analytics_report import AnalyticsReport
from app.models.assignment import Assignment
from app.models.assignment_attachment import AssignmentAttachment
from app.models.assignment_reference import AssignmentReference
from app.models.course import Course
from app.models.note import Note
from app.models.submission import Submission
from app.models.submission_text import SubmissionText
from app.services.agents.eval_graph import integrity_node, run_evaluation_graph
from app.services.agents.eval_graph import EvaluationOutputError
from app.services.grading_service import grade
from app.services.groq_service import (
    GroqConfigurationError,
    GroqRateLimitDeferred,
    GroqRequestTooLarge,
    retry_after_seconds,
)
from app.services.ocr_service import extract_text_from_bytes
from app.services.queue_service import get_redis_settings, queue_service
from app.services.rag_service import index_note
from app.services.storage_service import storage_service

logger = logging.getLogger("vidyaranya.worker")
_legacy_grade = grade


@lru_cache(maxsize=96)
def _cached_context_file(file_key: str, filename: str, mime_type: str | None) -> str:
    """Extract immutable teacher material once per worker process and file key."""
    data = storage_service.download_file_bytes(file_key)
    return extract_text_from_bytes(data, filename=filename, mime_type=mime_type or "")


async def _load_teacher_context_file(file_key: str, filename: str, mime_type: str | None) -> str:
    try:
        return await asyncio.to_thread(_cached_context_file, file_key, filename, mime_type)
    except Exception as exc:
        logger.warning("Could not extract teacher context file %s: %s", filename, exc)
        return ""


def _select_context_excerpt(text: str, query: str, max_chars: int) -> str:
    """Choose the most assignment-relevant bounded passage from teacher material."""
    cleaned = (text or "").strip()
    if len(cleaned) <= max_chars:
        return cleaned
    query_terms = set(re.findall(r"[\w-]{3,}", (query or "").casefold()))
    if not query_terms:
        return cleaned[:max_chars]

    step = max(1, max_chars // 2)
    starts = list(range(0, max(1, len(cleaned) - max_chars + 1), step))
    starts.append(max(0, len(cleaned) - max_chars))
    best_start = 0
    best_score = -1
    for start in starts:
        window = cleaned[start : start + max_chars]
        terms = set(re.findall(r"[\w-]{3,}", window.casefold()))
        score = len(query_terms & terms)
        if score > best_score:
            best_start, best_score = start, score
    return cleaned[best_start : best_start + max_chars]

try:
    from arq import cron
    from arq.worker import Retry
except ImportError:
    cron = None

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
    """Detect Groq rate-limit errors, including token-limit responses returned as 413."""
    if isinstance(exc, GroqRateLimitDeferred):
        return True
    exc_str = str(exc).lower()
    if any(marker in exc_str for marker in (
        "429",
        "rate limit",
        "rate_limit_exceeded",
        "ratelimit",
        "tokens per minute",
        "quota",
    )):
        return True
    # Check for groq.RateLimitError class name
    if "ratelimiterror" in exc.__class__.__name__.lower():
        return True
    return False


def _rate_limit_retry_after_seconds(exc: Exception) -> int | None:
    """Extract Groq's suggested wait (for example, `20m46.7s`) when present."""
    if isinstance(exc, GroqRateLimitDeferred):
        return max(1, math.ceil(exc.wait_seconds))
    provider_wait = retry_after_seconds(exc)
    if provider_wait:
        return provider_wait
    match = re.search(r"try again in\s+(?:(\d+)m)?(\d+(?:\.\d+)?)s", str(exc), re.IGNORECASE)
    if not match:
        return None
    minutes = int(match.group(1) or 0)
    seconds = float(match.group(2) or 0)
    return max(1, int(minutes * 60 + seconds + 2))


async def startup(ctx: dict[str, Any]) -> None:
    """Initialize worker context resources."""
    logger.info("Starting Vidyaranya background task worker...")
    ensure_submission_depth_columns(engine)
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

        assignment = db.query(Assignment).filter(Assignment.id == submission.assignment_id).first()
        if not assignment:
            logger.error("Assignment %s not found for submission %s", submission.assignment_id, submission_id)
            submission.status = "pending_eval"
            db.commit()
            return {"status": "assignment_not_found"}

        if not assignment.ai_eval_enabled:
            submission.status = "pending"
            submission.ai_score = None
            submission.mastery_level = None
            submission.depth_score = None
            submission.depth_label = None
            submission.topic_scores = None
            submission.integrity_score = None
            submission.plagiarism_flag = False
            submission.feedback_text = "AI evaluation is disabled for this assignment. Your teacher will review the submission."
            db.commit()
            return {"status": submission.status, "submission_id": submission_id, "reason": "ai_evaluation_disabled"}

        submission.status = "evaluating"
        db.commit()
        db.refresh(submission)

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

        logger.info(
            "Extracted %d characters for submission %s",
            len(extracted_text),
            submission_id,
        )
        submission.text_content = extracted_text
        if len(extracted_text) > settings.MAX_AI_SUBMISSION_CHARS:
            submission.status = "pending"
            submission.ai_score = None
            submission.mastery_level = None
            submission.depth_score = None
            submission.depth_label = None
            submission.topic_scores = None
            submission.integrity_score = None
            submission.plagiarism_flag = False
            submission.feedback_text = (
                f"This file contains more than {settings.MAX_AI_SUBMISSION_CHARS:,} characters, "
                "which exceeds the safe AI evaluation limit. No partial score was recorded; please ask your teacher to review it."
            )
            db.commit()
            return {"status": submission.status, "submission_id": submission_id, "reason": "evaluation_input_too_large"}
        if not extracted_text.strip():
            # Never convert an unreadable/unsupported upload into an AI zero.
            # Leave it for teacher review and tell the student what happened.
            submission.status = "pending"
            submission.ai_score = None
            submission.mastery_level = None
            submission.depth_score = None
            submission.depth_label = None
            submission.topic_scores = None
            submission.feedback_text = (
                "AI could not extract readable text from this file, so it was not scored. "
                "Please ask your teacher to review the upload or submit a clearer, text-readable file."
            )
            submission.integrity_score = None
            submission.plagiarism_flag = False
            db.commit()
            return {"status": submission.status, "submission_id": submission_id, "reason": "no_readable_text"}

        # Run AI grading with rate-limit retry logic
        grade_result = None
        evaluation_state: dict[str, Any] | None = None
        max_retries = settings.WORKER_MAX_RETRIES
        backoff_delay = settings.WORKER_RETRY_DELAY * (2 ** (attempt - 1))

        reference_solution = (
            db.query(AssignmentReference.solution_text)
            .filter(AssignmentReference.assignment_id == assignment.id)
            .scalar()
            or ""
        )
        assignment_context_query = "\n".join([
            str(assignment.title or ""),
            str(assignment.description or ""),
            json.dumps(assignment.topics_list or [], ensure_ascii=False),
            json.dumps(assignment.rubric or [], ensure_ascii=False),
            reference_solution,
        ])
        reference_note_context = ""
        if assignment.reference_note_id:
            reference_note = (
                db.query(Note)
                .filter(
                    Note.id == assignment.reference_note_id,
                    Note.course_id == assignment.course_id,
                )
                .first()
            )
            if reference_note:
                extracted_note = await _load_teacher_context_file(
                    reference_note.file_key,
                    f"{reference_note.title}{Path(reference_note.file_key).suffix}",
                    reference_note.file_type,
                )
                excerpt = _select_context_excerpt(extracted_note, assignment_context_query, 800)
                reference_note_context = f"{reference_note.title}: {excerpt}".strip()

        attachment_rows = (
            db.query(AssignmentAttachment)
            .filter(AssignmentAttachment.assignment_id == assignment.id)
            .order_by(AssignmentAttachment.created_at.asc())
            .all()
        )
        attachment_semaphore = asyncio.Semaphore(3)

        async def extract_attachment(item: AssignmentAttachment) -> str:
            async with attachment_semaphore:
                return await _load_teacher_context_file(item.file_path, item.file_name, item.mime_type)

        attachment_texts = await asyncio.gather(*(extract_attachment(item) for item in attachment_rows))
        chars_per_attachment = max(1, 1200 // max(len(attachment_rows), 1))
        title_chars = max(8, chars_per_attachment // 3)
        assignment_attachment_context = "\n".join(
            f"{item.title[:title_chars]}: "
            f"{_select_context_excerpt(content, assignment_context_query, max(0, chars_per_attachment - title_chars - 4))}"
            for item, content in zip(attachment_rows, attachment_texts)
        )

        try:
            # Run the Phase 4 LangGraph pipeline in a thread so blocking Groq,
            # ChromaDB, and embedding calls do not stall the ARQ event loop.
            if grade is not _legacy_grade:
                # Compatibility hook for existing tests and explicitly mocked
                # legacy grading integrations. Production uses the graph below.
                grade_result = await asyncio.to_thread(grade, extracted_text, assignment.rubric or [])
            else:
                evaluation_state = await asyncio.to_thread(
                    run_evaluation_graph,
                    {
                        "submission_id": str(submission.id),
                        "assignment_id": str(assignment.id),
                        "course_id": str(assignment.course_id),
                        "assignment_title": assignment.title or "",
                        "assignment_description": assignment.description or "",
                        "raw_text": extracted_text,
                        "rubric": assignment.rubric or [],
                        "reference_solution": reference_solution,
                        "reference_note_id": str(assignment.reference_note_id) if assignment.reference_note_id else None,
                        "reference_note_context": reference_note_context,
                        "assignment_attachment_context": assignment_attachment_context,
                        "topics_list": assignment.topics_list or [],
                        "max_score": float(assignment.max_marks or 100),
                    },
                )
                mastery_result = evaluation_state.get("mastery_result", {})
                grade_result = {
                    "total_score": mastery_result.get("total_score"),
                    "max_score": mastery_result.get("max_score", assignment.max_marks or 100),
                    "breakdown": mastery_result.get("topic_scores", []),
                    "depth_score": mastery_result.get("depth_score"),
                    "depth_label": mastery_result.get("depth_label"),
                    "general_feedback": evaluation_state.get("feedback_markdown", ""),
                    "integrity_score": evaluation_state.get("integrity_score", 1.0),
                    "plagiarism_flag": evaluation_state.get("plagiarism_flag", False),
                    "plagiarism_matches": evaluation_state.get("plagiarism_matches", []),
                }
        except Exception as exc:
            if isinstance(exc, (EvaluationOutputError, GroqConfigurationError, GroqRequestTooLarge)):
                logger.error("Submission %s was not graded because the AI result was unavailable: %s", submission_id, exc)
                submission.status = "pending"
                submission.ai_score = None
                submission.mastery_level = None
                submission.depth_score = None
                submission.depth_label = None
                submission.topic_scores = None
                submission.integrity_score = None
                submission.plagiarism_flag = False
                submission.feedback_text = (
                    "AI could not produce a complete, safely bounded evaluation for this submission. "
                    "No automated score was recorded; please ask your teacher to review it."
                )
                db.commit()
                return {"status": submission.status, "submission_id": submission_id, "reason": "manual_review_required"}
            if _is_rate_limit_error(exc):
                provider_wait = _rate_limit_retry_after_seconds(exc)
                retry_delay = max(backoff_delay, provider_wait or 0)
                submission.status = "pending_eval"
                submission.feedback_text = "AI evaluation is queued and waiting for Groq capacity."
                db.commit()
                logger.warning(
                    "Groq 429 Rate Limit hit for submission %s on attempt %d/%d. Backing off for %ds%s.",
                    submission_id,
                    attempt,
                    max_retries,
                    retry_delay,
                    " (provider retry-after)" if provider_wait else "",
                )
                if attempt < max_retries:
                    if ctx.get("is_fallback"):
                        if retry_delay > 600:
                            submission.status = "pending"
                            submission.feedback_text = (
                                "AI evaluation is delayed by the Groq account rate limit. "
                                "Please retry evaluation later from the assignment."
                            )
                            db.commit()
                            return {"status": submission.status, "submission_id": submission_id, "reason": "rate_limit_deferred"}
                        await asyncio.sleep(retry_delay)
                        ctx["job_try"] = attempt + 1
                        return await evaluate_submission_task(ctx, submission_id)
                    raise Retry(defer=retry_delay)
                else:
                    logger.error("Exceeded max retries for submission %s due to rate limits.", submission_id)
                    submission.status = "pending"
                    submission.feedback_text = (
                        "AI evaluation could not get Groq capacity after several retries. "
                        "Please ask your teacher to retry it later."
                    )
                    db.commit()
                    return {"status": submission.status, "submission_id": submission_id, "reason": "rate_limit_retries_exhausted"}
            else:
                logger.exception("Unexpected error evaluating submission %s: %s", submission_id, exc)
                if ctx.get("is_fallback") and attempt < max_retries:
                    submission.status = "pending_eval"
                    submission.feedback_text = "AI evaluation hit a temporary error and is retrying."
                    db.commit()
                    await asyncio.sleep(backoff_delay)
                    ctx["job_try"] = attempt + 1
                    return await evaluate_submission_task(ctx, submission_id)
                raise exc

        if grade_result is None:
            raise EvaluationOutputError("The grader returned no result; no score can be published.")

        if evaluation_state is not None:
            # Repeat the inexpensive integrity lookup after the long AI grading
            # calls so concurrent submissions have had time to enter the index.
            latest_integrity = await asyncio.to_thread(
                integrity_node,
                {
                    "submission_id": str(submission.id),
                    "assignment_id": str(assignment.id),
                    "raw_text": extracted_text,
                    "integrity_embedding": evaluation_state.get("integrity_embedding", []),
                },
            )
            evaluation_state.update(latest_integrity)
            grade_result["integrity_score"] = latest_integrity.get("integrity_score", 1.0)
            grade_result["plagiarism_flag"] = latest_integrity.get("plagiarism_flag", False)
            grade_result["plagiarism_matches"] = latest_integrity.get("plagiarism_matches", [])

        try:
            ai_score_val = float(grade_result["total_score"])
            if not math.isfinite(ai_score_val):
                raise ValueError("Non-finite AI score")
        except (KeyError, TypeError, ValueError) as exc:
            raise EvaluationOutputError("The grader returned an invalid total score.") from exc
        max_score_val = float(assignment.max_marks or grade_result.get("max_score", 100))
        if not math.isfinite(max_score_val) or max_score_val <= 0:
            raise EvaluationOutputError("Assignment maximum score must be greater than zero.")
        ai_score_val = max(0.0, min(max_score_val, ai_score_val))
        mastery_lvl = _compute_mastery_level(ai_score_val, max_score_val)
        feedback_txt = grade_result.get("general_feedback") or ""
        topic_sc = grade_result.get("breakdown")

        # Plagiarism / integrity assessment
        integrity_sc = float(grade_result.get("integrity_score", 1.0))
        plagiarism_flag_val = bool(grade_result.get("plagiarism_flag", False))

        db.refresh(assignment)
        if not assignment.ai_eval_enabled:
            submission.status = "pending"
            submission.ai_score = None
            submission.mastery_level = None
            submission.depth_score = None
            submission.depth_label = None
            submission.topic_scores = None
            submission.integrity_score = None
            submission.plagiarism_flag = False
            submission.feedback_text = "AI evaluation was disabled while this submission was processing. Your teacher will review it."
            db.commit()
            return {"status": submission.status, "submission_id": submission_id, "reason": "ai_evaluation_disabled"}

        submission.ai_score = ai_score_val
        submission.mastery_level = mastery_lvl
        submission.depth_score = grade_result.get("depth_score")
        submission.depth_label = grade_result.get("depth_label")
        submission.topic_scores = topic_sc
        submission.feedback_text = feedback_txt
        submission.integrity_score = integrity_sc
        submission.plagiarism_flag = plagiarism_flag_val
        submission.status = "flagged" if plagiarism_flag_val else "graded"

        # If a previously graded peer is found to match this submission, flag
        # that peer for teacher review too. In-flight peers will run the final
        # lookup above before saving their own result.
        for match in grade_result.get("plagiarism_matches", []):
            similarity = float(match.get("similarity", 0) or 0)
            if similarity <= 0.85:
                continue
            try:
                matched_id = uuid.UUID(str(match.get("submission_id", "")))
            except (ValueError, TypeError, AttributeError):
                continue
            if matched_id == submission.id:
                continue
            matched_submission = (
                db.query(Submission)
                .filter(
                    Submission.id == matched_id,
                    Submission.assignment_id == assignment.id,
                )
                .first()
            )
            if matched_submission and matched_submission.status in {"graded", "flagged"}:
                matched_submission.plagiarism_flag = True
                matched_submission.status = "flagged"
                peer_integrity = max(0.0, min(1.0, 1.0 - similarity))
                matched_submission.integrity_score = min(
                    float(matched_submission.integrity_score)
                    if matched_submission.integrity_score is not None
                    else 1.0,
                    peer_integrity,
                )

        # Update or create submission_texts record
        sub_text = db.query(SubmissionText).filter(SubmissionText.submission_id == submission.id).first()
        if sub_text is None:
            sub_text = SubmissionText(submission_id=submission.id, raw_text=extracted_text)
            db.add(sub_text)
        else:
            sub_text.raw_text = extracted_text

        db.commit()
        db.refresh(submission)
        # Build assignment analytics once every submitted file has reached a
        # terminal evaluation state. Teachers can refresh the class report on demand.
        if submission.status in {"graded", "flagged"}:
            unfinished_count = (
                db.query(Submission)
                .filter(
                    Submission.assignment_id == assignment.id,
                    Submission.status.in_(["pending_eval", "evaluating"]),
                )
                .count()
            )
            if unfinished_count == 0:
                await queue_service.enqueue_class_analytics(assignment.id)
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
            "depth_score": submission.depth_score,
            "depth_label": submission.depth_label,
            "topic_scores": submission.topic_scores,
        }

    except asyncio.CancelledError:
        # ARQ cancels the job coroutine when job_timeout expires. Keep the
        # submission retryable instead of leaving the UI stuck on evaluating.
        logger.warning("Evaluation task cancelled or timed out for submission %s", submission_id)
        try:
            db.rollback()
            sub = db.query(Submission).filter(Submission.id == uuid.UUID(submission_id)).first()
            if sub and sub.status in {"evaluating", "pending_eval"}:
                if int(ctx.get("job_try", 1)) >= settings.WORKER_MAX_RETRIES:
                    sub.status = "pending"
                    sub.feedback_text = (
                        "AI evaluation failed after automatic retries. No new score was recorded; "
                        "please ask your teacher to review it or retry later."
                    )
                else:
                    sub.status = "pending_eval"
                db.commit()
        except Exception:
            db.rollback()
        raise
    except Retry:
        raise
    except Exception as exc:
        if isinstance(exc, (EvaluationOutputError, GroqConfigurationError, GroqRequestTooLarge)):
            logger.error("Submission %s requires teacher review because AI grading failed safely: %s", submission_id, exc)
            try:
                sub = db.query(Submission).filter(Submission.id == uuid.UUID(submission_id)).first()
                if sub:
                    sub.status = "pending"
                    sub.ai_score = None
                    sub.mastery_level = None
                    sub.depth_score = None
                    sub.depth_label = None
                    sub.topic_scores = None
                    sub.integrity_score = None
                    sub.plagiarism_flag = False
                    sub.feedback_text = (
                        "AI could not produce a complete, safely bounded evaluation for this submission. "
                        "No automated score was recorded; please ask your teacher to review it."
                    )
                    db.commit()
                    return {"status": sub.status, "submission_id": submission_id, "reason": "manual_review_required"}
            except Exception:
                db.rollback()
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
    Background Task: Refresh course-level class metrics after an assignment's
    submitted work has completed evaluation.
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
        _build_class_analytics(db, course)
        logger.info("Successfully generated class analytics for assignment %s and refreshed course summary", assignment_id)
        return {"status": "completed", "assignment_id": assignment_id, "report_id": str(report.get("id"))}

    except Exception as exc:
        logger.exception("Error generating class analytics for %s: %s", assignment_id, exc)
        raise exc
    finally:
        db.close()


async def refresh_overdue_assignment_analytics_task(ctx: dict[str, Any]) -> dict[str, Any]:
    """Refresh class analytics after due dates, including students who did not submit.

    ARQ calls this periodically. It waits for submitted evaluations to finish,
    then refreshes the class report only if it predates a passed deadline.
    """
    from app.api.analytics import _assignment_deadline_passed, _build_class_analytics

    db: Session = SessionLocal()
    refreshed: list[str] = []
    waiting: list[str] = []
    try:
        now = datetime.now(timezone.utc)
        assignments = db.query(Assignment).filter(Assignment.due_date.is_not(None)).all()
        for assignment in assignments:
            due_date = assignment.due_date
            if due_date is None or not _assignment_deadline_passed(assignment):
                continue
            normalized_due_date = (
                due_date.replace(tzinfo=timezone.utc)
                if due_date.tzinfo is None
                else due_date
            )

            active_evaluations = (
                db.query(Submission)
                .filter(
                    Submission.assignment_id == assignment.id,
                    Submission.status.in_(["pending_eval", "evaluating"]),
                )
                .count()
            )
            if active_evaluations:
                waiting.append(str(assignment.id))
                continue

            latest_report = (
                db.query(AnalyticsReport)
                .filter(
                    AnalyticsReport.course_id == assignment.course_id,
                    AnalyticsReport.assignment_id.is_(None),
                    AnalyticsReport.report_type == "class_summary",
                )
                .order_by(AnalyticsReport.created_at.desc())
                .first()
            )
            report_time = latest_report.created_at if latest_report else None
            if report_time is not None:
                if report_time.tzinfo is None:
                    report_time = report_time.replace(tzinfo=timezone.utc)
                if report_time >= normalized_due_date:
                    continue

            course = db.query(Course).filter(Course.id == assignment.course_id).first()
            if not course:
                logger.warning("Course %s missing while refreshing deadline analytics", assignment.course_id)
                continue

            report = _build_class_analytics(db, course)
            refreshed.append(str(assignment.id))
            logger.info(
                "Refreshed deadline analytics for assignment %s after due date %s (report %s)",
                assignment.id,
                due_date.isoformat(),
                report.get("id"),
            )

        return {
            "status": "completed",
            "refreshed_assignments": refreshed,
            "waiting_for_evaluations": waiting,
            "checked_at": now.isoformat(),
        }
    except Exception:
        logger.exception("Failed to refresh analytics for assignments past their deadlines")
        raise
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
    # Shared Redis pacing protects the account budget while modest concurrency
    # keeps extraction and embedding work from serializing an entire class.
    max_jobs = settings.WORKER_MAX_JOBS
    job_timeout = 900
    max_tries = settings.WORKER_MAX_RETRIES
    cron_jobs = (
        [
            cron(
                refresh_overdue_assignment_analytics_task,
                minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55},
                run_at_startup=True,
            )
        ]
        if cron is not None
        else []
    )
