from datetime import datetime

from pydantic import BaseModel


class AssignmentCreate(BaseModel):
    course_id: int
    title: str
    description: str | None = None
    rubric: list[dict]
    due_date: datetime | None = None
    max_score: int


class AssignmentOut(BaseModel):
    id: int
    course_id: int
    title: str
    description: str | None = None
    rubric: list[dict]
    due_date: datetime | None = None
    max_score: int

    model_config = {"from_attributes": True}


class SubmissionOverride(BaseModel):
    final_score: float
    teacher_comment: str | None = None


class AssignmentDueDateUpdate(BaseModel):
    due_date: datetime | None = None
