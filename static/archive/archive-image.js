/* =======================================================================
   Archive Jeux Vidéos - archive-image.js

   Le bilan en image, dessiné sur un canvas.

   L'onglet affiché ou un seul jeu, redessinés en 1080 px de large, prêts à
   partager. Rien ne sort du navigateur : tout est composé ici à partir des
   jeux déjà chargés et des jaquettes déjà servies.

   Le découpage de l'histogramme vient de casiers(), dans
   archive-mur.js - l'image doit montrer ce qu'on avait sous les yeux.

   Chargé par templates/jeux-videos.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */


/* =======================================================================
   Bilan en image
   L'onglet affiché est redessiné sur un canvas de 1080 px de large, prêt
   à partager. Rien ne sort du navigateur : l'image est composée ici, à
   partir des jeux déjà chargés et des jaquettes déjà servies par Flask
   (même origine, donc le canvas n'est pas « teinté » et toBlob marche).
   ======================================================================= */
const BIL = {
  L: 1080, M: 72,
  texte:'#F2EDE4', doux:'#A79CB4', or:'#E5C46B', bleu:'#8FB8E8',
  trait:'rgba(242,237,228,.13)',
  display:'"Bricolage Grotesque",system-ui,sans-serif',
  corps:'"Karla",system-ui,sans-serif',
  mono:'"Azeret Mono",ui-monospace,monospace',
};
BIL.W = BIL.L - BIL.M*2;

/* Le reste du site écrit "300 h 15" (hoursFmt) : lisible dans une phrase.
   Le bilan, plus dense, resserre en "300h15" - pas d'espace autour du h. */
function bilHeures(h){
  if(h===null||h===undefined) return '-';
  const H = Math.floor(h), Min = Math.round((h-H)*60);
  return Min ? `${H}h${String(Min).padStart(2,'0')}` : `${H}h`;
}

/* --- petits outils de dessin --- */
function bilEcrire(c, t, x, y, o){
  c.save();
  c.font = o.f;
  if('letterSpacing' in c) c.letterSpacing = o.ls || '0px';
  c.fillStyle = o.c || BIL.texte;
  c.textAlign = o.a || 'left';
  c.textBaseline = o.b || 'alphabetic';
  c.fillText(t, x, y);
  c.restore();
}
/* toujours mesurer via save/restore : sinon un letterSpacing posé pour un
   texte reste actif et fausse toutes les mesures suivantes */
function bilLargeur(c, t, f, ls){
  c.save();
  c.font = f;
  if('letterSpacing' in c) c.letterSpacing = ls || '0px';
  const w = c.measureText(t).width;
  c.restore();
  return w;
}
function bilArrondi(c, x, y, w, h, r){
  r = Math.max(0, Math.min(r, w/2, h/2));
  c.beginPath();
  c.moveTo(x+r, y);
  c.arcTo(x+w, y,   x+w, y+h, r);
  c.arcTo(x+w, y+h, x,   y+h, r);
  c.arcTo(x,   y+h, x,   y,   r);
  c.arcTo(x,   y,   x+w, y,   r);
  c.closePath();
}
function bilTrait(c, x, y, w){
  c.fillStyle = BIL.trait;
  c.fillRect(x, y, w, 1);
}
function bilFilet(c, y){ bilTrait(c, BIL.M, y, BIL.W); }
/* La proportion des jaquettes est réglée une seule fois, dans CONFIG :
   « 3 / 4 » vaut 0,75, donc une jaquette large de 348 px fait 464 px de haut. */
/* noteColor() rend « rgb(r,g,b) » quand il y a une note, et le gris « #6E6480»
   quand il n'y en a pas : les deux formes doivent se lire, sinon un jeu sans
   note repeint sa case d'initiales avec une couleur invalide. */
function bilRVB(couleur){
  const t = String(couleur).trim();
  if(t[0] === '#' && t.length >= 7) return hex2rgb(t);
  const m = t.match(/\d+/g);
  return (m && m.length >= 3) ? m.slice(0,3).map(Number) : [110,100,128];
}
/* Le métal d'une médaille, c'est la bande claire qui traverse : un aplat
   doré ne se lit que comme du jaune. Mêmes arrêts que le CSS de la fiche. */
