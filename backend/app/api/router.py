"""Endpoints REST du cœur métier (préfixe /api).

Toutes les routes exigent une session valide (get_current_user).
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import schemas
from app.db import models as m
from app.db.session import get_db
from app.deps import get_current_user, require_admin
from app.services import reservations as svc
from app.services.dashboard import build_dashboard, get_setting, set_setting
from app.services.wordpress import fetch_content_detail, fetch_event_detail, fetch_events, fetch_news

router = APIRouter(prefix="/api", tags=["reservations"])


def _desk_read(desk: m.Desk) -> schemas.DeskRead:
    """Construit le DeskRead (position lue depuis la base)."""
    return schemas.DeskRead(
        id=desk.id, name=desk.name, zone=desk.zone, floor=desk.floor,
        features=desk.features, pos_x=desk.pos_x, pos_y=desk.pos_y,
    )


@router.get("/profile", response_model=schemas.UserProfile)
def profile(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Profil de l'utilisateur connecté, avec ses points à jour (pour l'en-tête)."""
    u = db.get(m.User, user["id"])
    # Construction explicite (le modèle utilise `display_name`, le schéma `name`).
    return schemas.UserProfile(
        id=u.id,
        name=u.display_name,
        email=u.email,
        department=u.department,
        role=u.role.value,
        total_points=u.total_points,
    )


