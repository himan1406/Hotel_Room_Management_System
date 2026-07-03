"""add images column to properties

Revision ID: 003
Revises: 2f89e3957990
Create Date: 2026-07-03
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "003"
down_revision: Union[str, None] = "2f89e3957990"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "properties",
        sa.Column("images", JSONB(), server_default=sa.text("'[]'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("properties", "images")
