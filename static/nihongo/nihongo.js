/* =======================================================================
   Nihongo - nihongo.js

   La page : les rubriques, la séance du jour, celle de la grammaire, le
   test de niveau, les tableaux des kanas et des kanjis, la liste des mots,
   les points de grammaire, leurs fiches, les textes à lire et leur
   liseuse, les progrès.

   Une seule page pour toutes les rubriques (/nihongo, /nihongo/kana...) :
   le serveur sert la même, et l'adresse dit laquelle afficher. On passe de
   l'une à l'autre sans recharger - l'état des révisions est déjà là.

   Ce que le serveur garde : les cartes et les journées (voir nihongo.py).
   Ce que la page décide : quoi montrer, dans quel ordre, et la note de
   chaque réponse. Rien n'est noté sans avoir été envoyé : chaque réponse
   part au serveur à l'instant où elle est donnée, et une séance quittée en
   route n'a rien perdu.
   ======================================================================= */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const echappe = (s) => String(s === null || s === undefined ? "" : s)
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
                                   '"': "&quot;", "'": "&#39;" }[c]));

  const JOUR = 86400000;

  let ETAT = null;                // la réponse de /api/nihongo/etat

  /* =====================================================================
     Outils
     ===================================================================== */
  async function api(chemin, methode, charge) {
    const options = { method: methode || "GET", credentials: "same-origin" };
    if (charge !== undefined) {
      // application/json : la parade CSRF que le serveur exige
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(charge);
    }
    const r = await fetch(chemin, options);
    let data = null;
    try { data = await r.json(); } catch (e) { /* réponse illisible */ }
    if (!r.ok || !data || data.ok === false) {
      const err = new Error((data && data.message) || `Erreur ${r.status}.`);
      err.statut = r.status;
      throw err;
    }
    return data;
  }

  /* Les réglages de cet appareil. Le stockage peut manquer (navigation
     privée, site bloqué) : on retombe alors sur la valeur par défaut. */
  const Pref = {
    lit(cle, defaut) {
      try {
        const v = localStorage.getItem("nihongo:" + cle);
        return v === null ? defaut : JSON.parse(v);
      } catch (e) { return defaut; }
    },
    ecrit(cle, valeur) {
      try { localStorage.setItem("nihongo:" + cle, JSON.stringify(valeur)); } catch (e) { /* tant pis */ }
    },
    efface(cle) {
      try { localStorage.removeItem("nihongo:" + cle); } catch (e) { /* tant pis */ }
    },
  };

  /* ---------- le rōmaji ----------
     Le réglage « Rōmaji » écrit en lettres latines les mots, les phrases et
     les textes (voir romaji.js). Les kanas et les kanjis gardent leur
     écriture là où c'est elle qu'on apprend : leurs tableaux, leurs cartes,
     la lecture d'un mot en kanjis, le test de niveau. Ce qui n'est pas
     découpé en mots - les phrases de la grammaire, le japonais glissé dans
     les explications - arrive transcrit de romaji.json, que la page ne
     demande qu'en rōmaji. */
  let EN_ROMAJI = Pref.lit("romaji", false) === true;
  const romaji = () => EN_ROMAJI;
  let TRANSCRITS = { fragments: {}, phrases: {} };
  let transcritsCharges = null;
  function chargeRomaji() {
    if (!transcritsCharges) {
      transcritsCharges = Matiere.json("romaji.json", "Le rōmaji n'a pas pu être chargé.")
        .then((d) => { TRANSCRITS = d; })
        .catch((e) => { transcritsCharges = null; throw e; });
    }
    return transcritsCharges;
  }

  /* La barre des rubriques lit ses mots en rōmaji, comme le reste. */
  function appliqueRomaji() {
    document.documentElement.classList.toggle("romaji", EN_ROMAJI);
    document.querySelectorAll("#onglets rt").forEach((rt) => {
      if (!rt.dataset.kana) rt.dataset.kana = rt.textContent;
      rt.textContent = EN_ROMAJI ? Romaji.de(rt.dataset.kana) : rt.dataset.kana;
    });
  }

  /* Le rōmaji n'est pas du japonais écrit : un élément lang="ja" où il ne
     reste ni kana ni kanji passe en « ja-Latn », et perd les polices des
     caractères (voir « Le rōmaji » dans nihongo.css). Les rendus gardent
     leur lang="ja" : il change ici, à mesure qu'ils arrivent dans la page. */
  const ECRIT_JAPONAIS = /[぀-ヿ㐀-鿿豈-﫿々〆]/;
  function latinise(el) {
    [el, ...el.querySelectorAll('[lang="ja"]')].forEach((x) => {
      if (x.getAttribute("lang") === "ja" && !ECRIT_JAPONAIS.test(x.textContent)) x.setAttribute("lang", "ja-Latn");
    });
  }
  new MutationObserver((changes) => {
    if (!EN_ROMAJI) return;
    changes.forEach((c) => c.addedNodes.forEach((n) => {
      const el = n.nodeType === 1 ? n : n.parentElement && n.parentElement.closest('[lang="ja"]');
      if (el) latinise(el);
    }));
  }).observe(document.body, { childList: true, subtree: true });

  let minuteurToast = null;
  function toast(texte, mauvais) {
    const t = $("toast");
    t.textContent = texte;
    t.classList.toggle("mauvais", !!mauvais);
    t.hidden = false;
    clearTimeout(minuteurToast);
    minuteurToast = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function melange(liste) {
    for (let i = liste.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [liste[i], liste[j]] = [liste[j], liste[i]];
    }
    return liste;
  }

  const ICONE_SON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;

  function boutonSon(id, texte) {
    return `<button type="button" class="btn-son" id="${id}">${ICONE_SON}<span>${texte || "Écouter"}</span></button>`;
  }

  /* =====================================================================
     Thème : le papier le jour, l'encre la nuit
     ===================================================================== */
  function themeActuel() {
    return document.documentElement.getAttribute("data-theme") === "nuit" ? "nuit" : "jour";
  }
  function majBoutonTheme() {
    const b = $("themeBtn");
    if (!b) return;
    const nuit = themeActuel() === "nuit";
    b.setAttribute("aria-label", nuit ? "Passer au thème clair" : "Passer au thème sombre");
    b.querySelector("span").textContent = nuit ? "昼" : "夜";
  }
  /* Le thème choisi sur cet appareil : « jour », « nuit », ou « systeme » -
     celui de l'appareil, qui suit ses changements (voir la tête de
     nihongo.html, qui le pose avant le premier affichage). */
  const NUIT_SYSTEME = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  function choixTheme() {
    const t = Pref.lit("theme", null);
    return t === "jour" || t === "nuit" ? t : "systeme";
  }
  function appliqueTheme() {
    const c = choixTheme();
    document.documentElement.setAttribute("data-theme",
      c !== "systeme" ? c : NUIT_SYSTEME && NUIT_SYSTEME.matches ? "nuit" : "jour");
    majBoutonTheme();
  }
  if (NUIT_SYSTEME && NUIT_SYSTEME.addEventListener) NUIT_SYSTEME.addEventListener("change", appliqueTheme);
  $("themeBtn").addEventListener("click", () => {
    Pref.ecrit("theme", themeActuel() === "nuit" ? "jour" : "nuit");
    appliqueTheme();
    // la page des paramètres montre le thème choisi
    if (ETAT && rubrique() === "parametres") rend();
  });
  majBoutonTheme();

  /* =====================================================================
     La voix
     =====================================================================
     D'abord les sons fabriqués sur le serveur par VOICEVOX Nemo (voir « La
     voix » dans nihongo.py) : une vraie voix japonaise, la même sur tous
     les appareils. Un dossier par voix, un fichier par son, au nom de ce
     qu'il dit - « f1/あ.mp3 », « h3/毎日・まいにち.mp3 », le mot puis sa
     lecture.

     La voix choisie d'abord, l'autre si elle n'a pas encore ce son (une
     voix se fabrique en deux heures, pas en une fois), et la synthèse de
     l'appareil en dernier recours. Sa qualité dépend de lui : correcte sur
     un téléphone, robotique sur bien des ordinateurs - c'est pour ça
     qu'elle ne passe plus qu'en dernier. Un fichier absent est retenu
     comme tel : on ne le redemande pas à chaque clic. */
  const VOIX = [               // la même liste que VOIX dans nihongo.py
    { id: "f1", nom: "Femme" },
    { id: "h3", nom: "Homme" },
  ];
  const PHRASE_ESSAI = "こんにちは。一緒に日本語を勉強しましょう。";

  const Voix = (function () {
    const absents = new Set();
    const sons = new Map();          // les fichiers déjà chargés, rejoués sans attendre
    let courant = null;
    let voixAppareil = null;
    const synthese = typeof window.speechSynthesis !== "undefined";

    function choisit() {
      if (!synthese) return;
      const japonaises = speechSynthesis.getVoices().filter((v) => /^ja([-_]|$)/i.test(v.lang));
      // les voix « naturelles » ou de Google d'abord : les autres hachent
      const score = (v) => (/natural|online|google|neural/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1);
      japonaises.sort((a, b) => score(b) - score(a));
      voixAppareil = japonaises[0] || null;
    }
    if (synthese) {
      choisit();
      speechSynthesis.addEventListener("voiceschanged", choisit);
    }

    /* La voix réglée sur cet appareil : l'id d'une voix, ou « alterne ». */
    function choix() {
      const c = Pref.lit("voix", VOIX[0].id);
      return c === "alterne" || VOIX.some((v) => v.id === c) ? c : VOIX[0].id;
    }
    /* Dans quel ordre essayer les voix : la choisie, puis les autres ; au
       hasard si on alterne. */
    function ordre(force) {
      const c = force || choix();
      const ids = VOIX.map((v) => v.id);
      if (c === "alterne") return melange(ids);
      return [c, ...ids.filter((id) => id !== c)];
    }

    /* Même règle que cle_audio dans nihongo.py. */
    function cle(texte, lecture) {
      return !lecture || lecture === texte ? texte : `${texte}・${lecture}`;
    }

    function arrete() {
      if (courant) { courant.pause(); courant = null; }
      if (synthese) try { speechSynthesis.cancel(); } catch (e) { /* rien */ }
    }

    function parleAppareil(texte, surEchec, fin) {
      if (!synthese || !voixAppareil) { if (surEchec) surEchec(); return; }
      try {
        const u = new SpeechSynthesisUtterance(texte);
        u.lang = "ja-JP";
        u.voice = voixAppareil;
        u.rate = 0.85;
        if (fin) u.onend = fin;
        speechSynthesis.speak(u);
      } catch (e) { if (surEchec) surEchec(); }
    }

    /* Essaie les voix une à une ; `suite` est ce qu'il reste à essayer si
       le fichier de celle-ci manque, `fin` ce qui vient une fois le son
       fini (une lecture à voix haute qui passe à la phrase suivante). Un
       son arrêté en route ne finit pas. */
    function joue(c, voix, suite, fin) {
      if (!voix.length) { suite(); return; }
      const id = `${voix[0]}/${c}`;
      const ensuite = () => joue(c, voix.slice(1), suite, fin);
      if (absents.has(id)) { ensuite(); return; }
      let son = sons.get(id);
      if (!son) {
        son = new Audio(`/static/nihongo/voix/${voix[0]}/${encodeURIComponent(c)}.mp3`);
        son.preload = "auto";
        sons.set(id, son);
        son.addEventListener("error", () => {
          absents.add(id);
          sons.delete(id);
          if (courant === son) { courant = null; son.suite(); }
        });
        son.addEventListener("ended", () => {
          if (courant !== son) return;
          courant = null;
          if (son.fin) son.fin();
        });
      }
      son.suite = ensuite;
      son.fin = fin || null;
      courant = son;
      try { son.currentTime = 0; } catch (e) { /* pas encore chargé : il part du début */ }
      const essai = son.play();
      // un refus de lecture automatique (aucun clic avant) n'est pas une
      // absence de fichier : on se tait, le bouton « Écouter » reste là
      if (essai && essai.catch) essai.catch(() => {});
    }

    /* Dit `texte` ; `lecture` départage les mots qui en ont plusieurs.
       `surEchec` : rien ne peut le dire (pas de fichier, pas de voix
       japonaise sur l'appareil). `voix` : imposer une voix (l'essai). */
    function dit(texte, lecture, surEchec, voix) {
      arrete();
      joue(cle(texte, lecture), ordre(voix), () => parleAppareil(lecture || texte, surEchec));
    }

    /* Dit une phrase de la grammaire ou d'un texte. Son fichier porte le
       nom de son empreinte, `son` (voir groupes_de_sons dans nihongo.py) ;
       l'appareil, en dernier recours, lit son texte. `o.voix` impose une
       voix (dans un dialogue, chacun la sienne), `o.fin` est appelé quand
       la phrase est dite. */
    function ditPhrase(son, texte, surEchec, o) {
      o = o || {};
      arrete();
      joue(son, ordre(o.voix), () => parleAppareil(texte, surEchec, o.fin), o.fin);
    }

    return { dit, ditPhrase, arrete, cle, choix };
  })();

  const VOIX_CHOIX = [...VOIX, { id: "alterne", nom: "Les deux" }];
  const SANS_VOIX = "Pas encore de son pour celui-ci, et aucune voix japonaise sur cet appareil.";
  function dire(texte, lecture) {
    Voix.dit(texte, lecture, () => toast(SANS_VOIX, true));
  }

  function brancheSon(id, texte) {
    const b = $(id);
    if (b) b.addEventListener("click", () => dire(texte));
  }

  /* =====================================================================
     Les cartes
     ===================================================================== */
  /* Une carte, d'où qu'elle vienne : « kana:あ:lire », « kanji:日:sens »,
     « mot:食べる・たべる:dire », « gram:te-kudasai:completer ». */
  const MODULES = { kana: Kana, kanji: Kanji, mot: Mots, gram: Grammaire };
  function depuisCle(cle) {
    return Kana.depuisCle(cle) || Kanji.depuisCle(cle) || Mots.depuisCle(cle)
      || Grammaire.depuisCle(cle);
  }
  /* Les cartes que crée la découverte. Celles d'un mot dépendent de ce
     qu'on sait déjà (voir « En kanjis, ou en kanas ») ; sa carte « dire »
     vient plus tard, voir planDuJour. */
  function clesDe(item) {
    if (item.type !== "mot") return MODULES[item.type].cles(item);
    const cles = cleSens(item) === `${item.id}:sens` ? [`${item.id}:sens`] : [];
    if (enKanjis(item)) cles.push(`${item.id}:lire`);
    return cles;
  }
  /* Les cartes qu'un élément a, ou pourra avoir : de quoi dire s'il est
     commencé, et depuis quand. Pas celle de son kanji, pour un mot qui
     n'est que ce kanji : découvrir 上 ne fait pas découvrir うえ. */
  function propres(item) {
    return item.type === "mot" ? ["sens", "lire", "dire"].map((g) => `${item.id}:${g}`) : clesDe(item);
  }
  function carteDe(cle) {
    const d = depuisCle(cle);
    return { genre: d.genre, item: d.item, cle };
  }
  function commence(item) {
    return propres(item).some((cle) => ETAT.cartes[cle]);
  }
  /* Cette façon de travailler existe-t-elle pour cet élément ? Un yōon ne
     s'écrit pas, un mot qui s'écrit en kanas ne se « lit » pas. */
  function aCeGenre(it, genre) {
    if (it.type === "mot") return genre === "lire" ? enKanjis(it) : genre === "sens" || genre === "dire";
    if (it.type === "gram") return genre === "completer";
    return genre !== "ecrire" || it.ecrire;
  }

  /* ---------- en kanjis, ou en kanas ----------
     Un mot s'écrit en kanjis quand ses kanjis sont à portée : ceux du
     niveau où l'on en est - le N5 tant qu'il reste des kanjis du N5 à
     découvrir, puis le N4... - et ceux qu'on a déjà appris. Sinon il
     s'écrit en kanas, dans la séance comme dans les textes : 壁 est un
     kanji du N1, かべ un mot du deuxième texte, qu'on apprend tout de
     suite. Son kanji viendra à son heure, et le mot gagnera alors sa
     carte de lecture (voir aLire dans planDuJour). Un kanji hors des
     listes du JLPT (誰, 頃) suit le niveau du mot.

     Un mot qui n'est qu'un kanji (上 うえ, 人 ひと) n'a pas de carte de
     sens à lui : c'est celle du kanji, qui accepte ses sens et le montre
     parmi ses mots - deux cartes pour la même question, c'était une de
     trop, et deux traductions pour un seul caractère. Il s'écrit donc en
     kanji dès qu'on connaît ce kanji, et seulement alors : la séance fait
     découvrir le kanji juste avant lui. Appris en kanas avant son kanji
     (かべ), il a sa carte de sens en kanas, que la carte du kanji remplace
     à son arrivée. Seul le mot le plus courant a ce lien (上 うえ, pas
     上 かみ) : les autres gardent leurs cartes, avec leur lecture. */
  const KANJI_CAR = /[㐀-鿿豈-﫿]/;
  let NIVEAU_KANJIS = null;
  function niveauKanjis() {
    if (NIVEAU_KANJIS === null) {
      const k = Kanji.TOUS.find((it) => !commence(it));
      NIVEAU_KANJIS = k ? k.n : 1;
    }
    return NIVEAU_KANJIS;
  }
  /* Les cartes ont changé : le niveau des kanjis est à refaire. */
  function cartesChangees() {
    NIVEAU_KANJIS = null;
  }
  /* Connu : déjà dans les révisions, ou découvert pendant cette séance. */
  function kanjiConnu(k) {
    return commence(k) || !!(SEANCE && SEANCE.decouverts.has(k.id));
  }
  /* `repli` : le niveau d'un kanji hors des listes, celui du mot ou du
     texte ; sans lui, le kanji passe. */
  function aPortee(c, repli) {
    const k = Kanji.PAR_CAR.get(c);
    if (!k) return (repli || 5) >= niveauKanjis();
    return k.n >= niveauKanjis() || kanjiConnu(k);
  }
  /* Le kanji d'un mot qui n'est que lui, le mot d'un kanji qui en forme un
     à lui seul (le premier de la liste, le plus courant). */
  let SEULS = null;
  function seul(it) {
    if (!SEULS) {
      SEULS = new Map();
      Mots.TOUS.forEach((m) => {
        const k = [...m.m].length === 1 && Kanji.PAR_CAR.get(m.m);
        if (k && !SEULS.has(k)) { SEULS.set(k, m); SEULS.set(m, k); }
      });
    }
    return SEULS.get(it) || null;
  }
  const kanjiDuMot = (it) => seul(it);
  const motDuKanji = (k) => seul(k);
  function enKanjis(it) {
    if (!it.kanjis) return false;
    const k = kanjiDuMot(it);
    if (k) return kanjiConnu(k);
    return [...it.m].every((c) => !KANJI_CAR.test(c) || aPortee(c, it.n));
  }
  /* Le mot tel que la séance et les textes l'écrivent. */
  function graphie(it) {
    return it.kanjis && !enKanjis(it) ? it.l[0] : it.m;
  }
  /* Le mot tel que la page l'affiche : en rōmaji si c'est le réglage. */
  function motEcrit(it) {
    return romaji() ? Romaji.mot(it) : graphie(it);
  }
  /* Une lecture en kanas (たべる, le ニチ de 日), telle que la page
     l'affiche. `p` : la nature du mot, s'il y en a un (voir
     Romaji.prepare). */
  function lectureEcrite(kana, p) {
    return romaji() ? Romaji.de(Romaji.prepare(kana, p)) : kana;
  }
  /* Les kanjis qui le tiennent encore en kanas. */
  function horsDePortee(it) {
    const k = kanjiDuMot(it);
    if (k) return kanjiConnu(k) ? [] : [k.k];
    return [...new Set([...it.m].filter((c) => KANJI_CAR.test(c) && !aPortee(c, it.n)))];
  }
  /* La carte qui porte le sens d'un mot : la sienne, ou celle de son
     kanji. */
  function cleSens(it) {
    const k = kanjiDuMot(it);
    return k && kanjiConnu(k) ? `${k.id}:sens` : `${it.id}:sens`;
  }
  function cleDe(item, genre) {
    return item.type === "mot" && genre === "sens" ? cleSens(item) : `${item.id}:${genre}`;
  }
  /* Une carte mise de côté : le sens d'un mot que porte maintenant la
     carte de son kanji, la lecture d'un mot qui s'écrit pour l'instant en
     kanas. Elle garde sa mémoire, et ne revient pas tant qu'elle ne sert
     pas. */
  function carteActive(cle) {
    const d = depuisCle(cle);
    if (!d) return false;
    if (d.item.type !== "mot" || d.genre === "dire") return true;
    return d.genre === "sens" ? cleSens(d.item) === cle : enKanjis(d.item);
  }
  /* Deux mots qui s'écrivent pareil (上 うえ et 上 かみ) : la carte dit
     lequel on attend. */
  let HOMOGRAPHES = null;
  function homographe(it) {
    if (!HOMOGRAPHES) {
      HOMOGRAPHES = new Map();
      Mots.TOUS.forEach((m) => HOMOGRAPHES.set(m.m, (HOMOGRAPHES.get(m.m) || 0) + 1));
    }
    return it.kanjis && HOMOGRAPHES.get(it.m) > 1;
  }
  /* Un sens tapé : celui d'un kanji vaut pour le mot qu'il forme à lui
     seul, et inversement (下 : « au-dessous », ou « dessous, en bas »
     comme した). */
  function accepteSens(it, tape) {
    const autre = it.type === "kanji" ? motDuKanji(it) : kanjiDuMot(it);
    return Kanji.accepteSens(it, tape) || (!!autre && Kanji.accepteSens(autre, tape));
  }

  /* 0 : jamais vue · 1 : en cours (moins de 3 jours de mémoire) · 2 : sue
     (moins de 3 semaines) · 3 : acquise. La stabilité de FSRS est
     justement « combien de jours avant d'en être à 90 % ». Une carte vue
     une seule fois reste en cours, quoi qu'en dise la formule : un « bien »
     trente secondes après la découverte lui donne déjà trois jours. Celles
     du test de niveau (aucune révision) étaient sues avant. */
  function niveau(carte) {
    if (!carte) return 0;
    if (carte.s < 3 || carte.n === 1) return 1;
    if (carte.s < 21) return 2;
    return 3;
  }
  const NIVEAUX = ["pas encore vu", "en cours", "su", "acquis"];
  function niveauDe(item, genre) {
    return niveau(ETAT.cartes[cleDe(item, genre)]);
  }

  function echeance(carte) {
    if (!carte) return "pas encore appris";
    const dans = Date.parse(carte.e) - Date.now();
    if (dans <= 0) return "à revoir maintenant";
    if (dans < 3600000) return `revient dans ${Math.max(1, Math.round(dans / 60000))} min`;
    // « demain » se compte en jours d'apprentissage, qui basculent à 4 h :
    // la page n'a pas à refaire ce calcul, l'échéance tombe déjà dessus
    const jours = Math.round(dans / JOUR);
    if (jours <= 1) return "revient demain";
    if (jours < 60) return `revient dans ${jours} jours`;
    return `revient dans ${Math.round(jours / 30)} mois`;
  }

  /* Les quotas du jour, réglés sur cet appareil : des kanas, des kanjis et
     des mots, chacun sa file. On peut tout apprendre en même temps - les
     kanjis n'attendent pas que les katakanas soient finis, ni les mots que
     leurs kanjis soient sus. La grammaire n'en a pas : elle a sa propre
     séance, qu'on lance quand on veut (voir « La grammaire, à part »). */
  const QUOTAS = {
    kana: { pref: "nouveaux", defaut: 5, choix: [0, 3, 5, 8, 10, 15] },
    kanji: { pref: "kanjis", defaut: 3, choix: [0, 1, 2, 3, 5, 8, 10] },
    mot: { pref: "mots", defaut: 5, choix: [0, 3, 5, 8, 10, 15, 20] },
  };
  function quota(type) {
    const q = QUOTAS[type];
    const n = +Pref.lit(q.pref, q.defaut);
    return n >= 0 && n <= 30 ? n : q.defaut;
  }

  /* Les mots demandés en lisant (voir la liseuse) et pas encore
     découverts, du plus ancien au plus récent. */
  function motsDemandes() {
    return (ETAT.demandes || []).map((id) => Mots.PAR_ID.get(id)).filter((it) => it && !commence(it));
  }
  function demande(it) {
    return (ETAT.demandes || []).includes(it.id) && !commence(it);
  }
  /* Au plus tant de mots demandés par jour, même au-delà du quota : on les
     a voulus, mais trente d'un coup feraient une séance d'une heure. */
  const DEMANDES_PAR_JOUR = 10;

  /* L'ordre des mots : celui des textes. On apprend pour lire - les mots du
     premier texte d'abord, dans l'ordre où il les emploie, puis ceux du
     deuxième... : quelques jours de séance, et le texte est à portée (voir
     PORTEE). Tous les textes du N5 d'abord, quel que soit le niveau de
     leurs mots (お願いします est du N1 dans les listes, et du premier texte).
     Ensuite, les mots du N5 qu'aucun texte n'emploie alternent avec ceux
     des textes du N4 : le niveau se finit sans que la lecture attende. Et
     ainsi de suite : le reste du N4 avec les textes du N3... Dans chaque
     niveau, l'ordre des listes, les plus fréquents d'abord.
     Le même pour tous, calculé une fois. */
  let ORDRE_MOTS = null;
  function ordreDesMots() {
    if (ORDRE_MOTS) return ORDRE_MOTS;
    const places = new Set(), ordre = [];
    const place = (it) => { if (it && !places.has(it)) { places.add(it); ordre.push(it); } };
    const desTextes = (n) => Lecture.TEXTES.filter((t) => t.n === n).flatMap((t) => t.mots.map((v) => Mots.TOUS[v]));
    const duNiveau = (n) => Mots.TOUS.filter((it) => it.n === n);
    // un sur deux, sans redire un mot déjà placé
    const alterne = (a, b) => {
      let i = 0, j = 0;
      while (i < a.length || j < b.length) {
        while (i < a.length && places.has(a[i])) i++;
        place(a[i++]);
        while (j < b.length && places.has(b[j])) j++;
        place(b[j++]);
      }
    };
    const niveaux = Mots.NIVEAUX;              // 5, 4, 3, 2, 1
    desTextes(niveaux[0]).forEach(place);
    for (let k = 1; k < niveaux.length; k++) alterne(duNiveau(niveaux[k - 1]), desTextes(niveaux[k]));
    Mots.TOUS.forEach(place);                  // le reste du N1
    ORDRE_MOTS = ordre;
    return ordre;
  }

  /* Les mots dans l'ordre où les découvrir : d'abord ceux qu'on a demandés
     en lisant, puis l'ordre des textes. */
  function motsADecouvrir() {
    const demandes = motsDemandes();
    const voulus = new Set(demandes.map((it) => it.id));
    return demandes.concat(ordreDesMots().filter((it) => !commence(it) && !voulus.has(it.id)));
  }

  /* Les kanjis, niveau par niveau : tout le N5 avant le N4. Dans un
     niveau, un sur deux vient des mots - ceux déjà vus, dans l'ordre où on
     les a découverts (写真 appris, 写 et 真 viennent), puis ceux qui
     arrivent -, l'autre de l'ordre du niveau, qui commence par les nombres
     et les jours de la semaine (voir construit_kanjis). Un kanji plus
     difficile attend son niveau, même si un mot l'emploie : ce mot s'écrit
     en kanas d'ici là (voir enKanjis), et son kanji passera en tête de son
     niveau. Suivre les mots seuls faisait apprendre 使 et 住 avant 四 et
     水. */
  function kanjisADecouvrir() {
    const desMots = [], vus = new Set();
    const deSesKanjis = (it) => {
      for (const c of it.m) {
        const k = Kanji.PAR_CAR.get(c);
        if (k && !vus.has(k)) { vus.add(k); desMots.push(k); }
      }
    };
    Mots.TOUS.filter((it) => it.kanjis && commence(it))
      .map((it) => [it, premiereCarte(it)]).sort((a, b) => a[1] - b[1])
      .forEach(([it]) => deSesKanjis(it));
    motsADecouvrir().forEach((it) => { if (it.kanjis) deSesKanjis(it); });
    const ordre = [], places = new Set();
    const libre = (k) => !places.has(k) && !commence(k);
    const place = (k) => { if (k) { places.add(k); ordre.push(k); } };
    for (const n of Kanji.NIVEAUX) {
      const a = desMots.filter((k) => k.n === n), b = Kanji.TOUS.filter((k) => k.n === n);
      for (let i = 0, j = 0; i < a.length || j < b.length;) {
        while (i < a.length && !libre(a[i])) i++;
        place(a[i++]);
        while (j < b.length && !libre(b[j])) j++;
        place(b[j++]);
      }
    }
    return ordre;
  }

  /* La grammaire commence une fois les hiraganas découverts, les sons de
     base et ceux à dakuten (が, だ, で…) : ses phrases en sont faites, ses
     furigana aussi. Les sons contractés (きょ, しゃ) se devinent d'ici là,
     et les katakanas des mots d'ailleurs viennent en même temps. */
  function grammaireOuverte() {
    return Kana.TOUS.every((it) => it.sys !== "hira" || it.famille === "youon" || commence(it));
  }

  /* Les cartes dues, les plus en retard d'abord. `grammaire` : celles de la
     grammaire, qui ont leur séance à part ; sinon toutes les autres. */
  function cartesDues(grammaire) {
    const maintenant = Date.now();
    const cartes = ETAT.cartes;
    return Object.keys(cartes)
      .filter((cle) => {
        const d = depuisCle(cle);
        return d && (d.item.type === "gram") === !!grammaire && Date.parse(cartes[cle].e) <= maintenant
          && carteActive(cle);
      })
      .sort((a, b) => Date.parse(cartes[a].e) - Date.parse(cartes[b].e));
  }

  /* Ce que la séance du jour contient : les cartes dues, ce qu'il y a à
     découvrir - jusqu'au quota du jour, plus `extra` si on en redemande -
     et les cartes qui naissent à des mots déjà vus, dans la limite du
     quota des mots : « dire », le jour où leur sens est su (trois jours
     de mémoire), et « lire », le jour où un mot appris en kanas passe en
     kanjis. Pas de grammaire : voir planGrammaire.
     -> { dues, nouveaux (kanas, kanjis et mots alternés), kanas, kanjis,
          mots, aDire, aLire, demandes (combien des mots ont été demandés
          en lisant) } */
  function planDuJour(extra) {
    extra = extra || {};
    const cartes = ETAT.cartes;
    const dues = cartesDues(false);

    // découvert aujourd'hui : sa première carte date d'après le début du
    // jour d'apprentissage. Celles du test de niveau (aucune révision)
    // n'ont rien été découvert : elles étaient déjà sues. Une carte née
    // aujourd'hui à un mot vu avant n'est pas une découverte, mais une
    // promotion.
    const debut = Date.parse(ETAT.debut);
    const deja = { kana: new Set(), kanji: new Set(), mot: new Set(), gram: new Set() };
    let promus = 0;
    Object.keys(cartes).forEach((cle) => {
      const d = depuisCle(cle);
      if (!d || !cartes[cle].n || Date.parse(cartes[cle].c) < debut) return;
      if (d.item.type === "mot" && premiereCarte(d.item) < debut) promus++;
      else deja[d.item.type].add(d.item.id);
    });
    const combien = (type) => Math.max(0, quota(type) - deja[type].size) + (extra[type] || 0);
    const kanas = Kana.TOUS.filter((it) => !commence(it)).slice(0, combien("kana"));
    // les mots demandés en lisant passent même quand le quota est atteint
    const nMots = Math.max(combien("mot"),
                           Math.min(motsDemandes().length, DEMANDES_PAR_JOUR - deja.mot.size));
    const mots = nMots > 0 ? motsADecouvrir().slice(0, nMots) : [];
    // un mot qui n'est qu'un kanji à portée (上) amène ce kanji, juste
    // avant lui, quitte à dépasser le quota des kanjis : sans lui, il
    // s'écrirait en kanas
    const amenes = quota("kanji") > 0
      ? mots.map(kanjiDuMot).filter((k) => k && !commence(k) && k.n >= niveauKanjis()) : [];
    const nKanjis = Math.max(amenes.length, combien("kanji"));
    const kanjis = nKanjis > 0 ? [...new Set([...amenes, ...kanjisADecouvrir()])].slice(0, nKanjis) : [];
    const nouveaux = [];
    for (let i = 0; i < Math.max(kanas.length, kanjis.length, mots.length); i++) {
      if (kanas[i]) nouveaux.push(kanas[i]);
      if (kanjis[i]) nouveaux.push(kanjis[i]);
      if (mots[i]) nouveaux.push(mots[i]);
    }
    // un sens « su » d'avant aujourd'hui : FSRS donne trois jours de mémoire
    // dès la première bonne réponse, et la carte « dire » d'un mot découvert
    // le matin serait née avant midi
    const suDAvant = (c) => niveau(c) >= 2 && Date.parse(c.c) < debut;
    const vuAvant = (it) => commence(it) && premiereCarte(it) < debut;
    const place = Math.max(0, quota("mot") - promus);
    const aDire = Mots.TOUS.filter((it) => !cartes[`${it.id}:dire`] && suDAvant(cartes[cleSens(it)]) && vuAvant(it))
      .slice(0, place).map((it) => `${it.id}:dire`);
    const aLire = Mots.TOUS.filter((it) => it.kanjis && !cartes[`${it.id}:lire`] && vuAvant(it) && enKanjis(it))
      .slice(0, Math.max(0, place - aDire.length)).map((it) => `${it.id}:lire`);
    return { dues, nouveaux, kanas, kanjis, mots, aDire, aLire, demandes: mots.filter(demande).length };
  }

  /* La grammaire, à part : elle ne se mêle pas à la séance du jour - une
     fiche se lit, elle ne se survole pas entre deux kanas. Comme un texte,
     elle se propose : le prochain point, et les phrases des points déjà
     étudiés qui reviennent. Elle s'ouvre une fois les hiraganas découverts
     (voir grammaireOuverte).

     Le prochain point : d'abord ceux du prochain texte à lire, dans l'ordre
     des fiches - はじめまして emploie 〜ています, qui n'arriverait qu'au
     cinquante-troisième point, et le texte attendrait deux mois. Un point
     qui renvoie à une fiche d'avant (« voir : ») la fait passer devant :
     〜ている s'appuie sur 〜てください, qui apprend la forme en て. Puis
     l'ordre des fiches, qui comble les trous en attendant le texte
     suivant. */
  function avantLui(p, vus) {
    vus = vus || new Set();
    vus.add(p);
    const avant = (p.voir || []).map((nom) => Grammaire.PAR_NOM.get(nom))
      .filter((v) => v && v.rang < p.rang && !commence(v) && !vus.has(v))
      .sort((a, b) => a.rang - b.rang);
    return avant.length ? avantLui(avant[0], vus) : p;
  }
  function gramPourTexte() {
    const t = grammaireOuverte() ? texteAVenir() : null;
    const it = t && Grammaire.TOUS.find((p) => t.points.includes(p.nom) && !commence(p));
    return it ? { point: avantLui(it), texte: t } : null;
  }
  function gramSuivant() {
    if (!grammaireOuverte()) return null;
    const pour = gramPourTexte();
    return pour ? pour.point : Grammaire.TOUS.find((it) => !commence(it)) || null;
  }
  function planGrammaire() {
    return { dues: cartesDues(true), suivant: gramSuivant() };
  }

  async function chargeEtat() {
    ETAT = await api("/api/nihongo/etat");
    cartesChangees();
    return ETAT;
  }

  /* Les traits arrivent par fichier : un pour les kanas, un par niveau de
     kanjis (celui de N1 pèse un mégaoctet, il n'est demandé que si l'on en
     est là). Chaque fichier n'est demandé qu'une fois. */
  const TRACES = {};
  const FICHIERS = new Map();
  function fichierDe(item) {
    return item.type === "kanji" ? `traces-kanji-n${item.n}.json` : "traces-kana.json";
  }
  function chargeTraces(items) {
    const noms = [...new Set(items.filter((it) => it.ecrire).map(fichierDe))];
    return Promise.all(noms.map((nom) => {
      if (!FICHIERS.has(nom)) {
        FICHIERS.set(nom, Matiere.json(nom, "Les tracés n'ont pas pu être chargés.")
          .then((d) => { Object.assign(TRACES, d.traces); })
          .catch((e) => {
            FICHIERS.delete(nom);
            throw e;
          }));
      }
      return FICHIERS.get(nom);
    }));
  }
  function traitsDe(item) {
    return item.ecrire ? TRACES[item.k] || null : null;
  }

  /* ---------- l'affichage d'un kanji ---------- */
  /* « た.べる » : た s'écrit avec le kanji, べる en kanas - en plus pâle.
     « -び », « おお- » : un suffixe, un préfixe. */
  function kunHtml(r) {
    const [tige, fin] = String(r).split(".");
    const tiret = (s) => echappe(lectureEcrite(s)).replace(/-/g, "‐");
    return tiret(tige) + (fin ? `<span class="okuri">${tiret(fin)}</span>` : "");
  }

  /* En rōmaji, les lectures on en capitales (NICHI), comme les
     dictionnaires : on les distingue des kun sans les katakanas. */
  function lecturesHtml(it, court) {
    const on = court ? it.on.slice(0, 2) : it.on;
    const kun = court ? it.kun.slice(0, 2) : it.kun;
    if (!on.length && !kun.length) return "";
    const enOn = (r) => echappe(romaji() ? Romaji.de(r).toUpperCase() : r);
    const point = romaji() ? " · " : "・";
    return `<dl class="lectures">
      ${on.length ? `<div><dt><span lang="ja">音</span> on</dt><dd lang="ja">${on.map(enOn).join(point)}</dd></div>` : ""}
      ${kun.length ? `<div><dt><span lang="ja">訓</span> kun</dt><dd lang="ja">${kun.map(kunHtml).join(point)}</dd></div>` : ""}
    </dl>`;
  }

  function sensHtml(it, combien) {
    const liste = Kanji.sens(it, combien);
    return `${liste.map(echappe).join(", ")}${it.fr.length ? "" : ' <em class="en">(en anglais)</em>'}`;
  }

  function composantsHtml(it, cliquable) {
    if (!it.c.length) return "";
    return `<p class="composants"><span class="composants-titre">Formé de</span>
      ${it.c.map(([forme, s]) => {
        const contenu = `<span class="cp-forme" lang="ja">${echappe(forme)}</span>${s ? `<span class="cp-sens">${echappe(s)}</span>` : ""}`;
        return cliquable && Kanji.PAR_CAR.has(forme)
          ? `<button type="button" class="composant" data-k="${echappe(forme)}">${contenu}</button>`
          : `<span class="composant">${contenu}</span>`;
      }).join('<span class="cp-plus" aria-hidden="true">+</span>')}</p>`;
  }

  /* Des mots courants qui l'emploient, et d'abord celui qu'il forme à lui
     seul (上 : うえ, « dessus, en haut ») : sa carte de sens est la sienne
     (voir « En kanjis, ou en kanas »). */
  function motsHtml(it) {
    const lui = motDuKanji(it);
    const mots = lui && !it.m.some(([mot]) => mot === lui.m)
      ? [[lui.m, lui.l[0], Mots.sens(lui, 3).join(", "), lui.fr.length ? 0 : 1], ...it.m] : it.m;
    if (!mots.length) return "";
    const surligne = (mot) => [...mot].map((c) => c === it.k ? `<b>${echappe(c)}</b>` : echappe(c)).join("");
    return `<ul class="mots">${mots.map(([mot, lecture, sens, en]) => `
      <li><button type="button" class="mot" data-mot="${echappe(mot)}" data-lecture="${echappe(lecture)}" aria-label="Écouter ${echappe(mot)}, ${echappe(lecture)}">
          <span class="mot-jp" lang="ja">${surligne(mot)}</span><span class="mot-kana" lang="ja">${echappe(lectureEcrite(lecture))}</span>${ICONE_SON}</button>
        <span class="mot-sens">${echappe(sens)}${en ? ' <em class="en">(en anglais)</em>' : ""}</span></li>`).join("")}</ul>`;
  }

  function brancheMots(racine) {
    racine.querySelectorAll(".mot[data-mot]").forEach((b) => b.addEventListener("click", () => {
      dire(b.dataset.mot, b.dataset.lecture);
    }));
  }

  function anneeEcole(g) {
    if (!g) return "";
    if (g <= 6) return g === 1 ? "1re année d'école" : `${g}e année d'école`;
    if (g === 8) return "collège";
    return "kanji de prénom";
  }

  /* ---------- l'affichage d'un mot ---------- */
  /* Le mot en grand : la taille suit sa longueur, 人 et コンピューター
     doivent tenir tous deux sur un téléphone - et une lettre latine est
     deux fois moins large qu'un kana. Tel que la séance l'écrit, en
     kanjis, en kanas ou en rōmaji, sauf `texte` donné. */
  function motGrand(it, classe, texte) {
    const m = texte || motEcrit(it);
    const n = Math.max(2, ECRIT_JAPONAIS.test(m) ? [...m].length : Math.ceil([...m].length * 0.55));
    return `<div class="sc-mot ${classe || ""}" lang="ja" style="--n:${n}">${echappe(m)}</div>`;
  }

  /* Ce qu'il manque à un mot écrit en kanas pour passer en kanjis :
     « quand 写 et 真 seront à ta portée ». */
  function quandHtml(it) {
    const liste = horsDePortee(it).map((c) => `<span lang="ja">${echappe(c)}</span>`);
    return `quand ${liste.length > 1 ? `${liste.slice(0, -1).join(", ")} et ${liste[liste.length - 1]} seront`
      : `${liste[0]} sera`} à ta portée`;
  }
  function plusTardHtml(it) {
    return it.kanjis && !enKanjis(it)
      ? ` · en kanjis <span lang="ja">${echappe(it.m)}</span>, ${quandHtml(it)}` : "";
  }

  function sensMotHtml(it, combien) {
    const liste = Mots.sens(it, combien);
    return `${liste.map(echappe).join(", ")}${it.fr.length ? "" : ' <em class="en">(en anglais)</em>'}`;
  }

  function dis(it) {
    dire(it.m, it.l[0]);
  }

  /* Les kanjis du mot, avec leur sens : c'est là que 日 devient に dans
     日本 et ニチ dans 毎日. */
  function kanjisDuMot(it, cliquable) {
    const ks = [...new Set([...it.m])].filter((c) => Kanji.PAR_CAR.has(c)).map((c) => Kanji.PAR_CAR.get(c));
    if (!ks.length) return "";
    return `<p class="composants mt-kanjis"><span class="composants-titre">Ses kanjis</span>
      ${ks.map((k) => {
        const contenu = `<span class="cp-forme" lang="ja">${echappe(k.k)}</span><span class="cp-sens">${echappe(Kanji.sens(k, 1)[0] || "")}</span>`;
        return cliquable ? `<button type="button" class="composant" data-k="${echappe(k.k)}">${contenu}</button>`
                         : `<span class="composant">${contenu}</span>`;
      }).join("")}</p>`;
  }

  /* Ce qu'une réponse dévoile d'un mot : sa lecture et sa voix, sa nature,
     ses sens, ses kanjis - ceux d'un mot écrit en kanas attendent leur
     tour. En rōmaji, le mot dit déjà sa lecture. Le bouton du son
     s'appelle scSon. */
  function detailMotHtml(it, options) {
    const o = options || {};
    const enK = enKanjis(it);
    const lecture = enK && o.lecture !== false && !romaji()
      ? `<span class="mt-lecture" lang="ja">${it.l.map(echappe).join(" · ")}</span>` : "";
    return `
      <div class="mt-ecoute">${lecture}${boutonSon("scSon")}</div>
      <p class="mt-nature">${echappe(Mots.nature(it))}${plusTardHtml(it)}${it.a
        ? ` · s'écrit aussi <span lang="ja">${echappe(it.a)}</span>` : ""}</p>
      <p class="sc-sens">${sensMotHtml(it)}</p>
      ${enK ? kanjisDuMot(it, o.cliquable) : ""}`;
  }

  /* La saisie d'une lecture : le rōmaji se change en kanas à mesure qu'on
     tape (voir Mots.versKana). Pas pendant une composition : le clavier
     japonais d'un téléphone fait déjà ce travail. Ni quand la page est en
     rōmaji : la réponse s'écrit comme on la lit. */
  function saisieKana(input) {
    let compose = false;
    const convertit = () => {
      if (compose || input.readOnly || romaji()) return;
      const v = Mots.versKana(input.value);
      if (v !== input.value) input.value = v;
    };
    input.addEventListener("compositionstart", () => { compose = true; });
    input.addEventListener("compositionend", () => { compose = false; convertit(); });
    input.addEventListener("input", convertit);
  }
  /* La réponse validée : en kanas, sauf en rōmaji, où elle reste comme on
     l'a tapée - les corrections la changent elles-mêmes en kanas. */
  function valideSaisie(input) {
    if (!romaji()) input.value = Mots.versKana(input.value, true);
    return input.value.trim();
  }
  /* En rōmaji, une réponse tapée comme la page l'écrit (tōkyō, toukyou ou
     tookyoo : voir Romaji.plat) est juste. */
  function commeEcrit(tape, transcriptions) {
    const t = Romaji.plat(tape);
    return romaji() && !!t && transcriptions.some((x) => Romaji.plat(x) === t);
  }
  const PRESQUE = () => (romaji() ? " Presque : attention aux voyelles longues (ō, ū…) et aux consonnes doubles."
                                  : " Presque : attention aux sons longs et aux っ.");

  /* ---------- l'affichage de la grammaire ----------
     Ses textes arrivent avec leurs furigana, {学生|がくせい}, et du
     **gras**. Le japonais glissé dans une phrase française passe dans un
     <span lang="ja">, pour avoir sa police. */
  const RUBI = /\{([^{}|]+)\|([^{}|]+)\}/g;
  const JAPONAIS = /(?:\{[^{}|]+\|[^{}|]+\}|[ぁ-ゖァ-ヺー〜々・「」『』。、？！（）]|[㐀-鿿])+/g;
  const enRubis = (s) => s.replace(RUBI, (m, base, lu) => `<ruby class="f">${base}<rt>${lu}</rt></ruby>`);
  /* Du japonais seul : une phrase, un motif. */
  function rubis(texte) {
    return enRubis(echappe(texte));
  }
  /* Les textes et les phrases de la grammaire s'écrivent comme la séance
     (voir « En kanjis, ou en kanas ») : un groupe de furigana dont un
     kanji est hors de portée laisse la place à sa lecture. `repli` : le
     niveau d'un kanji hors des listes, celui du texte. */
  function kanaise(balise, repli) {
    return String(balise || "").replace(RUBI, (tout, base, lu) =>
      ([...base].some((c) => KANJI_CAR.test(c) && !aPortee(c, repli)) ? lu : tout));
  }
  /* En rōmaji, chaque morceau de japonais glissé dans un texte - le gras
     (**) en son milieu compris - prend sa transcription de romaji.json : la
     même découpe que FRAGMENT_JAPONAIS dans nihongo.py. À défaut (le
     fichier n'est pas arrivé), celle de ses kanas, sans les espaces entre
     les mots. */
  const J = String.raw`\{[^{}|]+\|[^{}|]+\}|[ぁ-ゖァ-ヺー〜々・「」『』。、？！（）]|[㐀-鿿]`;
  const FRAGMENT = new RegExp(`(?:${J})(?:${J}|\\*\\*(?=(?:${J})))*`, "g");
  function roTexte(texte) {
    return String(texte || "").replace(FRAGMENT, (m) => TRANSCRITS.fragments[m]
      || Romaji.de(Grammaire.lecture(m.replace(/\*\*/g, ""))));
  }
  /* Du japonais à lire : une phrase, un titre de texte. `ecritJaponais`
     l'écrit toujours en kanas et en kanjis (le test de niveau). */
  function ecritJaponais(texte, repli) {
    return rubis(kanaise(texte, repli));
  }
  function enJaponais(texte, repli) {
    return romaji() ? echappe(roTexte(texte)) : ecritJaponais(texte, repli);
  }
  function titreHtml(t) {
    return romaji() ? echappe(Romaji.capitale(roTexte(t.titre))) : enJaponais(t.titre, t.n);
  }
  /* Du français, avec du japonais dedans. */
  function texteHtml(texte) {
    const html = echappe(romaji() ? roTexte(texte) : texte).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return romaji() ? html : html.replace(JAPONAIS, (m) => `<span lang="ja">${enRubis(m)}</span>`);
  }

  /* L'explication d'un point : paragraphes, listes, tableaux, remarques. */
  function blocsHtml(blocs) {
    return blocs.map((b) => {
      if (b.p) return `<p>${texteHtml(b.p)}</p>`;
      if (b.note) return `<p class="gr-note">${texteHtml(b.note)}</p>`;
      if (b.l) return `<ul>${b.l.map((x) => `<li>${texteHtml(x)}</li>`).join("")}</ul>`;
      if (b.t) {
        const [tete, ...lignes] = b.t;
        return `<div class="gr-tableau"><table>
          <thead><tr>${tete.map((c) => `<th>${texteHtml(c)}</th>`).join("")}</tr></thead>
          <tbody>${lignes.map((l) => `<tr>${l.map((c) => `<td>${texteHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody>
        </table></div>`;
      }
      return "";
    }).join("");
  }

  /* Le motif, son sens, ses constructions. */
  /* Le motif d'un point, et la précision qui le distingue d'un motif pareil
     (〜で, le moyen) : en français, plus petite. `toujours` la garde même
     quand le sens, affiché à côté, la dit déjà. */
  function motifHtml(it, toujours) {
    const { motif, precision } = Grammaire.decoupeTitre(it, toujours);
    const ecrit = romaji() ? echappe(roTexte(motif)) : rubis(motif).replace(/・/g, "・<wbr>");
    return `<span class="gr-motif" lang="ja">${ecrit}</span>${precision
      ? ` <span class="gr-precision">${texteHtml(precision)}</span>` : ""}`;
  }

  /* Un point en quelques signes, pour un bouton : son titre sans furigana. */
  function motifCourt(it) {
    return romaji() ? roTexte(it.titre) : it.court;
  }

  function enteteGramHtml(it, id) {
    return `
      <h2 class="gr-titre"${id ? ` id="${id}"` : ""}>${motifHtml(it)}</h2>
      <p class="gr-sens">${texteHtml(it.sens)}</p>
      ${it.formes.length ? `<ul class="gr-formes">${it.formes.map((f) => `<li>${texteHtml(f)}</li>`).join("")}</ul>` : ""}`;
  }

  /* Une phrase d'exemple : avec son trou (et ce qu'il montre, s'il montre
     quelque chose), ou remplie - `etat` vaut alors « juste », « faux » ou
     « montre ». */
  function phraseHtml(ex, etat) {
    if (romaji()) {
      const ro = roPhrase(ex);
      const trou = etat ? `<mark class="gr-rempli gr-${etat}">${echappe(ro.t)}</mark>`
        : `<span class="gr-trou" style="--n:${Math.max(2, Math.ceil(ro.t.length * 0.55))}">${
          ro.i ? `(${echappe(ro.i)})` : ""}</span>`;
      return `${echappe(ro.a)}${trou}${echappe(ro.p)}`;
    }
    const milieu = etat
      ? `<mark class="gr-rempli gr-${etat}">${enJaponais(ex.t)}</mark>`
      : `<span class="gr-trou" style="--n:${[...ex.r[0]].length}">${ex.i ? `（${enJaponais(ex.i)}）` : ""}</span>`;
    return `${enJaponais(ex.a)}${milieu}${enJaponais(ex.p)}`;
  }

  /* Une phrase à trou en rōmaji : avant, le trou, après, ce que montre le
     trou, les autres réponses (voir Romaniseur.exemple dans nihongo.py). */
  function roPhrase(ex) {
    const lu = (s) => Romaji.de(Grammaire.lecture(s || ""));
    return TRANSCRITS.phrases[ex.son]
      || { a: lu(ex.a), t: lu(ex.t), p: lu(ex.p), i: ex.i ? lu(ex.i) : "", r: ex.r.slice(1).map((r) => Romaji.de(r)) };
  }

  function exempleHtml(ex, i) {
    return `<li class="gr-ex">
      <button type="button" class="gr-ex-son" data-ex="${i}" aria-label="Écouter la phrase">${ICONE_SON}</button>
      <div>
        <p class="gr-phrase" lang="ja">${phraseHtml(ex, "montre")}</p>
        <p class="gr-ex-fr">${echappe(ex.fr)}</p>
      </div>
    </li>`;
  }
  function brancheExemples(racine, it) {
    racine.querySelectorAll("[data-ex]").forEach((b) => b.addEventListener("click", () => {
      direPhrase(it.ex[+b.dataset.ex]);
    }));
  }
  function direPhrase(ex) {
    Voix.ditPhrase(ex.son, Grammaire.surface(Grammaire.phrase(ex)), () => toast(SANS_VOIX, true));
  }

  /* Les furigana : montrés, ou cachés - un mot touché (ou survolé) montre
     alors les siens. Réglé sur cet appareil, pour toute la grammaire. */
  function furigana() {
    return Pref.lit("furigana", true) !== false;
  }
  function appliqueFurigana() {
    document.documentElement.classList.toggle("sans-furigana", !furigana());
  }
  /* `toujours` : même en rōmaji, où il n'y a pas de furigana à montrer (la
     page des paramètres). */
  function reglageFurigana(toujours) {
    if (romaji() && !toujours) return "";
    return `<div class="segment segment-petit" role="radiogroup" aria-label="Furigana">
      <button type="button" role="radio" data-furigana="1" aria-checked="${furigana()}">Furigana</button>
      <button type="button" role="radio" data-furigana="0" aria-checked="${!furigana()}">Sans</button>
    </div>`;
  }
  function brancheFurigana(racine) {
    racine.querySelectorAll("[data-furigana]").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("furigana", b.dataset.furigana === "1");
      appliqueFurigana();
      racine.querySelectorAll("[data-furigana]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    }));
  }
  document.addEventListener("click", (e) => {
    const r = e.target.closest && e.target.closest("ruby.f");
    // la liseuse a ses propres furigana (voir furiganaLecture)
    if (r && !furigana() && !r.closest(".ls-texte")) r.classList.toggle("vu");
  });

  /* =====================================================================
     Les rubriques
     ===================================================================== */
  const RUBRIQUES = {
    "": vueAujourdhui,
    kana: vueKana,
    kanji: vueKanji,
    vocabulaire: vueVocabulaire,
    lecture: vueLecture,
    grammaire: vueGrammaire,
    progres: vueProgres,
    parametres: vueParametres,
  };

  function rubrique() {
    const m = /^\/nihongo\/?([a-z]*)/.exec(location.pathname);
    return m && Object.prototype.hasOwnProperty.call(RUBRIQUES, m[1]) ? m[1] : "";
  }

  /* `requete` : la suite de l'adresse, « ?t=hajimemashite » pour un texte. */
  function va(nom, requete) {
    const adresse = "/nihongo" + (nom ? "/" + nom : "") + (requete || "");
    if (location.pathname + location.search !== adresse) history.pushState(null, "", adresse);
    rend();
    window.scrollTo(0, 0);
  }

  function rend() {
    const nom = rubrique();
    document.querySelectorAll("#onglets a").forEach((a) => {
      if (a.dataset.rubrique === nom) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    // l'onglet courant reste visible quand la barre défile, sur téléphone
    const courant = document.querySelector('#onglets a[aria-current="page"]');
    if (courant && courant.scrollIntoView) courant.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!ETAT) return;
    quitteLiseuse();
    RUBRIQUES[nom]($("vue"));
  }

  $("onglets").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-rubrique]");
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return;
    e.preventDefault();
    va(a.dataset.rubrique);
  });
  addEventListener("popstate", rend);

  /* =====================================================================
     今日 - Aujourd'hui
     ===================================================================== */
  const JOURS_JP = "日月火水木金土";

  /* Le salut de l'heure, en japonais ou en rōmaji, sans traduction : on le
     lit tous les jours, il finit par se savoir. */
  function salut() {
    const h = new Date().getHours();
    const s = h >= 4 && h < 10 ? ["おはようございます", "ohayō gozaimasu"]
      : h >= 10 && h < 18 ? ["こんにちは", "konnichiwa"] : ["こんばんは", "konbanwa"];
    return romaji() ? Romaji.capitale(s[1]) : s[0];
  }

  function dateJaponaise(d) {
    if (romaji()) return Romaji.date(d);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${JOURS_JP[d.getDay()]}）`;
  }

  function chiffre(jp, valeur, legende, classe) {
    return `<div class="chiffre ${classe || ""}">
      <span class="chiffre-jp" lang="ja">${jp}</span>
      <span class="chiffre-valeur">${valeur}</span>
      <span class="chiffre-legende">${legende}</span>
    </div>`;
  }

  const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;

  function vueAujourdhui(vue) {
    const plan = planDuJour();
    const j = ETAT.aujourdhui;
    const maintenant = new Date();
    const precision = j.revisions ? Math.round(100 * j.justes / j.revisions) + " %" : "–";
    const aReviser = plan.dues.length + plan.aDire.length + plan.aLire.length;
    const total = aReviser + plan.nouveaux.length;
    // une découverte prend une minute ou plus (présentation, tracé guidé,
    // deux cartes) ; une révision, une dizaine de secondes
    const minutes = Math.max(1, Math.round((aReviser * 10 + plan.kanas.length * 60 + plan.kanjis.length * 90
                                            + plan.mots.length * 45) / 60));
    const fait = total === 0 && j.revisions > 0;
    const reste = {
      kana: Kana.TOUS.some((it) => !commence(it)),
      kanji: Kanji.TOUS.some((it) => !commence(it)),
      mot: Mots.TOUS.some((it) => !commence(it)),
    };
    // pas encore une carte : le test de niveau se propose en grand
    const premierJour = !Object.keys(ETAT.cartes).length;

    // les révisions en une ligne, puis ce qu'il y a à découvrir, une ligne
    // par sorte - chaque élément ouvre sa fiche
    const apercus = new Map();
    // un mot dont le kanji vient dans la même séance s'écrira en kanji
    const prevus = new Set(plan.kanjis);
    const ecrit = (it) => it.k || (romaji() ? Romaji.mot(it) : prevus.has(kanjiDuMot(it)) ? it.m : graphie(it));
    // chaque élément a sa langue : en rōmaji, les mots passent en latin, les kanas restent
    const apercu = (liste) => `<span class="apercu-kanas" lang="ja">${liste.map((it) => {
      apercus.set(it.id, it);
      return `<button type="button" class="apercu-el" lang="ja" data-apercu="${echappe(it.id)}">${echappe(ecrit(it))}</button>`;
    }).join("")}</span>`;
    const nouveautes = [];
    const ligne = (liste, nom, plus) => `<li><span class="seance-sorte"><strong>${liste.length}</strong>
      ${nom}${liste.length > 1 ? "s" : ""}${plus || ""}</span>${apercu(liste)}</li>`;
    if (plan.kanas.length) nouveautes.push(ligne(plan.kanas, "kana"));
    if (plan.kanjis.length) nouveautes.push(ligne(plan.kanjis, "kanji"));
    if (plan.mots.length) {
      nouveautes.push(ligne(plan.mots, "mot", plan.demandes
        ? ` <span class="seance-dont">dont ${plan.demandes} demandé${plan.demandes > 1 ? "s" : ""} en lisant</span>` : ""));
    }
    let revisions = aReviser
      ? `<strong>${aReviser}</strong> révision${aReviser > 1 ? "s" : ""}` : "Aucune révision";
    const premieres = [];
    if (plan.aDire.length) {
      premieres.push(`${pluriel(plan.aDire.length, "mot")} à retrouver pour la première fois depuis le français`);
    }
    if (plan.aLire.length) {
      premieres.push(`${pluriel(plan.aLire.length, "mot")} à lire pour la première fois en kanjis`);
    }
    if (premieres.length) revisions += `, dont ${premieres.join(" et ")}`;
    // les mots demandés en lisant qui attendent encore : on peut y renoncer
    const enAttente = motsDemandes().length;
    const demandesHtml = enAttente ? `<p class="seance-demandes">${enAttente > 1
      ? `${enAttente} mots demandés en lisant attendent` : "Un mot demandé en lisant attend"} leur tour, ${
      DEMANDES_PAR_JOUR} par jour au plus. <button type="button" class="btn-lien" id="annuleDemandes">Ne plus
      ${enAttente > 1 ? "les" : "le"} demander</button></p>` : "";

    let seance;
    if (total > 0) {
      seance = `
        <div class="seance-texte">
          <h2 class="seance-titre">La séance du jour</h2>
          <p>${revisions}${nouveautes.length ? ", et à découvrir :" : "."}</p>
          ${nouveautes.length ? `<ul class="seance-nouveaux">${nouveautes.join("")}</ul>` : ""}
          <p class="seance-duree">Environ ${pluriel(minutes, "minute")}.</p>
          ${demandesHtml}
        </div>
        <button class="btn btn-grand" id="lance">始め <span>Commencer</span></button>`;
    } else {
      seance = `
        <div class="seance-texte">
          <h2 class="seance-titre">${fait ? "Séance faite" : "Rien à réviser"}</h2>
          <p>${fait ? "Tout ce qui devait revenir aujourd'hui est revu. La suite arrive demain matin, à partir de 4 h."
                    : "Aucune carte n'attend. La prochaine reviendra d'elle-même."}</p>
          <div class="seance-encore">
            ${reste.kana ? `<button class="btn btn-second" id="encoreKana">${QUOTAS.kana.defaut} kanas de plus</button>` : ""}
            ${reste.kanji ? `<button class="btn btn-second" id="encoreKanji">${QUOTAS.kanji.defaut} kanjis de plus</button>` : ""}
            ${reste.mot ? `<button class="btn btn-second" id="encoreMot">${QUOTAS.mot.defaut} mots de plus</button>` : ""}
          </div>
          ${demandesHtml}
        </div>
        ${fait ? `<div class="tampon tampon-pose" aria-label="Séance terminée"><span lang="ja">済</span></div>` : ""}`;
    }

    vue.innerHTML = `
      <section class="accueil-tete">
        <div>
          <p class="date"><span lang="ja">${dateJaponaise(maintenant)}</span></p>
          <h1 class="salut"><span lang="ja">${salut()}</span></h1>
        </div>
        <p class="devise" lang="ja" aria-hidden="true">毎日少しずつ</p>
      </section>

      <div class="chiffres">
        ${chiffre("連続", ETAT.serie, `jour${ETAT.serie > 1 ? "s" : ""} d'affilée`, ETAT.serie ? "chiffre-serie" : "")}
        ${chiffre("復習", aReviser, "à réviser")}
        ${chiffre("新規", plan.nouveaux.length, "à découvrir")}
        ${chiffre("正解", precision, "de justes aujourd'hui")}
      </div>

      <div class="accueil-cartes">
        ${premierJour ? testAccueilHtml() : ""}
        <section class="feuille seance">${seance}</section>
        ${gramCarteHtml("À étudier")}
        ${aLireHtml()}
      </div>

      <section class="programme">
        <h2 class="section-titre"><span lang="ja">道</span> Le chemin</h2>
        <ol class="etapes">
          ${etapeProgramme("仮名", "Les kanas", "Hiragana et katakana : les lire, les écrire, trait par trait.", "kana")}
          ${etapeProgramme("漢字", "Les kanjis", "Du N5 au N1 : leur sens, leurs lectures, leurs traits, et des mots courants.", "kanji")}
          ${etapeProgramme("単語", "Le vocabulaire", "Les mots du JLPT : les comprendre, les lire, puis les retrouver depuis le français.", "vocabulaire")}
          ${etapeProgramme("文法", "La grammaire", "Des fiches courtes en français, et des phrases à compléter, à ton rythme.", "grammaire")}
          ${etapeProgramme("読解", "La lecture", "Des textes à ta portée, du dialogue au conte et à l'article : chaque mot se touche, chaque phrase s'écoute.", "lecture")}
        </ol>
        ${premierJour ? "" : `<p class="programme-test">Tu en sais plus que ce chemin ne le montre ?
          <button type="button" class="btn-lien" data-test>Passer le test de niveau</button></p>`}
      </section>`;

    const lance = $("lance");
    if (lance) lance.addEventListener("click", () => lanceSeance());
    vue.querySelectorAll("[data-apercu]").forEach((b) => b.addEventListener("click", () => {
      ouvreFicheDe(apercus.get(b.dataset.apercu), b);
    }));
    const encoreKana = $("encoreKana");
    if (encoreKana) encoreKana.addEventListener("click", () => lanceSeance({ kana: QUOTAS.kana.defaut }));
    const encoreKanji = $("encoreKanji");
    if (encoreKanji) encoreKanji.addEventListener("click", () => lanceSeance({ kanji: QUOTAS.kanji.defaut }));
    const encoreMot = $("encoreMot");
    if (encoreMot) encoreMot.addEventListener("click", () => lanceSeance({ mot: QUOTAS.mot.defaut }));
    const annuleDemandes = $("annuleDemandes");
    if (annuleDemandes) {
      annuleDemandes.addEventListener("click", async () => {
        if (await demandeMots(motsDemandes().map((it) => it.id), false)) rend();
      });
    }
    vue.querySelectorAll(".etape a").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      va(a.dataset.rubrique);
    }));
    brancheALire(vue);
    brancheGram(vue);
    vue.querySelectorAll("[data-test]").forEach((b) => b.addEventListener("click", lanceTest));
  }

  /* Le niveau en cours, de kanjis, de mots ou de grammaire : le premier
     qui n'est pas entièrement su. */
  function niveauEnCours(module, genre) {
    for (const n of module.NIVEAUX) {
      const liste = module.TOUS.filter((it) => it.n === n);
      const sus = liste.filter((it) => niveauDe(it, genre || "sens") >= 2).length;
      if (sus < liste.length) return { n, sus, total: liste.length };
    }
    return null;
  }

  function etapeProgramme(jp, nom, texte, rub) {
    let detail;
    if (rub === "kana") {
      const n = Kana.TOUS.filter((it) => niveauDe(it, "lire") >= 2).length;
      detail = `<span class="etape-etat">${n} / ${Kana.TOUS.length} sus</span>`;
    } else if (rub === "kanji" || rub === "vocabulaire") {
      const en = niveauEnCours(rub === "kanji" ? Kanji : Mots);
      detail = `<span class="etape-etat">${en ? `N${en.n} : ${en.sus} / ${en.total} sus` : "tous sus"}</span>`;
    } else if (rub === "grammaire") {
      const en = niveauEnCours(Grammaire, "completer");
      detail = `<span class="etape-etat">${!grammaireOuverte() ? "après les hiraganas"
        : en ? `N${en.n} : ${en.sus} / ${en.total} sus` : "tous sus"}</span>`;
    } else if (rub === "lecture") {
      const n = (texteAVenir() || Lecture.TEXTES[Lecture.TEXTES.length - 1] || {}).n;
      const duNiveau = Lecture.TEXTES.filter((t) => t.n === n);
      detail = `<span class="etape-etat">${duNiveau.length
        ? `N${n} : ${duNiveau.filter(estLu).length} / ${duNiveau.length} lus` : "bientôt"}</span>`;
    }
    return `<li class="etape">
      <a href="/nihongo/${rub}" data-rubrique="${rub}">
        <span class="etape-jp" lang="ja">${jp}</span>
        <span class="etape-texte"><strong>${nom}</strong><span>${texte}</span></span>
        ${detail}
      </a></li>`;
  }

  /* =====================================================================
     La séance
     =====================================================================
     Une file d'étapes. Les révisions dues sont mélangées ; chaque nouveau
     kana ou kanji y entre par sa découverte, toutes les deux révisions, et
     ses deux cartes le suivent quelques étapes plus loin - assez loin pour
     qu'il faille s'en souvenir, assez près pour que ce soit encore frais.
     Une carte ratée revient trois étapes plus tard, deux fois au plus : au
     troisième échec, s'acharner n'apprend plus rien, et le serveur la
     ramène de toute façon dix minutes après. */
  const REPRISES = 2;
  let SEANCE = null;

  async function lanceSeance(extra) {
    const plan = planDuJour(extra);
    const revues = melange([...plan.dues, ...plan.aDire, ...plan.aLire].map(carteDe));
    try {
      await chargeTraces([...revues.map((e) => e.item), ...plan.nouveaux]);
    } catch (e) { toast(e.message, true); return; }
    const file = [];
    const nouveaux = plan.nouveaux.slice();
    while (revues.length || nouveaux.length) {
      if (nouveaux.length) file.push({ genre: "decouverte", item: nouveaux.shift() });
      file.push(...revues.splice(0, nouveaux.length ? 2 : revues.length));
    }
    ouvreSeance(file, "jour");
  }

  /* La séance de grammaire : la leçon d'un point, s'il y en a un - sa
     fiche, puis deux de ses phrases, l'une tout de suite, l'autre en fin
     de séance - et les phrases des points déjà étudiés qui reviennent. */
  function lanceGrammaire(item) {
    const revues = melange(cartesDues(true).map(carteDe));
    ouvreSeance(item && !commence(item) ? [{ genre: "decouverte", item }, ...revues] : revues, "gram");
  }

  /* `genre` : « jour » ou « gram », pour la fin (voir finSeance). */
  function ouvreSeance(file, genre) {
    if (!file.length) return;
    // decouverts, rates : pour le bilan de la fin, chaque élément vers sa fiche
    SEANCE = { file, genre, faites: 0, justes: 0, notees: 0, debut: Date.now(), courante: null,
               decouverts: new Map(), rates: new Map() };
    $("seance").hidden = false;
    document.body.classList.add("en-seance");
    etape();
  }

  function insere(e, distance) {
    SEANCE.file.splice(Math.min(distance, SEANCE.file.length), 0, e);
  }

  /* Une carte ratée revient un peu plus loin, tant qu'il lui reste des
     reprises. */
  function reprend(e) {
    const essais = (e.essais || 0) + 1;
    if (essais <= REPRISES) insere(Object.assign({}, e, { essais }), 3);
  }

  function majJauge() {
    const total = SEANCE.faites + SEANCE.file.length + (SEANCE.courante ? 1 : 0);
    const part = total ? SEANCE.faites / total : 1;
    $("scJauge").style.width = (part * 100).toFixed(1) + "%";
    $("scCompte").textContent = `${SEANCE.faites} / ${total}`;
  }

  function etape() {
    // une carte qui ne sert plus depuis le début de la séance : le sens de
    // まえ, quand on vient de découvrir le kanji 前 qui le porte
    while (SEANCE.file.length && SEANCE.file[0].cle && !carteActive(SEANCE.file[0].cle)) SEANCE.file.shift();
    const e = SEANCE.file.shift();
    SEANCE.courante = e || null;
    majJauge();
    if (!e) { finSeance(); return; }
    e.debut = Date.now();
    const scene = $("scScene");
    scene.classList.remove("entree");
    void scene.offsetWidth;      // relance l'animation d'entrée
    scene.classList.add("entree");
    RENDUS[e.item.type][e.genre](e);
  }

  function suivante() {
    SEANCE.faites++;
    SEANCE.courante = null;
    etape();
  }

  /* La réponse part tout de suite. Un échec réseau ne bloque pas la
     séance : la carte n'avance simplement pas, et reviendra. */
  async function note(e, valeur) {
    SEANCE.notees++;
    if (valeur > 1) SEANCE.justes++;
    else SEANCE.rates.set(e.item.id, e.item);
    const secondes = Math.round((Date.now() - e.debut) / 1000);
    try {
      const r = await api("/api/nihongo/reponse", "POST", { cle: e.cle, note: valeur, secondes });
      ETAT.cartes[r.cle] = r.carte;
      cartesChangees();
      ETAT.aujourdhui = r.aujourdhui;
      ETAT.serie = r.serie;
    } catch (err) {
      toast("Réponse non enregistrée : " + err.message, true);
    }
  }

  function genreLabel(e) {
    if (e.item.type === "mot") return `mot N${e.item.n}`;
    if (e.item.type === "gram") return `grammaire N${e.item.n}`;
    return e.item.type === "kanji" ? `kanji N${e.item.n}` : Kana.NOMS[e.item.sys].fr;
  }

  /* La fin d'une découverte : ses deux cartes, un peu plus loin. Un
     point de grammaire n'en a qu'une, travaillée deux fois : une phrase
     tout de suite, une autre en fin de séance. */
  function apresDecouverte(it) {
    SEANCE.decouverts.set(it.id, it);
    const [premiere, seconde] = clesDe(it);
    if (it.type === "gram") {
      insere(carteDe(premiere), 0);
      SEANCE.file.push(carteDe(premiere));
    } else {
      insere(carteDe(premiere), 2);
      if (seconde) insere(carteDe(seconde), 5);
    }
    suivante();
  }

  /* Le tracé guidé d'une découverte : la démonstration, puis à soi. */
  function guideHtml() {
    return `
      <div class="sc-guide">
        <div class="tr-hote" id="scTrace"></div>
        <div class="sc-guide-texte">
          <p class="sc-consigne" id="scConsigne">Regarde l'ordre des traits, puis trace en suivant le modèle. Le point rouge marque le départ.</p>
          <button type="button" class="btn-lien" id="scRevoir">Revoir l'ordre des traits</button>
        </div>
      </div>`;
  }
  function brancheGuide(it, traits) {
    const t = Trace.monte($("scTrace"), {
      traits, mode: "guide", etiquette: `Tracer ${it.k}`,
      surTrait: (r) => {
        if (!r.ok) $("scConsigne").textContent = r.message;
        else if (r.rang < traits.length) $("scConsigne").textContent = `Trait ${r.rang} sur ${traits.length}.`;
      },
      surFin: () => {
        $("scConsigne").textContent = "C'est ça. Il reviendra tout à l'heure, sans modèle.";
        $("scSuivant").textContent = "Continuer";
        $("scSuivant").focus();
      },
    });
    t.anime();
    $("scRevoir").addEventListener("click", () => t.anime());
  }

  function rendDecouverte(e) {
    const it = e.item;
    const traits = traitsDe(it);
    $("scScene").innerHTML = `
      <div class="carte-seance">
        <p class="sc-genre"><span class="sc-marque" lang="ja">新</span> Nouveau · ${genreLabel(e)}</p>
        <div class="sc-presentation">
          <div class="sc-glyphe" lang="ja">${echappe(it.k)}</div>
          <div class="sc-lecture">
            <p class="sc-romaji">${echappe(it.r)}</p>
            ${boutonSon("scSon")}
          </div>
        </div>
        ${it.note ? `<p class="sc-note">${echappe(it.note)}</p>` : ""}
        ${traits ? guideHtml() : ""}
        <div class="sc-actions">
          <button type="button" class="btn" id="scSuivant">${traits ? "Passer" : "Continuer"}</button>
        </div>
      </div>`;
    brancheSon("scSon", it.k);
    Voix.dit(it.k);
    if (traits) brancheGuide(it, traits);
    $("scSuivant").addEventListener("click", () => apresDecouverte(it));
    if (!traits) $("scSuivant").focus();
  }

  function rendDecouverteKanji(e) {
    const it = e.item;
    const traits = traitsDe(it);
    $("scScene").innerHTML = `
      <div class="carte-seance">
        <p class="sc-genre"><span class="sc-marque" lang="ja">新</span> Nouveau · ${genreLabel(e)}</p>
        <div class="sc-presentation">
          <div class="sc-glyphe" lang="ja">${echappe(it.k)}</div>
          <div class="sc-lecture sc-kanji-infos">
            <p class="sc-sens">${sensHtml(it, 4)}</p>
            ${lecturesHtml(it, true)}
          </div>
        </div>
        ${composantsHtml(it, false)}
        ${motsHtml(it)}
        ${traits ? guideHtml() : ""}
        <div class="sc-actions">
          <button type="button" class="btn" id="scSuivant">${traits ? "Passer" : "Continuer"}</button>
        </div>
      </div>`;
    brancheMots($("scScene"));
    if (traits) brancheGuide(it, traits);
    $("scSuivant").addEventListener("click", () => apresDecouverte(it));
    if (!traits) $("scSuivant").focus();
  }

  /* La question juste au-dessus du champ, et la langue de la réponse en
     pastille : voir « dans quelle langue on répond » dans nihongo.css. La
     carte porte tache-jp ou tache-fr, son champ data-langue. */
  function tacheHtml(question, langue) {
    return `<p class="sc-tache">${question} <span class="sc-tache-langue">${langue}</span></p>`;
  }

  function rendLire(e) {
    const it = e.item;
    $("scScene").innerHTML = `
      <div class="carte-seance tache-jp">
        <p class="sc-genre"><span class="sc-marque" lang="ja">読</span> Lecture · ${genreLabel(e)}</p>
        <div class="sc-glyphe sc-glyphe-seul" lang="ja">${echappe(it.k)}</div>
        ${tacheHtml("Comment se lit-il ?", "en rōmaji")}
        <form class="sc-reponse" id="scForm" autocomplete="off" data-langue="JP">
          <input id="scSaisie" class="sc-saisie" autocapitalize="none" autocorrect="off"
                 spellcheck="false" enterkeyhint="done" aria-label="La lecture, en rōmaji" placeholder="en rōmaji">
          <button class="btn" type="submit" id="scValider">Valider</button>
        </form>
        <p class="sc-retour" id="scRetour" aria-live="polite"></p>
      </div>`;
    const saisie = $("scSaisie");
    saisie.focus();
    let repondu = false, minuteur = null;
    $("scForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (repondu) { clearTimeout(minuteur); suivante(); return; }
      repondu = true;
      const juste = Kana.accepte(it, saisie.value);
      const tape = Kana.normalise(saisie.value);
      saisie.readOnly = true;
      saisie.classList.add(juste ? "juste" : "faux");
      Voix.dit(it.k);
      $("scRetour").innerHTML = juste
        ? `<span class="verdict verdict-juste">正解</span> <span lang="ja">${echappe(it.k)}</span> se lit « ${echappe(it.r)} ».`
        : `<span class="verdict verdict-faux">${tape ? "残念" : "?"}</span> <span lang="ja">${echappe(it.k)}</span> se lit « <strong>${echappe(it.r)}</strong> »${tape ? `, pas « ${echappe(tape)} »` : ""}. Il reviendra dans un instant.`;
      $("scValider").textContent = "Continuer";
      $("scValider").focus();
      note(e, juste ? 3 : 1);
      if (juste) minuteur = setTimeout(() => { if (SEANCE && SEANCE.courante === e) suivante(); }, 1100);
      else reprend(e);
    });
  }

  /* Le sens d'un kanji ou d'un mot, tapé en toutes lettres. La réponse
     dévoile tout : les sens, les lectures, des mots ou des kanjis - c'est
     là qu'il s'apprend. Une réponse refusée attend qu'on passe à la suite
     pour être notée : « J'avais bon » peut encore la changer, pour un
     synonyme que le dictionnaire ne connaît pas. */
  function rendSens(e) {
    const it = e.item;
    const mot = it.type === "mot";
    $("scScene").innerHTML = `
      <div class="carte-seance tache-fr">
        <p class="sc-genre"><span class="sc-marque" lang="ja">意</span> Sens · ${genreLabel(e)}</p>
        ${mot ? motGrand(it) : `<div class="sc-glyphe sc-glyphe-seul" lang="ja">${echappe(it.k)}</div>`}
        ${mot && homographe(it) && enKanjis(it) && !romaji() ? `<p class="sc-precision" lang="ja">${echappe(it.l[0])}</p>` : ""}
        ${tacheHtml(`Que veut dire ce ${mot ? "mot" : "kanji"} ?`, "en français")}
        <form class="sc-reponse" id="scForm" autocomplete="off" data-langue="FR">
          <input id="scSaisie" class="sc-saisie sc-saisie-sens" autocapitalize="none" autocorrect="off"
                 spellcheck="false" enterkeyhint="done" aria-label="Son sens, en français" placeholder="son sens, en français">
          <button class="btn" type="submit" id="scValider">Valider</button>
        </form>
        <p class="sc-retour" id="scRetour" aria-live="polite"></p>
        <div class="sc-detail" id="scDetail" hidden></div>
        <div class="sc-actions" id="scApres" hidden>
          <button type="button" class="btn-lien" id="scBon">J'avais bon</button>
          <button type="button" class="btn" id="scSuivant">Continuer</button>
        </div>
      </div>`;
    const saisie = $("scSaisie");
    saisie.focus();
    let repondu = false, enAttente = false;
    function continuer() {
      if (enAttente) { enAttente = false; note(e, 1); reprend(e); }
      suivante();
    }
    $("scForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (repondu) { continuer(); return; }
      repondu = true;
      const tape = saisie.value.trim();
      const juste = accepteSens(it, tape);
      saisie.readOnly = true;
      saisie.classList.add(juste ? "juste" : "faux");
      $("scRetour").innerHTML = juste
        ? `<span class="verdict verdict-juste">正解</span> C'est ça.`
        : `<span class="verdict verdict-faux">${tape ? "残念" : "?"}</span> ${tape ? `Pas « ${echappe(tape)} ».` : "Voici ce qu'il veut dire."}`;
      if (mot) {
        $("scDetail").innerHTML = detailMotHtml(it);
        $("scSon").addEventListener("click", () => dis(it));
        dis(it);
      } else {
        $("scDetail").innerHTML = `
          <p class="sc-sens">${sensHtml(it)}</p>
          ${lecturesHtml(it)}
          ${motsHtml(it)}`;
        brancheMots($("scDetail"));
      }
      $("scDetail").hidden = false;
      $("scValider").hidden = true;
      $("scApres").hidden = false;
      $("scBon").hidden = juste || !tape;
      if (juste) note(e, 3);
      else enAttente = true;
      $("scSuivant").focus();
    });
    $("scSuivant").addEventListener("click", continuer);
    $("scBon").addEventListener("click", () => {
      enAttente = false;
      note(e, 3);
      suivante();
    });
  }

  /* La découverte d'un mot : tout ce qu'il faut pour le reconnaître, et sa
     voix. Ses cartes suivent quelques étapes plus loin. */
  function rendDecouverteMot(e) {
    const it = e.item;
    $("scScene").innerHTML = `
      <div class="carte-seance">
        <p class="sc-genre"><span class="sc-marque" lang="ja">新</span> Nouveau · ${genreLabel(e)}</p>
        ${motGrand(it)}
        <div class="sc-detail">${detailMotHtml(it)}</div>
        <div class="sc-actions">
          <button type="button" class="btn" id="scSuivant">Continuer</button>
        </div>
      </div>`;
    $("scSon").addEventListener("click", () => dis(it));
    dis(it);
    $("scSuivant").addEventListener("click", () => apresDecouverte(it));
    $("scSuivant").focus();
  }

  /* La lecture d'un mot à kanjis : 食べる -> たべる. Le rōmaji devient des
     kanas pendant la frappe ; toutes les lectures du mot sont acceptées
     (今日 : きょう ou こんにち). Le mot reste en kanjis même quand la page
     est en rōmaji : c'est eux qu'on apprend à lire. */
  function rendLireMot(e) {
    const it = e.item;
    $("scScene").innerHTML = `
      <div class="carte-seance tache-jp">
        <p class="sc-genre"><span class="sc-marque" lang="ja">読</span> Lecture · ${genreLabel(e)}</p>
        ${motGrand(it, "", graphie(it))}
        ${homographe(it) ? `<p class="sc-precision">au sens de « ${sensMotHtml(it, 2)} »</p>` : ""}
        ${tacheHtml("Comment se lit ce mot ?", "en japonais")}
        <form class="sc-reponse" id="scForm" autocomplete="off" data-langue="JP">
          <input id="scSaisie" class="sc-saisie" lang="ja" autocapitalize="none" autocorrect="off"
                 spellcheck="false" enterkeyhint="done" aria-label="Sa lecture, en rōmaji ou en kanas"
                 placeholder="sa lecture (rōmaji ou kanas)">
          <button class="btn" type="submit" id="scValider">Valider</button>
        </form>
        <p class="sc-retour" id="scRetour" aria-live="polite"></p>
        <div class="sc-detail" id="scDetail" hidden></div>
      </div>`;
    const saisie = $("scSaisie");
    saisieKana(saisie);
    saisie.focus();
    let repondu = false;
    $("scForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (repondu) { suivante(); return; }
      repondu = true;
      const tape = valideSaisie(saisie);
      const lectures = it.l.map((l) => lectureEcrite(l, it.p));
      const juste = !!tape && (Mots.accepteLecture(it, tape) || commeEcrit(tape, lectures));
      saisie.readOnly = true;
      saisie.classList.add(juste ? "juste" : "faux");
      const lu = `<span lang="ja">${echappe(it.m)}</span> se lit « <strong lang="ja">${lectures.map(echappe).join(
        "</strong> » ou « <strong lang=\"ja\">")}</strong> »`;
      $("scRetour").innerHTML = juste
        ? `<span class="verdict verdict-juste">正解</span> ${lu}.`
        : `<span class="verdict verdict-faux">${tape ? "残念" : "?"}</span> ${lu}${tape ? `, pas « <span lang="ja">${echappe(tape)}</span> »` : ""}.`
          + (tape && Mots.presque(it, tape) ? PRESQUE() : "");
      $("scDetail").innerHTML = detailMotHtml(it, { lecture: false });
      $("scDetail").hidden = false;
      $("scSon").addEventListener("click", () => dis(it));
      dis(it);
      $("scValider").textContent = "Continuer";
      $("scValider").focus();
      note(e, juste ? 3 : 1);
      if (!juste) reprend(e);
    });
  }

  /* Retrouver le mot depuis son sens : la carte la plus difficile, celle
     qui fait parler. Un synonyme (はやい pour 速い quand on attendait 早い)
     n'est pas une erreur : on le dit, et on laisse un autre essai. Un
     indice dévoile la lecture un kana après l'autre ; une réponse juste
     après un indice compte comme « difficile ». */
  function rendDireMot(e) {
    const it = e.item;
    // l'indice dévoile un son après l'autre : un kana, ou sa syllabe en rōmaji
    const kanas = romaji() ? Romaji.sons(it.l[0]) : [...it.l[0]];
    $("scScene").innerHTML = `
      <div class="carte-seance tache-jp">
        <p class="sc-genre"><span class="sc-marque" lang="ja">言</span> Retrouver le mot · ${genreLabel(e)}</p>
        <p class="sc-demande">Comment dit-on « <strong class="sc-demande-sens">${sensMotHtml(it, 3)}</strong> » ?</p>
        <p class="mt-nature">${echappe(Mots.nature(it))}</p>
        <form class="sc-reponse" id="scForm" autocomplete="off" data-langue="JP">
          <input id="scSaisie" class="sc-saisie" lang="ja" autocapitalize="none" autocorrect="off"
                 spellcheck="false" enterkeyhint="done" aria-label="Le mot, en rōmaji ou en kanas"
                 placeholder="en rōmaji ou en kanas">
          <button class="btn" type="submit" id="scValider">Valider</button>
        </form>
        <p class="sc-indice" id="scIndice" lang="ja" hidden></p>
        <p class="sc-retour" id="scRetour" aria-live="polite"></p>
        <div class="sc-detail" id="scDetail" hidden></div>
        <div class="sc-actions">
          <button type="button" class="btn-lien" id="scAide">Un indice</button>
          <button type="button" class="btn-lien" id="scBon" hidden>J'avais bon</button>
          <button type="button" class="btn" id="scSuivant" hidden>Continuer</button>
        </div>
      </div>`;
    const saisie = $("scSaisie");
    saisieKana(saisie);
    saisie.focus();
    let repondu = false, enAttente = false, indices = 0, synonymeVu = false;
    function continuer() {
      if (enAttente) { enAttente = false; note(e, 1); reprend(e); }
      suivante();
    }
    $("scAide").addEventListener("click", () => {
      indices = Math.min(indices + 1, Math.max(1, kanas.length - 1));
      $("scIndice").textContent = romaji() ? Romaji.indice(it.l[0], indices)
        : kanas.map((k, i) => (i < indices ? k : "＿")).join(" ");
      $("scIndice").hidden = false;
      if (indices >= kanas.length - 1) $("scAide").hidden = true;
      saisie.focus();
    });
    $("scForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (repondu) { continuer(); return; }
      const tape = valideSaisie(saisie);
      const juste = !!tape && (Mots.accepteLecture(it, tape) || commeEcrit(tape, [Romaji.mot(it)]));
      if (tape && !juste && !synonymeVu) {
        const autre = Mots.synonyme(it, tape);
        if (autre) {
          synonymeVu = true;
          $("scRetour").innerHTML = `<span lang="ja">${echappe(motEcrit(autre))}</span>${enKanjis(autre) && !romaji()
            ? ` (<span lang="ja">${echappe(autre.l[0])}</span>)` : ""}
            veut dire ça aussi ! Mais on cherche un autre mot : encore un essai.`;
          saisie.value = "";
          saisie.focus();
          return;
        }
      }
      repondu = true;
      saisie.readOnly = true;
      saisie.classList.add(juste ? "juste" : "faux");
      $("scRetour").innerHTML = juste
        ? `<span class="verdict verdict-juste">正解</span> ${indices ? "Avec un indice." : "C'est ça."}`
        : `<span class="verdict verdict-faux">${tape ? "残念" : "?"}</span> On cherchait :`;
      $("scDetail").innerHTML = motGrand(it, "sc-mot-moyen") + detailMotHtml(it);
      $("scDetail").hidden = false;
      $("scSon").addEventListener("click", () => dis(it));
      dis(it);
      $("scIndice").hidden = true;
      $("scAide").hidden = true;
      $("scValider").hidden = true;
      $("scBon").hidden = juste || !tape;
      $("scSuivant").hidden = false;
      if (juste) note(e, indices ? 2 : 3);
      else enAttente = true;
      $("scSuivant").focus();
    });
    $("scSuivant").addEventListener("click", continuer);
    $("scBon").addEventListener("click", () => {
      enAttente = false;
      note(e, indices ? 2 : 3);
      suivante();
    });
  }

  /* « ji » ou « zu » : deux kanas chacun (じ ぢ, ず づ), qu'on ne sépare
     que par leur ligne - voir Kana.homophone. La ligne entière, en rōmaji,
     la syllabe demandée en gras à sa place : za ji zu ze zo n'est pas
     da ji zu de do, et rien du tracé n'est soufflé. */
  function homophoneHtml(it) {
    const h = it.homophone;
    return `<p class="sc-precision">celui de la ligne <strong>${echappe(h.ligne)}</strong> :
      <span class="sc-precision-ligne">${h.syllabes.map((s, i) =>
        i === h.rang ? `<b>${echappe(s)}</b>` : echappe(s)).join(" ")}</span></p>`;
  }

  function rendEcrire(e) {
    const it = e.item;
    const kanji = it.type === "kanji";
    const traits = traitsDe(it);
    const demande = kanji
      ? `<p class="sc-demande">Trace le kanji de « <strong class="sc-demande-sens">${echappe(Kanji.sens(it, 3).join(", "))}</strong> »</p>
         ${lecturesHtml(it, true)}`
      : `<p class="sc-demande">Trace « <strong>${echappe(it.r)}</strong> » ${boutonSon("scSon", "Réécouter")}</p>
         ${it.homophone ? homophoneHtml(it) : ""}`;
    $("scScene").innerHTML = `
      <div class="carte-seance">
        <p class="sc-genre"><span class="sc-marque" lang="ja">書</span> Écriture · ${genreLabel(e)}</p>
        ${demande}
        <div class="tr-hote sc-trace-memoire" id="scTrace"></div>
        <p class="sc-retour" id="scRetour" aria-live="polite">De mémoire, trait par trait${kanji ? ` : ${pluriel(traits.length, "trait")}` : ""}.</p>
        <div class="sc-actions">
          <button type="button" class="btn-lien" id="scOubli">Je ne sais plus</button>
          <button type="button" class="btn" id="scSuivant" hidden>Continuer</button>
        </div>
      </div>`;
    if (!kanji) {
      brancheSon("scSon", it.k);
      Voix.dit(it.k);
    }
    let fini = false;
    const t = Trace.monte($("scTrace"), {
      traits, mode: "memoire",
      etiquette: `Tracer ${kanji ? Kanji.sens(it, 1)[0] : it.r}${
        it.homophone ? `, celui de la ligne ${it.homophone.ligne}` : ""}`,
      surTrait: (r) => {
        if (!r.ok) $("scRetour").textContent = r.message;
        else if (r.rang < traits.length) $("scRetour").textContent = `Trait ${r.rang} sur ${traits.length}.`;
      },
      surFin: (bilan) => termine(Trace.note(bilan)),
    });
    function termine(valeur) {
      if (fini) return;
      fini = true;
      const textes = {
        3: `<span class="verdict verdict-juste">完璧</span> Sans une hésitation.`,
        2: `<span class="verdict verdict-juste">正解</span> Juste, après quelques hésitations.`,
        1: `<span class="verdict verdict-faux">残念</span> Il reviendra dans un instant.`,
      };
      $("scRetour").innerHTML = `${textes[valeur]} <span class="sc-rappel" lang="ja">${echappe(it.k)}</span>`;
      $("scOubli").hidden = true;
      $("scSuivant").hidden = false;
      $("scSuivant").focus();
      note(e, valeur);
      if (valeur === 1) reprend(e);
    }
    $("scOubli").addEventListener("click", () => {
      t.mode("demo");
      t.anime();
      termine(1);
    });
    $("scSuivant").addEventListener("click", suivante);
  }

  /* La découverte d'un point de grammaire : sa fiche, et trois de ses
     phrases. Les autres serviront aux révisions. */
  const EXEMPLES_DECOUVERTE = 3;
  function rendDecouverteGram(e) {
    const it = e.item;
    $("scScene").innerHTML = `
      <div class="carte-seance carte-gram">
        <p class="sc-genre"><span class="sc-marque" lang="ja">新</span> Nouveau · ${genreLabel(e)}</p>
        ${enteteGramHtml(it)}
        <div class="gr-texte">${blocsHtml(it.texte)}</div>
        <h3 class="gr-sous-titre">Exemples</h3>
        <ol class="gr-exemples">${it.ex.slice(0, EXEMPLES_DECOUVERTE).map(exempleHtml).join("")}</ol>
        <div class="sc-actions">
          <button type="button" class="btn" id="scSuivant">Continuer</button>
        </div>
      </div>`;
    brancheExemples($("scScene"), it);
    $("scSuivant").addEventListener("click", () => apresDecouverte(it));
    $("scSuivant").focus({ preventScroll: true });
  }

  /* La phrase d'une révision : une autre à chaque fois, en tournant. Les
     phrases de la découverte passent en dernier ; une carte reprise dans
     la même séance change de phrase. */
  function exempleSuivant(it, eviter) {
    const vus = Pref.lit("gramVus", {}) || {};
    const n = it.ex.length;
    const dernier = typeof vus[it.nom] === "number" ? vus[it.nom] : EXEMPLES_DECOUVERTE - 1;
    let i = (dernier + 1) % n;
    if (n > 1 && i === eviter) i = (i + 1) % n;
    vus[it.nom] = i;
    Pref.ecrit("gramVus", vus);
    return i;
  }

  /* Compléter une phrase : sa traduction, la phrase à trou, ce qui manque
     à taper. Une particule tapée comme elle se dit (« wa » pour は) n'est
     pas une faute de grammaire : on le dit, et on laisse corriger. Un
     indice rappelle le point travaillé ; une réponse juste après un indice
     compte comme « difficile ». Une réponse refusée attend qu'on passe à la
     suite pour être notée : « J'avais bon » peut encore la changer - le
     japonais a souvent deux façons de dire la même chose. */
  function rendCompleter(e) {
    const it = e.item;
    e.ex = exempleSuivant(it, e.ex);
    const ex = it.ex[e.ex];
    $("scScene").innerHTML = `
      <div class="carte-seance carte-gram tache-jp">
        <p class="sc-genre"><span class="sc-marque" lang="ja">文</span> Compléter · ${genreLabel(e)}</p>
        <p class="gr-consigne">${echappe(ex.fr)}</p>
        <p class="gr-phrase gr-phrase-seance" lang="ja" id="grPhrase">${phraseHtml(ex)}</p>
        <form class="sc-reponse" id="scForm" autocomplete="off" data-langue="JP">
          <input id="scSaisie" class="sc-saisie" lang="ja" autocapitalize="none" autocorrect="off"
                 spellcheck="false" enterkeyhint="done" aria-label="Ce qui manque, en rōmaji ou en kanas"
                 placeholder="ce qui manque (rōmaji ou kanas)">
          <button class="btn" type="submit" id="scValider">Valider</button>
        </form>
        <p class="gr-indice" id="grIndice" hidden></p>
        <p class="sc-retour" id="scRetour" aria-live="polite"></p>
        <div class="gr-rappel" id="grRappel" hidden></div>
        <div class="sc-actions">
          <button type="button" class="btn-lien" id="scAide">Un indice</button>
          <button type="button" class="btn-lien" id="scBon" hidden>J'avais bon</button>
          <button type="button" class="btn" id="scSuivant" hidden>Continuer</button>
        </div>
      </div>`;
    const saisie = $("scSaisie");
    saisieKana(saisie);
    saisie.focus();
    let repondu = false, enAttente = false, aide = false, particuleVue = false;
    function continuer() {
      if (enAttente) { enAttente = false; note(e, 1); reprend(e); }
      suivante();
    }
    $("scAide").addEventListener("click", () => {
      aide = true;
      $("grIndice").innerHTML = `${motifHtml(it)} : ${texteHtml(it.sens)}`;
      $("grIndice").hidden = false;
      $("scAide").hidden = true;
      saisie.focus();
    });
    $("scForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (repondu) { continuer(); return; }
      const ro = romaji() ? roPhrase(ex) : null;
      let verdict = Grammaire.corrige(ex, valideSaisie(saisie));
      // en rōmaji, la particule は s'écrit « wa » : la taper ainsi est juste
      if (ro && (verdict === "particule" || commeEcrit(saisie.value, [ro.t, ...(ro.r || [])]))) verdict = "juste";
      if (verdict === "particule" && !particuleVue) {
        particuleVue = true;
        $("scRetour").innerHTML = `Presque : は, へ et を, quand ce sont des particules, se tapent
          « ha », « he » et « wo ». Corrige, et valide.`;
        saisie.focus();
        return;
      }
      repondu = true;
      const tape = saisie.value.trim();
      const juste = verdict === "juste";
      saisie.readOnly = true;
      saisie.classList.add(juste ? "juste" : "faux");
      $("grPhrase").innerHTML = phraseHtml(ex, juste ? "juste" : "faux");
      const autres = ro ? ro.r || [] : (ex.e || ex.r).slice(1);
      $("scRetour").innerHTML = juste
        ? `<span class="verdict verdict-juste">正解</span> ${aide ? "Avec un indice." : "C'est ça."}`
        : `<span class="verdict verdict-faux">${tape ? "残念" : "?"}</span> Il fallait
           « <strong lang="ja">${ro ? echappe(ro.t) : enJaponais(ex.t)}</strong> »${autres.length ? ` (ou <span lang="ja">${autres.map(echappe).join("</span>, <span lang=\"ja\">")}</span>)` : ""}${tape ? `, pas « <span lang="ja">${echappe(tape)}</span> »` : ""}.`
          + (verdict === "presque" ? PRESQUE() : "");
      $("grRappel").innerHTML = `
        <p class="gr-rappel-titre"><span>${motifHtml(it)}</span> : ${texteHtml(it.sens)}
          ${boutonSon("grSon", "Réécouter")}</p>
        <button type="button" class="btn-lien" id="grExplique">Revoir l'explication</button>
        <div class="gr-texte" id="grTexte" hidden>${it.formes.length ? `<ul class="gr-formes">${it.formes.map((f) => `<li>${texteHtml(f)}</li>`).join("")}</ul>` : ""}${blocsHtml(it.texte)}</div>`;
      $("grRappel").hidden = false;
      $("grSon").addEventListener("click", () => direPhrase(ex));
      $("grExplique").addEventListener("click", () => {
        $("grTexte").hidden = false;
        $("grExplique").hidden = true;
      });
      direPhrase(ex);
      $("grIndice").hidden = true;
      $("scAide").hidden = true;
      $("scValider").hidden = true;
      $("scBon").hidden = juste || !tape;
      $("scSuivant").hidden = false;
      if (juste) note(e, aide ? 2 : 3);
      else enAttente = true;
      $("scSuivant").focus();
    });
    $("scSuivant").addEventListener("click", continuer);
    $("scBon").addEventListener("click", () => {
      enAttente = false;
      note(e, aide ? 2 : 3);
      suivante();
    });
  }

  /* Quel écran pour quelle carte. */
  const RENDUS = {
    kana: { decouverte: rendDecouverte, lire: rendLire, ecrire: rendEcrire },
    kanji: { decouverte: rendDecouverteKanji, sens: rendSens, ecrire: rendEcrire },
    mot: { decouverte: rendDecouverteMot, sens: rendSens, lire: rendLireMot, dire: rendDireMot },
    gram: { decouverte: rendDecouverteGram, completer: rendCompleter },
  };

  /* La fin : le bilan, et ce qu'on peut faire ensuite - un texte à
     portée, un point de grammaire ; le point d'abord, après la grammaire. */
  function finSeance() {
    const minutes = Math.max(1, Math.round((Date.now() - SEANCE.debut) / 60000));
    const suivant = texteSuivant();
    const point = gramSuivant();
    const precision = SEANCE.notees ? Math.round(100 * SEANCE.justes / SEANCE.notees) : 100;
    const versTexte = suivant ? `<button type="button" class="btn-lien" id="scLire">Un texte :
      <span lang="ja">${titreHtml(suivant)}</span> (${echappe(suivant.fr)})</button>` : "";
    const versPoint = point ? `<button type="button" class="btn-lien" id="scGram">${SEANCE.genre === "gram"
      ? "Le point suivant" : "Un point de grammaire"} : ${motifHtml(point, true)}</button>` : "";
    const suites = (SEANCE.genre === "gram" ? [versPoint, versTexte] : [versTexte, versPoint]).filter(Boolean);
    // ce qu'on a découvert, ce qu'on a raté : chaque élément ouvre sa fiche
    const elements = new Map();
    const rangee = (titre, items) => (items.length ? `<div class="sc-fin-rangee"><p>${titre}</p>
      <span class="apercu-kanas" lang="ja">${items.map((it) => {
        elements.set(it.id, it);
        return `<button type="button" class="apercu-el" data-element="${echappe(it.id)}">${echappe(
          it.type === "gram" ? motifCourt(it) : it.k || motEcrit(it))}</button>`;
      }).join("")}</span></div>` : "");
    const recap = rangee("Découverts", [...SEANCE.decouverts.values()])
      + rangee("À revoir", [...SEANCE.rates.values()]);
    $("scScene").innerHTML = `
      <div class="carte-seance sc-fin">
        <div class="tampon" aria-hidden="true"><span lang="ja">済</span></div>
        <h2 class="sc-fin-titre" lang="ja">${romaji() ? "Otsukaresama deshita" : "お疲れさまでした"}</h2>
        <p class="sc-fin-trad">${romaji() ? "" : "<em>otsukaresama deshita</em> — "}« merci pour cet effort »</p>
        <dl class="bilan">
          <div><dt>Réponses</dt><dd>${SEANCE.notees}</dd></div>
          <div><dt>Réponses justes</dt><dd>${precision} %</dd></div>
          <div><dt>Temps</dt><dd>${minutes} min</dd></div>
          <div><dt>Série</dt><dd>${ETAT.serie} jour${ETAT.serie > 1 ? "s" : ""}</dd></div>
        </dl>
        ${recap ? `<div class="sc-fin-recap">${recap}</div>` : ""}
        ${suites.length ? `<div class="sc-fin-lire"><p>Et maintenant ?</p>${suites.join("")}</div>` : ""}
        <button type="button" class="btn" id="scFin">Retour</button>
      </div>`;
    $("scFin").addEventListener("click", quitteSeance);
    $("scScene").querySelectorAll("[data-element]").forEach((b) => b.addEventListener("click", () => {
      ouvreFicheDe(elements.get(b.dataset.element), b);
    }));
    if (suivant) {
      $("scLire").addEventListener("click", () => {
        quitteSeance();
        ouvreTexte(suivant);
      });
    }
    if (point) {
      $("scGram").addEventListener("click", () => {
        quitteSeance();
        lanceGrammaire(point);
      });
    }
    $("scFin").focus();
  }

  function quitteSeance() {
    Voix.arrete();
    SEANCE = null;
    TEST = null;
    $("seance").hidden = true;
    $("scScene").innerHTML = "";
    document.body.classList.remove("en-seance");
    rend();
  }

  $("scQuitter").addEventListener("click", quitteSeance);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("fiche").hidden) { fermeFiche(); return; }
    if (!$("seance").hidden) { quitteSeance(); return; }
    if ($("pupitre") && !$("pupitre").hidden) fermePupitre();
  });

  /* =====================================================================
     試験 - Le test de niveau
     =====================================================================
     Pour qui a déjà des bases : quelques minutes de questions, et ce qui
     est su entre d'un coup dans les révisions, déjà solide - il ne revient
     que de loin en loin, pour vérifier (voir place dans nihongo.py). Rien
     de ce qui a déjà une carte ne change.

     Quatre domaines, l'un après l'autre : les kanas (hiraganas, puis
     katakanas), le vocabulaire, les kanjis, la grammaire. Les trois
     derniers vont par niveau du JLPT, en partant de celui qu'on se donne :
     un niveau réussi vaut pour ceux d'en dessous et fait monter d'un cran,
     un niveau manqué fait descendre. Un niveau est réussi à une erreur près
     - « Je ne sais pas » en est une : un coup de chance ferait sauter ce
     qu'on ne sait pas. Des questions à choix, pour aller vite : le test
     cherche ce qui est su, la séance fera le reste.

     Sans les hiraganas, rien d'autre ne se lit : le test s'arrête là.
     L'écriture ne se teste pas (tracer prendrait une heure) : les
     caractères sus à la lecture reviennent à tracer dans les trois mois.
     Le test reste en kanas et en kanjis même quand la page est en
     rōmaji : c'est leur lecture qu'il mesure. */
  const TEST_QUESTIONS = { kana: 8, mot: 10, kanji: 8, gram: 8 };
  const TEST_ERREURS = 1;
  const TEST_DOMAINES = [
    { id: "kana", nom: "Kanas" },
    { id: "mot", nom: "Vocabulaire" },
    { id: "kanji", nom: "Kanjis" },
    { id: "gram", nom: "Grammaire" },
  ];
  const TEST_DEPARTS = [
    { n: 5, texte: "les kanas, les premières phrases" },
    { n: 4, texte: "la conversation simple" },
    { n: 3, texte: "le japonais de tous les jours" },
    { n: 2, texte: "journaux, conversations rapides" },
    { n: 1, texte: "presque tout" },
  ];
  let TEST = null;

  /* Le premier jour, le test se propose en grand sur la page Aujourd'hui ;
     ensuite, un lien discret sous le chemin. */
  function testAccueilHtml() {
    return `
      <section class="feuille lc-suivant">
        <span class="lc-suivant-jp" lang="ja" aria-hidden="true">試</span>
        <div class="lc-suivant-texte">
          <h2 class="lc-suivant-titre">Tu as déjà des bases ?</h2>
          <p class="lc-suivant-intro">Quelques minutes de questions, et tu commences à ton niveau. Tu débutes ? La
            séance du jour commence par les hiraganas.</p>
        </div>
        <button type="button" class="btn btn-grand" data-test>試験 <span>Le test</span></button>
      </section>`;
  }

  function lanceTest() {
    TEST = { intro: true };
    $("seance").hidden = false;
    document.body.classList.add("en-seance");
    $("scJauge").style.width = "0%";
    $("scCompte").textContent = "";
    scene(`
      <div class="carte-seance nv-intro">
        <div class="tampon" aria-hidden="true"><span lang="ja">試</span></div>
        <h2 class="sc-fin-titre">Le test de niveau</h2>
        <p class="nv-texte">Des questions à choix sur les kanas, le vocabulaire, les kanjis et la grammaire, de
          cinq à quinze minutes. Ce que tu sais déjà entre dans tes révisions et ne revient que de loin en loin,
          pour vérifier.</p>
        <p class="nv-texte"><strong>Ne devine pas</strong> : « Je ne sais pas » vaut mieux qu'un coup de chance, qui
          te ferait sauter ce que tu ne sais pas.</p>
        <p class="sc-tache">Où en es-tu, à peu près ?</p>
        <div class="nv-departs">
          ${TEST_DEPARTS.map((d) => `<button type="button" class="nv-depart" data-depart="${d.n}">
            <strong>N${d.n}</strong><span>${d.texte}</span></button>`).join("")}
        </div>
        <p class="nv-aide">Le test commence là, puis monte ou descend selon tes réponses. Dans le doute, choisis plus bas.</p>
      </div>`);
    $("scScene").querySelectorAll("[data-depart]").forEach((b) => b.addEventListener("click", () => {
      TEST = { depart: +b.dataset.depart, domaine: 0, sens: 0, faits: 0, jauge: 0,
               acquis: { kana: [], mot: [], kanji: [], gram: [] } };
      testNiveau("hira");
    }));
    $("scScene").querySelector("[data-depart]").focus();
  }

  /* Une scène du test, avec l'animation d'entrée des cartes de séance. */
  function scene(html) {
    const sc = $("scScene");
    sc.classList.remove("entree");
    void sc.offsetWidth;
    sc.classList.add("entree");
    sc.innerHTML = html;
  }

  /* n éléments pris au hasard. */
  const auHasard = (liste, n) => melange(liste.slice()).slice(0, n);

  /* Trois leurres pour un choix : pris dans `pool`, chacun avec un texte à
     lui, et aucun qui partage un sens avec la bonne réponse (早い, 速い). */
  function leurres(bonne, pool, texte, sens) {
    const pris = [], vus = new Set([texte(bonne)]);
    const siens = new Set(sens(bonne));
    for (const x of melange(pool.slice())) {
      if (pris.length === 3) break;
      const t = texte(x);
      if (x === bonne || vus.has(t) || sens(x).some((m) => siens.has(m))) continue;
      vus.add(t);
      pris.push(t);
    }
    return pris;
  }

  /* Les questions d'un niveau : { invite, question, bonne, autres, jp }.
     `jp` : les choix sont du japonais. Un kana se lit parmi ceux de sa
     famille (きゃ parmi les sons contractés) ; じ et ぢ, qui se lisent
     pareil, n'y sont pas. Un mot se reconnaît parmi des mots de même
     nature. Une phrase se complète, sa traduction sous les yeux, parmi ce
     que complètent d'autres phrases du niveau, de son chapitre d'abord ; un
     trou sans indice, et toujours de la même largeur : sa taille ne souffle
     rien. */
  function questionsTest(domaine, niveau) {
    const n = TEST_QUESTIONS[domaine === "hira" || domaine === "kata" ? "kana" : domaine];
    const glyphe = (k) => `<div class="sc-glyphe nv-glyphe" lang="ja">${echappe(k)}</div>`;
    if (domaine === "kana") {
      const tous = Kana.TOUS.filter((it) => it.sys === niveau && !it.homophone);
      return auHasard(tous, n).map((it) => ({
        invite: glyphe(it.k), question: "Comment se lit-il ?", bonne: echappe(it.r),
        autres: leurres(it, tous.filter((x) => x.famille === it.famille), (x) => x.r, (x) => [x.r]).map(echappe),
      }));
    }
    if (domaine === "mot") {
      const tous = Mots.TOUS.filter((it) => it.n === niveau);
      const texte = (x) => Mots.sens(x, 2).join(", ");
      return auHasard(tous, n).map((it) => {
        const pareils = tous.filter((x) => (x.p || [])[0] === (it.p || [])[0]);
        return { invite: motGrand(it, "", it.m), question: "Que veut dire ce mot ?", bonne: echappe(texte(it)),
                 autres: leurres(it, pareils.length > 10 ? pareils : tous, texte, (x) => Mots.sens(x)).map(echappe) };
      });
    }
    if (domaine === "kanji") {
      const tous = Kanji.TOUS.filter((it) => it.n === niveau);
      const texte = (x) => Kanji.sens(x, 2).join(", ");
      return auHasard(tous, n).map((it) => ({
        invite: glyphe(it.k), question: "Que veut dire ce kanji ?", bonne: echappe(texte(it)),
        autres: leurres(it, tous, texte, (x) => Kanji.sens(x)).map(echappe),
      }));
    }
    const sansIndice = (it) => it.ex.filter((ex) => !ex.i);
    const tous = Grammaire.TOUS.filter((it) => it.n === niveau && sansIndice(it).length);
    return auHasard(tous, n).map((it) => {
      const ex = auHasard(sansIndice(it), 1)[0];
      const justes = new Set([...ex.r, ...(ex.e || []), Grammaire.surface(ex.t)]);
      const proches = melange(tous.filter((x) => x !== it && x.chapitre === it.chapitre));
      const loin = melange(tous.filter((x) => x.chapitre !== it.chapitre));
      const autres = [], vus = new Set();
      for (const x of [...proches.slice(0, 2), ...loin, ...proches.slice(2)]) {
        if (autres.length === 3) break;
        const t = auHasard(sansIndice(x), 1)[0].t;
        const surface = Grammaire.surface(t);
        if (vus.has(surface) || justes.has(surface) || justes.has(Grammaire.lecture(t))) continue;
        vus.add(surface);
        autres.push(ecritJaponais(t));
      }
      return {
        invite: `<p class="gr-consigne">${echappe(ex.fr)}</p>
          <p class="gr-phrase gr-phrase-seance" lang="ja">${ecritJaponais(ex.a)}<span class="gr-trou" style="--n:3"></span>${ecritJaponais(ex.p)}</p>`,
        question: "Que manque-t-il ?", bonne: ecritJaponais(ex.t), autres, jp: true,
      };
    });
  }

  /* Un niveau d'un domaine : « hira » ou « kata » pour les kanas, 5 à 1
     pour les autres. */
  function testNiveau(niveau) {
    const domaine = TEST_DOMAINES[TEST.domaine].id;
    Object.assign(TEST, { niveau, questions: questionsTest(domaine, niveau), k: 0, justes: 0, erreurs: 0 });
    if (TEST.questions.length) testQuestion();
    else finNiveau(false);
  }

  function testEtiquette() {
    const d = TEST_DOMAINES[TEST.domaine];
    return `${d.nom} · ${typeof TEST.niveau === "number" ? `N${TEST.niveau}` : Kana.NOMS[TEST.niveau].fr}`;
  }

  /* La jauge avance d'un quart par domaine ; dans un domaine, un tiers par
     niveau passé, sans jamais reculer quand on change de niveau. */
  function majTestJauge() {
    const part = Math.min(0.95, (TEST.faits + TEST.k / TEST.questions.length) / 3);
    TEST.jauge = Math.max(TEST.jauge, (TEST.domaine + part) / TEST_DOMAINES.length);
    $("scJauge").style.width = (TEST.jauge * 100).toFixed(1) + "%";
    $("scCompte").textContent = `${TEST.domaine + 1} / ${TEST_DOMAINES.length}`;
  }

  function testQuestion() {
    const q = TEST.questions[TEST.k];
    TEST.choix = melange([{ html: q.bonne, juste: true }, ...q.autres.map((html) => ({ html, juste: false }))]);
    TEST.repondu = false;
    majTestJauge();
    scene(`
      <div class="carte-seance">
        <p class="sc-genre"><span class="sc-marque" lang="ja">試</span> ${testEtiquette()}</p>
        ${q.invite}
        <p class="sc-tache">${q.question}</p>
        <div class="nv-choix">${TEST.choix.map((c, i) => `<button type="button" data-choix="${i}"${q.jp ? ' lang="ja"' : ""}>
          <span class="nv-touche" aria-hidden="true">${i + 1}</span><span class="nv-choix-texte">${c.html}</span></button>`).join("")}</div>
        <div class="sc-actions"><button type="button" class="btn-lien" id="nvPasse">Je ne sais pas</button></div>
      </div>`);
    $("scScene").querySelectorAll("[data-choix]").forEach((b) => b.addEventListener("click", () => testRepond(+b.dataset.choix)));
    $("nvPasse").addEventListener("click", () => testRepond(-1));
  }

  /* La réponse se montre un instant - la bonne en vert, la mauvaise barrée
     -, puis la suite. Un niveau s'arrête dès que son sort est joué. */
  function testRepond(i) {
    if (!TEST || TEST.repondu) return;
    TEST.repondu = true;
    const juste = i >= 0 && TEST.choix[i].juste;
    $("scScene").querySelectorAll("[data-choix]").forEach((b, k) => {
      b.disabled = true;
      if (TEST.choix[k].juste) b.classList.add("juste");
      else if (k === i) b.classList.add("faux");
    });
    $("nvPasse").disabled = true;
    if (juste) TEST.justes++;
    else TEST.erreurs++;
    TEST.k++;
    const test = TEST;
    setTimeout(() => {
      if (TEST !== test) return;            // quitté entre-temps
      const total = TEST.questions.length;
      if (TEST.erreurs > TEST_ERREURS) finNiveau(false);
      else if (TEST.justes >= total - TEST_ERREURS) finNiveau(true);
      else testQuestion();
    }, juste ? 450 : 1300);
  }

  /* Un niveau joué : où aller ensuite. Les kanas : sans les hiraganas, le
     test s'arrête ; les katakanas, réussis ou non, passent la main. Les
     autres : un premier niveau réussi vaut pour ceux d'en dessous, et l'on
     monte tant que ça passe ; un premier niveau manqué fait descendre
     jusqu'au premier qui passe. */
  function finNiveau(passe) {
    const domaine = TEST_DOMAINES[TEST.domaine].id;
    const n = TEST.niveau;
    TEST.faits++;
    let suivant = null;
    if (domaine === "kana") {
      if (passe) TEST.acquis.kana.push(n);
      if (n === "hira" && !passe) { finTest(); return; }
      if (n === "hira") suivant = "kata";
    } else {
      const acquis = TEST.acquis[domaine];
      const jusqua = (m) => [5, 4, 3, 2, 1].filter((x) => x >= m);
      if (TEST.sens === 0) {
        if (passe) acquis.push(...jusqua(n));
        TEST.sens = passe ? -1 : 1;
        suivant = passe ? n - 1 : n + 1;
      } else if (TEST.sens < 0) {
        if (passe) { acquis.push(n); suivant = n - 1; }
      } else if (passe) acquis.push(...jusqua(n));
      else suivant = n + 1;
      if (suivant < 1 || suivant > 5) suivant = null;
    }
    if (suivant !== null) { testNiveau(suivant); return; }
    // le domaine suivant, au niveau de départ
    TEST.domaine++;
    Object.assign(TEST, { sens: 0, faits: 0 });
    if (TEST.domaine >= TEST_DOMAINES.length) finTest();
    else testNiveau(TEST.depart);
  }

  /* Les cartes de ce qui est su, sauf celles qui existent déjà. Un mot su
     a son sens et sa lecture, même si ses kanjis ne sont pas encore à
     portée (la lecture attendra) ; son sens est sur la carte de son kanji
     s'il n'est que lui et que ce kanji est su (voir « En kanjis, ou en
     kanas »). */
  function clesDuTest() {
    const A = TEST.acquis, items = [];
    A.kana.forEach((sys) => items.push(...Kana.TOUS.filter((it) => it.sys === sys)));
    A.mot.forEach((n) => items.push(...Mots.TOUS.filter((it) => it.n === n)));
    A.kanji.forEach((n) => items.push(...Kanji.TOUS.filter((it) => it.n === n)));
    A.gram.forEach((n) => items.push(...Grammaire.TOUS.filter((it) => it.n === n)));
    const cles = items.flatMap((it) => {
      if (it.type !== "mot") return clesDe(it);
      const k = kanjiDuMot(it);
      const sens = k && (kanjiConnu(k) || A.kanji.includes(k.n)) ? `${k.id}:sens` : `${it.id}:sens`;
      return it.kanjis ? [sens, `${it.id}:lire`] : [sens];
    });
    return [...new Set(cles)].filter((cle) => !ETAT.cartes[cle]);
  }

  function finTest() {
    const A = TEST.acquis;
    TEST.choix = null;
    $("scJauge").style.width = "100%";
    $("scCompte").textContent = "";
    const cles = clesDuTest();
    const debutant = !A.kana.includes("hira");
    // « N5 et N4 sus : la suite commence au N3 »
    const niveaux = (l) => {
      const tries = [...new Set(l)].sort((a, b) => b - a);
      if (!tries.length) return "à apprendre, depuis le N5";
      if (tries.length === 5) return "tout est su";
      const noms = tries.map((n) => `N${n}`);
      return `${noms.length > 1 ? `${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}` : noms[0]} : su${
        noms.length > 1 ? "s" : ""} ; la suite commence au N${Math.min(...tries) - 1}`;
    };
    const kanas = A.kana.length === 2 ? "hiraganas et katakanas : sus"
      : A.kana.length ? "hiraganas : sus ; les katakanas sont à apprendre" : "à apprendre, en commençant par les hiraganas";
    const lignes = debutant ? [["仮名", "Kanas", kanas]] : [
      ["仮名", "Kanas", kanas],
      ["単語", "Vocabulaire", niveaux(A.mot)],
      ["漢字", "Kanjis", niveaux(A.kanji)],
      ["文法", "Grammaire", niveaux(A.gram)],
    ];
    const traces = cles.some((cle) => cle.endsWith(":ecrire"));
    scene(`
      <div class="carte-seance nv-fin">
        <div class="tampon" aria-hidden="true"><span lang="ja">${debutant ? "始" : "済"}</span></div>
        <h2 class="sc-fin-titre">${debutant ? "On commence au début" : "Ton point de départ"}</h2>
        <dl class="nv-resultats">${lignes.map(([jp, nom, texte]) => `
          <div><dt><span lang="ja">${jp}</span> ${nom}</dt><dd>${texte[0].toUpperCase() + texte.slice(1)}.</dd></div>`).join("")}
        </dl>
        ${debutant ? `<p class="nv-texte">Pas de souci : la séance du jour commence par les hiraganas, quelques-uns
          chaque jour.</p>` : cles.length ? `<p class="nv-texte">${pluriel(cles.length, "carte")} entre${cles.length > 1 ? "nt" : ""}
          dans tes révisions, déjà solide${cles.length > 1 ? "s" : ""} : elle${cles.length > 1 ? "s" : ""} reviendr${cles.length > 1 ? "ont" : "a"}
          de loin en loin, pour vérifier.${traces ? ` L'écriture n'a pas été testée : les caractères que tu lis
          reviendront à tracer dans les trois mois, quelques-uns par jour.` : ""}</p>`
          : `<p class="nv-texte">Rien de plus que ce que tes révisions savent déjà.</p>`}
        <div class="sc-actions">
          ${cles.length ? `<button type="button" class="btn-lien" id="nvAnnule">Annuler</button>
            <button type="button" class="btn" id="nvValide">C'est parti</button>`
            : `<button type="button" class="btn" id="nvAnnule">Retour</button>`}
        </div>
      </div>`);
    $("nvAnnule").addEventListener("click", quitteSeance);
    const valide = $("nvValide");
    if (!valide) { $("nvAnnule").focus(); return; }
    valide.focus();
    valide.addEventListener("click", async () => {
      valide.disabled = true;
      try {
        await api("/api/nihongo/niveau", "POST", { cles });
        await chargeEtat();
      } catch (e) {
        valide.disabled = false;
        toast(e.statut === 404 || e.statut === 405
          ? "Le serveur ne connaît pas encore le test : il attend d'être redémarré."
          : "Test non enregistré : " + e.message, true);
        return;
      }
      quitteSeance();
      toast("C'est noté : la séance reprend à ton niveau.");
    });
  }

  /* 1 à 4 au clavier : le choix du même numéro. */
  document.addEventListener("keydown", (e) => {
    if (!TEST || !TEST.choix || TEST.repondu || $("seance").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const i = "1234".indexOf(e.key);
    if (i < 0 || i >= TEST.choix.length) return;
    e.preventDefault();
    testRepond(i);
  });

  /* =====================================================================
     仮名 - Les kanas
     ===================================================================== */
  function vueKana(vue) {
    const sys = Pref.lit("syllabaire", "hira") === "kata" ? "kata" : "hira";
    const items = Kana.TOUS.filter((it) => it.sys === sys);
    const lus = items.filter((it) => niveauDe(it, "lire") >= 2).length;
    const ecrivables = items.filter((it) => it.ecrire);
    const ecrits = ecrivables.filter((it) => niveauDe(it, "ecrire") >= 2).length;

    vue.innerHTML = `
      <header class="rubrique-tete">
        <h1 class="titre"><span class="titre-jp" lang="ja">仮名</span><span class="titre-fr">Les kanas</span></h1>
        <p class="chapeau">La porte d'entrée : les <strong>hiraganas</strong> pour la grammaire et les mots japonais,
          les <strong>katakanas</strong> pour les mots venus d'ailleurs.</p>
      </header>

      <div class="kana-barre bilan-fin">
        <div class="segment" role="radiogroup" aria-label="Syllabaire">
          ${["hira", "kata"].map((s) => `
            <button type="button" role="radio" data-sys="${s}" aria-checked="${s === sys}">
              <span lang="ja">${Kana.NOMS[s].jp}</span> ${Kana.NOMS[s].fr}</button>`).join("")}
        </div>
        <p class="kana-bilan"><strong>${lus}</strong> / ${items.length} sus à la lecture ·
          <strong>${ecrits}</strong> / ${ecrivables.length} à l'écriture</p>
      </div>


      ${sectionKana(sys, "seion", "清音", "Les sons de base", Kana.COLONNES)}
      ${sectionKana(sys, "dakuon", "濁音", sys === "kata" ? "Avec dakuten (ガ) et handakuten (パ)" : "Avec dakuten (が) et handakuten (ぱ)", Kana.COLONNES)}
      ${sectionKana(sys, "youon", "拗音", "Les sons contractés", ["ya", "yu", "yo"])}`;

    vue.querySelectorAll(".segment button").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("syllabaire", b.dataset.sys);
      rend();
    }));
    vue.querySelectorAll(".kn-case").forEach((b) => b.addEventListener("click", () => {
      ouvreFiche(Kana.PAR_CAR.get(b.dataset.k), b);
    }));
  }

  function sectionKana(sys, famille, jp, titre, colonnes) {
    const grille = Kana.GRILLES[sys][famille];
    const tete = `<div class="kn-col-tete" aria-hidden="true"></div>` +
      colonnes.map((c) => `<div class="kn-col-tete" aria-hidden="true">${c}</div>`).join("");
    const lignes = grille.map((ligne) => {
      const premier = ligne.find(Boolean);
      // l'étiquette de ligne : la consonne (« k », « sh »), « – » pour les
      // voyelles seules
      const consonne = famille === "youon" ? premier.r.replace(/y?a$/, "")
                                           : premier.r.replace(/[aiueo]$/, "") || "–";
      return `<div class="kn-ligne-tete" aria-hidden="true">${consonne}</div>` +
        ligne.map((it) => it ? caseKana(it) : `<div class="kn-vide"></div>`).join("");
    }).join("");
    return `
      <section class="kn-section">
        <h2 class="section-titre"><span lang="ja">${jp}</span> ${titre}</h2>
        <div class="kn-grille kn-grille-${colonnes.length}">${tete}${lignes}</div>
      </section>`;
  }

  function caseKana(it) {
    const nl = niveauDe(it, "lire");
    const ne = it.ecrire ? niveauDe(it, "ecrire") : null;
    const etiquette = `${it.k}, ${it.r}. Lecture : ${NIVEAUX[nl]}${ne === null ? "" : `, écriture : ${NIVEAUX[ne]}`}.`;
    return `<button type="button" class="kn-case${it.famille === "youon" ? " kn-case-large" : ""}" data-k="${echappe(it.k)}" aria-label="${echappe(etiquette)}">
      <span class="kn-glyphe" lang="ja">${echappe(it.k)}</span>
      <span class="kn-romaji">${echappe(it.r)}</span>
      <span class="kn-jauges" aria-hidden="true"><i class="niv niv-${nl}"></i>${ne === null ? "" : `<i class="niv niv-${ne}"></i>`}</span>
    </button>`;
  }

  /* =====================================================================
     漢字 - Les kanjis
     ===================================================================== */
  function vueKanji(vue) {
    const n = choixListe("niveauKanji", Kanji.NIVEAUX);
    const vus = n === "vus";
    const compte = (liste, genre) => liste.filter((it) => niveauDe(it, genre) >= 2).length;
    const duNiveau = vus ? dejaVus(Kanji.TOUS) : Kanji.TOUS.filter((it) => it.n === n);

    vue.innerHTML = `
      <header class="rubrique-tete">
        <h1 class="titre"><span class="titre-jp" lang="ja">漢字</span><span class="titre-fr">Les kanjis</span></h1>
        <p class="chapeau">Un sens, un ordre des traits, du N5 au N1. Leurs lectures s'apprennent dans les mots.</p>
      </header>

      <div class="kana-barre">
        ${segmentNiveaux(Kanji.NIVEAUX, n)}
        <label class="recherche">
          <span class="lecture-seule">Chercher un kanji</span>
          <input type="search" id="kjCherche" placeholder="Chercher : sens, lecture ou kanji" autocomplete="off" spellcheck="false">
        </label>
      </div>
      <p class="kana-bilan bilan-fin" id="kjBilan">${vus ? `<strong>${pluriel(duNiveau.length, "kanji")}</strong> déjà
        vu${duNiveau.length > 1 ? "s" : ""}, du plus récent au plus ancien : ` : ""}<strong>${compte(duNiveau, "sens")}</strong>
        / ${duNiveau.length} sus en sens · <strong>${compte(duNiveau, "ecrire")}</strong> / ${duNiveau.length} à l'écriture</p>
      ${vus && !duNiveau.length ? `<p class="vide">Aucun kanji vu pour l'instant : la séance du jour en fait découvrir.</p>` : ""}
      <div class="kj-grille" id="kjGrille">${duNiveau.map((it) => caseKanji(it, vus)).join("")}</div>`;

    vue.querySelectorAll(".segment button").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("niveauKanji", valeurNiveau(b));
      rend();
    }));
    const grille = $("kjGrille");
    grille.addEventListener("click", (e) => {
      const b = e.target.closest(".kj-case");
      if (b) ouvreFicheKanji(Kanji.PAR_CAR.get(b.dataset.k), b);
    });
    $("kjCherche").addEventListener("input", (e) => {
      const q = e.target.value.trim();
      if (!q) {
        grille.innerHTML = duNiveau.map((it) => caseKanji(it, vus)).join("");
        $("kjBilan").hidden = false;
        return;
      }
      const trouves = Kanji.cherche(q);
      $("kjBilan").hidden = true;
      grille.innerHTML = trouves.length ? trouves.map((it) => caseKanji(it, true)).join("")
        : `<p class="vide">Rien ne correspond à « ${echappe(q)} ».</p>`;
    });
  }

  function caseKanji(it, avecNiveau) {
    const ns = niveauDe(it, "sens"), ne = niveauDe(it, "ecrire");
    const premier = Kanji.sens(it, 1)[0] || "";
    const etiquette = `${it.k} : ${Kanji.sens(it, 2).join(", ")}. Sens : ${NIVEAUX[ns]}, écriture : ${NIVEAUX[ne]}.`;
    return `<button type="button" class="kj-case" data-k="${echappe(it.k)}" aria-label="${echappe(etiquette)}">
      ${avecNiveau ? `<span class="kj-niveau">N${it.n}</span>` : ""}
      <span class="kj-glyphe" lang="ja">${echappe(it.k)}</span>
      <span class="kj-sens">${echappe(premier)}</span>
      <span class="kn-jauges" aria-hidden="true"><i class="niv niv-${ns}"></i><i class="niv niv-${ne}"></i></span>
    </button>`;
  }

  /* =====================================================================
     単語 - Le vocabulaire
     ===================================================================== */
  const PAR_PAGE = 150;

  /* Ce qu'on a déjà vu, tous niveaux mêlés, du plus récent au plus ancien :
     l'onglet « Vus » des kanjis et du vocabulaire. */
  function premiereCarte(it) {
    return Math.min(...propres(it).map((cle) => (ETAT.cartes[cle] ? Date.parse(ETAT.cartes[cle].c) : Infinity)));
  }
  function dejaVus(liste) {
    return liste.filter(commence).map((it) => [it, premiereCarte(it)])
      .sort((a, b) => b[1] - a[1]).map(([it]) => it);
  }
  /* Le niveau choisi d'une liste : 5 à 1, ou « vus ». */
  function choixListe(pref, niveaux) {
    const c = Pref.lit(pref, 5);
    return c === "vus" || niveaux.includes(+c) ? (c === "vus" ? c : +c) : 5;
  }
  function segmentNiveaux(niveaux, n) {
    return `<div class="segment" role="radiogroup" aria-label="Niveau du JLPT">
      ${niveaux.map((x) => `<button type="button" role="radio" data-niveau="${x}" aria-checked="${x === n}">N${x}</button>`).join("")}
      <button type="button" role="radio" data-niveau="vus" aria-checked="${n === "vus"}">Vus</button>
    </div>`;
  }
  const valeurNiveau = (b) => (b.dataset.niveau === "vus" ? "vus" : +b.dataset.niveau);

  function vueVocabulaire(vue) {
    const n = choixListe("niveauMot", Mots.NIVEAUX);
    const vus = n === "vus";
    const duNiveau = vus ? dejaVus(Mots.TOUS) : Mots.TOUS.filter((it) => it.n === n);
    const compte = (genre) => {
      const l = duNiveau.filter((it) => aCeGenre(it, genre));
      return `<strong>${l.filter((it) => niveauDe(it, genre) >= 2).length}</strong> / ${l.length}`;
    };
    const anglais = duNiveau.filter((it) => !it.fr.length).length;

    vue.innerHTML = `
      <header class="rubrique-tete">
        <h1 class="titre"><span class="titre-jp" lang="ja">単語</span><span class="titre-fr">Le vocabulaire</span></h1>
        <p class="chapeau">Les mots du JLPT, du N5 au N1, les plus fréquents d'abord : les comprendre, les lire, puis
          les retrouver depuis le français.</p>
      </header>

      <div class="kana-barre">
        ${segmentNiveaux(Mots.NIVEAUX, n)}
        <label class="recherche">
          <span class="lecture-seule">Chercher un mot</span>
          <input type="search" id="mtCherche" placeholder="Chercher un mot, un sens…" autocomplete="off" spellcheck="false">
        </label>
      </div>
      <p class="kana-bilan bilan-fin" id="mtBilan">${vus ? `<strong>${pluriel(duNiveau.length, "mot")}</strong> déjà
        vu${duNiveau.length > 1 ? "s" : ""}, du plus récent au plus ancien : ` : ""}${compte("sens")} sus en sens ·
        ${compte("lire")} à la lecture · ${compte("dire")} retrouvés depuis le français</p>
      ${vus && !duNiveau.length ? `<p class="vide">Aucun mot vu pour l'instant : la séance du jour en fait découvrir.</p>` : ""}
      ${anglais ? `<p class="mt-avertissement" id="mtAnglais">${anglais === duNiveau.length ? "Les sens de ce niveau sont"
          : `${pluriel(anglais, "mot")} de ce niveau ${anglais > 1 ? "ont" : "a"} leur sens`} en anglais en attendant
          leur traduction : la réponse en anglais est acceptée.</p>` : ""}
      <ul class="mt-liste" id="mtListe"></ul>
      <p class="mt-suite"><button type="button" class="btn btn-second" id="mtPlus" hidden></button></p>`;

    const liste = $("mtListe");
    let montres = 0;
    function suite() {
      liste.insertAdjacentHTML("beforeend", duNiveau.slice(montres, montres + PAR_PAGE).map((it) => ligneMot(it, vus)).join(""));
      montres = Math.min(duNiveau.length, montres + PAR_PAGE);
      const reste = duNiveau.length - montres;
      $("mtPlus").hidden = reste <= 0;
      $("mtPlus").textContent = `Voir les ${Math.min(reste, PAR_PAGE)} suivants (${reste} en tout)`;
    }
    suite();
    $("mtPlus").addEventListener("click", suite);

    vue.querySelectorAll(".segment button").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("niveauMot", valeurNiveau(b));
      rend();
    }));
    liste.addEventListener("click", (e) => {
      const b = e.target.closest(".mt-ligne");
      if (b) ouvreFicheMot(Mots.PAR_ID.get(b.dataset.id), b);
    });
    $("mtCherche").addEventListener("input", (e) => {
      const q = e.target.value.trim();
      $("mtBilan").hidden = !!q;
      if (!q) {
        liste.innerHTML = "";
        montres = 0;
        suite();
        return;
      }
      const trouves = Mots.cherche(q);
      $("mtPlus").hidden = true;
      liste.innerHTML = trouves.length ? trouves.map((it) => ligneMot(it, true)).join("")
        : `<li class="vide">Rien ne correspond à « ${echappe(q)} ».</li>`;
    });
  }

  function ligneMot(it, avecNiveau) {
    const genres = GENRES_MOT.filter(([g]) => aCeGenre(it, g));
    const etats = genres.map(([g, nom]) => `${nom.toLowerCase()} : ${NIVEAUX[niveauDe(it, g)]}`).join(", ");
    const sens = Mots.sens(it, 3).join(", ");
    return `<li><button type="button" class="mt-ligne" data-id="${echappe(it.id)}"
        aria-label="${echappe(`${it.m}${it.kanjis ? `, ${it.l[0]}` : ""} : ${sens}. ${etats}.`)}">
      ${avecNiveau ? `<span class="kj-niveau">N${it.n}</span>` : ""}
      <span class="mt-ligne-jp"><span class="mt-ligne-mot" lang="ja">${echappe(romaji() ? Romaji.mot(it) : it.m)}</span>${
        it.kanjis && !romaji() ? `<span class="mt-ligne-kana" lang="ja">${echappe(it.l[0])}</span>` : ""}</span>
      <span class="mt-ligne-sens">${echappe(sens)}${it.fr.length ? "" : ' <em class="en">(en)</em>'}</span>
      <span class="kn-jauges mt-jauges" aria-hidden="true">${genres.map(([g]) => `<i class="niv niv-${niveauDe(it, g)}"></i>`).join("")}</span>
    </button></li>`;
  }

  /* =====================================================================
     文法 - La grammaire
     ===================================================================== */
  function vueGrammaire(vue) {
    const niveaux = Grammaire.NIVEAUX;
    const choisi = +Pref.lit("niveauGram", niveaux[0]);
    const n = niveaux.includes(choisi) ? choisi : niveaux[0];
    const duNiveau = Grammaire.TOUS.filter((it) => it.n === n);
    const chapitres = Grammaire.CHAPITRES.filter((c) => c.n === n);
    const sus = duNiveau.filter((it) => niveauDe(it, "completer") >= 2).length;
    const vus = duNiveau.filter(commence).length;

    vue.innerHTML = `
      <header class="rubrique-tete">
        <h1 class="titre"><span class="titre-jp" lang="ja">文法</span><span class="titre-fr">La grammaire</span></h1>
        <p class="chapeau">Du N5 au N1, chaque point appuyé sur ceux d'avant : une fiche pour comprendre, des phrases
          à compléter pour retenir.</p>
      </header>
      ${gramCarteHtml("Le prochain point")}

      <div class="kana-barre">
        <div class="segment" role="radiogroup" aria-label="Niveau du JLPT">
          ${niveaux.map((x) => `<button type="button" role="radio" data-niveau="${x}" aria-checked="${x === n}">N${x}</button>`).join("")}
        </div>
        <label class="recherche">
          <span class="lecture-seule">Chercher un point de grammaire</span>
          <input type="search" id="grCherche" placeholder="Chercher : motif, rōmaji ou sens" autocomplete="off" spellcheck="false">
        </label>
      </div>
      <div class="gr-barre">
        <p class="kana-bilan" id="grBilan"><strong>${sus}</strong> / ${duNiveau.length} sus · ${pluriel(vus, "point")} découvert${vus > 1 ? "s" : ""}
          · ${pluriel(chapitres.length, "chapitre")}</p>
        ${reglageFurigana()}
      </div>
      ${grammaireOuverte() ? "" : `<p class="mt-avertissement">La grammaire s'ouvre une fois les hiraganas découverts,
        avec が, だ, で… : ses phrases en sont faites. Les fiches se lisent déjà.</p>`}
      <nav class="gr-sommaire" id="grSommaire" aria-label="Les chapitres du N${n}">
        ${chapitres.map((c) => `<button type="button" data-chap="${echappe(idChapitre(c))}">
          <span class="gr-sommaire-n" lang="ja">${enChiffresJaponais(c.numero)}</span>${texteHtml(c.nom)}</button>`).join("")}
      </nav>
      <div id="grListe">${listeGramHtml(duNiveau)}</div>`;

    const liste = $("grListe");
    brancheGram(vue);
    brancheFurigana(vue);
    vue.querySelectorAll(".segment [data-niveau]").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("niveauGram", +b.dataset.niveau);
      rend();
    }));
    $("grSommaire").addEventListener("click", (e) => {
      const b = e.target.closest("[data-chap]");
      const section = b && $(b.dataset.chap);
      if (section) section.open = true;
      if (section) section.scrollIntoView({ block: "start",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
    liste.addEventListener("click", (e) => {
      const b = e.target.closest(".gr-ligne");
      if (b) ouvreFicheGram(Grammaire.PAR_ID.get(b.dataset.id), b);
    });
    $("grCherche").addEventListener("input", (e) => {
      const q = e.target.value.trim();
      const trouves = q ? Grammaire.cherche(q) : duNiveau;
      $("grSommaire").hidden = !!q;
      liste.innerHTML = trouves.length ? listeGramHtml(trouves, !!q)
        : `<p class="vide">Rien ne correspond à « ${echappe(q)} ».</p>`;
    });
  }

  /* Le prochain point, en grand, comme le prochain texte : sur la page
     Aujourd'hui et en tête de la grammaire ; et les phrases qui reviennent,
     s'il y en a. Rien quand il n'y a ni l'un ni l'autre. */
  function gramCarteHtml(sur) {
    const { dues, suivant: it } = planGrammaire();
    if (!it && !dues.length) return "";
    const revoir = dues.length ? `${pluriel(dues.length, "phrase")} à revoir` : "";
    if (!it) {
      return `
      <section class="feuille lc-suivant">
        <span class="lc-suivant-jp" lang="ja" aria-hidden="true">文</span>
        <div class="lc-suivant-texte">
          <p class="lc-sur">Grammaire</p>
          <h2 class="lc-suivant-titre">${revoir[0].toUpperCase() + revoir.slice(1)}</h2>
          <p class="lc-suivant-intro">Les points déjà étudiés reviennent, avec une autre phrase à chaque fois.</p>
        </div>
        <button type="button" class="btn btn-grand" data-etudier="">復習 <span>Revoir</span></button>
      </section>`;
    }
    const pour = gramPourTexte();
    const pourLire = pour && pour.point === it
      ? ` Il sert à lire <span lang="ja">${titreHtml(pour.texte)}</span>, le prochain texte.` : "";
    return `
      <section class="feuille lc-suivant">
        <span class="lc-suivant-jp" lang="ja" aria-hidden="true">文</span>
        <div class="lc-suivant-texte">
          <p class="lc-sur">${sur} · N${it.n} · ${texteHtml(it.chap)}</p>
          <h2 class="lc-suivant-titre">${motifHtml(it)} <span class="lc-suivant-fr">${texteHtml(it.sens)}</span></h2>
          <p class="lc-suivant-intro">Une fiche à lire, puis deux phrases à compléter.${pourLire}${dues.length
            ? ` Et ${revoir}.` : ""}</p>
        </div>
        <button type="button" class="btn btn-grand" data-etudier="${echappe(it.nom)}">学ぶ <span>Étudier</span></button>
      </section>`;
  }
  function brancheGram(racine) {
    racine.querySelectorAll("[data-etudier]").forEach((b) => b.addEventListener("click", () => {
      lanceGrammaire(Grammaire.PAR_NOM.get(b.dataset.etudier) || null);
    }));
  }

  /* 1 à 99 en chiffres japonais : 一, 十, 十二, 二十. */
  function enChiffresJaponais(n) {
    const C = "〇一二三四五六七八九", d = Math.floor(n / 10), u = n % 10;
    return (d > 1 ? C[d] : "") + (d ? "十" : "") + (u ? C[u] : "");
  }
  const idChapitre = (c) => `gr-chap-${c.n}-${c.numero}`;

  /* Les points, rangés par chapitre. Chaque chapitre s'ouvre sur son sceau
     (son numéro, en chiffres japonais), ce qu'il contient, et une jauge
     d'un trait par point. Il se replie : seul celui du prochain point est
     ouvert d'emblée - les autres se lisent à leur tête, la liste entière
     faisait neuf mille pixels sur un téléphone. Une recherche mêle les
     niveaux et ne garde que quelques points par chapitre, tous ouverts :
     ni sommaire, ni jauge, le niveau dit. */
  function listeGramHtml(items, recherche) {
    const groupes = [];
    items.forEach((it) => {
      const dernier = groupes[groupes.length - 1];
      if (dernier && dernier.c === it.chapitre) dernier.items.push(it);
      else groupes.push({ c: it.chapitre, items: [it] });
    });
    // ouvert : le chapitre du prochain point ; à défaut (un autre niveau),
    // le premier qui a encore à étudier ; à défaut, le dernier
    const suivant = gramSuivant();
    const cible = groupes.find((g) => suivant && g.c === suivant.chapitre)
      || groupes.find((g) => g.c.items.some((it) => !commence(it))) || groupes[groupes.length - 1];
    const ouvert = (c) => recherche || (cible && cible.c === c);
    return groupes.map(({ c, items: dedans }) => {
      const decouverts = c.items.filter(commence).length;
      return `
      <details class="gr-chapitre"${recherche ? "" : ` id="${idChapitre(c)}"`}${ouvert(c) ? " open" : ""}>
        <summary class="gr-chapitre-tete">
          <span class="gr-sceau" lang="ja" aria-hidden="true">${enChiffresJaponais(c.numero)}</span>
          <div class="gr-chapitre-texte">
            <p class="gr-chapitre-sur">${recherche ? `N${c.n} · ` : ""}Chapitre ${c.numero} · ${pluriel(c.items.length, "point")}${
              recherche ? "" : ` · ${decouverts} étudié${decouverts > 1 ? "s" : ""}`}</p>
            <h2 class="gr-chapitre-titre">${texteHtml(c.nom)}</h2>
            ${recherche || !c.intro ? "" : `<p class="gr-chapitre-intro">${texteHtml(c.intro)}</p>`}
          </div>
          ${recherche ? "" : `<span class="gr-chapitre-jauge" role="img"
            aria-label="${echappe(`${decouverts} sur ${c.items.length} découverts`)}">${c.items.map((it) =>
              `<i class="niv niv-${niveauDe(it, "completer")}"></i>`).join("")}</span>`}
        </summary>
        <ol class="gr-liste">${dedans.map(ligneGram).join("")}</ol>
      </details>`;
    }).join("");
  }

  function ligneGram(it) {
    const niv = niveauDe(it, "completer");
    return `<li><button type="button" class="gr-ligne" data-id="${echappe(it.id)}"
        aria-label="${echappe(`${it.court} : ${Grammaire.surface(it.sens).replace(/\*\*/g, "")}. ${NIVEAUX[niv]}.`)}">
      <span class="gr-numero">${it.numero}</span>
      <span class="gr-ligne-titre">${motifHtml(it)}</span>
      <span class="gr-ligne-sens">${texteHtml(it.sens)}</span>
      <span class="kn-jauges gr-jauges" aria-hidden="true"><i class="niv niv-${niv}"></i></span>
    </button></li>`;
  }

  /* =====================================================================
     読解 - La lecture
     =====================================================================
     Deux vues à la même adresse : la liste des textes (/nihongo/lecture)
     et la liseuse d'un texte (/nihongo/lecture?t=hajimemashite) - une
     adresse qu'on peut garder, que le bouton « retour » sait défaire.

     Dans la liseuse, chaque mot se touche : le pupitre, en bas de l'écran,
     dit sa lecture, son sens, sa forme (起きました : 起きる, poli, passé),
     les points de grammaire qui l'expliquent, et s'il est déjà appris -
     sinon, on peut le demander, et il viendra à la prochaine séance.
     Chaque phrase s'écoute, seule ou à la suite ; dans un dialogue, chacun
     parle avec sa voix.

     Les furigana, au choix (sur cet appareil) : partout ; sauf sur les mots
     déjà sus à la lecture, si bien qu'ils s'effacent à mesure qu'on
     apprend ; ou nulle part, un mot touché montrant alors les siens. */
  const MODES_FURIGANA = [["toutes", "Partout"], ["auto", "Sauf les mots sus"], ["aucune", "Nulle part"]];
  function furiganaLecture() {
    const f = Pref.lit("furiganaLecture", "auto");
    return MODES_FURIGANA.some(([m]) => m === f) ? f : "auto";
  }
  function segmentFuriganaLecture(mode) {
    return `<div class="segment segment-petit" role="radiogroup" aria-label="Furigana des textes">
      ${MODES_FURIGANA.map(([m, nom]) => `<button type="button" role="radio" data-furi="${m}"
        aria-checked="${m === mode}">${nom}</button>`).join("")}
    </div>`;
  }

  /* Ce que le serveur sait des textes lus. Un serveur pas encore redémarré
     depuis l'arrivée de la lecture n'en dit rien. */
  const lectures = () => ETAT.lectures || {};
  function estLu(t) {
    return !!lectures()[t.nom];
  }
  const COMPRIS = { 1: "pas grand-chose", 2: "l'essentiel", 3: "tout" };

  /* Un texte se propose quand il est à portée : on connaît la grande
     majorité de ce qu'il emploie - PORTEE de ses mots du vocabulaire (vus
     en séance), et autant de ses points de grammaire (étudiés). Les mots
     hors des listes du JLPT n'y entrent pas : la séance ne les apprend
     pas, le pupitre les explique. Un texte hors de portée reste ouvert à
     qui le choisit dans la liste ; il n'est simplement pas proposé. */
  const PORTEE = 0.8;
  function portee(t) {
    const mots = t.mots.filter((v) => commence(Mots.TOUS[v])).length;
    const points = t.points.map((nom) => Grammaire.PAR_NOM.get(nom)).filter(Boolean);
    const sus = points.filter(commence).length;
    const part = (n, total) => (total ? n / total : 1);
    return { mots, totalMots: t.mots.length, points: sus, totalPoints: points.length,
             pret: part(mots, t.mots.length) >= PORTEE && part(sus, points.length) >= PORTEE };
  }
  /* « 14 mots sur 16 et 6 points de grammaire sur 7 » */
  function porteeHtml(p) {
    const l = [];
    if (p.totalMots) l.push(`${p.mots} mot${p.mots > 1 ? "s" : ""} sur ${p.totalMots}`);
    if (p.totalPoints) l.push(`${p.points} point${p.points > 1 ? "s" : ""} de grammaire sur ${p.totalPoints}`);
    return l.join(" et ");
  }

  /* Le texte à proposer : le premier qu'on n'a pas lu et qui est à portée. */
  function texteSuivant() {
    return Lecture.TEXTES.find((t) => !estLu(t) && portee(t).pret) || null;
  }
  /* Le premier qu'on n'a pas lu, à portée ou non : celui qui vient. */
  function texteAVenir() {
    return Lecture.TEXTES.find((t) => !estLu(t)) || null;
  }

  function ouvreTexte(t) {
    va("lecture", `?t=${t.nom}`);
  }
  function texteDemande() {
    const m = /[?&]t=([a-z0-9-]+)/.exec(location.search);
    return (m && Lecture.PAR_NOM.get(m[1])) || null;
  }

  function vueLecture(vue) {
    const t = texteDemande();
    if (t) liseuse(vue, t);
    else listeTextes(vue);
  }

  /* Le prochain texte, en grand : sur la page Aujourd'hui et en tête de
     la liste. */
  function suivantHtml(t, sur) {
    const p = portee(t);
    return `
      <section class="feuille lc-suivant">
        <span class="lc-suivant-jp" lang="ja" aria-hidden="true">読</span>
        <div class="lc-suivant-texte">
          <p class="lc-sur">${sur} · N${t.n} · ${Lecture.GENRES[t.genre]} · ${Lecture.minutes(t)} min</p>
          <h2 class="lc-suivant-titre"><span lang="ja">${titreHtml(t)}</span>
            <span class="lc-suivant-fr">${echappe(t.fr)}</span></h2>
          <p class="lc-suivant-intro">${texteHtml(t.intro)}</p>
          ${p.totalMots || p.totalPoints ? `<p class="lc-sur">Déjà connus : ${porteeHtml(p)}</p>` : ""}
        </div>
        <button type="button" class="btn btn-grand" data-lire="${echappe(t.nom)}">読む <span>Lire</span></button>
      </section>`;
  }
  function aLireHtml() {
    const t = texteSuivant();
    return t ? suivantHtml(t, "À lire") : "";
  }
  /* Aucun texte à portée : celui qui vient, ce qui lui manque, et de quoi
     demander ses mots - la séance les fera découvrir avant les autres. */
  function bientotHtml(t) {
    const nouveaux = motsNouveaux(t).length, demandes = demandesDuTexte(t).length;
    return `
      <section class="feuille lc-suivant lc-bientot">
        <span class="lc-suivant-jp" lang="ja" aria-hidden="true">待</span>
        <div class="lc-suivant-texte">
          <p class="lc-sur">Bientôt · N${t.n} · ${Lecture.GENRES[t.genre]}</p>
          <h2 class="lc-suivant-titre"><span lang="ja">${titreHtml(t)}</span>
            <span class="lc-suivant-fr">${echappe(t.fr)}</span></h2>
          <p class="lc-suivant-intro">Proposé dès que tu en connaîtras ${Math.round(PORTEE * 100)} % - pour
            l'instant, ${porteeHtml(portee(t))}. Ses mots et sa grammaire passent en premier dans tes séances.</p>
        </div>
        ${nouveaux ? `<button type="button" class="btn btn-second" id="lcApprendre" data-texte="${echappe(t.nom)}">
          Apprendre ses ${pluriel(nouveaux, "mot")}</button>`
          : demandes ? `<p class="lc-demandes">${demandes > 1 ? `${demandes} de ses mots sont demandés`
            : "Un de ses mots est demandé"} : ${demandes > 1 ? "ils passent" : "il passe"} en premier.
            <button type="button" class="btn-lien" id="lcAnnule" data-texte="${echappe(t.nom)}">Annuler</button></p>` : ""}
      </section>`;
  }
  function brancheALire(racine) {
    racine.querySelectorAll("[data-lire]").forEach((b) => b.addEventListener("click", () => {
      ouvreTexte(Lecture.PAR_NOM.get(b.dataset.lire));
    }));
  }

  function listeTextes(vue) {
    const niveaux = Lecture.NIVEAUX;
    const suivant = texteSuivant();
    const avenir = texteAVenir();
    const defaut = avenir ? avenir.n : niveaux[0];
    const choisi = +Pref.lit("niveauLecture", defaut);
    const n = niveaux.includes(choisi) ? choisi : defaut;
    const duNiveau = Lecture.TEXTES.filter((t) => t.n === n);
    const lus = duNiveau.filter(estLu).length;

    vue.innerHTML = `
      <header class="rubrique-tete">
        <h1 class="titre"><span class="titre-jp" lang="ja">読解</span><span class="titre-fr">La lecture</span></h1>
        <p class="chapeau">Du N5 au N1, de la vie de Léa à Tokyo aux contes et aux articles. Chaque mot se touche,
          chaque phrase s'écoute.</p>
      </header>
      ${suivant ? suivantHtml(suivant, "Le prochain texte") : avenir ? bientotHtml(avenir) : ""}
      <div class="kana-barre lc-barre">
        <div class="segment" role="radiogroup" aria-label="Niveau du JLPT">
          ${niveaux.map((x) => `<button type="button" role="radio" data-niveau="${x}" aria-checked="${x === n}">N${x}</button>`).join("")}
        </div>
        <p class="kana-bilan"><strong>${lus}</strong> / ${pluriel(duNiveau.length, "texte")} lu${duNiveau.length > 1 ? "s" : ""}</p>
      </div>
      <ol class="lc-grille">${duNiveau.map(carteTexte).join("")}</ol>`;

    brancheALire(vue);
    const apprendre = $("lcApprendre");
    if (apprendre) {
      apprendre.addEventListener("click", async () => {
        const t = Lecture.PAR_NOM.get(apprendre.dataset.texte);
        if (await demandeMots(motsNouveaux(t).map((it) => it.id), true)) rend();
      });
    }
    const annule = $("lcAnnule");
    if (annule) {
      annule.addEventListener("click", async () => {
        const t = Lecture.PAR_NOM.get(annule.dataset.texte);
        if (await demandeMots(demandesDuTexte(t).map((it) => it.id), false)) rend();
      });
    }
    vue.querySelectorAll(".segment [data-niveau]").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("niveauLecture", +b.dataset.niveau);
      rend();
    }));
    vue.querySelector(".lc-grille").addEventListener("click", (e) => {
      const b = e.target.closest(".lc-carte");
      if (b) ouvreTexte(Lecture.PAR_NOM.get(b.dataset.nom));
    });
  }

  function carteTexte(t) {
    const l = lectures()[t.nom];
    const p = portee(t);
    const part = p.totalMots ? Math.round(100 * p.mots / p.totalMots) : 100;
    return `<li><button type="button" class="lc-carte${l ? " lc-lue" : ""}" data-nom="${echappe(t.nom)}">
      <span class="lc-sur">${t.numero} · ${Lecture.GENRES[t.genre]}</span>
      <span class="lc-carte-titre" lang="ja">${titreHtml(t)}</span>
      <span class="lc-carte-fr">${echappe(t.fr)}</span>
      <span class="lc-carte-intro">${texteHtml(t.intro)}</span>
      <span class="lc-carte-pied">
        <span>${pluriel(t.phrases.length, "phrase")} · ${Lecture.minutes(t)} min</span>
        ${p.totalMots ? `<span class="lc-vus" role="img" aria-label="${p.mots} mots sur ${p.totalMots} déjà vus en séance">
          <i style="width:${part}%"></i></span><span>${part} % des mots${p.totalPoints
            ? ` · grammaire ${p.points} / ${p.totalPoints}` : ""}</span>` : ""}
      </span>
      ${l ? `<span class="lc-tampon" aria-label="Lu${l.f > 1 ? ` ${l.f} fois` : ""}" lang="ja">済</span>` : ""}
    </button></li>`;
  }

  /* ---------- la liseuse ---------- */
  let LISEUSE = null;            // { t, debut, ecoute, minuteur }

  function liseuse(vue, t) {
    const mode = furiganaLecture();
    const traduite = Pref.lit("traductionLecture", false) === true;
    const duNiveau = Lecture.TEXTES.filter((x) => x.n === t.n);
    const i = Lecture.TEXTES.indexOf(t);
    const prec = Lecture.TEXTES[i - 1], suiv = Lecture.TEXTES[i + 1];
    LISEUSE = { t, debut: Date.now(), ecoute: false, minuteur: null };

    vue.innerHTML = `
      <article class="ls">
        <nav class="ls-nav">
          <button type="button" class="btn-lien" id="lsRetour">← Les textes du N${t.n}</button>
          <span>${Lecture.GENRES[t.genre]} · ${t.numero} / ${duNiveau.length}</span>
        </nav>
        <header class="ls-tete">
          <h1 class="ls-titre" lang="ja">${titreHtml(t)}</h1>
          <p class="ls-titre-fr">${echappe(t.fr)}</p>
          <p class="ls-intro">${texteHtml(t.intro)}</p>
        </header>
        <div class="ls-outils">
          ${romaji() ? "" : `<div class="ls-outil">
            <span class="ls-outil-nom">Furigana</span>
            ${segmentFuriganaLecture(mode)}
          </div>`}
          <div class="ls-outil">
            <button type="button" class="ls-bascule" id="lsTrad" aria-pressed="${traduite}">Traduction</button>
            <button type="button" class="btn-son" id="lsEcoute">${ICONE_SON}<span>Tout écouter</span></button>
          </div>
        </div>
        <div class="ls-texte furi-${mode}${traduite ? " ls-traduite" : ""}" id="lsTexte" lang="ja">${corpsTexte(t)}</div>
        <p class="ls-aide">Touche un mot : sa lecture, son sens, sa forme. Les flèches passent d'un mot à l'autre.</p>
        ${questionsHtml(t)}
        <section class="feuille ls-fin" id="lsFin">${finHtml(t)}</section>
        <details class="ls-mots" id="lsMots">${motsDuTexteHtml(t)}</details>
        <nav class="fi-nav ls-suite">
          ${prec ? `<button type="button" class="btn-lien" data-lire="${echappe(prec.nom)}">← <span lang="ja">${titreHtml(prec)}</span></button>` : "<span></span>"}
          ${suiv ? `<button type="button" class="btn-lien" data-lire="${echappe(suiv.nom)}"><span lang="ja">${titreHtml(suiv)}</span> →</button>` : "<span></span>"}
        </nav>
      </article>
      <div class="pupitre" id="pupitre" role="dialog" aria-label="Le mot touché" hidden></div>`;

    const texte = $("lsTexte");
    $("lsRetour").addEventListener("click", () => {
      Pref.ecrit("niveauLecture", t.n);
      va("lecture");
    });
    vue.querySelectorAll("[data-furi]").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("furiganaLecture", b.dataset.furi);
      MODES_FURIGANA.forEach(([m]) => texte.classList.toggle(`furi-${m}`, m === b.dataset.furi));
      vue.querySelectorAll("[data-furi]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    }));
    $("lsTrad").addEventListener("click", () => {
      const oui = !texte.classList.contains("ls-traduite");
      texte.classList.toggle("ls-traduite", oui);
      $("lsTrad").setAttribute("aria-pressed", String(oui));
      Pref.ecrit("traductionLecture", oui);
    });
    $("lsEcoute").addEventListener("click", () => {
      if (LISEUSE.ecoute) arreteEcoute();
      else ecouteTout(LISEUSE.choisi ? +LISEUSE.choisi.dataset.m.split(".")[0] : 0);
    });
    texte.addEventListener("click", (e) => {
      const mot = e.target.closest(".ls-mot");
      if (mot) ouvrePupitre(mot);
      else fermePupitre();
    });
    texte.addEventListener("keydown", (e) => {
      const mot = e.target.closest(".ls-mot");
      if (mot && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        ouvrePupitre(mot);
      }
    });
    brancheQuestions(t);
    brancheFin(t);
    brancheMotsDuTexte(t);
    brancheALire(vue.querySelector(".ls-suite"));
  }

  function quitteLiseuse() {
    if (!LISEUSE) return;
    arreteEcoute();
    fermePupitre();
    LISEUSE = null;
  }

  /* Le texte : des paragraphes de phrases ; un dialogue, une réplique par
     ligne, avec qui parle. Chaque phrase porte sa traduction, que la
     bascule « Traduction » fait apparaître dessous. */
  function corpsTexte(t) {
    const phrase = (ph) => phraseLs(ph, t.n);
    return t.p.map((par) => {
      if (par.some((ph) => ph.qui)) {
        return `<div class="ls-dialogue">${par.map((ph) => `<p class="ls-replique">
          <span class="ls-qui">${!ph.qui ? "" : romaji() ? echappe(Romaji.capitale(roTexte(ph.qui)))
            : enJaponais(ph.qui, t.n)}</span>
          <span class="ls-dit">${phrase(ph)}</span></p>`).join("")}</div>`;
      }
      // en rōmaji, une espace entre deux phrases, comme en français
      return `<p class="ls-par">${par.map(phrase).join(romaji() ? " " : "")}</p>`;
    }).join("");
  }

  function phraseLs(ph, n) {
    let majuscule = true;
    const mots = ph.m.map((m, j) => {
      if (!romaji()) return motLs(m, ph.i, j, n);
      // la phrase commence par une capitale, un nom propre aussi
      let r = Romaji.de(kanaLs(m)).replace(/ {2,}/g, " ").trim();
      if ((majuscule && /[a-z]/.test(r)) || (typeof m.x === "number"
          && NOMS_PROPRES.test(Lecture.GLOSSAIRE[m.x].nature || ""))) r = Romaji.capitale(r);
      if (/[a-zāīūēō]/i.test(r)) majuscule = false;
      if (typeof m === "string" && /[。？！]/.test(m)) majuscule = true;
      return jointLs(ph.m[j - 1], m) + (typeof m === "string" ? echappe(r) : spanLs(m, ph.i, j, echappe(r)));
    });
    return `<span class="ls-phrase" data-ph="${ph.i}">${mots.join("")}</span>`
      + `<span class="ls-fr" lang="fr">${echappe(ph.fr)}</span>`;
  }

  /* ---------- un texte en rōmaji ----------
     Les mots arrivent découpés : chacun se transcrit seul, ses particules
     comme elles se disent (は : wa), une espace entre deux - sauf devant la
     ponctuation, après un guillemet ouvrant, et devant un suffixe (田中さん :
     Tanaka-san). */
  const OUVRANTS = "「『（・";
  const HONORIFIQUES = new Set(["さん", "さま", "様", "くん", "君", "ちゃん", "殿", "氏"]);
  const NOMS_PROPRES = /prénom|nom de lieu|nom propre|nom de famille/;
  const COPULES = ["です", "でした", "でしょう", "だ", "だった", "だろう", "な", "に", "じゃない", "ではない",
                   "じゃありません", "ではありません", "じゃなかった", "ではなかった"];
  /* Ses kanas, prêts à transcrire (voir Romaji.prepare). Un mot du texte
     emporte ses terminaisons : la forme en て se détache de ce qui suit
     ({住|す}んでいます : sunde imasu, 食べてもいい : tabete mo ii), et un
     adjectif de sa copule (大好きです : daisuki desu), comme en Hepburn. */
  function kanaLs(m) {
    if (typeof m === "string") return m;
    const lu = Lecture.lecture(m.t);
    if (m.k) return lu.replace(/は/g, "わ").replace(/へ/g, "え");
    if (typeof m.v === "number") {
      const it = Mots.TOUS[m.v];
      let k = lu;
      if ((m.g || []).some((g) => /^te-/.test(g))) {
        k = k.replace(/([てで])([^てで]+)$/, (x, te, reste) =>
          `${te} ${reste.replace(/^は/, "わ ").replace(/^も(?=.)/, "も ")}`);
      }
      const base = it.l.find((l) => k.startsWith(l));
      if (base && (it.p || []).some((c) => /^adj-(i|na)/.test(c)) && COPULES.includes(k.slice(base.length))) {
        k = `${base} ${k.slice(base.length)}`;
      }
      return Romaji.prepare(k, it.p);
    }
    if (typeof m.x === "number") return Romaji.prepare(lu, null, Lecture.GLOSSAIRE[m.x].nature);
    return lu;
  }
  function jointLs(avant, m) {
    if (avant === "・") return " ";
    if (avant === undefined || (typeof avant === "string" && OUVRANTS.includes(avant) && avant)) return "";
    if (typeof m === "string") return m && OUVRANTS.includes(m) ? " " : "";
    const suffixe = (typeof m.v === "number" && (Mots.TOUS[m.v].p || []).includes("suf"))
      || (typeof m.x === "number" && Lecture.GLOSSAIRE[m.x].nature === "suffixe");
    if (suffixe) return HONORIFIQUES.has(Lecture.surface(m.t)) ? "-" : "";
    return " ";
  }
  /* Un mot du texte, tel que la page l'affiche. */
  function ecritLs(m, n) {
    return romaji() ? echappe(Romaji.de(kanaLs(m)).trim()) : rubis(baliseLs(m, n));
  }

  /* Un mot du texte tel qu'il s'écrit ici : comme le mot du vocabulaire
     dans la séance ({住|す}んでいます passe en kanas tant que 住む s'y
     écrit すむ), et pour les autres, en kanas dès qu'un de leurs kanjis est
     hors de portée ({二|に}{階|かい} : にかい, pas 二かい). `n` : le niveau
     du texte. */
  function baliseLs(m, n) {
    const kanas = typeof m.v === "number" ? !enKanjis(Mots.TOUS[m.v]) : kanaise(m.t, n) !== m.t;
    return kanas ? Lecture.lecture(m.t) : m.t;
  }

  /* Un mot du vocabulaire est « su » à la lecture quand sa carte « lire »
     tient trois semaines : ses furigana s'effacent en mode « sauf les mots
     sus ». Un mot tout en kanas n'en a pas. */
  function motSu(m) {
    return typeof m.v === "number" && niveauDe(Mots.TOUS[m.v], "lire") >= 2;
  }
  function motLs(m, i, j, n) {
    if (typeof m === "string") return enJaponais(m, n);
    return spanLs(m, i, j, ecritLs(m, n));
  }
  function spanLs(m, i, j, contenu) {
    return `<span class="ls-mot${motSu(m) ? " su" : ""}${m.k ? " ls-particule" : ""}" data-m="${i}.${j}"
      role="button" tabindex="0">${contenu}</span>`;
  }

  /* ---------- le pupitre : ce qu'on sait du mot touché ---------- */
  function ouvrePupitre(el) {
    if (!LISEUSE) return;
    const [i, j] = el.dataset.m.split(".").map(Number);
    const t = LISEUSE.t, ph = t.phrases[i], m = ph.m[j];
    $("lsTexte").querySelectorAll(".ls-mot.choisi").forEach((x) => x.classList.remove("choisi"));
    el.classList.add("choisi");
    LISEUSE.choisi = el;
    const p = $("pupitre");
    p.innerHTML = pupitreHtml(t, ph, m);
    p.hidden = false;
    document.body.classList.add("pupitre-ouvert");
    branchePupitre(t, ph, m);
    // le mot reste visible au-dessus du pupitre
    const r = el.getBoundingClientRect();
    const haut = window.innerHeight - p.getBoundingClientRect().height;
    if (r.bottom > haut - 16) window.scrollBy({ top: r.bottom - haut + 48, behavior: mouvement() });
    else if (r.top < 120) window.scrollBy({ top: r.top - 140, behavior: mouvement() });
  }

  function fermePupitre() {
    const p = $("pupitre");
    if (!p || p.hidden) return;
    p.hidden = true;
    p.innerHTML = "";
    document.body.classList.remove("pupitre-ouvert");
    if (LISEUSE && LISEUSE.choisi) {
      LISEUSE.choisi.classList.remove("choisi");
      LISEUSE.choisi = null;
    }
  }

  const mouvement = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  /* Ici, le mot tel que le texte l'écrit (`balise`), s'il n'est pas sous
     sa forme du dictionnaire, et ce que disent ses terminaisons. */
  function formeHtml(m, balise, autre) {
    if (!m.f && !autre) return "";
    return `<p class="pp-forme"><span class="pp-ici">Ici</span> <span lang="ja">${romaji() ? ecritLs(m)
      : rubis(balise)}</span>${m.f
      ? ` : ${echappe(m.f)}` : ""}</p>`;
  }

  /* Les points de grammaire, en boutons qui ouvrent leur fiche. */
  function gramHtml(noms, titre) {
    const points = (noms || []).map((nom) => Grammaire.PAR_NOM.get(nom)).filter(Boolean).slice(0, 5);
    if (!points.length) return "";
    return `<div class="pp-gram"><span class="pp-gram-titre">${titre || "Grammaire"}</span>
      ${points.map((g) => `<button type="button" class="pp-point" data-point="${echappe(g.nom)}">${motifHtml(g, true)}</button>`).join("")}</div>`;
  }

  function etatMotHtml(it) {
    if (commence(it)) {
      const n = niveauDe(it, "sens");
      return `<i class="niv niv-${n}"></i><span>${NIVEAUX[n][0].toUpperCase() + NIVEAUX[n].slice(1)} :
        déjà dans tes révisions.</span> <button type="button" class="btn-lien" id="ppFiche">Sa fiche</button>`;
    }
    if (demande(it)) {
      return `<span class="pp-demande">Demandé : il viendra à la prochaine séance.</span>
        <button type="button" class="btn-lien" id="ppAnnule">Annuler</button>`;
    }
    return `<span>Pas encore appris.</span>
      <button type="button" class="btn btn-petit" id="ppApprendre">Apprendre ce mot</button>`;
  }

  function teteHtml(mot, kana) {
    return `<div class="pp-tete">
      <span class="pp-mot" lang="ja">${mot}</span>
      ${kana ? `<span class="pp-kana" lang="ja">${kana}</span>` : ""}
      <button type="button" class="pp-son" id="ppSon" aria-label="Écouter le mot">${ICONE_SON}</button>
    </div>`;
  }

  function pupitreHtml(t, ph, m) {
    const balise = baliseLs(m, t.n), enKanas = balise !== m.t;
    const ici = Lecture.surface(balise);
    let corps;
    if (typeof m.v === "number") {
      const it = Mots.TOUS[m.v], mot = graphie(it);
      corps = `
        ${teteHtml(echappe(motEcrit(it)), enKanjis(it) && !romaji() ? it.l.map(echappe).join(" · ") : "")}
        <p class="pp-nature">${echappe(Mots.nature(it) || "mot")} · N${it.n}${plusTardHtml(it)}${it.a
          ? ` · s'écrit aussi <span lang="ja">${echappe(it.a)}</span>` : ""}</p>
        <p class="pp-sens">${sensMotHtml(it, 5)}</p>
        ${formeHtml(m, balise, ici !== mot && ici !== it.m && ici !== it.a)}
        ${gramHtml(m.g)}
        <div class="pp-etat" id="ppEtat">${etatMotHtml(it)}</div>`;
    } else if (typeof m.x === "number") {
      const e = Lecture.GLOSSAIRE[m.x], mot = enKanas ? e.l : e.m;
      const ecrit = !romaji() ? mot : NOMS_PROPRES.test(e.nature || "")
        ? Romaji.capitale(Romaji.de(Romaji.prepare(e.l, null, e.nature))) : Romaji.de(Romaji.prepare(e.l, null, e.nature));
      corps = `
        ${teteHtml(echappe(ecrit), !enKanas && !romaji() && /[㐀-鿿々]/.test(e.m) ? echappe(e.l) : "")}
        <p class="pp-nature">${echappe(e.nature || "mot")} · hors des listes du JLPT${enKanas
          ? ` · en kanjis <span lang="ja">${echappe(e.m)}</span>` : ""}</p>
        <p class="pp-sens">${e.fr.map(echappe).join(", ")}</p>
        ${formeHtml(m, balise, ici !== mot)}
        ${gramHtml(m.g)}`;
    } else if (m.n) {
      corps = `
        ${romaji() ? teteHtml(ecritLs(m), "") : teteHtml(echappe(ici), enKanas ? "" : echappe(Lecture.lecture(m.t)))}
        <p class="pp-nature">un nombre et son compteur</p>
        <p class="pp-sens">${echappe(m.n)}</p>`;
    } else if (m.k) {
      const pa = Lecture.PARTICULES[m.k] || { fr: "", g: [] };
      corps = `
        <div class="pp-tete"><span class="pp-mot" lang="ja">${romaji() ? ecritLs(m) : echappe(ici)}</span></div>
        <p class="pp-nature">particule</p>
        <p class="pp-sens">${texteHtml(pa.fr)}</p>
        ${gramHtml(pa.g, "Ses emplois")}`;
    } else {
      corps = `
        <div class="pp-tete"><span class="pp-mot" lang="ja">${romaji() ? ecritLs(m) : rubis(balise)}</span></div>
        <p class="pp-nature">${romaji() ? "desu, da" : "です, だ"} : « être »</p>
        ${m.f ? `<p class="pp-sens">${echappe(m.f)}</p>` : ""}
        ${gramHtml(m.g)}`;
    }
    return `
      <div class="pp-boite wrap">
        <button type="button" class="pp-x" id="ppX" aria-label="Fermer">&times;</button>
        <div class="pp-corps">${corps}</div>
        <div class="pp-phrase">
          <button type="button" class="btn-son" id="ppPhrase">${ICONE_SON}<span>La phrase</span></button>
          <button type="button" class="btn-lien" id="ppTrad">Sa traduction</button>
          ${gramHtml(ph.g, "Dans cette phrase")}
          <p class="pp-fr" id="ppFr" hidden>${echappe(ph.fr)}</p>
        </div>
      </div>`;
  }

  function branchePupitre(t, ph, m) {
    const p = $("pupitre");
    $("ppX").addEventListener("click", fermePupitre);
    const son = $("ppSon");
    if (son) {
      son.addEventListener("click", () => {
        arreteEcoute();
        if (typeof m.v === "number") dis(Mots.TOUS[m.v]);
        else if (typeof m.x === "number") dire(Lecture.GLOSSAIRE[m.x].m, Lecture.GLOSSAIRE[m.x].l);
        else dire(Lecture.surface(m.t), Lecture.lecture(m.t));
      });
    }
    $("ppPhrase").addEventListener("click", () => {
      arreteEcoute();
      surligne(ph.i);
      direPhraseTexte(t, ph, () => surligne(-1));
    });
    $("ppTrad").addEventListener("click", () => {
      $("ppFr").hidden = !$("ppFr").hidden;
    });
    p.querySelectorAll("[data-point]").forEach((b) => b.addEventListener("click", () => {
      ouvreFicheGram(Grammaire.PAR_NOM.get(b.dataset.point), b);
    }));
    if (typeof m.v === "number") brancheEtatMot(Mots.TOUS[m.v]);
  }

  function brancheEtatMot(it) {
    const fiche = $("ppFiche"), apprendre = $("ppApprendre"), annule = $("ppAnnule");
    if (fiche) fiche.addEventListener("click", () => ouvreFicheMot(it, fiche));
    const change = async (oui) => {
      if (!(await demandeMots([it.id], oui))) return;
      $("ppEtat").innerHTML = etatMotHtml(it);
      brancheEtatMot(it);
      if (LISEUSE) majMotsDuTexte(LISEUSE.t);
    };
    if (apprendre) apprendre.addEventListener("click", () => change(true));
    if (annule) annule.addEventListener("click", () => change(false));
  }

  /* Demander des mots (ou y renoncer) : le serveur les garde, la séance
     les fera découvrir en premier. */
  const DEMANDES_PAR_ENVOI = 300;          // DEMANDES_MAXI dans nihongo.py
  async function demandeMots(ids, oui) {
    if (!ids.length) return true;
    try {
      for (let i = 0; i < ids.length; i += DEMANDES_PAR_ENVOI) {
        const r = await api("/api/nihongo/demande", "POST", { mots: ids.slice(i, i + DEMANDES_PAR_ENVOI), oui });
        ETAT.demandes = r.demandes;
      }
      if (oui) toast(ids.length > 1 ? `${ids.length} mots viendront aux prochaines séances.`
                                    : "Il viendra à la prochaine séance.");
      else toast(ids.length > 1 ? `${ids.length} demandes annulées : ces mots reprennent leur place.`
                                : "Demande annulée.");
      return true;
    } catch (e) {
      toast(e.statut === 404 || e.statut === 405
        ? "Le serveur ne garde pas encore les demandes : il attend d'être redémarré."
        : "Demande non enregistrée : " + e.message, true);
      return false;
    }
  }

  /* Passer au mot d'avant ou d'après avec les flèches, le pupitre ouvert. */
  document.addEventListener("keydown", (e) => {
    if (!LISEUSE || !LISEUSE.choisi || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    if (!$("fiche").hidden || (e.target.closest && e.target.closest("input, select, textarea"))) return;
    const mots = [...$("lsTexte").querySelectorAll(".ls-mot")];
    const k = mots.indexOf(LISEUSE.choisi) + (e.key === "ArrowRight" ? 1 : -1);
    if (k < 0 || k >= mots.length) return;
    e.preventDefault();
    mots[k].focus({ preventScroll: true });
    ouvrePupitre(mots[k]);
  });

  /* ---------- écouter ----------
     Une phrase, ou tout le texte à la suite, la phrase dite surlignée.
     Dans un dialogue, chacun sa voix : le premier qui parle a la voix
     choisie, le second l'autre. */
  function voixDe(t, ph) {
    if (!ph.qui || t.voix.length < 2) return undefined;
    const choix = VOIX.findIndex((v) => v.id === Voix.choix());
    return VOIX[(Math.max(0, choix) + t.voix.indexOf(ph.qui)) % VOIX.length].id;
  }
  function direPhraseTexte(t, ph, fin) {
    Voix.ditPhrase(ph.son, Lecture.surface(Lecture.balise(ph)), () => {
      toast(SANS_VOIX, true);
      arreteEcoute();
    }, { voix: voixDe(t, ph), fin });
  }

  function surligne(i) {
    const texte = $("lsTexte");
    if (!texte) return;
    texte.querySelectorAll(".ls-phrase.dite").forEach((x) => x.classList.remove("dite"));
    const el = i >= 0 && texte.querySelector(`.ls-phrase[data-ph="${i}"]`);
    if (!el) return;
    el.classList.add("dite");
    const r = el.getBoundingClientRect();
    if (r.top < 110 || r.bottom > window.innerHeight - 40) el.scrollIntoView({ block: "center", behavior: mouvement() });
  }

  function majBoutonEcoute() {
    const b = $("lsEcoute");
    if (b) b.querySelector("span").textContent = LISEUSE && LISEUSE.ecoute ? "Arrêter" : "Tout écouter";
  }

  function ecouteTout(depuis) {
    const L = LISEUSE;
    if (!L) return;
    L.ecoute = true;
    majBoutonEcoute();
    let i = depuis;
    const suite = () => {
      if (LISEUSE !== L || !L.ecoute) return;
      if (i >= L.t.phrases.length) { arreteEcoute(); return; }
      const ph = L.t.phrases[i];
      surligne(i);
      direPhraseTexte(L.t, ph, () => {
        i++;
        L.minuteur = setTimeout(suite, 450);
      });
    };
    suite();
  }

  function arreteEcoute() {
    if (!LISEUSE) return;
    clearTimeout(LISEUSE.minuteur);
    if (LISEUSE.ecoute) {
      LISEUSE.ecoute = false;
      Voix.arrete();
    }
    surligne(-1);
    majBoutonEcoute();
  }

  /* ---------- les questions : pour soi, rien n'est noté ---------- */
  function questionsHtml(t) {
    return `
      <section class="feuille ls-questions">
        <h2 class="section-titre"><span lang="ja">問</span> Les questions</h2>
        <p class="ls-q-aide">Pour vérifier ce que tu as compris : rien n'est noté.</p>
        <ol class="ls-q">${t.q.map((q, i) => `
          <li data-q="${i}">
            <p class="ls-q-texte">${texteHtml(q.q)}</p>
            <div class="ls-choix">${melange(q.c.map((_, k) => k)).map((k) => `
              <button type="button" data-c="${k}">${texteHtml(q.c[k])}</button>`).join("")}</div>
          </li>`).join("")}</ol>
        <p class="ls-q-bilan" id="lsBilanQ" aria-live="polite"></p>
      </section>`;
  }

  function brancheQuestions(t) {
    let repondues = 0, justes = 0;
    document.querySelectorAll(".ls-q li").forEach((li) => {
      const q = t.q[+li.dataset.q];
      li.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => {
        if (li.classList.contains("repondue")) return;
        li.classList.add("repondue");
        const k = +b.dataset.c;
        b.classList.add(k === q.r ? "juste" : "faux");
        li.querySelector(`[data-c="${q.r}"]`).classList.add("juste");
        li.querySelectorAll("[data-c]").forEach((x) => { x.disabled = true; });
        repondues++;
        if (k === q.r) justes++;
        if (repondues === t.q.length) {
          $("lsBilanQ").textContent = justes === repondues ? "Tout juste."
            : `${justes} sur ${repondues}. Le texte est toujours là, au-dessus.`;
        }
      }));
    });
  }

  /* ---------- la fin : ce qu'on a compris, et ce qui reste ---------- */
  function dateCourte(iso) {
    return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  }

  function finHtml(t) {
    const l = lectures()[t.nom];
    return `
      <h2 class="section-titre"><span lang="ja">済</span> ${l ? "Relu jusqu'au bout ?" : "Lu jusqu'au bout ?"}</h2>
      <p class="ls-fin-texte">Qu'en as-tu compris ?</p>
      <div class="ls-compris">
        ${[3, 2, 1].map((c) => `<button type="button" class="btn btn-second" data-compris="${c}">${
          COMPRIS[c][0].toUpperCase() + COMPRIS[c].slice(1)}</button>`).join("")}
      </div>
      ${l ? `<p class="ls-deja">Déjà lu ${l.f > 1 ? `${l.f} fois` : "une fois"}, la dernière le
        ${dateCourte(l.l)} : compris ${COMPRIS[l.c]}.</p>` : ""}`;
  }

  function brancheFin(t) {
    $("lsFin").querySelectorAll("[data-compris]").forEach((b) => b.addEventListener("click", () => {
      enregistreLecture(t, +b.dataset.compris);
    }));
  }

  async function enregistreLecture(t, compris) {
    if (!LISEUSE) return;
    const secondes = Math.min(3600, Math.round((Date.now() - LISEUSE.debut) / 1000));
    $("lsFin").querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      const r = await api("/api/nihongo/lu", "POST", { texte: t.nom, compris, secondes });
      ETAT.lectures = Object.assign({}, ETAT.lectures, { [t.nom]: r.lecture });
      ETAT.aujourdhui = r.aujourdhui;
      ETAT.serie = r.serie;
    } catch (e) {
      $("lsFin").querySelectorAll("button").forEach((b) => { b.disabled = false; });
      toast(e.statut === 404 || e.statut === 405
        ? "Le serveur ne garde pas encore les lectures : il attend d'être redémarré."
        : "Lecture non enregistrée : " + e.message, true);
      return;
    }
    LISEUSE.debut = Date.now();
    const nouveaux = motsNouveaux(t);
    const suivant = texteSuivant();
    $("lsFin").innerHTML = `
      <div class="ls-fait">
        <div class="tampon" aria-hidden="true"><span lang="ja">済</span></div>
        <div>
          <h2 class="section-titre">${compris === 3 ? "Bravo." : compris === 2 ? "C'est l'essentiel." : "C'est un début."}</h2>
          <p>${compris === 3 ? "Ce texte est à toi." : compris === 2
            ? "Le relire dans quelques jours le rendra limpide."
            : "Les mots du texte, appris en séance, le rendront clair à la prochaine lecture."}</p>
          ${nouveaux.length ? `<p>${pluriel(nouveaux.length, "mot")} du texte ${nouveaux.length > 1 ? "ne sont" : "n'est"}
            pas encore dans tes révisions.
            <button type="button" class="btn-lien" id="lsApprendreFin">${nouveaux.length > 1 ? "Les apprendre" : "L'apprendre"}</button></p>` : ""}
          ${suivant && suivant !== t ? `<p><button type="button" class="btn" data-lire="${echappe(suivant.nom)}">Texte suivant :
            <span lang="ja">${titreHtml(suivant)}</span></button></p>` : ""}
        </div>
      </div>`;
    brancheALire($("lsFin"));
    const apprendre = $("lsApprendreFin");
    if (apprendre) {
      apprendre.addEventListener("click", async () => {
        if (!(await demandeMots(nouveaux.map((it) => it.id), true))) return;
        const fait = document.createElement("span");
        fait.innerHTML = `C'est demandé. <button type="button" class="btn-lien" id="lsAnnuleFin">Annuler</button>`;
        apprendre.replaceWith(fait);
        majMotsDuTexte(t);
        $("lsAnnuleFin").addEventListener("click", async () => {
          if (!(await demandeMots(nouveaux.map((it) => it.id), false))) return;
          fait.textContent = "Demande annulée.";
          majMotsDuTexte(t);
        });
      });
    }
  }

  /* ---------- les mots du texte ---------- */
  function motsNouveaux(t) {
    return t.mots.map((v) => Mots.TOUS[v]).filter((it) => !commence(it) && !demande(it));
  }
  function demandesDuTexte(t) {
    return t.mots.map((v) => Mots.TOUS[v]).filter(demande);
  }

  function motsDuTexteHtml(t) {
    if (!t.mots.length) return "";
    const items = t.mots.map((v) => Mots.TOUS[v]);
    const vus = items.filter(commence).length;
    const demandes = demandesDuTexte(t).length;
    const nouveaux = motsNouveaux(t).length;
    const morceaux = [`${vus} déjà vu${vus > 1 ? "s" : ""}`];
    if (demandes) morceaux.push(`${demandes} demandé${demandes > 1 ? "s" : ""}`);
    if (nouveaux) morceaux.push(`${nouveaux} nouveau${nouveaux > 1 ? "x" : ""}`);
    return `
      <summary><span class="section-titre"><span lang="ja">単語</span> Les ${items.length} mots du texte</span>
        <span class="ls-mots-bilan">${morceaux.join(", ")}</span></summary>
      ${nouveaux ? `<p class="ls-mots-action"><button type="button" class="btn btn-second" id="lsApprendre">
        Apprendre les ${nouveaux} nouveau${nouveaux > 1 ? "x" : ""}</button>
        <span>Ils viendront dans les prochaines séances, avant les autres.</span></p>` : ""}
      ${demandes ? `<p class="ls-mots-action"><span>${demandes > 1 ? `${demandes} sont demandés : ils passent`
        : "Un est demandé : il passe"} avant les autres dans les séances.</span>
        <button type="button" class="btn-lien" id="lsAnnule">Annuler ${demandes > 1 ? "ces demandes" : "la demande"}</button></p>` : ""}
      <ul class="mt-liste ls-liste">${items.map((it) => ligneMot(it, true)).join("")}</ul>`;
  }

  function brancheMotsDuTexte(t) {
    const zone = $("lsMots");
    if (!zone) return;
    const apprendre = $("lsApprendre");
    if (apprendre) {
      apprendre.addEventListener("click", async () => {
        if (await demandeMots(motsNouveaux(t).map((it) => it.id), true)) majMotsDuTexte(t);
      });
    }
    const annule = $("lsAnnule");
    if (annule) {
      annule.addEventListener("click", async () => {
        if (await demandeMots(demandesDuTexte(t).map((it) => it.id), false)) majMotsDuTexte(t);
      });
    }
    zone.querySelectorAll(".mt-ligne").forEach((b) => b.addEventListener("click", () => {
      ouvreFicheMot(Mots.PAR_ID.get(b.dataset.id), b);
    }));
  }

  function majMotsDuTexte(t) {
    const zone = $("lsMots");
    if (!zone) return;
    const ouvert = zone.open;
    zone.innerHTML = motsDuTexteHtml(t);
    zone.open = ouvert;
    brancheMotsDuTexte(t);
  }

  /* =====================================================================
     Les fiches
     ===================================================================== */
  let FICHE = { retour: null, demo: null, trace: null };

  function videFiche() {
    if (FICHE.demo) FICHE.demo.detruit();
    if (FICHE.trace) FICHE.trace.detruit();
    FICHE.demo = FICHE.trace = null;
  }

  function etatHtml(item, genres) {
    return `<dl class="fi-etat">${genres.map(([genre, nom, absente]) => {
      const c = ETAT.cartes[cleDe(item, genre)];
      const texte = !c && absente ? absente : `${NIVEAUX[niveau(c)]} · ${echeance(c)}`;
      return `<div><dt>${nom}</dt><dd><i class="niv niv-${niveau(c)}"></i>${texte}</dd></div>`;
    }).join("")}</dl>`;
  }

  function pratiqueHtml() {
    return `
      <div class="fi-pratique">
        <div class="fi-pratique-tete">
          <h3>S'exercer</h3>
          <div class="segment segment-petit" role="radiogroup" aria-label="Façon de tracer">
            <button type="button" role="radio" data-mode="guide" aria-checked="true">Avec modèle</button>
            <button type="button" role="radio" data-mode="memoire" aria-checked="false">De mémoire</button>
          </div>
        </div>
        <div class="tr-hote fi-trace" id="fiTrace"></div>
        <p class="fi-retour" id="fiRetour" aria-live="polite">Rien de ce qui se trace ici ne compte dans les révisions.</p>
        <button type="button" class="btn-lien" id="fiEncore">Recommencer</button>
      </div>`;
  }

  /* Le voisin d'une fiche, en un mot : son caractère, sa graphie, son motif. */
  function nomVoisin(x) {
    if (x.type === "mot") return romaji() ? Romaji.mot(x) : x.m;
    return x.type === "gram" ? motifCourt(x) : x.k;
  }

  function navHtml(prec, suiv) {
    return `<div class="fi-nav">
      ${prec ? `<button type="button" class="btn-lien" id="fiPrec">← <span lang="ja">${echappe(nomVoisin(prec))}</span></button>` : "<span></span>"}
      ${suiv ? `<button type="button" class="btn-lien" id="fiSuiv"><span lang="ja">${echappe(nomVoisin(suiv))}</span> →</button>` : "<span></span>"}
    </div>`;
  }

  /* Ce qui se branche de la même façon sur les deux fiches : fermer, les
     voisins, la démonstration et la case d'exercice. */
  function brancheFiche(item, traits, prec, suiv, ouvre) {
    $("fiche").hidden = false;
    document.body.classList.add("voile-ouvert");
    $("fiX").addEventListener("click", fermeFiche);
    if (prec) $("fiPrec").addEventListener("click", () => ouvre(prec));
    if (suiv) $("fiSuiv").addEventListener("click", () => ouvre(suiv));
    if (traits) {
      FICHE.demo = Trace.monte($("fiDemo"), { traits, mode: "demo", numeros: true,
                                              etiquette: `Ordre des traits de ${item.k}` });
      FICHE.demo.anime();
      $("fiRejouer").addEventListener("click", () => FICHE.demo.anime());
      const retour = $("fiRetour");
      FICHE.trace = Trace.monte($("fiTrace"), {
        traits, mode: "guide", etiquette: `Tracer ${item.k}`,
        surTrait: (r) => { retour.textContent = r.ok ? `Trait ${r.rang} sur ${traits.length}.` : r.message; },
        surFin: (b) => {
          retour.textContent = b.erreurs === 0 ? "Parfait." : `Fini, avec ${b.erreurs} faux départ${b.erreurs > 1 ? "s" : ""}.`;
        },
      });
      $("fiEncore").addEventListener("click", () => {
        FICHE.trace.recommence();
        retour.textContent = "On recommence.";
      });
      $("fiche").querySelectorAll(".fi-pratique .segment button").forEach((b) => b.addEventListener("click", () => {
        $("fiche").querySelectorAll(".fi-pratique .segment button")
          .forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        FICHE.trace.mode(b.dataset.mode);
        retour.textContent = b.dataset.mode === "guide" ? "Le point rouge marque le départ du trait."
                                                        : "Case vide : le modèle n'apparaît qu'après deux essais manqués.";
      }));
    }
    $("fiX").focus();
  }

  async function ouvreFiche(item, depuis) {
    try { await chargeTraces([item]); } catch (e) { toast(e.message, true); return; }
    videFiche();
    if (depuis) FICHE.retour = depuis;
    const traits = traitsDe(item);
    const voisins = Kana.TOUS.filter((it) => it.sys === item.sys);
    const i = voisins.indexOf(item);
    const familles = { seion: "son de base", dakuon: "avec dakuten", youon: "son contracté" };

    $("fiche").innerHTML = `
      <div class="fi-boite" role="dialog" aria-modal="true" aria-labelledby="fiTitre">
        <div class="fi-tete">
          <p class="fi-sys"><span lang="ja">${Kana.NOMS[item.sys].jp}</span> · ${familles[item.famille]}</p>
          <button type="button" class="fi-x" id="fiX" aria-label="Fermer">&times;</button>
        </div>
        <div class="fi-corps">
          <div class="fi-modele">
            ${traits ? `<div class="tr-hote fi-demo" id="fiDemo"></div>` : `<div class="fi-demo fi-demo-texte" lang="ja">${echappe(item.k)}</div>`}
            ${traits ? `<p class="fi-sous-demo"><button type="button" class="btn-lien" id="fiRejouer">Revoir l'ordre</button>
              · ${pluriel(traits.length, "trait")}</p>` : ""}
          </div>
          <div class="fi-infos">
            <h2 class="fi-titre" id="fiTitre"><span class="fi-glyphe" lang="ja">${echappe(item.k)}</span>
              <span class="fi-romaji">${echappe(item.r)}</span></h2>
            ${boutonSon("fiSon")}
            ${item.note ? `<p class="fi-note">${echappe(item.note)}</p>` : ""}
            ${etatHtml(item, item.ecrire ? [["lire", "Lecture"], ["ecrire", "Écriture"]] : [["lire", "Lecture"]])}
          </div>
        </div>
        ${traits ? pratiqueHtml() : ""}
        ${navHtml(voisins[i - 1], voisins[i + 1])}
      </div>`;
    brancheSon("fiSon", item.k);
    brancheFiche(item, traits, voisins[i - 1], voisins[i + 1], ouvreFiche);
  }

  async function ouvreFicheKanji(item, depuis) {
    try { await chargeTraces([item]); } catch (e) { toast(e.message, true); return; }
    videFiche();
    if (depuis) FICHE.retour = depuis;
    const traits = traitsDe(item);
    const voisins = Kanji.TOUS.filter((it) => it.n === item.n);
    const i = voisins.indexOf(item);
    const meta = [`N${item.n}`, anneeEcole(item.g), item.f ? `fréquence n° ${item.f}` : ""].filter(Boolean);

    $("fiche").innerHTML = `
      <div class="fi-boite" role="dialog" aria-modal="true" aria-labelledby="fiTitre">
        <div class="fi-tete">
          <p class="fi-sys"><span lang="ja">漢字</span> · ${meta.join(" · ")}</p>
          <button type="button" class="fi-x" id="fiX" aria-label="Fermer">&times;</button>
        </div>
        <div class="fi-corps">
          <div class="fi-modele">
            ${traits ? `<div class="tr-hote fi-demo" id="fiDemo"></div>
              <p class="fi-sous-demo"><button type="button" class="btn-lien" id="fiRejouer">Revoir l'ordre</button>
              · ${pluriel(traits.length, "trait")}</p>`
              : `<div class="fi-demo fi-demo-texte" lang="ja">${echappe(item.k)}</div>`}
          </div>
          <div class="fi-infos">
            <h2 class="fi-titre" id="fiTitre"><span class="fi-glyphe" lang="ja">${echappe(item.k)}</span></h2>
            <p class="fi-sens">${sensHtml(item)}</p>
            ${lecturesHtml(item)}
            ${composantsHtml(item, true)}
            ${etatHtml(item, [["sens", "Sens"], ["ecrire", "Écriture"]])}
          </div>
        </div>
        ${item.m.length || motDuKanji(item) ? `<div class="fi-mots"><h3>Dans des mots</h3>${motsHtml(item)}</div>` : ""}
        ${traits ? pratiqueHtml() : ""}
        ${navHtml(voisins[i - 1], voisins[i + 1])}
      </div>`;
    brancheMots($("fiche"));
    $("fiche").querySelectorAll(".composant[data-k]").forEach((b) => b.addEventListener("click", () => {
      ouvreFicheKanji(Kanji.PAR_CAR.get(b.dataset.k));
    }));
    brancheFiche(item, traits, voisins[i - 1], voisins[i + 1], ouvreFicheKanji);
  }

  const GENRES_MOT = [["sens", "Sens"], ["lire", "Lecture"],
                      ["dire", "Retrouver", "viendra une fois le sens su"]];

  function ouvreFicheMot(item, depuis) {
    videFiche();
    if (depuis) FICHE.retour = depuis;
    const voisins = Mots.TOUS.filter((it) => it.n === item.n);
    const i = voisins.indexOf(item);
    // en rōmaji, le mot en grand dit sa lecture : dessous, comment il s'écrit
    const lectures = romaji() ? `<span class="mt-lecture" lang="ja">${echappe(item.m)}</span>`
      : item.kanjis ? `<span class="mt-lecture" lang="ja">${item.l.map(echappe).join(" · ")}</span>` : "";
    const enKanas = item.kanjis && !enKanjis(item);

    $("fiche").innerHTML = `
      <div class="fi-boite fi-boite-mot" role="dialog" aria-modal="true" aria-labelledby="fiTitre">
        <div class="fi-tete">
          <p class="fi-sys"><span lang="ja">単語</span> · N${item.n} · ${echappe(Mots.nature(item))}</p>
          <button type="button" class="fi-x" id="fiX" aria-label="Fermer">&times;</button>
        </div>
        <div class="fi-mot">
          <h2 class="fi-titre" id="fiTitre">${motGrand(item, "fi-glyphe-mot", romaji() ? Romaji.mot(item) : item.m)}</h2>
          <div class="mt-ecoute">${lectures}${boutonSon("fiSon")}</div>
          ${item.a ? `<p class="mt-nature">s'écrit aussi <span lang="ja">${echappe(item.a)}</span></p>` : ""}
          ${enKanas && !romaji() ? `<p class="mt-nature">Dans tes séances et tes textes, il s'écrit en kanas
            (<span lang="ja">${echappe(item.l[0])}</span>) ; en kanjis ${quandHtml(item)}.</p>` : ""}
          ${kanjiDuMot(item) && !enKanas ? `<p class="mt-nature">Son sens se révise avec le kanji
            <span lang="ja">${echappe(item.m)}</span>.</p>` : ""}
          <p class="fi-sens">${sensMotHtml(item)}</p>
          ${item.fr.length && item.en.length ? `<p class="mt-en">En anglais : ${echappe(item.en.join(", "))}</p>` : ""}
          ${kanjisDuMot(item, true)}
          ${etatHtml(item, GENRES_MOT.filter(([g]) => aCeGenre(item, g)))}
        </div>
        ${navHtml(voisins[i - 1], voisins[i + 1])}
      </div>`;
    $("fiSon").addEventListener("click", () => dis(item));
    $("fiche").querySelectorAll(".composant[data-k]").forEach((b) => b.addEventListener("click", () => {
      ouvreFicheKanji(Kanji.PAR_CAR.get(b.dataset.k));
    }));
    brancheFiche(item, null, voisins[i - 1], voisins[i + 1], ouvreFicheMot);
    dis(item);
  }

  function ouvreFicheGram(item, depuis) {
    videFiche();
    if (depuis) FICHE.retour = depuis;
    const voisins = Grammaire.TOUS.filter((it) => it.n === item.n);
    const i = voisins.indexOf(item);
    const voir = item.voir.map((nom) => Grammaire.PAR_NOM.get(nom)).filter(Boolean);

    $("fiche").innerHTML = `
      <div class="fi-boite fi-boite-gram" role="dialog" aria-modal="true" aria-labelledby="fiTitre">
        <div class="fi-tete">
          <p class="fi-sys"><span lang="ja">文法</span> · N${item.n} · ${echappe(item.chap)}</p>
          <button type="button" class="fi-x" id="fiX" aria-label="Fermer">&times;</button>
        </div>
        <div class="gr-fiche">
          ${enteteGramHtml(item, "fiTitre")}
          <div class="gr-texte">${blocsHtml(item.texte)}</div>
          <div class="gr-ex-tete">
            <h3 class="gr-sous-titre">Exemples</h3>
            ${reglageFurigana()}
          </div>
          <ol class="gr-exemples">${item.ex.map(exempleHtml).join("")}</ol>
          ${voir.length ? `<p class="gr-voir">Voir aussi : ${voir.map((v) => `<button type="button" class="btn-lien"
            data-voir="${echappe(v.nom)}">${motifHtml(v, true)}</button>`).join(" · ")}</p>` : ""}
          ${etatHtml(item, [["completer", "Compléter", "pas encore étudié"]])}
          ${!commence(item) && grammaireOuverte() ? `<button type="button" class="btn" id="fiEtudier">Étudier ce point</button>` : ""}
        </div>
        ${navHtml(voisins[i - 1], voisins[i + 1])}
      </div>`;
    brancheExemples($("fiche"), item);
    brancheFurigana($("fiche"));
    const etudier = $("fiEtudier");
    if (etudier) {
      etudier.addEventListener("click", () => {
        fermeFiche();
        lanceGrammaire(item);
      });
    }
    $("fiche").querySelectorAll("[data-voir]").forEach((b) => b.addEventListener("click", () => {
      ouvreFicheGram(Grammaire.PAR_NOM.get(b.dataset.voir));
    }));
    brancheFiche(item, null, voisins[i - 1], voisins[i + 1], ouvreFicheGram);
  }

  /* La fiche de n'importe quoi : un kana, un kanji, un mot, un point. */
  function ouvreFicheDe(item, depuis) {
    if (!item) return;
    const ouvre = { kana: ouvreFiche, kanji: ouvreFicheKanji, mot: ouvreFicheMot, gram: ouvreFicheGram }[item.type];
    if (ouvre) ouvre(item, depuis);
  }

  function fermeFiche() {
    if ($("fiche").hidden) return;
    videFiche();
    $("fiche").hidden = true;
    $("fiche").innerHTML = "";
    document.body.classList.remove("voile-ouvert");
    const retour = FICHE.retour;
    FICHE.retour = null;
    // le tableau a pu changer de place sous la fiche : on retrouve la case
    if (retour && document.contains(retour)) retour.focus();
  }
  // un clic sur le fond, et non un relâchement de sélection commencée dedans
  let fondPresse = false;
  $("fiche").addEventListener("mousedown", (e) => { fondPresse = e.target === $("fiche"); });
  $("fiche").addEventListener("click", (e) => { if (fondPresse && e.target === $("fiche")) fermeFiche(); });

  /* =====================================================================
     記録 - Les progrès
     ===================================================================== */
  /* Les thèmes, un onglet chacun : un seul à la fois sous le calendrier,
     le dernier ouvert sur cet appareil. */
  const THEMES_PROGRES = [
    { id: "kana", jp: "仮名", fr: "Kanas",
      rend: () => ["hira", "kata"].map((s) => barres(
        `<span lang="ja">${Kana.NOMS[s].jp}</span> <span>${Kana.NOMS[s].fr}</span>`,
        Kana.TOUS.filter((it) => it.sys === s), [["lire", "Lecture"], ["ecrire", "Écriture"]])).join("") },
    { id: "kanji", jp: "漢字", fr: "Kanjis",
      rend: () => Kanji.NIVEAUX.map((n) => barres(`N${n}`, Kanji.TOUS.filter((it) => it.n === n),
                                                  [["sens", "Sens"], ["ecrire", "Écriture"]])).join("") },
    { id: "mot", jp: "単語", fr: "Vocabulaire",
      rend: () => Mots.NIVEAUX.map((n) => barres(`N${n}`, Mots.TOUS.filter((it) => it.n === n), GENRES_MOT)).join("") },
    { id: "gram", jp: "文法", fr: "Grammaire",
      rend: () => Grammaire.NIVEAUX.map((n) => barres(`N${n}`, Grammaire.TOUS.filter((it) => it.n === n),
                                                      [["completer", "Compléter"]])).join("") },
    { id: "lecture", jp: "読解", fr: "Lecture",
      rend: () => `<div class="barres-sys">${Lecture.NIVEAUX.map((n) => barreLecture(n)).join("")}</div>` },
  ];

  function vueProgres(vue) {
    const hist = ETAT.historique || [];
    const total = hist.reduce((s, j) => s + j.revisions, 0);
    const justes = hist.reduce((s, j) => s + j.justes, 0);
    const secondes = hist.reduce((s, j) => s + (j.secondes || 0), 0);
    const jours = hist.filter((j) => j.revisions > 0).length;
    const choisi = THEMES_PROGRES.find((t) => t.id === Pref.lit("themeProgres", "kana")) || THEMES_PROGRES[0];

    vue.innerHTML = `
      <header class="rubrique-tete">
        <h1 class="titre"><span class="titre-jp" lang="ja">記録</span><span class="titre-fr">Les progrès</span></h1>
        <p class="chapeau">Ce qui est su, ce qui reste, et la régularité.</p>
      </header>

      <div class="chiffres">
        ${chiffre("連続", ETAT.serie, `jour${ETAT.serie > 1 ? "s" : ""} d'affilée`, ETAT.serie ? "chiffre-serie" : "")}
        ${chiffre("日数", jours, "jours de travail (6 mois)")}
        ${chiffre("回答", total, "réponses (6 mois)")}
        ${chiffre("時間", Math.round(secondes / 60) + " min", total ? `${Math.round(100 * justes / total)} % de justes` : "de travail")}
      </div>

      <section class="feuille progres-bloc">
        <h2 class="section-titre"><span lang="ja">暦</span> Les six derniers mois</h2>
        ${calendrier(hist)}
        <p class="calendrier-info" id="calInfo">${matchMedia("(hover: hover)").matches ? "Survole" : "Touche"} un jour pour le détail.</p>
      </section>

      <div class="pg-onglets" role="tablist" aria-label="Les thèmes">
        ${THEMES_PROGRES.map((t) => `<button type="button" role="tab" id="pgOnglet-${t.id}" data-theme-progres="${t.id}"
          aria-controls="pgTheme" aria-selected="${t === choisi}" tabindex="${t === choisi ? 0 : -1}">
          <span class="pg-onglet-jp" lang="ja">${t.jp}</span><span>${t.fr}</span></button>`).join("")}
      </div>
      <section class="feuille progres-theme" id="pgTheme" role="tabpanel" aria-labelledby="pgOnglet-${choisi.id}">
        ${choisi.rend()}
      </section>`;

    const onglets = [...vue.querySelectorAll("[data-theme-progres]")];
    const montre = (b) => {
      const t = THEMES_PROGRES.find((x) => x.id === b.dataset.themeProgres);
      Pref.ecrit("themeProgres", t.id);
      onglets.forEach((x) => {
        x.setAttribute("aria-selected", String(x === b));
        x.tabIndex = x === b ? 0 : -1;
      });
      $("pgTheme").setAttribute("aria-labelledby", b.id);
      $("pgTheme").innerHTML = t.rend();
    };
    onglets.forEach((b, i) => {
      b.addEventListener("click", () => montre(b));
      // les flèches passent d'un onglet à l'autre, comme le veut un tablist
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const autre = onglets[(i + (e.key === "ArrowRight" ? 1 : onglets.length - 1)) % onglets.length];
        autre.focus();
        montre(autre);
      });
    });

    const info = $("calInfo");
    const cal = vue.querySelector(".calendrier");
    // trop large pour un téléphone, il défile : on le montre par la fin,
    // aujourd'hui et les jours qui comptent
    cal.scrollLeft = cal.scrollWidth;
    const detail = (e) => {
      const c = e.target.closest("[data-j]");
      if (!c) return;
      cal.querySelectorAll(".cal-choisi").forEach((x) => x.classList.remove("cal-choisi"));
      c.classList.add("cal-choisi");
      const d = new Date(c.dataset.j + "T12:00:00");
      const date = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      const r = +c.dataset.r, ok = +c.dataset.ok, lus = +c.dataset.lus;
      const fait = [];
      if (r) fait.push(`${r} réponse${r > 1 ? "s" : ""}, ${Math.round(100 * ok / r)} % de justes`);
      if (lus) fait.push(`${pluriel(lus, "texte")} lu${lus > 1 ? "s" : ""}`);
      info.textContent = fait.length ? `${date} : ${fait.join(" ; ")}.` : `${date} : rien.`;
    };
    cal.addEventListener("mouseover", detail);
    cal.addEventListener("click", detail);
  }

  /* Les textes lus d'un niveau, selon ce qu'on en a compris la dernière
     fois : tout (la couleur de l'acquis), l'essentiel (du su), peu. */
  function barreLecture(n) {
    const textes = Lecture.TEXTES.filter((t) => t.n === n);
    const c = [0, 0, 0, 0];
    textes.forEach((t) => { const l = lectures()[t.nom]; c[l ? l.c : 0]++; });
    const part = (k) => (100 * c[k] / textes.length).toFixed(2);
    return `<div class="barre-kana">
      <span class="barre-titre">N${n}</span>
      <span class="barre" role="img" aria-label="${c[3]} compris en entier, ${c[2]} dans l'essentiel, ${c[1]} un peu, ${c[0]} pas encore lus">
        <i class="niv-3" style="width:${part(3)}%"></i><i class="niv-2" style="width:${part(2)}%"></i><i class="niv-1" style="width:${part(1)}%"></i>
      </span>
      <span class="barre-chiffre">${c[1] + c[2] + c[3]} / ${textes.length}</span>
    </div>`;
  }

  /* 26 semaines en colonnes, du lundi au dimanche, aujourd'hui en bas à
     droite. Les jours sont ceux du serveur (bascule à 4 h). Un texte lu
     compte pour dix réponses : il prend bien autant de temps. */
  function calendrier(hist) {
    const par = new Map(hist.map((j) => [j.jour, j]));
    const fin = new Date(ETAT.jour + "T12:00:00");
    const decalage = (fin.getDay() + 6) % 7;          // 0 = lundi
    const debut = new Date(fin.getTime() - (25 * 7 + decalage) * JOUR);
    const cases = [];
    for (let t = debut.getTime(); t <= fin.getTime() + JOUR / 2; t += JOUR) {
      const d = new Date(t);
      const cle = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const j = par.get(cle);
      const r = j ? j.revisions : 0, lus = j ? j.lectures || 0 : 0;
      const poids = r + 10 * lus;
      const n = poids === 0 ? 0 : poids < 10 ? 1 : poids < 30 ? 2 : poids < 60 ? 3 : 4;
      cases.push(`<i class="cal-j cal-${n}" data-j="${cle}" data-r="${r}" data-ok="${j ? j.justes : 0}" data-lus="${lus}"></i>`);
    }
    return `<div class="calendrier" role="img" aria-label="Activité des six derniers mois">${cases.join("")}</div>
      <div class="cal-legende" aria-hidden="true">moins <i class="cal-j cal-0"></i><i class="cal-j cal-1"></i><i class="cal-j cal-2"></i><i class="cal-j cal-3"></i><i class="cal-j cal-4"></i> plus</div>`;
  }

  function barres(titre, items, genres) {
    const ligne = ([genre, nom]) => {
      const liste = items.filter((it) => aCeGenre(it, genre));
      const n = [0, 0, 0, 0];
      liste.forEach((it) => { n[niveauDe(it, genre)]++; });
      const part = (k) => (100 * n[k] / liste.length).toFixed(2);
      return `<div class="barre-kana">
        <span class="barre-titre">${nom}</span>
        <span class="barre" role="img" aria-label="${n[3]} acquis, ${n[2]} sus, ${n[1]} en cours, ${n[0]} pas encore vus">
          <i class="niv-3" style="width:${part(3)}%"></i><i class="niv-2" style="width:${part(2)}%"></i><i class="niv-1" style="width:${part(1)}%"></i>
        </span>
        <span class="barre-chiffre">${n[2] + n[3]} / ${liste.length}</span>
      </div>`;
    };
    return `<div class="barres-sys"><h3>${titre}</h3>${genres.map(ligne).join("")}</div>`;
  }

  /* =====================================================================
     設定 - Les paramètres
     =====================================================================
     Tout ce qui se règle, au même endroit : ce que la séance fait
     découvrir, la voix, l'écriture, l'aide à la lecture, le thème. Sur cet
     appareil, comme le reste des réglages ; un choix compte dès qu'on le
     fait. La liseuse et les fiches de grammaire gardent leurs bascules sous
     la main : ce sont les mêmes réglages. */
  const THEMES = [["systeme", "Comme l'appareil"], ["jour", "Clair"], ["nuit", "Sombre"]];

  function vueParametres(vue) {
    const segment = (nom, cle, choix, actuel) => `<div class="segment segment-petit" role="radiogroup" aria-label="${nom}">
      ${choix.map(([v, libelle]) => `<button type="button" role="radio" data-${cle}="${v}"
        aria-checked="${v === actuel}">${libelle}</button>`).join("")}</div>`;
    const quotaHtml = (type, nom) => `
      <label class="param-quota"><span class="param-nom">${nom}</span>
        <select data-quota="${type}">${QUOTAS[type].choix.map((n) =>
          `<option value="${n}"${n === quota(type) ? " selected" : ""}>${n}</option>`).join("")}</select>
      </label>`;
    const traduite = Pref.lit("traductionLecture", false) === true;

    vue.innerHTML = `
      <header class="rubrique-tete">
        <h1 class="titre"><span class="titre-jp" lang="ja">設定</span><span class="titre-fr">Les paramètres</span></h1>
        <p class="chapeau">Réglés sur cet appareil : un autre garde les siens. Tes cartes et tes progrès, eux, te
          suivent partout.</p>
      </header>

      <div class="params">
        <section class="feuille param">
          <h2 class="section-titre"><span lang="ja">新規</span> Nouveaux par jour</h2>
          <p class="param-aide">Ce que la séance du jour fait découvrir, en plus des révisions. Les mots demandés en
            lisant passent en plus, ${DEMANDES_PAR_JOUR} par jour au plus.</p>
          <div class="param-ligne">
            ${quotaHtml("kana", "Kanas")}${quotaHtml("kanji", "Kanjis")}${quotaHtml("mot", "Mots")}
          </div>
        </section>

        <section class="feuille param">
          <h2 class="section-titre"><span lang="ja">声</span> La voix</h2>
          <p class="param-aide">Celle qui dit les kanas, les mots et les phrases. Dans un dialogue, chacun parle avec la
            sienne ; « Les deux » les alterne partout ailleurs.</p>
          <div class="param-ligne">
            ${segment("Voix", "voix", VOIX_CHOIX.map((v) => [v.id, v.nom]), Voix.choix())}
            ${boutonSon("essaiVoix", "Essayer")}
          </div>
        </section>

        <section class="feuille param">
          <h2 class="section-titre"><span lang="ja">文字</span> L'écriture</h2>
          <p class="param-aide">En rōmaji, les mots, les phrases et les textes s'écrivent en lettres latines :
            <em>Tōkyō ni sunde imasu.</em> Les kanas et les kanjis gardent leur écriture là où c'est elle qu'on
            apprend : leurs tableaux, leurs cartes, la lecture d'un mot en kanjis, le test de niveau.</p>
          <div class="param-ligne">
            ${segment("Écriture", "ecriture", [["kanas", "Kanas et kanjis"], ["romaji", "Rōmaji"]], romaji() ? "romaji" : "kanas")}
          </div>
        </section>

        <section class="feuille param">
          <h2 class="section-titre"><span lang="ja">読</span> L'aide à la lecture</h2>
          <p class="param-aide">Les furigana, la lecture en petit au-dessus des kanjis : ${romaji()
            ? "sans effet en rōmaji, où il n'y a pas de kanjis."
            : "cachés, un mot touché montre toujours les siens."}</p>
          <div class="param-champ${romaji() ? " param-eteint" : ""}">
            <span class="param-nom">Furigana de la grammaire</span>${reglageFurigana(true)}
          </div>
          <div class="param-champ${romaji() ? " param-eteint" : ""}">
            <span class="param-nom">Furigana des textes</span>${segmentFuriganaLecture(furiganaLecture())}
          </div>
          <div class="param-champ">
            <span class="param-nom">Traduction des textes</span>
            ${segment("Traduction des textes", "traduction", [["0", "Cachée"], ["1", "Sous chaque phrase"]], traduite ? "1" : "0")}
          </div>
        </section>

        <section class="feuille param">
          <h2 class="section-titre"><span lang="ja">色</span> Le thème</h2>
          <p class="param-aide">Le papier le jour, l'encre la nuit. Le bouton en haut de la page passe de l'un à
            l'autre.</p>
          <div class="param-ligne">${segment("Thème", "choix-theme", THEMES, choixTheme())}</div>
        </section>
      </div>`;

    // un groupe de boutons : celui qu'on touche devient le choix
    const coche = (cle, b) => vue.querySelectorAll(`[data-${cle}]`)
      .forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    vue.querySelectorAll("select[data-quota]").forEach((s) => s.addEventListener("change", () => {
      Pref.ecrit(QUOTAS[s.dataset.quota].pref, +s.value);
    }));
    // choisir une voix la fait entendre : c'est la seule façon de choisir
    vue.querySelectorAll("[data-voix]").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("voix", b.dataset.voix);
      coche("voix", b);
      dire(PHRASE_ESSAI);
    }));
    $("essaiVoix").addEventListener("click", () => dire(PHRASE_ESSAI));
    vue.querySelectorAll("[data-ecriture]").forEach((b) => b.addEventListener("click", async () => {
      const oui = b.dataset.ecriture === "romaji";
      if (oui === romaji()) return;
      if (oui) {
        try { await chargeRomaji(); } catch (e) { toast(`${e.message} Les phrases s'écrivent sans espaces.`, true); }
      }
      EN_ROMAJI = oui;
      Pref.ecrit("romaji", oui);
      appliqueRomaji();
      rend();
    }));
    brancheFurigana(vue);
    vue.querySelectorAll("[data-furi]").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("furiganaLecture", b.dataset.furi);
      coche("furi", b);
    }));
    vue.querySelectorAll("[data-traduction]").forEach((b) => b.addEventListener("click", () => {
      Pref.ecrit("traductionLecture", b.dataset.traduction === "1");
      coche("traduction", b);
    }));
    vue.querySelectorAll("[data-choix-theme]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.choixTheme === "systeme") Pref.efface("theme");
      else Pref.ecrit("theme", b.dataset.choixTheme);
      appliqueTheme();
      coche("choix-theme", b);
    }));
  }

  /* =====================================================================
     Démarrage
     ===================================================================== */
  function vueFermee(vue) {
    $("onglets").hidden = true;
    vue.innerHTML = `
      <section class="ferme">
        <div class="tampon tampon-pose" aria-hidden="true"><span lang="ja">工</span></div>
        <h1 class="salut" lang="ja">工事中</h1>
        <p class="salut-trad"><em>kōjichū</em> — en travaux</p>
        <p>Ce coin d'Abyss n'est pas encore ouvert.</p>
        <p><a class="btn" href="/abyss">Retour à Abyss</a></p>
      </section>`;
  }

  async function demarre() {
    const vue = $("vue");
    appliqueFurigana();
    appliqueRomaji();
    // en rōmaji, les transcriptions de la grammaire et des textes ; sans
    // elles, la page transcrit les kanas, sans espaces entre les mots
    const transcrits = romaji() ? chargeRomaji().catch(() => {}) : null;
    try {
      // tout en même temps : l'état dit ce qui est dû, les kanjis, les mots
      // et la grammaire dans quel ordre les découvrir, les textes ce qu'il
      // y a à lire
      await Promise.all([chargeEtat(), Kanji.charge(), Mots.charge(), Grammaire.charge(),
                         Lecture.charge(), transcrits]);
    } catch (e) {
      if (e.statut === 404) { vueFermee(vue); return; }
      vue.innerHTML = `<p class="erreur-page">Impossible de charger la page : ${echappe(e.message)}</p>`;
      return;
    }
    $("onglets").hidden = false;
    if (window.Suggestion) {
      $("suggBtn").hidden = false;
      Suggestion.branche({ bouton: "suggBtn", projet: "nihongo" });
    }
    rend();
    // les traits du jour arrivent pendant qu'on lit la page, pas au premier
    // clic
    const plan = planDuJour();
    chargeTraces([...plan.dues.map((c) => carteDe(c).item), ...plan.nouveaux]).catch(() => {
      /* redemandés au besoin */
    });
  }

  // revenir sur la page après une nuit : les cartes du jour sont arrivées
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !ETAT || SEANCE || TEST) return;
    if (Date.now() - Date.parse(ETAT.maintenant) < 30 * 60000) return;
    // un texte ouvert reste où il en était : on ne redessine pas sous les yeux
    chargeEtat().then(() => { if (!LISEUSE) rend(); }).catch(() => {});
  });

  demarre();
})();
