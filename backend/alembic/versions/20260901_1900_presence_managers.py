"""presence_managers

Second niveau de droits, plus étroit que le rôle admin : les « responsables
présence » peuvent voir qui est dans les locaux et exporter la liste
d'évacuation, sans accéder au reste de l'administration.

Le besoin vient de la sécurité incendie : si les administrateurs sont absents
le jour d'une évacuation, quelqu'un d'autre doit pouvoir sortir la liste au
point de rassemblement (demande d'Olivier du 01/09/2026).

Revision ID: b6f3d9c15a72
Revises: e7c1a94f2db8
Create Date: 2026-09-01 19:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b6f3d9c15a72"
down_revision: Union[str, None] = "e7c1a94f2db8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("can_manage_presence", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("users", "can_manage_presence")
