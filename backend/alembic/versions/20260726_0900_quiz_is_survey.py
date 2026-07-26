"""quiz_is_survey

Revision ID: 9a3f5c1b7e2d
Revises: 6ed247eafbf9
Create Date: 2026-07-26 09:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# Identifiants de révision Alembic.
revision: str = '9a3f5c1b7e2d'
down_revision: Union[str, None] = '6ed247eafbf9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('quizzes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('is_survey', sa.Boolean(), server_default='0', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('quizzes', schema=None) as batch_op:
        batch_op.drop_column('is_survey')
