# Présence réelle dans les locaux (lot A) — plan d'implémentation

> **Pour les agents :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` ou `superpowers:executing-plans`
> pour dérouler ce plan tâche par tâche. Les étapes utilisent des cases à
> cocher (`- [ ]`).

**But :** savoir qui est physiquement dans les locaux, employés et visiteurs
externes compris, pour l'évacuation incendie et le suivi des visites.

**Architecture :** deux nouvelles tables (`attendance`, `visitors`), un
service isolé `app/services/attendance.py` qu'aucun autre service n'importe
en retour, une poignée de routes sous `/api/attendance` et `/api/visitors`,
et côté front un pop-up d'arrivée, un bouton de départ et une vue « Dans les
locaux ». La clôture du soir se fait par balayage paresseux, sans
planificateur.

**Pile technique :** FastAPI 0.115, SQLAlchemy 2.0, Alembic 1.14, SQLite en
développement et PostgreSQL en production, JavaScript natif côté client (pas
de framework, pas d'étape de build).

**Spec de référence :** `docs/superpowers/specs/2026-08-25-presence-locaux-design.md`

## Contraintes globales

- **Aucun commit, aucun push.** Thibaud vérifie tout en local d'abord.
  Chaque tâche se termine par un point de contrôle exécuté, pas par un
  `git commit`.
- Langue du code : commentaires et docstrings en français, comme tout le
  projet. Textes d'interface en français.
- Ne jamais employer le tiret cadratin dans le code, les commentaires ou les
  textes affichés.
- « Présence » au sens statut déclaré (`DailyStatus`, vue `presence`,
  « Ma présence ») reste intouché. Le nouveau concept s'appelle **« Dans les
  locaux »** dans l'interface et `attendance` dans le code.
- Aucune heure d'arrivée ou de départ ne doit être visible par un employé non
  administrateur.
- Les dates de calendrier utilisent le fuseau `Europe/Brussels`, jamais
  `datetime.utcnow().date()` ni `toISOString().slice(0,10)` côté client.
- Toute modification de `app/static/app.js`, `styles.css` ou `index.html`
  impose d'incrémenter le paramètre `?v=` correspondant dans `index.html`
  (cache-busting déjà en place, actuellement `styles.css?v=51`).
- Migration Alembic : la révision actuelle en tête de chaîne est
  `d1a4b7c2e883` (`20260812_1600_enable_rls_public_tables`).

---

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `backend/app/core/timezone.py` | **Créer.** Fuseau local et helpers `local_now` / `local_today`. Rien d'autre. |
| `backend/app/db/models.py` | **Modifier.** Ajouter `Attendance` et `Visitor` en fin de fichier. |
| `backend/alembic/versions/20260825_1000_attendance_and_visitors.py` | **Créer.** Les deux tables. |
| `backend/app/services/attendance.py` | **Créer.** Toute la logique métier de présence. N'importe aucun autre service sauf `gamification`. |
| `backend/app/services/gamification.py` | **Modifier.** Ajouter `POINTS_PER_CHECKIN`. |
| `backend/app/services/reservations.py` | **Modifier.** `check_in` appelle aussi le service de présence. |
| `backend/app/schemas.py` | **Modifier.** Schémas d'entrée et de sortie de présence. |
| `backend/app/api/router.py` | **Modifier.** Routes de présence, de visiteurs et d'administration. |
| `backend/app/main.py` | **Modifier.** Gestionnaire d'exception `AttendanceError`. |
| `backend/app/static/index.html` | **Modifier.** Feuille du pop-up, entrée de navigation, versions des assets. |
| `backend/app/static/app.js` | **Modifier.** Pop-up, bouton de départ, vue « Dans les locaux », section admin. |
| `backend/app/static/styles.css` | **Modifier.** Styles de la nouvelle vue et du pop-up. |
| `backend/tests/conftest.py` | **Créer.** Base en mémoire, client de test, utilisateurs de test. |
| `backend/tests/test_attendance_service.py` | **Créer.** Logique métier. |
| `backend/tests/test_attendance_api.py` | **Créer.** Routes et autorisations. |
| `backend/requirements.txt` | **Modifier.** Ajouter `tzdata`. |
| `backend/requirements-dev.txt` | **Créer.** `pytest`, hors image de production. |

---

## Tâche 1 : socle — fuseau horaire et harnais de test

Le projet n'a aucun test. Cette tâche installe le minimum pour que les
tâches suivantes puissent être vérifiées autrement qu'à la main, et règle un
piège découvert en amont : `ZoneInfo("Europe/Brussels")` lève
`ZoneInfoNotFoundError` sur Windows, qui n'embarque pas de base de fuseaux.

**Fichiers :**
- Créer : `backend/app/core/timezone.py`
- Créer : `backend/requirements-dev.txt`
- Créer : `backend/tests/__init__.py` (fichier vide)
- Créer : `backend/tests/conftest.py`
- Créer : `backend/tests/test_timezone.py`
- Modifier : `backend/requirements.txt`

**Interfaces produites :**
- `app.core.timezone.LOCAL_TZ: ZoneInfo`
- `app.core.timezone.local_now() -> datetime` (aware, fuseau local)
- `app.core.timezone.local_today() -> date`
- fixtures pytest `db`, `client`, `employee`, `admin` (voir conftest)

- [ ] **Étape 1 : ajouter les dépendances**

Ajouter à la fin de `backend/requirements.txt` :

```
# --- Fuseaux horaires ---
tzdata==2025.2                 # Base de fuseaux IANA : indispensable sous Windows,
                               # où zoneinfo n'a aucune source système.
```

Créer `backend/requirements-dev.txt` :

```
# Dépendances de développement uniquement (jamais installées sur Render).
-r requirements.txt
pytest==8.3.4
```

- [ ] **Étape 2 : installer**

```bash
cd backend && .venv/Scripts/python.exe -m pip install -r requirements-dev.txt
```

Attendu : installation de `tzdata` et `pytest`, sans erreur.

- [ ] **Étape 3 : écrire le test du fuseau**

Créer `backend/tests/test_timezone.py` :

```python
"""Le fuseau local doit être résolvable sur toutes les machines du projet."""

from datetime import date, datetime

from app.core.timezone import LOCAL_TZ, local_now, local_today


def test_le_fuseau_local_est_disponible():
    assert LOCAL_TZ.key == "Europe/Brussels"


def test_local_now_est_horodate_avec_un_fuseau():
    now = local_now()
    assert isinstance(now, datetime)
    assert now.tzinfo is not None


def test_local_today_renvoie_une_date():
    assert isinstance(local_today(), date)
```

- [ ] **Étape 4 : lancer le test et le voir échouer**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_timezone.py -v
```

Attendu : ÉCHEC, `ModuleNotFoundError: No module named 'app.core.timezone'`.

- [ ] **Étape 5 : écrire le module**

Créer `backend/app/core/timezone.py` :

```python
"""Fuseau horaire de l'entreprise (Liège, Belgique).

Toute décision du type « quel jour sommes-nous » ou « est-il plus de 19h »
passe par ici. Le serveur de production tourne en UTC : comparer une heure
UTC à une heure de bureau décalerait d'une ou deux heures selon la période
de l'année, et clôturerait les présences au mauvais moment.
"""

from datetime import date, datetime
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("Europe/Brussels")


def local_now() -> datetime:
    """Instant présent, horodaté dans le fuseau local."""
    return datetime.now(LOCAL_TZ)


def local_today() -> date:
    """Date du calendrier local (pas la date UTC)."""
    return local_now().date()
```

- [ ] **Étape 6 : relancer le test**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_timezone.py -v
```

Attendu : 3 tests PASS.

- [ ] **Étape 7 : écrire le harnais de test partagé**

Créer `backend/tests/__init__.py` (vide) puis `backend/tests/conftest.py` :

```python
"""Harnais de test : base SQLite en mémoire, client HTTP, utilisateurs types.

Chaque test part d'une base vierge : les tables sont créées puis détruites
autour de chaque test, ce qui évite qu'un test en pollue un autre.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import models as m
from app.db.base import Base
from app.db.session import get_db
from app.deps import get_current_user, require_admin
from app.main import app


@pytest.fixture
def db():
    """Session sur une base SQLite en mémoire, isolée par test.

    StaticPool + une seule connexion : sans cela, chaque session ouvrirait
    sa propre base en mémoire, vide.
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


