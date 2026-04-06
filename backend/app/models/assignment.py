from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Assignment(Base):
    __tablename__ = "assignments"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    rubric: Mapped[list] = mapped_column(JSONB, nullable=False)
    due_date: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    max_score: Mapped[int] = mapped_column(Integer, nullable=False)

    course = relationship("Course", back_populates="assignments")
    attachments = relationship(
        "AssignmentAttachment",
        back_populates="assignment",
        cascade="all, delete-orphan",
    )
    submissions = relationship("Submission", back_populates="assignment", cascade="all, delete-orphan")
