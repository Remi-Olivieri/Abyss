/* Le bouton de compte, en haut a droite de toutes les pages d'Abyss.
 *
 * Il a vecu en quatre exemplaires -- Abyss, le profil, les suggestions, le
 * monitoring -- recopies l'un de l'autre puis retouches chacun de leur
 * cote. Ils avaient fini par diverger sur a peu pres tout : le profil
 * montrait une pastille verte de 7 px la ou les autres montraient un
 * visage, les suggestions n'avaient pas de chevron, le pseudo debordait de
 * la barre faute du <span> qui le coupe, et le menu ne proposait ni les
 * memes entrees ni le meme ordre d'une page a l'autre -- « Mon profil »
 * manquait sur le profil, « Monitoring » manquait partout ailleurs que sur
 * Abyss. Quatre copies, c'est quatre dessins qui s'eloignent.
 *
 * Ce fichier est desormais le seul : les quatre pages l'appellent, aucune
 * ne redessine le bouton de son cote. Le style, lui, a toujours ete commun
 * -- voir « Le bouton de compte » dans static/style_abyss.css.
 *
 * Une page l'utilise ainsi :
 *
 *     Compte.dessine(MOI);                       // le cas courant
 *     Compte.dessine(MOI, {                      // les deux reglages
 *       surConnexion: () => ouvreAuth(),         //   visiteur : quoi faire
 *       surSortie: () => poseEtat(...),          //   apres la deconnexion
 *     });
 *
 * Sans `surConnexion`, un visiteur ne voit rien : sur une page qui exige
 * un compte, un bouton « Se connecter » qui ne mene nulle part serait pire
 * que rien. Sans `surSortie`, on retombe sur /abyss -- ce qui est le bon
 * defaut partout sauf sur Abyss meme, qui reste ouverte aux visiteurs et
 * se contente de repasser en mode visiteur sans recharger.
 *
 * Le fichier ne depend de rien : ni du `api()` de la page, ni de son
 * `echappe()`. C'est ce qui permet de le charger tel quel dans une page de
 * plus le jour ou il y en aura une.
 */
