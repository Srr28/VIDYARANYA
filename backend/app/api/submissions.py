import asyncio
import logging
from pathlib import Path
from datetime import datetime, timezone
import uuid
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_teacher, get_current_user, get_db
from app.models.assignment import Assignment
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.submission import Submission
from app.models.submission_comment import SubmissionComment
from app.models.submission_text import SubmissionText
from app.models.user import User
from app.schemas.assignment import SubmissionOverride
from app.services.grading_service import grade
from app.services.queue_service import queue_service
from app.services.storage_service import get_submission_key, storage_service
import app.worker  # noqa: F401

router = APIRouter(prefix="/submissions", tags=["submissions"])
logger = logging.getLogger("vidyaranya.submissions")


async def _enqueue_submission_evaluation(submission_id: uuid.UUID) -> None:
    try:
        await queue_service.enqueue_submission_evaluation(submission_id)
    except Exception:
        logger.exception("Could not enqueue submission evaluation for %s", submission_id)


async def _delete_previous_submission_file(file_key: str) -> None:
    try:
        await asyncio.to_thread(storage_service.delete_file, file_key)
    except Exception:
        logger.exception("Could not delete replaced submission file %s", file_key)


class SubmissionPresignRequest(BaseModel):
    filename: str
    content_type: str = "application/pdf"


def _get_assignment_or_404(db: Session, assignment_id: uuid.UUID) -> Assignment:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    return assignment


def _get_course_or_404(db: Session, course_id: uuid.UUID) -> Course:
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    return course


