/* =========================================================
   Yu-Gi-Oh! Survivor : le moteur

   Les règles, et rien d'autre : pas une ligne de dessin ni de DOM. La page
   (survivor.js) demande un geste au joueur, le passe à `agit`, et reçoit
   la liste de ce qui s'est passé pour l'animer. C'est ce qui permet de
   faire jouer des parties entières sans navigateur pour régler
   l'équilibrage.

   Le principe : le temps n'avance que quand tu agis. Un geste (un pas, une
   carte jouée, attendre) fait passer un tour, et le tour se résout d'un
   coup, dans cet ordre :

     1. ton geste ;
     2. tes monstres se réparent un peu, puis attaquent seuls, chacun à son
        rythme ;
     3. les monstres ennemis : les frappes annoncées tombent, puis chacun
        frappe s'il est collé à toi (les 8 cases autour, diagonales
        comprises) ou s'approche d'une case (jamais en diagonale) ;
     4. la fin du tour : pioche, nouvelles vagues, boosters.

   L'attaque d'un monstre vient de son Type (un Dragon souffle en zone, un
   Magicien lance un sort qui rebondit...) et son attribut y ajoute un
   bonus (le FEU brûle, l'EAU ralentit...) : voir ATTAQUES et BONUS.

   La DEF de tes monstres te protège : plus ton terrain en a, moins les
   coups des ennemis te font mal, selon une courbe qui s'aplatit (voir
   protection). Tes monstres ne sont jamais détruits par un coup.

   Deux choses à ne pas confondre. Les boosters proposent des cartes tirées
   dans les 40 que le joueur a choisies hors de la partie (voir
   survivor.py), autant de fois qu'il le faut. Le deck, lui, c'est ce qu'il
   a en partie et qu'il pioche : il arrive avec le deck de départ de son
   duelliste, Yugi ou Joey (un monstre sur le terrain, quatre cartes dans
   le deck dont il tire deux), et chaque carte gardée d'un booster y est
   mélangée.
   Jouée, une carte part au cimetière et n'en revient pas seule : des
   cartes vont l'y chercher (Monster Reborn, le Magicien de la Foi...).
   Libération d'Âme en remet dans le deck.

   Tout ce qui se règle est en tête de fichier (R, BOSS, PALIERS...). Les
   cartes, elles, viennent de cartes.json, écrit par survivor.py.
   ========================================================= */
