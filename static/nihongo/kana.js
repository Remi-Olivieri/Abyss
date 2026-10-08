/* =======================================================================
   Nihongo - kana.js

   Les deux syllabaires : ce qu'on apprend, dans quel ordre, et comment se
   lit chaque caractère. Rien ici ne touche à la page : ce sont des données
   et des fonctions pures, que nihongo.js et trace.js consultent.

   Les hiraganas sont écrits une fois, ligne par ligne, avec leur lecture
   Hepburn (celle des gares et des dictionnaires : « shi », « tsu », « fu »).
   Les katakanas s'en déduisent : c'est le même tableau, décalé de 0x60 dans
   Unicode (あ U+3042 → ア U+30A2).

   Une case vide (null) garde sa place dans la grille : や n'a pas de « yi »,
   et la colonne de ゆ doit rester celle des « u ».
   ======================================================================= */
(function () {
  "use strict";

  const COLONNES = ["a", "i", "u", "e", "o"];

  const SEION = [
    ["あ a", "い i", "う u", "え e", "お o"],
    ["か ka", "き ki", "く ku", "け ke", "こ ko"],
    ["さ sa", "し shi", "す su", "せ se", "そ so"],
    ["た ta", "ち chi", "つ tsu", "て te", "と to"],
    ["な na", "に ni", "ぬ nu", "ね ne", "の no"],
    ["は ha", "ひ hi", "ふ fu", "へ he", "ほ ho"],
    ["ま ma", "み mi", "む mu", "め me", "も mo"],
    ["や ya", null, "ゆ yu", null, "よ yo"],
    ["ら ra", "り ri", "る ru", "れ re", "ろ ro"],
    ["わ wa", null, null, null, "を wo"],
    ["ん n", null, null, null, null],
  ];

  const DAKUON = [
    ["が ga", "ぎ gi", "ぐ gu", "げ ge", "ご go"],
    ["ざ za", "じ ji", "ず zu", "ぜ ze", "ぞ zo"],
    ["だ da", "ぢ ji", "づ zu", "で de", "ど do"],
    ["ば ba", "び bi", "ぶ bu", "べ be", "ぼ bo"],
    ["ぱ pa", "ぴ pi", "ぷ pu", "ぺ pe", "ぽ po"],
  ];

  const YOUON = [
    ["きゃ kya", "きゅ kyu", "きょ kyo"],
    ["しゃ sha", "しゅ shu", "しょ sho"],
    ["ちゃ cha", "ちゅ chu", "ちょ cho"],
    ["にゃ nya", "にゅ nyu", "にょ nyo"],
    ["ひゃ hya", "ひゅ hyu", "ひょ hyo"],
    ["みゃ mya", "みゅ myu", "みょ myo"],
    ["りゃ rya", "りゅ ryu", "りょ ryo"],
    ["ぎゃ gya", "ぎゅ gyu", "ぎょ gyo"],
    ["じゃ ja", "じゅ ju", "じょ jo"],
    ["びゃ bya", "びゅ byu", "びょ byo"],
    ["ぴゃ pya", "ぴゅ pyu", "ぴょ pyo"],
  ];

  /* Ce qu'un clavier japonais accepte aussi : « si » pour し, « tu » pour
     つ. Refuser « si » à quelqu'un qui a lu la bonne syllabe, ce serait
     corriger son orthographe, pas sa lecture. */
  const VARIANTES = {
    shi: ["si"], chi: ["ti"], tsu: ["tu"], fu: ["hu"], ji: ["zi"],
    wo: ["o"], n: ["nn", "n'"],
    sha: ["sya"], shu: ["syu"], sho: ["syo"],
    cha: ["tya", "cya"], chu: ["tyu", "cyu"], cho: ["tyo", "cyo"],
    ja: ["zya", "jya"], ju: ["zyu", "jyu"], jo: ["zyo", "jyo"],
  };
  // ぢ et づ s'écrivent « di » et « du » sur un clavier : c'est même la
  // seule façon de les obtenir sans passer par じ et ず
  const PROPRES = { "ぢ": ["di"], "づ": ["du"] };

  /* Quelques mots sur les caractères qui en demandent. Les katakanas ont
     les leurs : シ et ツ, ソ et ン sont les pièges classiques. */
  const NOTES = {
    "は": "Comme particule du thème, は se lit « wa » : わたしは (watashi wa).",
    "へ": "Comme particule de direction, へ se lit « e » : にほんへ (nihon e).",
    "を": "Ne sert qu'à marquer le complément d'objet, et se prononce « o ».",
    "ん": "Le seul kana sans voyelle. Devant b, p et m, il sonne « m » : さんぽ (sanpo).",
    "ぢ": "Rare : « ji » s'écrit presque toujours じ. ぢ ne sert que dans des mots comme はなぢ (saignement de nez).",
    "づ": "Rare : « zu » s'écrit presque toujours ず. づ ne sert que dans des mots comme つづく (continuer).",
    "ふ": "Ni « fou » ni « hou » : les lèvres ne se touchent pas, l'air passe entre elles.",
    "つ": "« tsu » se dit d'un seul coup, comme dans « tsé-tsé ».",
    "ら": "La ligne ら est entre le r et le l : un seul battement de la langue contre le palais.",
    "う": "Souvent presque muet en fin de mot : です se dit « dess ».",
    "シ": "À ne pas confondre avec ツ : les deux petits traits de シ sont empilés à gauche, et le grand remonte depuis le bas.",
    "ツ": "À ne pas confondre avec シ : les deux petits traits de ツ sont alignés en haut, et le grand descend.",
    "ソ": "À ne pas confondre avec ン : le grand trait de ソ descend du haut vers la gauche.",
    "ン": "À ne pas confondre avec ソ : le grand trait de ン remonte du bas vers la droite.",
    "ヲ": "Ne s'emploie presque jamais : la particule s'écrit を, même dans un texte en katakana.",
  };
  const NOTE_YOUON = "Le petit ゃ, ゅ ou ょ fond les deux kanas en une seule syllabe : きゃ se dit « kya », en un temps, et pas « ki-ya ».";

  function versKata(s) {
    return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }

  function normalise(s) {
    return String(s || "").normalize("NFKC").toLowerCase()
      .replace(/[’`´]/g, "'").replace(/[\s.\-]/g, "");
  }

  /* Tous les kanas enseignés, dans l'ordre où on les apprend : les
     hiraganas d'abord, ligne par ligne, puis les mêmes en katakana. */
  const TOUS = [];
  const PAR_CAR = new Map();
  const GRILLES = { hira: {}, kata: {} };

  function ajoute(sys, famille, grille) {
    GRILLES[sys][famille] = grille.map((ligne, l) => ligne.map((cellule, c) => {
      if (!cellule) return null;
      const [hira, r] = cellule.split(" ");
      const k = sys === "kata" ? versKata(hira) : hira;
      const item = {
        type: "kana", k, r, sys, famille, ligne: l, col: c,
        id: `kana:${k}`,
        // un yōon s'écrit en deux caractères : il se lit, et s'écrit en
        // traçant ses deux kanas, qui ont déjà leurs propres cartes
        ecrire: famille !== "youon",
        note: NOTES[k] || (famille === "youon"
          ? (sys === "kata" ? NOTE_YOUON.replace(/[ゃゅょき]/g, versKata) : NOTE_YOUON)
          : ""),
        reponses: [r, ...(VARIANTES[r] || []), ...(PROPRES[hira] || [])],
      };
      TOUS.push(item);
      PAR_CAR.set(k, item);
      return item;
    }));
  }

  ["hira", "kata"].forEach((sys) => {
    ajoute(sys, "seion", SEION);
    ajoute(sys, "dakuon", DAKUON);
    ajoute(sys, "youon", YOUON);
  });

  /* じ et ぢ se lisent tous deux « ji », ず et づ tous deux « zu » : ni
     l'oreille ni le rōmaji ne les séparent, et une carte d'écriture qui
     demande seulement « ji » laisse deviner lequel. On les distingue comme
     la grille : par leur ligne, z ou d, donnée avec ses syllabes - en
     rōmaji, pour ne rien souffler du tracé. */
  TOUS.forEach((it) => {
    if (!TOUS.some((x) => x !== it && x.sys === it.sys && x.r === it.r)) return;
    const ligne = GRILLES[it.sys][it.famille][it.ligne].filter(Boolean);
    it.homophone = {
      ligne: ligne[0].r.replace(/[aiueo]$/, ""),      // « z », « d »
      syllabes: ligne.map((x) => x.r),                // za ji zu ze zo
      rang: ligne.indexOf(it),                        // la sienne, dans la ligne
    };
  });

  /* Les deux cartes d'un kana : la lecture (voir あ, taper « a ») et
     l'écriture (entendre « a », tracer あ). Voir nihongo.py. */
  function cles(item) {
    const l = [`${item.id}:lire`];
    if (item.ecrire) l.push(`${item.id}:ecrire`);
    return l;
  }

  function depuisCle(cle) {
    const m = /^kana:(.+):(lire|ecrire)$/.exec(cle || "");
    if (!m) return null;
    const item = PAR_CAR.get(m[1]);
    return item ? { item, genre: m[2] } : null;
  }

  function accepte(item, saisie) {
    return item.reponses.indexOf(normalise(saisie)) >= 0;
  }

  const NOMS = {
    hira: { jp: "ひらがな", fr: "hiragana" },
    kata: { jp: "カタカナ", fr: "katakana" },
  };

  window.Kana = { TOUS, PAR_CAR, GRILLES, COLONNES, NOMS,
                  cles, depuisCle, accepte, normalise, versKata };
})();
