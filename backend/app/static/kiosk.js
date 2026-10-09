/* Tablette de pointage à l'entrée. Chacun tape son nom, touche sa carte et
   confirme : « Je suis arrivé » le matin, « Je pars » le soir. Une seule
   table de présence derrière, la même que le pop-up et le bandeau de l'app :
   la liste d'évacuation reste unique.

   Écrit en JavaScript classique (pas de syntaxe récente) : la tablette
   annoncée est ancienne, son navigateur aussi peut-être. */

var TOKEN = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
var API = "/api/kiosk/" + encodeURIComponent(TOKEN);
var INTERVALLE_MS = 10 * 1000;
var INACTIVITE_MS = 30 * 1000;

var personnes = [];
var selection = null;
var chronoInactivite = null;

// escapeHtml, initials et sansAccents viennent de shared.js.

function message(texte) {
  var box = document.getElementById("kMessage");
  box.textContent = texte || "";
  box.classList.toggle("hidden", !texte);
}

function carte(p) {
  var etat = p.state === "present" ? "Présent" : p.state === "left" ? "Reparti" : "";
  return '<button class="k-person k-' + p.state + '" data-id="' + p.id + '">' +
    '<span class="k-avatar">' + escapeHtml(initials(p.name)) + '</span>' +
    '<span class="k-name">' + escapeHtml(p.name) + '</span>' +
    (etat ? '<span class="k-badge">' + etat + '</span>' : "") +
    '</button>';
}

function rendre() {
  var filtre = sansAccents(document.getElementById("kSearch").value.trim());
  var visibles = personnes.filter(function (p) { return !filtre || sansAccents(p.name).indexOf(filtre) !== -1; });
  // Sans recherche : les personnes attendues (réservation du jour) et pas encore
  // arrivées en tête, c'est à elles que la tablette s'adresse le matin.
  var attendus = filtre ? [] : visibles.filter(function (p) { return p.expected && p.state !== "present"; });
  var tous = filtre ? visibles : visibles.filter(function (p) { return !(p.expected && p.state !== "present"); });

  var secA = document.getElementById("kExpectedSection");
  secA.classList.toggle("hidden", !attendus.length);
  document.getElementById("kExpected").innerHTML = attendus.map(carte).join("");

  var secT = document.getElementById("kAllSection");
  secT.classList.toggle("hidden", !tous.length);
  document.getElementById("kAllTitle").textContent = filtre ? "Résultats" : (attendus.length ? "Tout le monde" : "Qui es-tu ?");
  document.getElementById("kAll").innerHTML = tous.map(carte).join("");

  message(!visibles.length ? "Personne ne correspond à « " + document.getElementById("kSearch").value.trim() + " »." : "");

  var boutons = document.querySelectorAll(".k-person");
  for (var i = 0; i < boutons.length; i++) {
    boutons[i].addEventListener("click", function () { ouvrirConfirmation(+this.getAttribute("data-id")); });
  }
}

function ouvrirConfirmation(id) {
  selection = personnes.filter(function (p) { return p.id === id; })[0];
  if (!selection) return;
  document.getElementById("kConfirmName").textContent = selection.name;
  var present = selection.state === "present";
  document.getElementById("kConfirmState").textContent = present
    ? "Tu es marqué présent." : selection.state === "left" ? "Ton départ est déjà enregistré." : "Arrivée pas encore confirmée.";
  var action = document.getElementById("kConfirmAction");
  var avec = document.getElementById("kConfirmWithVisitors");
  // Même question qu'au départ depuis l'app : des visiteurs encore présents
  // ne doivent pas rester sur la liste d'évacuation parce que leur hôte est parti.
  var visiteurs = present ? (selection.visitors_present || 0) : 0;
  if (visiteurs) {
    action.textContent = "Je pars, " + (visiteurs > 1 ? "mes visiteurs restent" : "mon visiteur reste");
    avec.textContent = "Nous partons tous (" + (visiteurs + 1) + ")";
    avec.classList.remove("hidden");
  } else {
    action.textContent = present ? "Je pars" : selection.state === "left" ? "Je suis de retour" : "Je suis arrivé";
    avec.classList.add("hidden");
  }
  action.className = "k-btn " + (present ? "k-btn-leave" : "k-btn-primary");
  document.getElementById("kConfirm").classList.remove("hidden");
  relancerInactivite();
}

