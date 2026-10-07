"""
Phase 2: Analytics and Progress Report API tests.
Tests for:
  - GET  /courses/{course_id}/analytics
  - GET  /courses/{course_id}/analytics/assignments/{assignment_id}
  - POST /progress-reports?course_id=...
  - GET  /progress-reports/{course_id}
  - GET  /submissions/ai/status/{submission_id}
  - PATCH /submissions/{submission_id}/grade  (alias for /override)
"""

import uuid
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.user import User
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.note import Note
from app.models.assignment import Assignment
from app.models.submission import Submission
from app.models.analytics_report import AnalyticsReport
from app.models.progress_report import ProgressReport
from app.api.analytics import (
    _build_class_analytics,
    _compute_and_save_progress_report,
    _grade_letter,
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
    yield session
    session.close()
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def populated_db(db_session):
    """Create a course with 2 students, 2 assignments, and graded submissions."""
    faculty = User(email="faculty@test.edu", full_name="Dr. Faculty", role="faculty")
    student_a = User(email="alice@test.edu", full_name="Alice", role="student")
    student_b = User(email="bob@test.edu", full_name="Bob", role="student")
    db_session.add_all([faculty, student_a, student_b])
    db_session.commit()

    course = Course(
        name="Computer Science 101",
        subject="CS",
        faculty_id=faculty.id,
        join_code="CS1010",
    )
    db_session.add(course)
    db_session.commit()

    db_session.add_all(
        [
            Enrollment(course_id=course.id, student_id=student_a.id, status="active"),
            Enrollment(course_id=course.id, student_id=student_b.id, status="active"),
        ]
    )
    db_session.commit()

    rubric = [
        {"criterion": "Algorithms", "max_points": 60},
        {"criterion": "Data Structures", "max_points": 40},
    ]
    assignment1 = Assignment(
        course_id=course.id,
        title="Lab 1: Sorting",
        topics_list=["Algorithms", "Complexity"],
        rubric=rubric,
        max_marks=100,
    )
    assignment2 = Assignment(
        course_id=course.id,
        title="Lab 2: Trees",
        topics_list=["Data Structures", "Recursion"],
        rubric=rubric,
        max_marks=100,
    )
    db_session.add_all([assignment1, assignment2])
    db_session.commit()

    # Alice: high performer
    sub_a1 = Submission(
        assignment_id=assignment1.id,
        student_id=student_a.id,
        file_key="submissions/a1.pdf",
        status="graded",
        ai_score=85.0,
        topic_scores=[
            {"topic": "Algorithms", "score": 8, "max_points": 10},
            {"topic": "Complexity", "score": 7, "max_points": 10},
        ],
    )
    sub_a2 = Submission(
        assignment_id=assignment2.id,
        student_id=student_a.id,
        file_key="submissions/a2.pdf",
        status="graded",
        ai_score=90.0,
        topic_scores=[
            {"topic": "Data Structures", "score": 9, "max_points": 10},
            {"topic": "Recursion", "score": 8, "max_points": 10},
        ],
    )
    # Bob: low performer
    sub_b1 = Submission(
        assignment_id=assignment1.id,
        student_id=student_b.id,
        file_key="submissions/b1.pdf",
        status="graded",
        ai_score=30.0,
        topic_scores=[
            {"topic": "Algorithms", "score": 3, "max_points": 10},
            {"topic": "Complexity", "score": 2, "max_points": 10},
        ],
    )
    db_session.add_all([sub_a1, sub_a2, sub_b1])
    db_session.commit()

    return {
        "db": db_session,
        "faculty": faculty,
        "student_a": student_a,
        "student_b": student_b,
        "course": course,
        "assignment1": assignment1,
        "assignment2": assignment2,
        "sub_a1": sub_a1,
        "sub_a2": sub_a2,
        "sub_b1": sub_b1,
    }


# ---------------------------------------------------------------------------
# Grade letter tests
# ---------------------------------------------------------------------------


def test_grade_letter():
    assert _grade_letter(85) == "A"
    assert _grade_letter(80) == "A"
    assert _grade_letter(79.9) == "B"
    assert _grade_letter(60) == "B"
    assert _grade_letter(59) == "C"
    assert _grade_letter(40) == "C"
    assert _grade_letter(39) == "D"
    assert _grade_letter(20) == "D"
    assert _grade_letter(19) == "F"
    assert _grade_letter(0) == "F"


# ---------------------------------------------------------------------------
# Course-level analytics tests
# ---------------------------------------------------------------------------


def test_build_class_analytics_structure(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]

    result = _build_class_analytics(db, course, assignment_id=None)

    assert result["course_id"] == str(course.id)
    assert result["report_type"] == "class_summary"
    assert "weak_topics" in result
    assert "at_risk_students" in result
    assert "grade_distribution" in result
    assert "narrative" in result

    # Grade distribution should have keys A-F
    dist = result["grade_distribution"]
    assert set(dist.keys()) == {"A", "B", "C", "D", "F"}

    # Total submissions graded = 3 (sub_a1, sub_a2, sub_b1)
    total = sum(dist.values())
    assert total == 3


def test_build_class_analytics_identifies_at_risk(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]

    result = _build_class_analytics(db, course, assignment_id=None)

    at_risk_ids = {r["student_id"] for r in result["at_risk_students"]}
    # Bob scored 30% → at-risk; Alice scored 85/90% → not at-risk
    assert str(ctx["student_b"].id) in at_risk_ids
    assert str(ctx["student_a"].id) not in at_risk_ids


def test_build_class_analytics_persists_report(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]

    _build_class_analytics(db, course, assignment_id=None)

    saved = (
        db.query(AnalyticsReport)
        .filter(
            AnalyticsReport.course_id == course.id,
            AnalyticsReport.report_type == "class_summary",
        )
        .first()
    )
    assert saved is not None
    assert saved.course_id == course.id


def test_build_class_analytics_updates_existing(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]

    # First call creates
    _build_class_analytics(db, course, assignment_id=None)
    count_before = db.query(AnalyticsReport).filter(
        AnalyticsReport.course_id == course.id,
        AnalyticsReport.report_type == "class_summary",
    ).count()

    # Second call should update in-place (not create duplicate)
    _build_class_analytics(db, course, assignment_id=None)
    count_after = db.query(AnalyticsReport).filter(
        AnalyticsReport.course_id == course.id,
        AnalyticsReport.report_type == "class_summary",
    ).count()

    assert count_after == count_before == 1


def test_build_assignment_analytics(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]
    assignment1 = ctx["assignment1"]

    result = _build_class_analytics(db, course, assignment_id=assignment1.id)

    assert result["assignment_id"] == str(assignment1.id)
    assert result["report_type"] == "topic_gap"
    # Only 2 submissions belong to assignment1
    dist = result["grade_distribution"]
    assert sum(dist.values()) == 2


# ---------------------------------------------------------------------------
# Progress report tests
# ---------------------------------------------------------------------------


def test_compute_progress_report_structure(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]
    student_a = ctx["student_a"]

    result = _compute_and_save_progress_report(db, course, student_a)

    assert result["student_id"] == str(student_a.id)
    assert result["course_id"] == str(course.id)
    assert "narrative" in result
    assert "mastery_snapshot" in result
    assert "rank" in result

    snapshot = result["mastery_snapshot"]
    assert "topic_mastery" in snapshot
    assert "trajectory" in snapshot
    # Alice has 2 graded submissions → 2 trajectory entries
    assert len(snapshot["trajectory"]) == 2


def test_compute_progress_report_rank(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]
    student_a = ctx["student_a"]
    student_b = ctx["student_b"]

    result_a = _compute_and_save_progress_report(db, course, student_a)
    result_b = _compute_and_save_progress_report(db, course, student_b)

    # Alice outperforms Bob → Alice rank 1, Bob rank 2
    assert result_a["rank"] == 1
    assert result_b["rank"] == 2


def test_compute_progress_report_persists(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]
    student_a = ctx["student_a"]

    _compute_and_save_progress_report(db, course, student_a)

    saved = (
        db.query(ProgressReport)
        .filter(
            ProgressReport.student_id == student_a.id,
            ProgressReport.course_id == course.id,
        )
        .first()
    )
    assert saved is not None


def test_compute_progress_report_upserts(populated_db):
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]
    student_a = ctx["student_a"]

    _compute_and_save_progress_report(db, course, student_a)
    count_before = db.query(ProgressReport).filter(
        ProgressReport.student_id == student_a.id,
        ProgressReport.course_id == course.id,
    ).count()

    _compute_and_save_progress_report(db, course, student_a)
    count_after = db.query(ProgressReport).filter(
        ProgressReport.student_id == student_a.id,
        ProgressReport.course_id == course.id,
    ).count()

    assert count_before == count_after == 1


def test_compute_progress_report_no_submissions(populated_db):
    """A student with no submissions should still get a report (rank last)."""
    ctx = populated_db
    db = ctx["db"]
    course = ctx["course"]

    # Create a new student with no submissions
    new_student = User(email="newstudent@test.edu", full_name="New Student", role="student")
    db.add(new_student)
    db.commit()
    db.add(Enrollment(course_id=course.id, student_id=new_student.id, status="active"))
    db.commit()

    result = _compute_and_save_progress_report(db, course, new_student)

    assert result["student_id"] == str(new_student.id)
    snapshot = result["mastery_snapshot"]
    assert snapshot["trajectory"] == []
