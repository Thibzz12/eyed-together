# Démarrage en local

Prérequis : Python 3.12 (voir `render.yaml` — la 3.14 casse la compilation de
`pydantic-core`, pas de wheel précompilé disponible au moment de l'écriture).

## 1. Environnement virtuel

```bash
cd backend
python -m venv .venv
# Windows :
.venv\Scripts\activate
# Linux/Mac :
source .venv/bin/activate
```

## 2. Dépendances

```bash
pip install -r requirements.txt
```

## 3. Configuration

```bash
copy .env.example .env      # cp sous Linux/Mac
```

Le `.env` par défaut fonctionne tel quel pour un développement basique
(SQLite, pas de SSO configuré). Pour activer une vraie connexion, voir
[`DEPLOYMENT.md`](DEPLOYMENT.md).

Sans `WP_APP_SECRET` ni identifiants Entra ID renseignés, utilise
`/auth/dev-login` pour te connecter (compte de démo, admin par défaut,
**automatiquement désactivé si `ENVIRONMENT=production`**).

## 4. Base de données

En développement (SQLite), les tables sont créées automatiquement au
démarrage (`Base.metadata.create_all`, voir `app/main.py` → `lifespan`) — pas
besoin de lancer Alembic à la main. Les données de démo (postes de
coworking, cartes du dashboard) sont créées si la base est vide.

Si tu modifies `app/db/models.py` et que tu veux que **la prod** (qui utilise
Alembic, jamais `create_all`) suive :

```bash
alembic revision --autogenerate -m "description du changement"
alembic upgrade head
```

Vérifier qu'Alembic n'a rien oublié de détecter :

```bash
alembic check
```

## 5. Lancer le serveur

```bash
uvicorn app.main:app --reload --port 8000
```

Ouvrir `http://localhost:8000`. Le frontend est servi directement par
FastAPI (pas de serveur de dev séparé, pas de build).

## Tester rapidement une fonctionnalité

- Se connecter : `http://localhost:8000/auth/dev-login` (mode démo, admin).
- Documentation interactive de l'API : `http://localhost:8000/docs`.
- Recharger le CSS/JS après une modification : le navigateur peut mettre en
  cache `app.js`/`styles.css`. `index.html` les référence avec un paramètre
  `?v=N` — **incrémenter ce numéro à chaque modification** de l'un des deux
  fichiers, sinon le navigateur du testeur (ou le tien avec un cache
  agressif) ne verra pas le changement. Sinon, rechargement forcé
  (Ctrl+Maj+R).

## Style de code à respecter

- **Commentaires en français**, qui expliquent le *pourquoi* (une contrainte,
  une décision produit, un piège déjà rencontré), pas le *quoi* (le code
  déjà lisible n'a pas besoin d'être reformulé en commentaire).
- Pas de nouvelle dépendance frontend (voir `docs/ARCHITECTURE.md` — choix
  assumé de rester en JS natif).
- Avant d'ajouter une table/colonne pour un simple réglage admin, vérifier si
  `AppSetting` (clé/valeur) ne suffit pas.
- Toute tâche "automatique" (rappel, pénalité, badge) doit être **idempotente**
  et recalculée à la volée (pas de nouveau scheduler sans en discuter — voir
  `docs/ARCHITECTURE.md`).
