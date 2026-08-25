"""Logique métier de la présence : arrivée, départ, état du jour."""

from datetime import timedelta

import pytest

from app.core.timezone import local_now, local_today
from app.db import models as m
from app.services import attendance as svc


def test_arriver_cree_la_ligne_du_jour(db, employee):
    row = svc.check_in(db, employee.id)

    assert row.day == local_today()
    assert row.left_at is None
    assert row.source == "popup"


def test_arriver_attribue_les_points_une_seule_fois(db, employee):
    svc.check_in(db, employee.id)
    svc.check_in(db, employee.id)

    transactions = db.query(m.PointTransaction).filter_by(reason="checkin").all()
    assert len(transactions) == 1
    db.refresh(employee)
    assert employee.total_points == transactions[0].amount


def test_partir_pose_l_heure_de_depart(db, employee):
    svc.check_in(db, employee.id)
    row = svc.check_out(db, employee.id)

    assert row.left_at is not None
    assert row.auto_closed is False


def test_revenir_rouvre_la_ligne_sans_en_creer_une_seconde(db, employee):
    arrivee = svc.check_in(db, employee.id).arrived_at
    svc.check_out(db, employee.id)
    row = svc.check_in(db, employee.id)

    assert db.query(m.Attendance).count() == 1
    assert row.left_at is None
    assert row.arrived_at == arrivee  # l'heure d'arrivée d'origine est conservée


def test_revenir_ne_redonne_pas_de_points(db, employee):
    svc.check_in(db, employee.id)
    svc.check_out(db, employee.id)
    svc.check_in(db, employee.id)

    assert db.query(m.PointTransaction).filter_by(reason="checkin").count() == 1


def test_partir_sans_etre_arrive_est_refuse(db, employee):
    with pytest.raises(svc.AttendanceError):
        svc.check_out(db, employee.id)


def test_partir_deux_fois_est_refuse(db, employee):
    svc.check_in(db, employee.id)
    svc.check_out(db, employee.id)

    with pytest.raises(svc.AttendanceError):
        svc.check_out(db, employee.id)


def test_etat_du_jour_avant_toute_arrivee(db, employee):
    etat = svc.state_for(db, employee.id)

    assert etat["arrived"] is False
    assert etat["present"] is False
    assert etat["visitors"] == []


def test_etat_du_jour_apres_arrivee_puis_depart(db, employee):
    svc.check_in(db, employee.id)
    assert svc.state_for(db, employee.id)["present"] is True

    svc.check_out(db, employee.id)
    etat = svc.state_for(db, employee.id)
    assert etat["arrived"] is True
    assert etat["present"] is False


def test_la_source_est_conservee(db, employee):
    row = svc.check_in(db, employee.id, source="reservation")
    assert row.source == "reservation"


# ---------------------------------------------------------------- Clôture automatique
def test_heure_de_cloture_par_defaut(db):
    assert svc.get_auto_close_hour(db) == svc.DEFAULT_AUTO_CLOSE_HOUR


def test_heure_de_cloture_modifiable(db):
    svc.set_auto_close_hour(db, 21)
    assert svc.get_auto_close_hour(db) == 21


def test_heure_de_cloture_invalide_est_refusee(db):
    with pytest.raises(svc.AttendanceError):
        svc.set_auto_close_hour(db, 30)


def test_une_presence_d_hier_est_cloturee(db, employee):
    hier = local_today() - timedelta(days=1)
    svc.check_in(db, employee.id, day=hier)

    assert svc.close_stale(db) == 1

    row = db.query(m.Attendance).one()
    assert row.left_at is not None
    assert row.auto_closed is True


def test_une_presence_d_hier_est_cloturee_a_l_heure_limite_de_ce_jour_la(db, employee):
    """Clôturer à l'instant présent laisserait croire à une nuit sur place."""
    hier = local_today() - timedelta(days=1)
    svc.check_in(db, employee.id, day=hier)

    svc.close_stale(db)

    row = db.query(m.Attendance).one()
    assert row.left_at.date() == hier
    assert row.left_at.hour == svc.DEFAULT_AUTO_CLOSE_HOUR


def test_une_presence_du_jour_avant_l_heure_limite_reste_ouverte(db, employee):
    svc.check_in(db, employee.id)
    matin = local_now().replace(hour=9, minute=0)

    assert svc.close_stale(db, now=matin) == 0
    assert db.query(m.Attendance).one().left_at is None