const BIL_METAL = {
  or:     [[0,'#A9761E'],[.20,'#E7C46B'],[.38,'#FFF6D0'],[.52,'#E9C871'],[.72,'#B8862A'],[1,'#F6E2A4']],
  argent: [[0,'#6E7683'],[.20,'#C8CFD9'],[.38,'#FFFFFF'],[.52,'#CBD2DB'],[.72,'#8A929F'],[1,'#E8EDF3']],
  bronze: [[0,'#7A421F'],[.20,'#C87F4E'],[.38,'#F5C79B'],[.52,'#C9814F'],[.72,'#8E5228'],[1,'#E3A778']],
};
function bilMedaille(c, nom, x, y, w, h){
  const arrets = BIL_METAL[nom];
  if(!arrets) return null;
  const d = c.createLinearGradient(x, y, x + Math.max(40, w), y + h);
  arrets.forEach(([p, col])=> d.addColorStop(p, col));
  return d;
}
function bilRatio(){
  const m = String(CONFIG.coverRatio || '').match(/([\d.]+)\s*\/\s*([\d.]+)/);
  const r = m ? (+m[1]) / (+m[2]) : 0;
  return r > 0 ? r : 3/4;
}
/* Découpe un titre sur au plus maxLignes, en abrégeant la dernière. */
function bilCouper(c, t, largeur, maxLignes, f, ls){
  c.save();
  c.font = f;
  if('letterSpacing' in c) c.letterSpacing = ls || '0px';
  const mots = String(t).split(/\s+/).filter(Boolean);
  const lignes = [];
  let cur = '', i = 0;
  for(; i < mots.length; i++){
    const essai = cur ? cur + ' ' + mots[i] : mots[i];
    if(!cur || c.measureText(essai).width <= largeur){ cur = essai; continue; }
    lignes.push(cur); cur = mots[i];
    if(lignes.length >= maxLignes){ cur = ''; break; }
  }
  if(cur) lignes.push(cur);
  if(lignes.length){
    const trop = i < mots.length;
    let d = lignes[lignes.length-1];
    if(trop || c.measureText(d).width > largeur){
      while(d.length > 1 && c.measureText(d + '…').width > largeur) d = d.slice(0, -1);
      lignes[lignes.length-1] = d.replace(/\s+$/, '') + '…';
    }
  }
  c.restore();
  return lignes.length ? lignes : [''];
}

/* Comme bilCouper, mais sans limite : toutes les lignes sont rendues.
   C'est ce qu'il faut pour un avis, dont on ne veut couper aucun mot. */
function bilLignes(c, t, largeur, f, ls){
  c.save();
  c.font = f;
  if('letterSpacing' in c) c.letterSpacing = ls || '0px';
  const mots = String(t).split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  mots.forEach(m=>{
    const essai = cur ? cur + ' ' + m : m;
    if(!cur || c.measureText(essai).width <= largeur){ cur = essai; return; }
    out.push(cur); cur = m;
  });
  if(cur) out.push(cur);
  c.restore();
  return out.length ? out : [''];
}

/* --- ressources --- */
/* Canvas ne sait dessiner qu'avec les polices déjà chargées : sans ça, la
   première image sort en Arial. On les demande explicitement. */
async function bilPolices(){
  if(!document.fonts || !document.fonts.load) return;
  const l = [
    `800 128px ${BIL.display}`, `700 30px ${BIL.display}`, `500 17px ${BIL.display}`,
    `400 27px ${BIL.corps}`, `400 22px ${BIL.corps}`, `400 18px ${BIL.corps}`,
    `500 44px ${BIL.mono}`, `700 26px ${BIL.mono}`, `500 16px ${BIL.mono}`,
  ];
  try{ await Promise.all(l.map(f => document.fonts.load(f, 'AÉ0123456789'))); }catch(e){}
  try{ await document.fonts.ready; }catch(e){}
}
/* coverURL() porte déjà le paramètre ?v= de cache-buster une fois qu'une
   jaquette a été récupérée automatiquement : le bilan en profite tel quel. */
