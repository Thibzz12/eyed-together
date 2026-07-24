"""Profil public d'un collaborateur (consultable par n'importe quel employé via la recherche) :
statut du jour, prochaines réservations, idées signées, résultats de quiz. Aucune donnée
privée sensible n'est exposée (les idées anonymes restent anonymes).
"""

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.db import models as m

LEVELS = [(300, "Platine"), (150, "Or"), (50, "Argent"), (0, "Bronze")]


def _level_of(points: int) -> str:
    for threshold, label in LEVELS:
        if points >= threshold:
            return label
    return "Bronze"


def get_public_profile(db: Session, user_id: int) -> dict | None:
    user = db.get(m.User, user_id)
    if user is None:
        return None

    today = date.today()
    statuses = db.scalars(
        select(m.DailyStatus).where(
            m.DailyStatus.user_id == user_id, m.DailyStatus.day >= today, m.DailyStatus.day <= today + timedelta(days=6),
        ).order_by(m.DailyStatus.day)
    )
    upcoming_status = [{"day": s.day.isoformat(), "status": s.status.value} for s in statuses]

    reservations = db.scalars(
        select(m.Reservation).where(
            m.Reservation.user_id == user_id, m.Reservation.status == m.ReservationStatus.BOOKED,
            m.Reservation.reservation_date >= today,
        ).order_by(m.Reservation.reservation_date, m.Reservation.slot).options(joinedload(m.Reservation.desk))
    )
    upcoming_reservations = [
        {"desk": r.desk.name, "date": r.reservation_date.isoformat(), "slot": r.slot.value} for r in reservations
    ]

    ideas = db.scalars(
        select(m.Idea).where(
            m.Idea.author_id == user_id, m.Idea.is_anonymous.is_(False), m.Idea.status != m.IdeaStatus.ARCHIVED,
        ).order_by(m.Idea.created_at.desc())
    )
    signed_ideas = [{"id": i.id, "title": i.title, "status": i.status.value} for i in ideas]

    attempts = db.scalars(
        select(m.QuizAttempt).where(m.QuizAttempt.user_id == user_id)
        .order_by(m.QuizAttempt.completed_at.desc()).options(joinedload(m.QuizAttempt.quiz))
    )
    quiz_results = [{"quiz_title": a.quiz.title, "score": a.score, "total": a.total} for a in attempts]

    return {
        "id": user.id,
        "name": user.display_name,
        "department": user.department,
        "total_points": user.total_points,
        "level": _level_of(user.total_points),
        "upcoming_status": upcoming_status,
        "upcoming_reservations": upcoming_reservations,
        "signed_ideas": signed_ideas,
        "quiz_results": quiz_results,
    }
