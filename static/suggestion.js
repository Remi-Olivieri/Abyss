/* Le formulaire de suggestion, sur la page d'où l'on vient.
 *
 * Il ne vivait que sur Abyss : ailleurs, le bouton « Suggestion / Bug »
 * etait un lien vers /abyss?suggestion=<projet>. Signaler un bug de
 * l'Archive faisait donc quitter l'Archive -- avec ce qu'on y regardait, la
 * recherche en cours et la position dans le mur -- pour se retrouver sur le
 * hub, avec le retour a faire a la main une fois le message envoye. Une
 * idee se note en trois lignes, ca ne vaut pas un changement de page.
 *
 * D'ou ce fichier, sur le modele de compte.js : une seule mise en oeuvre,
 * chargee telle quelle par les pages qui portent le bouton. Le balisage est
 * le meme partout (classes `sg-`), l'habillage appartient a chaque feuille
 * de style -- l'Archive le dessine comme ses fiches, Abyss comme ses
 * modales. C'est la meme fenetre, pas le meme dessin, et c'est voulu : une
 * fenetre qui arriverait avec les couleurs d'une autre page se lirait comme
 * un bout de site etranger pose par-dessus celui qu'on regarde.
 *
 * Une page l'utilise ainsi :
 *
 *     Suggestion.branche({
 *       bouton: "suggBtn",                    // l'element ou son id
 *       projet: "jeux-videos",                // preselectionne dans la liste
 *       estConnecte: () => MOI.connecte,      // ce que la page sait deja
 *       surVisiteur: () => ouvreAuth(),       // visiteur : /abyss?connexion=1
 *       toast: (txt, mauvais) => toast(txt, mauvais),
 *       surBascule: () => verrouFond(),       // apres ouverture / fermeture
 *     });
 *
 * Tout est facultatif sauf `projet`. Sans `estConnecte`, l'etat est demande
 * au serveur avant d'ouvrir quoi que ce soit ; sans `surVisiteur`, un
 * visiteur part vers la connexion d'Abyss ; sans `toast`, la confirmation
 * s'affiche dans la fenetre elle-meme -- puis la fenetre se referme seule.
 */
