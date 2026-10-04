import json
from urllib.parse import urlparse
from typing import Any

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    ENVIRONMENT: str = "development"
    DATABASE_URL: str = "postgresql://eduuser:srr28082006@db:5432/eduai_db"
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 120
    FRONTEND_URL: str = "http://localhost"
    FRONTEND_ALLOWED_HOSTS: list[str] = ["localhost", "127.0.0.1"]
    ENABLE_DEV_LOGIN: bool = True
    GROQ_API_KEY: str
    GROQ_MODEL: str = "llama-3.3-70b-versatile"
    GOOGLE_CLIENT_ID: str
    GOOGLE_CLIENT_SECRET: str
    BACKEND_CORS_ORIGINS: list[str] = ["http://localhost", "http://localhost:80"]
    BACKEND_CORS_ALLOW_ORIGIN_REGEX: str | None = (
        r"^https?://(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?::\d+)?$"
    )
    # Cloudflare R2 Object Storage
    R2_ACCOUNT_ID: str | None = None
    R2_ACCESS_KEY_ID: str | None = None
    R2_SECRET_ACCESS_KEY: str | None = None
    R2_BUCKET_NAME: str = "vidyaranya-bucket"
    STORAGE_BACKEND: str = "auto"

    @property
    def r2_endpoint_url(self) -> str | None:
        if self.R2_ACCOUNT_ID:
            return f"https://{self.R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
        return None

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: Any) -> list[str]:
        if isinstance(value, str):
            try:
                loaded = json.loads(value)
                if isinstance(loaded, list):
                    return [str(item) for item in loaded]
            except json.JSONDecodeError:
                return [item.strip() for item in value.split(",") if item.strip()]
        if isinstance(value, list):
            return [str(item) for item in value]
        return ["http://localhost", "http://localhost:80"]

    @field_validator("FRONTEND_ALLOWED_HOSTS", mode="before")
    @classmethod
    def parse_frontend_allowed_hosts(cls, value: Any) -> list[str]:
        if isinstance(value, str):
            try:
                loaded = json.loads(value)
                if isinstance(loaded, list):
                    return [str(item).strip().lower() for item in loaded if str(item).strip()]
            except json.JSONDecodeError:
                return [item.strip().lower() for item in value.split(",") if item.strip()]
        if isinstance(value, list):
            return [str(item).strip().lower() for item in value if str(item).strip()]
        return ["localhost", "127.0.0.1"]

    @field_validator("ENVIRONMENT", mode="before")
    @classmethod
    def normalize_environment(cls, value: Any) -> str:
        env = str(value or "development").strip().lower()
        if env not in {"development", "staging", "production"}:
            raise ValueError("ENVIRONMENT must be development, staging, or production")
        return env

    @field_validator("SECRET_KEY")
    @classmethod
    def validate_secret_key(cls, value: str) -> str:
        if len((value or "").strip()) < 32:
            raise ValueError("SECRET_KEY must be at least 32 characters")
        return value

    @field_validator("ACCESS_TOKEN_EXPIRE_MINUTES")
    @classmethod
    def validate_access_token_expiry(cls, value: int) -> int:
        if value < 5 or value > 30 * 24 * 60:
            raise ValueError("ACCESS_TOKEN_EXPIRE_MINUTES must be between 5 and 43200")
        return value

    @field_validator("FRONTEND_URL")
    @classmethod
    def validate_frontend_url(cls, value: str) -> str:
        parsed = urlparse(value or "")
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("FRONTEND_URL must be a valid http/https URL")
        return value.rstrip("/")

    @model_validator(mode="after")
    def validate_prod_dev_login(self) -> "Settings":
        if self.ENVIRONMENT == "production" and self.ENABLE_DEV_LOGIN:
            raise ValueError("ENABLE_DEV_LOGIN must be false in production")
        return self


settings = Settings()
