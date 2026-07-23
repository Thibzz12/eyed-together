"""Service utilisateurs : création/mise à jour depuis les informations Microsoft."""

from sqlalchemy import select
from sqlalchemy.orm import Session

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
