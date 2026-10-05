from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app import models  # noqa: F401
from app.api import analytics, announcements, assignments, auth, chat, courses, notes, submissions, users
from app.core.config import settings
from app.core.database import Base, engine

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


app.include_router(auth.router)
app.include_router(courses.router)
app.include_router(announcements.router)
app.include_router(notes.router)
app.include_router(assignments.router)
app.include_router(submissions.router)
app.include_router(chat.router)
app.include_router(users.router)
app.include_router(analytics.router)


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok"}
