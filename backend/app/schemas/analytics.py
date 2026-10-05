import uuid
from datetime import datetime

from pydantic import BaseModel


class AnalyticsReportOut(BaseModel):
    id: uuid.UUID
    assignment_id: uuid.UUID | None = None
    course_id: uuid.UUID
    report_type: str
    weak_topics: dict | list | None = None
    at_risk_students: dict | list | None = None
    narrative: str | None = None
    grade_distribution: dict | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ProgressReportOut(BaseModel):
    id: uuid.UUID
    student_id: uuid.UUID
    course_id: uuid.UUID
    narrative: str | None = None
    mastery_snapshot: dict | None = None
    rank: int | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
