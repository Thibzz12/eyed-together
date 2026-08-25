"""Interrupteurs d'administration : quels modes de réservation sont ouverts.

Olivier veut pouvoir fermer à la demande la réservation d'une place, d'une
table, d'une salle ou d'une bulle, et rendre un espace précis indisponible
sans le supprimer.
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import reservations as svc


@pytest.fixture
def desks(db):
    postes = [
        m.Desk(name="T1-1", zone="Open Space", features="Table 1"),
        m.Desk(name="T1-2", zone="Open Space", features="Table 1"),
        m.Desk(name="B1-1", zone="Bureau 1"),
        m.Desk(name="B1-2", zone="Bureau 1"),
        m.Desk(name="BC-1", zone="Bulles calmes", features="Cabine individuelle"),
    ]
    db.add_all(postes)
    db.commit()
    return {d.name: d for d in postes}


@pytest.fixture
def demain():
    d = date.today() + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def test_tout_est_ouvert_par_defaut(db):
    toggles = svc.get_booking_toggles(db)
    assert toggles == {"seat": True, "table": True, "room": True, "pod": True}


def test_un_mode_se_ferme_et_se_rouvre(db):
    svc.set_booking_toggle(db, "table", False)
    assert svc.get_booking_toggles(db)["table"] is False

    svc.set_booking_toggle(db, "table", True)
    assert svc.get_booking_toggles(db)["table"] is True


def test_un_mode_inconnu_est_refuse(db):
    with pytest.raises(svc.ReservationError):
        svc.set_booking_toggle(db, "helicoptere", False)


def test_place_fermee_bloque_la_reservation_individuelle(db, employee, desks, demain):
    svc.set_booking_toggle(db, "seat", False)

    with pytest.raises(svc.ReservationError):
        svc.create_reservation(db, employee.id, ReservationCreate(
            desk_id=desks["T1-1"].id, reservation_date=demain, slot="AM"))


def test_place_fermee_n_empeche_pas_de_reserver_une_table(db, employee, desks, demain):
    svc.set_booking_toggle(db, "seat", False)

    svc.book_group(db, employee.id, "T1", demain, "AM",
                   [{"desk_id": desks["T1-1"].id, "user_id": employee.id}])

    assert db.query(m.Reservation).count() == 2


def test_table_fermee_bloque_la_reservation_de_table(db, employee, desks, demain):
    svc.set_booking_toggle(db, "table", False)

    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, "T1", demain, "AM",
                       [{"desk_id": desks["T1-1"].id, "user_id": employee.id}])


def test_table_fermee_n_empeche_pas_de_reserver_une_salle(db, employee, desks, demain):
    svc.set_booking_toggle(db, "table", False)

    svc.book_group(db, employee.id, "Bureau 1", demain, "AM",
                   [{"desk_id": desks["B1-1"].id, "user_id": employee.id}])

    assert db.query(m.Reservation).count() == 2


def test_salle_fermee_bloque_la_reservation_de_salle(db, employee, desks, demain):
    svc.set_booking_toggle(db, "room", False)

    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, "Bureau 1", demain, "AM",
                       [{"desk_id": desks["B1-1"].id, "user_id": employee.id}])


def test_un_espace_precis_peut_etre_rendu_indisponible(db, employee, desks, demain):
    svc.set_group_enabled(db, "T1", False)

    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, "T1", demain, "AM",
                       [{"desk_id": desks["T1-1"].id, "user_id": employee.id}])


def test_un_espace_indisponible_bloque_aussi_ses_places(db, employee, desks, demain):
    """Griser une salle doit aussi fermer ses postes, sinon le grisé ne veut rien dire."""
    svc.set_group_enabled(db, "Bureau 1", False)

    with pytest.raises(svc.ReservationError):
        svc.create_reservation(db, employee.id, ReservationCreate(
            desk_id=desks["B1-1"].id, reservation_date=demain, slot="AM"))


def test_un_espace_indisponible_est_signale_dans_la_liste(db, desks):
    svc.set_group_enabled(db, "T1", False)

    groupes = {g["ref"]: g for g in svc.bookable_groups(db)}
    assert groupes["T1"]["enabled"] is False
    assert groupes["Bureau 1"]["enabled"] is True


def test_bulle_fermee_bloque_la_reservation_par_creneau(db, employee, desks, demain):
    from datetime import time

    svc.set_booking_toggle(db, "pod", False)

    with pytest.raises(svc.ReservationError):
        svc.book_timeslot(db, employee.id, desks["BC-1"].id, demain, time(9, 0), time(9, 30))
