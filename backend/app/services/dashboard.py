"""Assemblage du tableau de bord d'accueil (cartes + données live)."""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models as m
from app.services import events as events_svc
from app.services import reservations as res_svc
from app.services.wordpress import fetch_event_detail, fetch_events, fetch_news


class DashboardError(Exception):
    """Erreur métier générique (catalogue de statuts, réglages d'accueil…)."""
    status_code = 400


def get_setting(db: Session, key: str, default: str = "") -> str:
    row = db.get(m.AppSetting, key)
    return row.value if row else default


# ------------------------------------------------------------------
#  Catalogue des statuts de présence (4 statuts de base + statuts
#  personnalisés ajoutés par l'admin) — stocké en JSON dans AppSetting
#  plutôt qu'un enum Python figé, pour permettre l'ajout depuis l'admin.
# ------------------------------------------------------------------
_STATUS_CATALOG_KEY = "status_catalog"
_DEFAULT_STATUS_CATALOG = [
    {"key": "coworking", "label": "Coworking", "color": "#00608D", "enabled": True, "builtin": True},
    {"key": "teletravail", "label": "Télétravail", "color": "#6C3FA0", "enabled": True, "builtin": True},
    {"key": "deplacement", "label": "Déplacement", "color": "#B4761C", "enabled": True, "builtin": True},
    {"key": "conge", "label": "Congé", "color": "#94A3B8", "enabled": True, "builtin": True},
]


def get_status_catalog(db: Session) -> list[dict]:
    """Catalogue complet (base + personnalisés), chacun avec clé/libellé/couleur/activé."""
    raw = get_setting(db, _STATUS_CATALOG_KEY, "")
    if raw:
        try:
            catalog = json.loads(raw)
            if catalog:
                return catalog
        except (json.JSONDecodeError, TypeError):
            pass
    return [dict(s) for s in _DEFAULT_STATUS_CATALOG]


def _save_status_catalog(db: Session, catalog: list[dict]) -> None:
    set_setting(db, _STATUS_CATALOG_KEY, json.dumps(catalog))
    db.commit()


def get_enabled_statuses(db: Session) -> list[str]:
    """Clés des statuts actuellement proposés aux employés (jamais une liste vide)."""
    enabled = [s["key"] for s in get_status_catalog(db) if s.get("enabled")]
    return enabled or [s["key"] for s in _DEFAULT_STATUS_CATALOG]


def set_enabled_statuses(db: Session, keys: list[str]) -> None:
    """Active/désactive des statuts existants (le reste du catalogue ne bouge pas)."""
    catalog = get_status_catalog(db)
    keys_set = set(keys)
    for s in catalog:
        s["enabled"] = s["key"] in keys_set
    if not any(s["enabled"] for s in catalog):
        catalog = [dict(s) for s in _DEFAULT_STATUS_CATALOG]  # jamais tout désactivé
    _save_status_catalog(db, catalog)


def add_custom_status(db: Session, label: str, color: str) -> dict:
    """Ajoute un statut personnalisé (label + couleur choisis par l'admin) au catalogue."""
    label = (label or "").strip()
    if not label:
        raise DashboardError("Le libellé est obligatoire.")
    color = (color or "#64707A").strip()
    catalog = get_status_catalog(db)
    base = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "statut"
    key, existing, i = base, {s["key"] for s in catalog}, 2
    while key in existing:
        key = f"{base}_{i}"; i += 1
    entry = {"key": key, "label": label, "color": color, "enabled": True, "builtin": False}
    catalog.append(entry)
    _save_status_catalog(db, catalog)
    return entry


def delete_custom_status(db: Session, key: str) -> None:
    """Supprime un statut personnalisé (les statuts de base ne se désactivent, jamais ne se suppriment)."""
    catalog = get_status_catalog(db)
    target = next((s for s in catalog if s["key"] == key), None)
    if target is None:
        return
    if target.get("builtin"):
        raise DashboardError("Les statuts de base ne peuvent pas être supprimés, seulement désactivés.")
    _save_status_catalog(db, [s for s in catalog if s["key"] != key])


def set_setting(db: Session, key: str, value: str) -> None:
    row = db.get(m.AppSetting, key)
    if row is None:
        db.add(m.AppSetting(key=key, value=value))
    else:
        row.value = value


def get_birthdays(db: Session) -> dict:
    """Anniversaires du jour + des 7 prochains jours (auto-déclarés par chacun dans son profil).
    Comparaison sur jour/mois uniquement, l'année de naissance n'est jamais utilisée."""
    today = date.today()
    users = db.scalars(select(m.User).where(m.User.birthday.isnot(None)))
    today_list, upcoming = [], []
    for u in users:
        b = u.birthday
        # Prochaine occurrence de cet anniversaire (cette année, ou l'an prochain si déjà passé).
        try:
            next_occurrence = b.replace(year=today.year)
        except ValueError:
            next_occurrence = date(today.year, 3, 1)  # 29 février sur année non bissextile
        if next_occurrence < today:
            try:
                next_occurrence = b.replace(year=today.year + 1)
            except ValueError:
                next_occurrence = date(today.year + 1, 3, 1)
        days_away = (next_occurrence - today).days
        if days_away == 0:
            today_list.append({"name": u.display_name})
        elif days_away <= 7:
            upcoming.append({"name": u.display_name, "days_away": days_away, "date": next_occurrence.isoformat()})
    upcoming.sort(key=lambda x: x["days_away"])
    return {"today": today_list, "upcoming": upcoming}


