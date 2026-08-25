# Présence réelle dans les locaux (lot A)

Spec du 25 août 2026. Origine : mail d'Olivier Vanbrabant du 25 août 2026,
« Modifications - EyeD Together », section PRÉSENCE.

## Problème

L'application sait qui a *réservé* un poste. Elle ne sait pas qui est
*physiquement dans le bâtiment*. Ce sont deux choses différentes :

- une personne qui réserve puis ne vient pas apparaît comme présente ;
- une personne qui passe sans avoir réservé n'apparaît nulle part ;
- un visiteur externe n'existe pas du tout dans le système.

EyeD Pharma veut cette information pour l'évacuation incendie et le suivi
des visiteurs. Une liste d'évacuation fausse est pire que pas de liste.

## Vocabulaire

Le mot « présence » désigne déjà deux notions dans l'application. Cette spec
les sépare et le code doit respecter cette distinction :

| Notion | Nature | Support existant | Nom dans l'interface |
|---|---|---|---|
| Statut déclaré matin/après-midi (bureau, télétravail, congé) | intention annoncée à l'avance | table `daily_status`, vue `presence` | « Ma présence » (inchangé) |
| Personne physiquement dans le bâtiment | fait constaté sur place | **nouveau** | « Dans les locaux » |

## Périmètre

Dans le périmètre :

1. confirmation d'arrivée par l'employé ;
2. confirmation de départ ;
3. déclaration de visiteurs externes (nom et société) par le collègue qui les reçoit ;
4. vue temps réel de qui est dans les locaux, employés et visiteurs ;
5. export imprimable pour l'évacuation, réservé aux administrateurs ;
6. points de gamification à la première arrivée du jour.

Hors périmètre, traité dans des lots ultérieurs : verrous d'activation en
admin (lot B), plan interactif et acronymes (lot C), corrections d'affichage
et page récompenses (lot D).

## Modèle de données

Une migration Alembic ajoute deux tables.

### `attendance`

| Colonne | Type | Notes |
|---|---|---|
| `id` | int, PK | |
| `user_id` | FK `users.id`, ondelete CASCADE, indexé | |
| `day` | date, indexé | jour local belge |
| `arrived_at` | datetime tz | horodatage de la première arrivée du jour |
| `left_at` | datetime tz, nullable | `null` signifie « encore dans les locaux » |
| `source` | str(20) | `popup`, `reservation` ou `admin` |
| `auto_closed` | bool, défaut `false` | `true` si le départ vient du balayage du soir |

Contrainte d'unicité `(user_id, day)`.

**Une seule ligne par personne et par jour, volontairement.** Si quelqu'un
part à midi et revient à 14h, un nouveau clic sur « Je suis arrivé » remet
`left_at` à `null` sur la ligne existante et ne touche pas `arrived_at`. Le
système répond à la question « cette personne est-elle dans le bâtiment
maintenant ? », il ne reconstitue pas un historique d'allées et venues. Ce
n'est pas une pointeuse et ne doit pas le devenir.

### `visitors`

| Colonne | Type | Notes |
|---|---|---|
| `id` | int, PK | |
| `host_user_id` | FK `users.id`, ondelete CASCADE, indexé | le collègue qui reçoit |
| `day` | date, indexé | |
| `full_name` | str(120) | |
| `company` | str(120), nullable | |
| `arrived_at` | datetime tz | |
| `left_at` | datetime tz, nullable | |
| `auto_closed` | bool, défaut `false` | |

Pas de contrainte d'unicité : un même visiteur peut revenir, et deux
visiteurs peuvent porter le même nom.

## Service `app/services/attendance.py`

Module isolé, sans dépendance vers `services/reservations.py`. C'est
`reservations` qui appellera `attendance`, jamais l'inverse, pour éviter un
cycle d'imports et garder la présence utilisable seule.

| Fonction | Rôle |
|---|---|
| `state_for(db, user_id, day)` | état du jour pour l'utilisateur : arrivé ou non, parti ou non, ses visiteurs. Pilote le pop-up. |
| `check_in(db, user_id, source, day)` | crée la ligne du jour ou rouvre une ligne clôturée. Attribue les points à la première arrivée seulement. |
| `check_out(db, user_id, day)` | pose `left_at`. Sans effet si la personne n'est pas marquée présente. |
| `add_visitor(db, host_user_id, full_name, company)` | enregistre un visiteur arrivé maintenant. |
| `visitor_check_out(db, visitor_id, requesting_user_id)` | pose `left_at` sur un visiteur. Autorisé à l'hôte et aux administrateurs. |
| `who_is_in(db, day)` | employés et visiteurs dont `left_at is null`, triés par heure d'arrivée. |
| `close_stale(db, now)` | balayage décrit ci-dessous. |

### Balayage du soir, sans planificateur

Render fait tourner un seul processus web et le projet n'a pas de
planificateur. En ajouter un pour cette seule fonction serait fragile et
difficile à tester. Le balayage est donc **paresseux** : `close_stale` est
appelé au début de `who_is_in` et de `check_in`, et clôture toute présence
ouverte qui remplit une des deux conditions :

