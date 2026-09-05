/* =======================================================================
   Archive Jeux Vidéos — archive-igdb.js

   La mise à jour du journal entier depuis IGDB.

   Cinq étapes : ce qu'on veut mettre à jour, l'analyse jeu par jeu, la
   relecture de ce qui va changer, l'écriture par paquets, puis les
   jaquettes une par une.

   C'est le seul module qui écrit en masse dans le classeur, d'où sa
   prudence : rien ne part sans avoir été montré.

   Chargé par templates/jeux-videos.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */


/* =======================================================================
   Mise à jour depuis IGDB — tout le journal d'un coup

   Le classeur vieillit : une date de sortie saisie de mémoire, un prix noté
   avant une baisse, une jaquette jamais récupérée. Ce module repasse sur
   chaque ligne, demande à Flask ce qu'IGDB en dit (/api/jeu/maj), et montre
   la liste des écarts.

   Trois précautions, parce qu'écrire trois cents lignes d'un coup ne se
   rattrape pas :

     - rien n'est écrit avant la relecture. L'analyse est un rapport ;
       l'écriture est un second geste, sur les lignes cochées seulement.
     - un jeu dont le titre ne correspond pas exactement à une fiche IGDB
       arrive décoché : « Doom » trouve six jeux, on ne les départage pas
       à l'aveugle.
     - les jaquettes se choisissent une par une, comme ailleurs dans la
       page. Aucune image ne part sur le disque sans un clic.

   L'écriture repasse par l'action « enregistrer » d'Apps Script, celle du
   formulaire : la ligne est réécrite en entier, avec les valeurs relues
   ici. C'est le chemin déjà éprouvé — modifier un jeu à la main fait
   exactement la même chose — plutôt qu'une action neuve qui écrirait deux
   cellules mais qu'il faudrait déboguer sur trois cents lignes.
   ======================================================================= */
const IGD = {
  jeton: 0,        // incrémenté à l'annulation : les boucles en vol s'arrêtent
  stop: false,     // « Interrompre » : on s'arrête mais on garde le résultat
  etape: '',
  liste: [],       // les jeux à interroger
  lignes: [],      // un rapport par jeu, une fois l'analyse finie
  file: [],        // les jaquettes à proposer, une par nom de fichier
  fi: 0,
  t0: 0,
  dernier: null,   // dernière réponse d'écriture : le classeur relu
  compte: {dates:0, prix:0, jaquettes:0, detail:0, echecs:0},
  echecs: [],
  opts: {dates:true, prix:true, jaquettes:true, detail:true},
};

const SURETE = {
  sure:     'sûr',
  probable: 'plusieurs fiches',
  douteuse: 'à vérifier',
};

function igdbCorps(){ return $('igdbIn'); }
function igdbEntete(txt){ const b = $('igdbTitre'); if(b) b.textContent = txt; }

function ouvrirIgdb(){
  closeMenu();
  if(!CAN_WRITE){ toast("Passe en mode éditeur pour mettre le journal à jour.", true); return; }
  if(!GAMES.length){ toast("Le journal est vide : rien à mettre à jour.", true); return; }
  IGD.jeton++;
  IGD.stop = false;
  // le script a pu être redéployé depuis la dernière fois : on lui laisse
  // sa chance à chaque ouverture plutôt qu'une seule fois par onglet
  IGD.lignes = []; IGD.file = []; IGD.fi = 0; IGD.dernier = null;
  IGD.compte = {dates:0, prix:0, jaquettes:0, echecs:0};
  IGD.echecs = [];
  const host = $('igdb');
  host.innerHTML = `<div class="sheet igdb-sheet" role="dialog" aria-modal="true" aria-label="Mise à jour depuis IGDB">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead" id="igdbTitre">Mise à jour depuis IGDB</b></span>
      <span class="grp"><button class="sbtn igdb-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="igdb-in" id="igdbIn"></div>
  </div>`;
  host.hidden = false;
  verrouFond();
  host.querySelector('.igdb-x').onclick = fermerIgdb;
  igdbReglages();
}
function fermerIgdb(){
  const host = $('igdb');
  if(host.hidden) return;
  IGD.jeton++;                  // ce qui répondra après nous ne sert plus
  host.hidden = true; host.innerHTML = '';
  verrouFond();
  /* des écritures ont pu passer avant l'interruption : le classeur relu
     qu'elles ont renvoyé est plus à jour que ce que le mur affiche */
  if(IGD.dernier){
    const s = source();
    if(s) cacheStore.set(s.url, IGD.dernier);
    applyData(IGD.dernier, true);
    IGD.dernier = null;
    render();
  }
}

