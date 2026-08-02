# Architecture

Ce document explique **comment le projet est construit** et **pourquoi**, pour
qu'un nouveau développeur puisse s'orienter sans avoir à tout relire depuis
zéro. Pour l'historique complet de chaque décision (avec le contexte exact du
moment), voir [`PROGRESS.md`](../PROGRESS.md) à la racine — c'est le journal
de bord tenu tout au long du développement, très détaillé.

## Vue d'ensemble

```
┌─────────────────────────┐      SSO       ┌──────────────────────────┐
│   Navigateur (frontend) │◄──────────────►│  Intranet WordPress       │
│   HTML/CSS/JS natif     │   (2 options)  │  weared.team               │
└───────────┬─────────────┘                └───────────┬──────────────┘
            │  fetch() JSON                             │ API REST WP
            ▼                                           │ (événements, actus,
┌─────────────────────────┐                             │  recherche)
│   FastAPI (backend)     │◄────────────────────────────┘
│   app/                  │
└───────────┬─────────────┘
            │ SQLAlchemy
            ▼
┌─────────────────────────┐
│  SQLite (dev) /          │
│  PostgreSQL (prod)       │
└─────────────────────────┘
```

Le backend sert **aussi** le frontend (fichiers statiques dans
`backend/app/static/`) : un seul processus à déployer, pas de CORS à gérer
entre deux domaines en prod.

## Pourquoi pas de framework frontend ?

Décision assumée dès le départ : `app.js` (~2400 lignes) est un unique fichier
JavaScript natif, organisé en sections commentées (une par écran), plutôt que
React/Vue + build step. Avantages recherchés : n'importe quel développeur peut
reprendre le projet sans connaître un framework précis, pas de `node_modules`,
pas d'étape de compilation, déploiement trivial. Le compromis assumé : pas de
composants réutilisables au sens framework, un peu de duplication entre écrans
similaires.

Pour s'orienter dans `app.js`, chercher les séparateurs de section :

```js
/* ============================================================
   VUE : ACCUEIL (tableau de bord administrable)
   ============================================================ */
```

