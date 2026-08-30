"""Chaque salle fermée du bon côté du plan.

Olivier le 29/08/2026 : « Les bureaux 1 et 2 ont été inversés. Par exemple, le
1er septembre, RUBE, FALE, GEBI et BEM doivent être dans le bureau 2. »

Le plan livré nomme la salle du MILIEU « Bureau 2 » et celle de DROITE « Bureau
Réservé RH / Admin / Finance / Legal / IT / EHS ». Les positions posaient
l'inverse : les collègues réservés dans le bureau ouvert apparaissaient dans la
salle réservée aux services support.
"""

from app.floorplan import DESK_POSITIONS

BUREAU_1 = [n for n in DESK_POSITIONS if n.startswith("B1-")]
BUREAU_2 = [n for n in DESK_POSITIONS if n.startswith("B2-")]


def test_les_deux_salles_ont_leurs_places():
    assert len(BUREAU_1) == 6
    assert len(BUREAU_2) == 6


def test_le_bureau_1_est_la_salle_du_milieu():
    """Zone « Bureau 1 » = la salle que le plan appelle Bureau 2, au milieu."""
    for nom in BUREAU_1:
        x = DESK_POSITIONS[nom][0]
        assert 50 < x < 65, f"{nom} n'est pas dans la salle du milieu (x={x})"


def test_le_bureau_2_est_la_salle_de_droite():
    """Zone « Bureau 2 » = la salle réservée RH / Admin, à droite."""
    for nom in BUREAU_2:
        x = DESK_POSITIONS[nom][0]
        assert 70 < x < 90, f"{nom} n'est pas dans la salle de droite (x={x})"


def test_les_deux_salles_ne_se_chevauchent_pas():
    droite_du_milieu = max(DESK_POSITIONS[n][0] for n in BUREAU_1)
    gauche_de_droite = min(DESK_POSITIONS[n][0] for n in BUREAU_2)
    assert droite_du_milieu < gauche_de_droite


def test_les_bulles_calmes_separent_les_deux_salles():
    """Sur le plan, Maldives et Seychelles sont entre les deux bureaux fermés."""
    for nom in ("BC-1", "BC-2"):
        x = DESK_POSITIONS[nom][0]
        assert max(DESK_POSITIONS[n][0] for n in BUREAU_1) < x
        assert x < min(DESK_POSITIONS[n][0] for n in BUREAU_2)
