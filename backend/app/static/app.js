/* ============================================================
   EyeD Together — application multi-pages (JavaScript natif)
   ============================================================ */

// Date du jour (calendrier LOCAL) au format AAAA-MM-JJ. Ne JAMAIS utiliser
// .toISOString().slice(0,10) pour une date de calendrier : ça convertit en UTC, ce qui
// peut décaler d'un jour selon l'heure et le fuseau (bug réel : "27" sélectionné mais
// réservation affichée au "26"). Uniquement pour un vrai timestamp (ex: publish_at),
// .toISOString() reste correct.
function toLocalISODate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const state = {
  profile: null,
  // vue Réserver
  date: toLocalISODate(new Date()),
  slot: "DAY",
  floor: null,
  availability: [],
  myReservations: [],
  selected: null,
  statusCatalog: [], // rempli au démarrage depuis /api/statuses : [{key,label,color,enabled}] (admin-géré)
  advanceDays: 7,     // rempli au démarrage depuis /api/reservation-policy (admin-géré)
  featureIcons: [],   // règles mot-clé -> icône, administrables (/api/feature-icons)
  floorplanVersion: 0,  // date du dernier remplacement du plan, mise dans l'URL de l'image
  spaces: [],         // salles et tables réservables d'un bloc (/api/spaces)
  bookingModes: { seat: true, table: true, room: true, pod: true },
};

/* Catalogue de statuts de présence (4 de base + statuts perso ajoutés par l'admin) —
   plus de liste figée côté client : tout vient de state.statusCatalog. */
function enabledStatusEntries() {
  return state.statusCatalog.filter(s => s.enabled).map(s => [s.key, s.label]);
}
function statusLabel(key) { const s = state.statusCatalog.find(x => x.key === key); return (s && s.label) || key; }
function statusColor(key) { const s = state.statusCatalog.find(x => x.key === key); return (s && s.color) || "#94A3B8"; }
/* Icône générique pour un statut sans icône dédiée (tout statut perso ajouté en admin). */
const DEFAULT_STATUS_ICON = '<circle cx="12" cy="12" r="8"/>';
function statusIcon(key) { return STATUS_ICON[key] || DEFAULT_STATUS_ICON; }
const PALETTE = ["#00608D", "#2E9E5B", "#E6A100", "#7A4E86", "#B4761C", "#0891b2", "#D64545"];

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...options });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}
function colorFor(n) { let s = 0; for (const c of n || "?") s += c.charCodeAt(0); return PALETTE[s % PALETTE.length]; }
function initials(n) { return (n || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase(); }
/* Acronyme à quatre lettres affiché SUR LES PLACES : deux lettres du prénom, deux du
   nom. Olivier Vanbrabant donne OLVA. C'est la notation qu'ils utilisent déjà en
   interne, et deux lettres seules créaient trop d'homonymes.
   Les avatars ronds gardent deux lettres : quatre caractères y seraient illisibles.
   Les accents sont retirés, un acronyme en capitales accentuées se lit mal. */
function deskAcronym(n) {
  const propre = (n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const mots = propre.split(/[\s-]+/).filter(Boolean);
  if (!mots.length) return "?";
  if (mots.length === 1) return mots[0].slice(0, 4).toUpperCase();
  // Prénom + dernier mot du nom : « Jean Paul Dupont » donne JEDU, pas JEPA.
  return (mots[0].slice(0, 2) + mots[mots.length - 1].slice(0, 2)).toUpperCase();
}
/* URL de l'image du plan, versionnée par la date de son dernier remplacement.
   Une nouvelle image donne une nouvelle URL : rien à invalider, là où les
   en-têtes de cache seuls laissaient réapparaître l'ancien plan jusqu'au F5. */
function floorplanUrl() {
  return `/api/floorplan?v=${state.floorplanVersion || 0}`;
}
function firstName(n) { return (n || "").split(/\s+/)[0]; }
function slotLabel(s) { return s === "AM" ? "Matin" : s === "PM" ? "Après-midi" : s === "timeslot" ? "Créneau" : "Journée"; }
/* Échappe le texte libre (saisi par un admin : badges, etc.) avant de l'insérer dans du HTML
   construit à la main — évite qu'un badge malveillant exécute du JS dans la session de
   n'importe quel employé consultant un profil. */
function escapeHtml(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Caractéristiques d'un poste (texte libre, admin) affichées en petites étiquettes avec icône
   pendant la réservation. Icône choisie par mot-clé (100% libre côté admin, pas de catalogue
   à maintenir), avec une icône générique en repli pour tout ce qui n'est pas reconnu. */
/* Règles administrables (mot-clé vers icône), chargées depuis /api/feature-icons au
   démarrage. Elles vivaient ici en dur : ajouter un type de poste imposait de toucher
   au code, ce qu'un responsable communication ne peut pas faire. La première règle qui
   correspond gagne, d'où l'ordre : « double écran » doit passer avant « écran ». */
function featureIcon(text) {
  const t = (text || "").toLowerCase();
  for (const r of state.featureIcons) {
    if (t.includes((r.keyword || "").toLowerCase())) return r.icon;
  }
  return "✨";
}
function featureTags(featuresStr) {
  return (featuresStr || "").split(",").map(s => s.trim()).filter(Boolean);
}
function featureTagsHtml(featuresStr) {
  const tags = featureTags(featuresStr);
  if (!tags.length) return "";
  return `<div class="feature-tags">${tags.map(t => `<span class="feature-tag">${featureIcon(t)} ${t}</span>`).join("")}</div>`;
}
function fdate(iso, opt) { return new Date(iso).toLocaleDateString("fr-FR", opt || { weekday: "long", day: "numeric", month: "long" }); }
function levelOf(pts) {
  if (pts >= 300) return "Platine"; if (pts >= 150) return "Or"; if (pts >= 50) return "Argent"; return "Bronze";
}
/* Progression (0-100) vers le prochain palier de niveau, pour l'anneau du cadran d'accueil. */
function levelProgress(pts) {
  const steps = [0, 50, 150, 300];
  const i = steps.findIndex(s => pts < s);
  if (i === -1) return 100; // déjà Platine, palier max
  const [lo, hi] = [steps[i - 1] || 0, steps[i]];
  return Math.round(((pts - lo) / (hi - lo)) * 100);
}
/* Longueur de l'arc SVG (stroke-dashoffset) pour un anneau de cadran, à partir d'un %. */
function ringOffset(circumference, pct) {
  return (circumference * (1 - Math.min(100, Math.max(0, pct)) / 100)).toFixed(1);
}

/* ---------------- Connexion : scène de fond animée (canvas) ----------------
   Un œil dessiné comme un schéma d'instrument de précision (iris à fibres radiales,
   pupille avec reflet, anneaux de mesure gradués, balayage façon scanner rétinien) —
   clin d'œil direct au métier d'EyeD Pharma (implants et dispositifs ophtalmiques),
   très au-dessus d'un simple motif décoratif. Positionné en débord pour rester visible
   même derrière/autour du contenu, et beaucoup plus contrasté qu'une version précédente
   trop discrète. Ne démarre qu'à l'affichage de l'écran de connexion, et respecte
   prefers-reduced-motion (une seule image fixe, pas de boucle). */
function initLoginScene() {
  const canvas = document.getElementById("loginScene");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w = 0, h = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // ResizeObserver plutôt qu'un simple appel + listener "resize" : au premier affichage,
  // la section #login peut ne pas encore avoir sa taille finale au moment où ce script
  // tourne (fonts pas encore prêtes, mise en page pas encore stabilisée) — clientWidth/
  // Height lu trop tôt vaut alors 0 et la scène ne dessine jamais rien (jusqu'à un
  // rechargement qui, par hasard de timing, évite la course). Le ResizeObserver se
  // redéclenche dès que la taille réelle est connue, quelle que soit la cause du retard.
  new ResizeObserver(() => { resize(); if (reduceMotion) draw(0); }).observe(canvas);
  resize();

  // Fibres d'iris : longueur/épaisseur/opacité irrégulières pour un rendu organique,
  // générées une fois (pas à chaque frame) pour rester stables pendant la rotation.
  const FIBER_COUNT = 130;
  const fibers = Array.from({ length: FIBER_COUNT }, () => ({
    a: Math.random() * Math.PI * 2,
    len: .62 + Math.random() * .38,
    lw: .6 + Math.random() * 1.3,
    op: .18 + Math.random() * .3,
  }));
  // Anneaux de mesure façon diagramme de lentille intraoculaire (gradués, comme un
  // instrument optique) : chacun tourne à sa propre vitesse pour suggérer un scanner.
  const RINGS = [
    { r: .82, lw: 1,   dash: [1, 9],   speed:  .00001, op: .16, color: "169,212,232", ticks: 48 },
    { r: .63, lw: 1,   dash: [],       speed: -.000015,op: .22, color: "79,179,217",  ticks: 0  },
    { r: .40, lw: 1.4, dash: [2, 7],   speed:  .00003, op: .30, color: "255,255,255", ticks: 24 },
  ];
  // Particules : reflets flottants façon poussières en suspension dans un liquide oculaire.
  const particles = Array.from({ length: 34 }, () => ({
    x: Math.random(), y: Math.random(),
    r: Math.random() * 2 + .6,
    phase: Math.random() * Math.PI * 2,
    base: Math.random() * .35 + .15,
  }));
  const t0 = performance.now();

  function draw(dt) {
    if (!w || !h) return; // taille pas encore connue (voir ResizeObserver ci-dessus)
    const cx = w * .5, cy = h * .30;
    const scale = Math.max(w, h) * .62;
    ctx.clearRect(0, 0, w, h);

    // Halo large derrière tout l'œil, pour détacher la forme du fond.
    const haloR = scale * 1.05;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, "rgba(30,138,184,.30)");
    halo.addColorStop(.55, "rgba(10,74,107,.16)");
    halo.addColorStop(1, "rgba(3,15,22,0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

    // Anneaux de mesure gradués (diagramme d'instrument optique).
    RINGS.forEach(ring => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(reduceMotion ? 0 : dt * ring.speed);
      ctx.setLineDash(ring.dash);
      ctx.strokeStyle = `rgba(${ring.color},${ring.op})`;
      ctx.lineWidth = ring.lw;
      ctx.beginPath(); ctx.arc(0, 0, scale * ring.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      if (ring.ticks) {
        ctx.strokeStyle = `rgba(${ring.color},${ring.op * 1.3})`;
        for (let i = 0; i < ring.ticks; i++) {
          const a = (i / ring.ticks) * Math.PI * 2;
          const long = i % 6 === 0;
          const r1 = scale * ring.r - (long ? 10 : 5), r2 = scale * ring.r + (long ? 10 : 5);
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
          ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
          ctx.stroke();
        }
      }
      ctx.restore();
    });

    // Iris : fibres radiales denses, teinte bleu EyeD, rotation lente d'ensemble.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(reduceMotion ? 0 : dt * .000025);
    const innerR = scale * .17, outerR = scale * .40;
    fibers.forEach(f => {
      const a = f.a;
      const r1 = innerR, r2 = innerR + (outerR - innerR) * f.len;
      const grad = ctx.createLinearGradient(Math.cos(a) * r1, Math.sin(a) * r1, Math.cos(a) * r2, Math.sin(a) * r2);
      grad.addColorStop(0, `rgba(169,212,232,${f.op})`);
      grad.addColorStop(1, `rgba(30,138,184,0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = f.lw;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      ctx.stroke();
    });
    ctx.restore();

    // Pupille : noyau sombre + reflet spéculaire, comme une lentille précise.
    const pupilR = scale * .155;
    const pupilGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, pupilR);
    pupilGrad.addColorStop(0, "#020C12");
    pupilGrad.addColorStop(.75, "#03141D");
    pupilGrad.addColorStop(1, "rgba(79,179,217,.4)");
    ctx.fillStyle = pupilGrad;
    ctx.beginPath(); ctx.arc(cx, cy, pupilR, 0, Math.PI * 2); ctx.fill();
    const catchPulse = reduceMotion ? 1 : .85 + Math.sin(dt * .0012) * .15;
    const catchR = pupilR * .32 * catchPulse;
    ctx.beginPath();
    ctx.arc(cx - pupilR * .32, cy - pupilR * .32, catchR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fill();

    // Balayage façon scanner rétinien : une ligne lumineuse tourne autour de l'iris,
    // avec une traînée dégressive — mouvement net et évidemment intentionnel.
    if (!reduceMotion) {
      const sweepA = dt * .00045;
      for (let i = 0; i < 18; i++) {
        const a = sweepA - i * .045;
        const op = (1 - i / 18) * .5;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
        ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
        ctx.strokeStyle = `rgba(255,255,255,${op})`;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }

    // Reflets en suspension, discrets, sur toute la scène.
    particles.forEach(p => {
      const drift = reduceMotion ? 0 : Math.sin(dt * .00016 + p.phase) * .01;
      const x = (p.x + drift) * w, y = (p.y + drift * .6) * h;
      const twinkle = reduceMotion ? p.base : p.base * (.6 + Math.sin(dt * .0013 + p.phase) * .4);
      ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${twinkle})`;
      ctx.fill();
    });
  }

  if (reduceMotion) { draw(0); return; }
  (function frame(t) { draw(t - t0); requestAnimationFrame(frame); })(t0);
}

/* ============================================================
   PRÉSENCE DANS LES LOCAUX (arrivée, départ, visiteurs)
   ------------------------------------------------------------
   À ne pas confondre avec la vue "Ma présence", qui sert à déclarer un
   statut matin/après-midi à l'avance. Ici on enregistre un fait : la
   personne est physiquement dans le bâtiment. Sert à l'évacuation.
   ============================================================ */
let attendanceState = { arrived: false, present: false, visitors: [] };

/* Clé de rejet du pop-up, valable pour la seule journée en cours : refuser une
   fois ne doit pas masquer la question pour toujours. Rien n'est envoyé au
   serveur, car quelqu'un qui n'est pas venu ne doit laisser aucune trace dans
   une table de présence. */
function arrivalDismissedToday() {
  try { return localStorage.getItem("arrivalDismissed") === toLocalISODate(new Date()); }
  catch (_) { return false; }  // navigation privée, stockage bloqué : on repose la question
}
function dismissArrivalForToday() {
  try { localStorage.setItem("arrivalDismissed", toLocalISODate(new Date())); } catch (_) {}
}

/* Le pop-up ne s'affiche pas le week-end : personne n'est censé être dans les locaux. */
function isWorkday(d) {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

async function refreshAttendance() {
  const { ok, data } = await api("/api/attendance/me");
  if (ok && data) attendanceState = data;
  const btn = document.getElementById("leaveBtn");
  if (btn) btn.classList.toggle("hidden", !attendanceState.present);
  return attendanceState;
}

async function maybeShowArrivalSheet() {
  await refreshAttendance();
  if (attendanceState.arrived) return;
  if (!isWorkday(new Date())) return;
  if (arrivalDismissedToday()) return;
  document.getElementById("arrivalSheetBackdrop").classList.remove("hidden");
}

function closeArrivalSheet() {
  document.getElementById("arrivalSheetBackdrop").classList.add("hidden");
}

function renderArrivalVisitors() {
  const box = document.getElementById("arrivalVisitorList");
  const presents = (attendanceState.visitors || []).filter(v => v.present);
  box.innerHTML = presents.length
    ? presents.map(v => `<span class="visitor-chip">${escapeHtml(v.full_name)}${v.company ? " · " + escapeHtml(v.company) : ""}</span>`).join("")
    : `<div class="empty-inline">Aucun visiteur déclaré.</div>`;
}

async function addVisitorFromSheet() {
  const nameInput = document.getElementById("arrivalVisitorName");
  const companyInput = document.getElementById("arrivalVisitorCompany");
  const full_name = nameInput.value.trim();
  if (!full_name) { toast("Indique le nom du visiteur.", "error"); return; }

  const { ok, data } = await api("/api/visitors", {
    method: "POST",
    body: JSON.stringify({ full_name, company: companyInput.value.trim() || null }),
  });
  if (!ok) { toast((data && data.detail) || "Impossible d'ajouter ce visiteur.", "error"); return; }

  nameInput.value = ""; companyInput.value = "";
  await refreshAttendance();
  renderArrivalVisitors();
  toast("Visiteur enregistré ✓", "success");
}

function initAttendanceUi() {
  document.getElementById("arrivalConfirmBtn").addEventListener("click", async () => {
    const { ok, data } = await api("/api/attendance/checkin", { method: "POST" });
    if (!ok) { toast((data && data.detail) || "Impossible d'enregistrer ton arrivée.", "error"); return; }
    attendanceState = data;
    document.getElementById("leaveBtn").classList.remove("hidden");
    closeArrivalSheet();
    toast("Arrivée confirmée ✓", "success");
    resyncPoints();
  });

  document.getElementById("arrivalDismissBtn").addEventListener("click", () => {
    dismissArrivalForToday();
    closeArrivalSheet();
  });

  document.getElementById("arrivalVisitorToggleBtn").addEventListener("click", () => {
    const block = document.getElementById("arrivalVisitorBlock");
    block.classList.toggle("hidden");
    if (!block.classList.contains("hidden")) renderArrivalVisitors();
  });

  document.getElementById("arrivalVisitorAddBtn").addEventListener("click", addVisitorFromSheet);

  // Pas de fermeture au clic à côté, contrairement aux autres feuilles : c'est une
  // question de sécurité incendie, pas un panneau d'information. Se débarrasser du
  // pop-up d'un clic distrait viderait la liste d'évacuation de son sens. Il faut
  // choisir : « Je suis arrivé » ou « Pas au bureau aujourd'hui ».

  document.getElementById("leaveBtn").addEventListener("click", async () => {
    const { ok, data } = await api("/api/attendance/checkout", { method: "POST" });
    if (!ok) { toast((data && data.detail) || "Impossible d'enregistrer ton départ.", "error"); return; }
    attendanceState = data;
    document.getElementById("leaveBtn").classList.add("hidden");
    toast("Départ enregistré. Bonne soirée !", "success");
  });
}

/* ---------------- Démarrage ---------------- */
async function init() {
  // /api/profile, /api/statuses et /api/reservation-policy sont indépendants : lancés en
  // parallèle plutôt que l'un après l'autre pour économiser des allers-retours réseau au
  // démarrage (sensible surtout en mobile/latence élevée).
  const [{ ok, data }, st, pol, icons] = await Promise.all([
    api("/api/profile"), api("/api/statuses"), api("/api/reservation-policy"),
    api("/api/feature-icons"),
  ]);
  if (!ok) { document.getElementById("login").classList.remove("hidden"); initLoginScene(); return; }
  state.profile = data;
  state.statusCatalog = (st.data && st.data.catalog) || [];
  state.advanceDays = (pol.data && pol.data.advance_days) || 7;
  state.featureIcons = (icons.data && icons.data.rules) || [];
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("tabbar").classList.remove("hidden");
  document.getElementById("userName").textContent = firstName(state.profile.name);
  document.getElementById("userLevel").textContent = "Niveau " + levelOf(state.profile.total_points);
  const av = document.getElementById("avatar");
  av.textContent = initials(state.profile.name);
  const avm = document.getElementById("avatarMobile");
  if (avm) avm.textContent = initials(state.profile.name);
  refreshPoints(0);
  if (state.profile.role === "admin") document.querySelector(".nav-admin").classList.remove("hidden");

  document.querySelectorAll(".nav-link[data-route], .tab-link[data-route]").forEach(a =>
    a.addEventListener("click", e => { e.preventDefault(); goTo(a.dataset.route); closeMobileMenu(); }));
  document.getElementById("sheetCancelBtn").addEventListener("click", clearSelection);
  document.getElementById("sheetConfirmBtn").addEventListener("click", confirmSheet);
  document.getElementById("reserveSheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "reserveSheetBackdrop") clearSelection();
  });
  document.querySelectorAll("#sheetSlotToggle button").forEach(b => b.addEventListener("click", () => {
    sheetSlot = b.dataset.slot;
    document.querySelectorAll("#sheetSlotToggle button").forEach(x => x.classList.toggle("active", x === b));
  }));
  document.getElementById("groupCancelBtn").addEventListener("click", closeGroupSheet);
  document.getElementById("groupConfirmBtn").addEventListener("click", confirmGroupSheet);
  document.querySelectorAll("#groupSlotToggle button").forEach(b => b.addEventListener("click", () => {
    groupSlot = b.dataset.slot;
    document.querySelectorAll("#groupSlotToggle button").forEach(x => x.classList.toggle("active", x === b));
  }));
  document.getElementById("groupSheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "groupSheetBackdrop") closeGroupSheet();
  });
  document.getElementById("podCancelBtn").addEventListener("click", closePodSheet);
  document.getElementById("podConfirmBtn").addEventListener("click", confirmPodSheet);
  document.getElementById("podSheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "podSheetBackdrop") closePodSheet();
  });
  document.getElementById("statusConflictKeepBtn").addEventListener("click", () => closeStatusConflictSheet("keep"));
  document.getElementById("statusConflictBackBtn").addEventListener("click", () => closeStatusConflictSheet("abort"));
  document.getElementById("statusConflictCancelResBtn").addEventListener("click", async () => {
    const st = statusConflictState;
    if (st) { for (const r of st.reservations) await api(`/api/reservations/${r.id}`, { method: "DELETE" }); }
    closeStatusConflictSheet("cancelled");
  });
  document.getElementById("statusConflictSheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "statusConflictSheetBackdrop") closeStatusConflictSheet("abort");
  });
  document.getElementById("badgeDetailCloseBtn").addEventListener("click", closeBadgeDetailSheet);
  document.getElementById("badgeDetailSheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "badgeDetailSheetBackdrop") closeBadgeDetailSheet();
  });
  document.getElementById("searchBtn").addEventListener("click", () => goTo("recherche"));
  document.getElementById("menuBtn").addEventListener("click", openMenuSheet);
  document.getElementById("menuSheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "menuSheetBackdrop") document.getElementById("menuSheetBackdrop").classList.add("hidden");
  });
  document.getElementById("notifBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleNotifPanel(); });
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("notifPanel");
    if (!panel.classList.contains("hidden") && !panel.contains(e.target) && e.target.id !== "notifBtn") panel.classList.add("hidden");
  });
  refreshNotifBadge();
  setInterval(refreshNotifBadge, 60000); // rafraîchit le badge même si le panneau reste fermé
  initAttendanceUi();
  maybeShowArrivalSheet();
  window.addEventListener("hashchange", router);
  router();
}

function toggleMobileMenu() { document.querySelector(".sidebar").classList.toggle("open"); }
function closeMobileMenu() { document.querySelector(".sidebar").classList.remove("open"); }

const ROUTES = {
  accueil: { title: "Accueil", render: viewAccueil },
  reserver: { title: "Réserver une place", render: viewReserver },
  evenements: { title: "Événements", render: viewEvenements },
  presence: { title: "Ma présence", render: viewPresence },
  locaux: { title: "Dans les locaux", render: viewLocaux },
  recompenses: { title: "Récompenses", render: viewRecompenses },
  idees: { title: "Boîte à idées", render: viewIdees },
  recherche: { title: "Recherche", render: viewRecherche },
  quiz: { title: "Quiz", render: viewQuiz },
  medias: { title: "Médias", render: viewMedias },
  profil: { title: "Mon profil", render: viewProfil },
  aide: { title: "Aide", render: viewAide },
  admin: { title: "Administration", render: viewAdmin },
};
let adminState = null;

function router() {
  const route = (location.hash.replace("#", "") || "accueil");
  const r = ROUTES[route] || ROUTES.accueil;
  document.getElementById("pageTitle").textContent = r.title;
  document.querySelectorAll(".nav-link, .tab-link").forEach(a => a.classList.toggle("active", a.dataset.route === route));
  clearSelection();
  r.render();
}

/* Change de route — force le rendu même si le hash ne bouge pas (ex: on est déjà sur
   "#evenements" et on revient du détail d'un événement ouvert SANS changer le hash :
   un hashchange ne se déclencherait pas dans ce cas). */
function goTo(route) {
  if (location.hash.replace("#", "") === route) router();
  else location.hash = route;
}

/* Le serveur vient de créditer ou de retirer des points sans qu'on sache combien :
   on relit le profil plutôt que de deviner un delta qui finirait par diverger. */
function resyncPoints() {
  return api("/api/profile").then(({ ok, data }) => {
    if (ok && data) { state.profile.total_points = data.total_points; refreshPoints(0); }
  });
}

function refreshPoints(delta) {
  if (delta) state.profile.total_points = Math.max(0, state.profile.total_points + delta);
  document.getElementById("pointsValue").textContent = state.profile.total_points;
  document.getElementById("userLevel").textContent = "Niveau " + levelOf(state.profile.total_points);
  if (delta) {
    const pill = document.getElementById("pointsPill");
    pill.classList.add("bump"); setTimeout(() => pill.classList.remove("bump"), 250);
  }
}

/* ============================================================
   VUE : ACCUEIL (tableau de bord administrable)
   ============================================================ */
const STATUS_ICON = {
  coworking: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  teletravail: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  deplacement: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  conge: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};

