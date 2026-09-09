/* =======================================================================
   Archive Jeux Vidéos - archive-fiche.js

   La fiche d'un jeu, ouverte par-dessus le mur.

   Son classement dans l'onglet, la comparaison avec son propre journal
   quand on lit celui de quelqu'un d'autre, la transition depuis la tuile,
   le piège à focus et le feuilletage au clavier.

   Chargé par templates/jeux-videos.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */


/* Les jeux dans l'ordre où la fiche les feuillette - figé à l'ouverture,
   relu par render() qui y retrouve la fiche après un rafraîchissement.

   Ici, auprès de la fiche à laquelle il sert : il était déclaré loin en
   amont tant que le démarrage s'exécutait au milieu du script, ce qui
   n'est plus le cas (voir archive-demarrage.js). */
let SHEET_LIST = [];

/* ---------- la fiche, par-dessus le mur ----------
   Le classement est calculé sur l'onglet affiché, comme les stats et
   l'histogramme : « 3e sur 42 en 2026 ». Les jeux en cours, ceux de la
   wishlist et ceux sans note n'en font pas partie, et en dessous de trois
   jeux notés la position ne veut rien dire - on ne l'affiche pas. */
function rangJeu(g){
  if(!g || estStatut(g) || g.rating === null || g.rating === undefined) return null;
  const lot = current().filter(x => !estStatut(x) && x.rating !== null);
  if(lot.length < 3) return null;
  // ex aequo : deux 8,5 partagent le même rang, aucun ne passe devant l'autre
  const rang = lot.filter(x => x.rating > g.rating).length + 1;
  /* Le podium ne compte pas les rangs, il compte les notes : si trois jeux
     sont à 10, ils sont tous dorés - et celui qui vient juste après reste
     « argenté », même si son rang affiché saute à la 4e place. */
  const notes = Array.from(new Set(lot.map(x => x.rating))).sort((a,b)=>b-a);
  const palier = notes.indexOf(g.rating) + 1;
  return { rang, total: lot.length, palier, ou: S.bucket === 'all' ? 'au total' : 'en ' + S.bucket };
}
/* Le podium, comme sur un vrai podium : deux jeux à égalité sont tous les
   deux premiers, et le suivant est troisième - il n'y a pas d'argent cette
   année-là. */
const MEDAILLES = ['or','argent','bronze'];
function medailleDe(r){ return (r && r.palier && r.palier <= 3) ? MEDAILLES[r.palier - 1] : ''; }
function rangHTML(r, med){
  if(!r) return '';
  return `<div class="sheet-rank${med ? ' medaille ' + med : ''}">`
       + `${r.rang}<sup>${r.rang === 1 ? 'er' : 'e'}</sup> sur ${r.total} ${esc(r.ou)}</div>`;
}

/* ---------- la fiche ----------
   La coquille est montée une fois et gardée : naviguer d'un jeu au suivant
   ne réécrit que le corps et la jaquette. Tout reconstruire relançait
   l'image à chaque flèche - élément recréé, requête, décodage - et la case
   clignotait même quand elle était déjà en cache. */

/* Copier dans le presse-papier. navigator.clipboard n'existe qu'en contexte
   sécurisé : depuis un autre poste du réseau, la page arrive en http et
   l'API est tout simplement absente. D'où le repli sur la vieille méthode -
   un champ hors écran, une sélection, execCommand - qui, elle, marche
   partout où ce hub est consulté. */
async function copier(texte){
  try{
    if(window.isSecureContext && navigator.clipboard){
      await navigator.clipboard.writeText(texte);
      return true;
    }
  }catch(e){}
  try{
    const zone = document.createElement('textarea');
    zone.value = texte;
    zone.setAttribute('readonly', '');
    zone.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(zone);
    zone.select();
    const ok = document.execCommand('copy');
    zone.remove();
    return ok;
  }catch(e){ return false; }
}

