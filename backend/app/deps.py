"""Dépendances FastAPI réutilisables (autorisation)."""

from fastapi import HTTPException, Request, status


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
