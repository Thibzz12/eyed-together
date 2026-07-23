"""Logique de gamification : attribution des points de collaboration.

Le journal `PointTransaction` est la source de vérité (append-only, auditable) ;
`user.total_points` n'en est que le cumul, mis à jour en même temps.
"""

from sqlalchemy.orm import Session

from app.db import models as m

# Points gagnés à chaque réservation validée.
POINTS_PER_BOOKING = 10


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
