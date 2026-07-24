"""Modèles ORM (SQLAlchemy 2.0) — la structure de la base de données.

Six entités :
  - User              : l'employé (créé à la 1re connexion SSO)
  - Desk              : un poste de coworking
  - Reservation       : une place réservée pour une demi-journée (cœur métier)
  - PointTransaction  : journal des points de gamification (append-only)
  - Badge / UserBadge : récompenses (relation N-N)
"""

import enum
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


# ------------------------------------------------------------------
#  Énumérations (stockées en VARCHAR pour la portabilité SQLite/Postgres)
# ------------------------------------------------------------------
class UserRole(str, enum.Enum):
    EMPLOYEE = "employee"
    ADMIN = "admin"


class ReservationSlot(str, enum.Enum):
    AM = "AM"   # Matin
    PM = "PM"   # Après-midi


class ReservationStatus(str, enum.Enum):
    BOOKED = "booked"
    CANCELLED = "cancelled"
    NO_SHOW = "no_show"  # réservé mais jamais confirmé présent (check-in manquant)


class WorkStatus(str, enum.Enum):
    """Statut de présence déclaré par l'employé pour une journée."""
    COWORKING = "coworking"
    TELETRAVAIL = "teletravail"
    DEPLACEMENT = "deplacement"
    CONGE = "conge"


class QuestionType(str, enum.Enum):
    """Type de question de quiz (V1 : QCM et vrai/faux — sondages/images/vidéos = V2)."""
    QCM = "qcm"           # une seule bonne réponse parmi plusieurs choix
    VRAI_FAUX = "vrai_faux"


class MediaType(str, enum.Enum):
    VIDEO = "video"
    ALBUM = "album"    # album photo (lien externe : Drive, etc.)


class IdeaStatus(str, enum.Enum):
    """Statut de traitement d'une idée (workflow piloté par l'admin)."""
    NEW = "new"
    UNDER_REVIEW = "under_review"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    ARCHIVED = "archived"


class EventRegistrationStatus(str, enum.Enum):
    """Statut d'inscription à un événement WordPress (type `evenement`)."""
    REGISTERED = "registered"
    WAITLISTED = "waitlisted"   # liste d'attente : capacité atteinte au moment de l'inscription
    CANCELLED = "cancelled"


def _enum(enum_cls: type[enum.Enum]) -> SAEnum:
    """Fabrique un type Enum stocké par sa *valeur* (ex: 'booked') et non son nom.

    `native_enum=False` => colonne VARCHAR + contrainte CHECK, identique sur tous les moteurs.
    """
    return SAEnum(
        enum_cls,
        native_enum=False,
        values_callable=lambda e: [m.value for m in e],
        length=20,
    )


