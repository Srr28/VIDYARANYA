import uuid
from datetime import datetime

from pydantic import BaseModel, model_validator


class SubmissionOut(BaseModel):
    id: uuid.UUID
    assignment_id: uuid.UUID
    student_id: uuid.UUID
    file_key: str
    file_path: str | None = None
    status: str
    ai_score: float | None = None
    final_score: float | None = None
    mastery_level: str | None = None
    topic_scores: list | dict | None = None
    feedback_text: str | None = None
    integrity_score: float | None = None
    plagiarism_flag: bool = False
    faculty_note: str | None = None
    teacher_comment: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def populate_aliases(cls, data: any) -> any:
        if isinstance(data, dict):
            if "file_path" not in data and "file_key" in data:
                data["file_path"] = data["file_key"]
            if "teacher_comment" not in data and "faculty_note" in data:
                data["teacher_comment"] = data["faculty_note"]
            if "faculty_note" not in data and "teacher_comment" in data:
                data["faculty_note"] = data["teacher_comment"]
        return data
