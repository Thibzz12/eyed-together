"""timeslot_reservations

Revision ID: 3d8b6e0f4a1c
Revises: 9a3f5c1b7e2d
Create Date: 2026-07-26 14:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# Identifiants de révision Alembic.
revision: str = '3d8b6e0f4a1c'
down_revision: Union[str, None] = '9a3f5c1b7e2d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('reservations', schema=None) as batch_op:
        batch_op.add_column(sa.Column('start_time', sa.Time(), nullable=True))
        batch_op.add_column(sa.Column('end_time', sa.Time(), nullable=True))

    # L'index unique doit exclure les créneaux "timeslot" (bulles calmes) : plusieurs
    # réservations à des horaires différents partagent le même (desk_id, date, slot).
    op.drop_index('uq_active_reservation', table_name='reservations')
    op.create_index(
        'uq_active_reservation', 'reservations',
        ['desk_id', 'reservation_date', 'slot'],
        unique=True,
        sqlite_where=sa.text("status = 'booked' AND slot != 'timeslot'"),
        postgresql_where=sa.text("status = 'booked' AND slot != 'timeslot'"),
    )


def downgrade() -> None:
    op.drop_index('uq_active_reservation', table_name='reservations')
    op.create_index(
        'uq_active_reservation', 'reservations',
        ['desk_id', 'reservation_date', 'slot'],
        unique=True,
        sqlite_where=sa.text("status = 'booked'"),
        postgresql_where=sa.text("status = 'booked'"),
    )
    with op.batch_alter_table('reservations', schema=None) as batch_op:
        batch_op.drop_column('end_time')
        batch_op.drop_column('start_time')