const ICONE_COPIE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="9" width="12" height="12" rx="2"/>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
</svg>`;

/* Le corps de la fiche : tout ce qui change d'un jeu à l'autre, hors
   jaquette et hors barre d'outils. */
function corpsFiche(g){
  const statut = statutDe(g), wish = estWishlist(g);
  // en cours ou convoité : dans les deux cas le jeu n'a pas de fin à raconter
  const enCours = !!statut;
  const plus  = g.review.filter(s=>s.startsWith('+')).map(s=>`<span class="pt plus">${esc(s.slice(1).trim())}</span>`);
  const minus = g.review.filter(s=>s.startsWith('-')).map(s=>`<span class="pt minus">${esc(s.slice(1).trim())}</span>`);
  const other = g.review.filter(s=>!/^[+-]/.test(s)).map(s=>`<span class="pt">${esc(s)}</span>`);
  /* la date de sortie s'affiche désormais à côté du titre (voir sheet-title
     plus bas) plutôt qu'ici : ça libère une case et laisse Terminé / Temps /
     Prix de base / Payé tenir sur une seule ligne. */
  /* Jeu convoité et soldé aujourd'hui : la case de prix montre l'ancien
     barré, celui du jour, et la remise. Le prix barré est celui du
     classeur, pas celui de Steam - c'est le montant qu'on avait noté, donc
     celui auquel on compare. À défaut, le prix fort que Steam annonce. */
  const solde = wish && TARIFS[g.name] && TARIFS[g.name].remise > 0 ? TARIFS[g.name] : null;
  const avant = (g.base === null || g.base === undefined) ? (solde && solde.plein) : g.base;
  const prix = solde
    ? `<s class="fait-avant">${esc(money(avant))}</s>${esc(money(solde.actuel))}`
      + `<span class="fait-solde">−${solde.remise}&#8239;%</span>`
    : '';
  const facts = [
    // ni date de fin ni temps de jeu tant que le jeu n'est pas terminé
    enCours ? null : ['Terminé', g.month?`${MONTHS[g.month-1]} ${g.year||''}`:(g.year||g.bucket)],
    enCours ? null : ['Temps', hoursFmt(g.hours)],
    // le troisième terme, quand il existe, est du HTML déjà échappé
    [solde ? 'Prix' : 'Prix de base', money(g.base), prix],
    // rien n'a été payé pour un jeu de la wishlist : la case dirait « - »
    wish ? null : ['Payé', money(g.paid)]
  ].filter(Boolean);
  const rang = rangJeu(g), med = medailleDe(rang);
  return `${statut
      ? `<span class="sheet-note ${wish ? 'wish' : 'encours'}">${esc(statut)}</span>`
      : `<span class="sheet-note" style="color:${noteColor(g.rating)}">${g.rating!==null?fr(g.rating,1):'-'}</span>`}
    <h3 class="sheet-title${med ? ' medaille ' + med : ''}">${esc(g.name)}<button
        class="titre-copie" type="button" title="Copier le nom du jeu"
        aria-label="Copier le nom du jeu">${ICONE_COPIE}</button>${
      g.release ? `<span class="sheet-release">${dateFmt(g.release)}</span>` : ''}</h3>
    ${rangHTML(rang, med)}
    ${enCours ? '' : (plus.length+minus.length+other.length)
      ? `<div class="pros">${plus.join('')}${minus.join('')}${other.join('')}</div>`
      : `<div class="pros"><span class="pt" style="opacity:.6">Pas d'avis écrit pour ce jeu.</span></div>`}
    <div class="facts">${facts.map(([u,b,brut])=>
      `<div class="fact"><u>${u}</u><b>${brut || esc(b)}</b></div>`).join('')}</div>
    ${compareHTML(g)}
    <button type="button" class="detail-btn">Voir plus d'informations</button>`;
}

