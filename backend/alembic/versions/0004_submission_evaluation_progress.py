"""Persist live assignment evaluation stages."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004_submission_evaluation_progress"
down_revision: Union[str, None] = "0003_phase4_bloom_depth"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("submissions")}
    if "evaluation_progress" not in existing:
        op.add_column("submissions", sa.Column("evaluation_progress", sa.Integer(), nullable=True))
    if "evaluation_stage" not in existing:
        op.add_column("submissions", sa.Column("evaluation_stage", sa.String(length=64), nullable=True))


def downgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("submissions")}
    if "evaluation_stage" in existing:
        op.drop_column("submissions", "evaluation_stage")
    if "evaluation_progress" in existing:
        op.drop_column("submissions", "evaluation_progress")
