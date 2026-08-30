"""Place réservée pour un visiteur externe, par l'employé qui le reçoit.

Question d'Olivier relayée par Thibaud le 30/08/2026 : un accompagnant occupe
une chaise, sa place doit pouvoir être réservée. L'hôte la prend en son nom
propre avec le nom du visiteur dessus : pas de compte pour l'externe, pas de
points pour l'hôte (réserver pour son invité n'est pas un geste à récompenser,
ni à pénaliser en cas d'annulation ou d'oubli de check-in).
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import attendance as attendance_svc
from app.services import reservations as svc


@pytest.fixture
def desks(db):
    postes = [m.Desk(name="T1-1", zone="Open Space"), m.Desk(name="T1-2", zone="Open Space")]
    db.add_all(postes)
    db.commit()
    return {d.name: d for d in postes}


@pytest.fixture
def demain():
    return date.today() + timedelta(days=1)


def _reserver_invite(db, employee, desk, jour, slot="DAY", nom="Jean Externe"):
    return svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=desk.id, reservation_date=jour, slot=slot,
        guest_name=nom, guest_company="Acme",
    ))


def test_la_place_porte_le_nom_du_visiteur(db, desks, employee, demain):
    _reserver_invite(db, employee, desks["T1-2"], demain)

    dispo = {d.name: (booker, occupant) for d, booker, occupant, _ in svc.get_availability(db, demain, "AM")}
    booker, occupant = dispo["T1-2"]
    assert booker == employee.display_name
    assert occupant == "Jean Externe"


def test_reserver_pour_un_visiteur_ne_rapporte_aucun_point(db, desks, employee, demain):
    _reserver_invite(db, employee, desks["T1-2"], demain)
    db.refresh(employee)
    assert employee.total_points == 0


def test_l_hote_garde_sa_place_et_celle_du_visiteur(db, desks, employee, demain):
    """Deux places le même jour : la sienne et celle de son invité."""
    svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=desks["T1-1"].id, reservation_date=demain, slot="DAY",
    ))
    _reserver_invite(db, employee, desks["T1-2"], demain)   # ne lève pas AlreadyBooked

    actives = db.query(m.Reservation).filter(m.Reservation.status == m.ReservationStatus.BOOKED).count()
    assert actives == 4  # 2 lignes (journée) x 2 places


def test_la_place_du_visiteur_reste_en_conflit_pour_les_autres(db, desks, employee, colleague, demain):
    _reserver_invite(db, employee, desks["T1-2"], demain)

    with pytest.raises(svc.SlotConflict):
        svc.create_reservation(db, colleague.id, ReservationCreate(
            desk_id=desks["T1-2"].id, reservation_date=demain, slot="AM",
        ))


def test_annuler_la_place_du_visiteur_ne_reprend_rien(db, desks, employee, demain):
    resa = _reserver_invite(db, employee, desks["T1-2"], demain)

    svc.cancel_reservation(db, employee.id, resa.id)

    db.refresh(employee)
    assert employee.total_points == 0


def test_pas_de_penalite_no_show_sur_la_place_d_un_visiteur(db, desks, employee):
    hier = date.today() - timedelta(days=1)
    db.add(m.Reservation(
        user_id=employee.id, desk_id=desks["T1-2"].id, reservation_date=hier,
        slot=m.ReservationSlot.AM, occupant_name="Jean Externe",
    ))
    db.commit()

    svc.apply_noshow_penalties(db, employee.id)

    db.refresh(employee)
    assert employee.total_points == 0
    ligne = db.query(m.Reservation).one()
    assert ligne.status == m.ReservationStatus.BOOKED  # pas transformée en no-show


def test_le_visiteur_rejoint_la_liste_d_evacuation_si_l_hote_est_present(db, desks, employee):
    attendance_svc.check_in(db, employee.id)

    _reserver_invite(db, employee, desks["T1-2"], date.today())

    visiteurs = db.query(m.Visitor).all()
    assert [v.full_name for v in visiteurs] == ["Jean Externe"]
    assert visiteurs[0].host_user_id == employee.id


def test_l_admin_reserve_pour_le_visiteur_d_un_collaborateur(db, desks, employee, demain):
    creees = svc.admin_create_reservation(
        db, employee.id, desks["T1-2"].id, demain, "AM",
        guest_name="Marie Visite", guest_company="Beta",
    )

    assert creees[0].occupant_name == "Marie Visite"
    assert creees[0].user_id == employee.id   # l'hôte reste responsable de la place
    db.refresh(employee)
    assert employee.total_points == 0


def test_l_api_reserve_pour_un_visiteur(client, employee, desks, demain):
    client.login_as(employee)

    res = client.post("/api/reservations", json={
        "desk_id": desks["T1-2"].id, "reservation_date": demain.isoformat(),
        "slot": "AM", "guest_name": "Jean Externe", "guest_company": "Acme",
    })

    assert res.status_code == 201
    assert res.json()["occupant"] == "Jean Externe"
