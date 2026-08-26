"""Fermer une place précise, ou un espace, sur une période.

Reformulation de la demande d'Olivier par Thibaud : « on doit être capable de
désactiver temporairement la réservation de la place T1-3 parce que le bureau
est cassé », et « on doit pouvoir définir à quelle date c'est indisponible ».
Un interrupteur global par mode de réservation ne répond ni à l'un ni à l'autre.
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
    """Le bureau de T1-3 est cassé : la place se ferme, les voisines non."""
    svc.add_unavailability(db, "desk", "T1-3", reason="Bureau cassé")

    with pytest.raises(svc.ReservationError):
        _reserver(db, employee, locaux["T1-3"], _ouvrable())


def test_fermer_une_place_laisse_ses_voisines_reservables(db, locaux, employee):
    svc.add_unavailability(db, "desk", "T1-3")

    reservation = _reserver(db, employee, locaux["T1-2"], _ouvrable())
    assert reservation.desk_id == locaux["T1-2"].id


def test_rouvrir_une_place_la_rend_reservable(db, locaux, employee):
    ligne = svc.add_unavailability(db, "desk", "T1-3")
    svc.remove_unavailability(db, ligne.id)

    assert _reserver(db, employee, locaux["T1-3"], _ouvrable()).desk_id == locaux["T1-3"].id


def test_une_place_inconnue_est_refusee(db, locaux):
    with pytest.raises(svc.DeskNotFound):
        svc.add_unavailability(db, "desk", "ZZ-9")


# ---------------------------------------------------------------- Les dates
def test_une_fermeture_ne_vaut_que_dans_sa_periode(db, locaux, employee):
    debut, fin = _ouvrable(7), _ouvrable(9)
    svc.add_unavailability(db, "desk", "T1-3", since=debut, until=fin)

    # Avant la période : réservable.
    assert _reserver(db, employee, locaux["T1-3"], _ouvrable(1)).desk_id == locaux["T1-3"].id
    # Pendant : refusé.
    with pytest.raises(svc.ReservationError):
        _reserver(db, employee, locaux["T1-3"], debut)


def test_les_bornes_de_la_periode_sont_incluses(db, locaux, employee):
    debut = fin = _ouvrable(5)
    svc.add_unavailability(db, "desk", "T1-3", since=debut, until=fin)

    with pytest.raises(svc.ReservationError):
        _reserver(db, employee, locaux["T1-3"], debut)


def test_une_fermeture_sans_date_vaut_pour_tous_les_jours(db, locaux, employee):
    svc.add_unavailability(db, "desk", "T1-3")

    for decalage in (1, 3, 10):
        with pytest.raises(svc.ReservationError):
            _reserver(db, employee, locaux["T1-3"], _ouvrable(decalage))


def test_une_fin_anterieure_au_debut_est_refusee(db, locaux):
    with pytest.raises(svc.ReservationError):
        svc.add_unavailability(db, "desk", "T1-3", since=_ouvrable(9), until=_ouvrable(2))


# ---------------------------------------------------------------- Un espace
def test_fermer_un_espace_ferme_toutes_ses_places(db, locaux, employee):
    svc.add_unavailability(db, "space", "Bureau 2", reason="Travaux")

    for nom in ("B2-1", "B2-2"):
        with pytest.raises(svc.ReservationError):
            _reserver(db, employee, locaux[nom], _ouvrable())


def test_fermer_un_espace_empeche_de_le_reserver_en_entier(db, locaux, employee):
    svc.add_unavailability(db, "space", "T1")

    with pytest.raises(svc.ReservationError):
        svc.book_group(db, employee.id, "T1", _ouvrable(), "AM",
                       [{"desk_id": locaux["T1-1"].id, "name": "Camille Dupont"}])


def test_une_seule_place_fermee_bloque_la_table_entiere(db, locaux, employee):
    """On ne peut pas réserver « toute la table » s'il y manque une place."""
    svc.add_unavailability(db, "desk", "T1-3", reason="Bureau cassé")

    with pytest.raises(svc.ReservationError) as erreur:
        svc.book_group(db, employee.id, "T1", _ouvrable(), "AM",
                       [{"desk_id": locaux["T1-1"].id, "name": "Camille Dupont"}])
    assert "T1-3" in str(erreur.value)


