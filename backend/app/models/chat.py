import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class ChatMessage(Base):
    __tablename__ = "chat_history"

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
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    user_message: Mapped[str] = mapped_column(Text, nullable=False)
    ai_response: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    course = relationship("Course", back_populates="chats", foreign_keys=[course_id])
    user = relationship("User", back_populates="chat_messages", foreign_keys=[user_id])
