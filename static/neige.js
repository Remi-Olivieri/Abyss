/* Neige marine — le fond animé de tout le hub.

   Trois pages l'affichaient, avec trois copies du même code : Abyss, le
   profil, et maintenant les suggestions. Les deux premières avaient déjà
   commencé à diverger — même code, mais l'une avait perdu tous ses
   commentaires en chemin. Une quatrième copie n'était pas envisageable.

   Le script s'active tout seul s'il trouve un <canvas id="neige"> ; une
   page qui n'en a pas ne paie rien. À charger en `defer` : il lit le DOM
   au démarrage.
*/
(function () {
  const reduit = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const c = document.getElementById("neige");
  // `!c` d'abord : le fichier est desormais partage, une page sans canvas
  // ne doit pas lever une erreur qui emporterait le reste de son script
  if (!c) return;
  if (reduit || !c.getContext) { c.style.display = "none"; return; }
  const ctx = c.getContext("2d");
  let w = 0, h = 0, grains = [];

  /* halo pré-dessiné : bien plus rapide que shadowBlur sur chaque grain */
  const halo = (function () {
    const t = 40, s = document.createElement("canvas");
    s.width = s.height = t;
    const g = s.getContext("2d");
    const d = g.createRadialGradient(t / 2, t / 2, 0, t / 2, t / 2, t / 2);
    d.addColorStop(0, "rgba(232,247,255,1)");
    d.addColorStop(.16, "rgba(188,230,250,.62)");
    d.addColorStop(.42, "rgba(130,198,232,.2)");
    d.addColorStop(1, "rgba(110,185,225,0)");
    g.fillStyle = d;
    g.fillRect(0, 0, t, t);
    return s;
  })();

  function init() {
    const d = window.devicePixelRatio || 1;
    w = window.innerWidth; h = window.innerHeight;
    c.width = w * d; c.height = h * d;
    c.style.width = w + "px"; c.style.height = h + "px";
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const n = Math.min(210, Math.round((w * h) / 20000));
    grains = Array.from({ length: n }, () => {
      const p = Math.random();            // profondeur : 0 = au loin, 1 = tout près
      return {
      x: Math.random() * w,
      y: Math.random() * h,
        r: .5 + p * 2,                    // les proches sont plus gros
        v: .035 + p * .21,                //  ... et tombent plus vite
        a: .1 + p * .42,                  //  ... et brillent plus fort
        ph: Math.random() * Math.PI * 2,  // phase de scintillement
        sp: .006 + Math.random() * .016,
        d: Math.random() * Math.PI * 2    // phase de dérive latérale
      };
    });
  }

  function boucle() {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";  // les halos s'additionnent
    for (const g of grains) {
      g.y += g.v;
      g.d += .004;
      g.ph += g.sp;
      if (g.y > h + 8) { g.y = -8; g.x = Math.random() * w; }
      const x = g.x + Math.sin(g.d) * 10;
      const taille = g.r * 9;
      ctx.globalAlpha = g.a * (.7 + .3 * Math.sin(g.ph));
      ctx.drawImage(halo, x - taille / 2, g.y - taille / 2, taille, taille);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(boucle);
  }

  init();
  /* init() redimensionne le canvas ET recree tous les grains. Un
     redimensionnement de fenetre emet des dizaines d'evenements : sans
     ce delai, on reconstruit 210 objets a chaque pixel tire a la souris. */
  let redim;
  window.addEventListener("resize", () => {
    clearTimeout(redim);
    redim = setTimeout(init, 150);
  });
  boucle();
})();
