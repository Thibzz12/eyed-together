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


def _en_heure_locale(dt: datetime) -> datetime:
    """Ramène un horodatage stocké en heure locale, qu'il arrive aware ou naïf.

    PostgreSQL renvoie de l'aware (UTC), SQLite peut rendre du naïf : la
    comparaison avec un seuil local doit tenir dans les deux cas.
    """
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(LOCAL_TZ).replace(tzinfo=None)


def close_stale(db: Session, now: datetime | None = None) -> int:
    """Clôture les présences oubliées. Renvoie le nombre de lignes touchées.

    Appelé au fil de l'eau (à chaque arrivée et à chaque consultation de la
    liste) plutôt que par un planificateur : Render ne fait tourner qu'un seul
    processus web, et un ordonnanceur pour cette seule tâche serait une pièce
    mobile de plus à surveiller. Vaut pour les employés comme pour les
    visiteurs, dont le départ dépend d'un clic que personne ne fera toujours.

    Une arrivée confirmée APRÈS l'heure limite du jour n'est pas touchée :
    la clôture vise les présences du matin jamais fermées, pas la personne qui
    travaille tard et vient de dire qu'elle est là — la refermer dans la
    seconde vidait la liste d'évacuation de son sens (constaté par Thibaud le
    29/08/2026 à 20 h : son arrivée disparaissait aussitôt confirmée). Cette
    présence tardive sera fermée au passage du lendemain, comme les autres.
    """
    now = now or local_now()
    limit_hour = get_auto_close_hour(db)
    seuil_du_jour = datetime.combine(now.date(), time(hour=limit_hour))
    reached = now.hour >= limit_hour
    closed = 0

    for model in (m.Attendance, m.Visitor):
        for row in db.scalars(select(model).where(model.left_at.is_(None))):
            arrivee_tardive = (
                row.day == now.date()
                and _en_heure_locale(row.arrived_at) >= seuil_du_jour
            )
            if arrivee_tardive:
                continue
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
        _accueillir_les_invites(db, user_id, day)
        db.commit()
        db.refresh(row)
        return row

    if row.left_at is not None:
        row.left_at = None
        row.auto_closed = False
        # Revenir après l'heure de clôture rouvre la ligne, mais son arrivée du
        # matin la ferait refermer au prochain balayage (voir close_stale). La
        # présence EN COURS prime sur l'heure d'arrivée initiale : la liste
        # d'évacuation répond à « qui est là maintenant », pas à un relevé.
        maintenant = local_now()
        if maintenant.hour >= get_auto_close_hour(db):
            row.arrived_at = maintenant
    # Les invités peuvent avoir été désignés APRÈS l'arrivée de leur hôte : on
    # repasse à chaque confirmation, sans quoi une table réservée à midi
    # n'inscrirait personne.
    _accueillir_les_invites(db, user_id, day)
    db.commit()
    db.refresh(row)
    return row


def guests_expected(db: Session, user_id: int, day: date | None = None) -> list[dict]:
    """Personnes extérieures que cet employé a désignées sur ses réservations du jour.

    Une réservation d'espace entier oblige à dire qui occupe chaque place ; celles
    qui ne correspondent à aucun collègue sont des visiteurs à annoncer. On lit le
    modèle `Reservation` directement plutôt que le service `reservations`, qui
    importe déjà celui-ci : l'inverse créerait un cycle.
    """
    day = day or local_today()
    lignes = db.scalars(
        select(m.Reservation).where(
            m.Reservation.user_id == user_id,
            m.Reservation.reservation_date == day,
            m.Reservation.status == m.ReservationStatus.BOOKED,
            m.Reservation.occupant_user_id.is_(None),
            m.Reservation.occupant_name.is_not(None),
        )
    )
    # Une même personne occupe souvent la place matin ET après-midi : deux lignes,
    # un seul visiteur.
    vus: dict[str, dict] = {}
    for r in lignes:
        nom = (r.occupant_name or "").strip()
        if not nom:
            continue
        vus.setdefault(nom.casefold(), {"full_name": nom, "company": r.occupant_company})
    return list(vus.values())


def refresh_guests(db: Session, user_id: int, day: date | None = None) -> int:
    """Réaligne les visiteurs annoncés d'un hôte DÉJÀ présent dans les locaux.

    Appelée après une réservation d'espace entier : si l'hôte est arrivé, ses
    invités du jour doivent apparaître tout de suite sur la liste d'évacuation.
    S'il n'est pas encore là, on ne fait rien — son arrivée s'en chargera.
    """
    day = day or local_today()
    row = _row_for(db, user_id, day)
    if row is None or row.left_at is not None:
        return 0

    avant = len(_visitors_of(db, user_id, day))
    _accueillir_les_invites(db, user_id, day)
    db.commit()
    return len(_visitors_of(db, user_id, day)) - avant


def _accueillir_les_invites(db: Session, user_id: int, day: date) -> None:
    """Inscrit comme visiteurs les personnes extérieures attendues par cet hôte.

    Idempotent : réarriver après un départ ne recrée pas de doublon. Ne valide
    pas la transaction, c'est l'appelant qui le fait.
    """
    deja = {
        (v.full_name or "").casefold()
        for v in db.scalars(
            select(m.Visitor).where(
                m.Visitor.host_user_id == user_id, m.Visitor.day == day
            )
        )
    }
    for invite in guests_expected(db, user_id, day):
        if invite["full_name"].casefold() in deja:
            continue
        db.add(m.Visitor(
            host_user_id=user_id,
            day=day,
            full_name=invite["full_name"][:120],
            company=(invite["company"] or None),
            arrived_at=local_now(),
        ))


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
