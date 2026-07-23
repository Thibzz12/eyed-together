"""Assemblage du tableau de bord d'accueil (cartes + données live)."""

from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models as m
from app.services import events as events_svc
from app.services import reservations as res_svc
from app.services.wordpress import fetch_event_detail, fetch_events, fetch_news


def get_setting(db: Session, key: str, default: str = "") -> str:
    row = db.get(m.AppSetting, key)
    return row.value if row else default


ALL_STATUSES = [s.value for s in m.WorkStatus]  # catalogue fixe ; seule l'activation est configurable


def get_enabled_statuses(db: Session) -> list[str]:
    """Statuts de présence proposés aux employés (configurable par l'admin)."""
    raw = get_setting(db, "enabled_statuses", ",".join(ALL_STATUSES))
    enabled = [s for s in raw.split(",") if s in ALL_STATUSES]
    return enabled or ALL_STATUSES  # jamais une liste vide (sécurité)


def set_enabled_statuses(db: Session, statuses: list[str]) -> None:
    valid = [s for s in statuses if s in ALL_STATUSES]
    set_setting(db, "enabled_statuses", ",".join(valid) or ",".join(ALL_STATUSES))
    db.commit()


def set_setting(db: Session, key: str, value: str) -> None:
    row = db.get(m.AppSetting, key)
    if row is None:
        db.add(m.AppSetting(key=key, value=value))
    else:
        row.value = value


def coworking_status(db: Session) -> dict:
    """Nombre de postes libres / total pour aujourd'hui."""
    today = date.today()
    total = db.scalar(select(func.count()).select_from(m.Desk).where(m.Desk.is_active.is_(True))) or 0
    occupied = db.scalar(
        select(func.count(func.distinct(m.Reservation.desk_id))).where(
            m.Reservation.reservation_date == today,
            m.Reservation.status == m.ReservationStatus.BOOKED,
        )
    ) or 0
    return {"free": max(0, total - occupied), "total": total, "occupied": occupied}


def _card_data(db: Session, key: str, user_id: int):
    if key == "presence":
        row = db.scalar(
            select(m.DailyStatus).where(m.DailyStatus.user_id == user_id, m.DailyStatus.day == date.today())
        )
        return {"status": row.status.value if row else None}
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
        return {
            "value": int(get_setting(db, "project_progress_value", "0") or 0),
            "label": get_setting(db, "project_progress_label", ""),
        }
    if key == "team_presence":
        rows = res_svc.presence(db, date.today())
        return [{"name": r.user.display_name, "desk": r.desk.name} for r in rows]
    if key == "events":
        return fetch_events(limit=5)
    if key == "news":
        return fetch_news(limit=4)
    if key == "mes_evenements":
        regs = events_svc.my_active_registrations(db, user_id)[:5]
        items = []
        for r in regs:
            d = fetch_event_detail(r.wp_event_id)
            if d:
                items.append({"id": r.wp_event_id, "title": d["title"], "date": d["date"], "status": r.status.value})
        return items
    return None


def build_dashboard(db: Session, user_id: int) -> list[dict]:
    """Cartes activées, dans l'ordre, avec leurs données."""
    cards = db.scalars(
        select(m.DashboardCard).where(m.DashboardCard.enabled.is_(True)).order_by(m.DashboardCard.position)
    ).all()
    return [
        {"key": c.key, "title": c.title, "highlighted": c.highlighted, "data": _card_data(db, c.key, user_id)}
        for c in cards
    ]
