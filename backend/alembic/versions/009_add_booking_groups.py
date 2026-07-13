"""add booking_groups table and group_id + room_adults/room_children to bookings

Revision ID: 009
Revises: 008
Create Date: 2026-07-13
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = '009'
down_revision: Union[str, None] = '008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'booking_groups',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('customer_id', UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('property_id', UUID(as_uuid=True), sa.ForeignKey('properties.id'), nullable=False),
        sa.Column('check_in', sa.Date(), nullable=False),
        sa.Column('check_out', sa.Date(), nullable=False),
        sa.Column('num_adults', sa.Integer(), nullable=False),
        sa.Column('num_children', sa.Integer(), server_default='0'),
        sa.Column('total_price', sa.Float(), nullable=True),
        sa.Column('idempotency_key', sa.String(255), unique=True, nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now()),
        sa.CheckConstraint('check_out > check_in'),
    )
    op.create_index('ix_booking_groups_customer', 'booking_groups', ['customer_id'])

    op.add_column('bookings', sa.Column('group_id', UUID(as_uuid=True), sa.ForeignKey('booking_groups.id'), nullable=True))
    op.add_column('bookings', sa.Column('room_adults', sa.Integer(), nullable=True))
    op.add_column('bookings', sa.Column('room_children', sa.Integer(), server_default='0'))
    op.create_index('ix_bookings_group_id', 'bookings', ['group_id'])

    op.alter_column('bookings', 'idempotency_key', nullable=True, server_default=None)


def downgrade() -> None:
    op.drop_index('ix_bookings_group_id', table_name='bookings')
    op.drop_column('bookings', 'group_id')
    op.drop_column('bookings', 'room_adults')
    op.drop_column('bookings', 'room_children')
    op.drop_table('booking_groups')
