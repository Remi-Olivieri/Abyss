/* =======================================================================
   Archive Jeux Vidéos - archive-mur.js

   Le mur de jaquettes et ce qui le surmonte.

   Filtrer, trier, découper en onglets ; les quatre chiffres du bandeau,
   l'histogramme des notes et son filtre par tranche ; les tuiles, gardées
   d'un rendu à l'autre au lieu d'être refaites ; et la découverte par
   similarité de la wishlist.

   casiers() vit ici : c'est le découpage de l'histogramme, et
   archive-image.js le reprend tel quel pour le bilan en image.

   Chargé par templates/jeux-videos.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */

function current(){
  let g = GAMES.slice();
  if(S.bucket!=='all') g = g.filter(x=>x.bucket===S.bucket);
  return g;
}
function binOf(note, R){
  return Math.max(0, Math.min(R.n-1, Math.floor((note - R.lo) / R.step)));
}
function dansTranche(x){
  const R = S.range;
  if(!R) return true;
  if(x.rating===null) return false;
  return binOf(x.rating, R) === R.i;
}
function filtered(){
  let g = current();
  // « Tout » mélangerait des jeux finis avec des jeux en cours ou convoités,
  // sans note ni temps de jeu : ils restent visibles dans leur propre onglet,
  // mais pas ici
  if(S.bucket==='all') g = g.filter(x=>!estStatut(x));
  if(S.range) g = g.filter(dansTranche);
  if(S.q){
    const q = norm(S.q);
    g = g.filter(x=>norm(x.name).includes(q));
  }
  return g.sort(comparateur(S.sort, S.dir));
}

/* Le comparateur d'un critère dans un sens donné. Une seule règle pour
   tous : ce qu'on ne sait pas ne se classe pas. Un jeu sans note, sans
   date annoncée ou dont on n'a jamais noté le prix payé finit en bas dans
   les deux sens - sans quoi retourner la flèche remplirait le haut de la
   liste de cases vides, alors qu'on cherchait le moins cher. */
function comparateur(cle, sens){
  const def = TRIS.find(t => t[0] === cle) || TRIS[0];
  const val = def[3], depart = def[4] || (cle === 'az' ? null : DEPART_NOM);
  const signe = sens === 'asc' ? 1 : -1;
  const absent = v => v === null || v === undefined || v === '';
  return (a,b)=>{
    const va = val(a), vb = val(b);
    if(absent(va) || absent(vb)){
      if(!absent(vb)) return 1;
      if(!absent(va)) return -1;
    }else{
      const d = typeof va === 'string' ? va.localeCompare(vb,'fr') : va - vb;
      if(d) return signe * d;
    }
    return depart ? depart(a,b) : 0;
  };
}

/* ---------- rendu : onglets ----------
   « Tout », puis un menu déroulant qui regroupe les périodes, puis « En cours »
   et « Wishlist » en boutons séparés : ce sont des statuts, pas des périodes,
   et on veut y aller d'un seul clic. Regrouper les années évite aussi que la
   barre s'allonge sans fin à chaque nouvelle année. */
function choisirOnglet(k){
  closePer();
  /* On entre dans les statistiques : elles s'ouvrent sur l'onglet qu'on
     était en train de lire. « En cours » et « Wishlist » n'ont ni note ni
     temps de jeu, il n'y a rien à analyser dedans - depuis ceux-là, et
     depuis « Tout », c'est le classeur entier. Le menu déroulant de la
     page permet ensuite d'en changer sans repasser par les onglets. */
  if(k === 'stats' && S.bucket !== 'stats'){
    S.anBucket = (S.bucket === 'all' || estStatutNom(S.bucket)) ? 'all' : S.bucket;
  }
  S.bucket = k;
  S.range = null;   // l'histogramme est recalculé : la tranche choisie ne vaut plus
  render();
}
function closePer(){
  const m = document.getElementById('perMenu');
  if(!m || m.hidden) return;
  m.hidden = true;
  const b = document.getElementById('perBtn');
  if(b) b.setAttribute('aria-expanded', 'false');
}
function togglePer(periodes){
  const m = document.getElementById('perMenu');
  if(!m) return;
  const ouvert = m.hidden;
  if(ouvert){
    closeMenu(); fermerRecherche();               // un seul menu ouvert à la fois
    /* Plus de coche : l'onglet courant se surligne, comme dans la barre
       juste au-dessus. Une coche ici et un fond doré là pour dire la même
       chose obligeait à apprendre deux signes au lieu d'un - et la coche
       se disputait la droite de la ligne avec l'étoile. */
    const entree = ongletEntree();
    m.innerHTML = periodes.map(b=>
      `<button class="menu-item${b===S.bucket?' on':''}" role="menuitem" data-b="${esc(b)}"
         aria-current="${b===S.bucket}"${periodeValide(b) ? '' :
           ' title="Onglet d\'avant la règle - clic droit dessus pour le renommer"'
         }>${esc(b)}${b===entree?ETOILE:''}${
         periodeValide(b)?'':'<span class="vieux">à renommer</span>'}</button>`).join('');
    m.querySelectorAll('.menu-item').forEach(x=>{
      x.onclick = ()=> choisirOnglet(x.dataset.b);
      x.oncontextmenu = e => menuOnglet(e, x.dataset.b);
    });
  }
  m.hidden = !ouvert;
  document.getElementById('perBtn').setAttribute('aria-expanded', ouvert ? 'true' : 'false');
}
/* ---------- clic droit sur un onglet ----------
   Un seul choix pour l'instant, mais un vrai menu contextuel plutôt qu'une
   bascule directe : un clic droit qui agit tout seul, sans rien montrer,
   est impossible à découvrir et impossible à annuler.

   Réservé au propriétaire : le réglage s'écrit dans son classeur. Chez
   quelqu'un d'autre, le clic droit rend la main au navigateur - son menu
   habituel vaut mieux que le nôtre, qui n'aurait rien à proposer. */
