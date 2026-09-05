/* =======================================================================
   Archive Jeux Vidéos — archive-stats.js

   L'onglet « Statistiques » : quatre lectures d'une même question.

   Deux nuages de points (note contre temps de jeu, note contre prix payé)
   et deux jeux de barres classées (par genre, par développeur), tout en
   SVG écrit à la main. Le menu en tête choisit l'onglet analysé.

   Chargé par templates/jeux-videos.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */

/* =======================================================================
   Onglet « Statistiques »

   Quatre lectures de la même question : qu'est-ce qui va avec une bonne
   note ? Deux formes, choisies par la nature de la donnée et pas par goût.

   - Temps de jeu et prix sont des quantités continues. Un nuage de points
     est la seule forme qui n'invente rien : il montre la dispersion, les
     cas isolés, et les paquets. Les mettre en barres obligerait à
     découper en tranches, et le découpage déciderait de la conclusion.
   - Genre et développeur sont des catégories, et un jeu en porte
     plusieurs. Un nuage empilerait des centaines de points sur une
     poignée d'abscisses, illisible. Des barres classées par moyenne
     répondent directement à « lesquels je note le mieux ».

   Chaque moyenne est accompagnée du nombre de jeux derrière elle, et rien
   n'est affiché sous ANALYSE_MINI : une moyenne sur deux jeux n'est pas un
   fait, c'est un hasard avec une décimale.

   Tout est en SVG écrit à la main. Pas de bibliothèque : la page n'a pas
   d'étape de construction, et quatre graphiques ne valent pas 300 Ko.
   ======================================================================= */
const ANALYSE_MINI = 3;      // en dessous, une moyenne ne veut rien dire

/* L'onglet dont les statistiques parlent, ramené à ce qui existe encore.
   Un onglet vidé de ses jeux disparaît de BUCKETS, et continuer d'annoncer
   « 2019 » au-dessus de graphiques vides ne dirait pas ce qui s'est
   passé : on retombe sur le classeur entier, comme le mur le fait déjà
   quand son onglet s'en va. */
function ongletAnalyse(){
  const k = S.anBucket;
  if(k === 'all' || estStatutNom(k) || BUCKETS.indexOf(k) < 0) return 'all';
  return k;
}

/* Les jeux sur lesquels une statistique a un sens : terminés et notés. Un
   jeu en cours ou en wishlist n'a pas de note, et sa présence ferait
   mentir tous les effectifs.

   Restreints à l'onglet choisi, s'il y en a un : « est-ce que je note
   mieux qu'il y a trois ans », « quel genre m'a occupé cette année-là »
   sont des questions qu'un classeur entier ne sait pas répondre. */
function jeuxAnalyses(){
  const onglet = ongletAnalyse();
  return GAMES.filter(x => !estStatut(x) && x.rating !== null && x.rating !== undefined
                           && (onglet === 'all' || x.bucket === onglet));
}

/* Le menu déroulant qui choisit cet onglet-là. Les statuts n'y sont pas :
   ils n'ont rien de noté à analyser, et les proposer serait promettre
   quatre graphiques vides. */
function choixAnalyseHTML(){
  const onglet = ongletAnalyse();
  const periodes = BUCKETS.filter(b => !estStatutNom(b));
  if(!periodes.length) return '';
  const option = (k, l) =>
    `<option value="${esc(k)}"${k === onglet ? ' selected' : ''}>${esc(l)}</option>`;
  return `<label class="an-choix">
      <span>Sur</span>
      <select class="sel" id="anOnglet" aria-label="Onglet analysé">
        ${option('all', 'Tout')}
        ${periodes.map(b => option(b, b)).join('')}
      </select>
    </label>`;
}

/* onchange et non addEventListener, pour la même raison que le dépliage
   des barres : renderAnalyse() redessine la section entière à chaque
   passage, et des écouteurs empilés finiraient par s'annuler.

   Seule la section se refait, pas la page : changer d'onglet analysé ne
   touche ni au mur, ni aux onglets, ni à la fiche ouverte. */
function brancheChoixAnalyse(){
  const sel = document.getElementById('anOnglet');
  if(!sel) return;
  sel.onchange = ()=>{ S.anBucket = sel.value; renderAnalyse(); };
}

/* Coefficient de Pearson : entre -1 et 1. Sans lui, un nuage laisse croire
   ce qu'on veut y voir — c'est le chiffre qui tranche entre « ça monte »
   et « ça ne dit rien ». */