(function (racine) {
  "use strict";

  /* ---------- les réglages ---------- */
  const R = {
    LP: 8000,
    ZONES: 5,                 // zones monstre, et autant de zones magie/piège
    MAIN_MAX: 6,              // la limite de la phase de fin : au-delà, la pioche attend
    MAIN_PLAFOND: 10,         // ce que Pot de Cupidité ou un booster peuvent encore ajouter
    MAIN_DEPART: 2,           // la première main, tirée au hasard dans le deck de départ
    PIOCHE_TOURS: 15,         // une carte tous les N tours, compte qui ne tourne que si le deck a des cartes
    RAMASSAGE: 1,             // les étoiles se ramassent à 1 case (8 voisines)
    VUE: { rx: 7, ry: 5 },    // la moitié de ce que l'écran montre, en cases

    // Les monstres ennemis. La population visée monte avec les tours ; il
    // en arrive au plus APPARITIONS par tour tant qu'elle n'est pas atteinte.
    POPULATION_BASE: 5,
    POPULATION_PAR_TOUR: 0.18,
    POPULATION_MAX: 64,
    POPULATION_BOSS: 0.6,     // pendant un boss, moins de petit monde
    APPARITIONS: 3,
    DEPART: 3,                // les ennemis du premier tour
    HORDES: [50, 150, 250],   // le cercle qui se referme, comme dans Vampire Survivors
    HORDE_TAILLE: 18,
    ELITE_TOURS: 30,          // un élite tous les N tours : il lâche un booster
    TAILLE_ELITE: 2,          // un élite occupe 2 × 2 cases,
    TAILLE_BOSS: 3,           // un boss 3 × 3

    // Ce que valent les ennemis. Leurs PV viennent de ATK + DEF, leurs
    // coups de leur ATK : un monstre à 1800 ATK frappe de 900.
    PV_DIVISEUR: 150,
    PV_TEMPS: 100,            // les PV doublent au tour 100...
    PV_FIN: 300,              // ... et accélèrent un peu ensuite : ×2,75 au tour 150, ×5 au tour 300
    DEGATS_ENNEMIS: 0.5,
    DEGATS_TEMPS: 400,
    VITESSE_TEMPS: 500,
    ELITE_PV: 5,
    ELITE_ATK: 1.5,

    // Tes monstres. Dégâts = ATK / 100, plus 25 % par niveau au-delà de 4
    // (le prix des sacrifices), plus 20 % par étoile au-delà de la
    // première. Les étoiles montent la DEF d'autant.
    PAR_NIVEAU: 0.25,
    PAR_ETOILE: 0.2,
    ATK_MINI: 500,            // en dessous, un monstre n'attaque pas : il sert à autre chose
    COMPTEUR: 0.1,            // un compteur de magie : +10 % de dégâts
    COMPTEURS_MAX: 3,
    CUIRASSE: 300,            // Gearfried : ce que perd chaque coup que tu reçois
    EQUIPEMENT: 0.25,         // Maha Vailo : par carte magie sur ton terrain
    USINE: 0.35,              // Usine de Convertisseurs : tes Machines, par étoile
    SALAMANDRA: 0.4,          // Salamandra : tes monstres FEU, par étoile
    ROQUETTE: 0.3,            // Guerrier Roquette : les monstres touchés frappent 30 % moins fort...
    ROQUETTE_TOURS: 3,        // ... pendant N tours
    DRESSE: 0.3,              // Dragon de harpie : par Harpie sur ton terrain
    CYBERBOUCLIER: 0.4,       // Cyberbouclier : tes Harpies, par étoile
    UNION: 0.25,              // Têtes Y et Z : tes autres Machines, par monstre Union
    PRIERE: 0.15,             // Mudora : par Elfe dans ton cimetière
    MEGAMORPHE: 0.5,          // Mégamorphe : tous tes monstres, par étoile...
    MEGAMORPHE_LP: 4000,      // ... tant que tes LP sont sous ce seuil
    PUISSANCE: 0.06,          // Puissance du Mage : par carte de tes zones magie/piège, par étoile
    BOUCLIER_TOURS: 10,       // Bouclier et Épée : les tours où tes monstres attaquent avec leur DEF
    BIBLIOTHEQUE: 3,          // Bibliothèque Magique Royale : les compteurs d'une pioche

    // Les niveaux : 3 étoiles pour le niveau 2, 5 de plus à chaque niveau,
    // et une part qui croît avec le carré du niveau. Sans elle, la horde de
    // la fin faisait monter d'un niveau tous les 8 tours.
    XP_COURBE: 0.3,

    // La protection de ton terrain : K × ln(1 + DEF totale / D0), au plus MAX.
    // 1400 DEF (le Lutin seul) : 13 % ; 5000 : 29 % ; 12 000 : 44 %.
    PROTECTION_K: 0.2,
    PROTECTION_D0: 1500,
    PROTECTION_MAX: 0.7,

    // Ce que prend chaque monstre touché, en part des dégâts du monstre qui
    // attaque, selon son Type (voir ATTAQUES). La fiche montre le chiffre
    // de la cible visée.
    MALEDICTION: 1.4,         // Démon : le plus de vie
    TAILLE: 0.9,              // Guerrier : tout ce qui est à 2 cases
    SEISME: 0.15,             // Rocher : tous les monstres à l'écran, un peu
    RAZ: 0.6,                 // Serpent de Mer : toute une rangée de l'écran
    REBONDS: [1, 0.6, 0.4],   // Magicien : chaque cible du sort, l'une après l'autre
    BOMBE: 0.5,               // Machine : la bombe qui explose au tour suivant...
    BOMBE_RAYON: 2,           // ... sur une zone de 5 × 5
    SERRES: 1.5,              // Bête Ailée : le monstre qu'elle emporte
    CORNE: 1.5,               // Bête-Guerrier : le coup de corne...
    PROJECTION: 4,            // ... qui projette sa cible jusqu'à N cases...
    CHOC: 0.8,                // ... et ce que prennent les deux qui se heurtent
    TOURBILLON: 0.6,          // Aqua : les voisins que le tourbillon aspire
    VORACE: 0.04,             // Poisson : +4 % de dégâts par monstre dévoré...
    VORACE_MAX: 2,            // ... jusqu'au triple
    PARALYSIE: 2,             // Insecte : les tours où le monstre piqué ne fait rien
    RAYONS: 0.5,              // Elfe : chaque monstre aligné avec toi (à 1, c'était deux fois le Guerrier en fin de partie)

    // Les bonus d'attribut
    BRULE_TOURS: 3,           // FEU : le monstre touché brûle N tours...
    BRULE_PART: 0.3,          // ... de cette part du coup, à chaque tour
    ECLATS: 0.3,              // TERRE : ce que prennent les voisins de la cible
    EXPOSE: 0.3,              // LUMIÈRE : le monstre touché prend 30 % de plus...
    EXPOSE_TOURS: 3,          // ... de tous les coups, pendant N tours
    VOL_DE_VIE: 1.5,          // TÉNÈBRES : LP rendus par point de dégât (à 4, il rendait 70 % des coups reçus)
    FEU_TOURS: 3,             // le sol brûle N tours sous un souffle embrasé
    FEU_PART: 0.4,            // et chaque tour, brûle de cette part du souffle

    // Les cartes qui frappent tous les ennemis ne tuent pas un boss : elles
    // lui retirent cette part de ses PV.
    BOSS_PART: 0.2,
    BOSS_PIEGE: 0.15,
    BOSS_EXODIA: 0.2,
    TRAPPE_TOURS: 8,
    TRAPPE_RAYON: 1,          // la Trappe couvre 3 × 3 cases autour de toi
    CYLINDRE: 3,
    ETOILE_POIDS: 0.6,        // une étoile sort un peu moins souvent qu'une carte nouvelle
    DIAN_KETO: 800,
    COEUR_TOURS: 10,          // Changement de Cœur : le temps que le monstre reste chez toi
    LIBERATION: 3,            // Libération d'Âme : les cartes du cimetière qu'elle remet dans le deck
    ENTERREMENT: 800,         // Enterrement Prématuré : ce qu'il coûte en LP
    EPEES: 3,                 // Épées de Révélation : les tours figés, sans compter celui où on les joue
    ECHANGE: 2000,            // Bourse des Âmes : les LP d'une invocation sacrifice, au lieu des sacrifices
    CRANE: 0.1,               // Dé-crâne : les coups ennemis perdent 10 % par point du dé...
    CRANE_TOURS: 10,          // ... pendant N tours
    CHAPEAUX: 5,              // Chapeaux Magiques : où l'on réapparaît
    PLUMEAU: 3,               // Le Plumeau de Dame Harpie : les cases dont il repousse
    VIRUS: 1500,              // Virus Broyeur de Carte : l'ATK à partir de laquelle il détruit
    ZOLGA: 2000,              // Zolga : les LP qu'il rend, sacrifié
    KELDO: 2,                 // Keldo : les cartes du cimetière qu'il remet dans le deck
    AGIDO: 4,                 // Agido : le dé qu'il faut pour ramener une Elfe
    PERMUTATION: 10,          // Permutation des Mondes : les cartes qu'il faut au cimetière...
    PERMUTATION_LP: 1000,     // ... et ce qu'elle coûte

    // Exodia : un élite ou un boss lâche toujours la pièce suivante, le
    // tout-venant de temps en temps. Les cinq balaient l'écran, puis on
    // recommence.
    EXODIA_AUTRES: 0.003,
  };

  /* Les boss, dans l'ordre de cartes.json : les trois dieux égyptiens.
     `frappe` : la forme de leur attaque annoncée (voir annonce), qui tombe
     `delai` tours plus tard -- toujours de quoi en sortir si l'on bouge :
     un pas de côté pour la ligne de Slifer, deux pour la croix de Râ et
     le poing d'Obélisk. Elle frappe tes LP, pas tes monstres. */
  const BOSS = [
    { tour: 100, pv: 900, atk: 1300, cadence: 5, frappe: "ligne", delai: 1, degats: 1500,
      nom: "Foudre écrasante" },
    { tour: 200, pv: 2300, atk: 1500, cadence: 6, frappe: "croix", delai: 2, degats: 2000,
      nom: "Canon flamboyant", renforts: 4 },
    { tour: 300, pv: 4500, atk: 2000, cadence: 5, frappe: "carre", delai: 2, degats: 3500,
      nom: "Poing du dieu", final: true },
  ];

  /* Le palier le plus fort que les ennemis peuvent envoyer, selon le tour. */
  const PALIERS = [0, 40, 90, 160, 230];

  const RARETES = { commune: 60, rare: 26, super: 10, ultra: 3 };
  const ETOILES_MAX = { monstre: 5, passif: 3, terrain: 3, banniere: 1 };

  const ATTRIBUTS = {
    DARK: { nom: "TÉNÈBRES", couleur: "#B983FF" },
    LIGHT: { nom: "LUMIÈRE", couleur: "#FFE78C" },
    EARTH: { nom: "TERRE", couleur: "#D2A56C" },
    WATER: { nom: "EAU", couleur: "#62BCFF" },
    FIRE: { nom: "FEU", couleur: "#FF7B47" },
    WIND: { nom: "VENT", couleur: "#7FEDAA" },
    DIVINE: { nom: "DIVIN", couleur: "#FFD54F" },
  };

  /* L'attaque de chaque Type : une par Type, aucune en double. Un type
     absent (aucune carte du joueur ne l'a) tombe sur la Malédiction. */
  const TYPE_ATTAQUE = {
    "Dragon": "souffle", "Pyro": "flammes", "Magicien": "sort", "Démon": "malediction",
    "Tonnerre": "foudre", "Guerrier": "taille", "Rocher": "seisme", "Bête": "meute", "Machine": "bombe",
    "Bête-Guerrier": "corne", "Bête Ailée": "serres", "Aqua": "tourbillon", "Poisson": "vorace",
    "Serpent de Mer": "raz", "Insecte": "piqure", "Elfe": "rayons",
  };

  /* Ce que chaque attribut ajoute à chaque coup. */
  const BONUS = { FIRE: "brule", WATER: "ralentit", WIND: "repousse", EARTH: "eclats",
                  LIGHT: "expose", DARK: "vampire" };

  // la Magicienne des Ténèbres et son maître (voir l'effet « disciple »)
  const MAGICIEN_SOMBRE = "46986414";

  /* ---------- les cartes ---------- */
  let STOCK = null;

  function charge(stock) { STOCK = stock; }
  function carte(id) { return STOCK.cartes[id]; }

  /* Une carte peut porter plusieurs effets (le Paladin des Ténèbres). */
  function effetsDe(c) { return c.effets || (c.effet ? [c.effet] : []); }
  function a(c, effet) { return effetsDe(c).indexOf(effet) >= 0; }
  /* Une fusion vit dans l'Extra Deck : Polymérisation l'en sort, le
     cimetière ne l'y renvoie pas. */
  function estFusion(c) { return c.rarete === "fusion"; }
  /* Les Harpies de Mai : la Dame Harpie, la Cyber-Harpie (qui compte comme
     elle) et les Sœurs. */
  function estHarpie(c) { return c.famille === "harpie"; }

  /* Ce qu'une carte devient une fois jouée. */
  function place(c) {
    if (c.genre === "monstre") return "monstre";
    if (c.effet === "terrain") return "terrain";
    if (c.effet === "trappe") return "sol";
    if (c.sorte === "continue" || ["miroir", "cylindre", "jugement", "chapeaux"].indexOf(c.effet) >= 0) return "zone";
    return "effet";
  }

  /* ---------- le hasard ----------
     Une graine, et la partie se rejoue à l'identique : c'est ce qui rend
     les simulations comparables d'un réglage à l'autre. */
  function hasard(graine) {
    let s = graine >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const cle = (x, y) => x + "," + y;

  function melange(etat, liste) {
    for (let i = liste.length - 1; i > 0; i--) {
      const j = Math.floor(etat.hasard() * (i + 1));
      [liste[i], liste[j]] = [liste[j], liste[i]];
    }
    return liste;
  }

  /* ---------- la place des ennemis ----------
     Un élite occupe 2 × 2 cases et un boss 3 × 3 : (x, y) est leur coin en
     haut à gauche. Toutes les distances se mesurent jusqu'à la case la plus
     proche du monstre. */
  const taille = (e) => e.t || 1;

  function dans(e, x, y) {
    const t = taille(e);
    return x >= e.x && x < e.x + t && y >= e.y && y < e.y + t;
  }

  /* La distance (en roi d'échecs) d'une case au monstre. */
  function ecart(e, p) {
    const t = taille(e);
    const dx = p.x < e.x ? e.x - p.x : p.x > e.x + t - 1 ? p.x - (e.x + t - 1) : 0;
    const dy = p.y < e.y ? e.y - p.y : p.y > e.y + t - 1 ? p.y - (e.y + t - 1) : 0;
    return Math.max(dx, dy);
  }

  /* La distance entre deux monstres, bord à bord. */
  function ecartEntre(p, q) {
    const tp = taille(p), tq = taille(q);
    const dx = Math.max(0, p.x - (q.x + tq - 1), q.x - (p.x + tp - 1));
    const dy = Math.max(0, p.y - (q.y + tq - 1), q.y - (p.y + tp - 1));
    return Math.max(dx, dy);
  }

  function milieu(e) { const t = taille(e); return { x: e.x + (t - 1) / 2, y: e.y + (t - 1) / 2 }; }

  /* La case du monstre la plus proche d'un point : là où l'on vise. */
  function caseVisee(e, p) {
    const t = taille(e);
    return { x: Math.min(e.x + t - 1, Math.max(e.x, p.x)), y: Math.min(e.y + t - 1, Math.max(e.y, p.y)) };
  }

  function casesDe(e) {
    const t = taille(e), cases = [];
    for (let dx = 0; dx < t; dx++) for (let dy = 0; dy < t; dy++) cases.push({ x: e.x + dx, y: e.y + dy });
    return cases;
  }

  // à portée de coup : une des 8 cases autour
  const colle = (e, j) => ecart(e, j) === 1;

  /* Le duelliste de cette clé (« yugi », « joey »), ou le premier. */
  function duelliste(cle) {
    return STOCK.duellistes.find((d) => d.cle === cle) || STOCK.duellistes[0];
  }

  /* =========================================================
     Une partie
     ========================================================= */
  /* `duelliste` : la clé de celui qu'on joue, Yugi sans elle. */
  function nouvelle(options) {
    const o = options || {};
    const graine = o.graine == null ? Math.floor(Math.random() * 2 ** 31) : o.graine;
    const etat = {
      graine,
      hasard: hasard(graine),
      vue: Object.assign({}, R.VUE, o.vue || {}),
      tour: 0,
      joueur: { x: 0, y: 0, lp: R.LP, niveau: 1, xp: 0 },
      monstres: new Array(R.ZONES).fill(null),   // { id, recharge, compteurs, jeton }
      zones: new Array(R.ZONES).fill(null),      // { id, charges } : passifs et pièges face cachée
      terrain: null,
      main: [],
      deck: [],                                  // ce qu'on pioche : le départ, puis ce qu'on garde des boosters
      reserve: [],                               // ce que les boosters peuvent proposer (les 40)
      extra: [],                                 // les fusions que Polymérisation peut sortir
      cimetiere: [],
      etoiles: {},
      pieges: [],                                // les Trappes ouvertes au sol : { x, y, id, fin }
      bombes: [],                                // celles des Machines : { uid, x, y, tour, n, source }
      avantPioche: R.PIOCHE_TOURS,               // les tours avant la prochaine pioche
      crane: null,                               // le Dé-crâne : { fin, part }
      feux: new Map(),                           // le sol qui brûle : cle -> { x, y, fin, degats, source }
      ennemis: [],
      butin: new Map(),                          // cle -> { x, y, xp, booster, exodia }
      annonces: [],                              // { cases: Set, tour, degats, nom }
      exodia: [],
      epees: 0,
      boosters: [],                              // ceux qui attendent d'être ouverts
      attente: null,                             // { sorte, offres } : un booster ouvert
      boss: null,                                // le boss en cours, pour sa jauge
      uid: 0,
      fini: null,                                // "defaite" | "victoire"
      duelliste: null,                           // la clé de celui qu'on joue
      bouclier: 0,                               // Bouclier et Épée : le tour où il cesse
      permutee: false,                           // Permutation des Mondes : une fois par duel
      calme: 0,                                  // les tours d'affilée sans bouger
      // ce que les succès comptent (voir SUCCES dans survivor.py) : `coup`,
      // le plus gros coup d'un de tes monstres ; `fil`, les dieux abattus
      // sous 1000 LP ; `zones`, `defense` (la part arrêtée par ta DEF, en
      // %) et `immobile`, le plus haut atteint ; `types`, les monstres
      // vaincus par Type de ton monstre
      stats: { tues: 0, degats: 0, cartes: 0, boosters: 0, boss: 0, exodia: 0, fusions: 0, magies: 0,
               pieges: 0, ramenees: 0, coup: 0, fil: 0, zones: 0, defense: 0, immobile: 0, types: {} },
    };
    const du = duelliste(o.duelliste);
    const d = du.depart;
    etat.duelliste = du.cle;
    d.terrain.forEach((id, i) => { etat.monstres[i] = nouveauMonstre(etat, id); });
    etat.deck = melange(etat, d.deck.slice());
    etat.main = etat.deck.splice(0, R.MAIN_DEPART);
    etat.reserve = (o.deck || STOCK.deck).filter((id) => STOCK.cartes[id]);
    etat.extra = (o.extra || STOCK.extra).filter((id) => STOCK.cartes[id]);
    const ev = [];
    for (let i = 0; i < R.DEPART; i++) apparait(etat, ev, tireEnnemi(etat), caseAuBord(etat, 0, 1));
    return etat;
  }

  /* L'écran a changé de taille : les ennemis naissent juste au-delà du bord. */
  function vue(etat, rx, ry) { etat.vue = { rx, ry }; }

  /* =========================================================
     Ce que valent les cartes
     ========================================================= */
  const etoiles = (etat, id) => (etat && etat.etoiles[id]) || 1;
  const parEtoile = (etat, id) => 1 + R.PAR_ETOILE * (etoiles(etat, id) - 1);

  /* `fin` : le tour où il repart (un monstre pris par Changement de Cœur) ;
     `copie` : l'ATK et la DEF que Copiechat a prises ; `repas` : les monstres
     qu'un Poisson a dévorés. */
  function nouveauMonstre(etat, id, jeton) {
    return { id, recharge: 0, compteurs: 0, jeton: !!jeton, fin: null, copie: null, repas: 0 };
  }

  /* L'ATK et la DEF d'une carte, ou celles que Copiechat a copiées. */
  const atkDe = (c, m) => (m && m.copie ? m.copie.atk : c.atk);
  const dfDe = (c, m) => (m && m.copie ? m.copie.df : c.df);

  function defenseMax(etat, id, m) { return Math.round(dfDe(carte(id), m) * parEtoile(etat, id)); }

  function passif(etat, effet) {
    let n = 0;
    for (const z of etat.zones) if (z && carte(z.id).effet === effet) n += etoiles(etat, z.id);
    return n;
  }

  function motif(c) { return c.motif || TYPE_ATTAQUE[c.type] || "malediction"; }
  function bonusDe(c) { return BONUS[c.attribut] || null; }

  /* L'ATK avec laquelle un monstre attaque : sa DEF tant que Bouclier et
     Épée dure. Sans `etat` (un booster qui se demande s'il attaque), son
     ATK. */
  function atkJeu(etat, c, m) { return etat && etat.bouclier > etat.tour ? dfDe(c, m) : atkDe(c, m); }

  function attaque(c, m, etat) { return atkJeu(etat, c, m) >= R.ATK_MINI && !a(c, "temps"); }

  /* « Tout l'écran » pour les tirs qui le traversent. */
  function ecran(etat) { const v = etat ? etat.vue : R.VUE; return Math.max(v.rx, v.ry) + 1; }

  function portee(etat, c) {
    const m = motif(c);
    if (m === "seisme" || m === "raz" || a(c, "trois-tetes") || a(c, "charge-celeste")) return ecran(etat);
    if (m === "flammes") return 3;
    return 4 + Math.floor(c.niveau / 4);
  }

  /* Sous un terrain qui renforce son type, le Chevalier Sirène attaque à
     chaque tour. */
  function sousSonTerrain(etat, c) {
    return !!(etat && etat.terrain && carte(etat.terrain).types.indexOf(c.type) >= 0);
  }

  function recharge(etat, c) {
    if (a(c, "temps")) return 4;
    if (c.niveau <= 2 || a(c, "furie")) return 1;
    if (a(c, "sirene") && sousSonTerrain(etat, c)) return 1;
    if (c.niveau <= 4 && etat && passif(etat, "banniere")) return 1;
    return 2;
  }

  function surLeTerrain(etat, id) { return etat.monstres.some((m) => m && m.id === id); }

  /* Les cartes magie de ton terrain : les zones magie/piège et le terrain. */
  function magiesPosees(etat) {
    return etat.zones.filter((z) => z && carte(z.id).genre === "magie").length + (etat.terrain ? 1 : 0);
  }

  /* Les monstres de ton terrain qui portent cet effet, ou sont des Harpies ;
     `sauf` : le monstre lui-même. Les jetons ne comptent pas. */
  function compte(etat, test, sauf) {
    return etat.monstres.filter((m) => m && m !== sauf && !m.jeton && test(carte(m.id))).length;
  }

  function bonus(etat, c, m) {
    let b = 1 + 0.2 * passif(etat, "hache");
    if (a(c, "equipement")) b += R.EQUIPEMENT * magiesPosees(etat);
    if (m && motif(c) === "vorace") b += Math.min(R.VORACE_MAX, R.VORACE * (m.repas || 0));
    if (c.type === "Dragon") b += 0.35 * passif(etat, "tresor-dragon");
    if (c.type === "Machine") b += R.USINE * passif(etat, "usine");
    if (c.type === "Machine") b += R.UNION * compte(etat, (x) => a(x, "union"), m);
    if (c.attribut === "FIRE") b += R.SALAMANDRA * passif(etat, "salamandra");
    if (estHarpie(c)) b += R.CYBERBOUCLIER * passif(etat, "cyberbouclier");
    if (a(c, "dresse")) b += R.DRESSE * compte(etat, estHarpie);
    if (a(c, "priere")) b += R.PRIERE * etat.cimetiere.filter((x) => carte(x).type === "Elfe").length;
    if (etat.joueur.lp < R.MEGAMORPHE_LP) b += R.MEGAMORPHE * passif(etat, "megamorphe");
    b += R.PUISSANCE * etat.zones.filter(Boolean).length * passif(etat, "puissance-du-mage");
    if (c.type === "Magicien" && m) b += R.COMPTEUR * m.compteurs;
    if (sousSonTerrain(etat, c)) b += 0.3 + 0.15 * (etoiles(etat, etat.terrain) - 1);
    if (a(c, "disciple")
        && (surLeTerrain(etat, MAGICIEN_SOMBRE) || etat.cimetiere.indexOf(MAGICIEN_SOMBRE) >= 0)) {
      b += 0.3;
    }
    return b;
  }

  /* Les dégâts d'un tir. `m` : le monstre sur le terrain, pour ses
     compteurs ; sans lui (une carte en main), le tir tel qu'il
     serait en arrivant. */
  function degats(etat, id, m) {
    const c = carte(id);
    if (!attaque(c, m, etat)) return 0;
    const base = atkJeu(etat, c, m) / 100 * (1 + R.PAR_NIVEAU * Math.max(0, c.niveau - 4)) * parEtoile(etat, id);
    return Math.max(1, Math.round(base * (etat ? bonus(etat, c, m) : 1)));
  }

  function sacrifices(c) { return c.niveau <= 4 ? 0 : c.niveau <= 6 ? 1 : 2; }

  /* Ce que vaut un monstre offert en sacrifice : 1, ou 2 pour le Kaiser
     Hippocampe. */
  function valeurSacrifice(etat, zone) {
    const m = etat.monstres[zone];
    if (!m) return 0;
    return a(carte(m.id), "hippocampe") ? 2 : 1;
  }

  /* La DEF qui te protège : celle de tous tes monstres, étoiles comprises.
     La Sentinelle compte double, et les Dragons aussi avec le Seigneur des
     D à leurs côtés. */
  function defenseTotale(etat) {
    const protecteur = etat.monstres.some((m) => m && a(carte(m.id), "protecteur"));
    let d = 0;
    for (const m of etat.monstres) {
      if (!m) continue;
      const c = carte(m.id);
      let x = defenseMax(etat, m.id, m);
      if (a(c, "rempart")) x *= 2;
      if (protecteur && c.type === "Dragon") x *= 2;
      d += x;
    }
    return d;
  }

  /* La part de chaque coup que ta DEF arrête : vite au début, puis de
     moins en moins, sans jamais tout arrêter. */
  function protection(etat) {
    const d = defenseTotale(etat);
    return Math.min(R.PROTECTION_MAX, R.PROTECTION_K * Math.log(1 + d / R.PROTECTION_D0));
  }

  /* La part de chaque coup ennemi qui ne te touche pas : ta DEF, et le
     Dé-crâne tant qu'il dure. C'est la « Défense » des stats. */
  function reduction(etat) {
    const crane = etat.crane && etat.crane.fin > etat.tour ? etat.crane.part : 0;
    return 1 - (1 - protection(etat)) * (1 - crane);
  }

  function rayonRamassage(etat) { return R.RAMASSAGE + passif(etat, "aimant"); }

  function xpPour(niveau) { return Math.round(3 + 5 * (niveau - 1) + R.XP_COURBE * (niveau - 1) ** 2); }

  /* =========================================================
     Les ennemis
     ========================================================= */
  function palierMax(tour) {
    let p = 0;
    PALIERS.forEach((t, i) => { if (tour >= t) p = i; });
    return p;
  }

  /* Le plus souvent le palier le plus fort ouvert, parfois les deux d'avant. */
  function tireEnnemi(etat, decalage) {
    const max = Math.min(STOCK.ennemis.length - 1, palierMax(etat.tour) + (decalage || 0));
    const r = etat.hasard();
    const p = Math.max(0, r < 0.6 ? max : r < 0.9 ? max - 1 : max - 2);
    const palier = STOCK.ennemis[p];
    return palier[Math.floor(etat.hasard() * palier.length)];
  }

  function ennemiEn(etat, x, y, sauf) {
    return etat.ennemis.find((e) => e !== sauf && dans(e, x, y)) || null;
  }

  function occupee(etat, x, y, sauf) {
    if (x === etat.joueur.x && y === etat.joueur.y) return true;
    return !!ennemiEn(etat, x, y, sauf);
  }

  /* Un carré de t × t cases libre, coin en (x, y). */
  function libre(etat, x, y, t, sauf) {
    for (let dx = 0; dx < t; dx++) for (let dy = 0; dy < t; dy++) if (occupee(etat, x + dx, y + dy, sauf)) return false;
    return true;
  }

  /* Une place libre sur le pourtour de l'écran, `marge` cases au-delà du
     bord (négatif : en deçà, à l'intérieur de l'écran). */
  function caseAuBord(etat, marge, t) {
    const ax = etat.vue.rx + 1 + marge, ay = etat.vue.ry + 1 + marge;
    const tour = 4 * (ax + ay);
    for (let essai = 0; essai < 40; essai++) {
      let k = Math.floor(etat.hasard() * tour), x, y;
      if (k < 2 * ax) { x = -ax + k; y = -ay; }
      else if ((k -= 2 * ax) < 2 * ay) { x = ax; y = -ay + k; }
      else if ((k -= 2 * ay) < 2 * ax) { x = ax - k; y = ay; }
      else { k -= 2 * ax; x = -ax; y = ay - k; }
      x += etat.joueur.x; y += etat.joueur.y;
      // un grand monstre déborde vers l'extérieur, jamais vers toi
      if (x <= etat.joueur.x) x -= (t || 1) - 1;
      if (y <= etat.joueur.y) y -= (t || 1) - 1;
      if (libre(etat, x, y, t || 1)) return { x, y };
    }
    return null;
  }

  /* La part de tours où un ennemi agit. Le VENT va aussi vite que toi, un
     mur de DEF traîne ; tous accélèrent avec les tours, jusqu'à ne plus
     te laisser semer personne. */
  function vitesse(etat, c) {
    if (c.attribut === "WIND") return 1;
    const base = c.df > c.atk ? 0.5 : 0.7;
    return Math.min(1, base * (1 + etat.tour / R.VITESSE_TEMPS));
  }

  function apparait(etat, ev, id, pos, options) {
    if (!pos || !id) return null;
    const o = options || {};
    const c = carte(id);
    const t0 = etat.tour;
    let pv = Math.max(3, Math.round((c.atk + c.df) / R.PV_DIVISEUR
      * (1 + t0 / R.PV_TEMPS + (t0 / R.PV_FIN) ** 2)));
    let atk = Math.max(100, Math.round(c.atk * R.DEGATS_ENNEMIS * (1 + etat.tour / R.DEGATS_TEMPS)));
    let v = vitesse(etat, c);
    let t = 1;
    if (o.elite) { pv *= R.ELITE_PV; atk = Math.round(atk * R.ELITE_ATK); t = R.TAILLE_ELITE; }
    if (o.boss != null) { const b = BOSS[o.boss]; pv = b.pv; atk = b.atk; v = 0.5; t = R.TAILLE_BOSS; }
    const e = {
      uid: ++etat.uid, id, x: pos.x, y: pos.y, t, pv, pvMax: pv, atk, vitesse: v,
      elan: etat.hasard(), ralenti: 0, brule: null, expose: 0, affaibli: 0, elite: !!o.elite,
      boss: o.boss == null ? null : o.boss,
      niveau: c.niveau || 1, prochaine: o.boss == null ? 0 : etat.tour + BOSS[o.boss].cadence,
    };
    etat.ennemis.push(e);
    if (e.boss != null) etat.boss = e;
    ev.push({ t: "apparait", uid: e.uid });
    return e;
  }

  /* Les nouvelles vagues, en fin de tour. */
  function vagues(etat, ev) {
    const t = etat.tour;
    BOSS.forEach((b, i) => {
      if (b.tour === t) {
        const e = apparait(etat, ev, STOCK.boss[i], caseAuBord(etat, -1, R.TAILLE_BOSS), { boss: i });
        if (e) ev.push({ t: "message", texte: carte(e.id).nom + " arrive !", genre: "boss" });
      }
    });
    if (R.HORDES.indexOf(t) >= 0) {
      const { rx, ry } = etat.vue;
      for (let k = 0; k < R.HORDE_TAILLE; k++) {
        const angle = k / R.HORDE_TAILLE * Math.PI * 2;
        const x = etat.joueur.x + Math.round(Math.cos(angle) * rx);
        const y = etat.joueur.y + Math.round(Math.sin(angle) * ry);
        if (!occupee(etat, x, y)) apparait(etat, ev, tireEnnemi(etat, -1), { x, y });
      }
      ev.push({ t: "message", texte: "Les monstres t'encerclent !", genre: "horde" });
    }
    if (t > 0 && t % R.ELITE_TOURS === 0) {
      apparait(etat, ev, tireEnnemi(etat, 1), caseAuBord(etat, 0, R.TAILLE_ELITE), { elite: true });
    }
    let visee = Math.min(R.POPULATION_MAX, Math.floor(R.POPULATION_BASE + t * R.POPULATION_PAR_TOUR));
    if (etat.boss) visee = Math.floor(visee * R.POPULATION_BOSS);
    const n = Math.min(R.APPARITIONS, visee - etat.ennemis.filter((e) => e.boss == null).length);
    for (let k = 0; k < n; k++) apparait(etat, ev, tireEnnemi(etat), caseAuBord(etat, 0, 1));
  }

  /* Un ennemi resté trop loin derrière revient au bord de l'écran : sinon
     il suffirait de courir tout droit pour vider la carte. */
  function rapproche(etat) {
    const loin = Math.max(etat.vue.rx, etat.vue.ry) * 2 + 3;
    for (const e of etat.ennemis) {
      if (ecart(e, etat.joueur) > loin) {
        const p = caseAuBord(etat, 0, taille(e));
        if (p) { e.x = p.x; e.y = p.y; }
      }
    }
  }

  /* =========================================================
     Frapper, tuer, ramasser
     ========================================================= */
  /* Ce qu'un coup de `n` retire vraiment : le double à un Dragon, pour un
     tueur de dragons ; un peu plus à un monstre exposé par la LUMIÈRE. */
  function force(e, n, source) {
    let d = n;
    if (source && a(carte(source), "anti-dragon") && carte(e.id).type === "Dragon") d *= 2;
    if (e.expose > 0) d *= 1 + R.EXPOSE;
    return Math.max(1, Math.round(d));
  }

  /* `source` : le monstre qui frappe ; sans lui (une carte qui détruit un
     boss d'une part de ses PV), le coup ne compte pas comme le sien. */
  function blesseEnnemi(etat, ev, e, n, source) {
    if (e.pv <= 0) return;
    const d = force(e, n, source);
    e.pv -= d;
    etat.stats.degats += d;
    if (source && d > etat.stats.coup) etat.stats.coup = d;
    const m = milieu(e);
    ev.push({ t: "coup", x: m.x, y: m.y, n: d, uid: e.uid });
    if (e.pv <= 0) tue(etat, ev, e, source);
  }

  /* Ce que frappe un ennemi : moins fort tant que le Guerrier Roquette
     l'affaiblit. */
  function frappeDe(e) { return Math.round(e.atk * (e.affaibli > 0 ? 1 - R.ROQUETTE : 1)); }

  /* Ce qui « détruit » d'un coup : un ennemi ordinaire meurt, un boss perd
     une part de ses PV. */
  function detruit(etat, ev, e, part) {
    if (e.pv <= 0) return;
    if (e.boss != null) blesseEnnemi(etat, ev, e, e.pvMax * part, null);
    else { const m = milieu(e); ev.push({ t: "coup", x: m.x, y: m.y, n: e.pv, uid: e.uid }); tue(etat, ev, e); }
  }

  /* Un piège qui détruit : ce qu'il abat compte pour lui. */
  function parPiege(etat, ev, e, part) {
    if (e.pv <= 0) return;
    detruit(etat, ev, e, part);
    if (e.pv <= 0) etat.stats.pieges++;
  }

  function tue(etat, ev, e, source) {
    e.pv = 0;
    etat.ennemis = etat.ennemis.filter((x) => x !== e);
    etat.stats.tues++;
    if (source) {
      const t = carte(source).type;
      etat.stats.types[t] = (etat.stats.types[t] || 0) + 1;
    }
    const m = milieu(e);
    ev.push({ t: "mort", x: m.x, y: m.y, uid: e.uid, id: e.id, boss: e.boss != null, taille: taille(e) });
    const x = Math.round(m.x), y = Math.round(m.y);
    lache(etat, x, y).xp += e.boss != null ? 30 : e.elite ? e.niveau * 4 : e.niveau;
    if (e.elite) { const p = aCote(etat, x, y, true); lache(etat, p.x, p.y).booster = true; }
    const piece = pieceSuivante(etat);
    if (piece && (e.boss != null || e.elite || etat.hasard() < R.EXODIA_AUTRES)) {
      const p = aCote(etat, x, y, false);
      lache(etat, p.x, p.y).exodia = piece;
    }
    if (e.boss != null) {
      etat.stats.boss++;
      if (etat.joueur.lp < 1000) etat.stats.fil++;
      // un boss qu'on n'a pas fini peut encore être là quand le suivant arrive
      etat.boss = etat.ennemis.find((x) => x.boss != null) || null;
      if (BOSS[e.boss].final) etat.fini = "victoire";
      // sa frappe annoncée ne tombera pas
      if (etat.annonces.some((x) => x.uid === e.uid)) {
        etat.annonces = etat.annonces.filter((x) => x.uid !== e.uid);
        ev.push({ t: "annule", nom: BOSS[e.boss].nom });
      }
    }
  }

  function lache(etat, x, y) {
    const k = cle(x, y);
    if (!etat.butin.has(k)) etat.butin.set(k, { x, y, xp: 0, booster: false, exodia: null });
    return etat.butin.get(k);
  }

  /* Où poser un booster ou une pièce d'Exodia : jamais sur la case d'un
     autre, pour qu'on voie l'un et l'autre. Le booster tombe sur la case du
     monstre (`ici`) ; la pièce à côté, du côté opposé au joueur, qui
     ramasse donc le booster d'abord. */
  function aCote(etat, x, y, ici) {
    const j = etat.joueur;
    let sx = Math.sign(x - j.x), sy = Math.sign(y - j.y);
    if (!sx && !sy) sx = 1;
    const cases = (ici ? [[0, 0]] : []).concat([[sx, sy]]);
    for (let r = 1; r <= 2; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) cases.push([dx, dy]);
      }
    }
    for (const [dx, dy] of cases) {
      const b = etat.butin.get(cle(x + dx, y + dy));
      if (!b || (!b.booster && !b.exodia)) return { x: x + dx, y: y + dy };
    }
    return { x: x + sx, y: y + sy };
  }

  function pieceSuivante(etat) {
    const auSol = new Set();
    etat.butin.forEach((b) => { if (b.exodia) auSol.add(b.exodia); });
    return STOCK.exodia.find((id) => etat.exodia.indexOf(id) < 0 && !auSol.has(id)) || null;
  }

  function aLEcran(etat) {
    const { rx, ry } = etat.vue;
    const j = etat.joueur;
    return etat.ennemis.filter((e) => {
      const p = caseVisee(e, j);
      return Math.abs(p.x - j.x) <= rx && Math.abs(p.y - j.y) <= ry;
    });
  }

  /* Les cinq pièces : Exodia balaie l'écran, et le compte repart à zéro. */
  function exodia(etat, ev) {
    ev.push({ t: "exodia-complet" });
    etat.stats.exodia++;
    etat.exodia = [];
    aLEcran(etat).forEach((e) => detruit(etat, ev, e, R.BOSS_EXODIA));
  }

  function ramasse(etat, ev) {
    const r = rayonRamassage(etat);
    const j = etat.joueur;
    etat.butin.forEach((b, k) => {
      if (Math.max(Math.abs(b.x - j.x), Math.abs(b.y - j.y)) > r) return;
      etat.butin.delete(k);
      if (b.xp) gagneXp(etat, ev, b.xp);
      if (b.booster) { etat.boosters.push("elite"); ev.push({ t: "message", texte: "Booster !", genre: "booster" }); }
      if (b.exodia) {
        etat.exodia.push(b.exodia);
        ev.push({ t: "exodia", id: b.exodia, n: etat.exodia.length });
        if (etat.exodia.length === STOCK.exodia.length) exodia(etat, ev);
      }
      ev.push({ t: "ramasse", x: b.x, y: b.y, xp: b.xp });
    });
  }

  /* Les étoiles trop loin se perdent ; une pièce d'Exodia ou un booster,
     jamais. */
  function oublieLeLointain(etat) {
    const loin = Math.max(etat.vue.rx, etat.vue.ry) * 3;
    const j = etat.joueur;
    etat.butin.forEach((b, k) => {
      if (!b.booster && !b.exodia && Math.max(Math.abs(b.x - j.x), Math.abs(b.y - j.y)) > loin) etat.butin.delete(k);
    });
  }

  function gagneXp(etat, ev, n) {
    const j = etat.joueur;
    j.xp += n;
    while (j.xp >= xpPour(j.niveau)) {
      j.xp -= xpPour(j.niveau);
      j.niveau++;
      etat.boosters.push("niveau");
      ev.push({ t: "niveau", niveau: j.niveau });
    }
  }

  function soigne(etat, ev, n) {
    if (n <= 0) return;
    etat.joueur.lp += n;
    ev.push({ t: "lp", n });
  }

  function monteEtoile(etat, ev, id) {
    etat.etoiles[id] = etoiles(etat, id) + 1;
    ev.push({ t: "etoile", id, n: etat.etoiles[id] });
  }

  /* =========================================================
     Les coups que tu prends
     ========================================================= */
  /* Un coup pour tes LP. Kuriboh, s'il est dans ta main, prend celui qui
     t'aurait mis à 0. */
  function blesseJoueur(etat, ev, n, e) {
    if (n <= 0 || etat.fini) return;
    const j = etat.joueur;
    if (j.lp - n <= 0) {
      const k = etat.main.findIndex((id) => a(carte(id), "kuriboh"));
      if (k >= 0) {
        const [id] = etat.main.splice(k, 1);
        etat.cimetiere.push(id);
        ev.push({ t: "garde", id, texte: "Kuriboh te protège !" });
        return;
      }
    }
    j.lp = Math.max(0, j.lp - n);
    ev.push({ t: "lp", n: -n, de: e ? caseVisee(e, j) : null });
    if (j.lp <= 0) etat.fini = "defaite";
  }

  /* Un ennemi frappe. Les pièges posés d'abord (Cylindre, Miroir,
     Chapeaux), puis ta DEF amortit le coup. */
  function encaisse(etat, ev, n, e) {
    const cyl = etat.zones.findIndex((z) => z && carte(z.id).effet === "cylindre");
    if (cyl >= 0) {
      const z = etat.zones[cyl];
      z.charges--;
      ev.push({ t: "garde", id: z.id, texte: "Cylindre Magique !" });
      if (z.charges <= 0) { etat.zones[cyl] = null; etat.cimetiere.push(z.id); }
      parPiege(etat, ev, e, R.BOSS_PIEGE);
      return;
    }
    const mir = etat.zones.findIndex((z) => z && carte(z.id).effet === "miroir");
    if (mir >= 0) {
      const id = etat.zones[mir].id;
      etat.zones[mir] = null;
      etat.cimetiere.push(id);
      ev.push({ t: "garde", id, texte: "Force de Miroir !", miroir: true });
      proches(etat, 2).forEach((x) => parPiege(etat, ev, x, R.BOSS_PIEGE));
      return;
    }
    const chap = etat.zones.findIndex((z) => z && carte(z.id).effet === "chapeaux");
    const p = chap >= 0 ? cachette(etat) : null;
    if (p) {
      const id = etat.zones[chap].id;
      etat.zones[chap] = null;
      etat.cimetiere.push(id);
      const de = { x: etat.joueur.x, y: etat.joueur.y };
      etat.joueur.x = p.x; etat.joueur.y = p.y;
      ev.push({ t: "chapeaux", id, de, vers: { x: p.x, y: p.y } });
      ev.push({ t: "garde", id, texte: "Chapeaux Magiques !" });
      return;
    }
    let coup = n * (1 - reduction(etat));
    const cuirasses = etat.monstres.filter((m) => m && a(carte(m.id), "cuirasse")).length;
    coup = Math.max(0, Math.round(coup - cuirasses * R.CUIRASSE));
    if (coup) blesseJoueur(etat, ev, coup, e);
    if (e.pv > 0 && etat.monstres.some((m) => m && a(carte(m.id), "illusion"))) {
      pousse(etat, ev, e, axe(etat.joueur, e), 2);
    }
  }

  /* Les Chapeaux Magiques : une case libre à N cases de toi, celle où il y
     a le moins de monstres autour. */
  function cachette(etat) {
    const j = etat.joueur, d = R.CHAPEAUX, places = [];
    for (let dx = -d; dx <= d; dx++) {
      for (let dy = -d; dy <= d; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== d || occupee(etat, j.x + dx, j.y + dy)) continue;
        const q = { x: j.x + dx, y: j.y + dy };
        places.push({ x: q.x, y: q.y, danger: etat.ennemis.filter((e) => ecart(e, q) <= 2).length });
      }
    }
    melange(etat, places);
    return places.sort((p, q) => p.danger - q.danger)[0] || null;
  }

  /* =========================================================
     Tes monstres attaquent
     ========================================================= */
  function proches(etat, rayon) {
    const j = etat.joueur;
    const manhattan = (e) => { const m = milieu(e); return Math.abs(m.x - j.x) + Math.abs(m.y - j.y); };
    return etat.ennemis
      .filter((e) => ecart(e, j) <= rayon)
      .sort((p, q) => ecart(p, j) - ecart(q, j) || manhattan(p) - manhattan(q) || p.uid - q.uid);
  }

  /* La direction d'un monstre vu de toi : l'axe le plus long. */
  function axe(j, e) {
    const m = milieu(e);
    const dx = m.x - j.x, dy = m.y - j.y;
    if (!dx && !dy) return [1, 0];
    return Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
  }


  /* Les ennemis sur ces cases, chacun une fois. */
  function surCases(etat, cases) {
    const vus = [];
    for (const p of cases) {
      const e = ennemiEn(etat, p.x, p.y);
      if (e && vus.indexOf(e) < 0) vus.push(e);
    }
    return vus;
  }

  /* Ajoute un coup, ou garde le plus fort quand deux zones se recouvrent. */
  function ajouteCoup(coups, e, part) {
    const deja = coups.find((x) => x[0] === e);
    if (deja) deja[1] = Math.max(deja[1], part); else coups.push([e, part]);
  }

  function zone(centre, r) {
    const cases = [];
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) cases.push({ x: centre.x + dx, y: centre.y + dy });
    return cases;
  }

  /* Un cône qui part de toi dans la direction d : 3 cases à la première
     rangée, 5 à la deuxième, 7 à la troisième. */
  function cone(etat, d, profondeur) {
    const j = etat.joueur, cases = [];
    for (let k = 1; k <= profondeur; k++) {
      for (let w = -k; w <= k; w++) cases.push({ x: j.x + d[0] * k + d[1] * w, y: j.y + d[1] * k + d[0] * w });
    }
    return cases;
  }

  /* Chaque attaque dit qui elle touche et comment :
       { cases, coups: [[e, part]], chemin }
     `cases` pour le dessin d'une zone, `chemin` pour celui d'un sort qui
     rebondit. Rien à toucher : le monstre garde son attaque prête pour le
     tour suivant. */
  const ATTAQUES = {
    // Dragon : un souffle en zone sur le plus proche
    souffle(etat, c) {
      const n = a(c, "trois-tetes") ? 3 : 1;
      const cibles = proches(etat, portee(etat, c)).slice(0, n);
      if (!cibles.length) return null;
      const r = a(c, "meteore") ? 2 : 1;
      const cases = [], coups = [], centres = [];
      for (const e of cibles) {
        const v = caseVisee(e, etat.joueur);
        centres.push(v);
        for (const p of zone(v, r)) cases.push(p);
        ajouteCoup(coups, e, 1);
        for (const x of surCases(etat, zone(v, r))) ajouteCoup(coups, x, 0.6);
      }
      return { cases, coups, centres, embrase: a(c, "meteore") };
    },
    // Magicien : un sort sur le plus proche, qui rebondit sur deux autres
    sort(etat, c) {
      const premier = proches(etat, portee(etat, c))[0];
      if (!premier) return null;
      const touches = [premier];
      while (touches.length < R.REBONDS.length) {
        const dernier = touches[touches.length - 1];
        const suivant = etat.ennemis.filter((e) => touches.indexOf(e) < 0 && ecartEntre(e, dernier) <= 3)
          .sort((p, q) => ecartEntre(p, dernier) - ecartEntre(q, dernier) || p.uid - q.uid)[0];
        if (!suivant) break;
        touches.push(suivant);
      }
      return { cases: [], coups: touches.map((e, k) => [e, R.REBONDS[k]]), chemin: touches.map((e) => milieu(e)) };
    },
    // Démon : frappe fort le plus résistant à portée
    malediction(etat, c) {
      const cibles = proches(etat, portee(etat, c));
      if (!cibles.length) return null;
      const e = cibles.slice().sort((p, q) => q.pv - p.pv || ecart(p, etat.joueur) - ecart(q, etat.joueur))[0];
      return { cases: [caseVisee(e, etat.joueur)], coups: [[e, R.MALEDICTION]], chemin: [milieu(e)] };
    },
    // Guerrier : taille tout ce qui est à 2 cases (l'Épée de flammes du
    // Spadassin embrase ces cases)
    taille(etat, c) {
      const r = 2;
      const cibles = proches(etat, r);
      if (!cibles.length) return null;
      return { cases: zone(etat.joueur, r).filter((p) => p.x !== etat.joueur.x || p.y !== etat.joueur.y),
               coups: cibles.map((e) => [e, R.TAILLE]), anneau: r, embrase: a(c, "epee-de-flammes") };
    },
    // Bête : les plus proches, un par Bête sur ton terrain (les jetons ne
    // comptent pas)
    meute(etat, c) {
      const n = Math.max(1, etat.monstres.filter((m) => m && !m.jeton && carte(m.id).type === "Bête").length);
      const cibles = proches(etat, portee(etat, c)).slice(0, n);
      if (!cibles.length) return null;
      return { cases: cibles.map((e) => caseVisee(e, etat.joueur)), coups: cibles.map((e) => [e, 1]),
               chemin: cibles.map((e) => milieu(e)) };
    },
    // Machine : lance une bombe sur le plus proche, qui explose au tour
    // suivant (voir explosions) ; le Canon Dragon-XYZ, sur les trois plus
    // proches
    bombe(etat, c) {
      const cibles = proches(etat, portee(etat, c)).slice(0, a(c, "triple-canon") ? 3 : 1);
      if (!cibles.length) return null;
      const cases = cibles.map((e) => caseVisee(e, etat.joueur));
      return { cases, coups: [], bombes: cases };
    },
    // Tonnerre : trois éclairs au hasard à portée (six pour la foudre en chaîne)
    foudre(etat, c) {
      const cibles = melange(etat, proches(etat, portee(etat, c))).slice(0, a(c, "chaine") ? 6 : 3);
      if (!cibles.length) return null;
      return { cases: cibles.map((e) => caseVisee(e, etat.joueur)), coups: cibles.map((e) => [e, 1]), eclairs: true };
    },
    // Bête Ailée : fond sur le plus proche et l'emporte au bord de l'écran ;
    // les Sœurs de Harpie, sur les trois plus proches
    serres(etat, c) {
      const cibles = proches(etat, portee(etat, c)).slice(0, a(c, "trois-soeurs") ? 3 : 1);
      if (!cibles.length) return null;
      return { cases: cibles.map((e) => caseVisee(e, etat.joueur)), coups: cibles.map((e) => [e, R.SERRES]),
               chemin: cibles.map((e) => milieu(e)), emporte: cibles };
    },
    // Aqua : un tourbillon sous le plus proche, qui aspire ses voisins vers lui
    tourbillon(etat, c) {
      const e = proches(etat, portee(etat, c))[0];
      if (!e) return null;
      const autour = etat.ennemis.filter((v) => v !== e && ecartEntre(v, e) <= 2);
      return { cases: zone(caseVisee(e, etat.joueur), 2), centres: [milieu(e)],
               coups: [[e, 1]].concat(autour.map((v) => [v, R.TOURBILLON])), attire: e, attires: autour };
    },
    // Pyro : un cône de flammes vers le plus proche
    flammes(etat, c) {
      const e = proches(etat, portee(etat, c))[0];
      if (!e) return null;
      const d = axe(etat.joueur, e);
      const cases = cone(etat, d, portee(etat, c));
      const cibles = surCases(etat, cases);
      return cibles.length ? { cases, coups: cibles.map((v) => [v, 1]), direction: d } : null;
    },
    // Rocher : un séisme, faible, sur tous les monstres à l'écran (deux fois
    // plus fort pour Valkyrion)
    seisme(etat, c) {
      const cibles = aLEcran(etat);
      if (!cibles.length) return null;
      const part = R.SEISME * (a(c, "magnetique") ? 2 : 1);
      return { cases: cibles.map((e) => caseVisee(e, etat.joueur)), coups: cibles.map((e) => [e, part]) };
    },
    // Bête-Guerrier : charge le plus proche et le projette contre les autres
    corne(etat, c) {
      const e = proches(etat, portee(etat, c))[0];
      if (!e) return null;
      return { cases: [caseVisee(e, etat.joueur)], coups: [[e, R.CORNE]], chemin: [milieu(e)],
               projette: e, direction: axe(etat.joueur, e) };
    },
    // Poisson : mord le plus proche, et grandit de ce qu'il dévore (voir bonus)
    vorace(etat, c) {
      const e = proches(etat, portee(etat, c))[0];
      if (!e) return null;
      return { cases: [caseVisee(e, etat.joueur)], coups: [[e, 1]], chemin: [milieu(e)] };
    },
    // Serpent de Mer : une vague balaie la rangée (ligne ou colonne) de
    // l'écran où il y a le plus de monstres, la plus proche de toi à égalité
    raz(etat, c) {
      const vus = aLEcran(etat);
      if (!vus.length) return null;
      const j = etat.joueur, { rx, ry } = etat.vue;
      let mieux = null;
      const essaie = (h, k) => {
        const touches = vus.filter((e) => (h ? e.y : e.x) <= k && k < (h ? e.y : e.x) + taille(e));
        const loin = Math.abs(k - (h ? j.y : j.x));
        if (touches.length && (!mieux || touches.length > mieux.touches.length
            || (touches.length === mieux.touches.length && loin < mieux.loin))) mieux = { h, k, touches, loin };
      };
      for (let y = j.y - ry; y <= j.y + ry; y++) essaie(true, y);
      for (let x = j.x - rx; x <= j.x + rx; x++) essaie(false, x);
      const cases = [];
      if (mieux.h) for (let x = j.x - rx; x <= j.x + rx; x++) cases.push({ x, y: mieux.k });
      else for (let y = j.y - ry; y <= j.y + ry; y++) cases.push({ x: mieux.k, y });
      return { cases, coups: mieux.touches.map((e) => [e, R.RAZ]), rangee: mieux.h ? "h" : "v" };
    },
    // Insecte : pique le plus proche, qui reste paralysé
    piqure(etat, c) {
      const e = proches(etat, portee(etat, c))[0];
      if (!e) return null;
      return { cases: [caseVisee(e, etat.joueur)], coups: [[e, 1]], chemin: [milieu(e)], paralyse: R.PARALYSIE };
    },
    // Elfe : huit rayons de lumière partent de toi, droit et en diagonale
    // (les cases vont par rayon, de la plus proche à la plus loin). Sans les
    // diagonales, les monstres qui arrivent en biais lui échappaient : le
    // robot ne tenait que 193 tours avec Ishizu.
    rayons(etat, c) {
      const j = etat.joueur, p = portee(etat, c), cases = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        for (let k = 1; k <= p; k++) cases.push({ x: j.x + dx * k, y: j.y + dy * k });
      }
      const cibles = surCases(etat, cases);
      return cibles.length ? { cases, coups: cibles.map((e) => [e, R.RAYONS]) } : null;
    },
  };

  /* Le bonus d'attribut, coup par coup : la TERRE ajoute des cibles, les
     autres marquent celles qui sont touchées (voir tire). */
  function bonusCibles(etat, nom, coups) {
    if (nom !== "eclats") return;
    for (const [e] of coups.slice()) {
      for (const v of etat.ennemis) if (v !== e && ecartEntre(v, e) <= 1) ajouteCoup(coups, v, R.ECLATS);
    }
  }

  /* Les coups d'une attaque, l'un après l'autre, avec le bonus de
     l'attribut de la carte `id` qui attaque. `t` : l'attaque (sa
     direction, la paralysie de la piqûre). La poussée et la paralysie ne
     touchent que les cibles visées (`primaires`), pas les éclats. */
  function frappe(etat, ev, id, n, coups, primaires, t) {
    const c = carte(id);
    const bonusNom = bonusDe(c);
    const repousse = Math.max(bonusNom === "repousse" ? 1 : 0, a(c, "charge-celeste") ? 3 : 0);
    let total = 0, abattus = 0;
    for (const [e, part] of coups) {
      if (e.pv <= 0) continue;
      const avant = e.pv;
      const coup = n * part;
      blesseEnnemi(etat, ev, e, coup, id);
      total += avant - Math.max(0, e.pv);
      if (e.pv <= 0) { abattus++; continue; }
      if (bonusNom === "brule") {
        const b = Math.max(1, Math.round(coup * R.BRULE_PART));
        if (!e.brule || e.brule.degats <= b) e.brule = { tours: R.BRULE_TOURS, degats: b, source: id };
        else e.brule.tours = R.BRULE_TOURS;
      }
      if (bonusNom === "ralentit" || a(c, "souffle-du-temps")) e.ralenti = Math.max(e.ralenti, 1);
      if (bonusNom === "expose") e.expose = R.EXPOSE_TOURS;
      if (a(c, "roquette")) e.affaibli = R.ROQUETTE_TOURS;
      if (t.paralyse && primaires.indexOf(e) >= 0) e.ralenti = Math.max(e.ralenti, t.paralyse);
      if (repousse && primaires.indexOf(e) >= 0) pousse(etat, ev, e, t.direction || axe(etat.joueur, e), repousse);
    }
    if (bonusNom === "vampire" && total) soigne(etat, ev, Math.round(total * R.VOL_DE_VIE));
    return abattus;
  }

  /* Un monstre tire. `force` : un tir de plus, hors de son rythme (la
     Magie noire du Magicien Sombre) ; il ne touche pas à sa recharge. */
  function tire(etat, ev, m, zone, force) {
    const c = carte(m.id);
    const nom = motif(c);
    const t = ATTAQUES[nom](etat, c, m);
    if (!t) return false;
    if (!force) m.recharge = recharge(etat, c);
    const n = degats(etat, m.id, m);
    const bonusNom = bonusDe(c);
    const primaires = t.coups.map((x) => x[0]);
    bonusCibles(etat, bonusNom, t.coups);
    ev.push({ t: "tir", zone, id: m.id, motif: nom, bonus: bonusNom,
              couleur: (ATTRIBUTS[c.attribut] || ATTRIBUTS.DARK).couleur,
              cases: t.cases, centres: t.centres || null, chemin: t.chemin || null,
              embrase: !!t.embrase, anneau: t.anneau || 0, direction: t.direction || null,
              rangee: t.rangee || null });
    const abattus = frappe(etat, ev, m.id, n, t.coups, primaires, t);
    if (nom === "vorace") m.repas = (m.repas || 0) + abattus;
    if (t.projette) projette(etat, ev, t.projette, t.direction, n, m.id);
    if (t.attire) attire(etat, ev, t.attire, t.attires);
    for (const e of t.emporte || []) emporte(etat, ev, e);
    for (const b of t.bombes || []) etat.bombes.push({ uid: ++etat.uid, x: b.x, y: b.y, tour: etat.tour + 1, n, source: m.id });
    if (t.embrase) {
      const brule = Math.max(1, Math.round(n * R.FEU_PART));
      for (const p of t.cases) {
        const k = cle(p.x, p.y);
        const f = etat.feux.get(k);
        if (!f || f.degats <= brule) etat.feux.set(k, { x: p.x, y: p.y, fin: etat.tour + R.FEU_TOURS, degats: brule, source: m.id });
      }
    }
    return true;
  }

  /* Le coup de corne : la cible vole jusqu'à N cases en arrière, et le
     premier monstre qu'elle heurte prend le choc, elle aussi. Abattue, elle
     vole quand même : son corps heurte ce qui est derrière. Un boss ne
     décolle pas. */
  function projette(etat, ev, e, d, n, source) {
    if (e.boss != null) return;
    const t = taille(e), de = milieu(e);
    let x = e.x, y = e.y, heurte = null;
    for (let k = 0; k < R.PROJECTION && !heurte; k++) {
      for (let dx = 0; dx < t && !heurte; dx++) {
        for (let dy = 0; dy < t && !heurte; dy++) heurte = ennemiEn(etat, x + d[0] + dx, y + d[1] + dy, e);
      }
      if (!heurte) { x += d[0]; y += d[1]; }
    }
    ev.push({ t: "projection", id: e.id, uid: e.uid, de, vers: { x: x + (t - 1) / 2, y: y + (t - 1) / 2 },
              heurte: heurte ? milieu(heurte) : null });
    if (e.pv > 0) { e.x = x; e.y = y; marcheSurUnPiege(etat, ev, e); }
    if (heurte) {
      blesseEnnemi(etat, ev, heurte, n * R.CHOC, source);
      if (e.pv > 0) blesseEnnemi(etat, ev, e, n * R.CHOC, source);
    }
  }

  /* Le tourbillon : ses voisins font un pas vers le monstre qu'il a pris
     (un boss ne se laisse pas aspirer). */
  function attire(etat, ev, centre, liste) {
    const c = milieu(centre);
    for (const v of liste.slice().sort((p, q) => ecartEntre(p, centre) - ecartEntre(q, centre))) {
      if (v.pv <= 0 || v.boss != null) continue;
      const m = milieu(v);
      const dx = c.x - m.x, dy = c.y - m.y;
      const pas = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
      if ((pas[0] || pas[1]) && libre(etat, v.x + pas[0], v.y + pas[1], taille(v), v)) {
        v.x += pas[0]; v.y += pas[1];
        marcheSurUnPiege(etat, ev, v);
      }
    }
  }

  /* Les serres de la Bête Ailée : le monstre, s'il vit encore, est déposé
     au bord de l'écran, du côté où il était. Elle ne soulève pas un boss. */
  function emporte(etat, ev, e) {
    if (e.pv <= 0 || e.boss != null) return;
    const j = etat.joueur, m = milieu(e), t = taille(e), { rx, ry } = etat.vue;
    const dx = m.x - j.x, dy = m.y - j.y;
    if (!dx && !dy) return;
    // jusqu'au bord, dans la direction où il était
    const k = Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity);
    const vx = Math.round(j.x + dx * k - (t - 1) / 2), vy = Math.round(j.y + dy * k - (t - 1) / 2);
    let mieux = null;
    for (let r = 0; r <= 3 && !mieux; r++) {
      for (let ox = -r; ox <= r; ox++) {
        for (let oy = -r; oy <= r; oy++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r || !libre(etat, vx + ox, vy + oy, t, e)) continue;
          const loin = ecart({ x: vx + ox, y: vy + oy, t }, j);
          if (!mieux || loin > mieux.loin) mieux = { x: vx + ox, y: vy + oy, loin };
        }
      }
    }
    if (!mieux || mieux.loin <= ecart(e, j)) return;
    e.x = mieux.x; e.y = mieux.y;
    ev.push({ t: "emporte", uid: e.uid, id: e.id, de: m, vers: milieu(e) });
    marcheSurUnPiege(etat, ev, e);
  }

  /* Les bombes des Machines, au tour d'après : tout ce qui est dans la zone
     de 5 × 5 prend le coup, avec le bonus de l'attribut de la Machine. */
  function explosions(etat, ev) {
    etat.bombes = etat.bombes.filter((b) => {
      if (b.tour > etat.tour) return true;
      const coups = surCases(etat, zone(b, R.BOMBE_RAYON)).map((e) => [e, R.BOMBE]);
      ev.push({ t: "boum", x: b.x, y: b.y, r: R.BOMBE_RAYON, uid: b.uid, couleur: (ATTRIBUTS[carte(b.source).attribut] || ATTRIBUTS.DARK).couleur });
      if (coups.length) {
        const primaires = coups.map((x) => x[0]);
        bonusCibles(etat, bonusDe(carte(b.source)), coups);
        frappe(etat, ev, b.source, b.n, coups, primaires, {});
      }
      return false;
    });
  }

  function phaseMonstres(etat, ev) {
    explosions(etat, ev);
    etat.monstres.forEach((m, zone) => {
      if (!m || etat.fini) return;
      const c = carte(m.id);
      if (m.recharge > 0) m.recharge--;
      if (m.recharge > 0) return;
      if (a(c, "temps")) pileOuFace(etat, ev, m, zone);
      else if (attaque(c, m, etat) && !seulEtFier(etat, c)) tire(etat, ev, m, zone, false);
    });
  }

  /* La Fierté du Guerrier Panthère : seul sur le terrain, il n'attaque pas
     (un jeton lui suffit). */
  function seulEtFier(etat, c) {
    return a(c, "fierte") && etat.monstres.filter(Boolean).length < 2;
  }

  function pousse(etat, ev, e, d, n) {
    for (let k = 0; k < n && e.pv > 0; k++) {
      if (!libre(etat, e.x + d[0], e.y + d[1], taille(e), e)) return;
      e.x += d[0]; e.y += d[1];
      marcheSurUnPiege(etat, ev, e);
    }
  }

  /* Le Magicien du Temps : pile, les monstres proches disparaissent ; face,
     c'est toi qui paies. */
  function pileOuFace(etat, ev, m, zone) {
    const r = 3 + (etoiles(etat, m.id) - 1);
    if (!proches(etat, r).length) return;
    m.recharge = recharge(etat, carte(m.id));
    const pile = etat.hasard() < 0.5;
    ev.push({ t: "piece", zone, pile });
    if (pile) proches(etat, r).forEach((e) => detruit(etat, ev, e, 0.1));
    else blesseJoueur(etat, ev, 500);
  }

  /* =========================================================
     Les monstres ennemis
     ========================================================= */
  /* Une trappe couvre `r` cases autour de sa case : 1 pour la Trappe, 2
     pour la Trappe sans Fond. */
  function marcheSurUnPiege(etat, ev, e) {
    const p = etat.pieges.find((q) => ecart(e, q) <= q.r);
    if (!p) return;
    ev.push({ t: "piege", id: p.id, x: p.x, y: p.y });
    if (e.boss != null) {
      // un boss n'y tombe qu'une fois : il en ressort, la trappe se referme
      etat.pieges = etat.pieges.filter((q) => q !== p);
      etat.cimetiere.push(p.id);
    }
    parPiege(etat, ev, e, R.BOSS_PIEGE);
  }

  function avance(etat, ev, e) {
    const j = etat.joueur;
    const m = milieu(e);
    const dx = j.x - m.x, dy = j.y - m.y;
    const sx = Math.sign(dx), sy = Math.sign(dy);
    const essais = [];
    const horizontal = Math.abs(dx) > Math.abs(dy) || (Math.abs(dx) === Math.abs(dy) && e.uid % 2 === 0);
    if (horizontal) { if (sx) essais.push([sx, 0]); if (sy) essais.push([0, sy]); }
    else { if (sy) essais.push([0, sy]); if (sx) essais.push([sx, 0]); }
    // bloqué : un pas de côté de temps en temps, pour que la foule
    // contourne au lieu de faire la queue
    if (etat.hasard() < 0.35) {
      if (!sx) essais.push(etat.hasard() < 0.5 ? [1, 0] : [-1, 0]);
      if (!sy) essais.push(etat.hasard() < 0.5 ? [0, 1] : [0, -1]);
    }
    for (const [mx, my] of essais) {
      if (!libre(etat, e.x + mx, e.y + my, taille(e), e)) continue;
      e.x += mx; e.y += my;
      marcheSurUnPiege(etat, ev, e);
      return;
    }
  }

  /* Les cases d'une frappe annoncée. Chaque forme laisse une case libre à
     un pas de toi, ou le temps d'y aller : on peut toujours l'éviter. */
  function annonce(etat, ev, e) {
    const b = BOSS[e.boss];
    const j = etat.joueur;
    const loin = Math.max(etat.vue.rx, etat.vue.ry) + 2;
    const cases = new Set();
    if (b.frappe === "ligne") {
      const horizontale = etat.hasard() < 0.5;
      for (let k = -loin; k <= loin; k++) cases.add(horizontale ? cle(j.x + k, j.y) : cle(j.x, j.y + k));
    } else if (b.frappe === "croix") {
      for (let k = -loin; k <= loin; k++) { cases.add(cle(j.x + k, j.y)); cases.add(cle(j.x, j.y + k)); }
    } else {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cases.add(cle(j.x + dx, j.y + dy));
    }
    etat.annonces.push({ cases, tour: etat.tour + b.delai, degats: b.degats, nom: b.nom, uid: e.uid });
    ev.push({ t: "annonce", nom: b.nom, cases: Array.from(cases), delai: b.delai });
    if (b.renforts) {
      for (let k = 0; k < b.renforts; k++) apparait(etat, ev, tireEnnemi(etat, -1), caseAuBord(etat, 0, 1));
    }
  }

  /* Le sol qui brûle et les monstres en feu : chacun prend sa brûlure une
     fois par tour. */
  function brule(etat, ev) {
    const brules = new Map();
    etat.feux.forEach((f) => {
      const e = ennemiEn(etat, f.x, f.y);
      if (e && (!brules.has(e) || brules.get(e).degats < f.degats)) brules.set(e, f);
    });
    brules.forEach((f, e) => blesseEnnemi(etat, ev, e, f.degats, f.source));
    for (const e of etat.ennemis.slice()) {
      if (!e.brule || e.pv <= 0) continue;
      blesseEnnemi(etat, ev, e, e.brule.degats, e.brule.source);
      if (e.pv > 0 && --e.brule.tours <= 0) e.brule = null;
    }
  }

  function phaseHorde(etat, ev) {
    const j = etat.joueur;
    // les frappes annoncées tombent, sur toi et non sur tes monstres
    etat.annonces = etat.annonces.filter((x) => {
      if (x.tour > etat.tour) return true;
      ev.push({ t: "explosion", cases: Array.from(x.cases), nom: x.nom });
      if (x.cases.has(cle(j.x, j.y))) {
        const k = etat.zones.findIndex((z) => z && carte(z.id).effet === "jugement");
        if (k >= 0) {
          const id = etat.zones[k].id;
          etat.zones[k] = null;
          etat.cimetiere.push(id);
          ev.push({ t: "garde", id, texte: "Jugement Solennel !" });
        } else blesseJoueur(etat, ev, x.degats);
      }
      return false;
    });
    if (etat.fini) return;
    if (etat.epees > 0) { brule(etat, ev); return; }   // les Épées figent tout le monde

    // qui agit ce tour-ci
    const agissent = [];
    for (const e of etat.ennemis) {
      e.elan += e.vitesse;
      if (e.elan < 1) continue;
      e.elan -= 1;
      if (e.ralenti > 0) { e.ralenti--; continue; }
      agissent.push(e);
    }
    agissent.sort((p, q) => ecart(p, j) - ecart(q, j));

    for (const e of agissent) {
      if (e.pv <= 0 || etat.fini) continue;
      if (colle(e, j)) {
        const p = caseVisee(e, j);
        ev.push({ t: "frappe", uid: e.uid, x: p.x, y: p.y });
        encaisse(etat, ev, frappeDe(e), e);
      } else avance(etat, ev, e);
    }
    brule(etat, ev);

    // les boss préparent leur coup
    for (const e of etat.ennemis) {
      if (e.boss != null && e.pv > 0 && etat.tour >= e.prochaine) {
        annonce(etat, ev, e);
        e.prochaine = etat.tour + BOSS[e.boss].cadence;
      }
    }
  }

  /* =========================================================
     Les cartes : piocher, jouer, envoyer au cimetière
     ========================================================= */
  /* Piocher : le deck vide, il n'y a plus rien à prendre. Le cimetière
     n'y retourne pas. */
  function pioche(etat, ev, n, filtre) {
    for (let k = 0; k < n; k++) {
      if (etat.main.length >= R.MAIN_PLAFOND) return;
      const i = filtre ? etat.deck.findIndex(filtre) : 0;
      if (i < 0 || !etat.deck.length) return;
      const [id] = etat.deck.splice(i, 1);
      etat.main.push(id);
      ev.push({ t: "pioche", id });
    }
  }

  /* Une carte ajoutée au deck, à une place au hasard. */
  function ajouteAuDeck(etat, ev, id) {
    etat.deck.splice(Math.floor(etat.hasard() * (etat.deck.length + 1)), 0, id);
    ev.push({ t: "dans-deck", id });
  }

  /* Les magies du cimetière, la plus récente d'abord, chacune une fois :
     ce que le Magicien de la Foi peut reprendre. */
  function magiesDuCimetiere(etat) {
    const vus = [];
    for (let k = etat.cimetiere.length - 1; k >= 0; k--) {
      const x = etat.cimetiere[k];
      if (carte(x).genre === "magie" && vus.indexOf(x) < 0) vus.push(x);
    }
    return vus;
  }

  /* Un monstre quitte le terrain : un jeton s'évanouit, une carte part au
     cimetière et son Dernier souffle se déclenche. */
  function retireMonstre(etat, ev, zone, raison) {
    const m = etat.monstres[zone];
    if (!m) return;
    etat.monstres[zone] = null;
    ev.push({ t: "quitte", zone, id: m.id, raison, jeton: m.jeton });
    if (m.jeton) return;
    etat.cimetiere.push(m.id);
    const c = carte(m.id);
    // Sangan et la Sorcière font choisir une carte : le choix s'ouvre en fin
    // de tour, comme un booster (voir suite)
    if (a(c, "sangan")) etat.boosters.push("sangan");
    if (a(c, "sorciere")) etat.boosters.push("sorciere");
    // Agido lance un dé : sur 4 ou plus, une Elfe du cimetière revient, au
    // choix, elle aussi en fin de tour (sa zone peut servir d'ici là)
    if (a(c, "agido")) {
      const n = 1 + Math.floor(etat.hasard() * 6);
      ev.push({ t: "de", n, id: m.id });
      if (n >= R.AGIDO) etat.boosters.push("agido");
    }
    if (a(c, "zolga") && raison === "sacrifice") soigne(etat, ev, R.ZOLGA);
    if (a(c, "keldo")) {
      // les dernières cartes arrivées avant lui, sauf les fusions : du
      // haut de la pile vers le bas, pour que les places restent justes
      let n = 0;
      for (let k = etat.cimetiere.length - 2; k >= 0 && n < R.KELDO; k--) {
        if (estFusion(carte(etat.cimetiere[k]))) continue;
        ajouteAuDeck(etat, ev, etat.cimetiere.splice(k, 1)[0]);
        n++;
      }
      etat.stats.ramenees += n;
    }
    if (a(c, "chimere") && raison !== "fusion") {
      // la Chimère se défait : ses deux moitiés reviennent en main, prises
      // au cimetière, sinon dans le deck
      for (const moitie of c.ramene || []) {
        if (etat.main.length >= R.MAIN_PLAFOND) break;
        let k = etat.cimetiere.indexOf(moitie);
        if (k >= 0) { etat.cimetiere.splice(k, 1); etat.stats.ramenees++; }
        else if ((k = etat.deck.indexOf(moitie)) >= 0) etat.deck.splice(k, 1);
        else continue;
        etat.main.push(moitie);
        ev.push({ t: "recoit", id: moitie });
      }
    }
  }

  function zoneLibre(liste) { return liste.findIndex((z) => !z); }

  /* Le monstre ennemi le plus fort à l'écran, hors boss : celui que
     Changement de Cœur prend, celui que Copiechat copie. */
  function plusFort(etat) {
    return aLEcran(etat).filter((e) => e.boss == null)
      .sort((p, q) => carte(q.id).atk - carte(p.id).atk || q.pv - p.pv || p.uid - q.uid)[0] || null;
  }

  /* Les matières d'une fusion, prises dans ta main puis sur ton terrain :
     les matières nommées d'abord, puis les « n'importe quel Dragon », en
     commençant par la main et par les plus faibles. Rend la liste des
     cartes prises ({ id, ou, i }), ou null. `sauf` : l'index de la
     Polymérisation dans la main. */
  function planFusion(etat, f, sauf) {
    const dispo = [];
    etat.main.forEach((id, i) => { if (i !== sauf && carte(id).genre === "monstre") dispo.push({ id, ou: "main", i }); });
    etat.monstres.forEach((m, z) => { if (m && !m.jeton) dispo.push({ id: m.id, ou: "terrain", i: z }); });
    const ordre = (p, q) => (p.ou === "main" ? 0 : 1) - (q.ou === "main" ? 0 : 1) || carte(p.id).atk - carte(q.id).atk;
    const pris = [];
    const nommees = f.matieres.filter((x) => x.id), libres = f.matieres.filter((x) => x.type);
    for (const mat of nommees.concat(libres)) {
      const k = dispo.filter((d) => pris.indexOf(d) < 0
        && (mat.id ? d.id === mat.id : carte(d.id).type === mat.type)).sort(ordre)[0];
      if (!k) return null;
      pris.push(k);
    }
    return pris;
  }

  /* Ce que Polymérisation ou Monster Reborn proposent : les fusions que ta
     main et ton terrain permettent, ou les monstres de ton cimetière. */
  function options(etat, index) {
    const id = etat.main[index];
    if (id == null) return [];
    const c = carte(id);
    if (c.effet === "fusion") {
      return STOCK.fusions.filter((f) => etat.extra.indexOf(f.carte) >= 0)
        .map((f) => ({ id: f.carte, matieres: planFusion(etat, f, index) }))
        .filter((o) => o.matieres)
        .sort((p, q) => carte(q.id).atk - carte(p.id).atk);
    }
    if (c.effet === "typhon") {
      // tes zones magie/piège, et le terrain en place 5
      const cartes = etat.zones.map((z, i) => z && { id: z.id, place: i }).filter(Boolean);
      if (etat.terrain) cartes.push({ id: etat.terrain, place: R.ZONES });
      return cartes;
    }
    if (c.effet === "liberation") {
      // les cartes du cimetière, par leur place (il peut en avoir deux
      // pareilles), sauf les fusions : piochées, elles ne serviraient à rien
      return etat.cimetiere.map((x, i) => ({ id: x, place: i })).filter((o) => !estFusion(carte(o.id)));
    }
    if (c.effet === "foi") return magiesDuCimetiere(etat).map((x) => ({ id: x }));
    if (c.effet === "reborn" || c.effet === "enterrement") {
      // Enterrement Prématuré reprend en main : une fusion n'y a rien à faire
      const vus = [];
      etat.cimetiere.forEach((x) => {
        if (carte(x).genre === "monstre" && vus.indexOf(x) < 0 && !(c.effet === "enterrement" && estFusion(carte(x)))) vus.push(x);
      });
      return vus.sort((p, q) => carte(q).atk - carte(p).atk).map((x) => ({ id: x }));
    }
    return [];
  }

  /* Ce qu'il faut pour jouer la carte `index` de la main :
     { ok, raison, options, choix, ou, sacrifice }.
       options    la carte attend un choix d'abord (voir options()) ;
       choix      ce qu'il faut désigner sur le terrain : des points de
                  sacrifice, ou une carte à remplacer ;
       ou         « monstres » ou « zones ». */
  /* `paie` : le joueur choisit la Bourse des Âmes (des LP) plutôt que des
     sacrifices. */
  function jouable(etat, index, option, paie) {
    const id = etat.main[index];
    if (id == null) return { ok: false, raison: "Cette carte n'est plus dans ta main." };
    const c = carte(id);
    const p = place(c);
    const libres = etat.monstres.filter((m) => !m).length;
    const remplace = libres ? { ok: true, choix: 0 } : { ok: true, choix: 1, ou: "monstres" };
    if (p === "monstre") {
      if (estFusion(c)) return { ok: false, raison: "Une fusion ne s'invoque que par Polymérisation." };
      if (a(c, "copie") && !plusFort(etat)) return { ok: false, raison: "Aucun monstre ennemi à copier à l'écran." };
      // le Magicien de la Foi : quelle magie reprendre, s'il y a le choix
      if (a(c, "foi") && magiesDuCimetiere(etat).length > 1) {
        if (option == null) return { ok: true, options: true };
        if (!magiesDuCimetiere(etat)[option]) return { ok: false, raison: "Ce choix n'existe plus." };
      }
      const s = sacrifices(c);
      if (!s) return remplace;
      // la Bourse des Âmes posée : des LP au lieu des sacrifices, au choix,
      // et d'office quand il n'y a pas assez de monstres à sacrifier
      const bourse = etat.zones.some((z) => z && carte(z.id).effet === "echange") && etat.joueur.lp > R.ECHANGE;
      if (paie) return bourse ? Object.assign({ paie: true }, remplace) : { ok: false, raison: "La Bourse des Âmes ne peut pas payer." };
      const points = etat.monstres.reduce((t, m, z) => t + valeurSacrifice(etat, z), 0);
      if (points < s) {
        if (bourse) return Object.assign({ paie: true }, remplace);
        return { ok: false, raison: `Il faut ${s} monstre${s > 1 ? "s" : ""} sur le terrain à sacrifier.` };
      }
      return { ok: true, choix: s, ou: "monstres", sacrifice: true, bourse };
    }
    if (p === "zone") {
      return zoneLibre(etat.zones) >= 0 ? { ok: true, choix: 0 } : { ok: true, choix: 1, ou: "zones" };
    }
    if (p === "sol") {
      const j0 = etat.joueur;
      if (etat.pieges.some((q) => Math.max(Math.abs(q.x - j0.x), Math.abs(q.y - j0.y)) <= R.TRAPPE_RAYON)) {
        return { ok: false, raison: "Une trappe est déjà ouverte ici." };
      }
      return { ok: true, choix: 0 };
    }
    if (c.effet === "enterrement" && etat.joueur.lp <= R.ENTERREMENT) {
      return { ok: false, raison: `Il faut plus de ${R.ENTERREMENT} LP.` };
    }
    if (c.effet === "liberation" || c.effet === "typhon") {
      const permises = options(etat, index).map((o) => o.place);
      const max = c.effet === "typhon" ? permises.length : R.LIBERATION;
      if (!permises.length) {
        return { ok: false, raison: c.effet === "typhon" ? "Aucune magie ni piège sur ton terrain." : "Rien à reprendre dans ton cimetière." };
      }
      if (option == null) return { ok: true, options: true, plusieurs: max };
      const places = [].concat(option);
      if (!places.length || places.length > max || new Set(places).size !== places.length
          || places.some((i) => permises.indexOf(i) < 0)) {
        return { ok: false, raison: "Choisis d'abord les cartes." };
      }
      return { ok: true, choix: 0 };
    }
    if (c.effet === "pot" && !etat.deck.length) return { ok: false, raison: "Ton deck est vide." };
    if (c.effet === "destruction" && etat.main.length < 2) return { ok: false, raison: "Rien d'autre dans ta main." };
    if (c.effet === "fissure" && !aLEcran(etat).length) return { ok: false, raison: "Aucun monstre ennemi à l'écran." };
    if (c.effet === "moutons" && !libres) return { ok: false, raison: "Aucune zone monstre libre." };
    if (c.effet === "coeur") return plusFort(etat) ? remplace : { ok: false, raison: "Aucun monstre ennemi à prendre à l'écran." };
    if (c.effet === "egotiste") return compte(etat, estHarpie) ? remplace : { ok: false, raison: "Il faut une Harpie sur ton terrain." };
    if (c.effet === "plumeau" && !aLEcran(etat).some((e) => e.boss == null)) {
      return { ok: false, raison: "Aucun monstre ennemi à repousser à l'écran." };
    }
    if (c.effet === "virus" && !aLEcran(etat).some((e) => carte(e.id).atk >= R.VIRUS)) {
      return { ok: false, raison: `Aucun monstre ennemi de ${R.VIRUS} ATK ou plus à l'écran.` };
    }
    if (c.effet === "permutation") {
      if (etat.permutee) return { ok: false, raison: "Une seule Permutation des Mondes par duel." };
      if (etat.cimetiere.filter((x) => !estFusion(carte(x))).length < R.PERMUTATION) {
        return { ok: false, raison: `Il faut ${R.PERMUTATION} cartes dans ton cimetière.` };
      }
      if (etat.joueur.lp <= R.PERMUTATION_LP) return { ok: false, raison: `Il faut plus de ${R.PERMUTATION_LP} LP.` };
    }
    if (c.effet === "fusion" || c.effet === "reborn" || c.effet === "enterrement") {
      const opts = options(etat, index);
      if (!opts.length) {
        return { ok: false, raison: c.effet === "fusion" ? "Aucune fusion de ton Extra Deck n'est possible."
                                                         : "Aucun monstre dans ton cimetière." };
      }
      if (option == null) return { ok: true, options: true };
      const o = opts[option];
      if (!o) return { ok: false, raison: "Ce choix n'existe plus." };
      if (c.effet === "fusion" && o.matieres.some((x) => x.ou === "terrain")) return { ok: true, choix: 0 };
      if (c.effet === "enterrement") return { ok: true, choix: 0 };
      return remplace;
    }
    return { ok: true, choix: 0 };
  }

  /* Un effet qui se joue depuis la main, à la place de la carte : le
     Dragon du Tonnerre se défausse pour en appeler deux. */
  function jouableEffet(etat, index) {
    const id = etat.main[index];
    if (id == null || !a(carte(id), "tonnerre")) return { ok: false, raison: "Pas d'effet depuis la main." };
    return { ok: true };
  }

  /* `magie` : celle que le Magicien de la Foi a choisi de reprendre. */
  function invoque(etat, ev, id, zone, jeton, magie) {
    etat.monstres[zone] = nouveauMonstre(etat, id, jeton);
    ev.push({ t: "invoque", zone, id, jeton: !!jeton });
    if (jeton) return;
    const c = carte(id);
    if (a(c, "mange")) {
      const cible = aLEcran(etat).sort((p, q) => q.pv - p.pv)[0];
      if (cible) detruit(etat, ev, cible, R.BOSS_PIEGE);
    }
    if (a(c, "brise-sort")) etat.monstres[zone].compteurs = 2;
    if (a(c, "copie")) {
      const e = plusFort(etat);
      if (e) {
        const v = carte(e.id);
        etat.monstres[zone].copie = { atk: v.atk, df: v.df, id: e.id };
        ev.push({ t: "copie", zone, id: e.id });
      }
    }
    if (a(c, "recherche") && c.cherche) {
      ajouteAuDeck(etat, ev, c.cherche);
      pioche(etat, ev, 1, (x) => x === c.cherche);
    }
    if (a(c, "foi")) {
      // la magie choisie, ou la plus récente (ramené par Monster Reborn, il n'a pas choisi)
      const voulue = magie != null ? magie : magiesDuCimetiere(etat)[0];
      for (let k = etat.cimetiere.length - 1; k >= 0; k--) {
        if (etat.cimetiere[k] === voulue && etat.main.length < R.MAIN_PLAFOND) {
          const [s] = etat.cimetiere.splice(k, 1);
          etat.main.push(s);
          etat.stats.ramenees++;
          ev.push({ t: "recoit", id: s });
          break;
        }
      }
    }
  }

  /* Après chaque magie jouée : les compteurs du Livre d'Arts Secrets, et
     la Magie noire qui fait tirer le Magicien Sombre. */
  function apresMagie(etat, ev) {
    const livre = passif(etat, "arts-secrets");
    etat.monstres.forEach((m, zone) => {
      if (!m) return;
      const c = carte(m.id);
      if (livre && c.type === "Magicien" && m.compteurs < R.COMPTEURS_MAX) {
        m.compteurs = Math.min(R.COMPTEURS_MAX, m.compteurs + livre);
        ev.push({ t: "compteur", zone, n: m.compteurs });
      }
      // la Bibliothèque : un compteur par magie, et une pioche au troisième
      if (a(c, "bibliotheque")) {
        m.compteurs++;
        if (m.compteurs >= R.BIBLIOTHEQUE) { m.compteurs = 0; pioche(etat, ev, 1); }
        ev.push({ t: "compteur", zone, n: m.compteurs });
      }
      if (a(c, "magie-noire") && !etat.fini) tire(etat, ev, m, zone, true);
    });
  }

  /* Joue la carte. `cibles` : les zones désignées, quand jouable() en
     demande ; `option` : le choix fait dans options(). */
  function joue(etat, ev, index, cibles, option, paie) {
    const j = jouable(etat, index, option, paie);
    if (!j.ok) return j.raison;
    if (j.options) return "Choisis d'abord ce que tu veux faire.";
    const choisies = Array.from(new Set(cibles || []));
    const liste = j.ou === "zones" ? etat.zones : etat.monstres;
    if (choisies.some((z) => !liste[z])) return "Cette zone est vide.";
    const id = etat.main[index];
    if (j.sacrifice) {
      const valeurs = choisies.map((z) => valeurSacrifice(etat, z));
      const total = valeurs.reduce((t, v) => t + v, 0);
      if (!valeurs.length || total < j.choix || total - Math.min(...valeurs) >= j.choix) {
        return "Choisis les monstres à sacrifier.";
      }
    } else if (choisies.length !== j.choix) {
      return "Choisis d'abord sur le terrain.";
    }

    const c = carte(id);
    const choix = option == null || Array.isArray(option) ? null : options(etat, index)[option];
    // la carte, et les matières d'une fusion prises dans la main, quittent
    // la main ensemble : du plus grand index au plus petit
    const sortent = [index].concat(choix && choix.matieres
      ? choix.matieres.filter((x) => x.ou === "main").map((x) => x.i) : []);
    sortent.sort((p, q) => q - p).forEach((i) => {
      const [x] = etat.main.splice(i, 1);
      if (i !== index) etat.cimetiere.push(x);
    });
    etat.stats.cartes++;
    if (c.genre === "magie") etat.stats.magies++;
    ev.push({ t: "joue", id });
    const p = place(c);

    if (j.ou === "monstres") choisies.forEach((z) => retireMonstre(etat, ev, z, j.sacrifice ? "sacrifice" : "remplace"));
    if (j.ou === "zones") {
      choisies.forEach((z) => { etat.cimetiere.push(etat.zones[z].id); etat.zones[z] = null; });
    }

    if (p === "monstre") {
      if (j.paie) {
        // la Bourse des Âmes paie l'invocation en LP, et reste posée
        blesseJoueur(etat, ev, R.ECHANGE);
        const z = etat.zones.find((x) => x && carte(x.id).effet === "echange");
        ev.push({ t: "garde", id: z.id, texte: "Bourse des Âmes !" });
      }
      invoque(etat, ev, id, zoneLibre(etat.monstres), false, choix ? choix.id : null);
      return null;
    }
    if (p === "zone") {
      const z = zoneLibre(etat.zones);
      // le Dé gracieux : un dé, autant de relances de booster
      const charges = c.effet === "cylindre" ? R.CYLINDRE : c.effet === "de-grace" ? 1 + Math.floor(etat.hasard() * 6) : 0;
      etat.zones[z] = { id, charges };
      etat.stats.zones = Math.max(etat.stats.zones, etat.zones.filter(Boolean).length);
      ev.push({ t: "pose", zone: z, id });
      if (c.effet === "de-grace") ev.push({ t: "de", n: charges, id });
    } else if (p === "sol") {
      etat.pieges.push({ x: etat.joueur.x, y: etat.joueur.y, id, fin: etat.tour + R.TRAPPE_TOURS,
                         r: c.rayon || R.TRAPPE_RAYON });
      ev.push({ t: "pose-sol", id, x: etat.joueur.x, y: etat.joueur.y });
    } else if (p === "terrain") {
      if (etat.terrain) etat.cimetiere.push(etat.terrain);
      etat.terrain = id;
      ev.push({ t: "terrain", id });
    } else {
      // une magie qui fait son effet, puis part au cimetière
      switch (c.effet) {
        case "raigeki":
          ev.push({ t: "eclairs" });
          aLEcran(etat).forEach((e) => detruit(etat, ev, e, R.BOSS_PART));
          break;
        case "epees":
          // le tour où on les joue ne compte pas : les monstres restent figés 3 tours de plus
          etat.epees = R.EPEES + 1;
          ev.push({ t: "epees" });
          break;
        case "pot":
          pioche(etat, ev, 2);
          break;
        case "dian-keto":
          soigne(etat, ev, R.DIAN_KETO);
          break;
        case "moutons":
          etat.monstres.forEach((m, z) => { if (!m) invoque(etat, ev, STOCK.jetons.mouton, z, true); });
          break;
        case "fissure": {
          const e = aLEcran(etat).sort((p, q) => q.pv - p.pv)[0];
          if (e) detruit(etat, ev, e, R.BOSS_PIEGE);
          break;
        }
        case "de-crane": {
          const n = 1 + Math.floor(etat.hasard() * 6);
          etat.crane = { fin: etat.tour + R.CRANE_TOURS, part: n * R.CRANE };
          ev.push({ t: "de", n, id });
          break;
        }
        case "destruction": {
          // toute la main repart dans le deck, mélangée, et on en repioche autant
          const n = etat.main.length;
          etat.deck = melange(etat, etat.deck.concat(etat.main));
          etat.main = [];
          ev.push({ t: "main-au-deck", n });
          pioche(etat, ev, n);
          break;
        }
        case "enterrement":
          // il reprend en main ce que Monster Reborn invoquerait
          blesseJoueur(etat, ev, R.ENTERREMENT);
          etat.cimetiere.splice(etat.cimetiere.indexOf(choix.id), 1);
          etat.main.push(choix.id);
          etat.stats.ramenees++;
          ev.push({ t: "recoit", id: choix.id });
          break;
        case "reborn":
          etat.cimetiere.splice(etat.cimetiere.indexOf(choix.id), 1);
          etat.stats.ramenees++;
          invoque(etat, ev, choix.id, zoneLibre(etat.monstres));
          break;
        case "coeur": {
          const e = plusFort(etat);
          const z = zoneLibre(etat.monstres);
          etat.ennemis = etat.ennemis.filter((x) => x !== e);
          ev.push({ t: "coeur", uid: e.uid, id: e.id, de: milieu(e), zone: z });
          invoque(etat, ev, e.id, z, true);
          etat.monstres[z].fin = etat.tour + R.COEUR_TOURS;
          if (etat.boss === e) etat.boss = null;
          break;
        }
        case "typhon":
          // les cartes choisies partent au cimetière : leurs zones se libèrent
          [].concat(option).forEach((i) => {
            if (i === R.ZONES) { etat.cimetiere.push(etat.terrain); etat.terrain = null; ev.push({ t: "detruite", id: etat.cimetiere[etat.cimetiere.length - 1] }); }
            else { etat.cimetiere.push(etat.zones[i].id); ev.push({ t: "detruite", id: etat.zones[i].id }); etat.zones[i] = null; }
          });
          break;
        case "liberation": {
          // du plus loin au plus près, pour que les places restent justes
          const places = [].concat(option).sort((p, q) => q - p);
          places.map((i) => etat.cimetiere.splice(i, 1)[0]).forEach((x) => ajouteAuDeck(etat, ev, x));
          etat.stats.ramenees += places.length;
          break;
        }
        case "fusion": {
          const zones = choix.matieres.filter((x) => x.ou === "terrain").map((x) => x.i);
          zones.forEach((z) => retireMonstre(etat, ev, z, "fusion"));
          invoque(etat, ev, choix.id, zones.length ? Math.min(...zones) : zoneLibre(etat.monstres));
          etat.stats.fusions++;
          ev.push({ t: "fusion", id: choix.id });
          break;
        }
        case "recherche":
          // le Sage Fusion : sa carte rejoint le deck, et on la pioche
          ajouteAuDeck(etat, ev, c.cherche);
          pioche(etat, ev, 1, (x) => x === c.cherche);
          break;
        case "egotiste":
          invoque(etat, ev, c.cherche, zoneLibre(etat.monstres));
          break;
        case "bouclier-epee":
          etat.bouclier = etat.tour + R.BOUCLIER_TOURS;
          break;
        case "plumeau": {
          // les plus loin d'abord : ils libèrent la place aux suivants
          const j0 = etat.joueur;
          aLEcran(etat).filter((e) => e.boss == null).sort((p, q) => ecart(q, j0) - ecart(p, j0))
            .forEach((e) => pousse(etat, ev, e, axe(j0, e), R.PLUMEAU));
          ev.push({ t: "plumeau" });
          break;
        }
        case "virus":
          aLEcran(etat).filter((e) => carte(e.id).atk >= R.VIRUS).forEach((e) => parPiege(etat, ev, e, R.BOSS_PIEGE));
          break;
        case "permutation": {
          // le cimetière part dans le deck, mélangé, et le deck au
          // cimetière ; les fusions y restent : piochées, elles ne
          // serviraient à rien
          blesseJoueur(etat, ev, R.PERMUTATION_LP);
          const reviennent = etat.cimetiere.filter((x) => !estFusion(carte(x)));
          etat.cimetiere = etat.cimetiere.filter((x) => estFusion(carte(x))).concat(etat.deck);
          etat.deck = melange(etat, reviennent);
          etat.permutee = true;
          etat.stats.ramenees += reviennent.length;
          ev.push({ t: "message", texte: "Ton cimetière et ton deck s'échangent !", genre: "info" });
          break;
        }
      }
      etat.cimetiere.push(id);
    }
    if (c.genre === "magie") apresMagie(etat, ev);
    return null;
  }

  function effetDeMain(etat, ev, index) {
    const j = jouableEffet(etat, index);
    if (!j.ok) return j.raison;
    const [id] = etat.main.splice(index, 1);
    etat.cimetiere.push(id);
    etat.stats.cartes++;
    ev.push({ t: "defausse", id });
    // deux Dragons du Tonnerre ajoutés au deck, puis piochés
    ajouteAuDeck(etat, ev, id);
    ajouteAuDeck(etat, ev, id);
    pioche(etat, ev, 2, (x) => x === id);
    return null;
  }

  /* =========================================================
     Les boosters
     Trois cartes tirées dans tes boosters (les 40 que tu as choisies),
     selon leur rareté. Une carte que tu as déjà en jeu revient en étoile ;
     celle que tu gardes va dans ton deck.
     ========================================================= */
  // le nombre d'exemplaires qu'on peut avoir à la fois ; une carte posée
  // qui en a un ici se reprend en exemplaire, pas en étoile
  const EXEMPLAIRES = { raigeki: 1, pot: 1, reborn: 1, fusion: 2, moutons: 2, fissure: 2, destruction: 1,
                        "de-grace": 1, echange: 1, virus: 1, permutation: 1, egotiste: 1, plumeau: 2,
                        recherche: 2, "bouclier-epee": 2 };
  const EXEMPLAIRES_SINON = 3;

  /* Ce qu'on a de cette carte : la main, le deck, le terrain. Le cimetière
     ne compte pas, ni ce que Libération d'Âme a retiré : un booster peut la
     redonner. */
  function possedee(etat, id) {
    let n = 0;
    const compte = (x) => { if (x === id) n++; };
    etat.main.forEach(compte); etat.deck.forEach(compte);
    etat.monstres.forEach((m) => m && !m.jeton && compte(m.id));
    etat.zones.forEach((z) => z && compte(z.id));
    etat.pieges.forEach((p) => compte(p.id));
    if (etat.terrain) compte(etat.terrain);
    return n;
  }

  /* Ce qu'un booster peut proposer de cette carte : null (rien), « carte »
     (un exemplaire de plus) ou « etoile » (une étoile de plus). Les
     monstres, les passifs et les terrains ne se doublent pas : les
     reprendre leur donne une étoile. */
  function proposition(etat, id) {
    const c = carte(id);
    const n = possedee(etat, id);
    const p = place(c);
    if (p === "monstre" || p === "terrain" || (p === "zone" && c.sorte === "continue" && !EXEMPLAIRES[c.effet])) {
      if (!n) return "carte";
      if (p === "monstre" && !attaque(c)) return null;
      const max = c.effet === "banniere" ? ETOILES_MAX.banniere
        : p === "monstre" ? ETOILES_MAX.monstre : p === "terrain" ? ETOILES_MAX.terrain : ETOILES_MAX.passif;
      return etoiles(etat, id) < max ? "etoile" : null;
    }
    return n < (EXEMPLAIRES[c.effet] || EXEMPLAIRES_SINON) ? "carte" : null;
  }

  function ouvreBooster(etat, sorte) {
    const candidates = [];
    const fusionner = STOCK.fusions.some((f) => f.matieres.some((x) => x.id && possedee(etat, x.id)));
    for (const id of etat.reserve) {
      const quoi = proposition(etat, id);
      if (!quoi) continue;
      const c = carte(id);
      let poids = RARETES[c.rarete] || 10;
      if (sorte === "elite" && c.rarete === "commune") poids *= 0.2;
      // un coup de pouce aux cartes qui vont avec ce qu'on a déjà, et une
      // étoile moins souvent qu'une carte nouvelle
      if (c.effet === "fusion" && fusionner) poids *= 2;
      if (quoi === "etoile") poids *= R.ETOILE_POIDS;
      candidates.push({ id, quoi, poids });
    }
    const offres = [];
    while (offres.length < 3 && candidates.length) {
      const total = candidates.reduce((t, x) => t + x.poids, 0);
      let r = etat.hasard() * total, k = 0;
      while (k < candidates.length - 1 && (r -= candidates[k].poids) > 0) k++;
      const [o] = candidates.splice(k, 1);
      offres.push({ id: o.id, quoi: o.quoi });
    }
    // tout est pris : de quoi se soigner, pour ne jamais ouvrir un booster vide
    if (!offres.length) offres.push({ id: null, quoi: "soin" });
    return { sorte, offres };
  }

  /* Ce que Sangan et la Sorcière font choisir : une carte du deck, ou du
     cimetière (pas une fusion, ni la Sorcière elle-même), chacune une fois.
     Agido, une Elfe du cimetière, qui revient sur le terrain. */
  const RECHERCHES = { sangan: "deck", sorciere: "cimetiere", agido: "cimetiere" };
  function recherche(etat, sorte) {
    const tas = RECHERCHES[sorte] === "deck" ? etat.deck : etat.cimetiere;
    const vus = [];
    for (const x of tas) {
      const c = carte(x);
      if (vus.indexOf(x) >= 0 || estFusion(c) || (sorte === "sorciere" && a(c, "sorciere"))) continue;
      if (sorte === "agido" && c.type !== "Elfe") continue;
      vus.push(x);
    }
    const plein = sorte === "agido" ? zoneLibre(etat.monstres) < 0 : etat.main.length >= R.MAIN_PLAFOND;
    if (!vus.length || plein) return null;
    const monstre = (x) => (carte(x).genre === "monstre" ? 1 : 0);
    vus.sort((p, q) => monstre(q) - monstre(p) || carte(p).nom.localeCompare(carte(q).nom));
    return { sorte, offres: vus.map((x) => ({ id: x, quoi: "carte" })) };
  }

  function choisit(etat, ev, index) {
    const o = etat.attente.offres[index];
    if (!o) return "Ce choix n'existe pas.";
    const sorte = etat.attente.sorte;
    etat.attente = null;
    if (RECHERCHES[sorte]) {
      // la carte choisie passe du deck (ou du cimetière) à la main, ou sur
      // le terrain pour Agido
      const tas = RECHERCHES[sorte] === "deck" ? etat.deck : etat.cimetiere;
      tas.splice(tas.indexOf(o.id), 1);
      if (tas === etat.cimetiere) etat.stats.ramenees++;
      if (sorte === "agido") invoque(etat, ev, o.id, zoneLibre(etat.monstres));
      else { etat.main.push(o.id); ev.push({ t: "recoit", id: o.id }); }
      suite(etat);
      return null;
    }
    etat.stats.boosters++;
    if (o.quoi === "soin") soigne(etat, ev, 1000);
    else if (o.quoi === "etoile") monteEtoile(etat, ev, o.id);
    else ajouteAuDeck(etat, ev, o.id);   // on la piochera
    suite(etat);
    return null;
  }

  function suite(etat) {
    while (!etat.attente && etat.boosters.length && !etat.fini) {
      const sorte = etat.boosters.shift();
      etat.attente = RECHERCHES[sorte] ? recherche(etat, sorte) : ouvreBooster(etat, sorte);
    }
  }

  /* =========================================================
     Le tour
     ========================================================= */
  function finDeTour(etat, ev) {
    etat.stats.defense = Math.max(etat.stats.defense, Math.round(protection(etat) * 100));
    if (etat.epees > 0) etat.epees--;
    for (const e of etat.ennemis) {
      if (e.expose > 0) e.expose--;
      if (e.affaibli > 0) e.affaibli--;
    }
    etat.tour++;
    etat.feux.forEach((f, k) => { if (f.fin <= etat.tour) etat.feux.delete(k); });
    etat.pieges = etat.pieges.filter((p) => {
      if (p.fin > etat.tour) return true;
      etat.cimetiere.push(p.id);
      ev.push({ t: "piege-fin", x: p.x, y: p.y });
      return false;
    });
    etat.monstres.forEach((m, z) => { if (m && m.fin != null && m.fin <= etat.tour) retireMonstre(etat, ev, z, "fin"); });
    // la pioche : un compte à rebours qui ne tourne que si le deck a des
    // cartes, et qui attend que la main ait de la place
    if (!etat.deck.length) etat.avantPioche = R.PIOCHE_TOURS;
    else {
      if (etat.avantPioche > 0) etat.avantPioche--;
      if (etat.avantPioche <= 0 && etat.main.length < R.MAIN_MAX) {
        pioche(etat, ev, 1);
        etat.avantPioche = R.PIOCHE_TOURS;
      }
    }
    vagues(etat, ev);
    rapproche(etat);
    ramasse(etat, ev);
    oublieLeLointain(etat);
    suite(etat);
  }

  /* Le seul point d'entrée d'un geste.
       { t: "bouge", dx, dy }   un pas (dx, dy dans -1..1, un seul non nul)
       { t: "attend" }          passer le tour
       { t: "joue", index, cibles, option, paie }   paie : la Bourse des Âmes au lieu des sacrifices
       { t: "effet", index }    l'effet de main d'une carte
       { t: "choisit", index }  une carte du booster ouvert
       { t: "passe" }           refermer le booster sans rien prendre
       { t: "relance" }         relancer ses cartes (un Dé gracieux posé)
     Rend { ok, ev, raison } : `ev` dit ce qui s'est passé, dans l'ordre. */
  function agit(etat, geste) {
    const ev = [];
    if (etat.fini) return { ok: false, ev, raison: "La partie est finie." };
    if (etat.attente) {
      if (geste.t === "passe") { etat.attente = null; suite(etat); return { ok: true, ev, raison: null }; }
      if (geste.t === "relance") {
        if (RECHERCHES[etat.attente.sorte]) return { ok: false, ev, raison: "Rien à relancer." };
        const k = etat.zones.findIndex((z) => z && carte(z.id).effet === "de-grace" && z.charges > 0);
        if (k < 0) return { ok: false, ev, raison: "Aucun Dé gracieux sur ton terrain." };
        const z = etat.zones[k];
        z.charges--;
        if (z.charges <= 0) { etat.zones[k] = null; etat.cimetiere.push(z.id); }
        etat.attente = ouvreBooster(etat, etat.attente.sorte);
        ev.push({ t: "relance", reste: z.charges });
        return { ok: true, ev, raison: null };
      }
      if (geste.t !== "choisit") return { ok: false, ev, raison: "Choisis d'abord une carte du booster." };
      const r = choisit(etat, ev, geste.index);
      return { ok: !r, ev, raison: r };
    }
    const j = etat.joueur;
    if (geste.t === "bouge") {
      const dx = Math.sign(geste.dx || 0), dy = Math.sign(geste.dy || 0);
      if (Math.abs(dx) + Math.abs(dy) !== 1) return { ok: false, ev, raison: "Un pas à la fois." };
      if (occupee(etat, j.x + dx, j.y + dy)) {
        ev.push({ t: "bute", dx, dy });
        return { ok: false, ev, raison: null };
      }
      j.x += dx; j.y += dy;
      ev.push({ t: "bouge", dx, dy });
      ramasse(etat, ev);
    } else if (geste.t === "joue" || geste.t === "effet") {
      const r = geste.t === "joue" ? joue(etat, ev, geste.index, geste.cibles, geste.option, geste.paie)
                                   : effetDeMain(etat, ev, geste.index);
      if (r) return { ok: false, ev: [], raison: r };
    } else if (geste.t !== "attend") {
      return { ok: false, ev, raison: "Geste inconnu." };
    }
    // les tours d'affilée sans bouger : jouer une carte ou attendre
    etat.calme = geste.t === "bouge" ? 0 : etat.calme + 1;
    etat.stats.immobile = Math.max(etat.stats.immobile, etat.calme);
    if (!etat.fini) phaseMonstres(etat, ev);
    if (!etat.fini) phaseHorde(etat, ev);
    if (!etat.fini) finDeTour(etat, ev);
    return { ok: true, ev, raison: null };
  }

  /* =========================================================
     Les textes des cartes
     Écrits ici et non dans la page : ils citent les mêmes chiffres que
     les règles, et doivent changer avec elles. Courts : une carte se lit
     d'un coup d'œil, les chiffres sont à part.
     ========================================================= */
  /* Ce que fait l'attaque de chaque Type. La page l'affiche après le nom
     du Type lui-même : « Dragon : une zone de 3 × 3... ». */
  const TEXTES_ATTAQUES = {
    souffle: (c) => a(c, "trois-tetes") ? "attaque trois zones de 3 × 3, sur les 3 monstres les plus proches."
      : a(c, "meteore") ? "attaque une zone de 5 × 5 sur le monstre le plus proche."
      : "attaque une zone de 3 × 3 sur le monstre le plus proche.",
    sort: () => "attaque le monstre le plus proche, puis rebondit sur 2 autres.",
    malediction: () => "attaque le monstre avec le plus de vie.",
    foudre: (c) => `attaque ${a(c, "chaine") ? 6 : 3} monstres au hasard.`,
    taille: () => "attaque tous les monstres à 2 cases.",
    seisme: () => "attaque tous les monstres à l'écran.",
    flammes: () => "attaque en cône de 3 cases sur le monstre le plus proche.",
    raz: () => "attaque la rangée de l'écran où il y a le plus de monstres.",
    meute: () => "attaque les monstres les plus proches : un par Bête sur ton terrain.",
    bombe: (c) => a(c, "triple-canon")
      ? "lance une bombe sur les 3 monstres les plus proches : elles explosent au tour suivant, sur 5 × 5 cases."
      : "lance une bombe sur le monstre le plus proche : elle explose au tour suivant, sur 5 × 5 cases.",
    serres: (c) => a(c, "trois-soeurs") ? "attaque les 3 monstres les plus proches et les emporte au bord de l'écran."
      : "attaque le monstre le plus proche et l'emporte au bord de l'écran.",
    corne: () => "attaque le monstre le plus proche et le projette contre les autres.",
    tourbillon: () => "attaque le monstre le plus proche dans un tourbillon qui aspire ses voisins.",
    vorace: () => "attaque le monstre le plus proche, et grandit à chaque monstre qu'il dévore.",
    piqure: () => `attaque le monstre le plus proche, qui reste {paralysé} ${R.PARALYSIE} tours.`,
    rayons: () => "attaque en 8 rayons depuis toi : tous les monstres alignés avec toi, droit ou en diagonale.",
  };

  /* Ce que l'attribut ajoute à chaque coup. */
  const TEXTES_BONUS = {
    brule: "ce qu'il touche {brûle}.",
    ralentit: "ce qu'il touche est {ralenti}.",
    repousse: "ce qu'il touche est repoussé.",
    eclats: "{dégâts de zone}.",
    expose: "ce qu'il touche est {exposé}.",
    vampire: "{vol de vie}.",
  };

  /* Les mots-clés : dans un texte, {mot} ou {mot|clé}, que la page
     souligne et explique au survol. Ils gardent les textes courts. Une
     clé en minuscules ; le mot en gras d'un effet (« Dernier souffle »)
     s'explique aussi, s'il est ici. */
  const MOTS = {
    "compteur magie": `+${R.COMPTEUR * 100} % de dégâts totaux (${R.COMPTEURS_MAX} au plus par carte).`,
    "brûle": `il perd ${R.BRULE_PART * 100} % du coup à chaque tour, pendant ${R.BRULE_TOURS} tours.`,
    "ralenti": "ne joue pas le prochain tour.",
    "dégâts de zone": `les monstres proches prennent ${R.ECLATS * 100} % des dégâts.`,
    "exposé": `il prend ${R.EXPOSE * 100} % de dégâts en plus pendant ${R.EXPOSE_TOURS} tours.`,
    "vol de vie": `chaque point de dégât te rend ${R.VOL_DE_VIE} LP.`,
    "paralysé": "il ne bouge plus et ne frappe plus.",
    "affaibli": `il frappe ${R.ROQUETTE * 100} % moins fort pendant ${R.ROQUETTE_TOURS} tours.`,
    "jeton": "un monstre qui disparaît quand il quitte le terrain, sans aller au cimetière.",
    "dernier souffle": "quand la carte part au cimetière.",
    "à l'arrivée": "quand le monstre est invoqué.",
    "dans ta main": "tant que la carte est dans ta main, sans la jouer.",
    "harpie": "Dame Harpie, Cyber-Harpie ou Sœurs de Harpie.",
  };

  /* [mot-clé, phrase] : le mot-clé se met en gras. */
  const TEXTES_EFFETS = {
    kuriboh: () => ["Dans ta main", "il t'évite une fois le coup fatal, puis part au cimetière."],
    sangan: () => ["Dernier souffle", "ajoute à ta main une carte de ton deck, au choix."],
    sorciere: () => ["Dernier souffle", "ajoute à ta main une carte de ton cimetière, au choix."],
    illusion: () => ["Illusion", "les monstres qui te frappent sont repoussés de 2 cases."],
    recherche: (c) => c.genre === "monstre"
      ? ["À l'arrivée", `ajoute ${c.cherche ? carte(c.cherche).nom : "sa moitié"} à ton deck, puis la pioche.`]
      : [null, `Ajoute ${carte(c.cherche).nom} à ton deck, puis pioche-la.`],
    foi: () => ["À l'arrivée", "reprends une magie de ton cimetière."],
    temps: () => ["Pile ou face", "tous les 4 tours : pile, les monstres proches disparaissent ; face, tu perds 500 LP."],
    "brise-sort": () => ["Brise-sort", "arrive avec 2 {compteurs magie|compteur magie}."],
    protecteur: () => ["Protecteur", "la DEF de tes Dragons compte double."],
    disciple: () => ["Disciple", "+30 % de dégâts si le Magicien Sombre est sur le terrain ou au cimetière."],
    "magie-noire": () => ["Magie noire", "chaque magie que tu joues le fait tirer aussitôt."],
    meteore: () => ["Météore", "son attaque embrase le sol."],
    "trois-tetes": () => ["Trois têtes", "son attaque porte sur tout l'écran."],
    rempart: () => ["Rempart", "sa DEF compte double pour te protéger."],
    cuirasse: () => ["Cuirasse", `les dégâts que t'infligent les monstres sont réduits de ${R.CUIRASSE}.`],
    "charge-celeste": () => ["Charge céleste", "son attaque porte sur tout l'écran et repousse de 3 cases."],
    "anti-dragon": () => ["Tueur de dragons", "double dégâts contre les Dragons."],
    mange: () => ["À l'arrivée", "dévore le monstre ennemi le plus résistant à l'écran."],
    tonnerre: () => ["Appel du tonnerre", "depuis ta main, défausse-le : 2 Dragons du Tonnerre sont ajoutés à ton deck, puis piochés."],
    hippocampe: () => ["Double sacrifice", "compte pour 2 sacrifices."],
    sirene: () => ["Sirène", "sous Umi, attaque à chaque tour."],
    chaine: () => ["Foudre en chaîne", "6 cibles au lieu de 3."],
    "souffle-du-temps": () => ["Souffle du temps", "les monstres touchés sont {ralentis|ralenti}."],
    furie: () => ["Furie", "attaque à chaque tour."],
    magnetique: () => ["Champ magnétique", "son attaque est deux fois plus forte."],
    chimere: (c) => ["Dernier souffle", `${enumere((c.ramene || []).map((x) => carte(x).nom))} reviennent dans ta main, depuis ton cimetière ou ton deck.`],
    equipement: () => ["Équipement", `+${R.EQUIPEMENT * 100} % de dégâts par carte magie sur ton terrain.`],
    copie: () => ["À l'arrivée", "prend l'ATK et la DEF du monstre ennemi le plus fort à l'écran."],
    roquette: () => ["Roquette", "ce qu'il touche est {affaibli}."],
    fierte: () => ["Fierté", "n'attaque que si un autre monstre est sur ton terrain."],
    "epee-de-flammes": () => ["Épée de flammes", "son attaque embrase le sol."],
    "trois-soeurs": () => ["Trois sœurs", "3 cibles au lieu d'une."],
    harpie: () => ["Harpie", "compte comme une Dame Harpie."],
    dresse: () => ["Dressé", `+${R.DRESSE * 100} % de dégâts par {Harpie|harpie} sur ton terrain.`],
    union: () => ["Union", `+${R.UNION * 100} % de dégâts à tes autres Machines.`],
    "triple-canon": () => ["Triple canon", "3 bombes au lieu d'une."],
    priere: () => ["Prière", `+${R.PRIERE * 100} % de dégâts par Elfe dans ton cimetière.`],
    keldo: () => ["Dernier souffle", `remet dans ton deck les ${R.KELDO} dernières cartes de ton cimetière.`],
    agido: () => ["Dernier souffle", `lance un dé : sur ${R.AGIDO} ou plus, une Elfe de ton cimetière revient sur le terrain, au choix.`],
    zolga: () => ["Offrande", `sacrifié, il te rend ${R.ZOLGA} LP.`],
    bibliotheque: () => ["Bibliothèque", `chaque magie jouée lui donne un compteur ; au ${R.BIBLIOTHEQUE}e, tu pioches une carte.`],
    raigeki: () => [null, "Détruit tous les monstres ennemis à l'écran."],
    epees: () => [null, `Les monstres ennemis se figent pendant ${R.EPEES} tours.`],
    pot: () => [null, "Pioche 2 cartes."],
    reborn: () => [null, "Ramène un monstre de ton cimetière sur le terrain."],
    fusion: () => [null, "Fusionne des monstres de ta main ou de ton terrain."],
    "dian-keto": () => [null, `Tu gagnes ${R.DIAN_KETO} LP.`],
    moutons: () => [null, "Remplit tes zones monstre libres de {jetons|jeton} Mouton."],
    coeur: () => [null, `Le monstre ennemi le plus fort à l'écran passe de ton côté pendant ${R.COEUR_TOURS} tours.`],
    liberation: () => [null, `Remet ${R.LIBERATION} cartes de ton cimetière dans ton deck.`],
    enterrement: () => [null, `Paie ${R.ENTERREMENT} LP : reprends un monstre de ton cimetière dans ta main.`],
    fissure: () => [null, "Détruit le monstre ennemi le plus résistant à l'écran."],
    typhon: () => [null, "Détruit autant de tes cartes magie et piège que tu veux."],
    destruction: () => [null, "Remet toute ta main dans ton deck, puis pioche autant de cartes."],
    "de-crane": () => [null, `Lance un dé : pendant ${R.CRANE_TOURS} tours, les monstres ennemis frappent ${R.CRANE * 100} % moins fort par point.`],
    "de-grace": () => [null, "Lance un dé : autant de fois, tu peux relancer les cartes d'un booster."],
    echange: () => [null, `Tu peux payer ${R.ECHANGE} LP au lieu de sacrifier tes monstres pour tes invocations sacrifice.`],
    hache: () => [null, "+20 % de dégâts à tous tes monstres."],
    "arts-secrets": () => [null, "Chaque magie jouée ajoute un {compteur magie} à tes Magiciens."],
    "tresor-dragon": () => [null, "+35 % de dégâts à tes Dragons."],
    usine: () => [null, `+${R.USINE * 100} % de dégâts à tes Machines.`],
    salamandra: () => [null, `+${R.SALAMANDRA * 100} % de dégâts à tes monstres FEU.`],
    banniere: () => [null, "Tes monstres de niveau 4 ou moins attaquent à chaque tour."],
    aimant: () => [null, "Tu ramasses les étoiles une case plus loin."],
    terrain: (c) => [null, `+30 % de dégâts aux ${enumere(c.types)}.`],
    trappe: (c) => {
      const n = 2 * (c.rayon || R.TRAPPE_RAYON) + 1;
      return [null, `Ouvre une trappe de ${n} × ${n} cases autour de toi : pendant ${R.TRAPPE_TOURS} tours, tout monstre qui y entre est détruit.`];
    },
    miroir: () => [null, "Au prochain coup reçu, détruit tous les monstres ennemis à 2 cases de toi."],
    cylindre: () => [null, `Annule les ${R.CYLINDRE} prochains coups, et détruit chaque attaquant.`],
    jugement: () => [null, "Annule la prochaine frappe d'un boss qui devait te toucher."],
    chapeaux: () => [null, `Au prochain coup reçu, tu disparais sous un chapeau et réapparais ${R.CHAPEAUX} cases plus loin.`],
    egotiste: (c) => [null, `Si une {Harpie|harpie} est sur ton terrain : invoque ${carte(c.cherche).nom}, sans sacrifice.`],
    plumeau: () => [null, `Repousse de ${R.PLUMEAU} cases tous les monstres ennemis à l'écran.`],
    cyberbouclier: () => [null, `+${R.CYBERBOUCLIER * 100} % de dégâts à tes {Harpies|harpie}.`],
    virus: () => [null, `Détruit tous les monstres ennemis de ${R.VIRUS} ATK ou plus à l'écran.`],
    permutation: () => [null, `Paie ${R.PERMUTATION_LP} LP : ton cimetière et ton deck s'échangent.`],
    "bouclier-epee": () => [null, `Pendant ${R.BOUCLIER_TOURS} tours, tes monstres attaquent avec leur DEF au lieu de leur ATK.`],
    megamorphe: () => [null, `+${R.MEGAMORPHE * 100} % de dégâts à tous tes monstres tant que tu as moins de ${R.MEGAMORPHE_LP} LP.`],
    "puissance-du-mage": () => [null, `+${R.PUISSANCE * 100} % de dégâts à tous tes monstres par carte dans tes zones magie et piège.`],
  };

  /* Ce qui se lit en italique, à part : les conditions et les limites. */
  const CONDITIONS = {
    raigeki: `Un boss perd ${R.BOSS_PART * 100} % de ses PV.`,
    fissure: `Un boss perd ${R.BOSS_PIEGE * 100} % de ses PV.`,
    hache: "Par étoile.",
    "tresor-dragon": "Par étoile.",
    usine: "Par étoile.",
    salamandra: "Par étoile.",
    aimant: "Par étoile.",
    terrain: "Un seul terrain à la fois.",
    trappe: "Un boss n'y tombe qu'une fois.",
    coeur: "Pas un boss.",
    copie: "Pas un boss.",
    plumeau: "Pas un boss.",
    virus: `Un boss perd ${R.BOSS_PIEGE * 100} % de ses PV.`,
    permutation: `Il faut ${R.PERMUTATION} cartes dans ton cimetière. Une seule par duel.`,
    cyberbouclier: "Par étoile.",
    megamorphe: "Par étoile.",
    "puissance-du-mage": "Par étoile.",
  };

  /* Ce que prend la cible visée, en part des dégâts du monstre : la
     pastille de dégâts de la fiche montre ce chiffre-là. */
  function partVisee(c) {
    switch (motif(c)) {
      case "malediction": return R.MALEDICTION;
      case "taille": return R.TAILLE;
      case "seisme": return R.SEISME * (a(c, "magnetique") ? 2 : 1);
      case "raz": return R.RAZ;
      case "serres": return R.SERRES;
      case "corne": return R.CORNE;
      case "bombe": return R.BOMBE;
      case "rayons": return R.RAYONS;
      default: return 1;
    }
  }

  /* Les relances qu'un Dé gracieux posé permet encore, pour le booster. */
  function relances(etat) {
    const z = etat.zones.find((x) => x && carte(x.id).effet === "de-grace");
    return z ? z.charges : 0;
  }

  /* « Démon et Magicien », « Insecte, Bête, Plante et Bête-Guerrier » */
  function enumere(liste) {
    return liste.length < 2 ? liste.join("") : liste.slice(0, -1).join(", ") + " et " + liste[liste.length - 1];
  }

  function nomsMatieres(f) {
    return f.matieres.map((x) => x.id ? carte(x.id).nom : `un ${x.type}`).join(" + ");
  }

  /* Le texte d'une carte, rangé par sortes de lignes que la page met en
     forme chacune à sa façon :
       { tete, stats, attaque: { nom, phrase, bonus: [attribut, phrase], puces },
         effets: [[mot, phrase]], conditions: [phrase] }
     `m` : le monstre sur le terrain, s'il y est (sa DEF du moment, ses
     compteurs). */
  function texte(etat, id, m) {
    const c = carte(id);
    const effets = [], conditions = [];
    let tete, stats = null, attaq = null;
    for (const e of effetsDe(c)) {
      if (TEXTES_EFFETS[e]) effets.push(TEXTES_EFFETS[e](c));
      if (CONDITIONS[e]) conditions.push(CONDITIONS[e]);
    }
    if (c.genre === "monstre") {
      const at = ATTRIBUTS[c.attribut] || { nom: c.attribut };
      tete = `Niveau ${c.niveau} · ${at.nom} · ${c.type}`;
      stats = { atk: atkDe(c, m), df: defenseMax(etat, id, m), compteurs: m && m.compteurs ? m.compteurs : 0 };
      if (attaque(c, m, etat)) {
        const r = recharge(etat, c);
        const p = portee(etat, c);
        const b = bonusDe(c);
        attaq = { nom: c.type, phrase: TEXTES_ATTAQUES[motif(c)](c),
                  bonus: b ? [at.nom, TEXTES_BONUS[b], c.attribut] : null, puces: [
          `${Math.max(1, Math.round(degats(etat, id, m) * partVisee(c)))} dégâts`,
          r === 1 ? "chaque tour" : `1 tour sur ${r}`,
          motif(c) === "taille" ? null : p >= ecran(etat) ? "tout l'écran" : `portée ${p}`,
        ].filter(Boolean) };
      } else if (!a(c, "copie")) {
        // le Magicien du Temps non plus : c'est son effet qui frappe ; Copiechat
        // attaquera dès qu'il aura copié
        conditions.unshift("N'attaque pas.");
      }
      const f = STOCK.fusions.find((x) => x.carte === id);
      if (f) conditions.push(`Fusion : ${nomsMatieres(f)}.`);
      else if (sacrifices(c)) conditions.push(`Demande ${sacrifices(c)} sacrifice${sacrifices(c) > 1 ? "s" : ""}.`);
    } else {
      const p = place(c);
      const piege = c.genre === "piege";
      tete = (piege ? "Piège" : "Magie")
        + (p === "terrain" ? " de terrain" : p === "zone" ? (piege ? " continu" : " continue") : "");
    }
    return { tete, stats, attaque: attaq, effets, conditions };
  }

  racine.Moteur = {
    R, BOSS, ATTRIBUTS, RARETES, TYPE_ATTAQUE, BONUS, MOTS,
    charge, carte, duelliste, nouvelle, vue, agit, jouable, jouableEffet, options, texte, frappeDe,
    place, effetsDe, estFusion, etoiles, degats, portee, recharge, defenseMax, defenseTotale, protection, reduction, xpPour,
    relances,
    rayonRamassage, sacrifices, valeurSacrifice, cle, taille, dans, milieu,
  };
})(typeof window !== "undefined" ? window : globalThis);
