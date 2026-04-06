from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Evaluation(Base):
    __tablename__ = "evaluations"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False, index=True)
    submission_id: Mapped[int] = mapped_column(ForeignKey("project_submissions.id"), nullable=False, index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    alignment_score: Mapped[float] = mapped_column(Float, nullable=False)
    benchmark_score: Mapped[float] = mapped_column(Float, nullable=False)
    benchmark_scores: Mapped[list] = mapped_column(JSONB, nullable=False)
    progress_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    final_score: Mapped[float] = mapped_column(Float, nullable=False)
    drift: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    feedback: Mapped[str] = mapped_column(Text, nullable=False)
    raw_response: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project = relationship("Project", back_populates="evaluations")
    submission = relationship("ProjectSubmission", back_populates="evaluations")
    student = relationship("User", back_populates="evaluations")
