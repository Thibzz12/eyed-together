"""Départ d'un hôte qui accompagne des visiteurs (retour d'Olivier du 01/09/2026).

Partir en oubliant ses visiteurs les laissait marqués présents jusqu'au
balayage du soir, et seul un admin pouvait corriger entre-temps. Le départ
peut maintenant emmener les visiteurs de l'hôte, et un hôte déjà parti garde
la main sur les départs de ses visiteurs.
"""


def _arriver_avec_visiteurs(client, *noms):
    client.post("/api/attendance/checkin")
    return [
        client.post("/api/visitors", json={"full_name": nom, "company": None}).json()["id"]
        for nom in noms
    ]


def test_partir_avec_ses_visiteurs(client, employee):
    client.login_as(employee)
    _arriver_avec_visiteurs(client, "Anna Peeters", "Marc Lejeune")

    etat = client.post("/api/attendance/checkout", json={"with_visitors": True}).json()
    assert etat["present"] is False
    assert all(v["present"] is False for v in etat["visitors"])

    # Plus personne sur la liste d'évacuation.
    releve = client.get("/api/attendance/today").json()
    assert releve["employees"] == []
    assert releve["visitors"] == []


def test_partir_seul_laisse_les_visiteurs_presents(client, employee):
    client.login_as(employee)
    _arriver_avec_visiteurs(client, "Anna Peeters")

    etat = client.post("/api/attendance/checkout", json={"with_visitors": False}).json()
    assert etat["present"] is False
    assert etat["visitors"][0]["present"] is True


def test_le_checkout_sans_corps_garde_son_comportement(client, employee):
    """Compatibilité : l'appel historique, sans corps JSON, ne touche personne d'autre."""
    client.login_as(employee)
    _arriver_avec_visiteurs(client, "Anna Peeters")

    res = client.post("/api/attendance/checkout")
    assert res.status_code == 200
    assert res.json()["visitors"][0]["present"] is True


def test_partir_avec_visiteurs_n_altere_pas_un_depart_deja_enregistre(client, db, employee):
    """Le départ groupé ne réécrit pas l'heure d'un visiteur déjà parti."""
    from app.db import models as m

    client.login_as(employee)
    (deja_parti,) = _arriver_avec_visiteurs(client, "Anna Peeters")
    client.post(f"/api/visitors/{deja_parti}/checkout")
    heure_de_reference = db.get(m.Visitor, deja_parti).left_at

    client.post("/api/attendance/checkout", json={"with_visitors": True})
    assert db.get(m.Visitor, deja_parti).left_at == heure_de_reference


def test_le_depart_groupe_est_un_vrai_depart_pas_une_cloture_d_office(client, db, employee):
    from app.db import models as m

    client.login_as(employee)
    (visiteur,) = _arriver_avec_visiteurs(client, "Anna Peeters")
    client.post("/api/attendance/checkout", json={"with_visitors": True})

    row = db.get(m.Visitor, visiteur)
    assert row.left_at is not None
    assert row.auto_closed is False


def test_un_hote_deja_parti_fait_encore_partir_son_visiteur(client, employee):
    """Le filet : même parti sans ses visiteurs, l'hôte garde la main sur eux."""
    client.login_as(employee)
    (visiteur,) = _arriver_avec_visiteurs(client, "Anna Peeters")
    client.post("/api/attendance/checkout")

    assert client.post(f"/api/visitors/{visiteur}/checkout").status_code == 200
    releve = client.get("/api/attendance/today").json()
    assert releve["visitors"] == []
