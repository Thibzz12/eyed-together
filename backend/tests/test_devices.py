"""Appareils partagés (demande d'Olivier du 02/10/2026) : un grand écran affiche
le plan du jour sans que personne ne se connecte dessus.

Le lien secret tient lieu d'authentification : généré et révoqué par un
administrateur, il donne accès au plan et à rien d'autre.
"""

from datetime import date

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import attendance as attendance_svc
from app.services import devices as devices_svc
from app.services import reservations as resa_svc


def _poste(db, nom="T1-1", zone="Open Space", x=10.0, y=20.0):
    d = m.Desk(name=nom, zone=zone, is_active=True, pos_x=x, pos_y=y)
    db.add(d)
    db.commit()
    return d


# ---------------------------------------------------------------- Administration des liens
def test_la_creation_d_un_lien_est_reservee_aux_admins(client, employee):
    client.login_as(employee)
    rep = client.post("/api/admin/devices", json={"kind": "screen", "label": "Couloir"})
    assert rep.status_code == 403


def test_un_admin_cree_un_lien_d_ecran(client, admin):
    client.login_as(admin)
    rep = client.post("/api/admin/devices", json={"kind": "screen", "label": "Écran du couloir"})
    assert rep.status_code == 201
    lien = rep.json()
    assert lien["kind"] == "screen"
    assert lien["label"] == "Écran du couloir"
    assert "/ecran/" in lien["url"]
    assert lien["revoked_at"] is None

    liste = client.get("/api/admin/devices").json()
    assert [l["id"] for l in liste] == [lien["id"]]


def test_un_nom_vide_est_refuse(client, admin):
    client.login_as(admin)
    rep = client.post("/api/admin/devices", json={"kind": "screen", "label": "   "})
    assert rep.status_code in (400, 422)


# ---------------------------------------------------------------- Accès par le lien
def _token(url: str) -> str:
    return url.rsplit("/", 1)[1]


def test_le_lien_donne_le_plan_du_jour_sans_session(client, db, admin, employee):
    poste = _poste(db)
    resa_svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=poste.id, reservation_date=date.today(), slot="DAY",
    ))
    lien = devices_svc.create_link(db, "screen", "Couloir", admin.id)

    # Personne n'est connecté : l'écran parle seul au serveur, avec son jeton.
    rep = client.get(f"/api/screen/{lien.token}/today?slot=AM")
    assert rep.status_code == 200
    data = rep.json()
    assert data["date"] == date.today().isoformat()
    assert data["slot"] == "AM"
    assert data["label"] == "Couloir"
    assert data["floorplan_version"]
    assert data["stats"] == {"reserved": 1, "free": 0}
    assert data["desks"] == [{
        "id": poste.id, "name": "T1-1", "zone": "Open Space", "pos_x": 10.0, "pos_y": 20.0,
        "state": "occupied", "occupant": "Camille Dupont",
    }]


def test_les_places_non_positionnees_et_les_bulles_sont_ignorees(client, db, admin):
    _poste(db, "T2-1", x=None, y=None)
    _poste(db, "BC-1", zone="Bulles calmes", x=50.0, y=50.0)
    _poste(db, "T3-1", x=30.0, y=40.0)
    client.login_as(admin)
    token = _token(client.post("/api/admin/devices", json={"kind": "screen", "label": "Couloir"}).json()["url"])

    data = client.get(f"/api/screen/{token}/today?slot=PM").json()
    assert [d["name"] for d in data["desks"]] == ["T3-1"]
    assert data["desks"][0]["state"] == "free"
    assert data["stats"] == {"reserved": 0, "free": 1}


def test_le_lien_donne_aussi_l_image_du_plan(client, admin):
    client.login_as(admin)
    token = _token(client.post("/api/admin/devices", json={"kind": "screen", "label": "Couloir"}).json()["url"])
    rep = client.get(f"/api/screen/{token}/floorplan")
    assert rep.status_code == 200
    assert rep.headers["content-type"].startswith("image/")


def test_un_jeton_inconnu_est_refuse(client):
    assert client.get("/api/screen/pas-un-vrai-jeton/today").status_code == 404
    assert client.get("/api/screen/pas-un-vrai-jeton/floorplan").status_code == 404


def test_un_lien_revoque_ne_fonctionne_plus(client, admin):
    client.login_as(admin)
    lien = client.post("/api/admin/devices", json={"kind": "screen", "label": "Couloir"}).json()
    token = _token(lien["url"])
    assert client.get(f"/api/screen/{token}/today").status_code == 200

    assert client.delete(f"/api/admin/devices/{lien['id']}").status_code == 204
    assert client.get(f"/api/screen/{token}/today").status_code == 404
    # Il reste visible dans la liste, marqué révoqué : la trace sert à l'admin.
    revoque = next(l for l in client.get("/api/admin/devices").json() if l["id"] == lien["id"])
    assert revoque["revoked_at"] is not None


