import os
import shutil
import tempfile
from pathlib import Path
from uuid import uuid4

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
except ImportError:
    boto3 = None
    Config = None  # type: ignore
    ClientError = Exception  # type: ignore

from app.core.config import settings

LOCAL_UPLOAD_BASE = Path("uploads")
LOCAL_UPLOAD_BASE.mkdir(parents=True, exist_ok=True)


def sanitize_filename(filename: str) -> str:
    raw = Path(filename).name
    cleaned = "".join(c for c in raw if c.isalnum() or c in "._- ")
    return cleaned.strip() or "file.bin"


def get_note_key(course_id: int | str, filename: str) -> str:
    safe = sanitize_filename(filename)
    return f"courses/{course_id}/notes/{uuid4()}_{safe}"


def get_submission_key(assignment_id: int | str, student_id: int | str, filename: str) -> str:
    safe = sanitize_filename(filename)
    return f"submissions/{assignment_id}/{student_id}/{uuid4()}_{safe}"


def get_assignment_attachment_key(course_id: int | str, assignment_id: int | str, filename: str) -> str:
    safe = sanitize_filename(filename)
    return f"courses/{course_id}/assignments/{assignment_id}/{uuid4()}_{safe}"


class StorageService:
    def __init__(self) -> None:
        self.bucket = settings.R2_BUCKET_NAME or "vidyaranya-bucket"
        self._s3_client = None
        self._use_r2 = False
        self._init_backend()

    def _init_backend(self) -> None:
        forced_backend = (settings.STORAGE_BACKEND or "auto").lower()

        has_creds = bool(
            settings.R2_ACCOUNT_ID
            and settings.R2_ACCESS_KEY_ID
            and settings.R2_SECRET_ACCESS_KEY
        )

        if forced_backend == "r2" or (forced_backend == "auto" and has_creds):
            try:
                self._s3_client = boto3.client(
                    "s3",
                    endpoint_url=settings.r2_endpoint_url,
                    aws_access_key_id=settings.R2_ACCESS_KEY_ID,
                    aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
                    region_name="auto",
                    config=Config(signature_version="s3v4"),
                )
                self._use_r2 = True
            except Exception:
                self._use_r2 = False
                self._s3_client = None
        else:
            self._use_r2 = False

    @property
    def is_r2_active(self) -> bool:
        return self._use_r2 and self._s3_client is not None

    def generate_presigned_put_url(
        self,
        key: str,
        content_type: str = "application/pdf",
        max_size_mb: int = 10,
        expires_in: int = 300,
    ) -> dict:
        """
        Generate a presigned PUT URL for direct client-to-storage upload.
        """
        if self.is_r2_active:
            url = self._s3_client.generate_presigned_url(
                ClientMethod="put_object",
                Params={
                    "Bucket": self.bucket,
                    "Key": key,
                    "ContentType": content_type,
                },
                ExpiresIn=expires_in,
            )
            return {
                "upload_url": url,
                "file_key": key,
                "method": "PUT",
                "headers": {"Content-Type": content_type},
                "expires_in": expires_in,
                "max_size_bytes": max_size_mb * 1024 * 1024,
                "backend": "r2",
            }
        else:
            # Local fallback emulation
            local_target = LOCAL_UPLOAD_BASE / key
            local_target.parent.mkdir(parents=True, exist_ok=True)
            base_url = settings.FRONTEND_URL.rstrip("/")
            return {
                "upload_url": f"{base_url}/api/storage/local-upload?key={key}",
                "file_key": key,
                "method": "PUT",
                "headers": {"Content-Type": content_type},
                "expires_in": expires_in,
                "max_size_bytes": max_size_mb * 1024 * 1024,
                "backend": "local",
            }

    def generate_presigned_get_url(self, key: str, expires_in: int = 3600) -> str:
        """
        Generate a presigned GET URL for secure, temporary file download.
        """
        if self.is_r2_active:
            return self._s3_client.generate_presigned_url(
                ClientMethod="get_object",
                Params={
                    "Bucket": self.bucket,
                    "Key": key,
                },
                ExpiresIn=expires_in,
            )
        else:
            base_url = settings.FRONTEND_URL.rstrip("/")
            return f"{base_url}/api/storage/local-download?key={key}"

    def upload_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        """
        Upload bytes directly from backend server (used for migrations or fallback).
        """
        if self.is_r2_active:
            self._s3_client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
            return key
        else:
            local_path = LOCAL_UPLOAD_BASE / key
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(data)
            return str(local_path)

    def download_file_bytes(self, key: str) -> bytes:
        """
        Download raw file bytes for ingestion and OCR processing.
        """
        if self.is_r2_active:
            try:
                response = self._s3_client.get_object(Bucket=self.bucket, Key=key)
                return response["Body"].read()
            except ClientError as e:
                raise FileNotFoundError(f"File key not found in R2: {key}") from e
        else:
            # Check if key is a full local path or relative to LOCAL_UPLOAD_BASE
            path = Path(key)
            if not path.is_file():
                path = LOCAL_UPLOAD_BASE / key
            if not path.is_file():
                raise FileNotFoundError(f"Local file not found: {key}")
            return path.read_bytes()

    def download_file_to_temp(self, key: str) -> str:
        """
        Download file to a local temporary path. Caller is responsible for deleting the temp file if needed.
        """
        suffix = Path(key).suffix or ".bin"
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        try:
            data = self.download_file_bytes(key)
            temp_file.write(data)
            temp_file.flush()
            return temp_file.name
        finally:
            temp_file.close()

    def delete_file(self, key: str) -> bool:
        """
        Delete a file by key.
        """
        if self.is_r2_active:
            try:
                self._s3_client.delete_object(Bucket=self.bucket, Key=key)
                return True
            except ClientError:
                return False
        else:
            path = Path(key)
            if not path.is_file():
                path = LOCAL_UPLOAD_BASE / key
            if path.is_file():
                path.unlink(missing_ok=True)
                return True
            return False


storage_service = StorageService()
