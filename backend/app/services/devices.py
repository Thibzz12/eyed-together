"""Appareils partagés : écran du plan du jour, tablette de pointage.

Ces appareils n'ont personne pour se connecter au SSO. Chacun reçoit un lien
secret généré par l'administration, qui vaut authentification à lui seul. Le
jeton est long et aléatoire (secrets.token_urlsafe), vérifié par une recherche
exacte en base, et un lien révoqué cesse de fonctionner immédiatement.
"""

import json
import secrets
from datetime import datetime, timedelta, timezone

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.timezone import local_now, local_today
from app.db import models as m
from app.schemas import ScreenSettings
from app.services import attendance as attendance_svc
from app.services import reservations as res_svc
from app.services.settings import get_setting, set_setting

KINDS = ("screen", "kiosk")

# Personnalisation de l'écran (titre, message, couleurs, image de fond, éléments
# affichés) : un seul réglage pour tous les écrans, modifiable depuis
# l'administration sans toucher à l'appareil, avec aperçu en direct. Conservé en
# JSON dans AppSetting, comme le catalogue de statuts l'était : pas de migration
# pour ajouter un champ. L'image de fond, elle, vit dans StoredImage comme le plan.
# Les règles de validation (couleurs hexadécimales, préréglages, bornes) vivent
# dans le schéma ScreenSettings, et nulle part ailleurs.
_SCREEN_SETTINGS_KEY = "screen_settings"
SCREEN_BACKGROUND_KEY = "screen_background"
SCREEN_PRESETS = {
    "sombre": {"bg1": "#0F2836", "bg2": "#04141D", "text": "#FFFFFF", "accent": "#7EC8E3"},
    "clair": {"bg1": "#F3F6F9", "bg2": "#DCE6EE", "text": "#16232C", "accent": "#00608D"},
    "eyed": {"bg1": "#00608D", "bg2": "#4FB3D9", "text": "#FFFFFF", "accent": "#E3F3FA"},
}


def stored_image_version(db: Session, key: str) -> str | None:
    """Jeton de version d'une image en base (date du dernier envoi), None si absente.

    Ne lit que la date : la colonne `data` pèse jusqu'à 5 Mo, et cette version
    est demandée par chaque écran toutes les dix secondes.
    """
    updated_at = db.scalar(select(m.StoredImage.updated_at).where(m.StoredImage.key == key))
    return str(int(updated_at.timestamp())) if updated_at is not None else None


def background_version(db: Session) -> str | None:
    return stored_image_version(db, SCREEN_BACKGROUND_KEY)


def get_screen_settings(db: Session) -> dict:
    """Les réglages de l'écran, toujours complets et valides, plus l'état de l'image de fond."""
    raw = get_setting(db, _SCREEN_SETTINGS_KEY, "")
    try:
        settings = ScreenSettings.model_validate(json.loads(raw)).model_dump() if raw else ScreenSettings().model_dump()
    except (ValidationError, ValueError):
        settings = ScreenSettings().model_dump()
    # Dérivés, jamais stockés : l'écran sait s'il doit charger une image de fond.
    version = background_version(db)
    settings["has_background"] = version is not None
    settings["background_version"] = version
    return settings


def save_screen_settings(db: Session, data: ScreenSettings) -> dict:
    set_setting(db, _SCREEN_SETTINGS_KEY, data.model_dump_json())
    db.commit()
    return get_screen_settings(db)


def create_link(db: Session, kind: str, label: str, created_by: int | None) -> m.DeviceLink:
    if kind not in KINDS:
        raise ValueError("Type d'appareil inconnu.")
    label = (label or "").strip()
    if not label:
        raise ValueError("Donne un nom à l'appareil (ex : écran de l'entrée).")
    link = m.DeviceLink(kind=kind, label=label[:80], token=secrets.token_urlsafe(24), created_by=created_by)
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


def list_links(db: Session) -> list[m.DeviceLink]:
    return list(db.scalars(select(m.DeviceLink).order_by(m.DeviceLink.created_at.desc(), m.DeviceLink.id.desc())))


def revoke_link(db: Session, link_id: int) -> bool:
    link = db.get(m.DeviceLink, link_id)
    if link is None:
        return False
    if link.revoked_at is None:
        link.revoked_at = datetime.now(timezone.utc)
        db.commit()
    return True


# Le passage de l'appareil est noté au plus une fois par minute : les écrans
# interrogent le serveur toutes les dix secondes, écrire à chaque fois ferait
# six écritures par minute et par appareil pour une information d'affichage.
_LAST_SEEN_THROTTLE = timedelta(minutes=1)


