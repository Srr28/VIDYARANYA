import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, JSON, String, Text, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class AnalyticsReport(Base):
    __tablename__ = "analytics_reports"
    __table_args__ = (
        CheckConstraint(
            "report_type IN ('class_summary', 'at_risk', 'topic_gap')",
            name="ck_analytics_report_type",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        primary_key=True,
        default=uuid.uuid4,
        index=True,
    )
    assignment_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("assignments.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    course_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("courses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    report_type: Mapped[str] = mapped_column(String(50), nullable=False)
    weak_topics: Mapped[dict | list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    at_risk_students: Mapped[dict | list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    narrative: Mapped[str | None] = mapped_column(Text, nullable=True)
    grade_distribution: Mapped[dict | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    assignment = relationship("Assignment", back_populates="analytics_reports", foreign_keys=[assignment_id])
    course = relationship("Course", back_populates="analytics_reports", foreign_keys=[course_id])
