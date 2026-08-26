"""Un espace grisé est refusé par toutes les portes d'entrée.

Olivier écrit « grisé et non recevable ». Le grisage est une affaire d'interface,
mais il ne vaut que si le serveur refuse aussi chaque chemin : la place seule, le
groupe entier, et le créneau pour une bulle. Sinon un lien direct ou un onglet
resté ouvert passe à travers.
"""

from datetime import date, time, timedelta

import pytest

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import reservations as svc


def _jour_ouvre() -> date:
    jour = date.today() + timedelta(days=1)
    while jour.weekday() >= 5:
        jour += timedelta(days=1)
    return jour


@pytest.fixture
def locaux(db):
    """Une salle fermée, une table d'open space et une bulle."""
    postes = [
        m.Desk(name="B2-1", zone="Bureau 2", floor="Rez", is_active=True),
        m.Desk(name="B2-2", zone="Bureau 2", floor="Rez", is_active=True),
        m.Desk(name="T5-1", zone="Open Space", floor="Rez", is_active=True),
        m.Desk(name="T5-2", zone="Open Space", floor="Rez", is_active=True),
        m.Desk(name="BC-1", zone="Bulles calmes", floor="Rez", is_active=True),
    ]
    db.add_all(postes)
    db.commit()
    return {d.name: d for d in postes}


@pytest.mark.parametrize("ref,poste", [("Bureau 2", "B2-1"), ("T5", "T5-1")])
def test_une_place_d_un_espace_grise_est_refusee(db, locaux, employee, ref, poste):
    svc.set_group_enabled(db, ref, False)

    with pytest.raises(svc.ReservationError) as erreur:
        svc.create_reservation(
            db, employee.id,
            ReservationCreate(desk_id=locaux[poste].id, reservation_date=_jour_ouvre(), slot="AM"),
        )
    assert "pas disponible" in str(erreur.value)


@pytest.mark.parametrize("ref,poste", [("Bureau 2", "B2-1"), ("T5", "T5-1")])
def test_l_espace_entier_grise_est_refuse(db, locaux, employee, ref, poste):
    svc.set_group_enabled(db, ref, False)

    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, ref, _jour_ouvre(), "AM",
                       [{"desk_id": locaux[poste].id, "name": "Camille Dupont"}])


def test_une_bulle_grisee_refuse_son_creneau(db, locaux, employee):
    svc.set_group_enabled(db, "BC-1", False)

    with pytest.raises(svc.ReservationError):
        svc.book_timeslot(db, employee.id, locaux["BC-1"].id, _jour_ouvre(),
                          time(10, 0), time(10, 30))


def test_griser_un_espace_n_affecte_pas_les_autres(db, locaux, employee):
    svc.set_group_enabled(db, "Bureau 2", False)

    reservation = svc.create_reservation(
        db, employee.id,
        ReservationCreate(desk_id=locaux["T5-1"].id, reservation_date=_jour_ouvre(), slot="AM"),
    )
    assert reservation.desk_id == locaux["T5-1"].id


def test_rouvrir_un_espace_le_rend_a_nouveau_reservable(db, locaux, employee):
    svc.set_group_enabled(db, "Bureau 2", False)
    svc.set_group_enabled(db, "Bureau 2", True)

    reservation = svc.create_reservation(
        db, employee.id,
        ReservationCreate(desk_id=locaux["B2-1"].id, reservation_date=_jour_ouvre(), slot="AM"),
    )
    assert reservation.desk_id == locaux["B2-1"].id


def test_griser_n_annule_pas_les_reservations_deja_prises(db, locaux, employee):
    """La carte d'administration le promet noir sur blanc."""
    reservation = svc.create_reservation(
        db, employee.id,
        ReservationCreate(desk_id=locaux["B2-1"].id, reservation_date=_jour_ouvre(), slot="AM"),
    )
    svc.set_group_enabled(db, "Bureau 2", False)

    db.refresh(reservation)
    assert reservation.status == m.ReservationStatus.BOOKED