function fermerConfirmation() {
  selection = null;
  document.getElementById("kConfirm").classList.add("hidden");
}

function merci(texte) {
  var box = document.getElementById("kThanks");
  box.textContent = texte;
  box.classList.remove("hidden");
  setTimeout(function () { box.classList.add("hidden"); }, 2500);
}

function requete(chemin, corps) {
  return fetch(API + chemin, {
    method: corps ? "POST" : "GET",
    headers: corps ? { "Content-Type": "application/json" } : {},
    body: corps ? JSON.stringify(corps) : undefined,
    cache: "no-store",
  });
}

function confirmer(avecVisiteurs) {
  if (!selection) return;
  var present = selection.state === "present";
  var nom = selection.name.split(" ")[0];
  var action = document.getElementById("kConfirmAction");
  action.disabled = true;
  var corps = { user_id: selection.id };
  if (present) corps.with_visitors = avecVisiteurs === true;
  requete(present ? "/checkout" : "/checkin", corps).then(function (res) {
    return res.json().then(function (data) { return { ok: res.ok, data: data }; });
  }).then(function (r) {
    action.disabled = false;
    if (!r.ok) { message((r.data && r.data.detail) || "Impossible d'enregistrer, réessaie."); fermerConfirmation(); return; }
    fermerConfirmation();
    document.getElementById("kSearch").value = "";
    merci(present ? "Bonne soirée " + nom + " !" : "Bienvenue " + nom + " !");
    rafraichir();
  }).catch(function () {
    action.disabled = false;
    message("Serveur injoignable, réessaie dans un instant.");
    fermerConfirmation();
  });
}

function rafraichir() {
  requete("/today").then(function (res) {
    if (res.status === 404) {
      personnes = [];
      rendre();
      fermerConfirmation();
      message("Ce lien de tablette n'est plus valable. Demande un nouveau lien à l'administration.");
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json().then(function (data) {
      personnes = data.people || [];
      var d = new Date(data.date + "T12:00:00");
      var jour = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      document.getElementById("kDate").textContent = jour.charAt(0).toUpperCase() + jour.slice(1);
      document.getElementById("kCount").textContent = data.present_count + " présent" + (data.present_count > 1 ? "s" : "");
      document.getElementById("kUpdated").textContent = "Actualisé à " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      rendre();
    });
  }).catch(function () {
    if (!personnes.length) message("Connexion au serveur en cours…");
  });
}

function horloge() {
  document.getElementById("kClock").textContent = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// Après trente secondes sans toucher la tablette, on efface la recherche et on
// referme une confirmation laissée ouverte : la personne suivante repart de zéro.
function relancerInactivite() {
  clearTimeout(chronoInactivite);
  chronoInactivite = setTimeout(function () {
    document.getElementById("kSearch").value = "";
    fermerConfirmation();
    rendre();
  }, INACTIVITE_MS);
}

document.getElementById("kSearch").addEventListener("input", function () { rendre(); relancerInactivite(); });
document.getElementById("kConfirmAction").addEventListener("click", function () { confirmer(false); });
document.getElementById("kConfirmWithVisitors").addEventListener("click", function () { confirmer(true); });
document.getElementById("kConfirmCancel").addEventListener("click", fermerConfirmation);
document.getElementById("kConfirm").addEventListener("click", function (e) { if (e.target.id === "kConfirm") fermerConfirmation(); });
document.addEventListener("touchstart", relancerInactivite, { passive: true });

horloge();
setInterval(horloge, 1000);
rafraichir();
setInterval(rafraichir, INTERVALLE_MS);
document.addEventListener("visibilitychange", function () { if (!document.hidden) rafraichir(); });
