/* =========================================================
   Yu-Gi-Oh! Survivor : la page

   Elle ne décide de rien : chaque geste part au moteur (moteur.js), qui
   rend la liste de ce qui s'est passé. La page en fait des animations
   (un tir, un coup, une carte qui se brise), redessine le terrain et la
   main, et ouvre les boosters quand le moteur en tient un prêt.

   Le plateau est un canvas, redessiné à chaque image. Le joueur reste au
   centre et c'est la table qui glisse sous lui ; chaque ennemi rejoint sa
   case en douceur, si bien qu'une touche tenue enfonce la partie à la
   vitesse d'un jeu d'action, alors que rien ne bouge tant qu'on n'agit pas.

   Avant le duel, l'accueil : choisir son duelliste (Yugi, puis Joey quand
   Yugi a battu Obélisk, Mai, Kaiba et Ishizu par d'autres succès), composer
   son deck (les 40 cartes que les boosters
   peuvent faire trouver pendant le duel), en acheter d'autres avec les
   Points de Duel gagnés en partie, voir ses succès et les cartes qu'eux
   seuls rapportent. Tout cela vit sur le serveur
   (/api/survivor, voir survivor.py) ; sans lui, on joue quand même, avec
   Yugi, le deck proposé au départ et sans rien gagner.

   En partie, les lignes Deck et Cimetière de « Ton duel » montrent les
   cartes qu'il y a dedans (le deck sans son ordre).

   Les commandes, qui ne sont écrites nulle part à l'écran :
     - flèches, ZQSD (WASD en QWERTY : on lit la touche physique) ou le
       pavé numérique : un pas ;
     - Espace, « . » ou 5 du pavé : attendre ;
     - 1 à 9 : choisir la carte de la main, une seconde fois pour la jouer
       (Entrée aussi) ; Échap annule, referme la pile qu'on regarde, ou
       met en pause ;
     - dans un booster, 1 à 3 ; dans la liste de Polymérisation ou de
       Monster Reborn, 1 à 9 ;
     - dans le Deck, un clic droit fait entrer une carte de la collection,
       ou sortir une carte du deck ;
     - au doigt ou à la souris : toucher le plateau du côté où l'on veut
       aller (sa propre case : attendre), glisser, ou garder appuyé pour
       marcher.
   ========================================================= */
