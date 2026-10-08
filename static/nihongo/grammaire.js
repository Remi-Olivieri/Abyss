/* =======================================================================
   Nihongo - grammaire.js

   La grammaire : les points du JLPT, du N5 au N1, écrits pour ce site
   (matiere/grammaire-n5.txt à -n1.txt, voir « La grammaire » dans
   nihongo.py). Rien ici ne touche à la page : les données, et de quoi
   corriger une réponse.

   Les données arrivent de static/nihongo/grammaire.json, une fois, au
   démarrage : les chapitres (n, nom, intro : ce qu'il contient), puis les
   points. Chaque point :
     nom     son nom, qui fait sa clé (gram:te-kudasai:completer)
     n       niveau JLPT (5 à 1)
     chap    le nom du chapitre où il se range
     titre   le motif (〜てください), sens, formes : ce qu'il veut dire
             et comment il se construit. Le titre peut finir par une
             précision, 〜で (le moyen) : voir decoupeTitre
     texte   l'explication, en blocs : p (paragraphe), l (liste),
             t (tableau, la première ligne pour titres), note
     ex      les exemples (voir plus bas)
     voir    d'autres points à relire

   Les textes portent leurs furigana, {学生|がくせい}, et du **gras** : la
   page en fait du HTML (voir rubis dans nihongo.js).

   Un exemple est une phrase à trou :
     a, p    ce qui vient avant et après le trou
     t       ce qui va dans le trou, tel qu'il s'écrit
     r       les réponses justes, en hiraganas ; e, les mêmes avec leurs
             kanjis quand il y en a (tapées au clavier japonais)
     i       ce que le trou montre, s'il montre quelque chose : la forme
             à transformer (食べる pour 食べました)
     fr      la traduction ; son, le nom de son fichier son

   Une seule carte par point, « compléter » : chaque révision prend une
   autre phrase du point.
   ======================================================================= */