def resolve(db: Session, token: str, kind: str) -> m.DeviceLink | None:
    """Le lien actif correspondant à ce jeton, ou None. Note le passage de l'appareil."""
    if not token or len(token) > 64:
        return None
    link = db.scalar(select(m.DeviceLink).where(m.DeviceLink.token == token, m.DeviceLink.kind == kind))
    if link is None or link.revoked_at is not None:
        return None
    maintenant = datetime.now(timezone.utc)
    dernier = link.last_seen_at.replace(tzinfo=timezone.utc) if link.last_seen_at and link.last_seen_at.tzinfo is None else link.last_seen_at
    if dernier is None or maintenant - dernier >= _LAST_SEEN_THROTTLE:
        link.last_seen_at = maintenant
        db.commit()
    return link


# ------------------------------------------------------------------
#  Tablette de pointage à l'entrée (demande d'Olivier du 02/10/2026) :
#  « il est difficile de forcer les gens à valider leur arrivée sur leur
#  ordi ». La tablette liste tout le monde, chacun tape son nom et confirme.
#  C'est la même présence que le pop-up et le bandeau : une seule table,
#  une seule liste d'évacuation, seule la source change ("kiosk").
# ------------------------------------------------------------------
def kiosk_roster(db: Session) -> dict:
    """Tout le monde, avec l'état du jour, un drapeau « attendu » (réservation
    ce jour) et le nombre de visiteurs encore présents que la personne accueille."""
    attendance_svc.close_stale(db)
    today = local_today()
    lignes = {a.user_id: a for a in db.scalars(select(m.Attendance).where(m.Attendance.day == today))}
    attendus: set[int] = set()
    for r in db.scalars(select(m.Reservation).where(
        m.Reservation.reservation_date == today, m.Reservation.status == m.ReservationStatus.BOOKED,
    )):
        attendus.add(r.occupant_user_id or r.user_id)
    visiteurs: dict[int, int] = {}
    for v in db.scalars(select(m.Visitor).where(m.Visitor.day == today, m.Visitor.left_at.is_(None))):
        visiteurs[v.host_user_id] = visiteurs.get(v.host_user_id, 0) + 1
    personnes = []
    for u in db.scalars(select(m.User).order_by(m.User.display_name)):
        a = lignes.get(u.id)
        etat = "absent" if a is None else ("present" if a.left_at is None else "left")
        personnes.append({
            "id": u.id, "name": u.display_name, "state": etat,
            "expected": u.id in attendus, "visitors_present": visiteurs.get(u.id, 0),
        })
    return {
        "date": today.isoformat(),
        "people": personnes,
        "present_count": sum(1 for p in personnes if p["state"] == "present"),
    }


def _kiosk_user(db: Session, user_id: int) -> m.User:
    u = db.get(m.User, user_id)
    if u is None:
        raise LookupError("Personne inconnue.")
    return u


def kiosk_checkin(db: Session, user_id: int) -> dict:
    u = _kiosk_user(db, user_id)
    attendance_svc.check_in(db, u.id, source="kiosk")
    return {"id": u.id, "name": u.display_name, "state": "present"}


def kiosk_checkout(db: Session, user_id: int, *, with_visitors: bool = False) -> dict:
    """Départ depuis la tablette. Comme dans l'app, l'hôte dit si ses visiteurs
    partent avec lui : sinon ils resteraient sur la liste d'évacuation jusqu'au
    balayage du soir (le bug du 01/09/2026, à ne pas réintroduire par ici)."""
    u = _kiosk_user(db, user_id)
    attendance_svc.check_out(db, u.id, with_visitors=with_visitors)
    return {"id": u.id, "name": u.display_name, "state": "left"}


def current_slot(now: datetime | None = None) -> str:
    """Le créneau que l'écran montre : le matin avant 13 h, l'après-midi ensuite."""
    now = now or local_now()
    return "AM" if now.hour < 13 else "PM"


def screen_snapshot(db: Session, slot: str | None = None) -> dict:
    """Le plan du jour tel qu'un écran d'affichage doit le montrer.

    Une place par pastille, avec son état et l'occupant. Seules les places
    positionnées sur le plan sont utiles ici ; les bulles calmes se réservent
    au quart d'heure, leur état « libre » sur une demi-journée ne dirait rien.
    """
    now = local_now()
    slot = slot if slot in ("AM", "PM") else current_slot(now)
    today = now.date()
    desks, reserved, free = [], 0, 0
    for desk, booker, occupant, fermee in res_svc.get_availability(db, today, slot):
        if desk.pos_x is None or desk.pos_y is None or desk.zone == res_svc.POD_ZONE:
            continue
        if booker is None and fermee:
            state = "off"
        elif booker is None:
            state, free = "free", free + 1
        elif occupant is None:
            state, reserved = "held", reserved + 1
        else:
            state, reserved = "occupied", reserved + 1
        desks.append({
            "id": desk.id, "name": desk.name, "zone": desk.zone,
            "pos_x": desk.pos_x, "pos_y": desk.pos_y,
            "state": state, "occupant": occupant,
        })
    return {
        "date": today.isoformat(),
        "slot": slot,
        "desks": desks,
        "stats": {"reserved": reserved, "free": free},
        "settings": get_screen_settings(db),
    }