async function viewAccueil() {
  const view = document.getElementById("view");
  const today = toLocalISODate(new Date());
  view.innerHTML = `<div class="empty">Chargement…</div>`;
  const d = (await api("/api/dashboard")).data;
  const cards = (d && d.cards) || [];
  const resa = cards.find(c => c.key === "next_reservation");
  const occ = cards.find(c => c.key === "coworking_status");

  // Cadran : anneau extérieur = occupation des espaces, anneau intérieur = progression de
  // niveau (points) ; le disque central reprend le statut de réservation du jour.
  const rOuter = 92, rInner = 72;
  const cOuter = 2 * Math.PI * rOuter, cInner = 2 * Math.PI * rInner;
  const occPct = occ && occ.data && occ.data.total ? Math.round((occ.data.total - occ.data.free) / occ.data.total * 100) : 0;
  const ptsPct = levelProgress(state.profile.total_points);
  const focal = resa && resa.data
    ? { tag: resa.data.checked_in ? "Présence confirmée ✓" : "Réservé", desk: "Poste " + resa.data.desk, meta: slotLabel(resa.data.slot) }
    : { tag: "Aujourd'hui", desk: "Pas encore réservé", meta: "" };

  view.innerHTML = `
      <div class="hero-banner">
        <svg class="hb-aperture" viewBox="0 0 400 400" aria-hidden="true" focusable="false">
          <g class="hb-aperture-rings">
            <circle cx="200" cy="200" r="196" fill="none" stroke="#ffffff" stroke-opacity=".05" stroke-width="1.5"/>
            <circle cx="200" cy="200" r="156" fill="none" stroke="#4FB3D9" stroke-opacity=".12" stroke-width="1.5" stroke-dasharray="20 16"/>
            <circle cx="200" cy="200" r="116" fill="none" stroke="#1E8AB8" stroke-opacity=".18" stroke-width="2" stroke-dasharray="34 12"/>
            <circle cx="200" cy="200" r="76" fill="none" stroke="#A9D4E8" stroke-opacity=".22" stroke-width="2"/>
          </g>
        </svg>
        <div class="hb-top">
          <div>
            <div class="hb-greet"><span class="hb-muted">Bonjour</span><br><span class="hb-name">${firstName(state.profile.name)}</span></div>
            <div class="hb-status"><span class="hb-dot"></span>Connecté · SSO EyeD</div>
          </div>
          <div class="hb-dial" id="hbDial" ${resa ? 'data-go="reserver" tabindex="0" role="button" aria-label="Modifier ma réservation"' : ""}>
            <svg viewBox="0 0 200 200">
              <circle class="hb-dial-track" cx="100" cy="100" r="${rOuter}"/>
              <circle class="hb-dial-arc" cx="100" cy="100" r="${rOuter}" stroke="#4FB3D9"
                      stroke-dasharray="${cOuter.toFixed(1)}" stroke-dashoffset="${ringOffset(cOuter, occPct)}"/>
              <circle class="hb-dial-track" cx="100" cy="100" r="${rInner}"/>
              <circle class="hb-dial-arc" cx="100" cy="100" r="${rInner}" stroke="#F59E0B"
                      stroke-dasharray="${cInner.toFixed(1)}" stroke-dashoffset="${ringOffset(cInner, ptsPct)}"/>
            </svg>
            <span class="hb-dial-legend l1">Occupation ${occPct}%</span>
            <span class="hb-dial-legend l2">Niveau ${ptsPct}%</span>
            <div class="hb-dial-focal">
              <span class="eb">${focal.tag}</span>
              <span class="val">${focal.desk}</span>
              ${focal.meta ? `<span class="sub">${focal.meta}</span>` : ""}
            </div>
          </div>
        </div>
      </div>
      <div class="dash-grid" id="dashGrid">${cards.map(c => renderCard(c)).join("") || `<div class="empty">Aucune carte activée.</div>`}</div>`;
  wireDashboard(today);
  const dial = document.getElementById("hbDial");
  if (dial) { dial.addEventListener("click", () => goTo("reserver")); dial.addEventListener("keydown", e => { if (e.key === "Enter") goTo("reserver"); }); }
}

function renderCard(c) {
  const wide = ["events", "news", "project_progress", "team_presence", "mes_evenements", "birthdays"].includes(c.key) ? " wide" : "";
  const hl = c.highlighted ? " highlight" : "";
  const data = c.data;
  let inner = "", extraClass = "";

  if (c.key === "presence") {
    const amCur = data && data.status_am;
    const pmCur = data && data.status_pm;
    const seg = (slot, cur) => `<div class="status-seg">${enabledStatusEntries().map(([k, l]) =>
      `<button class="status-seg-btn${cur === k ? " on" : ""}" data-slot="${slot}" data-status="${k}" style="--tile-color:${statusColor(k)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${statusIcon(k)}</svg>
        <span>${l}</span></button>`).join("")}</div>`;
    inner = `<div class="card-label">${c.title}</div>
      <div class="status-half-label">Matin</div>${seg("AM", amCur)}
      <div class="status-half-label">Après-midi</div>${seg("PM", pmCur)}`;
  } else if (c.key === "next_reservation") {
    extraClass = " reservation-card";
    if (data) {
      inner = `<div class="rc-row">
        <span class="rc-ic"><svg viewBox="0 0 24 24" fill="none" stroke="#00608D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M5 19v2M19 19v2"/></svg></span>
        <div><div class="rc-tag">${data.checked_in ? "Présence confirmée ✓" : "Réservé"}</div><div class="rc-desk">Poste ${data.desk}</div>
        <div class="rc-meta">${fdate(data.date, { weekday: "short", day: "numeric", month: "short" })} · ${slotLabel(data.slot)}</div></div></div>
        <div class="rc-actions">
          ${data.is_today && !data.checked_in ? `<button class="rc-btn primary" data-checkin="${data.reservation_id}">Je suis arrivé</button>` : ""}
          <button class="rc-btn" data-go="reserver">Modifier</button><button class="rc-btn danger" data-cancel-next="${data.reservation_id}">Annuler</button></div>`;
    } else {
      inner = `<div class="card-label">${c.title}</div><div class="card-value">Aucune réservation</div>
        <div class="rc-actions" style="margin-top:10px"><button class="rc-btn" data-go="reserver">Réserver une place</button></div>`;
    }
  } else if (c.key === "project_progress") {
    extraClass = " banner-card";
    inner = `<div class="banner-top2">
        <div><div class="banner-eyebrow">Building Our Future Home</div><div class="banner-title">${data.milestone_title || c.title}</div></div>
      </div>
      <div class="banner-progress"><div class="bp-row"><span>${data.label || ""}</span><span class="bp-pct">${data.value}%</span></div>
      <div class="progress"><i style="width:${data.value}%"></i></div></div>`;
  } else if (c.key === "team_presence") {
    const items = (data || []).map(p => `<div class="colleague">
      <div class="colleague-av" style="background:${colorFor(p.name)}">${initials(p.name)}</div>
      <div class="colleague-name">${firstName(p.name)}</div><div class="colleague-desk">${p.desk}</div></div>`).join("")
      || `<div class="empty">Personne pour l'instant. Sois le premier ! 🎯</div>`;
    inner = `<div class="card-head"><h3>${c.title} <span class="badge-count">${(data||[]).length}</span></h3></div>
      <div class="colleagues-scroll">${items}</div>`;
  } else if (c.key === "events") {
    const items = (data || []).map(ev => `<div class="event-row" data-event="${ev.id}">
      <div class="ev-datebox"><span>${fdate(ev.date, { month: "short" })}</span><b>${fdate(ev.date, { day: "numeric" })}</b></div>
      <div class="ev-info"><div class="ev-title">${ev.title}</div></div></div>`).join("") || `<div class="empty">Aucun événement.</div>`;
    inner = `<div class="card-head"><h3>${c.title}</h3><a class="link-more" data-go="evenements">Agenda</a></div><div class="event-list">${items}</div>`;
  } else if (c.key === "news") {
    const items = (data || []).map(n => `<div class="event-item" data-news="${n.id}">
      <span class="event-date">${fdate(n.date, { day: "numeric", month: "short" })}</span>
      <span class="event-title">${n.title}</span></div>`).join("") || `<div class="empty">Aucune actualité.</div>`;
    inner = `<div class="card-head"><h3>${c.title}</h3></div><div class="list">${items}</div>`;
  } else if (c.key === "mes_evenements") {
    const items = (data || []).map(ev => `<div class="event-row" data-event="${ev.id}">
      <div class="ev-datebox"><span>${fdate(ev.date, { month: "short" })}</span><b>${fdate(ev.date, { day: "numeric" })}</b></div>
      <div class="ev-info"><div class="ev-title">${ev.title}</div>
        <span class="ev-status-badge${ev.status === "waitlisted" ? " waitlisted" : ""}">${ev.status === "waitlisted" ? "Liste d'attente" : "Inscrit ✓"}</span></div></div>`).join("")
      || `<div class="empty">Aucune inscription. Va faire un tour dans les événements !</div>`;
    inner = `<div class="card-head"><h3>${c.title}</h3><a class="link-more" data-go="evenements">Agenda</a></div><div class="event-list">${items}</div>`;
  } else if (c.key === "liens_utiles") {
    const items = (data || []).map(l => `<a class="useful-link-row" href="${l.url}" target="_blank" rel="noopener">
      <span class="ul-icon">${l.icon || "🔗"}</span><span class="ul-label">${l.label}</span></a>`).join("")
      || `<div class="empty">Aucun lien pour l'instant.</div>`;
    inner = `<div class="card-head"><h3>${c.title}</h3></div><div class="list">${items}</div>`;
  } else if (c.key === "birthdays") {
    const hasAny = (data.today || []).length || (data.upcoming || []).length;
    if (!hasAny) { extraClass = " birthdays-empty-card"; inner = `<div class="card-head"><h3>🎂 ${c.title}</h3></div><div class="empty">Aucun anniversaire aujourd'hui.</div>`; }
    else {
      const todayHtml = (data.today || []).map(p => `<div class="birthday-today">🎂 N'oublie pas de souhaiter un bon anniversaire à <b>${firstName(p.name)}</b> !</div>`).join("");
      const upcomingHtml = (data.upcoming || []).map(p => `<div class="event-item"><span class="event-date">${fdate(p.date, { day: "numeric", month: "short" })}</span><span class="event-title">${p.name}</span></div>`).join("");
      inner = `<div class="card-head"><h3>🎂 ${c.title}</h3></div>
        ${todayHtml}
        ${upcomingHtml ? `<div class="section-eyebrow" style="margin-top:${todayHtml ? 12 : 0}px">À venir</div><div class="event-list">${upcomingHtml}</div>` : ""}`;
    }
  } else if (c.key === "coworking_status") {
    const pct = data.total ? Math.round(data.occupied / data.total * 100) : 0;
    inner = `<div class="card-label">${c.title}</div>
      <div class="card-value blue">${data.free} <span class="muted">/ ${data.total} libres</span></div>
      <div class="mini-bar"><i style="width:${pct}%"></i></div>
      <a class="link-more" data-go="reserver">Réserver une place →</a>`;
  }
  return `<div class="card dash-card${wide}${hl}${extraClass}">${inner}</div>`;
}

function wireDashboard(today) {
  const view = document.getElementById("view");
  view.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", () => goTo(el.dataset.go)));
  view.querySelectorAll("[data-event]").forEach(el => el.addEventListener("click", () => openEvent(+el.dataset.event)));
  view.querySelectorAll("[data-news]").forEach(el => el.addEventListener("click", () => openNews(+el.dataset.news)));
  view.querySelectorAll("[data-cancel-next]").forEach(el => el.addEventListener("click", async () => {
    const { ok, data } = await api(`/api/reservations/${el.dataset.cancelNext}`, { method: "DELETE" });
    if (!ok) return toast(data?.detail || "Annulation impossible.", "error");
    refreshPoints(-10); toast("Réservation annulée."); viewAccueil();
  }));
  view.querySelectorAll("[data-checkin]").forEach(el => el.addEventListener("click", async () => {
    const { ok, data } = await api(`/api/reservations/${el.dataset.checkin}/checkin`, { method: "POST" });
    if (!ok) return toast(data?.detail || "Check-in impossible.", "error");
    toast("Présence confirmée ✓", "success"); viewAccueil();
  }));
  view.querySelectorAll("[data-status]").forEach(el => el.addEventListener("click", () => {
    handleStatusChange(today, el.dataset.slot, el.dataset.status, (cancelledCount) => {
      if (cancelledCount) { refreshPoints(-10 * cancelledCount); viewAccueil(); }
      else {
        view.querySelectorAll(`[data-slot="${el.dataset.slot}"]`).forEach(b => b.classList.remove("on"));
        el.classList.add("on");
      }
    });
  }));
}

/* Si le statut choisi est "coworking" et qu'aucune place n'est encore réservée ce jour-là,
   propose de réserver directement (le statut seul ne réserve rien). */
async function maybeSuggestBooking(day, statusKey) {
  if (statusKey !== "coworking") return;
  const { data } = await api("/api/reservations/me");
  const already = (data || []).some(r => r.reservation_date === day);
  if (already) return;
  toastAction("Tu as indiqué Coworking pour ce jour.", "Réserver une place", () => {
    state.date = day; goTo("reserver");
  });
}

/* Statut ET réservations ne sont pas liés en base : si on change de statut vers autre chose
   que "coworking" alors qu'une place est déjà réservée ce jour-là, ça devient contradictoire
   (réservé mais "en télétravail"/"en congé"…) — on prévient et on laisse le choix de garder
   ou d'annuler la réservation avant d'enregistrer le nouveau statut. */
let statusConflictState = null; // { reservations, resolve }

function openStatusConflictSheet(reservations, resolve) {
  statusConflictState = { reservations, resolve };
  const names = reservations.map(r => `Poste ${r.desk.name} · ${slotLabel(r.slot)}`).join(", ");
  document.getElementById("statusConflictSub").textContent =
    `Réservation actuelle : ${names}. Si tu changes de statut, tu peux la garder ou l'annuler.`;
  document.getElementById("statusConflictSheetBackdrop").classList.remove("hidden");
}

function closeStatusConflictSheet(choice) {
  document.getElementById("statusConflictSheetBackdrop").classList.add("hidden");
  const st = statusConflictState; statusConflictState = null;
  if (st) st.resolve(choice);
}

/* Enregistre le statut, en passant par la confirmation ci-dessus si nécessaire.
   onSuccess(cancelledCount) est appelé une fois le statut effectivement enregistré. */
async function handleStatusChange(day, slot, statusKey, onSuccess) {
  if (statusKey !== "coworking") {
    const { data } = await api("/api/reservations/me");
    const conflicts = (data || []).filter(r => r.reservation_date === day);
    if (conflicts.length) {
      const choice = await new Promise(resolve => openStatusConflictSheet(conflicts, resolve));
      if (choice === "abort") return;
      const ok = await setStatus(day, slot, statusKey);
      if (ok) onSuccess(choice === "cancelled" ? conflicts.length : 0);
      return;
    }
  }
  const ok = await setStatus(day, slot, statusKey);
  if (ok) {
    onSuccess(0);
    if (statusKey === "coworking") maybeSuggestBooking(day, statusKey);
  }
}

/* ============================================================
   VUE : ADMINISTRATION (piloter l'accueil)
   ============================================================ */
async function viewAdmin() {
  const view = document.getElementById("view");
  if (state.profile.role !== "admin") { view.innerHTML = `<div class="empty">Accès réservé aux administrateurs.</div>`; return; }
  view.innerHTML = `
    <div class="admin-tabs">
      <button data-tab="accueil" class="active">Accueil</button>
      <button data-tab="espaces">Coworking</button>
      <button data-tab="presence">Présence</button>
      <button data-tab="evenements">Événements</button>
      <button data-tab="contenu">Contenu</button>
      <button data-tab="collaborateurs">Collaborateurs</button>
      <button data-tab="stats">Statistiques</button>
    </div>
    <div id="adminBody"></div>`;
  const RENDERERS = {
    accueil: renderAdminAccueil, espaces: renderAdminEspaces, presence: renderAdminPresence,
    evenements: renderAdminEvenements, contenu: renderAdminContenu,
    collaborateurs: renderAdminCollaborateurs, stats: renderAdminStats,
  };
  view.querySelectorAll(".admin-tabs button").forEach(b => b.addEventListener("click", () => {
    view.querySelectorAll(".admin-tabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    RENDERERS[b.dataset.tab]();
  }));
  renderAdminAccueil();
}

/* ---- Administration : présence dans les locaux ----
   Heure de clôture des présences oubliées + relevé du jour, heures comprises.
   C'est le seul endroit où les horodatages sont exposés : la vue employé les tait. */
async function renderAdminPresence() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="empty">Chargement…</div>`;

  const [reglages, releve] = await Promise.all([
    api("/api/admin/attendance/settings"),
    api("/api/attendance/today"),
  ]);
  if (!reglages.ok) { body.innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  const heure = (reglages.data && reglages.data.auto_close_hour) ?? 19;
  const presents = (releve.data && releve.data.employees) || [];
  const visiteurs = (releve.data && releve.data.visitors) || [];

  body.innerHTML = `
    <p class="sub" style="color:var(--muted);margin:0 0 16px">
      Toute personne encore marquée présente après l'heure ci-dessous est considérée comme partie.
      Son départ apparaît alors comme non confirmé dans le relevé : c'est un oubli, pas un vrai départ.
    </p>
    <div class="card">
      <h3>Clôture automatique</h3>
      <div class="visitor-form">
        <input id="autoCloseHour" type="number" min="0" max="23" value="${heure}" style="flex:0 0 6rem">
        <span style="color:var(--muted);font-size:.9rem">heures</span>
        <button class="btn btn-ghost" id="autoCloseSaveBtn" type="button">Enregistrer</button>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>Dans les locaux maintenant (${presents.length + visiteurs.length})</h3>
      <div class="presence-list">
        ${presents.map(e => `<div class="presence-row">
            <div class="colleague-av" style="background:${colorFor(e.name)}">${initials(e.name)}</div>
            <div class="presence-id"><b>${escapeHtml(e.name)}</b><small>${escapeHtml(e.department || "EyeD Pharma")}</small></div>
          </div>`).join("")}
        ${visiteurs.map(v => `<div class="presence-row">
            <div class="colleague-av visitor-av">${initials(v.full_name)}</div>
            <div class="presence-id"><b>${escapeHtml(v.full_name)}</b><small>${escapeHtml(v.company || "Externe")} · reçu par ${escapeHtml(v.host_name)}</small></div>
            <button class="presence-out" data-admin-visitor-out="${v.id}">Parti</button>
          </div>`).join("")}
        ${presents.length + visiteurs.length ? "" : `<div class="empty">Personne dans les locaux.</div>`}
      </div>
      <a class="btn btn-primary" href="/api/admin/attendance/export">Exporter le relevé du jour (CSV)</a>
    </div>`;

  document.getElementById("autoCloseSaveBtn").addEventListener("click", async () => {
    const valeur = parseInt(document.getElementById("autoCloseHour").value, 10);
    const { ok, data } = await api("/api/admin/attendance/settings", {
      method: "PATCH", body: JSON.stringify({ auto_close_hour: valeur }),
    });
    toast(ok ? "Heure de clôture enregistrée ✓" : ((data && data.detail) || "Valeur invalide (0 à 23)."), ok ? "success" : "error");
  });

  body.querySelectorAll("[data-admin-visitor-out]").forEach(btn => btn.addEventListener("click", async () => {
    const { ok, data } = await api(`/api/visitors/${btn.dataset.adminVisitorOut}/checkout`, { method: "POST" });
    if (!ok) { toast((data && data.detail) || "Impossible d'enregistrer ce départ.", "error"); return; }
    toast("Départ enregistré ✓", "success");
    renderAdminPresence();
  }));
}

/* ---- Administration : collaborateurs (anniversaires) ---- */
async function renderAdminCollaborateurs() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const { ok, data } = await api("/api/admin/users");
  if (!ok) { body.innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  const users = data || [];

  function rowsHtml(list) {
    return list.map(u => `
      <div class="collab-row" data-id="${u.id}">
        <div class="collab-info"><b>${u.name}</b><small class="muted">${u.department || u.email}</small></div>
        <input type="date" class="collab-birthday" data-field="birthday" value="${u.birthday || ""}">
      </div>`).join("") || `<div class="empty">Aucun collaborateur.</div>`;
  }

  body.innerHTML = `
    <p class="sub" style="color:var(--muted);margin:0 0 16px">Anniversaire de chaque collaborateur (pas de source WordPress fiable identifiée pour le récupérer automatiquement — à renseigner manuellement). Seuls jour et mois sont affichés dans l'appli.</p>
    <div class="search-bar"><input type="text" id="collabSearch" placeholder="Rechercher un collaborateur…"></div>
    <div class="desk-admin-list" id="collabList">${rowsHtml(users)}</div>`;

  function wireRows() {
    document.querySelectorAll(".collab-row [data-field]").forEach(inp => inp.addEventListener("change", async () => {
      const id = +inp.closest(".collab-row").dataset.id;
      const { ok, data } = await api(`/api/admin/users/${id}/birthday`, {
        method: "PATCH", body: JSON.stringify({ birthday: inp.value || null }),
      });
      toast(ok ? "Anniversaire enregistré ✓" : (data?.detail || "Erreur"), ok ? "success" : "error");
    }));
  }
  wireRows();

  document.getElementById("collabSearch").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = users.filter(u => u.name.toLowerCase().includes(q) || (u.department || "").toLowerCase().includes(q));
    document.getElementById("collabList").innerHTML = rowsHtml(filtered);
    wireRows();
  });
}

/* ---- Administration : capacité des événements ---- */
async function renderAdminEvenements() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const { ok, data } = await api("/api/events?limit=24");
  if (!ok) { body.innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  if (!data.length) { body.innerHTML = `<div class="empty">Aucun événement sur l'intranet.</div>`; return; }
  body.innerHTML = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Définis une capacité maximale par événement (laisse vide = illimité) et consulte qui s'est inscrit.</p>
    <div class="desk-admin-list" id="evCapList"></div>`;
  const list = document.getElementById("evCapList");
  for (const ev of data) {
    const row = document.createElement("div"); row.className = "event-admin-row";
    row.innerHTML = `
      <div class="event-admin-top">
        <div class="event-admin-info">
          <div class="ev-title">${ev.title}</div>
          <button class="link-more" data-toggle-reg="${ev.id}">${ev.registered_count} inscrit(s) — voir la liste</button>
          <button class="link-more" data-toggle-notify="${ev.id}">📢 Notifier les inscrits</button>
        </div>
        <label class="event-admin-cap">Capacité
          <input class="da-pos" type="number" min="0" placeholder="illimité" value="${ev.capacity ?? ""}">
        </label>
      </div>
      <div class="idea-comments hidden" id="evreg-${ev.id}"></div>
      <div class="idea-comments hidden" id="evnotify-${ev.id}"></div>`;
    row.querySelector("input").addEventListener("change", async (e) => {
      const val = e.target.value === "" ? null : +e.target.value;
      const { ok } = await api(`/api/admin/events/${ev.id}/capacity`, { method: "PUT", body: JSON.stringify({ capacity: val }) });
      toast(ok ? "Capacité enregistrée ✓" : "Erreur", ok ? "success" : "error");
    });
    row.querySelector("[data-toggle-notify]").addEventListener("click", () => toggleEventNotifyForm(ev));
    row.querySelector("[data-toggle-reg]").addEventListener("click", () => toggleEventRegistrations(ev.id));
    list.appendChild(row);
  }
}

function toggleEventNotifyForm(ev) {
  const box = document.getElementById(`evnotify-${ev.id}`);
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = `<form class="idea-form">
    <input type="text" class="notify-title" placeholder="Titre" value="À propos de « ${ev.title} »" required>
    <textarea class="notify-msg" placeholder="Message envoyé aux inscrits…" rows="2" required></textarea>
    <button type="submit" class="btn-save">Envoyer la notification</button>
  </form>`;
  box.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = box.querySelector(".notify-title").value.trim();
    const message = box.querySelector(".notify-msg").value.trim();
    if (!title || !message) return;
    const { ok, data } = await api(`/api/admin/events/${ev.id}/notify`, { method: "POST", body: JSON.stringify({ title, message }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast(`Notification envoyée à ${data.notified} personne(s) ✓`, "success");
    box.classList.add("hidden"); box.innerHTML = "";
  });
}

async function toggleEventRegistrations(eventId) {
  const box = document.getElementById(`evreg-${eventId}`);
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = `<div class="empty">Chargement…</div>`;
  const regs = (await api(`/api/admin/events/${eventId}/registrations`)).data || [];
  box.innerHTML = regs.length
    ? regs.map(r => `<div class="idea-comment"><b>${r.user_name}</b> <span>${r.status === "waitlisted" ? "— liste d'attente" : "— inscrit"}</span></div>`).join("")
    : `<div class="empty">Personne inscrit pour l'instant.</div>`;
}

async function renderAdminAccueil() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const [dash, st, links] = await Promise.all([api("/api/admin/dashboard"), api("/api/admin/statuses"), api("/api/admin/links")]);
  if (!dash.ok) { body.innerHTML = `<div class="empty">Accès refusé.</div>`; return; }
  adminState = {
    cards: dash.data.cards.slice(), progress: dash.data.project_progress,
    statusCatalog: ((st.data && st.data.catalog) || []).map(s => ({ ...s })),
    links: links.data || [],
  };
  renderAdminCards();
}

