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
                 grammaire} ;
     libre       la lecture libre (voir plus bas) : phrases, combien il y en
                 a par niveau ; paquet, combien par fichier ; version ; et son
                 glossaire et ses particules, qui prolongent ceux des textes.

   Une phrase : m, ses mots ; fr, sa traduction ; son, le nom de son
   fichier son ; qui, dans un dialogue, celui qui parle ; g, des points de
   grammaire nommés à la main. Un mot est une chaîne (la ponctuation) ou
   {t : son texte, avec furigana, et l'un de v (son indice dans le
   vocabulaire, celui de Mots.TOUS), x (dans le glossaire), n (le sens d'un
   nombre : « 7 h 30 ») ou k (la clé d'une particule) ; f, ce que disent
   ses terminaisons (« poli · passé ») ; g, les points de grammaire qui les
   expliquent}.

   La lecture libre : les phrases de Tatoeba (voir « La lecture libre »
   dans nihongo.py), lues une à une. Elles arrivent par paquets,
   libre/n5-0.json..., à la demande : un paquet pèse une trentaine de Ko,
   tous ensemble cinq Mo. Une phrase y a
   en plus id, son numéro sur Tatoeba, et relais quand sa traduction passe
   par l'anglais.
   ======================================================================= */
(function () {
  "use strict";

  const api = { TEXTES: [], PAR_NOM: new Map(), NIVEAUX: [], GLOSSAIRE: [], PARTICULES: {},
                LIBRE: { phrases: {}, paquet: 250, version: "" } };
  let PRET = null;

  const RUBI = /\{([^{}|]+)\|([^{}|]+)\}/g;
  function surface(texte) { return String(texte || "").replace(RUBI, "$1"); }
  function lecture(texte) { return String(texte || "").replace(RUBI, "$2"); }

  /* Une phrase en balisage, telle que la fabrication l'a lue. */
  function balise(ph) {
    return ph.m.map((m) => (typeof m === "string" ? m : m.t)).join("");
  }

  /* Ce qu'un texte emploie : les mots du vocabulaire (leurs indices, dans
     l'ordre où ils viennent), ses points de grammaire (leurs noms : ceux
     des phrases et des mots, pas ceux des particules, qui les nomment
     tous), ceux qui parlent, dans l'ordre où ils prennent la parole, et
     sa longueur en signes. */
  function releve(phrases) {
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
    return { mots, points: [...points], voix, signes };
  }

  /* Chaque texte prend aussi son numéro dans son niveau, ses phrases à
     plat (chacune avec son rang, i, et son paragraphe, par), et ce qu'il
     emploie (releve). Le glossaire et les particules de la lecture libre
     suivent ceux des textes : un mot x des phrases libres est le rang
     d'une entrée dans les deux mis bout à bout. */
  function installe(d) {
    const compte = {}, libre = d.libre || {};
    api.GLOSSAIRE = (d.glossaire || []).concat(libre.glossaire || []);
    api.PARTICULES = Object.assign({}, libre.particules, d.particules);
    api.LIBRE = { phrases: libre.phrases || {}, paquet: libre.paquet || 250, version: libre.version || "" };
    api.TEXTES = (d.textes || []).map((t, rang) => {
      const phrases = [];
      t.p.forEach((par, ip) => par.forEach((ph) => {
        phrases.push(Object.assign(ph, { par: ip, i: phrases.length }));
      }));
      return Object.assign(t, { type: "texte", id: `texte:${t.nom}`, rang,
        numero: (compte[t.n] = (compte[t.n] || 0) + 1), phrases }, releve(phrases));
    });
    api.PAR_NOM = new Map(api.TEXTES.map((t) => [t.nom, t]));
    api.NIVEAUX = [...new Set(api.TEXTES.map((t) => t.n))];
    return api.TEXTES;
  }

  /* ---------- la lecture libre ---------- */
  function phrasesLibres(n) {
    return +api.LIBRE.phrases[n] || 0;
  }
  /* Les niveaux où lire, textes ou lecture libre : N5 d'abord. */
  function niveaux() {
    const libres = Object.keys(api.LIBRE.phrases).map(Number).filter(phrasesLibres);
    return [...new Set(api.NIVEAUX.concat(libres))].sort((a, b) => b - a);
  }

  const PAQUETS = new Map();
  function paquet(nom) {
    if (!PAQUETS.has(nom)) {
      const p = fetch(`/static/nihongo/libre/${nom}.json`, { credentials: "same-origin" })
        .catch(() => null)
        .then((r) => {
          if (!r || !r.ok) throw new Error("Ce texte n'a pas pu être chargé.");
          return r.json();
        })
        .then((d) => {
          // refaite depuis l'ouverture de la page, la lecture libre ne
          // cite plus les mots aux mêmes rangs
          if (d.version !== api.LIBRE.version) throw new Error("La lecture libre a changé : recharge la page.");
          return d;
        });
      p.catch(() => PAQUETS.delete(nom));
      PAQUETS.set(nom, p);
    }
    return PAQUETS.get(nom);
  }

  /* La phrase libre n° k (à partir de 0) du niveau n, prête pour la
     liseuse : un texte d'une seule phrase. */
  async function phraseLibre(n, k) {
    const d = await paquet(`n${n}-${Math.floor(k / api.LIBRE.paquet)}`);
    const ph = d.phrases[k % api.LIBRE.paquet];
    if (!ph) throw new Error("Cette phrase n'existe pas.");
    const phrases = [Object.assign({}, ph, { par: 0, i: 0 })];
    return Object.assign({ type: "libre", id: `libre:${n}:${k}`, nom: `libre-n${n}-${k}`, n, k,
      numero: k + 1, p: [phrases], phrases, q: [] }, releve(phrases));
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

  window.Lecture = Object.assign(api, { charge, installe, balise, surface, lecture, minutes, GENRES,
                                        phrasesLibres, niveaux, phraseLibre });
})();
