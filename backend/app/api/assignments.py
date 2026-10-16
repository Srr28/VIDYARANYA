from datetime import datetime, timezone
from pathlib import Path
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.announcement import Announcement
from app.models.assignment import Assignment
from app.models.assignment_attachment import AssignmentAttachment
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.submission import Submission
from app.models.user import User
from app.schemas.assignment import AssignmentCreate, AssignmentDueDateUpdate, AssignmentOut
from app.services.storage_service import get_assignment_attachment_key, storage_service

router = APIRouter(prefix="/assignments", tags=["assignments"])


class AssignmentAttachmentPresignRequest(BaseModel):
    filename: str
    content_type: str = "application/octet-stream"


class AssignmentAttachmentRegisterRequest(BaseModel):
    file_key: str
    file_name: str
    title: str = ""
    mime_type: str = "application/octet-stream"

def _is_course_member(db: Session, course_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    enrollment = (
        db.query(Enrollment)
        .filter(Enrollment.course_id == course_id, Enrollment.student_id == user_id)
        .first()
    )
    return enrollment is not None


def _can_access_course(course: Course, db: Session, current_user: User) -> bool:
    if course.faculty_id == current_user.id:
        return True
    return _is_course_member(db, course.id, current_user.id)


def _attachment_payload(item: AssignmentAttachment) -> dict:
    return {
        "id": item.id,
        "assignment_id": item.assignment_id,
        "title": item.title,
        "file_name": item.file_name,
        "download_url": f"/assignments/attachments/{item.id}/download",
    }


def _delete_stored_file(file_key: str) -> None:
    """Delete an R2 object, while retaining support for legacy local files."""
    local_path = Path(file_key)
    if local_path.is_file():
        local_path.unlink(missing_ok=True)
        return
    storage_service.delete_file(file_key)


@router.post("", response_model=AssignmentOut)
def create_assignment(
    payload: AssignmentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Assignment:
    course = (
        db.query(Course)
        .filter(Course.id == payload.course_id, Course.faculty_id == current_user.id)
        .first()
    )
    if not course:
        raise HTTPException(status_code=403, detail="Only the classroom owner can create assignments")

    assignment = Assignment(
        course_id=payload.course_id,
        title=payload.title,
        description=payload.description,
        topics_list=payload.topics_list or [],
        rubric=payload.rubric or [],
        reference_note_id=payload.reference_note_id,
        ai_eval_enabled=payload.ai_eval_enabled,
        due_date=payload.due_date,
        max_marks=payload.max_marks if payload.max_marks is not None else (payload.max_score or 100),
    )
    db.add(assignment)
    due_label = payload.due_date.strftime("%b %d, %Y %I:%M %p") if payload.due_date else "No due date"
    db.add(
        Announcement(
            course_id=payload.course_id,
            author_id=current_user.id,
            content=f"New assignment posted: {payload.title} (Due: {due_label})",
        )
    )
    db.commit()
    db.refresh(assignment)
    return assignment


@router.get("", response_model=list[AssignmentOut])
def list_assignments(
    course_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[Assignment]:
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    if not _can_access_course(course, db, current_user):
        raise HTTPException(status_code=403, detail="No access to this course")

    return (
        db.query(Assignment)
        .filter(Assignment.course_id == course_id)
        .order_by(Assignment.created_at.desc())
        .all()
    )


@router.patch("/{assignment_id}", response_model=AssignmentOut)
def update_assignment_due_date(
    assignment_id: uuid.UUID,
    payload: AssignmentDueDateUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Assignment:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    course = db.query(Course).filter(Course.id == assignment.course_id).first()
    if not course or course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can update due date")

    assignment.due_date = payload.due_date
    db.commit()
    db.refresh(assignment)
    return assignment


@router.post("/{assignment_id}/end", response_model=AssignmentOut)
def end_assignment(
    assignment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Assignment:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    course = db.query(Course).filter(Course.id == assignment.course_id).first()
    if not course or course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can end assignments")

    assignment.due_date = datetime.now(timezone.utc)
    db.commit()
    db.refresh(assignment)
    return assignment


@router.delete("/{assignment_id}")
def delete_assignment(
    assignment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    course = db.query(Course).filter(Course.id == assignment.course_id).first()
    if not course or course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can delete assignments")

    attachments = db.query(AssignmentAttachment).filter(AssignmentAttachment.assignment_id == assignment_id).all()
    submissions = db.query(Submission).filter(Submission.assignment_id == assignment_id).all()

    for item in attachments:
        _delete_stored_file(item.file_path)

    for item in submissions:
        _delete_stored_file(item.file_key)

    db.delete(assignment)
    db.commit()

    return {"message": "Assignment deleted", "assignment_id": str(assignment_id)}


@router.post("/{assignment_id}/attachments")
def upload_assignment_attachment(
    assignment_id: uuid.UUID,
    file: UploadFile = File(...),
    title: str = Form(""),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    course = db.query(Course).filter(Course.id == assignment.course_id).first()
    if not course or course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can upload attachments")

    original_name = Path(file.filename or "attachment").name
    file_key = get_assignment_attachment_key(str(course.id), str(assignment_id), original_name)
    try:
        storage_service.upload_bytes(
            file_key,
            file.file.read(),
            content_type=file.content_type or "application/octet-stream",
        )
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc

    item = AssignmentAttachment(
        assignment_id=assignment_id,
        title=(title.strip() or original_name)[:255],
        file_name=original_name[:255],
        file_path=file_key,
        mime_type=file.content_type,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return _attachment_payload(item)


@router.post("/{assignment_id}/attachments/presign")
def presign_assignment_attachment(
    assignment_id: uuid.UUID,
    payload: AssignmentAttachmentPresignRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    course = db.query(Course).filter(Course.id == assignment.course_id).first()
    if not course or course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can upload attachments")

    file_key = get_assignment_attachment_key(str(course.id), str(assignment_id), payload.filename)
    return storage_service.generate_presigned_put_url(
        key=file_key,
        content_type=payload.content_type,
    )


@router.post("/{assignment_id}/attachments/register")
def register_assignment_attachment(
    assignment_id: uuid.UUID,
    payload: AssignmentAttachmentRegisterRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    course = db.query(Course).filter(Course.id == assignment.course_id).first()
    if not course or course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can upload attachments")

    expected_prefix = f"courses/{course.id}/assignments/{assignment_id}/"
    if not payload.file_key.startswith(expected_prefix):
        raise HTTPException(status_code=400, detail="Invalid assignment attachment key")
    try:
        exists = storage_service.object_exists(payload.file_key)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    if not exists:
        raise HTTPException(status_code=400, detail="Uploaded attachment object was not found")

    file_name = Path(payload.file_name or "attachment").name[:255]
    item = AssignmentAttachment(
        assignment_id=assignment_id,
        title=(payload.title.strip() or file_name)[:255],
        file_name=file_name,
        file_path=payload.file_key,
        mime_type=payload.mime_type,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return _attachment_payload(item)


@router.get("/{assignment_id}/attachments")
def list_assignment_attachments(
    assignment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    course = db.query(Course).filter(Course.id == assignment.course_id).first()
    if not course or not _can_access_course(course, db, current_user):
        raise HTTPException(status_code=403, detail="No access to this assignment")

    rows = (
        db.query(AssignmentAttachment)
        .filter(AssignmentAttachment.assignment_id == assignment_id)
        .order_by(AssignmentAttachment.created_at.desc())
        .all()
    )
    return [_attachment_payload(item) for item in rows]


@router.get("/attachments/{attachment_id}/download")
def download_assignment_attachment(
    attachment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    item = db.query(AssignmentAttachment).filter(AssignmentAttachment.id == attachment_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Attachment not found")

    assignment = db.query(Assignment).filter(Assignment.id == item.assignment_id).first()
    course = db.query(Course).filter(Course.id == assignment.course_id).first() if assignment else None
    if not course or not _can_access_course(course, db, current_user):
        raise HTTPException(status_code=403, detail="No access to this attachment")

    file_path = Path(item.file_path)
    if storage_service.is_r2_active and not file_path.is_file():
        try:
            content = storage_service.download_file_bytes(item.file_path)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="File not found") from exc
        return Response(
            content=content,
            media_type=item.mime_type or "application/octet-stream",
        )

    if not file_path.is_file():
        legacy_path = Path("uploads") / item.file_path
        if legacy_path.is_file():
            file_path = legacy_path
        else:
            raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(path=file_path, filename=item.file_name, media_type=item.mime_type or "application/octet-stream")