function renderAdminCards() {
  const body = document.getElementById("adminBody");
  const rows = adminState.cards.map((c, i) => `
    <div class="admin-row">
      <div class="admin-move">
        <button data-up="${i}" ${i === 0 ? "disabled" : ""}>▲</button>
        <button data-down="${i}" ${i === adminState.cards.length - 1 ? "disabled" : ""}>▼</button>
      </div>
      <div class="admin-title">${c.title}</div>
      <label class="admin-toggle"><input type="checkbox" data-enabled="${i}" ${c.enabled ? "checked" : ""}> Activée</label>
      <label class="admin-toggle"><input type="checkbox" data-highlight="${i}" ${c.highlighted ? "checked" : ""}> Mise en avant</label>
    </div>`).join("");
  const statusRows = adminState.statusCatalog.map(s => `
    <div class="status-admin-row">
      <input type="checkbox" data-statuskey="${s.key}" ${s.enabled ? "checked" : ""} title="Activé">
      <input type="color" class="status-color-input" data-key="${s.key}" value="${s.color}" title="Couleur">
      <input type="text" class="status-label-input" data-key="${s.key}" value="${s.label.replace(/"/g, "&quot;")}" maxlength="60">
      ${s.builtin ? "" : `<button class="da-del" data-del-status="${s.key}" title="Supprimer">✕</button>`}
    </div>`).join("");
  const linksRows = adminState.links.map(l => `
    <div class="desk-admin-row" data-id="${l.id}">
      <input class="da-name" style="max-width:50px" value="${l.icon || ""}" data-field="icon" placeholder="🔗">
      <input class="da-name" value="${l.label}" data-field="label" placeholder="Libellé">
      <input class="da-name" value="${l.url}" data-field="url" placeholder="https://…">
      <label class="admin-toggle"><input type="checkbox" data-field="enabled" ${l.enabled ? "checked" : ""}> Actif</label>
      <button class="da-del" data-del-link="${l.id}" title="Supprimer">✕</button>
    </div>`).join("");
  body.innerHTML = `
    <p class="sub" style="color:var(--muted);margin:0 0 16px">Configure l'accueil des collaborateurs : active/désactive les cartes, change l'ordre, mets en avant.</p>
    <div class="card"><h3>Cartes de l'accueil</h3><div class="admin-cards">${rows}</div></div>
    <div class="card"><h3>Building Our Future Home</h3>
      <div class="admin-progress">
        <label>Nom du jalon<br><input type="text" id="ppMilestone" value="${(adminState.progress.milestone_title || "").replace(/"/g, "&quot;")}"></label>
        <label>Texte de phase affiché<br><input type="text" id="ppLabel" value="${(adminState.progress.label || "").replace(/"/g, "&quot;")}"></label>
        <label>Date cible (compte à rebours)<br><input type="date" id="ppTarget" value="${adminState.progress.target_date || ""}"></label>
        <label>Progression : <b id="ppVal">${adminState.progress.value}</b> %<br>
          <input type="range" id="ppRange" min="0" max="100" value="${adminState.progress.value}"></label>
      </div>
    </div>
    <div class="card"><h3>Statuts de présence proposés</h3>
      <p class="sub" style="color:var(--muted);margin:0 0 10px">Décoche un statut pour le retirer des choix proposés aux employés, ou ajoutes-en un nouveau.</p>
      <div class="status-admin-list">${statusRows}</div>
      <form id="statusAddForm" class="status-add-form">
        <input id="statusAddLabel" type="text" placeholder="Nouveau statut (ex : Formation)" required maxlength="60">
        <input id="statusAddColor" type="color" value="#00608D" title="Couleur">
        <button type="submit" class="btn-save">Ajouter</button>
      </form>
    </div>
    <button class="btn-save" id="adminSave">Enregistrer</button>
    <div class="card" style="margin-top:16px">
      <h3>Liens utiles</h3>
      <p class="sub" style="color:var(--muted);margin:0 0 10px">Liens externes affichés sur l'accueil (mutuelle, intranet, RH…). Icône = un emoji.</p>
      <form id="linkAddForm" class="idea-form link-add-form" style="margin-bottom:14px">
        <input id="linkIcon" type="text" placeholder="🔗" maxlength="4">
        <input id="linkLabel" type="text" placeholder="Libellé (ex : Mutuelle)" required maxlength="100">
        <input id="linkUrl" type="text" placeholder="https://… ou mailto:contact@eyedpharma.com" required maxlength="500">
        <button type="submit" class="btn-save">Ajouter un lien</button>
      </form>
      <div class="desk-admin-list">${linksRows || `<div class="empty">Aucun lien pour l'instant.</div>`}</div>
    </div>`;
  body.querySelectorAll("[data-up]").forEach(b => b.addEventListener("click", () => moveCard(+b.dataset.up, -1)));
  body.querySelectorAll("[data-down]").forEach(b => b.addEventListener("click", () => moveCard(+b.dataset.down, 1)));
  body.querySelectorAll("[data-enabled]").forEach(cb => cb.addEventListener("change", () => { adminState.cards[+cb.dataset.enabled].enabled = cb.checked; }));
  body.querySelectorAll("[data-highlight]").forEach(cb => cb.addEventListener("change", () => { adminState.cards[+cb.dataset.highlight].highlighted = cb.checked; }));
  body.querySelectorAll("[data-statuskey]").forEach(cb => cb.addEventListener("change", () => {
    const s = adminState.statusCatalog.find(x => x.key === cb.dataset.statuskey);
    if (s) s.enabled = cb.checked;
  }));
  body.querySelectorAll("[data-del-status]").forEach(b => b.addEventListener("click", async () => {
    const { ok, data } = await api(`/api/admin/statuses/${b.dataset.delStatus}`, { method: "DELETE" });
    if (!ok) return toast(data?.detail || "Suppression impossible.", "error");
    state.statusCatalog = state.statusCatalog.filter(s => s.key !== b.dataset.delStatus);
    toast("Statut supprimé", "success");
    renderAdminAccueil();
  }));
  body.querySelectorAll(".status-label-input, .status-color-input").forEach(inp => inp.addEventListener("change", async () => {
    const key = inp.dataset.key;
    const field = inp.classList.contains("status-color-input") ? "color" : "label";
    const value = inp.value.trim();
    if (field === "label" && !value) { toast("Le libellé est obligatoire.", "error"); inp.value = adminState.statusCatalog.find(x => x.key === key).label; return; }
    const { ok, data } = await api(`/api/admin/statuses/${key}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    const s = adminState.statusCatalog.find(x => x.key === key); if (s) s[field] = data[field];
    const gs = state.statusCatalog.find(x => x.key === key); if (gs) gs[field] = data[field];
    toast("Statut mis à jour ✓", "success");
  }));
  document.getElementById("statusAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = document.getElementById("statusAddLabel").value.trim();
    const color = document.getElementById("statusAddColor").value;
    if (!label) return;
    const { ok, data } = await api("/api/admin/statuses", { method: "POST", body: JSON.stringify({ label, color }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    state.statusCatalog.push(data);
    toast("Statut ajouté ✓", "success");
    renderAdminAccueil();
  });
  const range = document.getElementById("ppRange");
  range.addEventListener("input", () => document.getElementById("ppVal").textContent = range.value);
  document.getElementById("adminSave").addEventListener("click", saveAdmin);

  document.getElementById("linkAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const icon = document.getElementById("linkIcon").value.trim() || "🔗";
    const label = document.getElementById("linkLabel").value.trim();
    const url = document.getElementById("linkUrl").value.trim();
    if (!label || !url) return;
    const { ok, data } = await api("/api/admin/links", { method: "POST", body: JSON.stringify({ label, url, icon }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast("Lien ajouté ✓", "success");
    renderAdminAccueil();
  });
  body.querySelectorAll(".desk-admin-list [data-field]").forEach(inp => inp.addEventListener("change", () => {
    const id = +inp.closest("[data-id]").dataset.id;
    const val = inp.type === "checkbox" ? inp.checked : inp.value;
    patchLink(id, { [inp.dataset.field]: val });
  }));
  body.querySelectorAll("[data-del-link]").forEach(b => b.addEventListener("click", () => delLink(+b.dataset.delLink)));
}

function moveCard(i, dir) {
  const j = i + dir; if (j < 0 || j >= adminState.cards.length) return;
  const a = adminState.cards; [a[i], a[j]] = [a[j], a[i]]; renderAdminCards();
}

async function saveAdmin() {
  const order = adminState.cards.map(c => ({ id: c.id, enabled: c.enabled, highlighted: c.highlighted }));
  const r1 = await api("/api/admin/dashboard", { method: "PUT", body: JSON.stringify(order) });
  const r2 = await api("/api/admin/project-progress", { method: "PUT", body: JSON.stringify({
    value: +document.getElementById("ppRange").value, label: document.getElementById("ppLabel").value,
    milestone_title: document.getElementById("ppMilestone").value, target_date: document.getElementById("ppTarget").value || null,
  }) });
  const r3 = await api("/api/admin/statuses", {
    method: "PUT",
    body: JSON.stringify({ enabled: adminState.statusCatalog.filter(s => s.enabled).map(s => s.key) }),
  });
  if (r1.ok && r2.ok && r3.ok) {
    const enabledKeys = new Set(adminState.statusCatalog.filter(s => s.enabled).map(s => s.key));
    state.statusCatalog.forEach(s => { s.enabled = enabledKeys.has(s.key); });
    toast("Accueil mis à jour ✓", "success");
  } else toast("Erreur d'enregistrement.", "error");
}

/* ---- Administration : Contenu (sous-onglets Idées / Quiz / Médias) ---- */
function renderAdminContenu() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="content-subtabs">
      <button data-sub="idees" class="active">Idées</button>
      <button data-sub="quiz">Quiz</button>
      <button data-sub="medias">Médias</button>
      <button data-sub="badges">Badges</button>
    </div>
    <div id="contenuBody"></div>`;
  const SUB = { idees: renderAdminIdees, quiz: renderAdminQuiz, medias: renderAdminMedias, badges: renderAdminBadges };
  body.querySelectorAll(".content-subtabs button").forEach(b => b.addEventListener("click", () => {
    body.querySelectorAll(".content-subtabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    SUB[b.dataset.sub]("contenuBody");
  }));
  renderAdminIdees("contenuBody");
}

/* ---- Administration : badges (création/édition/suppression/attribution manuelle) ---- */
const pointsValue = (raw) => +raw || 0;   // même coercion pour le champ points, qu'il vienne du form d'ajout ou d'une ligne existante

async function renderAdminBadges(targetId = "adminBody") {
  const body = document.getElementById(targetId);
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const [badgesRes, usersRes] = await Promise.all([api("/api/admin/badges"), api("/api/admin/users")]);
  if (!badgesRes.ok) { body.innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  const badges = badgesRes.data || [];
  const users = usersRes.data || [];
  const userOptions = users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");

  const rows = badges.map(b => `
    <div class="badge-admin-row" data-id="${b.id}">
      <div class="badge-admin-top">
        <input class="badge-admin-icon" value="${escapeHtml(b.icon)}" data-field="icon" maxlength="4">
        <input class="badge-admin-name" value="${escapeHtml(b.name)}" data-field="name">
        <input class="badge-admin-points" type="number" min="0" max="1000" value="${b.points}" data-field="points" title="Points accordés" style="width:64px;flex-shrink:0">
        <button class="da-del" data-del-badge="${b.id}" title="Supprimer">✕</button>
      </div>
      <textarea class="badge-admin-desc" data-field="description" rows="2" placeholder="Description">${escapeHtml(b.description)}</textarea>
      <div class="badge-admin-meta">
        <span class="muted">${b.earned_count} collaborateur(s) l'ont obtenu${b.is_custom ? "" : " · badge de base (règle automatique)"} · ${b.points} pts</span>
      </div>
      <div class="badge-admin-award">
        <select class="badge-award-select">
          <option value="">Choisir un collaborateur…</option>
          ${userOptions}
        </select>
        <button class="link-more" data-award="${b.id}">Attribuer</button>
        <button class="link-more" data-revoke="${b.id}">Retirer</button>
      </div>
    </div>`).join("");

  body.innerHTML = `
    <p class="sub" style="color:var(--muted);margin:0 0 16px">Crée, modifie ou supprime des badges. Un badge personnalisé n'a pas de règle d'obtention automatique : attribue-le manuellement aux collaborateurs concernés.</p>
    <div class="card">
      <h3>Nouveau badge personnalisé</h3>
      <form id="badgeAddForm" class="status-add-form">
        <input id="badgeAddIcon" type="text" placeholder="🏅" maxlength="4" style="width:52px;flex-shrink:0;text-align:center">
        <input id="badgeAddName" type="text" placeholder="Nom du badge" required maxlength="100" style="flex:1">
        <input id="badgeAddPoints" type="number" min="0" max="1000" placeholder="Points" value="15" style="width:80px;flex-shrink:0">
        <button type="submit" class="btn-save">Ajouter</button>
      </form>
      <textarea id="badgeAddDesc" placeholder="Description (optionnel)" rows="2" style="width:100%;margin-top:10px;border:1px solid var(--line);border-radius:var(--radius-sm);padding:9px 11px;font-family:inherit;font-size:.88rem"></textarea>
    </div>
    <div class="badge-admin-list">${rows || `<div class="empty">Aucun badge.</div>`}</div>`;

  document.getElementById("badgeAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const icon = document.getElementById("badgeAddIcon").value.trim() || "🏅";
    const name = document.getElementById("badgeAddName").value.trim();
    const description = document.getElementById("badgeAddDesc").value.trim();
    const points = pointsValue(document.getElementById("badgeAddPoints").value);
    if (!name) return;
    const { ok, data } = await api("/api/admin/badges", { method: "POST", body: JSON.stringify({ name, description, icon, points }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast("Badge créé ✓", "success");
    renderAdminBadges(targetId);
  });

  const selectedUserId = (row) => {
    const userId = +row.querySelector(".badge-award-select").value;
    if (!userId) toast("Choisis un collaborateur.", "error");
    return userId || null;
  };
  body.querySelectorAll(".badge-admin-row").forEach(row => {
    const id = +row.dataset.id;
    row.querySelectorAll("[data-field]").forEach(inp => inp.addEventListener("change", async () => {
      const value = inp.type === "number" ? pointsValue(inp.value) : inp.value;
      const { ok, data } = await api(`/api/admin/badges/${id}`, { method: "PATCH", body: JSON.stringify({ [inp.dataset.field]: value }) });
      if (!ok) return toast(data?.detail || "Erreur", "error");
      toast("Badge mis à jour ✓", "success");
    }));
    row.querySelector("[data-del-badge]").addEventListener("click", async () => {
      if (!confirm("Supprimer ce badge ? Les collaborateurs qui l'ont obtenu le perdront.")) return;
      const { ok } = await api(`/api/admin/badges/${id}`, { method: "DELETE" });
      if (!ok) return toast("Erreur", "error");
      toast("Badge supprimé", "success");
      renderAdminBadges(targetId);
    });
    row.querySelector("[data-award]").addEventListener("click", async () => {
      const userId = selectedUserId(row);
      if (!userId) return;
      const { ok, data } = await api(`/api/admin/badges/${id}/award`, { method: "POST", body: JSON.stringify({ user_id: userId }) });
      if (!ok) return toast(data?.detail || "Erreur", "error");
      toast("Badge attribué ✓", "success");
      renderAdminBadges(targetId);
    });
    row.querySelector("[data-revoke]").addEventListener("click", async () => {
      const userId = selectedUserId(row);
      if (!userId) return;
      if (!confirm("Retirer ce badge à ce collaborateur ? Les points associés seront repris.")) return;
      const { ok, data } = await api(`/api/admin/badges/${id}/award/${userId}`, { method: "DELETE" });
      if (!ok) return toast(data?.detail || "Erreur", "error");
      toast("Badge retiré", "success");
      renderAdminBadges(targetId);
    });
  });
}

/* ---- Administration : workflow de la boîte à idées ---- */
async function renderAdminIdees(targetId = "adminBody") {
  const body = document.getElementById(targetId);
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const ideas = (await api("/api/ideas")).data || [];
  if (!ideas.length) { body.innerHTML = `<div class="empty">Aucune idée soumise.</div>`; return; }
  body.innerHTML = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Fais avancer le statut de chaque idée. Une idée archivée disparaît de la liste des employés.</p>
    <div id="adminIdeaList"></div>`;
  const list = document.getElementById("adminIdeaList");
  for (const idea of ideas) {
    const row = document.createElement("div"); row.className = "card"; row.style.marginBottom = "10px";
    row.innerHTML = `<div class="idea-head"><div><div class="idea-title">${idea.title}</div>
        <div class="idea-meta">${idea.is_anonymous ? "Anonyme" : idea.author_name} · ${idea.vote_count} vote(s)</div></div>
      <select class="idea-status-select">
        ${Object.entries(IDEA_STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${idea.status === k ? "selected" : ""}>${l}</option>`).join("")}
      </select></div>`;
    row.querySelector("select").addEventListener("change", async (e) => {
      const { ok } = await api(`/api/admin/ideas/${idea.id}/status`, { method: "PUT", body: JSON.stringify({ status: e.target.value }) });
      toast(ok ? "Statut mis à jour ✓" : "Erreur", ok ? "success" : "error");
    });
    list.appendChild(row);
  }
}

/* Liens utiles : rendu fusionné dans renderAdminCards() (onglet Accueil). */
async function patchLink(id, patch) {
  const { ok } = await api(`/api/admin/links/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  toast(ok ? "Enregistré ✓" : "Erreur", ok ? "success" : "error");
}
async function delLink(id) {
  if (!confirm("Supprimer ce lien ?")) return;
  const { ok } = await api(`/api/admin/links/${id}`, { method: "DELETE" });
  if (ok) { toast("Lien supprimé", "success"); renderAdminAccueil(); }
  else toast("Erreur", "error");
}

/* ---- Administration : quiz ---- */
async function renderAdminQuiz(targetId = "adminBody") {
  const body = document.getElementById(targetId);
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const quizzes = (await api("/api/admin/quizzes")).data || [];
  body.innerHTML = `
    <div class="card">
      <h3>Créer un quiz ou un sondage</h3>
      <form id="quizCreateForm" class="idea-form">
        <input id="qzTitle" type="text" placeholder="Titre" required maxlength="150">
        <textarea id="qzDesc" placeholder="Description (optionnel)" rows="2"></textarea>
        <label class="admin-toggle" style="justify-content:flex-start;gap:8px">
          <input id="qzIsSurvey" type="checkbox"> Sondage</label>
        <label class="admin-toggle" style="justify-content:flex-start;gap:8px">Publication programmée (optionnel)
          <input id="qzPublishAt" type="datetime-local"></label>
        <button type="submit" class="btn-save">Créer</button>
      </form>
    </div>
    <div id="quizAdminList"></div>`;
  document.getElementById("quizCreateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("qzTitle").value.trim();
    if (!title) return;
    const description = document.getElementById("qzDesc").value.trim() || null;
    const is_survey = document.getElementById("qzIsSurvey").checked;
    const raw = document.getElementById("qzPublishAt").value;
    const publish_at = raw ? new Date(raw).toISOString() : null;
    const { ok, data } = await api("/api/admin/quizzes", { method: "POST", body: JSON.stringify({ title, description, publish_at, is_survey }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast(is_survey ? "Sondage créé ✓" : "Quiz créé ✓", "success");
    renderAdminQuiz(targetId);
  });
  const list = document.getElementById("quizAdminList");
  for (const qz of quizzes) {
    const card = document.createElement("div"); card.className = "card"; card.style.marginBottom = "10px";
    card.innerHTML = `
      <div class="idea-head">
        <div><div class="idea-title">${qz.title} <span class="idea-status-badge">${qz.is_survey ? "Sondage" : "Quiz"}</span> <button class="edit-pencil" data-edit-quiz="${qz.id}" title="Modifier">✎</button></div>
          <div class="idea-meta">${qz.question_count} question(s) · ${qz.attempt_count} réponse(s)${qz.publish_at ? ` · publié le ${fdate(qz.publish_at, { day: "numeric", month: "short" })}` : ""}</div></div>
        <button class="link-more" data-del-quiz="${qz.id}">Supprimer</button>
      </div>
      <div class="idea-comments hidden" id="qzedit-${qz.id}"></div>
      <button class="link-more" data-toggle-questions="${qz.id}" style="margin-top:8px">+ Gérer les questions</button>
      <div class="idea-comments hidden" id="qzq-${qz.id}"></div>`;
    card.querySelector("[data-del-quiz]").addEventListener("click", async () => {
      if (!confirm("Supprimer ce quiz et toutes ses réponses ?")) return;
      await api(`/api/admin/quizzes/${qz.id}`, { method: "DELETE" });
      toast("Quiz supprimé", "success"); renderAdminQuiz(targetId);
    });
    card.querySelector("[data-edit-quiz]").addEventListener("click", () => toggleQuizEdit(qz, targetId));
    card.querySelector("[data-toggle-questions]").addEventListener("click", () => toggleQuizQuestions(qz.id, qz.is_survey));
    list.appendChild(card);
  }
  if (!quizzes.length) list.innerHTML = `<div class="empty">Aucun quiz créé pour l'instant.</div>`;
}

function toggleQuizEdit(qz, targetId) {
  const box = document.getElementById(`qzedit-${qz.id}`);
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  const publishVal = qz.publish_at ? qz.publish_at.slice(0, 16) : "";
  box.innerHTML = `<form class="idea-form">
    <input type="text" class="qz-edit-title" value="${qz.title.replace(/"/g, "&quot;")}" required>
    <textarea class="qz-edit-desc" rows="2">${qz.description || ""}</textarea>
    <label class="admin-toggle" style="justify-content:flex-start;gap:8px">Publication programmée (optionnel)
      <input type="datetime-local" class="qz-edit-publish" value="${publishVal}"></label>
    <button type="submit" class="btn-save">Enregistrer</button>
  </form>`;
  box.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = box.querySelector(".qz-edit-title").value.trim();
    if (!title) return;
    const description = box.querySelector(".qz-edit-desc").value.trim() || null;
    const raw = box.querySelector(".qz-edit-publish").value;
    const publish_at = raw ? new Date(raw).toISOString() : null;
    const { ok, data } = await api(`/api/admin/quizzes/${qz.id}`, { method: "PATCH", body: JSON.stringify({ title, description, publish_at, is_survey: qz.is_survey }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast("Quiz mis à jour ✓", "success");
    renderAdminQuiz(targetId);
  });
}

function toggleQuizQuestions(quizId, isSurvey = false) {
  const box = document.getElementById(`qzq-${quizId}`);
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  renderQuestionEditor(quizId, box, null, isSurvey);
}

async function renderQuestionEditor(quizId, box, editingQuestion = null, isSurvey = false) {
  box.innerHTML = `<div class="empty">Chargement…</div>`;
  const quiz = (await api(`/api/admin/quizzes/${quizId}`)).data;
  const existing = (quiz?.questions || []).map(q => `
    <div class="idea-comment">${q.text}
      <button class="edit-pencil" data-edit-q="${q.id}" title="Modifier">✎</button>
      <button class="link-more" data-del-q="${q.id}" style="margin-left:6px">supprimer</button>
    </div>`).join("") || `<div class="empty">Aucune question.</div>`;

  box.innerHTML = `<div style="margin-bottom:10px">${existing}</div>
    <form id="qForm-${quizId}" class="idea-form">
      <input type="text" class="q-text" placeholder="Texte de la question" required>
      <select class="q-type">
        <option value="qcm">QCM</option>
        <option value="vrai_faux">Vrai / Faux</option>
      </select>
      <div class="q-choices"></div>
      <button type="button" class="link-more" data-add-choice>+ Ajouter un choix</button>
      <button type="submit" class="btn-save">${editingQuestion ? "Enregistrer la question" : "Ajouter la question"}</button>
      ${editingQuestion ? `<button type="button" class="link-more" data-cancel-edit>Annuler la modification</button>` : ""}
    </form>`;
  box.querySelectorAll("[data-del-q]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Supprimer cette question ?")) return;
    await api(`/api/admin/quizzes/questions/${b.dataset.delQ}`, { method: "DELETE" });
    toast("Question supprimée", "success"); renderQuestionEditor(quizId, box, null, isSurvey);
  }));
  box.querySelectorAll("[data-edit-q]").forEach(b => b.addEventListener("click", () => {
    const q = quiz.questions.find(x => x.id === +b.dataset.editQ);
    renderQuestionEditor(quizId, box, q, isSurvey);
  }));

  const form = document.getElementById(`qForm-${quizId}`);
  const choicesBox = form.querySelector(".q-choices");
  const typeSel = form.querySelector(".q-type");
  const cancelBtn = form.querySelector("[data-cancel-edit]");
  if (cancelBtn) cancelBtn.addEventListener("click", () => renderQuestionEditor(quizId, box, null, isSurvey));

  function choiceRow(text = "", correct = false) {
    const row = document.createElement("div"); row.className = "quiz-choice-row";
    const correctInput = isSurvey ? "" : `<input type="radio" name="correct-${quizId}" ${correct ? "checked" : ""}>`;
    row.innerHTML = `${correctInput}<input type="text" class="c-text" value="${text.replace(/"/g, "&quot;")}" placeholder="Choix"><button type="button" class="choice-del" title="Retirer ce choix">✕</button>`;
    row.querySelector(".choice-del").addEventListener("click", () => {
      if (choicesBox.querySelectorAll(".quiz-choice-row").length > 2) row.remove();
      else toast("Il faut au moins 2 choix.", "error");
    });
    choicesBox.appendChild(row);
  }
  function resetChoices() {
    choicesBox.innerHTML = "";
    if (typeSel.value === "vrai_faux") { choiceRow("Vrai"); choiceRow("Faux"); }
    else { choiceRow(); choiceRow(); }
  }

  if (editingQuestion) {
    form.querySelector(".q-text").value = editingQuestion.text;
    typeSel.value = editingQuestion.type;
    choicesBox.innerHTML = "";
    editingQuestion.choices.forEach(c => choiceRow(c.text, c.is_correct));
  } else {
    resetChoices();
  }
  typeSel.addEventListener("change", resetChoices);
  form.querySelector("[data-add-choice]").addEventListener("click", () => choiceRow());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = form.querySelector(".q-text").value.trim();
    if (!text) return;
    const rows = [...choicesBox.querySelectorAll(".quiz-choice-row")];
    const choices = rows.map(r => ({
      text: r.querySelector(".c-text").value.trim(),
      is_correct: isSurvey ? false : r.querySelector('input[type="radio"]').checked,
    })).filter(c => c.text);
    if (choices.length < 2) return toast("Il faut au moins 2 choix.", "error");
    if (!isSurvey && !choices.some(c => c.is_correct)) {
      return toast("Il faut cocher une bonne réponse.", "error");
    }
    const path = editingQuestion
      ? `/api/admin/quizzes/questions/${editingQuestion.id}`
      : `/api/admin/quizzes/${quizId}/questions`;
    const { ok, data } = await api(path, {
      method: editingQuestion ? "PATCH" : "POST", body: JSON.stringify({ text, type: typeSel.value, choices }),
    });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast(editingQuestion ? "Question mise à jour ✓" : "Question ajoutée ✓", "success");
    renderQuestionEditor(quizId, box, null, isSurvey);
  });
}

