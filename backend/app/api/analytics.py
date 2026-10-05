"""
Phase 2: Analytics & Progress Report API endpoints.

Provides:
  GET  /courses/{course_id}/analytics                          - Latest class-level analytics summary
  GET  /courses/{course_id}/analytics/assignments/{assignment_id} - Assignment-specific analytics
  POST /progress-reports                                       - Generate / refresh a student progress report
  GET  /progress-reports/{course_id}                          - Retrieve student's progress report for a course
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.analytics_report import AnalyticsReport
from app.models.assignment import Assignment
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.progress_report import ProgressReport
from app.models.submission import Submission
from app.models.user import User
from app.schemas.analytics import AnalyticsReportOut, ProgressReportOut

router = APIRouter(tags=["analytics"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_course_or_404(db: Session, course_id: uuid.UUID) -> Course:
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    return course


def _get_assignment_or_404(db: Session, assignment_id: uuid.UUID) -> Assignment:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    return assignment


def _is_enrolled(db: Session, course_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    return (
        db.query(Enrollment)
        .filter(Enrollment.course_id == course_id, Enrollment.student_id == user_id)
        .first()
    ) is not None


def _can_access_course(db: Session, course: Course, user: User) -> bool:
    if course.faculty_id == user.id:
        return True
    return _is_enrolled(db, course.id, user.id)


def _grade_letter(pct: float) -> str:
    if pct >= 80:
        return "A"
    if pct >= 60:
        return "B"
    if pct >= 40:
        return "C"
    if pct >= 20:
        return "D"
    return "F"


def _build_class_analytics(
    db: Session,
    course: Course,
    assignment_id: uuid.UUID | None = None,
) -> dict:
    """
    Compute class-level analytics in-process (no LLM yet; LLM narrative is
    added in Phase 5). Stores the result in ``analytics_reports`` and returns
    the computed dict.
    """
    if assignment_id:
        assignments = [_get_assignment_or_404(db, assignment_id)]
    else:
        assignments = db.query(Assignment).filter(Assignment.course_id == course.id).all()

    assignment_ids = [a.id for a in assignments]

    submissions: list[Submission] = (
        db.query(Submission)
        .filter(
            Submission.assignment_id.in_(assignment_ids),
            Submission.status == "graded",
        )
        .all()
    ) if assignment_ids else []

    # Aggregate topic scores
    topic_totals: dict[str, list[float]] = {}
    grade_dist: dict[str, int] = {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0}
    all_scores: list[float] = []
    student_score_map: dict[uuid.UUID, list[float]] = {}

    for sub in submissions:
        # Effective score (faculty override takes precedence)
        eff = float(sub.final_score if sub.final_score is not None else (sub.ai_score or 0.0))
        assignment = next((a for a in assignments if a.id == sub.assignment_id), None)
        max_marks = float(assignment.max_marks) if assignment and assignment.max_marks else 100.0
        pct = (eff / max_marks) * 100.0 if max_marks > 0 else 0.0
        all_scores.append(pct)
        grade_dist[_grade_letter(pct)] += 1
        student_score_map.setdefault(sub.student_id, []).append(pct)

        # Aggregate topic_scores if present
        if sub.topic_scores and isinstance(sub.topic_scores, list):
            for entry in sub.topic_scores:
                topic = entry.get("topic") or entry.get("criterion", "Unknown")
                score = float(entry.get("score", entry.get("points_awarded", 0)))
                max_val = float(entry.get("max_points", entry.get("max_score", 10)))
                topic_pct = (score / max_val * 100) if max_val > 0 else 0.0
                topic_totals.setdefault(topic, []).append(topic_pct)

    # Compute weak topics (average mastery < 60%)
    weak_topics = []
    for topic, scores in topic_totals.items():
        avg = sum(scores) / len(scores)
        if avg < 60:
            weak_topics.append({"topic": topic, "average_mastery_pct": round(avg, 2)})
    weak_topics.sort(key=lambda x: x["average_mastery_pct"])

    # At-risk students: average < 40% or zero graded submissions
    enrolled_students = (
        db.query(User)
        .join(Enrollment, Enrollment.student_id == User.id)
        .filter(Enrollment.course_id == course.id)
        .all()
    )
    at_risk = []
    for student in enrolled_students:
        scores = student_score_map.get(student.id, [])
        avg = sum(scores) / len(scores) if scores else 0.0
        if not scores or avg < 40:
            at_risk.append(
                {
                    "student_id": str(student.id),
                    "student_name": student.full_name,
                    "average_pct": round(avg, 2),
                    "submissions_graded": len(scores),
                    "reason": "no_submissions" if not scores else "low_score",
                }
            )

    report_type = "topic_gap" if assignment_id else "class_summary"
    narrative = (
        f"Class analytics for {course.name}. "
        f"{len(submissions)} graded submissions across {len(assignments)} assignment(s). "
        f"Weak topics: {[t['topic'] for t in weak_topics[:3]] or 'None identified'}. "
        f"At-risk students: {len(at_risk)}."
    )

    # Persist / update the report
    existing = (
        db.query(AnalyticsReport)
        .filter(
            AnalyticsReport.course_id == course.id,
            AnalyticsReport.assignment_id == assignment_id,
            AnalyticsReport.report_type == report_type,
        )
        .order_by(AnalyticsReport.created_at.desc())
        .first()
    )
    if existing:
        existing.weak_topics = weak_topics
        existing.at_risk_students = at_risk
        existing.narrative = narrative
        existing.grade_distribution = grade_dist
        db.commit()
        db.refresh(existing)
        return _report_payload(existing)
    else:
        report = AnalyticsReport(
            course_id=course.id,
            assignment_id=assignment_id,
            report_type=report_type,
            weak_topics=weak_topics,
            at_risk_students=at_risk,
            narrative=narrative,
            grade_distribution=grade_dist,
        )
        db.add(report)
        db.commit()
        db.refresh(report)
        return _report_payload(report)


def _report_payload(report: AnalyticsReport) -> dict:
    return {
        "id": str(report.id),
        "course_id": str(report.course_id),
        "assignment_id": str(report.assignment_id) if report.assignment_id else None,
        "report_type": report.report_type,
        "weak_topics": report.weak_topics,
        "at_risk_students": report.at_risk_students,
        "narrative": report.narrative,
        "grade_distribution": report.grade_distribution,
        "created_at": report.created_at,
    }


# ---------------------------------------------------------------------------
# Class Analytics Endpoints
# ---------------------------------------------------------------------------


@router.get("/courses/{course_id}/analytics")
def get_course_analytics(
    course_id: uuid.UUID,
    refresh: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Get the latest class-level analytics summary for a course.
    Faculty can also trigger a refresh by passing ``?refresh=true``.
    """
    course = _get_course_or_404(db, course_id)
    if not _can_access_course(db, course, current_user):
        raise HTTPException(status_code=403, detail="No access to this course")

    # If not refreshing, return the latest cached report if available
    if not refresh:
        cached = (
            db.query(AnalyticsReport)
            .filter(
                AnalyticsReport.course_id == course_id,
                AnalyticsReport.assignment_id.is_(None),
                AnalyticsReport.report_type == "class_summary",
            )
            .order_by(AnalyticsReport.created_at.desc())
            .first()
        )
        if cached:
            return _report_payload(cached)

    # Compute and persist fresh analytics
    return _build_class_analytics(db, course, assignment_id=None)


