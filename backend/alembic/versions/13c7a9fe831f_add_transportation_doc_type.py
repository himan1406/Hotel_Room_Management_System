"""add transportation doc type

Revision ID: 13c7a9fe831f
Revises: 007
Create Date: 2026-07-08 07:48:19.376272
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '13c7a9fe831f'
down_revision: Union[str, None] = '007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE doc_type ADD VALUE 'transportation'")


def downgrade() -> None:
    # PostgreSQL does not support removing a value from an enum.
    # To downgrade, you would need to create a new type, migrate data,
    # drop the old type, and rename. This is not implemented.
    pass