/* ---------- étape 1 : ce qu'on veut mettre à jour ---------- */
/* Toutes les portées possibles : le journal entier, puis chaque onglet qui
   contient quelque chose. La liste est la même où qu'on ouvre la fenêtre —
   avant, seul l'onglet affiché était proposé, si bien que mettre à jour
   « 2024 » obligeait à aller s'y placer d'abord, alors que c'est
   précisément une opération qu'on lance de loin, depuis n'importe où.

   L'onglet courant reste préselectionné : la commodité d'avant est gardée,
   elle n'est simplement plus la seule option. */
function igdbPortees(){
  const portees = [{nom: 'Tout le journal', bucket: 'all', jeux: GAMES.slice()}];
  BUCKETS.forEach(b=>{
    const jeux = GAMES.filter(x => x.bucket === b);
    if(jeux.length) portees.push({nom: `Onglet « ${b} »`, bucket: b, jeux: jeux});
  });
  return portees;
}
function igdbReglages(){
  IGD.etape = 'reglages';
  igdbEntete('Mise à jour depuis IGDB');
  const portees = igdbPortees();
  igdbCorps().innerHTML = `
    <div class="fgrid">
      <label class="fld full"><u>Années</u>
        <select id="igdb_portee">${portees.map((p,i)=>
          `<option value="${i}"${p.bucket === S.bucket ? ' selected' : ''}>${esc(p.nom)} — ${p.jeux.length} jeu${p.jeux.length > 1 ? 'x' : ''}</option>`
        ).join('')}</select></label>
      <label class="fld fcheck">
        <input id="igdb_dates" type="checkbox"${IGD.opts.dates ? ' checked' : ''}>
        <span>Dates de sortie</span></label>
      <label class="fld fcheck">
        <input id="igdb_prix" type="checkbox"${IGD.opts.prix ? ' checked' : ''}>
        <span>Prix de base</span></label>
      <label class="fld fcheck">
        <input id="igdb_jaq" type="checkbox"${IGD.opts.jaquettes ? ' checked' : ''}>
        <span>Jaquettes manquantes</span></label>
      <label class="fld fcheck">
        <input id="igdb_detail" type="checkbox"${IGD.opts.detail ? ' checked' : ''}>
        <span>Plateforme, développeur, genres</span></label>
    </div>
    <div class="frow"><span class="spacer"></span>
      <button class="ghost" id="igdb_annuler">Annuler</button>
      <button class="cta auto" id="igdb_go">Analyser</button></div>`;
  $('igdb_annuler').onclick = fermerIgdb;
  $('igdb_go').onclick = ()=>{
    IGD.opts = {
      dates: $('igdb_dates').checked,
      prix: $('igdb_prix').checked,
      jaquettes: $('igdb_jaq').checked,
      detail: $('igdb_detail').checked,
    };
    if(!IGD.opts.dates && !IGD.opts.prix && !IGD.opts.jaquettes && !IGD.opts.detail){
      toast("Coche au moins une chose à mettre à jour.", true);
      return;
    }
    const p = portees[+$('igdb_portee').value] || portees[0];
    IGD.liste = p.jeux.slice();
    igdbAnalyse();
  };
}

/* ---------- la jauge, commune à l'analyse et à l'écriture ---------- */
function igdbJauge(){
  return `<div class="igdb-jauge"><i id="igdb_barre" style="width:0%"></i></div>
    <p class="igdb-encours">
      <b id="igdb_compteur">0 / 0</b>
      <span id="igdb_quoi"></span>
      <em id="igdb_reste"></em>
    </p>`;
}
/* Le temps restant, à partir de ce qui est déjà passé. Sous deux jeux la
   moyenne ne veut rien dire, et sous cinq secondes l'annoncer est plus
   agité qu'utile. */
