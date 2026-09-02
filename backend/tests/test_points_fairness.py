"""Cas Ruben (02/09/2026) : présent dans les locaux mais sanctionné en no-show.

Le pop-up d'arrivée est devenu LE geste du matin, et il ne confirmait pas la
réservation du jour : quelqu'un venu, arrivée confirmée, se faisait quand même
retirer des points le lendemain. Trois verrous :
  - confirmer son arrivée confirme les réservations du jour (les deux sens
    sont symétriques : le check-in de réservation confirmait déjà l'arrivée) ;
  - le balayage des no-shows épargne, et répare, un jour où la présence dans
    les locaux était confirmée ;
  - l'admin voit le journal de points de chacun, les no-shows suspects, et
    peut régulariser sans toucher à la base.
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import attendance as attendance_svc
from app.services import reservations as resa_svc
from app.services.gamification import POINTS_PER_BOOKING
from app.services.reservations import NOSHOW_PENALTY

COUT_ABSENCE = POINTS_PER_BOOKING + NOSHOW_PENALTY


@pytest.fixture
def poste(db):
    d = m.Desk(name="T8-1", zone="Open Space", floor="Rez", is_active=True)
    db.add(d)
    db.commit()
    return d


def _hier() -> date:
    return date.today() - timedelta(days=1)


def _jour_ouvre() -> date:
    jour = date.today() + timedelta(days=1)
    while jour.weekday() >= 5:
        jour += timedelta(days=1)
    return jour


def _reservation_hier(db, user_id, desk_id, **kwargs):
    """Le service refuse le passé : on écrit la ligne d'hier en base."""
    r = m.Reservation(
        user_id=user_id, desk_id=desk_id, reservation_date=_hier(),
        slot=m.ReservationSlot.AM, **kwargs,
    )
    db.add(r)
    db.commit()
    return r


# ---------------------------------------------------- L'arrivée confirme le jour
def test_l_arrivee_confirme_la_reservation_du_jour(db, employee, poste):
    resa = resa_svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=poste.id, reservation_date=date.today(), slot="AM",
    ))
    assert resa.checked_in_at is None

    attendance_svc.check_in(db, employee.id)

    db.refresh(resa)
    assert resa.checked_in_at is not None


def test_l_arrivee_confirme_la_place_attribuee_par_un_collegue(db, employee, colleague, poste):
    """Une place attribuée sur un espace réservé par un autre est aussi couverte."""
    r = _reservation_hier(db, employee.id, poste.id,
                          is_group_booking=True,
                          occupant_user_id=colleague.id, occupant_name=colleague.display_name)
    r.reservation_date = date.today()
    db.commit()

    attendance_svc.check_in(db, colleague.id)

    db.refresh(r)
    assert r.checked_in_at is not None


def test_l_arrivee_ne_confirme_pas_les_autres_jours(db, employee, poste):
    resa = resa_svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=poste.id, reservation_date=_jour_ouvre(), slot="AM",
    ))

    attendance_svc.check_in(db, employee.id)

    db.refresh(resa)
    assert resa.checked_in_at is None


def test_l_arrivee_ne_confirme_pas_la_reservation_d_un_autre(db, employee, colleague, poste):
    resa = resa_svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=poste.id, reservation_date=date.today(), slot="AM",
    ))

    attendance_svc.check_in(db, colleague.id)

    db.refresh(resa)
    assert resa.checked_in_at is None


# ---------------------------------------------------- Le balayage épargne les présents
def test_pas_de_sanction_un_jour_ou_la_presence_etait_confirmee(db, employee, poste):
    resa = _reservation_hier(db, employee.id, poste.id)
    attendance_svc.check_in(db, employee.id, day=_hier())
    depart = employee.total_points

    sanctions = resa_svc.apply_noshow_penalties(db, employee.id)

    db.refresh(resa)
    db.refresh(employee)
    assert sanctions == 0
    assert resa.status == m.ReservationStatus.BOOKED
    # Le check-in manquant est réparé avec l'heure d'arrivée réelle.
    assert resa.checked_in_at is not None
    assert employee.total_points == depart


def test_la_sanction_tombe_toujours_sans_presence_confirmee(db, employee, poste):
    resa = _reservation_hier(db, employee.id, poste.id)
    depart = employee.total_points

    sanctions = resa_svc.apply_noshow_penalties(db, employee.id)

    db.refresh(resa)
    db.refresh(employee)
    assert sanctions == 1
    assert resa.status == m.ReservationStatus.NO_SHOW
    assert employee.total_points == depart - COUT_ABSENCE


# ---------------------------------------------------- Journal et régularisation admin
def test_le_journal_est_reserve_aux_admins(client, employee):
    client.login_as(employee)
    assert client.get(f"/api/admin/users/{employee.id}/points").status_code == 403


def test_le_journal_croise_no_show_et_presence(client, db, admin, employee, poste):
    resa = _reservation_hier(db, employee.id, poste.id)
    attendance_svc.check_in(db, employee.id, day=_hier())
    # Sanction posée AVANT le correctif : le statut est déjà no_show en base.
    resa.status = m.ReservationStatus.NO_SHOW
    db.commit()

    client.login_as(admin)
    data = client.get(f"/api/admin/users/{employee.id}/points").json()

    assert data["user"]["name"] == "Camille Dupont"
    assert data["no_shows"] == [{
        "date": _hier().isoformat(), "desk": "T8-1", "slot": "AM", "present_ce_jour": True,
    }]
    raisons = [t["reason"] for t in data["transactions"]]
    assert "checkin" in raisons


def test_l_ajustement_admin_credite_et_se_trace(client, db, admin, employee):
    client.login_as(admin)

    rep = client.post(f"/api/admin/users/{employee.id}/points",
                      json={"amount": 20, "note": "Régularisation no-show du 01/09"})
    assert rep.status_code == 201
    db.refresh(employee)
    assert employee.total_points == 20
    assert rep.json()["total_points"] == 20

    journal = client.get(f"/api/admin/users/{employee.id}/points").json()["transactions"]
    assert journal[0]["amount"] == 20
    assert journal[0]["reason"] == "ajustement_admin · Régularisation no-show du 01/09"


def test_l_ajustement_de_zero_est_refuse(client, admin, employee):
    client.login_as(admin)
    rep = client.post(f"/api/admin/users/{employee.id}/points", json={"amount": 0})
    assert rep.status_code == 400


def test_l_ajustement_est_reserve_aux_admins(client, employee):
    client.login_as(employee)
    rep = client.post(f"/api/admin/users/{employee.id}/points", json={"amount": 100})
    assert rep.status_code == 403