function correlation(paires){
  const n = paires.length;
  if(n < 3) return null;
  const mx = paires.reduce((s,p)=>s+p[0],0)/n;
  const my = paires.reduce((s,p)=>s+p[1],0)/n;
  let num = 0, dx = 0, dy = 0;
  paires.forEach(([a,b])=>{ num += (a-mx)*(b-my); dx += (a-mx)**2; dy += (b-my)**2; });
  const den = Math.sqrt(dx*dy);
  return den ? num/den : null;
}
function litCorrelation(r){
  if(r === null) return 'trop peu de jeux pour en dire quoi que ce soit';
  const f = Math.abs(r);
  const sens = r > 0 ? 'monte avec' : 'baisse quand monte';
  if(f < 0.2) return `aucun lien visible (r = ${fr(r,2)})`;
  if(f < 0.4) return `un lien faible, la note ${sens} (r = ${fr(r,2)})`;
  if(f < 0.6) return `un lien net, la note ${sens} (r = ${fr(r,2)})`;
  return `un lien fort, la note ${sens} (r = ${fr(r,2)})`;
}

/* ---------- le nuage de points ---------- */
const AN_L = 640, AN_H = 360, AN_MG = 46, AN_MB = 34, AN_MT = 12, AN_MR = 12;

function nuageHTML(titre, points, uniteX, fmtX, sous, log){
  if(points.length < 3){
    return carteAnalyse(titre, 'Moins de trois jeux renseignés : rien à tracer.', '');
  }
  const xMax = Math.max(...points.map(p => p.x));
  const py = v => AN_MT + (1 - v/10) * (AN_H - AN_MT - AN_MB);
  const large = AN_L - AN_MG - AN_MR;

  /* Échelle logarithmique quand les valeurs s'étalent sur plusieurs ordres
     de grandeur — c'est le cas du temps de jeu : moitié des jeux sous 12 h,
     et un à 3 581 h. En linéaire, tout se tasserait contre l'axe gauche sur
     moins d'un pour cent de la largeur et le graphique ne dirait plus rien.
     Aucun point n'est écarté pour autant : c'est la règle qui change, pas
     les données. */
  let px, graduations;
  if(log){
    const bas = 1, haut = Math.pow(10, Math.ceil(Math.log10(Math.max(xMax, 10))));
    const l = v => Math.log10(Math.max(v, bas));
    px = v => AN_MG + (l(v) - l(bas)) / (l(haut) - l(bas)) * large;
    graduations = [];
    for(let v = bas; v <= haut; v *= 10) graduations.push(v);
  }else{
    const haut = echelleHaute(xMax);
    px = v => AN_MG + (v / haut) * large;
    graduations = [0,1,2,3,4].map(i => haut/4*i);
  }

  const grilleY = [0,2,4,6,8,10].map(v =>
    `<line class="an-grille" x1="${AN_MG}" y1="${py(v).toFixed(1)}" x2="${AN_L-AN_MR}" y2="${py(v).toFixed(1)}"/>
     <text class="an-axe" x="${AN_MG-8}" y="${(py(v)+3.5).toFixed(1)}" text-anchor="end">${v}</text>`).join('');
  const grilleX = graduations.map(v =>
    `<text class="an-axe" x="${px(v).toFixed(1)}" y="${AN_H-AN_MB+18}" text-anchor="middle">${esc(fmtX(v))}</text>`).join('');

  /* Les points sont tracés du plus grand rayon au plus petit ? Non : dans
     l'ordre reçu, mais semi-transparents. Là où les jeux se tassent, les
     disques s'additionnent et la densité se voit — un aplat opaque ne
     dirait pas si un point en cache deux ou vingt. */
  const disques = points.map(p =>
    `<circle class="an-pt" cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="4.5"
       fill="${noteColor(p.y)}" data-info="${esc(p.nom)} — ${fr(p.y,1)}/10, ${esc(fmtX(p.x))}"/>`).join('');

  const r = correlation(points.map(p => [p.x, p.y]));
  return carteAnalyse(titre,
    `${points.length} jeu${points.length>1?'x':''} · ${litCorrelation(r)}${
      log ? ' · échelle logarithmique' : ''}${sous ? ' · ' + sous : ''}`,
    `<svg class="an-svg" viewBox="0 0 ${AN_L} ${AN_H}" role="img"
          aria-label="${esc(titre)}, ${points.length} jeux">
       ${grilleY}${grilleX}
       <line class="an-cadre" x1="${AN_MG}" y1="${AN_MT}" x2="${AN_MG}" y2="${AN_H-AN_MB}"/>
       <line class="an-cadre" x1="${AN_MG}" y1="${AN_H-AN_MB}" x2="${AN_L-AN_MR}" y2="${AN_H-AN_MB}"/>
       <text class="an-unite" x="${AN_L-AN_MR}" y="${AN_H-4}" text-anchor="end">${esc(uniteX)}</text>
       ${disques}
     </svg>`);
}

