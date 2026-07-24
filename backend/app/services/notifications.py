"""Notifications in-app (V1 : pas d'email/Teams/push — aucune infra externe disponible,
cf. PROGRESS.md). Déclenchées automatiquement (rappel J-1 événement, à la volée au chargement
du tableau de bord, même principe que les pénalités no-show) ou manuellement par l'admin.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models as m
from app.services import events as events_svc
from app.services.wordpress import fetch_event_detail


def notify(db: Session, user_id: int, title: str, body: str | None = None, link: str | None = None) -> None:
    db.add(m.Notification(user_id=user_id, title=title, body=body, link=link))


def list_mine(db: Session, user_id: int, limit: int = 30) -> list[dict]:
    rows = db.scalars(
        select(m.Notification).where(m.Notification.user_id == user_id)
        .order_by(m.Notification.created_at.desc()).limit(limit)
    )
    return [
        {"id": n.id, "title": n.title, "body": n.body, "link": n.link, "read": n.read, "created_at": n.created_at.isoformat()}
        for n in rows
    ]


def unread_count(db: Session, user_id: int) -> int:
    return db.scalar(
        select(func.count()).select_from(m.Notification).where(
            m.Notification.user_id == user_id, m.Notification.read.is_(False)
        )
    ) or 0


def mark_read(db: Session, user_id: int, notification_id: int) -> None:
    n = db.get(m.Notification, notification_id)
    if n is not None and n.user_id == user_id:
        n.read = True
        db.commit()


def mark_all_read(db: Session, user_id: int) -> None:
    db.query(m.Notification).filter(
        m.Notification.user_id == user_id, m.Notification.read.is_(False)
    ).update({"read": True})
    db.commit()


def generate_event_reminders(db: Session, user_id: int) -> None:
    """Crée un rappel (J-1 / jour J) pour chaque événement où l'employé est inscrit.

    Idempotent : identifie un rappel déjà envoyé via son `link` (format "event-reminder:{id}").
    Appelé à la volée au chargement du tableau de bord (pas de scheduler pour un MVP).
    """
    regs = events_svc.my_active_registrations(db, user_id)
    if not regs:
        return
    now = datetime.now(timezone.utc)
    window_end = now + timedelta(hours=48)  # couvre J-1 et jour J, marge fuseaux horaires

    already = set(db.scalars(
        select(m.Notification.link).where(
            m.Notification.user_id == user_id, m.Notification.link.like("event-reminder:%")
        )
    ))

    for r in regs:
        link = f"event-reminder:{r.wp_event_id}"
        if link in already:
            continue
        d = fetch_event_detail(r.wp_event_id)
        if not d:
            continue
        try:
            event_dt = datetime.fromisoformat(d["date"]).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if now <= event_dt <= window_end:
            notify(db, user_id, f"Rappel : {d['title']} approche", "Ça se passe bientôt.", link)
    db.commit()


def notify_event_registrants(db: Session, wp_event_id: int, title: str, message: str) -> int:
    """Notifie tous les inscrits (et la liste d'attente) d'un événement — déclenché par l'admin."""
    regs = events_svc.list_registrations(db, wp_event_id)
    for r in regs:
        notify(db, r.user_id, title, message, "evenements")
    db.commit()
    return len(regs)