function bilCover(g){
  return new Promise(res=>{
    const url = coverURL(cleJaquette(g));
    if(!url) return res(null);
    const im = new Image();
    let fini = false;
    const stop = v => { if(!fini){ fini = true; res(v); } };
    im.onload  = ()=> stop(im);
    im.onerror = ()=> stop(null);
    // une jaquette qui ne répond pas ne doit pas bloquer l'image entière
    setTimeout(()=> stop(null), 8000);
    im.src = url;
  });
}
/* Jaquette recadrée, ou les initiales du jeu comme sur le mur. */
function bilJaquette(c, g, im, x, y, w, h){
  const r = 10;
  c.save();
  bilArrondi(c, x, y, w, h, r);
  c.clip();
  if(im && im.naturalWidth){
    const s = Math.max(w/im.naturalWidth, h/im.naturalHeight);
    const dw = im.naturalWidth*s, dh = im.naturalHeight*s;
    c.drawImage(im, x + (w-dw)/2, y + (h-dh)/2, dw, dh);
  } else {
    const [R,G,B] = bilRVB(noteColor(g.rating));
    const m = (a,b) => Math.round(a*.16 + b*.84);   // même mélange que .cov.ph
    c.fillStyle = `rgb(${m(R,38)},${m(G,31)},${m(B,51)})`;
    c.fillRect(x, y, w, h);
    bilEcrire(c, initials(g.name), x + w/2, y + h/2, {
      f:`800 ${Math.round(w*.34)}px ${BIL.display}`, c:noteColor(g.rating),
      a:'center', b:'middle', ls:'-.04em' });
  }
  c.restore();
  c.save();
  c.strokeStyle = 'rgba(242,237,228,.14)';
  c.lineWidth = 1;
  bilArrondi(c, x+.5, y+.5, w-1, h-1, r);
  c.stroke();
  c.restore();
}
function bilFond(o, H){
  const L = BIL.L;
  const d = o.createLinearGradient(0, 0, 0, H);
  d.addColorStop(0, '#241D31');
  d.addColorStop(.5, '#17131F');
  d.addColorStop(1, '#100D17');
  o.fillStyle = d;
  o.fillRect(0, 0, L, H);
  const h = o.createRadialGradient(L*.84, -40, 0, L*.84, -40, 660);
  h.addColorStop(0, 'rgba(229,196,107,.16)');
  h.addColorStop(1, 'rgba(229,196,107,0)');
  o.fillStyle = h;
  o.fillRect(0, 0, L, 700);
  o.fillStyle = BIL.or;
  o.fillRect(0, 0, L, 7);
}

/* --- composition --- */
/* On dessine sur un brouillon transparent en suivant un curseur vertical,
   puis on recopie le tout sur un canvas exactement à la bonne hauteur.
   C'est ce qui permet d'enchaîner les sections sans calculer la hauteur
   finale à l'avance : une année sans jaquettes sort simplement plus courte. */
