"""Schémas Pydantic : contrats de données entrants/sortants de l'API.

Rôle : valider automatiquement ce qui entre, et formater proprement ce qui sort.
(Séparés des modèles ORM pour ne jamais exposer la base telle quelle.)
"""

from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.db.models import EventRegistrationStatus, ReservationSlot, ReservationStatus


# ---------------------------------------------------------------- Profil utilisateur
class UserProfile(BaseModel):
    id: int
    name: str
    email: str
    department: str | None = None
    role: str
    total_points: int
    birthday: date | None = None
    model_config = ConfigDict(from_attributes=True)


class BirthdayUpdate(BaseModel):
    birthday: date | None = None


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
    start_time: time | None = None   # uniquement pour slot=timeslot (bulles calmes)
    end_time: time | None = None
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


# ---------------------------------------------------------------- Réservation de salle entière
class RoomBookingCreate(BaseModel):
    zone: str                              # "Bureau 1" ou "Bureau 2"
    reservation_date: date
    slot: Literal["AM", "PM", "DAY"]


class RoomLabelUpdate(BaseModel):
    ref: str        # "Bureau 1" / "Bureau 2" / "BC-1" / "BC-2"
    label: str


# ---------------------------------------------------------------- Bulles calmes (créneaux 15 min)
class TimeslotBookingCreate(BaseModel):
    desk_id: int
    reservation_date: date
    start_time: time
    end_time: time


class TimeslotRead(BaseModel):
    id: int
    start_time: time
    end_time: time
    user_name: str


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
    milestone_title: str = "Nouveaux locaux"
    target_date: date | None = None


class StatusesUpdate(BaseModel):
    enabled: list[str]


# ---------------------------------------------------------------- Statut de présence (déclaration)
class DailyStatusRead(BaseModel):
    day: date
    status_am: str | None = None
    status_pm: str | None = None
    model_config = ConfigDict(from_attributes=True)


class DailyStatusDeclare(BaseModel):
    day: date
    slot: Literal["AM", "PM"]
    status: str  # clé du catalogue de statuts (admin.dashboard.get_status_catalog), pas un enum figé


class CustomStatusCreate(BaseModel):
    label: str
    color: str = "#64707A"


class ReservationPolicyUpdate(BaseModel):
    advance_days: int = Field(ge=1, le=30)


# ---------------------------------------------------------------- Événements (lus depuis WordPress)
class EventRead(BaseModel):
    id: int
    title: str
    date: str           # date réelle de l'événement (champ ACF), ou date de publication en repli
    place: str | None = None
    link: str           # lien vers la page de l'intranet
    capacity: int | None = None
    registered_count: int = 0
    my_status: str | None = None   # "registered" | "waitlisted" | None


class EventRegistrationRead(BaseModel):
    wp_event_id: int
    status: EventRegistrationStatus


class EventCapacityUpdate(BaseModel):
    capacity: int | None = None


class EventNotify(BaseModel):
    title: str
    message: str


class EventDetail(BaseModel):
    id: int
    title: str
    date: str
    place: str | None = None
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


# ---------------------------------------------------------------- Quiz
class QuizChoiceCreate(BaseModel):
    text: str
    is_correct: bool = False


class QuestionCreate(BaseModel):
    text: str
    type: str = "qcm"
    choices: list[QuizChoiceCreate]


class QuizCreate(BaseModel):
    title: str
    description: str | None = None
    publish_at: datetime | None = None
    is_survey: bool = False


class AttemptSubmit(BaseModel):
    answers: dict[int, int]   # {question_id: choice_id}


# ---------------------------------------------------------------- Médias
class MediaCreate(BaseModel):
    type: str  # "video" | "album"
    title: str
    description: str | None = None
    url: str
    comments_enabled: bool = True
    publish_at: datetime | None = None


# ---------------------------------------------------------------- Présence (gamification)
class PresenceEntry(BaseModel):
    """Qui est présent (a réservé) pour une date donnée."""
    user_name: str
    department: str | None = None
    desk_name: str
    slot: ReservationSlot
