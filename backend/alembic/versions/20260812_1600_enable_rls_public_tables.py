"""enable_rls_public_tables

Ferme l'API PostgREST de Supabase, que l'application n'utilise pas.

Le backend parle à PostgreSQL en direct (SQLAlchemy, rôle `postgres`, qui a
BYPASSRLS) : activer RLS ne change donc rien pour l'app, mais coupe tout accès
via l'API REST publique du projet Supabase, où les tables étaient jusqu'ici
lisibles et modifiables par n'importe qui connaissant l'URL du projet.

Ceinture et bretelles : on active RLS *et* on retire les droits des rôles
`anon` / `authenticated` sur le schéma public, y compris pour les tables
créées par les migrations futures.

Revision ID: d1a4b7c2e883
Revises: c8d3e6a1f709
Create Date: 2026-08-12 16:00:00.000000
"""
from typing import Sequence, Union

from alembic import op


# Identifiants de révision Alembic.
revision: str = 'd1a4b7c2e883'
down_revision: Union[str, None] = 'c8d3e6a1f709'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Boucle sur toutes les tables du schéma public : pas de liste en dur à tenir
# à jour, la migration reste correcte quel que soit le schéma du moment.
_SET_RLS = """
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%%I %s ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;
"""

# Les rôles anon/authenticated n'existent que sur Supabase : on ne touche aux
# droits que s'ils sont présents, pour rester exécutable sur un PostgreSQL nu.
_SET_GRANTS = """
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    %s
  END IF;
END $$;
"""

_REVOKE = """
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM anon, authenticated;
"""

_GRANT = """
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON SEQUENCES TO anon, authenticated;
"""


def _is_postgres() -> bool:
    # En développement la base est SQLite : rien à faire, le concept n'existe pas.
    return op.get_bind().dialect.name == 'postgresql'


def upgrade() -> None:
    if not _is_postgres():
        return
    op.execute(_SET_RLS % 'ENABLE')
    op.execute(_SET_GRANTS % _REVOKE)


def downgrade() -> None:
    if not _is_postgres():
        return
    op.execute(_SET_GRANTS % _GRANT)
    op.execute(_SET_RLS % 'DISABLE')
