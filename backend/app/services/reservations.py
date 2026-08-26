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

import json
import re
from datetime import date, datetime, timedelta, timezone
from datetime import time as time_type

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db import models as m
from app.schemas import ReservationCreate
from app.services import attendance as attendance_svc
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

# Les tables de l'open space ("T1", "T2", …) ne sont pas énumérées : leur nombre
# change quand l'admin ajoute ou retire des postes. Leur clé se déduit donc de la
# référence. Avant le 26/08/2026, le nom d'une table était lu dans le champ
# `features` de son premier poste, ce qui interdisait d'y noter un équipement
# (« Double écran ») sans renommer la table du même coup. Les deux notions sont
# désormais séparées : `features` décrit le poste, le libellé vit ici.
_TABLE_REF = re.compile(r"^T\d+$")


def _table_label_key(ref: str) -> str | None:
    return f"table_label_{ref.lower()}" if _TABLE_REF.match(ref) else None


def default_table_label(ref: str) -> str:
    """« T3 » -> « Table 3 »."""
    return f"Table {ref[1:]}"


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
    for ref in table_refs(db):
        row = db.get(m.AppSetting, _table_label_key(ref))
        labels[ref] = row.value if row else default_table_label(ref)
    return labels


def table_refs(db: Session) -> list[str]:
    """Références des tables d'open space existantes, triées ("T1", "T2", …)."""
    refs = {
        d.name.split("-")[0]
        for d in db.scalars(select(m.Desk).where(m.Desk.zone.notin_(ROOM_ZONES | {POD_ZONE})))
        if "-" in d.name
    }
    return sorted(r for r in refs if _TABLE_REF.match(r))


def set_room_label(db: Session, ref: str, label: str) -> None:
    """Renomme un bureau ("Bureau 1"), une bulle calme ("BC-1") ou une table ("T1")."""
    key = _ROOM_LABEL_KEYS.get(ref) or _POD_LABEL_KEYS.get(ref) or _table_label_key(ref)
    if not key:
        raise ReservationError("Référence de salle, de bulle ou de table inconnue.")
    label = label.strip() or (default_table_label(ref) if _TABLE_REF.match(ref) else ref)
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


def get_availability(db: Session, day: date, slot_str: str) -> list[tuple[m.Desk, str | None, str | None]]:
    """Pour une date + un créneau (AM/PM/DAY) : chaque poste, qui l'a réservé et qui l'occupe.

    En 'DAY', un poste est indisponible si le matin OU l'après-midi est déjà pris.

    Réservant et occupant diffèrent sur une réservation de groupe : celui qui bloque
    une table entière désigne qui s'installe sur chaque place. Afficher le réservant
    partout ferait apparaître son nom sur les six sièges, ce qui est faux et rend la
    demande d'Olivier (savoir qui est où) sans effet.
    """
    slots = slots_for(slot_str)
    desks = list_desks(db)
    taken: dict[int, tuple[str, str | None]] = {}
    reserved = db.scalars(
        select(m.Reservation)
        .where(
            m.Reservation.reservation_date == day,
            m.Reservation.slot.in_(slots),
            m.Reservation.status == m.ReservationStatus.BOOKED,
        )
        .options(joinedload(m.Reservation.user), joinedload(m.Reservation.occupant))
    )
    for r in reserved:
        if r.occupant is not None:
            occupant = r.occupant.display_name
        elif r.occupant_name:
            occupant = r.occupant_name
        elif r.is_group_booking:
            # Place bloquée par une réservation d'espace entier, volontairement vide.
            occupant = None
        else:
            # Réservation individuelle : l'occupant est le réservant lui-même.
            occupant = r.user.display_name
        taken.setdefault(r.desk_id, (r.user.display_name, occupant))
    return [(d, *taken.get(d.id, (None, None))) for d in desks]


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

    _require_mode(db, "seat")
    groupe = _group_of(desk)
    if groupe and not is_group_enabled(db, groupe):
        raise ReservationError("Cet espace n'est pas disponible en ce moment.")

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


