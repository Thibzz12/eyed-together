"""Présence physique dans les locaux : arrivées, départs, visiteurs.

À ne pas confondre avec DailyStatus, qui enregistre le statut *déclaré* à
l'avance (bureau, télétravail, congé). Ici on enregistre un fait constaté,
qui sert à la sécurité incendie : qui est réellement dans le bâtiment.

Ce module n'importe aucun autre service métier hormis la gamification :
c'est `reservations` qui appelle `attendance`, jamais l'inverse. Inverser ce
sens créerait un import circulaire.
"""

from datetime import date, datetime, time

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.timezone import LOCAL_TZ, local_now, local_today
from app.db import models as m
from app.services.gamification import POINTS_PER_CHECKIN, award_points


class AttendanceError(Exception):
    status_code = 400


class AttendanceNotFound(AttendanceError):
    status_code = 404


class AttendanceForbidden(AttendanceError):
    status_code = 403


# Heure locale à laquelle les présences encore ouvertes sont clôturées d'office.
DEFAULT_AUTO_CLOSE_HOUR = 19
_AUTO_CLOSE_KEY = "attendance_auto_close_hour"


def get_auto_close_hour(db: Session) -> int:
    """Heure de clôture automatique, réglable en administration."""
    row = db.get(m.AppSetting, _AUTO_CLOSE_KEY)
    if row is None:
        return DEFAULT_AUTO_CLOSE_HOUR
    try:
        return min(23, max(0, int(row.value)))
    except (TypeError, ValueError):
        return DEFAULT_AUTO_CLOSE_HOUR


def set_auto_close_hour(db: Session, hour: int) -> None:
    """Change l'heure de clôture. Refuse toute valeur hors du cadran."""
    if not isinstance(hour, int) or not 0 <= hour <= 23:
        raise AttendanceError("L'heure de clôture doit être comprise entre 0 et 23.")
    row = db.get(m.AppSetting, _AUTO_CLOSE_KEY)
    if row is None:
        db.add(m.AppSetting(key=_AUTO_CLOSE_KEY, value=str(hour)))
    else:
        row.value = str(hour)
    db.commit()


def _closing_moment(row_day: date, now: datetime, limit_hour: int) -> datetime:
    """Heure de départ à inscrire pour une présence clôturée d'office.

    Pour une journée passée, on ferme à l'heure limite de CE jour-là. Fermer
    à l'instant présent laisserait entendre que la personne a dormi sur place.
    """
    if row_day < now.date():
        return datetime.combine(row_day, time(hour=limit_hour), tzinfo=LOCAL_TZ)
    return now


def close_stale(db: Session, now: datetime | None = None) -> int:
    """Clôture les présences oubliées. Renvoie le nombre de lignes touchées.

    Appelé au fil de l'eau (à chaque arrivée et à chaque consultation de la
    liste) plutôt que par un planificateur : Render ne fait tourner qu'un seul
    processus web, et un ordonnanceur pour cette seule tâche serait une pièce
    mobile de plus à surveiller. Vaut pour les employés comme pour les
    visiteurs, dont le départ dépend d'un clic que personne ne fera toujours.
    """
    now = now or local_now()
    limit_hour = get_auto_close_hour(db)
    reached = now.hour >= limit_hour
    closed = 0

    for model in (m.Attendance, m.Visitor):
        for row in db.scalars(select(model).where(model.left_at.is_(None))):
            if row.day < now.date() or (row.day == now.date() and reached):
                row.left_at = _closing_moment(row.day, now, limit_hour)
                row.auto_closed = True
                closed += 1

    if closed:
        db.commit()
    return closed


def _row_for(db: Session, user_id: int, day: date) -> m.Attendance | None:
    return db.scalar(
        select(m.Attendance).where(
            m.Attendance.user_id == user_id, m.Attendance.day == day
        )
    )


def check_in(db: Session, user_id: int, source: str = "popup", day: date | None = None) -> m.Attendance:
    """Confirme l'arrivée. Rouvre la ligne du jour si la personne était partie.

    Les points ne sont attribués qu'à la toute première arrivée de la journée :
    sinon, alterner arrivée et départ suffirait à en accumuler.
    """
    close_stale(db)
    day = day or local_today()
    row = _row_for(db, user_id, day)

    if row is None:
        row = m.Attendance(user_id=user_id, day=day, arrived_at=local_now(), source=source)
        db.add(row)
        award_points(db, user_id, POINTS_PER_CHECKIN, "checkin")
        db.commit()
        db.refresh(row)
        return row

    if row.left_at is not None:
        row.left_at = None
        row.auto_closed = False
        db.commit()
        db.refresh(row)
    return row


def check_out(db: Session, user_id: int, day: date | None = None) -> m.Attendance:
    """Confirme le départ. Refuse si la personne n'était pas marquée présente."""
    day = day or local_today()
    row = _row_for(db, user_id, day)
    if row is None:
        raise AttendanceNotFound("Aucune arrivée confirmée aujourd'hui.")
    if row.left_at is not None:
        raise AttendanceError("Ton départ est déjà enregistré.")

    row.left_at = local_now()
    row.auto_closed = False
    db.commit()
    db.refresh(row)
    return row


