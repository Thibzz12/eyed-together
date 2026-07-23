"""Positions des postes sur le plan (vue de dessus).

Coordonnées en POURCENTAGE (0–100) : x = horizontal, y = vertical.
Organisation : 2 bureaux fermés de 6 places chacun (cf. cahier des charges).
Modifiable facilement (plus tard : éditeur admin drag & drop).
"""

# nom du poste -> (x, y) en %
DESK_POSITIONS: dict[str, tuple[float, float]] = {
    # --- Bureau 1 (salle de gauche) : 2 rangées de 3 ---
    "B1-1": (14, 34), "B1-2": (26, 34), "B1-3": (38, 34),
    "B1-4": (14, 62), "B1-5": (26, 62), "B1-6": (38, 62),
    # --- Bureau 2 (salle de droite) : 2 rangées de 3 ---
    "B2-1": (62, 34), "B2-2": (74, 34), "B2-3": (86, 34),
    "B2-4": (62, 62), "B2-5": (74, 62), "B2-6": (86, 62),
    # --- Open space (au-dessus des 2 bureaux) : 3 tables ---
    "T1-1": (10, 8), "T1-2": (18, 8), "T1-3": (10, 16), "T1-4": (18, 16),
    "T2-1": (36, 8), "T2-2": (44, 8), "T2-3": (36, 16), "T2-4": (44, 16),
    "T3-1": (52, 8), "T3-2": (60, 8), "T3-3": (68, 8),
    "T3-4": (52, 16), "T3-5": (60, 16), "T3-6": (68, 16),
    "T4-1": (78, 8), "T4-2": (86, 8), "T4-3": (94, 8),
    "T4-4": (78, 16), "T4-5": (86, 16), "T4-6": (94, 16),
}


def position_for(name: str) -> tuple[float | None, float | None]:
    """Renvoie (x, y) pour un poste, ou (None, None) si non positionné."""
    return DESK_POSITIONS.get(name, (None, None))