function fermeMenuOnglet(){
  const m = document.getElementById('ongletMenu');
  if(m) m.remove();
}
function menuOnglet(e, onglet){
  if(!CAN_WRITE || !onglet) return;      // pas chez moi : menu du navigateur
  e.preventDefault();
  e.stopPropagation();
  fermeMenuOnglet();
  const actuel = onglet === ONGLET_DEFAUT;
  const m = document.createElement('div');
  m.id = 'ongletMenu';
  m.className = 'menu onglet-menu';
  /* Renommer est la sortie de secours des journaux d'avant la règle :
     « A long long time ago » ne peut plus être créé, mais il existe, et il
     faut bien pouvoir le tourner en « Avant 2000 » sans rouvrir trois cents
     jeux un par un. Proposé sur tous les onglets, pas seulement les
     fautifs : corriger une année mal choisie relève du même geste. */
  /* « Tout », « En cours » et « Wishlist » ne se renomment pas : les deux
     derniers sont des tiroirs fixes du journal, et le premier n'est même pas
     un onglet - c'est la vue qui les montre tous. Renommer l'un des trois
     n'aurait rien à renommer, seulement de quoi casser ce que la page
     reconnaît par leur nom. Le serveur refuse déjà ; l'entrée ne s'affiche
     pas, ce qui vaut mieux qu'un refus après le clic. */
  const renommable = !estStatutNom(onglet) && !ONGLETS_VUE.includes(onglet);
  m.innerHTML = `<button class="menu-item" type="button" data-quoi="defaut">${
      actuel ? 'Ne plus ouvrir sur cet onglet' : 'Définir comme onglet par défaut'}</button>` +
    (renommable
      ? '<button class="menu-item" type="button" data-quoi="renommer">Renommer cet onglet</button>'
      : '');
  document.body.appendChild(m);
  /* posé après l'insertion : sa taille n'est connue qu'une fois dans la
     page, et sans elle on ne peut pas l'empêcher de déborder à droite */
  const l = Math.min(e.clientX, innerWidth - m.offsetWidth - 8);
  const t = Math.min(e.clientY, innerHeight - m.offsetHeight - 8);
  m.style.left = Math.max(8, l) + 'px';
  m.style.top  = Math.max(8, t) + 'px';
  m.querySelector('[data-quoi="defaut"]').onclick = ()=>{
    fermeMenuOnglet();
    poseOngletDefaut(actuel ? null : onglet);
  };
  const ren = m.querySelector('[data-quoi="renommer"]');
  if(ren) ren.onclick = ()=>{
    fermeMenuOnglet();
    ouvrirRenom(onglet);
  };
}
document.addEventListener('click', fermeMenuOnglet);
document.addEventListener('scroll', fermeMenuOnglet, true);
window.addEventListener('resize', fermeMenuOnglet);

/* ---------- renommer un onglet ----------
   Le même constructeur que dans le formulaire d'un jeu : composer un nom
   valide est le même geste, qu'on range un jeu ou qu'on répare un onglet.

   Renommer vers un onglet qui existe déjà les fusionne. C'est dit avant de
   cliquer, pas découvert après : « oui » et « 2019 » finissent souvent par
   désigner la même année, mais ça doit être un choix. */
function ouvrirRenom(onglet){
  const host = $('renom');
  const n = GAMES.filter(g => g.bucket === onglet).length;
  host.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"
      aria-label="Renommer un onglet" style="max-width:460px">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">Renommer « ${esc(onglet)} »</b></span>
      <span class="grp"><button class="sbtn renom-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="rsearch-in">
      <p class="rsearch-vide" style="text-align:left;padding:0 0 14px">${
        n} jeu${n > 1 ? 'x' : ''} ${n > 1 ? 'suivront' : 'suivra'} ce nom.</p>
      ${constructeurHTML('r')}
      <p class="qz-info" id="r_avis" style="margin:14px 0 0;font-size:12.5px;color:var(--muted)"></p>
      <button class="cta" id="r_ok" style="margin-top:16px">Renommer</button>
    </div>
  </div>`;
  host.hidden = false;
  verrouFond();
  host.querySelector('.renom-x').onclick = fermerRenom;
  brancheConstructeur('r', periodeValide(onglet) ? onglet : '', (nom)=>{
    const fusion = BUCKETS.indexOf(nom) >= 0 && nom !== onglet;
    $('r_avis').textContent = fusion
      ? `« ${nom} » existe déjà : les deux onglets n'en feront plus qu'un.`
      : '';
    $('r_ok').textContent = fusion ? 'Fusionner' : 'Renommer';
    $('r_ok').disabled = nom === onglet;
  });
  /* On vient ici pour composer un autre nom : le panneau s'ouvre d'emblée
     plutôt que de faire cliquer sur « Autre… » à coup sûr. */
  $('r_autre').click();
  $('r_ok').onclick = ()=> renommeOnglet(onglet, $('r_ok'));
}
function fermerRenom(){
  const host = $('renom');
  if(host.hidden) return;
  host.hidden = true; host.innerHTML = '';
  verrouFond();
}
fermeSurFond('renom', fermerRenom);

async function renommeOnglet(avant, bouton){
  const apres = valeurConstructeur('r');
  if(!apres || apres === avant) return;
  bouton.disabled = true;
  const texte = bouton.textContent;
  bouton.textContent = 'Enregistrement...';
  try{
    const data = await envoyer('PUT', '/api/journal/periode', {avant, apres});
    cacheStore.set(source().url, data);
    /* L'onglet affiché portait peut-être l'ancien nom : le suivre, sinon on
       se retrouve sur un onglet qui n'existe plus et la page paraît vide. */
    if(S.bucket === avant) S.bucket = apres;
    applyData(data, true);
    fermerRenom();
    render();
    toast(`Onglet renommé en « ${apres} »`);
  }catch(e){
    bouton.disabled = false; bouton.textContent = texte;
    toast(e.message, true);
  }
}

async function poseOngletDefaut(onglet){
  try{
    const data = await envoyer('POST', '/api/journal/onglet-defaut', {onglet: onglet});
    cacheStore.set(source().url, data);
    /* applyData remet PREMIERE_FOIS à false depuis longtemps : l'onglet
       affiché ne bouge donc pas sous les doigts. On ne fait que réafficher
       la barre pour que la puce suive. */
    applyData(data, true);
    renderTabs();
    toast(onglet ? `Ton classeur s'ouvrira sur « ${onglet} ».`
                 : "Ton classeur s'ouvrira de nouveau sur l'année la plus récente.");
  }catch(err){ toast(err.message || 'Enregistrement impossible', true); }
}

