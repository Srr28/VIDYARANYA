from pathlib import Path
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.announcement import Announcement
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.note import Note
from app.models.user import User
from app.services.ocr_service import extract_text_from_bytes
from app.services.queue_service import queue_service
from app.services.rag_service import delete_note_chunks
from app.services.storage_service import get_note_key, storage_service
import app.worker  # noqa: F401

router = APIRouter(prefix="/notes", tags=["notes"])


class NotePresignRequest(BaseModel):
    filename: str
    content_type: str = "application/pdf"


def _has_course_access(db: Session, course: Course, current_user: User) -> bool:
    if course.faculty_id == current_user.id:
        return True
    enrollment = (
        db.query(Enrollment)
        .filter(Enrollment.course_id == course.id, Enrollment.student_id == current_user.id)
        .first()
    )
    return enrollment is not None


def _pretty_file_name(file_path: str) -> str:
    name = Path(file_path).name
    parts = name.split("_", 1)
    return parts[1] if len(parts) == 2 else name


def _note_payload(note: Note) -> dict:
    return {
        "id": note.id,
        "course_id": note.course_id,
        "title": note.title,
        "file_key": note.file_key,
        "file_path": note.file_path,
        "file_type": note.file_type,
        "file_name": _pretty_file_name(note.file_key),
        "download_url": f"/notes/download/{note.id}",
        "chroma_indexed": note.chroma_indexed,
        "is_indexed": note.is_indexed,
        "chunk_count": note.chunk_count,
    }


@router.post("/courses/{course_id}/presign")
def presign_note_upload(
    course_id: uuid.UUID,
    payload: NotePresignRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    course = db.query(Course).filter(Course.id == course_id, Course.faculty_id == current_user.id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found for this faculty")

    key = get_note_key(str(course_id), payload.filename)
    return storage_service.generate_presigned_put_url(
        key=key,
        content_type=payload.content_type,
    )


@router.post("/upload")
async def upload_note(
    course_id: uuid.UUID = Form(...),
    title: str = Form(...),
    description: str = Form(default=""),
    file: UploadFile | None = File(default=None),
    file_key: str | None = Form(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    course = db.query(Course).filter(Course.id == course_id, Course.faculty_id == current_user.id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found for this faculty")

    if not file and not file_key:
        raise HTTPException(status_code=400, detail="Either file or file_key must be provided")

    file_extension = ""
    if file_key:
        saved_key = file_key
        file_extension = Path(file_key).suffix.lstrip(".").lower()
        try:
            content = storage_service.download_file_bytes(saved_key)
            extracted_text = extract_text_from_bytes(content, filename=saved_key)
        except Exception:
            extracted_text = ""
    else:
        original_name = Path(file.filename or "note").name
        file_extension = Path(original_name).suffix.lstrip(".").lower()
        saved_key = get_note_key(str(course_id), original_name)
        content = file.file.read()
        storage_service.upload_bytes(saved_key, content, content_type=file.content_type or "application/octet-stream")
        extracted_text = extract_text_from_bytes(content, mime_type=file.content_type or "", filename=original_name)

    note = Note(
        course_id=course_id,
        title=title,
        file_key=saved_key,
        file_type=file_extension[:10] if file_extension else "pdf",
        chroma_indexed=False,
        chunk_count=len(extracted_text.split()) // 100 if extracted_text else 0,
    )
    db.add(note)
    db.flush()

    announcement_content = f"New material uploaded: {title}"
    if description.strip():
        announcement_content = f"{announcement_content}\n{description.strip()}"

    db.add(
        Announcement(
            course_id=course_id,
            author_id=current_user.id,
            content=announcement_content,
        )
    )
    db.commit()
    db.refresh(note)

    # Decoupled note indexing via background queue (Phase 3)
    await queue_service.enqueue_note_indexing(note.id)

    return _note_payload(note)


@router.get("/download/{note_id}")
@router.get("/{note_id}/download")
def download_note(
    note_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    course = db.query(Course).filter(Course.id == note.course_id).first()
    if not course or not _has_course_access(db, course, current_user):
        raise HTTPException(status_code=403, detail="No access to this note")

    if storage_service.is_r2_active:
        url = storage_service.generate_presigned_get_url(note.file_key)
        return RedirectResponse(url=url)

    file_path = Path(note.file_key)
    if not file_path.is_file():
        file_path = Path("uploads") / note.file_key
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(path=file_path, filename=_pretty_file_name(note.file_key), media_type="application/octet-stream")


@router.get("/{course_id}")
def list_notes(
    course_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    if not _has_course_access(db, course, current_user):
        raise HTTPException(status_code=403, detail="No access to this course")

    notes = db.query(Note).filter(Note.course_id == course_id).all()
    return [_note_payload(note) for note in notes]


@router.delete("/{note_id}")
def delete_note(
    note_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Material not found")

    course = db.query(Course).filter(Course.id == note.course_id).first()
    if not course or course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the class faculty can remove materials")

    file_key = note.file_key
    delete_note_chunks(course_id=str(note.course_id), note_id=str(note.id))
    db.delete(note)
    db.commit()

    storage_service.delete_file(file_key)
    return {"ok": True}