(function () {
  "use strict";

  const api = { TOUS: [], PAR_ID: new Map(), PAR_NOM: new Map(), NIVEAUX: [], CHAPITRES: [] };
  let PRET = null;

  const RUBI = /\{([^{}|]+)\|([^{}|]+)\}/g;
  /* Le texte tel qu'il s'écrit, et tel qu'il se lit. */
  function surface(texte) { return String(texte || "").replace(RUBI, "$1"); }
  function lecture(texte) { return String(texte || "").replace(RUBI, "$2"); }

  /* Chaque point prend aussi son numéro dans son niveau, son motif sans
     furigana (court), pour les listes et les aperçus, et son chapitre ;
     chaque chapitre, son numéro dans son niveau et ses points. */
  function installe(points, chapitres) {
    const compte = {};
    api.CHAPITRES = chapitres.map((c) => Object.assign(
      { numero: (compte[`c${c.n}`] = (compte[`c${c.n}`] || 0) + 1), items: [] }, c));
    const chapitre = new Map(api.CHAPITRES.map((c) => [`${c.n}|${c.nom}`, c]));
    api.TOUS = points.map((x, i) => Object.assign(
      { type: "gram", id: `gram:${x.nom}`, rang: i, court: surface(x.titre),
        numero: (compte[x.n] = (compte[x.n] || 0) + 1), chapitre: chapitre.get(`${x.n}|${x.chap}`) }, x));
    api.TOUS.forEach((it) => it.chapitre.items.push(it));
    api.PAR_ID = new Map(api.TOUS.map((it) => [it.id, it]));
    api.PAR_NOM = new Map(api.TOUS.map((it) => [it.nom, it]));
    api.NIVEAUX = [...new Set(api.TOUS.map((it) => it.n))];
    return api.TOUS;
  }

  /* Le titre en deux : le motif, et la précision qui le distingue d'un
     motif pareil - 〜で (le moyen), 〜で (le lieu de l'action). Une
     précision que le sens dit déjà ne se répète pas, sauf `toujours` (le
     sens n'est pas affiché à côté) : 〜い (les adjectifs en い), dont le
     sens est « les adjectifs en い ». */
  const plat = (s) => ` ${surface(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9぀-ヿ]+/g, " ").trim()} `;
  function decoupeTitre(it, toujours) {
    const m = /^(.*\S)\s+\(([^()]*[a-zà-ÿ][^()]*)\)$/i.exec(it.titre);
    if (!m) return { motif: it.titre, precision: "" };
    return { motif: m[1], precision: !toujours && plat(it.sens).includes(plat(m[2])) ? "" : m[2] };
  }

  function charge() {
    if (!PRET) {
      PRET = Matiere.json("grammaire.json", "La grammaire n'a pas pu être chargée.")
        .then((d) => installe(d.points, d.chapitres))
        .catch((e) => { PRET = null; throw e; });
    }
    return PRET;
  }

  /* La carte que crée la découverte d'un point. */
  function cles(item) {
    return [`${item.id}:completer`];
  }
  function depuisCle(cle) {
    const m = /^(gram:[a-z0-9-]+):(completer)$/.exec(cle || "");
    const item = m && api.PAR_ID.get(m[1]);
    return item ? { item, genre: m[2] } : null;
  }

  /* ---------- corriger ----------
     La saisie passe par le même clavier que les mots (le rōmaji devient des
     kanas), et se compare de la même façon. Quatre verdicts :
       juste      une des réponses de la phrase ;
       particule  juste, si ce n'est は, へ ou を tapés comme ils se disent
                  (« wa », « e », « o ») : une affaire de clavier, pas de
                  grammaire - la page laisse corriger ;
       presque    juste aux sons longs et aux っ près : une vraie faute,
                  mais qui mérite d'être dite ;
       faux. */
  const DITES = { は: "わ", へ: "え", を: "お" };
  function nettoie(s) {
    return Mots.compareLecture(Mots.versKana(s, true)).replace(/[。、．，？！?!.,]/g, "");
  }
  function corrige(ex, saisie) {
    const brut = String(saisie || "").trim();
    const tape = nettoie(brut);
    if (!tape) return "faux";
    const ecrites = ex.e || ex.r;
    if (ecrites.includes(brut) || ex.r.some((r) => Mots.compareLecture(r) === tape)) return "juste";
    const dite = (s) => s.replace(/[はへを]/g, (c) => DITES[c]);
    if (ex.r.some((r) => dite(Mots.compareLecture(r)) === dite(tape))) return "particule";
    if (ex.r.some((r) => Mots.sansLongues(r) === Mots.sansLongues(tape))) return "presque";
    return "faux";
  }

  /* La phrase entière : ce que la voix dit, ce qui s'affiche une fois le
     trou rempli. */
  function phrase(ex) {
    return ex.a + ex.t + ex.p;
  }

  /* ---------- chercher ----------
     Un motif (てください, te kudasai), un mot de son sens ou de son
     chapitre (« permission »), ou le nom du point. Pas les constructions :
     leurs « aussi : … » répondraient à tout. */
  function cherche(texte) {
    const brut = String(texte || "").trim();
    if (!brut) return [];
    const kana = /[぀-ヿ㐀-鿿]/.test(brut) ? Mots.compareLecture(brut)
      : /^[a-z' \-~]+$/i.test(brut) ? Mots.compareLecture(Mots.versKana(brut.replace(/[~ ]/g, ""), true)) : "";
    const q = Kanji.normaliseSens(brut);
    return api.TOUS.filter((it) => {
      const motif = Mots.compareLecture(lecture(it.titre) + " " + surface(it.titre)).replace(/[〜~]/g, "");
      if (kana && !/[a-z]/.test(kana) && motif.includes(kana.replace(/[〜~]/g, ""))) return true;
      if (/[㐀-鿿]/.test(brut) && surface(it.titre).includes(brut)) return true;
      if (it.nom.includes(brut.toLowerCase())) return true;
      return !!q && Kanji.normaliseSens([it.sens, it.chap].join(" ")).includes(q);
    });
  }

  window.Grammaire = Object.assign(api, {
    charge, installe, cles, depuisCle, corrige, phrase, surface, lecture, cherche, decoupeTitre,
  });
})();