(function () {
  "use strict";

  const M = window.Moteur;
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* Les vignettes du jeu (192 px, voir survivor.py) ; les artworks
     complets du stock Yu-Gi-Oh pour les grandes cartes, et en secours. */
  const ART = (id) => `/static/survivor/art/${id}.webp`;
  const ART_GRANDE = (id) => `/static/yugioh/CardsCropped/${id}.jpg`;
  const img = (id, alt) => `<img src="${ART(id)}" data-repli="${ART_GRANDE(id)}" alt="${esc(alt || "")}">`;

  /* Les duellistes : leur portrait à l'accueil, et ce que montre leur
     médaillon : le point de leur visage (en part de l'image) et la largeur
     de l'image (en cercles), plus grande pour un portrait en buste, où le
     visage tient moins de place. */
  const PORTRAIT = (cle) => `/static/survivor/duellistes/${cle}.webp`;
  const VISAGES = { yugi: [0.5, 0.31, 2.5], joey: [0.5, 0.23, 3.2], mai: [0.49, 0.25, 2.6],
                    kaiba: [0.52, 0.22, 3.6], ishizu: [0.49, 0.24, 3.6] };

  const CADENCE = 115;      // ms au moins entre deux tours : le pas d'une touche tenue
  const RECORD = "abyss-survivor-record";
  const MEMO_DUELLISTE = "abyss-survivor-duelliste";   // le dernier choisi, dans ce navigateur

  /* La teinte de la table sous chaque terrain. */
  const TEINTES = { "Yami": "#1B0E29", "Sogen": "#1D1C0D", "Umi": "#0A192B", "Montagne": "#1F1812",
                    "Forêt": "#0C1D11" };

  /* ---------- l'état de la page ---------- */
  let STOCK = null;
  let PROFIL = null;        // ce que le serveur garde : Points de Duel, collection, deck ; null sans lui
  let JETON = null;         // le jeton de la partie en cours, qui la paie une fois
  let ONGLET = "jouer";
  let DUELLISTE = "yugi";   // la clé de celui qu'on a choisi à l'accueil
  let CHOISIE = null;       // la carte touchée dans le deck ou la boutique : { id, ou }
  let TRI = "type";         // l'ordre de la collection
  let FILTRE = "tout";      // ce qu'elle montre
  let ETAT = null;
  let SELECTION = null;     // l'index de la carte choisie dans la main
  let LISTE = null;         // { index } : la liste de Polymérisation ou de Monster Reborn ouverte
  let PILE = null;          // « deck » ou « cimetiere » : la pile qu'on regarde
  let CHOIX = null;         // { index, option, besoin, ou, sacrifice, pris } : désigner des zones
  let REGARD = null;        // une carte qu'on a touchée pour la lire : { id, zone, offre }
  let SURVOL = null;        // ce que la souris montre : { id, zone } ou { uid }
  let PAUSE = false;
  let ABANDON = false;
  let DERNIER = 0;          // l'heure du dernier tour joué
  let FILE = null;          // un geste arrivé trop tôt, joué dès que la cadence le permet
  let MINUTEUR = null;
  let LP_AVANT = null;
  let BOOSTER_PRET = false;
  let OFFRE_VUE = null;     // au téléphone : la carte du booster touchée une fois, qu'on lit
  let EXODIA_GARDEE = null; // l'oblitération d'Exodia, qui attend qu'on referme le booster
  let VERSION_DECK = 0;     // le dernier changement du deck : une réponse plus ancienne ne l'écrase pas
  // au téléphone, rien ne se survole : un premier toucher lit, le second choisit
  const ETROIT = window.matchMedia("(max-width: 900px)");
  const NIVEAUX = [];       // les niveaux atteints, pour titrer leurs boosters
  const ARRIVEES = new Set();   // les zones à faire apparaître : « m2 », « z0 », « t0 »
  const TIRS = new Set();       // les zones monstre qui viennent de tirer
  const TOUCHEES = new Set();   // celles qui viennent de prendre un coup
  const NOUVELLES = new Set();  // les cartes arrivées en main ce tour-ci

  /* ---------- le plateau ---------- */
  const plateau = el("plateau");
  const toile = el("toile");
  const ctx = toile.getContext("2d");
  let W = 0, H = 0, DPR = 1, T = 44;
  let VUE = { rx: 7, ry: 5 };
  const O = { x: 0, y: 0 };             // où tombe la case 0,0 à l'écran
  const CAM = { x: 0, y: 0 };           // la case au centre de l'écran, animée
  const SECOUSSE = { force: 0, t: 0 };
  const POS = new Map();                // uid -> { x, y, ne, flash, elan } : la place dessinée
  let BUTE = null;
  let EFFETS = [];
  let NOMBRES = [];
  let VIGNETTE = null;
  let IMAGE_PRECEDENTE = 0;

  /* ---------- le serveur ---------- */
  async function api(chemin, methode, charge) {
    const o = { method: methode || "GET", credentials: "same-origin" };
    if (charge !== undefined) {
      o.headers = { "Content-Type": "application/json" };
      o.body = JSON.stringify(charge);
    }
    const r = await fetch(chemin, o);
    let d = null;
    try { d = await r.json(); } catch (e) { /* réponse illisible */ }
    if (!r.ok || !d || d.ok === false) {
      const err = new Error((d && d.message) || `Erreur ${r.status}.`);
      err.statut = r.status;
      throw err;
    }
    return d;
  }

  /* ---------- les images ---------- */
  const IMAGES = new Map();
  function image(id) {
    let im = IMAGES.get(id);
    if (!im) {
      im = new Image();
      im.decoding = "async";
      im.addEventListener("error", () => { if (!im.repli) { im.repli = true; im.src = ART_GRANDE(id); } });
      im.src = ART(id);
      IMAGES.set(id, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }
  function precharge(ids) { ids.forEach(image); }

  /* Une vignette absente du disque : l'artwork complet prend sa place. Un
     écouteur, et non un onerror= : la page n'exécute que ses fichiers. */
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.dataset.repli) {
      const repli = t.dataset.repli;
      delete t.dataset.repli;
      t.src = repli;
    }
  }, true);

  /* =========================================================
     Les dimensions
     ========================================================= */
  function dimensionne() {
    const r = plateau.getBoundingClientRect();
    if (!r.width || !r.height) return;
    W = r.width; H = r.height;
    DPR = Math.min(2, window.devicePixelRatio || 1);
    toile.width = Math.round(W * DPR);
    toile.height = Math.round(H * DPR);
    const cible = W < 600 ? 38 : 50;
    let cols = Math.max(9, Math.floor(W / cible)); if (cols % 2 === 0) cols--;
    let rows = Math.max(7, Math.floor(H / cible)); if (rows % 2 === 0) rows--;
    T = Math.min(W / cols, H / rows);
    VUE = { rx: Math.min(11, Math.floor((W / T - 1) / 2)), ry: Math.min(8, Math.floor((H / T - 1) / 2)) };
    if (ETAT) M.vue(ETAT, VUE.rx, VUE.ry);
    VIGNETTE = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    VIGNETTE.addColorStop(0, "rgba(0,0,0,0)");
    VIGNETTE.addColorStop(1, "rgba(0,0,0,0.55)");
  }
  new ResizeObserver(dimensionne).observe(plateau);

  /* =========================================================
     La boucle d'animation
     ========================================================= */
  function boucle(now) {
    const dt = Math.min(64, now - (IMAGE_PRECEDENTE || now));
    IMAGE_PRECEDENTE = now;
    if (ETAT && W) { anime(dt, now); dessine(now); }
    requestAnimationFrame(boucle);
  }

  function anime(dt, now) {
    const k = 1 - Math.exp(-dt / 55);
    CAM.x += (ETAT.joueur.x - CAM.x) * k;
    CAM.y += (ETAT.joueur.y - CAM.y) * k;
    const vus = new Set();
    for (const e of ETAT.ennemis) {
      vus.add(e.uid);
      let p = POS.get(e.uid);
      if (!p) { p = { x: e.x, y: e.y, ne: now, flash: 0, elan: null }; POS.set(e.uid, p); }
      // un ennemi ramené au bord de l'écran y saute, il ne traverse pas la table
      if (Math.abs(e.x - p.x) + Math.abs(e.y - p.y) > 4) { p.x = e.x; p.y = e.y; p.ne = now; }
      p.x += (e.x - p.x) * k;
      p.y += (e.y - p.y) * k;
    }
    for (const uid of POS.keys()) if (!vus.has(uid)) POS.delete(uid);
  }

  const centre = (x, y) => [O.x + (x + 0.5) * T, O.y + (y + 0.5) * T];

  function cheminArrondi(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function dessine(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    let sx = 0, sy = 0;
    if (SECOUSSE.force) {
      const p = (now - SECOUSSE.t) / 240;
      if (p >= 0 && p < 1) {
        const f = SECOUSSE.force * (1 - p);
        sx = (Math.random() * 2 - 1) * f; sy = (Math.random() * 2 - 1) * f;
      } else if (p >= 1) SECOUSSE.force = 0;
    }
    O.x = W / 2 - (CAM.x + 0.5) * T + sx;
    O.y = H / 2 - (CAM.y + 0.5) * T + sy;
    fond();
    dessineFeux(now);
    dessineAnnonces(now);
    dessinePieges();
    dessineBombes(now);
    dessineButin(now);
    dessineEnnemis(now);
    dessineJoueur(now, sx, sy);
    dessineEffets(now);
    dessineNombres(now);
    if (ETAT.epees > 0) {
      ctx.fillStyle = "rgba(255,230,150,0.06)";
      ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = VIGNETTE;
    ctx.fillRect(0, 0, W, H);
  }

  function fond() {
    const teinte = ETAT.terrain ? TEINTES[M.carte(ETAT.terrain).nom] : null;
    ctx.fillStyle = teinte || "#0C0A14";
    ctx.fillRect(0, 0, W, H);
    const x0 = Math.floor(-O.x / T) - 1, x1 = Math.ceil((W - O.x) / T) + 1;
    const y0 = Math.floor(-O.y / T) - 1, y1 = Math.ceil((H - O.y) / T) + 1;
    // un damier à peine visible : la table a des cases
    ctx.fillStyle = "rgba(255,255,255,0.022)";
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) if (((x + y) & 1) === 0) ctx.fillRect(O.x + x * T, O.y + y * T, T, T);
    }
    ctx.strokeStyle = "rgba(201,168,76,0.09)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { const px = Math.round(O.x + x * T) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, H); }
    for (let y = y0; y <= y1; y++) { const py = Math.round(O.y + y * T) + 0.5; ctx.moveTo(0, py); ctx.lineTo(W, py); }
    ctx.stroke();
  }

  /* Le sol qui brûle après un souffle embrasé : des braises qui
     palpitent, et qui pâlissent au dernier tour. */
  function dessineFeux(now) {
    ETAT.feux.forEach((f) => {
      const reste = f.fin - ETAT.tour;
      const pulse = 0.5 + 0.5 * Math.sin(now / 120 + f.x * 2.1 + f.y * 1.3);
      ctx.fillStyle = `rgba(255,${90 + Math.round(60 * pulse)},30,${(reste <= 1 ? 0.12 : 0.22) + 0.1 * pulse})`;
      ctx.fillRect(O.x + f.x * T + 1, O.y + f.y * T + 1, T - 2, T - 2);
    });
  }

  /* Les frappes annoncées des boss : rouge pâle, puis vif au dernier tour. */
  function dessineAnnonces(now) {
    for (const a of ETAT.annonces) {
      const imminente = a.tour - ETAT.tour <= 1;
      const pulse = 0.5 + 0.5 * Math.sin(now / (imminente ? 90 : 200));
      ctx.fillStyle = `rgba(255,45,45,${imminente ? 0.2 + 0.18 * pulse : 0.08 + 0.07 * pulse})`;
      ctx.strokeStyle = `rgba(255,95,95,${imminente ? 0.55 + 0.35 * pulse : 0.3})`;
      ctx.lineWidth = 1.5;
      for (const k of a.cases) {
        const [x, y] = k.split(",").map(Number);
        ctx.fillRect(O.x + x * T + 1, O.y + y * T + 1, T - 2, T - 2);
        ctx.strokeRect(O.x + x * T + 2, O.y + y * T + 2, T - 4, T - 4);
      }
    }
  }

  /* Une Trappe posée : le dos d'une carte, liseré de rose. */
  function dessinePieges() {
    for (const p of ETAT.pieges) {
      // la fosse : ses 3 × 3 cases (5 × 5 sans fond), sombres et bordées de rose
      const r = p.r || M.R.TRAPPE_RAYON;
      ctx.fillStyle = "rgba(20,6,14,0.55)";
      ctx.fillRect(O.x + (p.x - r) * T + 1, O.y + (p.y - r) * T + 1, (2 * r + 1) * T - 2, (2 * r + 1) * T - 2);
      ctx.strokeStyle = "rgba(224,106,166,0.6)"; ctx.lineWidth = 1.5;
      ctx.strokeRect(O.x + (p.x - r) * T + 1.5, O.y + (p.y - r) * T + 1.5, (2 * r + 1) * T - 3, (2 * r + 1) * T - 3);
      const [cx, cy] = centre(p.x, p.y);
      const w = T * 0.44, h = T * 0.6;
      cheminArrondi(cx - w / 2, cy - h / 2, w, h, 3);
      const g = ctx.createLinearGradient(cx, cy - h / 2, cx, cy + h / 2);
      g.addColorStop(0, "#6B3414"); g.addColorStop(1, "#2E1406");
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#E06AA6"; ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.24, h * 0.27, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(240,180,90,0.75)"; ctx.lineWidth = 1.2; ctx.stroke();
    }
  }

  /* Une bombe de Machine, au sol jusqu'au tour suivant : la zone qu'elle
     va souffler, en pointillé, et sa mèche qui crépite. */
  function dessineBombes(now) {
    for (const b of ETAT.bombes) {
      const r = M.R.BOMBE_RAYON;
      ctx.save();
      ctx.strokeStyle = "rgba(255,150,60,0.45)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      ctx.strokeRect(O.x + (b.x - r) * T + 2, O.y + (b.y - r) * T + 2, (2 * r + 1) * T - 4, (2 * r + 1) * T - 4);
      ctx.setLineDash([]);
      const [cx, cy] = centre(b.x, b.y);
      ctx.fillStyle = "#1B1B22"; ctx.strokeStyle = "#5A5A66"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, T * 0.22, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const lueur = 0.5 + 0.5 * Math.sin(now / 60 + b.uid);
      ctx.fillStyle = `rgba(255,${180 + Math.round(60 * lueur)},80,${0.6 + 0.4 * lueur})`;
      ctx.shadowColor = "#FFB040"; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(cx + T * 0.14, cy - T * 0.2, T * 0.06 + 2 * lueur, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function etoile(cx, cy, r, couleur) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.shadowColor = couleur; ctx.shadowBlur = 8;
    ctx.fillStyle = couleur;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4 - Math.PI / 2, rr = i % 2 ? r * 0.4 : r;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function couleurXp(n) { return n >= 20 ? "#FF6B6B" : n >= 6 ? "#FFD34D" : n >= 3 ? "#7FEDAA" : "#7FC8FF"; }

  function dessineButin(now) {
    ETAT.butin.forEach((b) => {
      const [cx, base] = centre(b.x, b.y);
      const cy = base + Math.sin(now / 320 + b.x * 1.7 + b.y) * T * 0.05;
      if (b.exodia) {
        const r = T * 0.38, im = image(b.exodia);
        ctx.save();
        ctx.shadowColor = "#FFA43A"; ctx.shadowBlur = 18 + 8 * Math.sin(now / 200);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = "#2A1606"; ctx.fill();
        ctx.clip();
        if (im) ctx.drawImage(im, cx - r, cy - r, r * 2, r * 2);
        ctx.restore();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = "#FFB54D"; ctx.lineWidth = 2.5; ctx.stroke();
      } else if (b.booster) {
        const w = T * 0.4, h = T * 0.56;
        ctx.save();
        ctx.shadowColor = "#FFD34D"; ctx.shadowBlur = 14;
        cheminArrondi(cx - w / 2, cy - h / 2, w, h, 3);
        const g = ctx.createLinearGradient(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
        g.addColorStop(0, "#FFE58A"); g.addColorStop(0.5, "#E09A2D"); g.addColorStop(1, "#8A4A0E");
        ctx.fillStyle = g; ctx.fill();
        ctx.restore();
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fillRect(cx - w / 2, cy - h * 0.12, w, h * 0.08);
      }
      if (b.xp) {
        const r = T * Math.min(0.27, 0.11 + 0.028 * Math.sqrt(b.xp));
        etoile(cx, b.exodia || b.booster ? cy + T * 0.3 : cy, r, couleurXp(b.xp));
      }
    });
  }

  /* Un ennemi : son artwork dans un cadre à la couleur de son attribut,
     doré pour un élite, rouge pour un boss, sur toutes les cases qu'il
     occupe. */
  function dessineEnnemis(now) {
    const fige = ETAT.epees > 0;
    // les grands par-dessus les petits
    const liste = ETAT.ennemis.slice().sort((a, b) => M.taille(a) - M.taille(b));
    for (const e of liste) {
      const p = POS.get(e.uid);
      if (!p) continue;
      const t = M.taille(e);
      let x = p.x + (t - 1) / 2, y = p.y + (t - 1) / 2;
      if (p.elan) {
        const q = (now - p.elan.t) / 200;
        if (q >= 0 && q < 1) { const f = Math.sin(q * Math.PI) * 0.3; x += p.elan.dx * f; y += p.elan.dy * f; }
        else if (q >= 1) p.elan = null;
      }
      const [cx, cy] = centre(x, y);
      const boss = e.boss != null;
      const s = T * (t === 1 ? 0.82 : t - 0.12);
      const alpha = Math.max(0, Math.min(1, (now - p.ne) / 220));
      const c = M.carte(e.id);
      const couleur = (M.ATTRIBUTS[c.attribut] || M.ATTRIBUTS.DARK).couleur;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (boss || e.elite) {
        ctx.shadowColor = boss ? "#FF3030" : "#FFD34D";
        ctx.shadowBlur = boss ? 26 + 8 * Math.sin(now / 180) : 16;
      }
      cheminArrondi(cx - s / 2, cy - s / 2, s, s, s * 0.1);
      ctx.fillStyle = "#000"; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.save();
      ctx.clip();
      const im = image(e.id);
      if (im) ctx.drawImage(im, cx - s / 2, cy - s / 2, s, s);
      else { ctx.fillStyle = couleur; ctx.globalAlpha = alpha * 0.4; ctx.fillRect(cx - s / 2, cy - s / 2, s, s); }
      if (p.flash) {
        const q = (now - p.flash) / 150;
        if (q >= 0 && q < 1) { ctx.globalAlpha = alpha * (1 - q) * 0.8; ctx.fillStyle = "#fff"; ctx.fillRect(cx - s / 2, cy - s / 2, s, s); }
      }
      // en feu : une lueur orange qui palpite
      if (e.brule) {
        ctx.globalAlpha = alpha * (0.18 + 0.12 * Math.sin(now / 90 + e.uid));
        ctx.fillStyle = "#FF6A1A"; ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
      }
      // exposé par la LUMIÈRE : un voile clair qui scintille
      if (e.expose > 0) {
        ctx.globalAlpha = alpha * (0.16 + 0.1 * Math.sin(now / 110 + e.uid * 2));
        ctx.fillStyle = "#FFF6C8"; ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
      }
      if (fige) { ctx.globalAlpha = alpha * 0.35; ctx.fillStyle = "#CFE8FF"; ctx.fillRect(cx - s / 2, cy - s / 2, s, s); }
      ctx.restore();
      cheminArrondi(cx - s / 2, cy - s / 2, s, s, s * 0.1);
      ctx.lineWidth = boss ? 3.5 : e.elite ? 3 : 1.8;
      ctx.strokeStyle = boss ? "#FF5C5C" : e.elite ? "#FFD34D" : e.brule ? "#FF8A3D" : e.expose > 0 ? "#FFF3A0"
        : e.ralenti > 0 ? "#9FD8FF" : couleur;
      ctx.stroke();
      if (e.pv < e.pvMax && !boss) {
        const bh = Math.max(3, T * 0.07 * Math.min(t, 2));
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(cx - s / 2, cy + s / 2 + 1, s, bh);
        ctx.fillStyle = e.elite ? "#FFD34D" : "#FF5C5C";
        ctx.fillRect(cx - s / 2, cy + s / 2 + 1, s * Math.max(0, e.pv) / e.pvMax, bh);
      }
      ctx.restore();
    }
  }

  /* Le duelliste : un jeton d'or frappé du Puzzle du Millénaire pour Yugi,
     d'un dé pour Joey, le joueur de pile ou face, d'une plume de harpie
     pour Mai, des initiales de la Kaiba Corporation pour Kaiba, du Collier
     du Millénaire pour Ishizu. */
  function dessineJoueur(now, sx, sy) {
    let cx = W / 2 + sx, cy = H / 2 + sy;
    if (BUTE) {
      const q = (now - BUTE.t) / 160;
      if (q < 1) { const f = Math.sin(q * Math.PI) * T * 0.16; cx += BUTE.dx * f; cy += BUTE.dy * f; }
      else BUTE = null;
    }
    const r = T * 0.36;
    const halo = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.3);
    halo.addColorStop(0, "rgba(255,215,100,0.33)");
    halo.addColorStop(1, "rgba(255,215,100,0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, r * 2.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#1A1208"; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#F0D080"; ctx.stroke();
    const frappe = { joey: dessineDe, mai: dessinePlume, kaiba: dessineKC, ishizu: dessineCollier }[ETAT.duelliste];
    if (frappe) { frappe(cx, cy, r); return; }
    const t = r * 0.64;
    ctx.beginPath();
    ctx.moveTo(cx - t, cy - t * 0.6); ctx.lineTo(cx + t, cy - t * 0.6); ctx.lineTo(cx, cy + t * 0.95);
    ctx.closePath();
    const g = ctx.createLinearGradient(cx, cy - t, cx, cy + t);
    g.addColorStop(0, "#FFF0B0"); g.addColorStop(1, "#B8860B");
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = "#3A2A08"; ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath(); ctx.ellipse(cx, cy - t * 0.12, t * 0.36, t * 0.17, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#3A2A08";
    ctx.beginPath(); ctx.arc(cx, cy - t * 0.12, t * 0.1, 0, Math.PI * 2); ctx.fill();
  }

  /* Le dé de Joey : d'or, un peu penché, sur sa face à cinq points. */
  function dessineDe(cx, cy, r) {
    const c = r * 1.06;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.22);
    cheminArrondi(-c / 2, -c / 2, c, c, c * 0.2);
    const g = ctx.createLinearGradient(0, -c / 2, 0, c / 2);
    g.addColorStop(0, "#FFF0B0"); g.addColorStop(1, "#B8860B");
    ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = "#3A2A08";
    const k = c * 0.26;
    for (const [px, py] of [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]) {
      ctx.beginPath(); ctx.arc(px * k, py * k, c * 0.085, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function orJeton(y0, y1) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, "#FFF0B0"); g.addColorStop(1, "#B8860B");
    return g;
  }

  /* La plume de Mai : penchée, son rachis et ses barbes en creux. */
  function dessinePlume(cx, cy, r) {
    const l = r * 0.72, w = l * 0.42;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(0.65);
    ctx.beginPath();
    ctx.moveTo(0, l * 0.8);
    ctx.quadraticCurveTo(w * 1.3, -l * 0.1, 0, -l);
    ctx.quadraticCurveTo(-w * 1.3, -l * 0.1, 0, l * 0.8);
    ctx.fillStyle = orJeton(-l, l); ctx.fill();
    ctx.strokeStyle = "#3A2A08"; ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1, r * 0.09);
    ctx.beginPath(); ctx.moveTo(0, l * 1.2); ctx.lineTo(0, -l * 0.85); ctx.stroke();
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const y = -l * 0.45 + k * l * 0.38;
      ctx.moveTo(0, y + l * 0.12); ctx.lineTo(w * 0.62, y - l * 0.04);
      ctx.moveTo(0, y + l * 0.12); ctx.lineTo(-w * 0.62, y - l * 0.04);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* Les initiales de la Kaiba Corporation, celles de sa boucle de ceinture. */
  function dessineKC(cx, cy, r) {
    ctx.save();
    ctx.font = `700 ${Math.round(r * 0.92)}px Cinzel, Georgia, serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = orJeton(cy - r * 0.5, cy + r * 0.5);
    ctx.fillText("KC", cx, cy + r * 0.05);
    ctx.restore();
  }

  /* Le Collier du Millénaire d'Ishizu : un anneau d'or, et l'Œil Oudjat
     au milieu : l'amande, sa pupille, le sourcil et la larme. */
  function dessineCollier(cx, cy, r) {
    const t = r * 0.64, g = orJeton(cy - t, cy + t);
    const ex = cx, ey = cy - t * 0.05, w = t * 0.6, h = t * 0.24;
    ctx.save();
    ctx.strokeStyle = g; ctx.fillStyle = g; ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.beginPath(); ctx.arc(cx, cy, t, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.moveTo(ex - w, ey); ctx.quadraticCurveTo(ex, ey - h * 2, ex + w, ey);
    ctx.quadraticCurveTo(ex, ey + h * 2, ex - w, ey);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(ex, ey, h * 0.75, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(ex - w * 0.85, ey - h * 1.6); ctx.quadraticCurveTo(ex, ey - h * 2.7, ex + w * 0.85, ey - h * 1.6);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ex - w * 0.12, ey + h * 1.05); ctx.lineTo(ex - w * 0.22, ey + h * 2.5); ctx.stroke();
    ctx.restore();
  }

  /* ---------- les effets ---------- */
  function eclair(x0, y0, x1, y1, graine) {
    let s = graine;
    const alea = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    const n = 7;
    for (let i = 1; i < n; i++) {
      const q = i / n;
      ctx.lineTo(x0 + (x1 - x0) * q + alea() * T * 0.5, y0 + (y1 - y0) * q + alea() * T * 0.2);
    }
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  /* Ce que dure le dessin de chaque attaque, en ms (260 sinon). */
  const DUREES_TIR = { souffle: 320, sort: 300, meute: 300, bombe: 360, flammes: 320, seisme: 420, raz: 380, tourbillon: 400,
                       corne: 300, serres: 320, rayons: 340 };

  /* Les serres : la Bête Ailée monte puis fond sur la proie en `c`, et la
     saisit. */
  function dessineSerres(f, p, jx, jy, c) {
    const [tx, ty] = centre(c.x, c.y);
    const q = Math.min(1, p * 2.2);
    const mx = (jx + tx) / 2, my = Math.min(jy, ty) - T * 1.5;
    ctx.strokeStyle = f.couleur; ctx.lineWidth = 3;
    ctx.shadowColor = f.couleur; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.moveTo(jx, jy);
    for (let k = 1; k <= 20; k++) {
      const u = k / 20 * q;
      ctx.lineTo((1 - u) * (1 - u) * jx + 2 * (1 - u) * u * mx + u * u * tx,
                 (1 - u) * (1 - u) * jy + 2 * (1 - u) * u * my + u * u * ty);
    }
    ctx.stroke();
    if (q >= 1) {
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        const x0 = tx - T * 0.22 + k * T * 0.16, y0 = ty - T * 0.28;
        ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x0 + T * 0.12, y0 + T * 0.25, x0 + T * 0.04, y0 + T * 0.5);
      }
      ctx.stroke();
    }
  }

  /* Chaque attaque a son dessin ; la couleur de l'attribut le teinte. */
  function dessineTir(f, p) {
    const jx = W / 2, jy = H / 2;
    const a = 1 - p;
    ctx.globalAlpha = Math.max(0, a);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    switch (f.motif) {
      case "souffle": {
        const centres = f.centres || [];
        if (p < 0.45) {
          const q = p / 0.45;
          ctx.globalAlpha = 1;
          ctx.fillStyle = f.couleur; ctx.shadowColor = f.couleur; ctx.shadowBlur = 18;
          for (const c of centres) {
            const [tx, ty] = centre(c.x, c.y);
            ctx.beginPath();
            ctx.arc(jx + (tx - jx) * q, jy + (ty - jy) * q - Math.sin(q * Math.PI) * T * 0.6, T * 0.18, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          const q = (p - 0.45) / 0.55;
          ctx.globalAlpha = (1 - q) * 0.55;
          ctx.fillStyle = f.couleur;
          for (const c of f.cases) ctx.fillRect(O.x + c.x * T, O.y + c.y * T, T, T);
          ctx.globalAlpha = 1 - q;
          ctx.strokeStyle = "#FFF1D0"; ctx.lineWidth = 3;
          for (const c of centres) {
            const [tx, ty] = centre(c.x, c.y);
            ctx.beginPath(); ctx.arc(tx, ty, T * (0.3 + 1.3 * q), 0, Math.PI * 2); ctx.stroke();
          }
        }
        break;
      }
      case "sort": {
        // un trait qui court de cible en cible
        const pts = [[jx, jy]].concat((f.chemin || []).map((c) => centre(c.x, c.y)));
        const q = Math.min(1, p * 1.8);
        const nb = (pts.length - 1) * q;
        ctx.strokeStyle = f.couleur; ctx.lineWidth = 4;
        ctx.shadowColor = f.couleur; ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          if (i - 1 > nb) break;
          const r = Math.min(1, nb - (i - 1));
          ctx.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * r, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * r);
        }
        ctx.stroke();
        ctx.fillStyle = "#FFFFFF";
        for (let i = 1; i < pts.length && i - 1 <= nb; i++) {
          ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], T * 0.12 * a + 2, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case "malediction": {
        // une ombre qui tombe d'en haut sur sa proie
        const c = (f.chemin || [])[0];
        if (!c) break;
        const [tx, ty] = centre(c.x, c.y);
        ctx.strokeStyle = f.couleur; ctx.lineWidth = 6 * a + 2;
        ctx.shadowColor = f.couleur; ctx.shadowBlur = 20;
        ctx.beginPath(); ctx.moveTo(tx, ty - T * 2.6 * (1 - Math.min(1, p * 2.2))); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.beginPath(); ctx.arc(tx, ty, T * (0.25 + 0.6 * p), 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case "taille": {
        ctx.fillStyle = f.couleur;
        ctx.globalAlpha = a * 0.22;
        for (const c of f.cases) ctx.fillRect(O.x + c.x * T, O.y + c.y * T, T, T);
        ctx.globalAlpha = a;
        ctx.strokeStyle = f.couleur; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(jx, jy, T * (0.5 + (f.anneau + 0.4) * p), 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case "flammes": {
        // le feu court de toi vers le bout du cône, rangée après rangée (3,
        // 5 puis 7 cases : la k-ième rangée finit à la case (k + 1)² − 2)
        f.cases.forEach((c, i) => {
          const k = Math.ceil(Math.sqrt(i + 2)) - 1;
          const q = Math.min(1, Math.max(0, p * 2.4 - (k - 1) * 0.35));
          if (!q) return;
          ctx.globalAlpha = q * a * 0.75;
          ctx.fillStyle = k === 1 ? "#FFE08A" : k === 2 ? "#FF9A3D" : "#E0461E";
          ctx.fillRect(O.x + c.x * T + 1, O.y + c.y * T + 1, T - 2, T - 2);
        });
        break;
      }
      case "seisme": {
        // une onde part de toi jusqu'au bord de l'écran, et la poussière
        // saute sous chaque monstre touché
        ctx.strokeStyle = f.couleur; ctx.lineWidth = 6 * a + 2;
        ctx.globalAlpha = a * 0.8;
        ctx.beginPath(); ctx.arc(jx, jy, Math.hypot(W, H) * 0.6 * Math.min(1, p * 1.4), 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = "#C9A06A";
        ctx.globalAlpha = a;
        const h = Math.sin(Math.min(1, p * 1.6) * Math.PI) * T * 0.28;
        for (const c of f.cases) {
          const [tx, ty] = centre(c.x, c.y);
          for (let k = -1; k <= 1; k++) ctx.fillRect(tx + k * T * 0.22 - 2, ty + T * 0.32 - h * (1 - Math.abs(k) * 0.4) - 2, 4, 4);
        }
        break;
      }
      case "raz": {
        // la vague balaie la rangée d'un bout à l'autre, l'écume en tête
        const n = f.cases.length, front = p * 1.25 * n;
        ctx.fillStyle = f.couleur;
        ctx.globalAlpha = a * 0.5;
        f.cases.forEach((c, i) => { if (i <= front) ctx.fillRect(O.x + c.x * T, O.y + c.y * T, T, T); });
        const c = f.cases[Math.floor(front)];
        if (c) {
          const [tx, ty] = centre(c.x, c.y);
          ctx.globalAlpha = a; ctx.strokeStyle = "#E8F6FF"; ctx.lineWidth = 4;
          ctx.shadowColor = f.couleur; ctx.shadowBlur = 12;
          ctx.beginPath();
          if (f.rangee === "h") { ctx.moveTo(tx, ty - T * 0.5); ctx.lineTo(tx, ty + T * 0.5); }
          else { ctx.moveTo(tx - T * 0.5, ty); ctx.lineTo(tx + T * 0.5, ty); }
          ctx.stroke();
        }
        break;
      }
      case "piqure": {
        // un dard file vers sa cible, puis l'onde de la paralysie
        const c = (f.chemin || [])[0];
        if (!c) break;
        const [tx, ty] = centre(c.x, c.y);
        const q = Math.min(1, p * 3), q0 = Math.max(0, q - 0.3);
        ctx.strokeStyle = f.couleur; ctx.lineWidth = 2.5;
        ctx.shadowColor = f.couleur; ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(jx + (tx - jx) * q0, jy + (ty - jy) * q0); ctx.lineTo(jx + (tx - jx) * q, jy + (ty - jy) * q);
        ctx.stroke();
        if (q >= 1) {
          ctx.globalAlpha = a; ctx.strokeStyle = "#D8FF7A";
          ctx.beginPath(); ctx.arc(tx, ty, T * (0.2 + 0.5 * (p - 1 / 3) * 1.5), 0, Math.PI * 2); ctx.stroke();
        }
        break;
      }
      case "foudre":
        ctx.strokeStyle = "#FFF6C8"; ctx.lineWidth = 3;
        ctx.shadowColor = f.couleur; ctx.shadowBlur = 16;
        f.cases.forEach((c, i) => {
          const [tx, ty] = centre(c.x, c.y);
          eclair(tx + T * 0.3, ty - T * 3, tx, ty, f.graine + i * 7);
          ctx.fillStyle = "rgba(255,240,170,0.5)";
          ctx.beginPath(); ctx.arc(tx, ty, T * 0.4 * a, 0, Math.PI * 2); ctx.fill();
        });
        break;
      case "meute":
        // la meute bondit sur chaque proie et la griffe
        for (const c of f.chemin || []) {
          const [tx, ty] = centre(c.x, c.y);
          const q = Math.min(1, p * 2.4), q0 = Math.max(0, q - 0.35);
          ctx.strokeStyle = f.couleur; ctx.lineWidth = 3;
          ctx.shadowColor = f.couleur; ctx.shadowBlur = 12;
          ctx.beginPath(); ctx.moveTo(jx + (tx - jx) * q0, jy + (ty - jy) * q0); ctx.lineTo(jx + (tx - jx) * q, jy + (ty - jy) * q);
          ctx.stroke();
          if (q >= 1) {
            const l = T * 0.5 * Math.min(1, (p - 0.42) * 4);
            ctx.beginPath();
            for (let k = -1; k <= 1; k++) {
              const x0 = tx - T * 0.25 + k * T * 0.17, y0 = ty - T * 0.25;
              ctx.moveTo(x0, y0); ctx.lineTo(x0 + l, y0 + l);
            }
            ctx.stroke();
          }
        }
        break;
      case "bombe": {
        // chaque bombe part en cloche vers sa cible
        const u = Math.min(1, p * 1.3);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#1B1B22"; ctx.strokeStyle = f.couleur; ctx.lineWidth = 2;
        for (const c of f.cases) {
          const [tx, ty] = centre(c.x, c.y);
          const x = jx + (tx - jx) * u, y = jy + (ty - jy) * u - Math.sin(u * Math.PI) * T * 1.6;
          ctx.beginPath(); ctx.arc(x, y, T * 0.18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        break;
      }
      case "rayons": {
        // huit rayons de lumière partent de toi, puis s'éteignent ; les
        // cases vont par rayon, de la plus proche à la plus loin
        const n = f.cases.length / 8, q = Math.min(1, p * 3);
        ctx.globalAlpha = p < 0.35 ? 1 : a / 0.65;
        ctx.shadowColor = f.couleur; ctx.shadowBlur = 14;
        for (let d = 0; d < 8; d++) {
          const bout = f.cases[(d + 1) * n - 1];
          const [tx, ty] = centre(bout.x, bout.y);
          const x = jx + (tx - jx) * q, y = jy + (ty - jy) * q;
          ctx.strokeStyle = f.couleur; ctx.lineWidth = T * 0.34;
          ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(x, y); ctx.stroke();
          ctx.strokeStyle = "#FFFFF0"; ctx.lineWidth = T * 0.1;
          ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(x, y); ctx.stroke();
        }
        break;
      }
      case "corne": {
        // la charge : une traînée jusqu'à la cible, puis le choc
        const c = (f.chemin || [])[0];
        if (!c) break;
        const [tx, ty] = centre(c.x, c.y);
        const q = Math.min(1, p * 2.5);
        ctx.strokeStyle = f.couleur; ctx.shadowColor = f.couleur; ctx.shadowBlur = 12;
        ctx.globalAlpha = a * 0.7; ctx.lineWidth = T * 0.3 * (1 - p * 0.7);
        ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(jx + (tx - jx) * q, jy + (ty - jy) * q); ctx.stroke();
        if (q >= 1) {
          ctx.globalAlpha = a; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.arc(tx, ty, T * (0.3 + 0.5 * p), 0, Math.PI * 2); ctx.stroke();
        }
        break;
      }
      case "tourbillon": {
        // trois bras d'eau qui tournent et se resserrent sur la proie
        const c = (f.centres || [])[0];
        if (!c) break;
        const [tx, ty] = centre(c.x, c.y);
        ctx.strokeStyle = f.couleur; ctx.lineWidth = 2.5;
        ctx.shadowColor = f.couleur; ctx.shadowBlur = 10;
        for (let b = 0; b < 3; b++) {
          ctx.beginPath();
          for (let k = 0; k <= 40; k++) {
            const u = k / 40, ang = b * Math.PI * 2 / 3 + u * Math.PI * 2.2 + p * Math.PI * 3;
            const r = T * 2.4 * (1 - u) * (1 - p * 0.5);
            ctx.lineTo(tx + Math.cos(ang) * r, ty + Math.sin(ang) * r * 0.85);
          }
          ctx.stroke();
        }
        break;
      }
      case "serres": {
        // la Bête Ailée monte puis fond sur sa proie, et la saisit (les
        // Sœurs de Harpie, sur trois proies)
        for (const c of f.chemin || []) dessineSerres(f, p, jx, jy, c);
        break;
      }
      case "vorace": {
        // deux rangées de crocs qui se referment sur la proie
        const c = (f.chemin || [])[0];
        if (!c) break;
        const [tx, ty] = centre(c.x, c.y);
        const ecart = T * 0.42 * (1 - Math.min(1, p * 2.5));
        ctx.globalAlpha = p < 0.4 ? 1 : 1 - (p - 0.4) / 0.6;
        ctx.strokeStyle = f.couleur; ctx.lineWidth = 3;
        ctx.shadowColor = f.couleur; ctx.shadowBlur = 10;
        for (const sens of [-1, 1]) {
          const y = ty + sens * (ecart + T * 0.05);
          ctx.beginPath();
          for (let k = 0; k <= 6; k++) ctx.lineTo(tx - T * 0.3 + k * T * 0.1, k % 2 ? y - sens * T * 0.13 : y);
          ctx.stroke();
        }
        break;
      }
    }
  }

  function dessineEffets(now) {
    EFFETS = EFFETS.filter((f) => now < f.debut + f.duree);
    for (const f of EFFETS) {
      const p = (now - f.debut) / f.duree;
      if (p < 0) continue;
      ctx.save();
      switch (f.type) {
        case "tir":
          dessineTir(f, p);
          break;
        case "mort": {
          const [cx, cy] = centre(f.x, f.y);
          const s = T * (f.taille === 1 ? 0.82 : f.taille - 0.12) * (1 - p * 0.6);
          const im = image(f.id);
          ctx.globalAlpha = 1 - p;
          if (im) ctx.drawImage(im, cx - s / 2, cy - s / 2, s, s);
          ctx.fillStyle = f.couleur;
          for (const a of f.eclats) {
            const d = T * (0.2 + 0.8 * p) * a.v * f.taille;
            ctx.fillRect(cx + Math.cos(a.a) * d - 2, cy + Math.sin(a.a) * d - 2, 4, 4);
          }
          break;
        }
        case "frappe": {
          const [ex, ey] = centre(f.x, f.y);
          ctx.globalAlpha = 1 - p;
          ctx.strokeStyle = f.couleur; ctx.lineWidth = 3; ctx.lineCap = "round";
          const mx = (ex + W / 2) / 2, my = (ey + H / 2) / 2;
          ctx.beginPath(); ctx.moveTo(mx - T * 0.2, my - T * 0.2); ctx.lineTo(mx + T * 0.2, my + T * 0.2); ctx.stroke();
          break;
        }
        case "explosion":
          ctx.globalAlpha = 1 - p;
          ctx.fillStyle = "rgba(255,90,40,0.7)";
          for (const k of f.cases) {
            const [x, y] = k.split(",").map(Number);
            ctx.fillRect(O.x + x * T, O.y + y * T, T, T);
          }
          break;
        case "eclairs":
          ctx.globalAlpha = p < 0.15 ? 0.6 : 0.6 * (1 - p);
          ctx.fillStyle = "#FFFBE6"; ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1 - p;
          ctx.strokeStyle = "#FFF6C8"; ctx.lineWidth = 3; ctx.shadowColor = "#FFE066"; ctx.shadowBlur = 20;
          for (let i = 0; i < 9; i++) { const x = (i + 0.5) / 9 * W; eclair(x, -10, x + (i % 3 - 1) * T, H + 10, 13 + i * 31); }
          break;
        case "exodia": {
          // le Interdit se lève sur tout l'écran, dans un éclat d'or
          ctx.globalAlpha = p < 0.12 ? p / 0.12 * 0.85 : 0.85 * (1 - p);
          ctx.fillStyle = "#FFE7A0"; ctx.fillRect(0, 0, W, H);
          const im = image(STOCK.exodia[0]);
          if (im) {
            const s = Math.min(W, H) * (0.55 + 0.25 * p);
            ctx.globalAlpha = Math.sin(Math.min(1, p * 1.2) * Math.PI);
            ctx.shadowColor = "#FFB54D"; ctx.shadowBlur = 40;
            ctx.drawImage(im, W / 2 - s / 2, H / 2 - s / 2, s, s);
          }
          break;
        }
        case "epees":
          ctx.globalAlpha = 1 - p;
          ctx.fillStyle = "#FFE58A"; ctx.shadowColor = "#FFD34D"; ctx.shadowBlur = 16;
          for (let i = 0; i < 3; i++) {
            const a = i / 3 * Math.PI * 2 + p;
            const x = W / 2 + Math.cos(a) * T * 1.4, y = H / 2 + Math.sin(a) * T * 1.4 - (1 - Math.min(1, p * 3)) * H * 0.5;
            ctx.fillRect(x - 2, y - T * 0.5, 4, T);
            ctx.fillRect(x - T * 0.15, y + T * 0.2, T * 0.3, 3);
          }
          break;
        case "ramasse": {
          const [bx, by] = centre(f.x, f.y);
          ctx.globalAlpha = 1 - p * 0.5;
          etoile(bx + (W / 2 - bx) * p, by + (H / 2 - by) * p, T * 0.12 * (1 - p * 0.5), couleurXp(f.xp));
          break;
        }
        case "projection": {
          // la cible du coup de corne vole en arrière (son image, si elle
          // est morte : vivante, elle glisse d'elle-même), puis le choc
          const [x0, y0] = centre(f.de.x, f.de.y), [x1, y1] = centre(f.vers.x, f.vers.y);
          const q = Math.min(1, p * 2);
          const x = x0 + (x1 - x0) * q, y = y0 + (y1 - y0) * q;
          ctx.globalAlpha = 1 - p;
          ctx.strokeStyle = "rgba(220,190,140,0.8)"; ctx.lineWidth = T * 0.18; ctx.lineCap = "round";
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x, y); ctx.stroke();
          const im = f.morte ? image(f.id) : null;
          if (im) { const s = T * 0.7; ctx.drawImage(im, x - s / 2, y - s / 2, s, s); }
          if (f.heurte && q >= 1) {
            const [hx, hy] = centre((f.vers.x + f.heurte.x) / 2, (f.vers.y + f.heurte.y) / 2);
            ctx.strokeStyle = "#FFE9B0"; ctx.lineWidth = 3;
            ctx.beginPath();
            for (let k = 0; k < 8; k++) {
              const ang = k / 8 * Math.PI * 2, r0 = T * 0.15, r1 = T * (0.35 + 0.35 * p);
              ctx.moveTo(hx + Math.cos(ang) * r0, hy + Math.sin(ang) * r0);
              ctx.lineTo(hx + Math.cos(ang) * r1, hy + Math.sin(ang) * r1);
            }
            ctx.stroke();
          }
          break;
        }
        case "boum": {
          // la bombe souffle sa zone : un éclair orange, puis l'onde
          const r = f.r;
          ctx.globalAlpha = (1 - p) * 0.55;
          ctx.fillStyle = "#FF8A2A";
          ctx.fillRect(O.x + (f.x - r) * T, O.y + (f.y - r) * T, (2 * r + 1) * T, (2 * r + 1) * T);
          const [cx, cy] = centre(f.x, f.y);
          ctx.globalAlpha = 1 - p;
          ctx.strokeStyle = "#FFE2A0"; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.arc(cx, cy, T * (0.4 + (r + 0.6) * p), 0, Math.PI * 2); ctx.stroke();
          break;
        }
        case "chapeau": {
          // un haut-de-forme qui se pose puis s'envole
          const [cx, cy] = centre(f.x, f.y);
          const lev = f.arrivee ? (1 - p) : p;
          ctx.globalAlpha = f.arrivee ? 1 - p * 0.6 : 1 - p;
          ctx.fillStyle = "#2B1D3A"; ctx.strokeStyle = "#C9A8FF"; ctx.lineWidth = 2;
          const y = cy - T * 0.2 - lev * T * 0.8;
          ctx.fillRect(cx - T * 0.28, y - T * 0.42, T * 0.56, T * 0.42);
          ctx.strokeRect(cx - T * 0.28, y - T * 0.42, T * 0.56, T * 0.42);
          ctx.fillRect(cx - T * 0.42, y, T * 0.84, T * 0.08);
          ctx.strokeRect(cx - T * 0.42, y, T * 0.84, T * 0.08);
          break;
        }
        case "emporte": {
          // le monstre emporté file en l'air jusqu'au bord de l'écran
          const [x0, y0] = centre(f.de.x, f.de.y), [x1, y1] = centre(f.vers.x, f.vers.y);
          const u = Math.min(1, p * 1.1);
          const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - T * 2;
          const x = (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * mx + u * u * x1;
          const y = (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * my + u * u * y1;
          const im = image(f.id), s = T * 0.72;
          ctx.globalAlpha = p < 0.85 ? 1 : (1 - p) / 0.15;
          if (im) ctx.drawImage(im, x - s / 2, y - s / 2, s, s);
          ctx.strokeStyle = f.couleur; ctx.lineWidth = 2.5; ctx.lineCap = "round";
          ctx.beginPath();
          for (let k = -1; k <= 1; k++) { ctx.moveTo(x + k * s * 0.3, y - s * 0.62); ctx.lineTo(x + k * s * 0.22, y - s * 0.4); }
          ctx.stroke();
          break;
        }
        case "anneau": {
          const [cx, cy] = f.x == null ? [W / 2, H / 2] : centre(f.x, f.y);
          ctx.globalAlpha = 1 - p;
          ctx.strokeStyle = f.couleur; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.arc(cx, cy, T * (0.3 + f.rayon * p), 0, Math.PI * 2); ctx.stroke();
          break;
        }
      }
      ctx.restore();
    }
  }

  function nombre(x, y, texte, couleur, taille) {
    NOMBRES.push({ x, y, texte, couleur, taille: taille || 1, debut: performance.now(),
                   dx: (Math.random() - 0.5) * 0.5 });
  }

  function dessineNombres(now) {
    NOMBRES = NOMBRES.filter((n) => now - n.debut < 750);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const n of NOMBRES) {
      const p = (now - n.debut) / 750;
      const [cx, cy] = centre(n.x + n.dx * p, n.y - 0.25 - p * 0.7);
      ctx.globalAlpha = p < 0.65 ? 1 : (1 - p) / 0.35;
      ctx.font = `700 ${Math.round(T * 0.34 * n.taille)}px Cinzel, Georgia, serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(n.texte, cx, cy);
      ctx.fillStyle = n.couleur;
      ctx.fillText(n.texte, cx, cy);
    }
    ctx.globalAlpha = 1;
  }

  /* =========================================================
     Ce que le moteur raconte
     ========================================================= */
  function traite(ev) {
    if (ETAT.attente) ev = gardeExodia(ev);
    const now = performance.now();
    const j = ETAT.joueur;
    let horde = 0;
    for (const e of ev) {
      // les ennemis frappent un instant après tes monstres : on voit les deux
      if (e.t === "frappe" || e.t === "explosion" || e.t === "annonce") horde = 90;
      switch (e.t) {
        case "tir":
          EFFETS.push({ type: "tir", motif: e.motif, couleur: e.couleur, cases: e.cases, centres: e.centres,
                        chemin: e.chemin, anneau: e.anneau, rangee: e.rangee, graine: Math.floor(Math.random() * 1000),
                        debut: now, duree: DUREES_TIR[e.motif] || 260 });
          if (e.motif === "seisme") { SECOUSSE.force = Math.max(SECOUSSE.force, 3); SECOUSSE.t = now; }
          TIRS.add(e.zone);
          break;
        case "coup": {
          const p = POS.get(e.uid);
          if (p) p.flash = now + 50;
          nombre(e.x, e.y, String(e.n), e.n >= 60 ? "#FFD34D" : "#FFFFFF", e.n >= 60 ? 1.25 : 1);
          break;
        }
        case "mort": {
          const p = POS.get(e.uid);
          const t = e.taille || 1;
          const pos = p ? { x: p.x + (t - 1) / 2, y: p.y + (t - 1) / 2 } : { x: e.x, y: e.y };
          const c = M.carte(e.id);
          const eclats = [];
          for (let i = 0; i < 8; i++) eclats.push({ a: i / 8 * Math.PI * 2 + Math.random() * 0.5, v: 0.6 + Math.random() * 0.6 });
          EFFETS.push({ type: "mort", x: pos.x, y: pos.y, id: e.id, taille: t, eclats, debut: now + 40, duree: 380,
                        couleur: (M.ATTRIBUTS[c.attribut] || M.ATTRIBUTS.DARK).couleur });
          if (e.boss) { SECOUSSE.force = 10; SECOUSSE.t = now; annonce(c.nom + " est vaincu !", "boss"); }
          break;
        }
        case "frappe": {
          const p = POS.get(e.uid);
          if (p) p.elan = { dx: Math.sign(j.x - e.x), dy: Math.sign(j.y - e.y), t: now + horde };
          break;
        }
        case "lp":
          if (e.n < 0) {
            SECOUSSE.force = Math.min(9, 2 + -e.n / 350); SECOUSSE.t = now + horde;
            if (e.de) EFFETS.push({ type: "frappe", x: e.de.x, y: e.de.y, couleur: "#FF4A4A", debut: now + horde, duree: 200 });
            nombre(j.x, j.y + 0.3, String(e.n), "#FF5C5C", 1.1);
          } else if (e.n >= 10) nombre(j.x, j.y, "+" + e.n, "#4CFF91", 0.9);
          break;
        case "explosion":
          EFFETS.push({ type: "explosion", cases: e.cases, debut: now + horde, duree: 420 });
          break;
        case "projection":
          EFFETS.push({ type: "projection", de: e.de, vers: e.vers, heurte: e.heurte, id: e.id,
                        morte: !ETAT.ennemis.some((x) => x.uid === e.uid), debut: now + 60, duree: 360 });
          break;
        case "annonce":
          annonce(e.nom + " !", "boss");
          break;
        case "eclairs":
          EFFETS.push({ type: "eclairs", debut: now, duree: 650 });
          break;
        case "epees":
          EFFETS.push({ type: "epees", debut: now, duree: 800 });
          break;
        case "ramasse":
          if (e.xp) EFFETS.push({ type: "ramasse", x: e.x, y: e.y, xp: e.xp, debut: now, duree: 240 });
          break;
        case "piege":
          EFFETS.push({ type: "anneau", x: e.x, y: e.y, couleur: "#FF6AB8", rayon: 1.6, debut: now + horde, duree: 400 });
          break;
        case "pose-sol":
          EFFETS.push({ type: "anneau", x: e.x, y: e.y, couleur: "#E06AA6", rayon: 0.8, debut: now, duree: 350 });
          break;
        case "joue": {
          const c = M.carte(e.id);
          if (M.place(c) === "effet" && c.effet !== "fusion") annonce(c.nom + " !", "");
          break;
        }
        case "invoque": {
          ARRIVEES.add("m" + e.zone);
          const c = M.carte(e.id);
          if (!e.jeton && c.niveau >= 5) annonce(c.nom + " !", M.estFusion(c) ? "boss" : "");
          break;
        }
        case "pose": ARRIVEES.add("z" + e.zone); break;
        case "terrain": ARRIVEES.add("t0"); annonce(M.carte(e.id).nom + " !", ""); break;
        case "pioche":
        case "recoit": NOUVELLES.add(e.id); break;
        case "defausse": annonce("Appel du tonnerre !", ""); break;
        case "etoile": annonce(`${M.carte(e.id).nom} ${"★".repeat(e.n - 1)}`, ""); break;
        case "niveau": NIVEAUX.push(e.niveau); nombre(j.x, j.y - 0.4, "Niveau " + e.niveau, "#F0D080", 1); break;
        case "garde":
          annonce(e.texte, "");
          if (e.zone != null) TOUCHEES.add(e.zone);
          if (e.miroir) EFFETS.push({ type: "anneau", couleur: "#BFE3FF", rayon: 2.6, debut: now, duree: 450 });
          break;
        case "piece": annonce(e.pile ? "Pile ! Le temps les balaie." : "Face... le temps se retourne contre toi.", e.pile ? "" : "info"); break;
        case "exodia": annonce(`Pièce d'Exodia : ${e.n} sur 5`, "exodia"); break;
        case "exodia-complet":
          EFFETS.push({ type: "exodia", debut: now, duree: 1300 });
          SECOUSSE.force = 12; SECOUSSE.t = now;
          annonce("Exodia, oblitération !", "exodia");
          break;
        case "dans-deck": annonce(`${M.carte(e.id).nom} est ajouté à ton deck.`, ""); break;
        case "main-au-deck": annonce(`Ta main repart dans ton deck.`, "info"); break;
        case "annule": annonce(`${e.nom} : annulé !`, "info"); break;
        case "de": annonce(`${M.carte(e.id).nom} : ${e.n} !`, ""); break;
        case "relance": annonce(e.reste ? `Relance : encore ${e.reste}.` : "Dernière relance !", "info"); break;
        case "boum":
          EFFETS.push({ type: "boum", x: e.x, y: e.y, r: e.r, debut: now, duree: 420 });
          SECOUSSE.force = Math.max(SECOUSSE.force, 4); SECOUSSE.t = now;
          break;
        case "chapeaux":
          EFFETS.push({ type: "chapeau", x: e.de.x, y: e.de.y, arrivee: false, debut: now, duree: 420 });
          EFFETS.push({ type: "chapeau", x: e.vers.x, y: e.vers.y, arrivee: true, debut: now + 200, duree: 420 });
          break;
        case "bannies": annonce(`${e.ids.length} carte${e.ids.length > 1 ? "s" : ""} retirée${e.ids.length > 1 ? "s" : ""} de ton deck.`, ""); break;
        case "coeur": annonce(`${M.carte(e.id).nom} passe de ton côté !`, ""); break;
        case "copie": annonce(`Copiechat copie ${M.carte(e.id).nom} !`, ""); break;
        case "quitte": if (e.raison === "fin") annonce(`${M.carte(e.id).nom} repart.`, "info"); break;
        case "emporte": {
          const p = POS.get(e.uid), en = ETAT.ennemis.find((x) => x.uid === e.uid);
          // il n'atterrit qu'à la fin du vol
          if (p && en) { p.x = en.x; p.y = en.y; p.ne = now + 300; }
          EFFETS.push({ type: "emporte", de: e.de, vers: e.vers, id: e.id, couleur: "#7FEDAA", debut: now + 60, duree: 360 });
          break;
        }
        case "message": annonce(e.texte, e.genre); break;
        case "plumeau": EFFETS.push({ type: "anneau", couleur: "#7FEDAA", rayon: 4.5, debut: now, duree: 520 }); break;
      }
    }
  }

  /* La cinquième pièce d'Exodia ramassée au tour où un booster s'ouvre :
     son oblitération se jouerait sous le voile du booster. Elle attend
     qu'on l'ait refermé, avec les coups et les morts qu'elle cause. */
  function gardeExodia(ev) {
    const i = ev.findIndex((e) => e.t === "exodia-complet");
    if (i < 0) return ev;
    const debut = i > 0 && ev[i - 1].t === "exodia" ? i - 1 : i;
    let fin = i + 1;
    while (fin < ev.length && (ev[fin].t === "coup" || ev[fin].t === "mort")) fin++;
    EXODIA_GARDEE = ev.slice(debut, fin);
    return ev.slice(0, debut).concat(ev.slice(fin));
  }

  function annonce(texte, genre) {
    const boite = el("annonces");
    while (boite.children.length >= 3) boite.firstChild.remove();
    const d = document.createElement("div");
    // préfixées : « boss » est aussi la classe de la jauge du boss
    d.className = "annonce" + (genre ? " a-" + genre : "");
    d.textContent = texte;
    boite.appendChild(d);
    setTimeout(() => d.remove(), 1900);
  }

  /* =========================================================
     Jouer
     ========================================================= */
  function enJeu() { return !!ETAT && !ETAT.fini && !ETAT.attente && !PAUSE && !PILE; }

  /* Un geste passe au moteur, à la cadence au plus : arrivé trop tôt, il
     attend son tour, et un plus récent le remplace. */
  function geste(g) {
    if (!enJeu()) return;
    const attente = CADENCE - (performance.now() - DERNIER);
    if (attente <= 0 && !MINUTEUR) { execute(g); return; }
    FILE = g;
    if (!MINUTEUR) {
      MINUTEUR = setTimeout(() => {
        MINUTEUR = null;
        const f = FILE; FILE = null;
        if (f && enJeu()) execute(f);
      }, Math.max(0, attente));
    }
  }

  function execute(g) {
    DERNIER = performance.now();
    const r = M.agit(ETAT, g);
    if (!r.ok) {
      const b = r.ev.find((e) => e.t === "bute");
      if (b) BUTE = { dx: b.dx, dy: b.dy, t: performance.now() };
      else if (r.raison) annonce(r.raison, "info");
      return;
    }
    if (["choisit", "passe", "relance"].indexOf(g.t) < 0) { SELECTION = null; CHOIX = null; REGARD = null; fermeListe(); }
    traite(r.ev);
    majInterface();
    if (ETAT.fini) { termine(); return; }
    if (ETAT.attente) ouvreBooster(g.t === "relance");
    else {
      el("booster").hidden = true;
      if (EXODIA_GARDEE) { const ev = EXODIA_GARDEE; EXODIA_GARDEE = null; traite(ev); }
    }
  }

  /* Pendant un booster, une carte touchée se lit : on choisit en sachant
     ce qu'on a. */
  function clicCarte(k) {
    if (!ETAT || ETAT.fini || k >= ETAT.main.length) return;
    // une pile ouverte se referme : on revient au jeu
    if (PILE && !ETAT.attente) fermePile();
    if (ETAT.attente) { REGARD = { id: ETAT.main[k] }; dessineFiche(); return; }
    if (!enJeu()) return;
    if (CHOIX) CHOIX = null;
    fermeListe();
    if (SELECTION === k) { joueSelection(); return; }
    SELECTION = k;
    REGARD = null;
    majInterface();
  }

  function joueSelection(option) {
    const k = SELECTION;
    if (k == null) return;
    const j = M.jouable(ETAT, k, option);
    if (!j.ok) { annonce(j.raison, "info"); return; }
    if (j.options) { ouvreListe(k); return; }
    if (j.choix) {
      CHOIX = { index: k, option, besoin: j.choix, ou: j.ou, sacrifice: !!j.sacrifice, pris: [],
                bourse: !!j.bourse, paie: !!j.paie };
      fermeListe();
      majInterface();
      return;
    }
    geste({ t: "joue", index: k, cibles: [], option, paie: !!j.paie });
  }

  /* La Bourse des Âmes : des LP au lieu des sacrifices qu'on était en train
     de désigner. Sans zone libre, il reste un monstre à remplacer. */
  function paieBourse() {
    if (!CHOIX || !CHOIX.bourse) return;
    const k = CHOIX.index, option = CHOIX.option;
    const j = M.jouable(ETAT, k, option, true);
    if (!j.ok) { annonce(j.raison, "info"); return; }
    if (j.choix) {
      CHOIX = { index: k, option, besoin: j.choix, ou: j.ou, sacrifice: false, pris: [], paie: true };
      majInterface();
      return;
    }
    geste({ t: "joue", index: k, cibles: [], option, paie: true });
  }

  function joueEffet() {
    const k = SELECTION;
    if (k == null) return;
    const j = M.jouableEffet(ETAT, k);
    if (!j.ok) { annonce(j.raison, "info"); return; }
    geste({ t: "effet", index: k });
  }

  /* Les points déjà désignés : un Kaiser Hippocampe en vaut deux pour un
     monstre LUMIÈRE. */
  function pointsPris() {
    if (!CHOIX.sacrifice) return CHOIX.pris.length;
    const id = ETAT.main[CHOIX.index];
    return CHOIX.pris.reduce((t, z) => t + M.valeurSacrifice(ETAT, z, id), 0);
  }

  function clicZone(code) {
    if (!ETAT) return;
    const sorte = code[0], k = Number(code.slice(1));
    if (CHOIX && !ETAT.attente && ((CHOIX.ou === "monstres" && sorte === "m") || (CHOIX.ou === "zones" && sorte === "z"))) {
      const liste = sorte === "m" ? ETAT.monstres : ETAT.zones;
      if (!liste[k]) return;
      const i = CHOIX.pris.indexOf(k);
      if (i >= 0) CHOIX.pris.splice(i, 1); else CHOIX.pris.push(k);
      if (pointsPris() >= CHOIX.besoin) {
        geste({ t: "joue", index: CHOIX.index, cibles: CHOIX.pris.slice(), option: CHOIX.option, paie: !!CHOIX.paie });
        return;
      }
      majInterface();
      return;
    }
    const id = idDeZone(code);
    if (!id) return;
    if (!ETAT.attente) { SELECTION = null; CHOIX = null; fermeListe(); }
    REGARD = { id, zone: code };
    if (ETAT.attente) dessineFiche(); else majInterface();
  }

  function idDeZone(code) {
    const k = Number(code.slice(1));
    if (code[0] === "m") return ETAT.monstres[k] && ETAT.monstres[k].id;
    if (code[0] === "z") return ETAT.zones[k] && ETAT.zones[k].id;
    return ETAT.terrain;
  }

  /* Le monstre d'une zone, pour lire sa DEF du moment. */
  function monstreDe(code) { return code && code[0] === "m" ? ETAT.monstres[Number(code.slice(1))] : null; }

  function annule() {
    SELECTION = null; CHOIX = null; REGARD = null;
    fermeListe();
    majInterface();
  }

  /* =========================================================
     La liste de Polymérisation et de Monster Reborn
     ========================================================= */
  function ouvreListe(index) {
    const id = ETAT.main[index];
    const c = M.carte(id);
    const opts = M.options(ETAT, index);
    LISTE = { index, plusieurs: M.jouable(ETAT, index).plusieurs || 0, pris: [] };
    el("choixTitre").textContent = c.nom;
    if (LISTE.plusieurs) {
      dessineLiberation();
      el("choix").hidden = false;
      dessineFiche();
      return;
    }
    el("choixSous").textContent = c.effet === "fusion" ? "Choisis la fusion."
      : c.effet === "foi" ? "Choisis la magie à reprendre."
      : c.effet === "enterrement" ? "Choisis le monstre à reprendre en main." : "Choisis le monstre à ramener.";
    el("options").innerHTML = opts.map((o, k) => {
      const f = M.carte(o.id);
      const t = M.texte(ETAT, o.id);
      const effet = t.effets[0];
      const matieres = o.matieres ? `<span class="option-matieres">${o.matieres.map((x) =>
        `<span class="matiere">${img(x.id)}<span>${esc(M.carte(x.id).nom)}<i>${x.ou === "main" ? "main" : "terrain"}</i></span></span>`
      ).join('<span class="plus">+</span>')}</span>` : "";
      return `<button class="option" data-option="${k}" data-cadre="${cadre(f)}">
        <span class="option-art">${img(o.id)}</span>
        <span class="option-corps">
          <b class="option-nom">${esc(f.nom)}</b>
          ${f.genre === "monstre" ? `<span class="option-stats"><i>ATK</i>${f.atk}<i>DEF</i>${f.df}</span>`
            : `<span class="option-stats">${f.genre === "piege" ? "Piège" : "Magie"}</span>`}
          ${effet ? `<span class="option-effet">${effet[0] ? `${motEffet(effet[0])} : ` : ""}${texteRiche(effet[1])}</span>` : ""}
          ${matieres}
        </span></button>`;
    }).join("");
    el("choix").hidden = false;
    dessineFiche();
  }

  /* Libération d'Âme : les cartes du deck en vignettes, rangées par sorte
     (pas dans l'ordre du deck, qui ne se dévoile pas), qu'on coche. */
  function dessineLiberation() {
    const opts = M.options(ETAT, LISTE.index);
    const n = LISTE.pris.length;
    const typhon = M.carte(ETAT.main[LISTE.index]).effet === "typhon";
    el("choixSous").textContent = typhon ? "Choisis les cartes à détruire."
      : `Choisis jusqu'à ${LISTE.plusieurs} cartes de ton cimetière à remettre dans ton deck.`;
    const ordre = opts.map((o, k) => k).sort((p, q) => TRIS.type(M.carte(opts[p].id), M.carte(opts[q].id)));
    el("options").innerHTML = `<div class="grille-tuiles liberation">${ordre.map((k) => {
      const o = opts[k], f = M.carte(o.id);
      return `<button class="tuile${LISTE.pris.indexOf(o.place) >= 0 ? " choisie" : ""}" data-option="${k}"
        data-cadre="${cadre(f)}" aria-label="${esc(f.nom)}">${img(o.id)}</button>`;
    }).join("")}</div>
      <button class="cta petit valider" data-valider ${n ? "" : "disabled"}>${typhon ? "Détruire" : "Remettre"}${
        n ? ` ${n} carte${n > 1 ? "s" : ""}` : ""}</button>`;
  }

  function fermeListe() {
    LISTE = null;
    el("choix").hidden = true;
  }

  /* =========================================================
     Le deck et le cimetière
     Leurs cartes, en vignettes : le deck rangé par sorte, chaque carte
     une fois avec son nombre (son ordre ne se dévoile pas), le cimetière
     de la plus récente à la plus ancienne. Touchée, une carte se lit dans
     la fiche. On les ouvre depuis « Ton duel », même pendant un booster,
     pour choisir en sachant ce qu'on a.
     ========================================================= */
  function ouvrePile(quelle) {
    if (!ETAT || ETAT.fini) return;
    PILE = quelle;
    REGARD = null;
    dessinePile();
    el("pile").hidden = false;
    dessineFiche();
  }

  function fermePile() {
    if (!PILE) return;
    PILE = null;
    REGARD = null;
    el("pile").hidden = true;
    if (ETAT) dessineFiche();
  }

  const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;

  function dessinePile() {
    const deck = PILE === "deck";
    let cartes;
    if (deck) {
      const n = {};
      ETAT.deck.forEach((id) => { n[id] = (n[id] || 0) + 1; });
      cartes = trie(Object.keys(n), "type").map((id) => ({ id, n: n[id] }));
    } else cartes = ETAT.cimetiere.slice().reverse().map((id) => ({ id, n: 1 }));
    const total = deck ? ETAT.deck.length : ETAT.cimetiere.length;
    el("pileTitre").textContent = deck ? "Ton deck" : "Ton cimetière";
    el("pileSous").textContent = !total ? (deck ? "Il est vide : plus rien à piocher." : "Il est vide.")
      : pluriel(total, "carte");
    const vue = REGARD && REGARD.pile ? REGARD : null;
    el("pileCartes").innerHTML = cartes.map((o, k) => {
      const c = M.carte(o.id);
      return `<button class="tuile${vue && vue.place === k ? " regardee" : ""}" data-pile-carte="${k}"
        data-id="${o.id}" data-cadre="${cadre(c)}" aria-label="${esc(c.nom)}">${img(o.id)}${
        o.n > 1 ? `<span class="nombre">×${o.n}</span>` : ""}</button>`;
    }).join("");
  }

  function choisitOption(k) {
    if (!LISTE) return;
    const opts = M.options(ETAT, LISTE.index);
    if (k >= opts.length) return;
    if (LISTE.plusieurs) {
      const place = opts[k].place, i = LISTE.pris.indexOf(place);
      if (i >= 0) LISTE.pris.splice(i, 1);
      else if (LISTE.pris.length < LISTE.plusieurs) LISTE.pris.push(place);
      dessineLiberation();
      return;
    }
    SELECTION = LISTE.index;
    joueSelection(k);
  }

  function valideListe() {
    if (!LISTE || !LISTE.plusieurs || !LISTE.pris.length) return;
    SELECTION = LISTE.index;
    joueSelection(LISTE.pris.slice());
  }

  /* =========================================================
     Le terrain, la main, la fiche
     ========================================================= */
  function cadre(c) {
    if (c.genre === "magie") return "spell";
    if (c.genre === "piege") return "trap";
    return M.estFusion(c) ? "fusion" : c.cadre === "normal" ? "normal" : "effect";
  }

  function majInterface() {
    majReleves();
    dessineZones();
    dessineMain();
    if (PILE) dessinePile();
    dessineFiche();
    ARRIVEES.clear(); TIRS.clear(); TOUCHEES.clear(); NOUVELLES.clear();
  }

  function majReleves() {
    const j = ETAT.joueur;
    const lp = el("lp");
    if (LP_AVANT != null && j.lp !== LP_AVANT) {
      lp.classList.remove("touche", "soigne");
      void lp.offsetWidth;
      lp.classList.add(j.lp < LP_AVANT ? "touche" : "soigne");
    }
    LP_AVANT = j.lp;
    lp.textContent = j.lp;
    el("lpJauge").style.transform = `scaleX(${Math.min(1, j.lp / M.R.LP)})`;
    el("tour").textContent = ETAT.tour;
    el("niveau").textContent = j.niveau;
    el("xpJauge").style.transform = `scaleX(${Math.min(1, j.xp / M.xpPour(j.niveau))})`;
    const b = ETAT.boss;
    el("boss").hidden = !b;
    if (b) {
      el("bossNom").textContent = M.carte(b.id).nom;
      el("bossJauge").style.transform = `scaleX(${Math.max(0, b.pv / b.pvMax)})`;
    }
  }

  /* Les étoiles montrées : une par doublon gardé, la carte seule n'en a
     pas (le moteur compte la carte elle-même, d'où le « - 1 »). */
  function pips(id) { return "★".repeat(M.etoiles(ETAT, id) - 1); }

  function zone(code, id, classes, contenu) {
    if (!id) return `<button class="zone ${classes}" data-zone="${code}" aria-label="Zone vide" tabindex="-1"></button>`;
    const c = M.carte(id);
    return `<button class="zone pleine ${classes}" data-zone="${code}" style="--cadre:var(--cadre-${cadre(c)})"
      aria-label="${esc(c.nom)}">${img(id)}${contenu || ""}<span class="pips">${pips(id)}</span></button>`;
  }

  function dessineZones() {
    const choix = CHOIX ? CHOIX.ou : null;
    const cible = CHOIX && CHOIX.sacrifice ? ETAT.main[CHOIX.index] : null;
    el("zonesMonstres").innerHTML = ETAT.monstres.map((m, k) => {
      const cls = [];
      let contenu = "";
      if (m) {
        if (choix === "monstres") cls.push(CHOIX.pris.indexOf(k) >= 0 ? "choisie" : "choisissable");
        if (ARRIVEES.has("m" + k)) cls.push("arrive");
        if (TIRS.has(k)) cls.push("tire");
        if (TOUCHEES.has(k)) cls.push("touchee");
        if (m.jeton) cls.push("jeton");
        const c = M.carte(m.id);
        const max = M.recharge(ETAT, c);
        if (m.recharge > 0) contenu += `<span class="voile-recharge" style="transform:scaleY(${Math.min(1, m.recharge / max)})"></span>`;
        if (m.compteurs) contenu += `<span class="badge-zone compteurs">${m.compteurs}</span>`;
        if (m.fin != null) contenu += `<span class="badge-zone duree">${m.fin - ETAT.tour}</span>`;
        if (cible && M.valeurSacrifice(ETAT, k, cible) > 1) contenu += '<span class="badge-zone double">×2</span>';
      }
      return zone("m" + k, m && m.id, cls.join(" "), contenu);
    }).join("");
    el("zonesMagies").innerHTML = ETAT.zones.map((z, k) => {
      const cls = [];
      let contenu = "";
      if (z) {
        if (choix === "zones") cls.push(CHOIX.pris.indexOf(k) >= 0 ? "choisie" : "choisissable");
        if (ARRIVEES.has("z" + k)) cls.push("arrive");
        const c = M.carte(z.id);
        if (z.charges) contenu += `<span class="badge-zone compteurs">${z.charges}</span>`;
      }
      return zone("z" + k, z && z.id, cls.join(" "), contenu);
    }).join("") + zone("t0", ETAT.terrain, "terrain-zone" + (ARRIVEES.has("t0") ? " arrive" : ""), "");
  }

  /* Une petite carte : dans la main, le deck, la boutique. */
  function petiteCarte(id, attrs, classes, badge) {
    const c = M.carte(id);
    const ligne = c.genre === "monstre"
      ? `<span class="niv">★${c.niveau}</span><span class="ad">${c.atk}/${c.df}</span>`
      : `<span>${c.genre === "piege" ? "Piège" : "Magie"}</span>`;
    return `<button class="carte ${classes || ""}" ${attrs} data-cadre="${cadre(c)}" aria-label="${esc(c.nom)}">
      ${img(id)}<span class="nom">${esc(c.nom)}</span><span class="ligne">${ligne}</span>${badge || ""}</button>`;
  }

  function dessineMain() {
    el("main").innerHTML = ETAT.main.map((id, k) => {
      const ok = M.jouable(ETAT, k).ok || M.jouableEffet(ETAT, k).ok;
      const cls = [];
      if (!ok) cls.push("injouable");
      if (SELECTION === k) cls.push("choisie");
      if (NOUVELLES.has(id)) cls.push("nouvelle");
      const et = M.etoiles(ETAT, id);
      return petiteCarte(id, `data-index="${k}"`, cls.join(" "), et > 1 ? `<span class="badge">★${et - 1}</span>` : "");
    }).join("") + prochainePioche();
  }

  /* La prochaine pioche : une carte en pointillé au bout de la main, qui
     dit dans combien de tours elle arrive. Rien quand le deck est vide, ni
     quand la main est pleine (la pioche attend). */
  function prochainePioche() {
    if (!ETAT.deck.length || ETAT.main.length >= M.R.MAIN_MAX) return "";
    const n = Math.max(1, ETAT.avantPioche);
    return `<span class="carte a-venir" aria-label="Prochaine pioche dans ${n} tour${n > 1 ? "s" : ""}">
      <b>${n}</b><span>tour${n > 1 ? "s" : ""}</span></span>`;
  }

  /* Un texte du moteur, échappé, ses mots-clés {mot} ou {mot|clé} soulignés :
     leur sens s'affiche au survol (voir la bulle). */
  function texteRiche(s) {
    return esc(s).replace(/\{([^}|]+)(?:\|([^}]+))?\}/g, (_, mot, cle) => {
      const k = (cle || mot).toLowerCase();
      return M.MOTS[k] ? `<span class="mot" data-mot="${esc(k)}">${mot}</span>` : mot;
    });
  }

  /* Le mot en gras d'un effet (« Dernier souffle ») : expliqué lui aussi,
     s'il a un sens à lui. */
  function motEffet(mot) {
    const k = mot.toLowerCase();
    return M.MOTS[k] ? `<b class="mot" data-mot="${esc(k)}">${esc(mot)}</b>` : `<b>${esc(mot)}</b>`;
  }

  /* Le texte d'une carte, bloc par bloc : les stats en évidence, son
     attaque (le Type) et son bonus (l'attribut), ses effets avec leur
     mot-clé, puis en italique ce qu'elle demande. */
  function blocTexte(t) {
    let h = "";
    if (t.stats) {
      const s = t.stats;
      h += `<p class="t-stats"><span><i>ATK</i>${s.atk}</span><span><i>DEF</i>${s.df}</span>${
        s.compteurs ? `<span><i>Compteurs</i>${s.compteurs}</span>` : ""}</p>`;
    }
    if (t.attaque) {
      const a = t.attaque;
      h += `<p class="t-attaque"><b>${esc(a.nom)}</b> : ${texteRiche(a.phrase)}</p>`;
      if (a.bonus) {
        h += `<p class="t-bonus"><b style="color:${(M.ATTRIBUTS[a.bonus[2]] || {}).couleur || "inherit"}">${
          esc(a.bonus[0])}</b> : ${texteRiche(a.bonus[1])}</p>`;
      }
      h += `<p class="t-puces">${a.puces.map((p) => `<span>${esc(p)}</span>`).join("")}</p>`;
    }
    for (const [mot, phrase] of t.effets) {
      h += `<p class="t-effet">${mot ? `${motEffet(mot)} : ` : ""}${texteRiche(phrase)}</p>`;
    }
    for (const c of t.conditions) h += `<p class="t-cond">${texteRiche(c)}</p>`;
    return `<div class="txt">${h}</div>`;
  }

  function ficheCarte(id, m) {
    const c = M.carte(id);
    const t = M.texte(ETAT, id, m);
    const n = ETAT ? M.etoiles(ETAT, id) : 1;
    return `<div class="fiche-tete">
        <img class="fiche-art" src="${ART(id)}" data-repli="${ART_GRANDE(id)}" alt="" style="--cadre:var(--cadre-${cadre(c)})">
        <div><h3>${esc(c.nom)}</h3><p class="sous">${esc(t.tete)}</p>
        ${n > 1 ? `<p class="etoiles">${"★".repeat(n - 1)}</p>` : ""}</div></div>
      ${blocTexte(t)}`;
  }

  function ficheEnnemi(uid) {
    const e = ETAT.ennemis.find((x) => x.uid === uid);
    if (!e) return ficheRepos();
    const c = M.carte(e.id);
    const a = M.ATTRIBUTS[c.attribut] || { nom: c.attribut };
    const t = { stats: null, attaque: null, effets: [], conditions: [] };
    if (e.vitesse >= 1) t.effets.push(["Rapide", "il avance à chaque tour."]);
    else if (e.vitesse <= 0.5) t.effets.push(["Lent", "il avance un tour sur deux."]);
    if (e.brule) t.effets.push(["En feu", `encore ${e.brule.tours} tour${e.brule.tours > 1 ? "s" : ""}.`]);
    if (e.expose > 0) {
      t.effets.push(["Exposé", `+${M.R.EXPOSE * 100} % de dégâts, encore ${e.expose} tour${e.expose > 1 ? "s" : ""}.`]);
    }
    if (e.affaibli > 0) {
      t.effets.push(["Affaibli", `frappe ${M.R.ROQUETTE * 100} % moins fort, encore ${e.affaibli} tour${e.affaibli > 1 ? "s" : ""}.`]);
    }
    if (e.elite) t.effets.push(["Élite", "il lâche un booster et une pièce d'Exodia."]);
    if (e.boss != null) {
      const b = M.BOSS[e.boss];
      t.effets.push([b.nom, `les cases rouges tombent ${b.delai > 1 ? `dans ${b.delai} tours` : "au tour suivant"}, sur tes LP. Sors-en.`]);
    }
    return `<div class="fiche-tete">
        <img class="fiche-art" src="${ART(e.id)}" data-repli="${ART_GRANDE(e.id)}" alt="" style="--cadre:${e.boss != null ? "#FF5C5C" : e.elite ? "#FFD34D" : "var(--ligne-forte)"}">
        <div><h3>${esc(c.nom)}</h3><p class="sous">Niveau ${c.niveau} · ${esc(a.nom)} · ${esc(c.type)}</p></div></div>
      <div class="txt"><p class="t-stats"><span><i>PV</i>${Math.max(0, Math.round(e.pv))}<small> / ${e.pvMax}</small></span>
        <span><i>Frappe</i>${M.frappeDe(e)}</span></p></div>${blocTexte(t)}`;
  }

  /* Le Deck et le Cimetière s'y ouvrent aussi, d'un clic. */
  function ficheRepos() {
    return `<div class="fiche-repos"><h3>Ton duel</h3><div class="duel-lignes">
      <p class="duel-ligne"><span>Défense</span><b>${Math.round(M.reduction(ETAT) * 100)} %</b></p>${
        ETAT.bouclier > ETAT.tour ? `<p class="duel-ligne"><span>Bouclier et Épée</span><b>${
          pluriel(ETAT.bouclier - ETAT.tour, "tour")}</b></p>` : ""}
      <button class="duel-ligne" data-pile="deck"><span>Deck</span><b>${pluriel(ETAT.deck.length, "carte")}</b></button>
      <button class="duel-ligne" data-pile="cimetiere"><span>Cimetière</span><b>${
        pluriel(ETAT.cimetiere.length, "carte")}</b></button>
      </div>
      <p class="sous" style="margin-top:14px">Exodia</p>
      <div class="exodia">${STOCK.exodia.map((id) => ETAT.exodia.indexOf(id) >= 0
        ? `<span class="eue">${img(id, M.carte(id).nom)}</span>` : "<span></span>").join("")}</div></div>`;
  }

  function dessineFiche() {
    const f = el("fiche");
    let html, ouverte = true;
    if (CHOIX) {
      const reste = CHOIX.besoin - pointsPris();
      const quoi = CHOIX.ou === "zones" ? "la carte magie ou piège à remplacer"
        : CHOIX.sacrifice ? (reste > 1 ? `${reste} monstres à sacrifier` : "le monstre à sacrifier")
        : "le monstre à remplacer";
      html = ficheCarte(ETAT.main[CHOIX.index]) + `<p class="statut">Choisis ${quoi}.</p>
        <div class="actions">${CHOIX.bourse
          ? `<button class="cta petit" data-action="payer">Payer ${M.R.ECHANGE} LP</button>` : ""}
          <button class="sobre petit" data-action="annuler">Annuler</button></div>`;
    } else if (REGARD) {
      html = ficheCarte(REGARD.id, monstreDe(REGARD.zone)) + `<div class="actions">${
        REGARD.offre != null ? '<button class="cta petit" data-action="garder">Garder cette carte</button>' : ""}
        <button class="sobre petit" data-action="fermer">Fermer</button></div>`;
    } else if (SELECTION != null) {
      const j = M.jouable(ETAT, SELECTION);
      const effet = M.jouableEffet(ETAT, SELECTION).ok;
      html = ficheCarte(ETAT.main[SELECTION]) + (j.ok || effet ? "" : `<p class="statut non">${esc(j.raison)}</p>`)
        + `<div class="actions">${j.ok ? `<button class="cta petit" data-action="jouer">${
            M.carte(ETAT.main[SELECTION]).genre === "monstre" ? "Invoquer" : "Jouer"}</button>` : ""}
           ${effet ? '<button class="cta petit sombre" data-action="effet">Défausser</button>' : ""}
           <button class="sobre petit" data-action="annuler">Annuler</button></div>`;
    } else {
      ouverte = false;
      html = SURVOL ? (SURVOL.uid ? ficheEnnemi(SURVOL.uid) : ficheCarte(SURVOL.id, monstreDe(SURVOL.zone)))
        : ficheRepos();
    }
    // la liste de Polymérisation ouverte : la fusion survolée passe avant,
    // et le tiroir du téléphone se range, la liste dit déjà tout
    if (LISTE) {
      if (SURVOL && SURVOL.id) html = ficheCarte(SURVOL.id);
      ouverte = false;
    }
    f.innerHTML = html;
    f.classList.toggle("ouverte", ouverte);
    f.classList.toggle("choix", !!CHOIX);
  }

  /* =========================================================
     Les boosters
     ========================================================= */
  function grandeCarte(o) {
    if (!o.id) {
      return `<span class="grande" data-cadre="spell"><span class="nom">Soin</span><span class="niv"></span>
        <span class="texte"><div class="txt"><p class="t-effet">+1000 LP : plus rien à prendre dans ce booster.</p></div></span></span>`;
    }
    const c = M.carte(o.id);
    const niv = c.genre === "monstre" ? "★".repeat(Math.min(12, c.niveau)) : c.genre === "piege" ? "PIÈGE" : "MAGIE";
    return `<span class="grande ${esc(c.rarete || "")}" data-cadre="${cadre(c)}">
      ${o.quoi === "etoile" ? '<span class="ruban">★ +1</span>' : ""}
      <span class="nom">${esc(c.nom)}</span><span class="niv">${niv}</span>
      <img src="${ART_GRANDE(o.id)}" alt="">
      <span class="texte">${blocTexte(M.texte(ETAT, o.id))}</span></span>`;
  }

  /* `relance` : les mêmes boosters, relancés par un Dé gracieux : le
     titre ne change pas. */
  const RECHERCHES = { sangan: ["Sangan", "Ajoute une carte de ton deck à ta main."],
                       sorciere: ["Sorcière de la Forêt Noire", "Ajoute une carte de ton cimetière à ta main."],
                       agido: ["Agido", "Une Elfe de ton cimetière revient sur le terrain."] };

  function ouvreBooster(relance) {
    const a = ETAT.attente;
    if (RECHERCHES[a.sorte]) {
      // pas un booster : les cartes où choisir, en vignettes
      el("boosterTitre").textContent = RECHERCHES[a.sorte][0];
      el("boosterSous").textContent = RECHERCHES[a.sorte][1];
      el("boosterRelancer").hidden = true;
      el("offres").innerHTML = `<div class="grille-tuiles recherche">${a.offres.map((o, k) =>
        `<button class="tuile" data-offre="${k}" data-cadre="${cadre(M.carte(o.id))}" aria-label="${esc(M.carte(o.id).nom)}">${
          img(o.id)}</button>`).join("")}</div>`;
      el("booster").hidden = false;
      BOOSTER_PRET = true;
      OFFRE_VUE = null;
      return;
    }
    el("boosterSous").textContent = "Garde une carte.";
    if (!relance) {
      el("boosterTitre").textContent = a.sorte === "elite" ? "Booster d'élite !"
        : `Niveau ${NIVEAUX.length ? NIVEAUX.shift() : ETAT.joueur.niveau} !`;
    }
    const n = M.relances(ETAT);
    el("boosterRelancer").hidden = !n;
    el("boosterRelancer").textContent = `Relancer (${n})`;
    el("offres").innerHTML = a.offres.map((o, k) => `
      <button class="offre" data-offre="${k}" aria-label="${esc(o.id ? M.carte(o.id).nom : "Soin")}">
        <span class="dos"></span><span class="face">${grandeCarte(o)}</span></button>`).join("");
    el("booster").hidden = false;
    BOOSTER_PRET = false;
    OFFRE_VUE = null;
    a.offres.forEach((o, k) => setTimeout(() => {
      const b = el("offres").children[k];
      if (b) b.classList.add("retournee");
      if (k === a.offres.length - 1) BOOSTER_PRET = true;
    }, 240 + k * 150));
  }

  function choisitOffre(k) {
    if (!ETAT || !ETAT.attente || !BOOSTER_PRET || k >= ETAT.attente.offres.length) return;
    REGARD = null;
    OFFRE_VUE = null;
    execute({ t: "choisit", index: k });
  }

  function relanceBooster() {
    if (!ETAT || !ETAT.attente || !BOOSTER_PRET || !M.relances(ETAT)) return;
    REGARD = null;
    OFFRE_VUE = null;
    execute({ t: "relance" });
  }

  /* Refermer le booster sans rien prendre. */
  function passeBooster() {
    if (!ETAT || !ETAT.attente || !BOOSTER_PRET) return;
    REGARD = null;
    OFFRE_VUE = null;
    execute({ t: "passe" });
  }

  function marqueOffre() {
    el("offres").querySelectorAll("[data-offre]").forEach((b) => b.classList.toggle("regardee", Number(b.dataset.offre) === OFFRE_VUE));
  }

  /* =========================================================
     L'accueil : jouer, le deck, la boutique
     ========================================================= */
  function collection() { return PROFIL ? PROFIL.collection : STOCK.collection; }
  function deckActuel() { return PROFIL ? PROFIL.deck : STOCK.deck; }
  // un serveur d'avant l'Extra Deck n'en dit rien : celui de départ
  function extraActuel() { return PROFIL && PROFIL.extra ? PROFIL.extra : STOCK.extra; }
  function tailleDeck() { return PROFIL ? PROFIL.taille : STOCK.taille_deck; }
  function tailleExtra() { return PROFIL && PROFIL.taille_extra ? PROFIL.taille_extra : STOCK.taille_extra; }

  function majDp() {
    el("dp").hidden = !PROFIL;
    if (PROFIL) el("dpValeur").textContent = PROFIL.dp;
  }

  function changeOnglet(o) {
    ONGLET = o;
    CHOISIE = null;
    document.querySelectorAll(".onglet").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.onglet === o)));
    el("pJouer").hidden = o !== "jouer";
    el("atelier").hidden = o === "jouer";
    el("accueil").classList.toggle("large", o !== "jouer");
    el("accueil").dataset.onglet = o;
    if (o !== "jouer") dessineAtelier();
    else dessineJouer();
  }

  /* Les duellistes qu'on peut jouer : le serveur le dit ; sans lui, ou
     d'avant les duellistes, Yugi seul. */
  function ouverts() {
    return PROFIL && Array.isArray(PROFIL.duellistes) ? PROFIL.duellistes : [STOCK.duellistes[0].cle];
  }

  /* Le duelliste choisi : son portrait, son deck de départ ; encore
     fermé, sa silhouette, des cartes de dos, et le succès qui l'ouvre.
     Dessous, les médaillons pour changer de duelliste. */
  function dessineJouer() {
    const n = deckActuel().length, taille = tailleDeck();
    const libres = ouverts();
    const du = M.duelliste(DUELLISTE);
    const ouvert = libres.indexOf(du.cle) >= 0;
    const d = du.depart;
    const cartes = d.terrain.concat(d.deck);
    const ouvreur = STOCK.succes.find((x) => x.cle === du.succes);
    el("duelliste").classList.toggle("ferme", !ouvert);
    el("duelliste").innerHTML = `<img class="portrait" src="${PORTRAIT(du.cle)}" alt="">
      <div class="duelliste-corps"><b class="qui">${esc(du.nom)}</b>
      <div class="cartes">${cartes.map((id) => ouvert
        ? `<span class="mini" data-cadre="${cadre(M.carte(id))}">${img(id, M.carte(id).nom)}</span>`
        : '<span class="mini dos"></span>').join("")}</div>
      ${ouvert || !ouvreur ? "" : `<p class="condition">Succès « ${esc(ouvreur.nom)} » : ${esc(ouvreur.texte)}</p>`}
      </div>`;
    el("duellistes").hidden = STOCK.duellistes.length < 2;
    el("duellistes").innerHTML = STOCK.duellistes.map((x) => {
      const libre = libres.indexOf(x.cle) >= 0;
      return `<button class="medaillon${libre ? "" : " ferme"}" data-duelliste="${x.cle}"
        aria-pressed="${x.cle === du.cle}" aria-label="${esc(x.nom)}${libre ? "" : " (à débloquer)"}">
        ${medaillon(x.cle)}<span class="nom-duelliste">${esc(x.nom)}</span></button>`;
    }).join("");
    el("commencer").disabled = n !== taille || !ouvert;
    const r = lisRecord();
    el("record").textContent = n !== taille ? `Tes boosters doivent compter ${taille} cartes : ils en ont ${n}.`
      : r ? `Record : tour ${r.tour}, niveau ${r.niveau}.` : "";
  }

  function choisitDuelliste(cle) {
    DUELLISTE = cle;
    if (ouverts().indexOf(cle) >= 0) {
      try { localStorage.setItem(MEMO_DUELLISTE, cle); } catch (e) { /* stockage refusé : on le rechoisira */ }
    }
    dessineJouer();
  }

  /* Le duelliste qu'on jouait la dernière fois, s'il est toujours ouvert. */
  function rappelleDuelliste() {
    let cle = null;
    try { cle = localStorage.getItem(MEMO_DUELLISTE); } catch (e) { /* stockage refusé */ }
    DUELLISTE = ouverts().indexOf(cle) >= 0 ? cle : ouverts()[0];
  }

  /* Les ordres de la collection, comme dans un simulateur : par sorte de
     carte (monstres par niveau, magies, pièges, fusions), ou par une
     seule valeur. */
  const RANG_RARETE = { commune: 0, rare: 1, super: 2, ultra: 3, fusion: 4 };
  /* Monstres normaux, à effet, magies normales, continues, de terrain,
     pièges normaux, continus, puis les fusions. */
  function sorte(c) {
    if (M.estFusion(c)) return 7;
    if (c.genre === "monstre") return c.cadre === "normal" ? 0 : 1;
    const p = M.place(c);
    if (c.genre === "magie") return p === "terrain" ? 4 : p === "zone" ? 3 : 2;
    return p === "zone" ? 6 : 5;
  }
  const TRIS = {
    type: (a, b) => sorte(a) - sorte(b) || (a.niveau || 0) - (b.niveau || 0) || a.nom.localeCompare(b.nom),
    niveau: (a, b) => (b.niveau || 0) - (a.niveau || 0) || sorte(a) - sorte(b) || a.nom.localeCompare(b.nom),
    atk: (a, b) => (b.atk || 0) - (a.atk || 0) || a.nom.localeCompare(b.nom),
    def: (a, b) => (b.df || 0) - (a.df || 0) || a.nom.localeCompare(b.nom),
    nom: (a, b) => a.nom.localeCompare(b.nom),
    rarete: (a, b) => (RANG_RARETE[b.rarete] || 0) - (RANG_RARETE[a.rarete] || 0) || a.nom.localeCompare(b.nom),
  };
  const FILTRES = {
    tout: () => true,
    monstres: (c) => c.genre === "monstre" && !M.estFusion(c),
    magies: (c) => c.genre === "magie",
    pieges: (c) => c.genre === "piege",
    fusions: (c) => M.estFusion(c),
  };
  const trie = (ids, tri) => ids.slice().sort((p, q) => TRIS[tri](M.carte(p), M.carte(q)));

  /* Une vignette du deck : l'artwork seul, au cadre de sa sorte. */
  function tuile(id, ou) {
    const c = M.carte(id);
    const choisie = CHOISIE && CHOISIE.id === id && CHOISIE.ou === ou;
    return `<button class="tuile${choisie ? " choisie" : ""}" data-carte="${id}" data-ou="${ou}"
      data-cadre="${cadre(c)}" aria-label="${esc(c.nom)}">${img(id)}</button>`;
  }

  /* Une ligne de la collection : l'artwork, le nom, ce qu'il faut savoir. */
  function ligneCollection(id) {
    const c = M.carte(id);
    const choisie = CHOISIE && CHOISIE.id === id && CHOISIE.ou === "collection";
    const infos = c.genre === "monstre" ? `★${c.niveau} · ${c.type} · ${c.atk}/${c.df}`
      : c.genre === "piege" ? "Piège" : "Magie";
    return `<button class="ligne-col${choisie ? " choisie" : ""}" data-carte="${id}"
      data-ou="collection" data-cadre="${cadre(c)}">${img(id)}<span class="lc-texte"><b>${esc(c.nom)}</b>
      <span>${esc(infos)}</span></span></button>`;
  }

  function dessineDeck() {
    const deck = trie(deckActuel(), "type");
    const extra = trie(extraActuel(), "type");
    const vides = Math.max(0, tailleExtra() - extra.length);
    // la collection ne montre que ce qui reste hors des boosters et de l'Extra Deck
    const filtrees = collection().filter((id) => FILTRES[FILTRE](M.carte(id)));
    const liste = trie(filtrees.filter((id) => deck.indexOf(id) < 0 && extra.indexOf(id) < 0), TRI);
    const options = [["type", "Sorte de carte"], ["niveau", "Niveau"], ["atk", "ATK"], ["def", "DEF"],
                     ["nom", "Nom"], ["rarete", "Rareté"]];
    const filtres = [["tout", "Tout"], ["monstres", "Monstres"], ["magies", "Magies"],
                     ["pieges", "Pièges"], ["fusions", "Fusions"]];
    return `<div class="constructeur">
      <section class="deck-centre">
        <h3>Boosters <span class="compte${deck.length === tailleDeck() ? "" : " faux"}">${deck.length} / ${tailleDeck()}</span></h3>
        <div class="grille-tuiles">${deck.map((id) => tuile(id, "deck")).join("")}${
          new Array(Math.max(0, tailleDeck() - deck.length)).fill('<span class="tuile vide"></span>').join("")}</div>
        <h3>Extra Deck <span class="compte">${extra.length} / ${tailleExtra()}</span></h3>
        <div class="grille-tuiles extra">${extra.map((id) => tuile(id, "extra")).join("")}${
          new Array(vides).fill('<span class="tuile vide"></span>').join("")}</div>
      </section>
      <section class="collection-cadre">
        <div class="col-tete">
          <h3>Collection <span class="aide">${pluriel(liste.length, "carte")}</span></h3>
          <label class="tri">Trier par
            <select id="triCollection">${options.map(([k, n]) =>
              `<option value="${k}"${k === TRI ? " selected" : ""}>${n}</option>`).join("")}</select></label>
          <div class="filtres">${filtres.map(([k, n]) =>
            `<button class="filtre" data-filtre="${k}" aria-pressed="${k === FILTRE}">${n}</button>`).join("")}</div>
        </div>
        <div class="col-liste">${liste.map(ligneCollection).join("") || '<p class="vide">Aucune carte.</p>'}</div>
      </section></div>`;
  }

  function dessineAtelier() {
    let h;
    if (ONGLET === "deck") h = dessineDeck();
    else if (ONGLET === "succes") h = dessineSucces();
    else {
      h = PROFIL ? dessineBoutique()
        : '<p class="vide">La boutique ne répond pas : rien ne se garde pour l\'instant.</p>';
    }
    // la liste de la collection garde sa place quand on la redessine
    const avant = el("atelierListes").querySelector(".col-liste");
    const defile = avant ? avant.scrollTop : 0;
    el("atelierListes").innerHTML = h;
    const apres = el("atelierListes").querySelector(".col-liste");
    if (apres) apres.scrollTop = defile;
    el("atelier").classList.toggle("deck", ONGLET === "deck");
    dessineFicheAtelier();
  }

  function succesObtenus() { return PROFIL && Array.isArray(PROFIL.succes) ? PROFIL.succes : []; }

  /* Le succès qui donne cette carte : lui-même, ou par le duelliste qu'il
     ouvre. */
  function succesDe(id) {
    return STOCK.succes.find((s) => s.cartes.indexOf(id) >= 0
      || STOCK.duellistes.some((d) => d.succes === s.cle && d.cartes.indexOf(id) >= 0)) || null;
  }

  /* Le médaillon d'un duelliste : son visage dans un cercle d'or. */
  function medaillon(cle) {
    const [fx, fy, zoom] = VISAGES[cle] || [0.5, 0.15, 3];
    return `<span class="visage"><img src="${PORTRAIT(cle)}" alt="" style="--fx:${fx};--fy:${fy};--zoom:${zoom}"></span>`;
  }

  /* Les succès : ce qu'il faut accomplir en partie, une fois, et ce que
     cela rapporte. Leurs cartes ne s'obtiennent que là : on les voit
     d'avance, une touche les lit dans la fiche. */
  function dessineSucces() {
    const eus = succesObtenus();
    const n = STOCK.succes.filter((x) => eus.indexOf(x.cle) >= 0).length;
    return `<h3>Succès <span class="compte">${n} / ${STOCK.succes.length}</span></h3>
      ${PROFIL ? "" : '<p class="vide">Le serveur ne répond pas : les succès ne se gardent pas pour l\'instant.</p>'}
      <div class="succes-liste">${STOCK.succes.map((x) => {
        const eu = eus.indexOf(x.cle) >= 0;
        const du = STOCK.duellistes.find((d) => d.succes === x.cle);
        const cartes = (du ? du.cartes : []).concat(x.cartes);
        return `<div class="succes${eu ? " obtenu" : ""}">
          <span class="succes-marque" aria-label="${eu ? "Obtenu" : "À accomplir"}"></span>
          <div class="succes-corps"><b>${esc(x.nom)}</b><span>${esc(x.texte)}</span></div>
          <div class="recompenses">${du ? `<span class="recompense-duelliste">${medaillon(du.cle)}<i>${esc(du.nom)}</i></span>` : ""}${
            cartes.map((id) => tuile(id, "succes")).join("")}${
            x.dp ? `<span class="prime"><b>+${x.dp}</b>Points de Duel</span>` : ""}</div></div>`;
      }).join("")}</div>`;
  }

  /* La boutique : un booster d'une carte, tirée par le serveur parmi celles
     qu'on n'a pas encore, et la pioche du jour, cinq cartes dont on ne
     prend qu'une. */
  function dessineBoutique() {
    const b = PROFIL.boutique;
    // un serveur d'avant la nouvelle boutique (pas encore redémarré)
    if (!b || !Array.isArray(b.jour)) return '<p class="vide">La boutique change : elle rouvre au prochain redémarrage du serveur.</p>';
    const jour = b.jour.filter((id) => STOCK.cartes[id] && (collection().indexOf(id) < 0 || id === b.jour_pris));
    const manque = b.booster - PROFIL.dp;
    return `<div class="boutique">
      <section class="vitrine-booster">
        <h3>Booster</h3>
        <button class="paquet" data-boutique="booster" ${b.restantes && manque <= 0 ? "" : "disabled"}
          aria-label="Ouvrir un booster"><span>Survivor</span></button>
        <p class="prix-ligne"><b>${b.booster}</b> Points de Duel</p>
        ${!b.restantes ? '<p class="statut">Tu as déjà toutes les cartes.</p>'
          : manque > 0 ? `<p class="statut non">Il te manque ${manque} Points de Duel.</p>` : ""}
      </section>
      <section class="vitrine-jour">
        <h3>Pioche du jour</h3>
        <div class="grille-cartes">${jour.map((id) => petiteCarte(id, `data-carte="${id}" data-ou="jour"`,
          [CHOISIE && CHOISIE.id === id ? "choisie" : "", b.jour_pris && b.jour_pris !== id ? "eteinte" : ""].join(" "),
          `<span class="prix">${b.jour_pris === id ? "prise" : b.prix_jour}</span>`)).join("")
          || '<p class="vide">Rien aujourd\'hui.</p>'}</div>
      </section></div>`;
  }

  async function ouvreBoosterBoutique() {
    try {
      const r = await api("/api/survivor/booster", "POST", {});
      PROFIL = r;
      majDp();
      CHOISIE = null;
      dessineAtelier();
      revele(r.carte);
    } catch (err) { annonceAccueil(err.message); }
  }

  /* La carte d'un booster de la boutique : elle arrive face cachée et se
     retourne, comme en partie. Un toucher referme. */
  function revele(id) {
    const v = document.createElement("div");
    v.className = "ecran revelation";
    v.innerHTML = `<div class="revelation-in"><div class="offre" aria-label="${esc(M.carte(id).nom)}">
        <span class="dos"></span><span class="face">${grandeCarte({ id, quoi: "carte" })}</span></div>
      <p class="voile-sous">${esc(M.carte(id).nom)} rejoint ta collection.</p></div>`;
    document.body.appendChild(v);
    setTimeout(() => v.querySelector(".offre").classList.add("retournee"), 350);
    v.addEventListener("click", () => v.remove());
  }

  function dessineFicheAtelier() {
    const f = el("ficheAtelier");
    if (!CHOISIE) {
      f.innerHTML = `<div class="fiche-repos"><h3>${ONGLET === "deck" ? "Tes cartes" : ONGLET === "succes" ? "Les succès" : "La boutique"}</h3>
        <p class="sous">${ONGLET === "deck"
          ? `Tes boosters : les ${tailleDeck()} cartes qu'ils peuvent te proposer pendant le duel. Touche une carte pour la lire, l'ajouter ou la retirer.`
          : ONGLET === "succes" ? "Chacun se gagne une fois, en partie. Ses cartes ne s'obtiennent que par lui."
          : "Les Points de Duel se gagnent en partie."}</p></div>`;
      f.classList.remove("ouverte");
      return;
    }
    const { id, ou } = CHOISIE;
    const c = M.carte(id);
    const fusion = M.estFusion(c);
    const dans = (fusion ? extraActuel() : deckActuel()).indexOf(id) >= 0;
    let action = "", prix = "";
    if (ou === "succes") {
      // une récompense : où on l'a, ou ce qu'il faut faire pour l'avoir
      const x = succesDe(id);
      action = collection().indexOf(id) >= 0 ? '<p class="statut">Elle est dans ta collection.</p>'
        : x ? `<p class="statut">Succès « ${esc(x.nom)} » : ${esc(x.texte)}</p>` : "";
    } else if (ou === "jour") {
      const b = PROFIL.boutique;
      prix = `<p class="prix-ligne"><b>${b.prix_jour}</b> Points de Duel</p>`;
      action = b.jour_pris
        ? `<p class="statut">${b.jour_pris === id ? "Tu l'as prise aujourd'hui." : "Tu as déjà pris ta carte du jour : reviens demain."}</p>`
        : PROFIL.dp >= b.prix_jour ? '<button class="cta petit" data-atelier="acheter">Acheter</button>'
        : `<p class="statut non">Il te manque ${b.prix_jour - PROFIL.dp} Points de Duel.</p>`;
    } else if (dans) {
      action = `<button class="sobre petit" data-atelier="retirer">Retirer ${fusion ? "de l'Extra Deck" : "des boosters"}</button>`;
    } else if (fusion) {
      action = extraActuel().length < tailleExtra()
        ? '<button class="cta petit" data-atelier="ajouter">Ajouter à l\'Extra Deck</button>'
        : `<p class="statut">Ton Extra Deck est plein : retires-en une d'abord.</p>`;
    } else {
      action = deckActuel().length < tailleDeck()
        ? '<button class="cta petit" data-atelier="ajouter">Ajouter aux boosters</button>'
        : '<p class="statut">Tes boosters sont pleins : retires-en une d\'abord.</p>';
    }
    f.innerHTML = ficheCarte(id) + prix + `<div class="actions">${action}
      <button class="sobre petit" data-atelier="fermer">Fermer</button></div>`;
    f.classList.add("ouverte");
  }

  /* Le deck change : enregistré dès qu'il a ses 40 cartes. `choisie` : la
     carte que la fiche montre ensuite (null la referme). Plusieurs clics
     droits peuvent partir avant la première réponse : seule celle du
     dernier changement est gardée. */
  async function changeDeck(deck, extra, choisie) {
    if (!PROFIL) { annonceAccueil("Sans serveur, tes cartes ne se changent pas."); return; }
    const version = ++VERSION_DECK;
    PROFIL.deck = deck;
    PROFIL.extra = extra;
    CHOISIE = choisie || null;
    dessineAtelier();
    if (deck.length !== tailleDeck()) return;
    try {
      const p = await api("/api/survivor/deck", "PUT", { deck, extra });
      if (version === VERSION_DECK) PROFIL = p;
    } catch (err) { annonceAccueil(err.message); }
    if (version === VERSION_DECK) dessineAtelier();
  }

  /* Ajoute la carte au deck (une fusion à l'Extra Deck), ou l'en retire.
     `garde` : la fiche la montre ensuite, à sa nouvelle place. */
  function bascule(id, garde) {
    const fusion = M.estFusion(M.carte(id));
    const deck = deckActuel(), extra = extraActuel();
    const liste = fusion ? extra : deck;
    if (liste.indexOf(id) >= 0) {
      const reste = liste.filter((x) => x !== id);
      return changeDeck(fusion ? deck : reste, fusion ? reste : extra, garde && { id, ou: "collection" });
    }
    if (liste.length >= (fusion ? tailleExtra() : tailleDeck())) {
      annonceAccueil(fusion ? "Ton Extra Deck est plein : retires-en une d'abord."
                            : "Tes boosters sont pleins : retires-en une d'abord.");
      return null;
    }
    const plus = liste.concat([id]);
    return changeDeck(fusion ? deck : plus, fusion ? plus : extra, garde && { id, ou: fusion ? "extra" : "deck" });
  }

  async function actionAtelier(quoi) {
    if (!CHOISIE) return;
    const { id } = CHOISIE;
    if (quoi === "fermer") { CHOISIE = null; dessineAtelier(); return; }
    if (quoi === "retirer" || quoi === "ajouter") await bascule(id, false);
    if (quoi === "acheter") {
      try {
        PROFIL = await api("/api/survivor/achat", "POST", { carte: id });
        majDp();
        annonceAccueil(`${M.carte(id).nom} rejoint ta collection.`);
      } catch (err) { annonceAccueil(err.message); }
      CHOISIE = null;
      dessineAtelier();
    }
  }

  function annonceAccueil(texte) {
    const p = document.createElement("div");
    p.className = "annonce-accueil";
    p.textContent = texte;
    el("accueil").appendChild(p);
    setTimeout(() => p.remove(), 2600);
  }

  /* =========================================================
     Le début et la fin
     ========================================================= */
  function lisRecord() {
    try { return JSON.parse(localStorage.getItem(RECORD) || "null"); } catch (e) { return null; }
  }

  async function commence() {
    if (!STOCK) return;
    let deck = deckActuel(), extra = extraActuel();
    if (deck.length !== tailleDeck() || ouverts().indexOf(DUELLISTE) < 0) return;
    JETON = null;
    if (PROFIL) {
      try {
        const r = await api("/api/survivor/partie", "POST", { duelliste: DUELLISTE });
        JETON = r.jeton;
        deck = r.deck;
        extra = r.extra || extra;
      } catch (err) { /* le serveur ne répond pas : on joue quand même, sans rien gagner */ }
    }
    el("accueil").hidden = true;
    el("fin").hidden = true;
    el("pause").hidden = true;
    el("booster").hidden = true;
    el("table").hidden = false;
    el("releves").hidden = false;
    el("pauseBtn").hidden = false;
    fermeListe();
    fermePile();
    dimensionne();
    ETAT = M.nouvelle({ vue: VUE, deck, extra, duelliste: DUELLISTE });
    CAM.x = 0; CAM.y = 0;
    POS.clear(); EFFETS = []; NOMBRES = []; NIVEAUX.length = 0;
    SELECTION = null; CHOIX = null; REGARD = null; SURVOL = null;
    LP_AVANT = null; PAUSE = false; ABANDON = false; FILE = null; EXODIA_GARDEE = null;
    el("annonces").innerHTML = "";
    precharge(deck.concat(ETAT.deck, ETAT.extra));
    majInterface();
  }

  async function termine() {
    const f = ETAT.fini;
    const s = ETAT.stats;
    const titres = {
      defaite: ABANDON ? ["Duel abandonné", `Tu as tenu ${pluriel(ETAT.tour, "tour")}.`]
        : ["Tes LP tombent à zéro", `Tu as tenu ${pluriel(ETAT.tour, "tour")}.`],
      victoire: ["Victoire !", "Le dieu est tombé, les monstres se dispersent."],
    };
    el("finTitre").textContent = titres[f][0];
    el("finSous").textContent = titres[f][1];
    const r = lisRecord();
    const gagne = f === "victoire";
    const record = !ABANDON && (!r || gagne && !r.gagne || ETAT.tour > r.tour && (gagne || !r.gagne));
    if (record) {
      try {
        localStorage.setItem(RECORD, JSON.stringify({ tour: ETAT.tour, niveau: ETAT.joueur.niveau, tues: s.tues, gagne }));
      } catch (e) { /* stockage refusé : le record ne sera pas gardé */ }
    }
    const lignes = [["Tours", ETAT.tour], ["Niveau", ETAT.joueur.niveau], ["Ennemis vaincus", s.tues],
                    ["Boss vaincus", s.boss], ["Exodia", s.exodia], ["Cartes jouées", s.cartes]];
    el("bilan").innerHTML = lignes.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")
      + (record && r ? '<dt>Nouveau record</dt><dd>★</dd>' : "");
    const gain = el("finGain");
    gain.hidden = true;
    el("finDebloque").hidden = true;
    fermePile();
    setTimeout(() => { el("fin").hidden = false; }, ABANDON ? 0 : 800);
    if (JETON) {
      const jeton = JETON;
      JETON = null;
      try {
        const d = await api("/api/survivor/fin", "POST",
          { jeton, tours: ETAT.tour, tues: s.tues, boss: s.boss, exodia: s.exodia,
            niveau: ETAT.joueur.niveau, victoire: gagne, fusions: s.fusions, magies: s.magies,
            pieges: s.pieges, ramenees: s.ramenees, coup: s.coup, fil: s.fil, zones: s.zones,
            defense: s.defense, immobile: s.immobile, types: s.types });
        PROFIL = d;
        gain.innerHTML = `<b>+${d.gain}</b> Points de Duel<span>${d.dp} en tout</span>`;
        gain.hidden = false;
        majDp();
        annonceSucces(d.nouveaux_succes || [], d.debloques || []);
      } catch (err) { /* la partie ne paie pas : rien à montrer */ }
    }
  }

  /* Les succès que la partie vient d'accomplir, avec ce qu'ils rapportent,
     puis les duellistes qu'ils ouvrent : leur médaillon, et leurs cartes. */
  function annonceSucces(succes, duellistes) {
    const p = el("finDebloque");
    p.innerHTML = succes.map((cle) => {
      const x = STOCK.succes.find((s) => s.cle === cle);
      if (!x) return "";
      const gains = x.cartes.map((id) => M.carte(id).nom).concat(x.dp ? [`+${x.dp} Points de Duel`] : []);
      return `<p class="debloque"><span class="succes-marque"></span>
        <span><b>${esc(x.nom)}</b>${esc(gains.join(", "))}</span></p>`;
    }).concat(duellistes.map((cle) => {
      const du = M.duelliste(cle);
      return `<p class="debloque">${medaillon(cle)}
        <span><b>${esc(du.nom)} te rejoint !</b>${(du.cartes || []).length ? "Ses cartes entrent dans ta collection." : ""}</span></p>`;
    })).join("");
    p.hidden = !p.innerHTML;
  }

  function retourMenu() {
    fermePile();
    el("fin").hidden = true;
    el("table").hidden = true;
    el("releves").hidden = true;
    el("pauseBtn").hidden = true;
    el("accueil").hidden = false;
    ETAT = null;
    changeOnglet("jouer");
  }

  function pause() { if (!ETAT || ETAT.fini) return; PAUSE = true; el("pause").hidden = false; }
  function reprend() { PAUSE = false; el("pause").hidden = true; }

  /* =========================================================
     Les commandes
     ========================================================= */
  const DIRECTIONS = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0],
    Numpad8: [0, -1], Numpad2: [0, 1], Numpad4: [-1, 0], Numpad6: [1, 0],
  };

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // un bouton qui a le focus au clavier garde Entrée et Espace pour lui
    if ((e.key === "Enter" || e.code === "Space") && e.target.closest && e.target.closest("button")) return;
    if (!el("accueil").hidden) {
      if (e.key === "Enter" && ONGLET === "jouer") { e.preventDefault(); commence(); }
      if (e.key === "Escape" && CHOISIE) { CHOISIE = null; dessineAtelier(); }
      return;
    }
    if (!ETAT) return;
    if (ETAT.fini) {
      if (e.key === "Enter" && !el("fin").hidden) { e.preventDefault(); commence(); }
      return;
    }
    // une pile ouverte se regarde : rien ne bouge tant qu'elle l'est
    if (PILE) {
      if (e.key === "Escape") { e.preventDefault(); if (REGARD) { REGARD = null; majInterface(); } else fermePile(); }
      return;
    }
    if (ETAT.attente) {
      const m = /^(?:Digit|Numpad)([1-3])$/.exec(e.code);
      if (m) { e.preventDefault(); choisitOffre(Number(m[1]) - 1); }
      if (e.key === "Escape" && REGARD) { REGARD = null; dessineFiche(); }
      return;
    }
    if (PAUSE) { if (e.key === "Escape") reprend(); return; }
    if (LISTE) {
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      if (m) { e.preventDefault(); choisitOption(Number(m[1]) - 1); }
      if (e.key === "Enter" && LISTE.plusieurs) { e.preventDefault(); valideListe(); }
      if (e.key === "Escape") annule();
      return;
    }
    const d = DIRECTIONS[e.code];
    if (d) { e.preventDefault(); geste({ t: "bouge", dx: d[0], dy: d[1] }); return; }
    if (e.code === "Space" || e.code === "Numpad5" || e.key === ".") { e.preventDefault(); geste({ t: "attend" }); return; }
    const chiffre = /^Digit([1-9])$/.exec(e.code);
    if (chiffre) { e.preventDefault(); clicCarte(Number(chiffre[1]) - 1); return; }
    if (e.key === "Enter" && SELECTION != null && !CHOIX) { e.preventDefault(); joueSelection(); return; }
    if (e.key === "Escape") {
      if (CHOIX || SELECTION != null || REGARD) annule(); else pause();
    }
  });

  /* Un bouton cliqué à la souris ou au doigt rend le focus : sinon la
     barre d'espace, qui attend, le cliquerait à nouveau. */
  function lacheFocus(e) { if (e.detail > 0 && e.target.closest) { const b = e.target.closest("button"); if (b) b.blur(); } }

  el("main").addEventListener("click", (e) => {
    const b = e.target.closest("[data-index]");
    lacheFocus(e);
    if (b) clicCarte(Number(b.dataset.index));
  });
  ["zonesMonstres", "zonesMagies"].forEach((id) => el(id).addEventListener("click", (e) => {
    const b = e.target.closest("[data-zone]");
    lacheFocus(e);
    if (b) clicZone(b.dataset.zone);
  }));
  el("fiche").addEventListener("click", (e) => {
    const p = e.target.closest("[data-pile]");
    lacheFocus(e);
    if (p) { ouvrePile(p.dataset.pile); return; }
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const quoi = b.dataset.action;
    if (quoi === "jouer") joueSelection();
    else if (quoi === "payer") paieBourse();
    else if (quoi === "effet") joueEffet();
    else if (quoi === "garder" && REGARD && REGARD.offre != null) choisitOffre(REGARD.offre);
    else if (quoi === "fermer" && ETAT && ETAT.attente) { REGARD = null; OFFRE_VUE = null; marqueOffre(); dessineFiche(); }
    else annule();
  });
  el("offres").addEventListener("click", (e) => {
    const b = e.target.closest("[data-offre]");
    if (!b || !ETAT || !ETAT.attente) return;
    const k = Number(b.dataset.offre);
    const o = ETAT.attente.offres[k];
    if (ETROIT.matches && o && o.id && OFFRE_VUE !== k && BOOSTER_PRET) {
      OFFRE_VUE = k;
      REGARD = { id: o.id, offre: k };
      marqueOffre();
      dessineFiche();
      return;
    }
    choisitOffre(k);
  });
  el("boosterPasser").addEventListener("click", (e) => { lacheFocus(e); passeBooster(); });
  el("boosterRelancer").addEventListener("click", (e) => { lacheFocus(e); relanceBooster(); });

  /* La bulle des mots-clés : au survol à la souris, d'un toucher au doigt
     (qui ne choisit pas la carte du booster sous le mot). */
  const bulle = document.createElement("div");
  bulle.className = "bulle";
  bulle.hidden = true;
  document.body.appendChild(bulle);
  let BULLE_SUR = null;
  function montreBulle(m) {
    const k = m.dataset.mot;
    if (!M.MOTS[k]) return;
    BULLE_SUR = m;
    bulle.innerHTML = `<b>${esc(k.charAt(0).toUpperCase() + k.slice(1))}</b> : ${esc(M.MOTS[k])}`;
    bulle.hidden = false;
    const r = m.getBoundingClientRect(), b = bulle.getBoundingClientRect();
    const x = Math.max(8, Math.min(window.innerWidth - b.width - 8, r.left + r.width / 2 - b.width / 2));
    const y = r.top - b.height - 8 >= 8 ? r.top - b.height - 8 : r.bottom + 8;
    bulle.style.left = `${x}px`;
    bulle.style.top = `${y}px`;
  }
  function cacheBulle() { BULLE_SUR = null; bulle.hidden = true; }
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const m = e.target.closest && e.target.closest(".mot");
    if (m) montreBulle(m);
    else if (BULLE_SUR) cacheBulle();
  });
  let POINTE = "mouse";
  document.addEventListener("pointerdown", (e) => { POINTE = e.pointerType; }, true);
  document.addEventListener("click", (e) => {
    const m = e.target.closest && e.target.closest(".mot");
    if (!m || POINTE === "mouse") { if (POINTE !== "mouse") cacheBulle(); return; }
    e.stopPropagation();
    e.preventDefault();
    if (BULLE_SUR === m) cacheBulle(); else montreBulle(m);
  }, true);
  el("options").addEventListener("click", (e) => {
    lacheFocus(e);
    if (e.target.closest("[data-valider]")) { valideListe(); return; }
    const b = e.target.closest("[data-option]");
    if (b) choisitOption(Number(b.dataset.option));
  });
  el("choixAnnuler").addEventListener("click", (e) => { lacheFocus(e); annule(); });
  el("pileCartes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pile-carte]");
    lacheFocus(e);
    if (!b || !PILE) return;
    const place = Number(b.dataset.pileCarte);
    REGARD = REGARD && REGARD.pile && REGARD.place === place ? null : { id: b.dataset.id, pile: true, place };
    dessinePile();
    dessineFiche();
  });
  el("pileFermer").addEventListener("click", (e) => { lacheFocus(e); fermePile(); });
  /* « Attendre » : sous « Ton duel » au bureau, à côté de la main au
     téléphone, où la fiche n'est pas à l'écran. */
  ["attendreBtn", "attendreTel"].forEach((id) => el(id).addEventListener("click", (e) => {
    lacheFocus(e);
    fermePile();
    geste({ t: "attend" });
  }));
  el("pauseBtn").addEventListener("click", (e) => { lacheFocus(e); if (PAUSE) reprend(); else pause(); });
  el("reprendre").addEventListener("click", reprend);
  el("abandonner").addEventListener("click", () => {
    PAUSE = false; el("pause").hidden = true;
    ABANDON = true; ETAT.fini = "defaite";
    termine();
  });
  el("commencer").addEventListener("click", commence);
  el("duellistes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-duelliste]");
    lacheFocus(e);
    if (b) choisitDuelliste(b.dataset.duelliste);
  });
  el("rejouer").addEventListener("click", commence);
  el("menu").addEventListener("click", retourMenu);
  document.querySelectorAll(".onglet").forEach((b) => b.addEventListener("click", (e) => {
    lacheFocus(e);
    changeOnglet(b.dataset.onglet);
  }));
  el("atelierListes").addEventListener("click", (e) => {
    if (e.target.closest("[data-boutique]")) { lacheFocus(e); ouvreBoosterBoutique(); return; }
    const f = e.target.closest("[data-filtre]");
    if (f) { lacheFocus(e); FILTRE = f.dataset.filtre; dessineAtelier(); return; }
    const b = e.target.closest("[data-carte]");
    lacheFocus(e);
    if (!b) return;
    CHOISIE = { id: b.dataset.carte, ou: b.dataset.ou };
    dessineAtelier();
  });
  /* Le clic droit, comme dans un simulateur : une carte de la collection
     entre dans le deck (une fusion dans l'Extra Deck), une carte du deck en
     sort. */
  el("atelierListes").addEventListener("contextmenu", (e) => {
    const b = e.target.closest("[data-carte]");
    if (!b || ONGLET !== "deck") return;
    e.preventDefault();
    bascule(b.dataset.carte, true);
  });
  el("atelierListes").addEventListener("change", (e) => {
    if (e.target.id === "triCollection") { TRI = e.target.value; dessineAtelier(); }
  });
  el("ficheAtelier").addEventListener("click", (e) => {
    const b = e.target.closest("[data-atelier]");
    lacheFocus(e);
    if (b) actionAtelier(b.dataset.atelier);
  });

  /* La souris qui passe sur une carte (main, terrain, booster, liste) ou
     sur un ennemi le montre dans la fiche. */
  function survoleDom(e) {
    if (e.pointerType !== "mouse" || !ETAT) return;
    const z = e.target.closest("[data-zone],[data-index],[data-offre],[data-option],[data-pile-carte]");
    let s = null;
    if (z && z.dataset.pileCarte != null) s = { id: z.dataset.id };
    else if (z && z.dataset.index != null) s = { id: ETAT.main[Number(z.dataset.index)] };
    else if (z && z.dataset.zone != null) { const id = idDeZone(z.dataset.zone); if (id) s = { id, zone: z.dataset.zone }; }
    else if (z && z.dataset.offre != null && ETAT.attente) {
      const o = ETAT.attente.offres[Number(z.dataset.offre)];
      if (o && o.id) s = { id: o.id };
    } else if (z && z.dataset.option != null && LISTE) {
      const o = M.options(ETAT, LISTE.index)[Number(z.dataset.option)];
      if (o) s = { id: o.id };
    }
    if ((s && s.id) !== (SURVOL && SURVOL.id) || (s && s.zone) !== (SURVOL && SURVOL.zone)) { SURVOL = s; dessineFiche(); }
  }
  ["main", "zonesMonstres", "zonesMagies", "offres", "options", "pileCartes"].forEach((id) => {
    el(id).addEventListener("pointerover", survoleDom);
    el(id).addEventListener("pointerleave", () => { if (SURVOL && SURVOL.id) { SURVOL = null; dessineFiche(); } });
  });

  function survoleCase(px, py) {
    const x = Math.floor((px - O.x) / T), y = Math.floor((py - O.y) / T);
    const e = ETAT.ennemis.find((n) => M.dans(n, x, y));
    const uid = e ? e.uid : null;
    if (uid !== (SURVOL && SURVOL.uid || null)) {
      SURVOL = uid ? { uid } : (SURVOL && SURVOL.uid ? null : SURVOL);
      dessineFiche();
    }
  }

  /* Le plateau au doigt : toucher d'un côté du joueur pour y faire un pas,
     glisser, ou garder appuyé pour marcher. */
  let APPUI = null;

  function directionVers(px, py) {
    const dx = px - W / 2, dy = py - H / 2;
    if (Math.abs(dx) < T / 2 && Math.abs(dy) < T / 2) return null;
    return Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
  }

  toile.addEventListener("pointerdown", (e) => {
    if (!enJeu() || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    toile.setPointerCapture(e.pointerId);
    APPUI = { x0: e.offsetX, y0: e.offsetY, x: e.offsetX, y: e.offsetY, id: e.pointerId, repete: false };
    APPUI.minuteur = setTimeout(function repete() {
      if (!APPUI) return;
      const d = directionVers(APPUI.x, APPUI.y);
      if (d) { APPUI.repete = true; geste({ t: "bouge", dx: d[0], dy: d[1] }); }
      APPUI.minuteur = setTimeout(repete, CADENCE + 30);
    }, 300);
  });
  toile.addEventListener("pointermove", (e) => {
    if (APPUI && e.pointerId === APPUI.id) { APPUI.x = e.offsetX; APPUI.y = e.offsetY; return; }
    if (e.pointerType === "mouse" && ETAT) survoleCase(e.offsetX, e.offsetY);
  });
  function lache(e) {
    if (!APPUI || e.pointerId !== APPUI.id) return;
    clearTimeout(APPUI.minuteur);
    const a = APPUI;
    APPUI = null;
    if (a.repete || e.type === "pointercancel") return;
    const dx = a.x - a.x0, dy = a.y - a.y0;
    if (Math.hypot(dx, dy) > 24) {
      geste(Math.abs(dx) > Math.abs(dy) ? { t: "bouge", dx: Math.sign(dx), dy: 0 }
                                         : { t: "bouge", dx: 0, dy: Math.sign(dy) });
      return;
    }
    const d = directionVers(a.x0, a.y0);
    geste(d ? { t: "bouge", dx: d[0], dy: d[1] } : { t: "attend" });
  }
  toile.addEventListener("pointerup", lache);
  toile.addEventListener("pointercancel", lache);
  toile.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && SURVOL && SURVOL.uid) { SURVOL = null; dessineFiche(); }
  });

  /* =========================================================
     Le chargement
     ========================================================= */
  async function demarre() {
    try {
      const r = await fetch("/static/survivor/cartes.json", { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status);
      STOCK = await r.json();
      M.charge(STOCK);
    } catch (err) {
      el("commencer").disabled = true;
      el("record").textContent = "Les cartes du jeu ne se chargent pas. Recharge la page.";
      return;
    }
    try { PROFIL = await api("/api/survivor"); } catch (err) { PROFIL = null; }
    majDp();
    rappelleDuelliste();
    changeOnglet("jouer");
    precharge(STOCK.ennemis[0]);
    requestAnimationFrame(boucle);
  }

  demarre();
})();
