/* =======================================================================
   Abyss - presence.js

   Le battement de présence : dit au serveur « je suis encore là, sur cette
   page », pour la page Monitoring (voir monitoring.py, note_battement).

   Sans lui, la présence ne bougeait qu'au chargement d'une page - et le
   journal, le classeur ou le Social se lisent des heures sans en recharger
   aucune. Quelqu'un qui lisait un journal depuis six minutes avait déjà
   disparu de la liste.

   Trois règles :
   - un battement par minute, et seulement onglet visible. Un onglet oublié
     en arrière-plan n'est pas quelqu'un qui regarde : il s'efface tout seul
     au bout de cinq minutes, comme il se doit ;
   - l'adresse suit la page. Le journal et le classeur changent d'adresse
     sans recharger (voir majAdresse) : un battement part dans la seconde
     qui suit, au lieu d'attendre la minute ;
   - en partant, un dernier battement « parti ». keepalive : une requête
     ordinaire serait coupée avec la page qui se ferme.

   Rien ici ne doit jamais gêner la page : tout échec passe en silence, et
   le battement suivant rattrape celui qui s'est perdu.
   ======================================================================= */
(function () {
  const CADENCE = 60000;
  let minuteur = null, attente = null, derniere = location.pathname;

  function signale(parti) {
    try {
      fetch("/api/presence", {
        method: "POST",
        credentials: "same-origin",
        keepalive: !!parti,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adresse: location.pathname, parti: !!parti }),
      }).catch(() => {});
    } catch (e) { /* un navigateur sans fetch : tant pis pour la présence */ }
  }

  function demarre() {
    arrete();
    minuteur = setInterval(() => signale(false), CADENCE);
  }
  function arrete() {
    if (minuteur) { clearInterval(minuteur); minuteur = null; }
  }

  /* L'adresse a changé sans rechargement : le battement part une seconde
     plus tard, le temps que la page ait fini de s'y installer - et une
     seule fois si elle change trois fois de suite. */
  function adresseChangee() {
    if (location.pathname === derniere) return;
    derniere = location.pathname;
    clearTimeout(attente);
    attente = setTimeout(() => signale(false), 1000);
  }
  ["replaceState", "pushState"].forEach((nom) => {
    const origine = history[nom];
    if (typeof origine !== "function") return;
    history[nom] = function () {
      const r = origine.apply(this, arguments);
      try { adresseChangee(); } catch (e) {}
      return r;
    };
  });
  addEventListener("popstate", adresseChangee);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { signale(false); demarre(); }
    else arrete();
  });
  addEventListener("pagehide", () => signale(true));
  // revenue du cache de l'historique (bouton Retour) : la page n'a pas été
  // rechargée, le serveur ne sait donc pas qu'on y est de nouveau
  addEventListener("pageshow", (e) => { if (e.persisted) signale(false); });

  /* Un premier battement peu après le chargement. Le chargement lui-même a
     déjà été noté, mais pas l'adresse que la page a pu se donner ensuite,
     ni un départ de la page précédente arrivé après lui. */
  setTimeout(() => signale(false), 3000);
  if (document.visibilityState === "visible") demarre();
})();
