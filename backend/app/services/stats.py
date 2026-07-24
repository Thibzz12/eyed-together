"""Cockpit admin : KPI agrégés + alertes simples sur l'ensemble des modules."""

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models as m


def get_kpis(db: Session) -> dict:
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    today = date.today()
    week_start = today - timedelta(days=7)

    total_users = db.scalar(select(func.count()).select_from(m.User)) or 0

    active_ids = set()
    active_ids |= set(db.scalars(
        select(m.Reservation.user_id).where(m.Reservation.created_at >= week_ago).distinct()
    ))
    active_ids |= set(db.scalars(
        select(m.QuizAttempt.user_id).where(m.QuizAttempt.completed_at >= week_ago).distinct()
    ))
    active_ids |= set(db.scalars(
        select(m.DailyStatus.user_id).where(m.DailyStatus.day >= week_start).distinct()
    ))
    active_ids |= set(db.scalars(
        select(m.EventRegistration.user_id).where(m.EventRegistration.created_at >= week_ago).distinct()
    ))

    total_desks = db.scalar(select(func.count()).select_from(m.Desk).where(m.Desk.is_active.is_(True))) or 0
    occupied_today = db.scalar(
        select(func.count(func.distinct(m.Reservation.desk_id))).where(
            m.Reservation.reservation_date == today, m.Reservation.status == m.ReservationStatus.BOOKED,
        )
    ) or 0

    reservations_week = db.scalar(
        select(func.count()).select_from(m.Reservation).where(m.Reservation.created_at >= week_ago)
    ) or 0
    noshow_week = db.scalar(
        select(func.count()).select_from(m.Reservation).where(
            m.Reservation.status == m.ReservationStatus.NO_SHOW, m.Reservation.created_at >= week_ago,
        )
    ) or 0

    event_registrations = db.scalar(
        select(func.count()).select_from(m.EventRegistration).where(
            m.EventRegistration.status.in_([m.EventRegistrationStatus.REGISTERED, m.EventRegistrationStatus.WAITLISTED])
        )
    ) or 0

    quiz_attempts = db.scalar(select(func.count()).select_from(m.QuizAttempt)) or 0
    quiz_score_avg = db.scalar(
        select(func.avg(m.QuizAttempt.score * 100.0 / func.nullif(m.QuizAttempt.total, 0)))
    )

    ideas_total = db.scalar(select(func.count()).select_from(m.Idea)) or 0
    ideas_votes = db.scalar(select(func.count()).select_from(m.IdeaVote)) or 0

    media_total = db.scalar(select(func.count()).select_from(m.MediaItem)) or 0

    return {
        "total_users": total_users,
        "active_users_7d": len(active_ids),
        "coworking_occupancy_pct": round(occupied_today / total_desks * 100) if total_desks else 0,
        "reservations_week": reservations_week,
        "noshow_week": noshow_week,
        "event_registrations": event_registrations,
        "quiz_attempts": quiz_attempts,
        "quiz_score_avg_pct": round(quiz_score_avg) if quiz_score_avg is not None else None,
        "ideas_total": ideas_total,
        "ideas_votes": ideas_votes,
        "media_total": media_total,
    }


def get_alerts(db: Session) -> list[str]:
    alerts = []

    empty_published_quizzes = db.scalars(
        select(m.Quiz).outerjoin(m.QuizQuestion).where(m.QuizQuestion.id.is_(None))
    )
    for q in empty_published_quizzes:
        alerts.append(f"Le quiz « {q.title} » n'a aucune question — invisible d'intérêt pour les employés.")

    empty_ideas_categories_count = db.scalar(
        select(func.count()).select_from(m.Idea).where(m.Idea.status == m.IdeaStatus.NEW)
    ) or 0
    if empty_ideas_categories_count:
        alerts.append(f"{empty_ideas_categories_count} idée(s) en attente de traitement (statut « Nouvelle »).")

    full_capacity_events = db.scalars(
        select(m.EventCapacity).where(m.EventCapacity.capacity.isnot(None))
    )
    for ec in full_capacity_events:
        count = db.scalar(
            select(func.count()).select_from(m.EventRegistration).where(
                m.EventRegistration.wp_event_id == ec.wp_event_id,
                m.EventRegistration.status == m.EventRegistrationStatus.REGISTERED,
            )
        ) or 0
        waitlisted = db.scalar(
            select(func.count()).select_from(m.EventRegistration).where(
                m.EventRegistration.wp_event_id == ec.wp_event_id,
                m.EventRegistration.status == m.EventRegistrationStatus.WAITLISTED,
            )
        ) or 0
        if count >= ec.capacity and waitlisted:
            alerts.append(f"Un événement est complet avec {waitlisted} personne(s) en liste d'attente — envisage d'augmenter la capacité.")

    inactive_desks = db.scalar(select(func.count()).select_from(m.Desk).where(m.Desk.is_active.is_(False))) or 0
    if inactive_desks:
        alerts.append(f"{inactive_desks} poste(s) désactivé(s) — vérifie que c'est intentionnel.")

    return alerts
