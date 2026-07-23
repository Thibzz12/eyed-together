/* ============================================================
   EyeD Together — application multi-pages (JavaScript natif)
   ============================================================ */

const state = {
  profile: null,
  // vue Réserver
  date: new Date().toISOString().slice(0, 10),
  slot: "AM",
  floor: null,
  availability: [],
  myReservations: [],
  selected: null,
  enabledStatuses: null, // rempli au démarrage depuis /api/statuses (configurable par l'admin)
};

const STATUS = { coworking: "Coworking", teletravail: "Télétravail", deplacement: "Déplacement", conge: "Congé" };
/* Entrées STATUS filtrées selon ce que l'admin a activé (fallback: tout, tant que non chargé). */
function enabledStatusEntries() {
  const keys = state.enabledStatuses || Object.keys(STATUS);
  return Object.entries(STATUS).filter(([k]) => keys.includes(k));
}
const PALETTE = ["#00608D", "#2E9E5B", "#E6A100", "#7A4E86", "#B4761C", "#0891b2", "#D64545"];

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...options });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}
function colorFor(n) { let s = 0; for (const c of n || "?") s += c.charCodeAt(0); return PALETTE[s % PALETTE.length]; }
function initials(n) { return (n || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase(); }
function firstName(n) { return (n || "").split(/\s+/)[0]; }
function slotLabel(s) { return s === "AM" ? "Matin" : s === "PM" ? "Après-midi" : "Journée"; }
function fdate(iso, opt) { return new Date(iso).toLocaleDateString("fr-FR", opt || { weekday: "long", day: "numeric", month: "long" }); }
function levelOf(pts) {
  if (pts >= 300) return "Platine"; if (pts >= 150) return "Or"; if (pts >= 50) return "Argent"; return "Bronze";
}

/* ---------------- Démarrage ---------------- */
async function init() {
  const { ok, data } = await api("/api/profile");
  if (!ok) { document.getElementById("login").classList.remove("hidden"); setupLoginForm(); return; }
  state.profile = data;
  const st = await api("/api/statuses");
  state.enabledStatuses = (st.data && st.data.enabled) || Object.keys(STATUS);
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("userName").textContent = state.profile.name;
  document.getElementById("userLevel").textContent = "Niveau " + levelOf(state.profile.total_points);
  const av = document.getElementById("avatar");
  av.textContent = initials(state.profile.name);
  const avm = document.getElementById("avatarMobile");
  if (avm) avm.textContent = initials(state.profile.name);
  refreshPoints(0);
  if (state.profile.role === "admin") document.querySelector(".nav-admin").classList.remove("hidden");

  document.querySelectorAll(".nav-link, .tab-link").forEach(a =>
    a.addEventListener("click", e => { e.preventDefault(); goTo(a.dataset.route); closeMobileMenu(); }));
  document.getElementById("selDeselect").addEventListener("click", clearSelection);
  document.getElementById("selConfirm").addEventListener("click", confirmSelection);
  document.getElementById("mobileMenuBtn").addEventListener("click", toggleMobileMenu);
  document.addEventListener("click", e => {
    const sb = document.querySelector(".sidebar");
    if (sb.classList.contains("open") && !sb.contains(e.target) && e.target.id !== "mobileMenuBtn" && !document.getElementById("mobileMenuBtn").contains(e.target)) closeMobileMenu();
  });
  window.addEventListener("hashchange", router);
  router();
}

function toggleMobileMenu() { document.querySelector(".sidebar").classList.toggle("open"); }
function closeMobileMenu() { document.querySelector(".sidebar").classList.remove("open"); }

function setupLoginForm() {
  const form = document.getElementById("loginForm");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value;
    const password = document.getElementById("loginPassword").value;
    const err = document.getElementById("loginError");
    const btn = form.querySelector("button");
    err.textContent = ""; btn.disabled = true; btn.textContent = "Connexion…";
    const { ok, data } = await api("/auth/wordpress-login", { method: "POST", body: JSON.stringify({ email, password }) });
    if (ok) { location.reload(); return; }
    err.textContent = data?.detail || "Connexion impossible.";
    btn.disabled = false; btn.textContent = "Se connecter";
  });
}

