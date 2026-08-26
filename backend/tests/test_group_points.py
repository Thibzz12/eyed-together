"""Points d'une réservation de groupe : ce qui est retiré doit égaler ce qui a été donné.

`book_group` crédite une seule fois par créneau — bloquer une table de six ne
doit pas rapporter six fois une place. Mais elle crée une ligne de réservation
par place, et l'annulation débitait chaque ligne : réserver puis annuler la
Table 3 coûtait 50 points, et le solde plongeait dans le négatif à force.
"""

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.db import models as m
from app.services import reservations as svc
from app.schemas import ReservationCreate
from app.services.gamification import POINTS_PER_BOOKING


def _jour_ouvre() -> date:
    jour = date.today() + timedelta(days=1)
    while jour.weekday() >= 5:
        jour += timedelta(days=1)
    return jour


@pytest.fixture
def table(db):
    """Une table de quatre places, comme la Table 1 des locaux."""
    postes = [
        m.Desk(name=f"T7-{i}", zone="Open Space", floor="Rez", is_active=True)
        for i in range(1, 5)
    ]
    db.add_all(postes)
    db.commit()
    return postes


def _occupants(postes):
    return [{"desk_id": postes[0].id, "name": "Camille Dupont"}]


def test_reserver_une_table_rapporte_autant_qu_une_place(db, table, employee):
    depart = employee.total_points
    svc.book_group(db, employee.id, "T7", _jour_ouvre(), "AM", _occupants(table))
    db.refresh(employee)

    assert employee.total_points == depart + POINTS_PER_BOOKING


def test_annuler_une_table_rend_exactement_ce_qu_elle_avait_rapporte(db, table, employee):
    """Une seule annulation suffit : elle libère tout le lot."""
    depart = employee.total_points
    reservations = svc.book_group(db, employee.id, "T7", _jour_ouvre(), "AM", _occupants(table))

    svc.cancel_reservation(db, employee.id, reservations[0].id)
    db.refresh(employee)

    assert employee.total_points == depart


def test_annuler_une_place_libere_toute_la_table(db, table, employee):
    """Libérer une place d'une table retenue la rendait réservable par n'importe qui."""
    reservations = svc.book_group(db, employee.id, "T7", _jour_ouvre(), "AM", _occupants(table))
    svc.cancel_reservation(db, employee.id, reservations[0].id)

    for r in reservations:
        db.refresh(r)
        assert r.status == m.ReservationStatus.CANCELLED


def test_le_solde_ne_derive_pas_sur_plusieurs_cycles(db, table, employee):
    """Le symptôme observé : un compteur qui finit à moins cent soixante."""
    depart = employee.total_points
    for _ in range(5):
        reservations = svc.book_group(db, employee.id, "T7", _jour_ouvre(), "AM", _occupants(table))
        svc.cancel_reservation(db, employee.id, reservations[0].id)
    db.refresh(employee)

    assert employee.total_points == depart


def test_une_journee_entiere_compte_pour_deux_demi_journees(db, table, employee):
    """Une journée fait deux lots, matin et après-midi, annulables séparément.

    C'est ce que montre « Mes réservations » : deux entrées, deux boutons.
    """
    depart = employee.total_points
    reservations = svc.book_group(db, employee.id, "T7", _jour_ouvre(), "DAY", _occupants(table))
    db.refresh(employee)
    assert employee.total_points == depart + 2 * POINTS_PER_BOOKING

    matin = next(r for r in reservations if r.slot == m.ReservationSlot.AM)
    svc.cancel_reservation(db, employee.id, matin.id)
    db.refresh(employee)
    assert employee.total_points == depart + POINTS_PER_BOOKING

    apres_midi = next(r for r in reservations if r.slot == m.ReservationSlot.PM)
    svc.cancel_reservation(db, employee.id, apres_midi.id)
    db.refresh(employee)
    assert employee.total_points == depart


def test_une_place_seule_reste_debitee_normalement(db, employee):
    """La correction ne touche pas la réservation individuelle."""
    poste = m.Desk(name="T8-1", zone="Open Space", floor="Rez", is_active=True)
    db.add(poste)
    db.commit()

    depart = employee.total_points
    reservation = svc.create_reservation(
        db, employee.id,
        ReservationCreate(desk_id=poste.id, reservation_date=_jour_ouvre(), slot="AM"),
    )
    db.refresh(employee)
    assert employee.total_points == depart + POINTS_PER_BOOKING

    svc.cancel_reservation(db, employee.id, reservation.id)
    db.refresh(employee)
    assert employee.total_points == depart


def test_le_journal_de_points_reste_la_source_de_verite(db, table, employee):
    """`total_points` n'est qu'un cumul : il doit coller au journal, qui fait foi."""
    reservations = svc.book_group(db, employee.id, "T7", _jour_ouvre(), "AM", _occupants(table))
    svc.cancel_reservation(db, employee.id, reservations[0].id)

    db.refresh(employee)
    journal = sum(
        t.amount
        for t in db.scalars(
            select(m.PointTransaction).where(m.PointTransaction.user_id == employee.id)
        )
    )
    assert employee.total_points == journal
