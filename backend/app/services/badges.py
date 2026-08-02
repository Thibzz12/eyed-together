"""Badges de gamification : catalogue fixe, attribution automatique.

Le catalogue est codé en dur (pas de création de badge à la volée en V1 — cohérent
avec le choix déjà fait pour les statuts de présence). L'attribution est vérifiée
à la volée au chargement du tableau de bord, comme les rappels d'événements et les
pénalités no-show : pas besoin d'un scheduler pour un MVP.

Familles à PALIERS (I/II/III/IV) plutôt qu'un badge unique par activité : ça donne
un horizon de progression sur plusieurs mois/années au lieu d'un jeu "terminé" après
une semaine — cohérent avec la progression de niveau à paliers infinis (profile.py).
"""

import re
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models as m
from app.services.gamification import award_points

DEFAULT_BADGE_POINTS = 15  # valeur par défaut pour un nouveau badge (modifiable ensuite par badge)


class BadgeError(Exception):
    status_code = 400

TIER_NUMERALS = ["I", "II", "III", "IV", "V"]

# clé -> (nom de base, gabarit de description, icône, seuils croissants)
TIERED_FAMILIES: dict[str, tuple[str, str, str, list[int]]] = {
    "habitue": ("Habitué", "Réserver {n} places de coworking.", "🏢", [10, 50, 200, 500]),
    "quiz_master": ("Quiz Master", "Répondre à {n} quiz au total.", "🧠", [1, 10, 30, 100]),
    "sociable": ("Sociable", "S'inscrire à {n} événements.", "🎉", [3, 10, 30]),
    "assidu": ("Assidu", "{n} jours de présence confirmée d'affilée.", "🔥", [3, 10, 25, 60]),
    "idee_lumineuse": ("Idée lumineuse", "Soumettre {n} idée(s).", "💡", [1, 5, 20]),
}

# badges à palier unique (pas de progression, juste obtenu/non obtenu)
SINGLE_BADGES = [
    ("sans_faute", "Sans faute", "5 réservations honorées sans aucun no-show.", "✅"),
    ("sans_faute_quiz", "Sans-faute quiz", "Réussir un quiz avec 100% de bonnes réponses.", "🏆"),
    ("populaire", "Populaire", "Recevoir 5 votes ou plus sur une idée.", "⭐"),
]


def compute_streak(db: Session, user_id: int) -> int:
    """Nombre de jours ouvrés consécutifs (jusqu'à aujourd'hui inclus) avec présence
    confirmée (check-in). S'arrête au 1er jour ouvré manquant en remontant dans le temps."""
    checked_days = set(db.scalars(
        select(m.Reservation.reservation_date).where(
            m.Reservation.user_id == user_id, m.Reservation.checked_in_at.isnot(None),
        ).distinct()
    ))
    if not checked_days:
        return 0
    streak = 0
    day = date.today()
    while True:
        if day.weekday() >= 5:  # week-end : on saute sans casser la série
            day -= timedelta(days=1)
            continue
        if day in checked_days:
            streak += 1
            day -= timedelta(days=1)
        else:
            break
    return streak


def _tier_code(base: str, tier: int) -> str:
    return f"{base}_{tier + 1}"


def _full_catalog() -> list[tuple[str, str, str, str]]:
    out = list(SINGLE_BADGES)
    for base, (name, desc_tpl, icon, thresholds) in TIERED_FAMILIES.items():
        for tier, n in enumerate(thresholds):
            numeral = TIER_NUMERALS[tier] if tier < len(TIER_NUMERALS) else str(tier + 1)
            out.append((_tier_code(base, tier), f"{name} {numeral}", desc_tpl.format(n=n), icon))
    return out


