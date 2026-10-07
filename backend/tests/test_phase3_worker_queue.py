"""
Phase 3: Asynchronous Task Worker & Job Queue Tests.

Tests:
  1. Redis URL parser & ARQ RedisSettings (redis:// and rediss:// Upstash TLS)
  2. Queue service enqueuing and in-process fallback dispatch
  3. evaluate_submission_task lifecycle: pending_eval -> evaluating -> graded
  4. Groq 429 rate limit detection and exponential backoff retry
  5. index_note_task execution and status update
  6. generate_class_analytics_task background execution
  7. Non-blocking submit endpoint (<300ms) with instant pending_eval return
  8. Polling endpoint GET /ai/status/{submission_id}
"""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base
from app.models.analytics_report import AnalyticsReport
from app.models.assignment import Assignment
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.note import Note
from app.models.submission import Submission
from app.models.submission_text import SubmissionText
from app.models.user import User
from app.services.queue_service import (
    QueueService,
    get_redis_settings,
    parse_redis_url,
    queue_service,
)
from app.worker import (
    _compute_mastery_level,
    _is_rate_limit_error,
    evaluate_submission_task,
    generate_class_analytics_task,
    index_note_task,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys = ON;")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def mock_db_scope(db_session):
    with patch("app.worker.SessionLocal", return_value=db_session), \
         patch.object(db_session, "close", MagicMock()):
        yield db_session


@pytest.fixture
def sample_data(db_session):
    teacher = User(
        name="Prof. Sharma",
        email="sharma@vidyaranya.edu",
        role="teacher",
    )
    student = User(
        name="Aarav Patel",
        email="aarav@vidyaranya.edu",
        role="student",
    )
    db_session.add_all([teacher, student])
    db_session.flush()

    course = Course(
        faculty_id=teacher.id,
        name="Data Structures & Algorithms",
        subject="Computer Science",
        join_code="DSA101",
    )
    db_session.add(course)
    db_session.flush()

    enrollment = Enrollment(course_id=course.id, student_id=student.id)
    db_session.add(enrollment)
    db_session.flush()

    assignment = Assignment(
        course_id=course.id,
        title="Binary Search Trees Implementation",
        description="Implement insert, search, and delete in BST.",
        max_marks=100,
        topics_list=["BST Insertion", "BST Search", "BST Deletion"],
        rubric=[
            {"criterion": "BST Insertion", "max_points": 30},
            {"criterion": "BST Search", "max_points": 30},
            {"criterion": "BST Deletion", "max_points": 40},
        ],
    )
    db_session.add(assignment)
    db_session.flush()

    submission = Submission(
        assignment_id=assignment.id,
        student_id=student.id,
        file_key=f"submissions/{assignment.id}/{student.id}/bst.py",
        text_content="def insert(root, val):\n    # BST insert implementation\n    pass",
        status="pending_eval",
    )
    db_session.add(submission)
    db_session.commit()

    return {
        "teacher": teacher,
        "student": student,
        "course": course,
        "assignment": assignment,
        "submission": submission,
    }


# ---------------------------------------------------------------------------
# 1. Redis URL Parser & Settings Tests
# ---------------------------------------------------------------------------


def test_parse_redis_url_standard():
    parsed = parse_redis_url("redis://localhost:6379/1")
    assert parsed["host"] == "localhost"
    assert parsed["port"] == 6379
    assert parsed["database"] == 1
    assert parsed["ssl"] is None


def test_parse_redis_url_upstash_ssl():
    parsed = parse_redis_url("rediss://default:mypassword@glowing-panda.upstash.io:6379/0")
    assert parsed["host"] == "glowing-panda.upstash.io"
    assert parsed["port"] == 6379
    assert parsed["password"] == "mypassword"
    assert parsed["ssl"] is not None


# ---------------------------------------------------------------------------
# 2. Mastery Level and Rate Limit Helper Tests
# ---------------------------------------------------------------------------


def test_compute_mastery_level():
    assert _compute_mastery_level(35, 100) == "Beginner"
    assert _compute_mastery_level(50, 100) == "Developing"
    assert _compute_mastery_level(75, 100) == "Proficient"
    assert _compute_mastery_level(95, 100) == "Advanced"
    assert _compute_mastery_level(0, 0) == "Beginner"


def test_is_rate_limit_error():
    assert _is_rate_limit_error(Exception("429 Too Many Requests"))
    assert _is_rate_limit_error(Exception("Groq rate limit reached. Please wait."))
    assert _is_rate_limit_error(Exception("quota exceeded"))
    assert not _is_rate_limit_error(Exception("Database connection timeout"))


# ---------------------------------------------------------------------------
# 3. Queue Service Enqueuing & Fallback Tests
# ---------------------------------------------------------------------------


def test_queue_service_fallback_execution():
    async def _run():
        test_queue = QueueService()
        executed = []

        async def sample_handler(ctx, item_id):
            executed.append((ctx["job_id"], item_id))

        test_queue.register_fallback_handler("sample_task", sample_handler)

        # Force in-process mode
        with patch.object(settings, "QUEUE_MODE", "in_process"):
            job_id = await test_queue.enqueue_task("sample_task", "item_123")
            assert job_id is not None
            await asyncio.sleep(0.05)  # yield to let async task execute
            assert len(executed) == 1
            assert executed[0][1] == "item_123"

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# 4. evaluate_submission_task Tests
# ---------------------------------------------------------------------------


def test_evaluate_submission_task_success(mock_db_scope, sample_data):
    async def _run():
        submission = sample_data["submission"]

        mock_grade_result = {
            "total_score": 85,
            "max_score": 100,
            "breakdown": [
                {"criterion": "BST Insertion", "score": 28, "max_points": 30, "feedback": "Solid logic."},
                {"criterion": "BST Search", "score": 27, "max_points": 30, "feedback": "Good binary split."},
                {"criterion": "BST Deletion", "score": 30, "max_points": 40, "feedback": "Minor edge case."},
            ],
            "general_feedback": "Excellent data structure comprehension.",
        }

        with patch("app.worker.grade", return_value=mock_grade_result):
            ctx = {"job_try": 1, "is_fallback": True}
            result = await evaluate_submission_task(ctx, str(submission.id))

            assert result["status"] == "graded"
            assert result["ai_score"] == 85.0
            assert result["mastery_level"] == "Advanced"

            # Verify DB persisted state
            db_sub = mock_db_scope.query(Submission).filter(Submission.id == submission.id).first()
            assert db_sub.status == "graded"
            assert float(db_sub.ai_score) == 85.0
            assert db_sub.mastery_level == "Advanced"
            assert db_sub.feedback_text == "Excellent data structure comprehension."

            # Verify SubmissionText was saved
            sub_text = mock_db_scope.query(SubmissionText).filter(SubmissionText.submission_id == submission.id).first()
            assert sub_text is not None
            assert "BST insert" in sub_text.raw_text

    asyncio.run(_run())


def test_evaluate_submission_task_rate_limit_retry(mock_db_scope, sample_data):
    async def _run():
        submission = sample_data["submission"]
        attempts = []

        def mock_grade_flaky(*args, **kwargs):
            attempts.append(len(attempts) + 1)
            if len(attempts) < 2:
                raise Exception("429 Rate limit exceeded. Try again later.")
            return {
                "total_score": 90,
                "max_score": 100,
                "breakdown": [],
                "general_feedback": "Great after retry!",
            }

        with patch("app.worker.grade", side_effect=mock_grade_flaky), \
             patch("app.worker.settings.WORKER_RETRY_DELAY", 0.01):
            ctx = {"job_try": 1, "is_fallback": True}
            result = await evaluate_submission_task(ctx, str(submission.id))

            assert result["status"] == "graded"
            assert len(attempts) == 2
            assert result["ai_score"] == 90.0

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# 5. index_note_task Tests
# ---------------------------------------------------------------------------


def test_index_note_task(mock_db_scope, sample_data):
    async def _run():
        course = sample_data["course"]
        note = Note(
            course_id=course.id,
            title="Lecture 1: Trees and Graphs",
            file_key=f"courses/{course.id}/notes/trees.txt",
            file_type="txt",
            chroma_indexed=False,
        )
        mock_db_scope.add(note)
        mock_db_scope.commit()

        with patch("app.worker.storage_service.download_file_bytes", return_value=b"Binary search trees are node-based binary tree data structures."), \
             patch("app.worker.extract_text_from_bytes", return_value="Binary search trees are node-based binary tree data structures."), \
             patch("app.worker.index_note") as mock_rag_index:

            ctx = {"job_try": 1, "is_fallback": True}
            result = await index_note_task(ctx, str(note.id))

            assert result["status"] == "indexed"
            mock_rag_index.assert_called_once()

            db_note = mock_db_scope.query(Note).filter(Note.id == note.id).first()
            assert db_note.chroma_indexed is True

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# 6. generate_class_analytics_task Tests
# ---------------------------------------------------------------------------


def test_generate_class_analytics_task(mock_db_scope, sample_data):
    async def _run():
        assignment_id = sample_data["assignment"].id
        submission = sample_data["submission"]
        submission.status = "graded"
        submission.final_score = 88.0
        submission.ai_score = 88.0
        submission.topic_scores = [{"criterion": "BST Insertion", "score": 28, "max_points": 30}]
        mock_db_scope.commit()

        ctx = {"job_try": 1, "is_fallback": True}
        result = await generate_class_analytics_task(ctx, str(assignment_id))

        assert result["status"] == "completed"
        assert result["assignment_id"] == str(assignment_id)

        report = mock_db_scope.query(AnalyticsReport).filter(AnalyticsReport.assignment_id == assignment_id).first()
        assert report is not None
        assert report.grade_distribution is not None

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# 7. Non-Blocking Submission Endpoint & Status Polling Tests (<300ms)
# ---------------------------------------------------------------------------


def test_submit_assignment_non_blocking_latency(mock_db_scope, sample_data):
    from app.api.submissions import submit_assignment, get_ai_evaluation_status

    async def _run():
        student = sample_data["student"]
        assignment = sample_data["assignment"]

        start_time = time.time()
        with patch.object(queue_service, "enqueue_submission_evaluation", return_value="job_test_123"):
            response = await submit_assignment(
                assignment_id=assignment.id,
                file=None,
                file_key=f"submissions/{assignment.id}/{student.id}/solution.py",
                private_comment="Please evaluate quickly.",
                db=mock_db_scope,
                current_user=student,
            )
        elapsed_ms = (time.time() - start_time) * 1000.0

        # Verification Criteria: POST /assignments/{id}/submit returns in < 300ms
        assert elapsed_ms < 300.0, f"Submit endpoint took {elapsed_ms:.2f}ms, which exceeds 300ms limit"
        assert response["status"] == "pending_eval"
        assert response["submission_id"] is not None

        # Verify polling endpoint returns pending_eval initially
        sub_uuid = uuid.UUID(response["submission_id"])
        status_res = get_ai_evaluation_status(sub_uuid, mock_db_scope, student)
        assert status_res["status"] == "pending_eval"
        assert status_res["submission_id"] == str(sub_uuid)

    asyncio.run(_run())


def test_full_submission_to_graded_lifecycle(mock_db_scope, sample_data):
    """
    End-to-End lifecycle verification:
    1. Student submits assignment -> returns status 'pending_eval'
    2. Background worker evaluates submission -> updates status to 'graded'
    3. Status polling endpoint returns final AI scores and breakdown
    """
    from app.api.submissions import submit_assignment, get_ai_evaluation_status

    async def _run():
        student = sample_data["student"]
        assignment = sample_data["assignment"]

        mock_eval = {
            "total_score": 92,
            "max_score": 100,
            "breakdown": [{"criterion": "BST Insertion", "score": 30, "max_points": 30, "feedback": "Flawless."}],
            "general_feedback": "Outstanding implementation of tree algorithms.",
        }

        # Step 1: Submit assignment (returns pending_eval)
        with patch("app.worker.grade", return_value=mock_eval):
            response = await submit_assignment(
                assignment_id=assignment.id,
                file=None,
                file_key=f"submissions/{assignment.id}/{student.id}/bst_full.py",
                private_comment="",
                db=mock_db_scope,
                current_user=student,
            )
            sub_id = response["submission_id"]
            assert response["status"] == "pending_eval"

            # Step 2: Worker processes the job
            ctx = {"job_try": 1, "is_fallback": True}
            worker_result = await evaluate_submission_task(ctx, sub_id)
            assert worker_result["status"] == "graded"

            # Step 3: Polling endpoint returns completed grade
            status_res = get_ai_evaluation_status(uuid.UUID(sub_id), mock_db_scope, student)
            assert status_res["status"] == "graded"
            assert status_res["ai_score"] == 92.0
            assert status_res["mastery_level"] == "Advanced"
            assert "Outstanding" in status_res["feedback_text"]

    asyncio.run(_run())

