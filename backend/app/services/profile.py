"""Profil public d'un collaborateur (consultable par n'importe quel employé via la recherche) :
prochaines réservations, idées signées, résultats de quiz, badges. Aucune donnée
privée sensible n'est exposée (les idées anonymes restent anonymes).
"""

import math

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.db import models as m
from app.core.timezone import local_today
from app.services.badges import compute_streak, get_user_badges

# Progression à PALIERS INFINIS (jamais de plafond) : seuil(n) = 25*n*(n+1),
# donc seuil(1)=50, seuil(2)=150, seuil(3)=300 (compatible avec les anciens
# paliers Bronze/Argent/Or/Platine), et ça continue indéfiniment au-delà —
# la gamification doit rester pertinente après des mois/années d'usage, pas
# seulement la première semaine.
LEVEL_NAMES = ["Bronze", "Argent", "Or", "Platine", "Diamant", "Légende"]


def _level_index(points: int) -> int:
    """n tel que seuil(n) <= points < seuil(n+1), avec seuil(n) = 25*n*(n+1)."""
    if points <= 0:
        return 0
    n = (-1 + math.sqrt(1 + 4 * points / 25)) / 2
    return max(0, int(n))


def _level_threshold(n: int) -> int:
    return 25 * n * (n + 1)


def _level_label(n: int) -> str:
    if n < len(LEVEL_NAMES):
        return LEVEL_NAMES[n]
    extra = n - len(LEVEL_NAMES) + 2
    return f"{LEVEL_NAMES[-1]} {extra}"


def level_info(points: int) -> dict:
    n = _level_index(points)
    next_threshold = _level_threshold(n + 1)
    return {
        "level": _level_label(n),
        "points_to_next_level": max(0, next_threshold - points),
        "next_level_label": _level_label(n + 1),
        # Borné à [0, 100] : un solde négatif (pénalités) donnait un pourcentage
        # négatif, et la barre de progression du profil s'affichait n'importe
        # comment (constaté sur le profil de Ruben, à -20, le 02/09/2026).
        "level_progress_pct": max(0, min(100, round(
            (points - _level_threshold(n)) / (next_threshold - _level_threshold(n)) * 100
        ))) if next_threshold > _level_threshold(n) else 100,
    }




def get_public_profile(db: Session, user_id: int) -> dict | None:
    user = db.get(m.User, user_id)
    if user is None:
        return None

    today = local_today()
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
        "email": user.email,
        "department": user.department,
        "role": user.role.value,
        "birthday": user.birthday.isoformat() if user.birthday else None,
        "total_points": user.total_points,
        "streak_days": compute_streak(db, user_id),
        **level_info(user.total_points),
        "upcoming_reservations": upcoming_reservations,
        "signed_ideas": signed_ideas,
        "quiz_results": quiz_results,
        "badges": get_user_badges(db, user_id),
    }


def get_leaderboard(db: Session, limit: int = 20, period: str = "all") -> list[dict]:
    """Classement par points — "all" (total historique) ou "month" (points gagnés ce mois-ci).

    Le classement mensuel se réinitialise chaque mois : ça donne à chacun une raison de
    revenir même après des mois d'usage, plutôt qu'un classement figé que les premiers
    arrivés dominent indéfiniment.
    """
    if period == "month":
        month_start = local_today().replace(day=1)
        rows = db.execute(
            select(m.User, func.coalesce(func.sum(m.PointTransaction.amount), 0).label("pts"))
            .outerjoin(
                m.PointTransaction,
                (m.PointTransaction.user_id == m.User.id) & (m.PointTransaction.created_at >= month_start),
            )
            .group_by(m.User.id).order_by(func.coalesce(func.sum(m.PointTransaction.amount), 0).desc()).limit(limit)
        )
        return [
            {"id": u.id, "name": u.display_name, "department": u.department, "total_points": max(0, int(pts)), **level_info(u.total_points)}
            for u, pts in rows
        ]
    users = db.scalars(select(m.User).order_by(m.User.total_points.desc()).limit(limit))
    return [
        {"id": u.id, "name": u.display_name, "department": u.department, "total_points": u.total_points, **level_info(u.total_points)}
        for u in users
    ]