/* Une étoile pleine plutôt qu'au trait : à onze pixels, un contour se
   brouille et ne se reconnaît plus. */
const ETOILE = `<svg class="etoile" width="11" height="11" viewBox="0 0 16 16"
  fill="currentColor" aria-hidden="true"><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8
  11.4 4.2 13.4l.7-4.3-3.1-3 4.3-.6z"/></svg>`;

function renderTabs(){
  const t = document.getElementById('tabs');
  const periodes = BUCKETS.filter(b => !estStatutNom(b));
  const statuts  = BUCKETS.filter(estStatutNom);   // garde l'ordre de la feuille
  const surPeriode = periodes.indexOf(S.bucket) >= 0;
  /* Pas de compteur sur les onglets : le chiffre alourdissait une barre
     qu'on parcourt du regard. Il est allé dans le bandeau juste en dessous,
     où « Jeux terminés » le donnait déjà pour les années. */
  /* L'onglet d'ouverture porte une étoile, posée après le libellé. C'était
     une puce dorée dans son coin - soit, au pixel près, le dessin d'une
     notification : tout le monde y lisait « il y a du neuf ici », alors
     qu'elle ne dit que « c'est là qu'on arrive ».

     Elle suit ongletEntree() et non le seul choix de l'auteur : sans choix,
     le classeur s'ouvre sur « Tout », et c'est donc « Tout » qui la porte.
     La marquer nulle part laissait croire que rien n'était réglé. */
  const entree = ongletEntree();
  const bouton = (k, l) =>
    `<button class="tab" role="tab" data-b="${esc(k)
      }" aria-selected="${S.bucket===k}">${esc(l)}${k === entree ? ETOILE : ''}</button>`;

  t.innerHTML = bouton('all', 'Tout')
    + (periodes.length ? `<span class="tab-wrap">
        <button class="tab tab-menu" id="perBtn" role="tab" aria-haspopup="true"
                aria-expanded="false" aria-selected="${surPeriode}">
          <!-- L'étoile ne marque que l'onglet favori lui-même. Elle
               s'affichait dès que le favori était quelque part dans la
               liste, donc elle restait là en affichant « 2024 » alors que
               le favori était « 2023 » : elle désignait le bouton au lieu
               de désigner l'onglet. Repliée sur « Année », elle ne
               montre rien non plus - le favori est dans le menu, où sa
               ligne la porte. -->
          <span>${esc(surPeriode ? S.bucket : 'Année')}${
            surPeriode && S.bucket === entree ? ETOILE : ''}</span>
          <svg class="tab-chev" width="10" height="10" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
        <div class="menu per-menu" id="perMenu" hidden role="menu"></div>
      </span>` : '')
    + statuts.map(b => bouton(b, b)).join('');

  t.querySelectorAll('.tab[data-b]').forEach(b=>{
    b.onclick = ()=> choisirOnglet(b.dataset.b);
    b.oncontextmenu = e => menuOnglet(e, b.dataset.b);
  });
  const pb = document.getElementById('perBtn');
  if(pb) pb.addEventListener('click', e=>{ e.stopPropagation(); togglePer(periodes); });
}

/* ---------- rendu : le tri ---------- */
function familleTri(){
  if(estWishlistNom(S.bucket)) return 'wishlist';
  return estStatutNom(S.bucket) ? 'statut' : 'periode';
}
/* Le sens qu'un critère prend au moment où on le choisit : celui de la
   table, sauf là où la famille d'onglets en décide autrement. */
function sensNaturel(cle, famille){
  const propre = SENS_PAR_FAMILLE[famille];
  if(propre && propre[cle]) return propre[cle];
  const def = TRIS.find(t => t[0] === cle);
  return def ? def[2] : 'desc';
}
function renderSort(){
  const famille = familleTri();
  const permis = TRIS_PAR_FAMILLE[famille];
  const dispo = TRIS.filter(([k]) => permis.indexOf(k) >= 0);
  // on reprend le tri retenu pour cette famille d'onglets, sens compris
  const memo = TRI_MEMO[famille];
  if(!dispo.some(([k]) => k === memo.tri)){     // garde-fou
    memo.tri = 'az';
    memo.dir = sensNaturel('az', famille);
  }
  S.sort = memo.tri;
  S.dir  = memo.dir;
  document.getElementById('sort').innerHTML = dispo.map(([k,l]) =>
    `<option value="${esc(k)}"${k === S.sort ? ' selected' : ''}>${esc(l)}</option>`).join('');
  renderSortDir();
}
/* La flèche vaut pour toute la liste déroulante : quel que soit le
   critère affiché, elle le retourne. Changer de critère, en revanche, rend
   à chacun son sens naturel (voir l'écouteur du menu) - sinon choisir
   « Titre » après « Note ↑ » donnerait un Z → A que personne n'a demandé. */
function renderSortDir(){
  const b = document.getElementById('sortDir');
  if(!b) return;
  const asc = S.dir === 'asc';
  b.classList.toggle('asc', asc);
  const txt = asc ? 'Ordre croissant' : 'Ordre décroissant';
  b.title = txt + ' - cliquer pour inverser';
  b.setAttribute('aria-label', txt + ', inverser le tri');
}

