import uuid

from sqlalchemy import ForeignKey, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AssignmentReference(Base):
    """Private answer key for an assignment; never included in student payloads."""

    __tablename__ = "assignment_references"

    assignment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("assignments.id", ondelete="CASCADE"),
        primary_key=True,
    )
    solution_text: Mapped[str] = mapped_column(Text, nullable=False)
