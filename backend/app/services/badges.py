"""Badges de gamification : catalogue fixe, attribution automatique.

Le catalogue est codé en dur (pas de création de badge à la volée en V1 — cohérent
avec le choix déjà fait pour les statuts de présence). L'attribution est vérifiée
à la volée au chargement du tableau de bord, comme les rappels d'événements et les
pénalités no-show : pas besoin d'un scheduler pour un MVP.
"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models as m
from app.services.gamification import award_points

BADGE_BONUS_POINTS = 15  # bonus ponctuel à l'obtention d'un badge (en plus des points normaux)

# (code, nom, description, icône)
CATALOG = [
    ("premier_pas", "Premier pas", "Réserver sa toute première place de coworking.", "🎯"),
    ("habitue", "Habitué", "Réserver 10 places de coworking.", "🏢"),
    ("sans_faute", "Sans faute", "5 réservations honorées sans aucun no-show.", "✅"),
    ("curieux", "Curieux", "Répondre à son premier quiz.", "🧠"),
    ("sans_faute_quiz", "Sans-faute quiz", "Réussir un quiz avec 100% de bonnes réponses.", "🏆"),
    ("idee_lumineuse", "Idée lumineuse", "Soumettre sa première idée.", "💡"),
    ("populaire", "Populaire", "Recevoir 5 votes ou plus sur une idée.", "⭐"),
    ("sociable", "Sociable", "S'inscrire à 3 événements ou plus.", "🎉"),
]


def _catalog_map(db: Session) -> dict[str, m.Badge]:
    rows = db.scalars(select(m.Badge))
    return {b.code: b for b in rows}


def seed_catalog_if_empty(db: Session) -> int:
    existing = {b.code for b in db.scalars(select(m.Badge))}
    created = 0
    for code, name, description, icon in CATALOG:
        if code not in existing:
            db.add(m.Badge(code=code, name=name, description=description, icon=icon))
            created += 1
    if created:
        db.commit()
    return created


def _award(db: Session, user_id: int, badge: m.Badge, already: set[int]) -> bool:
    if badge.id in already:
        return False
    db.add(m.UserBadge(user_id=user_id, badge_id=badge.id))
    award_points(db, user_id, BADGE_BONUS_POINTS, f"badge_{badge.code}")
    return True


def check_and_award(db: Session, user_id: int) -> list[str]:
    """Vérifie tous les critères et attribue les badges manquants. Renvoie les noms
    des badges nouvellement obtenus (pour affichage d'une notif/toast côté front)."""
    catalog = _catalog_map(db)
    if not catalog:
        return []
    already = {ub.badge_id for ub in db.scalars(select(m.UserBadge).where(m.UserBadge.user_id == user_id))}
    newly: list[str] = []

    reservation_count = db.scalar(
        select(func.count()).select_from(m.Reservation).where(
            m.Reservation.user_id == user_id, m.Reservation.status != m.ReservationStatus.CANCELLED,
        )
    ) or 0
    if reservation_count >= 1 and "premier_pas" in catalog and _award(db, user_id, catalog["premier_pas"], already):
        newly.append(catalog["premier_pas"].name)
    if reservation_count >= 10 and "habitue" in catalog and _award(db, user_id, catalog["habitue"], already):
        newly.append(catalog["habitue"].name)

    honored_count = db.scalar(
        select(func.count()).select_from(m.Reservation).where(
            m.Reservation.user_id == user_id, m.Reservation.status == m.ReservationStatus.BOOKED,
            m.Reservation.checked_in_at.isnot(None),
        )
    ) or 0
    noshow_count = db.scalar(
        select(func.count()).select_from(m.Reservation).where(
            m.Reservation.user_id == user_id, m.Reservation.status == m.ReservationStatus.NO_SHOW,
        )
    ) or 0
    if honored_count >= 5 and noshow_count == 0 and "sans_faute" in catalog and _award(db, user_id, catalog["sans_faute"], already):
        newly.append(catalog["sans_faute"].name)

    quiz_attempts = db.scalar(
        select(func.count()).select_from(m.QuizAttempt).where(m.QuizAttempt.user_id == user_id)
    ) or 0
    if quiz_attempts >= 1 and "curieux" in catalog and _award(db, user_id, catalog["curieux"], already):
        newly.append(catalog["curieux"].name)
    perfect_quiz = db.scalar(
        select(func.count()).select_from(m.QuizAttempt).where(
            m.QuizAttempt.user_id == user_id, m.QuizAttempt.score == m.QuizAttempt.total,
        )
    ) or 0
    if perfect_quiz >= 1 and "sans_faute_quiz" in catalog and _award(db, user_id, catalog["sans_faute_quiz"], already):
        newly.append(catalog["sans_faute_quiz"].name)

    idea_count = db.scalar(select(func.count()).select_from(m.Idea).where(m.Idea.author_id == user_id)) or 0
    if idea_count >= 1 and "idee_lumineuse" in catalog and _award(db, user_id, catalog["idee_lumineuse"], already):
        newly.append(catalog["idee_lumineuse"].name)
    max_votes = db.scalar(
        select(func.count(m.IdeaVote.id)).select_from(m.Idea).join(m.IdeaVote, m.IdeaVote.idea_id == m.Idea.id)
        .where(m.Idea.author_id == user_id).group_by(m.Idea.id).order_by(func.count(m.IdeaVote.id).desc())
    )
    if (max_votes or 0) >= 5 and "populaire" in catalog and _award(db, user_id, catalog["populaire"], already):
        newly.append(catalog["populaire"].name)

    event_regs = db.scalar(
        select(func.count()).select_from(m.EventRegistration).where(
            m.EventRegistration.user_id == user_id,
            m.EventRegistration.status.in_([m.EventRegistrationStatus.REGISTERED, m.EventRegistrationStatus.WAITLISTED]),
        )
    ) or 0
    if event_regs >= 3 and "sociable" in catalog and _award(db, user_id, catalog["sociable"], already):
        newly.append(catalog["sociable"].name)

    if newly:
        db.commit()
    return newly


def get_user_badges(db: Session, user_id: int) -> list[dict]:
    """Catalogue complet avec état obtenu/non-obtenu, pour affichage sur le profil."""
    earned_ids = {ub.badge_id for ub in db.scalars(select(m.UserBadge).where(m.UserBadge.user_id == user_id))}
    badges = db.scalars(select(m.Badge).order_by(m.Badge.id))
    return [
        {"code": b.code, "name": b.name, "description": b.description, "icon": b.icon, "earned": b.id in earned_ids}
        for b in badges
    ]