/* ---- Administration : médias ---- */
async function renderAdminMedias(targetId = "adminBody") {
  const body = document.getElementById(targetId);
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const items = (await api("/api/admin/media")).data || [];
  body.innerHTML = `
    <div class="card">
      <h3>Ajouter un média</h3>
      <form id="mediaForm" class="idea-form">
        <select id="mdType"><option value="video">Vidéo</option><option value="album">Album photo</option></select>
        <input id="mdTitle" type="text" placeholder="Titre" required maxlength="150">
        <textarea id="mdDesc" placeholder="Description (optionnel)" rows="2"></textarea>
        <input id="mdUrl" type="text" placeholder="Lien (YouTube, Drive…)" required maxlength="500">
        <label class="admin-toggle"><input type="checkbox" id="mdComments" checked> Commentaires activés</label>
        <button type="submit" class="btn-save">Ajouter</button>
      </form>
    </div>
    <div id="mediaAdminList"></div>`;
  document.getElementById("mediaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("mdTitle").value.trim();
    const url = document.getElementById("mdUrl").value.trim();
    if (!title || !url) return;
    const body = {
      type: document.getElementById("mdType").value, title,
      description: document.getElementById("mdDesc").value.trim() || null,
      url, comments_enabled: document.getElementById("mdComments").checked,
    };
    const { ok, data } = await api("/api/admin/media", { method: "POST", body: JSON.stringify(body) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast("Média ajouté ✓", "success");
    renderAdminMedias(targetId);
  });
  const list = document.getElementById("mediaAdminList");
  list.innerHTML = items.length ? "" : `<div class="empty">Aucun média pour l'instant.</div>`;
  for (const it of items) {
    const row = document.createElement("div"); row.className = "event-admin-row"; row.style.marginBottom = "8px";
    row.innerHTML = `<div class="event-admin-top">
      <div class="event-admin-info"><div class="ev-title">${MEDIA_TYPE_LABEL[it.type] || it.type} · ${it.title} <button class="edit-pencil" data-edit-media="${it.id}" title="Modifier">✎</button></div></div>
      <button class="link-more" data-del-media="${it.id}">Supprimer</button>
    </div>
    <div class="idea-comments hidden" id="mdedit-${it.id}"></div>`;
    row.querySelector("[data-del-media]").addEventListener("click", async () => {
      if (!confirm("Supprimer ce média ?")) return;
      await api(`/api/admin/media/${it.id}`, { method: "DELETE" });
      toast("Média supprimé", "success"); renderAdminMedias(targetId);
    });
    row.querySelector("[data-edit-media]").addEventListener("click", () => toggleMediaEdit(it, targetId));
    list.appendChild(row);
  }
}

function toggleMediaEdit(it, targetId) {
  const box = document.getElementById(`mdedit-${it.id}`);
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = `<form class="idea-form">
    <select class="md-edit-type"><option value="video">Vidéo</option><option value="album">Album photo</option></select>
    <input type="text" class="md-edit-title" value="${it.title.replace(/"/g, "&quot;")}" required maxlength="150">
    <textarea class="md-edit-desc" rows="2">${it.description || ""}</textarea>
    <input type="text" class="md-edit-url" value="${it.url}" required maxlength="500">
    <label class="admin-toggle"><input type="checkbox" class="md-edit-comments" ${it.comments_enabled ? "checked" : ""}> Commentaires activés</label>
    <button type="submit" class="btn-save">Enregistrer</button>
  </form>`;
  box.querySelector(".md-edit-type").value = it.type;
  box.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = box.querySelector(".md-edit-title").value.trim();
    const url = box.querySelector(".md-edit-url").value.trim();
    if (!title || !url) return;
    const body = {
      type: box.querySelector(".md-edit-type").value, title,
      description: box.querySelector(".md-edit-desc").value.trim() || null,
      url, comments_enabled: box.querySelector(".md-edit-comments").checked,
    };
    const { ok, data } = await api(`/api/admin/media/${it.id}`, { method: "PATCH", body: JSON.stringify(body) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast("Média mis à jour ✓", "success");
    renderAdminMedias(targetId);
  });
}

/* ---- Administration : cockpit (KPI + alertes) ---- */
const CHART_COLORS = ["#00608D", "#10B981", "#F59E0B", "#F43F5E", "#7A4E86", "#0891b2"];

function svgBarChart(data, { height = 160 } = {}) {
  // Les libellés (dates) sont rendus en HTML normal sous le graphique, PAS en <text> SVG :
  // avec preserveAspectRatio="none" (nécessaire pour que les barres remplissent la largeur),
  // le texte SVG se retrouve étiré non-uniformément et devient illisible sur petit écran (mobile).
  const max = Math.max(1, ...data.map(d => d.value));
  const n = data.length;
  const barW = 100 / n;
  const showEvery = n > 10 ? 2 : 1;
  const bars = data.map((d, i) => {
    const h = max ? (d.value / max) * height : 0;
    const x = i * barW;
    return `<g><title>${d.label} : ${d.value}</title>
      <rect x="${x + barW * 0.18}%" y="${height - h}" width="${barW * 0.64}%" height="${Math.max(h, 1)}" rx="3" fill="#00608D"></rect>
      </g>`;
  }).join("");
  const labels = data.filter((d, i) => i % showEvery === 0).map(d => `<span>${d.label}</span>`).join("");
  return `<svg viewBox="0 0 100 ${height}" preserveAspectRatio="none" class="chart-svg" style="height:${height}px">${bars}</svg>
    <div class="chart-labels">${labels}</div>`;
}

function svgDonutChart(data) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = 50, c = 2 * Math.PI * r;
  let offset = 0;
  const circles = data.map((d, i) => {
    const dash = (d.value / total) * c;
    const el = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${CHART_COLORS[i % CHART_COLORS.length]}" stroke-width="18"
      stroke-dasharray="${dash} ${c - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"><title>${d.label} : ${d.value}</title></circle>`;
    offset += dash;
    return el;
  }).join("");
  const legend = data.map((d, i) => `<div class="chart-legend-item"><span class="chart-legend-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>${d.label} (${d.value})</div>`).join("");
  return `<div class="chart-donut-wrap"><svg viewBox="0 0 140 140" class="chart-donut">${circles}</svg><div class="chart-legend">${legend || `<div class="empty">Aucune donnée.</div>`}</div></div>`;
}

async function renderAdminStats() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const { ok, data } = await api("/api/admin/stats");
  if (!ok) { body.innerHTML = `<div class="empty">Accès refusé.</div>`; return; }
  const k = data.kpis;
  const tiles = [
    { label: "Collaborateurs actifs (7j)", value: `${k.active_users_7d} / ${k.total_users}` },
    { label: "Occupation coworking (aujourd'hui)", value: `${k.coworking_occupancy_pct}%` },
    { label: "Réservations (7j)", value: k.reservations_week },
    { label: "No-show (7j)", value: k.noshow_week },
    { label: "Inscriptions événements", value: k.event_registrations },
    { label: "Tentatives de quiz", value: k.quiz_attempts },
    { label: "Score moyen quiz", value: k.quiz_score_avg_pct != null ? `${k.quiz_score_avg_pct}%` : "—" },
    { label: "Idées soumises", value: `${k.ideas_total} (${k.ideas_votes} votes)` },
    { label: "Médias publiés", value: k.media_total },
  ];
  const ch = data.charts;
  body.innerHTML = `
    <p class="sub" style="color:var(--muted);margin:0 0 16px">Vue d'ensemble de l'activité sur l'application.</p>
    <div class="stats-grid">${tiles.map(t => `
      <div class="card stat-tile"><div class="stat-value">${t.value}</div><div class="stat-label">${t.label}</div></div>`).join("")}</div>

    <div class="card" style="margin-top:16px">
      <h3>Réservations — 14 derniers jours</h3>
      ${svgBarChart(ch.reservations_by_day)}
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Réservations — 14 prochains jours</h3>
      ${svgBarChart(ch.reservations_next_14_days)}
    </div>
    <div class="dash-cols" style="margin-top:16px">
      <div class="card"><h3>Idées par statut</h3>${svgDonutChart(ch.ideas_by_status)}</div>
      <div class="card"><h3>Inscriptions événements</h3>${svgDonutChart(ch.event_registrations_by_status)}</div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Répartition des scores de quiz</h3>
      ${svgBarChart(ch.quiz_score_distribution, { height: 140 })}
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Alertes</h3>
      <div class="idea-comment-list">${data.alerts.length
        ? data.alerts.map(a => `<div class="idea-comment">⚠️ ${a}</div>`).join("")
        : `<div class="empty">Rien à signaler ✓</div>`}</div>
    </div>`;
}

/* ---- Administration : postes & espaces (capacités) ---- */
async function renderAdminEspaces() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const [{ ok, data }, labelsRes, policyRes, spacesRes, iconsRes, dispoRes] = await Promise.all([
    api("/api/admin/desks"), api("/api/room-labels"), api("/api/reservation-policy"),
    api("/api/spaces"), api("/api/feature-icons"), api("/api/admin/availability"),
  ]);
  if (!ok) { body.innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  const labels = labelsRes.data || {};
  const advanceDays = (policyRes.data && policyRes.data.advance_days) || 7;
  const espaces = (spacesRes.data && spacesRes.data.groups) || [];
  const modes = (spacesRes.data && spacesRes.data.modes) || {};
  const iconRules = (iconsRes.data && iconsRes.data.rules) || [];
  const groups = {};
  for (const d of data) (groups[d.zone || "Sans bureau"] ||= []).push(d);
  const MODE_LABELS = {
    seat: "Réserver une place", table: "Réserver une table entière",
    room: "Réserver une salle entière", pod: "Réserver une bulle calme",
  };

  let html = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Gère les postes et la capacité de chaque bureau. Chaque changement est enregistré immédiatement.</p>
    <div class="card">
      <h3>Ce qui est réservable</h3>
      <div class="card-note">Décoche pour fermer un mode de réservation à tout le monde. Les réservations déjà prises ne sont pas annulées.</div>
      <div class="toggle-list">
        ${Object.entries(MODE_LABELS).map(([mode, label]) => `
          <label class="toggle-row">
            <input type="checkbox" data-booking-mode="${mode}"${modes[mode] !== false ? " checked" : ""}>
            <span>${label}</span>
          </label>`).join("")}
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Disponibilité</h3>
      <div class="card-note">Décoche ce qui n'est pas réservable : un espace entier, ou une place précise. Ce qui est décoché reste visible sur le plan, hachuré, et n'est plus proposé. Les dates sont facultatives : sans elles la fermeture vaut jusqu'à ce que tu recoches.</div>
      <div id="dispoSpaces" class="dispo-group"></div>
      <div class="dispo-eyebrow">Places</div>
      <div id="dispoDesks" class="dispo-group"></div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Icônes des types de poste</h3>
      <div class="card-note">Une place affiche l'icône de la première ligne dont le mot-clé apparaît dans ses équipements. Mets « double écran » avant « écran », sinon la règle la plus générale gagne.</div>
      <div id="iconRules"></div>
      <div class="visitor-form">
        <input id="iconKeyword" maxlength="60" placeholder="Mot-clé (ex : écran courbé)">
        <input id="iconEmoji" maxlength="8" placeholder="Icône" style="flex:0 0 5rem">
        <button class="btn btn-ghost" id="iconAddBtn" type="button">Ajouter la règle</button>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Image du plan</h3>
      <div class="card-note">Remplace le plan affiché aux collaborateurs. L'image est conservée en base de données, elle survit donc aux mises à jour du site. Formats image, 5 Mo maximum. Repasse ensuite par le placement des postes si le cadrage a changé.</div>
      <div class="visitor-form">
        <input type="file" id="planFile" accept="image/*">
        <button class="btn btn-ghost" id="planUploadBtn" type="button">Envoyer le plan</button>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Placer les postes sur le plan</h3>
      <div class="card-note">Choisis un poste dans la liste, puis clique à l'endroit voulu sur le plan. Un poste déjà placé se déplace en le sélectionnant puis en recliquant ailleurs. À refaire après chaque nouvelle image, si le cadrage a changé.</div>
      <div class="plan-editor">
        <select id="planEditorDesk" class="group-seat-mode"></select>
        <div class="plan-wrap" id="planEditorWrap">
          <img src="${floorplanUrl()}" alt="Plan des locaux" class="plan-image">
          <div class="plan-pins" id="planEditorPins"></div>
        </div>
        <div class="plan-note" id="planEditorNote"></div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Noms affichés</h3>
      <div class="room-label-grid">
        <label>Bureau 1 <input class="room-label-input" data-ref="Bureau 1" value="${(labels["Bureau 1"] || "Bureau 1").replace(/"/g, "&quot;")}"></label>
        <label>Bureau 2 <input class="room-label-input" data-ref="Bureau 2" value="${(labels["Bureau 2"] || "Bureau 2").replace(/"/g, "&quot;")}"></label>
        <label>Bulle calme 1 <input class="room-label-input" data-ref="BC-1" value="${(labels["BC-1"] || "Bulle calme 1").replace(/"/g, "&quot;")}"></label>
        <label>Bulle calme 2 <input class="room-label-input" data-ref="BC-2" value="${(labels["BC-2"] || "Bulle calme 2").replace(/"/g, "&quot;")}"></label>
        ${Object.keys(labels).filter(k => /^T\d+$/.test(k)).sort().map(ref => `
        <label>${escapeHtml(ref)} <input class="room-label-input" data-ref="${ref}" value="${(labels[ref] || "").replace(/"/g, "&quot;")}"></label>`).join("")}
      </div>
    </div>
    <div class="card">
      <h3>Horizon de réservation</h3>
      <p class="sub" style="color:var(--muted);margin:0 0 10px">Nombre de jours à l'avance où une place peut être réservée (ex : 5 jours ouvre la semaine suivante dès le mercredi).</p>
      <label class="admin-toggle">Ouvre les réservations
        <input type="number" id="advanceDaysInput" min="1" max="30" value="${advanceDays}" style="width:64px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit">
        jour(s) à l'avance</label>
    </div>`;
  for (const [zone, desks] of Object.entries(groups)) {
    const active = desks.filter(d => d.is_active).length;
    html += `<div class="card"><div class="card-head">
        <h3>${zone} <span class="muted" style="font-weight:400">· ${active} place${active > 1 ? "s" : ""} active${active > 1 ? "s" : ""}</span></h3>
        <button class="link-more" data-add="${zone}">+ Ajouter un poste</button></div>
      <div class="desk-admin-head"><span>Nom</span><span>Position (X / Y %)</span><span>Active</span><span></span></div>
      <div class="desk-admin-list">`;
    for (const d of desks) {
      html += `<div class="desk-admin-row" data-id="${d.id}">
        <input class="da-name" value="${d.name}" data-field="name">
        <div class="da-pos-group">
          <input class="da-pos" type="number" placeholder="X %" value="${d.pos_x ?? ""}" data-field="pos_x">
          <input class="da-pos" type="number" placeholder="Y %" value="${d.pos_y ?? ""}" data-field="pos_y">
        </div>
        <input class="da-features" placeholder="Caractéristiques (ex : double écran, compatible Surface)" value="${(d.features || "").replace(/"/g, "&quot;")}" data-field="features">
        <label class="admin-toggle"><input type="checkbox" data-field="is_active" ${d.is_active ? "checked" : ""}> Active</label>
        <button class="da-del" title="Supprimer">✕</button>
      </div>`;
    }
    html += `</div></div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll(".desk-admin-row").forEach(row => {
    const id = +row.dataset.id;
    row.querySelectorAll("[data-field]").forEach(inp => inp.addEventListener("change", () => {
      const val = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? (inp.value === "" ? null : +inp.value) : inp.value;
      patchDesk(id, { [inp.dataset.field]: val });
    }));
    row.querySelector(".da-del").addEventListener("click", () => delDesk(id));
  });
  body.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () => addDesk(b.dataset.add)));
  // --- Interrupteurs des modes de réservation ---
  body.querySelectorAll("[data-booking-mode]").forEach(cb => cb.addEventListener("change", async () => {
    const { ok, data } = await api("/api/admin/booking-modes", {
      method: "PATCH", body: JSON.stringify({ mode: cb.dataset.bookingMode, enabled: cb.checked }),
    });
    if (!ok) { cb.checked = !cb.checked; toast((data && data.detail) || "Erreur", "error"); return; }
    toast(cb.checked ? "Mode ouvert ✓" : "Mode fermé ✓", "success");
  }));


  // --- Disponibilité : un espace ou une place, avec ou sans dates ---
  let dispo = dispoRes.data || { spaces: [], desks: [] };

  /* Une ligne = une case, un libellé, et deux dates qui n'apparaissent que si la
     case est décochée : proposer des dates sur ce qui est ouvert n'aurait pas de
     sens, et alourdirait une liste de quarante lignes. */
  function ligneDispo(scope, cible, libelle, detail, etat) {
    const dates = etat.enabled ? "" : `
      <div class="dispo-dates">
        <label>du <input type="date" data-dispo-since="${scope}:${cible}" value="${etat.since || ""}"></label>
        <label>au <input type="date" data-dispo-until="${scope}:${cible}" value="${etat.until || ""}"></label>
        <small>${etat.since || etat.until ? "" : "vide = jusqu'à nouvel ordre"}</small>
      </div>`;
    return `<div class="dispo-row${etat.enabled ? "" : " fermee"}">
      <label class="toggle-row">
        <input type="checkbox" data-dispo="${scope}:${cible}"${etat.enabled ? " checked" : ""}>
        <span>${escapeHtml(libelle)}${detail ? ` <small class="muted">${escapeHtml(detail)}</small>` : ""}</span>
      </label>
      ${dates}
    </div>`;
  }

  function renderDispo() {
    const boxE = document.getElementById("dispoSpaces");
    const boxP = document.getElementById("dispoDesks");
    if (!boxE || !boxP) return;

    boxE.innerHTML = dispo.spaces.map(g =>
      ligneDispo("space", g.ref, g.label, `${g.seats} place${g.seats > 1 ? "s" : ""}`, g)).join("");
    boxP.innerHTML = dispo.desks.map(d =>
      ligneDispo("desk", d.name, d.name, d.zone || "", d)).join("");

    [boxE, boxP].forEach(box => {
      box.querySelectorAll("[data-dispo]").forEach(cb => cb.addEventListener("change", () => {
        const [scope, cible] = cb.dataset.dispo.split(":");
        enregistrerDispo(scope, cible, { enabled: cb.checked, since: null, until: null });
      }));
      box.querySelectorAll("[data-dispo-since], [data-dispo-until]").forEach(inp => {
        inp.addEventListener("change", () => {
          const cle = inp.dataset.dispoSince || inp.dataset.dispoUntil;
          const [scope, cible] = cle.split(":");
          const ligne = inp.closest(".dispo-row");
          enregistrerDispo(scope, cible, {
            enabled: false,
            since: ligne.querySelector("[data-dispo-since]").value || null,
            until: ligne.querySelector("[data-dispo-until]").value || null,
          });
        });
      });
    });
  }

  async function enregistrerDispo(scope, target, etat) {
    const { ok: enregistre, data: reponse } = await api("/api/admin/availability", {
      method: "PATCH", body: JSON.stringify({ scope, target, ...etat }),
    });
    if (!enregistre) { toast((reponse && reponse.detail) || "Erreur", "error"); renderDispo(); return; }

    const liste = scope === "space" ? dispo.spaces : dispo.desks;
    const cle = scope === "space" ? "ref" : "name";
    const item = liste.find(x => x[cle] === target);
    if (item) Object.assign(item, etat);
    renderDispo();
    toast(etat.enabled ? "Disponible ✓" : "Indisponible ✓", "success");
  }

  renderDispo();

  // --- Règles d'icônes ---
  let regles = iconRules.slice();

  function renderIconRules() {
    const box = document.getElementById("iconRules");
    box.innerHTML = regles.length
      ? regles.map((r, i) => `
          <div class="icon-rule">
            <input class="icon-rule-emoji" data-icon-emoji="${i}" maxlength="8" aria-label="Icône"
                   value="${escapeHtml(r.icon).replace(/"/g, "&quot;")}">
            <input class="icon-rule-keyword" data-icon-keyword="${i}" maxlength="60" aria-label="Mot-clé"
                   value="${escapeHtml(r.keyword).replace(/"/g, "&quot;")}">
            <button class="presence-out" data-icon-up="${i}"${i === 0 ? " disabled" : ""} title="Monter la priorité">↑</button>
            <button class="presence-out" data-icon-del="${i}" title="Supprimer">✕</button>
          </div>`).join("")
      : `<div class="empty-inline">Aucune règle : toutes les places afficheront l'icône par défaut.</div>`;

    // Enregistrement à la sortie du champ, comme les autres réglages d'administration.
    box.querySelectorAll("[data-icon-emoji], [data-icon-keyword]").forEach(inp => {
      inp.addEventListener("change", () => {
        const i = +(inp.dataset.iconEmoji ?? inp.dataset.iconKeyword);
        const champ = inp.dataset.iconEmoji !== undefined ? "icon" : "keyword";
        const valeur = inp.value.trim();
        if (!valeur) { toast("Une règle a besoin d'un mot-clé et d'une icône.", "error"); renderIconRules(); return; }
        if (champ === "keyword" && regles.some((r, j) => j !== i && r.keyword.toLowerCase() === valeur.toLowerCase())) {
          toast("Ce mot-clé a déjà une icône.", "error"); renderIconRules(); return;
        }
        if (regles[i][champ] === valeur) return;
        regles[i][champ] = valeur;
        saveIconRules();
      });
    });
    box.querySelectorAll("[data-icon-del]").forEach(b => b.addEventListener("click", () => {
      regles.splice(+b.dataset.iconDel, 1); saveIconRules();
    }));
    box.querySelectorAll("[data-icon-up]").forEach(b => b.addEventListener("click", () => {
      const i = +b.dataset.iconUp;
      [regles[i - 1], regles[i]] = [regles[i], regles[i - 1]];
      saveIconRules();
    }));
  }

  async function saveIconRules() {
    const { ok, data } = await api("/api/admin/feature-icons", {
      method: "PUT", body: JSON.stringify({ rules: regles }),
    });
    if (!ok) { toast((data && data.detail) || "Erreur", "error"); return; }
    regles = (data && data.rules) || regles;
    state.featureIcons = regles;   // l'affichage des places suit immédiatement
    renderIconRules();
    toast("Icônes enregistrées ✓", "success");
  }

  renderIconRules();
  document.getElementById("iconAddBtn").addEventListener("click", () => {
    const mot = document.getElementById("iconKeyword").value.trim();
    const icone = document.getElementById("iconEmoji").value.trim();
    if (!mot || !icone) { toast("Il faut un mot-clé et une icône.", "error"); return; }
    if (regles.some(r => r.keyword.toLowerCase() === mot.toLowerCase())) {
      toast("Ce mot-clé a déjà une icône. Supprime la règle existante d'abord.", "error");
      return;
    }
    // La première règle qui matche gagne : une règle ajoutée à la fin serait
    // battue par une règle plus générale déjà présente (« écran » l'emporterait
    // sur « double écran »). On la place donc juste avant celle-ci.
    const plusGenerale = regles.findIndex(r => mot.toLowerCase().includes(r.keyword.toLowerCase()));
    if (plusGenerale === -1) regles.push({ keyword: mot, icon: icone });
    else regles.splice(plusGenerale, 0, { keyword: mot, icon: icone });
    document.getElementById("iconKeyword").value = "";
    document.getElementById("iconEmoji").value = "";
    saveIconRules();
  });

  // --- Envoi d'une nouvelle image de plan ---
  document.getElementById("planUploadBtn").addEventListener("click", async () => {
    const input = document.getElementById("planFile");
    const fichier = input.files && input.files[0];
    if (!fichier) { toast("Choisis une image.", "error"); return; }

    // FormData impose son propre Content-Type avec la frontière multipart :
    // on n'utilise pas api(), qui force application/json.
    const corps = new FormData();
    corps.append("file", fichier);
    const res = await fetch("/api/admin/floorplan", { method: "POST", credentials: "same-origin", body: corps });
    let data = null; try { data = await res.json(); } catch (_) {}
    if (!res.ok) { toast((data && data.detail) || "Envoi impossible.", "error"); return; }

    toast(`Plan mis à jour (${Math.round(data.bytes / 1024)} Ko) ✓`, "success");
    input.value = "";
    // La version change : toute image du plan rendue ensuite pointe sur la
    // nouvelle URL, y compris sur la page Réserver, sans rechargement manuel.
    state.floorplanVersion = data.version || Date.now();
    document.querySelectorAll('img[src^="/api/floorplan"]').forEach(img => {
      img.src = floorplanUrl();
    });
  });

  // --- Éditeur de plan ---
  //  Les coordonnées sont enregistrées en POURCENTAGE de la taille de l'image, pas en
  //  pixels : le plan s'affiche à des largeurs différentes selon l'écran, et une
  //  position en pixels serait fausse partout ailleurs que sur la machine de l'admin.
  let postes = data.slice().sort((a, b) => a.name.localeCompare(b.name));
  let posteChoisi = postes.length ? postes[0].id : null;

  function renderPlanEditor() {
    const select = document.getElementById("planEditorDesk");
    if (!select) return;
    select.innerHTML = postes.map(d => {
      const place = d.pos_x != null && d.pos_y != null;
      return `<option value="${d.id}"${d.id === posteChoisi ? " selected" : ""}>${escapeHtml(d.name)}${d.zone ? " · " + escapeHtml(d.zone) : ""}${place ? "" : "  (non placé)"}</option>`;
    }).join("");

    const pins = document.getElementById("planEditorPins");
    pins.innerHTML = postes
      .filter(d => d.pos_x != null && d.pos_y != null)
      .map(d => `<button class="plan-pin${d.id === posteChoisi ? " selected" : " free"}" data-editor-desk="${d.id}"
          style="left:${d.pos_x}%; top:${d.pos_y}%" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</button>`)
      .join("");

    pins.querySelectorAll("[data-editor-desk]").forEach(b => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();   // sinon le clic pose aussi le poste à cet endroit
        if (b.dataset.vientDeGlisser) { delete b.dataset.vientDeGlisser; return; }
        posteChoisi = +b.dataset.editorDesk;
        renderPlanEditor();
      });
      b.addEventListener("pointerdown", (e) => demarrerGlisse(e, b));
    });

    const restants = postes.filter(d => d.pos_x == null || d.pos_y == null).length;
    document.getElementById("planEditorNote").textContent = restants
      ? `${restants} poste${restants > 1 ? "s" : ""} pas encore placé${restants > 1 ? "s" : ""}.`
      : "Tous les postes sont placés.";
  }

  /* Coordonnées d'un événement en pourcentage de l'image, bornées au cadre :
     relâcher hors du plan doit coller la pastille au bord, pas l'envoyer à -12 %. */
  function pourcentages(e, img) {
    const r = img.getBoundingClientRect();
    const borne = (v) => Math.min(100, Math.max(0, v));
    return {
      x: +borne(((e.clientX - r.left) / r.width) * 100).toFixed(2),
      y: +borne(((e.clientY - r.top) / r.height) * 100).toFixed(2),
    };
  }

  async function enregistrerPosition(deskId, x, y) {
    const { ok, data: maj } = await api(`/api/admin/desks/${deskId}`, {
      method: "PATCH", body: JSON.stringify({ pos_x: x, pos_y: y }),
    });
    if (!ok) { toast((maj && maj.detail) || "Placement impossible.", "error"); return false; }
    const i = postes.findIndex(d => d.id === deskId);
    if (i !== -1) postes[i] = { ...postes[i], pos_x: x, pos_y: y };
    return true;
  }

  /* Glisser-déposer d'une pastille déjà placée. Elle suit le curseur pendant
     tout le mouvement : sans ce retour visuel on lâche à l'aveugle. */
  function demarrerGlisse(depart, pastille) {
    const img = document.querySelector("#planEditorWrap .plan-image");
    if (!img) return;
    depart.preventDefault();
    const deskId = +pastille.dataset.editorDesk;
    posteChoisi = deskId;
    pastille.classList.add("dragging");
    pastille.setPointerCapture(depart.pointerId);

    let bouge = false;
    let dernier = pourcentages(depart, img);

    const suivre = (e) => {
      dernier = pourcentages(e, img);
      // Seuil de quelques pixels : un clic tremblé ne doit pas compter comme
      // un déplacement, sinon on repositionne un poste en voulant le choisir.
      if (!bouge && Math.abs(e.clientX - depart.clientX) + Math.abs(e.clientY - depart.clientY) < 4) return;
      bouge = true;
      pastille.style.left = dernier.x + "%";
      pastille.style.top = dernier.y + "%";
    };

    const lacher = async () => {
      pastille.removeEventListener("pointermove", suivre);
      pastille.removeEventListener("pointerup", lacher);
      pastille.removeEventListener("pointercancel", lacher);
      pastille.classList.remove("dragging");
      if (!bouge) { renderPlanEditor(); return; }
      pastille.dataset.vientDeGlisser = "1";   // le clic qui suit ne resélectionne pas
      if (await enregistrerPosition(deskId, dernier.x, dernier.y)) toast("Poste déplacé ✓", "success");
      renderPlanEditor();
    };

    pastille.addEventListener("pointermove", suivre);
    pastille.addEventListener("pointerup", lacher);
    pastille.addEventListener("pointercancel", lacher);
  }

  const wrap = document.getElementById("planEditorWrap");
  if (wrap) {
    wrap.addEventListener("click", async (e) => {
      if (!posteChoisi) return;
      const img = wrap.querySelector(".plan-image");
      const { x, y } = pourcentages(e, img);
      if (!(await enregistrerPosition(posteChoisi, x, y))) return;
      renderPlanEditor();

      // Enchaîner : on passe au poste suivant non placé, pour dérouler tout le plan
      // sans revenir à la liste entre chaque clic.
      const suivant = postes.find(d => d.pos_x == null || d.pos_y == null);
      if (suivant) { posteChoisi = suivant.id; renderPlanEditor(); }
      toast("Poste placé ✓", "success");
    });

    document.getElementById("planEditorDesk").addEventListener("change", (e) => {
      posteChoisi = +e.target.value;
      renderPlanEditor();
    });
    renderPlanEditor();
  }

  body.querySelectorAll(".room-label-input").forEach(inp => inp.addEventListener("change", async () => {
    const { ok } = await api("/api/admin/room-labels", { method: "PATCH", body: JSON.stringify({ ref: inp.dataset.ref, label: inp.value }) });
    toast(ok ? "Nom enregistré ✓" : "Erreur", ok ? "success" : "error");
  }));
  document.getElementById("advanceDaysInput").addEventListener("change", async (e) => {
    const days = +e.target.value;
    const { ok, data } = await api("/api/admin/reservation-policy", { method: "PATCH", body: JSON.stringify({ advance_days: days }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    state.advanceDays = days;
    toast("Horizon de réservation enregistré ✓", "success");
  });
}

async function patchDesk(id, patch) {
  const { ok } = await api(`/api/admin/desks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  toast(ok ? "Enregistré ✓" : "Erreur", ok ? "success" : "error");
}
async function addDesk(zone) {
  const name = prompt("Nom du nouveau poste (ex : B1-7) :");
  if (!name) return;
  const { ok, data } = await api("/api/admin/desks", { method: "POST", body: JSON.stringify({ name, zone, pos_x: 50, pos_y: 50 }) });
  if (ok) { toast("Poste ajouté ✓", "success"); renderAdminEspaces(); }
  else toast(data?.detail || "Erreur", "error");
}
async function delDesk(id) {
  if (!confirm("Supprimer ce poste ? Ses réservations seront supprimées.")) return;
  const { ok } = await api(`/api/admin/desks/${id}`, { method: "DELETE" });
  if (ok) { toast("Poste supprimé", "success"); renderAdminEspaces(); }
  else toast("Erreur", "error");
}

/* ============================================================
   VUE : RÉSERVER — tables avec sièges groupés + capacité au centre
   ============================================================ */
/* Jours OUVRÉS (lundi-vendredi) dans les state.advanceDays prochains jours calendaires
   (horizon configurable par l'admin — cf. /api/reservation-policy, plus de constante figée). */
function upcomingWeekdays() {
  const days = []; const d = new Date();
  for (let i = 0; i <= state.advanceDays; i++) {
    const day = new Date(d); day.setDate(d.getDate() + i);
    if (day.getDay() !== 0 && day.getDay() !== 6) days.push(day);
  }
  return days;
}

function viewReserver() {
  const days = upcomingWeekdays();
  document.getElementById("view").innerHTML = `
    <div class="resa-daypicker scroll">
      ${days.map(d => {
        const iso = toLocalISODate(d);
        return `<button class="day-pill" data-day="${iso}">
          <span class="dp-d">${d.toLocaleDateString("fr-FR", { weekday: "short" })}</span>
          <span class="dp-n">${d.getDate()}</span></button>`;
      }).join("")}
    </div>
    <div class="legend">
      <span class="lg"><span class="sw free"></span> Libre</span>
      <span class="lg"><span class="sw occupied"></span> Occupé</span>
      <span class="lg"><span class="sw selected"></span> Sélection</span>
      <span class="lg"><span class="sw mine"></span> Ma résa</span>
    </div>
    <div class="reserve-layout">
      <div>
        <div class="section-eyebrow">Plan de l'espace · clique une place pour la réserver</div>
        <div class="card plan-panel">
          <div class="plan-wrap" id="planWrap">
            <img src="${floorplanUrl()}" alt="Plan réel des locaux : tables 1 à 4 de l'open space, bureaux fermés, bulles calmes et entrées" class="plan-image">
            <div class="plan-pins" id="planPins"></div>
          </div>
          <div class="plan-note" id="planNote"></div>
        </div>
        <div id="tableSections"><div class="empty">Chargement…</div></div>
      </div>
      <div class="side-cards">
        <div class="card"><h3>Mes réservations</h3><div id="myReservations" class="list"></div></div>
      </div>
    </div>`;
  document.querySelectorAll(".day-pill").forEach(b => {
    if (b.dataset.day === state.date) b.classList.add("active");
    b.addEventListener("click", () => {
      document.querySelectorAll(".day-pill").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); state.date = b.dataset.day; clearSelection(); loadReserve();
    });
  });
  loadReserve();
}

const ROOM_ZONES = ["Bureau 1", "Bureau 2"];

async function loadReserve() {
  const [avail, mine, labels, spaces] = await Promise.all([
    api(`/api/availability?date=${state.date}&slot=${state.slot}`),
    api("/api/reservations/me"),
    api("/api/room-labels"),
    api("/api/spaces"),
  ]);
  state.availability = avail.data || [];
  state.myReservations = mine.data || [];
  state.roomLabels = labels.data || {};
  state.spaces = (spaces.data && spaces.data.groups) || [];
  state.bookingModes = (spaces.data && spaces.data.modes) || state.bookingModes;
  state.floorplanVersion = (spaces.data && spaces.data.floorplan_version) || 0;
  // La page est dessinée AVANT que cette réponse n'arrive : l'image du plan porte
  // donc encore `?v=0`. On la repointe maintenant qu'on connaît la version, sinon
  // un navigateur qui a l'ancien plan en mémoire pour cette URL le garde.
  document.querySelectorAll('img[src^="/api/floorplan"]').forEach(img => {
    const voulue = floorplanUrl();
    if (!img.getAttribute("src").endsWith(voulue)) img.src = voulue;
  });

  // Pour chaque espace réservable d'un bloc (salles fermées ET tables de l'open space),
  // sait-on si je l'ai pris en entier ? Sert à proposer « Annuler » plutôt que « Réserver ».
  const refs = state.spaces.filter(g => g.kind !== "pod").map(g => g.ref);
  const groupResults = await Promise.all(
    refs.map(r => api(`/api/reservations/group?ref=${encodeURIComponent(r)}&date=${state.date}`))
  );
  state.myRoomReservations = {};
  refs.forEach((r, i) => {
    state.myRoomReservations[r] = (groupResults[i].data && groupResults[i].data.reservation_ids) || [];
  });

  const podDesks = state.availability.filter(x => x.desk.zone === "Bulles calmes").map(x => x.desk);
  const podResults = await Promise.all(podDesks.map(d => api(`/api/pods/${d.id}/timeslots?date=${state.date}`)));
  state.podBookings = {};
  podDesks.forEach((d, i) => { state.podBookings[d.id] = podResults[i].data || []; });

  renderTables(); renderMyReservations(); renderPlanPins();
}

/* Regroupe les postes en "tables" : un bureau fermé = 1 table, une table d'open space = 1 table */
function groupIntoTables(items) {
  const groups = {};
  for (const it of items) {
    const zone = it.desk.zone || "Autres";
    const key = zone.startsWith("Bureau") ? zone : it.desk.name.split("-")[0];
    (groups[key] ||= { key, zone, items: [] }).items.push(it);
  }
  return Object.values(groups).map(g => {
    g.items.sort((a, b) => a.desk.name.localeCompare(b.desk.name));
    // Salles et tables se renomment toutes deux depuis l'administration ; à défaut,
    // « Bureau 2 » pour une salle et « Table 3 » pour la table T3.
    const defaut = g.zone.startsWith("Bureau") ? g.zone : `Table ${g.key.replace(/^T/, "")}`;
    const label = (state.roomLabels && state.roomLabels[g.key]) || defaut;
    const half = Math.ceil(g.items.length / 2);
    return { ...g, label, cap: g.items.length, topSeats: g.items.slice(0, half), botSeats: g.items.slice(half) };
  });
}

/* ------------------------------------------------------------------
   Plan interactif : les places posées sur l'image du plan
   ------------------------------------------------------------------
   Chaque poste porte des coordonnées en pourcentage (pos_x, pos_y) plutôt qu'en
   pixels : le plan se redimensionne avec la fenêtre, et l'image peut être
   remplacée sans que les positions se décalent, tant que le cadrage est proche.
   Un poste sans coordonnées n'apparaît simplement pas sur le plan ; il reste
   réservable dans les listes au-dessus. */
function renderPlanPins() {
  const box = document.getElementById("planPins");
  if (!box) return;

  const places = state.availability.filter(x => x.desk.pos_x != null && x.desk.pos_y != null);
  const sans = state.availability.length - places.length;

  box.innerHTML = places.map(item => {
    const occupant = item.occupied_by || null;
    const mineHere = !item.is_available && occupant === state.profile.name;
    const gardee = !item.is_available && !occupant;
    // `unavailable` vient du serveur : il tient compte de la place ELLE-MÊME,
    // de son espace, et de la date consultée.
    const ferme = item.is_available && item.unavailable === true;
    const cls = ferme ? "off"
      : item.is_available ? "free" : mineHere ? "mine" : gardee ? "held" : "occupied";
    const equipement = featureTags(item.desk.features)[0];
    const label = ferme ? ""
      : mineHere ? "moi"
      : occupant ? deskAcronym(occupant)
      : item.is_available && equipement ? featureIcon(equipement)
      : "";

    let etat;
    if (ferme) etat = "hors service";
    else if (item.is_available) etat = "disponible";
    else if (mineHere) etat = "votre place";
    else if (occupant) etat = occupant;
    else etat = "place gardée libre";

    return `<button class="plan-pin ${cls}" data-plan-desk="${item.desk.id}"
      style="left:${item.desk.pos_x}%; top:${item.desk.pos_y}%"
      title="${escapeHtml(item.desk.name + " — " + etat)}">${label}</button>`;
  }).join("");

  const note = document.getElementById("planNote");
  if (note) {
    note.textContent = sans > 0
      ? `${sans} place${sans > 1 ? "s" : ""} pas encore positionnée${sans > 1 ? "s" : ""} sur le plan.`
      : "";
  }

  box.querySelectorAll("[data-plan-desk]").forEach(btn => {
    const item = state.availability.find(a => a.desk.id === +btn.dataset.planDesk);
    const mineHere = !item.is_available && item.booked_by === state.profile.name;
    if (item.is_available || mineHere) {
      btn.addEventListener("click", () => selectSeat(item, mineHere));
    }
  });
}

function renderTables() {
  const box = document.getElementById("tableSections"); if (!box) return;
  const bureaux = groupIntoTables(state.availability.filter(x => x.desk.zone && x.desk.zone.startsWith("Bureau")));
  const openspace = groupIntoTables(state.availability.filter(x => x.desk.zone === "Open Space"));

  /* Bouton « réserver d'un bloc », pour une salle fermée comme pour une table de
     l'open space. Trois choses peuvent le fermer : l'admin a coupé le mode, l'admin
     a grisé cet espace précis, ou une place y est déjà prise. */
  function groupButtonHtml(t, _isRoom) {
    const espace = state.spaces.find(g => g.ref === t.key);
    const isRoom = espace ? espace.kind === "room" : (t.zone || "").startsWith("Bureau");
    const mot = isRoom ? "salle" : "table";
    const Mot = isRoom ? "Salle" : "Table";

    if (!state.bookingModes[isRoom ? "room" : "table"]) return "";
    if (espace && espace.enabled === false) {
      return `<button class="room-book-btn" disabled title="Espace rendu indisponible par l'administration">${Mot} indisponible</button>`;
    }

    const myIds = (state.myRoomReservations && state.myRoomReservations[t.key]) || [];
    if (myIds.length) return `<button class="room-book-btn mine" data-group-ref="${t.key}">${Mot} réservée (vous) · Annuler</button>`;
    if (t.items.every(x => x.is_available)) return `<button class="room-book-btn" data-group-ref="${t.key}">Réserver toute la ${mot}</button>`;
    return `<button class="room-book-btn" disabled title="Une place de cette ${mot} est déjà réservée">${Mot} indisponible</button>`;
  }

  /* Une ligne par espace : son nom, ce qu'il reste de libre, et le bouton de
     réservation en bloc. La grille schématique qui vivait ici doublonnait le
     plan, avec une géométrie qui ne ressemblait pas aux locaux. */
  function section(title, tables, isRoom) {
    if (!tables.length) return "";
    const lignes = tables.map(t => {
      // Une place hors service n'est pas « libre » : la compter promettrait
      // une place que personne ne peut prendre.
      const libres = t.items.filter(x => x.is_available && !x.unavailable).length;
      const bouton = groupButtonHtml(t, isRoom);
      return `<div class="space-row">
        <div class="space-row-info">
          <b>${escapeHtml(t.label)}</b>
          <small>${libres} place${libres > 1 ? "s" : ""} libre${libres > 1 ? "s" : ""} sur ${t.cap}</small>
        </div>
        ${bouton || '<span class="space-row-off">Réservation en bloc fermée</span>'}
      </div>`;
    }).join("");
    return `<div class="section-eyebrow">${title}</div>
      <div class="card space-list">${lignes}</div>`;
  }
  box.innerHTML = section("Réserver un espace entier", [...bureaux, ...openspace], false) + renderPodsSection();
  box.querySelectorAll("[data-group-ref]").forEach(btn => {
    if (!btn.disabled) btn.addEventListener("click", () => onGroupButtonClick(btn.dataset.groupRef));
  });
  box.querySelectorAll("[data-open-pod]").forEach(btn => btn.addEventListener("click", () => openPodSheet(+btn.dataset.openPod)));
  box.querySelectorAll("[data-cancel-pod]").forEach(btn => btn.addEventListener("click", () => cancelPodBooking(+btn.dataset.cancelPod)));
}

/* ------------------------------------------------------------------
   Réservation d'un espace entier (salle fermée ou table de l'open space)
   ------------------------------------------------------------------
   Bloquer une table retire quatre à six places du planning d'un coup. Celui qui
   réserve doit dire qui s'y installera : c'est la demande la plus insistante du
   retour d'Olivier, et sans cette information les places disparaissent sans que
   personne ne sache qui les occupe.

   Les personnes désignées sont ATTENDUES, pas présentes : chacune confirme son
   arrivée elle-même, sinon la liste d'évacuation dirait que six personnes sont
   dans le bâtiment parce qu'un collègue a coché leurs noms la veille. */
let groupSheetState = null;   // { ref, label, isRoom, seats: [...] }
let groupSlot = "DAY";

function onGroupButtonClick(ref) {
  const myIds = (state.myRoomReservations && state.myRoomReservations[ref]) || [];
  const espace = state.spaces.find(g => g.ref === ref) || {};
  const label = espace.label || ref;
  const mot = espace.kind === "room" ? "Salle" : "Table";

  // Espace déjà réservé par moi : on repasse par la feuille de confirmation
  // existante, qui sait annuler un lot de réservations d'un coup.
  if (myIds.length) {
    state.selected = { type: "room", zone: ref, name: `${mot} — ${label}`, mine: true, resIds: myIds };
    openReserveSheet();
    return;
  }

  const places = state.availability
    .filter(x => groupRefOf(x.desk) === ref)
    .sort((a, b) => a.desk.name.localeCompare(b.desk.name));
  if (!places.length) return toast("Cet espace n'existe plus.", "error");
  if (!places.every(x => x.is_available)) return toast("Cet espace n'est plus disponible.", "error");

  groupSheetState = {
    ref, label, isRoom: espace.kind === "room",
    // Par défaut je m'installe sur la première place, les autres restent à remplir.
    seats: places.map((x, i) => ({
      deskId: x.desk.id, name: x.desk.name, features: x.desk.features,
      mode: i === 0 ? "me" : "empty", userId: i === 0 ? state.profile.id : null,
      guestName: "", guestCompany: "",
    })),
  };
  groupSlot = "DAY";
  openGroupSheet();
}

/* Même règle de regroupement que le serveur : une salle par sa zone, une table
   par le préfixe du nom de ses postes. */
function groupRefOf(desk) {
  if (desk.zone && desk.zone.startsWith("Bureau")) return desk.zone;
  // Une bulle calme est un espace à elle seule : sa référence est son nom entier,
  // pas le préfixe « BC » que donnerait un découpage sur le tiret.
  if (desk.zone === "Bulles calmes") return desk.name;
  return desk.name.split("-")[0];
}

async function openGroupSheet() {
  const st = groupSheetState;
  document.getElementById("groupSheetEyebrow").textContent = st.isRoom ? "Salle entière" : "Table entière";
  document.getElementById("groupSheetTitle").textContent = st.label;
  document.getElementById("groupSheetSub").textContent =
    `${fdate(state.date, { weekday: "long", day: "numeric", month: "long" })} · ${st.seats.length} places`;
  document.querySelectorAll("#groupSlotToggle button").forEach(b =>
    b.classList.toggle("active", b.dataset.slot === groupSlot));

  // Annuaire chargé une seule fois, à la première ouverture.
  if (!state.colleagues) {
    const { data } = await api("/api/colleagues");
    state.colleagues = data || [];
  }
  renderGroupSeats();
  document.getElementById("groupSheetBackdrop").classList.remove("hidden");
}

function closeGroupSheet() {
  document.getElementById("groupSheetBackdrop").classList.add("hidden");
  groupSheetState = null;
}

function renderGroupSeats() {
  const box = document.getElementById("groupSeats");
  const annuaire = (state.colleagues || []).filter(c => c.id !== state.profile.id);

  box.innerHTML = groupSheetState.seats.map((seat, i) => {
    const options = annuaire.map(c =>
      `<option value="${c.id}"${seat.mode === "colleague" && seat.userId === c.id ? " selected" : ""}>${escapeHtml(c.name)}</option>`
    ).join("");
    return `
      <div class="group-seat">
        <div class="group-seat-head">
          <b>${escapeHtml(seat.name)}</b>
          ${seat.features ? `<small>${escapeHtml(seat.features)}</small>` : ""}
        </div>
        <select class="group-seat-mode" data-seat-mode="${i}">
          <option value="empty"${seat.mode === "empty" ? " selected" : ""}>Place libre</option>
          <option value="me"${seat.mode === "me" ? " selected" : ""}>Moi</option>
          <option value="colleague"${seat.mode === "colleague" ? " selected" : ""}>Un collègue</option>
          <option value="guest"${seat.mode === "guest" ? " selected" : ""}>Une personne extérieure</option>
        </select>
        ${seat.mode === "colleague" ? `<select class="group-seat-who" data-seat-user="${i}"><option value="">Choisir…</option>${options}</select>` : ""}
        ${seat.mode === "guest" ? `
          <input class="group-seat-who" data-seat-guest="${i}" maxlength="120" placeholder="Nom et prénom" value="${escapeHtml(seat.guestName)}">
          <input class="group-seat-who" data-seat-company="${i}" maxlength="120" placeholder="Société" value="${escapeHtml(seat.guestCompany)}">` : ""}
      </div>`;
  }).join("");

  box.querySelectorAll("[data-seat-mode]").forEach(sel => sel.addEventListener("change", () => {
    const seat = groupSheetState.seats[+sel.dataset.seatMode];
    seat.mode = sel.value;
    seat.userId = sel.value === "me" ? state.profile.id : null;
    if (sel.value !== "guest") { seat.guestName = ""; seat.guestCompany = ""; }
    renderGroupSeats();
  }));
  box.querySelectorAll("[data-seat-user]").forEach(sel => sel.addEventListener("change", () => {
    groupSheetState.seats[+sel.dataset.seatUser].userId = sel.value ? +sel.value : null;
  }));
  box.querySelectorAll("[data-seat-guest]").forEach(inp => inp.addEventListener("input", () => {
    groupSheetState.seats[+inp.dataset.seatGuest].guestName = inp.value;
  }));
  box.querySelectorAll("[data-seat-company]").forEach(inp => inp.addEventListener("input", () => {
    groupSheetState.seats[+inp.dataset.seatCompany].guestCompany = inp.value;
  }));
}

async function confirmGroupSheet() {
  const st = groupSheetState;
  if (!st) return;

  const occupants = [];
  for (const seat of st.seats) {
    if (seat.mode === "empty") continue;
    if (seat.mode === "colleague" && !seat.userId) return toast(`Choisis qui occupe la place ${seat.name}.`, "error");
    if (seat.mode === "guest" && !seat.guestName.trim()) return toast(`Indique le nom de la personne en ${seat.name}.`, "error");
    occupants.push({
      desk_id: seat.deskId,
      user_id: seat.mode === "guest" ? null : seat.userId,
      name: seat.mode === "guest" ? seat.guestName.trim() : null,
      company: seat.mode === "guest" ? (seat.guestCompany.trim() || null) : null,
    });
  }
  if (!occupants.length) return toast("Indique au moins une personne avant de réserver.", "error");

  const { ok, data } = await api("/api/reservations/group", {
    method: "POST",
    body: JSON.stringify({ ref: st.ref, reservation_date: state.date, slot: groupSlot, occupants }),
  });
  if (!ok) return toast((data && data.detail) || "Réservation impossible.", "error");

  const pts = groupSlot === "DAY" ? 20 : 10;
  refreshPoints(+pts); floatPoint();
  toast(`${st.isRoom ? "Salle" : "Table"} réservée ! +${pts} points ⭐`, "success");
  closeGroupSheet();
  loadReserve();
}

function renderPodsSection() {
  const podItems = state.availability.filter(x => x.desk.zone === "Bulles calmes");
  if (!podItems.length) return "";
  const cards = podItems.map(item => {
    const d = item.desk;
    const bookings = (state.podBookings && state.podBookings[d.id]) || [];
    const rows = bookings.map(b => {
      const mine = b.user_name === state.profile.name;
      return `<div class="pod-slot${mine ? " mine" : ""}">
        <span>${b.start_time.slice(0, 5)}–${b.end_time.slice(0, 5)}</span>
        <span class="pod-slot-who">${mine ? "Toi" : b.user_name}</span>
        ${mine ? `<button class="pod-slot-cancel" data-cancel-pod="${b.id}" title="Annuler">✕</button>` : ""}
      </div>`;
    }).join("") || `<div class="empty" style="padding:2px 0">Aucun créneau réservé.</div>`;
    const espace = (state.spaces || []).find(g => g.ref === d.name);
    const grisee = espace && espace.enabled === false;
    const action = grisee
      ? `<span class="muted" title="Bulle rendue indisponible par l'administration">Indisponible</span>`
      : `<button class="link-more" data-open-pod="${d.id}">+ Réserver un créneau</button>`;
    return `<div class="card pod-card${grisee ? " pod-card-off" : ""}">
      <div class="card-head"><h3>${podLabel(d.name)}</h3>${action}</div>
      <div class="pod-slots">${rows}</div>
    </div>`;
  }).join("");
  return `<div class="section-eyebrow">Bulles calmes · créneaux de 15 min</div>${cards}`;
}

function podLabel(name) {
  if (state.roomLabels && state.roomLabels[name]) return state.roomLabels[name];
  return name === "BC-1" ? "Bulle calme 1" : name === "BC-2" ? "Bulle calme 2" : name;
}

let podDeskId = null;

function openPodSheet(deskId) {
  podDeskId = deskId;
  const item = state.availability.find(x => x.desk.id === deskId);
  document.getElementById("podSheetTitle").textContent = item ? podLabel(item.desk.name) : "Bulle calme";
  document.getElementById("podSheetSub").textContent = fdate(state.date, { weekday: "long", day: "numeric", month: "long" });
  // Par défaut : le prochain quart d'heure, pour 30 min.
  const now = new Date();
  let mins = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  document.getElementById("podStart").value = fmt(mins);
  document.getElementById("podEnd").value = fmt(mins + 30);
  document.getElementById("podSheetBackdrop").classList.remove("hidden");
}
function closePodSheet() {
  document.getElementById("podSheetBackdrop").classList.add("hidden");
  podDeskId = null;
}
async function confirmPodSheet() {
  if (!podDeskId) return;
  const start_time = document.getElementById("podStart").value;
  const end_time = document.getElementById("podEnd").value;
  if (!start_time || !end_time) return toast("Choisis une heure de début et de fin.", "error");
  const { ok, data } = await api("/api/reservations/timeslot", {
    method: "POST",
    body: JSON.stringify({ desk_id: podDeskId, reservation_date: state.date, start_time, end_time }),
  });
  if (!ok) return toast(data?.detail || "Réservation impossible.", "error");
  toast("Bulle réservée ✓", "success");
  closePodSheet();
  loadReserve();
}
async function cancelPodBooking(id) {
  const { ok, data } = await api(`/api/reservations/${id}`, { method: "DELETE" });
  if (!ok) return toast(data?.detail || "Annulation impossible.", "error");
  toast("Créneau annulé.");
  loadReserve();
}

let sheetSlot = "DAY";

function selectSeat(item, mineHere) {
  let resIds = [];
  if (mineHere) {
    resIds = state.myReservations
      .filter(r => r.desk.id === item.desk.id && r.reservation_date === state.date)
      .map(r => r.id);
  }
  state.selected = { deskId: item.desk.id, name: item.desk.name, zone: item.desk.zone, features: item.desk.features, mine: mineHere, resIds };
  renderTables(); renderPlanPins(); openReserveSheet();
}
function clearSelection() {
  state.selected = null;
  closeReserveSheet();
  if (document.getElementById("tableSections")) renderTables();
}
function openReserveSheet() {
  if (!state.selected) return;
  const isRoom = state.selected.type === "room";
  sheetSlot = "DAY";
  document.getElementById("sheetTitle").textContent = isRoom ? state.selected.name : "Poste " + state.selected.name;
  document.getElementById("sheetSub").textContent = isRoom
    ? fdate(state.date, { weekday: "long", day: "numeric", month: "long" })
    : `${state.selected.zone || "Open space"} · ${fdate(state.date, { weekday: "long", day: "numeric", month: "long" })}`;
  document.getElementById("sheetFeatures").innerHTML = isRoom ? "" : featureTagsHtml(state.selected.features);
  const mine = document.getElementById("sheetMineNotice");
  const durationBox = document.getElementById("sheetDuration");
  const confirmBtn = document.getElementById("sheetConfirmBtn");
  if (state.selected.mine) {
    durationBox.classList.add("hidden"); mine.classList.remove("hidden");
    mine.textContent = isRoom ? "Tu as déjà réservé cette salle pour ce créneau." : "Tu as déjà réservé ce poste pour ce créneau.";
    confirmBtn.textContent = isRoom ? "Annuler la réservation de la salle" : "Annuler la réservation"; confirmBtn.classList.add("danger");
  } else {
    durationBox.classList.remove("hidden"); mine.classList.add("hidden");
    confirmBtn.textContent = "Confirmer"; confirmBtn.classList.remove("danger");
    document.querySelectorAll("#sheetSlotToggle button").forEach(b => b.classList.toggle("active", b.dataset.slot === sheetSlot));
  }
  document.getElementById("reserveSheetBackdrop").classList.remove("hidden");
}
function closeReserveSheet() {
  document.getElementById("reserveSheetBackdrop").classList.add("hidden");
}
async function confirmSheet() {
  if (!state.selected) return;
  if (state.selected.mine) { await cancelRes(state.selected.resIds[0], "Espace libéré."); }
  else if (state.selected.type === "room") await bookRoom(state.selected.zone, sheetSlot);
  else await book(state.selected.deskId, sheetSlot);
  clearSelection();
}
/* Regroupe les places prises d'un bloc : la Table 1 réservée entière est UNE
   entrée, pas quatre lignes identiques. Clé : espace + date + créneau. */
function groupMyReservations(reservations) {
  const entrees = [];
  const parLot = new Map();
  for (const r of reservations) {
    // On ne regroupe que ce qu'on a réservé soi-même : la place qu'un collègue
    // nous a attribuée est une entrée à elle seule, on ne possède pas l'espace.
    const jeSuisLeReservant = !r.booked_by || r.booked_by === state.profile.name;
    if (!r.is_group_booking || !jeSuisLeReservant) { entrees.push({ lot: null, res: r }); continue; }
    const cle = `${groupRefOf(r.desk)}|${r.reservation_date}|${r.slot}`;
    let lot = parLot.get(cle);
    if (!lot) {
      lot = { lot: cle, ref: groupRefOf(r.desk), res: r, places: [] };
      parLot.set(cle, lot);
      entrees.push(lot);
    }
    lot.places.push(r);
  }
  return entrees;
}

function occupantsHtml(places) {
  const noms = places
    .map(p => p.occupant ? escapeHtml(p.occupant === state.profile.name ? "Toi" : p.occupant) : null)
    .filter(Boolean);
  const libres = places.length - noms.length;
  const bouts = [];
  if (noms.length) bouts.push(noms.join(", "));
  if (libres) bouts.push(`${libres} place${libres > 1 ? "s" : ""} gardée${libres > 1 ? "s" : ""} libre${libres > 1 ? "s" : ""}`);
  return bouts.length ? `<small class="res-occupants">${bouts.join(" · ")}</small>` : "";
}

function renderMyReservations() {
  const box = document.getElementById("myReservations"); if (!box) return;
  if (!state.myReservations.length) { box.innerHTML = `<div class="empty">Aucune réservation à venir.</div>`; return; }
  box.innerHTML = "";
  const todayIso = toLocalISODate(new Date());

  for (const entree of groupMyReservations(state.myReservations)) {
    if (entree.lot) { box.appendChild(groupResItem(entree, todayIso)); continue; }
    const r = entree.res;
    const isTimeslot = r.slot === "timeslot";
    const isToday = r.reservation_date === todayIso;
    const el = document.createElement("div"); el.className = "res-item";
    const checkinBtn = isToday && !isTimeslot
      ? (r.checked_in_at ? `<span class="res-checked">✓ Présent</span>` : `<button class="checkin" data-checkin="${r.id}">Je suis arrivé</button>`)
      : "";
    const slotText = isTimeslot ? `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}` : slotLabel(r.slot);
    // Nom du poste, date et équipements sur trois lignes distinctes : collés sur une seule
    // ligne, le nom de la table et le jour se lisaient mal (retour d'Olivier, 25/08/2026).
    const zone = r.desk.zone ? ` · ${escapeHtml(r.desk.zone)}` : "";
    // Place attribuée par quelqu'un d'autre : on s'en retire, on ne l'annule pas.
    const attribuee = r.is_group_booking && r.booked_by && r.booked_by !== state.profile.name;
    const parQui = attribuee ? `<small>Réservé par ${escapeHtml(r.booked_by)}</small>` : "";
    el.innerHTML = `<div class="info">
        <b>${escapeHtml(r.desk.name)}${zone}</b>
        <small>${fdate(r.reservation_date, { weekday: "short", day: "numeric", month: "short" })} · ${slotText}</small>
        ${parQui}
        ${featureTagsHtml(r.desk.features)}
      </div>
      <div class="res-item-actions">${checkinBtn}<button class="cancel">${attribuee ? "Me retirer" : "Annuler"}</button></div>`;
    el.querySelector(".cancel").addEventListener("click", () => isTimeslot
      ? cancelPodBooking(r.id)
      : cancelRes(r.id, attribuee ? "Tu t'es retiré de cette place." : "Réservation annulée."));
    const cb = el.querySelector("[data-checkin]");
    if (cb) cb.addEventListener("click", async () => {
      const { ok, data } = await api(`/api/reservations/${r.id}/checkin`, { method: "POST" });
      if (!ok) return toast(data?.detail || "Check-in impossible.", "error");
      toast("Présence confirmée ✓", "success"); loadReserve();
    });
    box.appendChild(el);
  }
}
/* Une table ou une salle réservée d'un bloc : une seule carte, les occupants
   dessous, et une annulation qui libère tout le lot d'un coup. */
function groupResItem(entree, todayIso) {
  const r = entree.res;
  const espace = (state.spaces || []).find(g => g.ref === entree.ref) || {};
  const label = espace.label || entree.ref;
  const mot = espace.kind === "room" ? "salle" : "table";
  const el = document.createElement("div");
  el.className = "res-item";

  const moi = entree.places.find(p => p.occupant === state.profile.name);
  const checkinBtn = r.reservation_date === todayIso && moi
    ? (moi.checked_in_at ? `<span class="res-checked">✓ Présent</span>` : `<button class="checkin" data-checkin="${moi.id}">Je suis arrivé</button>`)
    : "";

  el.innerHTML = `<div class="info">
      <b>${escapeHtml(label)} <span class="res-whole">${mot} entière</span></b>
      <small>${fdate(r.reservation_date, { weekday: "short", day: "numeric", month: "short" })} · ${slotLabel(r.slot)}</small>
      ${occupantsHtml(entree.places)}
    </div>
    <div class="res-item-actions">${checkinBtn}<button class="cancel">Annuler</button></div>`;

  el.querySelector(".cancel").addEventListener("click", () => releaseGroup(entree));
  const cb = el.querySelector("[data-checkin]");
  if (cb) cb.addEventListener("click", async () => {
    const { ok, data } = await api(`/api/reservations/${moi.id}/checkin`, { method: "POST" });
    if (!ok) return toast(data?.detail || "Check-in impossible.", "error");
    toast("Présence confirmée ✓", "success"); loadReserve();
  });
  return el;
}

async function book(deskId, slot) {
  const { ok, data } = await api("/api/reservations", { method: "POST", body: JSON.stringify({ desk_id: deskId, reservation_date: state.date, slot }) });
  if (!ok) return toast(data?.detail || "Réservation impossible.", "error");
  const pts = slot === "DAY" ? 20 : 10;
  refreshPoints(+pts); floatPoint(); toast(`Réservé ! +${pts} points ⭐`, "success"); loadReserve();
}
async function bookRoom(zone, slot) {
  const { ok, data } = await api("/api/reservations/room", { method: "POST", body: JSON.stringify({ zone, reservation_date: state.date, slot }) });
  if (!ok) return toast(data?.detail || "Réservation de la salle impossible.", "error");
  const pts = slot === "DAY" ? 20 : 10;
  refreshPoints(+pts); floatPoint(); toast(`Salle réservée ! +${pts} points ⭐`, "success"); loadReserve();
}
/* Une même route sert trois gestes, le serveur décide lequel selon qui demande :
   annuler sa réservation, libérer tout un espace qu'on a réservé, ou se retirer
   d'une place qu'un collègue nous a attribuée. Le message doit suivre. */
async function cancelRes(id, message = "Réservation annulée.") {
  const { ok, data } = await api(`/api/reservations/${id}`, { method: "DELETE" });
  if (!ok) { toast(data?.detail || "Annulation impossible.", "error"); return false; }
  await resyncPoints();
  toast(message);
  loadReserve();
  return true;
}

/* Libère un espace réservé d'un bloc. Une seule demande suffit : le serveur
   annule tout le lot, les autres places n'auraient plus rien à annuler. */
async function releaseGroup(entree) {
  const espace = (state.spaces || []).find(g => g.ref === entree.ref) || {};
  const mot = espace.kind === "room" ? "Salle libérée." : "Table libérée.";
  await cancelRes(entree.places[0].id, mot);
}

/* ============================================================
   VUE : ÉVÉNEMENTS (depuis l'intranet WordPress)
   ============================================================ */
function eventRegBtnHtml(ev) {
  const full = ev.capacity != null && ev.registered_count >= ev.capacity && ev.my_status !== "registered";
  if (ev.my_status === "registered") return `<button class="event-reg-btn registered" data-unregister="${ev.id}">Inscrit ✓ — se désinscrire</button>`;
  if (ev.my_status === "waitlisted") return `<button class="event-reg-btn waitlisted" data-unregister="${ev.id}">Liste d'attente — quitter</button>`;
  if (full) return `<button class="event-reg-btn full" disabled>Complet — liste d'attente pleine</button>`;
  return `<button class="event-reg-btn" data-register="${ev.id}">S'inscrire</button>`;
}
function eventCapacityHtml(ev) {
  return ev.capacity != null ? `<span class="event-capacity">${ev.registered_count}/${ev.capacity} inscrit·e·s</span>` : "";
}

/* Téléchargement du .ics via Blob (plus fiable que l'attribut HTML `download` seul,
   notamment sur navigateurs mobiles qui l'ignorent souvent). */
async function downloadIcs(eventId) {
  const res = await fetch(`/api/events/${eventId}/ics`);
  if (!res.ok) return toast("Téléchargement impossible.", "error");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `evenement-${eventId}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function viewEvenements() {
  const view = document.getElementById("view");
  view.innerHTML = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Synchronisés en direct depuis l'intranet EyeD. Cliquez sur le titre pour lire le détail.</p><div class="events-grid" id="eventsGrid"></div>`;
  const grid = document.getElementById("eventsGrid");
  grid.innerHTML = `<div class="empty">Chargement…</div>`;
  const evts = (await api("/api/events?limit=24")).data || [];
  grid.innerHTML = evts.length ? "" : `<div class="empty">Aucun événement.</div>`;
  for (const ev of evts) {
    const c = document.createElement("div"); c.className = "event-card";
    c.innerHTML = `<span class="ec-date">${fdate(ev.date, { day: "numeric", month: "long", year: "numeric" })}</span>
      <span class="ec-title" role="button" tabindex="0">${ev.title}</span>
      ${ev.place ? `<span class="ec-place">📍 ${ev.place}</span>` : ""}
      <div class="event-reg-row">${eventCapacityHtml(ev)}<button class="event-ics-link" data-ics="${ev.id}">+ Calendrier</button></div>
      <div class="event-reg-row">${eventRegBtnHtml(ev)}</div>`;
    c.querySelector(".ec-title").addEventListener("click", () => openEvent(ev.id));
    grid.appendChild(c);
  }
  wireEventButtons(grid, viewEvenements);
}

function wireEventButtons(container, reload) {
  container.querySelectorAll("[data-register]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const { ok, data } = await api(`/api/events/${b.dataset.register}/register`, { method: "POST" });
    if (!ok) return toast(data?.detail || "Inscription impossible.", "error");
    toast(data.status === "waitlisted" ? "Ajouté à la liste d'attente." : "Inscription confirmée ✓", "success");
    reload();
  }));
  container.querySelectorAll("[data-unregister]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const { ok, data } = await api(`/api/events/${b.dataset.unregister}/register`, { method: "DELETE" });
    if (!ok) return toast(data?.detail || "Désinscription impossible.", "error");
    toast("Inscription annulée.");
    reload();
  }));
  container.querySelectorAll("[data-ics]").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    downloadIcs(b.dataset.ics);
  }));
}

