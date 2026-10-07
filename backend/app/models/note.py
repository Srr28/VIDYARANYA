import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Note(Base):
    __tablename__ = "notes"

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
    file_key: Mapped[str] = mapped_column(String(500), nullable=False)
    file_type: Mapped[str | None] = mapped_column(String(10), nullable=True)
    chroma_indexed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Compatibility properties for file_path and is_indexed
    @property
    def file_path(self) -> str:
        return self.file_key

    @file_path.setter
    def file_path(self, value: str) -> None:
        self.file_key = value

    @property
    def is_indexed(self) -> bool:
        return self.chroma_indexed

    @is_indexed.setter
    def is_indexed(self, value: bool) -> None:
        self.chroma_indexed = value

    def __init__(self, **kwargs):
        if "file_path" in kwargs and "file_key" not in kwargs:
            kwargs["file_key"] = kwargs.pop("file_path")
        if "is_indexed" in kwargs and "chroma_indexed" not in kwargs:
            kwargs["chroma_indexed"] = kwargs.pop("is_indexed")
        super().__init__(**kwargs)

    course = relationship("Course", back_populates="notes", foreign_keys=[course_id])
    assignments = relationship("Assignment", back_populates="reference_note")
