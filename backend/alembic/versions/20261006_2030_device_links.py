"""device_links

Liens secrets pour les appareils partagés (écran du plan du jour, tablette de
pointage) : pas de compte, pas de session, un lien par appareil, révocable
depuis l'administration (demande d'Olivier du 02/10/2026).

Revision ID: c4a7e2d91b05
Revises: b6f3d9c15a72
Create Date: 2026-10-06 20:30:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c4a7e2d91b05"
down_revision: Union[str, None] = "b6f3d9c15a72"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "device_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_device_links_token", "device_links", ["token"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_device_links_token", table_name="device_links")
    op.drop_table("device_links")
