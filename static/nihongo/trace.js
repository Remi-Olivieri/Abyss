/* =======================================================================
   Nihongo - trace.js

   La case où l'on trace un caractère, trait par trait, au doigt, au stylet
   ou à la souris.

   Chaque trait est jugé dès qu'on lève le doigt, contre le trait attendu
   de KanjiVG (voir static/nihongo/traces-kana.json et nihongo.py). Le
   doigt et le modèle sont ramenés à 20 points pris à distances égales le
   long du trait : deux traits de même forme donnent alors les mêmes
   points, qu'on les ait tracés vite ou lentement. Restent trois questions,
   dans cet ordre :

     - la forme : une fois les deux traits superposés (centre sur centre,
       même étendue), les points correspondants sont-ils proches ?
     - le sens : la même forme, parcourue à l'envers, est une faute à part
       entière - un trait se trace toujours de haut en bas et de gauche à
       droite, et c'est ce qui donne aux kanas leur dessin ;
     - la place : le trait est-il au bon endroit de la case ?

   Un trait juste est remplacé par le trait du modèle, à l'encre : on voit
   le caractère se construire proprement, et non ses propres hésitations.
   Deux échecs sur le même trait, et le modèle le montre.

   Les seuils ont été réglés sur les 481 traits des kanas (voir SEUILS) :
   larges, parce qu'on trace au doigt sur un téléphone, mais pas au point
   de confondre deux traits d'un même caractère.
   ======================================================================= */
