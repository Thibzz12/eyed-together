"""Logique métier des réservations (indépendante du web).

Règles appliquées :
  - pas de réservation dans le passé ;
  - pas de réservation le week-end (personne ne travaille) ;
  - horizon max de réservation : MAX_ADVANCE_DAYS jours calendaires ;
  - max MAX_CONSECUTIVE_DAYS jours ouvrés consécutifs réservés par un même employé ;
  - un employé ne peut pas réserver 2 postes sur le même créneau ;
  - anti-doublon garanti par la base (index unique partiel) → capturé en 409 ;
  - on ne peut annuler que SES propres réservations (ownership) ;
  - check-in obligatoire le jour J : une réservation passée jamais confirmée devient
    un "no-show" et coûte des points (cf. apply_noshow_penalties).
"""

from datetime import date, datetime, timedelta, timezone
from datetime import time as time_type

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db import models as m
from app.schemas import ReservationCreate
from app.services.gamification import POINTS_PER_BOOKING, award_points

# Politique de réservation (cf. PROGRESS.md — validée avec Thibaud le 2026-07-23).
DEFAULT_MAX_ADVANCE_DAYS = 7  # horizon par défaut, si jamais configuré par l'admin (cf. get_booking_advance_days)
MAX_CONSECUTIVE_DAYS = 5    # max de jours ouvrés consécutifs réservés d'affilée
_ADVANCE_DAYS_KEY = "booking_advance_days"


def get_booking_advance_days(db: Session) -> int:
    """Horizon de réservation (jours calendaires à l'avance), configurable par l'admin —
    ex: 5 jours ouvre la semaine suivante dès le mercredi de la semaine en cours."""
    row = db.get(m.AppSetting, _ADVANCE_DAYS_KEY)
    if row is None:
        return DEFAULT_MAX_ADVANCE_DAYS
    try:
        return max(1, int(row.value))
    except (TypeError, ValueError):
        return DEFAULT_MAX_ADVANCE_DAYS


def set_booking_advance_days(db: Session, days: int) -> None:
    days = max(1, min(30, int(days)))
    row = db.get(m.AppSetting, _ADVANCE_DAYS_KEY)
    if row is None:
        db.add(m.AppSetting(key=_ADVANCE_DAYS_KEY, value=str(days)))
    else:
        row.value = str(days)
    db.commit()

# Réservation de salle entière (Bureau 1 / Bureau 2) : "salle occupée" dès qu'un seul
# poste actif de la zone est déjà réservé sur le créneau visé.
ROOM_ZONES = {"Bureau 1", "Bureau 2"}

# Bulles calmes : réservables par créneau libre (pas de demi-journée), en tranches de 15 min.
POD_ZONE = "Bulles calmes"

# Noms affichés des salles/bulles, modifiables par l'admin (stockés dans AppSetting —
# pas d'import de dashboard.py ici pour éviter un import circulaire, dashboard.py important
# déjà ce module).
_ROOM_LABEL_KEYS = {"Bureau 1": "room_label_bureau1", "Bureau 2": "room_label_bureau2"}
_POD_LABEL_KEYS = {"BC-1": "pod_label_bc1", "BC-2": "pod_label_bc2"}
_POD_LABEL_DEFAULTS = {"BC-1": "Bulle calme 1", "BC-2": "Bulle calme 2"}


def get_room_labels(db: Session) -> dict[str, str]:
    """Noms affichés actuels des 2 bureaux et des 2 bulles calmes (valeur par défaut si
    jamais personnalisés)."""
    labels: dict[str, str] = {}
    for zone, key in _ROOM_LABEL_KEYS.items():
        row = db.get(m.AppSetting, key)
        labels[zone] = row.value if row else zone
    for desk_name, key in _POD_LABEL_KEYS.items():
        row = db.get(m.AppSetting, key)
        labels[desk_name] = row.value if row else _POD_LABEL_DEFAULTS[desk_name]
    return labels


