"""Le fuseau local doit être résolvable sur toutes les machines du projet.

Sous Windows, zoneinfo n'a aucune source système : sans le paquet `tzdata`,
ZoneInfo("Europe/Brussels") lève ZoneInfoNotFoundError. Ce test garde ce
piège sous surveillance.
"""

from datetime import date, datetime

from app.core.timezone import LOCAL_TZ, local_now, local_today


def test_le_fuseau_local_est_disponible():
    assert LOCAL_TZ.key == "Europe/Brussels"


def test_local_now_est_horodate_avec_un_fuseau():
    now = local_now()
    assert isinstance(now, datetime)
    assert now.tzinfo is not None


def test_local_today_renvoie_une_date():
    assert isinstance(local_today(), date)


def test_le_harnais_demarre(client, employee):
    """Sanity check : l'application se monte et répond avec le harnais de test."""
    client.login_as(employee)
    res = client.get("/api/me")
    assert res.status_code == 200
    assert res.json()["email"] == "employe@eyedpharma.com"