(function () {
  "use strict";

  const MAXI = 1000;

  /* Les projets, dans l'ordre de changements.txt (voir SECTIONS dans
     suggestions.py). `reserve` reprend RESERVEES du meme fichier : un projet
     pas encore ouvert n'a pas a se faire nommer ici alors que sa tuile ne
     s'affiche pas. Aucun ne l'est aujourd'hui -- le quiz l'a ete tant que
     ses jeux n'etaient pas finis, et le laisser reserve interdisait de
     signaler un bug sur la seule page ou l'on pouvait en voir.

     Le serveur refuse de son cote : les deux listes doivent dire la meme
     chose, sinon la fenetre propose un choix qu'il rejette. */
  const PROJETS = [
    { cle: "abyss", nom: "Abyss" },
    { cle: "jeux-videos", nom: "Archive Jeux Vidéos" },
    { cle: "collection", nom: "Collection Yu-Gi-Oh!" },
    { cle: "quiz", nom: "Mini-Jeux / Quiz" },
  ];

  const echappe = (s) => String(s === null || s === undefined ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
                                   '"': "&quot;", "'": "&#39;" }[c]));

  let OPT = {};
  let FOND = null;          // la fenetre, construite une fois pour toutes
  let RENDRE_FOCUS = null;  // a qui rendre le focus en refermant
  let COMPTE = null;        // { connecte, admin }, une fois /api/moi revenu
  let SUR_FOND = false;     // le mousedown qui precede le clic visait le fond
  let MINUTEUR_OK = null;   // la fermeture differee apres un envoi reussi

  /* ---------- ce que le serveur sait de nous ----------
     Demande a l'ouverture et garde ensuite : il n'y a qu'une chose a en
     tirer une fois la fenetre ouverte -- les projets reserves -- et elle ne
     change pas d'une minute a l'autre. Un echec ne fait rien echouer : on
     garde ce qu'on avait, quitte a ne pas proposer un projet reserve. */
  async function etatCompte() {
    try {
      const r = await fetch("/api/moi", { credentials: "same-origin" });
      const d = await r.json();
      COMPTE = { connecte: !!d.connecte,
                 admin: !!(d.utilisateur && d.utilisateur.admin) };
    } catch (e) { /* hors ligne : COMPTE reste ce qu'il etait */ }
    return COMPTE || { connecte: false, admin: false };
  }

  /* ---------- la fenetre ---------- */
  function construis() {
    if (FOND) return FOND;
    FOND = document.createElement("div");
    FOND.className = "sg-fond";
    FOND.id = "sgFond";
    FOND.hidden = true;
    FOND.innerHTML = `
      <div class="sg-boite" role="dialog" aria-modal="true" aria-labelledby="sgTitre">
        <div class="sg-tete">
          <h2 class="sg-titre" id="sgTitre">Une idée, un bug ?</h2>
          <button type="button" class="sg-x" id="sgX" aria-label="Fermer">&times;</button>
        </div>
        <form class="sg-form" id="sgForm">
          <div class="sg-genres" role="radiogroup" aria-label="Nature du message">
            <label class="sg-genre">
              <input type="radio" name="sgGenre" value="suggestion" checked>
              <span>Suggestion</span>
            </label>
            <label class="sg-genre">
              <input type="radio" name="sgGenre" value="bug">
              <span>Bug</span>
            </label>
          </div>
          <label class="sg-champ">
            <span>Le projet concerné</span>
            <select class="sg-select" id="sgProjet">${
              PROJETS.map((p) => `<option value="${echappe(p.cle)}"${
                p.reserve ? " data-reserve hidden" : ""}>${echappe(p.nom)}</option>`).join("")
            }</select>
          </label>
          <label class="sg-champ">
            <span>Ton message <span class="sg-oblig" aria-hidden="true">*</span></span>
            <textarea class="sg-zone" id="sgMessage" rows="4"
                      maxlength="${MAXI}" required aria-required="true"></textarea>
          </label>
          <p class="sg-compteur" id="sgCompteur"></p>
          <p class="sg-err" id="sgErr" hidden></p>
          <p class="sg-ok" id="sgOk" hidden></p>
          <button class="sg-go" type="submit" id="sgGo">Envoyer</button>
        </form>
      </div>`;
    document.body.appendChild(FOND);

    const el = (id) => document.getElementById(id);
    el("sgX").addEventListener("click", ferme);
    el("sgMessage").addEventListener("input", majCompteur);
    el("sgForm").addEventListener("submit", envoie);

    /* Clic sur le fond, et pas sur la boite. Une selection de texte
       commencee dans la boite et relachee sur le fond ne doit pas fermer la
       fenetre : on ne ferme que si le clic ET le mousedown qui l'a precede
       visaient tous les deux le fond lui-meme. C'est la meme parade que
       fermeSurFond() dans l'Archive et que le voile d'Abyss. */
    FOND.addEventListener("mousedown", (e) => { SUR_FOND = e.target === FOND; });
    FOND.addEventListener("click", (e) => {
      if (SUR_FOND && e.target === FOND) ferme();
      SUR_FOND = false;
    });

    /* Et le meme geste au doigt : sur un telephone la fenetre monte du bas
       et se repousse par sa poignee. Sous condition, parce que ce script
       vit sur des pages qui ne chargent pas static/gestes.js -- la fenetre
       s'y ferme par sa croix, comme avant. */
    if (typeof poigneeFeuille === "function") poigneeFeuille(FOND, ferme);

    /* En capture, et non en bulle : les pages qui accueillent cette fenetre
       ont deja leur propre gestionnaire d'Echap sur `document` -- l'Archive
       y ferme sa fiche, Abyss ses modales. Sans la capture, Echap fermerait
       cette fenetre-ci ET la fiche restee dessous. stopPropagation depuis
       la capture sur `document` empeche les gestionnaires en bulle du meme
       noeud de se declencher, ce qui est exactement ce qu'on veut. */
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || FOND.hidden) return;
      e.stopPropagation();
      ferme();
    }, true);

    return FOND;
  }

  function majCompteur() {
    const reste = MAXI - document.getElementById("sgMessage").value.length;
    document.getElementById("sgCompteur").textContent =
      `${reste} caractère${reste > 1 ? "s" : ""} restant${reste > 1 ? "s" : ""}.`;
  }

  /* Les projets reserves n'apparaissent que pour l'administration. Se
     deconnecter pendant que la fenetre est ouverte laisserait sinon un choix
     selectionne que le serveur refusera -- on revient donc au premier. */
  function majProjets() {
    const liste = document.getElementById("sgProjet");
    if (!liste) return;
    const admin = !!(COMPTE && COMPTE.admin);
    liste.querySelectorAll("option[data-reserve]").forEach((o) => { o.hidden = !admin; });
    const choisie = liste.selectedOptions[0];
    if (choisie && choisie.hidden) liste.selectedIndex = 0;
  }

  /* Personne n'est connecte. Ce qui suit appartient a la page : Abyss ouvre
     sa fenetre de connexion et peut annoncer pourquoi, les autres partent
     vers celle d'Abyss -- et un toast juste avant de changer de page ne
     serait jamais lu. D'ou le renvoi sec plutot qu'un message d'ici. */
  function visiteur() {
    if (OPT.surVisiteur) OPT.surVisiteur();
    else location.href = "/abyss?connexion=1";
  }

  /* Preselectionne le projet voulu, s'il est proposable. Un projet reserve
     ne l'est pas plus par la page que par la liste : sans ce test, la
     fenetre s'ouvrirait sur un choix que le serveur refuse, et l'aurait
     nomme au passage. Renvoie false quand le choix n'a pas pu etre pose --
     ce qui arrive tant que /api/moi n'a pas dit qu'on est administrateur,
     d'ou la seconde tentative dans ouvre(). */
  function choisitProjet(voulu) {
    const liste = document.getElementById("sgProjet");
    if (!liste || !voulu) return false;
    const cle = window.CSS && CSS.escape ? CSS.escape(voulu) : voulu;
    if (!liste.querySelector(`option[value="${cle}"]:not([hidden])`)) return false;
    liste.value = voulu;
    return true;
  }

  function montre(projet) {
    construis();
    const el = (id) => document.getElementById(id);
    RENDRE_FOCUS = document.activeElement;
    el("sgErr").hidden = true;
    el("sgOk").hidden = true;
    majProjets();
    const pose = choisitProjet(projet);
    majCompteur();
    FOND.hidden = false;
    if (OPT.surBascule) OPT.surBascule();
    el("sgMessage").focus();
    return pose;
  }

  function ouvre(projet) {
    /* Le formulaire demande d'etre connecte : une suggestion anonyme ne peut
       pas s'ecrire « Pseudo - Message », et surtout on ne saurait a qui
       revenir pour en discuter. Non connecte, on renvoie donc a la
       connexion -- pas un refus, juste l'etape d'avant. */
    const voulu = projet || OPT.projet;
    if (OPT.estConnecte) {
      if (!OPT.estConnecte()) return visiteur();
      const pose = montre(voulu);
      /* Les projets reserves arrivent avec /api/moi, donc apres l'ouverture :
         on repasse alors les proposer, et on repose le choix voulu s'il
         n'avait pas pu l'etre -- sans quoi arriver sur ?suggestion=quiz en
         administrateur ouvrait le formulaire sur « Abyss ». */
      etatCompte().then(() => { majProjets(); if (!pose) choisitProjet(voulu); });
      return;
    }
    // la page ne sait rien de la session : on demande avant d'ouvrir
    etatCompte().then((e) => { if (e.connecte) montre(voulu); else visiteur(); });
  }

  function ferme() {
    if (!FOND || FOND.hidden) return;
    clearTimeout(MINUTEUR_OK);
    MINUTEUR_OK = null;
    FOND.hidden = true;
    if (OPT.surBascule) OPT.surBascule();
    if (RENDRE_FOCUS && document.contains(RENDRE_FOCUS)) RENDRE_FOCUS.focus();
    RENDRE_FOCUS = null;
  }

  async function envoie(e) {
    e.preventDefault();
    const el = (id) => document.getElementById(id);
    const bouton = el("sgGo");
    const genre = FOND.querySelector('input[name="sgGenre"]:checked').value;
    el("sgErr").hidden = true;
    bouton.disabled = true;
    try {
      /* application/json declenche un pre-vol CORS : un formulaire poste
         depuis un autre site ne peut donc pas atteindre cette route. C'est
         la protection CSRF, et le serveur refuse tout autre type. */
      const r = await fetch("/api/suggestion", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projet: el("sgProjet").value,
          genre: genre,
          message: el("sgMessage").value,
        }),
      });
      let d = null;
      try { d = await r.json(); } catch (err) { /* reponse illisible */ }
      if (!r.ok || !d || d.ok === false) {
        throw new Error((d && d.message) || `Erreur ${r.status}.`);
      }
      el("sgMessage").value = "";
      majCompteur();
      const merci = genre === "bug" ? "Bug signalé, merci." : "Suggestion envoyée, merci.";
      if (OPT.toast) { ferme(); OPT.toast(merci); }
      else {
        /* Pas de toast sur cette page : le merci s'affiche dans la fenetre,
           qui se referme ensuite d'elle-meme. Elle restait ouverte -- vide,
           sur un message envoye -- et il fallait la fermer a la main apres
           chaque envoi, alors qu'un accuse de reception n'attend pas de
           reponse. La seconde et demie laisse le temps de le lire ; un clic
           sur la croix, le fond ou Echap coupe court, ferme() annulant le
           minuteur. */
        el("sgOk").textContent = merci;
        el("sgOk").hidden = false;
        clearTimeout(MINUTEUR_OK);
        MINUTEUR_OK = setTimeout(ferme, 1500);
      }
    } catch (err) {
      el("sgErr").textContent = err.message;
      el("sgErr").hidden = false;
    } finally {
      bouton.disabled = false;
    }
  }

  function branche(options) {
    OPT = options || {};
    construis();
    const b = typeof OPT.bouton === "string"
      ? document.getElementById(OPT.bouton) : OPT.bouton;
    if (!b) return;
    /* Le lien vers /abyss?suggestion=... reste dans le HTML et reste vrai :
       c'est ce qui se passe si ce fichier n'arrive pas. preventDefault le
       remplace quand il est la. */
    b.addEventListener("click", (e) => { e.preventDefault(); ouvre(); });
  }

  window.Suggestion = { branche: branche, ouvre: ouvre, ferme: ferme,
                        ouverte: () => !!FOND && !FOND.hidden };
})();