def test_le_passage_de_l_ecran_est_note(client, db, admin):
    client.login_as(admin)
    lien = client.post("/api/admin/devices", json={"kind": "screen", "label": "Couloir"}).json()
    assert lien["last_seen_at"] is None
    client.get(f"/api/screen/{_token(lien['url'])}/today")
    vu = next(l for l in client.get("/api/admin/devices").json() if l["id"] == lien["id"])
    assert vu["last_seen_at"] is not None


def test_un_lien_de_tablette_n_ouvre_pas_l_ecran(client, db, admin):
    """Les deux types de lien ne sont pas interchangeables : un jeton de
    pointage ne doit pas servir à afficher le plan, et inversement."""
    lien = devices_svc.create_link(db, "kiosk", "Tablette entrée", admin.id)
    assert client.get(f"/api/screen/{lien.token}/today").status_code == 404


# ---------------------------------------------------------------- Personnalisation
def test_l_ecran_a_des_reglages_par_defaut(client, db, admin):
    lien = devices_svc.create_link(db, "screen", "Couloir", admin.id)
    data = client.get(f"/api/screen/{lien.token}/today").json()
    assert data["settings"] == {
        "title": "Plan du jour", "message": "", "preset": "sombre",
        "colors": {"bg1": "#0F2836", "bg2": "#04141D", "text": "#FFFFFF", "accent": "#7EC8E3"},
        "bg_dim": 60, "show_clock": True, "show_stats": True, "show_legend": True, "show_logo": True,
        "plan_size": "auto", "has_background": False, "background_version": None,
    }


def test_l_admin_personnalise_l_ecran_et_l_ecran_le_recoit(client, db, admin):
    client.login_as(admin)
    rep = client.put("/api/admin/screen-settings", json={
        "title": "Bienvenue chez EyeD", "message": "Réunion d'équipe 14h, salle 2",
        "preset": "perso", "colors": {"bg1": "#123456", "bg2": "#654321", "text": "#FFFFFF", "accent": "#ABCDEF"},
        "bg_dim": 35, "show_clock": False, "show_stats": True, "show_legend": False, "show_logo": False,
        "plan_size": "large",
    })
    assert rep.status_code == 200
    assert rep.json()["colors"]["bg1"] == "#123456"
    assert client.get("/api/admin/screen-settings").json()["title"] == "Bienvenue chez EyeD"

    lien = devices_svc.create_link(db, "screen", "Couloir", admin.id)
    reglages = client.get(f"/api/screen/{lien.token}/today").json()["settings"]
    assert reglages["message"] == "Réunion d'équipe 14h, salle 2"
    assert reglages["show_clock"] is False
    assert reglages["show_logo"] is False
    assert reglages["plan_size"] == "large"
    assert reglages["bg_dim"] == 35


def test_une_couleur_invalide_est_refusee(client, admin):
    client.login_as(admin)
    rep = client.put("/api/admin/screen-settings", json={"colors": {"bg1": "rouge"}})
    assert rep.status_code == 422
    assert client.put("/api/admin/screen-settings", json={"preset": "fluo"}).status_code == 422


_PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0"
    "0000030101001b7e6e8f0000000049454e44ae426082"
)


def test_l_image_de_fond_se_pose_se_sert_et_se_retire(client, db, admin):
    client.login_as(admin)
    lien = devices_svc.create_link(db, "screen", "Couloir", admin.id)
    assert client.get(f"/api/screen/{lien.token}/background").status_code == 404

    rep = client.post("/api/admin/screen-background", files={"file": ("fond.png", _PNG_1PX, "image/png")})
    assert rep.status_code == 200
    assert rep.json()["version"]

    reglages = client.get(f"/api/screen/{lien.token}/today").json()["settings"]
    assert reglages["has_background"] is True
    assert reglages["background_version"] == rep.json()["version"]
    image = client.get(f"/api/screen/{lien.token}/background")
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"

    assert client.delete("/api/admin/screen-background").status_code == 204
    assert client.get(f"/api/screen/{lien.token}/background").status_code == 404
    assert client.get(f"/api/screen/{lien.token}/today").json()["settings"]["has_background"] is False


