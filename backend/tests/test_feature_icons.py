"""Icônes d'équipement, choisies par l'administrateur.

Les règles étaient figées dans app.js : ajouter un type de poste imposait de
modifier le code. Olivier veut pouvoir le faire depuis l'administration.
"""

import pytest

from app.services import reservations as svc


def test_des_regles_existent_par_defaut(db):
    regles = svc.get_feature_icons(db)
    assert len(regles) > 0
    assert all({"keyword", "icon"} <= set(r) for r in regles)


def test_un_ecran_est_reconnu_par_defaut(db):
    mots = [r["keyword"].lower() for r in svc.get_feature_icons(db)]
    assert any("cran" in mot for mot in mots)


def test_les_regles_se_remplacent(db):
    svc.set_feature_icons(db, [
        {"keyword": "courbé", "icon": "🖥"},
        {"keyword": "docking", "icon": "🔌"},
    ])

    regles = svc.get_feature_icons(db)
    assert [r["keyword"] for r in regles] == ["courbé", "docking"]


def test_une_regle_sans_mot_cle_est_refusee(db):
    with pytest.raises(svc.ReservationError):
        svc.set_feature_icons(db, [{"keyword": "  ", "icon": "🔌"}])


def test_une_regle_sans_icone_est_refusee(db):
    with pytest.raises(svc.ReservationError):
        svc.set_feature_icons(db, [{"keyword": "docking", "icon": ""}])


def test_l_api_expose_les_regles(client, employee):
    client.login_as(employee)
    res = client.get("/api/feature-icons")

    assert res.status_code == 200
    assert len(res.json()["rules"]) > 0


def test_seul_un_admin_modifie_les_regles(client, employee, admin, db):
    corps = {"rules": [{"keyword": "docking", "icon": "🔌"}]}

    client.login_as(employee)
    assert client.put("/api/admin/feature-icons", json=corps).status_code == 403

    client.login_as(admin)
    assert client.put("/api/admin/feature-icons", json=corps).status_code == 200
    assert svc.get_feature_icons(db) == [{"keyword": "docking", "icon": "🔌"}]
