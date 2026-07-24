"""Logique métier de la bibliothèque Médias (toujours des liens externes, jamais d'upload)."""

import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.db import models as m

_YOUTUBE_RE = re.compile(
    r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([\w-]{11})"
)


class MediaError(Exception):
    status_code = 400


class MediaNotFound(MediaError):
    status_code = 404


class CommentsDisabled(MediaError):
    status_code = 403


def _is_published(item: m.MediaItem) -> bool:
    return item.publish_at is None or item.publish_at <= datetime.now(timezone.utc)


def youtube_embed_url(url: str) -> str | None:
    """Renvoie l'URL d'embed si le lien est une vidéo YouTube, sinon None (lien externe simple)."""
    match = _YOUTUBE_RE.search(url or "")
    return f"https://www.youtube.com/embed/{match.group(1)}" if match else None


def _to_dict(item: m.MediaItem) -> dict:
    return {
        "id": item.id, "type": item.type.value, "title": item.title, "description": item.description,
        "url": item.url, "embed_url": youtube_embed_url(item.url), "comments_enabled": item.comments_enabled,
    }


def list_published(db: Session) -> list[dict]:
    items = db.scalars(select(m.MediaItem).order_by(m.MediaItem.created_at.desc()))
    return [_to_dict(i) for i in items if _is_published(i)]


def get_published(db: Session, media_id: int) -> dict:
    item = db.get(m.MediaItem, media_id)
    if item is None or not _is_published(item):
        raise MediaNotFound("Média introuvable.")
    return _to_dict(item)


def list_comments(db: Session, media_id: int) -> list[dict]:
    rows = db.scalars(
        select(m.MediaComment).where(m.MediaComment.media_id == media_id)
        .order_by(m.MediaComment.created_at).options(joinedload(m.MediaComment.author))
    )
    return [{"id": c.id, "author_name": c.author.display_name, "content": c.content} for c in rows]


def add_comment(db: Session, user_id: int, media_id: int, content: str) -> dict:
    item = db.get(m.MediaItem, media_id)
    if item is None:
        raise MediaNotFound("Média introuvable.")
    if not item.comments_enabled:
        raise CommentsDisabled("Les commentaires sont désactivés pour ce média.")
    comment = m.MediaComment(media_id=media_id, author_id=user_id, content=content.strip())
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return {"id": comment.id, "author_name": comment.author.display_name, "content": comment.content}


# --------------------------------------------------------------------------
#  Administration
# --------------------------------------------------------------------------
def admin_list(db: Session) -> list[dict]:
    items = db.scalars(select(m.MediaItem).order_by(m.MediaItem.created_at.desc()))
    return [
        {
            **_to_dict(i),
            "publish_at": i.publish_at.isoformat() if i.publish_at else None,
        }
        for i in items
    ]


def create(
    db: Session, media_type: str, title: str, description: str | None, url: str,
    comments_enabled: bool, publish_at: datetime | None,
) -> m.MediaItem:
    item = m.MediaItem(
        type=m.MediaType(media_type), title=title, description=description, url=url,
        comments_enabled=comments_enabled, publish_at=publish_at,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def delete(db: Session, media_id: int) -> None:
    item = db.get(m.MediaItem, media_id)
    if item is not None:
        db.delete(item)
        db.commit()
