"""attendance_and_visitors

Présence physique dans les locaux : arrivées, départs et visiteurs externes.

Nécessaire à la liste d'évacuation incendie, que les réservations seules ne
permettaient pas d'établir : quelqu'un qui réserve sans venir y figurait à
tort, quelqu'un qui vient sans réserver n'y figurait pas du tout, et les
visiteurs externes n'existaient nulle part.

Revision ID: e5f2c9b4a117
Revises: d1a4b7c2e883
Create Date: 2026-08-25 10:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f2c9b4a117"
down_revision: Union[str, None] = "d1a4b7c2e883"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "attendance",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("arrived_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source", sa.String(length=20), nullable=False, server_default="popup"),
        sa.Column("auto_closed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "day", name="uq_attendance_user_day"),
    )
    op.create_index("ix_attendance_user_id", "attendance", ["user_id"])
    op.create_index("ix_attendance_day", "attendance", ["day"])

    op.create_table(
        "visitors",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("host_user_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("full_name", sa.String(length=120), nullable=False),
        sa.Column("company", sa.String(length=120), nullable=True),
        sa.Column("arrived_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("auto_closed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["host_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_visitors_host_user_id", "visitors", ["host_user_id"])
    op.create_index("ix_visitors_day", "visitors", ["day"])


def downgrade() -> None:
    op.drop_index("ix_visitors_day", table_name="visitors")
    op.drop_index("ix_visitors_host_user_id", table_name="visitors")
    op.drop_table("visitors")
    op.drop_index("ix_attendance_day", table_name="attendance")
    op.drop_index("ix_attendance_user_id", table_name="attendance")
    op.drop_table("attendance")