/* Un maximum d'axe rond : 47 h devient 50, 1250 € devient 1500. Un axe qui
   s'arrête sur la valeur exacte du plus grand point colle ce point au bord
   et donne des graduations illisibles. */
function echelleHaute(v){
  if(v <= 0) return 1;
  const ordre = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / (ordre/2)) * (ordre/2);
}

/* ---------- les barres classées ---------- */
/* Une barre se déplie sur la liste des jeux qu'elle résume. Une moyenne
   sans ce qu'il y a derrière n'est qu'un chiffre : « Puzzle 7,41 » ne dit
   pas si c'est un genre régulier ou deux chefs-d'œuvre qui rattrapent
   quatre ratages. La liste est là, en un clic, triée par note.

   Repliée par défaut, et une seule ouverte à la fois : vingt genres
   dépliés d'un coup redonneraient le mur de jeux, qui existe déjà. */
function barresHTML(titre, groupes, legende){
  const lignes = Object.entries(groupes)
    .filter(([, jeux]) => jeux.length >= ANALYSE_MINI)
    .map(([nom, jeux]) => ({
      nom: nom,
      n: jeux.length,
      moy: jeux.reduce((s,x)=>s+x.rating,0) / jeux.length,
      jeux: jeux.slice().sort((a,b) => b.rating - a.rating),
    }))
    .sort((a,b) => b.moy - a.moy);

  if(!lignes.length){
    return carteAnalyse(titre,
      `Aucun n'atteint ${ANALYSE_MINI} jeux notés.`, '');
  }
  const corps = lignes.map(l => `
    <div class="an-item">
      <button type="button" class="an-ligne" aria-expanded="false">
        <span class="an-nom">${esc(l.nom)}</span>
        <span class="an-piste"><i style="width:${(l.moy*10).toFixed(1)}%;background:${noteColor(l.moy)}"></i></span>
        <span class="an-val">${fr(l.moy,2)}<em>${l.n} jeu${l.n>1?'x':''}</em></span>
      </button>
      <div class="an-jeux" hidden>${l.jeux.map(j => `
        <span class="an-jeu">
          <b>${esc(j.name)}</b>
          <i style="color:${noteColor(j.rating)}">${fr(j.rating,1)}</i>
        </span>`).join('')}</div>
    </div>`).join('');
  return carteAnalyse(titre, legende, `<div class="an-barres">${corps}</div>`);
}

function carteAnalyse(titre, sous, corps){
  return `<article class="an-carte">
    <header class="an-tete"><h3>${esc(titre)}</h3><span>${esc(sous)}</span></header>
    ${corps || '<p class="an-vide">Rien à montrer pour l\'instant.</p>'}
  </article>`;
}

/* Regroupe les JEUX par valeur d'un champ à valeurs multiples
   (« Platform, Puzzle, Adventure ») : un jeu compte dans chacune.
   Les jeux et pas seulement leurs notes, parce que la barre se déplie sur
   la liste — la moyenne se recalcule à partir d'eux. */
function groupePar(jeux, champ){
  const d = {};
  jeux.forEach(x => String(x[champ] || '').split(',').forEach(v => {
    const k = v.trim();
    if(k) (d[k] = d[k] || []).push(x);
  }));
  return d;
}