/* ---------- « et toi, tu en avais pensé quoi ? » ----------
   Chez quelqu'un d'autre, un jeu qu'on a soi-même dans son classeur
   déroule les deux lignes côte à côte : sa note et la nôtre, son temps de
   jeu et le nôtre, quand chacun l'a terminé. Rien ne s'affiche chez soi,
   ni pour un jeu qu'on n'a pas - la fiche reste ce qu'elle était.

   L'ordre est le sien d'abord : c'est son journal qu'on lit, sa ligne est
   celle que la fiche raconte au-dessus, et la nôtre vient s'y comparer. */
function ligneCompare(qui, g, moi){
  const statut = statutDe(g);
  const note = statut
    ? `<span class="cmp-statut ${estWishlist(g) ? 'wish' : 'encours'}">${esc(statut)}</span>`
    : `<b style="color:${noteColor(g.rating)}">${g.rating!==null?fr(g.rating,1):'-'}</b>`;
  const quand = statut ? '' : (g.month ? `${MONTHS[g.month-1]} ${g.year||''}` : (g.year || g.bucket || ''));
  return `<div class="cmp-l${moi ? ' moi' : ''}">
      <span class="cmp-qui">${esc(qui)}</span>
      ${note}
      <span class="cmp-t">${esc(statut ? '' : hoursFmt(g.hours))}</span>
      <span class="cmp-q">${esc(quand)}</span>
    </div>`;
}
function compareHTML(g){
  const mien = monJeu(g);
  if(!mien) return '';
  const lui = (source() && source().nom) || 'Lui';
  return `<div class="compare">
      <u>Dans ton journal</u>
      ${ligneCompare(lui, g, false)}
      ${ligneCompare('Toi', mien, true)}
    </div>`;
}

/* La coquille, montée une seule fois par ouverture. Les gestionnaires posés
   ici relisent S.open au moment du clic au lieu de capturer un rang : c'est
   ce qui permet de ne plus jamais les reposer. */
/* Les flèches encadrent la fiche au lieu d'être posées dessus : elles ne
   parlent pas de ce qu'on lit mais de ce qui l'entoure, et la barre du haut
   ne garde que ce qui concerne le jeu affiché. Elles sont donc voisines de
   la boîte et non dedans - d'où les querySelector sur `host` plus bas, et
   le piège à focus déplacé sur lui aussi, sans quoi la tabulation ne les
   atteindrait jamais. */
