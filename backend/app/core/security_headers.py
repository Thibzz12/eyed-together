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
    # jamais de fichier hébergé par l'app — cf. décision de Thibaud), et de nos propres
    # pages : l'administration affiche l'écran du plan du jour en aperçu dans un cadre.
    "frame-src 'self' https://www.youtube.com; "
    "frame-ancestors 'none'"
)
# La page de l'écran est la seule qu'on accepte de voir encadrée, et seulement par
# nous-mêmes (aperçu en direct dans l'administration). Partout ailleurs, aucun cadre.
_CSP_ECRAN = _CSP_HTML.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
_CSP_JSON = "default-src 'none'; frame-ancestors 'none'"  # l'API ne renvoie que du JSON : tout est interdit


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Ajoute les en-têtes de sécurité recommandés à chaque réponse."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        # Pages des appareils partagés (écran du couloir, tablette de l'entrée) :
        # ouvertes une fois et laissées tourner, elles doivent toujours revalider
        # leur HTML pour prendre une nouvelle version de leur script.
        est_appareil = request.url.path.startswith(("/ecran/", "/pointage/"))
        est_ecran = request.url.path.startswith("/ecran/")
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN" if est_ecran else "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
        content_type = response.headers.get("content-type", "")
        if content_type.startswith("text/html"):
            response.headers["Content-Security-Policy"] = _CSP_ECRAN if est_ecran else _CSP_HTML
        else:
            response.headers["Content-Security-Policy"] = _CSP_JSON
        # HSTS : uniquement en prod (HTTPS), jamais en dev (HTTP local).
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        # La page HTML référence app.js/styles.css avec un paramètre de version (?v=N) :
        # elle doit donc TOUJOURS être revalidée, en dev comme en prod. Sans ça, un
        # navigateur qui met en cache l'index.html de façon heuristique peut continuer à
        # charger une ancienne version des fichiers statiques sans jamais s'en rendre
        # compte — jusqu'à un rechargement manuel qui force la revalidation.
        if request.url.path == "/" or est_appareil:
            response.headers["Cache-Control"] = "no-cache"
        # En dev en plus, empêche aussi le cache des fichiers statiques (itération rapide).
        elif not settings.is_production and request.url.path.startswith("/static"):
            response.headers["Cache-Control"] = "no-store"
        return response