# --------------------------------------------------------------------------
#  Icônes d'équipement, administrables
# --------------------------------------------------------------------------
#  `Desk.features` est du texte libre ("Double écran, station assise/debout").
#  Chaque étiquette reçoit une icône par correspondance de mot-clé. Ces règles
#  vivaient en dur dans app.js : ajouter un type de poste imposait de toucher au
#  code. Elles sont désormais modifiables depuis l'administration.
_FEATURE_ICONS_KEY = "feature_icon_rules"
_DEFAULT_FEATURE_ICONS = [
    {"keyword": "double écran", "icon": "🖥️"},
    {"keyword": "écran courbé", "icon": "🖥"},
    {"keyword": "écran", "icon": "🖥️"},
    {"keyword": "docking", "icon": "🔌"},
    {"keyword": "surface", "icon": "📱"},
    {"keyword": "debout", "icon": "🧍"},
    {"keyword": "clavier", "icon": "⌨️"},
    {"keyword": "casque", "icon": "🎧"},
    {"keyword": "calme", "icon": "🤫"},
    {"keyword": "fenêtre", "icon": "☀️"},
    {"keyword": "cabine", "icon": "🚪"},
]


def get_feature_icons(db: Session) -> list[dict]:
    """Règles mot-clé vers icône, dans l'ordre de priorité (la première qui colle gagne)."""
    row = db.get(m.AppSetting, _FEATURE_ICONS_KEY)
    if row is None or not row.value:
        return [dict(r) for r in _DEFAULT_FEATURE_ICONS]
    try:
        regles = json.loads(row.value)
    except (TypeError, ValueError):
        return [dict(r) for r in _DEFAULT_FEATURE_ICONS]
    return [r for r in regles if isinstance(r, dict) and r.get("keyword") and r.get("icon")]


def set_feature_icons(db: Session, rules: list[dict]) -> None:
    """Remplace toutes les règles. Un mot-clé ou une icône vide est refusé."""
    propres = []
    for r in rules or []:
        mot = (r.get("keyword") or "").strip()
        icone = (r.get("icon") or "").strip()
        if not mot or not icone:
            raise ReservationError("Chaque règle a besoin d'un mot-clé et d'une icône.")
        propres.append({"keyword": mot[:60], "icon": icone[:8]})

    row = db.get(m.AppSetting, _FEATURE_ICONS_KEY)
    valeur = json.dumps(propres, ensure_ascii=False)
    if row is None:
        db.add(m.AppSetting(key=_FEATURE_ICONS_KEY, value=valeur))
    else:
        row.value = valeur
    db.commit()


# --------------------------------------------------------------------------
#  Interrupteurs d'administration : quels modes de réservation sont ouverts
# --------------------------------------------------------------------------
#  Tout est ouvert par défaut : un réglage absent ne doit jamais fermer une
#  fonction que les employés utilisaient la veille.
_TOGGLE_LABELS = {
    "seat": "Réservation d'une place",
    "table": "Réservation d'une table entière",
    "room": "Réservation d'une salle entière",
    "pod": "Réservation d'une bulle calme",
}
_TOGGLE_KEY = "booking_enabled_{}"
_GROUP_KEY = "space_enabled_{}"


def _flag(db: Session, key: str, defaut: bool = True) -> bool:
    row = db.get(m.AppSetting, key)
    if row is None:
        return defaut
    return row.value not in ("0", "false", "False", "")


def _set_flag(db: Session, key: str, enabled: bool) -> None:
    valeur = "1" if enabled else "0"
    row = db.get(m.AppSetting, key)
    if row is None:
        db.add(m.AppSetting(key=key, value=valeur))
    else:
        row.value = valeur
    db.commit()


def get_booking_toggles(db: Session) -> dict[str, bool]:
    """État des quatre modes de réservation."""
    return {mode: _flag(db, _TOGGLE_KEY.format(mode)) for mode in _TOGGLE_LABELS}


def set_booking_toggle(db: Session, mode: str, enabled: bool) -> None:
    if mode not in _TOGGLE_LABELS:
        raise ReservationError("Mode de réservation inconnu.")
    _set_flag(db, _TOGGLE_KEY.format(mode), enabled)


def is_group_enabled(db: Session, ref: str) -> bool:
    """Un espace grisé par l'admin reste visible sur le plan mais n'est plus réservable."""
    return _flag(db, _GROUP_KEY.format(ref))


