"""Deux demandes d'Olivier du 29/08/2026, sans rapport entre elles.

1. Réserver le week-end : c'était refusé net, il le veut possible avec un
   avertissement (l'avertissement vit dans l'interface, pas ici).
2. Nommer un administrateur depuis l'application, au lieu de modifier une
   variable d'environnement et de redéployer.
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import reservations as svc
from app.services import users as users_svc


@pytest.fixture
def desk(db):
    poste = m.Desk(name="T1-1", zone="Open Space")
    db.add(poste)
    db.commit()
    return poste


@pytest.fixture
def prochain_samedi():
    d = date.today() + timedelta(days=1)
    while d.weekday() != 5:
        d += timedelta(days=1)
    return d


# ---------------------------------------------------------------- Week-end
def test_le_samedi_est_reservable(db, desk, employee, prochain_samedi):
    # L'horizon par défaut est de 7 jours : le samedi visé peut tomber au-delà.
    svc.set_booking_advance_days(db, 30)

    resa = svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=desk.id, reservation_date=prochain_samedi, slot="AM",
    ))

    assert resa.reservation_date == prochain_samedi


def test_le_dimanche_est_reservable(db, desk, employee, prochain_samedi):
    svc.set_booking_advance_days(db, 30)
    dimanche = prochain_samedi + timedelta(days=1)

    resa = svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=desk.id, reservation_date=dimanche, slot="AM",
    ))

    assert resa.reservation_date == dimanche


def test_plus_de_limite_de_jours_consecutifs(db, desk, employee):
    """Demande d'Olivier du 18/09/2026 : certaines places sont attribuées de façon
    fixe, réserver la même place tous les jours ouvrés d'affilée doit passer.
    L'ancienne règle bloquait au-delà de 5 jours consécutifs."""
    svc.set_booking_advance_days(db, 30)

    jour, reservees = date.today(), 0
    while reservees < 10:
        if jour.weekday() < 5:
            resa = svc.create_reservation(db, employee.id, ReservationCreate(
                desk_id=desk.id, reservation_date=jour, slot="AM",
            ))
            assert resa.reservation_date == jour
            reservees += 1
        jour += timedelta(days=1)


def test_l_horizon_reste_oppose_le_week_end(db, desk, employee):
    svc.set_booking_advance_days(db, 2)
    lointain = date.today() + timedelta(days=20)

    with pytest.raises(svc.BookingWindowExceeded):
        svc.create_reservation(db, employee.id, ReservationCreate(
            desk_id=desk.id, reservation_date=lointain, slot="AM",
        ))


# ---------------------------------------------------------------- Rôles
def test_un_admin_nomme_un_autre_admin(db, admin, employee):
    users_svc.set_role(db, employee, True, admin.id)
    assert employee.role == m.UserRole.ADMIN


def test_un_admin_retire_les_droits(db, admin, employee):
    users_svc.set_role(db, employee, True, admin.id)
    users_svc.set_role(db, employee, False, admin.id)
    assert employee.role == m.UserRole.EMPLOYEE


def test_on_ne_retire_pas_ses_propres_droits(db, admin):
    """Sinon le dernier administrateur peut se verrouiller dehors d'un clic."""
    with pytest.raises(ValueError):
        users_svc.set_role(db, admin, False, admin.id)


def test_la_promotion_survit_a_la_connexion_suivante(db, admin, employee):
    """La liste blanche du serveur amorce les droits, elle ne rétrograde plus.

    Avant, `sync_admin_role` remettait à `employee` toute personne absente de
    ADMIN_EMAILS : la promotion faite depuis l'application aurait été annulée à
    la connexion suivante, sans explication.
    """
    users_svc.set_role(db, employee, True, admin.id)

    users_svc.sync_admin_role(db, employee)

    assert employee.role == m.UserRole.ADMIN


def test_l_api_change_le_role(client, admin, employee):
    client.login_as(admin)

    res = client.patch(f"/api/admin/users/{employee.id}/role", json={"is_admin": True})

    assert res.status_code == 200
    assert res.json()["is_admin"] is True
    assert client.get("/api/admin/users").json()[0]["is_admin"] in (True, False)


def test_l_api_refuse_un_employe(client, employee, colleague):
    client.login_as(employee)
    res = client.patch(f"/api/admin/users/{colleague.id}/role", json={"is_admin": True})
    assert res.status_code == 403


def test_l_api_refuse_de_se_retrograder(client, admin):
    client.login_as(admin)
    res = client.patch(f"/api/admin/users/{admin.id}/role", json={"is_admin": False})
    assert res.status_code == 400
