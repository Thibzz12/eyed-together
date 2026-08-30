"""Service utilisateurs : création/mise à jour depuis les informations Microsoft."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db import models as m


def upsert_user_from_claims(db: Session, claims: dict) -> m.User:
    """Crée l'utilisateur à sa 1re connexion, ou met à jour ses infos ensuite.

    `claims` = contenu du jeton d'identité Microsoft (vérifié par MSAL).
    On n'y stocke AUCUN mot de passe : l'identité est déléguée à Microsoft.
    """
    # `oid` = identifiant unique et stable de l'employé dans le tenant.
    oid = claims.get("oid") or claims.get("sub")
    if not oid:
        raise ValueError("Jeton Microsoft invalide : identifiant 'oid' absent.")

    email = claims.get("preferred_username") or claims.get("email") or ""
    name = claims.get("name") or email or "Utilisateur"

    user = db.scalar(select(m.User).where(m.User.entra_oid == oid))
    if user is None:
        user = m.User(entra_oid=oid, email=email, display_name=name)
        db.add(user)
    else:
        # Synchronise les infos au cas où elles changent côté annuaire.
        user.email = email or user.email
        user.display_name = name or user.display_name

    db.commit()
    db.refresh(user)
    return user


def sync_admin_role(db: Session, user: m.User) -> None:
    """Applique la liste blanche d'admins (`settings.ADMIN_EMAILS`) à chaque connexion.

    La liste blanche AMORCE les droits : quiconque y figure est administrateur à
    sa connexion, ce qui garantit qu'il reste toujours au moins un accès même si
    la base est repartie de zéro. Elle ne rétrograde plus personne.

    Depuis le 29/08/2026, un administrateur peut en nommer d'autres depuis
    l'application (demande d'Olivier). Rétrograder automatiquement toute personne
    absente de la variable d'environnement aurait annulé cette promotion à la
    connexion suivante, sans que personne comprenne pourquoi. Le rôle stocké en
    base fait donc foi, et le retrait des droits est une action explicite depuis
    Administration → Collaborateurs.

    Un admin WordPress n'est toujours pas automatiquement admin de cette app.
    """
    if user.email.lower() in settings.admin_emails and user.role != m.UserRole.ADMIN:
        user.role = m.UserRole.ADMIN
        db.commit()
        db.refresh(user)


def set_role(db: Session, target: m.User, admin: bool, demandeur_id: int) -> m.User:
    """Donne ou retire les droits d'administrateur à un collaborateur.

    Deux garde-fous : on ne se retire pas ses propres droits (personne ne se
    verrouille dehors par mégarde), et on ne retire pas ceux d'une personne
    inscrite dans `ADMIN_EMAILS`, que sa prochaine connexion repromouvrait
    aussitôt — mieux vaut le dire que laisser croire à un bug.
    """
    if target.id == demandeur_id and not admin:
        raise ValueError("Tu ne peux pas retirer tes propres droits d'administrateur.")
    if not admin and target.email.lower() in settings.admin_emails:
        raise ValueError(
            "Cette personne est administrateur par configuration du serveur : "
            "retire son adresse de ADMIN_EMAILS pour lui enlever ses droits."
        )
    target.role = m.UserRole.ADMIN if admin else m.UserRole.EMPLOYEE
    db.commit()
    db.refresh(target)
    return target
