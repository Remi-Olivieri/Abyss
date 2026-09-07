/* =======================================================================
   Archive Jeux Vidéos — archive-export.js

   Sortir un jeu de la page : export, fiche détaillée, captures.

   L'export JSON/CSV du journal, la fenêtre « Voir plus d'informations »
   (description, captures, bande-annonce, temps pour finir) et le zoom sur
   une capture.

   Chargé par templates/jeux-videos.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */


/* =======================================================================
   Export du journal
   Tout est déjà en mémoire (GAMES) : pas de requête, juste mettre en
   forme et déclencher un téléchargement. Disponible pour n'importe quel
   journal affiché, comme le bilan en image — c'est déjà ce qu'on regarde,
   pas besoin d'en être le propriétaire pour en garder une copie.
   Nom et catégorie partent toujours ; le reste se choisit dans la fenêtre.
   ======================================================================= */
function telecharge(contenu, type, nom){
  const blob = new Blob([contenu], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nom; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // laisse le temps au téléchargement de démarrer avant de libérer l'URL
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}
const CHAMPS_EXPORT = [
  ['rating', 'Note'], ['hours', 'Temps de jeu'], ['base', 'Prix de base'],
  ['paid', 'Prix payé'], ['release', 'Date de sortie'], ['month', 'Mois'],
  ['review', 'Avis'],
];
function exportHTML(){
  const categories = BUCKETS.map(b =>
    `<label class="fld fcheck"><input type="checkbox" value="${esc(b)}" checked><span>${esc(b)}</span></label>`
  ).join('');
  const champs = CHAMPS_EXPORT.map(([k,l]) =>
    `<label class="fld fcheck"><input type="checkbox" value="${k}" checked><span>${esc(l)}</span></label>`
  ).join('');
  return `<div class="sheet export-sheet" role="dialog" aria-modal="true" aria-label="Exporter le journal">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">Exporter le journal</b></span>
      <span class="grp"><button class="sbtn export-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="export-in">
      <div class="export-format" role="group" aria-label="Format du fichier">
        <button type="button" class="export-format-btn on" data-format="json">JSON</button>
        <button type="button" class="export-format-btn" data-format="csv">CSV</button>
      </div>
      <div class="export-section">
        <div class="export-section-head">
          <span class="export-section-title">Années</span>
        </div>
        <div class="export-grid" id="exportCategories">${categories}</div>
      </div>
      <div class="export-section">
        <div class="export-section-head">
          <span class="export-section-title">Données</span>
          <span class="export-hint">nom et catégorie toujours inclus</span>
        </div>
        <div class="export-grid" id="exportChamps">${champs}</div>
      </div>
      <p class="export-info" id="exportInfo"></p>
      <div class="frow">
        <span class="spacer"></span>
        <button class="ghost" id="export-annuler">Annuler</button>
        <button class="cta auto" id="export-go">Exporter</button>
      </div>
    </div>
  </div>`;
}
/* Le nombre de jeux qui partiraient avec la sélection actuelle des
   catégories — un retour immédiat, plutôt que de le découvrir dans le
   fichier téléchargé. */
function majExportInfo(){
  const host = $('export');
  const categories = new Set(Array.from(host.querySelectorAll('#exportCategories input:checked'))
    .map(c => c.value));
  const n = GAMES.filter(g => categories.has(g.bucket)).length;
  $('exportInfo').innerHTML = `<b>${n}</b> jeu${n>1?'x':''} avec cette sélection`;
}
function ouvrirExport(){
  closeMenu();
  if(!GAMES.length){ toast('Ce journal est vide : rien à exporter.', true); return; }
  const host = $('export');
  host.innerHTML = exportHTML();
  host.hidden = false;
  verrouFond();
  host.querySelector('.export-x').onclick = fermerExport;
  $('export-annuler').onclick = fermerExport;
  $('export-go').onclick = lancerExport;
  host.querySelectorAll('.export-format-btn').forEach(b => b.onclick = ()=>{
    host.querySelectorAll('.export-format-btn').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
  });
  host.querySelectorAll('#exportCategories input').forEach(c => c.addEventListener('change', majExportInfo));
  majExportInfo();
}
function fermerExport(){
  const host = $('export');
  if(host.hidden) return;
  host.hidden = true; host.innerHTML = '';
  verrouFond();
}
fermeSurFond('export', fermerExport);
$('exportBtn').addEventListener('click', ouvrirExport);

function lancerExport(){
  const host = $('export');
  const format = host.querySelector('.export-format-btn.on').dataset.format;
  const categories = new Set(Array.from(host.querySelectorAll('#exportCategories input:checked'))
    .map(c => c.value));
  const champs = Array.from(host.querySelectorAll('#exportChamps input:checked')).map(c => c.value);
  const jeux = GAMES.filter(g => categories.has(g.bucket));
  if(!jeux.length){ toast('Aucune catégorie choisie : rien à exporter.', true); return; }
  if(format === 'json') exporteJSON(jeux, champs);
  else exporteCSV(jeux, champs);
  fermerExport();
}
function exporteJSON(jeux, champs){
  const colonnes = ['id','bucket','name', ...champs];
  const sortie = jeux.map(g => {
    const o = {};
    colonnes.forEach(c => { o[c] = g[c]; });
    return o;
  });
  const nom = (source() && source().nom) || 'journal';
  telecharge(JSON.stringify(sortie, null, 2), 'application/json',
             `journal-${slug(nom) || 'jeux'}.json`);
}
/* Une valeur par cellule CSV : guillemets doublés, et la cellule entière
   entre guillemets dès qu'elle contient une virgule, un guillemet ou un
   retour à la ligne — l'avis tient sur plusieurs lignes, entre autres. */
function celluleCSV(v){
  if(v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const LIBELLES_EXPORT = {bucket:'onglet', name:'nom', rating:'note', month:'mois',
  hours:'heures', base:'prix_base', paid:'prix_payé', release:'sortie', review:'avis'};
function exporteCSV(jeux, champs){
  const colonnes = ['bucket','name', ...champs];
  const entetes = colonnes.map(c => LIBELLES_EXPORT[c] || c);
  const lignes = jeux.map(g => colonnes.map(c =>
    celluleCSV(c === 'review' ? g.review.join('\n') : g[c])).join(','));
  // BOM UTF-8 : sans lui, Excel lit les accents de travers en ouvrant le fichier
  const csv = '\uFEFF' + entetes.join(',') + '\n' + lignes.join('\n');
  const nom = (source() && source().nom) || 'journal';
  telecharge(csv, 'text/csv;charset=utf-8', `journal-${slug(nom) || 'jeux'}.csv`);
}

/* =======================================================================
   Voir plus d'informations
   Plateforme/d\u00E9veloppeur/genres/th\u00E8mes viennent du classeur (d\u00E9j\u00E0 en base) ; le
   reste \u2014 description, captures, bande-annonce, note critique, temps pour
   finir \u2014 est redemand\u00E9 au serveur \u00E0 chaque ouverture, jamais gard\u00E9 d'un
   jeu \u00E0 l'autre : voir /api/journal/jeu/<id>/detail c\u00F4t\u00E9 Flask.
   ======================================================================= */
let DETAIL_JETON = 0;

function detailHTML(g){
  return `<div class="sheet detail-sheet" role="dialog" aria-modal="true"
      aria-label="Plus d'informations sur ${esc(g.name)}">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">${esc(g.name)}</b></span>
      <span class="grp"><button class="sbtn detail-x" aria-label="Fermer">\u00D7</button></span>
    </div>
    <div class="detail-in" id="detailIn">
      <p class="detail-etat">Recherche des informations\u2026</p>
    </div>
  </div>`;
}

/* La fen\u00EAtre elle-m\u00EAme, ind\u00E9pendante de l'endroit d'o\u00F9 vient sa fiche :
   un jeu du classeur la demande par son identifiant \u00E0 nous, un jeu trouv\u00E9
   dans la recherche par son identifiant IGDB. Rien d'autre ne les distingue
   \u2014 m\u00EAme attente, m\u00EAme dessin, m\u00EAme peinture \u2014 donc rien d'autre n'est
   \u00E9crit deux fois. */
async function ouvreLaFiche(nom, demande){
  const host = $('detail');
  const g = {name: nom};
  host.innerHTML = detailHTML(g);
  host.hidden = false;
  verrouFond();
  host.querySelector('.detail-x').onclick = fermerDetail;

  const jeton = ++DETAIL_JETON;
  let data;
  try{
    data = await demande();
  }catch(e){
    /* raisonReseau plut\u00F4t qu'un « injoignable » fixe : un refus de d\u00E9bit
       de nginx et un c\u00E2ble d\u00E9branch\u00E9 appellent deux r\u00E9actions oppos\u00E9es. */
    data = {ok: false, message: raisonReseau(e)};
  }
  // la fen\u00EAtre a \u00E9t\u00E9 referm\u00E9e, ou un autre jeu ouvert entre-temps
  if(jeton !== DETAIL_JETON || host.hidden) return;
  peintDetail(data, g);
}

/* Un jeu du classeur : le serveur compl\u00E8te avec la plateforme, le
   d\u00E9veloppeur et les genres d\u00E9j\u00E0 en base, et sait retrouver la fiche IGDB
   par le nom quand le jeu n'y est pas encore rattach\u00E9. */
function ouvrirDetail(g){
  return ouvreLaFiche(g.name, async ()=>{
    const r = await fetch(`/api/journal/jeu/${g.id}/detail`, {credentials: 'same-origin'});
    return r.json();
  });
}

/* Un jeu qu'on ne poss\u00E8de pas, d\u00E9sign\u00E9 par sa fiche IGDB : il n'y a rien
   en base sur quoi retomber, tout vient d'IGDB. Le nom part quand m\u00EAme,
   parce que HowLongToBeat ne conna\u00EEt pas les identifiants IGDB et ne sait
   chercher que par titre. */
function ouvrirDetailIgdb(id, nom){
  return ouvreLaFiche(nom, ()=> api('/api/jeu/detail', {id: id, nom: nom}));
}

function fermerDetail(){
  const host = $('detail');
  if(host.hidden) return;
  DETAIL_JETON++;              // ce qui r\u00E9pondra apr\u00E8s nous ne sert plus
  host.hidden = true; host.innerHTML = '';
  verrouFond();
}
fermeSurFond('detail', fermerDetail);

/* Un fait par ligne, comme .facts sur la fiche elle-m\u00EAme \u2014 sauf que la
   valeur peut ici tenir sur plusieurs lignes (une longue liste de
   plateformes), d'o\u00F9 une classe \u00E0 soi plut\u00F4t que la r\u00E9utiliser telle
   quelle. */
function detailFaitHTML(u, b){
  return `<div class="detail-fait"><u>${esc(u)}</u><b>${esc(b)}</b></div>`;
}
function detailTempsHTML(libelle, heures){
  if(heures === null || heures === undefined) return '';
  return `<div class="detail-temps"><b>${fr(heures, 1)}&#8239;h</b><span>${esc(libelle)}</span></div>`;
}
function peintDetail(data, g){
  const zone = document.querySelector('#detail .detail-in');
  if(!zone) return;
  if(!data.ok){
    zone.innerHTML = `<p class="detail-etat">Informations injoignables : ${
      esc(data.message || data.raison || 'pas de r\u00E9ponse')}</p>`;
    return;
  }
  const hltb = data.hltb || null;
  const rien = !data.plateforme && !data.developpeur && !data.genres && !data.themes && !data.description
    && !(data.images || []).length && !data.trailer && !hltb
    && (data.note_critique === null || data.note_critique === undefined);
  if(rien){
    zone.innerHTML = `<p class="detail-etat">Aucune information trouv\u00E9e pour ce jeu.</p>`;
    return;
  }

  const faits = [
    data.plateforme  ? detailFaitHTML('Plateformes',  data.plateforme)  : '',
    data.developpeur ? detailFaitHTML('D\u00E9veloppeur',  data.developpeur) : '',
    data.genres      ? detailFaitHTML('Genres',       data.genres)      : '',
    data.themes      ? detailFaitHTML('Th\u00E8mes',      data.themes)      : '',
    (data.note_critique !== null && data.note_critique !== undefined)
      ? detailFaitHTML('Note critique', `${data.note_critique} / 100`) : '',
  ].join('');

  const temps = hltb ? [
    detailTempsHTML('Histoire',           hltb.histoire),
    detailTempsHTML('Histoire + annexes', hltb.extra),
    detailTempsHTML('Complet',            hltb.complet),
  ].join('') : '';

  const media = data.trailer
    ? `<div class="detail-media"><iframe src="${esc(data.trailer)}"
        title="Bande-annonce" loading="lazy" allow="encrypted-media" allowfullscreen></iframe></div>`
    : '';
  /* Chaque vignette porte l'adresse de sa version large : c'est le serveur
     qui compose les deux tailles (voir detail_complet), la page n'a pas à
     connaître la façon dont IGDB nomme ses images. */
  const galerie = (data.images || []).length
    ? `<div class="detail-galerie">${data.images.map((im, i) =>
        `<img src="${esc(im.apercu)}" data-grande="${esc(im.grande)}" data-i="${i}"
           alt="Capture ${i + 1}" loading="lazy">`).join('')}</div>`
    : '';

  /* Les liens de recherche ne vivent plus sur la fiche elle-même : ils
     n'ont d'intérêt qu'ici, où l'on est justement venu chercher plus. Celui
     de HowLongToBeat pointe sur la fiche exacte quand on l'a trouvée,
     plutôt que sur une recherche à refaire à la main. */
  const cherche = encodeURIComponent(g.name);
  const liens = [
    `<a href="https://www.google.com/search?q=${cherche}+jeu" target="_blank" rel="noopener">Chercher sur le web</a>`,
    data.lien ? `<a href="${esc(data.lien)}" target="_blank" rel="noopener">IGDB</a>` : '',
    data.steam ? `<a href="${esc(data.steam)}" target="_blank" rel="noopener">Steam</a>` : '',
    `<a href="${hltb && hltb.lien ? esc(hltb.lien) : `https://howlongtobeat.com/?q=${cherche}`}"
       target="_blank" rel="noopener">HowLongToBeat</a>`,
  ].filter(Boolean).join('');

  zone.innerHTML = `
    ${media}
    ${data.description ? `<p class="detail-desc">${esc(data.description)}</p>` : ''}
    ${faits ? `<div class="detail-faits">${faits}</div>` : ''}
    ${temps ? `<div class="detail-temps-grid"><u>Temps pour finir <span class="detail-source">HowLongToBeat</span></u>
      <div class="detail-temps-row">${temps}</div></div>` : ''}
    ${galerie}
    <div class="links">${liens}</div>`;

  // les captures s'ouvrent en grand : la bande ne sert qu'à choisir laquelle
  const vues = (data.images || []).map(im => im.grande);
  zone.querySelectorAll('.detail-galerie img').forEach(img=>{
    img.onclick = ()=> ouvrirZoom(vues, +img.dataset.i);
  });
}

/* ---------- une capture en grand ----------
   La dernière fenêtre de la pile, et la plus simple : une image, deux
   flèches, rien à charger d'autre. On garde la liste entière plutôt que
   l'image seule, pour passer de l'une à l'autre sans revenir en arrière. */
const ZOOM = {images: [], i: 0};
function ouvrirZoom(images, i){
  if(!images || !images.length) return;
  ZOOM.images = images;
  ZOOM.i = Math.max(0, Math.min(i || 0, images.length - 1));
  const host = $('zoom');
  host.innerHTML = `<div class="zoom-boite" role="dialog" aria-modal="true" aria-label="Capture d'écran">
      <img id="zoomImg" alt="">
      <button class="sbtn zoom-x" aria-label="Fermer">×</button>
      ${images.length > 1 ? `<button class="sbtn zoom-prev" aria-label="Capture précédente">‹</button>
        <button class="sbtn zoom-next" aria-label="Capture suivante">›</button>
        <span class="zoom-rang"></span>` : ''}
    </div>`;
  host.hidden = false;
  verrouFond();
  host.querySelector('.zoom-x').onclick = fermerZoom;
  const prev = host.querySelector('.zoom-prev'), next = host.querySelector('.zoom-next');
  if(prev) prev.onclick = ()=> zoomBouge(-1);
  if(next) next.onclick = ()=> zoomBouge(1);
  /* Une galerie d'images plein écran est l'endroit où le doigt s'attend le
     plus à être écouté. À gauche la suivante, comme les flèches ; vers le
     bas, on repose la capture — cette fenêtre-là n'a pas de poignée à
     tirer, elle n'est pas une feuille mais une image posée sur l'écran. */
  glissement(host.querySelector('.zoom-boite'), {
    gauche: ()=> zoomBouge(1),
    droite: ()=> zoomBouge(-1),
    bas:    fermerZoom,
  });
  peintZoom();
}
function peintZoom(){
  const img = $('zoomImg');
  if(!img) return;
  img.src = ZOOM.images[ZOOM.i];
  const rang = document.querySelector('#zoom .zoom-rang');
  if(rang) rang.textContent = `${ZOOM.i + 1} / ${ZOOM.images.length}`;
}
function zoomBouge(sens){
  if(ZOOM.images.length < 2) return;
  // on boucle : arrivé au bout, la suivante est la première
  ZOOM.i = (ZOOM.i + sens + ZOOM.images.length) % ZOOM.images.length;
  peintZoom();
}
function fermerZoom(){
  const host = $('zoom');
  if(host.hidden) return;
  host.hidden = true; host.innerHTML = '';
  verrouFond();
}
fermeSurFond('zoom', fermerZoom);
