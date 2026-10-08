/* =======================================================================
   Nihongo - lecture.js

   La lecture : des textes du N5 au N1, écrits pour ce site
   (matiere/lecture-n5.txt à -n1.txt, voir « La lecture » dans nihongo.py)
   et déjà découpés en mots à la fabrication. Rien ici ne touche à la
   page : les données, et ce qu'on en tire.

   Les données arrivent de static/nihongo/lecture.json, une fois, au
   démarrage :
     textes      dans l'ordre où les lire, N5 d'abord. Chacun : nom, n,
                 titre (avec furigana), fr, genre, intro ; p, ses
                 paragraphes (des listes de phrases) ; q, ses questions
                 ({q, c : les choix, r : la bonne}) ;
     glossaire   les mots hors du vocabulaire : {m, l, fr, nature} ;
     particules  ce que fait chaque particule : {fr, g : ses points de
                 grammaire}.

   Une phrase : m, ses mots ; fr, sa traduction ; son, le nom de son
   fichier son ; qui, dans un dialogue, celui qui parle ; g, des points de
   grammaire nommés à la main. Un mot est une chaîne (la ponctuation) ou
   {t : son texte, avec furigana, et l'un de v (son indice dans le
   vocabulaire, celui de Mots.TOUS), x (dans le glossaire), n (le sens d'un
   nombre : « 7 h 30 ») ou k (la clé d'une particule) ; f, ce que disent
   ses terminaisons (« poli · passé ») ; g, les points de grammaire qui les
   expliquent}.
   ======================================================================= */
(function () {
  "use strict";

  const api = { TEXTES: [], PAR_NOM: new Map(), NIVEAUX: [], GLOSSAIRE: [], PARTICULES: {} };
  let PRET = null;

  const RUBI = /\{([^{}|]+)\|([^{}|]+)\}/g;
  function surface(texte) { return String(texte || "").replace(RUBI, "$1"); }
  function lecture(texte) { return String(texte || "").replace(RUBI, "$2"); }

  /* Une phrase en balisage, telle que la fabrication l'a lue. */
  function balise(ph) {
    return ph.m.map((m) => (typeof m === "string" ? m : m.t)).join("");
  }

  /* Chaque texte prend aussi son numéro dans son niveau, ses phrases à
     plat (chacune avec son rang, i, et son paragraphe, par), les mots du
     vocabulaire qu'il emploie (leurs indices, dans l'ordre où ils
     viennent), ses points de grammaire (leurs noms : ceux des phrases et
     des mots, pas ceux des particules, qui les nomment tous), sa longueur
     en signes, et ceux qui parlent, dans l'ordre où ils prennent la
     parole. */
  function installe(d) {
    const compte = {};
    api.GLOSSAIRE = d.glossaire || [];
    api.PARTICULES = d.particules || {};
    api.TEXTES = (d.textes || []).map((t, rang) => {
      const phrases = [];
      t.p.forEach((par, ip) => par.forEach((ph) => {
        phrases.push(Object.assign(ph, { par: ip, i: phrases.length }));
      }));
      const vus = new Set(), mots = [], voix = [], points = new Set();
      phrases.forEach((ph) => {
        if (ph.qui && !voix.includes(ph.qui)) voix.push(ph.qui);
        (ph.g || []).forEach((g) => points.add(g));
        ph.m.forEach((m) => {
          if (typeof m !== "object") return;
          (m.g || []).forEach((g) => points.add(g));
          if (typeof m.v === "number" && !vus.has(m.v)) {
            vus.add(m.v);
            mots.push(m.v);
          }
        });
      });
      const signes = phrases.reduce((s, ph) => s + surface(balise(ph)).length, 0);
      return Object.assign(t, { type: "texte", id: `texte:${t.nom}`, rang,
        numero: (compte[t.n] = (compte[t.n] || 0) + 1), phrases, mots, points: [...points], voix, signes });
    });
    api.PAR_NOM = new Map(api.TEXTES.map((t) => [t.nom, t]));
    api.NIVEAUX = [...new Set(api.TEXTES.map((t) => t.n))];
    return api.TEXTES;
  }

  function charge() {
    if (!PRET) {
      PRET = Matiere.json("lecture.json", "Les textes n'ont pas pu être chargés.")
        .then(installe)
        .catch((e) => { PRET = null; throw e; });
    }
    return PRET;
  }

  /* Le temps de lecture, en minutes : on lit lentement au début - une
     centaine de signes à la minute au N5, avec les mots à toucher -, et
     plus vite ensuite. */
  const SIGNES_MINUTE = { 5: 90, 4: 120, 3: 160, 2: 200, 1: 240 };
  function minutes(t) {
    return Math.max(1, Math.round(t.signes / (SIGNES_MINUTE[t.n] || 150)));
  }

  /* Les noms des genres, pour la page. */
  const GENRES = { dialogue: "Dialogue", récit: "Récit", journal: "Journal", lettre: "Lettre",
                   conte: "Conte", article: "Article", essai: "Essai", entretien: "Entretien",
                   annonce: "Annonce" };

  window.Lecture = Object.assign(api, { charge, installe, balise, surface, lecture, minutes, GENRES });
})();
