"""Réservation d'un groupe entier (table de l'open space ou salle fermée).

Bloquer une table entière retire quatre à six places du planning d'un coup :
celui qui réserve doit dire qui s'y installera.
"""

from datetime import date, timedelta

import pytest

from app.db import models as m
from app.services import reservations as svc


@pytest.fixture
def desks(db):
    """Une table de 4 places dans l'open space et une salle fermée de 3 places."""
    postes = [
        m.Desk(name="T1-1", zone="Open Space", features="Table 1"),
        m.Desk(name="T1-2", zone="Open Space", features="Table 1"),
        m.Desk(name="T1-3", zone="Open Space", features="Table 1"),
        m.Desk(name="T1-4", zone="Open Space", features="Table 1"),
        m.Desk(name="T2-1", zone="Open Space", features="Table 2"),
        m.Desk(name="B1-1", zone="Bureau 1"),
        m.Desk(name="B1-2", zone="Bureau 1"),
        m.Desk(name="B1-3", zone="Bureau 1"),
    ]
    db.add_all(postes)
    db.commit()
    return {d.name: d for d in postes}


@pytest.fixture
def demain():
    """Le prochain jour ouvré : la réservation est refusée le week-end."""
    d = date.today() + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def _occupants(desks, noms):
    return [{"desk_id": desks[n].id, "user_id": u, "name": None, "company": None} for n, u in noms]


def test_reserver_une_table_prend_tous_ses_postes(db, employee, desks, demain):
    svc.book_group(db, employee.id, "T1", demain, "AM",
                   _occupants(desks, [("T1-1", employee.id)]))

    prises = db.query(m.Reservation).filter_by(reservation_date=demain).all()
    assert {r.desk.name for r in prises} == {"T1-1", "T1-2", "T1-3", "T1-4"}


def test_reserver_une_table_ne_touche_pas_les_autres_tables(db, employee, desks, demain):
    svc.book_group(db, employee.id, "T1", demain, "AM",
                   _occupants(desks, [("T1-1", employee.id)]))

    noms = {r.desk.name for r in db.query(m.Reservation).all()}
    assert "T2-1" not in noms


def test_une_salle_fermee_reste_reservable_par_groupe(db, employee, desks, demain):
    svc.book_group(db, employee.id, "Bureau 1", demain, "AM",
                   _occupants(desks, [("B1-1", employee.id)]))

    assert db.query(m.Reservation).count() == 3


def test_les_occupants_sont_enregistres(db, employee, colleague, desks, demain):
    svc.book_group(db, employee.id, "T1", demain, "AM", [
        {"desk_id": desks["T1-1"].id, "user_id": employee.id, "name": None, "company": None},
        {"desk_id": desks["T1-2"].id, "user_id": colleague.id, "name": None, "company": None},
        {"desk_id": desks["T1-3"].id, "user_id": None, "name": "Jean Dupont", "company": "Acme"},
    ])

    par_poste = {r.desk.name: r for r in db.query(m.Reservation).all()}
    assert par_poste["T1-1"].occupant_user_id == employee.id
    assert par_poste["T1-2"].occupant_user_id == colleague.id
    assert par_poste["T1-3"].occupant_name == "Jean Dupont"
    assert par_poste["T1-3"].occupant_company == "Acme"
    # La 4e place reste volontairement libre.
    assert par_poste["T1-4"].occupant_user_id is None
    assert par_poste["T1-4"].occupant_name is None


def test_reserver_un_groupe_sans_dire_qui_sera_la_est_refuse(db, employee, desks, demain):
    """Le point insistant du retour d'Olivier : on ne bloque pas six places en silence."""
    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, "T1", demain, "AM", [])

    assert db.query(m.Reservation).count() == 0


def test_un_occupant_sur_un_poste_hors_du_groupe_est_refuse(db, employee, desks, demain):
    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, "T1", demain, "AM",
                       _occupants(desks, [("T2-1", employee.id)]))

    assert db.query(m.Reservation).count() == 0


def test_deux_occupants_sur_le_meme_poste_sont_refuses(db, employee, colleague, desks, demain):
    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, "T1", demain, "AM",
                       _occupants(desks, [("T1-1", employee.id), ("T1-1", colleague.id)]))


def test_une_table_deja_partiellement_prise_est_refusee(db, employee, colleague, desks, demain):
    db.add(m.Reservation(user_id=colleague.id, desk_id=desks["T1-3"].id,
                         reservation_date=demain, slot=m.ReservationSlot.AM))
    db.commit()

    with pytest.raises(svc.SlotConflict):
        svc.book_group(db, employee.id, "T1", demain, "AM",
                       _occupants(desks, [("T1-1", employee.id)]))


def test_un_groupe_inconnu_est_refuse(db, employee, desks, demain):
    with pytest.raises(svc.DeskNotFound):
        svc.book_group(db, employee.id, "T9", demain, "AM",
                       _occupants(desks, [("T1-1", employee.id)]))