Sections principales (dans l'ordre du fichier) : démarrage/routing, Accueil,
Administration (avec ses propres sous-sections par onglet), Réserver,
Événements, Ma présence, Boîte à idées, Recherche, Quiz, Médias,
Notifications, Profil.

`styles.css` suit la même logique de sections commentées. Les couleurs,
polices et rayons de la charte EyeD Pharma sont des variables CSS (`:root`)
en haut du fichier — ne jamais coder une couleur en dur ailleurs.

## Backend : structure des dossiers

```
backend/app/
  main.py          Point d'entrée : middlewares, montage des routes, lifespan
  api/router.py    Tous les endpoints métier (préfixe /api), protégés par SSO
  auth/            Routes de connexion : SSO Entra ID + pont WordPress
    msal_client.py   Client MSAL (Entra ID)
    router.py        /auth/login, /auth/callback, /auth/wordpress-*, /auth/dev-login
  core/
    config.py             Variables d'environnement (Settings, pydantic-settings)
    security_headers.py   CSP, HSTS, X-Frame-Options, etc.
  db/
    models.py    Modèles ORM SQLAlchemy (la structure des tables)
    session.py   Moteur + fabrique de sessions (get_db)
    base.py      Base déclarative
    seed.py      Données de démo (postes, cartes du dashboard) + nettoyages idempotents
  services/      Logique métier, un fichier par domaine — voir tableau ci-dessous
  schemas.py     Schémas Pydantic (validation des requêtes/réponses API)
  deps.py        Dépendances FastAPI réutilisables (get_current_user, require_admin)
  floorplan.py   Coordonnées (x, y) des postes sur le plan du bureau
  static/        Le frontend : index.html, app.js, styles.css, fonts/, img/
alembic/         Migrations de base de données (une par évolution du schéma)
```

### Les services (logique métier)

Chaque fichier de `services/` est indépendant du web (pas d'objets FastAPI
dedans) : il prend une `Session` SQLAlchemy et des valeurs simples, renvoie
des modèles ou des dicts. `api/router.py` ne fait qu'appeler ces fonctions et
traduire leurs exceptions en réponses HTTP.

| Fichier | Domaine |
|---|---|
| `reservations.py` | Réservation de postes/salles/bulles calmes, règles anti-abus (horizon, jours consécutifs, week-end), check-in, no-show |
| `users.py` | Création/mise à jour d'un utilisateur depuis les claims SSO, synchronisation du rôle admin |
| `wordpress.py` | Lecture de l'API REST WordPress (événements, actus), pont d'authentification signé |
| `dashboard.py` | Assemblage des cartes de l'accueil (admin peut activer/réordonner/mettre en avant), catalogue des statuts de présence |
| `gamification.py` | Attribution de points (journal `PointTransaction`, append-only) |
| `badges.py` | Catalogue de badges (dont familles à paliers I/II/III/IV), attribution auto + manuelle |
| `profile.py` | Profil public d'un collaborateur (progression de niveau à paliers infinis) |
| `events.py` | Inscriptions aux événements WordPress, liste d'attente automatique, export .ics |
| `ideas.py` | Boîte à idées : soumission, votes, commentaires, workflow de statut |
| `quiz.py` | Quiz et sondages : passation, correction, classement |
| `media.py` | Bibliothèque de médias (toujours des liens externes, jamais d'upload) |
| `notifications.py` | Notifications in-app (rappels automatiques + notifications admin manuelles) |
| `search.py` | Recherche globale (agrège collaborateurs, événements, actus, idées, liens) |
| `stats.py` | Cockpit admin : KPI agrégés + alertes |

### Le modèle de données

30 tables environ (`db/models.py`). Les plus centrales :

| Modèle | Rôle |
|---|---|
| `User` | Un employé (créé à la 1re connexion SSO, jamais manuellement) |
| `Desk` | Un poste de coworking (bureau fermé, open space, ou bulle calme) |
| `Reservation` | Une place réservée (demi-journée, journée, ou créneau horaire pour les bulles) |
| `PointTransaction` | Journal des points gagnés/perdus — **source de vérité**, `User.total_points` n'en est que le cumul |
| `Badge` / `UserBadge` | Récompenses (relation N-N), certains badges ont des paliers |
| `DailyStatus` | Statut déclaré par un employé (coworking/télétravail/…), matin **et** après-midi séparément |
| `DashboardCard` | Configuration admin de l'accueil (activée, ordre, mise en avant) |
| `AppSetting` | Table clé/valeur générique pour tout réglage qui ne mérite pas sa propre table (catalogue de statuts, jalon projet, libellés de salles…) |

`AppSetting` revient souvent : c'est le choix par défaut de ce projet pour un
réglage admin simple, plutôt que d'ajouter une colonne/table à chaque fois.

### Authentification : deux mécanismes, un seul concept de session

Une fois connecté par n'importe quelle méthode, l'utilisateur a une session
signée (cookie httpOnly, `itsdangerous`, 8h). Le reste de l'app ne sait pas
par quel chemin il est arrivé.

1. **Pont WordPress** (utilisé en prod) : `/auth/wordpress-start` renvoie vers
   l'intranet ; si déjà connecté là-bas, WordPress renvoie un jeton signé
   (HMAC-SHA256, `WP_APP_SECRET` partagé) vers `/auth/wordpress-callback`.
   Le plugin PHP correspondant est dans `wordpress/eyed-app-auth.php` (à
   poser sur WordPress, pas dans ce déploiement).
2. **Microsoft Entra ID** (SSO alternatif, prêt mais pas branché en prod) :
   `/auth/login` → Microsoft → `/auth/callback`, via MSAL (Authorization Code
   Flow + PKCE).
3. **`/auth/dev-login`** : connexion factice, **désactivée automatiquement en
   production** (`settings.is_production`), pour développer/tester sans
   dépendre d'Azure ni de l'intranet.

L'accès à l'onglet Administration est décidé par une **liste blanche
d'emails** (`ADMIN_EMAILS`), vérifiée à **chaque connexion** — pas par le rôle
WordPress (un admin WordPress n'est pas forcément admin de l'app).

### API : carte des endpoints (`/api/...`, préfixés, tous protégés par session)

| Domaine | Exemples |
|---|---|
| Profil & auth | `GET /profile`, `PUT /profile/birthday` |
| Coworking | `GET /desks`, `GET /availability`, `POST /reservations`, `POST /reservations/room`, `POST /reservations/timeslot`, `POST /reservations/{id}/checkin` |
| Présence | `GET/PATCH /statuses`, `GET /status/me` |
| Accueil | `GET /dashboard`, `GET/PATCH /admin/dashboard` |
| Événements | `GET /events`, `POST /events/{id}/register`, `GET /events/{id}/ics` |
| Idées | `GET/POST /ideas`, `POST /ideas/{id}/vote` |
| Quiz | `GET /quizzes`, `POST /quizzes/{id}/attempt` |
| Médias | `GET /media`, `POST /media/{id}/comments` |
| Notifications | `GET /notifications`, `POST /notifications/{id}/read` |
| Recherche | `GET /search?q=` |
| Gamification | `GET /leaderboard`, `GET/POST/PATCH/DELETE /admin/badges` |
| Administration | `/admin/desks`, `/admin/statuses`, `/admin/links`, `/admin/users`, `/admin/stats`, `/admin/quizzes`, `/admin/media`, `/admin/events/{id}/*` |

La liste exacte (avec les schémas de requête/réponse) est dans
`backend/app/api/router.py` — chaque fonction a une docstring en une ligne.
Alternative : lancer le serveur et ouvrir `/docs` (Swagger généré
automatiquement par FastAPI).

## Décisions structurantes à connaître

Ces choix reviennent souvent et évitent de se poser la question à chaque
nouvelle fonctionnalité :

- **Pas de scheduler/cron.** Les tâches périodiques (rappels d'événements,
  pénalités no-show, attribution de badges) sont recalculées **à la volée** à
  chaque chargement du tableau de bord, de façon idempotente (jamais
  appliquées deux fois). Suffisant pour le volume d'un MVP interne ; si ça
  devient un problème de perf, c'est le premier endroit où introduire un vrai
  scheduler (APScheduler, Celery…).
- **WordPress reste la source de vérité du contenu.** Événements et actus ne
  sont jamais dupliqués en base : l'app lit l'API REST WordPress à la volée
  (avec un cache 5 min), ne stocke que ce qui lui est propre (inscriptions,
  capacités).
- **Pas d'email/Teams/push.** Aucune infrastructure d'envoi n'existe dans le
  projet ; les notifications sont in-app uniquement. À réévaluer si un
  serveur SMTP ou un compte applicatif M365 devient disponible.
- **Médias = liens externes uniquement**, jamais d'upload/stockage de
  fichiers sur le serveur (décision produit, pas une limite technique).
- **`AppSetting` avant une nouvelle table/colonne** pour tout réglage admin
  simple (voir plus haut).
- **CSP stricte** (`core/security_headers.py`) : `script-src 'self'`
  uniquement — pas de CDN externe possible côté JS. C'est pourquoi les
  graphiques du cockpit admin sont en SVG fait main plutôt qu'avec une
  librairie comme Chart.js.
