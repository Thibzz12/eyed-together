"""Lecture des contenus de l'intranet WordPress (weared.team).

Principe : notre backend lit l'API REST de WordPress et renvoie une version
épurée au frontend. Les données restent la propriété de l'intranet (source unique) —
on ne fait que les AFFICHER, toujours à jour. On ne remplace pas l'intranet :
chaque élément renvoie vers sa page d'origine.
"""

import base64
import hashlib
import hmac
import html
import json
import re
import time

import httpx

from app.core.config import settings

# Petit cache mémoire pour ne pas solliciter l'intranet à chaque appel.
_CACHE: dict[str, tuple[float, list]] = {}
_TTL_SECONDS = 300  # 5 minutes


def _clean(text: str) -> str:
    """Retire les balises HTML et décode les entités (&amp; → &)."""
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


def _sanitize(content: str) -> str:
    """Nettoyage de sécurité du HTML avant affichage dans l'app.

    Contenu interne (rédigé par la comm EyeD) donc de confiance, mais on retire
    par précaution les éléments actifs (scripts, iframes, gestionnaires d'événements).
    """
    s = content or ""
    s = re.sub(r"<script\b[^>]*>.*?</script>", "", s, flags=re.S | re.I)
    s = re.sub(r"<iframe\b[^>]*>.*?</iframe>", "", s, flags=re.S | re.I)
    s = re.sub(r"\son\w+\s*=\s*\"[^\"]*\"", "", s, flags=re.I)
    s = re.sub(r"\son\w+\s*=\s*'[^']*'", "", s, flags=re.I)
    s = re.sub(r"(href|src)\s*=\s*([\"'])\s*javascript:[^\"']*\2", r'\1=\2#\2', s, flags=re.I)
    return s


class WordPressAuthError(Exception):
    """Erreur renvoyée par l'intranet WordPress lors de l'authentification."""


def verify_bridge_token(token: str) -> dict | None:
    """Vérifie le jeton signé renvoyé par le 'pont' WordPress (Magic Login).

    Le jeton = base64url(payload JSON) + '.' + HMAC-SHA256(payload, secret partagé).
    On vérifie la signature ET la fraîcheur (exp). Renvoie des claims ou None.
    """
    if not settings.WP_APP_SECRET or not token or "." not in token:
        return None
    b64, sig = token.rsplit(".", 1)
    expected = hmac.new(settings.WP_APP_SECRET.encode(), b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None  # signature invalide → jeton falsifié
    try:
        payload = json.loads(base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)))
    except Exception:
        return None
    if float(payload.get("exp", 0)) < time.time():
        return None  # jeton expiré
    return {
        "oid": f"wp-{payload.get('id')}",
        "preferred_username": payload.get("email") or "",
        "name": payload.get("name") or payload.get("email") or "Utilisateur",
        "roles": payload.get("roles") or [],
    }


def authenticate_wp(email: str, password: str) -> dict | None:
    """Valide un email + mot de passe auprès de l'intranet WordPress.

    Renvoie des « claims » (mêmes champs que Microsoft) si valide, sinon None.
    Le mot de passe n'est ni stocké ni journalisé : juste transmis une fois en HTTPS.
    """
    if not settings.WP_APP_SECRET:
        return None  # connexion WordPress non configurée → mode démo uniquement
    url = f"{settings.WORDPRESS_URL}/wp-json/eyed/v1/login"
    try:
        resp = httpx.post(
            url,
            json={"email": email, "password": password},
            headers={"X-App-Secret": settings.WP_APP_SECRET},
            timeout=10.0,
        )
    except Exception as exc:
        raise WordPressAuthError(f"Intranet injoignable : {exc}") from exc
    if resp.status_code != 200:
        # DEBUG : on remonte la raison exacte de WordPress.
        try:
            reason = resp.json().get("message", resp.text[:200])
        except Exception:
            reason = resp.text[:200]
        raise WordPressAuthError(f"[{resp.status_code}] {reason}")
    data = resp.json()
    return {
        "oid": f"wp-{data.get('id')}",                       # identifiant unique stable
        "preferred_username": data.get("email") or email,
        "name": data.get("display_name") or email,
        "roles": data.get("roles") or [],
    }


def fetch_news(limit: int = 4) -> list[dict]:
    """Dernières actualités (articles) de l'intranet WordPress."""
    now = time.time()
    cached = _CACHE.get("news")
    if cached and now - cached[0] < _TTL_SECONDS:
        return cached[1][:limit]
    url = f"{settings.WORDPRESS_URL}/wp-json/wp/v2/posts"
    try:
        resp = httpx.get(url, params={"per_page": 8, "orderby": "date", "order": "desc"}, timeout=8.0)
        resp.raise_for_status()
        items = resp.json()
    except Exception:
        return cached[1][:limit] if cached else []
    news = [
        {
            "id": it.get("id"),
            "title": _clean(it.get("title", {}).get("rendered", "")),
            "date": it.get("date", ""),
            "link": it.get("link", ""),
            "excerpt": _clean(it.get("excerpt", {}).get("rendered", ""))[:160],
        }
        for it in items
    ]
    _CACHE["news"] = (now, news)
    return news[:limit]


def fetch_content_detail(rest_base: str, post_id: int) -> dict | None:
    """Contenu complet d'un contenu WordPress (événement `evenement` ou actualité `posts`)."""
    url = f"{settings.WORDPRESS_URL}/wp-json/wp/v2/{rest_base}/{post_id}"
    try:
        resp = httpx.get(url, params={"_embed": 1}, timeout=8.0)
        resp.raise_for_status()
        it = resp.json()
    except Exception:
        return None
    image = None
    media = it.get("_embedded", {}).get("wp:featuredmedia")
    if isinstance(media, list) and media and isinstance(media[0], dict):
        image = media[0].get("source_url")
    return {
        "id": it.get("id"),
        "title": _clean(it.get("title", {}).get("rendered", "")),
        "date": it.get("date", ""),
        "link": it.get("link", ""),
        "image": image,
        "content_html": _sanitize(it.get("content", {}).get("rendered", "")),
    }


def fetch_event_detail(event_id: int) -> dict | None:
    return fetch_content_detail("evenement", event_id)


def fetch_events(limit: int = 6) -> list[dict]:
    """Derniers événements publiés sur l'intranet (titre, date, lien).

    En cas d'intranet injoignable, renvoie le dernier résultat connu (ou []).
    """
    now = time.time()
    cached = _CACHE.get("events")
    if cached and now - cached[0] < _TTL_SECONDS:
        return cached[1][:limit]

    url = f"{settings.WORDPRESS_URL}/wp-json/wp/v2/evenement"
    try:
        resp = httpx.get(
            url,
            params={"per_page": 10, "orderby": "date", "order": "desc"},
            timeout=8.0,
        )
        resp.raise_for_status()
        items = resp.json()
    except Exception:
        return cached[1][:limit] if cached else []

    events = [
        {
            "id": it.get("id"),
            "title": _clean(it.get("title", {}).get("rendered", "")),
            "date": it.get("date", ""),
            "link": it.get("link", ""),
        }
        for it in items
    ]
    _CACHE["events"] = (now, events)
    return events[:limit]
