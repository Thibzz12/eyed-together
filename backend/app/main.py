"""Point d'entrée de l'API FastAPI + assemblage des couches de sécurité."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from app.api.router import router as api_router
from app.auth.router import router as auth_router
from app.core.config import settings
from app.core.security_headers import SecurityHeadersMiddleware
from app.db import models  # noqa: F401  -> enregistre les tables dans Base.metadata
from app.db.base import Base
from app.db.seed import (
    cleanup_demo_colleagues_if_present,
    limit_bureau_seats_if_needed,
    seed_dashboard_if_empty,
    seed_desks_if_empty,
    seed_pods_if_missing,
    seed_useful_links_if_missing,
)
from app.core.errors import AppError
from app.services.badges import seed_catalog_if_empty as seed_badges_if_empty
from app.db.session import SessionLocal, engine, get_db
from app.deps import get_current_user


def _seed_reference_data(db: Session) -> None:
    """Garnit les données de référence : postes, bulles calmes, liens utiles,
    cartes d'accueil et catalogue de badges."""
    seed_desks_if_empty(db)
    seed_pods_if_missing(db)
    seed_useful_links_if_missing(db)
    seed_dashboard_if_empty(db)
    seed_badges_if_empty(db)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Au démarrage : en DEV (SQLite), crée les tables et les postes de démo.

    En production, c'est Alembic qui gère le schéma (jamais create_all) et on ne
    garnit QUE les bases réellement vierges : rejouer les seeds à chaque
    redémarrage ressusciterait les liens ou les cartes qu'un admin a supprimés.
    """
    if not settings.is_production and settings.DATABASE_URL.startswith("sqlite"):
        Base.metadata.create_all(bind=engine)
        with SessionLocal() as db:
            _seed_reference_data(db)
            # Rattrapages de données historiques, propres aux bases de dev.
            cleanup_demo_colleagues_if_present(db)
            limit_bureau_seats_if_needed(db)
    else:
        with SessionLocal() as db:
            if db.scalar(select(func.count()).select_from(models.Desk)) == 0:
                _seed_reference_data(db)
    yield


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError):
    """Traduit toute erreur métier (réservations, présence, quiz…) en réponse HTTP
    claire (400, 403, 404, 409…), avec le code porté par la classe d'erreur."""
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

# --- Session signée (itsdangerous) : cookie httpOnly + Secure(prod) ---
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SECRET_KEY,
    session_cookie=settings.SESSION_COOKIE_NAME,
    # 'lax' est INDISPENSABLE pour l'OAuth : le cookie portant le state anti-CSRF
    # doit survivre à la redirection de retour depuis Microsoft (Strict le supprimerait).
    same_site="lax",
    https_only=settings.is_production,
    max_age=8 * 3600,  # 8 h
)

# --- En-têtes de sécurité ---
app.add_middleware(SecurityHeadersMiddleware)

# --- Compression : réduit la taille des réponses JSON/JS/CSS, sensible sur mobile ---
app.add_middleware(GZipMiddleware, minimum_size=500)

# --- CORS strict : seule l'origine du frontend est autorisée ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(api_router)

# --- Frontend : fichiers statiques (CSS/JS) + page d'accueil ---
_STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    """Sert l'application (le frontend gère l'état connecté/non connecté)."""
    return FileResponse(_STATIC_DIR / "index.html")


@app.get("/ecran/{token}", include_in_schema=False)
def ecran(token: str):
    """Grand écran : le plan du jour en lecture seule, authentifié par le lien.

    La page est servie telle quelle ; c'est son script qui présente le jeton à
    l'API et affiche « lien révoqué » si celle-ci le refuse. Ainsi un lien mort
    ne révèle rien de plus qu'une page vide.
    """
    return FileResponse(_STATIC_DIR / "screen.html")


@app.get("/pointage/{token}", include_in_schema=False)
def pointage(token: str):
    """Tablette de l'entrée : chacun confirme son arrivée et son départ en touchant son nom."""
    return FileResponse(_STATIC_DIR / "kiosk.html")


class _FiltreSondes(logging.Filter):
    """Écarte les sondes de disponibilité du journal d'accès.

    Le réveil planifié frappe /health/db toutes les dix minutes en heures
    ouvrées : sans ce filtre, ces appels noieraient les vraies requêtes le jour
    où on cherche un incident dans les logs de l'hébergeur.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        chemin = record.args[2] if record.args and len(record.args) > 2 else ""
        return not str(chemin).startswith("/health")


logging.getLogger("uvicorn.access").addFilter(_FiltreSondes())


@app.get("/health", tags=["system"])
def health():
    """Sonde de disponibilité."""
    return {"status": "ok"}


@app.get("/health/db", tags=["system"])
def health_db(db: Session = Depends(get_db)):
    """Sonde de réveil : touche la base pour que l'hébergement gratuit la garde active.

    Render endort le service après quinze minutes sans requête et Supabase met le
    projet en pause après sept jours sans activité sur la base. Un appel planifié
    aux heures de bureau couvre les deux.

    Volontairement séparée de /health, que Render interroge pour décider si le
    conteneur est vivant : y brancher la base ferait redémarrer l'application en
    boucle au moindre hoquet de Supabase, alors que le service, lui, va bien.
    """
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(status_code=503, content={"status": "db-unreachable"})
    return {"status": "ok"}


@app.get("/robots.txt", include_in_schema=False)
def robots():
    """Interdit l'indexation par les moteurs de recherche (app interne, accès par lien direct uniquement)."""
    return FileResponse(_STATIC_DIR / "robots.txt")


@app.get("/api/me", tags=["auth"])
def me(user: dict = Depends(get_current_user)):
    """Route protégée : renvoie l'utilisateur de session (léger)."""
    return user
