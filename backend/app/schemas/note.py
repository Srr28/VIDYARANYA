import uuid
from datetime import datetime

from pydantic import BaseModel, model_validator


class NoteOut(BaseModel):
    id: uuid.UUID
    course_id: uuid.UUID
    title: str
    file_key: str
    file_path: str | None = None
    file_type: str | None = None
    chroma_indexed: bool = False
    is_indexed: bool = False
    chunk_count: int = 0
    created_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def populate_aliases(cls, data: any) -> any:
        if isinstance(data, dict):
            if "file_path" not in data and "file_key" in data:
                data["file_path"] = data["file_key"]
            if "is_indexed" not in data and "chroma_indexed" in data:
                data["is_indexed"] = data["chroma_indexed"]
        return data
