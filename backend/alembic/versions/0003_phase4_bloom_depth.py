"""Persist Bloom's taxonomy depth results on submissions."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003_phase4_bloom_depth"
down_revision: Union[str, None] = "0002_phase2_supabase_rls"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("submissions")}
    if "depth_score" not in existing:
        op.add_column("submissions", sa.Column("depth_score", sa.Numeric(3, 2), nullable=True))
    if "depth_label" not in existing:
        op.add_column("submissions", sa.Column("depth_label", sa.String(length=32), nullable=True))


def downgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("submissions")}
    if "depth_label" in existing:
        op.drop_column("submissions", "depth_label")
    if "depth_score" in existing:
        op.drop_column("submissions", "depth_score")
