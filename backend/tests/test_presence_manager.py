"""Demandes d'Olivier du 01/09/2026 : visiteurs sans place, responsables présence.

Deux besoins de sécurité incendie :
  - déclarer plusieurs visiteurs externes sans leur réserver de place, pour
    qu'une réunion de quatre externes figure sur la liste d'évacuation ;
  - un second niveau de droits, plus étroit que le rôle admin, qui permet de
    voir qui est dans les locaux et d'exporter la liste au point de
    rassemblement quand aucun administrateur n'est présent.
"""

from app.db import models as m


# ---------------------------------------------------------------- Visiteurs sans place
def test_plusieurs_visiteurs_sans_reservation_ni_arrivee(client, employee):
    """Une réunion de quatre externes se déclare sans place et sans check-in.

    L'hôte n'a ni réservation ni arrivée confirmée : ses visiteurs doivent
    quand même tous apparaître sur la liste d'évacuation.
    """
    client.login_as(employee)

    for nom in ("Anna Peeters", "Marc Lejeune", "Sofia Ricci", "Tom Claes"):
        res = client.post("/api/visitors", json={"full_name": nom, "company": "Acme"})
        assert res.status_code == 201

    releve = client.get("/api/attendance/today").json()
    assert [v["full_name"] for v in releve["visitors"]] == [
        "Anna Peeters", "Marc Lejeune", "Sofia Ricci", "Tom Claes",
    ]
    # L'hôte, lui, n'est pas compté présent tant qu'il n'a pas confirmé.
    assert releve["employees"] == []


def test_les_visiteurs_sans_place_restent_dans_l_etat_de_l_hote(client, employee):
    client.login_as(employee)
    client.post("/api/visitors", json={"full_name": "Anna Peeters", "company": None})

    etat = client.get("/api/attendance/me").json()
    assert etat["arrived"] is False
    assert [v["full_name"] for v in etat["visitors"]] == ["Anna Peeters"]


# ---------------------------------------------------------------- Droit « présence »
def _rendre_responsable(db, user):
    user.can_manage_presence = True
    db.commit()


def test_l_export_est_ouvert_au_responsable_presence(client, db, employee):
    _rendre_responsable(db, employee)
    client.login_as(employee)

    res = client.get("/api/admin/attendance/export")
    assert res.status_code == 200
    assert "Type;Nom" in res.text


def test_l_export_reste_ferme_aux_autres_employes(client, employee):
    client.login_as(employee)
    assert client.get("/api/admin/attendance/export").status_code == 403


def test_le_droit_prend_effet_sans_reconnexion(client, db, employee):
    """Le droit se lit en base à chaque requête, pas dans la session.

    Accordé pour raison de sécurité incendie, il doit être utilisable
    immédiatement : on connecte l'employé AVANT de lui donner le droit.
    """
    client.login_as(employee)
    assert client.get("/api/admin/attendance/export").status_code == 403

    _rendre_responsable(db, employee)
    assert client.get("/api/admin/attendance/export").status_code == 200


def test_le_responsable_fait_partir_le_visiteur_d_un_autre(client, db, employee, colleague):
    client.login_as(colleague)
    visitor_id = client.post(
        "/api/visitors", json={"full_name": "Anna Peeters", "company": "Acme"}
    ).json()["id"]

    _rendre_responsable(db, employee)
    client.login_as(employee)
    assert client.post(f"/api/visitors/{visitor_id}/checkout").status_code == 200


def test_un_simple_employe_ne_fait_pas_partir_le_visiteur_d_un_autre(client, employee, colleague):
    client.login_as(colleague)
    visitor_id = client.post(
        "/api/visitors", json={"full_name": "Anna Peeters", "company": "Acme"}
    ).json()["id"]

    client.login_as(employee)
    assert client.post(f"/api/visitors/{visitor_id}/checkout").status_code == 403


def test_le_responsable_n_a_pas_les_reglages_admin(client, db, employee):
    """Le droit présence n'ouvre que l'export : le reste de l'admin reste fermé."""
    _rendre_responsable(db, employee)
    client.login_as(employee)

    assert client.get("/api/admin/attendance/settings").status_code == 403
    assert client.get("/api/admin/users").status_code == 403


# ---------------------------------------------------------------- Attribution du droit
def test_l_admin_accorde_et_retire_le_droit(client, db, admin, employee):
    client.login_as(admin)

    res = client.patch(
        f"/api/admin/users/{employee.id}/presence-role",
        json={"can_manage_presence": True},
    )
    assert res.status_code == 200
    assert res.json() == {"id": employee.id, "can_manage_presence": True}
    db.refresh(employee)
    assert employee.can_manage_presence is True

    res = client.patch(
        f"/api/admin/users/{employee.id}/presence-role",
        json={"can_manage_presence": False},
    )
    assert res.status_code == 200
    db.refresh(employee)
    assert employee.can_manage_presence is False


def test_un_employe_ne_s_accorde_pas_le_droit(client, employee):
    client.login_as(employee)
    res = client.patch(
        f"/api/admin/users/{employee.id}/presence-role",
        json={"can_manage_presence": True},
    )
    assert res.status_code == 403


def test_la_liste_des_collaborateurs_expose_le_droit(client, db, admin, employee):
    _rendre_responsable(db, employee)
    client.login_as(admin)

    users = client.get("/api/admin/users").json()
    par_id = {u["id"]: u for u in users}
    assert par_id[employee.id]["can_manage_presence"] is True
    assert par_id[admin.id]["can_manage_presence"] is False


def test_le_profil_expose_le_droit(client, db, employee):
    _rendre_responsable(db, employee)
    client.login_as(employee)
    assert client.get("/api/profile").json()["can_manage_presence"] is True