@router.get("/courses/{course_id}/analytics/assignments/{assignment_id}")
def get_assignment_analytics(
    course_id: uuid.UUID,
    assignment_id: uuid.UUID,
    refresh: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Get analytics for a specific assignment within a course.
    """
    course = _get_course_or_404(db, course_id)
    if not _can_access_course(db, course, current_user):
        raise HTTPException(status_code=403, detail="No access to this course")

    assignment = _get_assignment_or_404(db, assignment_id)
    if assignment.course_id != course_id:
        raise HTTPException(status_code=404, detail="Assignment not found in this course")

    if not refresh:
        cached = (
            db.query(AnalyticsReport)
            .filter(
                AnalyticsReport.course_id == course_id,
                AnalyticsReport.assignment_id == assignment_id,
            )
            .order_by(AnalyticsReport.created_at.desc())
            .first()
        )
        if cached:
            return _report_payload(cached)

    return _build_class_analytics(db, course, assignment_id=assignment_id)


# ---------------------------------------------------------------------------
# Student Progress Report Endpoints
# ---------------------------------------------------------------------------


@router.post("/progress-reports")
def generate_progress_report(
    course_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Generate (or refresh) the current user's longitudinal progress report for a course.
    Faculty can also generate a report for any student; students can only generate their own.
    """
    course = _get_course_or_404(db, course_id)
    if not _can_access_course(db, course, current_user):
        raise HTTPException(status_code=403, detail="No access to this course")

    if current_user.id == course.faculty_id:
        raise HTTPException(
            status_code=400, detail="Faculty members do not have progress reports"
        )

    return _compute_and_save_progress_report(db, course, current_user)


@router.get("/progress-reports/{course_id}")
def get_progress_report(
    course_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Retrieve the current user's most recent progress report for a course.
    """
    course = _get_course_or_404(db, course_id)
    if not _can_access_course(db, course, current_user):
        raise HTTPException(status_code=403, detail="No access to this course")

    report = (
        db.query(ProgressReport)
        .filter(
            ProgressReport.student_id == current_user.id,
            ProgressReport.course_id == course_id,
        )
        .order_by(ProgressReport.created_at.desc())
        .first()
    )
    if not report:
        # Auto-generate if none exists
        if current_user.id == course.faculty_id:
            raise HTTPException(status_code=404, detail="No progress report found")
        return _compute_and_save_progress_report(db, course, current_user)

    return _progress_report_payload(report)


def _compute_and_save_progress_report(
    db: Session, course: Course, student: User
) -> dict:
    """Compute the student's longitudinal progress across all assignments in the course."""
    assignments = (
        db.query(Assignment).filter(Assignment.course_id == course.id).all()
    )
    assignment_ids = [a.id for a in assignments]

    submissions = (
        db.query(Submission)
        .filter(
            Submission.assignment_id.in_(assignment_ids),
            Submission.student_id == student.id,
            Submission.status == "graded",
        )
        .order_by(Submission.created_at.asc())
        .all()
    ) if assignment_ids else []

    # Build mastery snapshot per topic across all graded submissions
    topic_scores: dict[str, list[float]] = {}
    trajectory: list[dict] = []

    for sub in submissions:
        assignment = next((a for a in assignments if a.id == sub.assignment_id), None)
        max_marks = float(assignment.max_marks) if assignment and assignment.max_marks else 100.0
        eff = float(sub.final_score if sub.final_score is not None else (sub.ai_score or 0.0))
        pct = (eff / max_marks) * 100.0 if max_marks > 0 else 0.0
        trajectory.append(
            {
                "assignment_id": str(sub.assignment_id),
                "assignment_title": assignment.title if assignment else "Unknown",
                "score_pct": round(pct, 2),
                "mastery_level": sub.mastery_level,
                "submitted_at": sub.created_at.isoformat() if sub.created_at else None,
            }
        )

        if sub.topic_scores and isinstance(sub.topic_scores, list):
            for entry in sub.topic_scores:
                topic = entry.get("topic") or entry.get("criterion", "Unknown")
                score = float(entry.get("score", entry.get("points_awarded", 0)))
                max_val = float(entry.get("max_points", entry.get("max_score", 10)))
                topic_pct = (score / max_val * 100) if max_val > 0 else 0.0
                topic_scores.setdefault(topic, []).append(topic_pct)

    mastery_snapshot = {
        topic: round(sum(scores) / len(scores), 2)
        for topic, scores in topic_scores.items()
    }

    # Compute class rank among enrolled students
    enrolled_students = (
        db.query(User)
        .join(Enrollment, Enrollment.student_id == User.id)
        .filter(Enrollment.course_id == course.id)
        .all()
    )

    def _student_avg(sid: uuid.UUID) -> float:
        subs = (
            db.query(Submission)
            .filter(
                Submission.assignment_id.in_(assignment_ids),
                Submission.student_id == sid,
                Submission.status == "graded",
            )
            .all()
        ) if assignment_ids else []
        if not subs:
            return 0.0
        scores = []
        for s in subs:
            a = next((x for x in assignments if x.id == s.assignment_id), None)
            mx = float(a.max_marks) if a and a.max_marks else 100.0
            eff = float(s.final_score if s.final_score is not None else (s.ai_score or 0.0))
            scores.append((eff / mx) * 100 if mx > 0 else 0.0)
        return sum(scores) / len(scores)

    ranked = sorted(enrolled_students, key=lambda u: -_student_avg(u.id))
    rank = next((i + 1 for i, u in enumerate(ranked) if u.id == student.id), None)

    student_avg = _student_avg(student.id)
    trend = "improving" if len(trajectory) >= 2 and trajectory[-1]["score_pct"] > trajectory[0]["score_pct"] else "stable"

    narrative = (
        f"{student.full_name}'s performance in {course.name}: "
        f"{'No graded assignments yet.' if not trajectory else f'Average score: {round(student_avg, 1)}%. Trend: {trend}. '}"
        f"{'Strong areas: ' + ', '.join([t for t, v in mastery_snapshot.items() if v >= 70]) if mastery_snapshot else ''}"
        f"{'  Areas to improve: ' + ', '.join([t for t, v in mastery_snapshot.items() if v < 60]) if mastery_snapshot else ''}"
    )

    snapshot_with_trajectory = {
        "topic_mastery": mastery_snapshot,
        "trajectory": trajectory,
    }

    # Upsert progress report
    existing = (
        db.query(ProgressReport)
        .filter(
            ProgressReport.student_id == student.id,
            ProgressReport.course_id == course.id,
        )
        .order_by(ProgressReport.created_at.desc())
        .first()
    )
    if existing:
        existing.narrative = narrative
        existing.mastery_snapshot = snapshot_with_trajectory
        existing.rank = rank
        db.commit()
        db.refresh(existing)
        return _progress_report_payload(existing)
    else:
        report = ProgressReport(
            student_id=student.id,
            course_id=course.id,
            narrative=narrative,
            mastery_snapshot=snapshot_with_trajectory,
            rank=rank,
        )
        db.add(report)
        db.commit()
        db.refresh(report)
        return _progress_report_payload(report)


def _progress_report_payload(report: ProgressReport) -> dict:
    return {
        "id": str(report.id),
        "student_id": str(report.student_id),
        "course_id": str(report.course_id),
        "narrative": report.narrative,
        "mastery_snapshot": report.mastery_snapshot,
        "rank": report.rank,
        "created_at": report.created_at,
    }