def set_room_label(db: Session, ref: str, label: str) -> None:
    """Renomme un bureau (ref = "Bureau 1"/"Bureau 2") ou une bulle calme (ref = "BC-1"/"BC-2")."""
    key = _ROOM_LABEL_KEYS.get(ref) or _POD_LABEL_KEYS.get(ref)
    if not key:
        raise ReservationError("Référence de salle ou de bulle inconnue.")
    label = label.strip() or ref
    row = db.get(m.AppSetting, key)
    if row is None:
        db.add(m.AppSetting(key=key, value=label))
    else:
        row.value = label
    db.commit()
TIMESLOT_STEP_MINUTES = 15
MIN_TIMESLOT_MINUTES = 15
MAX_TIMESLOT_MINUTES = 120


# --------------------------------------------------------------------------
#  Exceptions métier (mappées vers des codes HTTP dans main.py)
# --------------------------------------------------------------------------
class ReservationError(Exception):
    """Erreur métier générique."""
    status_code = 400


class DeskNotFound(ReservationError):
    status_code = 404


class ReservationNotFound(ReservationError):
    status_code = 404


class SlotConflict(ReservationError):
    status_code = 409


class AlreadyBooked(ReservationError):
    status_code = 409


class NotOwner(ReservationError):
    status_code = 403


class PastDate(ReservationError):
    status_code = 400


class WeekendNotAllowed(ReservationError):
    status_code = 400


class BookingWindowExceeded(ReservationError):
    status_code = 400


class ConsecutiveLimitExceeded(ReservationError):
    status_code = 409


def _is_weekend(day: date) -> bool:
    return day.weekday() >= 5  # 5=samedi, 6=dimanche


def _adjacent_weekday(day: date, step: int) -> date:
    """Jour ouvré suivant (step=+1) ou précédent (step=-1), en sautant les week-ends."""
    d = day + timedelta(days=step)
    while _is_weekend(d):
        d += timedelta(days=step)
    return d


def _check_booking_policy(db: Session, user_id: int, target: date) -> None:
    """Vérifie week-end, horizon max, et la limite de jours ouvrés consécutifs."""
    if _is_weekend(target):
        raise WeekendNotAllowed("Pas de réservation le week-end.")
    advance_days = get_booking_advance_days(db)
    if target > date.today() + timedelta(days=advance_days):
        raise BookingWindowExceeded(f"Impossible de réserver plus de {advance_days} jours à l'avance.")

    # Jours (ouvrés) où l'employé a déjà une réservation active, autour de la date visée.
    window_start = target - timedelta(days=MAX_CONSECUTIVE_DAYS + 2)
    window_end = target + timedelta(days=MAX_CONSECUTIVE_DAYS + 2)
    rows = db.scalars(
        select(m.Reservation.reservation_date).where(
            m.Reservation.user_id == user_id,
            m.Reservation.status == m.ReservationStatus.BOOKED,
            m.Reservation.reservation_date >= window_start,
            m.Reservation.reservation_date <= window_end,
        ).distinct()
    )
    booked_days = set(rows) | {target}

    # Longueur de la série de jours ouvrés consécutifs incluant la date visée.
    run_length = 1
    d = target
    while _adjacent_weekday(d, -1) in booked_days:
        d = _adjacent_weekday(d, -1); run_length += 1
    d = target
    while _adjacent_weekday(d, +1) in booked_days:
        d = _adjacent_weekday(d, +1); run_length += 1

    if run_length > MAX_CONSECUTIVE_DAYS:
        raise ConsecutiveLimitExceeded(
            f"Impossible de réserver plus de {MAX_CONSECUTIVE_DAYS} jours ouvrés d'affilée."
        )


# --------------------------------------------------------------------------
#  Lectures
# --------------------------------------------------------------------------
def list_desks(db: Session) -> list[m.Desk]:
    """Tous les postes actifs, triés par nom."""
    return list(db.scalars(select(m.Desk).where(m.Desk.is_active.is_(True)).order_by(m.Desk.name)))


