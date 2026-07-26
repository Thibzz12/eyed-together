"""Jeu de données de démo : quelques postes de coworking.

Usage :  python -m app.db.seed        (crée les postes s'ils n'existent pas)
Aussi appelé automatiquement au démarrage en mode développement.
"""

from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models as m
from app.db.session import SessionLocal

# (nom, zone/bureau, étage, équipements)
# 2 bureaux fermés de 6 places (déjà existants) + open space (plan réel fourni par Thibaud) :
#   Table 1 (4 places) et Table 2 (4 places) réservables,
#   Table 3 (6 places) réservable — la 2e table de 6 barrée sur le plan n'est PAS créée,
#   le coin salon barré entre les 2 bureaux n'est pas créé non plus.
_DEMO_DESKS = [
    ("B1-1", "Bureau 1", "Rez-de-chaussée", "Double écran"),
    ("B1-2", "Bureau 1", "Rez-de-chaussée", "Double écran"),
    ("B1-3", "Bureau 1", "Rez-de-chaussée", "Station assise/debout"),
    ("B1-4", "Bureau 1", "Rez-de-chaussée", None),
    ("B1-5", "Bureau 1", "Rez-de-chaussée", None),
    ("B1-6", "Bureau 1", "Rez-de-chaussée", "Près de la fenêtre"),
    ("B2-1", "Bureau 2", "Rez-de-chaussée", "Double écran"),
    ("B2-2", "Bureau 2", "Rez-de-chaussée", None),
    ("B2-3", "Bureau 2", "Rez-de-chaussée", "Station assise/debout"),
    ("B2-4", "Bureau 2", "Rez-de-chaussée", None),
    ("B2-5", "Bureau 2", "Rez-de-chaussée", "Près de la fenêtre"),
    ("B2-6", "Bureau 2", "Rez-de-chaussée", None),
    ("T1-1", "Open Space", "Rez-de-chaussée", "Table 1"),
    ("T1-2", "Open Space", "Rez-de-chaussée", "Table 1"),
    ("T1-3", "Open Space", "Rez-de-chaussée", "Table 1"),
    ("T1-4", "Open Space", "Rez-de-chaussée", "Table 1"),
    ("T2-1", "Open Space", "Rez-de-chaussée", "Table 2"),
    ("T2-2", "Open Space", "Rez-de-chaussée", "Table 2"),
    ("T2-3", "Open Space", "Rez-de-chaussée", "Table 2"),
    ("T2-4", "Open Space", "Rez-de-chaussée", "Table 2"),
    ("T3-1", "Open Space", "Rez-de-chaussée", "Table 3"),
    ("T3-2", "Open Space", "Rez-de-chaussée", "Table 3"),
    ("T3-3", "Open Space", "Rez-de-chaussée", "Table 3"),
    ("T3-4", "Open Space", "Rez-de-chaussée", "Table 3"),
    ("T3-5", "Open Space", "Rez-de-chaussée", "Table 3"),
    ("T3-6", "Open Space", "Rez-de-chaussée", "Table 3"),
    ("T4-1", "Open Space", "Rez-de-chaussée", "Table 4"),
    ("T4-2", "Open Space", "Rez-de-chaussée", "Table 4"),
    ("T4-3", "Open Space", "Rez-de-chaussée", "Table 4"),
    ("T4-4", "Open Space", "Rez-de-chaussée", "Table 4"),
    ("T4-5", "Open Space", "Rez-de-chaussée", "Table 4"),
    ("T4-6", "Open Space", "Rez-de-chaussée", "Table 4"),
]


def seed_desks_if_empty(db: Session) -> int:
    """Crée les postes de démo (avec leur position) uniquement si la table est vide."""
    from app.floorplan import position_for

    count = db.scalar(select(func.count()).select_from(m.Desk))
    if count:
        return 0
    for (n, z, f, feat) in _DEMO_DESKS:
        x, y = position_for(n)
        db.add(m.Desk(name=n, zone=z, floor=f, features=feat, pos_x=x, pos_y=y))
    db.commit()
    return len(_DEMO_DESKS)


# Anciens collègues fictifs de démo (retirés — l'app ne doit plus afficher de faux profils).
_DEMO_COLLEAGUE_OIDS = [f"demo-colleague-{i}" for i in range(3)]


def cleanup_demo_colleagues_if_present(db: Session) -> int:
    """Supprime les anciens collègues fictifs (Camille, Marc, Sarah) et leurs réservations,
    s'ils existent encore d'un précédent démarrage. Idempotent : ne fait rien s'ils sont déjà partis."""
    users = db.scalars(select(m.User).where(m.User.entra_oid.in_(_DEMO_COLLEAGUE_OIDS))).all()
    if not users:
        return 0
    user_ids = [u.id for u in users]
    db.query(m.Reservation).filter(m.Reservation.user_id.in_(user_ids)).delete(synchronize_session=False)
    for u in users:
        db.delete(u)
    db.commit()
    return len(users)


# Cartes d'accueil par défaut (clé, titre, position, mise en avant).
_DEFAULT_CARDS = [
    ("presence", "Mon statut du jour", 0, False),
    ("next_reservation", "Ma réservation", 1, False),
    ("project_progress", "Building Our Future Home", 2, True),
    ("team_presence", "Présents aujourd'hui", 3, False),
    ("events", "Événements à venir", 4, False),
    ("news", "Actualités", 5, False),
    ("coworking_status", "Espaces de coworking", 6, False),
    ("mes_evenements", "Mes inscriptions aux événements", 7, False),
    ("liens_utiles", "Liens utiles", 8, False),
    ("birthdays", "Anniversaires", 0, True),
]


def seed_dashboard_if_empty(db: Session) -> int:
    """Crée les cartes d'accueil + les réglages par défaut si absents."""
    created = 0
    if not db.scalar(select(func.count()).select_from(m.DashboardCard)):
        db.add_all(
            m.DashboardCard(key=k, title=t, position=p, highlighted=h, enabled=True)
            for (k, t, p, h) in _DEFAULT_CARDS
        )
        created = len(_DEFAULT_CARDS)
    else:
        # Rattrape les cartes ajoutées après le 1er démarrage (dev déjà seedé).
        existing_keys = {k for (k,) in db.execute(select(m.DashboardCard.key)).all()}
        for key, title, position, highlighted in _DEFAULT_CARDS:
            if key not in existing_keys:
                db.add(m.DashboardCard(key=key, title=title, position=position, highlighted=highlighted, enabled=True))
                created += 1
    # Réglages progression projet ("fil rouge" Building Our Future Home)
    from datetime import timedelta
    default_target = (date.today() + timedelta(days=90)).isoformat()
    for key, val in (
        ("project_progress_value", "35"),
        ("project_progress_label", "Phase 2 · Aménagement"),
        ("project_milestone_title", "Nouveaux locaux"),
        ("project_target_date", default_target),
    ):
        if not db.get(m.AppSetting, key):
            db.add(m.AppSetting(key=key, value=val))
    db.commit()
    return created


if __name__ == "__main__":
    with SessionLocal() as session:
        created = seed_desks_if_empty(session)
        print(f"{created} poste(s) créé(s)." if created else "Postes déjà présents, rien à faire.")
