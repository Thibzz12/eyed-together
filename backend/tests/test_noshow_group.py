"""Pénalité de no-show sur un espace réservé d'un bloc.

Deux pièges, le second bien pire que le premier : une table de six comptait six
no-shows alors qu'elle n'avait rapporté qu'une réservation, et le réservant ne
peut confirmer sa présence que sur SA place — les autres n'ont jamais de
check-in, si bien que réserver une table pour des collègues garantissait la
pénalité même en étant venu.
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import reservations as svc
from app.services.gamification import POINTS_PER_BOOKING
from app.services.reservations import NOSHOW_PENALTY

# Ne pas venir coûte les points de la réservation ET la pénalité : sinon
# oublier sa place reviendrait moins cher que de l'annuler à temps.
COUT_ABSENCE = POINTS_PER_BOOKING + NOSHOW_PENALTY


@pytest.fixture
def table(db):
    postes = [
        m.Desk(name=f"T9-{i}", zone="Open Space", floor="Rez", is_active=True)
        for i in range(1, 5)
    ]
    db.add_all(postes)
    db.commit()
    return postes


def _hier() -> date:
    return date.today() - timedelta(days=1)


def _reserver_hier(db, employee, table, confirmee=False):
    """Pose un lot daté d'hier : book_group refuse le passé, on écrit en base."""
    lignes = []
    for i, poste in enumerate(table):
        lignes.append(m.Reservation(
            user_id=employee.id, desk_id=poste.id, reservation_date=_hier(),
            slot=m.ReservationSlot.AM, is_group_booking=True,
            occupant_name=("Camille Dupont" if i == 0 else f"Invité {i}"),
        ))
    db.add_all(lignes)
    db.commit()
    if confirmee:
        from app.core.timezone import local_now
        lignes[0].checked_in_at = local_now()
        db.commit()
    return lignes


def test_une_table_non_honoree_coute_une_seule_absence(db, employee, table):
    _reserver_hier(db, employee, table)
    depart = employee.total_points

    svc.apply_noshow_penalties(db, employee.id)
    db.refresh(employee)

    assert employee.total_points == depart - COUT_ABSENCE


def test_confirmer_une_seule_place_epargne_tout_le_lot(db, employee, table):
    """Le réservant est venu : il ne peut pas pointer pour les autres."""
    _reserver_hier(db, employee, table, confirmee=True)
    depart = employee.total_points

    svc.apply_noshow_penalties(db, employee.id)
    db.refresh(employee)

    assert employee.total_points == depart


def test_toutes_les_places_du_lot_passent_en_no_show(db, employee, table):
    lignes = _reserver_hier(db, employee, table)

    svc.apply_noshow_penalties(db, employee.id)

    for r in lignes:
        db.refresh(r)
        assert r.status == m.ReservationStatus.NO_SHOW


def test_deux_lots_de_jours_differents_comptent_deux_absences(db, employee, table):
    _reserver_hier(db, employee, table)
    avant_hier = date.today() - timedelta(days=2)
    db.add_all([
        m.Reservation(user_id=employee.id, desk_id=p.id, reservation_date=avant_hier,
                      slot=m.ReservationSlot.AM, is_group_booking=True,
                      occupant_name="Quelqu'un")
        for p in table
    ])
    db.commit()
    depart = employee.total_points

    svc.apply_noshow_penalties(db, employee.id)
    db.refresh(employee)

    assert employee.total_points == depart - 2 * COUT_ABSENCE


def test_une_place_seule_reste_sanctionnee_normalement(db, employee):
    poste = m.Desk(name="T9-9", zone="Open Space", floor="Rez", is_active=True)
    db.add(poste)
    db.commit()   # sans quoi poste.id vaut encore None
    db.add(m.Reservation(user_id=employee.id, desk_id=poste.id,
                         reservation_date=_hier(), slot=m.ReservationSlot.AM))
    db.commit()
    depart = employee.total_points

    svc.apply_noshow_penalties(db, employee.id)
    db.refresh(employee)

    assert employee.total_points == depart - COUT_ABSENCE


def test_une_reservation_du_jour_n_est_pas_encore_un_no_show(db, employee, table):
    """La journée n'est pas finie : rien à sanctionner."""
    svc.book_group(db, employee.id, "T9", date.today(), "AM",
                   [{"desk_id": table[0].id, "name": "Camille Dupont"}])
    depart = employee.total_points

    assert svc.apply_noshow_penalties(db, employee.id) == 0
    db.refresh(employee)
    assert employee.total_points == depart