async function bilanCanvas(){
  await bilPolices();
  const { L, M, W } = BIL;

  // la wishlist est hors sujet dans un bilan : ces jeux-là ne sont ni faits,
  // ni achetés - ils ne comptent donc dans aucun des chiffres ci-dessous
  const tout    = current().filter(x => !estWishlist(x));
  const jeux    = tout.filter(x => !estEnCours(x));
  const enCours = tout.length - jeux.length;
  const notes   = jeux.filter(x => x.rating !== null);
  const avg  = notes.length ? notes.reduce((s,x)=>s+x.rating, 0)/notes.length : null;
  const base = tout.reduce((s,x)=>s+(x.base||0), 0);
  const paid = tout.reduce((s,x)=>s+(x.paid||0), 0);
  const hrs  = jeux.reduce((s,x)=>s+(x.hours||0), 0);

  // le top 10 complet : les 5 premiers en grand avec jaquette, les 5 suivants
  // en simple liste titre + note juste en dessous
  const classement = notes.slice().sort((a,b)=>b.rating-a.rating);
  const top = classement.slice(0, 5);
  const suivants = classement.slice(5, 10);
  const jaquettes = await Promise.all(top.map(x => bilCover(x)));

  const brouillon = document.createElement('canvas');
  brouillon.width = L; brouillon.height = 2600;
  const c = brouillon.getContext('2d');
  let y = 104;

  /* --- en-tête --- */
  const src = source();
  const entete = src && src.nom ? `Journal de ${src.nom}` : 'Journal de jeu';
  bilEcrire(c, entete, M, y, {f:`800 19px ${BIL.display}`, c:BIL.or, ls:'-.02em'});
  y += 30;

  const titre = S.bucket === 'all' ? 'Tout' : String(S.bucket);
  let ts = 130;
  while(ts > 52 && bilLargeur(c, titre, `800 ${ts}px ${BIL.display}`, '-.035em') > W) ts -= 4;
  y += Math.round(ts * .78);
  bilEcrire(c, titre, M, y, {f:`800 ${ts}px ${BIL.display}`, ls:'-.035em'});
  /* les jambages du chiffre descendent sous la ligne de base : sans cette
     marge, le sous-titre vient se coller au titre */
  y += 54;

  const bandeau = ["Résumé gaming"];
  bilEcrire(c, bandeau.join('   ·   '), M, y, {f:`400 27px ${BIL.corps}`, c:BIL.doux});
  y += 42;
  bilFilet(c, y); y += 46;

  /* --- les mieux notés --- */
  if(top.length){
    bilEcrire(c, 'LES MIEUX NOTÉS', M, y, {f:`500 16px ${BIL.mono}`, c:BIL.doux, ls:'.22em'});
    y += 32;
    const n = top.length, ecart = 18;
    const cw = Math.min(200, Math.floor((W - ecart*(n-1)) / n));
    const ch = Math.round(cw * 4/3);
    /* alignées à gauche, sur la même colonne que les titres, les filets et
       les chiffres : une année à deux jeux laisse du vide à droite plutôt
       qu'un bloc centré qui ne s'accroche à rien */
    const x0 = M;
    top.forEach((g,i)=>{
      const x = x0 + i*(cw+ecart);
      bilJaquette(c, g, jaquettes[i], x, y, cw, ch);
      /* le rang est l'information que porte cette section : il est sur la
         jaquette, pas relégué dans la légende */
      const p = 30;
      c.fillStyle = 'rgba(10,8,14,.86)';
      bilArrondi(c, x+9, y+9, p, p, 9); c.fill();
      c.strokeStyle = 'rgba(229,196,107,.5)'; c.lineWidth = 1;
      bilArrondi(c, x+9.5, y+9.5, p-1, p-1, 9); c.stroke();
      bilEcrire(c, String(i+1), x+9+p/2, y+9+p/2+1,
        {f:`700 16px ${BIL.mono}`, c:BIL.or, a:'center', b:'middle'});
    });
    const yb = y + ch + 30;
    top.forEach((g,i)=>{
      const x = x0 + i*(cw+ecart);
      bilEcrire(c, fr(g.rating,1), x, yb, {f:`700 26px ${BIL.mono}`, c:noteColor(g.rating), ls:'-.03em'});
      bilCouper(c, g.name, cw, 2, `500 17px ${BIL.display}`)
        .forEach((l,k)=> bilEcrire(c, l, x, yb + 28 + k*22, {f:`500 17px ${BIL.display}`}));
    });
    y = yb + 28 + 2*22 + 12;

    /* rangs 6 à 10 : plus de jaquette, juste le nom et la note, une ligne
       chacun - le podium a déjà montré la couverture, pas la peine de
       répéter cinq fois le même traitement pour des jeux moins en avant */
    if(suivants.length){
      y += 14;
      suivants.forEach((g,i)=>{
        const rang = i + 6;
        bilEcrire(c, String(rang), M, y, {f:`500 15px ${BIL.mono}`, c:BIL.doux});
        const note = fr(g.rating,1);
        const noteW = bilLargeur(c, note, `700 17px ${BIL.mono}`, '-.02em');
        const titreX = M + 36;
        const dispo = W - 36 - noteW - 16;
        const ligne = bilCouper(c, g.name, dispo, 1, `500 16px ${BIL.display}`)[0];
        bilEcrire(c, ligne, titreX, y, {f:`500 16px ${BIL.display}`});
        bilEcrire(c, note, M+W, y, {f:`700 17px ${BIL.mono}`, c:noteColor(g.rating), a:'right', ls:'-.02em'});
        y += 31;
      });
      y += 15;
    }
    bilFilet(c, y); y += 46;
  }

  /* --- les chiffres, les mêmes qu'en haut de la page --- */
  const cellules = [
    ['Jeux terminés', String(jeux.length), enCours ? `+ ${enCours} en cours` : ''],
    ['Note moyenne', avg !== null ? fr(avg,2) : '-',
      notes.length ? `sur ${notes.length} noté${notes.length>1?'s':''}` : ''],
    ['Temps de jeu', hrs ? bilHeures(hrs) : '-', hrs ? `≈ ${Math.round(hrs/24)} jours` : ''],
    ['Payé', paid ? EUR.format(paid) : '-', base ? `sur ${EUR.format(base)} de prix fort` : ''],
  ];
  const cl = W/4;
  cellules.forEach(([u,b,i2],k)=>{
    const x = M + k*cl;
    bilEcrire(c, u.toUpperCase(), x, y, {f:`500 14px ${BIL.mono}`, c:BIL.doux, ls:'.18em'});
    let f = 42;
    while(f > 22 && bilLargeur(c, b, `500 ${f}px ${BIL.mono}`, '-.03em') > cl - 18) f -= 2;
    bilEcrire(c, b, x, y + 52, {f:`500 ${f}px ${BIL.mono}`, ls:'-.03em'});
    if(i2) bilEcrire(c, i2, x, y + 80, {f:`400 17px ${BIL.corps}`, c:BIL.doux});
  });
  y += 104;
  bilFilet(c, y); y += 46;

  /* --- répartition des notes, le même histogramme que sur la page ---
     Le découpage vient de casiers(), celui-là même dont se sert
     renderDist() : l'image doit montrer ce qu'on avait sous les yeux en
     demandant l'image, et deux calculs séparés finissaient toujours par
     s'écarter l'un de l'autre. */
  if(notes.length >= DIST_MINI){
    const d = casiers(notes.map(x=>x.rating));
    const {lo, hi, span, bins} = d;
    const STEP = d.step, nBins = d.n, mid = d.mediane;
    const maxBin = d.max || 1;
    const pos = v => ((v - lo) / span) * W;

    bilEcrire(c, 'RÉPARTITION DES NOTES', M, y, {f:`500 16px ${BIL.mono}`, c:BIL.doux, ls:'.22em'});
    bilEcrire(c, `moyenne ${fr(avg,2)} · médiane ${fr(mid,2)}`, M+W, y,
      {f:`400 16px ${BIL.corps}`, c:BIL.doux, a:'right'});
    y += 34;

    const HB = 168, sol = y + HB;
    const gap = nBins > 26 ? 3 : (nBins > 14 ? 5 : 8);
    const bw = Math.max(4, (W - gap*(nBins-1)) / nBins);
    bins.forEach((cnt,i)=>{
      if(!cnt) return;
      const a = lo + i*STEP;
      const bh = Math.max(5, (cnt/maxBin)*HB);
      const bx = M + i*(bw+gap);
      c.fillStyle = noteColor(a + STEP/2);
      bilArrondi(c, bx, sol-bh, bw, bh, Math.min(4, bw/2));
      c.fill();
    });
    /* Même correction que sur l'histogramme de la page (.avg dans le CSS) :
       le repère se dessinait en or sur des barres claires - #E9A13C vers 5,
       #A8C24A vers 7 - où l'or ne se détache pas, et c'est précisément là
       qu'une moyenne tombe. Il porte donc son propre fond : un trait sombre
       posé sous le trait doré, une pastille sombre sous le chiffre.
       L'ordre compte, le sombre d'abord. */
    if(avg !== null){
      const xa = Math.round(M + pos(avg)) + .5;
      c.save();
      c.setLineDash([5,5]);
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(10,8,14,.7)';
      c.beginPath(); c.moveTo(xa, y-4); c.lineTo(xa, sol); c.stroke();
      c.lineWidth = 1;
      c.strokeStyle = BIL.or;
      c.beginPath(); c.moveTo(xa, y-4); c.lineTo(xa, sol); c.stroke();
      c.restore();

      const etiquette = `moy. ${fr(avg,2)}`;
      const police = `500 15px ${BIL.mono}`;
      const flip = xa > W - 90;
      const lg = bilLargeur(c, etiquette, police);
      const tx = xa + (flip ? -8 : 8);
      c.save();
      c.fillStyle = 'rgba(10,8,14,.82)';
      bilArrondi(c, (flip ? tx - lg : tx) - 6, y - 4, lg + 12, 21, 6);
      c.fill();
      c.restore();
      bilEcrire(c, etiquette, tx, y + 10,
        {f: police, c: BIL.or, a: flip ? 'right' : 'left'});
    }

    y = sol + 1;
    c.fillStyle = 'rgba(242,237,228,.22)';
    c.fillRect(M, y, W, 1);
    y += 24;
    const stepTick = span <= 8 ? 1 : 2;
    const ticks = [];
    for(let t = lo; t <= hi; t += stepTick) ticks.push(t);
    if(ticks[ticks.length-1] !== hi) ticks.push(hi);
    ticks.forEach(t=>{
      const x = M + pos(t);
      const a = (x < M + 14) ? 'left' : (x > M + W - 14 ? 'right' : 'center');
      bilEcrire(c, String(t), x, y, {f:`400 14px ${BIL.mono}`, c:BIL.doux, a});
    });
    y += 40;
    bilFilet(c, y); y += 46;
  }

  /* --- ce qui ressort de l'année --- */
  const faits = [];
  const long = jeux.filter(x=>x.hours).sort((a,b)=>b.hours-a.hours)[0];
  if(long) faits.push(['Le plus long', `${long.name} - ${bilHeures(long.hours)}`]);
  // le jeu le plus vieux joué cette période : celui qui vient le plus du
  // backlog, à l'opposé des sorties de l'année qui composent le reste
  const ancien = jeux.filter(x=>x.release).sort((a,b)=>a.release.localeCompare(b.release))[0];
  if(ancien) faits.push(['Le plus ancien', `${ancien.name} - sorti en ${yearOf(ancien.release)}`]);
  const bas = notes.slice().sort((a,b)=>a.rating-b.rating)[0];
  if(bas && notes.length > 3) faits.push(['La note la plus basse', `${bas.name} - ${fr(bas.rating,1)}`]);

  if(faits.length){
    const cg = 300;
    faits.forEach(([u,v])=>{
      bilEcrire(c, u.toUpperCase(), M, y, {f:`500 14px ${BIL.mono}`, c:BIL.doux, ls:'.18em'});
      bilEcrire(c, bilCouper(c, v, W - cg, 1, `400 22px ${BIL.corps}`)[0],
        M + cg, y, {f:`400 22px ${BIL.corps}`});
      y += 42;
    });
    y += 6;
    bilFilet(c, y); y += 46;
  }

  /* --- pied --- */
  bilEcrire(c, 'ABYSS · JEUX VIDÉOS', M, y, {f:`500 15px ${BIL.mono}`, c:BIL.or, ls:'.22em'});
  bilEcrire(c, new Date().toLocaleDateString('fr-FR', {day:'numeric', month:'long', year:'numeric'}),
    M+W, y, {f:`400 18px ${BIL.corps}`, c:BIL.doux, a:'right'});
  y += 56;

  const H = Math.min(Math.round(y), brouillon.height);
  const sortie = document.createElement('canvas');
  sortie.width = L; sortie.height = H;
  const o = sortie.getContext('2d');
  bilFond(o, H);
  o.drawImage(brouillon, 0, 0);
  return sortie;
}

