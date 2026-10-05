import uuid

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    course_id: uuid.UUID
    message: str
    note_ids: list[uuid.UUID] = Field(default_factory=list)


class ChatResponse(BaseModel):
    answer: str
    sources: list[str]
