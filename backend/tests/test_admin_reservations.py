"""Réservations gérées par un administrateur pour le compte d'un collaborateur.

Olivier demande le 29/08/2026 de pouvoir « modifier, supprimer ou faire des
réservations pour certaines personnes » : un absent à déplacer, une équipe à
regrouper, une place à libérer sans passer par l'intéressé.

Un administrateur échappe à la politique de réservation (horizon, jours
consécutifs) mais pas aux contraintes physiques : deux personnes ne tiennent
pas sur la même chaise au même moment.
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.services import reservations as svc


@pytest.fixture
def desks(db):
    postes = [
        m.Desk(name="T1-1", zone="Open Space"),
        m.Desk(name="T1-2", zone="Open Space"),
        m.Desk(name="B1-1", zone="Bureau 1"),
    ]
    db.add_all(postes)
    db.commit()
    return {d.name: d for d in postes}


@pytest.fixture
def demain():
    return date.today() + timedelta(days=1)


def test_un_admin_reserve_pour_quelqu_un_d_autre(db, desks, employee, demain):
    creees = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "DAY")

    assert len(creees) == 2  # une journée = matin + après-midi
    assert all(r.user_id == employee.id for r in creees)
    db.refresh(employee)
    assert employee.total_points > 0  # les points vont bien à la personne concernée


def test_la_place_deja_prise_est_refusee(db, desks, employee, colleague, demain):
    svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "DAY")

    with pytest.raises(svc.SlotConflict):
        svc.admin_create_reservation(db, colleague.id, desks["T1-1"].id, demain, "AM")


def test_deux_places_le_meme_jour_pour_la_meme_personne_sont_refusees(db, desks, employee, demain):
    svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "DAY")

    with pytest.raises(svc.AlreadyBooked):
        svc.admin_create_reservation(db, employee.id, desks["T1-2"].id, demain, "AM")


def test_l_horizon_ne_s_applique_pas_a_un_admin(db, desks, employee):
    """Un employé ne réserve pas à trois mois ; un admin qui prépare un planning, si."""
    lointain = date.today() + timedelta(days=90)
    creees = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, lointain, "AM")
    assert creees[0].reservation_date == lointain


def test_une_date_passee_reste_refusee(db, desks, employee):
    with pytest.raises(svc.PastDate):
        svc.admin_create_reservation(
            db, employee.id, desks["T1-1"].id, date.today() - timedelta(days=1), "AM"
        )


def test_un_poste_desactive_est_refuse(db, desks, employee, demain):
    desks["T1-1"].is_active = False
    db.commit()

    with pytest.raises(svc.DeskNotFound):
        svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "AM")


def test_une_reservation_se_deplace_sur_une_autre_place(db, desks, employee, demain):
    creees = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "DAY")

    svc.admin_move_reservation(db, creees[0].id, desk_id=desks["T1-2"].id)

    # Les DEUX lignes de la journée suivent : sinon la personne serait à cheval
    # sur deux places le même jour.
    for r in creees:
        db.refresh(r)
        assert r.desk_id == desks["T1-2"].id


def test_une_reservation_se_deplace_sur_un_autre_jour(db, desks, employee, demain):
    creees = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "AM")
    apres_demain = demain + timedelta(days=1)

    svc.admin_move_reservation(db, creees[0].id, day=apres_demain)

    db.refresh(creees[0])
    assert creees[0].reservation_date == apres_demain


def test_un_deplacement_vers_une_place_occupee_est_refuse(db, desks, employee, colleague, demain):
    a_moi = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "AM")
    svc.admin_create_reservation(db, colleague.id, desks["T1-2"].id, demain, "AM")

    with pytest.raises(svc.SlotConflict):
        svc.admin_move_reservation(db, a_moi[0].id, desk_id=desks["T1-2"].id)


def test_un_admin_supprime_la_reservation_de_n_importe_qui(db, desks, employee, demain):
    creees = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "AM")
    db.refresh(employee)
    points_apres_reservation = employee.total_points

    svc.admin_cancel_reservation(db, creees[0].id)

    db.refresh(creees[0])
    assert creees[0].status == m.ReservationStatus.CANCELLED
    db.refresh(employee)
    assert employee.total_points < points_apres_reservation  # les points sont repris


def test_la_journee_liste_les_reservations_de_tout_le_monde(db, desks, employee, colleague, demain):
    svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "AM")
    svc.admin_create_reservation(db, colleague.id, desks["T1-2"].id, demain, "AM")

    lignes = svc.admin_day_reservations(db, demain)

    assert {r.user.display_name for r in lignes} == {employee.display_name, colleague.display_name}


# ---------------------------------------------------------------- API
def test_l_api_refuse_un_employe(client, employee, desks, demain):
    client.login_as(employee)
    res = client.get(f"/api/admin/reservations?date={demain.isoformat()}")
    assert res.status_code == 403


def test_l_api_cree_deplace_et_supprime(client, admin, employee, desks, demain):
    client.login_as(admin)

    cree = client.post("/api/admin/reservations", json={
        "user_id": employee.id, "desk_id": desks["T1-1"].id,
        "reservation_date": demain.isoformat(), "slot": "AM",
    })
    assert cree.status_code == 201
    resa_id = cree.json()["ids"][0]

    liste = client.get(f"/api/admin/reservations?date={demain.isoformat()}")
    assert [l["user"]["name"] for l in liste.json()] == [employee.display_name]

    deplace = client.patch(f"/api/admin/reservations/{resa_id}", json={"desk_id": desks["T1-2"].id})
    assert deplace.status_code == 200
    assert deplace.json()["desk_id"] == desks["T1-2"].id

    supprime = client.delete(f"/api/admin/reservations/{resa_id}")
    assert supprime.status_code == 204
    assert client.get(f"/api/admin/reservations?date={demain.isoformat()}").json() == []


def test_une_bulle_calme_ne_se_reserve_pas_en_demi_journee(db, employee, demain):
    """Les bulles se réservent par créneau horaire : une ligne AM créée ici serait
    invisible du planning des bulles et bloquerait la place sans explication."""
    bulle = m.Desk(name="BC-1", zone="Bulles calmes")
    db.add(bulle)
    db.commit()

    with pytest.raises(svc.ReservationError):
        svc.admin_create_reservation(db, employee.id, bulle.id, demain, "AM")


def test_un_creneau_de_bulle_ne_se_deplace_pas(db, desks, employee, demain):
    bulle = m.Desk(name="BC-1", zone="Bulles calmes")
    db.add(bulle)
    db.commit()
    from datetime import time
    resa = m.Reservation(
        user_id=employee.id, desk_id=bulle.id, reservation_date=demain,
        slot=m.ReservationSlot.TIMESLOT, start_time=time(10, 0), end_time=time(10, 30),
    )
    db.add(resa)
    db.commit()

    with pytest.raises(svc.ReservationError):
        svc.admin_move_reservation(db, resa.id, desk_id=desks["T1-1"].id)

    # La suppression, elle, reste possible : c'est la seule action cohérente.
    svc.admin_cancel_reservation(db, resa.id)
    db.refresh(resa)
    assert resa.status == m.ReservationStatus.CANCELLED


# ---------------------------------------------------------------- Journée = une réservation
#  Une journée est stockée en deux lignes (AM + PM) mais vécue comme UNE
#  réservation : annulation, check-in et déplacement portent sur les deux.
def test_annuler_une_moitie_de_journee_annule_l_autre(db, desks, employee, demain):
    creees = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "DAY")
    db.refresh(employee)
    points_avant = employee.total_points

    svc.admin_cancel_reservation(db, creees[0].id)

    for r in creees:
        db.refresh(r)
        assert r.status == m.ReservationStatus.CANCELLED
    db.refresh(employee)
    # Les DEUX lignes rendent leurs points, pas seulement celle qu'on a visée.
    assert employee.total_points == points_avant - 2 * (points_avant // 2)


def test_l_employe_qui_annule_sa_journee_annule_tout(db, desks, employee, demain):
    creees = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, demain, "DAY")

    svc.cancel_reservation(db, employee.id, creees[1].id)

    for r in creees:
        db.refresh(r)
        assert r.status == m.ReservationStatus.CANCELLED
    db.refresh(employee)
    assert employee.total_points == 0


def test_le_checkin_confirme_les_deux_moities(db, desks, employee):
    creees = svc.admin_create_reservation(db, employee.id, desks["T1-1"].id, date.today(), "DAY")

    svc.check_in(db, employee.id, creees[0].id)

    for r in creees:
        db.refresh(r)
        # Sans cela, la moitié non confirmée devenait un no-show le lendemain,
        # pénalité comprise, alors que la personne était venue.
        assert r.checked_in_at is not None