def test_une_bulle_fermee_refuse_son_creneau(db, locaux, employee):
    svc.add_unavailability(db, "space", "BC-1")

    with pytest.raises(svc.ReservationError):
        svc.book_timeslot(db, employee.id, locaux["BC-1"].id, _ouvrable(),
                          time(10, 0), time(10, 30))


# ---------------------------------------------------------------- Ce que voit le front
def test_la_disponibilite_signale_les_places_fermees(db, locaux, employee):
    jour = _ouvrable()
    svc.add_unavailability(db, "desk", "T1-3")

    etats = {d.name: ferme for d, _b, _o, ferme in svc.get_availability(db, jour, "AM")}
    assert etats["T1-3"] is True
    assert etats["T1-2"] is False


def test_la_disponibilite_signale_les_places_d_un_espace_ferme(db, locaux, employee):
    jour = _ouvrable()
    svc.add_unavailability(db, "space", "Bureau 2")

    etats = {d.name: ferme for d, _b, _o, ferme in svc.get_availability(db, jour, "AM")}
    assert etats["B2-1"] is True and etats["B2-2"] is True
    assert etats["T1-1"] is False


def test_une_fermeture_datee_ne_grise_que_les_jours_concernes(db, locaux, employee):
    """Le point qui manquait : le grisage suit la date consultée, pas aujourd'hui."""
    jour_ferme = _ouvrable(8)
    svc.add_unavailability(db, "desk", "T1-3", since=jour_ferme, until=jour_ferme)

    ferme = {d.name: f for d, _b, _o, f in svc.get_availability(db, jour_ferme, "AM")}
    ouvert = {d.name: f for d, _b, _o, f in svc.get_availability(db, _ouvrable(1), "AM")}
    assert ferme["T1-3"] is True
    assert ouvert["T1-3"] is False


# ---------------------------------------------------------------- Interrupteur d'administration
def test_l_interrupteur_d_espace_reste_un_raccourci(db, locaux, employee):
    svc.set_group_enabled(db, "Bureau 2", False)
    assert svc.is_group_enabled(db, "Bureau 2") is False

    svc.set_group_enabled(db, "Bureau 2", True)
    assert svc.is_group_enabled(db, "Bureau 2") is True


def test_rouvrir_un_espace_leve_aussi_les_fermetures_datees(db, locaux):
    """Décocher la case doit rendre l'espace réservable, sans exception cachée."""
    svc.add_unavailability(db, "space", "Bureau 2", since=_ouvrable(1), until=_ouvrable(9))
    svc.set_group_enabled(db, "Bureau 2", True)

    ferme = {d.name: f for d, _b, _o, f in svc.get_availability(db, _ouvrable(2), "AM")}
    assert ferme["B2-1"] is False


def test_fermer_deux_fois_ne_cree_pas_de_doublon(db, locaux):
    svc.set_group_enabled(db, "Bureau 2", False)
    svc.set_group_enabled(db, "Bureau 2", False)

    sans_date = [
        u for u in svc.list_unavailabilities(db)
        if u["target"] == "Bureau 2" and u["since"] is None and u["until"] is None
    ]
    assert len(sans_date) == 1


def test_la_liste_dit_si_la_fermeture_court_aujourd_hui(db, locaux):
    svc.add_unavailability(db, "desk", "T1-3")
    svc.add_unavailability(db, "desk", "T1-2", since=_ouvrable(20), until=_ouvrable(21))

    par_cible = {u["target"]: u for u in svc.list_unavailabilities(db)}
    assert par_cible["T1-3"]["active_today"] is True
    assert par_cible["T1-2"]["active_today"] is False
