"""Routes d'authentification SSO Microsoft.

Parcours :
  /auth/login    -> redirige l'utilisateur vers la page de connexion Microsoft
  /auth/callback -> Microsoft renvoie ici ; on échange le code contre l'identité
  /auth/logout   -> vide la session
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.msal_client import SCOPES, build_msal_app
from app.core.config import settings
from app.db import models as m
from app.db.session import get_db
from app.services.users import sync_admin_role, upsert_user_from_claims
from app.services.wordpress import WordPressAuthError, authenticate_wp, verify_bridge_token

router = APIRouter(prefix="/auth", tags=["auth"])


class WordPressLogin(BaseModel):
    email: str
    password: str


def _open_session(request: Request, user: m.User) -> None:
    """Ouvre la session applicative (aucun jeton/mot de passe côté client)."""
    request.session["user"] = {
        "id": user.id,
        "email": user.email,
        "name": user.display_name,
        "role": user.role.value,
    }


@router.get("/wordpress-start")
def wordpress_start():
    """Démarre la connexion : envoie l'utilisateur vers le 'pont' de l'intranet."""
    return RedirectResponse(f"{settings.WORDPRESS_URL}/?eyed_bridge=1")


@router.get("/wordpress-callback")
def wordpress_callback(token: str, request: Request, db: Session = Depends(get_db)):
    """Retour du pont : vérifie le jeton signé et ouvre la session."""
    claims = verify_bridge_token(token)
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Jeton de connexion invalide ou expiré.")
    user = upsert_user_from_claims(db, claims)
    sync_admin_role(db, user)
    _open_session(request, user)
    return RedirectResponse("/")


@router.post("/wordpress-login")
def wordpress_login(data: WordPressLogin, request: Request, db: Session = Depends(get_db)):
    """Connexion avec les identifiants WordPress (validés côté intranet)."""
    try:
        claims = authenticate_wp(data.email, data.password)
    except WordPressAuthError as exc:
        # DEBUG : on affiche la vraie raison renvoyée par WordPress.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"WordPress → {exc}")
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Connexion WordPress pas encore configurée.")
    user = upsert_user_from_claims(db, claims)
    sync_admin_role(db, user)
    _open_session(request, user)
    return {"ok": True, "name": user.display_name}


def _sso_configured() -> bool:
    """Vrai seulement si les 3 identifiants Azure sont renseignés."""
    return bool(settings.ENTRA_TENANT_ID and settings.ENTRA_CLIENT_ID and settings.ENTRA_CLIENT_SECRET)


@router.get("/login")
def login(request: Request):
    """Démarre le SSO : construit l'URL Microsoft et y redirige l'utilisateur."""
    # Garde-fou : message clair tant que les identifiants Azure ne sont pas configurés.
    if not _sso_configured():
        return HTMLResponse(
            """<!doctype html><html lang="fr"><head><meta charset="utf-8">
            <title>SSO non configuré</title>
            <style>body{font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#1a1a2e}
            code{background:#f4f4f8;padding:2px 6px;border-radius:4px}
            .box{background:#fff7e6;border:1px solid #ffd591;border-radius:10px;padding:20px}</style></head>
            <body><div class="box">
            <h1>⚙️ SSO Microsoft pas encore configuré</h1>
            <p>Le serveur fonctionne, mais il manque les identifiants Azure. Pour activer le bouton :</p>
            <ol>
              <li>Crée une <b>App Registration</b> sur <code>portal.azure.com</code></li>
              <li>Copie <code>.env.example</code> vers <code>.env</code></li>
              <li>Renseigne <code>ENTRA_TENANT_ID</code>, <code>ENTRA_CLIENT_ID</code>, <code>ENTRA_CLIENT_SECRET</code></li>
              <li>Relance le serveur</li>
            </ol>
            <p><a href="/">← Retour</a></p>
            </div></body></html>""",
            status_code=503,
        )

    msal_app = build_msal_app()
    # initiate_auth_code_flow génère l'URL + le state (anti-CSRF) + PKCE.
    flow = msal_app.initiate_auth_code_flow(
        scopes=SCOPES,
        redirect_uri=settings.ENTRA_REDIRECT_URI,
    )
    # On mémorise le flow côté serveur (cookie de session signé) le temps de l'aller-retour.
    request.session["auth_flow"] = flow
    return RedirectResponse(flow["auth_uri"])


@router.get("/callback")
def callback(request: Request, db: Session = Depends(get_db)):
    """Retour de Microsoft : valide la réponse et ouvre la session applicative."""
    flow = request.session.pop("auth_flow", None)
    if not flow:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Flux d'authentification expiré. Recommencez la connexion.")

    msal_app = build_msal_app()
    # MSAL vérifie ici le `state` (anti-CSRF), le PKCE et la signature du jeton.
    result = msal_app.acquire_token_by_auth_code_flow(flow, dict(request.query_params))

    if "error" in result:
        detail = result.get("error_description", result["error"])
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Échec de la connexion Microsoft : {detail}")

    claims = result.get("id_token_claims", {})
    user = upsert_user_from_claims(db, claims)
    sync_admin_role(db, user)

    # Session minimale : on ne stocke PAS le jeton Microsoft côté client.
    request.session["user"] = {
        "id": user.id,
        "email": user.email,
        "name": user.display_name,
        "role": user.role.value,
    }
    # Retour vers le frontend, connecté.
    return RedirectResponse(settings.FRONTEND_ORIGIN)


@router.get("/dev-login")
def dev_login(request: Request, db: Session = Depends(get_db)):
    """[DÉVELOPPEMENT UNIQUEMENT] Simule une connexion Microsoft, sans Azure.

    Permet de construire et tester toute l'application avant d'avoir l'App Registration.
    🔒 Automatiquement désactivé en production (renvoie 404).
    """
    if settings.is_production:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Introuvable.")

    # Faux employé de test (mêmes champs que ceux fournis par Microsoft).
    fake_claims = {
        "oid": "dev-user-0001",
        "preferred_username": "thibaud.test@entreprise.com",
        "name": "Thibaud (compte démo)",
    }
    user = upsert_user_from_claims(db, fake_claims)
    # Le compte démo est admin, pour pouvoir tester l'espace d'administration.
    if user.role != m.UserRole.ADMIN:
        user.role = m.UserRole.ADMIN
        db.commit()
    _open_session(request, user)
    return RedirectResponse("/")  # retour à la page de test


@router.get("/logout")
def logout(request: Request):
    """Déconnexion locale : vide la session."""
    request.session.clear()
    return RedirectResponse("/")
