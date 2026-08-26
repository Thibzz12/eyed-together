"""Positions des postes sur le plan des locaux.

Superposer la réservation sur le plan (demande d'Olivier du 25/08/2026) suppose
que chaque poste porte des coordonnées, et que deux postes ne se retrouvent pas
empilés au même endroit : deux pastilles superposées, c'est une place qu'on ne
peut plus cliquer.
"""

import pytest

from app.db.seed import _DEMO_DESKS
from app.floorplan import DESK_POSITIONS, LEGACY_DESK_POSITIONS, position_for


def test_chaque_poste_du_seed_a_une_position():
    manquants = [nom for (nom, _z, _f, _feat) in _DEMO_DESKS if nom not in DESK_POSITIONS]
    assert manquants == [], f"postes sans position sur le plan : {manquants}"


def test_aucune_position_en_trop():
    """Une position orpheline signale un poste renommé ou supprimé du seed."""
    connus = {nom for (nom, _z, _f, _feat) in _DEMO_DESKS}
    assert set(DESK_POSITIONS) - connus == set()


def test_les_positions_restent_dans_le_cadre():
    for nom, (x, y) in DESK_POSITIONS.items():
        assert 0 < x < 100, f"{nom} sort du plan horizontalement"
        assert 0 < y < 100, f"{nom} sort du plan verticalement"


def test_deux_postes_ne_partagent_pas_le_meme_point():
    vus: dict[tuple[float, float], str] = {}
    for nom, point in DESK_POSITIONS.items():
        assert point not in vus, f"{nom} est posé sur {vus[point]}"
        vus[point] = nom


@pytest.mark.parametrize("nom", sorted(LEGACY_DESK_POSITIONS))
def test_les_positions_ont_bien_bouge_depuis_le_plan_schematique(nom):
    """Garde-fou : le plan réel n'a rien à voir avec l'ancienne grille de démo.

    Si une position redevenait identique à l'ancienne, c'est qu'une fusion a
    ramené le fichier d'avant le 26/08/2026.
    """
    assert DESK_POSITIONS[nom] != LEGACY_DESK_POSITIONS[nom]


def test_un_poste_inconnu_n_a_pas_de_position():
    assert position_for("XX-9") == (None, None)
