"""Non-régression des bugs relevés par l'audit du 07/10/2026.

Chaque test reproduit d'abord ce qui était faux, et verrouille le comportement
corrigé : check-in de l'occupant d'une table, suppression d'un poste réservé,
heures locales de la liste d'évacuation, créneau invalide, occupant inconnu,
double arrivée simultanée, rétrogradation d'un admin effective sans attendre.
"""

from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import deps
from app.api.router import _heure
from app.db import models as m
from app.schemas import ReservationCreate
from app.services import attendance as attendance_svc
from app.services import reservations as resa_svc
from app.services import users as users_svc


@pytest.fixture
def table(db):
    postes = [m.Desk(name=f"T7-{i}", zone="Open Space", is_active=True) for i in range(1, 5)]
    db.add_all(postes)
    db.commit()
    return postes


def _jour_ouvre() -> date:
    jour = date.today()
    while jour.weekday() >= 5:
        jour = jour.replace(day=jour.day + 1)
    return jour


# ---------------------------------------------------------------- 1. L'occupant confirme sa place
def test_l_occupant_d_une_table_confirme_sa_propre_place(db, table, employee, colleague):
    """« Mes réservations » lui montre la place et lui propose le bouton : le
    serveur répondait pourtant 403 « tes propres réservations »."""
    lignes = resa_svc.book_group(db, employee.id, "T7", date.today(), "AM", [
        {"desk_id": table[0].id, "user_id": colleague.id},
        {"desk_id": table[1].id, "user_id": employee.id},
    ])
    place_du_collegue = next(r for r in lignes if r.occupant_user_id == colleague.id)

    confirmee = resa_svc.check_in(db, colleague.id, place_du_collegue.id)
    assert confirmee.checked_in_at is not None
    # Un tiers, lui, reste refusé.
    with pytest.raises(resa_svc.NotOwner):
        resa_svc.check_in(db, employee.id + colleague.id + 1000, place_du_collegue.id)


# ---------------------------------------------------------------- 2. Supprimer un poste réservé
def test_supprimer_un_poste_emporte_ses_reservations(client, db, admin, employee):
    poste = m.Desk(name="T9-1", zone="Open Space", is_active=True)
    db.add(poste)
    db.commit()
    resa_svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=poste.id, reservation_date=date.today(), slot="AM",
    ))
    client.login_as(admin)
    assert client.delete(f"/api/admin/desks/{poste.id}").status_code == 204
    assert db.get(m.Desk, poste.id) is None
    assert db.query(m.Reservation).filter_by(desk_id=poste.id).count() == 0


# ---------------------------------------------------------------- 4. Heures locales sur l'export
def test_l_export_affiche_l_heure_de_bruxelles():
    # 12:53 UTC en octobre = 14:53 à Bruxelles (heure d'été).
    assert _heure("2026-10-07T12:53:00.077719+00:00") == "14:53"
    # Un horodatage naïf (SQLite) est déjà en heure locale : inchangé.
    assert _heure("2026-10-07T12:53:00") == "12:53"
    assert _heure(None) == ""


# ---------------------------------------------------------------- 5. Créneau invalide
def test_un_creneau_inconnu_est_une_erreur_de_saisie_pas_un_plantage(client, employee):
    client.login_as(employee)
    rep = client.get(f"/api/availability?date={date.today().isoformat()}&slot=FOO")
    assert rep.status_code == 422


# ---------------------------------------------------------------- 6. Occupant inconnu
def test_un_collegue_inexistant_sur_une_table_est_refuse_clairement(db, table, employee):
    with pytest.raises(resa_svc.ReservationError, match="n'existe pas"):
        resa_svc.book_group(db, employee.id, "T7", date.today(), "AM", [
            {"desk_id": table[0].id, "user_id": 424242},
        ])