def coworking_status(db: Session) -> dict:
    """Nombre de postes libres / total pour aujourd'hui.

    Les bulles calmes ne comptent pas dans la capacité : ce sont des créneaux de 15 min,
    pas des postes de travail au même titre que les bureaux/l'open space.
    """
    today = date.today()
    total = db.scalar(
        select(func.count()).select_from(m.Desk).where(m.Desk.is_active.is_(True), m.Desk.zone != "Bulles calmes")
    ) or 0
    occupied = db.scalar(
        select(func.count(func.distinct(m.Reservation.desk_id))).join(m.Desk).where(
            m.Reservation.reservation_date == today,
            m.Reservation.status == m.ReservationStatus.BOOKED,
            m.Desk.zone != "Bulles calmes",
        )
    ) or 0
    return {"free": max(0, total - occupied), "total": total, "occupied": occupied}


def _card_data(db: Session, key: str, user_id: int, wp_cache: dict | None = None):
    wp_cache = wp_cache or {}
    if key == "presence":
        row = db.scalar(
            select(m.DailyStatus).where(m.DailyStatus.user_id == user_id, m.DailyStatus.day == date.today())
        )
        return {
            "status_am": row.status_am if row else None,
            "status_pm": row.status_pm if row else None,
        }
    if key == "coworking_status":
        return coworking_status(db)
    if key == "next_reservation":
        mine = res_svc.my_reservations(db, user_id)
        if not mine:
            return None
        r = mine[0]
        return {
            "reservation_id": r.id, "desk": r.desk.name, "date": r.reservation_date.isoformat(),
            "slot": r.slot.value, "is_today": r.reservation_date == date.today(),
            "checked_in": r.checked_in_at is not None,
        }
    if key == "project_progress":
        target_raw = get_setting(db, "project_target_date", "")
        days_left = None
        if target_raw:
            try:
                days_left = (date.fromisoformat(target_raw) - date.today()).days
            except ValueError:
                days_left = None
        return {
            "value": int(get_setting(db, "project_progress_value", "0") or 0),
            "label": get_setting(db, "project_progress_label", ""),
            "milestone_title": get_setting(db, "project_milestone_title", "Nouveaux locaux"),
            "days_left": days_left,
        }
    if key == "team_presence":
        rows = res_svc.presence(db, date.today())
        return [{"name": r.user.display_name, "desk": r.desk.name} for r in rows]
    if key == "events":
        return wp_cache.get("events") if "events" in wp_cache else fetch_events(limit=5)
    if key == "news":
        return wp_cache.get("news") if "news" in wp_cache else fetch_news(limit=4)
    if key == "birthdays":
        return get_birthdays(db)
    if key == "liens_utiles":
        rows = db.scalars(
            select(m.UsefulLink).where(m.UsefulLink.enabled.is_(True)).order_by(m.UsefulLink.position)
        )
        return [{"label": l.label, "url": l.url, "icon": l.icon} for l in rows]
    if key == "mes_evenements":
        regs = events_svc.my_active_registrations(db, user_id)[:5]
        if not regs:
            return []
        # Les détails (dont chacun peut être un aller-retour réseau non-cached la 1re fois)
        # sont récupérés en parallèle plutôt que l'un après l'autre.
        with ThreadPoolExecutor(max_workers=len(regs)) as ex:
            details = list(ex.map(lambda r: fetch_event_detail(r.wp_event_id), regs))
        return [
            {"id": r.wp_event_id, "title": d["title"], "date": d["date"], "status": r.status.value}
            for r, d in zip(regs, details) if d
        ]
    return None


def build_dashboard(db: Session, user_id: int) -> list[dict]:
    """Cartes activées, dans l'ordre, avec leurs données.

    Les appels réseau vers l'intranet WordPress (événements, actualités) sont lancés
    en parallèle plutôt que l'un après l'autre — c'était la principale source de lenteur
    au chargement de l'accueil (2 allers-retours réseau séquentiels avant, potentiellement
    plus avec les événements inscrits).
    """
    cards = db.scalars(
        select(m.DashboardCard).where(m.DashboardCard.enabled.is_(True)).order_by(m.DashboardCard.position)
    ).all()
    enabled_keys = {c.key for c in cards}

    wp_cache: dict = {}
    wp_jobs = [k for k in ("events", "news") if k in enabled_keys]
    if wp_jobs:
        with ThreadPoolExecutor(max_workers=len(wp_jobs)) as ex:
            futures = {
                "events": ex.submit(fetch_events, limit=5) if "events" in wp_jobs else None,
                "news": ex.submit(fetch_news, limit=4) if "news" in wp_jobs else None,
            }
            for k, f in futures.items():
                if f is not None:
                    wp_cache[k] = f.result()

    return [
        {"key": c.key, "title": c.title, "highlighted": c.highlighted, "data": _card_data(db, c.key, user_id, wp_cache)}
        for c in cards
    ]
