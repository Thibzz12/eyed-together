"""Logique métier des inscriptions aux événements (WordPress = source du contenu,
nos tables ne stockent que la capacité et les inscriptions, jamais le contenu lui-même).
"""

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models as m


class EventError(Exception):
    """Erreur métier générique (mappée en code HTTP dans main.py)."""
    status_code = 400


class RegistrationNotFound(EventError):
    status_code = 404


def get_capacity(db: Session, wp_event_id: int) -> int | None:
    row = db.get(m.EventCapacity, wp_event_id)
    return row.capacity if row else None


def set_capacity(db: Session, wp_event_id: int, capacity: int | None) -> None:
    row = db.get(m.EventCapacity, wp_event_id)
    if row is None:
        row = m.EventCapacity(wp_event_id=wp_event_id, capacity=capacity)
        db.add(row)
    else:
        row.capacity = capacity
    db.commit()


def registered_count(db: Session, wp_event_id: int) -> int:
    return db.scalar(
        select(func.count()).select_from(m.EventRegistration).where(
            m.EventRegistration.wp_event_id == wp_event_id,
            m.EventRegistration.status == m.EventRegistrationStatus.REGISTERED,
        )
    ) or 0


def my_registration(db: Session, user_id: int, wp_event_id: int) -> m.EventRegistration | None:
    return db.scalar(
        select(m.EventRegistration).where(
            m.EventRegistration.user_id == user_id, m.EventRegistration.wp_event_id == wp_event_id,
        )
    )


def my_active_registrations(db: Session, user_id: int) -> list[m.EventRegistration]:
    """Toutes mes inscriptions actives (inscrit ou en liste d'attente), pour affichage ('mes événements')."""
    return list(
        db.scalars(
            select(m.EventRegistration).where(
                m.EventRegistration.user_id == user_id,
                m.EventRegistration.status.in_(
                    [m.EventRegistrationStatus.REGISTERED, m.EventRegistrationStatus.WAITLISTED]
                ),
            ).order_by(m.EventRegistration.created_at.desc())
        )
    )


def register(db: Session, user_id: int, wp_event_id: int) -> m.EventRegistration:
    """Inscrit l'employé (ou le place en liste d'attente si complet). Idempotent."""
    row = my_registration(db, user_id, wp_event_id)
    if row is not None and row.status in (
        m.EventRegistrationStatus.REGISTERED, m.EventRegistrationStatus.WAITLISTED
    ):
        return row  # déjà inscrit (ou en attente) — pas d'erreur, on renvoie l'état actuel

    capacity = get_capacity(db, wp_event_id)
    full = capacity is not None and registered_count(db, wp_event_id) >= capacity
    status = m.EventRegistrationStatus.WAITLISTED if full else m.EventRegistrationStatus.REGISTERED

    if row is None:
        row = m.EventRegistration(user_id=user_id, wp_event_id=wp_event_id, status=status)
        db.add(row)
    else:
        row.status = status  # ré-inscription après une annulation précédente
    db.commit()
    db.refresh(row)
    return row


def unregister(db: Session, user_id: int, wp_event_id: int) -> None:
    """Annule mon inscription et promeut automatiquement le 1er de la liste d'attente."""
    row = my_registration(db, user_id, wp_event_id)
    if row is None or row.status == m.EventRegistrationStatus.CANCELLED:
        raise RegistrationNotFound("Inscription introuvable.")
    was_registered = row.status == m.EventRegistrationStatus.REGISTERED
    row.status = m.EventRegistrationStatus.CANCELLED
    db.commit()

    if was_registered:
        capacity = get_capacity(db, wp_event_id)
        if capacity is not None and registered_count(db, wp_event_id) < capacity:
            next_in_line = db.scalar(
                select(m.EventRegistration).where(
                    m.EventRegistration.wp_event_id == wp_event_id,
                    m.EventRegistration.status == m.EventRegistrationStatus.WAITLISTED,
                ).order_by(m.EventRegistration.created_at)
            )
            if next_in_line is not None:
                next_in_line.status = m.EventRegistrationStatus.REGISTERED
                db.commit()


def build_ics(title: str, event_date: str, link: str) -> str:
    """Génère un fichier .ics minimal (événement 'journée entière', pour 'ajouter au calendrier').

    Limitation connue : WordPress n'expose pas de date/heure d'événement précise via l'API REST
    publique (champ ACF non activé côté intranet) — on utilise donc la date de publication.
    """
    day = (event_date or "")[:10].replace("-", "")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    escaped_title = (title or "Événement EyeD").replace(",", "\\,").replace(";", "\\;")
    return (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//EyeD Together//FR\r\n"
        "BEGIN:VEVENT\r\n"
        f"UID:eyed-event-{day}-{abs(hash(link))}@eyed-together\r\n"
        f"DTSTAMP:{stamp}\r\n"
        f"DTSTART;VALUE=DATE:{day}\r\n"
        f"SUMMARY:{escaped_title}\r\n"
        f"DESCRIPTION:{link}\r\n"
        f"URL:{link}\r\n"
        "END:VEVENT\r\n"
        "END:VCALENDAR\r\n"
    )
