import uuid
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.core.rate_limit import limiter
from app.models.chat import ChatMessage
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.note import Note
from app.models.user import User
from app.schemas.chat import ChatRequest, ChatResponse
from app.services.rag_service import chat as rag_chat, stream_chat as rag_stream_chat
from app.services.rag_service import CHROMA_CLIENT, index_note
from app.services.ocr_service import extract_text_from_bytes
from app.services.storage_service import storage_service

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


def _repair_missing_note_indexes(db: Session, course_id: uuid.UUID, note_ids: list[uuid.UUID]) -> dict[str, str]:
    """Rebuild missing vectors and retain extracted text as a retrieval fallback."""
    material_texts: dict[str, str] = {}
    try:
        collection = CHROMA_CLIENT.get_or_create_collection(name=f"course_{course_id}")
    except Exception:
        logger.exception("Could not open Chroma collection for course %s", course_id)
        collection = None

    notes = db.query(Note).filter(Note.course_id == course_id, Note.id.in_(note_ids)).all()
    for note in notes:
        note_id = str(note.id)
        try:
            can_index = collection is not None
            if collection is not None:
                try:
                    existing = collection.get(where={"note_id": note_id}, include=["documents", "metadatas"])
                except Exception:
                    logger.exception("Could not check Chroma chunks for note %s", note_id)
                    existing = {}
                    can_index = False
                if any(str(text or "").strip() for text in existing.get("documents", [])):
                    continue

            content = storage_service.download_file_bytes(note.file_key)
            extracted_text = extract_text_from_bytes(content, filename=note.file_key)
            if not extracted_text.strip():
                logger.warning("Selected note %s has no extractable text", note_id)
                continue

            material_texts[note_id] = extracted_text
            if can_index:
                index_note(course_id=str(course_id), text=extracted_text, note_id=note_id)
                note.chroma_indexed = True
                note.chunk_count = max(1, len(extracted_text.split()) // 100)
                db.commit()
            else:
                logger.warning(
                    "Using extracted text for tutor response; Chroma is unavailable for note %s",
                    note_id,
                )
        except Exception:
            db.rollback()
            logger.exception("Could not repair missing Chroma index for note %s", note_id)
    return material_texts


@router.post("/chat", response_model=ChatResponse)
@limiter.limit("10/minute")
def chat_with_course_notes(
    request: Request,
    payload: ChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict | StreamingResponse:
    course = db.query(Course).filter(Course.id == payload.course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    owns_course = course.faculty_id == current_user.id
    enrollment = (
        db.query(Enrollment)
        .filter(
            Enrollment.course_id == payload.course_id,
            Enrollment.student_id == current_user.id,
        )
        .first()
    )
    if not owns_course and not enrollment:
        raise HTTPException(status_code=403, detail="No access to this course")

    selected_note_ids = list({note_id for note_id in payload.note_ids if note_id})

    if selected_note_ids:
        existing_note_ids = {
            row[0]
            for row in (
                db.query(Note.id)
                .filter(Note.course_id == payload.course_id, Note.id.in_(selected_note_ids))
                .all()
            )
        }
        missing = [note_id for note_id in selected_note_ids if note_id not in existing_note_ids]
        if missing:
            raise HTTPException(status_code=404, detail="One or more selected materials were not found in this course")

        material_texts = _repair_missing_note_indexes(db, payload.course_id, selected_note_ids)
    else:
        material_texts = {}

    if "text/event-stream" in request.headers.get("accept", ""):
        def event_stream():
            answer_parts: list[str] = []
            sources: list[str] = []
            try:
                for item in rag_stream_chat(
                    course_id=str(payload.course_id),
                    question=payload.message,
                    note_ids=[str(n) for n in selected_note_ids],
                    material_texts=material_texts,
                ):
                    if item.get("type") == "token":
                        answer_parts.append(item["content"])
                        yield f"event: token\ndata: {json.dumps({'content': item['content']})}\n\n"
                    elif item.get("type") == "sources":
                        sources = item.get("sources", [])
                answer = "".join(answer_parts)
                db.add(ChatMessage(course_id=payload.course_id, user_id=current_user.id,
                                   user_message=payload.message, ai_response=answer))
                db.commit()
                yield f"event: metadata\ndata: {json.dumps({'sources': sources})}\n\n"
                yield "event: done\ndata: {}\n\n"
            except Exception:
                db.rollback()
                yield f"event: error\ndata: {json.dumps({'detail': 'AI tutor stream failed. Please retry.'})}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
        })

    rag_response = rag_chat(
        course_id=str(payload.course_id),
        question=payload.message,
        note_ids=[str(n) for n in selected_note_ids],
        material_texts=material_texts,
    )

    history = ChatMessage(
        course_id=payload.course_id,
        user_id=current_user.id,
        user_message=payload.message,
        ai_response=rag_response["answer"],
    )
    db.add(history)
    db.commit()

    return rag_response
