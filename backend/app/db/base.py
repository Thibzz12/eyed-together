"""Classe de base déclarative pour tous les modèles ORM (SQLAlchemy 2.0)."""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Toutes les tables héritent de cette classe."""
    pass