/* ---------- rendu : stats ---------- */

/* « En cours » et « Wishlist » n'ont ni jeu terminé, ni note, ni temps de
   jeu : les quatre grandes cases n'y montreraient que des tirets. Une seule
   ligne de chiffres à la place - et c'est elle qui porte désormais le nombre
   de jeux, que les onglets n'affichent plus. */
function renderStatsStatut(){
  const jeux = current();
  const wish = estWishlistNom(S.bucket);
  // « jeu » fait « jeux », pas « jeus » : les noms en -eu prennent un x.
  // « en wishlist » et « en cours » ne s'accordent pas, ce sont des états.
  const pluriel = jeux.length > 1 ? 'x' : '';
  const lignes = [[String(jeux.length),
    `jeu${pluriel} ${wish ? 'en wishlist' : 'en cours'}`]];

  if(wish){
    // les soldes ne sont connus qu'une fois les tarifs Steam arrivés : la
    // ligne se complète d'elle-même au rendu suivant
    const soldes = jeux.filter(x => remiseDe(x) > 0).length;
    if(soldes) lignes.push([String(soldes), `en solde`]);
    const fort = jeux.reduce((a,x)=> a + (x.base || 0), 0);
    if(fort) lignes.push([EUR.format(fort), 'au prix fort']);
    /* Ce que la liste coûterait aujourd'hui : le tarif du jour quand on le
       connaît, le prix du classeur sinon. Affiché seulement s'il diffère du
       prix fort, sinon la ligne répéterait deux fois la même somme. */
    const jour = jeux.reduce((a,x)=>{
      const tarif = TARIFS[x.name];
      return a + ((tarif && tarif.actuel != null) ? tarif.actuel : (x.base || 0));
    }, 0);
    if(jour && Math.abs(jour - fort) >= 0.005) lignes.push([EUR.format(jour), "aujourd'hui"]);
  }else{
    const paye = jeux.reduce((a,x)=> a + (x.paid || 0), 0);
    if(paye) lignes.push([EUR.format(paye), 'déjà payés']);
  }

  document.getElementById('statsWrap').hidden = false;
  const boite = document.getElementById('stats');
  boite.className = 'stats ligne';
  boite.innerHTML = lignes.map(([b,u]) =>
    `<span><b>${esc(b)}</b>${esc(u)}</span>`).join('');
}

function renderStats(){
  if(estStatutNom(S.bucket)) return renderStatsStatut();
  document.getElementById('statsWrap').hidden = false;
  document.getElementById('stats').className = 'stats';
  // un jeu de la wishlist n'est pas acheté : il ne pèse nulle part, pas même
  // dans les prix - sinon « Payé » compterait de l'argent jamais sorti
  const tout = current().filter(x=>!estWishlist(x));
  // un jeu en cours ne compte pas comme terminé, mais il est bien acheté :
  // il sort de la moyenne et du temps de jeu, il reste dans les prix
  const g = tout.filter(x=>!estEnCours(x));
  const nEnCours = tout.length - g.length;
  const rated = g.filter(x=>x.rating!==null);
  const avg = rated.length ? rated.reduce((s,x)=>s+x.rating,0)/rated.length : null;
  const base = tout.reduce((s,x)=>s+(x.base||0),0);
  const paid = tout.reduce((s,x)=>s+(x.paid||0),0);
  const hrs  = g.reduce((s,x)=>s+(x.hours||0),0);
  const cards = [
    ['Jeux terminés', g.length, nEnCours ? `+ ${nEnCours} en cours` : ''],
    ['Note moyenne', avg!==null?fr(avg,2):'-', ''],
    ['Temps de jeu', hrs?hoursFmt(hrs):'-', hrs?`≈ ${Math.round(hrs/24)} jours`:''],
    ['Payé', paid?EUR.format(paid):'-', base?`sur ${EUR.format(base)} de prix fort`:''],
  ];
  document.getElementById('stats').innerHTML = cards.map(([u,b,i])=>
    `<div class="stat"><u>${u}</u><b>${b}</b><i>${i||''}</i></div>`).join('');
}

/* ---------- le découpage de l'histogramme des notes ----------
   Combien de barres, de quelle largeur, et ce qu'il y a dedans. Partagé
   par l'histogramme de la page et par celui du bilan en image : les deux
   doivent montrer exactement la même chose, et ils recopiaient jusqu'ici
   le même calcul chacun de son côté - donc chaque correction deux fois,
   ou une seule et deux histogrammes qui divergent.

   Le pas suit l'EFFECTIF autant que l'amplitude. Il ne suivait que
   l'amplitude, et quatre jeux notés 7 à 9 tombaient sur une plage forcée à
   trois points découpée par 0,2 : quinze barres pour quatre jeux, dont
   onze vides. Ce n'était plus une répartition mais un peigne. On vise donc
   environ 2·√n barres, et on retient le pas rond le plus fin qui n'en
   fasse pas davantage.

   Ronds, les pas : 2, 1, 0,5 et 0,2 tombent tous juste sur le dixième, et
   seuls ceux qui divisent la plage sont retenus. Un pas bâtard ferait
   alterner les barres haut et bas au seul gré de l'arrondi. */
const PAS_POSSIBLES = [2, 1, 0.5, 0.2];
const DIST_MINI = 3;    // en dessous, une répartition ne montre rien