def slots_for(slot_str: str) -> list[m.ReservationSlot]:
    """Traduit AM / PM / DAY en créneaux stockés. DAY = matin + après-midi."""
    if slot_str == "DAY":
        return [m.ReservationSlot.AM, m.ReservationSlot.PM]
    return [m.ReservationSlot(slot_str)]  # lève ValueError si invalide


def get_availability(db: Session, day: date, slot_str: str) -> list[tuple[m.Desk, str | None]]:
    """Pour une date + un créneau (AM/PM/DAY) : chaque poste avec l'occupant s'il est pris.

    En 'DAY', un poste est indisponible si le matin OU l'après-midi est déjà pris.
    """
    slots = slots_for(slot_str)
    desks = list_desks(db)
    taken: dict[int, str] = {}
    reserved = db.scalars(
        select(m.Reservation)
        .where(
            m.Reservation.reservation_date == day,
            m.Reservation.slot.in_(slots),
            m.Reservation.status == m.ReservationStatus.BOOKED,
        )
        .options(joinedload(m.Reservation.user))
    )
    for r in reserved:
        taken.setdefault(r.desk_id, r.user.display_name)
    return [(d, taken.get(d.id)) for d in desks]


def my_reservations(db: Session, user_id: int) -> list[m.Reservation]:
    """Mes réservations à venir (aujourd'hui inclus), triées."""
    return list(
        db.scalars(
            select(m.Reservation)
            .where(
                m.Reservation.user_id == user_id,
                m.Reservation.status == m.ReservationStatus.BOOKED,
                m.Reservation.reservation_date >= date.today(),
            )
            .order_by(m.Reservation.reservation_date, m.Reservation.slot)
            .options(joinedload(m.Reservation.desk))
        )
    )


def presence(db: Session, day: date) -> list[m.Reservation]:
    """Qui est présent (réservations actives) pour une date donnée.

    Une personne en réservation "Journée" a 2 lignes (AM+PM) : on ne garde que
    la 1re par (user, poste) pour ne jamais l'afficher deux fois.
    """
    rows = db.scalars(
        select(m.Reservation)
        .where(
            m.Reservation.reservation_date == day,
            m.Reservation.status == m.ReservationStatus.BOOKED,
        )
        .order_by(m.Reservation.slot)
        .options(joinedload(m.Reservation.user), joinedload(m.Reservation.desk))
    )
    seen: set[tuple[int, int]] = set()
    out = []
    for r in rows:
        key = (r.user_id, r.desk_id)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


# --------------------------------------------------------------------------
#  Écritures
# --------------------------------------------------------------------------
def create_reservation(db: Session, user_id: int, data: ReservationCreate) -> m.Reservation:
    """Crée une réservation (matin, après-midi ou journée) et attribue les points."""
    if data.reservation_date < date.today():
        raise PastDate("Impossible de réserver une date déjà passée.")
    _check_booking_policy(db, user_id, data.reservation_date)

    desk = db.get(m.Desk, data.desk_id)
    if desk is None or not desk.is_active:
        raise DeskNotFound("Ce poste n'existe pas ou n'est pas disponible.")

    slots = slots_for(data.slot)

    # Validation de TOUS les créneaux avant toute création (atomique).
    for slot_enum in slots:
        already = db.scalar(
            select(m.Reservation).where(
                m.Reservation.user_id == user_id,
                m.Reservation.reservation_date == data.reservation_date,
                m.Reservation.slot == slot_enum,
                m.Reservation.status == m.ReservationStatus.BOOKED,
            )
        )
        if already:
            raise AlreadyBooked("Tu as déjà réservé un poste sur ce créneau.")
        conflict = db.scalar(
            select(m.Reservation).where(
                m.Reservation.desk_id == data.desk_id,
                m.Reservation.reservation_date == data.reservation_date,
                m.Reservation.slot == slot_enum,
                m.Reservation.status == m.ReservationStatus.BOOKED,
            )
        )
        if conflict:
            raise SlotConflict("Ce poste est déjà réservé sur ce créneau.")

    # Création
    created = [
        m.Reservation(user_id=user_id, desk_id=data.desk_id, reservation_date=data.reservation_date, slot=s)
        for s in slots
    ]
    db.add_all(created)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise SlotConflict("Ce poste vient d'être réservé par quelqu'un d'autre.")

    for _ in slots:
        award_points(db, user_id, POINTS_PER_BOOKING, "reservation_created")
    db.commit()
    for r in created:
        db.refresh(r)
    return created[0]


