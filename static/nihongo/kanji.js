/* =======================================================================
   Nihongo - kanji.js

   Les kanjis : 2 211, ceux des cinq niveaux du JLPT, dans l'ordre où on
   les apprend (voir construit_kanjis dans nihongo.py). Rien ici ne touche
   à la page : les données, et de quoi corriger un sens tapé au clavier.

   Les données arrivent de static/nihongo/kanji.json, une fois, au
   démarrage de la page. Chaque kanji :
     k  le caractère          n   niveau JLPT (5 = N5 ... 1 = N1)
     g  année d'école         t   nombre de traits     f  rang de fréquence
     fr / en  ses sens        on / kun  ses lectures (KANJIDIC : « た.べる »,
                                         le point sépare ce qui s'écrit en kanas)
     c  ses morceaux [[forme, sens]]
     m  des mots courants [[mot, lecture, sens, (1 si le sens est en anglais)]]

   Deux cartes par kanji : le sens (voir 日, taper « jour ») et l'écriture
   (lire « jour, soleil », tracer 日). Pas de carte pour ses lectures
   seules : 日 se lit ひ, び, か, ニチ ou ジツ selon le mot, et c'est dans
   les mots qu'une lecture s'apprend - le vocabulaire s'en chargera. Elles
   s'affichent à chaque réponse, avec des mots qui les emploient.
   ======================================================================= */
