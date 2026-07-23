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
- [ ] **Pénalité no-show** : si réservé mais pas venu → perte de points. Nécessite un mécanisme de **check-in** (bouton "je suis arrivé" ou badge/QR) pour distinguer réservé-et-venu de réservé-et-absent

## ⏭️ Reste du cahier des charges (Présence & Coworking)

- [ ] Réservation d'espaces entiers (réserver un bureau/une salle en un clic, pas poste par poste)
- [ ] Statuts configurables (l'admin gère la liste, pas codée en dur)

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
- [ ] Migrations Alembic à jour (actuellement `create_all` en dev pour les nouvelles tables : DailyStatus, DashboardCard, AppSetting, colonnes pos_x/pos_y — il faudra générer une vraie migration Alembic avant la prod)

## Comment on l'utilise

Dis-moi juste **"prochaine étape : X"** en pointant une ligne de cette liste, je n'ai pas besoin qu'on réexplique le contexte à chaque fois. Je coche au fur et à mesure ici.
