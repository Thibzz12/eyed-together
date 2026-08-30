"""Icône de type de poste envoyée en image plutôt que choisie parmi les emoji.

Olivier le 29/08/2026 : « Possible de mettre n'importe quoi comme GIF ou PNG
pour les icônes ? […] le smiley écran courbé ou double écran n'existe pas. »

L'image vit dans stored_images, comme le plan, parce que Render remonte un
disque neuf à chaque déploiement. La règle ne stocke que sa référence.
"""

import pytest

from app.db import models as m
from app.services import reservations as svc

# Le plus petit PNG valide : 1 pixel transparent.
PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000a49444154789c6300010000050001"
    "0d0a2db40000000049454e44ae426082"
)


def _envoyer(client, contenu=PNG_1PX, content_type="image/png", nom="icone.png"):
    return client.post(
        "/api/admin/feature-icons/image",
        files={"file": (nom, contenu, content_type)},
    )


def test_un_admin_envoie_une_image_et_recoit_sa_reference(client, admin):
    client.login_as(admin)

    res = _envoyer(client)

    assert res.status_code == 200
    assert res.json()["icon"].startswith("img:")
    assert res.json()["url"].startswith("/api/feature-icons/")


def test_un_employe_ne_peut_pas_envoyer_d_image(client, employee):
    client.login_as(employee)
    assert _envoyer(client).status_code == 403


def test_un_fichier_qui_n_est_pas_une_image_est_refuse(client, admin):
    client.login_as(admin)
    res = _envoyer(client, b"ceci est du texte", "text/plain", "note.txt")
    assert res.status_code == 400


def test_une_image_trop_lourde_est_refusee(client, admin):
    client.login_as(admin)
    res = _envoyer(client, b"\x89PNG" + b"0" * (400 * 1024))
    assert res.status_code == 400


def test_l_image_se_relit_par_son_url(client, admin, employee):
    client.login_as(admin)
    url = _envoyer(client).json()["url"]

    client.login_as(employee)   # tout le monde doit pouvoir afficher l'icône
    res = client.get(url)

    assert res.status_code == 200
    assert res.content == PNG_1PX


def test_une_image_inconnue_renvoie_404(client, employee):
    client.login_as(employee)
    assert client.get("/api/feature-icons/inexistante/image").status_code == 404


def test_une_regle_accepte_une_reference_d_image(client, admin, db):
    client.login_as(admin)
    icone = _envoyer(client).json()["icon"]

    res = client.put("/api/admin/feature-icons", json={
        "rules": [{"keyword": "double écran", "icon": icone}],
    })

    assert res.status_code == 200
    assert res.json()["rules"] == [{"keyword": "double écran", "icon": icone}]


def test_une_reference_d_image_inexistante_est_refusee(db):
    with pytest.raises(svc.ReservationError):
        svc.set_feature_icons(db, [{"keyword": "écran", "icon": "img:" + "0" * 16}])


def test_une_image_abandonnee_est_nettoyee(client, admin, db):
    """Envoyer une image puis enregistrer des règles sans elle ne doit rien laisser."""
    client.login_as(admin)
    _envoyer(client)

    client.put("/api/admin/feature-icons", json={"rules": [{"keyword": "écran", "icon": "🖥"}]})

    restantes = db.query(m.StoredImage).filter(m.StoredImage.key.like("feature_icon:%")).all()
    assert restantes == []


def test_une_image_utilisee_n_est_pas_nettoyee(client, admin, db):
    client.login_as(admin)
    icone = _envoyer(client).json()["icon"]

    client.put("/api/admin/feature-icons", json={"rules": [{"keyword": "écran", "icon": icone}]})

    assert db.get(m.StoredImage, svc.icon_image_key(icone[4:])) is not None


def test_un_emoji_reste_accepte(db):
    """L'ancien mode ne disparaît pas : une icône image ne remplace pas l'emoji."""
    svc.set_feature_icons(db, [{"keyword": "casque", "icon": "🎧"}])
    assert svc.get_feature_icons(db) == [{"keyword": "casque", "icon": "🎧"}]
