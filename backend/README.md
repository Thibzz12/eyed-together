# Coworking Booking — Backend

API de réservation de places de coworking (demi-journées) avec gamification et SSO Microsoft.

**Stack :** FastAPI · SQLAlchemy 2.0 · Alembic · PostgreSQL (prod) / SQLite (dev) · Entra ID (SSO)

## Démarrage (dev)

```bash
# 1. Environnement virtuel
python -m venv .venv
# Windows :
.\.venv\Scripts\activate

# 2. Dépendances
pip install -r requirements.txt

# 3. Configuration
copy .env.example .env      # (cp sous Linux/Mac) puis ajuster si besoin

# 4. Créer / mettre à jour la base
alembic upgrade head
```

## Migrations

```bash
# Après une modification des modèles (app/db/models.py) :
alembic revision --autogenerate -m "description du changement"
alembic upgrade head
```

## Structure

```
app/
  core/config.py     # Configuration via variables d'environnement (secrets hors du code)
  db/base.py         # Base déclarative ORM
  db/session.py      # Moteur + sessions (get_db pour FastAPI)
  db/models.py       # Les 6 entités (User, Desk, Reservation, PointTransaction, Badge, UserBadge)
alembic/             # Migrations de base de données
```
