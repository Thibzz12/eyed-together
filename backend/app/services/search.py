"""Recherche globale : agrège collaborateurs, événements, actualités, idées et liens utiles."""

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import models as m
from app.services.wordpress import search_events, search_news

MAX_PER_CATEGORY = 8


def search_all(db: Session, q: str) -> dict:
    q = (q or "").strip()
    if not q:
        return {"collaborateurs": [], "evenements": [], "actualites": [], "idees": [], "liens": []}

    like = f"%{q}%"

    users = db.scalars(
        select(m.User).where(
            or_(m.User.display_name.ilike(like), m.User.email.ilike(like))
        ).limit(MAX_PER_CATEGORY)
    )
    collaborateurs = [
        {"id": u.id, "name": u.display_name, "department": u.department} for u in users
    ]

    ideas = db.scalars(
        select(m.Idea).where(
            m.Idea.status != m.IdeaStatus.ARCHIVED,
            or_(m.Idea.title.ilike(like), m.Idea.description.ilike(like)),
        ).limit(MAX_PER_CATEGORY)
    )
    idees = [{"id": i.id, "title": i.title, "category": i.category} for i in ideas]

    links = db.scalars(
        select(m.UsefulLink).where(
            m.UsefulLink.enabled.is_(True), m.UsefulLink.label.ilike(like)
        ).limit(MAX_PER_CATEGORY)
    )
    liens = [{"id": l.id, "label": l.label, "url": l.url, "icon": l.icon} for l in links]

    return {
        "collaborateurs": collaborateurs,
        "evenements": search_events(q, limit=MAX_PER_CATEGORY),
        "actualites": search_news(q, limit=MAX_PER_CATEGORY),
        "idees": idees,
        "liens": liens,
    }