def test_seule_la_page_ecran_accepte_d_etre_encadree_par_nous(client):
    """L'administration affiche l'écran en aperçu dans un cadre : la page de
    l'écran doit l'accepter, mais seulement depuis notre propre origine, et le
    reste du site reste interdit d'encadrement."""
    ecran = client.get("/ecran/nimportequoi")
    assert ecran.status_code == 200
    assert ecran.headers["x-frame-options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in ecran.headers["content-security-policy"]

    accueil = client.get("/")
    assert accueil.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in accueil.headers["content-security-policy"]
    assert "frame-src 'self'" in accueil.headers["content-security-policy"]


def test_l_apercu_admin_donne_le_meme_plan(client, db, admin):
    client.login_as(admin)
    data = client.get("/api/admin/screen-preview").json()
    assert data["label"] == "Aperçu"
    assert "desks" in data and "settings" in data and data["floorplan_version"]


def test_la_personnalisation_est_reservee_aux_admins(client, employee):
    client.login_as(employee)
    assert client.get("/api/admin/screen-settings").status_code == 403
    assert client.put("/api/admin/screen-settings", json={"title": "x"}).status_code == 403


# ---------------------------------------------------------------- Tablette de pointage
def _tablette(db, admin):
    return devices_svc.create_link(db, "kiosk", "Tablette entrée", admin.id)


def test_le_lien_de_tablette_mene_a_la_page_de_pointage(client, admin):
    client.login_as(admin)
    lien = client.post("/api/admin/devices", json={"kind": "kiosk", "label": "Tablette entrée"}).json()
    assert "/pointage/" in lien["url"]
    assert client.get("/pointage/" + lien["url"].rsplit("/", 1)[1]).status_code == 200


def test_la_tablette_liste_tout_le_monde_avec_l_etat_du_jour(client, db, admin, employee, colleague):
    poste = _poste(db)
    resa_svc.create_reservation(db, employee.id, ReservationCreate(
        desk_id=poste.id, reservation_date=date.today(), slot="AM",
    ))
    attendance_svc.check_in(db, colleague.id)
    lien = _tablette(db, admin)

    data = client.get(f"/api/kiosk/{lien.token}/today").json()
    assert data["date"] == date.today().isoformat()
    assert data["present_count"] == 1
    par_nom = {p["name"]: p for p in data["people"]}
    assert par_nom["Camille Dupont"] == {
        "id": employee.id, "name": "Camille Dupont", "state": "absent", "expected": True, "visitors_present": 0,
    }
    assert par_nom["Alex Martin"]["state"] == "present"
    assert par_nom["Alex Martin"]["expected"] is False
    assert par_nom["Olivier Vanbrabant"]["state"] == "absent"


def test_pointer_sur_la_tablette_est_une_vraie_arrivee(client, db, admin, employee):
    lien = _tablette(db, admin)
    depart = employee.total_points

    rep = client.post(f"/api/kiosk/{lien.token}/checkin", json={"user_id": employee.id})
    assert rep.status_code == 200
    assert rep.json() == {"id": employee.id, "name": "Camille Dupont", "state": "present"}

    ligne = db.query(m.Attendance).filter_by(user_id=employee.id).one()
    assert ligne.source == "kiosk"
    assert ligne.left_at is None
    db.refresh(employee)
    assert employee.total_points == depart + 5  # même règle que le pop-up

    # Le départ depuis la tablette ferme la même ligne.
    rep = client.post(f"/api/kiosk/{lien.token}/checkout", json={"user_id": employee.id})
    assert rep.status_code == 200 and rep.json()["state"] == "left"
    db.refresh(ligne)
    assert ligne.left_at is not None and ligne.auto_closed is False


def test_le_depart_depuis_la_tablette_demande_apres_les_visiteurs(client, db, admin, employee):
    """Le bug du 01/09/2026 ne doit pas revenir par la tablette : l'hôte dit si
    ses visiteurs partent avec lui, et la liste les compte pour poser la question."""
    lien = _tablette(db, admin)
    attendance_svc.check_in(db, employee.id)
    attendance_svc.add_visitor(db, employee.id, "Paul Externe", "ACME")

    moi = next(p for p in client.get(f"/api/kiosk/{lien.token}/today").json()["people"] if p["id"] == employee.id)
    assert moi["visitors_present"] == 1

    client.post(f"/api/kiosk/{lien.token}/checkout", json={"user_id": employee.id, "with_visitors": True})
    visiteur = db.query(m.Visitor).one()
    assert visiteur.left_at is not None and visiteur.auto_closed is False


def test_la_page_tablette_est_toujours_revalidee(client):
    assert client.get("/pointage/abc").headers["cache-control"] == "no-cache"


def test_les_prereglages_de_couleurs_viennent_du_serveur(client, admin):
    client.login_as(admin)
    data = client.get("/api/admin/screen-settings").json()
    assert set(data["presets"]) == {"sombre", "clair", "eyed"}
    assert data["presets"]["eyed"]["bg1"] == "#00608D"


def test_partir_sans_etre_arrive_est_refuse(client, db, admin, employee):
    lien = _tablette(db, admin)
    rep = client.post(f"/api/kiosk/{lien.token}/checkout", json={"user_id": employee.id})
    assert rep.status_code == 404


def test_une_personne_inconnue_est_refusee(client, db, admin):
    lien = _tablette(db, admin)
    assert client.post(f"/api/kiosk/{lien.token}/checkin", json={"user_id": 99999}).status_code == 404


def test_un_lien_d_ecran_n_ouvre_pas_la_tablette(client, db, admin, employee):
    ecran = devices_svc.create_link(db, "screen", "Couloir", admin.id)
    assert client.get(f"/api/kiosk/{ecran.token}/today").status_code == 404
    assert client.post(f"/api/kiosk/{ecran.token}/checkin", json={"user_id": employee.id}).status_code == 404


def test_le_creneau_suit_l_heure():
    from datetime import datetime
    assert devices_svc.current_slot(datetime(2026, 10, 6, 9, 30)) == "AM"
    assert devices_svc.current_slot(datetime(2026, 10, 6, 13, 0)) == "PM"
