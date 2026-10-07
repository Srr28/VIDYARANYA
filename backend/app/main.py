import uuid

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from app import models  # noqa: F401
from app.api import analytics, announcements, assignments, auth, chat, courses, notes, submissions, users
from app.api.deps import get_current_user, get_db
from app.core.config import settings
from app.core.database import Base, engine
from app.models.assignment import Assignment
from app.models.course import Course
from app.models.submission import Submission
from app.models.user import User
from app.services.queue_service import queue_service
import app.worker  # noqa: F401

app = FastAPI(title="Vidyaranya Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_origin_regex=settings.BACKEND_CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    return response


@app.on_event("startup")
def on_startup() -> None:
    Base.metadata.create_all(bind=engine)


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await queue_service.close()


ai_router = APIRouter(prefix="/ai", tags=["ai"])


@ai_router.get("/status/{submission_id}")
def get_ai_status_root(
    submission_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Query async AI evaluation status for a submission."""
    return submissions.get_ai_evaluation_status(submission_id, db, current_user)


app.include_router(auth.router)
app.include_router(courses.router)
app.include_router(announcements.router)
app.include_router(notes.router)
app.include_router(assignments.router)
app.include_router(submissions.router)
app.include_router(ai_router)
app.include_router(chat.router)
app.include_router(users.router)
app.include_router(analytics.router)


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok"}