def cancel_reservation(db: Session, user_id: int, reservation_id: int) -> None:
    """Annule une réservation (uniquement la sienne) et reprend les points."""
    reservation = db.get(m.Reservation, reservation_id)
    if reservation is None or reservation.status != m.ReservationStatus.BOOKED:
        raise ReservationNotFound("Réservation introuvable ou déjà annulée.")
    # Contrôle d'ownership : sécurité (on n'annule pas la résa d'un collègue).
    if reservation.user_id != user_id:
        raise NotOwner("Tu ne peux annuler que tes propres réservations.")

    reservation.status = m.ReservationStatus.CANCELLED
    # Anti-farming : on retire les points gagnés à la réservation — sauf les créneaux
    # "bulle calme" (timeslot), qui n'en rapportent jamais (voir book_timeslot).
    if reservation.slot != m.ReservationSlot.TIMESLOT:
        award_points(db, user_id, -POINTS_PER_BOOKING, "reservation_cancelled")
    db.commit()


# --------------------------------------------------------------------------
#  Réservation de salle entière (Bureau 1 / Bureau 2)
# --------------------------------------------------------------------------
def _room_desks(db: Session, zone: str) -> list[m.Desk]:
    if zone not in ROOM_ZONES:
        raise DeskNotFound("Cette salle n'existe pas.")
    desks = list(db.scalars(select(m.Desk).where(m.Desk.zone == zone, m.Desk.is_active.is_(True))))
    if not desks:
        raise DeskNotFound("Aucun poste actif dans cette salle.")
    return desks


def book_room(db: Session, user_id: int, zone: str, reservation_date: date, slot_str: str) -> list[m.Reservation]:
    """Réserve TOUS les postes actifs d'une salle fermée (Bureau 1/2) en une seule action.

    Bloquée dès qu'un seul poste de la salle est déjà réservé sur le créneau visé
    (peu importe par qui) — pas de réservation "de salle" partielle.
    """
    if reservation_date < date.today():
        raise PastDate("Impossible de réserver une date déjà passée.")
    _check_booking_policy(db, user_id, reservation_date)

    desks = _room_desks(db, zone)
    desk_ids = [d.id for d in desks]
    slots = slots_for(slot_str)

    for slot_enum in slots:
        already = db.scalar(
            select(m.Reservation).where(
                m.Reservation.user_id == user_id,
                m.Reservation.reservation_date == reservation_date,
                m.Reservation.slot == slot_enum,
                m.Reservation.status == m.ReservationStatus.BOOKED,
            )
        )
        if already:
            raise AlreadyBooked("Tu as déjà réservé un poste sur ce créneau.")
        conflict = db.scalar(
            select(m.Reservation).where(
                m.Reservation.desk_id.in_(desk_ids),
                m.Reservation.reservation_date == reservation_date,
                m.Reservation.slot == slot_enum,
                m.Reservation.status == m.ReservationStatus.BOOKED,
            )
        )
        if conflict:
            raise SlotConflict("Cette salle n'est pas disponible : un poste y est déjà réservé sur ce créneau.")

    created = [
        m.Reservation(user_id=user_id, desk_id=d.id, reservation_date=reservation_date, slot=s)
        for d in desks for s in slots
    ]
    db.add_all(created)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise SlotConflict("Cette salle vient d'être réservée par quelqu'un d'autre.")

    # Points comme une réservation de poste normale (par créneau, pas multiplié par le
    # nombre de postes de la salle — sinon la salle rapporterait bien plus qu'un poste seul).
    for _ in slots:
        award_points(db, user_id, POINTS_PER_BOOKING, "reservation_created")
    db.commit()
    for r in created:
        db.refresh(r)
    return created


