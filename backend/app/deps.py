"""Dépendances FastAPI réutilisables (autorisation)."""

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.db import models as m
from app.db.session import get_db


def get_current_user(request: Request) -> dict:
    """Exige une session valide. Renvoie 401 si l'utilisateur n'est pas connecté."""
    user = request.session.get("user")
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Non authentifié.")
    return user


def require_admin(request: Request) -> dict:
    """Exige le rôle admin (défense en profondeur pour les routes d'administration)."""
    user = get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès réservé aux administrateurs.")
    return user


def manages_presence(db: Session, user: dict) -> bool:
    """Cette personne peut-elle administrer la présence (liste d'évacuation) ?

    Vrai pour les administrateurs et pour les « responsables présence ». Le droit
    se lit en base et non dans la session : accordé pour raison de sécurité
    incendie, il doit être effectif immédiatement, pas à la prochaine connexion.
    """
    if user.get("role") == "admin":
        return True
    row = db.get(m.User, user["id"])
    return row is not None and row.can_manage_presence


def require_presence_access(
    user: dict = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict:
    """Exige le droit d'administrer la présence : admin OU responsable présence."""
    if not manages_presence(db, user):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Accès réservé aux administrateurs et aux responsables présence.",
        )
    return user
