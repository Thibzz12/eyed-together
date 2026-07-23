"""Moteur SQLAlchemy et fabrique de sessions.

Le même code fonctionne en SQLite (dev) et PostgreSQL (prod) :
seule l'URL change (voir DATABASE_URL).
"""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

# `check_same_thread` est spécifique à SQLite ; inutile (et invalide) pour PostgreSQL.
connect_args = (
    {"check_same_thread": False}
    if settings.DATABASE_URL.startswith("sqlite")
    else {}
)

engine = create_engine(
    settings.DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,   # Vérifie que la connexion est vivante avant usage (robustesse prod).
    echo=False,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session)


def get_db() -> Generator[Session, None, None]:
    """Dépendance FastAPI : fournit une session et la ferme proprement après usage."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
