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
