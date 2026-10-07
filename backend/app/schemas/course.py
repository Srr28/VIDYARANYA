import uuid
from datetime import datetime

from pydantic import BaseModel, model_validator


class CourseCreate(BaseModel):
    name: str
    subject: str | None = None
    section: str | None = None
    description: str | None = None


class CourseJoinRequest(BaseModel):
    code: str


class CourseOut(BaseModel):
    id: uuid.UUID
    name: str
    subject: str | None = None
    section: str | None = None
    description: str | None = None
    faculty_id: uuid.UUID | None = None
    teacher_id: uuid.UUID | None = None
    join_code: str
    banner_color: str
    created_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def populate_aliases(cls, data: any) -> any:
        if isinstance(data, dict):
            if "teacher_id" not in data and "faculty_id" in data:
                data["teacher_id"] = data["faculty_id"]
            if "faculty_id" not in data and "teacher_id" in data:
                data["faculty_id"] = data["teacher_id"]
        return data
