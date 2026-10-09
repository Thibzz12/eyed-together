/* Fonctions partagées par les trois pages (application, écran du couloir,
   tablette de l'entrée). Une seule définition : l'acronyme d'une personne ou
   l'échappement HTML ne doivent pas diverger d'une page à l'autre.
   JavaScript classique volontairement : la tablette peut être ancienne. */

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* Deux lettres pour les avatars ronds : quatre caractères y seraient illisibles. */
function initials(n) {
  return String(n || "?").split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase();
}

/* Sans accents ni casse, pour comparer ou chercher un nom. */
function sansAccents(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/* Acronyme à quatre lettres affiché SUR LES PLACES : deux lettres du prénom, deux du
   nom. Olivier Vanbrabant donne OLVA. C'est la notation que l'équipe utilise déjà en
   interne, et deux lettres seules créaient trop d'homonymes.
   Les accents sont retirés, un acronyme en capitales accentuées se lit mal. */
function deskAcronym(n) {
  var propre = String(n || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  var mots = propre.split(/[\s-]+/).filter(Boolean);
  if (!mots.length) return "?";
  if (mots.length === 1) return mots[0].slice(0, 4).toUpperCase();
  // Prénom + dernier mot du nom : « Jean Paul Dupont » donne JEDU, pas JEPA.
  return (mots[0].slice(0, 2) + mots[mots.length - 1].slice(0, 2)).toUpperCase();
}