@pytest.fixture
def employee(db):
    """Un employé standard, déjà en base."""
    user = m.User(
        entra_oid="oid-employe",
        email="employe@eyedpharma.com",
        display_name="Camille Dupont",
        role=m.UserRole.EMPLOYEE,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def colleague(db):
    """Un second employé, pour les tests qui opposent deux utilisateurs."""
    user = m.User(
        entra_oid="oid-collegue",
        email="collegue@eyedpharma.com",
        display_name="Alex Martin",
        role=m.UserRole.EMPLOYEE,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def admin(db):
    """Un administrateur, déjà en base."""
    user = m.User(
        entra_oid="oid-admin",
        email="admin@eyedpharma.com",
        display_name="Olivier Vanbrabant",
        role=m.UserRole.ADMIN,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def client(db):
    """Client HTTP dont l'utilisateur connecté se règle via `login_as`.

    L'authentification réelle passe par une session signée alimentée par
    Microsoft Entra ID ; en test on court-circuite les dépendances plutôt
    que de simuler tout le protocole OAuth.
    """
    current = {"user": None}

    def _get_db_override():
        yield db

    def _get_current_user_override():
        if current["user"] is None:
            from fastapi import HTTPException, status

            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Non authentifié.")
        return current["user"]

    def _require_admin_override():
        user = _get_current_user_override()
        if user.get("role") != "admin":
            from fastapi import HTTPException, status

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
```

- [ ] **Étape 8 : vérifier que le harnais démarre**

Créer un test temporaire dans `backend/tests/test_timezone.py`, à la fin :

```python
def test_le_harnais_demarre(client, employee):
    """Sanity check : l'application se monte et répond avec le harnais."""
    client.login_as(employee)
    res = client.get("/api/me")
    assert res.status_code == 200
    assert res.json()["email"] == "employe@eyedpharma.com"
```

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

Attendu : 4 tests PASS. Si `TestClient` se plaint d'une base de production
manquante, vérifier que `backend/.env` pointe bien sur SQLite en développement.

- [ ] **Étape 9 : point de contrôle**

Aucun commit. Vérifier que `.gitignore` n'exclut pas `tests/`, et que
l'application démarre toujours :

```bash
cd backend && .venv/Scripts/python.exe -c "from app.main import app; print('import ok')"
```

---

## Tâche 2 : modèles et migration

**Fichiers :**
- Modifier : `backend/app/db/models.py` (ajout en fin de fichier)
- Créer : `backend/alembic/versions/20260825_1000_attendance_and_visitors.py`
- Créer : `backend/tests/test_attendance_models.py`

**Interfaces consommées :** `app.core.timezone.local_now` (tâche 1).

**Interfaces produites :**
- `models.Attendance` : `id, user_id, day, arrived_at, left_at, source, auto_closed, user`
- `models.Visitor` : `id, host_user_id, day, full_name, company, arrived_at, left_at, auto_closed, host`

- [ ] **Étape 1 : écrire le test**

Créer `backend/tests/test_attendance_models.py` :

```python
"""Les deux tables de présence : contraintes et valeurs par défaut."""

import pytest
from sqlalchemy.exc import IntegrityError

from app.core.timezone import local_now, local_today
from app.db import models as m


def test_une_seule_ligne_de_presence_par_personne_et_par_jour(db, employee):
    day = local_today()
    db.add(m.Attendance(user_id=employee.id, day=day, arrived_at=local_now()))
    db.commit()

    db.add(m.Attendance(user_id=employee.id, day=day, arrived_at=local_now()))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_une_presence_neuve_est_ouverte_et_non_cloturee(db, employee):
    row = m.Attendance(user_id=employee.id, day=local_today(), arrived_at=local_now())
    db.add(row)
    db.commit()
    db.refresh(row)

    assert row.left_at is None
    assert row.auto_closed is False
    assert row.source == "popup"


def test_plusieurs_visiteurs_peuvent_porter_le_meme_nom(db, employee):
    for _ in range(2):
        db.add(
            m.Visitor(
                host_user_id=employee.id,
                day=local_today(),
                full_name="Jean Dupont",
                company="Acme",
                arrived_at=local_now(),
            )
        )
    db.commit()

    assert db.query(m.Visitor).count() == 2
```

- [ ] **Étape 2 : lancer et voir échouer**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_models.py -v
```

Attendu : ÉCHEC, `AttributeError: module 'app.db.models' has no attribute 'Attendance'`.

- [ ] **Étape 3 : ajouter les modèles**

À la fin de `backend/app/db/models.py` :

```python
# ------------------------------------------------------------------
#  Présence physique dans les locaux (sécurité incendie)
# ------------------------------------------------------------------
class Attendance(Base):
    """Présence physique constatée d'un employé, pour une journée.

    À ne pas confondre avec DailyStatus, qui enregistre une *intention*
    déclarée à l'avance (bureau, télétravail, congé). Ici c'est un fait :
    la personne a confirmé être dans le bâtiment.

    Une seule ligne par personne et par jour, volontairement : repartir puis
    revenir rouvre la ligne existante au lieu d'en créer une seconde. On
    répond à « est-il dans le bâtiment maintenant ? », on ne reconstitue pas
    un relevé d'heures.
    """

    __tablename__ = "attendance"
    __table_args__ = (
        UniqueConstraint("user_id", "day", name="uq_attendance_user_day"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    day: Mapped[date] = mapped_column(Date, index=True)
    arrived_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # NULL = la personne est encore dans les locaux.
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # "popup", "reservation" ou "admin" — chaîne libre plutôt qu'un enum, pour
    # ne pas imposer une migration de type PostgreSQL à chaque nouvelle source.
    source: Mapped[str] = mapped_column(String(20), default="popup", nullable=False)
    # True quand le départ vient du balayage du soir, pas d'un clic : permet à
    # l'admin de distinguer un départ confirmé d'un oubli.
    auto_closed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    user: Mapped["User"] = relationship()


class Visitor(Base):
    """Visiteur externe accompagné par un employé, présent dans les locaux."""

    __tablename__ = "visitors"

    id: Mapped[int] = mapped_column(primary_key=True)
    host_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    day: Mapped[date] = mapped_column(Date, index=True)
    full_name: Mapped[str] = mapped_column(String(120), nullable=False)
    company: Mapped[str | None] = mapped_column(String(120), nullable=True)
    arrived_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    auto_closed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    host: Mapped["User"] = relationship()
```

Vérifier que `UniqueConstraint`, `Boolean`, `String`, `Date`, `DateTime`,
`ForeignKey` sont déjà importés en tête de `models.py` (ils le sont pour les
autres tables) ; sinon compléter l'import.

- [ ] **Étape 4 : relancer les tests**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_models.py -v
```

Attendu : 3 tests PASS.

- [ ] **Étape 5 : écrire la migration**

Créer `backend/alembic/versions/20260825_1000_attendance_and_visitors.py` :

```python
"""attendance_and_visitors

Présence physique dans les locaux : arrivées, départs et visiteurs externes.
Nécessaire à la liste d'évacuation incendie, que les réservations seules ne
permettaient pas d'établir.

Revision ID: e5f2c9b4a117
Revises: d1a4b7c2e883
Create Date: 2026-08-25 10:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f2c9b4a117"
down_revision: Union[str, None] = "d1a4b7c2e883"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "attendance",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("arrived_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source", sa.String(length=20), nullable=False, server_default="popup"),
        sa.Column("auto_closed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "day", name="uq_attendance_user_day"),
    )
    op.create_index("ix_attendance_user_id", "attendance", ["user_id"])
    op.create_index("ix_attendance_day", "attendance", ["day"])

    op.create_table(
        "visitors",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("host_user_id", sa.Integer(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("full_name", sa.String(length=120), nullable=False),
        sa.Column("company", sa.String(length=120), nullable=True),
        sa.Column("arrived_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("auto_closed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.ForeignKeyConstraint(["host_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_visitors_host_user_id", "visitors", ["host_user_id"])
    op.create_index("ix_visitors_day", "visitors", ["day"])


def downgrade() -> None:
    op.drop_index("ix_visitors_day", table_name="visitors")
    op.drop_index("ix_visitors_host_user_id", table_name="visitors")
    op.drop_table("visitors")
    op.drop_index("ix_attendance_day", table_name="attendance")
    op.drop_index("ix_attendance_user_id", table_name="attendance")
    op.drop_table("attendance")
```

- [ ] **Étape 6 : vérifier la migration dans les deux sens**

```bash
cd backend && .venv/Scripts/python.exe -m alembic upgrade head && .venv/Scripts/python.exe -m alembic downgrade -1 && .venv/Scripts/python.exe -m alembic upgrade head
```

Attendu : aucune erreur, et `alembic current` affiche `e5f2c9b4a117`.

- [ ] **Étape 7 : point de contrôle**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

Attendu : tous les tests PASS. Pas de commit.

---

## Tâche 3 : service — arrivée, départ, état du jour

**Fichiers :**
- Créer : `backend/app/services/attendance.py`
- Modifier : `backend/app/services/gamification.py`
- Créer : `backend/tests/test_attendance_service.py`

**Interfaces consommées :** `models.Attendance` (tâche 2),
`gamification.award_points(db, user_id, amount, reason) -> None` (ne commit pas).

**Interfaces produites :**
- `attendance.AttendanceError` (attribut `status_code`), `AttendanceNotFound`, `AttendanceForbidden`
- `attendance.check_in(db, user_id, source="popup", day=None) -> m.Attendance`
- `attendance.check_out(db, user_id, day=None) -> m.Attendance`
- `attendance.state_for(db, user_id, day=None) -> dict`
- `gamification.POINTS_PER_CHECKIN: int`

- [ ] **Étape 1 : écrire les tests**

Créer `backend/tests/test_attendance_service.py` :

```python
"""Logique métier de la présence : arrivée, départ, état du jour."""

from datetime import timedelta

import pytest

from app.core.timezone import local_now, local_today
from app.db import models as m
from app.services import attendance as svc


def test_arriver_cree_la_ligne_du_jour(db, employee):
    row = svc.check_in(db, employee.id)

    assert row.day == local_today()
    assert row.left_at is None
    assert row.source == "popup"


def test_arriver_attribue_les_points_une_seule_fois(db, employee):
    svc.check_in(db, employee.id)
    svc.check_in(db, employee.id)

    transactions = db.query(m.PointTransaction).filter_by(reason="checkin").all()
    assert len(transactions) == 1
    db.refresh(employee)
    assert employee.total_points == transactions[0].amount


def test_partir_pose_l_heure_de_depart(db, employee):
    svc.check_in(db, employee.id)
    row = svc.check_out(db, employee.id)

    assert row.left_at is not None
    assert row.auto_closed is False


def test_revenir_rouvre_la_ligne_sans_en_creer_une_seconde(db, employee):
    arrivee = svc.check_in(db, employee.id).arrived_at
    svc.check_out(db, employee.id)
    row = svc.check_in(db, employee.id)

    assert db.query(m.Attendance).count() == 1
    assert row.left_at is None
    assert row.arrived_at == arrivee  # l'heure d'arrivée d'origine est conservée


def test_revenir_ne_redonne_pas_de_points(db, employee):
    svc.check_in(db, employee.id)
    svc.check_out(db, employee.id)
    svc.check_in(db, employee.id)

    assert db.query(m.PointTransaction).filter_by(reason="checkin").count() == 1


def test_partir_sans_etre_arrive_est_refuse(db, employee):
    with pytest.raises(svc.AttendanceError):
        svc.check_out(db, employee.id)


def test_etat_du_jour_avant_toute_arrivee(db, employee):
    etat = svc.state_for(db, employee.id)

    assert etat["arrived"] is False
    assert etat["present"] is False
    assert etat["visitors"] == []


def test_etat_du_jour_apres_arrivee_puis_depart(db, employee):
    svc.check_in(db, employee.id)
    assert svc.state_for(db, employee.id)["present"] is True

    svc.check_out(db, employee.id)
    etat = svc.state_for(db, employee.id)
    assert etat["arrived"] is True
    assert etat["present"] is False


def test_la_source_est_conservee(db, employee):
    row = svc.check_in(db, employee.id, source="reservation")
    assert row.source == "reservation"
```

- [ ] **Étape 2 : lancer et voir échouer**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_service.py -v
```

Attendu : ÉCHEC à l'import, `No module named 'app.services.attendance'`.

- [ ] **Étape 3 : ajouter la constante de points**

Dans `backend/app/services/gamification.py`, sous `POINTS_PER_BOOKING` :

```python
# Points gagnés en confirmant son arrivée dans les locaux, une fois par jour.
POINTS_PER_CHECKIN = 5
```

- [ ] **Étape 4 : écrire le service**

Créer `backend/app/services/attendance.py` :

```python
"""Présence physique dans les locaux : arrivées, départs, visiteurs.

À ne pas confondre avec DailyStatus, qui enregistre le statut *déclaré* à
l'avance (bureau, télétravail, congé). Ici on enregistre un fait constaté,
qui sert à la sécurité incendie : qui est réellement dans le bâtiment.

Ce module n'importe aucun autre service métier hormis la gamification :
c'est `reservations` qui appelle `attendance`, jamais l'inverse.
"""

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.timezone import local_now, local_today
from app.db import models as m
from app.services.gamification import POINTS_PER_CHECKIN, award_points


class AttendanceError(Exception):
    status_code = 400


class AttendanceNotFound(AttendanceError):
    status_code = 404


class AttendanceForbidden(AttendanceError):
    status_code = 403


def _row_for(db: Session, user_id: int, day: date) -> m.Attendance | None:
    return db.scalar(
        select(m.Attendance).where(
            m.Attendance.user_id == user_id, m.Attendance.day == day
        )
    )


def check_in(db: Session, user_id: int, source: str = "popup", day: date | None = None) -> m.Attendance:
    """Confirme l'arrivée. Rouvre la ligne du jour si la personne était partie.

    Les points ne sont attribués qu'à la toute première arrivée de la journée :
    sinon, alterner arrivée et départ suffirait à en accumuler.
    """
    day = day or local_today()
    row = _row_for(db, user_id, day)

    if row is None:
        row = m.Attendance(user_id=user_id, day=day, arrived_at=local_now(), source=source)
        db.add(row)
        award_points(db, user_id, POINTS_PER_CHECKIN, "checkin")
        db.commit()
        db.refresh(row)
        return row

    if row.left_at is not None:
        row.left_at = None
        row.auto_closed = False
        db.commit()
        db.refresh(row)
    return row


def check_out(db: Session, user_id: int, day: date | None = None) -> m.Attendance:
    """Confirme le départ. Refuse si la personne n'était pas marquée présente."""
    day = day or local_today()
    row = _row_for(db, user_id, day)
    if row is None:
        raise AttendanceNotFound("Aucune arrivée confirmée aujourd'hui.")
    if row.left_at is not None:
        raise AttendanceError("Ton départ est déjà enregistré.")

    row.left_at = local_now()
    row.auto_closed = False
    db.commit()
    db.refresh(row)
    return row


def _visitors_of(db: Session, host_user_id: int, day: date) -> list[m.Visitor]:
    return list(
        db.scalars(
            select(m.Visitor)
            .where(m.Visitor.host_user_id == host_user_id, m.Visitor.day == day)
            .order_by(m.Visitor.arrived_at)
        )
    )


def state_for(db: Session, user_id: int, day: date | None = None) -> dict:
    """État du jour pour un utilisateur : pilote le pop-up et le bouton de départ."""
    day = day or local_today()
    row = _row_for(db, user_id, day)
    return {
        "day": day.isoformat(),
        "arrived": row is not None,
        "present": row is not None and row.left_at is None,
        "visitors": [
            {
                "id": v.id,
                "full_name": v.full_name,
                "company": v.company,
                "present": v.left_at is None,
            }
            for v in _visitors_of(db, user_id, day)
        ],
    }
```

- [ ] **Étape 5 : relancer les tests**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_service.py -v
```

Attendu : 9 tests PASS.

- [ ] **Étape 6 : point de contrôle**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

Attendu : tous les tests PASS. Pas de commit.

---

## Tâche 4 : service — balayage du soir et heure paramétrable

**Fichiers :**
- Modifier : `backend/app/services/attendance.py`
- Modifier : `backend/tests/test_attendance_service.py` (ajouts en fin de fichier)

**Interfaces consommées :** `models.AppSetting` (clé/valeur, déjà en base),
`check_in` et `check_out` (tâche 3).

**Interfaces produites :**
- `attendance.DEFAULT_AUTO_CLOSE_HOUR: int` (valeur `19`)
- `attendance.get_auto_close_hour(db) -> int`
- `attendance.set_auto_close_hour(db, hour: int) -> None`
- `attendance.close_stale(db, now: datetime | None = None) -> int` (nombre de lignes clôturées)

- [ ] **Étape 1 : écrire les tests**

Ajouter à la fin de `backend/tests/test_attendance_service.py` :

```python
def test_heure_de_cloture_par_defaut(db):
    assert svc.get_auto_close_hour(db) == svc.DEFAULT_AUTO_CLOSE_HOUR


def test_heure_de_cloture_modifiable(db):
    svc.set_auto_close_hour(db, 21)
    assert svc.get_auto_close_hour(db) == 21


def test_heure_de_cloture_invalide_est_refusee(db):
    with pytest.raises(svc.AttendanceError):
        svc.set_auto_close_hour(db, 30)


def test_une_presence_d_hier_est_cloturee(db, employee):
    hier = local_today() - timedelta(days=1)
    svc.check_in(db, employee.id, day=hier)

    assert svc.close_stale(db) == 1

    row = db.query(m.Attendance).one()
    assert row.left_at is not None
    assert row.auto_closed is True


def test_une_presence_d_hier_est_cloturee_a_l_heure_limite_de_ce_jour_la(db, employee):
    """Clôturer à l'instant présent laisserait croire à une nuit sur place."""
    hier = local_today() - timedelta(days=1)
    svc.check_in(db, employee.id, day=hier)

    svc.close_stale(db)

    row = db.query(m.Attendance).one()
    assert row.left_at.date() == hier
    assert row.left_at.hour == svc.DEFAULT_AUTO_CLOSE_HOUR


def test_une_presence_du_jour_avant_l_heure_limite_reste_ouverte(db, employee):
    svc.check_in(db, employee.id)
    matin = local_now().replace(hour=9, minute=0)

    assert svc.close_stale(db, now=matin) == 0
    assert db.query(m.Attendance).one().left_at is None


def test_une_presence_du_jour_apres_l_heure_limite_est_cloturee(db, employee):
    svc.check_in(db, employee.id)
    tard = local_now().replace(hour=22, minute=0)

    assert svc.close_stale(db, now=tard) == 1
    assert db.query(m.Attendance).one().auto_closed is True


def test_un_depart_confirme_n_est_pas_marque_auto(db, employee):
    svc.check_in(db, employee.id)
    svc.check_out(db, employee.id)

    svc.close_stale(db, now=local_now().replace(hour=22))

    assert db.query(m.Attendance).one().auto_closed is False
```

- [ ] **Étape 2 : lancer et voir échouer**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_service.py -k "cloture or heure" -v
```

Attendu : ÉCHEC, `module 'app.services.attendance' has no attribute 'get_auto_close_hour'`.

- [ ] **Étape 3 : implémenter**

Dans `backend/app/services/attendance.py`, après les classes d'erreur :

```python
# Heure locale à laquelle les présences encore ouvertes sont clôturées d'office.
DEFAULT_AUTO_CLOSE_HOUR = 19
_AUTO_CLOSE_KEY = "attendance_auto_close_hour"


def get_auto_close_hour(db: Session) -> int:
    """Heure de clôture automatique, réglable en administration."""
    row = db.get(m.AppSetting, _AUTO_CLOSE_KEY)
    if row is None:
        return DEFAULT_AUTO_CLOSE_HOUR
    try:
        return min(23, max(0, int(row.value)))
    except (TypeError, ValueError):
        return DEFAULT_AUTO_CLOSE_HOUR


def set_auto_close_hour(db: Session, hour: int) -> None:
    if not isinstance(hour, int) or not 0 <= hour <= 23:
        raise AttendanceError("L'heure de clôture doit être comprise entre 0 et 23.")
    row = db.get(m.AppSetting, _AUTO_CLOSE_KEY)
    if row is None:
        db.add(m.AppSetting(key=_AUTO_CLOSE_KEY, value=str(hour)))
    else:
        row.value = str(hour)
    db.commit()
```

Puis, toujours dans le même fichier, le balayage :

```python
def _closing_moment(row_day: date, now: datetime, limit_hour: int) -> datetime:
    """Heure de départ à inscrire pour une présence clôturée d'office.

    Pour une journée passée, on ferme à l'heure limite de CE jour-là. Fermer
    à l'instant présent laisserait entendre que la personne a dormi sur place.
    """
    if row_day < now.date():
        return datetime.combine(row_day, time(hour=limit_hour), tzinfo=LOCAL_TZ)
    return now


def close_stale(db: Session, now: datetime | None = None) -> int:
    """Clôture les présences oubliées. Renvoie le nombre de lignes touchées.

    Appelé au fil de l'eau (à chaque arrivée et à chaque consultation de la
    liste) plutôt que par un planificateur : Render ne fait tourner qu'un
    seul processus web, et un ordonnanceur pour cette seule tâche serait une
    pièce mobile de plus à surveiller.
    """
    now = now or local_now()
    limit_hour = get_auto_close_hour(db)
    reached = now.hour >= limit_hour
    closed = 0

    for model in (m.Attendance, m.Visitor):
        for row in db.scalars(select(model).where(model.left_at.is_(None))):
            if row.day < now.date() or (row.day == now.date() and reached):
                row.left_at = _closing_moment(row.day, now, limit_hour)
                row.auto_closed = True
                closed += 1

    if closed:
        db.commit()
    return closed
```

Compléter les imports en tête du fichier :

```python
from datetime import date, datetime, time

from app.core.timezone import LOCAL_TZ, local_now, local_today
```

- [ ] **Étape 4 : brancher le balayage sur l'arrivée**

Dans `check_in`, insérer en toute première ligne du corps :

```python
    close_stale(db)
```

- [ ] **Étape 5 : relancer les tests**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_service.py -v
```

Attendu : 17 tests PASS. Si `test_revenir_rouvre_la_ligne...` casse parce que
le balayage a refermé la ligne, vérifier que le test tourne bien avant
l'heure limite, et sinon forcer l'heure dans le test.

- [ ] **Étape 6 : point de contrôle**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

---

## Tâche 5 : service — visiteurs et vue d'ensemble

**Fichiers :**
- Modifier : `backend/app/services/attendance.py`
- Modifier : `backend/tests/test_attendance_service.py`

**Interfaces consommées :** `close_stale` (tâche 4), `models.Visitor` (tâche 2).

**Interfaces produites :**
- `attendance.add_visitor(db, host_user_id: int, full_name: str, company: str | None) -> m.Visitor`
- `attendance.visitor_check_out(db, visitor_id: int, requesting_user_id: int, is_admin: bool = False) -> m.Visitor`
- `attendance.who_is_in(db, day=None) -> dict` de forme
  `{"employees": [{"user_id", "name", "department"}], "visitors": [{"id", "full_name", "company", "host_name", "host_user_id"}]}`
- `attendance.roster(db, day=None) -> dict` : même chose avec les heures, réservé aux administrateurs

- [ ] **Étape 1 : écrire les tests**

Ajouter à la fin de `backend/tests/test_attendance_service.py` :

```python
def test_declarer_un_visiteur(db, employee):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")

    assert v.full_name == "Jean Dupont"
    assert v.company == "Acme"
    assert v.left_at is None
    assert v.day == local_today()


def test_un_visiteur_sans_nom_est_refuse(db, employee):
    with pytest.raises(svc.AttendanceError):
        svc.add_visitor(db, employee.id, "   ", "Acme")


def test_la_societe_est_facultative(db, employee):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", None)
    assert v.company is None


def test_faire_partir_son_propre_visiteur(db, employee):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")
    v = svc.visitor_check_out(db, v.id, employee.id)

    assert v.left_at is not None


def test_on_ne_peut_pas_faire_partir_le_visiteur_d_un_autre(db, employee, colleague):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")

    with pytest.raises(svc.AttendanceForbidden):
        svc.visitor_check_out(db, v.id, colleague.id)


def test_un_admin_peut_faire_partir_n_importe_quel_visiteur(db, employee, admin):
    v = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")
    v = svc.visitor_check_out(db, v.id, admin.id, is_admin=True)

    assert v.left_at is not None


def test_le_depart_d_un_visiteur_n_affecte_pas_les_autres(db, employee):
    a = svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")
    b = svc.add_visitor(db, employee.id, "Marie Durand", "Acme")

    svc.visitor_check_out(db, a.id, employee.id)

    assert db.get(m.Visitor, b.id).left_at is None


def test_qui_est_la_liste_employes_et_visiteurs_presents(db, employee, colleague):
    svc.check_in(db, employee.id)
    svc.add_visitor(db, employee.id, "Jean Dupont", "Acme")

    vue = svc.who_is_in(db)

    assert [e["name"] for e in vue["employees"]] == ["Camille Dupont"]
    assert vue["visitors"][0]["host_name"] == "Camille Dupont"
    assert colleague.display_name not in [e["name"] for e in vue["employees"]]


def test_qui_est_la_exclut_les_personnes_parties(db, employee):
    svc.check_in(db, employee.id)
    svc.check_out(db, employee.id)

    assert svc.who_is_in(db)["employees"] == []


def test_qui_est_la_ne_divulgue_aucune_heure(db, employee):
    svc.check_in(db, employee.id)
    entree = svc.who_is_in(db)["employees"][0]

    assert "arrived_at" not in entree
    assert "left_at" not in entree


def test_le_releve_admin_contient_les_heures(db, employee):
    svc.check_in(db, employee.id)
    entree = svc.roster(db)["employees"][0]

    assert entree["arrived_at"] is not None
    assert "auto_closed" in entree
```

- [ ] **Étape 2 : lancer et voir échouer**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_service.py -k "visiteur or qui_est_la or releve" -v
```

Attendu : ÉCHEC, `has no attribute 'add_visitor'`.

- [ ] **Étape 3 : implémenter**

À la fin de `backend/app/services/attendance.py` :

```python
def add_visitor(db: Session, host_user_id: int, full_name: str, company: str | None) -> m.Visitor:
    """Enregistre un visiteur externe arrivé maintenant, sous la responsabilité d'un hôte."""
    name = (full_name or "").strip()
    if not name:
        raise AttendanceError("Le nom du visiteur est obligatoire.")

    visitor = m.Visitor(
        host_user_id=host_user_id,
        day=local_today(),
        full_name=name[:120],
        company=((company or "").strip() or None),
        arrived_at=local_now(),
    )
    db.add(visitor)
    db.commit()
    db.refresh(visitor)
    return visitor


def visitor_check_out(
    db: Session, visitor_id: int, requesting_user_id: int, is_admin: bool = False
) -> m.Visitor:
    """Marque un visiteur parti. Réservé à son hôte et aux administrateurs."""
    visitor = db.get(m.Visitor, visitor_id)
    if visitor is None:
        raise AttendanceNotFound("Ce visiteur n'existe pas.")
    if not is_admin and visitor.host_user_id != requesting_user_id:
        raise AttendanceForbidden("Seul l'hôte de ce visiteur peut enregistrer son départ.")
    if visitor.left_at is not None:
        raise AttendanceError("Le départ de ce visiteur est déjà enregistré.")

    visitor.left_at = local_now()
    visitor.auto_closed = False
    db.commit()
    db.refresh(visitor)
    return visitor


def who_is_in(db: Session, day: date | None = None) -> dict:
    """Qui est dans les locaux, sans aucun horodatage.

    Vue destinée à tous les employés : afficher les heures d'arrivée et de
    départ à tout le monde transformerait l'outil en pointeuse, ce qui n'est
    pas son objet.
    """
    close_stale(db)
    day = day or local_today()

    employees = db.scalars(
        select(m.Attendance)
        .options(joinedload(m.Attendance.user))
        .where(m.Attendance.day == day, m.Attendance.left_at.is_(None))
        .order_by(m.Attendance.arrived_at)
    )
    visitors = db.scalars(
        select(m.Visitor)
        .options(joinedload(m.Visitor.host))
        .where(m.Visitor.day == day, m.Visitor.left_at.is_(None))
        .order_by(m.Visitor.arrived_at)
    )

    return {
        "day": day.isoformat(),
        "employees": [
            {"user_id": a.user_id, "name": a.user.display_name, "department": a.user.department}
            for a in employees
        ],
        "visitors": [
            {
                "id": v.id,
                "full_name": v.full_name,
                "company": v.company,
                "host_user_id": v.host_user_id,
                "host_name": v.host.display_name,
            }
            for v in visitors
        ],
    }


def roster(db: Session, day: date | None = None) -> dict:
    """Relevé complet d'une journée, heures comprises. Usage administrateur seulement."""
    close_stale(db)
    day = day or local_today()

    employees = db.scalars(
        select(m.Attendance)
        .options(joinedload(m.Attendance.user))
        .where(m.Attendance.day == day)
        .order_by(m.Attendance.arrived_at)
    )
    visitors = db.scalars(
        select(m.Visitor)
        .options(joinedload(m.Visitor.host))
        .where(m.Visitor.day == day)
        .order_by(m.Visitor.arrived_at)
    )

    return {
        "day": day.isoformat(),
        "employees": [
            {
                "name": a.user.display_name,
                "department": a.user.department,
                "arrived_at": a.arrived_at.isoformat(),
                "left_at": a.left_at.isoformat() if a.left_at else None,
                "auto_closed": a.auto_closed,
                "source": a.source,
            }
            for a in employees
        ],
        "visitors": [
            {
                "full_name": v.full_name,
                "company": v.company,
                "host_name": v.host.display_name,
                "arrived_at": v.arrived_at.isoformat(),
                "left_at": v.left_at.isoformat() if v.left_at else None,
                "auto_closed": v.auto_closed,
            }
            for v in visitors
        ],
    }
```

- [ ] **Étape 4 : relancer les tests**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_service.py -v
```

Attendu : 28 tests PASS.

- [ ] **Étape 5 : point de contrôle**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

---

## Tâche 6 : API

**Fichiers :**
- Modifier : `backend/app/schemas.py`
- Modifier : `backend/app/api/router.py`
- Modifier : `backend/app/main.py`
- Créer : `backend/tests/test_attendance_api.py`

**Interfaces consommées :** tout le service `attendance` (tâches 3 à 5),
`get_current_user`, `require_admin`, `get_db`.

**Interfaces produites :** les routes listées dans la spec.

- [ ] **Étape 1 : écrire les tests**

Créer `backend/tests/test_attendance_api.py` :

```python
"""Routes de présence : contrat HTTP et autorisations."""

from app.services import attendance as svc


def test_etat_du_jour_exige_une_session(client):
    assert client.get("/api/attendance/me").status_code == 401


def test_arriver_puis_consulter_son_etat(client, employee):
    client.login_as(employee)

    assert client.post("/api/attendance/checkin").status_code == 200

    etat = client.get("/api/attendance/me").json()
    assert etat["arrived"] is True
    assert etat["present"] is True


def test_partir(client, employee):
    client.login_as(employee)
    client.post("/api/attendance/checkin")

    assert client.post("/api/attendance/checkout").status_code == 200
    assert client.get("/api/attendance/me").json()["present"] is False


def test_partir_sans_etre_arrive_renvoie_404(client, employee):
    client.login_as(employee)
    assert client.post("/api/attendance/checkout").status_code == 404


def test_liste_du_jour(client, employee):
    client.login_as(employee)
    client.post("/api/attendance/checkin")

    data = client.get("/api/attendance/today").json()
    assert data["employees"][0]["name"] == "Camille Dupont"
    assert "arrived_at" not in data["employees"][0]


def test_declarer_un_visiteur(client, employee):
    client.login_as(employee)

    res = client.post("/api/visitors", json={"full_name": "Jean Dupont", "company": "Acme"})
    assert res.status_code == 201
    assert res.json()["full_name"] == "Jean Dupont"

    data = client.get("/api/attendance/today").json()
    assert data["visitors"][0]["host_name"] == "Camille Dupont"


def test_visiteur_sans_nom_renvoie_400(client, employee):
    client.login_as(employee)
    assert client.post("/api/visitors", json={"full_name": "  "}).status_code == 400


def test_faire_partir_le_visiteur_d_un_autre_renvoie_403(client, employee, colleague):
    client.login_as(employee)
    visitor_id = client.post("/api/visitors", json={"full_name": "Jean Dupont"}).json()["id"]

    client.login_as(colleague)
    assert client.post(f"/api/visitors/{visitor_id}/checkout").status_code == 403


def test_l_export_est_refuse_a_un_employe(client, employee):
    client.login_as(employee)
    assert client.get("/api/admin/attendance/export").status_code == 403


def test_l_export_admin_liste_employes_et_visiteurs(client, employee, admin):
    client.login_as(employee)
    client.post("/api/attendance/checkin")
    client.post("/api/visitors", json={"full_name": "Jean Dupont", "company": "Acme"})

    client.login_as(admin)
    res = client.get("/api/admin/attendance/export")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/csv")
    corps = res.text
    assert "Camille Dupont" in corps
    assert "Jean Dupont" in corps
    assert "Acme" in corps


def test_reglage_de_l_heure_de_cloture(client, admin, db):
    client.login_as(admin)

    assert client.patch("/api/admin/attendance/settings", json={"auto_close_hour": 20}).status_code == 200
    assert svc.get_auto_close_hour(db) == 20


def test_reglage_hors_bornes_refuse(client, admin):
    client.login_as(admin)
    assert client.patch("/api/admin/attendance/settings", json={"auto_close_hour": 30}).status_code == 422
```

- [ ] **Étape 2 : lancer et voir échouer**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_api.py -v
```

Attendu : ÉCHECS avec des 404 sur toutes les routes.

- [ ] **Étape 3 : ajouter les schémas**

À la fin de `backend/app/schemas.py` :

```python
# ---------------------------------------------------------------- Présence dans les locaux
class VisitorCreate(BaseModel):
    full_name: str = Field(min_length=1, max_length=120)
    company: str | None = Field(default=None, max_length=120)


class VisitorRead(BaseModel):
    id: int
    full_name: str
    company: str | None = None
    host_user_id: int
    host_name: str | None = None

    model_config = ConfigDict(from_attributes=True)


class AttendanceSettingsUpdate(BaseModel):
    auto_close_hour: int = Field(ge=0, le=23)
```

Vérifier que `BaseModel`, `Field` et `ConfigDict` sont déjà importés en tête
de `schemas.py` ; compléter si besoin.

- [ ] **Étape 4 : ajouter les routes**

Dans `backend/app/api/router.py`, importer le service en tête, à côté des
autres imports de services :

```python
from app.services import attendance as attendance_svc
```

Puis ajouter, après le bloc des routes `/presence` :

```python
# ---------------------------------------------------------------- Présence dans les locaux
@router.get("/attendance/me")
def attendance_me(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """État du jour : suis-je arrivé, suis-je encore là, quels visiteurs ai-je déclarés."""
    return attendance_svc.state_for(db, user["id"])


@router.post("/attendance/checkin")
def attendance_checkin(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Confirme l'arrivée dans les locaux (pop-up d'accueil)."""
    attendance_svc.check_in(db, user["id"], source="popup")
    return attendance_svc.state_for(db, user["id"])


@router.post("/attendance/checkout")
def attendance_checkout(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Confirme le départ des locaux."""
    attendance_svc.check_out(db, user["id"])
    return attendance_svc.state_for(db, user["id"])


@router.get("/attendance/today")
def attendance_today(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Qui est dans les locaux en ce moment, employés et visiteurs. Sans horodatage."""
    return attendance_svc.who_is_in(db)


@router.post("/visitors", response_model=schemas.VisitorRead, status_code=status.HTTP_201_CREATED)
def create_visitor(
    data: schemas.VisitorCreate, db: Session = Depends(get_db), user: dict = Depends(get_current_user)
):
    """Déclare un visiteur externe que l'on accompagne aujourd'hui."""
    visitor = attendance_svc.add_visitor(db, user["id"], data.full_name, data.company)
    return schemas.VisitorRead(
        id=visitor.id,
        full_name=visitor.full_name,
        company=visitor.company,
        host_user_id=visitor.host_user_id,
        host_name=user.get("name"),
    )


@router.post("/visitors/{visitor_id}/checkout")
def visitor_checkout(
    visitor_id: int, db: Session = Depends(get_db), user: dict = Depends(get_current_user)
):
    """Enregistre le départ d'un visiteur. Réservé à son hôte et aux administrateurs."""
    attendance_svc.visitor_check_out(
        db, visitor_id, user["id"], is_admin=user.get("role") == "admin"
    )
    return {"ok": True}


@router.get("/admin/attendance/export")
def admin_attendance_export(db: Session = Depends(get_db), _=Depends(require_admin)):
    """Relevé du jour au format CSV, imprimable pour l'évacuation."""
    data = attendance_svc.roster(db)
    lignes = ["Type;Nom;Société ou service;Arrivée;Départ;Départ confirmé"]
    for e in data["employees"]:
        lignes.append(
            f"Employé;{e['name']};{e['department'] or ''};{e['arrived_at']};"
            f"{e['left_at'] or ''};{'non' if e['auto_closed'] else 'oui'}"
        )
    for v in data["visitors"]:
        lignes.append(
            f"Visiteur ({v['host_name']});{v['full_name']};{v['company'] or ''};"
            f"{v['arrived_at']};{v['left_at'] or ''};{'non' if v['auto_closed'] else 'oui'}"
        )
    contenu = "﻿" + "\r\n".join(lignes)  # BOM : Excel ouvre l'UTF-8 correctement
    return Response(
        content=contenu,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=presence-{data['day']}.csv"},
    )


@router.get("/admin/attendance/settings")
def admin_attendance_settings(db: Session = Depends(get_db), _=Depends(require_admin)):
    """Heure de clôture automatique en vigueur."""
    return {"auto_close_hour": attendance_svc.get_auto_close_hour(db)}


@router.patch("/admin/attendance/settings")
def admin_attendance_settings_update(
    data: schemas.AttendanceSettingsUpdate, db: Session = Depends(get_db), _=Depends(require_admin)
):
    """Change l'heure à laquelle les présences oubliées sont clôturées."""
    attendance_svc.set_auto_close_hour(db, data.auto_close_hour)
    return {"auto_close_hour": data.auto_close_hour}
```

Ajouter `Response` à l'import `fastapi` en tête de `router.py` s'il n'y est pas.

- [ ] **Étape 5 : brancher le gestionnaire d'erreurs**

Dans `backend/app/main.py`, à côté des autres gestionnaires :

```python
from app.services.attendance import AttendanceError
```

```python
@app.exception_handler(AttendanceError)
async def attendance_error_handler(request: Request, exc: AttendanceError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})
```

- [ ] **Étape 6 : relancer les tests**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_api.py -v
```

Attendu : 12 tests PASS.

- [ ] **Étape 7 : point de contrôle**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

---

## Tâche 7 : brancher le check-in de réservation

Confirmer sa présence sur sa réservation, c'est être dans les locaux. Une
seule vérité, pas deux boutons qui se contredisent.

**Fichiers :**
- Modifier : `backend/app/services/reservations.py` (fonction `check_in`, vers la ligne 539)
- Modifier : `backend/tests/test_attendance_service.py`

**Interfaces consommées :** `attendance.check_in` (tâche 3).

- [ ] **Étape 1 : écrire le test**

Ajouter à la fin de `backend/tests/test_attendance_service.py` :

```python
def test_le_checkin_d_une_reservation_marque_la_presence(db, employee):
    from app.services import reservations as resa_svc

    desk = m.Desk(name="B1-1", zone="Bureau 1", is_active=True)
    db.add(desk)
    db.commit()
    db.refresh(desk)

    reservation = m.Reservation(
        user_id=employee.id,
        desk_id=desk.id,
        reservation_date=local_today(),
        slot=m.ReservationSlot.DAY,
        status=m.ReservationStatus.BOOKED,
    )
    db.add(reservation)
    db.commit()
    db.refresh(reservation)

    resa_svc.check_in(db, employee.id, reservation.id)

    presence = db.query(m.Attendance).one()
    assert presence.user_id == employee.id
    assert presence.source == "reservation"
    assert presence.left_at is None
```

Vérifier le nom exact du membre d'énumération `ReservationSlot.DAY` dans
`models.py` avant de lancer, et l'ajuster si la valeur diffère.

- [ ] **Étape 2 : lancer et voir échouer**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/test_attendance_service.py -k reservation -v
```

Attendu : ÉCHEC, `NoResultFound` : aucune ligne d'`attendance` n'a été créée.

- [ ] **Étape 3 : modifier `reservations.check_in`**

Dans `backend/app/services/reservations.py`, importer le service en tête du
fichier :

```python
from app.services import attendance as attendance_svc
```

Puis, dans `check_in`, juste avant le `return` final, après la pose de
`reservation.checked_in_at` et son commit :

```python
    # Confirmer sa présence sur sa réservation, c'est aussi être dans les locaux :
    # une seule source de vérité pour la liste d'évacuation.
    attendance_svc.check_in(db, user_id, source="reservation")
```

Attention au sens des dépendances : `attendance.py` ne doit importer ni
`reservations` ni aucun autre service métier, sans quoi l'import devient
circulaire.

- [ ] **Étape 4 : relancer les tests**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

Attendu : tout PASS, y compris les tests de réservation existants s'il y en a.

- [ ] **Étape 5 : point de contrôle**

Vérifier qu'aucun import circulaire n'a été introduit :

```bash
cd backend && .venv/Scripts/python.exe -c "from app.main import app; print('import ok')"
```

---

## Tâche 8 : front — pop-up d'arrivée et bouton de départ

**Fichiers :**
- Modifier : `backend/app/static/index.html`
- Modifier : `backend/app/static/app.js`
- Modifier : `backend/app/static/styles.css`

**Interfaces consommées :** `GET /api/attendance/me`, `POST /api/attendance/checkin`,
`POST /api/attendance/checkout`, `POST /api/visitors` (tâche 6).

- [ ] **Étape 1 : ajouter la feuille du pop-up**

Dans `backend/app/static/index.html`, à côté des autres `sheet-backdrop`
(vers la ligne 110), en suivant exactement le même patron :

```html
  <!-- Confirmation d'arrivée dans les locaux (sécurité incendie) -->
  <div id="arrivalSheetBackdrop" class="sheet-backdrop hidden">
    <div class="sheet" id="arrivalSheet">
      <div class="sheet-handle"></div>
      <div class="sheet-eyebrow">Présence</div>
      <div class="sheet-title">Tu es au bureau aujourd'hui ?</div>
      <div class="sheet-sub">
        Confirmer ton arrivée permet de savoir qui se trouve dans les locaux,
        notamment en cas d'évacuation.
      </div>
      <div id="arrivalVisitorBlock" class="hidden">
        <div class="sheet-label">Personnes que tu accompagnes</div>
        <div id="arrivalVisitorList"></div>
        <div class="visitor-form">
          <input id="arrivalVisitorName" type="text" maxlength="120" placeholder="Nom et prénom">
          <input id="arrivalVisitorCompany" type="text" maxlength="120" placeholder="Société">
          <button class="btn" id="arrivalVisitorAddBtn" type="button">Ajouter</button>
        </div>
      </div>
      <div class="sheet-actions">
        <button class="btn sheet-cancel" id="arrivalDismissBtn">Pas au bureau aujourd'hui</button>
        <button class="btn btn-primary sheet-confirm" id="arrivalConfirmBtn">Je suis arrivé</button>
      </div>
      <button class="btn-back" id="arrivalVisitorToggleBtn">Je suis accompagné</button>
    </div>
  </div>
```

- [ ] **Étape 2 : ajouter le bouton de départ dans l'entête**

Toujours dans `index.html`, dans la barre d'entête, à côté de `searchBtn` et
`notifBtn` :

```html
      <button class="icon-btn hidden" id="leaveBtn" title="Enregistrer mon départ">Je pars</button>
```

- [ ] **Étape 3 : écrire la logique côté client**

Dans `backend/app/static/app.js`, ajouter une section avant le routeur :

```js
/* ============================================================
   PRÉSENCE DANS LES LOCAUX (arrivée, départ, visiteurs)
   ------------------------------------------------------------
   À ne pas confondre avec la vue "Ma présence", qui sert à déclarer un
   statut matin/après-midi à l'avance. Ici on enregistre un fait : la
   personne est physiquement dans le bâtiment. Sert à l'évacuation.
   ============================================================ */
let attendanceState = { arrived: false, present: false, visitors: [] };

/* Clé de rejet du pop-up, valable pour la seule journée en cours : refuser
   une fois ne doit pas masquer la question pour toujours. Rien n'est envoyé
   au serveur, car quelqu'un qui n'est pas venu ne doit laisser aucune trace
   dans une table de présence. */
function arrivalDismissedToday() {
  return localStorage.getItem("arrivalDismissed") === toLocalISODate(new Date());
}
function dismissArrivalForToday() {
  localStorage.setItem("arrivalDismissed", toLocalISODate(new Date()));
}

function isWorkday(d) {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

async function refreshAttendance() {
  const { ok, data } = await api("/api/attendance/me");
  if (ok && data) attendanceState = data;
  document.getElementById("leaveBtn").classList.toggle("hidden", !attendanceState.present);
  return attendanceState;
}

async function maybeShowArrivalSheet() {
  await refreshAttendance();
  if (attendanceState.arrived) return;
  if (!isWorkday(new Date())) return;
  if (arrivalDismissedToday()) return;
  document.getElementById("arrivalSheetBackdrop").classList.remove("hidden");
}

function closeArrivalSheet() {
  document.getElementById("arrivalSheetBackdrop").classList.add("hidden");
}

function renderArrivalVisitors() {
  const box = document.getElementById("arrivalVisitorList");
  const presents = attendanceState.visitors.filter(v => v.present);
  box.innerHTML = presents.length
    ? presents.map(v => `<div class="visitor-chip">${escapeHtml(v.full_name)}${v.company ? " · " + escapeHtml(v.company) : ""}</div>`).join("")
    : `<div class="empty-inline">Aucun visiteur déclaré.</div>`;
}

async function addVisitorFromSheet() {
  const nameInput = document.getElementById("arrivalVisitorName");
  const companyInput = document.getElementById("arrivalVisitorCompany");
  const full_name = nameInput.value.trim();
  if (!full_name) { toast("Indique le nom du visiteur.", "error"); return; }

  const { ok, data } = await api("/api/visitors", {
    method: "POST",
    body: JSON.stringify({ full_name, company: companyInput.value.trim() || null }),
  });
  if (!ok) { toast((data && data.detail) || "Impossible d'ajouter ce visiteur.", "error"); return; }

  nameInput.value = ""; companyInput.value = "";
  await refreshAttendance();
  renderArrivalVisitors();
  toast("Visiteur enregistré ✓", "success");
}

function initAttendanceUi() {
  document.getElementById("arrivalConfirmBtn").addEventListener("click", async () => {
    const { ok, data } = await api("/api/attendance/checkin", { method: "POST" });
    if (!ok) { toast((data && data.detail) || "Impossible d'enregistrer ton arrivée.", "error"); return; }
    attendanceState = data;
    document.getElementById("leaveBtn").classList.remove("hidden");
    closeArrivalSheet();
    toast("Arrivée confirmée ✓", "success");
    refreshPoints(0);
  });

  document.getElementById("arrivalDismissBtn").addEventListener("click", () => {
    dismissArrivalForToday();
    closeArrivalSheet();
  });

  document.getElementById("arrivalVisitorToggleBtn").addEventListener("click", () => {
    const block = document.getElementById("arrivalVisitorBlock");
    block.classList.toggle("hidden");
    if (!block.classList.contains("hidden")) renderArrivalVisitors();
  });

  document.getElementById("arrivalVisitorAddBtn").addEventListener("click", addVisitorFromSheet);

  document.getElementById("arrivalSheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "arrivalSheetBackdrop") closeArrivalSheet();
  });

  document.getElementById("leaveBtn").addEventListener("click", async () => {
    const { ok, data } = await api("/api/attendance/checkout", { method: "POST" });
    if (!ok) { toast((data && data.detail) || "Impossible d'enregistrer ton départ.", "error"); return; }
    attendanceState = data;
    document.getElementById("leaveBtn").classList.add("hidden");
    toast("Départ enregistré. Bonne soirée !", "success");
  });
}
```

- [ ] **Étape 4 : brancher au démarrage**

Dans la fonction d'initialisation de `app.js` (celle qui contient déjà
`refreshNotifBadge(); setInterval(...); window.addEventListener("hashchange", router); router();`),
insérer avant `router()` :

```js
  initAttendanceUi();
  maybeShowArrivalSheet();
```

- [ ] **Étape 5 : styles**

Dans `backend/app/static/styles.css`, à la suite des styles de feuilles :

```css
/* --- Présence : visiteurs déclarés depuis le pop-up d'arrivée --- */
.visitor-form { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .5rem; }
.visitor-form input { flex: 1 1 8rem; min-width: 0; }
.visitor-chip {
  display: inline-block; margin: .2rem .3rem .2rem 0; padding: .25rem .6rem;
  border-radius: 999px; background: var(--surface-2, #eef2f6); font-size: .85rem;
}
.empty-inline { font-size: .85rem; opacity: .7; padding: .3rem 0; }
```

- [ ] **Étape 6 : incrémenter les versions d'assets**

Dans `index.html`, passer `styles.css?v=51` à `?v=52` et faire de même pour
la balise de `app.js`.

- [ ] **Étape 7 : vérifier dans le navigateur**

Lancer le serveur :

```bash
cd backend && .venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```

Ouvrir `http://localhost:8000`, se connecter, et vérifier :
le pop-up s'affiche ; « Je suis accompagné » déplie le formulaire ; ajouter
un visiteur l'affiche en pastille ; « Je suis arrivé » ferme le pop-up et
fait apparaître le bouton « Je pars » ; recharger la page ne réaffiche pas le
pop-up ; cliquer « Je pars » masque le bouton. Vérifier l'absence d'erreur
dans la console.

- [ ] **Étape 8 : point de contrôle**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

---

## Tâche 9 : front — vue « Dans les locaux »

**Fichiers :**
- Modifier : `backend/app/static/app.js`
- Modifier : `backend/app/static/index.html`
- Modifier : `backend/app/static/styles.css`

**Interfaces consommées :** `GET /api/attendance/today`,
`POST /api/visitors/{id}/checkout` (tâche 6), `attendanceState` (tâche 8).

- [ ] **Étape 1 : déclarer la route**

Dans `app.js`, dans l'objet `ROUTES`, après l'entrée `presence` :

```js
  locaux: { title: "Dans les locaux", render: viewLocaux },
```

- [ ] **Étape 2 : ajouter l'entrée de navigation**

Dans `index.html`, dans `<nav class="nav" id="nav">`, en suivant le patron
des liens existants :

```html
      <a class="nav-link" href="#locaux" data-route="locaux">Dans les locaux</a>
```

- [ ] **Étape 3 : écrire la vue**

Dans `app.js`, à la suite de `viewPresence` :

```js
/* Vue "Dans les locaux" : qui est physiquement présent, employés et visiteurs.
   Volontairement sans heures d'arrivée ni de départ — les afficher à tous
   ferait de l'outil une pointeuse. Les heures existent en base et sortent
   dans l'export réservé aux administrateurs. */
async function viewLocaux() {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="empty">Chargement…</div>`;

  const { ok, data } = await api("/api/attendance/today");
  if (!ok || !data) { view.innerHTML = `<div class="empty">Liste indisponible.</div>`; return; }

  const employes = data.employees.length
    ? data.employees.map(e => `
        <div class="list-item">
          <div class="colleague-av" style="background:${colorFor(e.name)}">${initials(e.name)}</div>
          <div><div class="li-title">${escapeHtml(e.name)}</div>
          <div class="li-sub">${escapeHtml(e.department || "")}</div></div>
        </div>`).join("")
    : `<div class="empty">Personne n'a encore confirmé son arrivée.</div>`;

  const visiteurs = data.visitors.length
    ? data.visitors.map(v => `
        <div class="list-item">
          <div class="colleague-av visitor-av">${initials(v.full_name)}</div>
          <div><div class="li-title">${escapeHtml(v.full_name)}</div>
          <div class="li-sub">${escapeHtml(v.company || "Externe")} · reçu par ${escapeHtml(v.host_name)}</div></div>
          ${v.host_user_id === state.profile.id ? `<button class="btn btn-small" data-visitor-out="${v.id}">Parti</button>` : ""}
        </div>`).join("")
    : `<div class="empty">Aucun visiteur déclaré aujourd'hui.</div>`;

  view.innerHTML = `
    <div class="card">
      <h3>Employés présents (${data.employees.length})</h3>
      <div class="list">${employes}</div>
    </div>
    <div class="card">
      <h3>Visiteurs (${data.visitors.length})</h3>
      <div class="list">${visiteurs}</div>
      <div class="card-note">Tu peux déclarer une personne que tu accompagnes depuis le message d'arrivée, ou ici même en revenant demain.</div>
    </div>`;

  view.querySelectorAll("[data-visitor-out]").forEach(btn => btn.addEventListener("click", async () => {
    const { ok, data: res } = await api(`/api/visitors/${btn.dataset.visitorOut}/checkout`, { method: "POST" });
    if (!ok) { toast((res && res.detail) || "Impossible d'enregistrer ce départ.", "error"); return; }
    toast("Départ du visiteur enregistré ✓", "success");
    viewLocaux();
  }));
}
```

Vérifier que `state.profile` expose bien `id` ; s'il expose un autre nom de
champ, ajuster la comparaison `v.host_user_id === state.profile.id`.

- [ ] **Étape 4 : style de l'avatar visiteur**

Dans `styles.css` :

```css
/* Avatar de visiteur : contour plutôt qu'aplat, pour le distinguer d'un employé. */
.visitor-av { background: transparent; border: 2px dashed var(--brand, #00608D); color: var(--brand, #00608D); }
```

- [ ] **Étape 5 : incrémenter les versions d'assets**

Passer `?v=52` à `?v=53` pour `styles.css` et `app.js` dans `index.html`.

- [ ] **Étape 6 : vérifier dans le navigateur**

Serveur lancé, ouvrir « Dans les locaux » : la personne connectée apparaît
après avoir confirmé son arrivée, les visiteurs déclarés apparaissent avec
leur hôte, le bouton « Parti » n'est proposé que sur ses propres visiteurs,
et cliquer dessus retire le visiteur de la liste. Aucune heure affichée.

- [ ] **Étape 7 : point de contrôle**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

---

## Tâche 10 : administration — heure de clôture et export

**Fichiers :**
- Modifier : `backend/app/static/app.js` (fonction `viewAdmin`)
- Modifier : `backend/app/static/index.html` (version des assets)

**Interfaces consommées :** `GET/PATCH /api/admin/attendance/settings`,
`GET /api/admin/attendance/export` (tâche 6).

- [ ] **Étape 1 : ajouter la section admin**

Dans `app.js`, repérer `viewAdmin` et le patron des sections existantes
(cartes avec titre et champs). Ajouter une section construite sur le même
modèle :

```js
/* Section d'administration de la présence : heure de clôture et relevé du jour. */
async function renderAdminAttendance(container) {
  const { data } = await api("/api/admin/attendance/settings");
  const heure = (data && data.auto_close_hour) ?? 19;

  container.innerHTML = `
    <h3>Présence dans les locaux</h3>
    <div class="admin-row">
      <label for="autoCloseHour">Clôture automatique des présences oubliées</label>
      <input id="autoCloseHour" type="number" min="0" max="23" value="${heure}"> h
      <button class="btn" id="autoCloseSaveBtn" type="button">Enregistrer</button>
    </div>
    <div class="card-note">
      Toute personne encore marquée présente après cette heure est considérée comme partie,
      et son départ apparaît comme non confirmé dans le relevé.
    </div>
    <div class="admin-row">
      <a class="btn btn-primary" href="/api/admin/attendance/export">Exporter le relevé du jour (CSV)</a>
    </div>`;

  container.querySelector("#autoCloseSaveBtn").addEventListener("click", async () => {
    const valeur = parseInt(container.querySelector("#autoCloseHour").value, 10);
    const { ok, data: res } = await api("/api/admin/attendance/settings", {
      method: "PATCH",
      body: JSON.stringify({ auto_close_hour: valeur }),
    });
    toast(ok ? "Heure de clôture enregistrée ✓" : ((res && res.detail) || "Valeur invalide."), ok ? "success" : "error");
  });
}
```

Puis appeler `renderAdminAttendance` depuis `viewAdmin`, dans un conteneur
`<div class="card" id="adminAttendance"></div>` inséré avec les autres cartes
d'administration.

- [ ] **Étape 2 : incrémenter les versions d'assets**

`?v=53` devient `?v=54` pour `styles.css` et `app.js`.

- [ ] **Étape 3 : vérifier dans le navigateur**

Connecté en administrateur, ouvrir Administration : la section apparaît,
changer l'heure et enregistrer affiche la confirmation, recharger conserve la
valeur, et le lien d'export télécharge un CSV qui s'ouvre correctement dans
Excel avec les accents.

Connecté en employé simple, vérifier que l'appel direct à
`/api/admin/attendance/export` renvoie bien 403.

- [ ] **Étape 4 : point de contrôle**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

---

## Tâche 11 : vérification de bout en bout et documentation

**Fichiers :**
- Modifier : `docs/ARCHITECTURE.md`
- Modifier : `README.md` (section des tests)

- [ ] **Étape 1 : dérouler le parcours complet**

Serveur lancé sur une base de développement vierge, dérouler dans l'ordre les
neuf points de la section « Vérification » de la spec, et noter le résultat
observé de chacun. Un point qui ne passe pas est un défaut à corriger, pas
une case à cocher.

Pour le point 6 (clôture d'une présence de la veille), créer la donnée à la
main :

```bash
cd backend && .venv/Scripts/python.exe -c "
from datetime import timedelta
from app.core.timezone import local_now, local_today
from app.db.session import SessionLocal
from app.db import models as m
from app.services import attendance as svc

with SessionLocal() as db:
    user = db.query(m.User).first()
    hier = local_today() - timedelta(days=1)
    db.add(m.Attendance(user_id=user.id, day=hier, arrived_at=local_now()))
    db.commit()
    print('lignes cloturees :', svc.close_stale(db))
    row = db.query(m.Attendance).filter_by(day=hier).one()
    print('depart :', row.left_at, '| auto :', row.auto_closed)
"
```

Attendu : `lignes cloturees : 1`, un départ daté d'hier à l'heure limite, et
`auto : True`.

- [ ] **Étape 2 : documenter**

Dans `docs/ARCHITECTURE.md`, ajouter à la liste des services :

```markdown
- `services/attendance.py` : présence physique dans les locaux (arrivées,
  départs, visiteurs externes, liste d'évacuation). À distinguer de
  `daily_status`, qui porte le statut déclaré à l'avance. La clôture du soir
  se fait par balayage paresseux, sans planificateur.
```

Dans `README.md`, ajouter une section intitulée `## Tests`, contenant un bloc
de code shell avec les trois lignes suivantes :

```bash
cd backend
.venv/Scripts/python.exe -m pip install -r requirements-dev.txt
.venv/Scripts/python.exe -m pytest tests/ -v
```

suivi de la phrase : « Les tests tournent sur une base SQLite en mémoire,
recréée pour chaque test : ils ne touchent jamais `coworking.db`. »

- [ ] **Étape 3 : vérification finale**

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests/ -v
```

Attendu : la totalité des tests PASS. Reporter le nombre exact.

- [ ] **Étape 4 : remise à Thibaud**

Résumer ce qui a été fait, ce qui a été vérifié et comment, et ce qui reste
en suspens. **Aucun commit, aucun push.** Thibaud décide de la suite.

---

## Ce qui reste hors de ce plan

Les lots B, C et D du mail d'Olivier du 25 août 2026 :

- **Lot B** : activer ou désactiver en administration la réservation d'une
  table, d'une place, d'une salle ; griser un espace indisponible ; interdire
  la réservation d'une salle complète ; nommer les autres occupants lors
  d'une réservation de salle ou de table entière ; choisir une icône par type
  de poste.
- **Lot C** : nouvelle image du plan (pièce jointe à récupérer), acronymes de
  quatre lettres au lieu de deux, équipements visibles sur le plan avec icône
  choisie en administration, réservation superposée au plan, envoi du plan
  depuis l'administration.
- **Lot D** : espacement dans « Mes réservations » entre le nom de la table
  et le jour, affichage du type d'écran, page des récompenses, points
  négatifs éventuels.
