"""Envoi du plan des locaux depuis l'administration.

Le plan est conservé en base et non sur le disque : Render remonte un système
de fichiers neuf à chaque déploiement, un fichier déposé y disparaîtrait à la
mise à jour suivante.
"""

import io

# Un PNG valide d'un pixel, suffisant pour vérifier tout le trajet.
PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)


def test_le_plan_par_defaut_est_servi_sans_envoi(client, employee):
    """Tant que rien n'a été envoyé, on sert l'image livrée avec l'application."""
    client.login_as(employee)
    res = client.get("/api/floorplan")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("image/")


def test_un_employe_ne_peut_pas_remplacer_le_plan(client, employee):
    client.login_as(employee)
    res = client.post(
        "/api/admin/floorplan",
        files={"file": ("plan.png", io.BytesIO(PNG_1PX), "image/png")},
    )
    assert res.status_code == 403


def test_un_admin_remplace_le_plan(client, admin):
    client.login_as(admin)
    res = client.post(
        "/api/admin/floorplan",
        files={"file": ("plan.png", io.BytesIO(PNG_1PX), "image/png")},
    )

    assert res.status_code == 200
    assert res.json()["bytes"] == len(PNG_1PX)

    servi = client.get("/api/floorplan")
    assert servi.content == PNG_1PX
    assert servi.headers["content-type"] == "image/png"


def test_le_plan_envoye_survit_a_un_second_envoi(client, admin):
    client.login_as(admin)
    client.post("/api/admin/floorplan", files={"file": ("a.png", io.BytesIO(PNG_1PX), "image/png")})

    autre = PNG_1PX + b"\x00"
    client.post("/api/admin/floorplan", files={"file": ("b.png", io.BytesIO(autre), "image/png")})

    assert client.get("/api/floorplan").content == autre


def test_un_fichier_qui_n_est_pas_une_image_est_refuse(client, admin):
    client.login_as(admin)
    res = client.post(
        "/api/admin/floorplan",
        files={"file": ("plan.pdf", io.BytesIO(b"%PDF-1.4 pas une image"), "application/pdf")},
    )
    assert res.status_code == 400


def test_une_image_trop_lourde_est_refusee(client, admin):
    """Garde-fou : la base n'est pas un espace de stockage de fichiers."""
    client.login_as(admin)
    gros = PNG_1PX + b"\x00" * (6 * 1024 * 1024)
    res = client.post(
        "/api/admin/floorplan",
        files={"file": ("enorme.png", io.BytesIO(gros), "image/png")},
    )
    assert res.status_code == 400
