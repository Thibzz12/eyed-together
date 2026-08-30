"""Positions des postes sur le plan des locaux (vue de dessus).

Coordonnées en POURCENTAGE (0–100) de la largeur et de la hauteur de l'image :
x = horizontal, y = vertical. Le pourcentage plutôt que le pixel permet au plan
de se redimensionner avec la fenêtre sans décaler les pastilles.

Ces valeurs sont relevées sur le plan réel fourni par Olivier le 24/08/2026
(`app/static/img/floorplan.jpg`), chaise par chaise, de la gauche vers la
droite :

    Table 1 (4) · Table 2 (4) · Table 3 (6) · Table 4 (6)
    Bureau 1 (6, salle fermée du milieu, notée "Bureau 2" sur le plan)
    Bulle Maldives · Bulle Seychelles
    Bureau 2 (6, salle fermée de droite, notée "Bureau Réservé RH / Admin /
    Finance / Legal / IT / EHS" sur le plan)

Attention au décalage entre le nom interne d'une zone et son nom affiché : le
plan ne connaît qu'un seul bureau ouvert à la réservation, qu'il appelle
« Bureau 2 », et une salle réservée aux services support. Les clés `Bureau 1` /
`Bureau 2` restent les identifiants techniques des deux salles fermées, leur
libellé se règle depuis l'administration (Noms affichés). C'est l'inversion
signalée par Olivier le 29/08/2026 : les pastilles de la salle du milieu se
posaient dans la salle de droite et inversement, si bien que les collègues
réservés dans le « Bureau 2 » apparaissaient dans le bureau réservé.

Si l'image du plan est remplacée depuis l'administration et que le cadrage
change, ces positions se décalent : l'écran « Placer les postes sur le plan »
(Administration → Coworking) permet alors de tout reposer au clic, sans
toucher à ce fichier. Ce module ne sert plus que de position de départ pour
une base neuve.
"""

# nom du poste -> (x, y) en %
DESK_POSITIONS: dict[str, tuple[float, float]] = {
    # --- Open space : Table 1, 4 places (2 x 2) ---
    "T1-1": (8.0, 57.0), "T1-2": (13.5, 57.0),
    "T1-3": (8.0, 73.0), "T1-4": (13.5, 73.0),
    # --- Open space : Table 2, 4 places (2 x 2) ---
    "T2-1": (17.5, 57.0), "T2-2": (23.0, 57.0),
    "T2-3": (17.5, 73.0), "T2-4": (23.0, 73.0),
    # --- Open space : Table 3, 6 places (3 rangées de 2), sous le local Print ---
    "T3-1": (29.5, 40.0), "T3-2": (35.0, 40.0),
    "T3-3": (29.5, 57.0), "T3-4": (35.0, 57.0),
    "T3-5": (29.5, 73.0), "T3-6": (35.0, 73.0),
    # --- Open space : Table 4, 6 places (3 rangées de 2) ---
    "T4-1": (38.5, 40.0), "T4-2": (44.0, 40.0),
    "T4-3": (38.5, 57.0), "T4-4": (44.0, 57.0),
    "T4-5": (38.5, 73.0), "T4-6": (44.0, 73.0),
    # --- Bureau 1 : salle fermée du milieu (« Bureau 2 » sur le plan),
    #     3 places de chaque côté de la table ---
    "B1-1": (56.5, 38.0), "B1-2": (56.5, 47.0), "B1-3": (56.5, 56.0),
    "B1-4": (60.3, 38.0), "B1-5": (60.3, 47.0), "B1-6": (60.3, 56.0),
    # --- Bulles calmes : Maldives puis Seychelles, entre les deux salles ---
    "BC-1": (65.5, 31.5),
    "BC-2": (72.0, 57.0),
    # --- Bureau 2 : salle fermée de droite (bureau réservé RH / Admin /
    #     Finance / Legal / IT / EHS) ---
    "B2-1": (78.0, 38.0), "B2-2": (78.0, 47.0), "B2-3": (78.0, 56.0),
    "B2-4": (81.8, 38.0), "B2-5": (81.8, 47.0), "B2-6": (81.8, 56.0),
}

# Positions livrées avant le plan réel du 24/08/2026 : une grille schématique qui
# ne correspondait à aucun mur. Conservées uniquement pour que la migration de
# données sache reconnaître un poste jamais repositionné à la main, et ne pas
# écraser le travail d'un administrateur qui aurait déjà déplacé ses pastilles.
LEGACY_DESK_POSITIONS: dict[str, tuple[float, float]] = {
    "B1-1": (14, 34), "B1-2": (26, 34), "B1-3": (38, 34),
    "B1-4": (14, 62), "B1-5": (26, 62), "B1-6": (38, 62),
    "B2-1": (62, 34), "B2-2": (74, 34), "B2-3": (86, 34),
    "B2-4": (62, 62), "B2-5": (74, 62), "B2-6": (86, 62),
    "T1-1": (10, 8), "T1-2": (18, 8), "T1-3": (10, 16), "T1-4": (18, 16),
    "T2-1": (36, 8), "T2-2": (44, 8), "T2-3": (36, 16), "T2-4": (44, 16),
    "T3-1": (52, 8), "T3-2": (60, 8), "T3-3": (68, 8),
    "T3-4": (52, 16), "T3-5": (60, 16), "T3-6": (68, 16),
    "T4-1": (78, 8), "T4-2": (86, 8), "T4-3": (94, 8),
    "T4-4": (78, 16), "T4-5": (86, 16), "T4-6": (94, 16),
    "BC-1": (46, 24), "BC-2": (54, 24),
}


def position_for(name: str) -> tuple[float | None, float | None]:
    """Renvoie (x, y) pour un poste, ou (None, None) si non positionné."""
    return DESK_POSITIONS.get(name, (None, None))