def my_room_reservation_ids(db: Session, user_id: int, zone: str, reservation_date: date) -> list[int]:
    """IDs des réservations de l'utilisateur pour CETTE SALLE ENTIÈRE (tous les postes actifs
    de la zone) à cette date — [] s'il n'a réservé qu'une partie des postes individuellement
    (ce n'est alors pas "la salle", juste des postes ordinaires dans cette zone).

    Pour l'annulation groupée depuis le front, qui appelle ensuite cancel_reservation() une
    fois par id — même schéma que l'annulation d'une réservation "Journée" existante.
    """
    if zone not in ROOM_ZONES:
        return []
    desk_ids = {d.id for d in db.scalars(select(m.Desk).where(m.Desk.zone == zone, m.Desk.is_active.is_(True)))}
    if not desk_ids:
        return []
    rows = list(db.scalars(
        select(m.Reservation).where(
            m.Reservation.user_id == user_id,
            m.Reservation.reservation_date == reservation_date,
            m.Reservation.status == m.ReservationStatus.BOOKED,
            m.Reservation.desk_id.in_(desk_ids),
        )
    ))
    if not rows:
        return []
    # "Salle réservée" seulement si TOUS les postes actifs sont couverts pour au moins un des
    # créneaux détenus (AM et/ou PM) — sinon c'est une réservation individuelle ordinaire.
    by_slot: dict[m.ReservationSlot, set[int]] = {}
    for r in rows:
        by_slot.setdefault(r.slot, set()).add(r.desk_id)
    if not any(covered == desk_ids for covered in by_slot.values()):
        return []
    return [r.id for r in rows]


# --------------------------------------------------------------------------
#  Bulles calmes : réservation par créneau libre de 15 min (pas de demi-journée)
# --------------------------------------------------------------------------
def _to_minutes(t: time_type) -> int:
    return t.hour * 60 + t.minute


def get_pod_bookings(db: Session, desk_id: int, day: date) -> list[dict]:
    """Créneaux déjà réservés pour une bulle calme, ce jour-là (pour affichage)."""
    rows = db.scalars(
        select(m.Reservation).where(
            m.Reservation.desk_id == desk_id,
            m.Reservation.reservation_date == day,
            m.Reservation.slot == m.ReservationSlot.TIMESLOT,
            m.Reservation.status == m.ReservationStatus.BOOKED,
        ).order_by(m.Reservation.start_time).options(joinedload(m.Reservation.user))
    )
    return [
        {"id": r.id, "start_time": r.start_time, "end_time": r.end_time, "user_name": r.user.display_name}
        for r in rows
    ]