const ROUTES = {
  accueil: { title: "Accueil", render: viewAccueil },
  reserver: { title: "Réserver une place", render: viewReserver },
  evenements: { title: "Événements", render: viewEvenements },
  presence: { title: "Ma présence", render: viewPresence },
  idees: { title: "Boîte à idées", render: viewIdees },
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
  const today = new Date().toISOString().slice(0, 10);
  view.innerHTML = `
      <div class="hero-banner">
        <div class="hb-greet"><span class="hb-muted">Bonjour,</span> <span class="hb-name">${firstName(state.profile.name)}</span></div>
        <div class="hb-status"><span class="hb-dot"></span>Connecté · SSO EyeD</div>
      </div>
      <div class="dash-grid" id="dashGrid"><div class="empty">Chargement…</div></div>
      <h3 class="section-title">Services rapides</h3>
      <div class="services-grid">
        <a class="service-tile" href="mailto:restauration@eyedpharma.com"><span class="service-ic" style="background:#E0F2FE"><svg viewBox="0 0 24 24" fill="none" stroke="#0284C7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h18M12 11v9M4 11c0-4 4-7 8-7s8 3 8 7"/></svg></span><span>Restauration</span></a>
        <a class="service-tile" href="https://weared.team" target="_blank" rel="noopener"><span class="service-ic" style="background:#F3E8FF"><svg viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg></span><span>Intranet</span></a>
        <a class="service-tile" href="mailto:support-it@eyedpharma.com"><span class="service-ic" style="background:#FFF1F2"><svg viewBox="0 0 24 24" fill="none" stroke="#F43F5E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10"/><path d="M2 17h20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/></svg></span><span>Support IT</span></a>
        <a class="service-tile" href="mailto:rh@eyedpharma.com"><span class="service-ic" style="background:#ECFDF5"><svg viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/></svg></span><span>Ressources humaines</span></a>
      </div>`;
  const d = (await api("/api/dashboard")).data;
  const cards = (d && d.cards) || [];
  document.getElementById("dashGrid").innerHTML =
    cards.map(c => renderCard(c)).join("") || `<div class="empty">Aucune carte activée.</div>`;
  wireDashboard(today);
}

