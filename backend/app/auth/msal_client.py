"""Client MSAL — SSO Microsoft Entra ID.

MSAL est la librairie OFFICIELLE de Microsoft. On utilise le flux le plus sûr :
Authorization Code Flow + PKCE (MSAL gère automatiquement le `state` anti-CSRF,
le `nonce` et le code_verifier PKCE via `initiate_auth_code_flow`).
"""

import msal

from app.core.config import settings

# Scopes demandés. MSAL ajoute automatiquement openid/profile/offline_access.
# "User.Read" permet, si besoin plus tard, d'interroger Microsoft Graph (ex: le département).
SCOPES: list[str] = ["User.Read"]


def _authority() -> str:
    """URL du tenant Entra ID de l'entreprise."""
    return f"https://login.microsoftonline.com/{settings.ENTRA_TENANT_ID}"


def build_msal_app() -> msal.ConfidentialClientApplication:
    """Construit l'application MSAL confidentielle (secret côté serveur uniquement)."""
    return msal.ConfidentialClientApplication(
        client_id=settings.ENTRA_CLIENT_ID,
        client_credential=settings.ENTRA_CLIENT_SECRET,
        authority=_authority(),
    )
