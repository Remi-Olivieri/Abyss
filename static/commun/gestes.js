/* =======================================================================
   Gestes du doigt - static/commun/gestes.js

   Deux gestes, et rien de plus : le balayage - un jeu, une page, une carte
   plus loin - et la feuille qu'on repousse vers le bas pour la fermer.

   Une règle tenue partout : aucun geste n'est le seul chemin vers son
   action. Chacun double un bouton qui reste à l'écran - les flèches de la
   fiche, celles du classeur, la croix de fermeture. Un glissement ne
   s'annonce nulle part et personne ne le devine tout seul ; il fait gagner
   du temps à qui le trouve, il ne retire rien à qui l'ignore.

   Et ils ne répondent qu'au doigt ou au stylet. À la souris, un glissement
   est une sélection de texte : la détourner casserait le copier-coller
   pour un raccourci dont personne n'a besoin là où il y a un clavier.

   Chargé avant les scripts de page, qui appellent ces deux fonctions.
   ======================================================================= */

/* Ce sur quoi un glissement ne commence jamais : ce qui se manipule déjà au
   doigt. Faire défiler une liste déroulante, tirer un curseur ou poser le
   point d'insertion dans un texte sont des glissements comme les autres, et
   ils étaient là avant. `.geste-hors` est la porte de sortie pour tout ce
   qui, au cas par cas, doit garder son doigt pour lui. */
const GESTE_HORS = 'input,textarea,select,[contenteditable],.geste-hors';

/* Un balayage qui vient d'agir laisse derrière lui un « click », posé sur
   ce qui se trouvait sous le doigt au départ - la tuile d'où l'on est
   parti, qui ouvrirait sa fiche par-dessus la page qu'on vient de tourner.
   On mange celui-là, et lui seul : l'écoute est en capture, elle part au
   premier clic, et un minuteur la retire si aucun ne vient. */
function avaleClic(){
  const tueur = e => { e.stopPropagation(); e.preventDefault(); };
  document.addEventListener('click', tueur, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', tueur, true), 500);
}

/* ---------- le balayage ----------
   `cible` écoute pour elle et pour tout ce qu'elle contient ; `actions`
   donne ce qu'on veut voir arriver : { gauche, droite, haut, bas }. Les
   directions absentes ne sont pas surveillées.

   Options : `seuil`, la distance à parcourir (55 px par défaut, soit un
   bon centimètre de pouce - assez pour qu'un tremblement n'y arrive pas,
   assez peu pour tenir dans un geste), et `quand`, consultée à chaque
   départ, pour les endroits où le geste n'a de sens que sur un téléphone. */
function glissement(cible, actions){
  const seuil = actions.seuil || 55;
  const eveil = 10;      // ce qu'il faut parcourir avant de choisir un axe
  let g = null;

  cible.addEventListener('pointerdown', e => {
    g = null;
    if(e.pointerType === 'mouse' || !e.isPrimary) return;
    if(e.target.closest(GESTE_HORS)) return;
    if(actions.quand && !actions.quand()) return;
    g = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, axe: null };
  }, { passive: true });

  cible.addEventListener('pointermove', e => {
    if(!g || !e.isPrimary) return;
    g.dx = e.clientX - g.x0;
    g.dy = e.clientY - g.y0;
    if(g.axe) return;
    const ax = Math.abs(g.dx), ay = Math.abs(g.dy);
    if(ax < eveil && ay < eveil) return;
    /* L'axe est choisi une fois pour toutes, au premier centimètre. Sans
       cela un geste en diagonale changerait d'avis en cours de route et
       déclencherait, à l'arrivée, ce que le doigt avait cessé de viser.
       Le 1.3 laisse tomber les diagonales franches : elles ne demandent
       rien de clair, mieux vaut ne rien faire que se tromper. */
    g.axe = ax > ay * 1.3 ? 'x' : (ay > ax * 1.3 ? 'y' : 'aucun');
  }, { passive: true });

  const conclut = () => {
    const fait = g;
    g = null;
    if(!fait || !fait.axe || fait.axe === 'aucun') return;
    let action = null;
    if(fait.axe === 'x' && Math.abs(fait.dx) >= seuil)
      action = fait.dx < 0 ? actions.gauche : actions.droite;
    if(fait.axe === 'y' && Math.abs(fait.dy) >= seuil)
      action = fait.dy < 0 ? actions.haut : actions.bas;
    if(!action) return;
    avaleClic();
    action();
  };

  cible.addEventListener('pointerup', conclut, { passive: true });
  /* pointercancel : le navigateur a repris le doigt pour faire défiler.
     Le geste est fini pour nous, mais s'il avait déjà parcouru sa distance
     sur le bon axe, il comptait quand même - l'abandonner ici donnerait un
     balayage qui marche une fois sur deux selon l'angle de la main. */
  cible.addEventListener('pointercancel', conclut, { passive: true });
}