function renderCard(c) {
  const wide = ["events", "news", "project_progress", "team_presence", "mes_evenements"].includes(c.key) ? " wide" : "";
  const hl = c.highlighted ? " highlight" : "";
  const data = c.data;
  let inner = "", extraClass = "";

  if (c.key === "presence") {
    const cur = data && data.status;
    inner = `<div class="card-label">${c.title}</div>
      <div class="status-seg">${enabledStatusEntries().map(([k, l]) =>
        `<button class="status-seg-btn${cur === k ? " on" : ""}" data-status="${k}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STATUS_ICON[k]}</svg>
          <span>${l}</span></button>`).join("")}</div>`;
  } else if (c.key === "next_reservation") {
    extraClass = " reservation-card";
    if (data) {
      inner = `<div class="rc-row">
        <span class="rc-ic"><svg viewBox="0 0 24 24" fill="none" stroke="#0284C7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M5 19v2M19 19v2"/></svg></span>
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
    inner = `<div class="banner-blob"></div>
      <div class="banner-top"><div><div class="banner-eyebrow">Building Our Future Home</div><div class="banner-title">${c.title}</div></div></div>
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
  view.querySelectorAll("[data-status]").forEach(el => el.addEventListener("click", async () => {
    const ok = await setStatus(today, el.dataset.status);
    if (ok) {
      view.querySelectorAll("[data-status]").forEach(b => b.classList.remove("on"));
      el.classList.add("on");
    }
  }));
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
      <button data-tab="espaces">Postes &amp; espaces</button>
      <button data-tab="evenements">Événements</button>
      <button data-tab="idees">Idées</button>
      <button data-tab="liens">Liens utiles</button>
    </div>
    <div id="adminBody"></div>`;
  const RENDERERS = {
    accueil: renderAdminAccueil, espaces: renderAdminEspaces, evenements: renderAdminEvenements,
    idees: renderAdminIdees, liens: renderAdminLiens,
  };
  view.querySelectorAll(".admin-tabs button").forEach(b => b.addEventListener("click", () => {
    view.querySelectorAll(".admin-tabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    RENDERERS[b.dataset.tab]();
  }));
  renderAdminAccueil();
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
        </div>
        <label class="event-admin-cap">Capacité
          <input class="da-pos" type="number" min="0" placeholder="illimité" value="${ev.capacity ?? ""}">
        </label>
      </div>
      <div class="idea-comments hidden" id="evreg-${ev.id}"></div>`;
    row.querySelector("input").addEventListener("change", async (e) => {
      const val = e.target.value === "" ? null : +e.target.value;
      const { ok } = await api(`/api/admin/events/${ev.id}/capacity`, { method: "PUT", body: JSON.stringify({ capacity: val }) });
      toast(ok ? "Capacité enregistrée ✓" : "Erreur", ok ? "success" : "error");
    });
    row.querySelector("[data-toggle-reg]").addEventListener("click", () => toggleEventRegistrations(ev.id));
    list.appendChild(row);
  }
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
  const [dash, st] = await Promise.all([api("/api/admin/dashboard"), api("/api/admin/statuses")]);
  if (!dash.ok) { body.innerHTML = `<div class="empty">Accès refusé.</div>`; return; }
  adminState = {
    cards: dash.data.cards.slice(), progress: dash.data.project_progress,
    statusesAll: (st.data && st.data.all) || [], statusesEnabled: new Set((st.data && st.data.enabled) || []),
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
  const statusRows = adminState.statusesAll.map(key => `
    <label class="admin-toggle"><input type="checkbox" data-statuskey="${key}" ${adminState.statusesEnabled.has(key) ? "checked" : ""}> ${STATUS[key] || key}</label>`).join("");
  body.innerHTML = `
    <p class="sub" style="color:var(--muted);margin:0 0 16px">Configure l'accueil des collaborateurs : active/désactive les cartes, change l'ordre, mets en avant.</p>
    <div class="card"><h3>Cartes de l'accueil</h3><div class="admin-cards">${rows}</div></div>
    <div class="card"><h3>Indicateur de progression du projet</h3>
      <div class="admin-progress">
        <label>Texte affiché<br><input type="text" id="ppLabel" value="${(adminState.progress.label || "").replace(/"/g, "&quot;")}"></label>
        <label>Progression : <b id="ppVal">${adminState.progress.value}</b> %<br>
          <input type="range" id="ppRange" min="0" max="100" value="${adminState.progress.value}"></label>
      </div>
    </div>
    <div class="card"><h3>Statuts de présence proposés</h3>
      <p class="sub" style="color:var(--muted);margin:0 0 10px">Décoche un statut pour le retirer des choix proposés aux employés.</p>
      <div class="admin-progress">${statusRows}</div>
    </div>
    <button class="btn-save" id="adminSave">Enregistrer</button>`;
  body.querySelectorAll("[data-up]").forEach(b => b.addEventListener("click", () => moveCard(+b.dataset.up, -1)));
  body.querySelectorAll("[data-down]").forEach(b => b.addEventListener("click", () => moveCard(+b.dataset.down, 1)));
  body.querySelectorAll("[data-enabled]").forEach(cb => cb.addEventListener("change", () => { adminState.cards[+cb.dataset.enabled].enabled = cb.checked; }));
  body.querySelectorAll("[data-highlight]").forEach(cb => cb.addEventListener("change", () => { adminState.cards[+cb.dataset.highlight].highlighted = cb.checked; }));
  body.querySelectorAll("[data-statuskey]").forEach(cb => cb.addEventListener("change", () => {
    if (cb.checked) adminState.statusesEnabled.add(cb.dataset.statuskey); else adminState.statusesEnabled.delete(cb.dataset.statuskey);
  }));
  const range = document.getElementById("ppRange");
  range.addEventListener("input", () => document.getElementById("ppVal").textContent = range.value);
  document.getElementById("adminSave").addEventListener("click", saveAdmin);
}

function moveCard(i, dir) {
  const j = i + dir; if (j < 0 || j >= adminState.cards.length) return;
  const a = adminState.cards; [a[i], a[j]] = [a[j], a[i]]; renderAdminCards();
}

async function saveAdmin() {
  const order = adminState.cards.map(c => ({ id: c.id, enabled: c.enabled, highlighted: c.highlighted }));
  const r1 = await api("/api/admin/dashboard", { method: "PUT", body: JSON.stringify(order) });
  const r2 = await api("/api/admin/project-progress", { method: "PUT", body: JSON.stringify({ value: +document.getElementById("ppRange").value, label: document.getElementById("ppLabel").value }) });
  const r3 = await api("/api/admin/statuses", { method: "PUT", body: JSON.stringify({ enabled: [...adminState.statusesEnabled] }) });
  if (r1.ok && r2.ok && r3.ok) toast("Accueil mis à jour ✓", "success");
  else toast("Erreur d'enregistrement.", "error");
}

/* ---- Administration : workflow de la boîte à idées ---- */
async function renderAdminIdees() {
  const body = document.getElementById("adminBody");
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

/* ---- Administration : liens utiles ---- */
async function renderAdminLiens() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const { ok, data } = await api("/api/admin/links");
  if (!ok) { body.innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  body.innerHTML = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Gère les liens externes affichés sur l'accueil : mutuelle, RH, intranet (ex. ${window.location.protocol}//weared.team), documents partagés, etc. Icône = un emoji (ex. 🍽️, 🏥, 📄).</p>
    <div class="card">
      <h3>Ajouter un lien</h3>
      <form id="linkAddForm" class="idea-form link-add-form">
        <input id="linkIcon" type="text" placeholder="🔗" maxlength="4">
        <input id="linkLabel" type="text" placeholder="Libellé (ex : Mutuelle)" required maxlength="100">
        <input id="linkUrl" type="text" placeholder="https://… ou mailto:contact@eyedpharma.com" required maxlength="500">
        <button type="submit" class="btn-save">Ajouter</button>
      </form>
    </div>
    <div class="card"><h3>Liens existants</h3><div class="desk-admin-list" id="linksList"></div></div>`;
  document.getElementById("linkAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const icon = document.getElementById("linkIcon").value.trim() || "🔗";
    const label = document.getElementById("linkLabel").value.trim();
    const url = document.getElementById("linkUrl").value.trim();
    if (!label || !url) return;
    const { ok, data } = await api("/api/admin/links", { method: "POST", body: JSON.stringify({ label, url, icon }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast("Lien ajouté ✓", "success");
    renderAdminLiens();
  });
  const list = document.getElementById("linksList");
  for (const l of data) {
    const row = document.createElement("div"); row.className = "desk-admin-row"; row.dataset.id = l.id;
    row.innerHTML = `
      <input class="da-name" style="max-width:50px" value="${l.icon || ""}" data-field="icon" placeholder="🔗">
      <input class="da-name" value="${l.label}" data-field="label" placeholder="Libellé">
      <input class="da-name" value="${l.url}" data-field="url" placeholder="https://…">
      <label class="admin-toggle"><input type="checkbox" data-field="enabled" ${l.enabled ? "checked" : ""}> Actif</label>
      <button class="da-del" title="Supprimer">✕</button>`;
    row.querySelectorAll("[data-field]").forEach(inp => inp.addEventListener("change", () => {
      const val = inp.type === "checkbox" ? inp.checked : inp.value;
      patchLink(l.id, { [inp.dataset.field]: val });
    }));
    row.querySelector(".da-del").addEventListener("click", () => delLink(l.id));
    list.appendChild(row);
  }
  if (!data.length) list.innerHTML = `<div class="empty">Aucun lien pour l'instant — ajoute le premier ci-dessus.</div>`;
}

async function patchLink(id, patch) {
  const { ok } = await api(`/api/admin/links/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  toast(ok ? "Enregistré ✓" : "Erreur", ok ? "success" : "error");
}
async function delLink(id) {
  if (!confirm("Supprimer ce lien ?")) return;
  const { ok } = await api(`/api/admin/links/${id}`, { method: "DELETE" });
  if (ok) { toast("Lien supprimé", "success"); renderAdminLiens(); }
  else toast("Erreur", "error");
}

/* ---- Administration : postes & espaces (capacités) ---- */
async function renderAdminEspaces() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  const { ok, data } = await api("/api/admin/desks");
  if (!ok) { body.innerHTML = `<div class="empty">Erreur de chargement.</div>`; return; }
  const groups = {};
  for (const d of data) (groups[d.zone || "Sans bureau"] ||= []).push(d);
  let html = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Gère les postes et la capacité de chaque bureau. Chaque changement est enregistré immédiatement.</p>`;
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
const MAX_ADVANCE_DAYS = 7; // doit rester synchro avec reservations.py

/* Jours OUVRÉS (lundi-vendredi) dans les MAX_ADVANCE_DAYS prochains jours calendaires. */
function upcomingWeekdays() {
  const days = []; const d = new Date();
  for (let i = 0; i <= MAX_ADVANCE_DAYS; i++) {
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
        const iso = d.toISOString().slice(0, 10);
        return `<button class="day-pill" data-day="${iso}">
          <span class="dp-d">${d.toLocaleDateString("fr-FR", { weekday: "short" })}</span>
          <span class="dp-n">${d.getDate()}</span></button>`;
      }).join("")}
    </div>
    <div class="controls">
      <div class="segmented" id="slotToggle">
        <button data-slot="AM" class="active">Matin</button><button data-slot="PM">Après-midi</button><button data-slot="DAY">Journée</button>
      </div>
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
  document.querySelectorAll("#slotToggle button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("#slotToggle button").forEach(x => x.classList.remove("active"));
    b.classList.add("active"); state.slot = b.dataset.slot; clearSelection(); loadReserve();
  }));
  loadReserve();
}

async function loadReserve() {
  const [avail, mine] = await Promise.all([
    api(`/api/availability?date=${state.date}&slot=${state.slot}`),
    api("/api/reservations/me"),
  ]);
  state.availability = avail.data || [];
  state.myReservations = mine.data || [];
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
    const label = g.zone.startsWith("Bureau") ? g.zone : `Table ${g.key.replace(/^T/, "")}`;
    const half = Math.ceil(g.items.length / 2);
    return { ...g, label, cap: g.items.length, topSeats: g.items.slice(0, half), botSeats: g.items.slice(half) };
  });
}

