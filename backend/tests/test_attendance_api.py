"""Routes de présence : contrat HTTP et autorisations."""

from app.services import attendance as svc


def test_etat_du_jour_exige_une_session(client):
    assert client.get("/api/attendance/me").status_code == 401


def test_arriver_puis_consulter_son_etat(client, employee):
    client.login_as(employee)

    assert client.post("/api/attendance/checkin").status_code == 200

    etat = client.get("/api/attendance/me").json()
    assert etat["arrived"] is True
    assert etat["present"] is True


def test_partir(client, employee):
    client.login_as(employee)
    client.post("/api/attendance/checkin")

    assert client.post("/api/attendance/checkout").status_code == 200
    assert client.get("/api/attendance/me").json()["present"] is False


def test_partir_sans_etre_arrive_renvoie_404(client, employee):
    client.login_as(employee)
    assert client.post("/api/attendance/checkout").status_code == 404


def test_liste_du_jour(client, employee):
    client.login_as(employee)
    client.post("/api/attendance/checkin")

    data = client.get("/api/attendance/today").json()
    assert data["employees"][0]["name"] == "Camille Dupont"
    assert "arrived_at" not in data["employees"][0]


def test_declarer_un_visiteur(client, employee):
    client.login_as(employee)

    res = client.post("/api/visitors", json={"full_name": "Jean Dupont", "company": "Acme"})
    assert res.status_code == 201
    assert res.json()["full_name"] == "Jean Dupont"

    data = client.get("/api/attendance/today").json()
    assert data["visitors"][0]["host_name"] == "Camille Dupont"


def test_visiteur_sans_nom_renvoie_422(client, employee):
    """La longueur minimale est vérifiée par Pydantic, avant le service."""
    client.login_as(employee)
    assert client.post("/api/visitors", json={"full_name": ""}).status_code == 422


def test_visiteur_avec_un_nom_d_espaces_renvoie_400(client, employee):
    """Pydantic laisse passer les espaces : c'est le service qui refuse."""
    client.login_as(employee)
    assert client.post("/api/visitors", json={"full_name": "   "}).status_code == 400


def test_faire_partir_le_visiteur_d_un_autre_renvoie_403(client, employee, colleague):
    client.login_as(employee)
    visitor_id = client.post("/api/visitors", json={"full_name": "Jean Dupont"}).json()["id"]

    client.login_as(colleague)
    assert client.post(f"/api/visitors/{visitor_id}/checkout").status_code == 403


def test_faire_partir_son_visiteur(client, employee):
    client.login_as(employee)
    visitor_id = client.post("/api/visitors", json={"full_name": "Jean Dupont"}).json()["id"]

    assert client.post(f"/api/visitors/{visitor_id}/checkout").status_code == 200
    assert client.get("/api/attendance/today").json()["visitors"] == []


def test_l_export_est_refuse_a_un_employe(client, employee):
    client.login_as(employee)
    assert client.get("/api/admin/attendance/export").status_code == 403


def test_l_export_admin_liste_employes_et_visiteurs(client, employee, admin):
    client.login_as(employee)
    client.post("/api/attendance/checkin")
    client.post("/api/visitors", json={"full_name": "Jean Dupont", "company": "Acme"})

    client.login_as(admin)
    res = client.get("/api/admin/attendance/export")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/csv")
    corps = res.text
    assert "Camille Dupont" in corps
    assert "Jean Dupont" in corps
    assert "Acme" in corps


def test_reglage_de_l_heure_de_cloture(client, admin, db):
    client.login_as(admin)

    res = client.patch("/api/admin/attendance/settings", json={"auto_close_hour": 20})
    assert res.status_code == 200
    assert svc.get_auto_close_hour(db) == 20


def test_reglage_hors_bornes_refuse(client, admin):
    client.login_as(admin)
    assert client.patch("/api/admin/attendance/settings", json={"auto_close_hour": 30}).status_code == 422


# ---------------------------------------------------------------- Page Récompenses
def test_les_recompenses_exigent_une_session(client):
    assert client.get("/api/rewards").status_code == 401


def test_les_recompenses_donnent_le_bareme_et_les_badges(client, employee):
    client.login_as(employee)
    data = client.get("/api/rewards").json()

    assert data["total_points"] == 0
    assert isinstance(data["badges"], list)
    labels = [r["label"] for r in data["rules"]]
    assert any("arrivée" in l for l in labels)
    assert any("sans venir" in l for l in labels)


def test_le_bareme_expose_les_vraies_valeurs(client, employee):
    """Le barème doit venir des constantes, pas de chiffres recopiés."""
    from app.services.gamification import POINTS_PER_BOOKING, POINTS_PER_CHECKIN
    from app.services.reservations import NOSHOW_PENALTY

    client.login_as(employee)
    regles = {r["label"]: r["points"] for r in client.get("/api/rewards").json()["rules"]}

    assert regles["Réserver une place pour une demi-journée"] == POINTS_PER_BOOKING
    assert regles["Réserver une place pour la journée entière"] == POINTS_PER_BOOKING * 2
    assert regles["Confirmer ton arrivée dans les locaux"] == POINTS_PER_CHECKIN
    assert regles["Réserver sans venir, sans confirmer sa présence"] == -NOSHOW_PENALTY


def test_les_points_gagnes_remontent_dans_les_recompenses(client, employee):
    client.login_as(employee)
    client.post("/api/attendance/checkin")

    from app.services.gamification import POINTS_PER_CHECKIN
    assert client.get("/api/rewards").json()["total_points"] == POINTS_PER_CHECKIN