/* ---------- la poignée d'une feuille ----------
   Sur un téléphone, les fenêtres montent du bas et portent une poignée en
   haut (voir .sheet-tools::before dans la feuille de style). Elle disait
   d'où la feuille venait sans qu'on puisse l'attraper ; elle s'attrape.

   Le geste part de la barre du haut et d'elle seule. Le corps de la
   feuille défile - y guetter un glissement vers le bas obligerait à
   arbitrer entre les deux à chaque doigt posé, et à se tromper parfois sur
   une feuille qu'on était en train de lire. La barre, elle, ne défile pas :
   elle est collée en haut, toujours sous le pouce, et n'a rien d'autre à
   faire. C'est ce que dit `touch-action:none` sur .sheet-tools.

   `fond` est le voile qui porte la feuille - le même qu'on donne à
   fermeSurFond(), et il survit à toutes les ouvertures, d'où l'écoute
   déléguée. `ferme` est la fermeture de la fenêtre, exactement celle du
   clic sur le voile : repousser une feuille abandonne ce qu'on y avait
   commencé, ni plus ni moins qu'en tapant à côté. */
function poigneeFeuille(fond, ferme, opts){
  const o = opts || {};
  const surTelephone = window.matchMedia(o.media || '(max-width:640px)');
  const poignee = o.poignee || '.sheet-tools,.sg-tete';
  const boiteSel = o.boite || '.sheet,.sg-boite';
  const COURSE = 96;     // la descente qui vaut fermeture...
  const VITESSE = 0.55;  // ...ou, plus court mais lancé, ces px par ms

  let d = null;

  const bouge = e => {
    if(!d || !e.isPrimary) return;
    d.dy = e.clientY - d.y0;
    d.t = e.timeStamp;
    if(!d.pris){
      // sous huit pixels, c'est encore un appui : un doigt posé sur la
      // barre pour lire ne doit pas faire trembler la feuille
      if(d.dy < 8) return;
      d.pris = true;
      d.boite.style.transition = 'none';
    }
    /* Vers le haut la feuille ne va nulle part, elle est déjà en butée.
       Elle suit tout de même, du quart : un bord parfaitement immobile
       donne l'impression que le doigt a raté sa prise. */
    d.boite.style.transform =
      'translateY(' + (d.dy > 0 ? d.dy : d.dy / 4) + 'px)';
  };

  const lache = () => {
    document.removeEventListener('pointermove', bouge);
    document.removeEventListener('pointerup', lache);
    document.removeEventListener('pointercancel', lache);
    const g = d;
    d = null;
    if(!g || !g.pris) return;

    const boite = g.boite;
    const vitesse = g.dy / Math.max(1, g.t - g.t0);
    if(g.dy >= COURSE || (g.dy > 34 && vitesse >= VITESSE)){
      /* La feuille finit sa course avant d'être retirée : elle a suivi le
         doigt jusque-là, la voir disparaître d'un coup à la dernière
         seconde annulerait tout le geste. */
      let parti = false;
      const sort = () => {
        if(parti) return;
        parti = true;
        boite.style.transition = '';
        boite.style.transform = '';
        ferme();
      };
      boite.style.transition = 'transform .16s ease-out';
      boite.style.transform = 'translateY(100%)';
      boite.addEventListener('transitionend', sort, { once: true });
      setTimeout(sort, 260);   // filet : pas de transitionend si rien ne bouge
      return;
    }
    // pas assez loin : elle remonte se remettre en place
    boite.style.transition = 'transform .22s cubic-bezier(.2,.8,.3,1)';
    boite.style.transform = '';
    boite.addEventListener('transitionend',
      () => { boite.style.transition = ''; }, { once: true });
  };

  fond.addEventListener('pointerdown', e => {
    if(e.pointerType === 'mouse' || !e.isPrimary) return;
    if(!surTelephone.matches) return;        // ailleurs, la feuille est centrée
    if(!e.target.closest(poignee)) return;
    if(e.target.closest('button,a,' + GESTE_HORS)) return;
    const boite = e.target.closest(boiteSel);
    if(!boite) return;
    d = { y0: e.clientY, t0: e.timeStamp, t: e.timeStamp, dy: 0, boite: boite, pris: false };
    /* Le doigt quitte la poignée dès les premiers pixels : la suite du
       geste s'écoute sur le document, sans capture de pointeur - celle-ci
       redirigerait aussi le « click » et avalerait l'appui sur la croix. */
    document.addEventListener('pointermove', bouge, { passive: true });
    document.addEventListener('pointerup', lache, { passive: true });
    document.addEventListener('pointercancel', lache, { passive: true });
  }, { passive: true });
}
