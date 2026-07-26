"""daily_status_am_pm

Revision ID: 7c2f9a4e8b31
Revises: 3d8b6e0f4a1c
Create Date: 2026-07-27 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# Identifiants de révision Alembic.
revision: str = '7c2f9a4e8b31'
down_revision: Union[str, None] = '3d8b6e0f4a1c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('daily_status', schema=None) as batch_op:
        batch_op.add_column(sa.Column('status_am', sa.String(length=20), nullable=True))
        batch_op.add_column(sa.Column('status_pm', sa.String(length=20), nullable=True))

    # Rattrape les déclarations existantes : un statut unique pour la journée devient
    # le même statut matin ET après-midi (équivalent visuel : cercle plein).
    op.execute("UPDATE daily_status SET status_am = status, status_pm = status")

    with op.batch_alter_table('daily_status', schema=None) as batch_op:
        batch_op.drop_column('status')


def downgrade() -> None:
    with op.batch_alter_table('daily_status', schema=None) as batch_op:
        batch_op.add_column(sa.Column('status', sa.String(length=20), nullable=False, server_default='coworking'))

    op.execute("UPDATE daily_status SET status = COALESCE(status_am, status_pm, 'coworking')")

    with op.batch_alter_table('daily_status', schema=None) as batch_op:
        batch_op.alter_column('status', server_default=None)
        batch_op.drop_column('status_am')
        batch_op.drop_column('status_pm')
