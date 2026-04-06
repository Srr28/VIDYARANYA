from datetime import datetime

from pydantic import BaseModel


class CourseCreate(BaseModel):
    name: str
    section: str | None = None
    description: str | None = None


class CourseJoinRequest(BaseModel):
    code: str


class CourseOut(BaseModel):
    id: int
    name: str
    section: str | None = None
    description: str | None = None
    teacher_id: int
    join_code: str
    banner_color: str
    created_at: datetime

    model_config = {"from_attributes": True}
