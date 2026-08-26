"""Nom d'une table d'open space et équipement d'un poste sont deux choses.

Le champ `desks.features` servait aux deux : « Table 1 » y tenait lieu de nom de
table. Impossible, donc, d'y écrire « Double écran » sans renommer la table.
Olivier demandant de voir clairement le type d'écran (mail du 25/08/2026), les
deux notions sont séparées : le nom vit dans les réglages, `features` ne décrit
plus que le matériel.
"""

import pytest

from app.db import models as m
from app.services import reservations as svc


@pytest.fixture
def open_space(db):
    """Une table de 2 places, sans équipement déclaré."""
    postes = [m.Desk(name=f"T9-{i}", zone="Open Space", floor="Rez", is_active=True) for i in (1, 2)]
    db.add_all(postes)
    db.commit()
    return postes


def test_une_table_porte_un_nom_par_defaut(db, open_space):
    groupes = {g["ref"]: g for g in svc.bookable_groups(db)}
    assert groupes["T9"]["label"] == "Table 9"


def test_l_admin_peut_renommer_une_table(db, open_space):
    svc.set_room_label(db, "T9", "Grande table")

    groupes = {g["ref"]: g for g in svc.bookable_groups(db)}
    assert groupes["T9"]["label"] == "Grande table"
    assert svc.get_room_labels(db)["T9"] == "Grande table"


def test_renommer_avec_du_vide_revient_au_nom_par_defaut(db, open_space):
    svc.set_room_label(db, "T9", "Grande table")
    svc.set_room_label(db, "T9", "   ")
    assert svc.get_room_labels(db)["T9"] == "Table 9"


def test_l_equipement_d_un_poste_ne_renomme_plus_la_table(db, open_space):
    """Le cœur de la correction : écrire l'équipement laisse le nom tranquille."""
    open_space[0].features = "Double écran"
    db.commit()

    groupes = {g["ref"]: g for g in svc.bookable_groups(db)}
    assert groupes["T9"]["label"] == "Table 9"


def test_une_reference_de_table_inconnue_est_refusee(db):
    with pytest.raises(svc.ReservationError):
        svc.set_room_label(db, "Salle du fond", "Peu importe")


def test_les_bureaux_et_bulles_gardent_leur_renommage(db):
    svc.set_room_label(db, "Bureau 1", "Bureau RH")
    svc.set_room_label(db, "BC-1", "Bulle Maldives")

    labels = svc.get_room_labels(db)
    assert labels["Bureau 1"] == "Bureau RH"
    assert labels["BC-1"] == "Bulle Maldives"


def test_le_seed_ne_range_plus_de_nom_de_table_dans_l_equipement():
    from app.db.seed import _DEMO_DESKS

    fautifs = [
        nom for (nom, zone, _f, feat) in _DEMO_DESKS
        if zone == "Open Space" and (feat or "").lower().startswith("table")
    ]
    assert fautifs == []