function igdbReste(fait, total){
  if(!IGD.t0 || fait < 2) return '';
  const s = Math.round((Date.now() - IGD.t0) / fait * (total - fait) / 1000);
  if(s < 5) return '';
  return s < 90 ? `environ ${s} s` : `environ ${Math.round(s / 60)} min`;
}
function igdbAvance(fait, total, quoi){
  const barre = $('igdb_barre'), compteur = $('igdb_compteur');
  if(!barre || !compteur) return;
  barre.style.width = (total ? Math.round(fait / total * 100) : 100) + '%';
  compteur.textContent = `${fait} / ${total}`;
  $('igdb_quoi').textContent = quoi || '';
  $('igdb_reste').textContent = igdbReste(fait, total);
}

/* ---------- étape 2 : l'analyse ---------- */
async function igdbAnalyse(){
  const jeton = ++IGD.jeton;
  IGD.etape = 'analyse';
  IGD.stop = false;
  IGD.lignes = [];
  IGD.t0 = Date.now();
  igdbEntete('Analyse en cours');
  igdbCorps().innerHTML = `
    ${igdbJauge()}
    <div class="frow"><span class="spacer"></span>
      <button class="ghost" id="igdb_stop">Interrompre</button></div>`;
  $('igdb_stop').onclick = ()=>{ IGD.stop = true; };

  const total = IGD.liste.length;
  for(let i = 0; i < total; i++){
    if(jeton !== IGD.jeton) return;      // la fenêtre a été fermée
    if(IGD.stop) break;                  // interrompu : on garde ce qu'on a
    const g = IGD.liste[i];
    igdbAvance(i, total, g.name);
    let data;
    try{
      data = await apiPatient('/api/jeu/maj', {
        nom: g.name,
        sortie: g.release || '',
        prix: IGD.opts.prix,
        detail: IGD.opts.detail,
        // Flask attend un mot, pas un booléen : « aucune » lui évite de
        // rassembler des propositions dont personne ne veut
        jaquettes: IGD.opts.jaquettes ? 'manquantes' : 'aucune',
      });
    }catch(e){
      data = {etat:'injoignable', raison: raisonReseau(e)};
    }
    if(jeton !== IGD.jeton) return;
    IGD.lignes.push(igdbRapport(g, data));
  }
  if(jeton !== IGD.jeton) return;
  igdbAvance(IGD.lignes.length, total, '');
  igdbRevue();
}

/* Ce qu'on retient d'un jeu : les écarts, et rien d'autre. Une valeur
   identique n'est pas un changement — la liste ne montrerait que du bruit. */
function igdbRapport(g, data){
  const l = {
    g: g,
    etat: data.etat || 'injoignable',
    raison: data.raison || '',
    fiche: data.fiche || null,
    surete: data.surete || '',
    jaquette: data.jaquette || '',
    propositions: data.propositions || [],
    date: null, prix: null, detail: null, coche: false,
  };
  if(l.etat !== 'ok' || !l.fiche) return l;

  if(IGD.opts.dates && l.fiche.iso && l.fiche.iso !== (g.release || '')){
    l.date = {avant: g.release || '', apres: l.fiche.iso};
  }
  if(IGD.opts.prix && data.prix !== null && data.prix !== undefined){
    const av = g.base;
    // le centime d'écart : deux flottants qui valent le même prix ne sont
    // pas forcément égaux au bit près
    if(av === null || av === undefined || Math.abs(av - data.prix) >= 0.005){
      l.prix = {avant: av, apres: data.prix};
    }
  }
  /* Le rattachement à une fiche IGDB, et les quatre colonnes qui en
     découlent. Un jeu déjà rattaché à la même fiche et déjà rempli n'est
     pas un écart : ce sont les jeux d'avant cette fonctionnalité qu'on
     cherche ici, ceux qui n'ont encore ni identifiant ni plateforme — et,
     depuis la grille de connexions du Quiz, ceux à qui il manque le thème. */
  if(IGD.opts.detail && data.detail){
    const d = data.detail;
    const change = g.idIgdb !== l.fiche.id
      || (d.plateforme || null)  !== (g.plateforme || null)
      || (d.developpeur || null) !== (g.developpeur || null)
      || (d.genres || null)      !== (g.genres || null)
      || (d.themes || null)      !== (g.themes || null);
    if(change) l.detail = d;
  }
  l.coche = igdbAChanger(l) && l.surete !== 'douteuse';
  return l;
}
/* Un jeu a quelque chose à écrire. Rassemblé ici parce que quatre endroits
   posaient la même question, et qu'en oublier un laisserait des lignes
   cochées que l'écriture n'enverrait jamais. */
