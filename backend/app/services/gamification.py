"""Logique de gamification : attribution des points de collaboration.

Le journal `PointTransaction` est la source de vérité (append-only, auditable) ;
`user.total_points` n'en est que le cumul, mis à jour en même temps.
"""

from sqlalchemy.orm import Session

from app.db import models as m

# Points gagnés à chaque réservation validée.
POINTS_PER_BOOKING = 10

# Points gagnés en confirmant son arrivée dans les locaux, une fois par jour.
POINTS_PER_CHECKIN = 5


def points_rules(noshow_penalty: int) -> list[dict]:
    """Barème lisible par un employé, construit à partir des constantes réelles.

    Source unique de vérité : la page Récompenses lit ce barème plutôt que de
    recopier des chiffres qui divergeraient au premier ajustement.
    """
    return [
        {
            "label": "Réserver une place pour une demi-journée",
            "points": POINTS_PER_BOOKING,
        },
        {
            "label": "Réserver une place pour la journée entière",
            "points": POINTS_PER_BOOKING * 2,
            "note": "Une journée compte comme deux demi-journées.",
        },
        {
            "label": "Confirmer ton arrivée dans les locaux",
            "points": POINTS_PER_CHECKIN,
            "note": "Une seule fois par jour.",
        },
        {
            "label": "Annuler une réservation",
            "points": -POINTS_PER_BOOKING,
            "note": "Les points de la réservation sont repris.",
        },
        {
            "label": "Réserver sans venir, sans confirmer sa présence",
            "points": -noshow_penalty,
            "note": "Par demi-journée non confirmée. Une place réservée et vide prive un collègue.",
        },
        {
            "label": "Réserver une bulle calme",
            "points": 0,
            "note": "Les bulles calmes ne rapportent pas de points.",
        },
    ]


def award_points(db: Session, user_id: int, amount: int, reason: str) -> None:
    """Enregistre un mouvement de points et met à jour le cumul de l'utilisateur.

    N.B. : ne fait PAS de commit — c'est l'appelant (le service métier) qui valide
    la transaction complète, pour que points et réservation soient cohérents.
    """
    user = db.get(m.User, user_id)
    if user is None:
        return
    db.add(m.PointTransaction(user_id=user_id, amount=amount, reason=reason))
    user.total_points = (user.total_points or 0) + amount