# ---------------------------------------------------------------- 12. Double arrivée
def test_deux_arrivees_simultanees_ne_plantent_pas(db, employee, monkeypatch):
    """Un double clic sur « Je suis arrivé » envoie deux requêtes : la seconde
    tombait sur la contrainte unique (user, jour) en erreur 500."""
    premiere = attendance_svc.check_in(db, employee.id)

    # Simule la course : la seconde requête ne voit pas encore la ligne au moment
    # de la chercher, mais la trouve en base au moment d'écrire (clé unique).
    vraie = attendance_svc._row_for
    appels = {"n": 0}

    def premiere_lecture_a_vide(*args, **kwargs):
        appels["n"] += 1
        return None if appels["n"] == 1 else vraie(*args, **kwargs)

    monkeypatch.setattr(attendance_svc, "_row_for", premiere_lecture_a_vide)
    seconde = attendance_svc.check_in(db, employee.id)

    assert seconde.id == premiere.id
    assert db.query(m.Attendance).filter_by(user_id=employee.id).count() == 1


# ---------------------------------------------------------------- 11. Rétrogradation immédiate
def test_un_admin_retrograde_perd_ses_droits_sans_se_reconnecter(db, admin, employee):
    users_svc.set_role(db, employee, True, admin.id)
    session = {"user": {"id": employee.id, "name": employee.display_name, "email": employee.email, "role": "admin"}}
    requete = SimpleNamespace(session=session)
    assert deps.require_admin(requete, db)["role"] == "admin"

    users_svc.set_role(db, employee, False, admin.id)
    with pytest.raises(HTTPException) as refus:
        deps.require_admin(requete, db)
    assert refus.value.status_code == 403


# ---------------------------------------------------------------- 9. Points additifs
def test_les_points_s_additionnent_meme_si_la_session_a_une_vieille_valeur(db, employee):
    """Le cumul est incrémenté par la base, pas lu puis réécrit depuis Python."""
    from app.services.gamification import award_points

    award_points(db, employee.id, 10, "test")
    # Une autre « requête » voit encore l'ancien total chargé en mémoire.
    employee.total_points = 0
    award_points(db, employee.id, 5, "test")
    db.commit()
    db.refresh(employee)
    assert employee.total_points == 15


# ---------------------------------------------------------------- 13. Présents aujourd'hui : l'occupant, pas le réservant
def test_presents_aujourd_hui_montre_les_occupants(db, table, employee, colleague):
    """La carte affichait le réservant sur chaque place d'une table, et sur la
    place prise pour un visiteur. Les places gardées libres n'ont personne."""
    resa_svc.book_group(db, employee.id, "T7", date.today(), "DAY", [
        {"desk_id": table[0].id, "user_id": employee.id},
        {"desk_id": table[1].id, "user_id": colleague.id},
        {"desk_id": table[2].id, "name": "Paul Ext", "company": "Ext SA"},
    ])
    presents = resa_svc.presence(db, date.today())

    assert sorted(p["name"] for p in presents) == sorted([
        employee.display_name, colleague.display_name, "Paul Ext",
    ])
    assert len(presents) == 3  # une Journée = deux lignes, un seul nom par place


# ---------------------------------------------------------------- 14. Déjà là, puis réserve : pas de second « Je suis arrivé »
def test_reserver_apres_avoir_pointe_confirme_la_place(db, table, employee, colleague):
    """Arriver, pointer à l'entrée, puis prendre une place pour aujourd'hui ne
    doit pas redemander de confirmer sa présence (retour d'Olivier du 02/10/2026)."""
    attendance_svc.check_in(db, employee.id, source="kiosk")
    a_part = m.Desk(name="T8-1", zone="Open Space", is_active=True)
    db.add(a_part)
    db.commit()

    seule = resa_svc.create_reservation(
        db, employee.id, ReservationCreate(desk_id=a_part.id, reservation_date=date.today(), slot="DAY"),
    )
    assert seule.checked_in_at is not None

    lignes = resa_svc.book_group(db, colleague.id, "T7", date.today(), "AM", [
        {"desk_id": table[0].id, "user_id": colleague.id},   # pas encore arrivé
        {"desk_id": table[1].id, "user_id": employee.id},    # déjà dans les locaux
    ])
    par_occupant = {r.occupant_user_id: r for r in lignes if r.occupant_user_id}
    assert par_occupant[employee.id].checked_in_at is not None
    assert par_occupant[colleague.id].checked_in_at is None