function igdbAChanger(l){
  return !!(l.date || l.prix || l.detail || l.rattache);
}

/* Les jaquettes à proposer, dédoublonnées par nom de fichier : le même jeu
   rejoué dans deux onglets n'a qu'une seule image sur le disque. */
function igdbFileJaquettes(){
  if(!IGD.opts.jaquettes) return [];
  const file = [], vus = {};
  IGD.lignes.forEach(l=>{
    if(l.etat !== 'ok' || !l.propositions.length) return;
    // déjà illustré : le bouton de la tuile sert à en changer, un par un
    if(l.jaquette !== 'absente') return;
    const cle = cleJaquette(l.g);
    if(!cle || vus[cle]) return;
    vus[cle] = true;
    file.push({nom: l.g.name, jeuId: l.g.id, propositions: l.propositions});
  });
  return file;
}

/* ---------- étape 3 : la relecture ---------- */
function igdbDelta(titre, avant, apres){
  return `<span class="igdb-delta"><u>${titre}</u>
    <span class="igdb-av">${esc(avant)}</span>
    <span class="igdb-fl">→</span>
    <b class="igdb-ap">${esc(apres)}</b></span>`;
}
function igdbLigneHTML(l, i){
  const f = l.fiche;
  const meme = norm(f.titre) === norm(l.g.name);
  return `<label class="igdb-ligne">
    <input type="checkbox" data-i="${i}"${l.coche ? ' checked' : ''}>
    <span class="igdb-corps">
      <b class="igdb-nom">${esc(l.g.name)} <em>${esc(l.g.bucket)}</em></b>
      <span class="igdb-match">${meme ? '' : esc(f.titre) + ' · '}${esc(f.date || 'date inconnue')} <i
        class="igdb-tag ${l.surete}">${esc(SURETE[l.surete] || '')}</i></span>
      ${l.date ? igdbDelta('Date', l.date.avant ? dateFmt(l.date.avant) : 'aucune', dateFmt(l.date.apres)) : ''}
      ${l.prix ? igdbDelta('Prix', money(l.prix.avant), money(l.prix.apres)) : ''}
      ${l.detail ? `<span class="igdb-delta"><u>Fiche</u>
        <b class="igdb-ap">${esc([l.detail.developpeur, l.detail.genres, l.detail.themes].filter(Boolean).join(' · ') || 'plateforme, genres et thèmes')}</b></span>` : ''}
    </span>
    ${l.surete === 'sure' ? '' :
      `<button type="button" class="igdb-fiche-btn" data-corr="${i}">Changer de jeu</button>`}
  </label>`;
}
function igdbRevue(){
  IGD.etape = 'revue';
  IGD.file = igdbFileJaquettes();
  const avec  = IGD.lignes.filter(igdbAChanger);
  const rates = IGD.lignes.filter(l => l.etat !== 'ok');
  igdbEntete('Ce qui va changer');

  const nJaq = IGD.file.length;
  igdbCorps().innerHTML = `
    <p class="igdb-info">
      <b>${IGD.lignes.length}</b> jeu${IGD.lignes.length > 1 ? 'x' : ''} analysé${IGD.lignes.length > 1 ? 's' : ''} :
      <b>${avec.length}</b> à corriger${nJaq ? `, <b>${nJaq}</b> jaquette${nJaq > 1 ? 's' : ''} à proposer` : ''}.
      ${avec.length ? `Seules les cellules « Date de sortie », « Prix de base »${
        IGD.opts.detail ? ' et la fiche détaillée (plateforme, développeur, genres, thèmes)' : ''} sont touchées.` : ''}
    </p>
    ${avec.length
      ? `<div class="igdb-liste">${avec.map(igdbLigneHTML).join('')}</div>`
      : `<p class="igdb-note">Rien à corriger${nJaq ? ' — il reste les jaquettes.' : ' : le journal est déjà à jour.'}</p>`}
    ${rates.length ? `<details class="igdb-repli">
      <summary>${rates.length} jeu${rates.length > 1 ? 'x' : ''} sans réponse d'IGDB</summary>
      ${igdbMotifsHTML(rates)}
      <ul>${rates.map(l=>`<li>${esc(l.g.name)} <i>— ${esc(motifLigne(l))}</i></li>`).join('')}</ul>
    </details>` : ''}
    <div class="frow">
      ${avec.length ? '<button class="ghost" id="igdb_tous">Tout cocher</button><button class="ghost" id="igdb_aucun">Tout décocher</button>' : ''}
      <span class="spacer"></span>
      <button class="ghost" id="igdb_annuler">Annuler</button>
      <button class="cta auto" id="igdb_ok"></button>
    </div>`;

  /* data-i pointe dans `avec`, pas dans IGD.lignes : c'est la liste affichée
     qui est indexée, et elle ne contient que les jeux à corriger */
  igdbCorps().querySelectorAll('.igdb-ligne input').forEach(c=>{
    c.onchange = ()=>{ avec[+c.dataset.i].coche = c.checked; igdbBouton(); };
  });
  const cocher = v => igdbCorps().querySelectorAll('.igdb-ligne input').forEach(c=>{
    c.checked = v; avec[+c.dataset.i].coche = v;
  });
  /* « Changer de jeu » : le bouton vit dans le <label> de la ligne, donc un
     clic cocherait la case en passant — d'où le preventDefault. */
  igdbCorps().querySelectorAll('.igdb-fiche-btn').forEach(b=>{
    b.onclick = e=>{
      e.preventDefault(); e.stopPropagation();
      corrigeFiche(avec[+b.dataset.corr]);
    };
  });
  if($('igdb_tous'))  $('igdb_tous').onclick  = ()=>{ cocher(true);  igdbBouton(); };
  if($('igdb_aucun')) $('igdb_aucun').onclick = ()=>{ cocher(false); igdbBouton(); };
  $('igdb_annuler').onclick = fermerIgdb;
  $('igdb_ok').onclick = ()=>{
    if(IGD.lignes.some(l => l.coche && igdbAChanger(l))) igdbEcriture();
    else if(IGD.file.length) igdbJaquette();
    else fermerIgdb();
  };
  igdbBouton();
}
/* Pourquoi une ligne n'a rien donné. « Aucune fiche trouvée » veut dire
   qu'IGDB a répondu mais ne connaît pas ce titre ; tout le reste est une
   panne de liaison, et c'est le motif exact qui permet d'y remédier. */
