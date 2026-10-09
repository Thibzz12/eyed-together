"""Erreur métier commune à tous les services.

Chaque service définit ses erreurs (ReservationError, AttendanceError…) en
héritant d'AppError : un seul gestionnaire dans main.py les traduit en réponse
HTTP, avec le code porté par la classe. Avant, huit gestionnaires identiques
se succédaient, un par module.
"""


class AppError(Exception):
    """Erreur métier traduite en réponse HTTP `{"detail": message}` avec `status_code`."""

    status_code = 400