- son `day` est antérieur au jour courant ;
- son `day` est le jour courant et l'heure locale a dépassé l'heure limite.

Les lignes clôturées ainsi reçoivent `auto_closed = true`, ce qui permet à
l'administrateur de distinguer un départ confirmé d'un oubli. L'heure limite
est stockée dans `app_settings` sous la clé `attendance_auto_close_hour`,
valeur par défaut `19`, modifiable en administration.

Le balayage s'applique aux employés **et aux visiteurs**. Le départ des
visiteurs étant indépendant de celui de leur hôte (choix produit assumé, il
donne une heure de départ juste quand le bouton est utilisé), le balayage du
soir est le seul filet contre un visiteur parti dont personne n'a cliqué.

### Points

`check_in` appelle `award_points(db, user_id, POINTS_PER_CHECKIN, "checkin")`
uniquement lors de la première arrivée d'une journée, jamais lors d'une
réouverture après un départ. `POINTS_PER_CHECKIN` est déclaré dans
`services/gamification.py` à côté de `POINTS_PER_BOOKING`.

## API

Toutes les routes sont sous `/api`, protégées par `get_current_user` sauf
mention contraire.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/attendance/me` | état du jour, pilote l'affichage du pop-up et du bouton de départ |
| POST | `/attendance/checkin` | confirme l'arrivée, `source = "popup"` |
| POST | `/attendance/checkout` | confirme le départ |
| GET | `/attendance/today` | qui est dans les locaux, employés et visiteurs |
| POST | `/visitors` | déclare un visiteur (nom, société) |
| POST | `/visitors/{id}/checkout` | marque un visiteur parti |
| GET | `/admin/attendance/export` | CSV imprimable pour l'évacuation, `require_admin` |
| PATCH | `/admin/attendance/settings` | heure de clôture automatique, `require_admin` |

Le rejet du pop-up (« Pas au bureau aujourd'hui ») n'a pas de route : il est
purement côté client, mémorisé en `localStorage` avec la date du jour. Rien
n'est écrit en base, car une personne qui n'est pas venue ne doit laisser
aucune trace dans une table de présence.

### Réutilisation du check-in de réservation

`POST /api/reservations/{id}/checkin` existe déjà et remplit
`Reservation.checked_in_at`. Il appellera en plus
`attendance.check_in(db, user_id, source="reservation")`. Une seule vérité :
confirmer sa présence sur sa réservation, c'est aussi être dans les locaux.
`Reservation.checked_in_at` reste en place, il sert à la détection des
no-show, qui est une autre question.

## Interface

**Pop-up d'arrivée.** Au premier chargement de la journée, si
`/attendance/me` indique que rien n'est confirmé et que le jour est ouvré
(lundi à vendredi, heure locale du navigateur),
une modale s'ouvre avec trois actions : « Je suis arrivé », « Je suis
accompagné » (qui déplie un formulaire nom + société, répétable), et « Pas au
bureau aujourd'hui » qui ferme jusqu'au lendemain. Le site étant page
d'accueil imposée du navigateur chez EyeD, c'est le bon moment pour poser la
question. Elle ne revient pas une fois l'arrivée confirmée.

**Bouton de départ.** Visible dans l'entête tant que l'utilisateur est marqué
présent, avec confirmation.

**Vue « Dans les locaux ».** Nouvelle entrée de navigation. Liste les
employés présents et les visiteurs, avec le nom de l'hôte et la société pour
ces derniers. Visible par tous les employés. Les heures d'arrivée et de
départ ne sont **pas** affichées aux employés : un horodatage visible de tous
transforme l'outil en pointage. Un collègue peut ajouter ou faire partir un
visiteur qu'il a lui-même déclaré.

**Administration.** Section dédiée : l'heure de clôture automatique, la liste
complète avec heures et mention des départs non confirmés, et le bouton
d'export imprimable.

## Vérification

Le projet n'a pas de suite de tests. La vérification se fait donc en local,
serveur lancé, sur ce parcours, et le résultat de chaque étape est constaté
avant de déclarer le lot terminé :

1. la migration s'applique et se rejoue à l'envers sans erreur ;
2. un utilisateur sans arrivée voit le pop-up ; après confirmation il ne le
   revoit plus, même après rechargement ;
3. l'arrivée attribue les points une fois, pas deux ;
4. un départ puis une nouvelle arrivée le même jour laissent une seule ligne
   en base, avec l'`arrived_at` d'origine ;
5. deux visiteurs déclarés apparaissent dans « Dans les locaux » avec leur
   hôte, et le départ de l'un ne touche pas l'autre ;
6. une présence ouverte antérieure à aujourd'hui est clôturée au premier
   appel, avec `auto_closed = true` ;
7. l'export admin contient employés et visiteurs présents ;
8. un employé non administrateur reçoit 403 sur les routes admin ;
9. le check-in depuis une réservation crée bien la ligne d'`attendance`.

## Ce que cette spec ne fait pas

- Aucun décompte de temps de travail, aucune statistique d'heures par
  personne. L'outil répond à « qui est là », rien d'autre.
- Aucun badge physique ni géolocalisation.
- Les visiteurs ne consomment pas de poste et n'entrent pas dans les quotas
  de réservation.