/* Détail d'un contenu (événement ou actualité) affiché DANS l'app */
async function openContent(apiPath, pageTitle, backHash, isEvent) {
  document.getElementById("pageTitle").textContent = pageTitle;
  const view = document.getElementById("view");
  view.innerHTML = `<div class="empty">Chargement…</div>`;
  const { ok, data } = await api(apiPath);
  if (!ok) { view.innerHTML = `<div class="empty">Contenu introuvable.</div>`; return; }
  view.innerHTML = `
    <div class="detail-wrap">
    <button class="btn-back" id="backBtn">← Retour</button>
    <article class="event-detail">
      <span class="ec-date">${fdate(data.date, { day: "numeric", month: "long", year: "numeric" })}</span>
      <h2 class="ed-title">${data.title}</h2>
      ${isEvent && data.place ? `<span class="ec-place">📍 ${data.place}</span>` : ""}
      ${isEvent ? `<div class="event-reg-row">${eventCapacityHtml(data)}<button class="event-ics-link" data-ics="${data.id}">+ Ajouter au calendrier</button></div>
        <div class="event-reg-row">${eventRegBtnHtml(data)}</div>` : ""}
      ${data.image ? `<img class="ed-hero" src="${data.image}" alt="">` : ""}
      <div class="ed-body">${data.content_html}</div>
      <a class="ed-source" href="${data.link}" target="_blank" rel="noopener">Voir sur l'intranet ↗</a>
    </article></div>`;
  document.getElementById("backBtn").addEventListener("click", () => goTo(backHash));
  if (isEvent) wireEventButtons(view, () => openContent(apiPath, pageTitle, backHash, isEvent));
}
function openEvent(id) { openContent("/api/events/" + id, "Événement", "evenements", true); }
function openNews(id) { openContent("/api/news/" + id, "Actualité", "accueil"); }

