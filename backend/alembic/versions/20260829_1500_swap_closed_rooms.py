"""swap_closed_rooms

Remet chaque salle fermée à sa place sur le plan.

Olivier signale le 29/08/2026 que « les bureaux 1 et 2 ont été inversés » :
au 1er septembre, quatre collègues réservés dans la salle affichée « Bureau 2 »
apparaissaient dans la salle de droite, celle que le plan réserve aux services
support (RH / Admin / Finance / Legal / IT / EHS).

La cause n'est pas le nom mais la position. `app/floorplan.py` posait les
pastilles `B1-*` dans la salle de droite et les `B2-*` dans celle du milieu,
alors que le plan livré nomme la salle du MILIEU « Bureau 2 ». Les réservations
elles-mêmes sont justes : c'est la pastille qui tombait dans la mauvaise pièce.
On échange donc les coordonnées de `B1-n` et `B2-n`, ce qui laisse intactes les
réservations, les libellés et les caractéristiques de chaque poste.

Garde-fou : l'échange n'a lieu que si la salle `Bureau 1` est encore posée à la
DROITE de la salle `Bureau 2`, c'est-à-dire dans l'état fautif. Si un
administrateur a déjà tout repositionné à la main depuis l'éditeur, la
migration ne touche à rien.

Revision ID: e7c1a94f2db8
Revises: d3f6b81c04e7
Create Date: 2026-08-29 15:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e7c1a94f2db8"
down_revision: Union[str, None] = "d3f6b81c04e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _swap(bind) -> None:
    """Échange les coordonnées de B1-n et B2-n, si l'inversion est encore là."""
    lignes = bind.execute(
        sa.text(
            "SELECT name, zone, pos_x, pos_y FROM desks "
            "WHERE zone IN ('Bureau 1', 'Bureau 2') AND pos_x IS NOT NULL"
        )
    ).fetchall()

    par_zone: dict[str, list[float]] = {"Bureau 1": [], "Bureau 2": []}
    for _, zone, pos_x, _y in lignes:
        par_zone[zone].append(float(pos_x))
    if not par_zone["Bureau 1"] or not par_zone["Bureau 2"]:
        return  # une des deux salles n'est pas positionnée : rien à échanger

    milieu_b1 = sum(par_zone["Bureau 1"]) / len(par_zone["Bureau 1"])
    milieu_b2 = sum(par_zone["Bureau 2"]) / len(par_zone["Bureau 2"])
    if milieu_b1 <= milieu_b2:
        return  # déjà dans le bon sens : Bureau 1 au milieu, Bureau 2 à droite

    positions = {name: (pos_x, pos_y) for name, _zone, pos_x, pos_y in lignes}
    for name, (pos_x, pos_y) in positions.items():
        prefixe, _, numero = name.partition("-")
        jumeau = ("B2-" if prefixe == "B1" else "B1-") + numero
        if jumeau not in positions:
            continue  # pas de poste correspondant en face : on le laisse où il est
        cible_x, cible_y = positions[jumeau]
        bind.execute(
            sa.text("UPDATE desks SET pos_x = :x, pos_y = :y WHERE name = :n"),
            {"x": cible_x, "y": cible_y, "n": name},
        )


def upgrade() -> None:
    _swap(op.get_bind())


def downgrade() -> None:
    # L'échange est sa propre réciproque, mais le garde-fou de `_swap` refuserait
    # de le rejouer (les salles sont maintenant dans le bon sens). On rétablit
    # donc l'état fautif explicitement, pour que le retour arrière soit fidèle.
    bind = op.get_bind()
    lignes = bind.execute(
        sa.text(
            "SELECT name, pos_x, pos_y FROM desks "
            "WHERE zone IN ('Bureau 1', 'Bureau 2') AND pos_x IS NOT NULL"
        )
    ).fetchall()
    positions = {name: (pos_x, pos_y) for name, pos_x, pos_y in lignes}
    for name, (pos_x, pos_y) in positions.items():
        prefixe, _, numero = name.partition("-")
        jumeau = ("B2-" if prefixe == "B1" else "B1-") + numero
        if jumeau not in positions:
            continue
        cible_x, cible_y = positions[jumeau]
        bind.execute(
            sa.text("UPDATE desks SET pos_x = :x, pos_y = :y WHERE name = :n"),
            {"x": cible_x, "y": cible_y, "n": name},
        )
