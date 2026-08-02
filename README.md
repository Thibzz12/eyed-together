# EyeD Together

Application interne de coworking et de vie d'entreprise pour **EyeD Pharma** :
réservation de postes, présence, événements, quiz, boîte à idées, médias,
gamification (points/niveaux/badges) — connectée en SSO à l'intranet
WordPress de l'entreprise (weared.team).

C'est une app **web mono-repo** : un backend FastAPI qui sert aussi le frontend
(HTML/CSS/JS natif, pas de framework front, pas de build step).

## Démarrer ici

| Besoin | Document |
|---|---|
| Faire tourner le projet en local | [`docs/SETUP.md`](docs/SETUP.md) |
| Comprendre comment le projet est construit (stack, structure, décisions) | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Déployer / configurer la prod (Render, SSO, pont WordPress) | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| **Ce qui n'est pas fini / pas testé / fragile — à lire avant de modifier quoi que ce soit** | [`docs/HANDOVER.md`](docs/HANDOVER.md) |
| Historique détaillé de chaque fonctionnalité livrée, avec le contexte et les décisions prises | [`PROGRESS.md`](PROGRESS.md) |
| Utiliser l'app au quotidien (collaborateurs) | Écran **Aide** dans l'app (icône `?` du menu) |

> ⚠️ **Aucun test automatisé** n'existe dans ce projet à ce jour — voir
> [`docs/HANDOVER.md`](docs/HANDOVER.md) pour le détail et les zones les
> plus risquées à modifier sans filet.

## Stack en une phrase

FastAPI + SQLAlchemy 2.0 + Alembic (SQLite en dev, PostgreSQL en prod) côté
serveur ; HTML/CSS/JS natif (aucune dépendance front) servi directement par
FastAPI ; authentification via SSO Microsoft Entra ID **ou** pont SSO
WordPress (au choix, voir `docs/ARCHITECTURE.md`).

## Structure du repo

```
backend/            API FastAPI + frontend statique
  app/
    api/router.py      endpoints métier (/api/...)
    auth/               SSO (Entra ID + pont WordPress)
    core/               config, en-têtes de sécurité
    db/                 modèles ORM, migrations Alembic, seed de démo
    services/           logique métier (1 fichier par domaine)
    static/             frontend : index.html, app.js, styles.css
  alembic/            migrations de base de données
wordpress/           plugin PHP du pont SSO (à poser sur l'intranet)
render.yaml          config de déploiement Render.com
PROGRESS.md          journal de bord détaillé du développement
```

## Pourquoi si peu de dépendances front ?

Choix assumé dès le départ : pas de React/Vue ni de bundler, pour rester
simple à reprendre par n'importe quel développeur sans connaître un
écosystème front spécifique. `app.js` est un gros fichier organisé en
sections (une par écran) plutôt qu'en multiples petits modules — voir
`docs/ARCHITECTURE.md` pour s'y retrouver.
