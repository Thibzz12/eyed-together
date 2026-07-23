"""Logique métier des réservations (indépendante du web).

Règles appliquées :
  - pas de réservation dans le passé ;
  - pas de réservation le week-end (personne ne travaille) ;
  - horizon max de réservation : MAX_ADVANCE_DAYS jours calendaires ;
  - max MAX_CONSECUTIVE_DAYS jours ouvrés consécutifs réservés par un même employé ;
  - un employé ne peut pas réserver 2 postes sur le même créneau ;
  - anti-doublon garanti par la base (index unique partiel) → capturé en 409 ;
  - on ne peut annuler que SES propres réservations (ownership).
"""

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db import models as m
from app.schemas import ReservationCreate
from app.services.gamification import POINTS_PER_BOOKING, award_points

# Politique de réservation (cf. PROGRESS.md — validée avec Thibaud le 2026-07-23).
MAX_ADVANCE_DAYS = 7        # horizon max de réservation à l'avance
MAX_CONSECUTIVE_DAYS = 5    # max de jours ouvrés consécutifs réservés d'affilée


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
    if target > date.today() + timedelta(days=MAX_ADVANCE_DAYS):
        raise BookingWindowExceeded(f"Impossible de réserver plus de {MAX_ADVANCE_DAYS} jours à l'avance.")

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
    """Qui est présent (réservations actives) pour une date donnée."""
    return list(
        db.scalars(
            select(m.Reservation)
            .where(
                m.Reservation.reservation_date == day,
                m.Reservation.status == m.ReservationStatus.BOOKED,
            )
            .order_by(m.Reservation.slot)
            .options(joinedload(m.Reservation.user), joinedload(m.Reservation.desk))
        )
    )


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
    # Anti-farming : on retire les points gagnés à la réservation.
    award_points(db, user_id, -POINTS_PER_BOOKING, "reservation_cancelled")
    db.commit()
