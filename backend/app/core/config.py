"""Configuration centralisée de l'application.

Toutes les valeurs sensibles sont lues depuis les variables d'environnement
(fichier `.env` en dev, Azure Key Vault en prod). Rien de secret n'est codé en dur.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Chemin absolu du .env (dans backend/) — chargé quel que soit le dossier de lancement.
_ENV_FILE = Path(__file__).resolve().parent.parent.parent / ".env"


class Settings(BaseSettings):
    # Charge automatiquement le fichier `.env` s'il existe.
    model_config = SettingsConfigDict(env_file=str(_ENV_FILE), env_file_encoding="utf-8", extra="ignore")

    # --- Application ---
    APP_NAME: str = "Coworking Booking"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    # --- Sécurité ---
    # ⚠️ Doit impérativement être surchargée en production.
    SECRET_KEY: str = "dev-insecure-change-me"
    SESSION_COOKIE_NAME: str = "cw_session"

    # --- Base de données ---
    DATABASE_URL: str = "sqlite:///./coworking.db"

    # --- Microsoft Entra ID (SSO) ---
    ENTRA_TENANT_ID: str = ""
    ENTRA_CLIENT_ID: str = ""
    ENTRA_CLIENT_SECRET: str = ""
    ENTRA_REDIRECT_URI: str = "http://localhost:8000/auth/callback"

    # --- CORS ---
    FRONTEND_ORIGIN: str = "http://localhost:5173"

    # --- Intranet WordPress (lecture des contenus : événements, actus…) ---
    WORDPRESS_URL: str = "https://weared.team"
    # Secret partagé avec l'endpoint d'auth WordPress (doit être identique à EYED_APP_SECRET).
    # Vide = connexion WordPress désactivée (on reste en mode démo).
    WP_APP_SECRET: str = ""

    # --- Administrateurs de l'application (liste blanche, PAS le rôle WordPress) ---
    # Emails séparés par des virgules. Seules ces personnes ont accès à l'onglet Administration,
    # peu importe leur rôle sur l'intranet WordPress (un admin WordPress n'est pas forcément
    # admin de l'app EyeD Together — accès volontairement restreint).
    ADMIN_EMAILS: str = "t.pirard@eyedpharma.com,o.vanbrabant@eyedpharma.com"

    @property
    def admin_emails(self) -> set[str]:
        return {e.strip().lower() for e in self.ADMIN_EMAILS.split(",") if e.strip()}

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"


# Instance unique importée partout dans l'app.
settings = Settings()
