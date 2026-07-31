"""badge_points

Revision ID: c8d3e6a1f709
Revises: b3f7a1d9c2e5
Create Date: 2026-07-31 14:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# Identifiants de révision Alembic.
revision: str = 'c8d3e6a1f709'
down_revision: Union[str, None] = 'b3f7a1d9c2e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('badges', schema=None) as batch_op:
        batch_op.add_column(sa.Column('points', sa.Integer(), nullable=False, server_default='15'))


def downgrade() -> None:
    with op.batch_alter_table('badges', schema=None) as batch_op:
        batch_op.drop_column('points')