function motifLigne(l){
  if(l.etat === 'introuvable') return 'aucune fiche trouvée';
  return l.raison || 'IGDB injoignable';
}
/* Les échecs regroupés par motif. Trente jeux qui échouent pour la même
   raison, c'est un seul problème à régler — la liste nom par nom, elle, ne
   le montre pas. */
function igdbMotifsHTML(rates){
  const compte = new Map();
  rates.forEach(l=>{
    const m = motifLigne(l);
    compte.set(m, (compte.get(m) || 0) + 1);
  });
  if(compte.size < 2 && rates.length < 4) return '';
  const lignes = [...compte.entries()].sort((a,b)=> b[1] - a[1])
    .map(([m,k])=> `<li><b>${k}×</b> ${esc(m)}</li>`).join('');
  return `<ul class="igdb-motifs">${lignes}</ul>`;
}

/* ---------- désigner soi-même la bonne fiche ----------
   Sur un titre que plusieurs jeux portent — « Doom », « God of War »,
   « Tomb Raider » — ou qu'IGDB n'a pas reconnu, le rapprochement
   automatique se trompe. La date de sortie tranche presque toujours (elle
   suffit pour 96 % du journal), mais quand elle ne suffit pas, seul un
   œil humain peut décider. La grille des jaquettes sert déjà exactement à
   ça ailleurs : on la réutilise telle quelle, titres et dates affichés.

   La fiche retenue est celle qui sera écrite : c'est son identifiant qui
   part, et le serveur en tire plateforme, développeur et genres. */