def test_les_points_ne_sont_pas_multiplies_par_le_nombre_de_places(db, employee, desks, demain):
    """Réserver une table de 4 ne doit pas rapporter 4 fois plus qu'une place."""
    svc.book_group(db, employee.id, "T1", demain, "AM",
                   _occupants(desks, [("T1-1", employee.id)]))

    db.refresh(employee)
    assert employee.total_points == svc.POINTS_PER_BOOKING


def test_les_groupes_reservables_sont_listes(db, desks):
    refs = {g["ref"] for g in svc.bookable_groups(db)}
    assert {"T1", "T2", "Bureau 1"} <= refs


def test_un_groupe_liste_ses_places_et_son_libelle(db, desks):
    groupes = {g["ref"]: g for g in svc.bookable_groups(db)}
    assert groupes["T1"]["seats"] == 4
    assert groupes["T1"]["label"] == "Table 1"
    assert groupes["Bureau 1"]["seats"] == 3


# ---------------------------------------------------------------- Contrat HTTP
def test_l_api_liste_les_espaces(client, employee, desks):
    client.login_as(employee)
    data = client.get("/api/spaces").json()

    refs = {g["ref"] for g in data["groups"]}
    assert {"T1", "Bureau 1"} <= refs
    assert data["modes"]["table"] is True


def test_l_api_reserve_une_table_avec_occupants(client, employee, colleague, desks, demain):
    client.login_as(employee)
    res = client.post("/api/reservations/group", json={
        "ref": "T1",
        "reservation_date": demain.isoformat(),
        "slot": "AM",
        "occupants": [
            {"desk_id": desks["T1-1"].id, "user_id": employee.id},
            {"desk_id": desks["T1-2"].id, "name": "Jean Dupont", "company": "Acme"},
        ],
    })

    assert res.status_code == 201
    assert len(res.json()) == 4


def test_l_api_refuse_une_table_sans_occupant(client, employee, desks, demain):
    client.login_as(employee)
    res = client.post("/api/reservations/group", json={
        "ref": "T1", "reservation_date": demain.isoformat(), "slot": "AM", "occupants": [],
    })

    assert res.status_code == 400
    assert "occupera" in res.json()["detail"]


def test_seul_un_admin_ferme_un_mode(client, employee, admin, db):
    client.login_as(employee)
    assert client.patch("/api/admin/booking-modes", json={"mode": "table", "enabled": False}).status_code == 403

    client.login_as(admin)
    assert client.patch("/api/admin/booking-modes", json={"mode": "table", "enabled": False}).status_code == 200
    assert svc.get_booking_toggles(db)["table"] is False


def test_seul_un_admin_grise_un_espace(client, employee, admin, db, desks):
    corps = {"scope": "space", "target": "T1", "enabled": False}

    client.login_as(employee)
    assert client.patch("/api/admin/availability", json=corps).status_code == 403

    client.login_as(admin)
    assert client.patch("/api/admin/availability", json=corps).status_code == 200
    assert svc.is_group_enabled(db, "T1") is False


def test_l_annuaire_ne_divulgue_pas_les_donnees_personnelles(client, employee, colleague):
    client.login_as(employee)
    gens = client.get("/api/colleagues").json()

    assert {g["name"] for g in gens} == {"Camille Dupont", "Alex Martin"}
    assert all("email" not in g and "birthday" not in g for g in gens)


def test_l_annuaire_exige_une_session(client):
    assert client.get("/api/colleagues").status_code == 401


def test_reserver_toute_la_table_est_reconnu_comme_tel(db, employee, desks, demain):
    svc.book_group(db, employee.id, "T1", demain, "AM",
                   _occupants(desks, [("T1-1", employee.id)]))

    assert len(svc.my_group_reservation_ids(db, employee.id, "T1", demain)) == 4


def test_reserver_une_seule_place_n_est_pas_reserver_la_table(db, employee, desks, demain):
    from app.schemas import ReservationCreate

    svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=desks["T1-1"].id, reservation_date=demain, slot="AM"))

    assert svc.my_group_reservation_ids(db, employee.id, "T1", demain) == []


def test_une_place_gardee_vide_n_est_pas_attribuee_au_reservant(db, employee, desks, demain):
    """Bloquer une place sans y installer personne ne veut pas dire s'y installer soi-même."""
    from datetime import date as _d

    svc.book_group(db, employee.id, "T1", demain, "AM",
                   _occupants(desks, [("T1-1", employee.id)]))

    par_poste = {d.name: (b, o) for d, b, o, _ferme in svc.get_availability(db, demain, "AM")}
    assert par_poste["T1-1"] == ("Camille Dupont", "Camille Dupont")
    assert par_poste["T1-4"] == ("Camille Dupont", None)   # bloquée, mais personne dessus


def test_une_reservation_individuelle_designe_bien_son_auteur(db, employee, desks, demain):
    from app.schemas import ReservationCreate

    svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=desks["T2-1"].id, reservation_date=demain, slot="AM"))

    par_poste = {d.name: (b, o) for d, b, o, _ferme in svc.get_availability(db, demain, "AM")}
    assert par_poste["T2-1"] == ("Camille Dupont", "Camille Dupont")
