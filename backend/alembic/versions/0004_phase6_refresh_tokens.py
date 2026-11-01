"""Add revocable refresh token records for Phase 6."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004_phase6_refresh_tokens"
down_revision: Union[str, None] = "0003_phase4_bloom_depth"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("refresh_tokens"):
        op.create_table(
            "refresh_tokens",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("user_id", sa.Uuid(), nullable=False),
            sa.Column("jti", sa.String(length=64), nullable=False),
            sa.Column("token_hash", sa.String(length=64), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("jti"),
        )

    # Base.metadata.create_all() may create this table before Alembic is run.
    # Ensure its lookup indexes exist without failing on that already-created schema.
    inspector = sa.inspect(op.get_bind())
    existing_indexes = {index["name"] for index in inspector.get_indexes("refresh_tokens")}
    for name, columns in (
        ("ix_refresh_tokens_user_id", ["user_id"]),
        ("ix_refresh_tokens_jti", ["jti"]),
    ):
        if name not in existing_indexes:
            op.create_index(name, "refresh_tokens", columns, unique=False)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("refresh_tokens"):
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes("refresh_tokens")}
    if "ix_refresh_tokens_jti" in existing_indexes:
        op.drop_index("ix_refresh_tokens_jti", table_name="refresh_tokens")
    if "ix_refresh_tokens_user_id" in existing_indexes:
        op.drop_index("ix_refresh_tokens_user_id", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
