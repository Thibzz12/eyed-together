# Déploiement

## Pourquoi Render.com

L'hébergement mutualisé fourni par EyeD (weared.team) est un compte
PHP/WordPress classique, sans support Python (vérifié en explorant sa
structure : uniquement du PHP). Render.com héberge donc l'app pour l'instant
(`render.yaml` à la racine du repo, déploiement automatique depuis GitHub).

## Configuration Render actuelle (`render.yaml`)

| Variable | Valeur / origine | Remarque |
|---|---|---|
| `PYTHON_VERSION` | `3.12.7` figé | La 3.14 par défaut de Render échoue à compiler `pydantic-core` (pas de wheel précompilé) |
| `ENVIRONMENT` | `development` | Volontaire pour l'instant : garde la création auto des tables (SQLite) et `/auth/dev-login` actif, pratique tant que l'app est en phase de test. **À repasser en `production` avant un vrai lancement** (voir plus bas) |
| `SECRET_KEY` | générée automatiquement par Render | Signe les cookies de session |
| `DATABASE_URL` | `sqlite:///./coworking.db` | ⚠️ Le disque de Render (plan gratuit) n'est pas persistant entre déploiements — passer en PostgreSQL avant la mise en prod réelle |
| `FRONTEND_ORIGIN` | `https://eyedtogether.onrender.com` | Doit correspondre exactement à l'URL publique (CORS) |
| `WORDPRESS_URL` | `https://weared.team` | Intranet source des événements/actus |
| `WP_APP_SECRET` | à renseigner manuellement dans le dashboard Render (`sync: false`) | Voir section pont WordPress ci-dessous |
| `ADMIN_EMAILS` | à renseigner manuellement (`sync: false`) | Emails séparés par des virgules |

## Basculer en vraie production

Avant un lancement réel (pas juste un test), il reste à faire :

1. **Base de données** : passer `DATABASE_URL` sur une instance PostgreSQL
   (Render propose un plan gratuit). Le code est déjà compatible (`psycopg2`
   dans `requirements.txt`, pas de SQL spécifique à SQLite).
2. **`ENVIRONMENT=production`** : désactive `/auth/dev-login` et bascule le
   schéma de base sur Alembic (`alembic upgrade head`) au lieu de
   `create_all`. **Faire tourner les migrations avant de basculer**, sinon la
   base sera vide au premier déploiement en mode production.
3. **`SECRET_KEY`** : régénérer une vraie valeur aléatoire pour cet
   environnement (`generateValue: true` dans `render.yaml` s'en charge déjà
   à chaque nouveau service, mais vérifier qu'elle n'est jamais réutilisée
   entre environnements).
4. **`FRONTEND_ORIGIN`** : mettre à jour si le domaine change (domaine
   personnalisé EyeD par exemple).

## SSO : deux options, une seule à activer en prod

### Option A — Pont WordPress (utilisée actuellement)

Le plugin `wordpress/eyed-app-auth.php` doit être posé sur l'intranet
WordPress (en Code Snippet, ou comme plugin classique) :

1. Générer un secret aléatoire : `python -c "import secrets; print(secrets.token_hex(32))"`.
2. Remplacer `EYED_APP_SECRET` dans le fichier PHP par cette valeur.
3. Mettre `EYED_APP_CALLBACK` sur l'URL réelle de l'app :
   `https://<domaine-app>/auth/wordpress-callback`.
4. Renseigner la **même** valeur secrète dans `WP_APP_SECRET` côté app
   (variable d'environnement Render, ou `.env` en local).
5. **Ne jamais committer** la vraie valeur du secret dans un des deux dépôts
   — les fichiers présents dans ce repo (`wordpress/eyed-app-auth.php`,
   `.env.example`) ne contiennent que des placeholders.

Le flux : `/auth/wordpress-start` → intranet (login si besoin) → jeton signé
HMAC-SHA256 renvoyé vers `/auth/wordpress-callback` (2 minutes de validité).

### Option B — Microsoft Entra ID (SSO alternatif, prêt mais pas branché)

1. Créer une **App Registration** sur `portal.azure.com`.
2. Renseigner `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`.
3. Ajouter l'URI de redirection exacte dans la config Azure :
   `https://<domaine-app>/auth/callback`.
4. Mettre à jour `ENTRA_REDIRECT_URI` côté app en conséquence.

Tant que ces 3 variables Entra ne sont pas renseignées,
`/auth/login` affiche un message clair ("SSO non configuré") plutôt que de
planter.

## Checklist avant un déploiement

- [ ] `PYTHON_VERSION` toujours figé sur une version avec wheels précompilés
      pour `pydantic-core` (vérifier si la version par défaut de Render a
      changé).
- [ ] Migrations Alembic à jour (`alembic check` ne doit rien détecter de
      nouveau) si `ENVIRONMENT=production`.
- [ ] `ADMIN_EMAILS` à jour (qui doit avoir accès à l'onglet Administration).
- [ ] Secrets (`WP_APP_SECRET`, `SECRET_KEY`) jamais committés — toujours via
      les variables d'environnement de la plateforme d'hébergement.
