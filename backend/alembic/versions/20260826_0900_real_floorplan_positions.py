"""real_floorplan_positions

Repose les 34 postes sur le plan réel des locaux.

Les positions livrées jusqu'ici venaient d'une grille schématique (deux salles
côte à côte, trois tables au-dessus) qui n'avait aucun rapport avec le plan
qu'Olivier a fourni le 24/08/2026. Superposer la réservation sur le plan, ce
qu'il demande dans son mail du 25/08, n'a de sens que si les pastilles tombent
sur les vraies chaises.

Prudence volontaire : on ne réécrit une position que si elle vaut encore
exactement l'ancienne valeur schématique de ce poste. Un poste déjà déplacé à
la main depuis l'éditeur d'administration est laissé tel quel, sinon la mise en
production effacerait le travail de l'administrateur.

Revision ID: b6d0c9a15e42
Revises: a2b8e4d7f193
Create Date: 2026-08-26 09:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b6d0c9a15e42"
down_revision: Union[str, None] = "a2b8e4d7f193"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Les tables sont recopiées ici plutôt qu'importées depuis app.floorplan : une
# migration doit rester lisible et rejouable même si le code applicatif évolue.
NOUVELLES = {
    "T1-1": (8.0, 57.0),
    "T1-2": (13.5, 57.0),
    "T1-3": (8.0, 73.0),
    "T1-4": (13.5, 73.0),
    "T2-1": (17.5, 57.0),
    "T2-2": (23.0, 57.0),
    "T2-3": (17.5, 73.0),
    "T2-4": (23.0, 73.0),
    "T3-1": (29.5, 40.0),
    "T3-2": (35.0, 40.0),
    "T3-3": (29.5, 57.0),
    "T3-4": (35.0, 57.0),
    "T3-5": (29.5, 73.0),
    "T3-6": (35.0, 73.0),
    "T4-1": (38.5, 40.0),
    "T4-2": (44.0, 40.0),
    "T4-3": (38.5, 57.0),
    "T4-4": (44.0, 57.0),
    "T4-5": (38.5, 73.0),
    "T4-6": (44.0, 73.0),
    "B2-1": (56.5, 38.0),
    "B2-2": (56.5, 47.0),
    "B2-3": (56.5, 56.0),
    "B2-4": (60.3, 38.0),
    "B2-5": (60.3, 47.0),
    "B2-6": (60.3, 56.0),
    "BC-1": (65.5, 31.5),
    "BC-2": (72.0, 57.0),
    "B1-1": (78.0, 38.0),
    "B1-2": (78.0, 47.0),
    "B1-3": (78.0, 56.0),
    "B1-4": (81.8, 38.0),
    "B1-5": (81.8, 47.0),
    "B1-6": (81.8, 56.0),
}

ANCIENNES = {
    "B1-1": (14, 34), "B1-2": (26, 34), "B1-3": (38, 34),
    "B1-4": (14, 62), "B1-5": (26, 62), "B1-6": (38, 62),
    "B2-1": (62, 34), "B2-2": (74, 34), "B2-3": (86, 34),
    "B2-4": (62, 62), "B2-5": (74, 62), "B2-6": (86, 62),
    "T1-1": (10, 8), "T1-2": (18, 8), "T1-3": (10, 16), "T1-4": (18, 16),
    "T2-1": (36, 8), "T2-2": (44, 8), "T2-3": (36, 16), "T2-4": (44, 16),
    "T3-1": (52, 8), "T3-2": (60, 8), "T3-3": (68, 8),
    "T3-4": (52, 16), "T3-5": (60, 16), "T3-6": (68, 16),
    "T4-1": (78, 8), "T4-2": (86, 8), "T4-3": (94, 8),
    "T4-4": (78, 16), "T4-5": (86, 16), "T4-6": (94, 16),
    "BC-1": (46, 24), "BC-2": (54, 24),
}

_SQL = sa.text(
    "UPDATE desks SET pos_x = :nx, pos_y = :ny "
    "WHERE name = :nom AND pos_x = :ax AND pos_y = :ay"
)


def _deplacer(depuis: dict, vers: dict) -> None:
    bind = op.get_bind()
    for nom, (ax, ay) in depuis.items():
        nx, ny = vers[nom]
        bind.execute(_SQL, {"nom": nom, "ax": ax, "ay": ay, "nx": nx, "ny": ny})


def upgrade() -> None:
    _deplacer(ANCIENNES, NOUVELLES)


def downgrade() -> None:
    _deplacer(NOUVELLES, ANCIENNES)