/* ============================================================
   VUE : MA PRÉSENCE (déclaration de statut)
   ============================================================ */
let presenceState = { days: [], byDay: {}, selected: null };

async function viewPresence() {
  const view = document.getElementById("view");
  const days = []; const d = new Date();
  while (days.length < 7) { if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d)); d.setDate(d.getDate() + 1); }
  const from = toLocalISODate(days[0]), to = toLocalISODate(days[days.length - 1]);
  const rows = (await api(`/api/status/me?from=${from}&to=${to}`)).data || [];
  const byDay = {}; for (const r of rows) byDay[r.day] = { am: r.status_am, pm: r.status_pm };
  presenceState = { days, byDay, selected: toLocalISODate(days[0]) };

  view.innerHTML = `
    <div class="hero-banner presence-hero">
      <div class="banner-eyebrow">MA PRÉSENCE</div>
      <div class="banner-title" style="margin-bottom:14px">Où seras-tu cette semaine ?</div>
      <div class="presence-daystrip" id="presenceDaystrip"></div>
    </div>
    <div class="card presence-card">
      <h3 id="presenceDayTitle"></h3>
      <div class="presence-status-grid" id="presenceStatusGrid"></div>
    </div>
    <div class="card search-section"><h3>Vue de la semaine</h3><div class="list" id="presenceWeekList"></div></div>`;
  renderPresenceDaystrip();
  renderPresenceStatusGrid();
  renderPresenceWeekList();
}

function renderPresenceDaystrip() {
  const box = document.getElementById("presenceDaystrip");
  box.innerHTML = presenceState.days.map(day => {
    const iso = toLocalISODate(day);
    const s = presenceState.byDay[iso] || {};
    const amColor = s.am ? statusColor(s.am) : "transparent";
    const pmColor = s.pm ? statusColor(s.pm) : "transparent";
    return `<button class="pd-pill${iso === presenceState.selected ? " active" : ""}" data-day="${iso}">
      <span class="pd-d">${day.toLocaleDateString("fr-FR", { weekday: "short" })}</span>
      <span class="pd-n">${day.getDate()}</span>
      <span class="pd-dot" style="background:linear-gradient(to right, ${amColor} 50%, ${pmColor} 50%)"></span></button>`;
  }).join("");
  box.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => {
    presenceState.selected = b.dataset.day;
    renderPresenceDaystrip(); renderPresenceStatusGrid();
  }));
}

function renderPresenceStatusGrid() {
  const iso = presenceState.selected;
  const day = presenceState.days.find(d => toLocalISODate(d) === iso);
  document.getElementById("presenceDayTitle").textContent = day.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const grid = document.getElementById("presenceStatusGrid");
  const s = presenceState.byDay[iso] || {};
  const tiles = (slot, current) => enabledStatusEntries().map(([key, lbl]) => `
    <button class="presence-status-tile${current === key ? " on" : ""}" data-slot="${slot}" data-status="${key}" style="--tile-color:${statusColor(key)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${statusIcon(key)}</svg>
      <span>${lbl}</span>
    </button>`).join("");
  grid.innerHTML = `
    <div class="status-half-label">Matin</div>
    <div class="presence-status-tiles">${tiles("AM", s.am)}</div>
    <div class="status-half-label">Après-midi</div>
    <div class="presence-status-tiles">${tiles("PM", s.pm)}</div>`;
  grid.querySelectorAll("[data-status]").forEach(b => b.addEventListener("click", () => {
    const slot = b.dataset.slot, statusKey = b.dataset.status;
    handleStatusChange(iso, slot, statusKey, (cancelledCount) => {
      presenceState.byDay[iso] = { ...(presenceState.byDay[iso] || {}), [slot === "AM" ? "am" : "pm"]: statusKey };
      renderPresenceStatusGrid(); renderPresenceDaystrip(); renderPresenceWeekList();
      if (cancelledCount) refreshPoints(-10 * cancelledCount);
    });
  }));
}

function renderPresenceWeekList() {
  const box = document.getElementById("presenceWeekList");
  const badge = (status) => status
    ? `<span class="ev-status-badge" style="background:${statusColor(status)}22;color:${statusColor(status)}">${statusLabel(status)}</span>`
    : `<span class="muted">—</span>`;
  box.innerHTML = presenceState.days.map(day => {
    const iso = toLocalISODate(day);
    const s = presenceState.byDay[iso] || {};
    return `<div class="pres-week-row">
      <div class="pres-week-day">${day.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}</div>
      <div class="pres-week-slots">
        <span class="pres-week-slot"><span class="pws-label">Matin</span> ${badge(s.am)}</span>
        <span class="pres-week-slot"><span class="pws-label">Après-midi</span> ${badge(s.pm)}</span>
      </div>
    </div>`;
  }).join("");
}

async function setStatus(day, slot, status) {
  const { ok, data } = await api("/api/status/me", { method: "PUT", body: JSON.stringify({ day, slot, status }) });
  if (!ok) { toast(data?.detail || "Impossible d'enregistrer.", "error"); return false; }
  toast("Présence enregistrée ✓", "success"); return true;
}

/* ============================================================
   VUE : DANS LES LOCAUX (présence physique constatée)
   ------------------------------------------------------------
   Volontairement sans heures d'arrivée ni de départ : les afficher à tous
   ferait de l'outil une pointeuse. Les heures existent en base et sortent
   dans l'export réservé aux administrateurs.
   ============================================================ */
