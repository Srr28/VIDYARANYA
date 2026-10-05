from pathlib import Path
import uuid
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
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
from app.services.ocr_service import extract_text_from_bytes
from app.services.storage_service import get_submission_key, storage_service

router = APIRouter(prefix="/submissions", tags=["submissions"])


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

    key = get_submission_key(str(assignment_id), str(current_user.id), payload.filename)
    return storage_service.generate_presigned_put_url(
        key=key,
        content_type=payload.content_type,
    )


@router.post("")
def submit_assignment(
    assignment_id: uuid.UUID = Form(...),
    file: UploadFile | None = File(default=None),
    file_key: str | None = Form(default=None),
    private_comment: str = Form(default=""),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = _get_assignment_or_404(db, assignment_id)
    course = _get_course_or_404(db, assignment.course_id)
    if course.faculty_id == current_user.id:
        raise HTTPException(status_code=403, detail="Classroom owner cannot submit this assignment")

    if not _is_enrolled(db, assignment.course_id, current_user.id):
        raise HTTPException(status_code=403, detail="You are not enrolled in this course")

    if not file and not file_key:
        raise HTTPException(status_code=400, detail="Either file or file_key must be provided")

    if file_key:
        saved_key = file_key
        try:
            content = storage_service.download_file_bytes(saved_key)
            extracted_text = extract_text_from_bytes(content, filename=saved_key)
        except Exception:
            extracted_text = ""
    else:
        original_name = Path(file.filename or "submission").name
        saved_key = get_submission_key(str(assignment_id), str(current_user.id), original_name)
        content = file.file.read()
        storage_service.upload_bytes(saved_key, content, content_type=file.content_type or "application/octet-stream")
        extracted_text = extract_text_from_bytes(content, mime_type=file.content_type or "", filename=original_name)

    grade_result = grade(extracted_text, assignment.rubric)
    ai_score_val = float(grade_result.get("total_score", 0))
    max_score_val = float(assignment.max_marks or grade_result.get("max_score", 100))
    mastery_lvl = _compute_mastery_level(ai_score_val, max_score_val)
    feedback_txt = grade_result.get("general_feedback") or ""
    topic_sc = grade_result.get("breakdown")

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
            status="graded",
            ai_score=ai_score_val,
            mastery_level=mastery_lvl,
            topic_scores=topic_sc,
            feedback_text=feedback_txt,
            integrity_score=1.0,
            plagiarism_flag=False,
            final_score=None,
            faculty_note=None,
        )
        db.add(submission)
    else:
        previous_path = submission.file_key
        submission.file_key = saved_key
        submission.text_content = extracted_text
        submission.status = "graded"
        submission.ai_score = ai_score_val
        submission.mastery_level = mastery_lvl
        submission.topic_scores = topic_sc
        submission.feedback_text = feedback_txt
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
        storage_service.delete_file(previous_path)

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

    return {
        "id": submission.id,
        "status": submission.status,
        "ai_score": submission.ai_score,
        "ai_feedback": submission.ai_feedback,
        "mastery_level": submission.mastery_level,
        "topic_scores": submission.topic_scores,
        "feedback_text": submission.feedback_text,
    }


@router.get("/{submission_id}")
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

    return {
        "id": submission.id,
        "assignment_id": submission.assignment_id,
        "student_id": submission.student_id,
        "status": submission.status,
        "file_name": _submitted_file_name(submission),
        "ai_score": submission.ai_score,
        "ai_feedback": submission.ai_feedback,
        "mastery_level": submission.mastery_level,
        "topic_scores": submission.topic_scores,
        "feedback_text": submission.feedback_text,
        "integrity_score": submission.integrity_score,
        "plagiarism_flag": submission.plagiarism_flag,
        "final_score": submission.final_score,
        "effective_score": _effective_score(submission),
        "teacher_comment": submission.faculty_note,
        "faculty_note": submission.faculty_note,
    }


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

    return {
        "assignment_id": assignment.id,
        "submission": {
            "id": submission.id,
            "assignment_id": submission.assignment_id,
            "student_id": submission.student_id,
            "status": submission.status,
            "file_name": _submitted_file_name(submission),
            "ai_score": submission.ai_score,
            "final_score": submission.final_score,
            "effective_score": _effective_score(submission),
            "mastery_level": submission.mastery_level,
            "topic_scores": submission.topic_scores,
            "feedback_text": submission.feedback_text,
            "teacher_comment": submission.faculty_note,
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


@router.get("/{submission_id}/download")
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

    if storage_service.is_r2_active:
        url = storage_service.generate_presigned_get_url(submission.file_key)
        return RedirectResponse(url=url)

    file_path = Path(submission.file_key)
    if not file_path.is_file():
        file_path = Path("uploads") / submission.file_key
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


@router.get("/{submission_id}/comments")
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


@router.post("/{submission_id}/comments")
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

    for assignment in ordered:
        submission = submission_map.get(assignment.id)
        effective = _effective_score(submission)
        if effective is not None:
            total_effective += effective
            graded_count += 1
        items.append(
            {
                "assignment_id": assignment.id,
                "title": assignment.title,
                "due_date": assignment.due_date,
                "max_score": assignment.max_marks,
                "submission_id": submission.id if submission else None,
                "status": submission.status if submission else "missing",
                "ai_score": submission.ai_score if submission else None,
                "final_score": submission.final_score if submission else None,
                "effective_score": effective,
                "mastery_level": submission.mastery_level if submission else None,
                "teacher_comment": submission.faculty_note if submission else None,
            }
        )

    return {
        "course_id": course_id,
        "is_owner": course.faculty_id == current_user.id,
        "summary": {
            "assignments_total": len(assignments),
            "graded_count": graded_count,
            "average_score": (round(total_effective / graded_count, 2) if graded_count else None),
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
    assignment_ids = [item.id for item in assignments]

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
        scores = [_effective_score(item) for item in student_submissions]
        valid_scores = [score for score in scores if score is not None]
        average = round(sum(valid_scores) / len(valid_scores), 2) if valid_scores else 0.0
        rows.append(
            {
                "student_id": student.id,
                "student_name": student.name,
                "submissions_count": len(student_submissions),
                "graded_count": len(valid_scores),
                "average_score": average,
            }
        )

    rows.sort(key=lambda item: (-item["average_score"], -item["graded_count"], item["student_name"]))
    for index, row in enumerate(rows, start=1):
        row["rank"] = index

    return {
        "course_id": course_id,
        "assignments_total": len(assignments),
        "rows": rows,
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


@router.get("/ai/status/{submission_id}")
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

    result: dict = {
        "submission_id": str(submission.id),
        "status": submission.status,
    }
    if submission.status == "graded":
        result.update(
            {
                "ai_score": submission.ai_score,
                "final_score": submission.final_score,
                "effective_score": _effective_score(submission),
                "mastery_level": submission.mastery_level,
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

