from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.announcement import Announcement
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.note import Note
from app.models.user import User
from app.services.ocr_service import extract_text
from app.services.rag_service import delete_note_chunks, index_note

router = APIRouter(prefix="/notes", tags=["notes"])

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _has_course_access(db: Session, course: Course, current_user: User) -> bool:
    if course.teacher_id == current_user.id:
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
        "file_path": note.file_path,
        "file_name": _pretty_file_name(note.file_path),
        "download_url": f"/notes/download/{note.id}",
        "is_indexed": note.is_indexed,
    }


@router.post("/upload")
def upload_note(
    file: UploadFile = File(...),
    course_id: int = Form(...),
    title: str = Form(...),
    description: str = Form(default=""),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    course = db.query(Course).filter(Course.id == course_id, Course.teacher_id == current_user.id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found for this teacher")

    original_name = Path(file.filename or "note").name
    safe_name = f"{uuid4()}_{original_name}"
    file_path = UPLOAD_DIR / safe_name
    content = file.file.read()
    file_path.write_bytes(content)

    mime_type = file.content_type or ""
    extracted_text = extract_text(str(file_path), mime_type)

    note = Note(
        course_id=course_id,
        title=title,
        file_path=str(file_path),
        is_indexed=bool(extracted_text.strip()),
    )
    db.add(note)
    db.flush()

    index_note(course_id=course_id, text=extracted_text, note_id=note.id)

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

    return _note_payload(note)


@router.get("/download/{note_id}")
def download_note(
    note_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FileResponse:
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    course = db.query(Course).filter(Course.id == note.course_id).first()
    if not course or not _has_course_access(db, course, current_user):
        raise HTTPException(status_code=403, detail="No access to this note")

    file_path = Path(note.file_path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(path=file_path, filename=_pretty_file_name(note.file_path), media_type="application/octet-stream")


@router.get("/{course_id}")
def list_notes(
    course_id: int,
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
    note_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note:
        raise HTTPException(status_code=404, detail="Material not found")

    course = db.query(Course).filter(Course.id == note.course_id).first()
    if not course or course.teacher_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the class teacher can remove materials")

    file_path = Path(note.file_path)

    delete_note_chunks(course_id=note.course_id, note_id=note.id)
    db.delete(note)
    db.commit()

    if file_path.exists():
        try:
            file_path.unlink()
        except OSError:
            # File cleanup failures should not block DB-level deletion.
            pass

    return {"ok": True}