# ------------------------------------------------------------------
#  User
# ------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Identifiant unique et stable fourni par Microsoft Entra ID (pas de mot de passe stocké).
    entra_oid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(255))
    department: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[UserRole] = mapped_column(_enum(UserRole), default=UserRole.EMPLOYEE, nullable=False)
    # Compteur agrégé (source de vérité = journal PointTransaction).
    total_points: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    reservations: Mapped[list["Reservation"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    point_transactions: Mapped[list["PointTransaction"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    badges: Mapped[list["UserBadge"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


# ------------------------------------------------------------------
#  Desk (poste de coworking)
# ------------------------------------------------------------------
class Desk(Base):
    __tablename__ = "desks"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)   # ex: "A-12"
    zone: Mapped[str | None] = mapped_column(String(100), nullable=True)
    floor: Mapped[str | None] = mapped_column(String(50), nullable=True)
    features: Mapped[str | None] = mapped_column(String(255), nullable=True)  # ex: "écran, zone calme"
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    pos_x: Mapped[float | None] = mapped_column(Float, nullable=True)   # position sur le plan (%)
    pos_y: Mapped[float | None] = mapped_column(Float, nullable=True)

    reservations: Mapped[list["Reservation"]] = relationship(back_populates="desk")


# ------------------------------------------------------------------
#  Reservation (cœur métier : 1 poste / 1 date / 1 demi-journée)
# ------------------------------------------------------------------
class Reservation(Base):
    __tablename__ = "reservations"
    __table_args__ = (
        # 🔒 Anti-doublon : un poste ne peut être réservé qu'une fois par (date, créneau)…
        #    …mais UNIQUEMENT pour les réservations actives. Une réservation annulée
        #    (conservée pour l'audit) ne bloque pas une nouvelle réservation du même créneau.
        #    Index partiel compatible SQLite ET PostgreSQL.
        Index(
            "uq_active_reservation",
            "desk_id",
            "reservation_date",
            "slot",
            unique=True,
            sqlite_where=text("status = 'booked'"),
            postgresql_where=text("status = 'booked'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    desk_id: Mapped[int] = mapped_column(
        ForeignKey("desks.id", ondelete="CASCADE"), index=True
    )
    reservation_date: Mapped[date] = mapped_column(Date, index=True)
    slot: Mapped[ReservationSlot] = mapped_column(_enum(ReservationSlot))
    status: Mapped[ReservationStatus] = mapped_column(
        _enum(ReservationStatus), default=ReservationStatus.BOOKED, nullable=False
    )
    # Rempli quand l'employé confirme sa présence (check-in). Sert à détecter les no-show.
    checked_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="reservations")
    desk: Mapped["Desk"] = relationship(back_populates="reservations")


# ------------------------------------------------------------------
#  PointTransaction (journal de gamification — append-only, auditable)
# ------------------------------------------------------------------
class PointTransaction(Base):
    __tablename__ = "point_transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    amount: Mapped[int] = mapped_column(Integer, nullable=False)          # +10, +5, -...
    reason: Mapped[str] = mapped_column(String(100), nullable=False)      # ex: "checkin", "full_week"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="point_transactions")


# ------------------------------------------------------------------
#  Badge / UserBadge (récompenses — relation N-N)
# ------------------------------------------------------------------
class DailyStatus(Base):
    """Statut de présence déclaré par un employé pour une journée donnée."""
    __tablename__ = "daily_status"
    __table_args__ = (
        UniqueConstraint("user_id", "day", name="uq_user_day_status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    day: Mapped[date] = mapped_column(Date, index=True)
    status: Mapped[WorkStatus] = mapped_column(_enum(WorkStatus), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DashboardCard(Base):
    """Carte de l'accueil, administrable (activation, ordre, mise en avant)."""
    __tablename__ = "dashboard_cards"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(50), unique=True)     # type de carte
    title: Mapped[str] = mapped_column(String(120))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    highlighted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class AppSetting(Base):
    """Réglages généraux clé/valeur (ex: progression du projet)."""
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


class EventRegistration(Base):
    """Inscription d'un employé à un événement WordPress (identifié par son id WP)."""
    __tablename__ = "event_registrations"
    __table_args__ = (
        UniqueConstraint("user_id", "wp_event_id", name="uq_user_event"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    wp_event_id: Mapped[int] = mapped_column(Integer, index=True)
    status: Mapped[EventRegistrationStatus] = mapped_column(
        _enum(EventRegistrationStatus), default=EventRegistrationStatus.REGISTERED, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship()


class EventCapacity(Base):
    """Capacité configurée par l'admin pour un événement WordPress (None = illimité)."""
    __tablename__ = "event_capacities"

    wp_event_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Idea(Base):
    """Idée soumise par un employé (Boîte à idées), signée ou anonyme."""
    __tablename__ = "ideas"

    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(150))
    description: Mapped[str] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(60), nullable=True)
    # L'auteur reste connu en base (modération) mais n'est jamais affiché si True.
    is_anonymous: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[IdeaStatus] = mapped_column(_enum(IdeaStatus), default=IdeaStatus.NEW, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    author: Mapped["User"] = relationship()
    votes: Mapped[list["IdeaVote"]] = relationship(back_populates="idea", cascade="all, delete-orphan")
    comments: Mapped[list["IdeaComment"]] = relationship(back_populates="idea", cascade="all, delete-orphan")


class IdeaVote(Base):
    __tablename__ = "idea_votes"
    __table_args__ = (
        UniqueConstraint("idea_id", "user_id", name="uq_idea_vote"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    idea_id: Mapped[int] = mapped_column(ForeignKey("ideas.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    idea: Mapped["Idea"] = relationship(back_populates="votes")


class IdeaComment(Base):
    __tablename__ = "idea_comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    idea_id: Mapped[int] = mapped_column(ForeignKey("ideas.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    idea: Mapped["Idea"] = relationship(back_populates="comments")
    author: Mapped["User"] = relationship()


class UsefulLink(Base):
    """Lien externe administrable (rubrique 'Liens utiles')."""
    __tablename__ = "useful_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    label: Mapped[str] = mapped_column(String(100))
    url: Mapped[str] = mapped_column(String(500))
    icon: Mapped[str | None] = mapped_column(String(50), nullable=True)   # emoji ou nom d'icône
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Quiz(Base):
    """Un quiz, planifiable dans le temps (publication programmée)."""
    __tablename__ = "quizzes"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(150))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # NULL = publié immédiatement. Dans le futur = planifié (invisible des employés jusque-là).
    publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    questions: Mapped[list["QuizQuestion"]] = relationship(
        back_populates="quiz", cascade="all, delete-orphan", order_by="QuizQuestion.position"
    )
    attempts: Mapped[list["QuizAttempt"]] = relationship(back_populates="quiz", cascade="all, delete-orphan")


class QuizQuestion(Base):
    __tablename__ = "quiz_questions"

    id: Mapped[int] = mapped_column(primary_key=True)
    quiz_id: Mapped[int] = mapped_column(ForeignKey("quizzes.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(Text)
    type: Mapped[QuestionType] = mapped_column(_enum(QuestionType), default=QuestionType.QCM, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    quiz: Mapped["Quiz"] = relationship(back_populates="questions")
    choices: Mapped[list["QuizChoice"]] = relationship(
        back_populates="question", cascade="all, delete-orphan", order_by="QuizChoice.position"
    )


class QuizChoice(Base):
    __tablename__ = "quiz_choices"

    id: Mapped[int] = mapped_column(primary_key=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("quiz_questions.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(String(255))
    is_correct: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    question: Mapped["QuizQuestion"] = relationship(back_populates="choices")


class QuizAttempt(Base):
    """Une passation de quiz par un employé (1 tentative par quiz — pas de repasse en V1)."""
    __tablename__ = "quiz_attempts"
    __table_args__ = (
        UniqueConstraint("quiz_id", "user_id", name="uq_quiz_attempt"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    quiz_id: Mapped[int] = mapped_column(ForeignKey("quizzes.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    score: Mapped[int] = mapped_column(Integer)             # nb de bonnes réponses
    total: Mapped[int] = mapped_column(Integer)              # nb total de questions
    # Détail des réponses (question_id -> choice_id choisi), pour l'affichage de la correction.
    # Stocké en JSON plutôt qu'en table séparée : suffisant pour un quiz (peu de questions),
    # évite une table de plus pour un simple historique consultatif.
    answers_json: Mapped[str] = mapped_column(Text, default="{}")
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    quiz: Mapped["Quiz"] = relationship(back_populates="attempts")
    user: Mapped["User"] = relationship()


class MediaItem(Base):
    """Élément de la bibliothèque médias — TOUJOURS un lien externe (YouTube, Drive…),
    jamais un fichier hébergé par l'app (décision de Thibaud : pas de gestion de stockage).
    """
    __tablename__ = "media_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[MediaType] = mapped_column(_enum(MediaType), nullable=False)
    title: Mapped[str] = mapped_column(String(150))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    url: Mapped[str] = mapped_column(String(500))
    comments_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # NULL = publié immédiatement. Dans le futur = planifié.
    publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    comments: Mapped[list["MediaComment"]] = relationship(back_populates="media", cascade="all, delete-orphan")


class MediaComment(Base):
    __tablename__ = "media_comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    media_id: Mapped[int] = mapped_column(ForeignKey("media_items.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    media: Mapped["MediaItem"] = relationship(back_populates="comments")
    author: Mapped["User"] = relationship()


class Notification(Base):
    """Notification in-app (V1 : pas d'email/Teams/push, cf. PROGRESS.md — pas d'infra externe
    disponible). Déclenchées automatiquement (rappel J-1 événement) ou manuellement par l'admin.
    """
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(150))
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(100), nullable=True)   # route interne, ex: "evenements"
    read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Badge(Base):
    __tablename__ = "badges"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(50), unique=True)   # ex: "early_bird"
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    icon: Mapped[str | None] = mapped_column(String(100), nullable=True)   # ex: nom d'icône / emoji

    user_badges: Mapped[list["UserBadge"]] = relationship(back_populates="badge")


class UserBadge(Base):
    __tablename__ = "user_badges"
    __table_args__ = (
        UniqueConstraint("user_id", "badge_id", name="uq_user_badge"),  # 1 badge gagné 1 seule fois
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    badge_id: Mapped[int] = mapped_column(
        ForeignKey("badges.id", ondelete="CASCADE"), index=True
    )
    earned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="badges")
    badge: Mapped["Badge"] = relationship(back_populates="user_badges")
