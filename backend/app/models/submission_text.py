import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class SubmissionText(Base):
    __tablename__ = "submission_texts"

    submission_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("submissions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    submission = relationship("Submission", back_populates="submission_text")