def set_group_enabled(db: Session, ref: str, enabled: bool) -> None:
    _set_flag(db, _GROUP_KEY.format(ref), enabled)


def _require_mode(db: Session, mode: str) -> None:
    if not _flag(db, _TOGGLE_KEY.format(mode)):
        raise ReservationError(f"{_TOGGLE_LABELS[mode]} est désactivée pour le moment.")


# --------------------------------------------------------------------------
#  Groupes réservables d'un bloc : salles fermées ET tables de l'open space
# --------------------------------------------------------------------------
#  Une salle est un groupe par sa zone ("Bureau 1"). Une table est un groupe par
#  le préfixe du nom de ses postes ("T1" pour T1-1 … T1-4). On ne se base pas sur
#  `features` pour regrouper : ce champ est du texte libre que l'admin modifie,
#  et il sert déjà à décrire les équipements.
def _group_of(desk: m.Desk) -> str | None:
    """Référence du groupe auquel appartient un poste, ou None s'il n'en a pas."""
    if desk.zone in ROOM_ZONES:
        return desk.zone
    if desk.zone == POD_ZONE:
        return None  # une bulle calme se réserve par créneau, jamais en groupe
    prefixe = desk.name.split("-")[0]
    return prefixe if prefixe != desk.name else None


def _group_desks(db: Session, ref: str) -> list[m.Desk]:
    """Postes actifs d'un groupe (salle ou table)."""
    desks = [
        d for d in db.scalars(select(m.Desk).where(m.Desk.is_active.is_(True)).order_by(m.Desk.name))
        if _group_of(d) == ref
    ]
    if not desks:
        raise DeskNotFound("Cet espace n'existe pas ou n'a aucun poste disponible.")
    return desks


def bookable_groups(db: Session) -> list[dict]:
    """Tous les groupes réservables d'un bloc, avec leur libellé et leur nombre de places."""
    groupes: dict[str, list[m.Desk]] = {}
    for d in db.scalars(select(m.Desk).where(m.Desk.is_active.is_(True)).order_by(m.Desk.name)):
        ref = _group_of(d)
        if ref:
            groupes.setdefault(ref, []).append(d)

    labels = get_room_labels(db)
    out = []

    # Une bulle calme ne se réserve pas « en entier » (elle n'a qu'une place, prise
    # par créneau de 15 min), mais Olivier veut pouvoir la rendre indisponible comme
    # une salle : elle figure donc parmi les espaces, avec kind="pod" pour que le
    # front n'aille pas lui proposer un bouton « réserver toute la bulle ».
    for d in db.scalars(select(m.Desk).where(m.Desk.zone == POD_ZONE).order_by(m.Desk.name)):
        out.append({
            "ref": d.name,
            "label": labels.get(d.name) or d.name,
            "zone": d.zone,
            "seats": 1,
            "kind": "pod",
            "enabled": is_group_enabled(db, d.name),
        })

    for ref, desks in groupes.items():
        # Libellé : ce que l'admin a saisi, sinon « Table 3 » pour une table et le
        # nom de zone pour une salle. Jamais `features`, qui décrit l'équipement.
        label = labels.get(ref) or (default_table_label(ref) if _TABLE_REF.match(ref) else ref)
        out.append({
            "ref": ref,
            "label": label,
            "zone": desks[0].zone,
            "seats": len(desks),
            "kind": "room" if ref in ROOM_ZONES else "table",
            "enabled": is_group_enabled(db, ref),
        })
    rang = {"room": 0, "table": 1, "pod": 2}
    return sorted(out, key=lambda g: (rang.get(g["kind"], 9), g["ref"]))


