"""Sondes de disponibilité et de réveil de l'hébergement gratuit.

Render endort le service après quinze minutes sans requête, Supabase met le
projet en pause après sept jours sans activité sur la base. Un ping planifié
frappe /health/db aux heures de bureau ; ces tests fixent ce sur quoi il
s'appuie, et surtout ce qu'il ne doit pas casser.
"""

import logging

from app.main import _FiltreSondes


def test_health_ne_touche_pas_la_base(client):
    """La sonde que l'hébergeur interroge doit répondre sans la base.

    Si /health dépendait de PostgreSQL, un hoquet de Supabase ferait échouer le
    contrôle de santé et redémarrer le conteneur en boucle, alors que le service
    lui-même va très bien.
    """
    reponse = client.get("/health")
    assert reponse.status_code == 200
    assert reponse.json() == {"status": "ok"}


def test_health_db_touche_la_base(client):
    """Le ping de réveil doit vraiment interroger la base, sinon Supabase la met
    en pause malgré le trafic."""
    reponse = client.get("/health/db")
    assert reponse.status_code == 200
    assert reponse.json() == {"status": "ok"}


def test_health_db_sans_authentification(client):
    """Le ping vient d'un cron sans session : aucune des deux sondes ne peut
    exiger d'être connecté."""
    assert client.get("/health").status_code == 200
    assert client.get("/health/db").status_code == 200


def test_health_db_signale_une_base_injoignable(client, db, monkeypatch):
    """Base tombée : 503 plutôt qu'une erreur 500 opaque, pour que le cron sache
    distinguer un service endormi d'une base réellement perdue."""

    def _explose(*args, **kwargs):
        raise RuntimeError("connexion perdue")

    monkeypatch.setattr(db, "execute", _explose)
    reponse = client.get("/health/db")
    assert reponse.status_code == 503
    assert reponse.json() == {"status": "db-unreachable"}


def _ligne_acces(chemin: str) -> logging.LogRecord:
    """Reproduit un enregistrement du journal d'accès d'uvicorn."""
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:1234", "GET", chemin, "1.1", 200),
        exc_info=None,
    )


def test_les_sondes_sortent_du_journal_dacces():
    """Six pings par heure pendant quatorze heures : sans filtre, les vraies
    requêtes seraient noyées le jour où on cherche un incident."""
    filtre = _FiltreSondes()
    assert filtre.filter(_ligne_acces("/health")) is False
    assert filtre.filter(_ligne_acces("/health/db")) is False


def test_le_reste_du_trafic_reste_journalise():
    """Le filtre ne doit écarter que les sondes."""
    filtre = _FiltreSondes()
    assert filtre.filter(_ligne_acces("/api/availability")) is True
    assert filtre.filter(_ligne_acces("/")) is True


def test_le_filtre_survit_a_une_ligne_sans_chemin():
    """Certains messages d'uvicorn n'ont pas d'arguments : le filtre ne doit pas
    faire tomber la journalisation avec une IndexError."""
    filtre = _FiltreSondes()
    nue = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, "démarrage", None, None)
    assert filtre.filter(nue) is True
