"""Disponibilité d'une place ou d'un espace, éventuellement datée.

Reformulation de la demande d'Olivier par Thibaud : « on doit être capable de
désactiver temporairement la réservation de la place T1 par exemple car le
bureau est cassé, et faire pareil pour une salle entière ; on doit pouvoir
choisir ce qu'on désactive », puis « on doit pouvoir définir à quelle date c'est
indisponible ».

Un seul geste pour les deux échelles : `set_availability`. Le bureau cassé n'est
qu'une raison parmi d'autres, ce n'est pas un concept à part.
"""

from datetime import date, time, timedelta

import pytest

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import reservations as svc


@pytest.fixture
def locaux(db):
    postes = [
        m.Desk(name="T1-1", zone="Open Space", floor="Rez", is_active=True),
        m.Desk(name="T1-2", zone="Open Space", floor="Rez", is_active=True),
        m.Desk(name="T1-3", zone="Open Space", floor="Rez", is_active=True),
        m.Desk(name="B2-1", zone="Bureau 2", floor="Rez", is_active=True),
        m.Desk(name="B2-2", zone="Bureau 2", floor="Rez", is_active=True),
        m.Desk(name="BC-1", zone="Bulles calmes", floor="Rez", is_active=True),
    ]
    db.add_all(postes)
    db.commit()
    return {d.name: d for d in postes}


def _ouvrable(decalage: int = 1) -> date:
    jour = date.today() + timedelta(days=decalage)
    while jour.weekday() >= 5:
        jour += timedelta(days=1)
    return jour


def _reserver(db, employee, poste, jour):
    return svc.create_reservation(
        db, employee.id, ReservationCreate(desk_id=poste.id, reservation_date=jour, slot="AM")
    )


# ---------------------------------------------------------------- Une place seule
def test_une_place_fermee_n_est_plus_reservable(db, locaux, employee):
    """Le bureau de T1-3 est cassé : on décoche cette place, pas les autres."""
    svc.set_availability(db, "desk", "T1-3", False)

    with pytest.raises(svc.ReservationError):
        _reserver(db, employee, locaux["T1-3"], _ouvrable())


def test_fermer_une_place_laisse_ses_voisines_reservables(db, locaux, employee):
    svc.set_availability(db, "desk", "T1-3", False)

    assert _reserver(db, employee, locaux["T1-2"], _ouvrable()).desk_id == locaux["T1-2"].id


def test_rouvrir_une_place_la_rend_reservable(db, locaux, employee):
    svc.set_availability(db, "desk", "T1-3", False)
    svc.set_availability(db, "desk", "T1-3", True)

    assert _reserver(db, employee, locaux["T1-3"], _ouvrable()).desk_id == locaux["T1-3"].id


def test_une_portee_inconnue_est_refusee(db, locaux):
    with pytest.raises(svc.ReservationError):
        svc.set_availability(db, "batiment", "T1-3", False)


# ---------------------------------------------------------------- Les dates
def test_une_fermeture_ne_vaut_que_dans_sa_periode(db, locaux, employee):
    debut, fin = _ouvrable(7), _ouvrable(9)
    svc.set_availability(db, "desk", "T1-3", False, since=debut, until=fin)

    assert _reserver(db, employee, locaux["T1-3"], _ouvrable(1)).desk_id == locaux["T1-3"].id
    with pytest.raises(svc.ReservationError):
        _reserver(db, employee, locaux["T1-3"], debut)


def test_les_bornes_de_la_periode_sont_incluses(db, locaux, employee):
    jour = _ouvrable(5)
    svc.set_availability(db, "desk", "T1-3", False, since=jour, until=jour)

    with pytest.raises(svc.ReservationError):
        _reserver(db, employee, locaux["T1-3"], jour)


def test_une_fermeture_sans_date_vaut_pour_tous_les_jours(db, locaux, employee):
    svc.set_availability(db, "desk", "T1-3", False)

    for decalage in (1, 3, 10):
        with pytest.raises(svc.ReservationError):
            _reserver(db, employee, locaux["T1-3"], _ouvrable(decalage))


def test_une_fin_anterieure_au_debut_est_refusee(db, locaux):
    with pytest.raises(svc.ReservationError):
        svc.set_availability(db, "desk", "T1-3", False,
                             since=_ouvrable(9), until=_ouvrable(2))


def test_changer_les_dates_remplace_la_fermeture(db, locaux, employee):
    """Modifier une date ne doit pas empiler deux fermetures sur la même cible."""
    svc.set_availability(db, "desk", "T1-3", False, since=_ouvrable(2), until=_ouvrable(3))
    svc.set_availability(db, "desk", "T1-3", False, since=_ouvrable(8), until=_ouvrable(9))

    etat = {d["name"]: d for d in svc.availability_state(db)["desks"]}
    assert etat["T1-3"]["since"] == _ouvrable(8).isoformat()
    assert _reserver(db, employee, locaux["T1-3"], _ouvrable(2)).desk_id == locaux["T1-3"].id


# ---------------------------------------------------------------- Un espace
def test_fermer_un_espace_ferme_toutes_ses_places(db, locaux, employee):
    svc.set_availability(db, "space", "Bureau 2", False)

    for nom in ("B2-1", "B2-2"):
        with pytest.raises(svc.ReservationError):
            _reserver(db, employee, locaux[nom], _ouvrable())


