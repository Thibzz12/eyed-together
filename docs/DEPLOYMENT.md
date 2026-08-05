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
| `ENVIRONMENT` | `production` | Désactive `/auth/dev-login`, force les cookies `Secure`, et confie le schéma à Alembic (jamais `create_all`) |
| `SECRET_KEY` | générée automatiquement par Render | Signe les cookies de session |
| `DATABASE_URL` | PostgreSQL Supabase, saisie **à la main** dans le dashboard Render (`sync: false`) | Contient un mot de passe : jamais dans le dépôt. Voir « Base de données » ci-dessous |
| `FRONTEND_ORIGIN` | `https://eyedtogether.onrender.com` | Doit correspondre exactement à l'URL publique (CORS) |
| `WORDPRESS_URL` | `https://weared.team` | Intranet source des événements/actus |
| `WP_APP_SECRET` | à renseigner manuellement dans le dashboard Render (`sync: false`) | Voir section pont WordPress ci-dessous |
| `ADMIN_EMAILS` | à renseigner manuellement (`sync: false`) | Emails séparés par des virgules |

## Base de données : PostgreSQL (Supabase)

**Ne jamais remettre une URL SQLite en production.** Le disque d'un service
Render gratuit est éphémère : le conteneur est reconstruit à chaque
redéploiement et à chaque réveil après mise en veille (~15 min sans trafic).
Un fichier `coworking.db` y disparaît donc avec *toutes* les données —
comptes, réservations, liens utiles, idées. C'est exactement le bug qui a
motivé la migration ; l'app repartait à zéro sans le moindre message d'erreur.

La base est un projet **Supabase** dédié (plan gratuit, sans expiration).

### Construire `DATABASE_URL`

Dans Supabase : *Connect* → *Direct / Connection string* → méthode
**Session pooler**. La connexion directe est **IPv6 uniquement** alors que
Render sort en IPv4 : elle échouerait.

```
postgresql+psycopg2://postgres.<ref-projet>:<mot-de-passe>@aws-1-<region>.pooler.supabase.com:5432/postgres
```

Deux pièges :

- Le préfixe doit être `postgresql+psycopg2://` (Supabase affiche
  `postgresql://`), sinon SQLAlchemy ne sait pas quel pilote charger.
- **Percent-encoder** les caractères spéciaux du mot de passe : `+` → `%2B`,
  `@` → `%40`, `#` → `%23`. Sans ça, l'URL est mal découpée.

### Migrations

`render.yaml` lance `alembic upgrade head` avant `uvicorn` : le schéma est
donc mis à jour à chaque démarrage, et le conteneur refuse de démarrer si une
migration échoue (plutôt que de servir un schéma incohérent). Rien à faire
manuellement.

Note : `alembic/env.py` construit son moteur directement avec `create_engine`
et n'écrit **jamais** l'URL dans la config Alembic. Celle-ci passe par
`configparser`, où `%` amorce une interpolation — un mot de passe
percent-encodé y déclencherait un `ValueError` au démarrage.

### Données de référence

En production, les seeds (postes, bulles calmes, liens utiles, cartes
d'accueil, badges) ne s'exécutent **que si la base est vierge**. Les rejouer à
chaque démarrage ressusciterait les éléments par défaut qu'un admin a
volontairement supprimés.

## Autres points de vigilance

- **`SECRET_KEY`** : `generateValue: true` la génère une fois à la création du
  service et la conserve. Ne jamais la réutiliser entre environnements — la
  changer déconnecte toutes les sessions en cours.
- **`FRONTEND_ORIGIN`** : à mettre à jour si le domaine change (domaine
  personnalisé EyeD par exemple), sinon le CORS bloque le frontend.
- **`WP_APP_SECRET`** : indispensable depuis le passage en `production`, car
  `/auth/dev-login` est désactivé — le pont WordPress est le seul moyen de se
  connecter.
- **Service « Blueprint managed »** : les variables déclarées avec `value:`
  dans `render.yaml` sont réécrites à chaque déploiement. Seules celles en
  `sync: false` se modifient depuis le dashboard.

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
      nouveau) : elles s'appliquent automatiquement au démarrage.
- [ ] `DATABASE_URL` pointe bien sur PostgreSQL, jamais sur SQLite.
- [ ] `ADMIN_EMAILS` à jour (qui doit avoir accès à l'onglet Administration).
- [ ] Secrets (`WP_APP_SECRET`, `SECRET_KEY`) jamais committés — toujours via
      les variables d'environnement de la plateforme d'hébergement.