function renderTables() {
  const box = document.getElementById("tableSections"); if (!box) return;
  const bureaux = groupIntoTables(state.availability.filter(x => x.desk.zone && x.desk.zone.startsWith("Bureau")));
  const openspace = groupIntoTables(state.availability.filter(x => x.desk.zone === "Open Space"));

  function section(title, tables) {
    if (!tables.length) return "";
    const widgets = tables.map(t => `
      <div class="table-widget">
        <div class="ts-row">${t.topSeats.map(seatHtml).join("")}</div>
        <div class="ts-surface">${t.cap} pl.</div>
        <div class="ts-row">${t.botSeats.map(seatHtml).join("")}</div>
        <div class="ts-label">${t.label}</div>
      </div>`).join("");
    return `<div class="section-eyebrow">${title}</div>
      <div class="card table-card"><div class="table-scroll scroll">${widgets}</div></div>`;
  }
  function seatHtml(item) {
    const mineHere = !item.is_available && item.booked_by === state.profile.name;
    const isSel = state.selected && state.selected.deskId === item.desk.id;
    const cls = isSel ? "selected" : item.is_available ? "free" : mineHere ? "mine" : "occupied";
    // Nom visible directement sur le siège (sans avoir à cliquer) : initiales pour les occupés, "moi" pour ma place.
    const label = mineHere ? "moi" : !item.is_available ? initials(item.booked_by) : "";
    return `<button class="tseat ${cls}" data-desk="${item.desk.id}" title="${item.desk.name}${item.is_available ? " — disponible" : mineHere ? " — votre place" : " — occupé par " + item.booked_by}">${label}</button>`;
  }
  box.innerHTML = section("Bureaux fermés", bureaux) + section("Open space · postes individuels", openspace);
  box.querySelectorAll(".tseat").forEach(btn => {
    const id = +btn.dataset.desk;
    const item = state.availability.find(a => a.desk.id === id);
    const mineHere = !item.is_available && item.booked_by === state.profile.name;
    if (item.is_available || mineHere) btn.addEventListener("click", () => selectSeat(item, mineHere));
  });
}