(function () {
  "use strict";

  const TAILLE = 109;                 // le carré de KanjiVG
  const NS = "http://www.w3.org/2000/svg";

  const SEUILS = {
    forme: 13,     // écart moyen toléré, en unités de la case (sur 109)...
    formeRel: 0.75, // ...et au plus les trois quarts de l'étendue du trait
    formeMini: 5,
    angle: 50,     // écart de direction toléré, en degrés, d'un bout à l'autre
    place: 24,     // distance tolérée entre les centres des deux traits
    petit: 16,     // en dessous, un trait est un point : seule sa place compte
    taille: [0.4, 2.4],   // rapport d'étendue toléré, doigt / modèle
  };

  /* ---------- géométrie : pure, et testée ---------- */
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  function longueur(p) {
    let l = 0;
    for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]);
    return l;
  }

  function reechantillonne(points, n) {
    n = n || 20;
    if (!points.length) return [];
    const total = longueur(points);
    if (points.length < 2 || total === 0) {
      return Array.from({ length: n }, () => points[0].slice());
    }
    const pas = total / (n - 1);
    const sortie = [points[0].slice()];
    let parcouru = 0, cible = pas;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const seg = dist(a, b);
      while (seg > 0 && parcouru + seg >= cible - 1e-9 && sortie.length < n - 1) {
        const t = (cible - parcouru) / seg;
        sortie.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        cible += pas;
      }
      parcouru += seg;
    }
    sortie.push(points[points.length - 1].slice());
    return sortie;
  }

  /* Un chemin SVG de KanjiVG mis à plat en points : M, C et S, absolus ou
     relatifs, avec répétitions implicites (« c 1,2 3,4 5,6 7,8 9,10 11,12 »
     fait deux courbes). Le même calcul que polyligne dans nihongo.py, qui
     refuse à la fabrication tout chemin que celui-ci ne saurait pas lire :
     les fichiers ne portent que les chemins, deux fois plus légers que
     chemins et points. */
  const JETON = /[MmCcSsLl]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  const NOMBRE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

  function polyligne(d) {
    const jetons = String(d).match(JETON) || [];
    const points = [];
    let i = 0, cmd = null, x = 0, y = 0, ctrl = null;
    const nombres = (n) => {
      const morceau = jetons.slice(i, i + n);
      if (morceau.length < n || morceau.some((v) => !NOMBRE.test(v))) throw new Error("chemin tronqué : " + d);
      i += n;
      return morceau.map(Number);
    };
    const cubique = (x0, y0, x1, y1, x2, y2, x3, y3) => {
      for (let k = 1; k <= 16; k++) {
        const s = k / 16, u = 1 - s;
        points.push([u * u * u * x0 + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x3,
                     u * u * u * y0 + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y3]);
      }
    };
    while (i < jetons.length) {
      if (!NOMBRE.test(jetons[i])) cmd = jetons[i++];
      else if (cmd === null) throw new Error("chemin sans commande : " + d);
      const rel = cmd === cmd.toLowerCase(), c = cmd.toUpperCase();
      if (c === "M" || c === "L") {
        const [a, b] = nombres(2);
        [x, y] = rel ? [x + a, y + b] : [a, b];
        points.push([x, y]);
        ctrl = null;
        if (c === "M") cmd = rel ? "l" : "L";      // la suite d'un M est un L
      } else if (c === "C" || c === "S") {
        let x1, y1, x2, y2, x3, y3;
        if (c === "C") {
          [x1, y1, x2, y2, x3, y3] = nombres(6);
          if (rel) { x1 += x; y1 += y; x2 += x; y2 += y; x3 += x; y3 += y; }
        } else {
          [x2, y2, x3, y3] = nombres(4);
          if (rel) { x2 += x; y2 += y; x3 += x; y3 += y; }
          // le premier point de contrôle : le reflet du précédent
          [x1, y1] = ctrl ? [2 * x - ctrl[0], 2 * y - ctrl[1]] : [x, y];
        }
        cubique(x, y, x1, y1, x2, y2, x3, y3);
        ctrl = [x2, y2];
        x = x3; y = y3;
      } else {
        throw new Error("commande " + cmd + " non gérée : " + d);
      }
    }
    return points;
  }

  /* Les traits d'un caractère, prêts à comparer : [{ d, p }]. Les fichiers
     donnent les chemins seuls ; les points sont calculés une fois, au
     premier besoin, et gardés. */
  const POINTS = new Map();
  function prepare(traits) {
    return (traits || []).map((t) => {
      const d = typeof t === "string" ? t : t.d;
      if (!POINTS.has(d)) POINTS.set(d, reechantillonne(polyligne(d), 20));
      return { d, p: POINTS.get(d) };
    });
  }

  function centre(p) {
    let x = 0, y = 0;
    p.forEach((q) => { x += q[0]; y += q[1]; });
    return [x / p.length, y / p.length];
  }

  function ecart(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += dist(a[i], b[i]);
    return s / a.length;
  }

  /* L'étendue d'un trait autour de son centre (rayon de giration). Plutôt
     que sa longueur : un doigt qui tremble allonge le chemin de chaque
     zigzag, il ne change presque pas l'étendue. */
  function rayon(p) {
    const c = centre(p);
    let s = 0;
    p.forEach((q) => { s += (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2; });
    return Math.sqrt(s / p.length);
  }

  /* `u` posé sur `ref` : même centre, même étendue. */
  function superpose(u, ref) {
    const cu = centre(u), cr = centre(ref);
    const ru = rayon(u), rr = rayon(ref);
    const k = ru > 0 ? rr / ru : 1;
    return u.map((q) => [cr[0] + (q[0] - cu[0]) * k, cr[1] + (q[1] - cu[1]) * k]);
  }

  /* Un trait contre un modèle, sans se soucier des autres traits.
     `decalage` : où la main dessine par rapport au modèle (voir decalage),
     retiré avant de juger la place. -> { ok, raison, place } */
  function compare(trait, ref, decalage) {
    const [dx, dy] = decalage || [0, 0];
    const u = reechantillonne(trait, ref.length).map((q) => [q[0] - dx, q[1] - dy]);
    const rr = rayon(ref), ru = rayon(u);
    const place = dist(centre(u), centre(ref));

    // un point, un petit trait de dakuten : la forme d'un trait de trois
    // unités ne veut rien dire, on ne regarde que l'endroit
    if (longueur(ref) < SEUILS.petit) {
      const court = ru <= rr * 2.5 + 4;
      if (place <= SEUILS.place * 0.6 && court) return { ok: true, place };
      return { ok: false, raison: court ? "place" : "forme", place };
    }

    const rapport = ru / rr;
    const tailleOk = rapport >= SEUILS.taille[0] && rapport <= SEUILS.taille[1];
    // l'écart toléré suit la taille du trait : 13 unités, c'est beaucoup
    // pour une barre de quinze, et une diagonale y passerait pour elle
    const seuil = Math.min(SEUILS.forme, Math.max(SEUILS.formeMini, SEUILS.formeRel * rr));
    const ressemble = (v) => ecart(superpose(v, ref), ref) <= seuil && direction(v, ref);
    const forme = ressemble(u);
    if (forme && tailleOk && place <= SEUILS.place) return { ok: true, place };
    if (tailleOk && place <= SEUILS.place && ressemble(u.slice().reverse())) {
      return { ok: false, raison: "sens", place };
    }
    if (forme && tailleOk) return { ok: false, raison: "place", place };
    return { ok: false, raison: "forme", place };
  }

  /* Les deux traits vont-ils dans la même direction, d'un bout à l'autre ?
     Sans objet pour un trait qui revient près de son départ (la boucle de
     の) : sa corde ne dit rien de sa forme. */
  function direction(u, ref) {
    const a = ref[0], b = ref[ref.length - 1];
    if (dist(a, b) < 0.5 * longueur(ref)) return true;
    const c = u[0], d = u[u.length - 1];
    let ecartAngle = Math.abs(Math.atan2(d[1] - c[1], d[0] - c[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
    if (ecartAngle > Math.PI) ecartAngle = 2 * Math.PI - ecartAngle;
    return ecartAngle * 180 / Math.PI <= SEUILS.angle;
  }

  /* Où la main dessine, par rapport au modèle : l'écart moyen entre les
     traits déjà acceptés et les leurs. De mémoire, on trace rarement pile au
     centre de la case ; une fois le premier trait posé, les suivants sont
     jugés là où la main a commencé, et non là où le modèle les attendait.
     `poses` : [[trait du doigt, trait du modèle], ...] */
  function decalage(poses) {
    if (!poses || !poses.length) return [0, 0];
    let x = 0, y = 0;
    poses.forEach(([u, ref]) => {
      const cu = centre(u), cr = centre(ref);
      x += cu[0] - cr[0];
      y += cu[1] - cr[1];
    });
    return [x / poses.length, y / poses.length];
  }

  /* Le trait du doigt contre le trait attendu, et contre les autres traits
     du caractère. -> { ok: true }
                   ou { ok: false, raison: "forme" | "sens" | "place" | "ordre" | "deja" }

     Les autres traits servent à reconnaître un trait juste au mauvais
     moment. Les deux barres de き se ressemblent et sont proches : la
     seconde, tracée en premier, passerait pour la première - sauf qu'elle
     colle nettement mieux à la seconde. Même chose pour un trait déjà fait
     qu'on retrace par-dessus.

     Les petits traits (les deux de ゛) ne servent pas de témoin : ils se
     touchent presque, et le moindre décalage ferait prendre l'un pour
     l'autre. */
  function juge(trait, ref, suivants, precedents, poses) {
    const dec = decalage(poses);
    const r = compare(trait, ref, dec);
    const autres = [...(suivants || []).map((p) => [p, "ordre"]),
                    ...(precedents || []).map((p) => [p, "deja"])];
    for (const [p, raison] of autres) {
      if (longueur(p) < SEUILS.petit && longueur(ref) < SEUILS.petit) continue;
      const s = compare(trait, p, dec);
      if (s.ok && (!r.ok || s.place + 4 < r.place)) return { ok: false, raison };
    }
    return r.ok ? { ok: true } : { ok: false, raison: r.raison };
  }

  /* La note d'une carte d'écriture : sans faute, c'est « bien » ; quelques
     hésitations, « difficile » ; un trait qu'il a fallu montrer, « raté ». */
  function note(bilan) {
    if (bilan.indices > 0) return 1;
    if (bilan.erreurs > 0) return 2;
    return 3;
  }

  const MESSAGES = {
    forme: "Ce n'est pas ce trait-là.",
    sens: "Bonne forme, mais dans l'autre sens.",
    place: "Bonne forme, mais pas au bon endroit.",
    ordre: "Bon trait, mais pas encore : l'ordre compte.",
    deja: "Celui-là est déjà tracé.",
  };

  /* ---------- la case ---------- */
  function noeud(nom, attrs, parent) {
    const e = document.createElementNS(NS, nom);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function chemin(points) {
    return points.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
  }

  /* Monte une case dans `hote`.
       traits  : [{ d, p }] - les traits du caractère, dans l'ordre
       mode    : "guide"   le modèle en filigrane, le départ du trait marqué
                 "memoire" la case nue
                 "demo"    on regarde, on ne trace pas
       numeros : les numéros des traits, à leur point de départ
       surTrait({ rang, ok, raison, message }), surFin({ erreurs, indices })
     Rend { recommence, anime, mode, detruit }. */
  function monte(hote, options) {
    const opt = Object.assign({ mode: "guide", traits: [], numeros: false,
                                surTrait: null, surFin: null, etiquette: "" }, options);
    opt.traits = prepare(opt.traits);
    hote.innerHTML = "";
    const svg = noeud("svg", { viewBox: `0 0 ${TAILLE} ${TAILLE}`, class: "tr-svg",
                               role: "img", "aria-label": opt.etiquette || "Case de tracé" }, hote);
    const gGrille = noeud("g", { class: "tr-grille" }, svg);
    noeud("rect", { x: 0.75, y: 0.75, width: TAILLE - 1.5, height: TAILLE - 1.5, rx: 3 }, gGrille);
    noeud("path", { class: "tr-croix", d: `M54.5 2V107M2 54.5H107` }, gGrille);
    const gModele = noeud("g", { class: "tr-modele" }, svg);
    const gIndice = noeud("g", { class: "tr-indice" }, svg);
    const gFaits = noeud("g", { class: "tr-faits" }, svg);
    const gNumeros = noeud("g", { class: "tr-numeros" }, svg);
    const encre = noeud("path", { class: "tr-encre", d: "" }, svg);
    const depart = noeud("circle", { class: "tr-depart", r: 3, cx: -20, cy: -20 }, svg);

    let rang = 0, erreurs = 0, erreursTrait = 0, indices = 0;
    let actif = null, fini = false, jetonRate = 0;
    let poses = [];          // [trait du doigt, trait du modèle], voir decalage
    // La démonstration en cours, et elle seule : tracer pendant qu'elle se
    // joue l'interrompt et vide la case. Le trait montré après deux échecs
    // n'en est pas une - le prendre pour elle faisait tout recommencer au
    // trait suivant, compteurs d'erreurs remis à zéro (« Sans une
    // hésitation » après trois ratés).
    let animations = [];
    let demo = false;

    function arreteAnimations() {
      animations.forEach((a) => { try { a.cancel(); } catch (e) { /* déjà finie */ } });
      animations = [];
      demo = false;
    }

    function dessineModele() {
      gModele.innerHTML = "";
      if (opt.mode === "guide") opt.traits.forEach((t) => noeud("path", { d: t.d }, gModele));
      gNumeros.innerHTML = "";
      if (opt.numeros) {
        opt.traits.forEach((t, i) => {
          // le numéro se pose un peu avant le départ, à l'opposé du trait
          const [x0, y0] = t.p[0], [x1, y1] = t.p[Math.min(3, t.p.length - 1)];
          const d = Math.hypot(x1 - x0, y1 - y0) || 1;
          const x = Math.min(104, Math.max(5, x0 - (x1 - x0) / d * 6));
          const y = Math.min(106, Math.max(7, y0 - (y1 - y0) / d * 6 + 2.5));
          noeud("text", { x: x.toFixed(1), y: y.toFixed(1) }, gNumeros).textContent = String(i + 1);
        });
      }
      majDepart();
    }

    function majDepart() {
      const t = opt.traits[rang];
      const visible = opt.mode === "guide" && t && !fini;
      depart.setAttribute("cx", visible ? t.p[0][0] : -20);
      depart.setAttribute("cy", visible ? t.p[0][1] : -20);
    }

    /* Un trait qui se dessine, comme sous le pinceau. getTotalLength sur
       un élément déjà dans la page ; à défaut, la longueur des points. */
    function traitAnime(parent, trait, delai, classe, sansSuivi) {
      const p = noeud("path", { d: trait.d, class: classe || "tr-trait" }, parent);
      let l = 0;
      try { l = p.getTotalLength(); } catch (e) { l = 0; }
      if (!l) l = longueur(trait.p) * 1.05 + 2;
      const duree = 260 + l * 8;
      p.style.strokeDasharray = `${l} ${l}`;
      p.style.strokeDashoffset = String(l);
      p.style.opacity = "0";
      if (typeof p.animate === "function") {
        const a = p.animate([
          { strokeDashoffset: l, opacity: 0, offset: 0 },
          { strokeDashoffset: l * 0.97, opacity: 1, offset: 0.03 },
          { strokeDashoffset: 0, opacity: 1, offset: 1 },
        ], { duration: duree, delay: delai, easing: "ease-in-out", fill: "forwards" });
        if (!sansSuivi) animations.push(a);
      } else {
        p.style.strokeDashoffset = "0";
        p.style.opacity = "1";
      }
      return duree;
    }

    /* L'ordre des traits, du premier au dernier. */
    function anime() {
      arreteAnimations();
      gFaits.innerHTML = "";
      gIndice.innerHTML = "";
      encre.setAttribute("d", "");
      let t = 120;
      opt.traits.forEach((trait) => { t += traitAnime(gFaits, trait, t) + 140; });
      demo = true;
      if (opt.mode !== "demo") {
        // après la démonstration, la case se vide pour qu'on trace à son tour
        const attente = setTimeout(() => recommence(), t + 500);
        animations.push({ cancel: () => clearTimeout(attente) });
      }
      return t;
    }

    function recommence() {
      arreteAnimations();
      rang = 0; erreurs = 0; erreursTrait = 0; indices = 0; fini = false; poses = [];
      gFaits.innerHTML = "";
      gIndice.innerHTML = "";
      encre.setAttribute("d", "");
      svg.classList.remove("tr-fini");
      dessineModele();
      if (opt.mode === "demo") opt.traits.forEach((t) => noeud("path", { d: t.d, class: "tr-trait" }, gFaits));
    }

    function montreIndice() {
      const t = opt.traits[rang];
      if (!t) return;
      if (!gIndice.childNodes.length) indices++;
      gIndice.innerHTML = "";
      traitAnime(gIndice, t, 0, "tr-trait-indice", true);
    }

    function evalue(points) {
      const ref = opt.traits[rang];
      if (!ref) return;
      // un simple contact du doigt n'est pas un trait (sauf là où on attend un point)
      if (longueur(points) < 1.5 && longueur(ref.p) >= SEUILS.petit) {
        encre.setAttribute("d", "");
        return;
      }
      const r = juge(points, ref.p, opt.traits.slice(rang + 1).map((t) => t.p),
                     opt.traits.slice(0, rang).map((t) => t.p), poses);
      if (r.ok) {
        poses.push([points, ref.p]);
        encre.setAttribute("d", "");
        gIndice.innerHTML = "";
        noeud("path", { d: ref.d, class: "tr-trait tr-pose" }, gFaits);
        rang++;
        erreursTrait = 0;
        fini = rang >= opt.traits.length;
        majDepart();
        if (opt.surTrait) opt.surTrait({ rang, ok: true });
        if (fini) {
          svg.classList.add("tr-fini");
          if (opt.surFin) opt.surFin({ erreurs, indices });
        }
        return;
      }
      erreurs++;
      erreursTrait++;
      const jeton = ++jetonRate;
      encre.classList.add("tr-rate");
      setTimeout(() => {
        if (jeton !== jetonRate) return;
        encre.classList.remove("tr-rate");
        if (!actif) encre.setAttribute("d", "");
      }, 650);
      if (erreursTrait >= 2) montreIndice();
      if (opt.surTrait) opt.surTrait({ rang, ok: false, raison: r.raison, message: MESSAGES[r.raison] });
    }

    /* ---------- le doigt ---------- */
    function coord(e) {
      const r = svg.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width * TAILLE, (e.clientY - r.top) / r.height * TAILLE];
    }
    svg.addEventListener("pointerdown", (e) => {
      if (fini || opt.mode === "demo" || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      // tracer pendant la démonstration l'interrompt : on a compris
      if (demo) recommence();
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ }
      jetonRate++;
      encre.classList.remove("tr-rate");
      actif = { id: e.pointerId, points: [coord(e)] };
      encre.setAttribute("d", chemin(actif.points));
    });
    svg.addEventListener("pointermove", (e) => {
      if (!actif || e.pointerId !== actif.id) return;
      const serie = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      (serie.length ? serie : [e]).forEach((ev) => actif.points.push(coord(ev)));
      encre.setAttribute("d", chemin(actif.points));
    });
    svg.addEventListener("pointerup", (e) => {
      if (!actif || e.pointerId !== actif.id) return;
      const points = actif.points;
      actif = null;
      evalue(points);
    });
    svg.addEventListener("pointercancel", (e) => {
      if (!actif || e.pointerId !== actif.id) return;
      actif = null;
      encre.setAttribute("d", "");
    });

    recommence();

    return {
      recommence,
      anime,
      montreIndice,
      mode(m) { opt.mode = m; recommence(); },
      detruit() { arreteAnimations(); hote.innerHTML = ""; },
      get fini() { return fini; },
    };
  }

  window.Trace = { monte, juge, note, prepare, MESSAGES, SEUILS,
                   geo: { polyligne, reechantillonne, longueur, centre, rayon, ecart, superpose, decalage } };
})();