def book_timeslot(
    db: Session, user_id: int, desk_id: int, reservation_date: date,
    start_time: time_type, end_time: time_type,
) -> m.Reservation:
    """Réserve une bulle calme sur un créneau libre en minutes (pas de demi-journée).

    Pas de limite de jours consécutifs (non pertinent pour un créneau de quelques minutes),
    ni de points de gamification (éviterait un farming par réservations à répétition).
    """
    if reservation_date < date.today():
        raise PastDate("Impossible de réserver une date déjà passée.")
    if _is_weekend(reservation_date):
        raise WeekendNotAllowed("Pas de réservation le week-end.")
    advance_days = get_booking_advance_days(db)
    if reservation_date > date.today() + timedelta(days=advance_days):
        raise BookingWindowExceeded(f"Impossible de réserver plus de {advance_days} jours à l'avance.")

    desk = db.get(m.Desk, desk_id)
    if desk is None or not desk.is_active or desk.zone != POD_ZONE:
        raise DeskNotFound("Cette bulle calme n'existe pas ou n'est pas disponible.")

    if end_time <= start_time:
        raise ReservationError("L'heure de fin doit être après l'heure de début.")
    duration = _to_minutes(end_time) - _to_minutes(start_time)
    if start_time.minute % TIMESLOT_STEP_MINUTES or end_time.minute % TIMESLOT_STEP_MINUTES:
        raise ReservationError(f"Les créneaux se calent sur des tranches de {TIMESLOT_STEP_MINUTES} min.")
    if duration < MIN_TIMESLOT_MINUTES or duration > MAX_TIMESLOT_MINUTES:
        raise ReservationError(f"Durée du créneau : entre {MIN_TIMESLOT_MINUTES} et {MAX_TIMESLOT_MINUTES} min.")

    def _overlaps(existing_start: time_type, existing_end: time_type) -> bool:
        return not (_to_minutes(existing_end) <= _to_minutes(start_time) or _to_minutes(existing_start) >= _to_minutes(end_time))

    # Chevauchement sur CETTE bulle (n'importe quel utilisateur).
    same_desk = db.scalars(
        select(m.Reservation).where(
            m.Reservation.desk_id == desk_id,
            m.Reservation.reservation_date == reservation_date,
            m.Reservation.slot == m.ReservationSlot.TIMESLOT,
            m.Reservation.status == m.ReservationStatus.BOOKED,
        )
    )
    if any(_overlaps(r.start_time, r.end_time) for r in same_desk):
        raise SlotConflict("Ce créneau chevauche une réservation déjà en place sur cette bulle.")

    # Chevauchement avec une AUTRE bulle réservée par le même utilisateur au même moment
    # (illogique d'être dans deux bulles à la fois).
    same_user = db.scalars(
        select(m.Reservation).where(
            m.Reservation.user_id == user_id,
            m.Reservation.reservation_date == reservation_date,
            m.Reservation.slot == m.ReservationSlot.TIMESLOT,
            m.Reservation.status == m.ReservationStatus.BOOKED,
        )
    )
    if any(_overlaps(r.start_time, r.end_time) for r in same_user):
        raise AlreadyBooked("Tu as déjà une bulle réservée sur ce créneau.")

    reservation = m.Reservation(
        user_id=user_id, desk_id=desk_id, reservation_date=reservation_date,
        slot=m.ReservationSlot.TIMESLOT, start_time=start_time, end_time=end_time,
    )
    db.add(reservation)
    db.commit()
    db.refresh(reservation)
    return reservation


NOSHOW_PENALTY = 10  # points retirés par demi-journée non confirmée (check-in manquant)


def check_in(db: Session, user_id: int, reservation_id: int) -> m.Reservation:
    """Confirme sa présence sur une réservation du jour même."""
    reservation = db.get(m.Reservation, reservation_id)
    if reservation is None or reservation.status != m.ReservationStatus.BOOKED:
        raise ReservationNotFound("Réservation introuvable ou annulée.")
    if reservation.user_id != user_id:
        raise NotOwner("Tu ne peux confirmer que tes propres réservations.")
    if reservation.reservation_date != date.today():
        raise ReservationError("Le check-in n'est possible que le jour de la réservation.")
    if reservation.checked_in_at is not None:
        return reservation  # déjà confirmé — idempotent, pas une erreur

    reservation.checked_in_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(reservation)
    return reservation


def apply_noshow_penalties(db: Session, user_id: int) -> int:
    """Marque en 'no_show' les réservations passées jamais confirmées, et retire des points.

    Appelée à la volée (au chargement du tableau de bord) plutôt que par une tâche planifiée —
    suffisant pour le volume d'un MVP, pas besoin d'un vrai scheduler.
    """
    rows = db.scalars(
        select(m.Reservation).where(
            m.Reservation.user_id == user_id,
            m.Reservation.status == m.ReservationStatus.BOOKED,
            m.Reservation.reservation_date < date.today(),
            m.Reservation.checked_in_at.is_(None),
        )
    ).all()
    for r in rows:
        r.status = m.ReservationStatus.NO_SHOW
        award_points(db, user_id, -NOSHOW_PENALTY, "no_show")
    if rows:
        db.commit()
    return len(rows)
