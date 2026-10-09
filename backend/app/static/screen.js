/* Grand écran : le plan du jour en lecture seule, rafraîchi tout seul.
   Ouvert une fois sur l'écran via son lien /ecran/<token>, il ne demande rien
   à personne : pas de connexion, pas de clic. S'il perd le serveur, il garde le
   dernier plan affiché et réessaie ; si son lien est révoqué, il le dit.

   Même page en mode aperçu (/ecran/apercu?apercu=1) dans l'administration :
   elle s'alimente alors par la session admin et reçoit les réglages en cours
   d'édition par postMessage, pour montrer le résultat avant d'enregistrer. */

const PARAMS = new URLSearchParams(location.search);
const APERCU = PARAMS.has("apercu");
const TOKEN = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
const API = `/api/screen/${encodeURIComponent(TOKEN)}`;
const URL_TODAY = APERCU ? "/api/admin/screen-preview" : `${API}/today`;
const urlPlan = (v) => (APERCU ? "/api/floorplan" : `${API}/floorplan`) + `?v=${encodeURIComponent(v)}`;
const urlFond = (v) => (APERCU ? "/api/admin/screen-background" : `${API}/background`) + `?v=${encodeURIComponent(v)}`;
/* Dix secondes : quelqu'un qui réserve depuis son téléphone en entrant doit
   voir sa place apparaître avant d'avoir traversé le couloir. Une requête
   légère toutes les dix secondes pour un seul écran ne pèse rien. Avec une
   minute, Thibaud avait l'impression qu'il fallait recharger la page. */
const INTERVALLE_MS = 10 * 1000;

const COULEURS_DEFAUT = { bg1: "#0F2836", bg2: "#04141D", text: "#FFFFFF", accent: "#7EC8E3" };

let versionPlan = null;
// Réglages poussés par l'administration pendant l'édition (mode aperçu) : ils
// priment sur ceux du serveur jusqu'à l'enregistrement.
let reglagesForces = null;

// escapeHtml et deskAcronym viennent de shared.js : même acronyme (OLVA) que
// sur la page Réserver, par construction.

function afficherMessage(texte) {
  const box = document.getElementById("screenMessage");
  box.textContent = texte;
  box.classList.remove("hidden");
}

function masquerMessage() {
  document.getElementById("screenMessage").classList.add("hidden");
}

/* Les réglages viennent avec chaque rafraîchissement : l'admin change le titre,
   les couleurs ou l'image de fond depuis l'application, l'écran suit dans les
   dix secondes, sans que personne ne touche à l'appareil. */
function appliquerReglages(s) {
  s = s || {};
  const c = Object.assign({}, COULEURS_DEFAUT, s.colors || {});
  const style = document.body.style;
  style.setProperty("--scr-bg1", c.bg1);
  style.setProperty("--scr-bg2", c.bg2);
  style.setProperty("--scr-text", c.text);
  style.setProperty("--scr-accent", c.accent);
  style.setProperty("--scr-dim", String((s.bg_dim ?? 60) / 100));
  document.body.classList.toggle("plan-large", s.plan_size === "large");

  const titre = s.title || "Plan du jour";
  document.getElementById("screenTitle").textContent = titre;
  document.title = titre + " · EyeD Together";
  const banner = document.getElementById("screenBanner");
  banner.textContent = s.message || "";
  banner.classList.toggle("hidden", !s.message);
  document.getElementById("screenLogo").classList.toggle("hidden", s.show_logo === false);
  document.getElementById("screenClock").classList.toggle("hidden", s.show_clock === false);
  document.getElementById("screenStats").classList.toggle("hidden", s.show_stats === false);
  document.getElementById("screenLegend").classList.toggle("hidden", s.show_legend === false);

  // Image de fond : rechargée seulement si sa version change.
  const fond = document.getElementById("screenBg");
  const voile = document.getElementById("screenBgDim");
  if (s.has_background) {
    const u = urlFond(s.background_version || 0);
    if (fond.dataset.src !== u) { fond.style.backgroundImage = `url("${u}")`; fond.dataset.src = u; }
    fond.classList.remove("hidden");
    voile.classList.remove("hidden");
  } else {
    fond.classList.add("hidden");
    voile.classList.add("hidden");
  }
}

function rendre(data) {
  appliquerReglages(reglagesForces || data.settings);
  const date = new Date(data.date + "T12:00:00");
  const demi = data.slot === "AM" ? "Matin" : "Après-midi";
  const jour = date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  document.getElementById("screenDate").textContent = jour.charAt(0).toUpperCase() + jour.slice(1) + " · " + demi;
  document.getElementById("screenLabel").textContent = data.label || "";
  document.getElementById("screenStats").innerHTML = `
    <span class="screen-stat"><b>${data.stats.reserved}</b> réservée${data.stats.reserved > 1 ? "s" : ""}</span>
    <span class="screen-stat"><b>${data.stats.free}</b> libre${data.stats.free > 1 ? "s" : ""}</span>`;

  // L'image ne se recharge que si le plan a changé côté admin.
  if (data.floorplan_version !== versionPlan) {
    versionPlan = data.floorplan_version;
    document.getElementById("screenImage").src = urlPlan(versionPlan);
  }

  document.getElementById("screenPins").innerHTML = data.desks.map(d => {
    const label = d.state === "occupied" ? escapeHtml(deskAcronym(d.occupant)) : "";
    const titre = d.state === "occupied" ? `${d.name} · ${d.occupant}` : d.name;
    return `<span class="plan-pin ${d.state}" style="left:${d.pos_x}%; top:${d.pos_y}%" title="${escapeHtml(titre)}">${label}</span>`;
  }).join("");
}

async function rafraichir() {
  try {
    const res = await fetch(URL_TODAY, { cache: "no-store", credentials: "same-origin" });
    if (res.status === 404) { afficherMessage("Ce lien d'écran n'est plus valable. Demande un nouveau lien à l'administration."); return; }
    if (res.status === 401 || res.status === 403) { afficherMessage("Aperçu indisponible : reconnecte-toi à l'administration."); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    rendre(await res.json());
    masquerMessage();
    document.getElementById("screenUpdated").textContent =
      "Actualisé à " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (_) {
    // Serveur injoignable : on garde le dernier plan affiché, on réessaie au prochain tour.
    if (versionPlan === null) afficherMessage("Connexion au serveur en cours…");
  }
}

function horloge() {
  document.getElementById("screenClock").textContent =
    new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// Mode aperçu : l'administration envoie les réglages à chaque modification.
if (APERCU) {
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "eyed-screen-settings") return;
    reglagesForces = e.data.settings;
    appliquerReglages(reglagesForces);
  });
}

horloge();
setInterval(horloge, 1000);
rafraichir();
setInterval(rafraichir, INTERVALLE_MS);
// Un onglet en arrière-plan voit ses minuteurs ralentis par le navigateur :
// dès qu'on revient dessus, on remet le plan à jour sans attendre.
document.addEventListener("visibilitychange", () => { if (!document.hidden) rafraichir(); });
window.addEventListener("focus", rafraichir);
