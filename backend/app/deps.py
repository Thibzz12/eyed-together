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


def require_admin(request: Request, db: Session = Depends(get_db)) -> dict:
    """Exige le rôle admin (défense en profondeur pour les routes d'administration).

    Le rôle se relit en base, pas dans la session : un administrateur rétrogradé
    depuis Collaborateurs gardait sinon ses droits jusqu'à l'expiration de sa
    session, jusqu'à huit heures (audit du 07/10/2026).
    """
    user = get_current_user(request)
    row = db.get(m.User, user["id"])
    if row is None or row.role != m.UserRole.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès réservé aux administrateurs.")
    user["role"] = "admin"
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


def require_screen_link(token: str, db: Session = Depends(get_db)) -> m.DeviceLink:
    """Authentifie un écran d'affichage par le jeton de son lien (paramètre de route).

    Pas de session ici : l'appareil n'a personne pour se connecter. Un jeton
    inconnu ou révoqué donne un 404 indistinct, pour ne pas confirmer à un
    curieux qu'un lien a existé.
    """
    from app.services import devices as devices_svc

    link = devices_svc.resolve(db, token, kind="screen")
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lien inconnu ou révoqué.")
    return link


def require_kiosk_link(token: str, db: Session = Depends(get_db)) -> m.DeviceLink:
    """Authentifie une tablette de pointage par le jeton de son lien. Même logique que l'écran."""
    from app.services import devices as devices_svc

    link = devices_svc.resolve(db, token, kind="kiosk")
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lien inconnu ou révoqué.")
    return link
