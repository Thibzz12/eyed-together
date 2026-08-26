"""Ce qu'un occupant possède sur la place qu'on lui a attribuée.

Retour de Thibaud : « si je réserve pour OLVA, est-ce que la résa peut s'afficher
dans son espace ? comme ça il est maître de dire s'il est arrivé, parti,
d'annuler ». Et en même temps : « c'est bien que celui qui a réservé la table
garde la main sur la réservation totale ».

Les deux tiennent ensemble : l'occupant possède SA place, le réservant possède
l'espace.
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.services import reservations as svc
from app.services.gamification import POINTS_PER_BOOKING


@pytest.fixture
def table(db):
    postes = [
        m.Desk(name=f"T4-{i}", zone="Open Space", floor="Rez", is_active=True)
        for i in range(1, 5)
    ]
    db.add_all(postes)
    db.commit()
    return postes


def _jour() -> date:
    jour = date.today() + timedelta(days=1)
    while jour.weekday() >= 5:
        jour += timedelta(days=1)
    return jour


def _reserver(db, table, employee, colleague):
    """Employee réserve la table, s'y met, et installe colleague à côté."""
    return svc.book_group(db, employee.id, "T4", _jour(), "AM", [
        {"desk_id": table[0].id, "user_id": employee.id},
        {"desk_id": table[1].id, "user_id": colleague.id},
        {"desk_id": table[2].id, "name": "Sophie Bernard", "company": "Roche"},
    ])


# ---------------------------------------------------------------- Points partagés
def test_un_collegue_installe_gagne_aussi_ses_points(db, table, employee, colleague):
    depart = colleague.total_points
    _reserver(db, table, employee, colleague)

    db.refresh(colleague)
    assert colleague.total_points == depart + POINTS_PER_BOOKING


def test_le_reservant_n_est_pas_credite_deux_fois(db, table, employee, colleague):
    """Il est aussi occupant : une seule attribution, pas deux."""
    depart = employee.total_points
    _reserver(db, table, employee, colleague)

    db.refresh(employee)
    assert employee.total_points == depart + POINTS_PER_BOOKING


def test_annuler_la_table_reprend_les_points_de_tout_le_monde(db, table, employee, colleague):
    depart_e, depart_c = employee.total_points, colleague.total_points
    reservations = _reserver(db, table, employee, colleague)

    svc.cancel_reservation(db, employee.id, reservations[0].id)

    db.refresh(employee); db.refresh(colleague)
    assert employee.total_points == depart_e
    assert colleague.total_points == depart_c


# ---------------------------------------------------------------- Visibilité
def test_l_occupant_voit_sa_place_chez_lui(db, table, employee, colleague):
    _reserver(db, table, employee, colleague)

    siennes = svc.my_reservations(db, colleague.id)
    assert [r.desk.name for r in siennes] == ["T4-2"]


def test_le_reservant_voit_tout_le_lot(db, table, employee, colleague):
    _reserver(db, table, employee, colleague)

    siennes = svc.my_reservations(db, employee.id)
    assert {r.desk.name for r in siennes} == {"T4-1", "T4-2", "T4-3", "T4-4"}


def test_une_personne_exterieure_n_apparait_chez_personne(db, table, employee, colleague):
    """Sophie Bernard n'a pas de compte : sa place reste chez le réservant."""
    _reserver(db, table, employee, colleague)

    noms = {r.desk.name for r in svc.my_reservations(db, colleague.id)}
    assert "T4-3" not in noms


# ---------------------------------------------------------------- Se retirer
def test_l_occupant_peut_se_retirer_de_sa_place(db, table, employee, colleague):
    reservations = _reserver(db, table, employee, colleague)
    sienne = next(r for r in reservations if r.desk_id == table[1].id)

    svc.cancel_reservation(db, colleague.id, sienne.id)

    db.refresh(sienne)
    assert sienne.occupant_user_id is None
    assert svc.my_reservations(db, colleague.id) == []


def test_se_retirer_ne_libere_pas_la_place_pour_les_autres(db, table, employee, colleague):
    """Le bug trouvé par Thibaud : la table reste retenue, la place reste gardée."""
    reservations = _reserver(db, table, employee, colleague)
    sienne = next(r for r in reservations if r.desk_id == table[1].id)

    svc.cancel_reservation(db, colleague.id, sienne.id)

    db.refresh(sienne)
    assert sienne.status == m.ReservationStatus.BOOKED
    etats = {d.name: dispo for d, dispo, _o, _f in svc.get_availability(db, _jour(), "AM")}
    assert etats["T4-2"] is not None   # toujours réservée par le réservant


def test_se_retirer_rend_les_points_de_l_occupant_seulement(db, table, employee, colleague):
    reservations = _reserver(db, table, employee, colleague)
    depart_e, depart_c = employee.total_points, colleague.total_points
    sienne = next(r for r in reservations if r.desk_id == table[1].id)

    svc.cancel_reservation(db, colleague.id, sienne.id)

    db.refresh(employee); db.refresh(colleague)
    assert colleague.total_points == depart_c - POINTS_PER_BOOKING
    assert employee.total_points == depart_e


def test_un_tiers_ne_touche_a_rien(db, table, employee, colleague, admin):
    reservations = _reserver(db, table, employee, colleague)

    with pytest.raises(svc.NotOwner):
        svc.cancel_reservation(db, admin.id, reservations[0].id)


# ---------------------------------------------------------------- Le réservant garde la main
def test_le_reservant_libere_tout_le_lot_d_un_coup(db, table, employee, colleague):
    reservations = _reserver(db, table, employee, colleague)

    svc.cancel_reservation(db, employee.id, reservations[0].id)

    for r in reservations:
        db.refresh(r)
        assert r.status == m.ReservationStatus.CANCELLED


def test_la_table_redevient_reservable_apres_liberation(db, table, employee, colleague):
    reservations = _reserver(db, table, employee, colleague)
    svc.cancel_reservation(db, employee.id, reservations[0].id)

    reprise = svc.book_group(db, colleague.id, "T4", _jour(), "AM",
                             [{"desk_id": table[0].id, "user_id": colleague.id}])
    assert len(reprise) == 4
