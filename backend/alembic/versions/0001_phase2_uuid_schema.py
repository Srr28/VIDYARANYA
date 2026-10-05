"""Phase 2: Migration to UUID schema and new assessment models

Revision ID: 0001_phase2_uuid_schema
Revises: 
Create Date: 2026-10-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0001_phase2_uuid_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Enable pgcrypto extension on Postgres if supported
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    if is_postgres:
        op.execute(sa.text('CREATE EXTENSION IF NOT EXISTS "pgcrypto";'))

    # Users table
    op.create_table(
        "users",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("full_name", sa.String(255), nullable=False),
        sa.Column("avatar_url", sa.String(500), nullable=True),
        sa.Column("role", sa.String(50), nullable=False, server_default="student"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "role IN ('student', 'faculty', 'admin', 'teacher')",
            name="ck_users_role",
        ),
    )
    op.create_index("ix_users_email", "users", ["email"])
    op.create_index("ix_users_id", "users", ["id"])

    # Courses table
    op.create_table(
        "courses",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("faculty_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("subject", sa.String(100), nullable=True),
        sa.Column("section", sa.String(100), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("join_code", sa.String(6), nullable=False, unique=True),
        sa.Column("banner_color", sa.String(7), nullable=False, server_default="#1a73e8"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_courses_faculty_id", "courses", ["faculty_id"])
    op.create_index("ix_courses_join_code", "courses", ["join_code"])

    # Enrollments table
    op.create_table(
        "enrollments",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("student_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("student_id", "course_id", name="uq_student_course"),
        sa.CheckConstraint("status IN ('active', 'dropped')", name="ck_enrollment_status"),
    )
    op.create_index("ix_enrollments_student_id", "enrollments", ["student_id"])
    op.create_index("ix_enrollments_course_id", "enrollments", ["course_id"])

    # Notes table
    op.create_table(
        "notes",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("file_key", sa.String(500), nullable=False),
        sa.Column("file_type", sa.String(10), nullable=True),
        sa.Column("chroma_indexed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_notes_course_id", "notes", ["course_id"])

    # Assignments table
    json_type = postgresql.JSONB if is_postgres else sa.JSON
    op.create_table(
        "assignments",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("topics_list", json_type, nullable=False, server_default=sa.text("'[]'::jsonb" if is_postgres else "'[]'")),
        sa.Column("rubric", json_type, nullable=False, server_default=sa.text("'[]'::jsonb" if is_postgres else "'[]'")),
        sa.Column("reference_note_id", sa.Uuid(), sa.ForeignKey("notes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("ai_eval_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("max_marks", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("due_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_assignments_course_id", "assignments", ["course_id"])
    op.create_index("ix_assignments_ref_note_id", "assignments", ["reference_note_id"])

    # Submissions table
    op.create_table(
        "submissions",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("assignment_id", sa.Uuid(), sa.ForeignKey("assignments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("student_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("file_key", sa.String(500), nullable=False),
        sa.Column("status", sa.String(50), nullable=False, server_default="pending_eval"),
        sa.Column("ai_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("final_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("mastery_level", sa.String(50), nullable=True),
        sa.Column("topic_scores", json_type, nullable=True),
        sa.Column("feedback_text", sa.Text(), nullable=True),
        sa.Column("integrity_score", sa.Numeric(4, 2), nullable=True),
        sa.Column("plagiarism_flag", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("faculty_note", sa.Text(), nullable=True),
        sa.Column("text_content", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "status IN ('pending_eval', 'evaluating', 'graded', 'overdue', 'flagged', 'pending')",
            name="ck_submission_status",
        ),
    )
    op.create_index("ix_submissions_assignment_id", "submissions", ["assignment_id"])
    op.create_index("ix_submissions_student_id", "submissions", ["student_id"])

    # Submission Texts table
    op.create_table(
        "submission_texts",
        sa.Column(
            "submission_id",
            sa.Uuid(),
            sa.ForeignKey("submissions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("raw_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # Analytics Reports table
    op.create_table(
        "analytics_reports",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("assignment_id", sa.Uuid(), sa.ForeignKey("assignments.id", ondelete="CASCADE"), nullable=True),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("report_type", sa.String(50), nullable=False),
        sa.Column("weak_topics", json_type, nullable=True),
        sa.Column("at_risk_students", json_type, nullable=True),
        sa.Column("narrative", sa.Text(), nullable=True),
        sa.Column("grade_distribution", json_type, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "report_type IN ('class_summary', 'at_risk', 'topic_gap')",
            name="ck_analytics_report_type",
        ),
    )
    op.create_index("ix_analytics_reports_course_id", "analytics_reports", ["course_id"])
    op.create_index("ix_analytics_reports_assignment_id", "analytics_reports", ["assignment_id"])

    # Progress Reports table
    op.create_table(
        "progress_reports",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("student_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("narrative", sa.Text(), nullable=True),
        sa.Column("mastery_snapshot", json_type, nullable=True),
        sa.Column("rank", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_progress_reports_student_id", "progress_reports", ["student_id"])
    op.create_index("ix_progress_reports_course_id", "progress_reports", ["course_id"])

    # Assignment Attachments table
    op.create_table(
        "assignment_attachments",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("assignment_id", sa.Uuid(), sa.ForeignKey("assignments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("file_name", sa.String(255), nullable=False),
        sa.Column("file_path", sa.Text(), nullable=False),
        sa.Column("mime_type", sa.String(120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_attachments_assignment_id", "assignment_attachments", ["assignment_id"])

    # Submission Comments table
    op.create_table(
        "submission_comments",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("submission_id", sa.Uuid(), sa.ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_comments_submission_id", "submission_comments", ["submission_id"])
    op.create_index("ix_comments_author_id", "submission_comments", ["author_id"])

    # Announcements table
    op.create_table(
        "announcements",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("author_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_announcements_course_id", "announcements", ["course_id"])

    # Chat History table
    op.create_table(
        "chat_history",
        sa.Column(
            "id",
            sa.Uuid(),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()") if is_postgres else None,
        ),
        sa.Column("course_id", sa.Uuid(), sa.ForeignKey("courses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("user_message", sa.Text(), nullable=False),
        sa.Column("ai_response", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_chat_course_id", "chat_history", ["course_id"])
    op.create_index("ix_chat_user_id", "chat_history", ["user_id"])


def downgrade() -> None:
    op.drop_table("chat_history")
    op.drop_table("announcements")
    op.drop_table("submission_comments")
    op.drop_table("assignment_attachments")
    op.drop_table("progress_reports")
    op.drop_table("analytics_reports")
    op.drop_table("submission_texts")
    op.drop_table("submissions")
    op.drop_table("assignments")
    op.drop_table("notes")
    op.drop_table("enrollments")
    op.drop_table("courses")
    op.drop_table("users")
