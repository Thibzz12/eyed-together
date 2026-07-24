/* ============================================================
   EyeD Together — application multi-pages (JavaScript natif)
   ============================================================ */

const state = {
  profile: null,
  // vue Réserver
  date: new Date().toISOString().slice(0, 10),
  slot: "DAY",
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
  recherche: { title: "Recherche", render: viewRecherche },
  quiz: { title: "Quiz", render: viewQuiz },
  medias: { title: "Médias", render: viewMedias },
  profil: { title: "Mon profil", render: viewProfil },
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
    const daysLeft = data.days_left;
    const countdown = daysLeft != null
      ? `<div class="banner-countdown"><span class="bc-num">${daysLeft >= 0 ? "J-" + daysLeft : "J+" + (-daysLeft)}</span><span class="bc-label">${daysLeft >= 0 ? "jours restants" : "jours de retard"}</span></div>`
      : "";
    inner = `<div class="banner-top2">
        <div><div class="banner-eyebrow">Building Our Future Home</div><div class="banner-title">${data.milestone_title || c.title}</div></div>
        ${countdown}
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
      <button data-tab="espaces">Coworking</button>
      <button data-tab="evenements">Événements</button>
      <button data-tab="contenu">Contenu</button>
      <button data-tab="stats">Statistiques</button>
    </div>
    <div id="adminBody"></div>`;
  const RENDERERS = {
    accueil: renderAdminAccueil, espaces: renderAdminEspaces, evenements: renderAdminEvenements,
    contenu: renderAdminContenu, stats: renderAdminStats,
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
    statusesAll: (st.data && st.data.all) || [], statusesEnabled: new Set((st.data && st.data.enabled) || []),
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
  const statusRows = adminState.statusesAll.map(key => `
    <label class="admin-toggle"><input type="checkbox" data-statuskey="${key}" ${adminState.statusesEnabled.has(key) ? "checked" : ""}> ${STATUS[key] || key}</label>`).join("");
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
      <p class="sub" style="color:var(--muted);margin:0 0 10px">Décoche un statut pour le retirer des choix proposés aux employés.</p>
      <div class="admin-progress">${statusRows}</div>
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
    if (cb.checked) adminState.statusesEnabled.add(cb.dataset.statuskey); else adminState.statusesEnabled.delete(cb.dataset.statuskey);
  }));
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
  const r3 = await api("/api/admin/statuses", { method: "PUT", body: JSON.stringify({ enabled: [...adminState.statusesEnabled] }) });
  if (r1.ok && r2.ok && r3.ok) toast("Accueil mis à jour ✓", "success");
  else toast("Erreur d'enregistrement.", "error");
}

