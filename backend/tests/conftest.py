"""Harnais de test : base SQLite en mémoire, client HTTP, utilisateurs types.

Chaque test part d'une base vierge : les tables sont créées puis détruites
autour de chaque test, ce qui évite qu'un test en pollue un autre.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.timezone import local_now
from app.db import models as m
from app.db.base import Base
from app.db.session import get_db
from app.deps import get_current_user, require_admin
from app.main import app


@pytest.fixture(autouse=True)
def heure_de_bureau(monkeypatch):
    """Gèle l'horloge du service de présence à 10h du matin.

    Sans cela la suite est fragile : elle passe le matin et échoue le soir,
    parce qu'après l'heure de clôture le balayage referme aussitôt les
    présences que le test vient d'ouvrir. Les tests qui portent justement sur
    la clôture passent leur propre `now` en argument et ne sont pas concernés.
    """
    from app.services import attendance

    fige = local_now().replace(hour=10, minute=0, second=0, microsecond=0)
    monkeypatch.setattr(attendance, "local_now", lambda: fige)
    return fige


@pytest.fixture
def db():
    """Session sur une base SQLite en mémoire, isolée par test.

    StaticPool et une connexion unique : sans cela, chaque nouvelle connexion
    ouvrirait sa propre base en mémoire, vide.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def _make_user(db, oid: str, email: str, name: str, role: m.UserRole) -> m.User:
    user = m.User(entra_oid=oid, email=email, display_name=name, role=role)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def employee(db):
    """Un employé standard, déjà en base."""
    return _make_user(db, "oid-employe", "employe@eyedpharma.com", "Camille Dupont", m.UserRole.EMPLOYEE)


@pytest.fixture
def colleague(db):
    """Un second employé, pour les tests qui opposent deux utilisateurs."""
    return _make_user(db, "oid-collegue", "collegue@eyedpharma.com", "Alex Martin", m.UserRole.EMPLOYEE)


@pytest.fixture
def admin(db):
    """Un administrateur, déjà en base."""
    return _make_user(db, "oid-admin", "admin@eyedpharma.com", "Olivier Vanbrabant", m.UserRole.ADMIN)


@pytest.fixture
def client(db):
    """Client HTTP dont l'utilisateur connecté se règle via `login_as`.

    L'authentification réelle passe par une session signée alimentée par
    Microsoft Entra ID ; en test on court-circuite les dépendances plutôt que
    de rejouer tout le protocole OAuth.
    """
    from fastapi import HTTPException, status

    current = {"user": None}

    def _get_db_override():
        yield db

    def _get_current_user_override():
        if current["user"] is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Non authentifié.")
        return current["user"]

    def _require_admin_override():
        user = _get_current_user_override()
        if user.get("role") != "admin":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Accès réservé aux administrateurs.")
        return user

    app.dependency_overrides[get_db] = _get_db_override
    app.dependency_overrides[get_current_user] = _get_current_user_override
    app.dependency_overrides[require_admin] = _require_admin_override

    # TestClient SANS `with` : volontaire. Le context manager déclencherait le
    # lifespan de l'application, qui crée les tables et joue les seeds sur la
    # VRAIE base de développement. Les tests écriraient alors dans
    # backend/coworking.db au lieu de rester dans leur base en mémoire.
    test_client = TestClient(app)

    def login_as(user):
        current["user"] = {
            "id": user.id,
            "name": user.display_name,
            "email": user.email,
            "role": user.role.value,
        }

    test_client.login_as = login_as
    try:
        yield test_client
    finally:
        app.dependency_overrides.clear()