function casiers(valeurs){
  const notes = valeurs.slice().sort((a,b)=>a-b);
  let lo = Math.floor(notes[0]), hi = Math.ceil(notes[notes.length-1]);
  // un journal où tout est noté entre 8 et 9 tiendrait sur une seule barre :
  // on ouvre la plage à trois points, sans sortir du 0-10
  if(hi - lo < 3){ hi = Math.min(10, lo + 3); lo = Math.max(0, hi - 3); }
  const span = hi - lo;

  const vise = Math.max(4, Math.min(20, Math.round(2 * Math.sqrt(notes.length))));
  const possibles = PAS_POSSIBLES
    .map(pas => ({pas, n: Math.round(span / pas)}))
    .filter(c => Math.abs(c.n * c.pas - span) < 1e-9);
  // le dernier qui tient sous la cible, donc le plus fin ; à défaut le plus
  // grossier, qui est celui qui fait le moins de barres
  const choix = possibles.filter(c => c.n <= vise).pop() || possibles[0];
  const step = choix.pas, n = choix.n;

  const bins = new Array(n).fill(0);
  notes.forEach(r => bins[Math.max(0, Math.min(n - 1, Math.floor((r - lo) / step)))]++);
  return {
    lo, hi, span, step, n, bins,
    max: Math.max(...bins),
    moyenne: notes.reduce((s,x) => s + x, 0) / notes.length,
    mediane: notes.length % 2
      ? notes[(notes.length - 1) / 2]
      : (notes[notes.length / 2 - 1] + notes[notes.length / 2]) / 2,
  };
}

