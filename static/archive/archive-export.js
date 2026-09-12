/* =======================================================================
   Archive Jeux Vidéos - archive-export.js

   Sortir un jeu de la page : export, fiche détaillée, captures.

   L'export JSON/CSV du journal, la fenêtre « Voir plus d'informations »
   (description, captures, bande-annonce, temps pour finir) et le zoom sur
   une capture.

   Chargé par templates/archive/archive.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */


/* =======================================================================
   Export du journal
   Tout est déjà en mémoire (GAMES) : pas de requête, juste mettre en
   forme et déclencher un téléchargement. Disponible pour n'importe quel
   journal affiché, comme le bilan en image - c'est déjà ce qu'on regarde,
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
   catégories - un retour immédiat, plutôt que de le découvrir dans le
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
/* L'export appartient au journal : il met en forme GAMES, que la page
   Social n'a pas. Ce fichier y est pourtant chargé, pour la fenêtre « Voir
   plus d'informations » qu'ouvre la recherche - d'où ce test plutôt qu'un
   faux bouton caché dans le balisage de l'autre page. */
if($('exportBtn')){
  fermeSurFond('export', fermerExport);
  $('exportBtn').addEventListener('click', ouvrirExport);
}

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
   retour à la ligne - l'avis tient sur plusieurs lignes, entre autres. */
/* Excel et LibreOffice lisent une cellule qui commence par =, +, - ou @
   comme une FORMULE et non comme du texte : un titre de jeu venant d'IGDB
   traversait l'export sans filtre et s'exécutait à l'ouverture. Une
   apostrophe devant neutralise le tableur, et n'apparaît pas dans la
   cellule affichée.
   Les nombres en sont exemptés : préfixer -5 le rendrait illisible comme
   nombre, et un nombre ne peut de toute façon pas être une formule. */
function celluleCSV(v){
  if(v === null || v === undefined) return '';
  let s = String(v);
  if(typeof v !== 'number' && /^[=+\-@]/.test(s)) s = "'" + s;
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
      <!-- Une infobulle sur le titre, parce qu'il se coupe quand il est trop
           long pour la ligne (voir .detail-sheet .fhead) : le survol rend le
           reste, et l'aria-label de la fenetre le donne entier a la voix. -->
      <span class="grp"><b class="fhead" title="${esc(g.name)}">${esc(g.name)}</b></span>
      <!-- Les deux actions, sur la ligne du titre : c'est le jeu qu'elles
           concernent, et le titre est ce qui le nomme. Plus bas, elles
           auraient flotté au-dessus d'une description qui ne parle pas
           d'elles. Remplies par peintDetail() quand la fiche a répondu -
           avant, on ne sait pas encore si le jeu existe. -->
      <span class="grp detail-actions" id="detailActions"></span>
      <span class="grp"><button class="sbtn detail-x" aria-label="Fermer">×</button></span>
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
async function ouvreLaFiche(nom, demande, idIgdb){
  const host = $('detail');
  /* L'identifiant IGDB voyage avec le nom depuis que la fiche porte deux
     actions : « Avis des joueurs », qui rassemble les journaux sur ce
     jeu-la, et « + Wishlist », qui l'ecrit dans le mien. Les deux le
     veulent, et la reponse du serveur ne le rend pas -- elle decrit le jeu,
     elle ne le nomme pas. */
  const g = {name: nom, idIgdb: idIgdb || null};
  host.innerHTML = detailHTML(g);
  host.hidden = false;
  auPremierPlan(host);      // elle peut s'ouvrir depuis les avis, ou l'inverse
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
  }, g.idIgdb);
}

/* Un jeu qu'on ne poss\u00E8de pas, d\u00E9sign\u00E9 par sa fiche IGDB : il n'y a rien
   en base sur quoi retomber, tout vient d'IGDB. Le nom part quand m\u00EAme,
   parce que HowLongToBeat ne conna\u00EEt pas les identifiants IGDB et ne sait
   chercher que par titre. */
