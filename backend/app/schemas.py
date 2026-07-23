"""Schémas Pydantic : contrats de données entrants/sortants de l'API.

Rôle : valider automatiquement ce qui entre, et formater proprement ce qui sort.
(Séparés des modèles ORM pour ne jamais exposer la base telle quelle.)
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.db.models import EventRegistrationStatus, ReservationSlot, ReservationStatus, WorkStatus


# ---------------------------------------------------------------- Profil utilisateur
class UserProfile(BaseModel):
    id: int
    name: str
    email: str
    department: str | None = None
    role: str
    total_points: int
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- Desks
class DeskRead(BaseModel):
    id: int
    name: str
    zone: str | None = None
    floor: str | None = None
    features: str | None = None
    pos_x: float | None = None   # position sur le plan (%)
    pos_y: float | None = None
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- Réservations
class ReservationCreate(BaseModel):
    """Données envoyées par le frontend pour réserver (AM, PM ou DAY=journée)."""
    desk_id: int
    reservation_date: date
    slot: Literal["AM", "PM", "DAY"]


class ReservationRead(BaseModel):
    id: int
    reservation_date: date
    slot: ReservationSlot
    status: ReservationStatus
    checked_in_at: datetime | None = None
    desk: DeskRead
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- Disponibilités
class DeskAvailability(BaseModel):
    """État d'un poste pour une date + un créneau donnés."""
    desk: DeskRead
    is_available: bool
    booked_by: str | None = None   # nom de la personne si le poste est pris


# ---------------------------------------------------------------- Postes (administration)
class DeskAdminRead(BaseModel):
    id: int
    name: str
    zone: str | None = None
    floor: str | None = None
    features: str | None = None
    is_active: bool
    pos_x: float | None = None
    pos_y: float | None = None
    model_config = ConfigDict(from_attributes=True)


class DeskCreate(BaseModel):
    name: str
    zone: str | None = None
    features: str | None = None
    pos_x: float | None = None
    pos_y: float | None = None


class DeskUpdate(BaseModel):
    name: str | None = None
    zone: str | None = None
    features: str | None = None
    is_active: bool | None = None
    pos_x: float | None = None
    pos_y: float | None = None


# ---------------------------------------------------------------- Accueil (administration)
class DashboardCardUpdate(BaseModel):
    id: int
    enabled: bool = True
    highlighted: bool = False


class ProjectProgress(BaseModel):
    value: int
    label: str


class StatusesUpdate(BaseModel):
    enabled: list[str]


# ---------------------------------------------------------------- Statut de présence (déclaration)
class DailyStatusRead(BaseModel):
    day: date
    status: WorkStatus
    model_config = ConfigDict(from_attributes=True)


class DailyStatusDeclare(BaseModel):
    day: date
    status: WorkStatus


# ---------------------------------------------------------------- Événements (lus depuis WordPress)
class EventRead(BaseModel):
    id: int
    title: str
    date: str           # date ISO (publication)
    link: str           # lien vers la page de l'intranet
    capacity: int | None = None
    registered_count: int = 0
    my_status: str | None = None   # "registered" | "waitlisted" | None


class EventRegistrationRead(BaseModel):
    wp_event_id: int
    status: EventRegistrationStatus


class EventCapacityUpdate(BaseModel):
    capacity: int | None = None


class EventDetail(BaseModel):
    id: int
    title: str
    date: str
    link: str
    image: str | None = None     # image à la une
    content_html: str            # contenu complet (nettoyé) affiché DANS l'app
    capacity: int | None = None
    registered_count: int = 0
    my_status: str | None = None


# ---------------------------------------------------------------- Liens utiles
class UsefulLinkRead(BaseModel):
    id: int
    label: str
    url: str
    icon: str | None = None
    enabled: bool = True
    model_config = ConfigDict(from_attributes=True)


class UsefulLinkCreate(BaseModel):
    label: str
    url: str
    icon: str | None = None


class UsefulLinkUpdate(BaseModel):
    label: str | None = None
    url: str | None = None
    icon: str | None = None
    enabled: bool | None = None


# ---------------------------------------------------------------- Boîte à idées
class IdeaCreate(BaseModel):
    title: str
    description: str
    category: str | None = None
    is_anonymous: bool = False


class CommentCreate(BaseModel):
    content: str


class IdeaStatusUpdate(BaseModel):
    status: str


# ---------------------------------------------------------------- Présence (gamification)
class PresenceEntry(BaseModel):
    """Qui est présent (a réservé) pour une date donnée."""
    user_name: str
    department: str | None = None
    desk_name: str
    slot: ReservationSlot