/* ---------- rendu : répartition des notes ---------- */
function renderDist(){
  const sec  = document.getElementById('dist');
  const rated = current().filter(x=>x.rating!==null);
  if(rated.length < DIST_MINI){ sec.hidden = true; S.range = null; return; }
  sec.hidden = false;

  const d = casiers(rated.map(x=>x.rating));
  const {lo, hi, span, n, bins, max} = d;
  const STEP = d.step, avg = d.moyenne, mid = d.mediane;
  // le découpage a bougé (autre onglet, jeu ajouté...) : la tranche choisie ne veut plus rien dire
  if(S.range && (S.range.lo !== lo || S.range.step !== STEP || S.range.n !== n)) S.range = null;
  const pos = v => ((v - lo) / span) * 100;

  document.getElementById('distHint').textContent =
    `moyenne ${fr(avg,2)} · médiane ${fr(mid,2)}`;

  const barsHTML = bins.map((c,i)=>{
    const a = lo + i*STEP, b = a + STEP;
    const h = c ? Math.max(3, c/max*100) : 0;
    return `<button class="bar" type="button"
      data-i="${i}" data-c="${c}" data-a="${fr(a,2)}" data-b="${fr(b,2)}"
      aria-label="${c} jeu${c>1?'x':''} entre ${fr(a,2)} et ${fr(b,2)}${c?" - n'afficher que ceux-là":''}">
      <i style="height:${h}%;background:${noteColor(a + STEP/2)}"></i></button>`;
  }).join('');
  const avgP = pos(avg);
  document.getElementById('hist').innerHTML = barsHTML +
    `<div class="avg${avgP > 70 ? ' flip' : ''}" style="left:${avgP.toFixed(2)}%"><span>moy. ${fr(avg,2)}</span></div>`;

  const stepTick = span <= 8 ? 1 : 2;
  const ticks = [];
  for(let t = lo; t <= hi; t += stepTick) ticks.push(t);
  if(ticks[ticks.length-1] !== hi) ticks.push(hi);
  document.getElementById('haxis').innerHTML = ticks.map(t=>
    `<span style="left:${pos(t).toFixed(2)}%">${t}</span>`).join('');

  const tip = document.getElementById('tip');
  document.getElementById('hist').querySelectorAll('.bar').forEach(bar=>{
    const show = ()=>{
      const c = +bar.dataset.c;
      tip.innerHTML = `<b>${c}</b> jeu${c>1?'x':''} · ${bar.dataset.a} → ${bar.dataset.b}`;
      const box = tip.parentElement.getBoundingClientRect();
      const fill = bar.querySelector('i').getBoundingClientRect();
      const x = fill.left - box.left + fill.width/2;
      tip.style.left   = Math.round(Math.min(Math.max(x, 80), Math.max(80, box.width - 80))) + 'px';
      tip.style.bottom = Math.round(box.bottom - fill.top + 8) + 'px';   // juste au-dessus de la barre
      tip.classList.add('show');
    };
    const hide = ()=> tip.classList.remove('show');
    bar.addEventListener('pointerenter', show);
    bar.addEventListener('pointerleave', hide);
    bar.addEventListener('click', ()=>{
      if(!+bar.dataset.c) return;               // tranche vide : rien à filtrer
      const i = +bar.dataset.i;
      // reclic sur la même tranche : on enlève le filtre
      S.range = (S.range && S.range.i === i)
        ? null
        : { lo, step:STEP, n, i, a: lo + i*STEP, b: lo + (i+1)*STEP };
      majDist(); renderWall();
    });
  });
  majDist();
}
/* Reflète S.range sur l'histogramme sans le redessiner. */
function majDist(){
  const hist = document.getElementById('hist');
  hist.classList.toggle('picked', !!S.range);
  hist.querySelectorAll('.bar').forEach(b=>{
    const on = !!S.range && +b.dataset.i === S.range.i;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const c = document.getElementById('distClear');
  c.hidden = !S.range;
  if(S.range) c.innerHTML = `notes ${fr(S.range.a,2)} → ${fr(S.range.b,2)}<span>×</span>`;
}
function viderTranche(){
  if(!S.range) return;
  S.range = null; majDist(); renderWall();
}
document.getElementById('distClear').addEventListener('click', viderTranche);

/* ---------- identité et cache des tuiles ----------
   Enfin auprès de renderWall(), qui est le seul à s'en servir. Ces
   déclarations vivaient loin d'ici, en tête du fichier d'un seul tenant :
   le démarrage rendait le mur avant que le script ait fini de se dérouler,
   et une liaison lue avant sa ligne de déclaration lève une
   ReferenceError. Le démarrage ferme maintenant la marche (voir
   archive-demarrage.js), et la contrainte est tombée avec lui.

   Les tuiles déjà construites, retrouvées par clé d'un rendu à l'autre. */
const TUILES = new Map();
// séparateur invisible entre les morceaux d'une clé : ni un nom d'onglet
// ni un nom de jeu ne peut le contenir, donc aucune collision possible
const SEP = '\u0001';
/* La clé d'une tuile : l'id du jeu, stable et unique - ce que `row`
   donnait avant que la base remplace les feuilles (voir journal.py). */
const cleTuile = x => String(x.id);
/* Tout ce que la tuile donne à voir. Si rien n'a bougé là-dedans, le nœud
   existant fait l'affaire tel quel. L'adresse de la jaquette en fait partie
   plutôt que le seul nom : elle change quand l'image arrive, quand elle est
   remplacée, ou quand le manifeste apprend qu'elle n'existe pas - trois cas
   où la tuile doit être refaite, et un seul terme pour les couvrir. */
const sigTuile = x => [x.name, x.rating, x.hours, x.bucket, x.release,
                       coverURL(cleJaquette(x)), sigPromo(x)].join(SEP);

/* ---------- rendu : mur ---------- */
function groupLabel(g){
  if(estStatut(g)) return statutDe(g);
  if(g.year && g.month) return `${MONTHS[g.month-1]} ${g.year}`;
  if(g.year) return `${g.year} · mois non noté`;
  return g.bucket;
}
/* L'intérieur d'une tuile, sans son <button> : celui-ci est réutilisé d'un
   rendu à l'autre, seul son contenu est réécrit quand le jeu a changé. */
function tileInner(x, i){
  const statut = statutDe(x);
  /* Sous le titre : le temps de jeu pour un jeu terminé, le compte à rebours
     pour un jeu convoité. Les deux ne se rencontrent jamais - un jeu de la
     wishlist n'a pas d'heures au compteur - donc une seule ligne suffit. */
  const attente = estWishlist(x) ? compteARebours(x.release) : null;
  const meta = attente
    ? `<span class="tmeta${attente.avant ? ' avant' : ''}">${esc(attente.txt)}</span>`
    : x.hours ? `<span class="tmeta">${hoursFmt(x.hours)}</span>` : '';
  /* La promotion du jour, dans le coin opposé à la pastille de statut. Le
     prix exact tient dans l'infobulle : sur une vignette de 158 px, le
     pourcentage est ce qui se lit d'un coup d'œil, pas « 23,99 € ». */
  const t = estWishlist(x) ? TARIFS[x.name] : null;
  const promo = t && t.remise > 0
    ? `<span class="tpromo" title="${esc(money(t.actuel))} au lieu de ${esc(money(t.plein))}">−${t.remise}&#8239;%</span>`
    : '';
  return `${promo}${statut
      ? `<span class="tnote ${estWishlist(x) ? 'wish' : 'encours'}">${esc(statut)}</span>`
      : `<span class="tnote" style="color:${noteColor(x.rating)}">${x.rating!==null?fr(x.rating,1):'-'}</span>`}
    ${coverTag(x, 'big', i < PRIORITAIRES)}
    <span class="tcap">
      <span class="tn">${esc(x.name)}</span>
      ${meta}
    </span>`;
}
/* pixel transparent : réaffecter src coupe net un téléchargement en cours */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/* Coupe les jaquettes encore en vol et renvoie combien. Une image déjà
   arrivée n'est pas touchée : elle ne coûte plus rien et resservira telle
   quelle. data-off dit au gestionnaire d'erreur d'ignorer le pixel - sans
   lui il prendrait l'annulation pour un échec et poserait des initiales. */
function annuleCovers(root){
  let coupees = 0;
  root.querySelectorAll('img.cov[src]').forEach(im=>{
    if(im.complete) return;
    im.dataset.off = '1';
    im.src = PIXEL;
    coupees++;
  });
  return coupees;
}

/* La tuile de ce jeu : celle qui existe déjà, ou une neuve. */
function tuilePour(cle, x, i){
  const sig = sigTuile(x);
  let el = TUILES.get(cle);
  if(!el){
    el = document.createElement('button');
    el.type = 'button';
    el.className = 'tile';
    TUILES.set(cle, el);
  }
  // refaire l'intérieur seulement si le jeu a changé, ou si sa jaquette a
  // été coupée en route pendant qu'il était hors écran
  if(el.dataset.sig !== sig || el.dataset.coupee){
    /* Le rang sert à la priorité de chargement de la jaquette. Il n'est pas
       dans la signature exprès : une tuile qui change simplement de place
       n'a pas à être refaite, et son image est de toute façon déjà là. */
    el.innerHTML = tileInner(x, i);
    delete el.dataset.coupee;
    el.dataset.sig = sig;
    /* Le liseré de note du bas de la jaquette. Posé sur la tuile et hérité
       par la case, plutôt que sur l'image : hydrateCovers() remplace
       celle-ci par une case d'initiales quand le fichier manque, et ne
       recopie pas ses styles - la variable, elle, s'hérite. */
    if(x.rating === null || x.rating === undefined) el.style.removeProperty('--note');
    else el.style.setProperty('--note', noteColor(x.rating));
    hydrateCovers(el);
  }
  el.dataset.i = i;   // le rang dans filtered(), que la fiche relit au clic
  el.dataset.id = x.id;
  return el;
}

/* Le mur est réordonné, pas reconstruit. Réécrire innerHTML coûtait deux
   fois : le navigateur rebâtissait tout, et surtout chaque jaquette
   repartait de zéro alors qu'elle était déjà là et déjà décodée. Trier,
   taper dans la recherche ou recevoir un rafraîchissement de fond ne fait
   donc plus clignoter le mur. appendChild() déplace un nœud déjà dans le
   document, il ne le recrée pas : c'est ce qui rend l'opération gratuite. */
function renderWall(){
  const out = document.getElementById('out');
  const g = filtered();

  const vues = new Set();
  const frag = document.createDocumentFragment();
  let mur = null, groupe = null;
  const nouveauMur = ()=>{
    mur = document.createElement('div');
    mur.className = 'wall';
    frag.appendChild(mur);
  };
  if(g.length && S.sort !== 'chrono') nouveauMur();

  g.forEach((x, i)=>{
    // en tri chronologique le mur est coupé par des intertitres de mois
    if(S.sort === 'chrono'){
      const nom = groupLabel(x);
      if(nom !== groupe){
        const titre = document.createElement('div');
        titre.className = 'grouphead';
        titre.textContent = nom;
        frag.appendChild(titre);
        groupe = nom;
        nouveauMur();
      }
    }
    const cle = cleTuile(x);
    vues.add(cle);
    mur.appendChild(tuilePour(cle, x, i));
  });

  /* Les jaquettes des tuiles qui quittent l'écran libèrent leur connexion,
     comme avant - le mur qui arrive en a besoin. La tuile est marquée pour
     qu'un retour à l'écran la reconstruise plutôt que d'afficher le pixel
     transparent qu'on vient de lui mettre. */
  TUILES.forEach((el, cle)=>{
    if(vues.has(cle) || el.dataset.coupee) return;
    if(annuleCovers(el)) el.dataset.coupee = '1';
  });

  if(!g.length){ out.innerHTML = emptyHTML(); return; }
  out.replaceChildren(frag);
}
/* Les tuiles des jeux qui ont quitté le classeur : sans ce ménage la Map
   enflerait à chaque relecture. Appelée quand GAMES est reconstruit. */
function oublieTuiles(){
  const vivantes = new Set(GAMES.map(cleTuile));
  TUILES.forEach((_, cle)=>{ if(!vivantes.has(cle)) TUILES.delete(cle); });
}
/* Un seul gestionnaire pour tout le mur, posé une fois : réattacher un
   onclick par tuile à chaque rendu annulerait le bénéfice de les garder.
   Le bouton de téléchargement d'une jaquette arrête la propagation de son
   côté, il ne remonte donc jamais jusqu'ici. */
document.getElementById('out').addEventListener('click', e=>{
  const t = e.target.closest('.tile');
  if(!t) return;
  if(t.dataset.i !== undefined) ouvreFiche(+t.dataset.i, t);
});

function emptyHTML(){
  if(S.q || S.range){
    return `<div class="empty"><h3>Aucun jeu trouvé...</h3>`
  }
  return `<div class="empty">
    <h3>Cet onglet est vide</h3>
  </div>`;
}

/* =======================================================================
   Découverte par similarité - wishlist seulement

   IGDB tient un champ similar_games sur chaque fiche. On lui donne
   quelques-uns des jeux qu'on a le mieux notés, il répond ce qu'il juge
   proche, et on retire ce qui est déjà au classeur.

   La section ne vit que dans l'onglet Wishlist, jamais sur le mur
   principal : le mur raconte ce qu'on a joué, et y glisser des jeux qu'on
   ne possède pas brouillerait la seule chose qu'il sait bien faire. La
   wishlist, elle, est exactement l'endroit où l'on se demande à quoi jouer
   ensuite.

   Chaque suggestion garde le jeu qui l'a amenée. « Parce que tu as mis 9,5
   à Hollow Knight » est le cœur de la fonction : sans cette phrase, ce
   n'est qu'une liste de jeux de plus.
   ======================================================================= */
/* Ces quatre-là étaient déclarés tout en haut du fichier d'un seul tenant,
   pour la même raison de disparue que les tuiles : le premier rendu venait
   avant la fin du script. Ils sont revenus auprès du code qui les lit. */
const DECOUVERTE_GRAINES = 8;
let DECOUVERTE = null;          // null = jamais demandé, [] = rien à proposer
let decouverteEnVol = false;
/* Les titres déjà proposés dans cette session. Ils partent en exclusion
   avec la demande suivante : c'est ce qui fait que « Rafraîchir » montre
   autre chose, même quand le tirage retombe sur les mêmes jeux de départ. */
const DECOUVERTE_VUS = new Set();

/* Les jeux qui servent de point de départ : tirés au sort parmi ceux notés
   8 ou plus. Au hasard et non les meilleurs, pour que la section change
   d'une visite à l'autre au lieu de ressasser les trois mêmes préférés. */
function grainesDecouverte(){
  const bons = GAMES.filter(x => !estStatut(x) && x.rating !== null && x.rating >= 8);
  const melange = bons.slice();
  for(let i = melange.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    const t = melange[i]; melange[i] = melange[j]; melange[j] = t;
  }
  return melange.slice(0, DECOUVERTE_GRAINES)
    .map(x => ({nom:x.name, sortie:x.release || '', note:x.rating}));
}

/* Un tour de demande. Ce qu'on possède ET ce qu'on a déjà proposé partent
   ensemble comme exclusions : c'est le serveur qui écarte, pour qu'il puisse
   puiser plus loin au lieu de renvoyer douze jeux dont dix seraient jetés
   ici. C'est aussi ce qui fait que « Rafraîchir » montre autre chose même
   quand le tirage retombe sur les mêmes jeux de départ. */
async function demandeDecouverte(graines){
  const data = await api('/api/decouverte', {
    jeux: graines,
    connus: GAMES.map(x => x.name).concat(Array.from(DECOUVERTE_VUS)),
  });
  return (data && data.etat === 'ok' && data.suggestions) ? data.suggestions : [];
}

async function chargeDecouverte(relance){
  if(decouverteEnVol) return;
  if(DECOUVERTE && !relance) return;      // déjà fait, sauf demande explicite
  const graines = grainesDecouverte();
  if(!graines.length){ DECOUVERTE = []; renderDecouverte(); return; }
  decouverteEnVol = true;
  DECOUVERTE = null;
  renderDecouverte();                     // affiche l'attente
  try{
    let trouve = await demandeDecouverte(graines);
    /* Rien de neuf : on a fait le tour de ce qu'IGDB rapproche de ces
       jeux-là. On oublie ce qui a déjà été montré et on repart du début,
       plutôt que de laisser la section vide après un clic explicite. */
    if(!trouve.length && DECOUVERTE_VUS.size){
      DECOUVERTE_VUS.clear();
      trouve = await demandeDecouverte(graines);
    }
    trouve.forEach(s => DECOUVERTE_VUS.add(s.titre));
    DECOUVERTE = trouve;
  }catch(e){
    DECOUVERTE = [];
  }finally{
    decouverteEnVol = false;
  }
  renderDecouverte();
}

function carteDecouverte(s, i){
  const visuel = s.apercu
    ? `<img class="deco-img" src="${esc(s.apercu)}" alt="" loading="lazy" decoding="async">`
    : `<span class="deco-img deco-nue">${esc(initials(s.titre))}</span>`;
  const note = (s.note === null || s.note === undefined) ? '' : fr(s.note, 1);
  return `<article class="deco-carte">
    <a class="deco-lien" href="${esc(s.lien || '#')}" target="_blank" rel="noopener"
       aria-label="Voir ${esc(s.titre)} sur IGDB">${visuel}</a>
    <div class="deco-corps">
      <b class="deco-nom">${esc(s.titre)}</b>
      <i class="deco-date">${esc(s.date || 'date inconnue')}</i>
      <span class="deco-parce">Parce que tu as mis
        <b>${esc(note)}</b> à ${esc(s.parce_que)}</span>
      <button class="deco-plus" type="button" data-i="${i}">+ Wishlist</button>
    </div>
  </article>`;
}

/* Y a-t-il seulement de quoi suggérer ? Sans un jeu noté 8 ou plus, la
   section n'a rien sur quoi s'appuyer et ne s'affiche pas du tout. */
function aDesGraines(){
  return GAMES.some(x => !estStatut(x) && x.rating !== null && x.rating >= 8);
}

function renderDecouverte(){
  const hote = document.getElementById('deco');
  if(!hote) return;
  /* Chez quelqu'un d'autre, la section n'a pas lieu d'être : ses cartes
     disent « parce que TU as mis 9 à ... » en parlant des notes de l'autre,
     et leur bouton ajoute à MA wishlist depuis une page qui montre la
     sienne. On vient y lire un classeur, pas se faire conseiller sur le
     sien. */
  if(!estWishlistNom(S.bucket) || !estMonJournal() || !aDesGraines()){
    hote.hidden = true; hote.innerHTML = '';
    return;
  }
  /* L'en-tête et son bouton restent en place dans tous les cas : c'est ce
     qui permet de relancer même quand la dernière tentative n'a rien donné,
     et ça évite que la section saute d'une hauteur à l'autre. */
  const corps = decouverteEnVol
    ? `<p class="deco-note"></p>`
    : !DECOUVERTE ? ''
    : DECOUVERTE.length
      ? `<div class="deco-grille">${DECOUVERTE.map(carteDecouverte).join('')}</div>`
      : `<p class="deco-note">Rien de plus à proposer pour l'instant - retente un tirage.</p>`;

  hote.hidden = false;
  hote.innerHTML = `<div class="deco-tete">
      <h2 class="deco-titre">Découvertes</h2>
      <button class="deco-neuf" type="button" id="decoNeuf"${decouverteEnVol ? ' disabled' : ''}
        >${decouverteEnVol ? 'Recherche...' : 'Rafraîchir'}</button>
    </div>${corps}`;

  const neuf = document.getElementById('decoNeuf');
  if(neuf) neuf.onclick = ()=> chargeDecouverte(true);
  hote.querySelectorAll('.deco-plus').forEach(b=>{
    b.onclick = ()=> ajouteWishlist(+b.dataset.i, b);
  });
}

/* Ajout en un clic : la même écriture que le formulaire, avec le nom, la
   date de sortie et rien d'autre - un jeu convoité n'a ni note, ni temps de
   jeu, ni prix payé. La jaquette suit dans la foulée, puisqu'IGDB vient de
   nous dire laquelle c'est. */
async function ajouteWishlist(i, btn){
  const s = DECOUVERTE && DECOUVERTE[i];
  if(!s) return;
  if(!CAN_WRITE){ toast('Passe en mode éditeur pour ajouter un jeu.', true); return; }
  const cible = ongletWishlist();

  btn.disabled = true;
  const texte = btn.textContent;
  btn.textContent = 'Ajout...';

  /* Le prix de base, par le même chemin que le formulaire : la suggestion
     porte déjà son identifiant IGDB, qui donne le lien Steam, qui donne le
     tarif. Demandé au clic et pas dans la liste des suggestions - les faire
     toutes aurait coûté deux appels par jeu pour un prix qu'on n'utilise
     qu'une fois sur douze.

     Un échec ne bloque rien : « pas sur Steam » est une réponse, pas une
     panne, et la case reste vide plutôt que de recevoir un chiffre inventé. */
  let base = null;
  try{
    const p = await api('/api/jeu/prix', {id: s.id});
    if(p && p.etat === 'ok' && p.prix !== null && p.prix !== undefined) base = p.prix;
  }catch(e){}

  try{
    const data = await envoyer('POST', '/api/journal/jeu', {
      periode: cible, review: '',
      values: {
        name: s.titre, rating: null, month: null, hours: null,
        base: base, paid: null, release: s.iso || null, id_igdb: s.id || null,
      },
    });
    cacheStore.set(source().url, data);
    applyData(data, true);
    // il est au classeur : il n'a plus rien à faire dans les suggestions
    DECOUVERTE = DECOUVERTE.filter((_, k) => k !== i);
    render();
    toast(`« ${s.titre} » ajouté à la wishlist`);
    if(s.image) poseJaquetteChoisie(s.titre, s.image, s.id);
  }catch(e){
    toast('Ajout impossible - ' + (e.message || 'erreur inconnue'), true);
    btn.disabled = false; btn.textContent = texte;
  }
}