/* =======================================================================
   La carte d'un seul jeu - même moteur, une seule fiche.
   C'est l'image qu'on envoie à quelqu'un pour dire « joue à ça » sans lui
   faire ouvrir le journal : jaquette, note, place au classement, et ce
   qu'on en a pensé.
   ======================================================================= */
async function ficheCanvas(g){
  await bilPolices();
  const { L, M, W } = BIL;
  const im = await bilCover(g);
  const statut = statutDe(g), wish = estWishlist(g);
  const enCours = !!statut;   // en cours ou convoité : pas de note à afficher

  const brouillon = document.createElement('canvas');
  brouillon.width = L; brouillon.height = 2600;
  const c = brouillon.getContext('2d');
  let y = 104;

  /* --- en-tête ---
     La période (mois/année) figure déjà dans les faits plus bas, sous
     « Terminé » : pas besoin de la répéter ici. */
  const src = source();
  bilEcrire(c, src && src.nom ? `Journal de ${src.nom}` : 'Journal de jeu', M, y,
    {f:`800 19px ${BIL.display}`, c:BIL.or, ls:'-.02em'});
  y += 30;

  /* --- jaquette à gauche, identité à droite --- */
  const cw = 348, ch = Math.round(cw / bilRatio());
  bilJaquette(c, g, im, M, y, cw, ch);

  const rx = M + cw + 44, rw = W - cw - 44;
  let ry = y;

  if(enCours){
    const t = statut.toUpperCase();
    const teinte = wish ? BIL.bleu : BIL.or;
    const tw = bilLargeur(c, t, `500 17px ${BIL.mono}`, '.2em') + 42;
    c.save();
    c.strokeStyle = wish ? 'rgba(143,184,232,.5)' : 'rgba(229,196,107,.5)'; c.lineWidth = 1;
    bilArrondi(c, rx+.5, ry+.5, tw, 42, 21); c.stroke();
    c.restore();
    bilEcrire(c, t, rx+21, ry+27, {f:`500 17px ${BIL.mono}`, c:teinte, ls:'.2em'});
    ry += 72;
  } else {
    bilEcrire(c, g.rating !== null ? fr(g.rating,1) : '-', rx, ry+62,
      {f:`700 80px ${BIL.mono}`, c:noteColor(g.rating), ls:'-.05em'});
    ry += 88;
  }

  /* le titre rétrécit jusqu'à tenir sur trois lignes : « Nier Automata »
     et « The Legend of Zelda: Tears of the Kingdom » doivent tous les deux
     tenir dans la même colonne */
  const r = rangJeu(g), med = medailleDe(r);
  const fTitre = t => `800 ${t}px ${BIL.display}`;
  let ts = 44, lignes = [];
  while(true){
    lignes = bilLignes(c, g.name, rw, fTitre(ts), '-.03em');
    if(lignes.length <= 3 || ts <= 24) break;
    ts -= 3;
  }
  lignes.slice(0, 3).forEach(l=>{
    ry += Math.round(ts * 1.04);
    /* le dégradé est refait pour chaque ligne, sur sa largeur à elle :
       sinon un titre court n'en montrerait que le premier centimètre */
    const w = bilLargeur(c, l, fTitre(ts), '-.03em');
    bilEcrire(c, l, rx, ry, {f:fTitre(ts), ls:'-.03em',
      c: med ? bilMedaille(c, med, rx, ry - ts*.78, w, ts*.86) : BIL.texte});
  });

  if(r){
    ry += 30;
    const t = `${r.rang}${r.rang === 1 ? 'er' : 'e'} sur ${r.total} ${r.ou}`;
    const w = bilLargeur(c, t, `500 15px ${BIL.mono}`, '.1em');
    bilEcrire(c, t, rx, ry, {f:`500 15px ${BIL.mono}`, ls:'.1em',
      c: med ? bilMedaille(c, med, rx, ry - 13, w, 15) : BIL.doux});
  }

  const faits = [
    ['Sortie', dateFmt(g.release)],
    enCours ? null : ['Terminé', g.month ? `${MONTHS[g.month-1]} ${g.year || ''}`.trim()
                                         : String(g.year || g.bucket || '-')],
    (!enCours && g.hours) ? ['Temps de jeu', bilHeures(g.hours)] : null,
    g.base ? ['Prix du jeu', EUR.format(g.base)] : null,
  ].filter(Boolean);

  if(faits.length){
    ry += 34;
    bilTrait(c, rx, ry, rw);
    ry += 12;
    faits.forEach(([u,v])=>{
      ry += 22;
      bilEcrire(c, u.toUpperCase(), rx, ry, {f:`500 13px ${BIL.mono}`, c:BIL.doux, ls:'.16em'});
      bilEcrire(c, bilCouper(c, v, rw - 190, 1, `400 20px ${BIL.corps}`)[0], rx+rw, ry,
        {f:`400 20px ${BIL.corps}`, a:'right'});
      ry += 14;
    });
  }

  /* la colonne la plus haute décide où reprend la page : une fiche sans
     prix est plus courte que sa jaquette, une fiche complète la dépasse */
  y = Math.max(y + ch, ry) + 48;

  /* --- ce que j'en ai pensé --- */
  const points = enCours ? [] : (g.review || []).filter(Boolean);
  if(points.length){
    bilFilet(c, y); y += 46;
    bilEcrire(c, 'AVIS', M, y, {f:`500 16px ${BIL.mono}`, c:BIL.doux, ls:'.22em'});
    y += 42;
    const limite = brouillon.height - 240;
    for(const p of points){
      if(y > limite) break;                      // avis fleuve : on s'arrête avant le bas
      const t = String(p).trim();
      const plus = t.startsWith('+'), moins = t.startsWith('-');
      const signe = plus ? '+' : (moins ? '–' : '·');
      // le point entier prend la couleur, pas seulement son signe
      const coul  = plus ? '#9BE3BE' : (moins ? '#F0A29C' : null);
      const texte = (plus || moins) ? t.slice(1).trim() : t;
      if(!texte) continue;
      const ls = bilLignes(c, texte, W - 40, `400 23px ${BIL.corps}`);
      bilEcrire(c, signe, M+3, y, {f:`700 23px ${BIL.mono}`, c: coul || BIL.doux});
      ls.forEach((l,k)=> bilEcrire(c, l, M+40, y + k*33,
        {f:`400 23px ${BIL.corps}`, c: coul || BIL.texte}));
      y += ls.length*33 + 14;
    }
    y += 4;
  }
  bilFilet(c, y); y += 46;

  /* --- pied --- */
  bilEcrire(c, 'ABYSS · JEUX VIDÉOS', M, y, {f:`500 15px ${BIL.mono}`, c:BIL.or, ls:'.22em'});
  bilEcrire(c, new Date().toLocaleDateString('fr-FR', {day:'numeric', month:'long', year:'numeric'}),
    M+W, y, {f:`400 18px ${BIL.corps}`, c:BIL.doux, a:'right'});
  y += 56;

  const H = Math.min(Math.round(y), brouillon.height);
  const sortie = document.createElement('canvas');
  sortie.width = L; sortie.height = H;
  const o = sortie.getContext('2d');
  bilFond(o, H);
  o.drawImage(brouillon, 0, 0);
  return sortie;
}

