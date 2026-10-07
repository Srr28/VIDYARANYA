import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        primary_key=True,
        default=uuid.uuid4,
        index=True,
    )
    faculty_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str | None] = mapped_column(String(100), nullable=True)
    section: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    join_code: Mapped[str] = mapped_column(String(6), unique=True, index=True, nullable=False)
    banner_color: Mapped[str] = mapped_column(String(7), default="#1a73e8", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Compatibility properties for teacher_id and teacher
    @property
    def teacher_id(self) -> uuid.UUID:
        return self.faculty_id

    @teacher_id.setter
    def teacher_id(self, value: uuid.UUID) -> None:
        self.faculty_id = value

    @property
    def teacher(self):
        return self.faculty

    @teacher.setter
    def teacher(self, value):
        self.faculty = value

    def __init__(self, **kwargs):
        if "teacher_id" in kwargs and "faculty_id" not in kwargs:
            kwargs["faculty_id"] = kwargs.pop("teacher_id")
        super().__init__(**kwargs)

    faculty = relationship("User", back_populates="teaching_courses", foreign_keys=[faculty_id])
    enrollments = relationship("Enrollment", back_populates="course", cascade="all, delete-orphan")
    notes = relationship("Note", back_populates="course", cascade="all, delete-orphan")
    assignments = relationship("Assignment", back_populates="course", cascade="all, delete-orphan")
    analytics_reports = relationship("AnalyticsReport", back_populates="course", cascade="all, delete-orphan")
    progress_reports = relationship("ProgressReport", back_populates="course", cascade="all, delete-orphan")
    chats = relationship("ChatMessage", back_populates="course", cascade="all, delete-orphan")
    announcements = relationship("Announcement", back_populates="course", cascade="all, delete-orphan")
