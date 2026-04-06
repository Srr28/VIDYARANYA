from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class ProjectSubmission(Base):
    __tablename__ = "project_submissions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    stage: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    submission_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project = relationship("Project", back_populates="submissions")
    student = relationship("User", back_populates="project_submissions")
    evaluations = relationship("Evaluation", back_populates="submission", cascade="all, delete-orphan")
