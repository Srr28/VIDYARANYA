import uuid
import json

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

router = APIRouter(tags=["chat"])


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

    if "text/event-stream" in request.headers.get("accept", ""):
        def event_stream():
            answer_parts: list[str] = []
            sources: list[str] = []
            try:
                for item in rag_stream_chat(
                    course_id=str(payload.course_id),
                    question=payload.message,
                    note_ids=[str(n) for n in selected_note_ids],
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
