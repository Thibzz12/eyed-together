"""Endpoints REST du cœur métier (préfixe /api).

Toutes les routes exigent une session valide (get_current_user).
"""


from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import schemas
from app.db import models as m
from app.db.session import get_db
from app.deps import get_current_user, require_admin
from app.services import events as events_svc
from app.services import ideas as ideas_svc
from app.services import media as media_svc
from app.services import quiz as quiz_svc
from app.services import reservations as svc
from app.services.search import search_all
from app.services.dashboard import (
    ALL_STATUSES,
    build_dashboard,
    get_enabled_statuses,
    get_setting,
    set_enabled_statuses,
    set_setting,
)
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


@router.post("/reservations/{reservation_id}/checkin", response_model=schemas.ReservationRead)
def checkin_reservation(
    reservation_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Confirme ma présence sur une réservation du jour (évite la pénalité no-show)."""
    return svc.check_in(db, user["id"], reservation_id)


def _enrich_event(db: Session, ev: dict, user_id: int) -> dict:
    """Ajoute capacité, nb d'inscrits et mon statut à un événement WordPress."""
    reg = events_svc.my_registration(db, user_id, ev["id"])
    return {
        **ev,
        "capacity": events_svc.get_capacity(db, ev["id"]),
        "registered_count": events_svc.registered_count(db, ev["id"]),
        "my_status": reg.status.value if reg and reg.status != m.EventRegistrationStatus.CANCELLED else None,
    }


@router.get("/events", response_model=list[schemas.EventRead])
def events(
    limit: int = Query(6, ge=1, le=30),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Événements lus en direct depuis l'intranet WordPress (weared.team)."""
    return [_enrich_event(db, ev, user["id"]) for ev in fetch_events(limit=limit)]


@router.get("/events/{event_id}", response_model=schemas.EventDetail)
def event_detail(event_id: int, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Contenu complet d'un événement, pour l'afficher dans l'app."""
    d = fetch_event_detail(event_id)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Événement introuvable.")
    return _enrich_event(db, d, user["id"])


@router.get("/events/mine", response_model=list[schemas.EventRegistrationRead])
def my_event_registrations(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Mes inscriptions actives (inscrit ou en liste d'attente), tous événements confondus."""
    return [
        schemas.EventRegistrationRead(wp_event_id=r.wp_event_id, status=r.status)
        for r in events_svc.my_active_registrations(db, user["id"])
    ]


@router.post("/events/{event_id}/register", response_model=schemas.EventRegistrationRead)
def register_event(event_id: int, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """S'inscrit à un événement (ou rejoint la liste d'attente si la capacité est atteinte)."""
    row = events_svc.register(db, user["id"], event_id)
    return schemas.EventRegistrationRead(wp_event_id=row.wp_event_id, status=row.status)


@router.delete("/events/{event_id}/register", status_code=status.HTTP_204_NO_CONTENT)
def unregister_event(event_id: int, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Annule mon inscription (promeut automatiquement le 1er de la liste d'attente)."""
    events_svc.unregister(db, user["id"], event_id)


@router.get("/events/{event_id}/ics")
def event_ics(event_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Fichier .ics à télécharger ('ajouter au calendrier')."""
    d = fetch_event_detail(event_id)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Événement introuvable.")
    ics = events_svc.build_ics(d["title"], d["date"], d["link"])
    return Response(
        content=ics, media_type="text/calendar",
        headers={"Content-Disposition": f'attachment; filename="evenement-{event_id}.ics"'},
    )


@router.get("/admin/events/{event_id}/registrations")
def admin_event_registrations(event_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    """Liste des inscrits (et de la liste d'attente) pour un événement, pour l'administration."""
    return [
        {"user_name": r.user.display_name, "status": r.status.value}
        for r in events_svc.list_registrations(db, event_id)
    ]


@router.get("/admin/events/{event_id}/capacity")
def admin_event_capacity_get(event_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    """Capacité configurée + nb d'inscrits pour un événement (administration)."""
    return {"capacity": events_svc.get_capacity(db, event_id), "registered_count": events_svc.registered_count(db, event_id)}


@router.put("/admin/events/{event_id}/capacity")
def admin_event_capacity_set(
    event_id: int, data: schemas.EventCapacityUpdate, db: Session = Depends(get_db), _=Depends(require_admin),
):
    """Définit (ou retire, si null) la capacité maximale d'un événement."""
    events_svc.set_capacity(db, event_id, data.capacity)
    return {"ok": True}


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
    # Applique les pénalités no-show en retard avant de construire le tableau de bord
    # (pas de scheduler pour un MVP : on le fait à la volée, au premier chargement de la page).
    svc.apply_noshow_penalties(db, user["id"])
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


@router.get("/statuses")
def statuses(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Statuts de présence proposés aux employés (configurés par l'admin)."""
    return {"enabled": get_enabled_statuses(db)}


@router.get("/admin/statuses")
def admin_statuses(db: Session = Depends(get_db), _=Depends(require_admin)):
    """Tous les statuts possibles + ceux actuellement activés."""
    return {"all": ALL_STATUSES, "enabled": get_enabled_statuses(db)}


@router.put("/admin/statuses")
def admin_statuses_save(data: schemas.StatusesUpdate, db: Session = Depends(get_db), _=Depends(require_admin)):
    """Active/désactive les statuts proposés aux employés."""
    set_enabled_statuses(db, data.enabled)
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


@router.get("/links", response_model=list[schemas.UsefulLinkRead])
def list_links(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Liens utiles actifs, dans l'ordre défini par l'admin."""
    return list(
        db.scalars(
            select(m.UsefulLink).where(m.UsefulLink.enabled.is_(True)).order_by(m.UsefulLink.position)
        )
    )


@router.get("/admin/links", response_model=list[schemas.UsefulLinkRead])
def admin_list_links(db: Session = Depends(get_db), _=Depends(require_admin)):
    """Tous les liens (actifs et désactivés), pour la gestion."""
    return list(db.scalars(select(m.UsefulLink).order_by(m.UsefulLink.position)))


@router.post("/admin/links", response_model=schemas.UsefulLinkRead, status_code=status.HTTP_201_CREATED)
def admin_create_link(data: schemas.UsefulLinkCreate, db: Session = Depends(get_db), _=Depends(require_admin)):
    next_pos = db.scalar(select(func.max(m.UsefulLink.position))) or 0
    link = m.UsefulLink(label=data.label, url=data.url, icon=data.icon, position=next_pos + 1)
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


@router.patch("/admin/links/{link_id}", response_model=schemas.UsefulLinkRead)
def admin_update_link(link_id: int, data: schemas.UsefulLinkUpdate, db: Session = Depends(get_db), _=Depends(require_admin)):
    link = db.get(m.UsefulLink, link_id)
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lien introuvable.")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(link, field, value)
    db.commit()
    db.refresh(link)
    return link


@router.delete("/admin/links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_link(link_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    link = db.get(m.UsefulLink, link_id)
    if link is not None:
        db.delete(link)
        db.commit()


@router.get("/media")
def list_media(db: Session = Depends(get_db), _=Depends(get_current_user)):
    return media_svc.list_published(db)


@router.get("/media/{media_id}")
def get_media(media_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    return media_svc.get_published(db, media_id)


@router.get("/media/{media_id}/comments")
def media_comments(media_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    return media_svc.list_comments(db, media_id)


@router.post("/media/{media_id}/comments", status_code=status.HTTP_201_CREATED)
def add_media_comment(
    media_id: int, data: schemas.CommentCreate, db: Session = Depends(get_db), user: dict = Depends(get_current_user),
):
    return media_svc.add_comment(db, user["id"], media_id, data.content)


@router.get("/admin/media")
def admin_list_media(db: Session = Depends(get_db), _=Depends(require_admin)):
    return media_svc.admin_list(db)


@router.post("/admin/media", status_code=status.HTTP_201_CREATED)
def admin_create_media(data: schemas.MediaCreate, db: Session = Depends(get_db), _=Depends(require_admin)):
    item = media_svc.create(
        db, data.type, data.title, data.description, data.url, data.comments_enabled, data.publish_at
    )
    return {"id": item.id}


@router.delete("/admin/media/{media_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_media(media_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    media_svc.delete(db, media_id)


@router.get("/quizzes")
def list_quizzes(db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Quiz publiés, avec mon statut de passation."""
    return quiz_svc.list_published_quizzes(db, user["id"])


@router.get("/quizzes/{quiz_id}")
def get_quiz(quiz_id: int, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Le quiz à passer, ou la correction si déjà passé."""
    return quiz_svc.get_quiz_for_attempt(db, quiz_id, user["id"])


@router.post("/quizzes/{quiz_id}/attempt")
def attempt_quiz(
    quiz_id: int, data: schemas.AttemptSubmit, db: Session = Depends(get_db), user: dict = Depends(get_current_user),
):
    """Soumet mes réponses : correction automatique immédiate."""
    attempt = quiz_svc.submit_attempt(db, quiz_id, user["id"], data.answers)
    return {"score": attempt.score, "total": attempt.total}


@router.get("/quizzes/{quiz_id}/leaderboard")
def quiz_leaderboard(quiz_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    return quiz_svc.leaderboard(db, quiz_id)


@router.get("/admin/quizzes")
def admin_list_quizzes(db: Session = Depends(get_db), _=Depends(require_admin)):
    return quiz_svc.admin_list_quizzes(db)


@router.post("/admin/quizzes", status_code=status.HTTP_201_CREATED)
def admin_create_quiz(data: schemas.QuizCreate, db: Session = Depends(get_db), _=Depends(require_admin)):
    quiz = quiz_svc.create_quiz(db, data.title, data.description, data.publish_at)
    return {"id": quiz.id}


@router.delete("/admin/quizzes/{quiz_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_quiz(quiz_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    quiz_svc.delete_quiz(db, quiz_id)


@router.post("/admin/quizzes/{quiz_id}/questions", status_code=status.HTTP_201_CREATED)
def admin_add_question(
    quiz_id: int, data: schemas.QuestionCreate, db: Session = Depends(get_db), _=Depends(require_admin),
):
    q = quiz_svc.add_question(db, quiz_id, data.text, data.type, [c.model_dump() for c in data.choices])
    return {"id": q.id}


@router.delete("/admin/quizzes/questions/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_question(question_id: int, db: Session = Depends(get_db), _=Depends(require_admin)):
    quiz_svc.delete_question(db, question_id)


@router.get("/search")
def search(q: str = Query("", min_length=0), db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Recherche globale : collaborateurs, événements, actualités, idées, liens utiles."""
    return search_all(db, q)


@router.get("/ideas")
def list_ideas(category: str | None = None, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Idées classées par popularité (nb de votes)."""
    return ideas_svc.list_ideas(db, user["id"], category)


@router.post("/ideas", status_code=status.HTTP_201_CREATED)
def create_idea(data: schemas.IdeaCreate, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Soumet une nouvelle idée (signée ou anonyme)."""
    idea = ideas_svc.create_idea(db, user["id"], data.title, data.description, data.category, data.is_anonymous)
    return ideas_svc.to_dict(db, idea, user["id"])


@router.post("/ideas/{idea_id}/vote")
def vote_idea(idea_id: int, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    """Vote pour une idée, ou retire son vote si déjà voté (bascule)."""
    voted = ideas_svc.toggle_vote(db, user["id"], idea_id)
    return {"voted": voted}


@router.get("/ideas/{idea_id}/comments")
def idea_comments(idea_id: int, db: Session = Depends(get_db), _=Depends(get_current_user)):
    return ideas_svc.list_comments(db, idea_id)


@router.post("/ideas/{idea_id}/comments", status_code=status.HTTP_201_CREATED)
def add_idea_comment(
    idea_id: int, data: schemas.CommentCreate, db: Session = Depends(get_db), user: dict = Depends(get_current_user),
):
    return ideas_svc.add_comment(db, user["id"], idea_id, data.content)


@router.put("/admin/ideas/{idea_id}/status")
def admin_set_idea_status(
    idea_id: int, data: schemas.IdeaStatusUpdate, db: Session = Depends(get_db), _=Depends(require_admin),
):
    """Fait avancer le workflow d'une idée (nouvelle → étudiée → acceptée/refusée/archivée)."""
    ideas_svc.set_status(db, idea_id, data.status)
    return {"ok": True}


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
