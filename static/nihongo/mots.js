/* =======================================================================
   Nihongo - mots.js

   Le vocabulaire : les 7 900 mots du JLPT, du N5 au N1, dans l'ordre où
   on les apprend (voir construit_vocabulaire dans nihongo.py). Rien ici ne
   touche à la page : les données, la saisie en kanas, et de quoi corriger
   une réponse.

   Les données arrivent de static/nihongo/vocabulaire.json, une fois, au
   démarrage. Chaque mot :
     m   sa graphie (食べる, ちょっと, コーヒー)
     l   ses lectures, la principale d'abord (今日 : きょう, こんにち)
     n   niveau JLPT (5 = N5 ... 1 = N1)
     p   sa nature, en codes JMdict (v5k, v1, adj-i, n, vs...)
     fr / en  ses sens ; fr vide = pas encore traduit
     a   une autre graphie (うるさい s'écrit aussi 煩い)

   Trois cartes par mot :
     sens  voir le mot, taper ce qu'il veut dire ;
     lire  voir le mot, taper sa lecture - seulement s'il a des kanjis ;
     dire  lire le sens en français, retrouver le mot. Elle n'arrive
           qu'une fois le sens su (voir planDuJour dans nihongo.js) : on
           retrouve un mot bien plus difficilement qu'on ne le reconnaît.
   ======================================================================= */
