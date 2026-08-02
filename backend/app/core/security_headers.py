"""Middleware d'en-têtes de sécurité HTTP (couche 'forteresse')."""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.core.config import settings

# CSP : très stricte pour l'API JSON ; assouplie pour les pages HTML (la mini-page de test
# a besoin d'un peu de style/script inline). Ne dépend que de settings.WORDPRESS_URL, figé
# au démarrage — calculée une fois plutôt qu'à chaque requête HTML.
_CSP_HTML = (
    "default-src 'self'; "
    # img-src autorise les images de l'intranet WordPress (événements affichés dans l'app).
    f"img-src 'self' data: {settings.WORDPRESS_URL}; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline'; "
    # Autorise l'intégration de vidéos YouTube (module Médias : liens externes uniquement,
    # jamais de fichier hébergé par l'app — cf. décision de Thibaud).
    "frame-src https://www.youtube.com; "
    "frame-ancestors 'none'"
)
_CSP_JSON = "default-src 'none'; frame-ancestors 'none'"  # l'API ne renvoie que du JSON : tout est interdit


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Ajoute les en-têtes de sécurité recommandés à chaque réponse."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
        content_type = response.headers.get("content-type", "")
        response.headers["Content-Security-Policy"] = _CSP_HTML if content_type.startswith("text/html") else _CSP_JSON
        # HSTS : uniquement en prod (HTTPS), jamais en dev (HTTP local).
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        # En dev, empêche le cache des fichiers statiques + de la page (rechargement immédiat).
        elif request.url.path.startswith("/static") or request.url.path == "/":
            response.headers["Cache-Control"] = "no-store"
        return response