async function viewLocaux() {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="empty">Chargement…</div>`;

  const { ok, data } = await api("/api/attendance/today");
  if (!ok || !data) { view.innerHTML = `<div class="empty">Liste indisponible.</div>`; return; }

  const employes = data.employees.length
    ? data.employees.map(e => `
        <div class="presence-row">
          <div class="colleague-av" style="background:${colorFor(e.name)}">${initials(e.name)}</div>
          <div class="presence-id">
            <b>${escapeHtml(e.name)}</b>
            <small>${escapeHtml(e.department || "EyeD Pharma")}</small>
          </div>
        </div>`).join("")
    : `<div class="empty">Personne n'a encore confirmé son arrivée.</div>`;

  const visiteurs = data.visitors.length
    ? data.visitors.map(v => `
        <div class="presence-row">
          <div class="colleague-av visitor-av">${initials(v.full_name)}</div>
          <div class="presence-id">
            <b>${escapeHtml(v.full_name)}</b>
            <small>${escapeHtml(v.company || "Externe")} · reçu par ${escapeHtml(v.host_name)}</small>
          </div>
          ${v.host_user_id === state.profile.id
            ? `<button class="presence-out" data-visitor-out="${v.id}">Parti</button>` : ""}
        </div>`).join("")
    : `<div class="empty">Aucun visiteur déclaré aujourd'hui.</div>`;

  const moi = attendanceState.present
    ? `<button class="btn btn-ghost" id="locauxLeaveBtn">J'enregistre mon départ</button>`
    : `<button class="btn btn-primary" id="locauxArriveBtn">Je confirme mon arrivée</button>`;

  view.innerHTML = `
    <div class="card">
      <h3>Employés présents (${data.employees.length})</h3>
      <div class="presence-list">${employes}</div>
      ${moi}
    </div>
    <div class="card" style="margin-top:14px">
      <h3>Visiteurs (${data.visitors.length})</h3>
      <div class="presence-list">${visiteurs}</div>
      <div class="visitor-form">
        <input id="locauxVisitorName" type="text" maxlength="120" placeholder="Nom et prénom">
        <input id="locauxVisitorCompany" type="text" maxlength="120" placeholder="Société">
        <button class="btn btn-ghost" id="locauxVisitorAddBtn" type="button">Déclarer un visiteur</button>
      </div>
    </div>`;

  view.querySelectorAll("[data-visitor-out]").forEach(btn => btn.addEventListener("click", async () => {
    const { ok: sorti, data: res } = await api(`/api/visitors/${btn.dataset.visitorOut}/checkout`, { method: "POST" });
    if (!sorti) { toast((res && res.detail) || "Impossible d'enregistrer ce départ.", "error"); return; }
    toast("Départ du visiteur enregistré ✓", "success");
    await refreshAttendance();
    viewLocaux();
  }));

  const arriveBtn = document.getElementById("locauxArriveBtn");
  if (arriveBtn) arriveBtn.addEventListener("click", async () => {
    const { ok: entre, data: res } = await api("/api/attendance/checkin", { method: "POST" });
    if (!entre) { toast((res && res.detail) || "Impossible d'enregistrer ton arrivée.", "error"); return; }
    attendanceState = res;
    document.getElementById("leaveBtn").classList.remove("hidden");
    toast("Arrivée confirmée ✓", "success");
    resyncPoints();
    viewLocaux();
  });

  const leaveBtn = document.getElementById("locauxLeaveBtn");
  if (leaveBtn) leaveBtn.addEventListener("click", async () => {
    const { ok: parti, data: res } = await api("/api/attendance/checkout", { method: "POST" });
    if (!parti) { toast((res && res.detail) || "Impossible d'enregistrer ton départ.", "error"); return; }
    attendanceState = res;
    document.getElementById("leaveBtn").classList.add("hidden");
    toast("Départ enregistré. Bonne soirée !", "success");
    viewLocaux();
  });

  const addBtn = document.getElementById("locauxVisitorAddBtn");
  addBtn.addEventListener("click", async () => {
    const nom = document.getElementById("locauxVisitorName").value.trim();
    if (!nom) { toast("Indique le nom du visiteur.", "error"); return; }
    const societe = document.getElementById("locauxVisitorCompany").value.trim() || null;
    const { ok: cree, data: res } = await api("/api/visitors", {
      method: "POST", body: JSON.stringify({ full_name: nom, company: societe }),
    });
    if (!cree) { toast((res && res.detail) || "Impossible d'ajouter ce visiteur.", "error"); return; }
    toast("Visiteur enregistré ✓", "success");
    await refreshAttendance();
    viewLocaux();
  });
}

/* ============================================================
   VUE : RÉCOMPENSES (niveau, barème des points, badges)
   ------------------------------------------------------------
   Le barème vient du serveur (/api/rewards), jamais de valeurs recopiées ici :
   une page qui annonce un nombre de points faux est pire que pas de page.
   ============================================================ */
async function viewRecompenses() {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="empty">Chargement…</div>`;

  const { ok, data } = await api("/api/rewards");
  if (!ok || !data) { view.innerHTML = `<div class="empty">Page indisponible.</div>`; return; }

  const gains = data.rules.filter(r => r.points > 0);
  const pertes = data.rules.filter(r => r.points < 0);
  const neutres = data.rules.filter(r => r.points === 0);

  const ligne = (r) => `
    <div class="reward-rule">
      <div class="reward-rule-text">
        <b>${escapeHtml(r.label)}</b>
        ${r.note ? `<small>${escapeHtml(r.note)}</small>` : ""}
      </div>
      <span class="reward-pts ${r.points > 0 ? "gain" : r.points < 0 ? "perte" : "neutre"}">
        ${r.points > 0 ? "+" : ""}${r.points}
      </span>
    </div>`;

  const badges = (data.badges || []);
  const obtenus = badges.filter(b => b.earned).length;
  const badgesHtml = badges.map((b, i) => `
    <div class="badge-tile${b.earned ? " earned" : ""}" data-reward-badge="${i}">
      <div class="badge-icon">${escapeHtml(b.icon) || "🏅"}</div><div class="badge-name">${escapeHtml(b.name)}</div>
    </div>`).join("") || `<div class="empty">Aucun badge au catalogue.</div>`;

  view.innerHTML = `
    <div class="card reward-hero">
      <div class="reward-points">${data.total_points}</div>
      <div class="reward-level">Niveau ${escapeHtml(data.level)}</div>
      <div class="reward-progress"><span style="width:${data.level_progress_pct}%"></span></div>
      <div class="reward-next">${data.points_to_next_level > 0
        ? `Encore ${data.points_to_next_level} points avant le niveau suivant`
        : "Niveau maximum atteint"}</div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Comment gagner des points</h3>
      <div class="reward-rules">${gains.map(ligne).join("")}</div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Ce qui fait perdre des points</h3>
      <div class="reward-rules">${pertes.map(ligne).join("")}</div>
      ${neutres.length ? `<div class="reward-rules" style="margin-top:10px">${neutres.map(ligne).join("")}</div>` : ""}
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h3>Badges</h3>
        <span class="badge-count">${obtenus} / ${badges.length}</span>
      </div>
      <div class="badges-grid">${badgesHtml}</div>
    </div>`;

  view.querySelectorAll("[data-reward-badge]").forEach(el => el.addEventListener("click", () => {
    openBadgeDetailSheet(badges[+el.dataset.rewardBadge]);
  }));
}

/* ============================================================
   VUE : BOÎTE À IDÉES (soumission, votes, commentaires, workflow)
   ============================================================ */
const IDEA_STATUS_LABEL = {
  new: "Nouvelle", under_review: "Étudiée", accepted: "Acceptée", rejected: "Refusée", archived: "Archivée",
};

async function viewIdees() {
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="card">
      <h3>Proposer une idée</h3>
      <form id="ideaForm" class="idea-form">
        <input id="ideaTitle" type="text" placeholder="Titre de l'idée" required maxlength="150">
        <textarea id="ideaDesc" placeholder="Décris ton idée…" required rows="3"></textarea>
        <input id="ideaCategory" type="text" placeholder="Catégorie (optionnel, ex : Bien-être)" maxlength="60">
        <label class="admin-toggle"><input type="checkbox" id="ideaAnon"> Publier anonymement</label>
        <button type="submit" class="btn-save">Publier</button>
      </form>
    </div>
    <div class="idea-list" id="ideaList"><div class="empty">Chargement…</div></div>`;
  document.getElementById("ideaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("ideaTitle").value.trim();
    const description = document.getElementById("ideaDesc").value.trim();
    const category = document.getElementById("ideaCategory").value.trim();
    const is_anonymous = document.getElementById("ideaAnon").checked;
    if (!title || !description) return;
    const { ok, data } = await api("/api/ideas", { method: "POST", body: JSON.stringify({ title, description, category, is_anonymous }) });
    if (!ok) return toast(data?.detail || "Publication impossible.", "error");
    toast("Idée publiée ✓", "success");
    e.target.reset();
    renderIdeaList();
  });
  renderIdeaList();
}

async function renderIdeaList() {
  const list = document.getElementById("ideaList");
  const ideas = (await api("/api/ideas")).data || [];
  list.innerHTML = ideas.length ? "" : `<div class="empty">Aucune idée pour l'instant. À toi de lancer la première !</div>`;
  for (const idea of ideas) {
    const card = document.createElement("div"); card.className = "card idea-card";
    card.innerHTML = `
      <div class="idea-head">
        <div><div class="idea-title">${idea.title}</div>
          <div class="idea-meta">${idea.category ? idea.category + " · " : ""}${idea.is_anonymous ? "Anonyme" : idea.author_name}
            <span class="idea-status-badge idea-status-${idea.status}">${IDEA_STATUS_LABEL[idea.status] || idea.status}</span></div></div>
        <button class="idea-vote-btn${idea.my_vote ? " voted" : ""}" data-vote="${idea.id}">▲ <span>${idea.vote_count}</span></button>
      </div>
      <p class="idea-desc">${idea.description}</p>
      <button class="link-more" data-comments="${idea.id}">💬 ${idea.comment_count} commentaire(s)</button>
      <div class="idea-comments hidden" id="comments-${idea.id}"></div>`;
    card.querySelector("[data-vote]").addEventListener("click", async () => {
      const { ok } = await api(`/api/ideas/${idea.id}/vote`, { method: "POST" });
      if (ok) renderIdeaList();
    });
    card.querySelector("[data-comments]").addEventListener("click", () => toggleIdeaComments(idea.id));
    list.appendChild(card);
  }
}

async function toggleIdeaComments(ideaId) {
  const box = document.getElementById(`comments-${ideaId}`);
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  await loadIdeaComments(ideaId);
}

async function loadIdeaComments(ideaId) {
  const box = document.getElementById(`comments-${ideaId}`);
  box.innerHTML = `<div class="empty">Chargement…</div>`;
  const comments = (await api(`/api/ideas/${ideaId}/comments`)).data || [];
  box.innerHTML = `
    <div class="idea-comment-list">${comments.map(c => `
      <div class="idea-comment"><b>${c.author_name}</b> <span>${c.content}</span></div>`).join("") || `<div class="empty">Aucun commentaire.</div>`}</div>
    <form class="idea-comment-form">
      <input type="text" placeholder="Ajouter un commentaire…" maxlength="500" required>
      <button type="submit">Envoyer</button>
    </form>`;
  box.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const content = input.value.trim();
    if (!content) return;
    const { ok } = await api(`/api/ideas/${ideaId}/comments`, { method: "POST", body: JSON.stringify({ content }) });
    if (!ok) return toast("Envoi impossible.", "error");
    await loadIdeaComments(ideaId);
    const btn = document.querySelector(`[data-comments="${ideaId}"]`);
    if (btn) btn.textContent = "💬 " + (comments.length + 1) + " commentaire(s)";
  });
}

/* ============================================================
   VUE : RECHERCHE GLOBALE
   ============================================================ */
const SEARCH_SECTIONS = [
  { key: "collaborateurs", title: "Collaborateurs" },
  { key: "evenements", title: "Événements" },
  { key: "actualites", title: "Actualités" },
  { key: "idees", title: "Idées" },
  { key: "liens", title: "Liens utiles" },
];

function viewRecherche() {
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="search-bar"><input type="text" id="searchInput" placeholder="Rechercher un collaborateur, un événement, une idée…" autocomplete="off"></div>
    <div id="searchResults"></div>`;
  const input = document.getElementById("searchInput");
  input.focus();
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value.trim()), 300);
  });
}

async function runSearch(q) {
  const results = document.getElementById("searchResults");
  if (!q) { results.innerHTML = ""; return; }
  results.innerHTML = `<div class="empty">Recherche…</div>`;
  const { ok, data } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (!ok) { results.innerHTML = `<div class="empty">Erreur de recherche.</div>`; return; }
  const total = SEARCH_SECTIONS.reduce((n, s) => n + (data[s.key] || []).length, 0);
  if (!total) { results.innerHTML = `<div class="empty">Aucun résultat pour « ${q} ».</div>`; return; }
  results.innerHTML = SEARCH_SECTIONS.filter(s => (data[s.key] || []).length).map(s => `
    <div class="card search-section">
      <h3>${s.title}</h3>
      <div class="list">${searchItemsHtml(s.key, data[s.key])}</div>
    </div>`).join("");
  results.querySelectorAll("[data-search-event]").forEach(el => el.addEventListener("click", () => openEvent(+el.dataset.searchEvent)));
  results.querySelectorAll("[data-search-news]").forEach(el => el.addEventListener("click", () => openNews(+el.dataset.searchNews)));
  results.querySelectorAll("[data-search-link]").forEach(el => el.addEventListener("click", () => window.open(el.dataset.searchLink, "_blank", "noopener")));
  results.querySelectorAll("[data-search-user]").forEach(el => el.addEventListener("click", () => openUserProfile(+el.dataset.searchUser)));
}

function searchItemsHtml(key, items) {
  if (key === "collaborateurs") {
    return items.map(u => `<div class="event-item" data-search-user="${u.id}"><span class="colleague-av" style="background:${colorFor(u.name)};width:28px;height:28px;font-size:.7rem;flex-shrink:0">${initials(u.name)}</span>
      <span class="event-title">${u.name}${u.department ? ` · <span class="muted">${u.department}</span>` : ""}</span></div>`).join("");
  }
  if (key === "evenements") {
    return items.map(e => `<div class="event-item" data-search-event="${e.id}"><span class="event-date">${fdate(e.date, { day: "numeric", month: "short" })}</span><span class="event-title">${e.title}</span></div>`).join("");
  }
  if (key === "actualites") {
    return items.map(n => `<div class="event-item" data-search-news="${n.id}"><span class="event-date">${fdate(n.date, { day: "numeric", month: "short" })}</span><span class="event-title">${n.title}</span></div>`).join("");
  }
  if (key === "idees") {
    return items.map(i => `<div class="event-item"><span class="event-title">${i.title}${i.category ? ` · <span class="muted">${i.category}</span>` : ""}</span></div>`).join("");
  }
  if (key === "liens") {
    return items.map(l => `<div class="event-item" data-search-link="${l.url}"><span class="event-title">${l.icon || "🔗"} ${l.label}</span></div>`).join("");
  }
  return "";
}

/* ============================================================
   VUE : QUIZ (passation + correction automatique + classement)
   ============================================================ */
async function viewQuiz() {
  const view = document.getElementById("view");
  view.innerHTML = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Réponds aux quiz publiés — correction immédiate, classement par quiz.</p>
    <div id="quizList" class="idea-list"><div class="empty">Chargement…</div></div>`;
  const list = document.getElementById("quizList");
  const quizzes = (await api("/api/quizzes")).data || [];
  list.innerHTML = quizzes.length ? "" : `<div class="empty">Aucun quiz disponible pour l'instant.</div>`;
  for (const qz of quizzes) {
    const card = document.createElement("div"); card.className = "card idea-card"; card.style.cursor = "pointer";
    const statusBadge = qz.completed
      ? (qz.is_survey ? `<span class="ev-status-badge">Merci d'avoir répondu ✓</span>` : `<span class="ev-status-badge">Score : ${qz.my_score}/${qz.my_total}</span>`)
      : `<span class="event-reg-btn">${qz.is_survey ? "Donner mon avis" : "Répondre"}</span>`;
    card.innerHTML = `<div class="idea-head">
        <div><div class="idea-title">${qz.title} <span class="idea-status-badge">${qz.is_survey ? "Sondage" : "Quiz"}</span></div>
          <div class="idea-meta">${qz.question_count} question(s)</div></div>
        ${statusBadge}
      </div>
      ${qz.description ? `<p class="idea-desc">${qz.description}</p>` : ""}`;
    card.addEventListener("click", () => openQuiz(qz.id));
    list.appendChild(card);
  }
}

async function openQuiz(quizId) {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="empty">Chargement…</div>`;
  const { ok, data } = await api(`/api/quizzes/${quizId}`);
  if (!ok) { view.innerHTML = `<div class="empty">Quiz introuvable.</div>`; return; }

  const qHtml = data.questions.map((q, i) => `
    <div class="card quiz-question">
      <div class="idea-title">${i + 1}. ${q.text}</div>
      <div class="quiz-choices">${q.choices.map(c => {
        if (data.completed && data.is_survey) {
          const totalVotes = q.choices.reduce((s, x) => s + x.votes, 0);
          const pct = totalVotes ? Math.round((c.votes / totalVotes) * 100) : 0;
          return `<div class="survey-result ${c.chosen ? "chosen" : ""}">
            <div class="survey-result-row"><span>${c.text}${c.chosen ? " · ton choix" : ""}</span><b>${pct}%</b></div>
            <div class="survey-bar"><i style="width:${pct}%"></i></div>
          </div>`;
        }
        if (data.completed) {
          const cls = c.is_correct ? "correct" : (c.chosen ? "wrong" : "");
          return `<label class="quiz-choice ${cls}"><input type="radio" disabled ${c.chosen ? "checked" : ""}> ${c.text}${c.is_correct ? " ✓" : (c.chosen ? " ✕" : "")}</label>`;
        }
        return `<label class="quiz-choice"><input type="radio" name="q${q.id}" value="${c.id}"> ${c.text}</label>`;
      }).join("")}</div>
    </div>`).join("");

  const statusHtml = data.completed
    ? `<div class="ev-status-badge" style="display:inline-block;margin-bottom:14px">${data.is_survey ? "Merci d'avoir répondu !" : `Ton score : ${data.score}/${data.total}`}</div>`
    : "";

  view.innerHTML = `
    <button class="btn-back" id="backBtn">← Retour ${data.is_survey ? "aux sondages" : "aux quiz"}</button>
    <h2 class="ed-title">${data.title}</h2>
    ${data.description ? `<p class="idea-desc">${data.description}</p>` : ""}
    ${statusHtml}
    <form id="quizForm">${qHtml}
      ${data.completed ? "" : `<button type="submit" class="btn-save">${data.is_survey ? "Envoyer ma réponse" : "Valider mes réponses"}</button>`}
    </form>
    ${data.is_survey ? "" : `<button class="link-more" id="showLeaderboard" style="margin-top:14px">🏆 Voir le classement</button>
    <div id="quizLeaderboard" class="idea-comments hidden"></div>`}`;

  document.getElementById("backBtn").addEventListener("click", () => goTo("quiz"));
  const lbBtn = document.getElementById("showLeaderboard");
  if (lbBtn) lbBtn.addEventListener("click", () => toggleQuizLeaderboard(quizId));

  if (!data.completed) {
    document.getElementById("quizForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const answers = {};
      for (const q of data.questions) {
        const checked = document.querySelector(`input[name="q${q.id}"]:checked`);
        if (checked) answers[q.id] = +checked.value;
      }
      const { ok, data: res } = await api(`/api/quizzes/${quizId}/attempt`, { method: "POST", body: JSON.stringify({ answers }) });
      if (!ok) return toast(res?.detail || "Envoi impossible.", "error");
      toast(data.is_survey ? "Merci pour ta réponse ✓" : `Score : ${res.score}/${res.total} ✓`, "success");
      openQuiz(quizId);
    });
  }
}

async function toggleQuizLeaderboard(quizId) {
  const box = document.getElementById("quizLeaderboard");
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = `<div class="empty">Chargement…</div>`;
  const rows = (await api(`/api/quizzes/${quizId}/leaderboard`)).data || [];
  box.innerHTML = rows.length
    ? rows.map((r, i) => `<div class="idea-comment"><b>${i + 1}. ${r.name}</b> <span>${r.score}/${r.total}</span></div>`).join("")
    : `<div class="empty">Personne n'a encore répondu.</div>`;
}

/* ============================================================
   VUE : MÉDIAS (bibliothèque vidéo / albums — liens externes)
   ============================================================ */
const MEDIA_TYPE_LABEL = { video: "Vidéo", album: "Album photo" };

async function viewMedias() {
  const view = document.getElementById("view");
  view.innerHTML = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Vidéos et albums photos partagés par la communication.</p>
    <div id="mediaGrid" class="events-grid"><div class="empty">Chargement…</div></div>`;
  const grid = document.getElementById("mediaGrid");
  const items = (await api("/api/media")).data || [];
  grid.innerHTML = items.length ? "" : `<div class="empty">Aucun média pour l'instant.</div>`;
  for (const it of items) {
    const c = document.createElement("div"); c.className = "event-card"; c.style.cursor = "pointer";
    c.innerHTML = `<span class="ec-date">${MEDIA_TYPE_LABEL[it.type] || it.type}</span>
      <span class="ec-title">${it.title}</span>
      ${it.description ? `<p class="idea-desc" style="margin:4px 0 0">${it.description}</p>` : ""}`;
    c.addEventListener("click", () => openMedia(it.id));
    grid.appendChild(c);
  }
}

async function openMedia(mediaId) {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="empty">Chargement…</div>`;
  const { ok, data } = await api(`/api/media/${mediaId}`);
  if (!ok) { view.innerHTML = `<div class="empty">Média introuvable.</div>`; return; }
  view.innerHTML = `
    <div class="detail-wrap">
    <button class="btn-back" id="backBtn">← Retour</button>
    <article class="event-detail">
      <span class="ec-date">${MEDIA_TYPE_LABEL[data.type] || data.type}</span>
      <h2 class="ed-title">${data.title}</h2>
      ${data.description ? `<p class="idea-desc">${data.description}</p>` : ""}
      ${data.embed_url
        ? `<div class="media-embed"><iframe src="${data.embed_url}" allowfullscreen title="${data.title}"></iframe></div>`
        : `<a class="btn btn-primary" href="${data.url}" target="_blank" rel="noopener">Ouvrir le média ↗</a>`}
      ${data.comments_enabled ? `<div class="idea-comments" id="mediaComments"></div>` : ""}
    </article></div>`;
  document.getElementById("backBtn").addEventListener("click", () => goTo("medias"));
  if (data.comments_enabled) loadMediaComments(mediaId);
}

async function loadMediaComments(mediaId) {
  const box = document.getElementById("mediaComments");
  box.innerHTML = `<div class="empty">Chargement des commentaires…</div>`;
  const comments = (await api(`/api/media/${mediaId}/comments`)).data || [];
  box.innerHTML = `
    <div class="idea-comment-list">${comments.map(c => `
      <div class="idea-comment"><b>${c.author_name}</b> <span>${c.content}</span></div>`).join("") || `<div class="empty">Aucun commentaire.</div>`}</div>
    <form class="idea-comment-form">
      <input type="text" placeholder="Ajouter un commentaire…" maxlength="500" required>
      <button type="submit">Envoyer</button>
    </form>`;
  box.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const content = input.value.trim();
    if (!content) return;
    const { ok } = await api(`/api/media/${mediaId}/comments`, { method: "POST", body: JSON.stringify({ content }) });
    if (!ok) return toast("Envoi impossible.", "error");
    loadMediaComments(mediaId);
  });
}

/* ============================================================
   NOTIFICATIONS (in-app)
   ============================================================ */
async function refreshNotifBadge() {
  const { data } = await api("/api/notifications/unread-count");
  const badge = document.getElementById("notifBadge");
  const count = data?.count || 0;
  badge.textContent = count > 9 ? "9+" : count;
  badge.classList.toggle("hidden", count === 0);
}

async function toggleNotifPanel() {
  const panel = document.getElementById("notifPanel");
  if (!panel.classList.contains("hidden")) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="empty">Chargement…</div>`;
  const items = (await api("/api/notifications")).data || [];
  panel.innerHTML = `
    <div class="notif-head"><b>Notifications</b>${items.some(n => !n.read) ? `<button class="link-more" id="notifReadAll">Tout marquer lu</button>` : ""}</div>
    <div class="notif-list">${items.map(n => `
      <div class="notif-item${n.read ? "" : " unread"}" data-notif="${n.id}" data-link="${n.link || ""}">
        <div class="notif-row"><div class="notif-title">${n.title}</div>
          <button class="notif-del" data-del-notif="${n.id}" title="Supprimer">✕</button></div>
        ${n.body ? `<div class="notif-body">${n.body}</div>` : ""}
      </div>`).join("") || `<div class="empty">Aucune notification.</div>`}</div>`;
  const readAllBtn = document.getElementById("notifReadAll");
  if (readAllBtn) readAllBtn.addEventListener("click", async () => {
    await api("/api/notifications/read-all", { method: "POST" });
    refreshNotifBadge(); toggleNotifPanel(); toggleNotifPanel();
  });
  panel.querySelectorAll("[data-del-notif]").forEach(el => el.addEventListener("click", async (e) => {
    e.stopPropagation();
    await api(`/api/notifications/${el.dataset.delNotif}`, { method: "DELETE" });
    refreshNotifBadge();
    toggleNotifPanel(); toggleNotifPanel();
  }));
  panel.querySelectorAll("[data-notif]").forEach(el => el.addEventListener("click", async () => {
    if (!el.classList.contains("unread")) return;
    await api(`/api/notifications/${el.dataset.notif}/read`, { method: "POST" });
    el.classList.remove("unread");
    refreshNotifBadge();
  }));
}

