"""Une bulle calme se grise comme une salle.

Olivier demande de pouvoir rendre indisponible « une bubble ou une salle ou
autre (grisé et non recevable) ». Les salles et les tables passaient par les
verrous d'espace, mais les bulles n'y figuraient pas : elles ne se réservent
pas en entier, donc elles n'étaient pas des groupes. Elles y sont maintenant,
avec `kind="pod"` pour que l'interface ne leur propose pas de bouton
« réserver toute la bulle ».
"""

from datetime import date, time, timedelta

import pytest

from app.db import models as m
from app.services import reservations as svc


def _prochain_jour_ouvre() -> date:
    jour = date.today() + timedelta(days=1)
    while jour.weekday() >= 5:
        jour += timedelta(days=1)
    return jour


@pytest.fixture
def bulle(db):
    d = m.Desk(name="BC-1", zone="Bulles calmes", floor="Rez", is_active=True)
    db.add(d)
    db.commit()
    return d


def test_une_bulle_figure_parmi_les_espaces(db, bulle):
    espaces = {g["ref"]: g for g in svc.bookable_groups(db)}

    assert "BC-1" in espaces
    assert espaces["BC-1"]["kind"] == "pod"
    assert espaces["BC-1"]["enabled"] is True


def test_une_bulle_grisee_est_signalee_comme_telle(db, bulle):
    svc.set_group_enabled(db, "BC-1", False)

    espaces = {g["ref"]: g for g in svc.bookable_groups(db)}
    assert espaces["BC-1"]["enabled"] is False


def test_une_bulle_grisee_refuse_les_creneaux(db, bulle, employee):
    svc.set_group_enabled(db, "BC-1", False)

    with pytest.raises(svc.ReservationError) as erreur:
        svc.book_timeslot(db, employee.id, bulle.id, _prochain_jour_ouvre(),
                          time(10, 0), time(10, 30))
    assert "pas disponible" in str(erreur.value)


def test_une_bulle_rouverte_redevient_reservable(db, bulle, employee):
    svc.set_group_enabled(db, "BC-1", False)
    svc.set_group_enabled(db, "BC-1", True)

    reservation = svc.book_timeslot(db, employee.id, bulle.id, _prochain_jour_ouvre(),
                                    time(10, 0), time(10, 30))
    assert reservation.desk_id == bulle.id


def test_griser_une_bulle_n_affecte_pas_l_autre(db, employee):
    db.add_all([
        m.Desk(name="BC-1", zone="Bulles calmes", floor="Rez", is_active=True),
        m.Desk(name="BC-2", zone="Bulles calmes", floor="Rez", is_active=True),
    ])
    db.commit()
    svc.set_group_enabled(db, "BC-1", False)

    espaces = {g["ref"]: g for g in svc.bookable_groups(db)}
    assert espaces["BC-1"]["enabled"] is False
    assert espaces["BC-2"]["enabled"] is True


def test_une_bulle_ne_se_reserve_pas_en_entier(db, bulle, employee):
    """Le verrou est le seul point commun avec une salle : pas la réservation de groupe."""
    with pytest.raises(svc.DeskNotFound):
        svc.book_group(db, employee.id, "BC-1", _prochain_jour_ouvre(), "AM",
                       [{"desk_id": bulle.id, "name": "Quelqu'un"}])