/* ---- Administration : Contenu (sous-onglets Idées / Quiz / Médias) ---- */
function renderAdminContenu() {
  const body = document.getElementById("adminBody");
  body.innerHTML = `<div class="content-subtabs">
      <button data-sub="idees" class="active">Idées</button>
      <button data-sub="quiz">Quiz</button>
      <button data-sub="medias">Médias</button>
    </div>
    <div id="contenuBody"></div>`;
  const SUB = { idees: renderAdminIdees, quiz: renderAdminQuiz, medias: renderAdminMedias };
  body.querySelectorAll(".content-subtabs button").forEach(b => b.addEventListener("click", () => {
    body.querySelectorAll(".content-subtabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    SUB[b.dataset.sub]("contenuBody");
  }));
  renderAdminIdees("contenuBody");
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
      <h3>Créer un quiz</h3>
      <form id="quizCreateForm" class="idea-form">
        <input id="qzTitle" type="text" placeholder="Titre du quiz" required maxlength="150">
        <textarea id="qzDesc" placeholder="Description (optionnel)" rows="2"></textarea>
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
    const raw = document.getElementById("qzPublishAt").value;
    const publish_at = raw ? new Date(raw).toISOString() : null;
    const { ok, data } = await api("/api/admin/quizzes", { method: "POST", body: JSON.stringify({ title, description, publish_at }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast("Quiz créé ✓", "success");
    renderAdminQuiz(targetId);
  });
  const list = document.getElementById("quizAdminList");
  for (const qz of quizzes) {
    const card = document.createElement("div"); card.className = "card"; card.style.marginBottom = "10px";
    card.innerHTML = `
      <div class="idea-head">
        <div><div class="idea-title">${qz.title} <button class="edit-pencil" data-edit-quiz="${qz.id}" title="Modifier">✎</button></div>
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
    card.querySelector("[data-toggle-questions]").addEventListener("click", () => toggleQuizQuestions(qz.id));
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
    const { ok, data } = await api(`/api/admin/quizzes/${qz.id}`, { method: "PATCH", body: JSON.stringify({ title, description, publish_at }) });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast("Quiz mis à jour ✓", "success");
    renderAdminQuiz(targetId);
  });
}

function toggleQuizQuestions(quizId) {
  const box = document.getElementById(`qzq-${quizId}`);
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  renderQuestionEditor(quizId, box);
}

async function renderQuestionEditor(quizId, box, editingQuestion = null) {
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
    toast("Question supprimée", "success"); renderQuestionEditor(quizId, box);
  }));
  box.querySelectorAll("[data-edit-q]").forEach(b => b.addEventListener("click", () => {
    const q = quiz.questions.find(x => x.id === +b.dataset.editQ);
    renderQuestionEditor(quizId, box, q);
  }));

  const form = document.getElementById(`qForm-${quizId}`);
  const choicesBox = form.querySelector(".q-choices");
  const typeSel = form.querySelector(".q-type");
  const cancelBtn = form.querySelector("[data-cancel-edit]");
  if (cancelBtn) cancelBtn.addEventListener("click", () => renderQuestionEditor(quizId, box));

  function choiceRow(text = "", correct = false) {
    const row = document.createElement("div"); row.className = "quiz-choice-row";
    row.innerHTML = `<input type="radio" name="correct-${quizId}" ${correct ? "checked" : ""}><input type="text" class="c-text" value="${text.replace(/"/g, "&quot;")}" placeholder="Choix"><button type="button" class="choice-del" title="Retirer ce choix">✕</button>`;
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
      is_correct: r.querySelector('input[type="radio"]').checked,
    })).filter(c => c.text);
    if (choices.length < 2 || !choices.some(c => c.is_correct)) {
      return toast("Il faut au moins 2 choix et une bonne réponse cochée.", "error");
    }
    const path = editingQuestion
      ? `/api/admin/quizzes/questions/${editingQuestion.id}`
      : `/api/admin/quizzes/${quizId}/questions`;
    const { ok, data } = await api(path, {
      method: editingQuestion ? "PATCH" : "POST", body: JSON.stringify({ text, type: typeSel.value, choices }),
    });
    if (!ok) return toast(data?.detail || "Erreur", "error");
    toast(editingQuestion ? "Question mise à jour ✓" : "Question ajoutée ✓", "success");
    renderQuestionEditor(quizId, box);
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
const CHART_COLORS = ["#0284C7", "#10B981", "#F59E0B", "#F43F5E", "#7A4E86", "#0891b2"];

