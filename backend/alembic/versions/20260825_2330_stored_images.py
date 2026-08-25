"""stored_images

Images envoyées depuis l'administration, stockées EN BASE et non sur le disque.

Render remonte un système de fichiers neuf à chaque déploiement : un plan déposé
dans app/static/img disparaîtrait à la mise à jour suivante, exactement comme
les données avaient disparu en août avant le passage à PostgreSQL. La base est
le seul endroit qui survit.

Une image de plan pèse une centaine de kilooctets : parfaitement tenable en
base, et cela évite d'ajouter un service de stockage externe pour un fichier.

Revision ID: a2b8e4d7f193
Revises: f7c1d3e8a520
Create Date: 2026-08-25 23:30:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a2b8e4d7f193"
down_revision: Union[str, None] = "f7c1d3e8a520"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "stored_images",
        sa.Column("key", sa.String(length=60), nullable=False),
        sa.Column("content_type", sa.String(length=60), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("stored_images")