def _validate_occupants(occupants: list[dict] | None, desks: list[m.Desk]) -> dict[int, dict]:
    """Vérifie les occupants déclarés et les indexe par poste.

    Réserver une table entière retire quatre à six places du planning d'un coup :
    on exige de savoir qui s'y installera, sinon les places disparaissent sans
    que personne ne puisse dire qui les occupe (demande explicite d'Olivier).
    """
    occupants = occupants or []
    if not occupants:
        raise ReservationError("Indique qui occupera cet espace avant de le réserver.")

    ids_du_groupe = {d.id for d in desks}
    par_poste: dict[int, dict] = {}
    for o in occupants:
        desk_id = o.get("desk_id")
        if desk_id not in ids_du_groupe:
            raise ReservationError("Une des places indiquées n'appartient pas à cet espace.")
        if desk_id in par_poste:
            raise ReservationError("Deux personnes sont indiquées sur la même place.")
        nom = (o.get("name") or "").strip()
        if not o.get("user_id") and not nom:
            raise ReservationError("Indique un collègue ou le nom d'une personne extérieure.")
        par_poste[desk_id] = {
            "user_id": o.get("user_id"),
            "name": nom[:120] or None,
            "company": ((o.get("company") or "").strip() or None),
        }
    return par_poste


def book_group(
    db: Session,
    user_id: int,
    ref: str,
    reservation_date: date,
    slot_str: str,
    occupants: list[dict] | None = None,
) -> list[m.Reservation]:
    """Réserve d'un bloc tous les postes actifs d'une salle fermée ou d'une table.

    Bloquée dès qu'un seul poste du groupe est déjà réservé sur le créneau visé,
    peu importe par qui : pas de réservation de groupe partielle.
    """
    if reservation_date < date.today():
        raise PastDate("Impossible de réserver une date déjà passée.")
    _check_booking_policy(db, user_id, reservation_date)

    desks = _group_desks(db, ref)
    _require_mode(db, "room" if ref in ROOM_ZONES else "table")
    if not is_group_enabled(db, ref):
        raise ReservationError("Cet espace n'est pas disponible en ce moment.")
    par_poste = _validate_occupants(occupants, desks)
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
            raise SlotConflict("Cet espace n'est pas disponible : une place y est déjà réservée sur ce créneau.")

    created = []
    for d in desks:
        occupant = par_poste.get(d.id, {})
        for s in slots:
            created.append(m.Reservation(
                user_id=user_id, desk_id=d.id, reservation_date=reservation_date, slot=s,
                is_group_booking=True,
                occupant_user_id=occupant.get("user_id"),
                occupant_name=occupant.get("name"),
                occupant_company=occupant.get("company"),
            ))
    db.add_all(created)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise SlotConflict("Cet espace vient d'être réservé par quelqu'un d'autre.")

    # Points comme une réservation de poste normale (par créneau, pas multiplié par le
    # nombre de places — sinon bloquer une table entière rapporterait bien plus qu'une place.)
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


def my_group_reservation_ids(db: Session, user_id: int, ref: str, reservation_date: date) -> list[int]:
    """IDs de mes réservations quand j'ai pris CET ESPACE ENTIER (salle ou table).

    Renvoie [] si je n'ai réservé qu'une partie des places : ce n'est alors pas
    « la table », juste des places ordinaires que j'ai prises une par une.
    """
    try:
        desks = _group_desks(db, ref)
    except DeskNotFound:
        return []
    desk_ids = {d.id for d in desks}

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

    by_slot: dict[m.ReservationSlot, set[int]] = {}
    for r in rows:
        by_slot.setdefault(r.slot, set()).add(r.desk_id)
    if not any(couvert == desk_ids for couvert in by_slot.values()):
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
    _require_mode(db, "pod")
    if _is_weekend(reservation_date):
        raise WeekendNotAllowed("Pas de réservation le week-end.")
    advance_days = get_booking_advance_days(db)
    if reservation_date > date.today() + timedelta(days=advance_days):
        raise BookingWindowExceeded(f"Impossible de réserver plus de {advance_days} jours à l'avance.")

    desk = db.get(m.Desk, desk_id)
    if desk is None or not desk.is_active or desk.zone != POD_ZONE:
        raise DeskNotFound("Cette bulle calme n'existe pas ou n'est pas disponible.")
    if not is_group_enabled(db, desk.name):
        raise ReservationError("Cet espace n'est pas disponible en ce moment.")

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

    # Confirmer sa présence sur sa réservation, c'est aussi être dans les locaux :
    # une seule source de vérité pour la liste d'évacuation (voir services/attendance.py).
    attendance_svc.check_in(db, user_id, source="reservation")
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