def _is_enrolled(db: Session, course_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    enrolled = (
        db.query(Enrollment)
        .filter(Enrollment.course_id == course_id, Enrollment.student_id == user_id)
        .first()
    )
    return enrolled is not None


def _can_access_submission(current_user: User, course: Course, submission: Submission) -> bool:
    if course.faculty_id == current_user.id:
        return True
    return submission.student_id == current_user.id


def _submitted_file_name(submission: Submission) -> str:
    raw_name = Path(submission.file_key).name
    return raw_name.split("_", 1)[1] if "_" in raw_name else raw_name


def _effective_score(submission: Submission | None) -> float | None:
    if submission is None:
        return None
    return float(submission.final_score if submission.final_score is not None else (submission.ai_score or 0.0))


def _assignment_results_released(assignment: Assignment) -> bool:
    """Results unlock only after a configured deadline has passed."""
    due_date = assignment.due_date
    if due_date is None:
        return False
    if due_date.tzinfo is None:
        due_date = due_date.replace(tzinfo=timezone.utc)
    return due_date <= datetime.now(timezone.utc)


def _submission_deadline_passed(assignment: Assignment) -> bool:
    """Assignments without a due date remain open; a configured deadline is inclusive."""
    due_date = assignment.due_date
    if due_date is None:
        return False
    if due_date.tzinfo is None:
        due_date = due_date.replace(tzinfo=timezone.utc)
    return due_date <= datetime.now(timezone.utc)


def _results_released_to_user(assignment: Assignment, course: Course, user: User) -> bool:
    return course.faculty_id == user.id or _assignment_results_released(assignment)


def _student_visible_status(submission: Submission | None, results_released: bool) -> str:
    if submission is None:
        return "missing"
    if not results_released and submission.status in {"graded", "flagged"}:
        return "awaiting_release"
    return submission.status


def _can_access_course(current_user: User, course: Course, db: Session) -> bool:
    if course.faculty_id == current_user.id:
        return True
    return _is_enrolled(db, course.id, current_user.id)


def _compute_mastery_level(score: float, max_score: float) -> str:
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


class PrivateCommentCreate(BaseModel):
    content: str


@router.post("/assignments/{assignment_id}/presign")
def presign_submission_upload(
    assignment_id: uuid.UUID,
    payload: SubmissionPresignRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = _get_assignment_or_404(db, assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if course.faculty_id == current_user.id:
        raise HTTPException(status_code=403, detail="Classroom owner cannot submit this assignment")

    if not _is_enrolled(db, assignment.course_id, current_user.id):
        raise HTTPException(status_code=403, detail="You are not enrolled in this course")
    if _submission_deadline_passed(assignment):
        raise HTTPException(status_code=403, detail="The submission deadline has passed")

    key = get_submission_key(str(assignment_id), str(current_user.id), payload.filename)
    return storage_service.generate_presigned_put_url(
        key=key,
        content_type=payload.content_type,
    )


@router.post("")
async def submit_assignment(
    assignment_id: uuid.UUID = Form(...),
    file: UploadFile | None = File(default=None),
    file_key: str | None = Form(default=None),
    private_comment: str = Form(default=""),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return await _handle_submission(
        assignment_id=assignment_id,
        file=file,
        file_key=file_key,
        private_comment=private_comment,
        db=db,
        current_user=current_user,
    )


@router.post("/assignments/{assignment_id}/submit")
async def submit_assignment_by_path(
    assignment_id: uuid.UUID,
    file: UploadFile | None = File(default=None),
    file_key: str | None = Form(default=None),
    private_comment: str = Form(default=""),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return await _handle_submission(
        assignment_id=assignment_id,
        file=file,
        file_key=file_key,
        private_comment=private_comment,
        db=db,
        current_user=current_user,
    )


async def _handle_submission(
    assignment_id: uuid.UUID,
    file: UploadFile | None,
    file_key: str | None,
    private_comment: str,
    db: Session,
    current_user: User,
) -> dict:
    assignment = _get_assignment_or_404(db, assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if course.faculty_id == current_user.id:
        raise HTTPException(status_code=403, detail="Classroom owner cannot submit this assignment")

    if not _is_enrolled(db, assignment.course_id, current_user.id):
        raise HTTPException(status_code=403, detail="You are not enrolled in this course")
    if _submission_deadline_passed(assignment):
        raise HTTPException(status_code=403, detail="The submission deadline has passed")

    if not file and not file_key:
        raise HTTPException(status_code=400, detail="Either file or file_key must be provided")

    if file_key:
        expected_prefix = f"submissions/{assignment_id}/{current_user.id}/"
        if not file_key.startswith(expected_prefix):
            raise HTTPException(status_code=400, detail="Invalid submission file key")
        # The presigned PUT has already uploaded the object. Avoid a second
        # network round-trip here so submission registration stays non-blocking.
        saved_key = file_key
        extracted_text = ""
    else:
        original_name = Path(file.filename or "submission").name
        saved_key = get_submission_key(str(assignment_id), str(current_user.id), original_name)
        content = file.file.read()
        try:
            storage_service.upload_bytes(saved_key, content, content_type=file.content_type or "application/octet-stream")
        except ValueError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        extracted_text = ""

    submission = (
        db.query(Submission)
        .filter(
            Submission.assignment_id == assignment.id,
            Submission.student_id == current_user.id,
        )
        .first()
    )
    previous_path = None
    if submission is None:
        submission = Submission(
            assignment_id=assignment.id,
            student_id=current_user.id,
            file_key=saved_key,
            text_content=extracted_text,
            status="pending_eval",
            ai_score=None,
            mastery_level=None,
            depth_score=None,
            depth_label=None,
            topic_scores=None,
            feedback_text=None,
            integrity_score=None,
            plagiarism_flag=False,
            final_score=None,
            faculty_note=None,
        )
        db.add(submission)
    else:
        previous_path = submission.file_key
        submission.file_key = saved_key
        submission.text_content = extracted_text
        submission.status = "pending_eval"
        submission.ai_score = None
        submission.mastery_level = None
        submission.depth_score = None
        submission.depth_label = None
        submission.topic_scores = None
        submission.feedback_text = None
        submission.final_score = None
        submission.faculty_note = None

    db.flush()

    # Create or update submission_texts record
    sub_text = db.query(SubmissionText).filter(SubmissionText.submission_id == submission.id).first()
    if sub_text is None:
        sub_text = SubmissionText(submission_id=submission.id, raw_text=extracted_text)
        db.add(sub_text)
    else:
        sub_text.raw_text = extracted_text

    if previous_path and previous_path != saved_key:
        asyncio.create_task(_delete_previous_submission_file(previous_path))

    trimmed_comment = private_comment.strip()
    if trimmed_comment:
        db.add(
            SubmissionComment(
                submission_id=submission.id,
                author_id=current_user.id,
                content=trimmed_comment,
            )
        )

    db.commit()
    db.refresh(submission)

    # Decoupled Asynchronous Evaluation Queue (Phase 3)
    # Do not wait for Redis connection setup in the HTTP request. The API can
    # return pending_eval immediately while this task hands work to ARQ.
    asyncio.create_task(_enqueue_submission_evaluation(submission.id))

    return {
        "id": submission.id,
        "submission_id": str(submission.id),
        "status": submission.status,
        "ai_score": submission.ai_score,
        "ai_feedback": submission.ai_feedback,
        "mastery_level": submission.mastery_level,
        "topic_scores": submission.topic_scores,
        "feedback_text": submission.feedback_text,
    }


@router.get("/{submission_id:uuid}")
def get_submission(
    submission_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    submission = db.query(Submission).filter(Submission.id == submission_id).first()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    assignment = _get_assignment_or_404(db, submission.assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if not _can_access_submission(current_user, course, submission):
        raise HTTPException(status_code=403, detail="No access")

    results_released = _results_released_to_user(assignment, course, current_user)
    result = {
        "id": submission.id,
        "assignment_id": submission.assignment_id,
        "student_id": submission.student_id,
        "status": _student_visible_status(submission, results_released),
        "results_released": results_released,
        "file_name": _submitted_file_name(submission),
        "ai_score": submission.ai_score if results_released else None,
        "ai_feedback": submission.ai_feedback if results_released else None,
        "mastery_level": submission.mastery_level if results_released else None,
        "depth_score": submission.depth_score if results_released else None,
        "depth_label": submission.depth_label if results_released else None,
        "topic_scores": submission.topic_scores if results_released else None,
        "feedback_text": submission.feedback_text if results_released else None,
        "integrity_score": submission.integrity_score if results_released else None,
        "plagiarism_flag": submission.plagiarism_flag if results_released else False,
        "final_score": submission.final_score if results_released else None,
        "effective_score": _effective_score(submission) if results_released else None,
        "teacher_comment": submission.faculty_note if results_released else None,
        "faculty_note": submission.faculty_note if results_released else None,
    }
    return result


@router.get("/by-assignment/{assignment_id}/mine")
def get_my_submission_for_assignment(
    assignment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = _get_assignment_or_404(db, assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if not _can_access_course(current_user, course, db):
        raise HTTPException(status_code=403, detail="No access")

    if course.faculty_id == current_user.id:
        return {"assignment_id": assignment.id, "submission": None}

    submission = (
        db.query(Submission)
        .filter(
            Submission.assignment_id == assignment.id,
            Submission.student_id == current_user.id,
        )
        .first()
    )
    if submission is None:
        return {"assignment_id": assignment.id, "submission": None}

    results_released = _results_released_to_user(assignment, course, current_user)
    return {
        "assignment_id": assignment.id,
        "results_released": results_released,
        "submission": {
            "id": submission.id,
            "assignment_id": submission.assignment_id,
            "student_id": submission.student_id,
            "status": _student_visible_status(submission, results_released),
            "file_name": _submitted_file_name(submission),
            "results_released": results_released,
            "ai_score": submission.ai_score if results_released else None,
            "final_score": submission.final_score if results_released else None,
            "effective_score": _effective_score(submission) if results_released else None,
            "mastery_level": submission.mastery_level if results_released else None,
            "depth_score": submission.depth_score if results_released else None,
            "depth_label": submission.depth_label if results_released else None,
            "topic_scores": submission.topic_scores if results_released else None,
            "feedback_text": submission.feedback_text if results_released else None,
            "teacher_comment": submission.faculty_note if results_released else None,
            "created_at": submission.created_at,
        },
    }


@router.delete("/by-assignment/{assignment_id}/mine")
def unsubmit_my_assignment(
    assignment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = _get_assignment_or_404(db, assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if course.faculty_id == current_user.id:
        raise HTTPException(status_code=403, detail="Classroom owner cannot unsubmit")

    if not _is_enrolled(db, course.id, current_user.id):
        raise HTTPException(status_code=403, detail="No access")
    if _submission_deadline_passed(assignment):
        raise HTTPException(status_code=403, detail="The submission deadline has passed; submissions can no longer be changed")

    submission = (
        db.query(Submission)
        .filter(
            Submission.assignment_id == assignment.id,
            Submission.student_id == current_user.id,
        )
        .first()
    )
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    db.query(SubmissionComment).filter(SubmissionComment.submission_id == submission.id).delete()
    storage_service.delete_file(submission.file_key)
    db.delete(submission)
    db.commit()

    return {"assignment_id": str(assignment_id), "message": "Submission removed"}


@router.get("/{submission_id:uuid}/download")
def download_submission_file(
    submission_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    submission = db.query(Submission).filter(Submission.id == submission_id).first()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    assignment = _get_assignment_or_404(db, submission.assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if not _can_access_submission(current_user, course, submission):
        raise HTTPException(status_code=403, detail="No access")

    file_path = Path(submission.file_key)
    if not file_path.is_file():
        legacy_path = Path("uploads") / submission.file_key
        if legacy_path.is_file():
            file_path = legacy_path

    if storage_service.is_r2_active and not file_path.is_file():
        try:
            content = storage_service.download_file_bytes(submission.file_key)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="File not found") from exc
        return Response(
            content=content,
            media_type="application/octet-stream",
        )

    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(
        path=file_path,
        filename=_submitted_file_name(submission),
        media_type="application/octet-stream",
    )


@router.get("/by-assignment/{assignment_id}")
def list_submissions_for_assignment(
    assignment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = _get_assignment_or_404(db, assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can view all submissions")

    submissions = (
        db.query(Submission)
        .filter(Submission.assignment_id == assignment.id)
        .order_by(Submission.created_at.desc())
        .all()
    )
    return {
        "assignment_id": assignment.id,
        "submissions": [
            {
                "id": item.id,
                "assignment_id": item.assignment_id,
                "student_id": item.student_id,
                "status": item.status,
                "file_name": _submitted_file_name(item),
                "ai_score": item.ai_score,
                "final_score": item.final_score,
                "effective_score": _effective_score(item),
                "mastery_level": item.mastery_level,
                "depth_score": item.depth_score,
                "depth_label": item.depth_label,
                "topic_scores": item.topic_scores,
                "feedback_text": item.feedback_text,
                "integrity_score": item.integrity_score,
                "plagiarism_flag": item.plagiarism_flag,
                "teacher_comment": item.faculty_note,
                "created_at": item.created_at,
            }
            for item in submissions
        ],
    }


@router.get("/{submission_id:uuid}/comments")
def list_private_comments(
    submission_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    submission = db.query(Submission).filter(Submission.id == submission_id).first()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    assignment = _get_assignment_or_404(db, submission.assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if not _can_access_submission(current_user, course, submission):
        raise HTTPException(status_code=403, detail="No access")

    rows = (
        db.query(SubmissionComment)
        .filter(SubmissionComment.submission_id == submission_id)
        .order_by(SubmissionComment.created_at.asc())
        .all()
    )

    author_ids = {item.author_id for item in rows}
    authors = {
        user.id: user
        for user in db.query(User)
        .filter(User.id.in_(author_ids))
        .all()
    } if author_ids else {}

    return {
        "submission_id": submission_id,
        "comments": [
            {
                "id": item.id,
                "author_id": item.author_id,
                "author_name": (authors[item.author_id].name if item.author_id in authors else "User"),
                "author_role": (
                    "teacher"
                    if item.author_id == course.faculty_id
                    else "student"
                ),
                "content": item.content,
                "created_at": item.created_at,
            }
            for item in rows
        ],
    }


@router.post("/{submission_id:uuid}/comments")
def add_private_comment(
    submission_id: uuid.UUID,
    payload: PrivateCommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    submission = db.query(Submission).filter(Submission.id == submission_id).first()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    assignment = _get_assignment_or_404(db, submission.assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if not _can_access_submission(current_user, course, submission):
        raise HTTPException(status_code=403, detail="No access")

    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Comment cannot be empty")

    row = SubmissionComment(
        submission_id=submission_id,
        author_id=current_user.id,
        content=content,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    return {
        "id": row.id,
        "submission_id": row.submission_id,
        "author_id": row.author_id,
        "author_name": current_user.name,
        "author_role": "teacher" if current_user.id == course.faculty_id else "student",
        "content": row.content,
        "created_at": row.created_at,
    }


@router.get("/my-grades")
def my_grades_by_course(
    course_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    course = _get_course_or_404(db, course_id)
    if not _can_access_course(current_user, course, db):
        raise HTTPException(status_code=403, detail="No access")

    assignments = db.query(Assignment).filter(Assignment.course_id == course_id).all()
    assignment_ids = [item.id for item in assignments]

    submissions = (
        db.query(Submission)
        .filter(
            Submission.assignment_id.in_(assignment_ids),
            Submission.student_id == current_user.id,
        )
        .all()
    ) if assignment_ids else []
    submission_map = {item.assignment_id: item for item in submissions}

    def due_key(item: Assignment) -> tuple[int, object]:
        return (0, item.due_date) if item.due_date else (1, item.created_at)

    ordered = sorted(assignments, key=due_key)
    items = []
    total_effective = 0.0
    graded_count = 0
    published_count = 0

    for assignment in ordered:
        submission = submission_map.get(assignment.id)
        results_released = _results_released_to_user(assignment, course, current_user)
        if results_released:
            published_count += 1
        is_graded = bool(results_released and submission and submission.status == "graded")
        effective = (
            _effective_score(submission) if is_graded
            else 0.0 if results_released and submission is None
            else None
        )
        if is_graded:
            total_effective += effective or 0.0
            graded_count += 1
        items.append(
            {
                "assignment_id": assignment.id,
                "title": assignment.title,
                "due_date": assignment.due_date,
                "results_released": results_released,
                "max_score": assignment.max_marks,
                "submission_id": submission.id if submission else None,
                "status": _student_visible_status(submission, results_released),
                "ai_score": submission.ai_score if submission and results_released else None,
                "final_score": submission.final_score if submission and results_released else None,
                "effective_score": effective,
                "mastery_level": submission.mastery_level if submission and results_released else None,
                "depth_score": submission.depth_score if submission and results_released else None,
                "depth_label": submission.depth_label if submission and results_released else None,
                "topic_scores": submission.topic_scores if submission and results_released else None,
                "feedback_text": submission.feedback_text if submission and results_released else None,
                "integrity_score": submission.integrity_score if submission and results_released else None,
                "plagiarism_flag": submission.plagiarism_flag if submission and results_released else False,
                "teacher_comment": submission.faculty_note if submission and results_released else None,
            }
        )

    return {
        "course_id": course_id,
        "is_owner": course.faculty_id == current_user.id,
        "summary": {
            "assignments_total": published_count,
            "graded_count": graded_count,
            "average_score": (round(total_effective / published_count, 2) if published_count else None),
        },
        "items": items,
    }


@router.get("/leaderboard/{course_id}")
def leaderboard_by_course(
    course_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    course = _get_course_or_404(db, course_id)
    if not _can_access_course(current_user, course, db):
        raise HTTPException(status_code=403, detail="No access")

    students = (
        db.query(User)
        .join(Enrollment, Enrollment.student_id == User.id)
        .filter(Enrollment.course_id == course_id)
        .all()
    )
    assignments = db.query(Assignment).filter(Assignment.course_id == course_id).all()
    published_assignments = [item for item in assignments if _assignment_results_released(item)]
    assignment_ids = [item.id for item in published_assignments]

    submissions = (
        db.query(Submission)
        .filter(Submission.assignment_id.in_(assignment_ids))
        .all()
    ) if assignment_ids else []

    by_student: dict[uuid.UUID, list[Submission]] = {}
    for item in submissions:
        by_student.setdefault(item.student_id, []).append(item)

    rows = []
    for student in students:
        student_submissions = by_student.get(student.id, [])
        submission_map = {item.assignment_id: item for item in student_submissions}
        scores = []
        graded_count = 0
        for assignment in published_assignments:
            item = submission_map.get(assignment.id)
            if item and item.status == "graded":
                scores.append(_effective_score(item) or 0.0)
                graded_count += 1
            else:
                # Missing, still-processing, and flagged submissions contribute zero
                # once the assignment deadline closes.
                scores.append(0.0)
        average = round(sum(scores) / len(published_assignments), 2) if published_assignments else 0.0
        rows.append(
            {
                "student_id": student.id,
                "student_name": student.name,
                "submissions_count": sum(1 for item in student_submissions if item.assignment_id in assignment_ids),
                "graded_count": graded_count,
                "average_score": average,
            }
        )

    rows.sort(key=lambda item: (-item["average_score"], -item["graded_count"], item["student_name"]))
    for index, row in enumerate(rows, start=1):
        row["rank"] = index

    return {
        "course_id": course_id,
        "assignments_total": len(published_assignments),
        "pending_assignments_count": len(assignments) - len(published_assignments),
        "rows": rows if published_assignments else [],
    }


@router.patch("/{submission_id}/override")
def override_submission(
    submission_id: uuid.UUID,
    payload: SubmissionOverride,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_teacher),
) -> dict:
    submission = db.query(Submission).filter(Submission.id == submission_id).first()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    assignment = db.query(Assignment).filter(Assignment.id == submission.assignment_id).first()
    course = db.query(Course).filter(Course.id == assignment.course_id).first() if assignment else None
    if not course or course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="No access")

    submission.final_score = payload.final_score
    submission.faculty_note = payload.faculty_note or payload.teacher_comment
    submission.status = "graded"
    db.commit()
    db.refresh(submission)

    return {
        "id": submission.id,
        "status": submission.status,
        "final_score": submission.final_score,
        "depth_score": submission.depth_score,
        "depth_label": submission.depth_label,
        "teacher_comment": submission.faculty_note,
        "faculty_note": submission.faculty_note,
    }


@router.patch("/{submission_id}/grade")
def grade_submission(
    submission_id: uuid.UUID,
    payload: SubmissionOverride,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_teacher),
) -> dict:
    """Alias for /override — matches the Phase 2 API specification path."""
    return override_submission(submission_id, payload, db, current_user)


@router.get("/ai/status/{submission_id:uuid}")
def get_ai_evaluation_status(
    submission_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    Poll the evaluation status of a submission.
    Returns the current status and, if graded, the AI results.
    This endpoint supports Phase 3's async evaluation pipeline.
    """
    submission = db.query(Submission).filter(Submission.id == submission_id).first()
    if not submission:
        raise HTTPException(status_code=404, detail="Submission not found")

    assignment = _get_assignment_or_404(db, submission.assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if not _can_access_submission(current_user, course, submission):
        raise HTTPException(status_code=403, detail="No access")

    results_released = _results_released_to_user(assignment, course, current_user)
    result: dict = {
        "submission_id": str(submission.id),
        "status": _student_visible_status(submission, results_released),
        "results_released": results_released,
    }
    if not results_released:
        return result
    if submission.status == "graded":
        result.update(
            {
                "ai_score": submission.ai_score,
                "final_score": submission.final_score,
                "effective_score": _effective_score(submission),
                "mastery_level": submission.mastery_level,
                "depth_score": submission.depth_score,
                "depth_label": submission.depth_label,
                "topic_scores": submission.topic_scores,
                "feedback_text": submission.feedback_text,
                "integrity_score": submission.integrity_score,
                "plagiarism_flag": submission.plagiarism_flag,
            }
        )
    elif submission.status == "flagged":
        result["plagiarism_flag"] = submission.plagiarism_flag
        result["integrity_score"] = submission.integrity_score
    return result

