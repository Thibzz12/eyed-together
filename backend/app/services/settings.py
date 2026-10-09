"""Réglages clé/valeur de l'application (table app_settings).

Un seul endroit pour lire et écrire un réglage : l'horizon de réservation,
l'heure de clôture des présences, les noms des salles, les interrupteurs de
réservation, les règles d'icônes, la personnalisation de l'écran… Avant, le
même « lire la ligne, la créer si absente, sinon la modifier » était recopié
dans huit fonctions de quatre modules.

Ce module ne dépend d'aucun autre service : il peut être importé partout sans
risque d'import circulaire. Il n'engage jamais la transaction : l'appelant
décide du commit, pour garder un réglage et ses effets cohérents.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import models as m


def get_setting(db: Session, key: str, default: str = "") -> str:
    row = db.get(m.AppSetting, key)
    return row.value if row else default


def get_settings(db: Session, keys: list[str]) -> dict[str, str]:
    """Version groupée (une requête au lieu d'une par clé)."""
    rows = db.scalars(select(m.AppSetting).where(m.AppSetting.key.in_(keys)))
    values = {row.key: row.value for row in rows}
    return {key: values.get(key, "") for key in keys}


def get_int(db: Session, key: str, default: int, lo: int | None = None, hi: int | None = None) -> int:
    """Un entier borné ; la valeur par défaut si le réglage manque ou est illisible."""
    try:
        valeur = int(get_setting(db, key, ""))
    except (TypeError, ValueError):
        return default
    if lo is not None:
        valeur = max(lo, valeur)
    if hi is not None:
        valeur = min(hi, valeur)
    return valeur


def get_bool(db: Session, key: str, default: bool = True) -> bool:
    row = db.get(m.AppSetting, key)
    if row is None:
        return default
    return row.value not in ("0", "false", "False", "")


def set_setting(db: Session, key: str, value: str) -> None:
    """Crée ou remplace un réglage. Sans commit : à l'appelant de valider."""
    row = db.get(m.AppSetting, key)
    if row is None:
        db.add(m.AppSetting(key=key, value=value))
    else:
        row.value = value
