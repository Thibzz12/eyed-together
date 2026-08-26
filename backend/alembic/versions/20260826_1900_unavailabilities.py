"""unavailabilities

Indisponibilités : une place ou un espace fermé à la réservation, éventuellement
sur une plage de dates.

Le drapeau `space_enabled_<ref>` ne savait faire ni l'un ni l'autre. Olivier
demande de fermer « la place T1-3 parce que le bureau est cassé », et de dire à
partir de quand et jusqu'à quand. Les drapeaux existants sont repris ici comme
des indisponibilités sans date, pour ne rien perdre de ce qui est déjà réglé.

Revision ID: d3f6b81c04e7
Revises: c4a7f2b9d631
Create Date: 2026-08-26 19:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d3f6b81c04e7"
down_revision: Union[str, None] = "c4a7f2b9d631"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_PREFIXE = "space_enabled_"


def upgrade() -> None:
    op.create_table(
        "unavailabilities",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("scope", sa.String(length=10), nullable=False),
        sa.Column("target", sa.String(length=100), nullable=False),
        sa.Column("since", sa.Date(), nullable=True),
        sa.Column("until", sa.Date(), nullable=True),
        sa.Column("reason", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_unavailabilities_target", "unavailabilities", ["target"])

    # Reprise des espaces déjà grisés : ils deviennent des indisponibilités sans
    # date, exactement le même effet qu'avant la migration.
    bind = op.get_bind()
    fermes = bind.execute(
        sa.text("SELECT key, value FROM app_settings WHERE key LIKE :motif"),
        {"motif": _PREFIXE + "%"},
    ).all()
    for cle, valeur in fermes:
        if valeur not in ("0", "false", "False", ""):
            continue
        bind.execute(
            sa.text(
                "INSERT INTO unavailabilities (scope, target, reason) "
                "VALUES ('space', :cible, 'Repris du réglage précédent')"
            ),
            {"cible": cle[len(_PREFIXE):]},
        )
    bind.execute(sa.text("DELETE FROM app_settings WHERE key LIKE :motif"), {"motif": _PREFIXE + "%"})


def downgrade() -> None:
    # On ne restaure que ce que l'ancien format savait exprimer : un espace
    # fermé sans date. Les fermetures de places et les périodes n'ont pas
    # d'équivalent et disparaissent avec la table.
    bind = op.get_bind()
    espaces = bind.execute(
        sa.text(
            "SELECT DISTINCT target FROM unavailabilities "
            "WHERE scope = 'space' AND since IS NULL AND until IS NULL"
        )
    ).all()
    for (cible,) in espaces:
        bind.execute(
            sa.text("INSERT INTO app_settings (key, value) VALUES (:k, '0')"),
            {"k": _PREFIXE + cible},
        )
    op.drop_index("ix_unavailabilities_target", table_name="unavailabilities")
    op.drop_table("unavailabilities")
