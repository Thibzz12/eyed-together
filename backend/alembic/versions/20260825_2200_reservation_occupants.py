"""reservation_occupants

Qui occupe réellement chaque poste d'une réservation de groupe.

Bloquer une table ou une salle entière retire d'un coup quatre à six places du
planning. Sans savoir qui s'y installera, impossible de dire qui est attendu
dans les locaux, ce qui était précisément la demande d'Olivier Vanbrabant
(mail du 25 août 2026).

Revision ID: f7c1d3e8a520
Revises: e5f2c9b4a117
Create Date: 2026-08-25 22:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f7c1d3e8a520"
down_revision: Union[str, None] = "e5f2c9b4a117"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # batch_alter_table : SQLite ne sait pas ajouter une contrainte de clé étrangère
    # à une table existante, Alembic recrée donc la table pour lui. Sans effet sur
    # PostgreSQL, où l'ALTER TABLE natif est utilisé.
    with op.batch_alter_table("reservations") as batch:
        batch.add_column(sa.Column("occupant_user_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("occupant_name", sa.String(length=120), nullable=True))
        batch.add_column(sa.Column("occupant_company", sa.String(length=120), nullable=True))
        batch.add_column(sa.Column(
            "is_group_booking", sa.Boolean(), nullable=False, server_default=sa.false(),
        ))
        batch.create_foreign_key(
            "fk_reservations_occupant_user_id",
            "users",
            ["occupant_user_id"],
            ["id"],
            ondelete="SET NULL",
        )
    op.create_index("ix_reservations_occupant_user_id", "reservations", ["occupant_user_id"])


def downgrade() -> None:
    op.drop_index("ix_reservations_occupant_user_id", table_name="reservations")
    with op.batch_alter_table("reservations") as batch:
        batch.drop_constraint("fk_reservations_occupant_user_id", type_="foreignkey")
        batch.drop_column("is_group_booking")
        batch.drop_column("occupant_company")
        batch.drop_column("occupant_name")
        batch.drop_column("occupant_user_id")