function renderAnalyse(){
  const hote = document.getElementById('analyse');
  const onglet = ongletAnalyse();
  const jeux = jeuxAnalyses();
  /* Le menu reste affiché même quand il n'y a rien à montrer : c'est par
     lui qu'on ressort d'une année vide, et le retirer enfermerait dans le
     seul onglet où la page n'a rien à dire. */
  const choix = choixAnalyseHTML();
  if(!jeux.length){
    hote.innerHTML = `<div class="tip" id="anTip"></div>
      <div class="an-entete"><h2>Statistiques</h2>${choix}</div>
      <p class="an-rien">${onglet === 'all'
        ? 'Aucun jeu terminé et noté : les statistiques arriveront avec eux.'
        : esc(`Aucun jeu noté dans « ${onglet} ».`)}</p>`;
    brancheChoixAnalyse();
    return;
  }
  const heures = jeux.filter(x => x.hours).map(x => ({x: x.hours, y: x.rating, nom: x.name}));

  /* Le prix demande une précaution : un jeu à 0 € n'est pas un jeu bon
     marché, c'est un jeu qui n'a pas été acheté (offert, bundle, gratuit).
     Le mettre dans le nuage collerait une colonne verticale contre l'axe
     et écraserait les vrais prix. Mais l'écarter en silence cacherait le
     fait le plus intéressant du lot — alors il est dit en toutes lettres
     dans le sous-titre, et il vaut mieux qu'un point de plus. */
  const payants = jeux.filter(x => x.paid > 0);
  const offerts = jeux.filter(x => x.paid === 0);
  const moyenne = l => l.reduce((s,x)=>s+x.rating,0) / l.length;
  const prix = payants.map(x => ({x: x.paid, y: x.rating, nom: x.name}));
  const compare = (offerts.length >= ANALYSE_MINI && payants.length >= ANALYSE_MINI)
    ? `${offerts.length} jeux obtenus sans payer : ${fr(moyenne(offerts),2)} de moyenne, contre ${
        fr(moyenne(payants),2)} pour les payants`
    : '';

  hote.innerHTML = `<div class="tip" id="anTip"></div>
    <div class="an-entete">
      <h2>Statistiques</h2>
      ${choix}
      <p>Sur ${jeux.length} jeu${jeux.length>1?'x':''} terminé${jeux.length>1?'s':''} et noté${
        jeux.length>1?'s':''}${onglet === 'all' ? ' du classeur' : esc(` de « ${onglet} »`)}.</p>
    </div>
    <div class="an-grille2">
      ${nuageHTML('Note et temps de jeu', heures, 'heures de jeu',
                  v => fr(v,0) + ' h', '', true)}
      ${nuageHTML('Note et prix payé', prix, 'prix payé',
                  v => fr(v,0) + ' €', compare, false)}
      ${barresHTML('Note moyenne par genre', groupePar(jeux, 'genres'), ``)}
      ${barresHTML('Note moyenne par développeur', groupePar(jeux, 'developpeur'), ``)}
    </div>`;
  brancheInfobulleAnalyse();
  brancheDepliage();
  brancheChoixAnalyse();
}

/* Un seul gestionnaire pour toutes les barres, posé sur la section : elles
   sont redessinées à chaque rendu, et rattacher vingt écouteurs à chaque
   fois ne servirait qu'à les oublier une fois sur deux.

   onclick et non addEventListener : renderAnalyse() rappelle cette
   fonction à chaque rendu. Avec addEventListener les écouteurs
   s'empileraient, et deux d'entre eux s'annuleraient — le premier ouvre la
   liste, le second la voit ouverte et la referme aussitôt. Une affectation
   remplace au lieu d'ajouter. */
function brancheDepliage(){
  const hote = document.getElementById('analyse');
  if(!hote) return;
  hote.onclick = e=>{
    const b = e.target.closest('.an-ligne');
    if(!b) return;
    const liste = b.nextElementSibling;
    const ouvrir = liste.hidden;
    // on referme celle d'avant : deux listes ouvertes noient la comparaison
    hote.querySelectorAll('.an-jeux').forEach(l => { l.hidden = true; });
    hote.querySelectorAll('.an-ligne').forEach(x => x.setAttribute('aria-expanded', 'false'));
    if(ouvrir){
      liste.hidden = false;
      b.setAttribute('aria-expanded', 'true');
    }
  };
}

/* Une seule infobulle, pour les nuages de points : elle suit le pointeur et
   lit data-info. Les barres n'en portent plus — leur ligne dit déjà tout ce
   que l'infobulle répétait, le nom, la moyenne et l'effectif, et une bulle
   qui redit ce qu'on est en train de lire ne fait que masquer la ligne
   suivante. Un point d'un nuage, lui, n'a pas de place pour son étiquette. */
function brancheInfobulleAnalyse(){
  const hote = document.getElementById('analyse');
  const tip = document.getElementById('anTip');
  if(!hote || !tip) return;
  hote.onmousemove = e => {
    const cible = e.target.closest('[data-info]');
    if(!cible){ tip.classList.remove('show'); return; }
    tip.textContent = cible.dataset.info;
    const b = hote.getBoundingClientRect();
    tip.style.left = (e.clientX - b.left) + 'px';
    tip.style.top  = (e.clientY - b.top - 12) + 'px';
    tip.classList.add('show');
  };
  hote.onmouseleave = ()=> tip.classList.remove('show');
}