def test_fermer_un_espace_empeche_de_le_reserver_en_entier(db, locaux, employee):
    svc.set_availability(db, "space", "T1", False)

    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, "T1", _ouvrable(), "AM",
                       [{"desk_id": locaux["T1-1"].id, "name": "Camille Dupont"}])


def test_une_seule_place_fermee_bloque_la_table_entiere(db, locaux, employee):
    """On ne réserve pas « toute la table » s'il y manque une place."""
    svc.set_availability(db, "desk", "T1-3", False)

    with pytest.raises(svc.ReservationError) as erreur:
        svc.book_group(db, employee.id, "T1", _ouvrable(), "AM",
                       [{"desk_id": locaux["T1-1"].id, "name": "Camille Dupont"}])
    assert "T1-3" in str(erreur.value)


def test_une_bulle_fermee_refuse_son_creneau(db, locaux, employee):
    svc.set_availability(db, "space", "BC-1", False)

    with pytest.raises(svc.ReservationError):
        svc.book_timeslot(db, employee.id, locaux["BC-1"].id, _ouvrable(),
                          time(10, 0), time(10, 30))


# ---------------------------------------------------------------- Ce que voit le front
def test_la_disponibilite_signale_les_places_fermees(db, locaux, employee):
    svc.set_availability(db, "desk", "T1-3", False)

    etats = {d.name: ferme for d, _b, _o, ferme in svc.get_availability(db, _ouvrable(), "AM")}
    assert etats["T1-3"] is True
    assert etats["T1-2"] is False


def test_la_disponibilite_signale_les_places_d_un_espace_ferme(db, locaux, employee):
    svc.set_availability(db, "space", "Bureau 2", False)

    etats = {d.name: ferme for d, _b, _o, ferme in svc.get_availability(db, _ouvrable(), "AM")}
    assert etats["B2-1"] is True and etats["B2-2"] is True
    assert etats["T1-1"] is False


def test_une_fermeture_datee_ne_grise_que_les_jours_concernes(db, locaux, employee):
    """Le grisage suit la date consultée, pas aujourd'hui."""
    jour = _ouvrable(8)
    svc.set_availability(db, "desk", "T1-3", False, since=jour, until=jour)

    ferme = {d.name: f for d, _b, _o, f in svc.get_availability(db, jour, "AM")}
    ouvert = {d.name: f for d, _b, _o, f in svc.get_availability(db, _ouvrable(1), "AM")}
    assert ferme["T1-3"] is True
    assert ouvert["T1-3"] is False


# ---------------------------------------------------------------- L'écran de réglage
def test_l_etat_liste_les_espaces_et_les_places(db, locaux):
    etat = svc.availability_state(db)

    assert {g["ref"] for g in etat["spaces"]} >= {"T1", "Bureau 2", "BC-1"}
    assert {d["name"] for d in etat["desks"]} == set(locaux)
    assert all(g["enabled"] for g in etat["spaces"])
    assert all(d["enabled"] for d in etat["desks"])


def test_l_etat_porte_les_dates_de_chaque_fermeture(db, locaux):
    debut, fin = _ouvrable(2), _ouvrable(4)
    svc.set_availability(db, "desk", "T1-3", False, since=debut, until=fin)
    svc.set_availability(db, "space", "Bureau 2", False)

    etat = svc.availability_state(db)
    poste = next(d for d in etat["desks"] if d["name"] == "T1-3")
    espace = next(g for g in etat["spaces"] if g["ref"] == "Bureau 2")

    assert poste["enabled"] is False
    assert (poste["since"], poste["until"]) == (debut.isoformat(), fin.isoformat())
    assert espace["enabled"] is False
    assert (espace["since"], espace["until"]) == (None, None)


def test_rouvrir_leve_aussi_les_fermetures_datees(db, locaux):
    """Cocher la case doit rendre la cible réservable, sans exception cachée."""
    svc.set_availability(db, "space", "Bureau 2", False, since=_ouvrable(1), until=_ouvrable(9))
    svc.set_availability(db, "space", "Bureau 2", True)

    ferme = {d.name: f for d, _b, _o, f in svc.get_availability(db, _ouvrable(2), "AM")}
    assert ferme["B2-1"] is False


def test_fermer_deux_fois_ne_cree_pas_de_doublon(db, locaux):
    svc.set_availability(db, "space", "Bureau 2", False)
    svc.set_availability(db, "space", "Bureau 2", False)

    lignes = db.query(m.Unavailability).filter_by(scope="space", target="Bureau 2").all()
    assert len(lignes) == 1


# ---------------------------------------------------------------- Contrat HTTP
def test_seul_un_admin_change_la_disponibilite(client, employee, admin, locaux):
    corps = {"scope": "desk", "target": "T1-3", "enabled": False}

    client.login_as(employee)
    assert client.patch("/api/admin/availability", json=corps).status_code == 403

    client.login_as(admin)
    assert client.patch("/api/admin/availability", json=corps).status_code == 200


def test_l_api_renvoie_l_etat_complet(client, admin, locaux):
    client.login_as(admin)
    data = client.get("/api/admin/availability").json()

    assert "spaces" in data and "desks" in data
    assert {d["name"] for d in data["desks"]} == set(locaux)


def test_un_employe_ne_lit_pas_l_etat_d_administration(client, employee, locaux):
    client.login_as(employee)
    assert client.get("/api/admin/availability").status_code == 403