/* ============================================================
   PROFIL D'UN COLLABORATEUR (le sien = onglet "Profil", ou celui
   d'un collègue depuis la Recherche)
   ============================================================ */
function openMenuSheet() {
  const items = [
    { route: "idees", label: "Idées", icon: "💡" }, { route: "quiz", label: "Quiz", icon: "🧠" },
    { route: "medias", label: "Médias", icon: "🎬" }, { route: "recherche", label: "Recherche", icon: "🔍" },
    { route: "aide", label: "Aide", icon: "❓" },
  ];
  if (state.profile.role === "admin") items.push({ route: "admin", label: "Administration", icon: "⚙️" });
  document.getElementById("menuGrid").innerHTML = items.map(e => `
    <button class="explore-tile" data-go-menu="${e.route}"><span class="explore-icon">${e.icon}</span><span>${e.label}</span></button>`).join("");
  document.querySelectorAll("[data-go-menu]").forEach(b => b.addEventListener("click", () => {
    document.getElementById("menuSheetBackdrop").classList.add("hidden");
    goTo(b.dataset.goMenu);
  }));
  document.getElementById("menuSheetBackdrop").classList.remove("hidden");
}

async function openUserProfile(userId) {
  const { ok, data } = await fetchProfileData(userId);
  if (!ok) { document.getElementById("view").innerHTML = `<div class="empty">Profil introuvable.</div>`; return; }
  renderProfileView(data, { isOwn: false, backLabel: "← Retour à la recherche", backRoute: "recherche" });
}

async function viewProfil() {
  const { ok, data } = await fetchProfileData(state.profile.id);
  if (!ok) { document.getElementById("view").innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  renderProfileView(data, { isOwn: true });
}

async function fetchProfileData(userId) {
  document.getElementById("view").innerHTML = `<div class="empty">Chargement…</div>`;
  return api(`/api/users/${userId}/profile`);
}

function renderProfileView(data, { isOwn, backLabel, backRoute }) {
  const view = document.getElementById("view");
  document.getElementById("pageTitle").textContent = isOwn ? "Mon profil" : data.name;

  const statusRows = data.upcoming_status.map(s => `
    <div class="event-item"><span class="event-date">${fdate(s.day, { weekday: "short", day: "numeric" })}</span>
      <span class="event-title">Matin : ${s.status_am ? statusLabel(s.status_am) : "—"} · Après-midi : ${s.status_pm ? statusLabel(s.status_pm) : "—"}</span></div>`).join("") || `<div class="empty">Aucun statut déclaré.</div>`;
  const resRows = data.upcoming_reservations.map(r => `
    <div class="event-item"><span class="event-date">${fdate(r.date, { day: "numeric", month: "short" })}</span>
      <span class="event-title">Poste ${r.desk} · ${slotLabel(r.slot)}</span></div>`).join("") || `<div class="empty">Aucune réservation à venir.</div>`;
  const ideaRows = data.signed_ideas.map(i => `
    <div class="event-item"><span class="event-title">${i.title} <span class="muted">· ${IDEA_STATUS_LABEL[i.status] || i.status}</span></span></div>`).join("") || `<div class="empty">Aucune idée signée.</div>`;
  const quizRows = data.quiz_results.map(q => `
    <div class="event-item"><span class="event-title">${q.quiz_title}</span><span class="ev-status-badge">${q.score}/${q.total}</span></div>`).join("") || `<div class="empty">Aucun quiz passé.</div>`;

  const badgesHtml = data.badges.map((b, i) => `
    <div class="badge-tile${b.earned ? " earned" : ""}" data-badge-index="${i}">
      <div class="badge-icon">${escapeHtml(b.icon) || "🏅"}</div><div class="badge-name">${escapeHtml(b.name)}</div>
    </div>`).join("");

  view.innerHTML = `
    ${!isOwn ? `<button class="btn-back" id="backBtn">${backLabel}</button>` : ""}
    <div class="card profile-header-card">
      <div class="profile-header">
        <div class="colleague-av" style="background:${colorFor(data.name)};width:52px;height:52px;font-size:1.1rem">${initials(data.name)}</div>
        <div><div class="idea-title" style="font-size:1.1rem;color:#fff">${data.name}</div>
          <div class="profile-sub">${data.department ? data.department + " · " : ""}${data.role === "admin" ? "Administrateur" : "Collaborateur"}</div>
          ${isOwn ? `<div class="profile-sub">✓ Connecté · SSO EyeD${data.streak_days >= 2 ? ` · 🔥 ${data.streak_days} jours de suite` : ""}</div>` : ""}</div>
      </div>
      <div class="level-card">
        <div class="level-row"><span>⭐ ${data.total_points} points</span><b>Niveau ${data.level}</b></div>
        <div class="progress"><i style="width:${data.level_progress_pct}%"></i></div>
        <div class="level-hint">${data.points_to_next_level} points avant le niveau ${data.next_level_label}</div>
      </div>
    </div>
    <div class="card search-section"><h3>Badges <span class="badge-count">${data.badges.filter(b => b.earned).length}/${data.badges.length}</span></h3>
      <div class="badges-grid">${badgesHtml}</div></div>
    <div class="card search-section"><h3>Présence des prochains jours</h3><div class="list">${statusRows}</div></div>
    <div class="card search-section"><h3>Réservations à venir</h3><div class="list">${resRows}</div></div>
    <div class="card search-section"><h3>Idées soumises</h3><div class="list">${ideaRows}</div></div>
    <div class="card search-section"><h3>Quiz passés</h3><div class="list">${quizRows}</div></div>
    ${isOwn ? `
    <div class="card search-section">
      <div class="card-head"><h3>🏆 Classement</h3>
        <div class="segmented" id="lbPeriodToggle"><button data-period="all" class="active">Général</button><button data-period="month">Ce mois-ci</button></div>
      </div>
      <div class="list" id="leaderboardList"><div class="empty">Chargement…</div></div>
    </div>
    <div class="card search-section"><h3>Paramètres</h3>
      <div class="profile-setting-row"><span>Email</span><span class="muted">${data.email}</span></div>
      <div class="profile-setting-row"><span>Département</span><span class="muted">${data.department || "—"}</span></div>
      <div class="profile-setting-row"><span>Mon anniversaire 🎂</span>
        <input type="date" id="birthdayInput" value="${data.birthday || ""}" style="border:1px solid var(--border);border-radius:8px;padding:6px 8px;font:inherit">
      </div>
      <button class="btn" id="saveBirthdayBtn" style="margin-top:4px">Enregistrer</button>
      <a class="btn" style="background:#FEE2E2;color:var(--red);text-align:center;margin-top:12px" href="/auth/logout">Se déconnecter</a>
    </div>` : ""}`;

  if (!isOwn) document.getElementById("backBtn").addEventListener("click", () => goTo(backRoute));
  if (isOwn) {
    loadLeaderboard(data.id, "all");
    document.querySelectorAll("#lbPeriodToggle button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll("#lbPeriodToggle button").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); loadLeaderboard(data.id, b.dataset.period);
    }));
    document.getElementById("saveBirthdayBtn").addEventListener("click", async () => {
      const val = document.getElementById("birthdayInput").value || null;
      const { ok } = await api("/api/profile/birthday", { method: "PUT", body: JSON.stringify({ birthday: val }) });
      toast(ok ? "Anniversaire enregistré ✓" : "Erreur, réessaie", ok ? "success" : "error");
    });
  }
  view.querySelectorAll("[data-badge-index]").forEach(el => el.addEventListener("click", () => {
    openBadgeDetailSheet(data.badges[+el.dataset.badgeIndex]);
  }));
}

function openBadgeDetailSheet(badge) {
  document.getElementById("badgeDetailIcon").textContent = badge.icon || "🏅";
  document.getElementById("badgeDetailName").textContent = badge.name;
  document.getElementById("badgeDetailDesc").textContent = badge.description || "";
  document.getElementById("badgeDetailPoints").textContent = `⭐ ${badge.points} points`;
  document.getElementById("badgeDetailStatus").textContent = badge.earned ? "✓ Obtenu" : "Pas encore obtenu";
  document.getElementById("badgeDetailStatus").className = "badge-detail-status" + (badge.earned ? " earned" : "");
  document.getElementById("badgeDetailSheetBackdrop").classList.remove("hidden");
}
function closeBadgeDetailSheet() {
  document.getElementById("badgeDetailSheetBackdrop").classList.add("hidden");
}

async function loadLeaderboard(myId, period) {
  const box = document.getElementById("leaderboardList");
  box.innerHTML = `<div class="empty">Chargement…</div>`;
  const rows = (await api(`/api/leaderboard?period=${period}`)).data || [];
  box.innerHTML = rows.map((r, i) => `
    <div class="event-item leaderboard-row${r.id === myId ? " me" : ""}"><span class="event-date">#${i + 1}</span>
      <span class="event-title">${r.name}${r.id === myId ? " (toi)" : ""}</span><span class="ev-status-badge">${r.total_points} pts</span></div>`).join("")
    || `<div class="empty">Pas encore de classement.</div>`;
}

/* ============================================================
   VUE : AIDE (guide pratique — comment utiliser l'app au quotidien)
   ============================================================ */
function viewAide() {
  const isAdmin = state.profile.role === "admin";
  const ICONS = {
    reserver: `<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M5 19v2M19 19v2"/>`,
    presence: `<path d="M20 6L9 17l-5-5"/>`,
    gamification: `<path d="M12 2l2.9 6.9L22 9.6l-5.5 4.9L18 22l-6-3.6L6 22l1.5-7.5L2 9.6l7.1-.7z"/>`,
    evenements: `<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>`,
    idees: `<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.1 1 1.8v.5h6v-.5c0-.7.4-1.4 1-1.8A7 7 0 0 0 12 2z"/>`,
    quiz: `<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4"/><path d="M12 17h.01"/>`,
    medias: `<rect x="2" y="3" width="20" height="14" rx="2"/><path d="m10 8 5 3-5 3z"/><path d="M8 21h8"/>`,
    recherche: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
    profil: `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
    admin: `<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.3 1a7 7 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.5-2-1.5a7 7 0 0 0 .1-1z"/>`,
    astuces: `<path d="M13 2 3 14h7l-1 8 11-14h-7z"/>`,
    faq: `<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`,
  };
  const ICON_TIP = `<svg viewBox="0 0 24 24"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.1 1 1.8v.5h6v-.5c0-.7.4-1.4 1-1.8A7 7 0 0 0 12 2z"/></svg>`;
  const ICON_WARN = `<svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`;
  const tip = (html) => `<div class="aide-callout tip">${ICON_TIP}<p>${html}</p></div>`;
  const warn = (html) => `<div class="aide-callout warn">${ICON_WARN}<p>${html}</p></div>`;

  const sections = [
    {
      id: "reserver",
      title: "Réserver une place",
      a: `<p>Choisis un jour dans le calendrier, puis clique sur un poste libre (en vert) sur le plan. Tu peux réserver le matin, l'après-midi ou la journée complète : c'est cette dernière qui est proposée par défaut, la plus simple si ton programme ne change pas en cours de route.</p>
        <p>Dans les bureaux fermés (Bureau 1 et 2), tu réserves soit un siège précis, soit toute la salle d'un coup avec "Réserver toute la salle", pratique pour une réunion d'équipe. Un seul poste déjà pris dans la salle suffit à bloquer cette option, peu importe qui l'a réservé.</p>
        <p>Dans l'open space, certains postes portent une petite icône (écran, debout, calme, fenêtre...) qui signale leurs particularités. Un clic ou un survol suffit pour les voir avant de te décider.</p>
        <p>Les bulles calmes (BC-1, BC-2) sont pensées pour un appel ou un moment de concentration. Elles se réservent par créneau horaire libre plutôt que par demi-journée, et ne rapportent volontairement pas de points : ça évite qu'on les réserve juste pour gonfler son score. Elles ne comptent pas non plus dans le taux d'occupation affiché sur l'accueil.</p>
        <p>Quelques garde-fous s'appliquent à tout le monde : pas de réservation le week-end, un horizon maximum fixé par l'admin (affiché en haut de la page Réserver), et un nombre de jours consécutifs limité. Tu peux annuler à tout moment depuis "Mes réservations" ou l'accueil.</p>
        ${warn(`Le jour J, pense à cliquer <b>"Je suis arrivé"</b> une fois sur place. Une demi-journée réservée mais jamais confirmée devient un no-show : -10 points, sans rattrapage possible après coup.`)}
        ${tip(`Tu déclares le statut "Coworking" sans avoir encore réservé ? L'app te propose de le faire directement, pas besoin de changer d'écran.`)}`,
    },
    {
      id: "presence",
      title: "Déclarer sa présence",
      a: `<p>Dans "Ma présence", ou directement sur l'accueil, indique ton statut pour le matin et l'après-midi séparément : coworking, télétravail, déplacement, congé, ou un statut propre à ton équipe si l'admin en a créé un.</p>
        <p>Si tu changes de statut un jour où tu as déjà une réservation, l'app te prévient et te laisse choisir entre la garder ou l'annuler. Rien n'est décidé à ta place.</p>
        <p>La page affiche aussi un aperçu de ta semaine complète, pratique pour visualiser tes prochains jours d'un coup d'œil.</p>`,
    },
    {
      id: "gamification",
      title: "Points, niveaux et badges",
      a: `<p>Chaque réservation confirmée rapporte 10 points, dès sa création (pas besoin d'attendre le check-in). À l'inverse, une annulation ou un no-show en coûte 10. Une bonne réponse à un quiz vaut 2 points (les sondages n'en rapportent pas, ils n'ont pas de bonne réponse), et débloquer un badge pour la première fois donne un bonus de 15 points.</p>
        <p>Les niveaux montent sans fin, un peu comme dans un jeu vidéo : plus tu progresses, plus le palier suivant demande de points. Ta progression est visible sur ton profil et dans le cadran de l'accueil.</p>
        <p>Les badges récompensent des habitudes qui durent : assiduité, présence sans faute, participation aux quiz ou aux idées. Certains ont plusieurs paliers qui se débloquent progressivement plutôt qu'un seul badge figé.</p>
        <p>Ton streak (visible sur ton profil) compte les jours ouvrés consécutifs avec un check-in confirmé. Il casse au premier oubli. Il existe deux classements : un général depuis toujours, et un mensuel remis à zéro chaque mois, une bonne excuse pour rester actif même après une pause.</p>`,
    },
    {
      id: "evenements",
      title: "Événements",
      a: `<p>Inscris-toi en un clic depuis "Événements" ou la carte "Événements à venir" de l'accueil. Si c'est complet, tu passes en liste d'attente automatiquement : dès qu'une place se libère, la première personne en attente est promue sans rien avoir à faire.</p>
        <p>Le bouton "+ Calendrier" télécharge un fichier .ics à ouvrir dans ton application habituelle (Outlook, Google Calendar...). Ce n'est pas une synchronisation automatique, mais ça s'ouvre nativement partout.</p>
        <p>Un rappel arrive automatiquement dans tes notifications la veille et le jour même d'un événement où tu es inscrit.</p>
        <p>Petite limite à connaître : la date affichée dépend de ce que l'intranet WordPress renseigne. Si un événement n'a pas de date précise côté intranet, l'app se rabat sur sa date de publication.</p>`,
    },
    {
      id: "idees",
      title: "Boîte à idées",
      a: `<p>Propose une idée avec un titre, une description et une catégorie libre. Tu peux publier anonymement si tu préfères : dans ce cas, ton nom n'apparaît nulle part, pas même sur ton profil.</p>
        <p>Vote pour les idées qui te parlent (un vote par idée et par personne, la liste est triée par popularité) et commente pour enrichir la discussion.</p>
        <p>Le statut de chaque idée évolue au fil du temps (nouvelle, étudiée, acceptée, refusée ou archivée), mis à jour par l'équipe qui gère la boîte à idées. Une idée archivée disparaît simplement de la liste.</p>`,
    },
    {
      id: "quiz",
      title: "Quiz",
      a: `<p>Une seule tentative par quiz et par personne, pas de deuxième chance en cas d'erreur. Prends ton temps avant de valider.</p>
        <p>Deux formats existent. Le quiz classique corrige automatiquement et immédiatement, avec les bonnes et mauvaises réponses surlignées et 2 points à la clé par bonne réponse. Le sondage n'a pas de bonne réponse : une fois que tu as voté, tu vois la répartition de tout le monde en pourcentage.</p>
        <p>Un classement par quiz est consultable dès que tu as répondu.</p>`,
    },
    {
      id: "medias",
      title: "Médias",
      a: `<p>Une bibliothèque de vidéos et d'albums photos, toujours en liens externes : rien n'est hébergé sur nos serveurs. Les vidéos YouTube se lisent directement dans l'app, les autres liens (Drive, albums en ligne...) s'ouvrent dans un nouvel onglet.</p>
        <p>Certains médias permettent de laisser un commentaire. L'admin active cette option au cas par cas, selon le contenu.</p>`,
    },
    {
      id: "recherche",
      title: "Recherche et notifications",
      a: `<p>La loupe en haut de l'écran cherche partout à la fois : collègues (nom, email), événements et actualités de l'intranet, idées (titre, description), liens utiles. Les résultats sont groupés par catégorie.</p>
        <p>Clique sur un collègue pour ouvrir son profil public : son statut des prochains jours, ses réservations à venir, ses idées signées (les anonymes le restent) et ses résultats de quiz.</p>
        <p>La cloche affiche tes notifications : rappels d'événements et annonces de l'équipe. Le badge rouge compte les non-lues et se met à jour tout seul. Clique une notification pour la marquer lue, "Tout marquer lu" pour vider le badge d'un coup, ou la croix pour la supprimer. Pas d'email ni de notification Teams pour l'instant, tout se passe dans l'app.</p>`,
    },
    {
      id: "profil",
      title: "Mon profil",
      a: `<p>Ta carte d'identité dans l'app : avatar, département, rôle, points et niveau avec la progression vers le palier suivant, grille de badges obtenus (clique dessus pour le détail), streak de présence, classement général et mensuel.</p>
        <p>Tu y retrouves aussi tes réservations à venir, tes idées et tes quiz passés, tout au même endroit.</p>
        <p>Dans les paramètres, tout en bas, renseigne ta date d'anniversaire (jour et mois seulement, jamais l'année) pour apparaître sur la carte "Anniversaires" de l'accueil le jour J. C'est aussi là que tu te déconnectes.</p>`,
    },
  ];

  if (isAdmin) sections.push({
    id: "admin",
    title: "Administration (accès restreint)",
    a: `<p>Visible seulement par une liste restreinte de personnes, indépendamment du rôle sur l'intranet WordPress. Un aperçu de ce qu'on peut configurer, onglet par onglet :</p>
      <ul>
        <li><b>Accueil</b> : active, désactive et réordonne les cartes du tableau de bord, configure le jalon "Building Our Future Home" et les statuts de présence proposés.</li>
        <li><b>Coworking</b> : postes (création, désactivation, caractéristiques, position sur le plan), horizon de réservation, noms des salles et bulles.</li>
        <li><b>Événements</b> : capacité par événement, liste des inscrits et de la liste d'attente, envoi d'une notification manuelle à tous les inscrits.</li>
        <li><b>Contenu</b> : idées (workflow de statut), quiz (création et édition, y compris en mode sondage), médias (ajout, édition), badges (création, attribution ou retrait manuel, points associés).</li>
        <li><b>Collaborateurs</b> : renseigner l'anniversaire de n'importe qui, faute d'une source fiable côté intranet.</li>
        <li><b>Statistiques</b> : indicateurs d'usage (occupation, réservations, quiz, idées...) et alertes automatiques (quiz sans question, idées en attente, événement complet avec liste d'attente...).</li>
      </ul>`,
  });

  sections.push({
    id: "astuces",
    title: "Pour en tirer le maximum",
    a: `<ul>
        <li>Réserve dès le début de la semaine si tu vises un poste précis (fenêtre, écran...), les places populaires partent vite.</li>
        <li>Pense au check-in dès ton arrivée. Ça prend deux secondes et t'évite de perdre des points sans t'en rendre compte.</li>
        <li>Si finalement tu ne viens plus, annule plutôt que de laisser tourner en no-show : ça libère la place pour quelqu'un d'autre et t'évite la pénalité.</li>
        <li>Un coup d'œil à la carte "Présents aujourd'hui" avant de réserver, pour voir qui sera sur site le même jour que toi.</li>
        <li>Pour un appel important, une bulle calme vaut mieux qu'un poste classique : pas besoin de bloquer une demi-journée pour trente minutes.</li>
        <li>Le classement se réinitialise chaque mois : après une pause, tu repars à égalité avec tout le monde.</li>
      </ul>`,
  });

  sections.push({
    id: "faq",
    title: "Questions fréquentes",
    a: `<ul>
          <li><b>Je n'arrive pas à réserver un jour précis.</b> Trois causes possibles : c'est un week-end, c'est au-delà de l'horizon autorisé (affiché en haut de la page Réserver), ou tu as déjà atteint ton maximum de jours consécutifs.</li>
          <li><b>J'ai perdu des points sans comprendre pourquoi.</b> Regarde du côté d'une réservation jamais confirmée par "Je suis arrivé" (no-show, -10 points), ou d'une annulation d'une réservation déjà validée.</li>
          <li><b>"Réserver toute la salle" refuse.</b> Il suffit qu'un seul poste actif de la salle soit déjà pris pour bloquer toute la salle sur ce créneau.</li>
          <li><b>Je ne vois pas l'onglet Administration.</b> Il est réservé à une liste restreinte de personnes, indépendamment de ton rôle sur l'intranet.</li>
          <li><b>Je ne reçois pas d'email pour les rappels.</b> C'est normal : tout passe par les notifications in-app pour l'instant, rien n'est envoyé par email ou Teams.</li>
          <li><b>La date d'un événement semble fausse.</b> L'app affiche la date exacte quand l'intranet la fournit. Sinon, elle se rabat sur la date de publication de l'article, qui peut différer de la date réelle.</li>
        </ul>`,
  });

  const stripTags = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

  document.getElementById("view").innerHTML = `
    <div class="aide-hero">
      <h2>Besoin d'un coup de main ?</h2>
      <p>Tout ce qu'il y a à savoir sur l'app, expliqué simplement. Cherche un mot-clé ou choisis une catégorie ci-dessous.</p>
      <div class="aide-search">
        <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="text" id="aideSearch" placeholder="Cherche par exemple « no-show », « badge », « anniversaire »...">
      </div>
    </div>
    <div class="aide-categories">
      ${sections.map(s => `<button type="button" class="aide-chip" data-aide-jump="${s.id}"><svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">${ICONS[s.id] || ""}</svg><span>${s.title}</span></button>`).join("")}
    </div>
    <div class="aide-list" id="aideList">
      ${sections.map((s, i) => `
        <details class="card aide-item" id="aide-${s.id}"${i === 0 ? " open" : ""} data-aide-text="${escapeHtml(s.title.toLowerCase() + " " + stripTags(s.a))}">
          <summary>
            <span class="aide-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">${ICONS[s.id] || ""}</svg></span>
            <span class="aide-item-title">${s.title}</span>
            <span class="aide-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
          </summary>
          <div class="aide-body">${s.a}</div>
        </details>`).join("")}
    </div>
    <p class="empty aide-empty hidden" id="aideEmpty">Aucun résultat pour cette recherche. Essaie un autre mot-clé, ou explore les catégories ci-dessus.</p>
    <a href="#idees" class="card aide-cta">
      <span class="aide-cta-icon">${ICON_TIP}</span>
      <span class="aide-cta-text"><strong>Une question qui n'est pas dans la liste ?</strong><p>Passe par la boîte à idées, l'équipe qui gère l'app y répond.</p></span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
    </a>`;

  document.querySelectorAll("[data-aide-jump]").forEach(btn => btn.addEventListener("click", () => {
    const target = document.getElementById("aide-" + btn.dataset.aideJump);
    target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  const searchInput = document.getElementById("aideSearch");
  const items = Array.from(document.querySelectorAll("#aideList .aide-item"));
  const emptyMsg = document.getElementById("aideEmpty");
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    let visible = 0;
    items.forEach(item => {
      const match = !q || item.dataset.aideText.includes(q);
      item.classList.toggle("hidden", !match);
      if (match) { visible++; if (q) item.open = true; }
    });
    emptyMsg.classList.toggle("hidden", visible !== 0);
  });
}

/* ---------------- Effets ---------------- */
function floatPoint() {
  const pill = document.getElementById("pointsPill"); const r = pill.getBoundingClientRect();
  const f = document.createElement("div"); f.className = "float-point"; f.textContent = "+10 ⭐";
  f.style.left = r.left + "px"; f.style.top = r.top + "px"; document.body.appendChild(f); setTimeout(() => f.remove(), 1000);
}
let toastTimer;
function toast(msg, type = "") {
  const t = document.getElementById("toast"); t.textContent = msg; t.className = "toast show " + type;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = "toast " + type; }, 2600);
}

/* Toast avec un bouton d'action (ex: "Réserver une place →"). Reste affiché plus
   longtemps qu'un toast normal pour laisser le temps de cliquer. */
function toastAction(msg, actionLabel, onAction) {
  const t = document.getElementById("toast");
  t.innerHTML = `<span>${msg}</span><button class="toast-action-btn" id="toastActionBtn">${actionLabel} →</button>`;
  t.className = "toast show toast-with-action";
  clearTimeout(toastTimer);
  document.getElementById("toastActionBtn").onclick = () => {
    t.className = "toast toast-with-action"; onAction();
  };
  toastTimer = setTimeout(() => { t.className = "toast toast-with-action"; }, 5000);
}

init();
