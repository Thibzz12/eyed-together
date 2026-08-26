"""Une personne extérieure désignée sur une place rejoint la liste d'évacuation.

Réserver une table entière oblige à dire qui occupe chaque place. Quand une de
ces places revient à quelqu'un d'extérieur, ce nom doit finir dans « Dans les
locaux » : c'est la raison même pour laquelle Olivier réclame cette saisie.

Le visiteur n'est pas créé au moment de la réservation — une place retenue pour
dans trois jours est une annonce, pas une présence. Il apparaît quand son hôte
est effectivement là.
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.services import attendance as att
from app.services import reservations as svc


def _demain() -> date:
    jour = date.today() + timedelta(days=1)
    while jour.weekday() >= 5:
        jour += timedelta(days=1)
    return jour


@pytest.fixture
def table(db):
    postes = [
        m.Desk(name=f"T6-{i}", zone="Open Space", floor="Rez", is_active=True)
        for i in range(1, 4)
    ]
    db.add_all(postes)
    db.commit()
    return postes


def _avec_invite(postes, employee, colleague):
    return [
        {"desk_id": postes[0].id, "user_id": employee.id, "name": employee.display_name},
        {"desk_id": postes[1].id, "user_id": colleague.id, "name": colleague.display_name},
        {"desk_id": postes[2].id, "name": "Sophie Bernard", "company": "Roche"},
    ]


def test_l_invite_apparait_quand_son_hote_arrive(db, table, employee, colleague):
    svc.book_group(db, employee.id, "T6", date.today(), "AM",
                   _avec_invite(table, employee, colleague))
    att.check_in(db, employee.id)

    visiteurs = att.who_is_in(db)["visitors"]
    assert [v["full_name"] for v in visiteurs] == ["Sophie Bernard"]
    assert visiteurs[0]["company"] == "Roche"
    assert visiteurs[0]["host_name"] == employee.display_name


def test_un_collegue_designe_n_est_pas_un_visiteur(db, table, employee, colleague):
    """Alex Martin travaille ici : il n'a rien à faire dans la liste des visiteurs."""
    svc.book_group(db, employee.id, "T6", date.today(), "AM",
                   _avec_invite(table, employee, colleague))
    att.check_in(db, employee.id)

    noms = [v["full_name"] for v in att.who_is_in(db)["visitors"]]
    assert colleague.display_name not in noms


def test_reserver_apres_etre_arrive_annonce_aussi_l_invite(db, table, employee, colleague):
    """L'ordre inverse est tout aussi courant : on arrive, puis on réserve."""
    att.check_in(db, employee.id)
    svc.book_group(db, employee.id, "T6", date.today(), "AM",
                   _avec_invite(table, employee, colleague))

    noms = [v["full_name"] for v in att.who_is_in(db)["visitors"]]
    assert "Sophie Bernard" in noms


def test_une_reservation_future_n_annonce_personne_aujourd_hui(db, table, employee, colleague):
    """Une place retenue pour demain n'est pas une présence d'aujourd'hui."""
    svc.book_group(db, employee.id, "T6", _demain(), "AM",
                   _avec_invite(table, employee, colleague))
    att.check_in(db, employee.id)

    assert att.who_is_in(db)["visitors"] == []


def test_matin_et_apres_midi_ne_font_qu_un_visiteur(db, table, employee, colleague):
    """Une journée entière crée deux lignes de réservation par place."""
    svc.book_group(db, employee.id, "T6", date.today(), "DAY",
                   _avec_invite(table, employee, colleague))
    att.check_in(db, employee.id)

    noms = [v["full_name"] for v in att.who_is_in(db)["visitors"]]
    assert noms == ["Sophie Bernard"]


def test_repartir_et_revenir_ne_duplique_pas_l_invite(db, table, employee, colleague):
    svc.book_group(db, employee.id, "T6", date.today(), "AM",
                   _avec_invite(table, employee, colleague))
    att.check_in(db, employee.id)
    att.check_out(db, employee.id)
    att.check_in(db, employee.id)

    noms = [v["full_name"] for v in att.who_is_in(db)["visitors"]]
    assert noms == ["Sophie Bernard"]


def test_l_hote_absent_n_annonce_rien(db, table, employee, colleague):
    """Réserver ne suffit pas : tant que l'hôte n'est pas là, personne n'est là."""
    svc.book_group(db, employee.id, "T6", date.today(), "AM",
                   _avec_invite(table, employee, colleague))

    assert att.who_is_in(db)["visitors"] == []


def test_l_invite_reste_declarable_a_la_main(db, employee):
    """La saisie manuelle d'un visiteur n'est pas remplacée, seulement complétée."""
    att.check_in(db, employee.id)
    att.add_visitor(db, employee.id, "Jean Dupuis", "Acme")

    noms = [v["full_name"] for v in att.who_is_in(db)["visitors"]]
    assert noms == ["Jean Dupuis"]
