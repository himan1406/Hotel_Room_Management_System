"""add ai_highlight to properties

Revision ID: 467caaa5724a
Revises: 13c7a9fe831f
Create Date: 2026-07-08 08:11:54.341778
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '467caaa5724a'
down_revision: Union[str, None] = '13c7a9fe831f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('properties', sa.Column('ai_highlight', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('properties', 'ai_highlight')
