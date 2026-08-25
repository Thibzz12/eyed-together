"""Fuseau horaire de l'entreprise (Liège, Belgique).

Toute décision du type « quel jour sommes-nous » ou « est-il plus de 19h »
passe par ici. Le serveur de production tourne en UTC : comparer une heure
UTC à une heure de bureau décalerait d'une ou deux heures selon la période
de l'année, et clôturerait les présences au mauvais moment.

Nécessite le paquet `tzdata` (voir requirements.txt) : sous Windows, zoneinfo
n'a aucune base de fuseaux système.
"""

from datetime import date, datetime
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("Europe/Brussels")


def local_now() -> datetime:
    """Instant présent, horodaté dans le fuseau local."""
    return datetime.now(LOCAL_TZ)


def local_today() -> date:
    """Date du calendrier local (pas la date UTC)."""
    return local_now().date()