function ouvrirDetailIgdb(id, nom){
  return ouvreLaFiche(nom, ()=> api('/api/jeu/detail', {id: id, nom: nom}), id);
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
/* ---------- les deux actions de la fiche ----------
   La fiche ne faisait que raconter le jeu. Elle est pourtant l'endroit ou
   l'on decide : c'est la qu'on lit la description, les temps pour finir et
   la note critique, donc la qu'on se dit « celui-la, je le veux » ou « et
   les autres, ils en ont pense quoi ? ».

   Les deux chemins existaient deja ailleurs -- le bouton sous la jaquette
   d'une fiche du mur, et le « + Wishlist » des suggestions de decouverte.
   Ils sont simplement branches ici. */
const ICONE_AVIS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>`;

function detailActionsHTML(){
  /* Le bouton wishlist part caché : savoir si le jeu est déjà chez nous
     demande de lire notre journal, ce qui n'arrive pas dans la même
     milliseconde. Il apparaît ensuite s'il a lieu d'être - plutôt que de
     s'afficher puis de disparaître sous les doigts. */
  return `<button type="button" class="detail-act" id="detailAvis"
      >${ICONE_AVIS}<span>Avis des joueurs</span></button>
    <button type="button" class="detail-act detail-wish" id="detailWish" hidden
      ><span>+ Wishlist</span></button>`;
}

/* ---------- ce que j'ai déjà ----------
   Les jeux de MON journal, où qu'ils soient rangés : terminés, en cours ou
   convoités. Sert à ne pas proposer d'ajouter à la wishlist un jeu qu'on a
   fini il y a trois ans, ou qui y est déjà.

   Lu une seule fois, et seulement si l'on ouvre une fiche. Sur son propre
   journal il n'y a même rien à demander : GAMES est déjà la réponse, et
   c'est le cas le plus fréquent.

   Deux clés, parce que deux journaux n'écrivent pas un titre pareil :
   l'identifiant IGDB quand il existe - il ne se discute pas - et le titre
   réduit à son slug sinon. Même règle que la page « Avis ». */
let MES_JEUX = null;

function indexeMesJeux(jeux){
  const noms = new Set(), ids = new Set();
  (jeux || []).forEach(j=>{
    if(j.name) noms.add(slug(j.name));
    if(j.idIgdb) ids.add(String(j.idIgdb));
  });
  return {noms: noms, ids: ids};
}

async function mesJeux(){
  if(MES_JEUX) return MES_JEUX;
  // mon journal est celui qu'on regarde : rien à demander
  if(typeof CAN_WRITE !== 'undefined' && CAN_WRITE && typeof GAMES !== 'undefined'){
    return (MES_JEUX = indexeMesJeux(GAMES));
  }
  if(!MOI.pseudo) return (MES_JEUX = indexeMesJeux([]));
  try{
    const r = await fetch('/api/journal/' + encodeURIComponent(MOI.pseudo),
                          {credentials: 'same-origin'});
    const d = await r.json();
    return (MES_JEUX = indexeMesJeux(d.jeux));
  }catch(e){
    // pas mis en cache : un réseau qui a hoqueté ne doit pas cacher le
    // bouton pour le reste de la visite
    return indexeMesJeux([]);
  }
}

function dejaChezMoi(index, nom, idIgdb){
  if(idIgdb && index.ids.has(String(idIgdb))) return true;
  return index.noms.has(slug(nom || ''));
}

/* Ajouter a MA wishlist, depuis n'importe quelle page qui ouvre cette
   fenetre - le mur, la recherche, une discussion du Social.

   Il n'y a donc ni CAN_WRITE ni classeur affiche sur quoi s'appuyer : le
   serveur est seul juge, et c'est lui qui repond « connecte-toi » quand il
   le faut. C'est aussi plus juste - on peut ajouter a sa wishlist depuis le
   journal de quelqu'un d'autre, ce que la regle du mode editeur interdisait
   pour de mauvaises raisons.

   Le prix de base suit le meme chemin que dans les suggestions : la fiche
   IGDB donne le lien Steam, qui donne le tarif. Un echec ne bloque rien --
   « pas sur Steam » est une reponse, pas une panne. */
async function ajouteALaWishlist(g, data, btn){
  const avant = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Ajout…</span>';

  let base = null;
  if(g.idIgdb){
    try{
      const p = await api('/api/jeu/prix', {id: g.idIgdb});
      if(p && p.etat === 'ok' && p.prix !== null && p.prix !== undefined) base = p.prix;
    }catch(e){}
  }
  try{
    /* socialAppel plutot que envoyer() : celui-ci exige le mode editeur sur
       le journal affiche, et cette fenetre s'ouvre aussi la ou il n'y a
       aucun journal affiche. Il vit dans archive-social.js, que les deux
       pages chargent - et il rapporte le message du serveur, qui est
       precisement ce qu'on veut montrer ici. */
    const rep = await socialAppel('/api/journal/jeu', 'POST', {
      periode: ongletWishlist(), review: '',
      values: {
        name: g.name, rating: null, month: null, hours: null,
        base: base, paid: null, release: (data && data.iso) || null,
        id_igdb: g.idIgdb || null,
      },
    });
    btn.hidden = true;
    /* Il est chez moi maintenant : l'index doit le savoir, sans quoi
       rouvrir la fiche reproposerait de l'ajouter une seconde fois. */
    if(MES_JEUX){
      MES_JEUX.noms.add(slug(g.name || ''));
      if(g.idIgdb) MES_JEUX.ids.add(String(g.idIgdb));
    }
    toast(`« ${g.name} » ajouté à la wishlist`);
    /* C'est MON journal qui vient de changer. S'il est justement celui qu'on
       regarde, le serveur vient de le relire en entier : on le remplace,
       plutot que de laisser un mur qui ne connait pas encore ce jeu. */
    if(typeof CAN_WRITE !== 'undefined' && CAN_WRITE && typeof applyData === 'function'){
      cacheStore.set(source().url, rep);
      applyData(rep, true);
      render();
    }
  }catch(e){
    btn.disabled = false; btn.innerHTML = avant;
    toast('Ajout impossible - ' + (e.message || 'erreur inconnue'), true);
  }
}

/* Les deux boutons de la ligne du titre, une fois la fiche revenue.

   Ils vivent dans la barre d'outils, hors de `zone` : celle-ci est réécrite
   à chaque jeu, eux non - d'où leur propre hôte, et leur propre câblage. */
function brancheActions(g, data){
  const hote = $('detailActions');
  if(!hote) return;
  hote.innerHTML = detailActionsHTML();
  /* Les avis des autres sur ce jeu : la même fenêtre que le bouton sous la
     jaquette d'une fiche du mur (voir ouvrirAvisSocial dans
     archive-social.js), chargée par les deux pages. */
  hote.querySelector('#detailAvis').onclick = ()=> ouvrirAvisSocial(g.name, g.idIgdb);
  const wish = hote.querySelector('#detailWish');
  wish.onclick = ()=> ajouteALaWishlist(g, data, wish);
  /* Un jeu qu'on a déjà n'a rien à faire dans une wishlist. Le bouton ne se
     grise pas, il s'en va : une action impossible qu'on laisse à l'écran
     invite à cliquer pour découvrir qu'elle ne sert à rien. */
  mesJeux().then(index=>{
    if(!$('detailActions') || hote.querySelector('#detailWish') !== wish) return;
    wish.hidden = dejaChezMoi(index, g.name, g.idIgdb);
  });
}

function peintDetail(data, g){
  const zone = document.querySelector('#detail .detail-in');
  if(!zone) return;
  /* Avant les refus qui suivent, et c'est voulu : ni les avis des joueurs
     ni la wishlist ne dépendent d'IGDB. Un jeu qu'IGDB ne connaît pas peut
     très bien avoir été terminé par trois personnes d'ici, et on doit
     pouvoir le convoiter quand même. */
  brancheActions(g, data);
  if(!data.ok){
    zone.innerHTML = `<p class="detail-etat">Informations injoignables : ${
      esc(data.message || data.raison || 'pas de r\u00E9ponse')}</p>`;
    return;
  }
  const hltb = data.hltb || null;
  const rien = !data.date && !data.plateforme && !data.developpeur && !data.genres
    && !data.themes && !data.description
    && !(data.images || []).length && !data.trailer && !hltb
    && (data.note_critique === null || data.note_critique === undefined);
  if(rien){
    zone.innerHTML = `<p class="detail-etat">Aucune information trouv\u00E9e pour ce jeu.</p>`;
    return;
  }

  const faits = [
    /* La sortie en premier : c'est ce qui situe un jeu avant tout le reste.
       « Un Zelda de 1998 » et « un Zelda de 2023 » ne se lisent pas pareil,
       et la fiche racontait tout -- le studio, les genres, les temps pour
       finir -- sans jamais dire de quand il datait.
       `date` vient d'IGDB deja mise en francais (voir _date_fr dans
       jaquettes.py) : la page n'a pas a savoir compter en secondes UTC. */
    data.date        ? detailFaitHTML('Sortie',       data.date)        : '',
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
/* Le meme chevron que les fleches de la fiche du mur (voir CHEVRON dans
   archive-fiche.js) : les deux gestes sont le meme geste, ils doivent porter
   le meme dessin. Recopie plutot que partagee parce que le Social ne charge
   pas archive-fiche.js -- et ce fichier-ci doit tenir debout tout seul. */
const CHEVRON_ZOOM = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="${d}"/></svg>`;

function ouvrirZoom(images, i){
  if(!images || !images.length) return;
  ZOOM.images = images;
  ZOOM.i = Math.max(0, Math.min(i || 0, images.length - 1));
  const host = $('zoom');
  /* Les fleches encadrent la capture au lieu d'etre posees dessus, comme
     celles de la fiche du mur : elles ne parlent pas de l'image qu'on
     regarde mais de celles d'a cote. Elles sont donc voisines de la boite
     et non dedans -- d'ou les querySelector sur `host` plus bas.
     `zoom-multi` sur le fond dit a la feuille de style de leur reserver la
     place ; une capture seule n'a pas de fleches et garde toute la largeur. */
  const plusieurs = images.length > 1;
  host.classList.toggle('zoom-multi', plusieurs);
  host.innerHTML = `${plusieurs ? `<button class="sheet-nav nav-prev zoom-prev"
        aria-label="Capture précédente">${CHEVRON_ZOOM('M15 5l-7 7 7 7')}</button>` : ''}
    <div class="zoom-boite" role="dialog" aria-modal="true" aria-label="Capture d'écran">
      <img id="zoomImg" alt="">
      <button class="sbtn zoom-x" aria-label="Fermer">×</button>
      ${plusieurs ? `<span class="zoom-rang"></span>` : ''}
    </div>
    ${plusieurs ? `<button class="sheet-nav nav-next zoom-next"
      aria-label="Capture suivante">${CHEVRON_ZOOM('M9 5l7 7-7 7')}</button>` : ''}`;
  host.hidden = false;
  auPremierPlan(host);      // la fiche qui l'ouvre peut être passée devant
  verrouFond();
  host.querySelector('.zoom-x').onclick = fermerZoom;
  const prev = host.querySelector('.zoom-prev'), next = host.querySelector('.zoom-next');
  if(prev) prev.onclick = ()=> zoomBouge(-1);
  if(next) next.onclick = ()=> zoomBouge(1);
  /* Une galerie d'images plein écran est l'endroit où le doigt s'attend le
     plus à être écouté. À gauche la suivante, comme les flèches ; vers le
     bas, on repose la capture - cette fenêtre-là n'a pas de poignée à
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

/* ---------- les fleches, d'une capture a la suivante ----------
   Echap n'est plus ici : les deux fenetres de ce fichier se sont inscrites
   par fermeSurFond, et c'est archive-noyau.js qui ferme celle du dessus
   (voir FERMETURES). Ce qu'il y avait a la place - « si le zoom est
   ouvert..., sinon si le detail... » - etait la meme cascade a tenir a la
   main que dans archive-fiche.js, et par les deux bouts.

   Restent les fleches, et seulement quand c'est bien la capture en grand
   qu'on regarde : `estDuDessus` pose la meme question que la fiche du mur
   pose pour elle-meme, et c'est ce qui les empeche de compter double la ou
   les deux fichiers sont charges. */
document.addEventListener('keydown', e=>{
  if(e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if(!estDuDessus('zoom')) return;
  zoomBouge(e.key === 'ArrowLeft' ? -1 : 1);
});