@router.get("/desks", response_model=list[schemas.DeskRead])
def list_desks(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Liste des postes de coworking."""
    return [_desk_read(d) for d in svc.list_desks(db)]


@router.get("/availability", response_model=list[schemas.DeskAvailability])
def availability(
    day: date = Query(..., alias="date", description="Date au format AAAA-MM-JJ"),
    slot: str = Query(..., description="AM, PM ou DAY (journée)"),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Disponibilité de chaque poste pour une date + un créneau."""
    return [
        schemas.DeskAvailability(desk=_desk_read(desk), is_available=name is None, booked_by=name)
        for desk, name in svc.get_availability(db, day, slot)
    ]


@router.post("/reservations", response_model=schemas.ReservationRead, status_code=status.HTTP_201_CREATED)
def create_reservation(
    data: schemas.ReservationCreate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Réserver un poste pour une demi-journée (attribue les points)."""
    return svc.create_reservation(db, user["id"], data)


@router.get("/reservations/me", response_model=list[schemas.ReservationRead])
def my_reservations(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Mes réservations à venir."""
    return svc.my_reservations(db, user["id"])


@router.delete("/reservations/{reservation_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_reservation(
    reservation_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Annuler une de mes réservations."""
    svc.cancel_reservation(db, user["id"], reservation_id)


@router.get("/events", response_model=list[schemas.EventRead])
def events(limit: int = Query(6, ge=1, le=30), _=Depends(get_current_user)):
    """Événements lus en direct depuis l'intranet WordPress (weared.team)."""
    return fetch_events(limit=limit)


@router.get("/events/{event_id}", response_model=schemas.EventDetail)
def event_detail(event_id: int, _=Depends(get_current_user)):
    """Contenu complet d'un événement, pour l'afficher dans l'app."""
    d = fetch_event_detail(event_id)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Événement introuvable.")
    return d


@router.get("/news")
def news(limit: int = Query(6, ge=1, le=20), _=Depends(get_current_user)):
    """Actualités lues en direct depuis l'intranet WordPress."""
    return fetch_news(limit=limit)


@router.get("/news/{post_id}", response_model=schemas.EventDetail)
def news_detail(post_id: int, _=Depends(get_current_user)):
    """Contenu complet d'une actualité, pour l'afficher dans l'app."""
    d = fetch_content_detail("posts", post_id)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Actualité introuvable.")
    return d


# ------------------------------------------------------------------ Tableau de bord
@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Cartes de l'accueil (activées, ordonnées) avec leurs données."""
    return {"cards": build_dashboard(db, user["id"]), "user_name": user["name"]}


@router.get("/admin/dashboard")
def admin_dashboard(db: Session = Depends(get_db), _=Depends(require_admin)):
    """Toutes les cartes (admin) pour configuration."""
    cards = db.scalars(select(m.DashboardCard).order_by(m.DashboardCard.position)).all()
    return {
        "cards": [
            {"id": c.id, "key": c.key, "title": c.title, "enabled": c.enabled, "highlighted": c.highlighted}
            for c in cards
        ],
        "project_progress": {
            "value": int(get_setting(db, "project_progress_value", "0") or 0),
            "label": get_setting(db, "project_progress_label", ""),
        },
    }


@router.put("/admin/dashboard")
def admin_dashboard_save(
    cards: list[schemas.DashboardCardUpdate],
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """Enregistre l'ordre, l'activation et la mise en avant des cartes."""
    for index, item in enumerate(cards):
        card = db.get(m.DashboardCard, item.id)
        if card:
            card.enabled = item.enabled
            card.highlighted = item.highlighted
            card.position = index
    db.commit()
    return {"ok": True}


@router.get("/admin/desks", response_model=list[schemas.DeskAdminRead])
def admin_desks(db: Session = Depends(get_db), _=Depends(require_admin)):
    """Tous les postes (actifs et inactifs) pour la gestion des capacités."""
    return list(db.scalars(select(m.Desk).order_by(m.Desk.zone, m.Desk.name)))


@router.post("/admin/desks", response_model=schemas.DeskAdminRead, status_code=status.HTTP_201_CREATED)
def admin_desk_create(data: schemas.DeskCreate, db: Session = Depends(get_db), _=Depends(require_admin)):
    """Ajoute un poste (augmente la capacité de l'espace)."""
    if db.scalar(select(m.Desk).where(m.Desk.name == data.name)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Un poste porte déjà ce nom.")
    desk = m.Desk(
        name=data.name, zone=data.zone, floor="Rez-de-chaussée",
        features=data.features, pos_x=data.pos_x, pos_y=data.pos_y, is_active=True,
    )
    db.add(desk)
    db.commit()
    db.refresh(desk)
    return desk


@router.patch("/admin/desks/{desk_id}", response_model=schemas.DeskAdminRead)
def admin_desk_update(desk_id: int, data: schemas.DeskUpdate, db: Session = Depends(get_db), _=Depends(require_admin)):
    """Modifie un poste (nom, bureau, position, activation)."""
    desk = db.get(m.Desk, desk_id)
    if desk is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Poste introuvable.")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(desk, field, value)
    db.commit()
    db.refresh(desk)
    return desk


@router.delete("/admin/desks/{desk_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_desk_delete(desk_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    """Supprime un poste (réduit la capacité ; ses réservations sont supprimées)."""
    desk = db.get(m.Desk, desk_id)
    if desk is not None:
        db.delete(desk)
        db.commit()


@router.put("/admin/project-progress")
def admin_project_progress(
    data: schemas.ProjectProgress,
    db: Session = Depends(get_db),
    _=Depends(require_admin),
):
    """Met à jour l'indicateur de progression du projet."""
    set_setting(db, "project_progress_value", str(max(0, min(100, data.value))))
    set_setting(db, "project_progress_label", data.label)
    db.commit()
    return {"ok": True}


@router.get("/status/me", response_model=list[schemas.DailyStatusRead])
def my_status(
    start: date = Query(..., alias="from"),
    end: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Mes statuts de présence déclarés sur une période (ex. la semaine)."""
    rows = db.scalars(
        select(m.DailyStatus).where(
            m.DailyStatus.user_id == user["id"],
            m.DailyStatus.day >= start,
            m.DailyStatus.day <= end,
        )
    )
    return list(rows)


@router.put("/status/me", response_model=schemas.DailyStatusRead)
def set_status(
    data: schemas.DailyStatusDeclare,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Déclare (ou met à jour) mon statut de présence pour une journée."""
    row = db.scalar(
        select(m.DailyStatus).where(
            m.DailyStatus.user_id == user["id"],
            m.DailyStatus.day == data.day,
        )
    )
    if row is None:
        row = m.DailyStatus(user_id=user["id"], day=data.day, status=data.status)
        db.add(row)
    else:
        row.status = data.status
    db.commit()
    db.refresh(row)
    return row


@router.get("/presence", response_model=list[schemas.PresenceEntry])
def presence(
    day: date = Query(default_factory=date.today, alias="date"),
    db: Session = Depends(get_db),
    _=Depends(get_current_user),
):
    """Qui est présent au bureau pour une date donnée (défaut : aujourd'hui)."""
    return [
        schemas.PresenceEntry(
            user_name=r.user.display_name,
            department=r.user.department,
            desk_name=r.desk.name,
            slot=r.slot,
        )
        for r in svc.presence(db, day)
    ]