def seed_catalog_if_empty(db: Session) -> int:
    """Crée les badges manquants ET retire ceux qui ne sont plus dans le catalogue
    (ex: anciens badges à palier unique remplacés par des familles à paliers I/II/III...).

    Ne touche jamais aux badges personnalisés (is_custom=True, ajoutés depuis l'admin) :
    ils n'existent pas dans _full_catalog() mais ne doivent surtout pas être supprimés.
    """
    current_codes = {code for code, *_ in _full_catalog()}
    existing = {b.code: b for b in db.scalars(select(m.Badge))}
    created = 0
    changed = False
    for code, name, description, icon in _full_catalog():
        if code not in existing:
            db.add(m.Badge(code=code, name=name, description=description, icon=icon))
            created += 1
            changed = True
    for code, badge in existing.items():
        if badge.is_custom:
            continue
        if code not in current_codes:
            for ub in db.scalars(select(m.UserBadge).where(m.UserBadge.badge_id == badge.id)):
                db.delete(ub)
            db.delete(badge)
            changed = True
    if changed:
        db.commit()
    return created


def _slugify_code(label: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "badge"
    return base


def badge_to_dict(b: m.Badge, earned_count: int = 0) -> dict:
    return {
        "id": b.id, "code": b.code, "name": b.name, "description": b.description,
        "icon": b.icon, "points": b.points, "is_custom": b.is_custom, "earned_count": earned_count,
    }


def list_all_badges(db: Session) -> list[dict]:
    """Catalogue complet pour l'admin, avec le nombre de collaborateurs l'ayant obtenu."""
    counts = dict(
        db.execute(select(m.UserBadge.badge_id, func.count()).group_by(m.UserBadge.badge_id)).all()
    )
    badges = db.scalars(select(m.Badge).order_by(m.Badge.id))
    return [badge_to_dict(b, counts.get(b.id, 0)) for b in badges]


def create_custom_badge(db: Session, name: str, description: str, icon: str, points: int = DEFAULT_BADGE_POINTS) -> m.Badge:
    name = (name or "").strip()
    if not name:
        raise BadgeError("Le nom est obligatoire.")
    existing_codes = {b.code for b in db.scalars(select(m.Badge))}
    base = _slugify_code(name)
    code, i = base, 2
    while code in existing_codes:
        code = f"{base}_{i}"; i += 1
    badge = m.Badge(
        code=code, name=name, description=(description or "").strip() or None,
        icon=(icon or "").strip() or "🏅", points=points,
        is_custom=True,
    )
    db.add(badge)
    db.commit()
    db.refresh(badge)
    return badge


def update_badge(
    db: Session, badge_id: int, name: str | None, description: str | None, icon: str | None,
    points: int | None = None,
) -> m.Badge:
    badge = db.get(m.Badge, badge_id)
    if badge is None:
        raise BadgeError("Badge introuvable.")
    if name is not None:
        name = name.strip()
        if not name:
            raise BadgeError("Le nom est obligatoire.")
        badge.name = name
    if description is not None:
        badge.description = description.strip() or None
    if icon is not None:
        badge.icon = icon.strip() or badge.icon
    if points is not None:
        badge.points = points
    db.commit()
    db.refresh(badge)
    return badge


def delete_badge(db: Session, badge_id: int) -> None:
    badge = db.get(m.Badge, badge_id)
    if badge is None:
        return
    db.delete(badge)  # cascade="all, delete-orphan" supprime aussi les UserBadge associés
    db.commit()


def award_badge_manually(db: Session, badge_id: int, user_id: int) -> None:
    badge = db.get(m.Badge, badge_id)
    if badge is None:
        raise BadgeError("Badge introuvable.")
    if db.get(m.User, user_id) is None:
        raise BadgeError("Utilisateur introuvable.")
    already = db.scalar(
        select(m.UserBadge).where(m.UserBadge.badge_id == badge_id, m.UserBadge.user_id == user_id)
    )
    if already:
        return
    db.add(m.UserBadge(user_id=user_id, badge_id=badge_id))
    award_points(db, user_id, badge.points, f"badge_{badge.code}")
    db.commit()


def revoke_badge_manually(db: Session, badge_id: int, user_id: int) -> None:
    """Retire un badge attribué manuellement (ex: erreur de clic) — reprend aussi les points
    bonus accordés à l'obtention, pour ne pas laisser un gain de points issu d'une erreur."""
    ub = db.scalar(select(m.UserBadge).where(m.UserBadge.badge_id == badge_id, m.UserBadge.user_id == user_id))
    if ub is None:
        return
    badge = ub.badge  # FK NOT NULL + cascade delete-orphan sur Badge.user_badges : toujours présent ici
    db.delete(ub)
    award_points(db, user_id, -badge.points, f"revoke_badge_{badge.code}")
    db.commit()


def _catalog_map(db: Session) -> dict[str, m.Badge]:
    return {b.code: b for b in db.scalars(select(m.Badge))}


def _award(db: Session, user_id: int, badge: m.Badge, already: set[int], newly: list[str]) -> None:
    if badge.id in already:
        return
    db.add(m.UserBadge(user_id=user_id, badge_id=badge.id))
    award_points(db, user_id, badge.points, f"badge_{badge.code}")
    already.add(badge.id)
    newly.append(badge.name)


def _award_tiers(db: Session, user_id: int, base: str, count: int, catalog: dict, already: set, newly: list) -> None:
    thresholds = TIERED_FAMILIES[base][3]
    for tier, n in enumerate(thresholds):
        if count >= n:
            code = _tier_code(base, tier)
            if code in catalog:
                _award(db, user_id, catalog[code], already, newly)


def check_and_award(db: Session, user_id: int) -> list[str]:
    """Vérifie tous les critères et attribue les badges manquants (tous les paliers
    atteints, pas seulement le dernier). Renvoie les noms nouvellement obtenus."""
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
    _award_tiers(db, user_id, "habitue", reservation_count, catalog, already, newly)

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
    if honored_count >= 5 and noshow_count == 0 and "sans_faute" in catalog:
        _award(db, user_id, catalog["sans_faute"], already, newly)

    quiz_attempts = db.scalar(
        select(func.count()).select_from(m.QuizAttempt).where(m.QuizAttempt.user_id == user_id)
    ) or 0
    _award_tiers(db, user_id, "quiz_master", quiz_attempts, catalog, already, newly)
    perfect_quiz = db.scalar(
        select(func.count()).select_from(m.QuizAttempt).where(
            m.QuizAttempt.user_id == user_id, m.QuizAttempt.score == m.QuizAttempt.total,
        )
    ) or 0
    if perfect_quiz >= 1 and "sans_faute_quiz" in catalog:
        _award(db, user_id, catalog["sans_faute_quiz"], already, newly)

    idea_count = db.scalar(select(func.count()).select_from(m.Idea).where(m.Idea.author_id == user_id)) or 0
    _award_tiers(db, user_id, "idee_lumineuse", idea_count, catalog, already, newly)
    max_votes = db.scalar(
        select(func.count(m.IdeaVote.id)).select_from(m.Idea).join(m.IdeaVote, m.IdeaVote.idea_id == m.Idea.id)
        .where(m.Idea.author_id == user_id).group_by(m.Idea.id).order_by(func.count(m.IdeaVote.id).desc())
    )
    if (max_votes or 0) >= 5 and "populaire" in catalog:
        _award(db, user_id, catalog["populaire"], already, newly)

    event_regs = db.scalar(
        select(func.count()).select_from(m.EventRegistration).where(
            m.EventRegistration.user_id == user_id,
            m.EventRegistration.status.in_([m.EventRegistrationStatus.REGISTERED, m.EventRegistrationStatus.WAITLISTED]),
        )
    ) or 0
    _award_tiers(db, user_id, "sociable", event_regs, catalog, already, newly)

    streak = compute_streak(db, user_id)
    _award_tiers(db, user_id, "assidu", streak, catalog, already, newly)

    if newly:
        db.commit()
    return newly


def get_user_badges(db: Session, user_id: int) -> list[dict]:
    """Catalogue complet avec état obtenu/non-obtenu, pour affichage sur le profil."""
    earned_ids = {ub.badge_id for ub in db.scalars(select(m.UserBadge).where(m.UserBadge.user_id == user_id))}
    badges = db.scalars(select(m.Badge).order_by(m.Badge.id))
    return [
        {
            "id": b.id, "code": b.code, "name": b.name, "description": b.description,
            "icon": b.icon, "points": b.points, "earned": b.id in earned_ids,
        }
        for b in badges
    ]