async function corrigeFiche(l, terme){
  const cherche = terme || l.g.name;
  let data;
  try{ data = await api('/api/jeu/suggestions', {nom: cherche}); }
  catch(e){ data = null; }
  const jeux = (data && data.etat === 'ok' && data.jeux) || [];
  if(!jeux.length && !terme){
    toast(`Aucune fiche proposée pour « ${cherche} »`, true);
    return;
  }
  if(!jeux.length) toast(`Rien trouvé pour « ${cherche} »`, true);
  openJaq(l.g.name, jeux, choix=>{
    l.fiche = choix;
    l.surete = 'sure';              // choisi à la main : plus rien à deviner
    l.rattache = true;              // l'identifiant part, options ou pas
    /* on repart du choix : la date suit la fiche, et les trois colonnes
       seront relues côté serveur à partir de l'identifiant */
    l.date = (IGD.opts.dates && choix.iso && choix.iso !== (l.g.release || ''))
      ? {avant: l.g.release || '', apres: choix.iso} : null;
    if(IGD.opts.detail) l.detail = {plateforme: null, developpeur: null, genres: null, themes: null};
    l.coche = igdbAChanger(l);
    igdbRevue();                    // la liste se redessine avec le nouveau choix
  }, null, {
    titre: `Quel jeu est « ${l.g.name} » ?`,
    terme: cherche,
    surRecherche: t => corrigeFiche(l, t),
  });
}

/* Le bouton principal dit ce qu'il va faire, et il change à chaque case
   décochée : « Écrire 12 lignes », puis « Passer aux jaquettes », puis
   « Fermer » quand il ne reste plus rien. */
function igdbBouton(){
  const b = $('igdb_ok');
  if(!b) return;
  const n = IGD.lignes.filter(l => l.coche && igdbAChanger(l)).length;
  if(n) b.textContent = `Écrire ${n} ligne${n > 1 ? 's' : ''}`;
  else if(IGD.file.length) b.textContent = `Voir les ${IGD.file.length} jaquette${IGD.file.length > 1 ? 's' : ''}`;
  else b.textContent = 'Fermer';
}

/* ---------- étape 4 : l'écriture ---------- */
/* Ce qui part pour un jeu : les deux champs concernés, pas un de plus.
   Le serveur ne touche qu'aux champs présents dans `values` — la note, le
   mois, le temps de jeu, le prix payé et l'avis ne sont donc pas réécrits,
   pas même à l'identique. Ni `periode` ni `review` ici : les omettre est
   justement ce qui dit de ne pas y toucher. */
function igdbCharge(l){
  const values = {};
  if(l.date) values.release = l.date.apres;
  if(l.prix) values.base = l.prix.apres;
  /* Seul l'identifiant part : plateforme, développeur et genres sont
     relus depuis IGDB par le serveur (enrichit_igdb), jamais dictés
     d'ici. Il vient de répondre à l'analyse, donc il les a en cache et
     l'écriture ne lui coûte pas un aller-retour de plus. */
  if(l.detail || l.rattache) values.id_igdb = l.fiche.id;
  return { id: l.g.id, values: values };
}

/* Écriture par paquets : une seule relecture du journal pour vingt jeux au
   lieu d'une par jeu. C'est la relecture qui coûte, pas l'écriture.

   Le repli « un par un » de l'époque Apps Script a disparu : il servait aux
   scripts pas encore redéployés avec l'action « lot ». Flask, lui, sait
   toujours traiter un paquet. */
const IGDB_LOT = 20;

