"""Point d'entrée de l'API FastAPI + assemblage des couches de sécurité."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.api.router import router as api_router
from app.auth.router import router as auth_router
from app.core.config import settings
from app.core.security_headers import SecurityHeadersMiddleware
from app.db import models  # noqa: F401  -> enregistre les tables dans Base.metadata
from app.db.base import Base
from app.db.seed import seed_dashboard_if_empty, seed_demo_reservations_if_empty, seed_desks_if_empty
from app.services.badges import seed_catalog_if_empty as seed_badges_if_empty
from app.db.session import SessionLocal, engine
from app.deps import get_current_user
from app.services.events import EventError
from app.services.ideas import IdeaError
from app.services.media import MediaError
from app.services.quiz import QuizError
from app.services.reservations import ReservationError


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Au démarrage : en DEV (SQLite), crée les tables et les postes de démo.

    En production, c'est Alembic qui gère le schéma (jamais create_all).
    """
    if not settings.is_production and settings.DATABASE_URL.startswith("sqlite"):
        Base.metadata.create_all(bind=engine)
        with SessionLocal() as db:
            seed_desks_if_empty(db)
            seed_demo_reservations_if_empty(db)
            seed_dashboard_if_empty(db)
            seed_badges_if_empty(db)
    yield


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)


@app.exception_handler(ReservationError)
async def reservation_error_handler(request: Request, exc: ReservationError):
    """Traduit les erreurs métier en réponses HTTP claires (404, 409, 403…)."""
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.exception_handler(EventError)
async def event_error_handler(request: Request, exc: EventError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.exception_handler(IdeaError)
async def idea_error_handler(request: Request, exc: IdeaError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.exception_handler(QuizError)
async def quiz_error_handler(request: Request, exc: QuizError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.exception_handler(MediaError)
async def media_error_handler(request: Request, exc: MediaError):
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

# --- CORS strict : seule l'origine du frontend est autorisée ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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


@app.get("/health", tags=["system"])
def health():
    """Sonde de disponibilité."""
    return {"status": "ok"}


@app.get("/api/me", tags=["auth"])
def me(user: dict = Depends(get_current_user)):
    """Route protégée : renvoie l'utilisateur de session (léger)."""
    return user
