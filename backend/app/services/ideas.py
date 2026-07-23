"""Logique métier de la Boîte à idées (soumission, votes, commentaires, workflow)."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.db import models as m


class IdeaError(Exception):
    status_code = 400


class IdeaNotFound(IdeaError):
    status_code = 404


def _vote_count(db: Session, idea_id: int) -> int:
    return db.scalar(select(func.count()).select_from(m.IdeaVote).where(m.IdeaVote.idea_id == idea_id)) or 0


def _comment_count(db: Session, idea_id: int) -> int:
    return db.scalar(select(func.count()).select_from(m.IdeaComment).where(m.IdeaComment.idea_id == idea_id)) or 0


def _has_voted(db: Session, idea_id: int, user_id: int) -> bool:
    return db.scalar(
        select(m.IdeaVote).where(m.IdeaVote.idea_id == idea_id, m.IdeaVote.user_id == user_id)
    ) is not None


def to_dict(db: Session, idea: m.Idea, user_id: int) -> dict:
    return {
        "id": idea.id,
        "title": idea.title,
        "description": idea.description,
        "category": idea.category,
        "is_anonymous": idea.is_anonymous,
        "author_name": None if idea.is_anonymous else idea.author.display_name,
        "status": idea.status.value,
        "created_at": idea.created_at.isoformat(),
        "vote_count": _vote_count(db, idea.id),
        "comment_count": _comment_count(db, idea.id),
        "my_vote": _has_voted(db, idea.id, user_id),
        "is_mine": idea.author_id == user_id,
    }


def list_ideas(db: Session, user_id: int, category: str | None = None) -> list[dict]:
    """Classées par popularité (nb de votes) puis par date, catégorie optionnelle."""
    query = select(m.Idea).where(m.Idea.status != m.IdeaStatus.ARCHIVED).options(joinedload(m.Idea.author))
    if category:
        query = query.where(m.Idea.category == category)
    ideas = list(db.scalars(query))
    items = [to_dict(db, i, user_id) for i in ideas]
    items.sort(key=lambda d: (d["vote_count"], d["created_at"]), reverse=True)
    return items


def create_idea(db: Session, user_id: int, title: str, description: str, category: str | None, is_anonymous: bool) -> m.Idea:
    idea = m.Idea(
        author_id=user_id, title=title.strip(), description=description.strip(),
        category=(category or "").strip() or None, is_anonymous=is_anonymous,
    )
    db.add(idea)
    db.commit()
    db.refresh(idea)
    return idea


def toggle_vote(db: Session, user_id: int, idea_id: int) -> bool:
    """Vote ou retire son vote (1 vote max par personne et par idée). Renvoie l'état après bascule."""
    idea = db.get(m.Idea, idea_id)
    if idea is None:
        raise IdeaNotFound("Idée introuvable.")
    existing = db.scalar(
        select(m.IdeaVote).where(m.IdeaVote.idea_id == idea_id, m.IdeaVote.user_id == user_id)
    )
    if existing is not None:
        db.delete(existing)
        db.commit()
        return False
    db.add(m.IdeaVote(idea_id=idea_id, user_id=user_id))
    db.commit()
    return True


def list_comments(db: Session, idea_id: int) -> list[dict]:
    rows = db.scalars(
        select(m.IdeaComment).where(m.IdeaComment.idea_id == idea_id)
        .order_by(m.IdeaComment.created_at).options(joinedload(m.IdeaComment.author))
    )
    return [
        {"id": c.id, "author_name": c.author.display_name, "content": c.content, "created_at": c.created_at.isoformat()}
        for c in rows
    ]


def add_comment(db: Session, user_id: int, idea_id: int, content: str) -> dict:
    idea = db.get(m.Idea, idea_id)
    if idea is None:
        raise IdeaNotFound("Idée introuvable.")
    comment = m.IdeaComment(idea_id=idea_id, author_id=user_id, content=content.strip())
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return {"id": comment.id, "author_name": comment.author.display_name, "content": comment.content, "created_at": comment.created_at.isoformat()}


def set_status(db: Session, idea_id: int, status_value: str) -> None:
    idea = db.get(m.Idea, idea_id)
    if idea is None:
        raise IdeaNotFound("Idée introuvable.")
    idea.status = m.IdeaStatus(status_value)
    db.commit()