(function () {
  "use strict";

  const NIVEAUX = [5, 4, 3, 2, 1];
  const api = { TOUS: [], PAR_ID: new Map(), NIVEAUX };
  let PRET = null;

  const KANJI = /[㐀-鿿豈-﫿々]/;

  /* Même règle que cle_audio dans nihongo.py : le mot, puis sa lecture
     s'il en a une autre. C'est aussi le nom de son fichier son. */
  function cleDe(m, l) {
    return !l || l === m ? m : `${m}・${l}`;
  }

  function installe(liste) {
    api.TOUS = liste.map((x, i) => Object.assign(
      { type: "mot", id: `mot:${cleDe(x.m, x.l[0])}`, rang: i,
        kanjis: KANJI.test(x.m), en: [] }, x));
    api.PAR_ID = new Map(api.TOUS.map((it) => [it.id, it]));
    return api.TOUS;
  }

  function charge() {
    if (!PRET) {
      PRET = Matiere.json("vocabulaire.json", "Le vocabulaire n'a pas pu être chargé.")
        .then((d) => installe(d.mots))
        .catch((e) => { PRET = null; throw e; });
    }
    return PRET;
  }

  /* Les cartes que crée la découverte d'un mot. `dire` vient plus tard. */
  function cles(item) {
    return item.kanjis ? [`${item.id}:sens`, `${item.id}:lire`] : [`${item.id}:sens`];
  }
  function genres(item) {
    return item.kanjis ? ["sens", "lire", "dire"] : ["sens", "dire"];
  }

  function depuisCle(cle) {
    const m = /^(mot:.+):(sens|lire|dire)$/.exec(cle || "");
    if (!m) return null;
    const item = api.PAR_ID.get(m[1]);
    if (!item || (m[2] === "lire" && !item.kanjis)) return null;
    return { item, genre: m[2] };
  }

  /* Les sens à montrer : le français, l'anglais en attendant. */
  function sens(item, combien) {
    const liste = item.fr.length ? item.fr : item.en;
    return combien ? liste.slice(0, combien) : liste;
  }

  /* ---------- la nature d'un mot ----------
     Les codes de JMdict, dits comme une grammaire française les dirait.
     Les verbes gardent leur famille : « en -u » (godan : 書く, 書かない,
     書きます) ou « en -ru » (ichidan : 食べる, 食べない, 食べます) - c'est
     ce qui décide de toute leur conjugaison. */
  function nature(item) {
    const p = new Set(item.p);
    const morceaux = [];
    const godan = item.p.some((c) => /^v5/.test(c));
    if (godan) morceaux.push(p.has("v5r-i") || p.has("v5k-s") || p.has("v5aru") ? "verbe en -u (irrégulier)" : "verbe en -u");
    else if (p.has("v1") || p.has("v1-s")) morceaux.push("verbe en -ru");
    else if (p.has("vk")) morceaux.push("verbe irrégulier (来る)");
    else if (p.has("vs-i") || p.has("vs-s") || p.has("vz")) morceaux.push("verbe en する");
    if (morceaux.length && p.has("vt")) morceaux.push("transitif");
    else if (morceaux.length && p.has("vi")) morceaux.push("intransitif");
    if (p.has("adj-i") || p.has("adj-ix")) morceaux.push("adjectif en い");
    if (p.has("adj-na")) morceaux.push("adjectif en な");
    if (!morceaux.length) {
      if (p.has("n") || p.has("n-adv") || p.has("n-t")) morceaux.push("nom");
      else if (p.has("pn")) morceaux.push("pronom");
      else if (p.has("adv") || p.has("adv-to")) morceaux.push("adverbe");
      else if (p.has("adj-pn") || p.has("adj-f")) morceaux.push("déterminant");
      else if (p.has("conj")) morceaux.push("conjonction");
      else if (p.has("int")) morceaux.push("interjection");
      else if (p.has("ctr")) morceaux.push("compteur");
      else if (p.has("num")) morceaux.push("nombre");
      else if (p.has("prt")) morceaux.push("particule");
      else if (p.has("exp")) morceaux.push("expression");
      else if (p.has("pref") || p.has("n-pref")) morceaux.push("préfixe");
      else if (p.has("suf") || p.has("n-suf")) morceaux.push("suffixe");
    }
    if (p.has("vs") && !morceaux.some((x) => x.startsWith("verbe"))) morceaux.push("+ する : verbe");
    return morceaux.join(", ");
  }

  /* ---------- le rōmaji, changé en kanas pendant la frappe ----------
     Comme un clavier japonais : « taberu » donne たべる, « gakkou » がっこう,
     « n' » ん, « - » le trait des voyelles longues ー, « ti » ティ. Le n suit le rōmaji
     des dictionnaires : « minna » みんな, « konnichiwa » こんにちわ, « kon'ya »
     こんや. Un n qui termine la saisie attend la lettre suivante, sauf une
     fois la réponse validée (`fin`), où il devient ん. Les kanas tapés
     directement (clavier japonais du téléphone) passent tels quels. */
  const SYLLABES = (function () {
    const t = {};
    const ligne = (cons, kanas) => ["a", "i", "u", "e", "o"].forEach((v, i) => {
      if (kanas[i] !== "・") t[cons + v] = kanas[i];
    });
    ligne("", "あいうえお"); ligne("k", "かきくけこ"); ligne("s", "さしすせそ"); ligne("t", "たちつてと");
    ligne("n", "なにぬねの"); ligne("h", "はひふへほ"); ligne("m", "まみむめも"); ligne("y", "や・ゆ・よ");
    ligne("r", "らりるれろ"); ligne("w", "わ・・・を"); ligne("g", "がぎぐげご"); ligne("z", "ざじずぜぞ");
    ligne("d", "だぢづでど"); ligne("b", "ばびぶべぼ"); ligne("p", "ぱぴぷぺぽ");
    ligne("x", "ぁぃぅぇぉ"); ligne("l", "ぁぃぅぇぉ");
    // les sons contractés : kya, sha, cha, ja...
    const yo = { k: "き", s: "し", t: "ち", c: "ち", n: "に", h: "ひ", m: "み", r: "り",
                 g: "ぎ", z: "じ", j: "じ", d: "ぢ", b: "び", p: "ぴ", f: "ふ", v: "ゔ" };
    Object.keys(yo).forEach((c) => {
      t[c + "ya"] = yo[c] + "ゃ"; t[c + "yu"] = yo[c] + "ゅ"; t[c + "yo"] = yo[c] + "ょ";
    });
    Object.assign(t, {
      // Hepburn, et le kunrei des claviers (si, tu, hu, zi) ; mais « ti »
      // et « di » donnent ティ et ディ, comme dans le rōmaji des
      // dictionnaires (パーティー, pātī) : ち s'y écrit « chi »
      shi: "し", chi: "ち", tsu: "つ", fu: "ふ", ji: "じ", si: "し", tu: "つ", hu: "ふ", zi: "じ",
      ti: "てぃ", di: "でぃ",
      sha: "しゃ", shu: "しゅ", sho: "しょ", she: "しぇ", cha: "ちゃ", chu: "ちゅ", cho: "ちょ", che: "ちぇ",
      ja: "じゃ", ju: "じゅ", jo: "じょ", je: "じぇ", ye: "いぇ", wi: "うぃ", we: "うぇ",
      // les sons des mots d'ailleurs : ファ, ティ, ディ, ヴァ...
      fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ", tsa: "つぁ", tsi: "つぃ", tse: "つぇ", tso: "つぉ",
      thi: "てぃ", dhi: "でぃ", dhu: "でゅ", twu: "とぅ", dwu: "どぅ",
      va: "ゔぁ", vi: "ゔぃ", vu: "ゔ", ve: "ゔぇ", vo: "ゔぉ",
      xya: "ゃ", xyu: "ゅ", xyo: "ょ", lya: "ゃ", lyu: "ゅ", lyo: "ょ",
      xtu: "っ", ltu: "っ", xtsu: "っ", ltsu: "っ", xwa: "ゎ", lwa: "ゎ",
      "n'": "ん", "-": "ー",
    });
    return t;
  })();
  const PLUS_LONGUE = Math.max(...Object.keys(SYLLABES).map((s) => s.length));
  const CONSONNE = /^[bcdfghjklmpqrstvwxz]$/;          // sans n ni y
  const VOYELLE_OU_Y = /^[aiueoy]$/;

  function versKana(texte, fin) {
    const s = String(texte || "").normalize("NFKC").replace(/[’`´]/g, "'").toLowerCase();
    let sortie = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (!/[a-z'\-]/.test(c)) { sortie += c; i++; continue; }
      const apres = s[i + 1] || "";
      if (c === "n" && !VOYELLE_OU_Y.test(apres) && apres !== "'") {
        if (apres === "n") {
          const encore = s[i + 2] || "";
          if (!encore && !fin) { sortie += s.slice(i); break; }       // « konn… » : on attend
          // « minna » : ん, et le second n ouvre な ; « konn » + consonne : ん
          sortie += "ん";
          i += VOYELLE_OU_Y.test(encore) ? 1 : 2;
          continue;
        }
        if (apres || fin) { sortie += "ん"; i++; continue; }
        sortie += c; i++; continue;                                    // un n final : on attend
      }
      // une consonne doublée : っ (« kko », « tte », « tch »)
      if (CONSONNE.test(c) && (apres === c || (c === "t" && apres === "c"))) {
        sortie += "っ"; i++; continue;
      }
      let trouve = false;
      for (let n = Math.min(PLUS_LONGUE, s.length - i); n >= 1; n--) {
        const morceau = s.slice(i, i + n);
        if (Object.prototype.hasOwnProperty.call(SYLLABES, morceau)) {
          sortie += SYLLABES[morceau]; i += n; trouve = true; break;
        }
      }
      if (!trouve) { sortie += c; i++; }   // une syllabe pas finie (« ky », « ts »)
    }
    return sortie;
  }

  function versHira(s) {
    return String(s || "").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  /* Une lecture, pour comparer : en hiraganas, sans espaces, et le trait
     des voyelles longues remplacé par la voyelle qu'il allonge (コーヒー et
     こおひい, c'est la même chose tapée au clavier). */
  const VOYELLE = {};
  ["あかさたなはまやらわがざだばぱぁゃ", "いきしちにひみりぎじぢびぴぃ", "うくすつぬふむゆるぐずづぶぷぅゅゔ",
   "えけせてねへめれげぜでべぺぇ", "おこそとのほもよろをごぞどぼぽぉょ"].forEach((l, i) => {
    for (const c of l) VOYELLE[c] = "あいうえお"[i];
  });
  function compareLecture(s) {
    const h = versHira(String(s || "").normalize("NFKC")).replace(/[\s・.\-‐]/g, "");
    let sortie = "";
    for (const c of h) sortie += c === "ー" && sortie ? (VOYELLE[sortie[sortie.length - 1]] || "") : c;
    return sortie;
  }

  /* La saisie est-elle une des lectures du mot ? On accepte aussi le mot
     lui-même, tapé avec le clavier japonais de l'appareil (食べる). */
  function accepteLecture(item, saisie) {
    const tape = compareLecture(versKana(saisie, true));
    if (!tape) return false;
    return item.l.some((l) => compareLecture(l) === tape) || saisie.trim() === item.m
      || (!!item.a && saisie.trim() === item.a);
  }

  /* Presque : la même lecture aux sons longs et aux っ près - les deux
     pièges de l'oreille française (おばさん, tante ; おばあさん, grand-mère ;
     きて, viens ; きって, timbre). */
  function sansLongues(s) {
    let sortie = "";
    for (const c of compareLecture(s)) {
      const v = VOYELLE[sortie[sortie.length - 1]];
      if (c === "っ") continue;
      if (v && (c === v || (c === "う" && v === "お") || (c === "い" && v === "え"))) continue;
      sortie += c;
    }
    return sortie;
  }
  function presque(item, saisie) {
    const tape = sansLongues(versKana(saisie, true));
    return !!tape && item.l.some((l) => sansLongues(l) === tape);
  }

  /* Le sens tapé : la même correction que pour les kanjis (accents,
     articles, pluriels et fautes de frappe pardonnés, l'anglais accepté). */
  function accepteSens(item, saisie) {
    return Kanji.accepteSens(item, saisie);
  }

  /* Un autre mot qui se lit comme la saisie et partage un sens avec
     `item` : un synonyme, pas une erreur (« はやい » pour 速い quand on
     attendait 早い). */
  function synonyme(item, saisie) {
    const tape = compareLecture(versKana(saisie, true));
    if (!tape) return null;
    const siens = new Set([...item.fr, ...item.en].map(Kanji.normaliseSens).filter(Boolean));
    return api.TOUS.find((it) => it !== item
      && (it.l.some((l) => compareLecture(l) === tape) || saisie.trim() === it.m)
      && [...it.fr, ...it.en].some((s) => siens.has(Kanji.normaliseSens(s)))) || null;
  }

  /* ---------- chercher ----------
     Un mot (日本), des kanas ou du rōmaji (« taberu »), ou un sens en
     français ou en anglais. */
  function cherche(texte, maxi) {
    const brut = String(texte || "").trim();
    if (!brut) return [];
    maxi = maxi || 200;
    if (/[぀-ヿ㐀-鿿]/.test(brut)) {
      const q = compareLecture(brut);
      const exacts = [], debuts = [], dedans = [];
      api.TOUS.forEach((it) => {
        if (it.m === brut || it.l.some((l) => compareLecture(l) === q)) exacts.push(it);
        else if (it.m.startsWith(brut) || it.l.some((l) => compareLecture(l).startsWith(q))) debuts.push(it);
        else if (it.m.includes(brut)) dedans.push(it);
      });
      return exacts.concat(debuts, dedans).slice(0, maxi);
    }
    const romaji = /^[a-z' \-]+$/i.test(brut) ? compareLecture(versKana(brut, true)) : "";
    const q = Kanji.normaliseSens(brut);
    const exacts = [], debuts = [];
    api.TOUS.forEach((it) => {
      const s = [...it.fr, ...it.en].map(Kanji.normaliseSens);
      const lu = romaji && !/[a-z]/.test(romaji) && it.l.some((l) => compareLecture(l) === romaji);
      if (lu || (q && s.includes(q))) exacts.push(it);
      else if (q && s.some((x) => x.startsWith(q) || x.includes(" " + q))) debuts.push(it);
    });
    return exacts.concat(debuts).slice(0, maxi);
  }

  window.Mots = Object.assign(api, {
    charge, installe, cles, genres, depuisCle, sens, nature, cleDe,
    versKana, versHira, compareLecture, sansLongues, accepteLecture, presque, accepteSens, synonyme, cherche,
  });
})();