def _visitors_of(db: Session, host_user_id: int, day: date) -> list[m.Visitor]:
    return list(
        db.scalars(
            select(m.Visitor)
            .where(m.Visitor.host_user_id == host_user_id, m.Visitor.day == day)
            .order_by(m.Visitor.arrived_at)
        )
    )


def state_for(db: Session, user_id: int, day: date | None = None) -> dict:
    """État du jour pour un utilisateur : pilote le pop-up et le bouton de départ."""
    day = day or local_today()
    row = _row_for(db, user_id, day)
    return {
        "day": day.isoformat(),
        "arrived": row is not None,
        "present": row is not None and row.left_at is None,
        "visitors": [
            {
                "id": v.id,
                "full_name": v.full_name,
                "company": v.company,
                "present": v.left_at is None,
            }
            for v in _visitors_of(db, user_id, day)
        ],
    }


def add_visitor(db: Session, host_user_id: int, full_name: str, company: str | None) -> m.Visitor:
    """Enregistre un visiteur externe arrivé maintenant, sous la responsabilité d'un hôte."""
    name = (full_name or "").strip()
    if not name:
        raise AttendanceError("Le nom du visiteur est obligatoire.")

    visitor = m.Visitor(
        host_user_id=host_user_id,
        day=local_today(),
        full_name=name[:120],
        company=((company or "").strip() or None),
        arrived_at=local_now(),
    )
    db.add(visitor)
    db.commit()
    db.refresh(visitor)
    return visitor


def visitor_check_out(
    db: Session, visitor_id: int, requesting_user_id: int, is_admin: bool = False
) -> m.Visitor:
    """Marque un visiteur parti. Réservé à son hôte et aux administrateurs."""
    visitor = db.get(m.Visitor, visitor_id)
    if visitor is None:
        raise AttendanceNotFound("Ce visiteur n'existe pas.")
    if not is_admin and visitor.host_user_id != requesting_user_id:
        raise AttendanceForbidden("Seul l'hôte de ce visiteur peut enregistrer son départ.")
    if visitor.left_at is not None:
        raise AttendanceError("Le départ de ce visiteur est déjà enregistré.")

    visitor.left_at = local_now()
    visitor.auto_closed = False
    db.commit()
    db.refresh(visitor)
    return visitor


def who_is_in(db: Session, day: date | None = None) -> dict:
    """Qui est dans les locaux, sans aucun horodatage.

    Vue destinée à tous les employés : afficher les heures d'arrivée et de
    départ à tout le monde transformerait l'outil en pointeuse, ce qui n'est
    pas son objet. Les heures restent en base et sortent dans le relevé admin.
    """
    close_stale(db)
    day = day or local_today()

    employees = db.scalars(
        select(m.Attendance)
        .options(joinedload(m.Attendance.user))
        .where(m.Attendance.day == day, m.Attendance.left_at.is_(None))
        .order_by(m.Attendance.arrived_at)
    )
    visitors = db.scalars(
        select(m.Visitor)
        .options(joinedload(m.Visitor.host))
        .where(m.Visitor.day == day, m.Visitor.left_at.is_(None))
        .order_by(m.Visitor.arrived_at)
    )

    return {
        "day": day.isoformat(),
        "employees": [
            {"user_id": a.user_id, "name": a.user.display_name, "department": a.user.department}
            for a in employees
        ],
        "visitors": [
            {
                "id": v.id,
                "full_name": v.full_name,
                "company": v.company,
                "host_user_id": v.host_user_id,
                "host_name": v.host.display_name,
            }
            for v in visitors
        ],
    }


def roster(db: Session, day: date | None = None) -> dict:
    """Relevé complet d'une journée, heures comprises. Usage administrateur seulement."""
    close_stale(db)
    day = day or local_today()

    employees = db.scalars(
        select(m.Attendance)
        .options(joinedload(m.Attendance.user))
        .where(m.Attendance.day == day)
        .order_by(m.Attendance.arrived_at)
    )
    visitors = db.scalars(
        select(m.Visitor)
        .options(joinedload(m.Visitor.host))
        .where(m.Visitor.day == day)
        .order_by(m.Visitor.arrived_at)
    )

    return {
        "day": day.isoformat(),
        "employees": [
            {
                "name": a.user.display_name,
                "department": a.user.department,
                "arrived_at": a.arrived_at.isoformat(),
                "left_at": a.left_at.isoformat() if a.left_at else None,
                "auto_closed": a.auto_closed,
                "source": a.source,
            }
            for a in employees
        ],
        "visitors": [
            {
                "full_name": v.full_name,
                "company": v.company,
                "host_name": v.host.display_name,
                "arrived_at": v.arrived_at.isoformat(),
                "left_at": v.left_at.isoformat() if v.left_at else None,
                "auto_closed": v.auto_closed,
            }
            for v in visitors
        ],
    }
