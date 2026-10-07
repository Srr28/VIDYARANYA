import uuid
from datetime import datetime

from pydantic import BaseModel, model_validator


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    full_name: str | None = None
    picture: str | None = None
    avatar_url: str | None = None
    role: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def populate_aliases(cls, data: any) -> any:
        if isinstance(data, dict):
            if "name" not in data and "full_name" in data:
                data["name"] = data["full_name"]
            if "full_name" not in data and "name" in data:
                data["full_name"] = data["name"]
            if "picture" not in data and "avatar_url" in data:
                data["picture"] = data["avatar_url"]
            if "avatar_url" not in data and "picture" in data:
                data["avatar_url"] = data["picture"]
        return data


class UserProfileUpdate(BaseModel):
    name: str | None = None
    full_name: str | None = None
    picture: str | None = None
    avatar_url: str | None = None