def test_une_presence_du_jour_apres_l_heure_limite_est_cloturee(db, employee):
    svc.check_in(db, employee.id)
    tard = local_now().replace(hour=22, minute=0)

    assert svc.close_stale(db, now=tard) == 1
    assert db.query(m.Attendance).one().auto_closed is True


def test_un_depart_confirme_n_est_pas_marque_auto(db, employee):
    svc.check_in(db, employee.id)
    svc.check_out(db, employee.id)

    svc.close_stale(db, now=local_now().replace(hour=22))

    assert db.query(m.Attendance).one().auto_closed is False


# ---------------------------------------------------------------- Visiteurs externes
def test_declarer_un_visiteur(db, employee):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")

    assert v.full_name == "Jean Dupont"
    assert v.company == "Acme"
    assert v.left_at is None
    assert v.day == local_today()


def test_un_visiteur_sans_nom_est_refuse(db, employee):
    with pytest.raises(svc.AttendanceError):
        svc.add_visitor(db, employee.id, "   ", "Acme")


def test_la_societe_est_facultative(db, employee):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", None)
    assert v.company is None


def test_faire_partir_son_propre_visiteur(db, employee):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")
    v = svc.visitor_check_out(db, v.id, employee.id)

    assert v.left_at is not None


def test_on_ne_peut_pas_faire_partir_le_visiteur_d_un_autre(db, employee, colleague):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")

    with pytest.raises(svc.AttendanceForbidden):
        svc.visitor_check_out(db, v.id, colleague.id)


def test_un_admin_peut_faire_partir_n_importe_quel_visiteur(db, employee, admin):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")
    v = svc.visitor_check_out(db, v.id, admin.id, is_admin=True)

    assert v.left_at is not None


def test_le_depart_d_un_visiteur_n_affecte_pas_les_autres(db, employee):
    a = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")
    b = svc.add_visitor(db, employee.id, "Marie Durand", "Acme")

    svc.visitor_check_out(db, a.id, employee.id)

    assert db.get(m.Visitor, b.id).left_at is None


def test_qui_est_la_liste_employes_et_visiteurs_presents(db, employee, colleague):
    svc.check_in(db, employee.id)
    svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")

    vue = svc.who_is_in(db)

    assert [e["name"] for e in vue["employees"]] == ["Camille Dupont"]
    assert vue["visitors"][0]["host_name"] == "Camille Dupont"
    assert colleague.display_name not in [e["name"] for e in vue["employees"]]


def test_qui_est_la_exclut_les_personnes_parties(db, employee):
    svc.check_in(db, employee.id)
    svc.check_out(db, employee.id)

    assert svc.who_is_in(db)["employees"] == []


def test_qui_est_la_ne_divulgue_aucune_heure(db, employee):
    svc.check_in(db, employee.id)
    entree = svc.who_is_in(db)["employees"][0]

    assert "arrived_at" not in entree
    assert "left_at" not in entree


def test_le_releve_admin_contient_les_heures(db, employee):
    svc.check_in(db, employee.id)
    entree = svc.roster(db)["employees"][0]

    assert entree["arrived_at"] is not None
    assert "auto_closed" in entree


# ---------------------------------------------------------------- Lien avec les réservations
def test_le_checkin_d_une_reservation_marque_la_presence(db, employee):
    """Confirmer sa présence sur sa réservation, c'est aussi être dans les locaux.

    Une seule source de vérité pour la liste d'évacuation : sans ce lien, un
    employé qui pointe depuis sa réservation resterait invisible.
    """
    from app.services import reservations as resa_svc

    desk = m.Desk(name="B1-1", zone="Bureau 1", is_active=True)
    db.add(desk)
    db.commit()
    db.refresh(desk)

    reservation = m.Reservation(
        user_id=employee.id,
        desk_id=desk.id,
        reservation_date=local_today(),
        slot=m.ReservationSlot.AM,
        status=m.ReservationStatus.BOOKED,
    )
    db.add(reservation)
    db.commit()
    db.refresh(reservation)

    resa_svc.check_in(db, employee.id, reservation.id)

    presence = db.query(m.Attendance).one()
    assert presence.user_id == employee.id
    assert presence.source == "reservation"
    assert presence.left_at is None