(function () {
  "use strict";

  const echappe = (s) => String(s === null || s === undefined ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
                                   '"': "&quot;", "'": "&#39;" }[c]));

  let OPTIONS = {};

  /* ---------- le medaillon ----------
     La photo si elle existe, sinon l'initiale sur un fond dont la teinte
     est tiree du pseudo. Un medaillon dans les deux cas, et de la meme
     taille : une pastille verte de 7 px la ou les autres pages montrent un
     visage, c'est exactement ce qui faisait dire que le bouton n'est
     jamais le meme. La teinte suit la meme regle que les avatars du
     journal, pour qu'une personne garde sa couleur d'un bout a l'autre
     du site. */
  function initiales(nom) {
    return (nom || "?").replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/)
      .filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join("") || "?";
  }

  function teinte(nom) {
    let h = 0;
    for (const c of (nom || "?")) h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
  }

  function medaillon(u) {
    if (u.avatar) {
      return `<img class="avatar-mini" src="${echappe(u.avatar)}" alt="">`;
    }
    return `<span class="avatar-mini avatar-lettre" aria-hidden="true"
                  style="--h:${teinte(u.pseudo)}">${echappe(initiales(u.pseudo))}</span>`;
  }

  /* ---------- le bouton ---------- */
  function dessine(moi, options) {
    OPTIONS = options || {};
    const zone = document.getElementById("compte");
    if (!zone) return;

    if (!moi || !moi.connecte || !moi.utilisateur) {
      if (!OPTIONS.surConnexion) { zone.innerHTML = ""; return; }
      zone.innerHTML = '<button class="bouton" id="btnConn">Se connecter</button>';
      document.getElementById("btnConn")
        .addEventListener("click", () => OPTIONS.surConnexion());
      return;
    }

    const u = moi.utilisateur;
    /* La pastille suit le compte : elle vaut sur toutes les pages, puisque
       c'est le meme bouton partout. Elle est posee deux fois -- sur le
       bouton lui-meme, ou elle se voit sans rien ouvrir, et sur l'entree du
       menu, la ou l'on clique pour aller lire. */
    const neuf = u.admin ? (+u.suggestionsNeuves || 0) : 0;
    zone.innerHTML = `
      <div class="enveloppe-menu">
        <button class="bouton pseudo${neuf ? ' a-neuf' : ''}" id="btnMenu"
                aria-expanded="false" aria-haspopup="true">
          ${medaillon(u)}
          <span class="pseudo-nom">${echappe(u.pseudo)}</span>
          <span class="chevron" aria-hidden="true">&#9662;</span>
          ${pastille(neuf, 'suggestion')}
        </button>
        <div class="menu" id="menuCompte" hidden>
          ${entree("/abyss/profil", "Mon profil")}
          <!-- reservee a l'admin : l'entree n'apparait que pour lui, et
               l'API qu'ouvre la page repond 404 a tous les autres -->
          ${u.admin ? entree("/abyss/suggestions", "Suggestions", neuf) : ""}
          ${u.admin ? entree("/abyss/monitoring", "Monitoring") : ""}
          <hr>
          <button class="entree sortie" id="mnSortie">Se déconnecter</button>
        </div>
      </div>`;
    document.getElementById("btnMenu")
      .addEventListener("click", (e) => { e.stopPropagation(); bascule(); });
    document.getElementById("mnSortie").addEventListener("click", sortir);
  }

  /* Le menu porte les memes entrees partout, y compris celle de la page ou
     l'on se trouve deja : un menu qui perd une ligne selon l'endroit oblige
     a chercher des yeux ce qui a bouge. Elle est seulement marquee -- pale
     et signalee aux lecteurs d'ecran -- plutot que retiree. */
  function entree(adresse, nom, neuf) {
    const ici = location.pathname.replace(/\/+$/, "") === adresse;
    return `<a class="entree" href="${adresse}"${ici ? ' aria-current="page"' : ""}
      >${nom}${pastille(neuf, "suggestion")}</a>`;
  }

  /* Le zero ne s'ecrit pas : une pastille qui annonce « rien » est du bruit.
     Au-dela de 99, « 99+ » -- le chiffre exact n'apprend plus rien et ferait
     grossir la pastille jusqu'a deformer ce qu'elle decore.

     Le texte pour les lecteurs d'ecran est en toutes lettres : « 3 » tout
     seul, annonce apres un pseudo, ne veut rien dire. */
  function pastille(n, quoi) {
    n = +n || 0;
    if (!n) return "";
    return `<span class="neuf"><span aria-hidden="true">${
      n > 99 ? "99+" : n}</span><span class="lecture-seule">${
      n} nouvelle${n > 1 ? "s" : ""} ${echappe(quoi)}${n > 1 ? "s" : ""}</span></span>`;
  }

  /* ---------- ouverture, fermeture ---------- */
  function bascule() {
    const m = document.getElementById("menuCompte");
    if (!m) return;
    m.hidden = !m.hidden;
    document.getElementById("btnMenu")
      .setAttribute("aria-expanded", m.hidden ? "false" : "true");
  }

  function ferme() {
    const m = document.getElementById("menuCompte");
    if (m && !m.hidden) {
      m.hidden = true;
      document.getElementById("btnMenu").setAttribute("aria-expanded", "false");
    }
  }

  /* Une selection de texte commencee dans le menu et relachee dehors ne
     doit pas le fermer : on ne ferme que si le clic ET le mousedown qui l'a
     precede visaient tous les deux en dehors du menu. */
  let SOURIS_DEHORS = false;
  document.addEventListener("mousedown", (e) => {
    SOURIS_DEHORS = !e.target.closest(".enveloppe-menu");
  });
  document.addEventListener("click", (e) => {
    if (SOURIS_DEHORS && !e.target.closest(".enveloppe-menu")) ferme();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const m = document.getElementById("menuCompte");
    if (m && !m.hidden) { ferme(); document.getElementById("btnMenu").focus(); }
  });

  /* ---------- deconnexion ---------- */
  async function sortir() {
    try {
      /* en JSON, comme toutes les ecritures du site : c'est la parade CSRF
         que le serveur exige. */
      await fetch("/api/deconnexion", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
    } catch (e) {
      /* le cookie est peut-etre deja mort : on redescend quand meme en
         visiteur plutot que de rester sur un etat de connexion menteur */
    }
    ferme();
    if (OPTIONS.surSortie) OPTIONS.surSortie();
    else location.href = "/abyss";
  }

  window.Compte = { dessine, ferme, sortir };
})();
