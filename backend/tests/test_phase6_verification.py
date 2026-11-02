import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, PropertyMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.database import Base
from app.core.rate_limit import limiter
from app.core.security import create_access_token, create_signed_token, decode_signed_token
from app.main import app as fastapi_app
from app.models.analytics_report import AnalyticsReport
from app.models.announcement import Announcement
from app.models.assignment import Assignment
from app.models.assignment_attachment import AssignmentAttachment
from app.models.assignment_reference import AssignmentReference
from app.models.chat import ChatMessage
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.note import Note
from app.models.progress_report import ProgressReport
from app.models.refresh_token import RefreshToken
from app.models.submission import Submission
from app.models.submission_comment import SubmissionComment
from app.models.submission_text import SubmissionText
from app.models.user import User
from app.services.file_validation import validate_uploaded_file
from app.services.rag_service import stream_chat


# ---------------------------------------------------------------------------
# Test SQLite Engine & Session Fixture
# ---------------------------------------------------------------------------
test_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


@pytest.fixture(scope="function")
def db_session():
    Base.metadata.create_all(bind=test_engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def client(db_session):
    from app.api.deps import get_db

    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    fastapi_app.dependency_overrides[get_db] = override_get_db
    test_client = TestClient(fastapi_app, base_url="http://localhost")
    yield test_client
    fastapi_app.dependency_overrides.clear()


@pytest.fixture
def test_users(db_session):
    faculty = User(
        email="faculty_p6@test.edu",
        full_name="Prof. Phase6",
        role="faculty",
        is_active=True,
    )
    student = User(
        email="student_p6@test.edu",
        full_name="Student Phase6",
        role="student",
        is_active=True,
    )
    db_session.add_all([faculty, student])
    db_session.commit()
    db_session.refresh(faculty)
    db_session.refresh(student)
    return {"faculty": faculty, "student": student}


@pytest.fixture
def test_course(db_session, test_users):
    course = Course(
        name="Phase 6 Advanced Systems",
        subject="Computer Science",
        faculty_id=test_users["faculty"].id,
        join_code="P6TEST",
    )
    db_session.add(course)
    db_session.commit()
    db_session.refresh(course)

    enrollment = Enrollment(
        course_id=course.id,
        student_id=test_users["student"].id,
        status="active",
    )
    db_session.add(enrollment)
    db_session.commit()
    return course


def _auth_headers(user: User) -> dict:
    token = create_access_token(
        subject=str(user.id),
        extra_claims={"email": user.email, "role": user.role, "full_name": user.full_name},
    )
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# 1. File Validation (Magic Bytes & Type Checks)
# ---------------------------------------------------------------------------
class TestFileValidation:
    def test_valid_pdf_magic_bytes(self):
        valid_pdf = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"
        validate_uploaded_file("document.pdf", valid_pdf)  # should not raise

    def test_spoofed_pdf_rejected(self):
        spoofed_pdf = b"This is just a plain text file pretending to be PDF"
        with pytest.raises(HTTPException) as exc_info:
            validate_uploaded_file("malicious.pdf", spoofed_pdf)
        assert exc_info.value.status_code == 400
        assert "does not match .pdf" in exc_info.value.detail

    def test_valid_png_magic_bytes(self):
        valid_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        validate_uploaded_file("diagram.png", valid_png)

    def test_valid_jpeg_magic_bytes(self):
        valid_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF"
        validate_uploaded_file("photo.jpg", valid_jpeg)

    def test_valid_utf8_text_files(self):
        valid_py = b"def solve():\n    return 42\n"
        validate_uploaded_file("solution.py", valid_py)

        valid_txt = "Hello Vidyaranya AI assessment".encode("utf-8")
        validate_uploaded_file("notes.txt", valid_txt)

    def test_text_file_with_null_bytes_rejected(self):
        binary_as_txt = b"Hello\x00World\x00Binary"
        with pytest.raises(HTTPException) as exc_info:
            validate_uploaded_file("readme.txt", binary_as_txt)
        assert exc_info.value.status_code == 400
        assert "contains binary data" in exc_info.value.detail

    def test_unsupported_file_extension(self):
        exe_file = b"MZ\x90\x00\x03\x00\x00\x00"
        with pytest.raises(HTTPException) as exc_info:
            validate_uploaded_file("malware.exe", exe_file)
        assert exc_info.value.status_code == 415

    def test_empty_file_rejected(self):
        with pytest.raises(HTTPException) as exc_info:
            validate_uploaded_file("empty.pdf", b"")
        assert exc_info.value.status_code == 400
        assert "empty" in exc_info.value.detail

    def test_oversized_file_rejected(self):
        oversized = b"A" * (10 * 1024 * 1024 + 1)
        with pytest.raises(HTTPException) as exc_info:
            validate_uploaded_file("large.txt", oversized)
        assert exc_info.value.status_code == 413


# ---------------------------------------------------------------------------
# 2. Auth & Refresh Token Lifecycle
# ---------------------------------------------------------------------------
class TestAuthAndRefreshToken:
    def test_google_login_endpoint(self, client):
        response = client.get("/auth/google/login", follow_redirects=False)
        assert response.status_code in (302, 307)
        location = response.headers.get("location", "")
        assert "accounts.google.com" in location
        assert "client_id=" in location
        assert "state=" in location

    def test_dev_login_sets_refresh_cookie(self, client, db_session):
        response = client.get("/auth/dev-login?identity=demo")
        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

        # Check refresh_token cookie
        cookie = response.cookies.get("refresh_token")
        assert cookie is not None

        # Verify refresh token in DB
        payload = decode_signed_token(cookie)
        jti = payload.get("jti")
        assert jti is not None
        record = db_session.query(RefreshToken).filter(RefreshToken.jti == jti).first()
        assert record is not None
        assert record.revoked_at is None
        assert record.token_hash == hashlib.sha256(cookie.encode()).hexdigest()

    def test_refresh_token_rotation_and_expiry(self, client, db_session, test_users):
        student = test_users["student"]
        jti = uuid.uuid4().hex
        raw_refresh = create_signed_token(
            subject=str(student.id),
            extra_claims={"type": "refresh", "jti": jti},
            expires_minutes=60,
        )
        record = RefreshToken(
            user_id=student.id,
            jti=jti,
            token_hash=hashlib.sha256(raw_refresh.encode()).hexdigest(),
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
        )
        db_session.add(record)
        db_session.commit()

        # Call /auth/refresh with valid cookie
        client.cookies.set("refresh_token", raw_refresh)
        refresh_res = client.post("/auth/refresh", headers={"Origin": "http://localhost"})
        assert refresh_res.status_code == 200
        new_tokens = refresh_res.json()
        assert "access_token" in new_tokens

        # Check that old record was revoked
        db_session.refresh(record)
        assert record.revoked_at is not None

        # Check new refresh cookie was issued
        new_cookie = refresh_res.cookies.get("refresh_token")
        assert new_cookie is not None
        assert new_cookie != raw_refresh

    def test_refresh_fails_with_revoked_token(self, client, db_session, test_users):
        student = test_users["student"]
        jti = uuid.uuid4().hex
        raw_refresh = create_signed_token(
            subject=str(student.id),
            extra_claims={"type": "refresh", "jti": jti},
            expires_minutes=60,
        )
        record = RefreshToken(
            user_id=student.id,
            jti=jti,
            token_hash=hashlib.sha256(raw_refresh.encode()).hexdigest(),
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            revoked_at=datetime.now(timezone.utc),
        )
        db_session.add(record)
        db_session.commit()

        client.cookies.set("refresh_token", raw_refresh)
        res = client.post("/auth/refresh", headers={"Origin": "http://localhost"})
        assert res.status_code == 401

    def test_logout_revokes_token_and_clears_cookie(self, client, db_session, test_users):
        student = test_users["student"]
        jti = uuid.uuid4().hex
        raw_refresh = create_signed_token(
            subject=str(student.id),
            extra_claims={"type": "refresh", "jti": jti},
            expires_minutes=60,
        )
        record = RefreshToken(
            user_id=student.id,
            jti=jti,
            token_hash=hashlib.sha256(raw_refresh.encode()).hexdigest(),
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
        )
        db_session.add(record)
        db_session.commit()

        client.cookies.set("refresh_token", raw_refresh)
        logout_res = client.post("/auth/logout", headers={"Origin": "http://localhost"})
        assert logout_res.status_code == 200

        db_session.refresh(record)
        assert record.revoked_at is not None


# ---------------------------------------------------------------------------
# 3. Notes Endpoints (Presign, Download, Compat routes)
# ---------------------------------------------------------------------------
class TestNotesEndpoints:
    def test_presign_note_upload_route(self, client, test_course, test_users):
        headers = _auth_headers(test_users["faculty"])
        res = client.post(
            f"/courses/{test_course.id}/notes/presign",
            json={"filename": "lecture1.pdf", "content_type": "application/pdf"},
            headers=headers,
        )
        assert res.status_code == 200
        data = res.json()
        assert "upload_url" in data
        assert "file_key" in data

    def test_download_note_route(self, client, db_session, test_course, test_users, tmp_path):
        dummy_file = tmp_path / "dummy.pdf"
        dummy_file.write_bytes(b"%PDF-1.4 syllabus content")
        note = Note(
            course_id=test_course.id,
            title="Syllabus",
            file_key=str(dummy_file),
            file_type="pdf",
        )
        db_session.add(note)
        db_session.commit()

        from app.services.storage_service import storage_service
        with patch.object(type(storage_service), "is_r2_active", new_callable=PropertyMock, return_value=False):
            res1 = client.get(f"/notes/{note.id}/download", headers=_auth_headers(test_users["student"]))
            res2 = client.get(f"/notes/download/{note.id}", headers=_auth_headers(test_users["student"]))
            assert res1.status_code == 200
            assert res2.status_code == 200


# ---------------------------------------------------------------------------
# 3. Course Creation Authorization
# ---------------------------------------------------------------------------
class TestCourseCreationAuthorization:
    def test_student_cannot_create_course_or_be_promoted(self, client, db_session, test_users):
        student = test_users["student"]
        response = client.post(
            "/courses",
            json={"name": "Unauthorized course", "subject": "Security"},
            headers=_auth_headers(student),
        )

        assert response.status_code == 403
        db_session.refresh(student)
        assert student.role == "student"
        assert db_session.query(Course).filter(Course.name == "Unauthorized course").first() is None

    def test_faculty_can_create_course(self, client, test_users):
        faculty = test_users["faculty"]
        response = client.post(
            "/courses",
            json={"name": "Authorized course", "subject": "Security", "section": "A"},
            headers=_auth_headers(faculty),
        )

        assert response.status_code == 200
        assert response.json()["faculty_id"] == str(faculty.id)


# ---------------------------------------------------------------------------
# 4. Assignments Endpoints
# ---------------------------------------------------------------------------
class TestAssignmentsEndpoints:
    def test_create_assignment_for_course_route(self, client, test_course, test_users):
        headers = _auth_headers(test_users["faculty"])
        payload = {
            "course_id": str(test_course.id),
            "title": "Assignment 1: Distributed Consensus",
            "description": "Implement Raft consensus algorithm.",
            "topics_list": ["Distributed Systems", "Consensus", "Fault Tolerance"],
            "rubric": [
                {"criterion": "Leader Election", "max_points": 40},
                {"criterion": "Log Replication", "max_points": 60},
            ],
            "max_marks": 100,
        }
        res = client.post(f"/courses/{test_course.id}/assignments", json=payload, headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data["title"] == payload["title"]
        assert data["topics_list"] == payload["topics_list"]
        assert len(data["rubric"]) == 2

    def test_create_assignment_mismatched_course_id(self, client, test_course, test_users):
        headers = _auth_headers(test_users["faculty"])
        random_id = str(uuid.uuid4())
        payload = {
            "course_id": random_id,
            "title": "Mismatched",
            "topics_list": ["Algorithms"],
            "rubric": [],
            "max_marks": 100,
        }
        res = client.post(f"/courses/{test_course.id}/assignments", json=payload, headers=headers)
        assert res.status_code == 400


# ---------------------------------------------------------------------------
# 5. Submissions Endpoints
# ---------------------------------------------------------------------------
class TestSubmissionsEndpoints:
    def test_presign_submission_route(self, client, db_session, test_course, test_users):
        assignment = Assignment(
            course_id=test_course.id,
            title="Lab 1",
            topics_list=["Networking"],
            rubric=[{"criterion": "Socket Programming", "max_points": 100}],
            max_marks=100,
        )
        db_session.add(assignment)
        db_session.commit()

        headers = _auth_headers(test_users["student"])
        res = client.post(
            f"/assignments/{assignment.id}/submit/presign",
            json={"filename": "solution.py"},
            headers=headers,
        )
        assert res.status_code == 200
        data = res.json()
        assert "upload_url" in data
        assert "file_key" in data

    def test_submit_assignment_and_override_grade(self, client, db_session, test_course, test_users):
        assignment = Assignment(
            course_id=test_course.id,
            title="Lab 2",
            topics_list=["Trees"],
            rubric=[{"criterion": "BST", "max_points": 100}],
            max_marks=100,
        )
        db_session.add(assignment)
        db_session.commit()

        student = test_users["student"]
        faculty = test_users["faculty"]

        # Submit assignment
        student_headers = _auth_headers(student)
        with patch("app.services.queue_service.queue_service.enqueue_submission_evaluation", return_value="job_abc"):
            submit_res = client.post(
                f"/assignments/{assignment.id}/submit",
                data={"file_key": f"submissions/{assignment.id}/{student.id}/bst.py", "private_comment": "Done"},
                headers=student_headers,
            )
            assert submit_res.status_code == 200
            sub_data = submit_res.json()
            assert sub_data["status"] == "pending_eval"
            submission_id = sub_data["submission_id"]

        # Teacher overrides grade via PATCH /submissions/{id}/grade
        teacher_headers = _auth_headers(faculty)
        grade_res = client.patch(
            f"/submissions/{submission_id}/grade",
            json={"final_score": 95.0, "teacher_comment": "Excellent work!"},
            headers=teacher_headers,
        )
        assert grade_res.status_code == 200
        grade_data = grade_res.json()
        assert float(grade_data["final_score"]) == 95.0
        assert grade_data["status"] == "graded"
        assert grade_data["teacher_comment"] == "Excellent work!"


# ---------------------------------------------------------------------------
# 6. Analytics & Progress Report Endpoints
# ---------------------------------------------------------------------------
class TestAnalyticsAndReportsEndpoints:
    def test_class_analytics_endpoint(self, client, test_course, test_users):
        faculty_headers = _auth_headers(test_users["faculty"])
        res = client.get(f"/courses/{test_course.id}/analytics", headers=faculty_headers)
        assert res.status_code == 200
        data = res.json()
        assert "weak_topics" in data
        assert "at_risk_students" in data
        assert "grade_distribution" in data

    def test_assignment_analytics_endpoint(self, client, db_session, test_course, test_users):
        assignment = Assignment(
            course_id=test_course.id,
            title="Exam 1",
            topics_list=["Math"],
            rubric=[],
            max_marks=100,
        )
        db_session.add(assignment)
        db_session.commit()

        faculty_headers = _auth_headers(test_users["faculty"])
        res = client.get(
            f"/courses/{test_course.id}/analytics/assignments/{assignment.id}",
            headers=faculty_headers,
        )
        assert res.status_code == 200
        data = res.json()
        assert "weak_topics" in data

    def test_progress_report_endpoints(self, client, test_course, test_users):
        student_headers = _auth_headers(test_users["student"])

        # POST /progress-report to generate
        post_res = client.post(f"/progress-report?course_id={test_course.id}", headers=student_headers)
        assert post_res.status_code == 200
        report_data = post_res.json()
        assert "narrative" in report_data
        assert "mastery_snapshot" in report_data

        # GET /progress-report/{course_id} to retrieve
        get_res = client.get(f"/progress-report/{test_course.id}", headers=student_headers)
        assert get_res.status_code == 200
        assert get_res.json()["student_id"] == str(test_users["student"].id)


# ---------------------------------------------------------------------------
# 7. AI Tutor SSE Streaming (/chat)
# ---------------------------------------------------------------------------
class TestAiTutorStreaming:
    def test_stream_chat_generator(self):
        fake_response = MagicMock()
        fake_response.iter_lines.return_value = [
            'data: {"choices": [{"delta": {"content": "Binary "}}]}',
            'data: {"choices": [{"delta": {"content": "Search "}}]}',
            'data: {"choices": [{"delta": {"content": "Tree"}}]}',
            'data: [DONE]',
        ]
        fake_context = MagicMock()
        fake_context.__enter__.return_value = fake_response
        fake_context.__exit__.return_value = False
        with patch("requests.post", return_value=fake_context):
            items = list(stream_chat("dummy_course", "What is BST?"))
            tokens = [i["content"] for i in items if i["type"] == "token"]
            assert "".join(tokens) == "Binary Search Tree"
            sources_item = [i for i in items if i["type"] == "sources"][0]
            assert "sources" in sources_item

    def test_chat_endpoint_sse_streaming(self, client, test_course, test_users):
        headers = _auth_headers(test_users["student"])
        headers["Accept"] = "text/event-stream"

        mock_stream = [
            {"type": "token", "content": "Hello "},
            {"type": "token", "content": "student!"},
            {"type": "sources", "sources": ["course_overview.pdf"]},
        ]

        with patch("app.api.chat.rag_stream_chat", return_value=mock_stream):
            res = client.post(
                "/chat",
                json={"course_id": str(test_course.id), "message": "Explain quicksort", "note_ids": []},
                headers=headers,
            )
            assert res.status_code == 200
            assert "text/event-stream" in res.headers.get("content-type", "")

            # Parse SSE events from body
            lines = res.text.strip().split("\n\n")
            event_types = []
            for event in lines:
                for line in event.split("\n"):
                    if line.startswith("event:"):
                        event_types.append(line.split(":", 1)[1].strip())

            assert "token" in event_types
            assert "metadata" in event_types
            assert "done" in event_types
            assert "Hello " in res.text
            assert "student!" in res.text


# ---------------------------------------------------------------------------
# 8. Rate Limiting Setup & Configuration
# ---------------------------------------------------------------------------
class TestRateLimiting:
    def test_limiter_configured(self):
        assert limiter is not None
        assert fastapi_app.state.limiter is limiter


# ---------------------------------------------------------------------------
# 9. Architectural Specification: 28+ Route Inventory Verification
# ---------------------------------------------------------------------------
class TestRouteInventory:
    def test_minimum_28_routes_and_key_endpoints_registered(self):
        routes = {r.path for r in fastapi_app.routes if hasattr(r, "path")}
        assert len(routes) >= 28

        # Critical Phase 6 required endpoints
        required_endpoints = [
            "/auth/google/login",
            "/auth/google/callback",
            "/auth/refresh",
            "/auth/logout",
            "/courses/{course_id}/notes/presign",
            "/notes/{note_id}/download",
            "/courses/{course_id}/assignments",
            "/assignments/{assignment_id}/submit/presign",
            "/assignments/{assignment_id}/submit",
            "/submissions/{submission_id}/grade",
            "/courses/{course_id}/analytics",
            "/courses/{course_id}/analytics/assignments/{assignment_id}",
            "/progress-report",
            "/progress-report/{course_id}",
            "/chat",
        ]
        for ep in required_endpoints:
            assert ep in routes, f"Required Phase 6 endpoint {ep} is missing from app routes!"
