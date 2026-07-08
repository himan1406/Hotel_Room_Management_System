"""change property_documents.file_url from String(500) to Text

Revision ID: 004
Revises: 003
Create Date: 2026-07-07
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("property_documents", "file_url", type_=sa.Text(), existing_type=sa.String(500))


def downgrade() -> None:
    op.alter_column("property_documents", "file_url", type_=sa.String(500), existing_type=sa.Text())