function selectSeat(item, mineHere) {
  let resIds = [];
  if (mineHere) {
    resIds = state.myReservations
      .filter(r => r.desk.id === item.desk.id && r.reservation_date === state.date && (state.slot === "DAY" || r.slot === state.slot))
      .map(r => r.id);
  }
  state.selected = { deskId: item.desk.id, name: item.desk.name, mine: mineHere, resIds };
  renderTables(); renderSelectionBar();
}
function clearSelection() {
  state.selected = null;
  const bar = document.getElementById("selectionBar"); if (bar) bar.classList.add("hidden");
  if (document.getElementById("tableSections")) renderTables();
}
function renderSelectionBar() {
  const bar = document.getElementById("selectionBar"); if (!state.selected) { bar.classList.add("hidden"); return; }
  document.getElementById("selDesk").textContent = "Poste " + state.selected.name;
  document.getElementById("selMeta").textContent = `${fdate(state.date)} · ${slotLabel(state.slot)}`;
  const c = document.getElementById("selConfirm");
  if (state.selected.mine) { c.textContent = "Annuler la réservation"; c.classList.add("danger"); }
  else { c.textContent = "Confirmer la réservation"; c.classList.remove("danger"); }
  bar.classList.remove("hidden");
}
async function confirmSelection() {
  if (!state.selected) return;
  if (state.selected.mine) { for (const id of state.selected.resIds) await cancelRes(id); }
  else await book(state.selected.deskId);
  clearSelection();
}
function renderMyReservations() {
  const box = document.getElementById("myReservations"); if (!box) return;
  if (!state.myReservations.length) { box.innerHTML = `<div class="empty">Aucune réservation à venir.</div>`; return; }
  box.innerHTML = "";
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const r of state.myReservations) {
    const isToday = r.reservation_date === todayIso;
    const el = document.createElement("div"); el.className = "res-item";
    const checkinBtn = isToday
      ? (r.checked_in_at ? `<span class="res-checked">✓ Présent</span>` : `<button class="checkin" data-checkin="${r.id}">Je suis arrivé</button>`)
      : "";
    el.innerHTML = `<div class="info"><b>${r.desk.name}</b><small>${fdate(r.reservation_date, { weekday: "short", day: "numeric", month: "short" })} · ${slotLabel(r.slot)}</small></div>
      <div class="res-item-actions">${checkinBtn}<button class="cancel">Annuler</button></div>`;
    el.querySelector(".cancel").addEventListener("click", () => cancelRes(r.id));
    const cb = el.querySelector("[data-checkin]");
    if (cb) cb.addEventListener("click", async () => {
      const { ok, data } = await api(`/api/reservations/${r.id}/checkin`, { method: "POST" });
      if (!ok) return toast(data?.detail || "Check-in impossible.", "error");
      toast("Présence confirmée ✓", "success"); loadReserve();
    });
    box.appendChild(el);
  }
}
async function book(deskId) {
  const { ok, data } = await api("/api/reservations", { method: "POST", body: JSON.stringify({ desk_id: deskId, reservation_date: state.date, slot: state.slot }) });
  if (!ok) return toast(data?.detail || "Réservation impossible.", "error");
  const pts = state.slot === "DAY" ? 20 : 10;
  refreshPoints(+pts); floatPoint(); toast(`Réservé ! +${pts} points ⭐`, "success"); loadReserve();
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
async function viewPresence() {
  const view = document.getElementById("view");
  view.innerHTML = `<p class="sub" style="color:var(--muted);margin:0 0 16px">Indique où tu seras pour les prochains jours. C'est visible par tes collègues.</p><div class="week" id="week"></div>`;
  // 5 prochains jours ouvrés
  const days = []; const d = new Date();
  while (days.length < 7) { if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d)); d.setDate(d.getDate() + 1); }
  const from = days[0].toISOString().slice(0, 10), to = days[days.length - 1].toISOString().slice(0, 10);
  const rows = (await api(`/api/status/me?from=${from}&to=${to}`)).data || [];
  const byDay = {}; for (const r of rows) byDay[r.day] = r.status;

  const week = document.getElementById("week");
  for (const day of days) {
    const iso = day.toISOString().slice(0, 10);
    const row = document.createElement("div"); row.className = "day-row";
    row.innerHTML = `<div class="day-name">${day.toLocaleDateString("fr-FR", { weekday: "long" })}<small>${day.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</small></div>`;
    const opts = document.createElement("div"); opts.className = "status-opts";
    for (const [key, lbl] of enabledStatusEntries()) {
      const b = document.createElement("button");
      b.className = "status-opt" + (key === "coworking" ? " coworking" : "") + (byDay[iso] === key ? " on" : "");
      b.textContent = lbl;
      b.addEventListener("click", async () => {
        const ok = await setStatus(iso, key);
        if (ok) { opts.querySelectorAll(".status-opt").forEach(x => x.classList.remove("on")); b.classList.add("on"); }
      });
      opts.appendChild(b);
    }
    row.appendChild(opts); week.appendChild(row);
  }
}

async function setStatus(day, status) {
  const { ok, data } = await api("/api/status/me", { method: "PUT", body: JSON.stringify({ day, status }) });
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

init();
