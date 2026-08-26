"""table_labels_free_features

Sépare le NOM d'une table de l'open space de l'ÉQUIPEMENT de ses postes.

Jusqu'ici le champ `desks.features` servait aux deux : « Table 1 » y tenait lieu
de nom de table, et c'est aussi ce champ qui affiche les équipements d'un poste.
Impossible, donc, d'indiquer « double écran » sur une place d'open space sans
renommer la table du même coup — alors qu'Olivier demande précisément de voir
double écran, écran courbé et docking station (mail du 25/08/2026).

Le nom d'une table vit désormais dans `app_settings`, sous la clé
`table_label_t1`, `table_label_t2`, … comme pour les bureaux et les bulles. Le
champ `features` est libéré : il ne décrit plus que l'équipement, et l'admin peut
le remplir poste par poste.

Aucune information n'est perdue : le nom lu dans `features` est recopié dans le
réglage avant d'être effacé, et la descente refait le trajet inverse.

Revision ID: c4a7f2b9d631
Revises: b6d0c9a15e42
Create Date: 2026-08-26 10:00:00.000000
"""
import re
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c4a7f2b9d631"
down_revision: Union[str, None] = "b6d0c9a15e42"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Un poste d'open space se nomme "T3-2" : le préfixe est la référence de sa table.
POSTE_DE_TABLE = re.compile(r"^(T\d+)-\d+$")
# Ce qui, dans `features`, n'est qu'un nom de table déguisé.
NOM_DE_TABLE = re.compile(r"^Table\s+\d+$", re.IGNORECASE)


def upgrade() -> None:
    bind = op.get_bind()
    postes = bind.execute(sa.text("SELECT name, features FROM desks WHERE features IS NOT NULL")).all()

    noms: dict[str, str] = {}
    a_vider: list[str] = []
    for nom_poste, features in postes:
        m = POSTE_DE_TABLE.match(nom_poste or "")
        if not m or not NOM_DE_TABLE.match((features or "").strip()):
            continue
        noms.setdefault(m.group(1), features.strip())
        a_vider.append(nom_poste)

    for ref, libelle in noms.items():
        cle = f"table_label_{ref.lower()}"
        deja = bind.execute(sa.text("SELECT 1 FROM app_settings WHERE key = :k"), {"k": cle}).first()
        if not deja:
            bind.execute(
                sa.text("INSERT INTO app_settings (key, value) VALUES (:k, :v)"),
                {"k": cle, "v": libelle},
            )

    for nom_poste in a_vider:
        bind.execute(sa.text("UPDATE desks SET features = NULL WHERE name = :n"), {"n": nom_poste})


def downgrade() -> None:
    bind = op.get_bind()
    reglages = bind.execute(
        sa.text("SELECT key, value FROM app_settings WHERE key LIKE 'table_label_%'")
    ).all()
    for cle, libelle in reglages:
        ref = cle.removeprefix("table_label_").upper()
        bind.execute(
            sa.text("UPDATE desks SET features = :v WHERE name LIKE :p AND features IS NULL"),
            {"v": libelle, "p": f"{ref}-%"},
        )
        bind.execute(sa.text("DELETE FROM app_settings WHERE key = :k"), {"k": cle})
