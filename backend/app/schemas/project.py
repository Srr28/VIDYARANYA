from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class BenchmarkCreate(BaseModel):
    title: str
    description: str
    weight: float
    expected_stage: int = 1

    @field_validator("weight")
    @classmethod
    def validate_weight(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("weight must be greater than 0")
        return value

    @field_validator("title", "description")
    @classmethod
    def validate_text_fields(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("text fields cannot be empty")
        return cleaned

    @field_validator("expected_stage")
    @classmethod
    def validate_expected_stage(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("expected_stage must be greater than 0")
        return value


class BenchmarkOut(BaseModel):
    id: int
    title: str
    description: str
    weight: float
    expected_stage: int

    model_config = {"from_attributes": True}


class ProjectCreate(BaseModel):
    course_id: int
    title: str
    description: str
    benchmarks: list[BenchmarkCreate] = Field(min_length=1)

    @field_validator("title", "description")
    @classmethod
    def validate_project_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("text fields cannot be empty")
        return cleaned


class ProjectOut(BaseModel):
    id: int
    course_id: int
    teacher_id: int
    title: str
    description: str
    created_at: datetime
    benchmarks: list[BenchmarkOut]

    model_config = {"from_attributes": True}


class ProjectSubmissionCreate(BaseModel):
    stage: int = 1
    submission_text: str

    @field_validator("stage")
    @classmethod
    def validate_stage(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("stage must be greater than 0")
        return value

    @field_validator("submission_text")
    @classmethod
    def validate_submission_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("submission_text cannot be empty")
        return cleaned


class BenchmarkScoreOut(BaseModel):
    title: str
    score: float


class EvaluationOut(BaseModel):
    id: int
    submission_id: int
    alignment_score: float
    benchmark_score: float
    benchmark_scores: list[BenchmarkScoreOut]
    progress_score: float
    final_score: float
    drift: bool
    feedback: str
    created_at: datetime


class ProjectSubmissionResultOut(BaseModel):
    submission_id: int
    project_id: int
    student_id: int
    stage: int
    created_at: datetime
    evaluation: EvaluationOut


class EvaluationHistoryItem(BaseModel):
    submission_id: int
    stage: int
    submission_text: str
    created_at: datetime
    evaluation: EvaluationOut


class EvaluationHistoryOut(BaseModel):
    project_id: int
    student_id: int
    latest_final_score: float | None = None
    latest_progress_score: float | None = None
    evaluations: list[EvaluationHistoryItem]