function svgBarChart(data, { height = 160 } = {}) {
  const max = Math.max(1, ...data.map(d => d.value));
  const n = data.length;
  const barW = 100 / n;
  const showEvery = n > 10 ? 2 : 1;
  const bars = data.map((d, i) => {
    const h = max ? (d.value / max) * (height - 26) : 0;
    const x = i * barW;
    const label = i % showEvery === 0 ? `<text x="${x + barW / 2}%" y="${height - 4}" font-size="8.5" text-anchor="middle" fill="#94A3B8">${d.label}</text>` : "";
    return `<g><title>${d.label} : ${d.value}</title>
      <rect x="${x + barW * 0.18}%" y="${height - 18 - h}" width="${barW * 0.64}%" height="${Math.max(h, 1)}" rx="3" fill="#0284C7"></rect>
      ${label}</g>`;
  }).join("");
  return `<svg viewBox="0 0 100 ${height}" preserveAspectRatio="none" class="chart-svg" style="height:${height}px">${bars}</svg>`;
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
      <div class="table-widget-wrap">
        <div class="table-widget">
          <div class="ts-row">${t.topSeats.map(seatHtml).join("")}</div>
          <div class="ts-surface">${t.cap} pl.</div>
          <div class="ts-row">${t.botSeats.map(seatHtml).join("")}</div>
        </div>
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

let sheetSlot = "DAY";

function selectSeat(item, mineHere) {
  let resIds = [];
  if (mineHere) {
    resIds = state.myReservations
      .filter(r => r.desk.id === item.desk.id && r.reservation_date === state.date)
      .map(r => r.id);
  }
  state.selected = { deskId: item.desk.id, name: item.desk.name, zone: item.desk.zone, mine: mineHere, resIds };
  renderTables(); openReserveSheet();
}
function clearSelection() {
  state.selected = null;
  closeReserveSheet();
  if (document.getElementById("tableSections")) renderTables();
}
function openReserveSheet() {
  if (!state.selected) return;
  sheetSlot = "DAY";
  document.getElementById("sheetTitle").textContent = "Poste " + state.selected.name;
  document.getElementById("sheetSub").textContent = `${state.selected.zone || "Open space"} · ${fdate(state.date, { weekday: "long", day: "numeric", month: "long" })}`;
  const mine = document.getElementById("sheetMineNotice");
  const durationBox = document.getElementById("sheetDuration");
  const confirmBtn = document.getElementById("sheetConfirmBtn");
  if (state.selected.mine) {
    durationBox.classList.add("hidden"); mine.classList.remove("hidden");
    confirmBtn.textContent = "Annuler la réservation"; confirmBtn.classList.add("danger");
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
  else await book(state.selected.deskId, sheetSlot);
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
async function book(deskId, slot) {
  const { ok, data } = await api("/api/reservations", { method: "POST", body: JSON.stringify({ desk_id: deskId, reservation_date: state.date, slot }) });
  if (!ok) return toast(data?.detail || "Réservation impossible.", "error");
  const pts = slot === "DAY" ? 20 : 10;
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
const STATUS_COLOR = { coworking: "#0284C7", teletravail: "#7A4E86", deplacement: "#B4761C", conge: "#94A3B8" };
let presenceState = { days: [], byDay: {}, selected: null };

async function viewPresence() {
  const view = document.getElementById("view");
  const days = []; const d = new Date();
  while (days.length < 7) { if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d)); d.setDate(d.getDate() + 1); }
  const from = days[0].toISOString().slice(0, 10), to = days[days.length - 1].toISOString().slice(0, 10);
  const rows = (await api(`/api/status/me?from=${from}&to=${to}`)).data || [];
  const byDay = {}; for (const r of rows) byDay[r.day] = r.status;
  presenceState = { days, byDay, selected: days[0].toISOString().slice(0, 10) };

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
    const iso = day.toISOString().slice(0, 10);
    const status = presenceState.byDay[iso];
    const dotColor = status ? STATUS_COLOR[status] : "transparent";
    return `<button class="pd-pill${iso === presenceState.selected ? " active" : ""}" data-day="${iso}">
      <span class="pd-d">${day.toLocaleDateString("fr-FR", { weekday: "short" })}</span>
      <span class="pd-n">${day.getDate()}</span>
      <span class="pd-dot" style="background:${dotColor}"></span></button>`;
  }).join("");
  box.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => {
    presenceState.selected = b.dataset.day;
    renderPresenceDaystrip(); renderPresenceStatusGrid();
  }));
}

function renderPresenceStatusGrid() {
  const iso = presenceState.selected;
  const day = presenceState.days.find(d => d.toISOString().slice(0, 10) === iso);
  document.getElementById("presenceDayTitle").textContent = day.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const grid = document.getElementById("presenceStatusGrid");
  const current = presenceState.byDay[iso];
  grid.innerHTML = enabledStatusEntries().map(([key, lbl]) => `
    <button class="presence-status-tile${current === key ? " on" : ""}" data-status="${key}" style="--tile-color:${STATUS_COLOR[key]}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STATUS_ICON[key]}</svg>
      <span>${lbl}</span>
    </button>`).join("");
  grid.querySelectorAll("[data-status]").forEach(b => b.addEventListener("click", async () => {
    const ok = await setStatus(iso, b.dataset.status);
    if (ok) { presenceState.byDay[iso] = b.dataset.status; renderPresenceStatusGrid(); renderPresenceDaystrip(); renderPresenceWeekList(); }
  }));
}