/* Écrit un paquet et renvoie les motifs d'échec, un par jeu. Les compteurs
   sont tenus ici : c'est le seul endroit qui sache exactement lequel des
   jeux est passé et lequel a résisté. */
async function igdbEnvoyerPaquet(paquet){
  const echecs = [], utiles = [];
  paquet.forEach(l=>{
    try{ utiles.push({ligne: l, charge: igdbCharge(l)}); }
    catch(e){ echecs.push(`${l.g.name} — ${e.message || 'erreur inconnue'}`); }
  });
  if(!utiles.length) return echecs;
  const compter = u => {
    if(u.ligne.date) IGD.compte.dates++;
    if(u.ligne.prix) IGD.compte.prix++;
    if(u.ligne.detail || u.ligne.rattache) IGD.compte.detail++;
  };

  try{
    IGD.dernier = await envoyer('PUT', '/api/journal/lot',
                                {modifs: utiles.map(u => u.charge)});
    const refuses = ((IGD.dernier.fait || {}).echecs) || [];
    const rates = {};
    refuses.forEach(e=>{
      rates[e.i] = true;
      echecs.push(`${e.jeu || '?'} — ${e.error}`);
    });
    utiles.forEach((u,k)=>{ if(!rates[k]) compter(u); });
    return echecs;
  }catch(e){
    // panne franche : le paquet entier n'est pas passé, on le dit
    const motif = e.message || 'erreur inconnue';
    return echecs.concat(utiles.map(u => `${u.ligne.g.name} — ${motif}`));
  }
}

async function igdbEcriture(){
  const jeton = ++IGD.jeton;
  IGD.etape = 'ecriture';
  IGD.stop = false;
  IGD.t0 = Date.now();
  IGD.compte.dates = 0; IGD.compte.prix = 0; IGD.compte.detail = 0; IGD.compte.echecs = 0;
  IGD.echecs = [];
  const aFaire = IGD.lignes.filter(l => l.coche && igdbAChanger(l));
  igdbEntete('Écriture dans le classeur');
  igdbCorps().innerHTML = `
    <p class="igdb-info">Seules la date de sortie, le prix de base${
      IGD.opts.detail ? ' et la fiche détaillée' : ''} sont touchés.</p>
    ${igdbJauge()}
    <div class="frow"><span class="spacer"></span>
      <button class="ghost" id="igdb_stop">Interrompre</button></div>`;
  $('igdb_stop').onclick = ()=>{ IGD.stop = true; };

  let i = 0;
  while(i < aFaire.length){
    if(jeton !== IGD.jeton) return;
    if(IGD.stop) break;
    const paquet = aFaire.slice(i, i + IGDB_LOT);
    igdbAvance(i, aFaire.length, paquet[0].g.name
      + (paquet.length > 1 ? ` (+${paquet.length - 1})` : ''));
    const rates = await igdbEnvoyerPaquet(paquet);
    if(jeton !== IGD.jeton) return;
    IGD.echecs = IGD.echecs.concat(rates);
    IGD.compte.echecs += rates.length;
    i += paquet.length;
  }
  if(jeton !== IGD.jeton) return;
  igdbAvance(aFaire.length, aFaire.length, '');

  /* le classeur relu par la dernière écriture remplace ce qu'on affiche :
     une seule fois, à la fin, plutôt qu'un rendu complet par ligne */
  if(IGD.dernier){
    const s = source();
    if(s) cacheStore.set(s.url, IGD.dernier);
    applyData(IGD.dernier, true);
    IGD.dernier = null;
    render();
  }
  if(IGD.file.length) igdbJaquette();
  else igdbFini();
}

