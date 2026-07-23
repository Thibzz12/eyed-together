# EyeD Together — Suivi d'avancement

_Dernière mise à jour : 2026-07-23_

## ✅ Fait (testé en conditions réelles)

- **Auth** : pont SSO WordPress (Magic Login compatible, sans mot de passe manipulé)
- **Coworking** : réservation matin/après-midi/journée, 2 bureaux fermés (6pl.) + open space (4 tables), widget table+sièges avec initiales visibles, plan réel (image PDF) en dessous
- **Présence** : déclaration statut (coworking/télétravail/déplacement/congé)
- **Accueil** : tableau de bord administrable (cartes activables/réordonnables/mises en avant), bannière projet, présents du jour, événements/actus WordPress en direct, services rapides
- **Gamification** : points, niveaux (Bronze→Platine)
- **Admin** : gestion postes/capacités, ordre des cartes accueil, progression projet
- **Design** : charte EyeD reproduite (navy/bleu ciel, Plus Jakarta Sans), mobile-first responsive
- **Infra** : repo GitHub créé et poussé (`Thibzz12/eyed-together`)

## 🆕 Checklist

- [x] **Limite de réservation** — FAIT (2026-07-23) : horizon max **7 jours calendaires**, max **5 jours ouvrés consécutifs**, **pas de réservation le week-end**. `app/services/reservations.py` (`MAX_ADVANCE_DAYS`, `MAX_CONSECUTIVE_DAYS`, `_check_booking_policy`). Sélecteur de jours du front ne montre que les jours ouvrés. Testé (weekend/horizon/consécutif) OK.
- [x] **Pénalité no-show + check-in** — FAIT (2026-07-23) :
  - `ReservationStatus.NO_SHOW` + colonne `Reservation.checked_in_at` (migration Alembic générée et vérifiée)
  - `check_in()` : bouton "Je suis arrivé" (accueil + Mes réservations), uniquement le jour même, idempotent
  - `apply_noshow_penalties()` : réservations passées jamais confirmées → statut `no_show` + **-10 pts**. Appliqué à la volée au chargement du tableau de bord (pas de scheduler pour un MVP). Idempotent (pas de double pénalité).
  - Testé : pénalité appliquée + idempotente, check-in fonctionnel (accueil ↔ Mes réservations cohérents), check-in refusé sur une résa passée, mobile sans débordement.

## ⏭️ Reste du cahier des charges (Présence & Coworking)

- [ ] Réservation d'espaces entiers (réserver un bureau/une salle en un clic, pas poste par poste)
- [x] Statuts configurables — FAIT (2026-07-23) : l'admin peut activer/désactiver quels statuts (coworking/télétravail/déplacement/congé) sont proposés aux employés (Administration → Accueil → "Statuts de présence proposés"). Catalogue de statuts fixe (pas de création de nouveaux types à la volée — hors scope MVP), mais l'activation est bien pilotée par l'admin, sans toucher au code. Réutilise la table `AppSetting` existante (pas de migration). `GET /api/statuses` (public), `GET/PUT /api/admin/statuses`. Testé : désactivation persistée en base, reflétée sur Accueil + Ma présence, réactivation OK, mobile sans débordement.

## ⏭️ Modules non commencés (cahier des charges complet)

- [ ] Événements (inscriptions, liste d'attente, rappels, calendrier, export Outlook)
- [ ] Quiz (QCM, classements, badges, intégration Kahoot)
- [ ] Médias (bibliothèque vidéo, albums photos)
- [ ] Notifications (email/Teams/push configurables)
- [ ] Recherche globale
- [ ] Boîte à idées
- [ ] Cockpit admin avancé (KPI, stats, alertes)

## 🌐 Site web interne (WordPress) — chantier séparé

- [ ] Pas commencé (périmètre à définir avec EyeD)

## 🚀 Déploiement

- [ ] Hébergement réel (fourni par EyeD — à confirmer)
- [ ] `EYED_APP_CALLBACK` (WordPress) → passer de localhost au vrai domaine
- [ ] Régénérer le secret partagé pour la prod
- [x] Migrations Alembic à jour — FAIT (2026-07-23) : migration de rattrapage générée (`440c5f41be08_daily_status_dashboard_cards_app_.py`) pour DailyStatus, DashboardCard, AppSetting, colonnes pos_x/pos_y. Vérifié sur base temporaire : upgrade → `alembic check` confirme "No new upgrade operations detected" (schéma = modèles), downgrade puis re-upgrade OK. Le dev continue d'utiliser `create_all` (pratique, inchangé) ; c'est la **prod** qui bénéficiera de cette migration via `alembic upgrade head`.

## Comment on l'utilise

Dis-moi juste **"prochaine étape : X"** en pointant une ligne de cette liste, je n'ai pas besoin qu'on réexplique le contexte à chaque fois. Je coche au fur et à mesure ici.
