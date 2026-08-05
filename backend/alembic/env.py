"""Environnement de migration Alembic.

Particularités :
  - L'URL de la base vient de nos settings (pas du .ini) => une seule source de vérité.
  - `render_as_batch=True` : indispensable pour SQLite (permet les ALTER TABLE).
  - On importe les modèles pour que `Base.metadata` connaisse toutes les tables.
"""

from logging.config import fileConfig

from sqlalchemy import create_engine, pool

from alembic import context

from app.core.config import settings
from app.db.base import Base
from app.db import models  # noqa: F401  -> enregistre les modèles dans Base.metadata

config = context.config
# L'URL vient des settings (secrets hors du dépôt) et n'est JAMAIS écrite dans la config
# Alembic : celle-ci passe par configparser, où `%` amorce une interpolation. Un mot de
# passe percent-encodé (`%2B` pour un `+`) y déclencherait un ValueError au démarrage.

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# Le batch mode n'est utile/nécessaire que pour SQLite.
_is_sqlite = settings.DATABASE_URL.startswith("sqlite")


def run_migrations_offline() -> None:
    """Migrations en mode 'offline' (génère du SQL sans connexion active)."""
    context.configure(
        url=settings.DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=_is_sqlite,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Migrations en mode 'online' (connexion réelle à la base)."""
    connectable = create_engine(settings.DATABASE_URL, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=_is_sqlite,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