function renderPresenceWeekList() {
  const box = document.getElementById("presenceWeekList");
  box.innerHTML = presenceState.days.map(day => {
    const iso = day.toISOString().slice(0, 10);
    const status = presenceState.byDay[iso];
    return `<div class="event-item"><span class="event-date">${day.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}</span>
      <span class="event-title">${status ? `<span class="ev-status-badge" style="background:${STATUS_COLOR[status]}22;color:${STATUS_COLOR[status]}">${STATUS[status] || status}</span>` : `<span class="muted">Non déclaré</span>`}</span></div>`;
  }).join("");
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
    card.innerHTML = `<div class="idea-head">
        <div><div class="idea-title">${qz.title}</div>
          <div class="idea-meta">${qz.question_count} question(s)</div></div>
        ${qz.completed ? `<span class="ev-status-badge">Score : ${qz.my_score}/${qz.my_total}</span>` : `<span class="event-reg-btn">Répondre</span>`}
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
        if (data.completed) {
          const cls = c.is_correct ? "correct" : (c.chosen ? "wrong" : "");
          return `<label class="quiz-choice ${cls}"><input type="radio" disabled ${c.chosen ? "checked" : ""}> ${c.text}${c.is_correct ? " ✓" : (c.chosen ? " ✕" : "")}</label>`;
        }
        return `<label class="quiz-choice"><input type="radio" name="q${q.id}" value="${c.id}"> ${c.text}</label>`;
      }).join("")}</div>
    </div>`).join("");

  view.innerHTML = `
    <button class="btn-back" id="backBtn">← Retour aux quiz</button>
    <h2 class="ed-title">${data.title}</h2>
    ${data.description ? `<p class="idea-desc">${data.description}</p>` : ""}
    ${data.completed ? `<div class="ev-status-badge" style="display:inline-block;margin-bottom:14px">Ton score : ${data.score}/${data.total}</div>` : ""}
    <form id="quizForm">${qHtml}
      ${data.completed ? "" : `<button type="submit" class="btn-save">Valider mes réponses</button>`}
    </form>
    <button class="link-more" id="showLeaderboard" style="margin-top:14px">🏆 Voir le classement</button>
    <div id="quizLeaderboard" class="idea-comments hidden"></div>`;

  document.getElementById("backBtn").addEventListener("click", () => goTo("quiz"));
  document.getElementById("showLeaderboard").addEventListener("click", () => toggleQuizLeaderboard(quizId));

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
      toast(`Score : ${res.score}/${res.total} ✓`, "success");
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
      <span class="event-title">${STATUS[s.status] || s.status}</span></div>`).join("") || `<div class="empty">Aucun statut déclaré.</div>`;
  const resRows = data.upcoming_reservations.map(r => `
    <div class="event-item"><span class="event-date">${fdate(r.date, { day: "numeric", month: "short" })}</span>
      <span class="event-title">Poste ${r.desk} · ${slotLabel(r.slot)}</span></div>`).join("") || `<div class="empty">Aucune réservation à venir.</div>`;
  const ideaRows = data.signed_ideas.map(i => `
    <div class="event-item"><span class="event-title">${i.title} <span class="muted">· ${IDEA_STATUS_LABEL[i.status] || i.status}</span></span></div>`).join("") || `<div class="empty">Aucune idée signée.</div>`;
  const quizRows = data.quiz_results.map(q => `
    <div class="event-item"><span class="event-title">${q.quiz_title}</span><span class="ev-status-badge">${q.score}/${q.total}</span></div>`).join("") || `<div class="empty">Aucun quiz passé.</div>`;

  const badgesHtml = data.badges.map(b => `
    <div class="badge-tile${b.earned ? " earned" : ""}" title="${(b.description || "").replace(/"/g, "&quot;")}">
      <div class="badge-icon">${b.icon || "🏅"}</div><div class="badge-name">${b.name}</div>
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
      <a class="btn" style="background:#FEE2E2;color:var(--red);text-align:center;margin-top:12px" href="/auth/logout">Se déconnecter</a>
    </div>` : ""}`;

  if (!isOwn) document.getElementById("backBtn").addEventListener("click", () => goTo(backRoute));
  if (isOwn) {
    loadLeaderboard(data.id, "all");
    document.querySelectorAll("#lbPeriodToggle button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll("#lbPeriodToggle button").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); loadLeaderboard(data.id, b.dataset.period);
    }));
  }
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
