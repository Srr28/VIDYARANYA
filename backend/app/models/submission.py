import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, JSON, Numeric, String, Text, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Submission(Base):
    __tablename__ = "submissions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending_eval', 'evaluating', 'graded', 'overdue', 'flagged', 'pending')",
            name="ck_submission_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        primary_key=True,
        default=uuid.uuid4,
        index=True,
    )
    assignment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("assignments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    student_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_key: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="pending_eval", nullable=False)
    ai_score: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    final_score: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    mastery_level: Mapped[str | None] = mapped_column(String(50), nullable=True)
    topic_scores: Mapped[dict | list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    feedback_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    integrity_score: Mapped[float | None] = mapped_column(Numeric(4, 2), nullable=True)
    plagiarism_flag: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    faculty_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    text_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Compatibility properties
    @property
    def file_path(self) -> str:
        return self.file_key

    @file_path.setter
    def file_path(self, value: str) -> None:
        self.file_key = value

    @property
    def teacher_comment(self) -> str | None:
        return self.faculty_note

    @teacher_comment.setter
    def teacher_comment(self, value: str | None) -> None:
        self.faculty_note = value

    @property
    def ai_feedback(self) -> dict | None:
        if self.feedback_text:
            return {"feedback": self.feedback_text, "topic_scores": self.topic_scores}
        return None

    @ai_feedback.setter
    def ai_feedback(self, value: dict | None) -> None:
        if isinstance(value, dict):
            self.feedback_text = value.get("general_feedback") or value.get("feedback") or str(value)
            if "breakdown" in value:
                self.topic_scores = value["breakdown"]
        elif isinstance(value, str):
            self.feedback_text = value

    def __init__(self, **kwargs):
        if "file_path" in kwargs and "file_key" not in kwargs:
            kwargs["file_key"] = kwargs.pop("file_path")
        if "teacher_comment" in kwargs and "faculty_note" not in kwargs:
            kwargs["faculty_note"] = kwargs.pop("teacher_comment")
        if "ai_feedback" in kwargs and "feedback_text" not in kwargs:
            val = kwargs.pop("ai_feedback")
            if isinstance(val, dict):
                kwargs["feedback_text"] = val.get("general_feedback") or val.get("feedback") or str(val)
                if "breakdown" in val:
                    kwargs["topic_scores"] = val["breakdown"]
            elif isinstance(val, str):
                kwargs["feedback_text"] = val
        super().__init__(**kwargs)

    assignment = relationship("Assignment", back_populates="submissions", foreign_keys=[assignment_id])
    student = relationship("User", back_populates="submissions", foreign_keys=[student_id])
    submission_text = relationship(
        "SubmissionText",
        back_populates="submission",
        uselist=False,
        cascade="all, delete-orphan",
    )
    comments = relationship("SubmissionComment", back_populates="submission", cascade="all, delete-orphan")
