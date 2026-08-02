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
const FEATURE_ICON_RULES = [
  [/écran|ecran|screen|moniteur/i, "🖥️"],
  [/surface|tablette|tablet/i, "📱"],
  [/debout|standing/i, "🧍"],
  [/clavier|souris|keyboard|mouse/i, "⌨️"],
  [/casque|audio|micro/i, "🎧"],
  [/calme|silence|quiet/i, "🤫"],
  [/fenêtre|fenetre|lumière|lumiere|window/i, "☀️"],
];
function featureIcon(text) {
  for (const [re, icon] of FEATURE_ICON_RULES) if (re.test(text)) return icon;
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
  window.addEventListener("resize", resize);
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
    // Centre décalé en haut à droite : l'œil déborde du cadre, visible en marge du
    // contenu plutôt que caché dessous — c'est l'illustration qui donne le ton, pas
    // un fond décoratif qu'on ne remarque pas.
    const cx = w * .78, cy = h * .30;
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

/* ---------------- Démarrage ---------------- */
async function init() {
  // /api/profile, /api/statuses et /api/reservation-policy sont indépendants : lancés en
  // parallèle plutôt que l'un après l'autre pour économiser des allers-retours réseau au
  // démarrage (sensible surtout en mobile/latence élevée).
  const [{ ok, data }, st, pol] = await Promise.all([
    api("/api/profile"), api("/api/statuses"), api("/api/reservation-policy"),
  ]);
  if (!ok) { document.getElementById("login").classList.remove("hidden"); initLoginScene(); return; }
  state.profile = data;
  state.statusCatalog = (st.data && st.data.catalog) || [];
  state.advanceDays = (pol.data && pol.data.advance_days) || 7;
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
      <button data-tab="evenements">Événements</button>
      <button data-tab="contenu">Contenu</button>
      <button data-tab="collaborateurs">Collaborateurs</button>
      <button data-tab="stats">Statistiques</button>
    </div>
    <div id="adminBody"></div>`;
  const RENDERERS = {
    accueil: renderAdminAccueil, espaces: renderAdminEspaces, evenements: renderAdminEvenements,
    contenu: renderAdminContenu, collaborateurs: renderAdminCollaborateurs, stats: renderAdminStats,
  };
  view.querySelectorAll(".admin-tabs button").forEach(b => b.addEventListener("click", () => {
    view.querySelectorAll(".admin-tabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    RENDERERS[b.dataset.tab]();
  }));
  renderAdminAccueil();
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
  const [{ ok, data }, labelsRes, policyRes] = await Promise.all([
    api("/api/admin/desks"), api("/api/room-labels"), api("/api/reservation-policy"),
  ]);
  if (!ok) { body.innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  const labels = labelsRes.data || {};
  const advanceDays = (policyRes.data && policyRes.data.advance_days) || 7;
  const groups = {};
  for (const d of data) (groups[d.zone || "Sans bureau"] ||= []).push(d);
  let html = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Gère les postes et la capacité de chaque bureau. Chaque changement est enregistré immédiatement.</p>
    <div class="card">
      <h3>Noms affichés</h3>
      <div class="room-label-grid">
        <label>Bureau 1 <input class="room-label-input" data-ref="Bureau 1" value="${(labels["Bureau 1"] || "Bureau 1").replace(/"/g, "&quot;")}"></label>
        <label>Bureau 2 <input class="room-label-input" data-ref="Bureau 2" value="${(labels["Bureau 2"] || "Bureau 2").replace(/"/g, "&quot;")}"></label>
        <label>Bulle calme 1 <input class="room-label-input" data-ref="BC-1" value="${(labels["BC-1"] || "Bulle calme 1").replace(/"/g, "&quot;")}"></label>
        <label>Bulle calme 2 <input class="room-label-input" data-ref="BC-2" value="${(labels["BC-2"] || "Bulle calme 2").replace(/"/g, "&quot;")}"></label>
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
        <h3>${zone} <span class="muted" style="font-weight:400">· ${active} place(s) active(s)</span></h3>
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
        <div id="tableSections"><div class="empty">Chargement…</div></div>
        <div class="section-eyebrow">Plan de l'espace</div>
        <div class="card plan-panel">
          <img src="/static/img/floorplan.png" alt="Plan réel de l'open space et des bureaux" class="plan-image">
        </div>
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
  const [avail, mine, labels] = await Promise.all([
    api(`/api/availability?date=${state.date}&slot=${state.slot}`),
    api("/api/reservations/me"),
    api("/api/room-labels"),
  ]);
  state.availability = avail.data || [];
  state.myReservations = mine.data || [];
  state.roomLabels = labels.data || {};

  const roomResults = await Promise.all(
    ROOM_ZONES.map(z => api(`/api/reservations/room?zone=${encodeURIComponent(z)}&date=${state.date}`))
  );
  state.myRoomReservations = {};
  ROOM_ZONES.forEach((z, i) => { state.myRoomReservations[z] = (roomResults[i].data && roomResults[i].data.reservation_ids) || []; });

  const podDesks = state.availability.filter(x => x.desk.zone === "Bulles calmes").map(x => x.desk);
  const podResults = await Promise.all(podDesks.map(d => api(`/api/pods/${d.id}/timeslots?date=${state.date}`)));
  state.podBookings = {};
  podDesks.forEach((d, i) => { state.podBookings[d.id] = podResults[i].data || []; });

  renderTables(); renderMyReservations();
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
    const label = g.zone.startsWith("Bureau") ? ((state.roomLabels && state.roomLabels[g.zone]) || g.zone) : `Table ${g.key.replace(/^T/, "")}`;
    const half = Math.ceil(g.items.length / 2);
    return { ...g, label, cap: g.items.length, topSeats: g.items.slice(0, half), botSeats: g.items.slice(half) };
  });
}

function renderTables() {
  const box = document.getElementById("tableSections"); if (!box) return;
  const bureaux = groupIntoTables(state.availability.filter(x => x.desk.zone && x.desk.zone.startsWith("Bureau")));
  const openspace = groupIntoTables(state.availability.filter(x => x.desk.zone === "Open Space"));

  function roomButtonHtml(t) {
    const myIds = (state.myRoomReservations && state.myRoomReservations[t.zone]) || [];
    const mine = myIds.length > 0;
    const free = t.items.every(x => x.is_available);
    if (mine) return `<button class="room-book-btn mine" data-room-zone="${t.zone}">Salle réservée (vous) · Annuler</button>`;
    if (free) return `<button class="room-book-btn" data-room-zone="${t.zone}">Réserver toute la salle</button>`;
    return `<button class="room-book-btn" data-room-zone="${t.zone}" disabled title="Un poste de cette salle est déjà réservé">Salle indisponible</button>`;
  }

  function section(title, tables, isRoom) {
    if (!tables.length) return "";
    // Groupées par paires (colle au plan réel : les tables voisines restent côte à côte
    // sur la même ligne, plutôt qu'un enchaînement qui coupe les paires au retour à la ligne).
    const rows = [];
    for (let i = 0; i < tables.length; i += 2) rows.push(tables.slice(i, i + 2));
    const rowsHtml = rows.map(row => {
      const widgets = row.map(t => `
        <div class="table-widget-wrap">
          <div class="table-widget">
            <div class="ts-row">${t.topSeats.map(seatHtml).join("")}</div>
            <div class="ts-surface">${t.cap} pl.</div>
            <div class="ts-row">${t.botSeats.map(seatHtml).join("")}</div>
          </div>
          <div class="ts-label">${t.label}</div>
          ${isRoom ? roomButtonHtml(t) : ""}
        </div>`).join("");
      return `<div class="table-scroll-row">${widgets}</div>`;
    }).join("");
    return `<div class="section-eyebrow">${title}</div>
      <div class="card table-card"><div class="table-scroll scroll">${rowsHtml}</div></div>`;
  }
  function seatHtml(item) {
    const mineHere = !item.is_available && item.booked_by === state.profile.name;
    const isSel = state.selected && state.selected.deskId === item.desk.id;
    const cls = isSel ? "selected" : item.is_available ? "free" : mineHere ? "mine" : "occupied";
    // Nom visible directement sur le siège (sans avoir à cliquer) : initiales pour les occupés, "moi" pour ma place.
    const label = mineHere ? "moi" : !item.is_available ? initials(item.booked_by) : "";
    const featTitle = item.desk.features ? ` (${item.desk.features})` : "";
    return `<button class="tseat ${cls}" data-desk="${item.desk.id}" title="${item.desk.name}${featTitle}${item.is_available ? " — disponible" : mineHere ? " — votre place" : " — occupé par " + item.booked_by}">${label}</button>`;
  }
  box.innerHTML = section("Bureaux fermés", bureaux, true) + section("Open space · postes individuels", openspace, false) + renderPodsSection();
  box.querySelectorAll(".tseat").forEach(btn => {
    const id = +btn.dataset.desk;
    const item = state.availability.find(a => a.desk.id === id);
    const mineHere = !item.is_available && item.booked_by === state.profile.name;
    if (item.is_available || mineHere) btn.addEventListener("click", () => selectSeat(item, mineHere));
  });
  box.querySelectorAll("[data-room-zone]").forEach(btn => {
    if (!btn.disabled) btn.addEventListener("click", () => onRoomButtonClick(btn.dataset.roomZone));
  });
  box.querySelectorAll("[data-open-pod]").forEach(btn => btn.addEventListener("click", () => openPodSheet(+btn.dataset.openPod)));
  box.querySelectorAll("[data-cancel-pod]").forEach(btn => btn.addEventListener("click", () => cancelPodBooking(+btn.dataset.cancelPod)));
}

function onRoomButtonClick(zone) {
  const myIds = (state.myRoomReservations && state.myRoomReservations[zone]) || [];
  if (myIds.length) {
    state.selected = { type: "room", zone, name: `Salle — ${(state.roomLabels && state.roomLabels[zone]) || zone}`, mine: true, resIds: myIds };
  } else {
    const items = state.availability.filter(x => x.desk.zone === zone);
    if (!items.every(x => x.is_available)) return toast("Cette salle n'est plus disponible.", "error");
    state.selected = { type: "room", zone, name: `Salle — ${(state.roomLabels && state.roomLabels[zone]) || zone}`, mine: false, resIds: [] };
  }
  openReserveSheet();
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
    return `<div class="card pod-card">
      <div class="card-head"><h3>${podLabel(d.name)}</h3>
        <button class="link-more" data-open-pod="${d.id}">+ Réserver un créneau</button></div>
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
  renderTables(); openReserveSheet();
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
  if (state.selected.mine) { for (const id of state.selected.resIds) await cancelRes(id); }
  else if (state.selected.type === "room") await bookRoom(state.selected.zone, sheetSlot);
  else await book(state.selected.deskId, sheetSlot);
  clearSelection();
}
function renderMyReservations() {
  const box = document.getElementById("myReservations"); if (!box) return;
  if (!state.myReservations.length) { box.innerHTML = `<div class="empty">Aucune réservation à venir.</div>`; return; }
  box.innerHTML = "";
  const todayIso = toLocalISODate(new Date());
  for (const r of state.myReservations) {
    const isTimeslot = r.slot === "timeslot";
    const isToday = r.reservation_date === todayIso;
    const el = document.createElement("div"); el.className = "res-item";
    const checkinBtn = isToday && !isTimeslot
      ? (r.checked_in_at ? `<span class="res-checked">✓ Présent</span>` : `<button class="checkin" data-checkin="${r.id}">Je suis arrivé</button>`)
      : "";
    const slotText = isTimeslot ? `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}` : slotLabel(r.slot);
    el.innerHTML = `<div class="info"><b>${r.desk.name}</b><small>${fdate(r.reservation_date, { weekday: "short", day: "numeric", month: "short" })} · ${slotText}</small></div>
      <div class="res-item-actions">${checkinBtn}<button class="cancel">Annuler</button></div>`;
    el.querySelector(".cancel").addEventListener("click", () => isTimeslot ? cancelPodBooking(r.id) : cancelRes(r.id));
    const cb = el.querySelector("[data-checkin]");
    if (cb) cb.addEventListener("click", async () => {
      const { ok, data } = await api(`/api/reservations/${r.id}/checkin`, { method: "POST" });
      if (!ok) return toast(data?.detail || "Check-in impossible.", "error");
      toast("Présence confirmée ✓", "success"); loadReserve();
    });
    box.appendChild(el);
  }
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
async function cancelRes(id) {
  const { ok, data } = await api(`/api/reservations/${id}`, { method: "DELETE" });
  if (!ok) return toast(data?.detail || "Annulation impossible.", "error");
  refreshPoints(-10); toast("Réservation annulée."); loadReserve();
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
  const sections = [
    {
      id: "reserver",
      q: "🪑 Réserver une place",
      a: `<p>Choisis un jour puis clique sur un poste libre (vert) sur le plan. Trois durées possibles : <b>matin</b>, <b>après-midi</b> ou <b>journée</b> (par défaut, la plus simple si tu ne changes pas d'avis en cours de journée).</p>
        <ul>
          <li><b>Bureaux fermés</b> (Bureau 1/2) : réserve un poste individuel en cliquant sur un siège précis, ou "Réserver toute la salle" pour prendre toute la pièce d'un coup (pratique pour une réunion d'équipe) — bloqué si un seul poste de la salle est déjà pris, par n'importe qui.</li>
          <li><b>Open space</b> : les postes marqués d'une icône (écran, debout, calme, fenêtre…) ont des caractéristiques particulières — survole ou clique un poste pour les voir avant de réserver.</li>
          <li><b>Bulles calmes</b> (BC-1, BC-2) : pour un appel ou un moment de concentration. Réservables par <b>créneau horaire libre</b> (ex. 14h15–15h00), pas par demi-journée. Elles ne rapportent pas de points (pour éviter les réservations répétées juste pour farmer des points) et ne comptent pas dans le taux d'occupation affiché sur l'accueil.</li>
          <li>Limites anti-abus, valables pour tout le monde : pas de réservation le week-end, un horizon maximum de jours à l'avance (visible en haut de la page "Réserver", réglé par l'admin), et un nombre maximum de jours ouvrés <b>consécutifs</b> réservés d'affilée.</li>
          <li>Tu peux annuler une réservation à tout moment depuis "Mes réservations" (page Réserver) ou l'accueil.</li>
        </ul>
        <p><b>⚠️ Le jour J, clique "Je suis arrivé"</b> (bouton sur l'accueil ou dans "Mes réservations") une fois sur place. Une demi-journée réservée mais jamais confirmée devient un <b>no-show</b> : -10 points, automatiquement, sans rattrapage possible après coup.</p>
        <p>💡 <b>Astuce</b> : si tu déclares le statut "Coworking" (voir section suivante) sans avoir encore réservé, l'app te le propose directement — pas besoin de changer d'écran.</p>`,
    },
    {
      id: "presence",
      q: "📋 Déclarer sa présence",
      a: `<p>Dans "Ma présence" (ou directement sur l'accueil), indique ton statut <b>séparément pour le matin et l'après-midi</b> : coworking, télétravail, déplacement, congé — ou un statut personnalisé si l'admin en a ajouté un pour ton équipe.</p>
        <p>Si tu changes de statut un jour où tu as déjà une réservation active, l'app te prévient et te laisse choisir : garder la réservation ou l'annuler avant d'enregistrer le nouveau statut. Rien n'est fait à ta place sans confirmation.</p>
        <p>La page "Ma présence" affiche aussi un aperçu de ta semaine, pratique pour visualiser tes prochains jours d'un coup d'œil.</p>`,
    },
    {
      id: "gamification",
      q: "⭐ Points, niveaux et badges",
      a: `<p>Ce que ça rapporte (ou coûte) concrètement :</p>
        <ul>
          <li>+10 points par réservation confirmée (validée dès la création, pas seulement au check-in) ; -10 en cas d'annulation ou de <b>no-show</b>.</li>
          <li>+2 points par bonne réponse à un quiz (les sondages n'en rapportent pas, ils n'ont pas de bonne/mauvaise réponse).</li>
          <li>+15 points bonus la première fois que tu débloques un badge.</li>
        </ul>
        <p>Les <b>niveaux</b> montent à l'infini (jamais de "fin de jeu") : plus tu progresses, plus le palier suivant demande de points, un peu comme dans un jeu à XP. Ta progression et le nombre de points qui te séparent du niveau suivant sont visibles sur ton Profil et dans le cadran de l'accueil.</p>
        <p>Les <b>badges</b> récompensent des habitudes dans la durée (assiduité, présence sans faute, participation aux quiz, aux idées…). Certains ont plusieurs paliers (I, II, III, IV) qui se débloquent progressivement, plutôt qu'un seul badge figé.</p>
        <p>Le <b>🔥 streak</b> (visible sur ton profil) compte tes jours ouvrés consécutifs avec un check-in confirmé — casse au premier oubli.</p>
        <p>Deux classements existent : <b>général</b> (depuis toujours) et <b>mensuel</b> (remis à zéro chaque mois — une bonne raison de rester actif même après plusieurs mois d'usage).</p>`,
    },
    {
      id: "evenements",
      q: "📅 Événements",
      a: `<p>Inscris-toi en un clic depuis "Événements" ou la carte "Événements à venir" de l'accueil. Si l'événement est complet, tu passes automatiquement en <b>liste d'attente</b> — dès qu'une place se libère (quelqu'un se désinscrit), la première personne en attente est promue automatiquement, sans action de ta part.</p>
        <p>"+ Calendrier" télécharge un fichier <b>.ics</b> à ouvrir dans ton application de calendrier habituelle (Outlook, Google Calendar…) — pas d'intégration automatique dans ta messagerie, mais ça s'ouvre nativement partout.</p>
        <p>Un rappel est envoyé automatiquement (notification in-app) la veille et le jour même d'un événement où tu es inscrit.</p>
        <p><i>Limite connue</i> : la date affichée dépend de ce que l'intranet WordPress expose ; si un événement n'a pas de date précise renseignée côté intranet, l'app se rabat sur sa date de publication.</p>`,
    },
    {
      id: "idees",
      q: "💡 Boîte à idées",
      a: `<p>Propose une idée (titre, description, catégorie libre), avec ou sans ton nom (case "Publier anonymement" — dans ce cas ton nom n'apparaît nulle part, même pas sur ton profil).</p>
        <p>Vote pour les idées que tu soutiens (1 vote max par idée et par personne, la liste est triée par popularité) et commente pour enrichir la discussion.</p>
        <p>Le statut de chaque idée (nouvelle → étudiée → acceptée / refusée / archivée) est mis à jour par l'équipe qui gère la boîte à idées ; une idée archivée disparaît simplement de la liste.</p>`,
    },
    {
      id: "quiz",
      q: "🧠 Quiz",
      a: `<p>Une seule tentative par quiz et par personne — pas de repasse en cas d'erreur, donc prends ton temps avant de valider.</p>
        <p>Deux modes : <b>quiz classique</b> (correction automatique et immédiate, bonnes/mauvaises réponses surlignées, +2 points par bonne réponse) et <b>sondage</b> (pas de bonne réponse : après avoir répondu, tu vois la répartition des votes de tout le monde, en pourcentage).</p>
        <p>Un classement par quiz est consultable une fois que tu as répondu.</p>`,
    },
    {
      id: "medias",
      q: "🎬 Médias",
      a: `<p>Bibliothèque de vidéos et d'albums photos, toujours en <b>liens externes</b> (rien n'est hébergé sur nos serveurs). Les vidéos YouTube se lisent directement dans l'app (lecteur intégré) ; les autres liens (Drive, albums en ligne…) s'ouvrent dans un nouvel onglet.</p>
        <p>Certains médias permettent de laisser un commentaire — l'option est activée au cas par cas par l'admin selon le contenu.</p>`,
    },
    {
      id: "recherche",
      q: "🔍 Recherche & notifications",
      a: `<p>La loupe (en haut de l'écran) cherche <b>partout à la fois</b> : collègues (nom/email), événements et actualités de l'intranet, idées (titre/description), liens utiles (libellé). Les résultats sont groupés par catégorie.</p>
        <p>Clique sur un collègue pour ouvrir son <b>profil public</b> : son statut des prochains jours, ses réservations à venir, ses idées signées (les anonymes restent anonymes) et ses résultats de quiz.</p>
        <p>La cloche affiche tes notifications : rappels d'événements et annonces envoyées par l'équipe. Le badge rouge compte les non-lues (mis à jour automatiquement). Clique une notification pour la marquer lue, "Tout marquer lu" pour vider le badge d'un coup, ✕ pour la supprimer. Pas d'email ni de notification Teams à ce jour — tout se passe dans l'app.</p>`,
    },
    {
      id: "profil",
      q: "👤 Mon profil",
      a: `<p>Ta carte d'identité dans l'app : avatar, département, rôle, points et niveau avec la progression vers le palier suivant, grille de badges obtenus (clique un badge pour voir son détail), série de présence (🔥), classement général et mensuel.</p>
        <p>Tu y retrouves aussi tes propres réservations à venir, tes idées, tes quiz passés — en un seul endroit, sans avoir à naviguer entre plusieurs pages.</p>
        <p><b>Paramètres</b> (en bas du profil) : renseigne ta date d'anniversaire (jour et mois affichés uniquement, jamais l'année) pour apparaître dans la carte "Anniversaires" de l'accueil le jour J. Tu peux aussi t'y déconnecter.</p>`,
    },
  ];

  if (isAdmin) sections.push({
    id: "admin",
    q: "⚙️ Administration (accès restreint)",
    a: `<p>Visible uniquement par une liste restreinte de personnes (indépendamment de ton rôle sur l'intranet WordPress). Aperçu de ce qui est configurable, onglet par onglet :</p>
      <ul>
        <li><b>Accueil</b> : active/désactive/réordonne/met en avant les cartes du tableau de bord, configure le jalon "Building Our Future Home" et les statuts de présence proposés.</li>
        <li><b>Coworking</b> : postes (création, désactivation, caractéristiques, position sur le plan), horizon de réservation, noms affichés des salles/bulles.</li>
        <li><b>Événements</b> : capacité par événement, liste des inscrits/liste d'attente, envoi d'une notification manuelle à tous les inscrits.</li>
        <li><b>Contenu</b> (sous-onglets) : Idées (workflow de statut), Quiz (création/édition, y compris en mode sondage), Médias (ajout/édition), Badges (création de badges personnalisés, attribution/retrait manuel, points par badge).</li>
        <li><b>Collaborateurs</b> : renseigner l'anniversaire de n'importe qui (à défaut d'une source fiable côté intranet).</li>
        <li><b>Statistiques</b> : KPI d'usage (occupation, réservations, quiz, idées…) et alertes automatiques (quiz sans question, idées en attente, événement complet avec liste d'attente…).</li>
      </ul>`,
  });

  sections.push({
    id: "astuces",
    q: "🚀 Pour en tirer le maximum",
    a: `<ul>
        <li>Réserve <b>dès le début de la semaine</b> si tu vises un poste précis (fenêtre, écran…) — les places populaires partent vite selon l'horizon configuré.</li>
        <li>Pense au <b>check-in</b> dès ton arrivée, ça prend 2 secondes et t'évite une perte de points sans même t'en rendre compte.</li>
        <li>Si tu ne viendras plus, <b>annule</b> plutôt que de laisser la réservation devenir un no-show — ça libère la place pour quelqu'un d'autre et t'évite la pénalité.</li>
        <li>Consulte la carte "Présents aujourd'hui" avant de réserver pour repérer qui sera sur site le même jour que toi.</li>
        <li>Une <b>bulle calme</b> vaut mieux qu'un poste classique pour un appel important — pas besoin de bloquer une demi-journée entière pour 30 minutes.</li>
        <li>Le classement se réinitialise chaque mois : même après une pause, tu repars à égalité avec tout le monde.</li>
      </ul>`,
  });

  sections.push({
    id: "faq",
    q: "❓ Questions fréquentes",
    a: `<ul>
          <li><b>Je ne peux pas réserver un jour donné</b> → soit c'est un week-end, soit c'est au-delà de l'horizon autorisé (affiché en haut de la page Réserver), soit tu as déjà une série de jours consécutifs réservés au maximum autorisé.</li>
          <li><b>J'ai perdu des points sans comprendre</b> → tu as probablement une réservation passée jamais confirmée par "Je suis arrivé" (no-show, -10 pts), ou tu as annulé une réservation déjà validée.</li>
          <li><b>"Réserver toute la salle" ne marche pas</b> → il suffit qu'un seul poste actif de la salle soit déjà pris par quelqu'un pour bloquer toute la salle sur ce créneau.</li>
          <li><b>Je ne vois pas l'onglet Administration</b> → il est réservé à une liste restreinte de personnes, indépendamment de ton rôle sur l'intranet.</li>
          <li><b>Je ne reçois pas d'email pour les rappels/notifications</b> → normal, tout est in-app pour l'instant (pas d'email ni de Teams configuré côté app).</li>
          <li><b>La date d'un événement semble fausse</b> → l'app affiche la date exacte quand l'intranet la fournit ; sinon elle se rabat sur la date de publication de l'article, qui peut différer de la date réelle.</li>
        </ul>`,
  });

  document.getElementById("view").innerHTML = `
    <p class="sub" style="color:var(--muted);margin:0 0 14px">Le guide pratique de l'app, section par section. Clique un titre pour déplier, ou passe directement à une section :</p>
    <div class="aide-toc">
      ${sections.map(s => `<a href="#aide" data-aide-jump="${s.id}">${s.q.replace(/^\S+\s/, "")}</a>`).join("")}
    </div>
    <div class="aide-list">
      ${sections.map((s, i) => `
        <details class="card aide-item" id="aide-${s.id}"${i === 0 ? " open" : ""}>
          <summary>${s.q}</summary>
          <div class="aide-body">${s.a}</div>
        </details>`).join("")}
    </div>`;
  document.querySelectorAll("[data-aide-jump]").forEach(a => a.addEventListener("click", (e) => {
    e.preventDefault();
    const target = document.getElementById("aide-" + a.dataset.aideJump);
    target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
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
