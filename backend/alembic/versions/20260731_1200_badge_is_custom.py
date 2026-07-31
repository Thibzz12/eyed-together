"""badge_is_custom

Revision ID: b3f7a1d9c2e5
Revises: 9a1c5e2f7d44
Create Date: 2026-07-31 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# Identifiants de révision Alembic.
revision: str = 'b3f7a1d9c2e5'
down_revision: Union[str, None] = '9a1c5e2f7d44'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('badges', schema=None) as batch_op:
        batch_op.add_column(sa.Column('is_custom', sa.Boolean(), nullable=False, server_default='0'))


def downgrade() -> None:
    with op.batch_alter_table('badges', schema=None) as batch_op:
        batch_op.drop_column('is_custom')
