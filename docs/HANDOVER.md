# Passation — état réel du projet

Ce document dit **ce qui n'est pas fini, pas testé, ou fragile**, pour qu'un
nouveau développeur (ou un stagiaire qui reprend la suite) ne le découvre pas
à la dure. Rien ici n'est une critique du travail fait — c'est l'état réel
d'un projet développé en continu par une seule personne, sur plusieurs
semaines, avec des priorités produit qui ont évolué en cours de route (voir
[`PROGRESS.md`](../PROGRESS.md) pour le détail chronologique).

## ⚠️ Le plus important : aucun test automatisé

**Il n'existe aucun fichier de test dans ce projet** (ni `pytest`, ni test
JS). Chaque fonctionnalité listée comme "testée" dans `PROGRESS.md` a été
vérifiée **manuellement** au moment de sa livraison, une fois, dans le
navigateur — jamais rejouée depuis.

Conséquence concrète : si tu modifies `app/services/reservations.py` (règles
anti-abus, no-show, réservation de salle entière) ou `app/services/badges.py`
(attribution automatique), **rien ne te dira si tu casses un cas déjà
géré**. C'est le risque technique n°1 de ce projet, largement avant tout
problème de documentation.

Si tu as le temps d'ajouter une seule chose avant de continuer à construire
dessus : des tests `pytest` sur `services/reservations.py` (règles de
booking) et `services/badges.py` (attribution/paliers) — c'est là que la
logique est la plus dense et la plus risquée à modifier à l'aveugle.

## Dépendance déclarée mais jamais utilisée

`slowapi` (rate limiting / anti brute-force) est dans `requirements.txt`
mais **n'apparaît nulle part dans le code** (`grep -rn slowapi app/` ne
renvoie rien) — probablement ajoutée en anticipation d'un chantier sécurité
qui n'a jamais été fait. Pas de rate limiting nulle part dans l'app
actuellement. À évaluer si un jour un endpoint accepte à nouveau un mot de
passe (voir point suivant).

**✅ Corrigé (2026-08-03)** : un ancien endpoint `POST /auth/wordpress-login`
acceptait un email + mot de passe et les transmettait à une route WordPress
(`wp-json/eyed/v1/login`) qui n'a jamais existé côté intranet — l'endpoint
échouait donc systématiquement, mais restait accessible et sans aucune
limite de tentatives (code mort côté écran de connexion, qui n'a jamais eu
de formulaire correspondant, mais bien vivant côté API). Supprimé avec son
code associé (`authenticate_wp`/`WordPressAuthError` dans `wordpress.py`,
`setupLoginForm()` dans `app.js`). **Le chemin de connexion réellement
utilisé** (bouton "Se connecter avec mon compte EyeD" → pont WordPress) n'a
jamais été concerné : le mot de passe est saisi sur la page de connexion de
WordPress lui-même, jamais transmis à notre backend.

## Limites connues (assumées, mais à ne pas oublier)

| Sujet | Limite | Pourquoi |
|---|---|---|
| Base de données en prod | SQLite sur le disque Render (plan gratuit, **non persistant** entre déploiements) | Phase de test ; passer en PostgreSQL avant un vrai lancement (voir `DEPLOYMENT.md`) |
| `ENVIRONMENT` sur Render | `development` (pas `production`) | Volontaire pour l'instant : garde `/auth/dev-login` actif et la création auto des tables — à corriger avant un vrai lancement |
| Emails / Teams / push | Aucun envoi externe, tout est in-app | Aucune infra d'envoi (SMTP, compte M365) n'a jamais existé dans le projet |
| Dates d'événements | Dépend d'un champ ACF exposé côté WordPress (`acf.date`) | Si ce réglage WordPress est un jour désactivé ou renommé côté intranet, l'app se rabat silencieusement sur la date de publication — aucune alerte ne préviendrait |
| Anniversaires | Auto-déclarées par chaque employé (ou saisies par un admin) | Pas de champ fiable exposé par l'API REST WordPress au moment du développement |
| Médias | Liens externes uniquement, jamais d'upload | Décision produit (simplicité), pas une limite technique |
| SSO Microsoft Entra ID | Codé et prêt, **jamais utilisé en conditions réelles** | Le pont WordPress est le seul chemin de connexion réellement éprouvé en prod |
| Site web interne WordPress | Chantier séparé, pas commencé | Périmètre jamais défini avec EyeD (cf. `PROGRESS.md`) |

## Qui contacter pour quoi

- **Décisions produit** (nouvelle fonctionnalité, priorité, arbitrage
  fonctionnel) : Thibaud Pirard.
- **Accès admin de l'app** (`ADMIN_EMAILS`) et **accès WordPress/intranet**
  (pour poser le plugin `wordpress/eyed-app-auth.php`, activer un champ ACF
  dans l'API REST…) : Thibaud Pirard, avec Olivier Vanbrabant en second admin
  actuel de l'app.
- **Hébergement** : compte Render.com du projet (`eyedtogether`) — accès à
  demander à Thibaud.

## Avant de commencer à modifier le code

1. Lire [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) en entier (15 min).
2. Faire tourner le projet en local ([`docs/SETUP.md`](SETUP.md)).
3. Si la modification touche les réservations ou la gamification : relire
   les docstrings de `reservations.py`/`badges.py` en entier avant de toucher
   quoi que ce soit — la logique anti-abus est dense et les règles ne sont
   pas toujours évidentes à deviner depuis le seul nom des fonctions.
4. Toujours incrémenter `?v=N` sur `app.js`/`styles.css` dans `index.html`
   après une modification frontend (sinon le cache navigateur masque le
   changement — piège classique de ce projet, sans build step).