const CHEVRON = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="${d}"/></svg>`;

function monteFiche(host){
  host.innerHTML = `<button class="sheet-nav nav-prev" aria-label="Jeu précédent"
      >${CHEVRON('M15 5l-7 7 7 7')}</button>
    <div class="sheet" role="dialog" aria-modal="true">
    <div class="sheet-tools">
      <span class="grp">
        <button class="sbtn wide sheet-edit" hidden>Modifier</button>
        <button class="sbtn sheet-share" aria-label="Mettre ce jeu en image">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="3"/>
            <circle cx="8.6" cy="8.6" r="1.4"/><path d="M21 15.5l-4.5-4.5L5 21.5"/>
          </svg>
        </button>
      </span>
      <span class="grp">
        <button class="sbtn sheet-x" aria-label="Fermer">×</button>
      </span>
    </div>
    <div class="sheet-in">
      <div class="sheet-cover">
        <!-- La jaquette dans sa boîte à elle, et le bouton dessous. Un
             cran de plus dans le balisage, mais coverFiche() remplace tout
             ce qu'elle trouve chez son hôte à chaque jeu : sans cette
             boîte, le bouton partait avec l'image du jeu précédent. -->
        <div class="cov-boite"></div>
        <!-- « Avis » : ce que les AUTRES ont pensé du même jeu. Sa place est
             sous la jaquette et non dans le corps de la fiche, parce qu'il
             parle du jeu lui-même - pas de la ligne qu'on est en train de
             lire, dont tout le reste de la fiche s'occupe.
             Caché pour un jeu en cours ou convoité : il n'y a pas encore
             d'avis à comparer. -->
        <button type="button" class="fiche-avis" hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>
          </svg>
          <span>Avis des joueurs</span>
        </button>
      </div>
      <div class="sheet-body"></div>
    </div>
  </div>
  <button class="sheet-nav nav-next" aria-label="Jeu suivant"
    >${CHEVRON('M9 5l7 7-7 7')}</button>`;
  const boite = host.querySelector('.sheet');
  const jeu = ()=> SHEET_LIST[S.open];
  boite.querySelector('.sheet-x').onclick = fermeFiche;
  boite.querySelector('.sheet-edit').onclick = ()=>{ const g = jeu(); if(g) openForm(g); };
  boite.querySelector('.sheet-share').onclick = ()=>{ const g = jeu(); if(g) partagerJeu(g); };
  /* Les avis des autres sur ce jeu : la fenêtre est celle du Social, à
     l'identique - voir ouvrirAvisSocial dans archive-social.js. Un avis lu
     depuis le mur et le même avis lu depuis le fil ne doivent pas se
     ressembler, ils doivent être la même chose. */
  boite.querySelector('.fiche-avis').onclick = ()=>{
    const g = jeu();
    if(g) ouvrirAvisSocial(g.name, g.idIgdb);
  };
  host.querySelector('.nav-prev').onclick = ()=> ficheVoisine(-1);
  host.querySelector('.nav-next').onclick = ()=> ficheVoisine(1);
  /* Le doigt fait ce que font les flèches, dans le sens où l'on pousse la
     fiche : vers la gauche pour amener le jeu suivant, comme on tourne une
     page.
     Posé sur le contenu et non sur la boîte entière, ce qui laisse la barre
     du haut à la poignée - elle, se tire vers le bas pour refermer, et deux
     gestes qui se disputent le même bandeau de quarante pixels finiraient
     par se déclencher ensemble.
     La feuille de style met #sheet .sheet en touch-action:pan-y : le
     défilement vertical reste au navigateur, l'horizontal nous revient
     entier. */
  glissement(boite.querySelector('.sheet-in'), {
    gauche: ()=> ficheVoisine(1),
    droite: ()=> ficheVoisine(-1),
  });
  // sur `host` et non sur la boîte : les flèches sont dehors, et le piège
  // doit les compter parmi ce qu'on peut atteindre
  host.addEventListener('keydown', e=> piegeFocus(host, e));
  /* Le bouton « copier » et « voir plus d'informations » vivent tous deux
     dans le corps, réécrit à chaque jeu : on écoute la boîte plutôt que les
     boutons, une fois pour toutes. */
  boite.addEventListener('click', e=>{
    if(e.target.closest('.titre-copie')){
      const g = jeu();
      if(!g) return;
      copier(g.name).then(ok =>
        toast(ok ? `« ${g.name} » copié` : 'Copie impossible', !ok));
      return;
    }
    if(e.target.closest('.detail-btn')){
      const g = jeu();
      if(g) ouvrirDetail(g);
    }
  });
}

/* ---------- la jaquette de la fiche ----------
   Un seul <img>, gardé d'un jeu au suivant : seul son src change. Le repli
   en initiales est refait ici plutôt que confié à hydrateCovers(), qui
   remplace l'élément - c'est précisément ce qu'on cherche à éviter. */
function coverInitiales(hote, g){
  const d = document.createElement('div');
  d.className = 'cov xl ph';
  d.style.setProperty('--c', noteColor(g.rating));
  d.textContent = initials(g.name);
  d.appendChild(boutonJaquette(g.name, g.release, g.idIgdb));
  hote.replaceChildren(d);
}
function coverFiche(g){
  const hote = document.querySelector('#sheet .sheet-cover .cov-boite');
  if(!hote) return;
  const url = coverURL(cleJaquette(g));
  if(!url){ coverInitiales(hote, g); return; }

  let img = hote.querySelector('img.cov');
  if(!img){
    img = document.createElement('img');
    img.className = 'cov xl';
    img.alt = '';
    img.decoding = 'async';
    // seule image de l'écran quand la fiche s'ouvre, et celle qu'on attend
    img.setAttribute('fetchpriority', 'high');
    /* Écoutes posées une fois, et sans {once} : le même élément servira à
       toutes les jaquettes suivantes. Elles vérifient que la réponse porte
       bien sur l'image demandée - une arrivée en retard, sur un jeu qu'on a
       déjà quitté, ne doit rien changer à l'écran. */
    img.addEventListener('load', ()=>{
      if(img.dataset.url === img.getAttribute('src')) img.classList.remove('chargement');
    });
    img.addEventListener('error', ()=>{
      if(img.dataset.url !== img.getAttribute('src')) return;
      const jeu = SHEET_LIST[S.open];
      if(jeu) coverInitiales(hote, jeu);
    });
    hote.replaceChildren(img);
  }
  if(img.getAttribute('src') === url) return;   // déjà la bonne

  img.dataset.url = url;
  /* Déjà en cache : la bascule tient dans la même image, inutile de faire
     clignoter la case. Un Image() jetable le dit tout de suite - complete
     passe à true sans attendre quand le navigateur l'a déjà. */
  const sonde = new Image();
  sonde.src = url;
  img.classList.toggle('chargement', !sonde.complete);
  img.src = url;
}
function openSheet(i){
  SHEET_LIST = filtered();
  if(!SHEET_LIST[i]) return;
  S.open = i;
  paintSheet();
}
/* Rejoue l'animation de glissement sur la zone de contenu. La classe doit
   être retirée puis reposée après un recalcul forcé : sans ce détour, le
   navigateur ne voit aucun changement et l'animation ne repart pas quand on
   enchaîne les flèches dans le même sens.

   Une simple animation CSS, et pas une View Transition : celle-ci
   photographierait la fiche pour la faire glisser en dehors de sa boîte
   arrondie, alors qu'on veut justement que le contenu défile à l'intérieur
   du cadre, qui lui ne bouge pas. */
function animeFiche(sens){
  if(!sens) return;
  const hote = document.getElementById('sheet');
  const zone = hote && hote.querySelector('.sheet-in');
  if(!zone) return;
  zone.classList.remove('va-gauche', 'va-droite');
  void zone.offsetWidth;
  zone.classList.add(sens > 0 ? 'va-droite' : 'va-gauche');

  /* Et la flèche qui a servi répond du même coup. Elle est retrouvée ici
     plutôt que posée par chaque appelant : clic, doigt et flèches du clavier
     passent tous par là, et aucun n'a à s'en souvenir. */
  const fleche = hote.querySelector(sens > 0 ? '.nav-next' : '.nav-prev');
  if(!fleche) return;
  fleche.classList.remove('pousse');
  void fleche.offsetWidth;
  fleche.classList.add('pousse');
  /* La classe s'en va avec l'animation : laissée en place, elle garderait la
     flèche dorée alors que plus rien ne bouge. `once` suffit - une nouvelle
     impulsion recommence par la retirer. */
  fleche.addEventListener('animationend',
    () => fleche.classList.remove('pousse'), {once: true});
}

/* Le jeu d'à côté, s'il existe. Les flèches de la fiche, les flèches du
   clavier et le doigt aboutissent tous ici : un seul endroit sait ce que
   veut dire « suivant », et ce qu'il faut faire quand il n'y en a pas. */
function ficheVoisine(sens){
  const i = S.open + sens;
  if(i < 0 || i >= SHEET_LIST.length) return;
  S.open = i;
  paintSheet(sens);
}

/* `sens` : +1 vers le jeu suivant, -1 vers le précédent, rien sinon. Les
   repeintures qui ne changent pas de jeu - rafraîchissement de fond, prix
   Steam qui arrivent - n'en passent pas, et n'animent donc rien. */
function paintSheet(sens){
  const host = document.getElementById('sheet');
  const i = S.open, g = SHEET_LIST[i];
  if(!g){ closeSheet(); return; }
  const neuve = !host.querySelector('.sheet');
  if(neuve) monteFiche(host);

  const boite = host.querySelector('.sheet');
  boite.setAttribute('aria-label', g.name);
  boite.querySelector('.sheet-edit').hidden = !CAN_WRITE;
  // rien à comparer tant que le jeu n'est pas fini : ni « En cours » ni
  // « Wishlist » n'ont d'avis derrière eux
  boite.querySelector('.fiche-avis').hidden = estStatut(g);
  host.querySelector('.nav-prev').disabled = i <= 0;
  host.querySelector('.nav-next').disabled = i >= SHEET_LIST.length - 1;
  coverFiche(g);
  boite.querySelector('.sheet-body').innerHTML = corpsFiche(g);

  /* On ne remonte en haut qu'en changeant de jeu. Quand render() repeint la
     fiche après un rafraîchissement, la lecture en cours ne doit pas
     repartir du titre. */
  const cle = cleTuile(g);
  if(boite.dataset.jeu !== cle){
    boite.scrollTop = 0;
    boite.dataset.jeu = cle;
    animeFiche(sens);
    /* Le retour au mur (focus + halo) vise le jeu qu'on regarde à la
       fermeture, pas celui sur lequel on avait cliqué au départ : sans
       cette mise à jour, feuilleter avec les flèches puis fermer ramenait
       toujours sur la toute première tuile. */
    const tuileActuelle = TUILES.get(cle);
    if(tuileActuelle) FICHE_RETOUR = tuileActuelle;
  }

  host.hidden = false;
  verrouFond();
  // le focus n'entre dans la fiche qu'à son ouverture : le reposer à chaque
  // flèche ferait sauter le lecteur d'écran au bouton de fermeture
  if(neuve) boite.querySelector('.sheet-x').focus();
}
/* ---------- transition tuile → fiche ----------
   La jaquette de la tuile et celle de la fiche portent tour à tour le même
   view-transition-name : le navigateur reconnaît alors le même élément de
   part et d'autre du changement et fait glisser la vignette jusqu'à sa
   grande taille, au lieu d'ouvrir un panneau par-dessus.

   Le nom doit désigner UN SEUL élément à la fois dans toute la page. La
   tuile reste dans le document derrière la fiche : si les deux le portaient
   en même temps, le navigateur abandonnerait l'animation sans rien dire.
   D'où le passage de relais à l'intérieur du callback, et le nettoyage sur
   `finished` - une transition interrompue ne doit pas laisser le nom
   accroché à une tuile, sinon la suivante ne démarre plus.

   startViewTransition n'existe pas partout (Safari ancien) : dans ce cas la
   mutation s'exécute telle quelle. Pas d'animation, pas d'erreur,
   exactement le comportement d'avant. */
/* ---------- piège à focus, retour et repère ----------
   Une fiche ouverte occupe tout l'écran : le reste de la page est
   inatteignable à la souris, Tab n'a donc rien à y faire non plus. Il tourne
   en boucle à l'intérieur tant qu'elle est là.

   À la fermeture, trois choses reviennent à leur place : le défilement, le
   focus, et le regard. Le focus revenait jusqu'ici sur <body>, si bien que
   le Tab suivant repartait du haut du document et y ramenait la page -
   punitif sur un mur de deux cents jeux. */
const FOCUSABLES = 'a[href],button:not([disabled]),input:not([disabled]),' +
  'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let FICHE_RETOUR = null;   // la tuile d'où l'on vient
let FICHE_SCROLL = 0;      // le défilement au moment de l'ouverture
let HALO = null;           // tuile à souligner une fois la fiche refermée

/* Tab et Maj+Tab rebouclent aux extrémités. offsetParent écarte ce qui est
   masqué - le bouton « Modifier » en lecture seule, par exemple - sans quoi
   la boucle s'arrêterait sur un élément invisible. */
function piegeFocus(boite, e){
  if(e.key !== 'Tab') return;
  /* offsetParent est null pour ce qui est masqué... et aussi pour ce qui est
     en position:fixed, ce que sont les flèches de la fiche sur téléphone.
     Sans le second test elles sortaient du cycle de tabulation. */
  const cibles = Array.from(boite.querySelectorAll(FOCUSABLES))
    .filter(el => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
  if(!cibles.length) return;
  const premier = cibles[0], dernier = cibles[cibles.length - 1];
  const ici = document.activeElement;
  if(e.shiftKey && (ici === premier || !boite.contains(ici))){
    e.preventDefault(); dernier.focus();
  }else if(!e.shiftKey && ici === dernier){
    e.preventDefault(); premier.focus();
  }
}

/* Le halo doré, joué après coup. Vidé dès le premier appel : la fermeture
   animée le déclenche à la fin de la transition, la fermeture sèche tout de
   suite, et il ne doit jouer qu'une fois. */
function joueHalo(){
  const tuile = HALO;
  HALO = null;
  if(!tuile || !tuile.isConnected) return;
  tuile.classList.remove('revenu');
  void tuile.offsetWidth;          // sinon l'animation ne repart pas
  tuile.classList.add('revenu');
  setTimeout(()=>{ tuile.classList.remove('revenu'); }, 700);
}

/* Remet le défilement puis le focus, sur la tuile du jeu qu'on regardait à
   la fermeture - pas forcément celle sur laquelle on avait cliqué, si on a
   feuilleté avec les flèches entre-temps. C'est elle qui décide d'où
   défiler : preventScroll coupe le scroll-into-view par défaut de focus(),
   sinon les deux se disputeraient la position finale. Sans tuile (jeu
   supprimé, filtre changé...), on retombe sur le défilement d'avant. */
function rendreFocus(){
  const tuile = FICHE_RETOUR;
  FICHE_RETOUR = null;
  if(!tuile || !tuile.isConnected){
    if(Math.abs(window.scrollY - FICHE_SCROLL) > 1) window.scrollTo(0, FICHE_SCROLL);
    return;
  }
  tuile.scrollIntoView({block: 'center'});
  try{ tuile.focus({preventScroll: true}); }catch(err){ tuile.focus(); }
  HALO = tuile;
}

const VT_JAQUETTE = 'jaquette-active';
/* La classe accompagne le nom : le liseré de note ne doit pas partir en
   voyage avec la jaquette - voir .cov.big.envol dans la feuille de style. */
function nomVT(el, actif){
  if(!el) return;
  el.style.viewTransitionName = actif ? VT_JAQUETTE : '';
  el.classList.toggle('envol', actif);
}
function jaquetteFiche(){
  return document.querySelector('#sheet .sheet-cover .cov');
}
function jaquetteTuile(g){
  const tuile = g && TUILES.get(cleTuile(g));
  return (tuile && tuile.isConnected) ? tuile.querySelector('.cov') : null;
}

/* Un rafraîchissement de fond qui aboutit pendant la transition reconstruit
   les tuiles (voir render()) - dont celle qui porte le nom de transition,
   si elle bouge de place ou change de contenu. Le navigateur abandonne
   alors l'animation sans le dire : la fiche apparaît d'un coup, comme
   téléportée, au lieu de voir la jaquette voyager jusqu'à sa place.
   TRANSITION_EN_COURS dit à render() de repousser cette reconstruction
   plutôt que de la faire sous les pieds de l'animation. */
let TRANSITION_EN_COURS = false;
let RENDU_MUR_EN_ATTENTE = false;
function finTransition(){
  TRANSITION_EN_COURS = false;
  if(RENDU_MUR_EN_ATTENTE){ RENDU_MUR_EN_ATTENTE = false; renderWall(); }
}
function ouvreFiche(i, tuile){
  FICHE_RETOUR = tuile || null;
  FICHE_SCROLL = window.scrollY;
  const src = tuile && tuile.querySelector('.cov');
  if(!document.startViewTransition || !src){ openSheet(i); return; }
  nomVT(src, true);
  TRANSITION_EN_COURS = true;
  const vt = document.startViewTransition(()=>{
    nomVT(src, false);           // la tuile rend le nom...
    openSheet(i);
    /* Posée avant le premier rendu de la fiche : son animation d'entrée
       n'a alors jamais lieu, et la photo de la jaquette d'arrivée est
       prise à sa place définitive. Retirée par closeSheet(), une fois la
       fiche fermée - l'enlever plus tôt déclencherait l'entrée qu'on
       vient d'éviter. */
    document.getElementById('sheet').classList.add('vt-entree');
    nomVT(jaquetteFiche(), true);  // ...la fiche le reprend
  });
  vt.finished.catch(()=>{}).then(()=>{ nomVT(src, false); finTransition(); });
}

function fermeFiche(){
  const host = document.getElementById('sheet');
  if(host.hidden) return;
  const g = SHEET_LIST[S.open];
  const src = jaquetteFiche();
  if(!document.startViewTransition || !src || !g){ closeSheet(); joueHalo(); return; }
  nomVT(src, true);
  TRANSITION_EN_COURS = true;
  const vt = document.startViewTransition(()=>{
    nomVT(src, false);
    closeSheet();
    nomVT(jaquetteTuile(g), true);   // la vignette reprend sa place
  });
  vt.finished.catch(()=>{}).then(()=>{
    nomVT(jaquetteTuile(g), false);
    joueHalo();          // sous la photo de la transition, il serait invisible
    finTransition();
  });
}

function closeSheet(){
  const host = document.getElementById('sheet');
  if(host.hidden) return;
  host.hidden = true; host.innerHTML = ''; host.classList.remove('vt-entree');
  verrouFond();          // le défilement doit être rendu avant d'être repositionné
  S.open = null;
  rendreFocus();
}
fermeSurFond('sheet', fermeFiche);
document.addEventListener('keydown', e=>{
  /* L'ordre suit la pile : la fenêtre du dessus prend Échap et rend la
     main. Une fenêtre oubliée ici laisserait Échap traverser jusqu'à celle
     du dessous et fermer la mauvaise - c'est ce qui arrivait au détail
     d'un jeu, qui refermait la fiche derrière lui. */
  /* Le zoom et le detail d'un jeu s'arretent ici sans etre traites : ils
     ont leur propre ecoute dans archive-export.js, la ou vivent leurs deux
     fenetres, parce que le Social les ouvre aussi et ne charge pas ce
     fichier-ci. On garde les deux gardes pour que la fleche ne parte pas,
     par-dessous, changer le jeu de la fiche du mur. */
  if(!document.getElementById('zoom').hidden) return;
  if(!document.getElementById('detail').hidden) return;
  if(!document.getElementById('export').hidden){
    if(e.key === 'Escape') fermerExport();
    return;
  }
  if(!document.getElementById('recherche').hidden){
    if(e.key === 'Escape') fermerRecherche();
    return;
  }
  // la mise à jour depuis IGDB occupe l'écran seule : rien ne s'ouvre
  // par-dessus, donc rien d'autre ne prend Échap tant qu'elle est là
  if(!document.getElementById('igdb').hidden){
    if(e.key === 'Escape') fermerIgdb();
    return;
  }
  // le bilan en image est au-dessus de tout, y compris le choix de jaquette
  if(!document.getElementById('bilan').hidden){
    if(e.key === 'Escape') fermerBilan();
    return;
  }
  if(!document.getElementById('jaq').hidden){
    if(e.key === 'Escape') closeJaq();
    return;
  }
  if(!document.getElementById('form').hidden){
    if(e.key === 'Escape') closeForm();
    return;
  }
  if(document.getElementById('sheet').hidden){
    // rien d'ouvert : Échap enlève la tranche de notes choisie
    const per = document.getElementById('perMenu');
    if(e.key === 'Escape' && S.range
       && document.getElementById('menu').hidden
       && document.getElementById('recherche').hidden
       && (!per || per.hidden)) viderTranche();
    return;
  }
  if(e.key === 'Escape'){ fermeFiche(); }
  else if(e.key === 'ArrowLeft') ficheVoisine(-1);
  else if(e.key === 'ArrowRight') ficheVoisine(1);
});
