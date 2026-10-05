from pathlib import Path
import pytest
from sqlalchemy import create_engine
from alembic.config import Config
from alembic.script import ScriptDirectory

from app.core.config import settings


def test_supabase_sql_script_contains_all_phase2_elements():
    sql_path = Path(__file__).resolve().parent.parent / "app" / "db" / "supabase_phase2_migration.sql"
    assert sql_path.exists(), "supabase_phase2_migration.sql should exist"

    content = sql_path.read_text(encoding="utf-8")

    # Verify tables
    expected_tables = [
        "users",
        "courses",
        "enrollments",
        "notes",
        "assignments",
        "submissions",
        "submission_texts",
        "analytics_reports",
        "progress_reports",
        "assignment_attachments",
        "submission_comments",
        "announcements",
        "chat_history",
    ]
    for table in expected_tables:
        assert f"CREATE TABLE IF NOT EXISTS {table}" in content, f"Missing table {table}"
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;" in content, f"Missing RLS on {table}"

    # Verify key Phase 2 fields
    assert "topics_list JSONB" in content
    assert "rubric JSONB" in content
    assert "reference_note_id UUID REFERENCES notes(id)" in content
    assert "ai_eval_enabled BOOLEAN" in content
    assert "mastery_level VARCHAR(50)" in content
    assert "topic_scores JSONB" in content
    assert "feedback_text TEXT" in content
    assert "integrity_score DECIMAL(4, 2)" in content
    assert "plagiarism_flag BOOLEAN" in content
    assert "faculty_note TEXT" in content
    assert "raw_text TEXT NOT NULL" in content

    # Verify RLS policies and functions
    assert "is_course_faculty" in content
    assert "is_course_enrolled" in content
    assert "submissions_select_policy" in content
    assert "courses_select_policy" in content
    assert "notes_select_policy" in content


def test_alembic_script_discovery():
    alembic_ini_path = Path(__file__).resolve().parent.parent / "alembic.ini"
    assert alembic_ini_path.exists()

    config = Config(str(alembic_ini_path))
    script = ScriptDirectory.from_config(config)

    revisions = list(script.walk_revisions())
    rev_ids = [rev.revision for rev in revisions]

    assert "0001_phase2_uuid_schema" in rev_ids
    assert "0002_phase2_supabase_rls" in rev_ids