/* ---------- étape 5 : les jaquettes, une par une ---------- */
function igdbJaquette(){
  IGD.etape = 'jaquettes';
  if(IGD.fi >= IGD.file.length){ igdbFini(); return; }
  const e = IGD.file[IGD.fi];
  igdbEntete(`Jaquette ${IGD.fi + 1} / ${IGD.file.length}`);
  igdbCorps().innerHTML = `
    <p class="igdb-info">Jaquette de <b>« ${esc(e.nom)} »</b>.</p>
    <div class="jaq-grid">
      ${e.propositions.map((p,i)=>`
        <button class="jaq-item${p.suggere ? ' suggeree' : ''}" data-i="${i}" title="${esc(p.lien || '')}">
          <img src="${esc(p.apercu)}" alt="" loading="lazy" decoding="async">
          <b>${esc(p.titre)}</b>
          <span>${esc(p.date || 'date inconnue')}${p.nature ? ' · ' + esc(p.nature) : ''}</span>
        </button>`).join('')}
    </div>
    <div class="frow">
      <button class="ghost" id="igdb_stop">Arrêter là</button>
      <span class="spacer"></span>
      <button class="ghost" id="igdb_passer">Passer ce jeu</button>
    </div>`;
  $('igdb_stop').onclick = igdbFini;
  $('igdb_passer').onclick = ()=>{ IGD.fi++; igdbJaquette(); };
  igdbCorps().querySelectorAll('.jaq-item').forEach(b=>{
    b.onclick = ()=> igdbPoser(b, e.nom, e.propositions[+b.dataset.i], e.jeuId);
  });
}
async function igdbPoser(btn, nom, choix, jeuId){
  const jeton = ++IGD.jeton;
  igdbCorps().querySelectorAll('.jaq-item').forEach(b=>{ b.disabled = true; });
  btn.classList.add('pris');
  /* Le jeu est relu dans GAMES plutôt que pris dans le rapport : l'écriture
     vient de passer juste avant, et c'est elle qui a pu lui donner son
     identifiant IGDB. Le rapport, lui, date d'avant. */
  const jeu = GAMES.find(x => x.id === jeuId);
  const idIgdb = jeu ? jeu.idIgdb : null;
  const cle = idIgdb ? String(idIgdb) : slug(nom);
  let data;
  try{ data = await api('/api/jaquette/choisir',
    {nom: nom, image: choix.image, id_igdb: idIgdb || null}); }
  catch(e){ data = null; }
  if(jeton !== IGD.jeton) return;       // la fenêtre a été fermée entre-temps
  if(data && data.etat === 'telechargee'){
    IGD.compte.jaquettes++;
    poseJaquette(cle);
  }else{
    toast('Téléchargement impossible' + (data && data.raison ? ' — ' + data.raison : ''), true);
  }
  IGD.fi++;
  igdbJaquette();
}

/* ---------- étape 6 : le compte rendu ---------- */
function igdbFini(){
  IGD.etape = 'fini';
  IGD.jeton++;
  igdbEntete('Mise à jour terminée');
  const c = IGD.compte;
  const plu = n => n > 1 ? 's' : '';
  igdbCorps().innerHTML = `
    <div class="igdb-bilan">
      <span class="igdb-chiffre"><b>${c.dates}</b> <u>date${plu(c.dates)} corrigée${plu(c.dates)}</u></span>
      <span class="igdb-chiffre"><b>${c.prix}</b> <u>prix mis à jour</u></span>
      <span class="igdb-chiffre"><b>${c.jaquettes}</b> <u>jaquette${plu(c.jaquettes)} récupérée${plu(c.jaquettes)}</u></span>
      <span class="igdb-chiffre"><b>${c.detail}</b> <u>fiche${plu(c.detail)} détaillée${plu(c.detail)}</u></span>
    </div>
    ${(!c.dates && !c.prix && !c.jaquettes && !c.detail)
      ? '<p class="igdb-note">Rien à changer : le journal était déjà à jour.</p>' : ''}
    ${c.echecs ? `<div class="ferr">${c.echecs} ligne${c.echecs > 1 ? 's n\'ont' : " n'a"} pas pu être écrite${c.echecs > 1 ? 's' : ''} :<br>${IGD.echecs.map(esc).join('<br>')}</div>` : ''}
    <div class="frow"><span class="spacer"></span>
      <button class="cta auto" id="igdb_fin">Fermer</button></div>`;
  $('igdb_fin').onclick = fermerIgdb;
}

fermeSurFond('igdb', fermerIgdb);
$('igdbBtn').addEventListener('click', ouvrirIgdb);
