"""Small additive schema compatibility migration for Phase 4 submission fields."""

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine


def ensure_submission_depth_columns(engine: Engine) -> None:
    """Add Bloom depth columns to databases created before the Phase 4 update."""
    inspector = inspect(engine)
    if not inspector.has_table("submissions"):
        return
    existing = {column["name"] for column in inspector.get_columns("submissions")}

    if engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE submissions ADD COLUMN IF NOT EXISTS depth_score NUMERIC(3, 2)")
            )
            connection.execute(
                text("ALTER TABLE submissions ADD COLUMN IF NOT EXISTS depth_label VARCHAR(32)")
            )
        return

    missing_columns = []
    if "depth_score" not in existing:
        missing_columns.append("ALTER TABLE submissions ADD COLUMN depth_score NUMERIC(3, 2)")
    if "depth_label" not in existing:
        missing_columns.append("ALTER TABLE submissions ADD COLUMN depth_label VARCHAR(32)")
    if missing_columns:
        with engine.begin() as connection:
            for statement in missing_columns:
                connection.execute(text(statement))
