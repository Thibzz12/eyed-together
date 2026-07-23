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


# Collègues fictifs pour peupler le plan en démo (nom, e-mail, département).
_DEMO_COLLEAGUES = [
    ("Camille Dubois", "camille.dubois@demo.com", "Marketing"),
    ("Marc Lefevre", "marc.lefevre@demo.com", "R&D"),
    ("Sarah Khan", "sarah.khan@demo.com", "Ventes"),
]
# Postes occupés par ces collègues (aujourd'hui, matin).
_DEMO_BOOKINGS = [("B1-2", 0), ("B2-1", 1), ("B1-5", 2)]


def seed_demo_reservations_if_empty(db: Session) -> int:
    """Crée des collègues de démo + leurs réservations du jour (idempotent).

    Basé sur l'existence des collègues démo, pour peupler le plan même si
    l'utilisateur a déjà ses propres réservations.
    """
    if db.scalar(select(m.User).where(m.User.entra_oid == "demo-colleague-0")):
        return 0  # déjà fait
    users = [
        m.User(entra_oid=f"demo-colleague-{i}", email=email, display_name=name, department=dept)
        for i, (name, email, dept) in enumerate(_DEMO_COLLEAGUES)
    ]
    db.add_all(users)
    db.flush()

    desks = {d.name: d for d in db.scalars(select(m.Desk))}
    today = date.today()
    created = 0
    for desk_name, user_idx in _DEMO_BOOKINGS:
        desk = desks.get(desk_name)
        if not desk:
            continue
        # Ne pas entrer en conflit avec une réservation déjà présente sur ce créneau.
        taken = db.scalar(
            select(m.Reservation).where(
                m.Reservation.desk_id == desk.id,
                m.Reservation.reservation_date == today,
                m.Reservation.slot == m.ReservationSlot.AM,
                m.Reservation.status == m.ReservationStatus.BOOKED,
            )
        )
        if taken:
            continue
        db.add(m.Reservation(
            user_id=users[user_idx].id, desk_id=desk.id,
            reservation_date=today, slot=m.ReservationSlot.AM,
        ))
        created += 1
    db.commit()
    return created


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
    # Réglages progression projet
    for key, val in (("project_progress_value", "35"), ("project_progress_label", "Aménagement des nouveaux bureaux")):
        if not db.get(m.AppSetting, key):
            db.add(m.AppSetting(key=key, value=val))
    db.commit()
    return created


if __name__ == "__main__":
    with SessionLocal() as session:
        created = seed_desks_if_empty(session)
        print(f"{created} poste(s) créé(s)." if created else "Postes déjà présents, rien à faire.")
