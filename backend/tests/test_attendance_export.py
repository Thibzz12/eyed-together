"""Export CSV de la présence du jour.

C'est le document qu'on imprime pour une évacuation : il se lit debout dans un
couloir, et la seule question qui compte est « qui est encore dans le bâtiment ».
"""

from app.services import attendance as attendance_svc


def _lignes(res):
    corps = res.content.decode("utf-8-sig")
    return corps.split("\r\n")


def test_un_employe_ne_peut_pas_exporter(client, employee):
    client.login_as(employee)
    assert client.get("/api/admin/attendance/export").status_code == 403


def test_l_export_s_ouvre_correctement_dans_excel(client, db, admin, employee):
    attendance_svc.check_in(db, employee.id)
    db.commit()
    client.login_as(admin)
    res = client.get("/api/admin/attendance/export")

    assert res.status_code == 200
    # Sans BOM, Excel lit l'UTF-8 en ANSI et « Société » devient « SociÃ©tÃ© ».
    assert res.content.startswith(b"\xef\xbb\xbf")
    # CRLF et non LF : Excel garde tout sur une seule ligne avec des LF seuls.
    assert b"\r\n" in res.content
    assert res.headers["content-disposition"].startswith("attachment; filename=presence-")


def test_l_entete_annonce_les_six_colonnes(client, admin):
    client.login_as(admin)
    assert _lignes(client.get("/api/admin/attendance/export"))[0] == (
        "Type;Nom;Société ou service;Arrivée;Départ;Statut"
    )


def test_une_personne_presente_est_annoncee_dans_les_locaux(client, db, admin, employee):
    """Le point qui comptait : ne jamais afficher un départ pour quelqu'un encore là."""
    attendance_svc.check_in(db, employee.id)
    db.commit()
    client.login_as(admin)

    ligne = next(l for l in _lignes(client.get("/api/admin/attendance/export")) if "Camille" in l)
    champs = ligne.split(";")
    assert champs[5] == "Dans les locaux"
    assert champs[4] == ""


def test_une_personne_partie_est_annoncee_partie(client, db, admin, employee):
    attendance_svc.check_in(db, employee.id)
    attendance_svc.check_out(db, employee.id)
    db.commit()
    client.login_as(admin)

    ligne = next(l for l in _lignes(client.get("/api/admin/attendance/export")) if "Camille" in l)
    assert ligne.split(";")[5] == "Parti"


def test_les_heures_sont_lisibles(client, db, admin, employee):
    """« 12:53 », pas « 2026-08-26T12:53:00.077719 » qu'Excel affiche tel quel."""
    attendance_svc.check_in(db, employee.id)
    db.commit()
    client.login_as(admin)

    arrivee = next(l for l in _lignes(client.get("/api/admin/attendance/export")) if "Camille" in l).split(";")[3]
    assert len(arrivee) == 5 and arrivee[2] == ":"
    assert arrivee[:2].isdigit() and arrivee[3:].isdigit()


def test_un_visiteur_apparait_avec_sa_societe_et_son_hote(client, db, admin, employee):
    attendance_svc.check_in(db, employee.id)
    attendance_svc.add_visitor(db, employee.id, "Jean Dupuis", "Acme")
    db.commit()
    client.login_as(admin)

    ligne = next(l for l in _lignes(client.get("/api/admin/attendance/export")) if "Jean Dupuis" in l)
    champs = ligne.split(";")
    assert champs[0] == "Visiteur (reçu par Camille Dupont)"
    assert champs[2] == "Acme"
    assert champs[5] == "Dans les locaux"


def test_un_point_virgule_dans_un_nom_ne_casse_pas_les_colonnes(client, db, admin, employee):
    """Un nom de société avec un « ; » décalerait toutes les colonnes suivantes."""
    attendance_svc.check_in(db, employee.id)
    attendance_svc.add_visitor(db, employee.id, "Jean Dupuis", "Durand; et Fils")
    db.commit()
    client.login_as(admin)

    ligne = next(l for l in _lignes(client.get("/api/admin/attendance/export")) if "Jean Dupuis" in l)
    assert '"Durand; et Fils"' in ligne
    # Sans échappement, la ligne compterait une colonne de plus.
    assert ligne.count(";") == 6