/* --- la fenêtre --- */
/* Une seule fenêtre pour les deux images : le bilan d'un onglet et la carte
   d'un jeu. Elle ne sait rien de ce qu'elle montre, on lui passe le titre,
   le nom du fichier et la fonction qui compose le canvas. */
let BILAN_BLOB = null, BILAN_URL = null, BILAN_JETON = 0;

function libererBilan(){
  if(BILAN_URL){ URL.revokeObjectURL(BILAN_URL); BILAN_URL = null; }
  BILAN_BLOB = null;
}
function ouvrirBilan(){
  if(!current().length){ toast("Cet onglet est vide : rien à mettre en image.", true); return; }
  const nom = S.bucket === 'all' ? 'complet' : S.bucket;
  ouvrirImage({
    titre: `Bilan ${nom}`,
    fichier: 'bilan-' + (slug(nom) || 'journal') + '.png',
    partage: 'Bilan ' + nom,
    composer: bilanCanvas,
  });
}
function partagerJeu(g){
  if(!g) return;
  ouvrirImage({
    titre: `« ${g.name} » en image`,
    fichier: 'jeu-' + (slug(g.name) || 'fiche') + '.png',
    partage: g.name,
    composer: ()=> ficheCanvas(g),
  });
}
function ouvrirImage(opt){
  closeMenu();
  const host = $('bilan');
  host.innerHTML = `<div class="sheet bilan-sheet" role="dialog" aria-modal="true" aria-label="${esc(opt.titre)}">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">${esc(opt.titre)}</b></span>
      <span class="grp"><button class="sbtn bilan-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="bilan-in">
      <div class="bilan-apercu" id="bilanApercu"><span class="bilan-attente">Composition de l'image...</span></div>
      <div class="bilan-actions">
        <button class="ghost" id="bilanFermer">Fermer</button>
        <button class="ghost" id="bilanPartager" hidden>Partager</button>
        <button class="cta auto" id="bilanTelecharger" disabled>Télécharger</button>
      </div>
    </div>
  </div>`;
  host.hidden = false;
  verrouFond();
  host.querySelector('.bilan-x').onclick = fermerBilan;
  $('bilanFermer').onclick = fermerBilan;
  host.querySelector('.bilan-x').focus();
  composerImage(opt);
}
async function composerImage(opt){
  /* le jeton dit si la fenêtre a été fermée pendant la composition :
     dans ce cas on jette le résultat au lieu d'écrire dans le vide */
  const jeton = ++BILAN_JETON;
  let toile;
  try{
    toile = await opt.composer();
  }catch(e){
    if(jeton !== BILAN_JETON) return;
    const a = $('bilanApercu');
    if(a) a.innerHTML = '<span class="bilan-attente">L\'image n\'a pas pu être composée.</span>';
    return;
  }
  if(jeton !== BILAN_JETON) return;
  const apercu = $('bilanApercu');
  if(!apercu) return;
  apercu.innerHTML = '';
  apercu.appendChild(toile);

  const fichier = opt.fichier;
  toile.toBlob(b=>{
    if(jeton !== BILAN_JETON || !b) return;
    libererBilan();
    BILAN_BLOB = b;
    const dl = $('bilanTelecharger');
    if(dl){
      dl.disabled = false;
      dl.onclick = ()=>{
        // l'adresse n'est libérée qu'à la fermeture, ou au clic suivant :
        // la révoquer aussitôt annulerait le téléchargement en cours
        if(BILAN_URL) URL.revokeObjectURL(BILAN_URL);
        BILAN_URL = URL.createObjectURL(BILAN_BLOB);
        const a = document.createElement('a');
        a.href = BILAN_URL;
        a.download = fichier;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
    }
    /* partage direct quand le navigateur sait le faire - surtout utile
       depuis le téléphone, où « télécharger » finit dans un dossier perdu */
    try{
      const f = new File([b], fichier, {type:'image/png'});
      if(navigator.canShare && navigator.canShare({files:[f]})){
        const p = $('bilanPartager');
        if(p){
          p.hidden = false;
          p.onclick = ()=> navigator.share({files:[f], title: opt.partage}).catch(()=>{});
        }
      }
    }catch(e){}
  }, 'image/png');
}
function fermerBilan(){
  const host = $('bilan');
  if(host.hidden) return;
  BILAN_JETON++;
  host.hidden = true;
  host.innerHTML = '';
  libererBilan();
  verrouFond();
}
fermeSurFond('bilan', fermerBilan);
/* Les statistiques sont une lecture à part du classeur, pas un tiroir de
   plus : elles vivent dans les réglages, à côté du résumé et de l'export,
   avec lesquels elles ont plus à voir qu'avec les onglets. La barre
   d'onglets reste affichée pendant qu'on les consulte - c'est par elle
   qu'on en ressort. */
$('statsBtn').addEventListener('click', ()=>{
  closeMenu();
  choisirOnglet('stats');
});
$('bilanBtn').addEventListener('click', ouvrirBilan);
