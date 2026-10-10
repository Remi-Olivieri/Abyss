/* =======================================================================
   Nihongo - romaji.js

   Le japonais en lettres latines, pour qui règle la page en rōmaji : le
   Hepburn des dictionnaires et des gares, ses voyelles longues marquées
   (とうきょう : tōkyō), les particules comme elles se disent (は : wa,
   へ : e, を : o). Rien ici ne touche à la page : de quoi transcrire des
   kanas, un mot, une date, et comparer ce qu'on tape à une transcription.

   Les phrases de la grammaire et le japonais glissé dans les explications
   ne sont pas découpés en mots : nihongo.py les transcrit à la fabrication
   (romaji.json, voir « Le romaji » dans nihongo.py), avec la même table et
   les mêmes règles qu'ici.
   ======================================================================= */
(function () {
  "use strict";

  const TABLE = (function () {
    const t = {};
    const lignes = { "": "あいうえお", k: "かきくけこ", s: "さしすせそ", t: "たちつてと", n: "なにぬねの",
                     h: "はひふへほ", m: "まみむめも", r: "らりるれろ", g: "がぎぐげご", z: "ざじずぜぞ",
                     d: "だぢづでど", b: "ばびぶべぼ", p: "ぱぴぷぺぽ" };
    Object.entries(lignes).forEach(([c, kanas]) => [..."aiueo"].forEach((v, i) => { t[kanas[i]] = c + v; }));
    Object.assign(t, {
      し: "shi", ち: "chi", つ: "tsu", ふ: "fu", じ: "ji", ぢ: "ji", づ: "zu", や: "ya", ゆ: "yu", よ: "yo",
      わ: "wa", ゐ: "i", ゑ: "e", を: "o", ん: "n", ゔ: "vu", ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
      ゃ: "ya", ゅ: "yu", ょ: "yo", ゎ: "wa", ゕ: "ka", ゖ: "ke",
    });
    // les sons contractés : きゃ kya, しゃ sha, じゃ ja
    [..."きにひみりぎびぴ"].forEach((k, i) => [..."ゃゅょ"].forEach((p, j) => {
      t[k + p] = "knhmrgbp"[i] + "y" + "auo"[j];
    }));
    [["し", "sh"], ["ち", "ch"], ["じ", "j"], ["ぢ", "j"]].forEach(([k, c]) => [..."ゃゅょ"].forEach((p, j) => {
      t[k + p] = c + "auo"[j];
    }));
    // les sons des mots d'ailleurs : ティ, ファ, ヴァ
    Object.assign(t, {
      しぇ: "she", ちぇ: "che", じぇ: "je", てぃ: "ti", でぃ: "di", とぅ: "tu", どぅ: "du", てゅ: "tyu",
      でゅ: "dyu", ふぁ: "fa", ふぃ: "fi", ふぇ: "fe", ふぉ: "fo", ふゅ: "fyu", うぃ: "wi", うぇ: "we",
      うぉ: "wo", ゔぁ: "va", ゔぃ: "vi", ゔぇ: "ve", ゔぉ: "vo", つぁ: "tsa", つぃ: "tsi", つぇ: "tse",
      つぉ: "tso", いぇ: "ye", くぁ: "kwa", ぐぁ: "gwa", きぇ: "kye", にぇ: "nye", ひぇ: "hye",
    });
    return t;
  })();
  const PETITS = "ぁぃぅぇぉゃゅょゎ";
  const LONGUES = new Set(["aあ", "uう", "oう", "oお", "eえ"]);
  const MACRON = { a: "ā", i: "ī", u: "ū", e: "ē", o: "ō" };
  const PONCTUATION = { "。": ".", "、": ",", "？": "?", "！": "!", "「": "“", "」": "”", "『": "“", "』": "”",
                        "（": "(", "）": ")", "・": "·", "〜": "~", "～": "~", "―": "—", "　": " ", "，": ",",
                        "．": "." };
  /* Entre deux voyelles qui ne font pas une longue : おも|う, omou. */
  const COUPURE = "|";

  const versHira = (s) => String(s || "").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

  /* Les kanas un par un, un son contracté (きょ, ティ) comptant pour un. */
  function moras(s) {
    const sortie = [];
    for (let i = 0; i < s.length;) {
      const deux = s.slice(i, i + 2);
      if (deux.length === 2 && PETITS.includes(deux[1]) && TABLE[deux]) { sortie.push(deux); i += 2; }
      else { sortie.push(s[i]); i++; }
    }
    return sortie;
  }

  /* « とうきょう » -> « tōkyō ». っ double la consonne qui suit (がっこう :
     gakkō), ん prend une apostrophe devant une voyelle (こんや : kon'ya), ー
     et une voyelle qui en allonge une autre font une voyelle longue
     (コーヒー : kōhī, おかあさん : okāsan) - sauf い, qui reste écrit
     (せんせい : sensei, いいえ : iie). Le reste passe tel quel. `suite` :
     les kanas du mot collé à celui-ci, pour un っ ou un ん final. Même
     règle que kana_en_romaji dans nihongo.py. */
  function de(kana, suite) {
    const m = moras(versHira(kana));
    const avecSuite = m.concat(moras(versHira(suite)).slice(0, 1));
    let sortie = "", voyelle = null;
    m.forEach((x, k) => {
      if (x === COUPURE) { voyelle = null; return; }
      if (x === "っ") {
        const r = TABLE[avecSuite[k + 1]] || "";
        if (r && !"aiueo".includes(r[0])) sortie += r.startsWith("ch") ? "t" : r[0];
        voyelle = null;
        return;
      }
      if (x === "ん") {
        const r = TABLE[avecSuite.slice(k + 1).find((y) => y !== COUPURE)] || "";
        sortie += r && "aiueoy".includes(r[0]) ? "n'" : "n";
        voyelle = null;
        return;
      }
      if (x === "ー") {
        if (voyelle) sortie = sortie.slice(0, -1) + MACRON[voyelle];
        voyelle = null;
        return;
      }
      const r = TABLE[x];
      if (r === undefined) {
        sortie += PONCTUATION[x] !== undefined ? PONCTUATION[x] : x;
        voyelle = null;
        return;
      }
      if (voyelle && LONGUES.has(voyelle + x)) {
        sortie = sortie.slice(0, -1) + MACRON[voyelle];
        voyelle = null;
        return;
      }
      sortie += r;
      voyelle = "aiueo".includes(r[r.length - 1]) ? r[r.length - 1] : null;
    });
    return sortie;
  }

  /* La lecture d'un mot, prête à transcrire : le う final d'un verbe (思う,
     吸う) n'allonge rien, la particule finale d'une expression se dit
     comme une particule (こんにちは : konnichiwa, 実は : jitsuwa), を et
     ございます se détachent (気を付ける : ki o tsukeru). `p` : sa nature, en codes
     JMdict ; `nature` : celle du glossaire de la lecture. */
  function prepare(kana, p, nature) {
    const codes = new Set(p || []);
    let k = String(kana || "");
    const verbeU = [...codes].some((c) => /^v5u/.test(c)) || /verbe en -u/.test(nature || "");
    if (verbeU && k.endsWith("う")) k = k.slice(0, -1) + COUPURE + "う";
    const locution = ["exp", "conj", "int", "prt", "adv"].some((c) => codes.has(c))
      || /expression|interjection/.test(nature || "");
    if (locution && k.length > 1 && k.endsWith("は")) k = k.slice(0, -1) + "わ";
    if (k.length > 1 && /.を./.test(k)) k = k.replace(/を/g, " を ");
    // ありがとうございます : arigatō gozaimasu
    return k.replace(/(.)(ござい(?:ます|ました))$/, "$1 $2");
  }

  /* Un mot du vocabulaire, en rōmaji. */
  function mot(it) {
    return de(prepare(it.l[0], it.p)).replace(/ {2,}/g, " ").trim();
  }

  /* Ce qu'on tape, et une transcription, pour les comparer : sans
     majuscules ni signes, les voyelles longues écrites en double (ō, ô,
     ou, oo : la même chose). */
  function plat(s) {
    return String(s || "").toLowerCase().normalize("NFC")
      .replace(/[āâ]/g, "aa").replace(/[īî]/g, "ii").replace(/[ūû]/g, "uu").replace(/[ēê]/g, "ee")
      .replace(/[ōô]/g, "ou").replace(/[^a-z]/g, "").replace(/oo/g, "ou");
  }

  /* Un indice : les `n` premiers sons du mot, des blancs pour la suite. */
  function indice(kana, n) {
    const m = moras(versHira(kana).replace(/ /g, ""));
    const reste = m.length - n;
    return (de(m.slice(0, n).join(""), m[n] || "") + " " + Array(Math.max(0, reste)).fill("＿").join(" ")).trim();
  }

  /* La date comme elle se dit : « 2026-nen jū-gatsu kokonoka (kin) ». */
  const NOMBRES = ["", "ichi", "ni", "san", "yon", "go", "roku", "nana", "hachi", "kyū"];
  const MOIS = ["ichi", "ni", "san", "shi", "go", "roku", "shichi", "hachi", "ku", "jū", "jūichi", "jūni"];
  const JOURS = { 1: "tsuitachi", 2: "futsuka", 3: "mikka", 4: "yokka", 5: "itsuka", 6: "muika", 7: "nanoka",
                  8: "yōka", 9: "kokonoka", 10: "tōka", 14: "jūyokka", 20: "hatsuka", 24: "nijūyokka" };
  const SEMAINE = ["nichi", "getsu", "ka", "sui", "moku", "kin", "do"];
  function date(d) {
    const j = d.getDate();
    const dizaine = Math.floor(j / 10), unite = j % 10;
    const jour = JOURS[j] || `${dizaine > 1 ? NOMBRES[dizaine] : ""}${dizaine ? "jū" : ""}${
      unite === 7 ? "shichi" : unite === 9 ? "ku" : NOMBRES[unite]}-nichi`;
    return `${d.getFullYear()}-nen ${MOIS[d.getMonth()]}-gatsu ${jour} (${SEMAINE[d.getDay()]})`;
  }

  /* La première lettre en capitale : « Tōkyō ». */
  function capitale(s) {
    return String(s || "").replace(/^([^a-zāīūēōA-ZĀĪŪĒŌ]*)([a-zāīūēō])/, (x, avant, c) => avant + c.toUpperCase());
  }

  /* Les sons d'un mot, un par un : きょ, う, と. */
  function sons(kana) {
    return moras(versHira(kana).replace(/ /g, ""));
  }

  window.Romaji = { de, prepare, mot, plat, indice, sons, date, capitale, COUPURE };
})();