(function () {
  "use strict";

  const NIVEAUX = [5, 4, 3, 2, 1];
  const api = { TOUS: [], PAR_CAR: new Map(), NIVEAUX };
  let PRET = null;

  function installe(liste) {
    api.TOUS = liste.map((x, i) => Object.assign(
      { type: "kanji", id: `kanji:${x.k}`, ecrire: true, rang: i }, x));
    api.PAR_CAR = new Map(api.TOUS.map((it) => [it.k, it]));
    return api.TOUS;
  }

  function charge() {
    if (!PRET) {
      PRET = Matiere.json("kanji.json", "Les kanjis n'ont pas pu être chargés.")
        .then((d) => installe(d.kanji))
        .catch((e) => { PRET = null; throw e; });
    }
    return PRET;
  }

  function cles(item) {
    return [`${item.id}:sens`, `${item.id}:ecrire`];
  }

  function depuisCle(cle) {
    const m = /^kanji:(.+):(sens|ecrire)$/.exec(cle || "");
    if (!m) return null;
    const item = api.PAR_CAR.get(m[1]);
    return item ? { item, genre: m[2] } : null;
  }

  /* ---------- corriger un sens tapé ----------
     Ce qui ne change pas le sens ne compte pas : les accents, les
     majuscules, l'article (« le soleil »), le pluriel, ce qui est entre
     parenthèses, et une faute de frappe dans un mot assez long. L'anglais
     est accepté aussi : on sait ce que veut dire 日 si on répond « sun ».
     Pour le reste, la page propose « J'avais bon » : un synonyme que
     KANJIDIC ne connaît pas n'est pas une erreur. */
  const ARTICLES = /^(?:(?:le|la|les|l|un|une|des|du|de|d|se|s|to|the|a|an)\s+)+/;

  /* Les nombres s'écrivent en chiffres ou en lettres : « 1 » vaut « un »,
     « 20 ans » vaut « vingt ans ». Les chiffres passent en lettres, des
     deux côtés. */
  const UNITES = ["zero", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
                  "onze", "douze", "treize", "quatorze", "quinze", "seize"];
  const DIZAINES = ["", "dix", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante",
                    "quatre vingt", "quatre vingt"];
  function moinsDeCent(n) {
    if (n <= 16) return UNITES[n];
    if (n < 20) return "dix " + UNITES[n - 10];
    const d = Math.floor(n / 10), u = n % 10;
    if (d === 7 || d === 9) return DIZAINES[d] + (d === 7 && u === 1 ? " et " : " ") + moinsDeCent(10 + u);
    if (!u) return DIZAINES[d] + (d === 8 ? "s" : "");
    return DIZAINES[d] + (u === 1 && d !== 8 ? " et un" : " " + UNITES[u]);
  }
  function moinsDeMille(n) {
    const c = Math.floor(n / 100), r = n % 100;
    const cents = !c ? "" : c === 1 ? "cent" : UNITES[c] + (r ? " cent" : " cents");
    return [cents, r || !c ? moinsDeCent(r) : ""].filter(Boolean).join(" ");
  }
  function enLettres(n) {
    if (!Number.isSafeInteger(n) || n >= 1e12) return String(n);
    if (n < 1000) return moinsDeMille(n);
    const morceaux = [];
    [[1e9, "milliard"], [1e6, "million"], [1e3, "mille"]].forEach(([p, nom]) => {
      const q = Math.floor(n / p);
      n %= p;
      if (!q) return;
      if (p === 1e3) morceaux.push(q === 1 ? "mille" : moinsDeMille(q) + " mille");
      else morceaux.push(moinsDeMille(q) + " " + nom + (q > 1 ? "s" : ""));
    });
    if (n) morceaux.push(moinsDeMille(n));
    return morceaux.join(" ");
  }

  /* Les abréviations qu'on tape, ou qu'un sens emploie : « M. », « Mme ». */
  const ABREGES = { m: "monsieur", mr: "monsieur", mme: "madame", mlle: "mademoiselle",
                    qqn: "quelqu un", qqch: "quelque chose", qq: "quelque" };

  function normaliseSens(s) {
    return String(s || "").toLowerCase()
      .replace(/œ/g, "oe").replace(/æ/g, "ae")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/\([^)]*\)/g, " ")
      // 10 000, 10.000 : un seul nombre
      .replace(/(\d)[\s.](?=\d{3}(?!\d))/g, "$1")
      .replace(/\d+/g, (c) => ` ${enLettres(+c)} `)
      .replace(/[^a-z0-9]+/g, " ").trim()
      .replace(/\b(?:m|mr|mme|mlle|qqn|qqch|qq)\b/g, (a) => ABREGES[a])
      .replace(ARTICLES, "")
      .replace(/^(\w{3,})[sx]$/, "$1")
      .replace(/(\w{3,})[sx]( |$)/g, "$1$2");
  }

  /* Les façons de dire un sens : sans ce qui est entre parenthèses, ou avec
     - « (préfixe de) politesse » se répond « politesse » comme « préfixe de
     politesse », « stylo (à bille) » se répond « stylo à bille ». Sauf
     quand la parenthèse ferait perdre le mot lui-même : « un (objet) »
     n'est pas « objet » (l'article « un » s'en irait). */
  function formesDuSens(s) {
    const texte = String(s || "");
    const sans = normaliseSens(texte);
    const formes = [sans];
    if (texte.includes("(")) {
      const avec = normaliseSens(texte.replace(/[()]/g, " "));
      if (/^\s*\(/.test(texte) || !sans || avec.split(" ")[0] === sans.split(" ")[0]) formes.push(avec);
    }
    return formes.filter(Boolean);
  }

  /* Le nombre de fautes de frappe entre deux mots : une lettre en trop, en
     moins, changée, ou deux lettres voisines inversées (« étudire »). */
  function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                           d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  /* Une faute de frappe dès cinq lettres, deux dès neuf. En dessous, rien :
     « mer » et « mère » sont deux kanjis différents. */
  function proche(a, b) {
    if (a === b) return true;
    const n = Math.max(a.length, b.length);
    if (n < 5) return false;
    return distance(a, b) <= (n >= 9 ? 2 : 1);
  }

  function accepteSens(item, saisie) {
    const essais = String(saisie || "").split(/[,;/]|\bou\b|\bor\b/)
      .map(normaliseSens).filter(Boolean);
    if (!essais.length) return false;
    const sens = [...item.fr, ...item.en].flatMap(formesDuSens);
    return essais.some((e) => sens.some((s) => proche(e, s)));
  }

  /* Les sens à montrer : le français, l'anglais à défaut (une partie de
     N1, surtout des kanjis de prénoms). */
  function sens(item, combien) {
    const liste = item.fr.length ? item.fr : item.en;
    return combien ? liste.slice(0, combien) : liste;
  }

  /* ---------- chercher ----------
     Un kanji collé (ou plusieurs : « 日本語 » donne les trois), une lecture
     en kanas, ou un sens en français ou en anglais. */
  function versHira(s) {
    return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  function cherche(texte, maxi) {
    const brut = String(texte || "").trim();
    if (!brut) return [];
    maxi = maxi || 150;
    const kanjis = [...brut].filter((c) => api.PAR_CAR.has(c));
    if (kanjis.length) return [...new Set(kanjis)].map((c) => api.PAR_CAR.get(c));
    if (/[ぁ-ー]/.test(brut)) {
      const q = versHira(brut);
      return api.TOUS.filter((it) => [...it.on, ...it.kun]
        .some((r) => versHira(r).replace(/[.\-]/g, "").startsWith(q))).slice(0, maxi);
    }
    const q = normaliseSens(brut);
    if (!q) return [];
    const exacts = [], debuts = [];
    api.TOUS.forEach((it) => {
      const s = [...it.fr, ...it.en].map(normaliseSens);
      if (s.includes(q)) exacts.push(it);
      else if (s.some((x) => x.startsWith(q) || x.includes(" " + q))) debuts.push(it);
    });
    return exacts.concat(debuts).slice(0, maxi);
  }

  window.Kanji = Object.assign(api, {
    charge, installe, cles, depuisCle, accepteSens, normaliseSens, formesDuSens, enLettres, distance, sens,
    cherche, versHira,
  });
})();
