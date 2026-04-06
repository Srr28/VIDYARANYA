from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    course_id: int
    message: str
    note_ids: list[int] = Field(default_factory=list)


class ChatResponse(BaseModel):
    answer: str
    sources: list[str]
