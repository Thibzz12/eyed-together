"""Schémas Pydantic : contrats de données entrants/sortants de l'API.

Rôle : valider automatiquement ce qui entre, et formater proprement ce qui sort.
(Séparés des modèles ORM pour ne jamais exposer la base telle quelle.)
"""

from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.db.models import EventRegistrationStatus, ReservationSlot, ReservationStatus
from app.services.badges import DEFAULT_BADGE_POINTS


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
    # Réservation prise d'un bloc (table ou salle entière) : la liste « Mes
    # réservations » regroupe alors les places en une seule entrée au lieu d'en
    # afficher une par siège.
    is_group_booking: bool = False
    # Nom affichable de l'occupant, quelle que soit sa nature : un collègue est
    # stocké par son identifiant, une personne extérieure par son nom libre.
    occupant: str | None = Field(default=None, validation_alias="occupant_display")
    occupant_company: str | None = None
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


# ---------------------------------------------------------------- Disponibilités
class DeskAvailability(BaseModel):
    """État d'un poste pour une date + un créneau donnés."""
    desk: DeskRead
    is_available: bool
    booked_by: str | None = None    # qui a fait la réservation
    # Qui s'installe réellement : diffère du réservant sur une table réservée d'un
    # bloc, où chaque place peut revenir à quelqu'un d'autre. None = place gardée libre.
    occupied_by: str | None = None
    # Fermée par l'administration à CETTE date (bureau cassé, salle en travaux).
    # Différent de `is_available` : personne ne l'occupe, elle n'est pas proposable.
    unavailable: bool = False


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


# ---------------------------------------------------------------- Indisponibilités
class UnavailabilityCreate(BaseModel):
    """Ferme une place (« T1-3 ») ou un espace (« Bureau 2 », « T1 », « BC-1 »).

    Sans dates, la fermeture vaut jusqu'à ce qu'on la retire. Les deux bornes
    sont incluses.
    """
    scope: Literal["desk", "space"]
    target: str
    since: date | None = None
    until: date | None = None
    reason: str | None = None


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


class CustomStatusUpdate(BaseModel):
    label: str | None = None
    color: str | None = None


class ReservationPolicyUpdate(BaseModel):
    advance_days: int = Field(ge=1, le=30)


# ---------------------------------------------------------------- Badges (administration)
class BadgeCreate(BaseModel):
    name: str
    description: str = ""
    icon: str = "🏅"
    points: int = Field(default=DEFAULT_BADGE_POINTS, ge=0, le=1000)


class BadgeUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    points: int | None = Field(default=None, ge=0, le=1000)


class BadgeAwardCreate(BaseModel):
    user_id: int


# ---------------------------------------------------------------- Anniversaires (administration)
class AdminBirthdayUpdate(BaseModel):
    birthday: date | None = None


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
    model_config = ConfigDict(from_attributes=True)


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


# ---------------------------------------------------------------- Présence dans les locaux
class VisitorCreate(BaseModel):
    """Déclaration d'un visiteur externe par le collègue qui l'accompagne."""
    full_name: str = Field(min_length=1, max_length=120)
    company: str | None = Field(default=None, max_length=120)


class VisitorRead(BaseModel):
    id: int
    full_name: str
    company: str | None = None
    host_user_id: int
    host_name: str | None = None

    model_config = ConfigDict(from_attributes=True)


class AttendanceSettingsUpdate(BaseModel):
    """Heure à laquelle les présences oubliées sont clôturées d'office."""
    auto_close_hour: int = Field(ge=0, le=23)


# ---------------------------------------------------------------- Réservation d'un groupe (table ou salle)
class OccupantIn(BaseModel):
    """Qui s'installe sur une place d'un espace réservé d'un bloc.

    Soit un collègue (`user_id`), soit une personne extérieure (`name`, `company`).
    """
    desk_id: int
    user_id: int | None = None
    name: str | None = Field(default=None, max_length=120)
    company: str | None = Field(default=None, max_length=120)


class GroupBookingCreate(BaseModel):
    ref: str = Field(min_length=1, max_length=60)   # "Bureau 1", "T1"…
    reservation_date: date
    slot: Literal["AM", "PM", "DAY"]
    occupants: list[OccupantIn] = Field(default_factory=list)


class BookingToggleUpdate(BaseModel):
    mode: Literal["seat", "table", "room", "pod"]
    enabled: bool


class SpaceEnabledUpdate(BaseModel):
    ref: str = Field(min_length=1, max_length=60)
    enabled: bool


class FeatureIconRule(BaseModel):
    keyword: str = Field(min_length=1, max_length=60)
    icon: str = Field(min_length=1, max_length=8)


class FeatureIconsUpdate(BaseModel):
    rules: list[FeatureIconRule]
