import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Assignment(Base):
    __tablename__ = "assignments"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        primary_key=True,
        default=uuid.uuid4,
        index=True,
    )
    course_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("courses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    topics_list: Mapped[list] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"),
        default=list,
        nullable=False,
    )
    rubric: Mapped[list] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"),
        default=list,
        nullable=False,
    )
    reference_note_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("notes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    ai_eval_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    max_marks: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    due_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Compatibility property for max_score
    @property
    def max_score(self) -> int:
        return self.max_marks

    @max_score.setter
    def max_score(self, value: int) -> None:
        self.max_marks = value

    def __init__(self, **kwargs):
        if "max_score" in kwargs and "max_marks" not in kwargs:
            kwargs["max_marks"] = kwargs.pop("max_score")
        super().__init__(**kwargs)

    course = relationship("Course", back_populates="assignments", foreign_keys=[course_id])
    reference_note = relationship("Note", back_populates="assignments", foreign_keys=[reference_note_id])
    attachments = relationship(
        "AssignmentAttachment",
        back_populates="assignment",
        cascade="all, delete-orphan",
    )
    submissions = relationship("Submission", back_populates="assignment", cascade="all, delete-orphan")
    analytics_reports = relationship("AnalyticsReport", back_populates="assignment", cascade="all, delete-orphan")
