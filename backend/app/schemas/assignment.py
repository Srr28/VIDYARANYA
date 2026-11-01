import uuid
from datetime import datetime

from pydantic import BaseModel, Field, model_validator


class AssignmentCreate(BaseModel):
    course_id: uuid.UUID
    title: str
    description: str | None = None
    topics_list: list[str] = []
    rubric: list[dict] = []
    reference_note_id: uuid.UUID | None = None
    ai_eval_enabled: bool = True
    max_marks: int = Field(default=100, ge=1)
    max_score: int | None = None
    due_date: datetime | None = None
    private_reference_solution: str | None = Field(default=None, max_length=5000)

    @model_validator(mode="before")
    @classmethod
    def populate_max_marks(cls, data: any) -> any:
        if isinstance(data, dict):
            if "max_marks" not in data and "max_score" in data:
                data["max_marks"] = data["max_score"]
            elif "max_score" not in data and "max_marks" in data:
                data["max_score"] = data["max_marks"]
        return data

    @model_validator(mode="after")
    def validate_rubric(self) -> "AssignmentCreate":
        if not self.rubric:
            return self
        try:
            points = [float(item.get("max_points", 0)) for item in self.rubric]
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError("Each rubric criterion must include numeric max_points") from exc
        if any(not str(item.get("criterion", "")).strip() or value < 0 for item, value in zip(self.rubric, points)):
            raise ValueError("Rubric criteria need a name and non-negative points")
        if abs(sum(points) - self.max_marks) > 0.001:
            raise ValueError("Rubric points must add up to max_marks")
        return self


class AssignmentReferenceUpdate(BaseModel):
    solution_text: str = Field(min_length=1, max_length=5000)


class AssignmentReferenceOut(BaseModel):
    solution_text: str


class AssignmentOut(BaseModel):
    id: uuid.UUID
    course_id: uuid.UUID
    title: str
    description: str | None = None
    topics_list: list[str] = []
    rubric: list[dict] = []
    reference_note_id: uuid.UUID | None = None
    ai_eval_enabled: bool = True
    max_marks: int = 100
    max_score: int | None = None
    due_date: datetime | None = None

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def populate_max_marks(cls, data: any) -> any:
        if isinstance(data, dict):
            if "max_marks" not in data and "max_score" in data:
                data["max_marks"] = data["max_score"]
            elif "max_score" not in data and "max_marks" in data:
                data["max_score"] = data["max_marks"]
        return data


class SubmissionOverride(BaseModel):
    final_score: float
    teacher_comment: str | None = None
    faculty_note: str | None = None

    @model_validator(mode="before")
    @classmethod
    def populate_comment(cls, data: any) -> any:
        if isinstance(data, dict):
            if "faculty_note" not in data and "teacher_comment" in data:
                data["faculty_note"] = data["teacher_comment"]
            elif "teacher_comment" not in data and "faculty_note" in data:
                data["teacher_comment"] = data["faculty_note"]
        return data


class AssignmentDueDateUpdate(BaseModel):
    due_date: datetime | None = None
