from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.services.storage_service import (
    StorageService,
    get_assignment_attachment_key,
    get_note_key,
    get_submission_key,
    sanitize_filename,
)


def test_sanitize_filename():
    assert sanitize_filename("../secret/test.pdf") == "test.pdf"
    assert sanitize_filename("my lecture notes #1.pdf") == "my lecture notes 1.pdf"
    assert sanitize_filename("") == "file.bin"


def test_key_generators():
    note_key = get_note_key(101, "syllabus.pdf")
    assert note_key.startswith("courses/101/notes/")
    assert note_key.endswith("_syllabus.pdf")

    sub_key = get_submission_key(202, 303, "assignment1.pdf")
    assert sub_key.startswith("submissions/202/303/")
    assert sub_key.endswith("_assignment1.pdf")

    attach_key = get_assignment_attachment_key(101, 202, "rubric.pdf")
    assert attach_key.startswith("courses/101/assignments/202/")
    assert attach_key.endswith("_rubric.pdf")


def test_local_storage_operations(tmp_path, monkeypatch):
    # Ensure local mode
    service = StorageService()
    service._use_r2 = False
    service._s3_client = None

    test_key = "courses/1/notes/test_note.txt"
    test_content = b"Lecture note content for testing"

    # Test upload bytes
    saved_path = service.upload_bytes(test_key, test_content, "text/plain")
    assert Path(saved_path).is_file()

    # Test download bytes
    downloaded = service.download_file_bytes(test_key)
    assert downloaded == test_content

    # Test download to temp
    temp_path = service.download_file_to_temp(test_key)
    assert Path(temp_path).is_file()
    assert Path(temp_path).read_bytes() == test_content
    Path(temp_path).unlink(missing_ok=True)

    # Test presigned PUT & GET (local fallback)
    put_info = service.generate_presigned_put_url(test_key, "text/plain")
    assert "upload_url" in put_info
    assert put_info["backend"] == "local"
    assert put_info["file_key"] == test_key

    get_url = service.generate_presigned_get_url(test_key)
    assert "local-download" in get_url
    assert f"key={test_key}" in get_url

    # Test delete
    deleted = service.delete_file(test_key)
    assert deleted is True
    assert not Path(saved_path).exists()


def test_r2_storage_presigned_generation():
    service = StorageService()
    mock_s3 = MagicMock()
    mock_s3.generate_presigned_url.side_effect = [
        "https://r2.example.com/put-upload-signed",
        "https://r2.example.com/get-download-signed",
    ]
    service._s3_client = mock_s3
    service._use_r2 = True

    test_key = "courses/5/notes/lecture.pdf"

    put_info = service.generate_presigned_put_url(test_key, "application/pdf")
    assert put_info["upload_url"] == "https://r2.example.com/put-upload-signed"
    assert put_info["backend"] == "r2"
    assert put_info["file_key"] == test_key
    mock_s3.generate_presigned_url.assert_called_with(
        ClientMethod="put_object",
        Params={"Bucket": service.bucket, "Key": test_key, "ContentType": "application/pdf"},
        ExpiresIn=300,
    )

    get_url = service.generate_presigned_get_url(test_key)
    assert get_url == "https://r2.example.com/get-download-signed"
