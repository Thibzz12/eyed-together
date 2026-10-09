"""Assemblage du tableau de bord d'accueil (cartes + données live)."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.timezone import local_today
from app.db import models as m
from app.services import events as events_svc
from app.services import reservations as res_svc
from app.services.settings import get_settings
from app.services.wordpress import fetch_event_detail, fetch_events, fetch_news


def project_progress_settings(db: Session) -> dict:
    """Le jalon « Building Our Future Home » : valeur, libellé, titre, date cible.

    Lu par la carte d'accueil et par l'écran d'administration : une seule
    lecture, un seul défaut (« Nouveaux locaux »).
    """
    settings = get_settings(db, [
        "project_progress_value", "project_progress_label", "project_milestone_title", "project_target_date",
    ])
    target_raw = settings["project_target_date"]
    days_left = None
    if target_raw:
        try:
            days_left = (date.fromisoformat(target_raw) - local_today()).days
        except ValueError:
            days_left = None
    return {
        "value": int(settings["project_progress_value"] or 0),
        "label": settings["project_progress_label"],
        "milestone_title": settings["project_milestone_title"] or "Nouveaux locaux",
        "target_date": target_raw or None,
        "days_left": days_left,
    }


def get_birthdays(db: Session) -> dict:
    """Anniversaires du jour + des 7 prochains jours (auto-déclarés par chacun dans son profil).
    Comparaison sur jour/mois uniquement, l'année de naissance n'est jamais utilisée."""
    today = local_today()
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
    today = local_today()
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
    if key == "coworking_status":
        return coworking_status(db)
    if key == "next_reservation":
        # La place prise pour un visiteur n'est pas « ma réservation » : elle ne
        # doit ni occuper la carte, ni réclamer un « Je suis arrivé » à l'hôte.
        mine = [
            r for r in res_svc.my_reservations(db, user_id)
            if r.is_group_booking or not r.occupant_name
        ]
        if not mine:
            return None
        r = mine[0]
        return {
            "reservation_id": r.id, "desk": r.desk.name, "date": r.reservation_date.isoformat(),
            "slot": r.slot.value, "is_today": r.reservation_date == local_today(),
            "checked_in": r.checked_in_at is not None,
        }
    if key == "project_progress":
        return project_progress_settings(db)
    if key == "team_presence":
        return res_svc.presence(db, local_today())
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
