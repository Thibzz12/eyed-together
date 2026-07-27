"""status_length

Revision ID: 9a1c5e2f7d44
Revises: 7c2f9a4e8b31
Create Date: 2026-07-27 15:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# Identifiants de révision Alembic.
revision: str = '9a1c5e2f7d44'
down_revision: Union[str, None] = '7c2f9a4e8b31'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Les statuts personnalisés (admin) peuvent avoir une clé un peu plus longue que les
    # 4 statuts de base ("coworking", "teletravail", ...) : VARCHAR(20) -> VARCHAR(40).
    with op.batch_alter_table('daily_status', schema=None) as batch_op:
        batch_op.alter_column('status_am', type_=sa.String(length=40))
        batch_op.alter_column('status_pm', type_=sa.String(length=40))


def downgrade() -> None:
    with op.batch_alter_table('daily_status', schema=None) as batch_op:
        batch_op.alter_column('status_am', type_=sa.String(length=20))
        batch_op.alter_column('status_pm', type_=sa.String(length=20))
