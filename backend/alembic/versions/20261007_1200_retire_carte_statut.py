"""retire_carte_statut

La carte d'accueil « Mon statut du jour » (clé "presence") appartenait à la
déclaration de statut retirée de l'interface le 25/09/2026. Elle était encore
en base et filtrée à deux endroits du code : on supprime la ligne, et le code
n'a plus rien à filtrer. La table daily_status reste, par prudence.

Revision ID: d8e1f3a4b5c6
Revises: c4a7e2d91b05
Create Date: 2026-10-07 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op

revision: str = "d8e1f3a4b5c6"
down_revision: Union[str, None] = "c4a7e2d91b05"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DELETE FROM dashboard_cards WHERE key = 'presence'")


def downgrade() -> None:
    # La carte revient désactivée : la remettre à l'écran est un choix d'admin.
    op.execute(
        "INSERT INTO dashboard_cards (key, title, position, highlighted, enabled) "
        "VALUES ('presence', 'Mon statut du jour', 0, 0, 0)"
    )
