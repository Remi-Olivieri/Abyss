/* =======================================================================
   Archive Jeux Vidéos - archive-igdb.js

   La mise à jour du journal entier depuis IGDB.

   Cinq étapes : ce qu'on veut mettre à jour, l'analyse jeu par jeu, la
   relecture de ce qui va changer, l'écriture par paquets, puis les
   jaquettes une par une. L'analyse peut aussi venir du serveur, qui la
   fait seul chaque nuit (voir entretien.py) : on passe alors directement
   à la relecture.

   C'est le seul module qui écrit en masse dans le classeur, d'où sa
   prudence : rien ne part sans avoir été montré.

   Chargé par templates/archive/archive.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */


/* =======================================================================
   Mise à jour depuis IGDB - l'entretien de la base

   Le classeur vieillit : une date de sortie saisie de mémoire, un prix noté
   avant une baisse, une jaquette jamais récupérée. Ce module repasse sur
   chaque ligne, demande à Flask ce qu'IGDB en dit (/api/jeu/maj), et montre
   la liste des écarts.

   Réservé à l'administration, et pour une raison qui a changé la nature de
   l'outil : ce ne sont plus seulement les colonnes d'un classeur qu'il
   remplit, ce sont celles dont le reste du site se sert. Le Quiz tire ses
   grilles de connexions des genres et des thèmes de TOUS les journaux ; un
   jeu d'avant les fiches IGDB en manque, et personne n'allait le compléter
   chez lui pour un mini-jeu qu'il ne voit même pas. L'entretien revient donc
   à qui tient la base, et il porte sur la base entière - la portée « Toute
   la base » est la première du menu, avant le journal affiché.

   Le serveur ne s'en remet pas à cette fenêtre : /api/journal/admin/jeux et
   /api/journal/admin/lot répondent 404 à qui n'est pas administrateur, et le
   second n'accepte que les colonnes qu'IGDB fournit (voir CHAMPS_IGDB).

   Trois précautions, parce qu'écrire trois cents lignes d'un coup ne se
   rattrape pas :

     - rien n'est écrit avant la relecture. L'analyse est un rapport ;
       l'écriture est un second geste, sur les lignes cochées seulement.
     - un jeu dont le titre ne correspond pas exactement à une fiche IGDB
       arrive décoché : « Doom » trouve six jeux, on ne les départage pas
       à l'aveugle.
     - les jaquettes se choisissent une par une, comme ailleurs dans la
       page. Aucune image ne part sur le disque sans un clic.

   L'écriture passe par /api/journal/admin/lot, par paquets de vingt. Elle
   n'écrit que les colonnes qu'IGDB fournit - la date, le prix, la fiche
   détaillée - et le serveur refuse les autres plutôt que de s'en remettre à
   ce que la page veut bien lui envoyer : une note ou un avis sont l'œuvre de
   qui tient le journal, un entretien de base n'a rien à y faire.
   ======================================================================= */
const IGD = {
  jeton: 0,        // incrémenté à l'annulation : les boucles en vol s'arrêtent
  stop: false,     // « Interrompre » : on s'arrête mais on garde le résultat
  etape: '',
  liste: [],       // les jeux à interroger
  site: null,      // tous les jeux du site, lus une fois à l'ouverture
  lignes: [],      // un rapport par jeu, une fois l'analyse finie
  file: [],        // les jaquettes à proposer, une par nom de fichier
  fi: 0,
  t0: 0,
  ecrit: false,    // une écriture au moins est passée : le classeur affiché
                   // n'est plus à jour, il faudra le relire
  filtre: false,   // la relecture ne montre que les jeux à vérifier
  compte: {dates:0, prix:0, jaquettes:0, detail:0, echecs:0},
  echecs: [],
  opts: {dates:true, prix:true, jaquettes:true, detail:true, tout:false},
  passes: 0,       // les jeux déjà complets, que l'analyse n'a pas interrogés
  nuit: null,      // où en est l'analyse de nuit, lu avec la base (voir entretien.py)
  source: '',      // 'nuit' quand la relecture vient du rapport de nuit
  rapportNuit: null, // son début et sa fin, pour le dire en tête de relecture
  horsRapport: 0,  // les lignes ajoutées ou modifiées depuis ce rapport
};

const SURETE = {
  sure:     'sûr',
  probable: 'plusieurs fiches',
  douteuse: 'à vérifier',
};

function igdbCorps(){ return $('igdbIn'); }
/* Chaque étape passe par ici pour se nommer : c'est donc aussi l'endroit
   où la flèche de réduction apparaît ou s'efface, et où la pastille apprend
   que le travail qu'elle suivait est fini. */
function igdbEntete(txt){
  const b = $('igdbTitre'); if(b) b.textContent = txt;
  const r = document.querySelector('#igdb .igdb-reduire');
  if(r) r.hidden = !igdbEnCours();
  igdbPastilleMaj();
}
/* Les deux étapes qui tournent seules, et les seules qu'on puisse replier :
   la relecture et les jaquettes demandent un œil, les réduire n'aurait pas
   de sens. */
const igdbEnCours = ()=> IGD.etape === 'analyse' || IGD.etape === 'ecriture';

function ouvrirIgdb(){
  closeMenu();
  if(!MOI.admin){ toast("L'entretien de la base est réservé à l'administration.", true); return; }
  /* Une mise à jour repliée attend en bas : le menu la fait revenir, il ne
     la jette pas pour en recommencer une. */
  if(igdbPastille()){ rouvrirIgdb(); return; }
  IGD.jeton++;
  IGD.stop = false;
  IGD.lignes = []; IGD.file = []; IGD.fi = 0; IGD.ecrit = false; IGD.filtre = false;
  IGD.avance = null;
  IGD.source = ''; IGD.rapportNuit = null; IGD.horsRapport = 0;
  /* Les cinq compteurs, et pas quatre : `detail` manquait ici alors que le
     bilan l'affiche. L'écriture le remettait à zéro au passage, ce qui
     masquait l'oubli - sauf quand il n'y a rien à écrire et qu'on va
     directement aux jaquettes, où le bilan annonçait « undefined ». */
  IGD.compte = {dates:0, prix:0, jaquettes:0, detail:0, echecs:0};
  IGD.echecs = [];
  const host = $('igdb');
  host.innerHTML = `<div class="sheet igdb-sheet" role="dialog" aria-modal="true" aria-label="Mise à jour depuis IGDB">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead" id="igdbTitre">Mise à jour depuis IGDB</b></span>
      <span class="grp">
        <button class="sbtn igdb-reduire" aria-label="Réduire, pour naviguer pendant la mise à jour" hidden>${ICONE_REDUIRE}</button>
        <button class="sbtn igdb-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="igdb-in" id="igdbIn"></div>
  </div>`;
  host.hidden = false;
  verrouFond();
  host.querySelector('.igdb-x').onclick = fermerIgdb;
  host.querySelector('.igdb-reduire').onclick = igdbReduire;
  igdbOuvreReglages();
}
/* La base est relue à chaque ouverture, jamais gardée d'une fois sur
   l'autre : entre deux passages, des jeux ont été ajoutés, et une liste
   d'hier proposerait d'en corriger qui n'existent plus. Le temps d'attente
   est celui d'une requête ; les réglages s'affichent derrière. */
async function igdbOuvreReglages(){
  const jeton = IGD.jeton;
  igdbEntete('Lecture de la base');
  igdbCorps().innerHTML = '<p class="igdb-info">Lecture des journaux du site...</p>';
  let souci = '';
  try{
    const d = await envoiBrut('GET', '/api/journal/admin/jeux');
    IGD.site = d.jeux || [];
    IGD.nuit = d.nuit || null;
  }catch(e){ souci = e.message || 'erreur inconnue'; }
  if(jeton !== IGD.jeton) return;        // fermée pendant la lecture
  /* Sans cette liste il n'y a plus rien à proposer : les journaux, leurs
     onglets et tous les comptes en sortent. On le dit et on offre de
     recommencer, plutôt que d'afficher une fenêtre vide qui laisserait
     croire que la base ne contient rien. */
  if(souci){
    igdbEntete('Base illisible');
    igdbCorps().innerHTML = `
      <div class="ferr">La liste des journaux n'a pas pu être lue - ${esc(souci)}</div>
      <div class="frow"><span class="spacer"></span>
        <button class="ghost" id="igdb_annuler">Fermer</button>
        <button class="cta auto" id="igdb_encore">Réessayer</button></div>`;
    $('igdb_annuler').onclick = fermerIgdb;
    $('igdb_encore').onclick = igdbOuvreReglages;
    return;
  }
  igdbReglages();
}
function fermerIgdb(){
  const host = $('igdb');
  // repliée, la fenêtre est cachée mais bien là : la pastille le dit
  const reduite = !!igdbPastille();
  igdbPastilleEnleve();
  if(host.hidden && !reduite) return;
  IGD.jeton++;                  // ce qui répondra après nous ne sert plus
  IGD.etape = '';
  host.hidden = true; host.innerHTML = '';
  host.style.zIndex = '';       // posé par rouvrirIgdb, voir closeForm
  verrouFond();
  igdbRelitLeClasseur();
}

/* ---------- réduire pendant que ça tourne ----------
   Sur toute la base, l'analyse se compte en minutes, et la fenêtre tenait
   la page entière pendant ce temps. La flèche la replie en une pastille en
   bas au centre - la jauge, le pourcentage, le temps restant - et rend le
   journal : on va lire, noter, changer de journal, et un clic la fait
   remonter. Le même geste et le même vol que le formulaire replié (voir
   reduireForm dans archive-formulaire.js), dont on reprend les outils.

   Au centre et pas dans un coin : le bas à droite est au formulaire replié,
   le bas à gauche au rattrapage, et les deux peuvent être là en même temps. */
let IGDB_ANIME = false;
function igdbPastille(){ return $('igdbPastille'); }
function igdbPastilleEnleve(){
  const p = igdbPastille();
  if(p) p.remove();
}
function igdbPastilleMonte(){
  igdbPastilleEnleve();
  const p = document.createElement('div');
  p.id = 'igdbPastille';
  p.className = 'igdb-pastille mesure';
  p.innerHTML = `<button type="button" class="ip-ouvre" aria-label="Rouvrir la mise à jour depuis IGDB">
      <span class="fp-fleche">${ICONE_AGRANDIR}</span>
      <span class="ip-corps">
        <span class="ip-ligne"><b class="ip-pct"></b><i class="ip-reste"></i></span>
        <span class="ip-jauge"><i></i></span>
      </span>
    </button>`;
  document.body.appendChild(p);
  p.querySelector('.ip-ouvre').onclick = ()=> rouvrirIgdb();
  igdbPastilleMaj();
  return p;
}
/* Pendant le travail : le pourcentage et le temps restant. Une fois l'étape
   passée, ce qui attend - la relecture ou le bilan ne se font pas seuls,
   la pastille le dit au lieu de rester figée sur 100 %. */
const IGDB_FIN_ETAPE = {
  revue: 'Analyse terminée',
  jaquettes: 'Écriture terminée',
  fini: 'Mise à jour terminée',
};
function igdbPastilleMaj(){
  const p = igdbPastille();
  if(!p) return;
  const a = IGD.avance || {fait: 0, total: 0};
  const enCours = igdbEnCours();
  const pct = enCours ? (a.total ? Math.round(a.fait / a.total * 100) : 0) : 100;
  p.classList.toggle('fini', !enCours);
  p.querySelector('.ip-pct').textContent = enCours
    ? `${pct} %` : (IGDB_FIN_ETAPE[IGD.etape] || 'Mise à jour en pause');
  p.querySelector('.ip-reste').textContent = enCours
    ? igdbReste(a.fait, a.total) : 'Voir';
  p.querySelector('.ip-jauge i').style.width = pct + '%';
}

function igdbReduire(){
  const host = $('igdb');
  const feuille = host.querySelector('.igdb-sheet');
  if(host.hidden || !feuille || IGDB_ANIME) return;
  IGDB_ANIME = true;
  const p = igdbPastilleMonte();
  poseVolForm(feuille, p);
  const vite = sansMouvement();
  if(!vite){
    // jamais retirées, seulement échangées : voir le commentaire de reduireForm
    feuille.classList.remove('revient');
    feuille.classList.add('part');
    host.classList.add('part');
  }
  setTimeout(()=>{
    host.hidden = true;
    host.classList.remove('part');
    verrouFond();                       // la page redevient défilable
    p.classList.remove('mesure');
    if(!vite) p.classList.add('arrive');
    IGDB_ANIME = false;
  }, vite ? 0 : FORM_REDUIT_MS);
}
function rouvrirIgdb(){
  const host = $('igdb');
  const feuille = host.querySelector('.igdb-sheet');
  const p = igdbPastille();
  if(!feuille || IGDB_ANIME) return;
  IGDB_ANIME = true;
  const vite = sansMouvement();
  host.hidden = false;
  auPremierPlan(host);                  // au-dessus de ce qu'on a ouvert entre-temps
  verrouFond();
  if(p){
    poseVolForm(feuille, p);
    p.classList.remove('arrive');
    if(vite) p.remove(); else { p.classList.add('repart'); setTimeout(()=> p.remove(), 200); }
  }
  if(!vite){
    feuille.classList.remove('part');
    feuille.classList.add('revient');
  }
  setTimeout(()=>{ IGDB_ANIME = false; }, vite ? 0 : FORM_ROUVRE_MS);
}
/* Les autres pages du site rechargent tout : quitter celle-ci en pleine
   analyse la perdrait sans un mot. Le navigateur demande d'abord - et
   seulement tant que quelque chose tourne. */
window.addEventListener('beforeunload', e=>{
  if(!igdbEnCours()) return;
  e.preventDefault();
  e.returnValue = '';
});
/* Des écritures ont pu passer : ce que le mur affiche date d'avant.
   Le classeur est relu au lieu d'être recollé à la main - l'écriture ne
   renvoie plus le journal, elle ne le peut plus : elle a pu toucher autant
   de journaux qu'il y a de propriétaires, et la page n'en montre qu'un. */
function igdbRelitLeClasseur(){
  if(!IGD.ecrit) return;
  IGD.ecrit = false;
  if(typeof source === 'function' && source()) charger({silencieux: true});
}

/* ---------- étape 1 : ce qu'on veut mettre à jour ----------
   Deux questions, dans cet ordre : quel journal, puis quel onglet.

   La première liste tout le site - « Toute la base », puis chaque personne
   qui tient un journal. La seconde n'apparaît qu'une fois quelqu'un choisi,
   et ne propose que SES onglets : « 2024 » n'a pas le même contenu chez
   deux personnes, et une liste d'onglets qui ne dirait pas de qui ils sont
   ne voudrait rien dire.

   Tout vient de la lecture faite à l'ouverture (IGD.site) : les journaux,
   leurs onglets et le compte de chacun sont déduits de la même liste de
   jeux, sans une requête de plus. C'est aussi pourquoi la fenêtre ne parle
   plus du classeur affiché - elle ne dépend plus de l'endroit d'où on
   l'ouvre, ce qui était justement la gêne : mettre à jour le journal de
   quelqu'un d'autre obligeait à aller s'y placer d'abord. */
function igdbJournaux(){
  const par = new Map();
  (IGD.site || []).forEach(g=>{
    const qui = g.pseudo || '?';
    if(!par.has(qui)) par.set(qui, {pseudo: qui, jeux: [], onglets: [], rang: {}});
    const j = par.get(qui);
    j.jeux.push(g);
    /* Les onglets dans l'ordre où les jeux arrivent, c'est-à-dire celui du
       serveur (periode croissante). Ce n'est pas tout à fait l'ordre
       chronologique du classeur - « Avant 2019 » se range après « 2019 » -
       mais c'est un ordre stable et lisible, et la fenêtre n'a pas à
       refaire le tri que la page fait déjà chez elle. */
    if(!(g.bucket in j.rang)){
      j.rang[g.bucket] = j.onglets.length;
      j.onglets.push({nom: g.bucket, jeux: []});
    }
    j.onglets[j.rang[g.bucket]].jeux.push(g);
  });
  const tous = [...par.values()];
  // le mien d'abord : c'est celui qu'on entretient le plus souvent, et la
  // page range déjà ses journaux comme ça partout ailleurs
  const i = tous.findIndex(j => MOI.pseudo && norm(j.pseudo) === norm(MOI.pseudo));
  if(i > 0) tous.unshift(tous.splice(i, 1)[0]);
  return tous;
}
const igdbPluriel = n => n > 1 ? 'x' : '';

/* ---------- l'analyse de la nuit ----------
   Chaque nuit à minuit, le serveur fait seul l'analyse de toute la base,
   jeux complets compris (voir entretien.py), et garde ce qu'IGDB et Steam
   ont répondu. Le matin, il ne reste qu'à relire et écrire : c'est donc la
   première chose que la fenêtre propose, avant les réglages de l'analyse
   à la main. */
function igdbQuand(iso){
  const d = new Date(iso);
  if(isNaN(d)) return '';
  return d.toLocaleString('fr-FR', {weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris'});
}
function igdbDuree(debut, fin){
  const min = Math.round((new Date(fin) - new Date(debut)) / 60000);
  return isNaN(min) ? '' : (min < 1 ? "moins d'une minute" : `${min} min`);
}
function igdbNuitHTML(){
  const n = IGD.nuit || {};
  const r = n.rapport, c = n.en_cours;
  const enCours = suite => c ? `<p class="igdb-note">Une analyse tourne sur le serveur : <b>${
    c.fait} / ${c.total}</b> jeux. ${suite}</p>` : '';
  if(r) return `<div class="igdb-nuit">
      <p class="igdb-info">Analyse de la nuit : <b>${r.jeux} jeu${igdbPluriel(r.jeux)}</b> vérifié${
        r.jeux > 1 ? 's' : ''} le ${esc(igdbQuand(r.debut))}${
        r.fin ? ` (${esc(igdbDuree(r.debut, r.fin))})` : ''}.</p>
      <button class="cta auto" id="igdb_nuit">Relire l'analyse de la nuit</button>
      ${enCours('Son rapport remplacera celui-ci à la fin.')}
    </div>`;
  if(c) return `<div class="igdb-nuit">${enCours('Le rapport sera prêt à la fin.')}</div>`;
  return '<p class="igdb-note igdb-nuit-rien">Pas encore d\'analyse de nuit : le serveur en fait une chaque nuit à minuit.</p>';
}
/* Le rapport de nuit, comparé à la base telle qu'elle est maintenant.

   Le serveur ne garde que les réponses d'IGDB, jamais les écarts : c'est
   igdbRapport, celui de l'analyse à la main, qui les calcule ici, contre
   les valeurs lues à l'ouverture. Un jeu corrigé dans la matinée n'a donc
   plus rien à proposer, et une ligne renommée ou rattachée à une autre
   fiche depuis minuit est écartée : la réponse ne la décrit plus.

   Une ligne sans fiche à minuit, rattachée depuis à celle-là même que la
   nuit avait trouvée, reste la même : c'est ce que fait l'écriture de ce
   rapport, et la relire ne doit pas la compter parmi les « modifiées ». */
function igdbMemeLigne(g, s, data){
  if(s.id_igdb) return g.idIgdb === s.id_igdb;
  if(g.idIgdb) return !!(data.fiche && g.idIgdb === data.fiche.id);
  return g.name === s.nom && (g.release || '') === (s.sortie || '');
}
async function igdbNuit(){
  const jeton = ++IGD.jeton;
  igdbEntete('Lecture du rapport');
  igdbCorps().innerHTML = "<p class=\"igdb-info\">Lecture de l'analyse de la nuit...</p>";
  let r = null, souci = '';
  try{
    const d = await envoiBrut('GET', '/api/journal/admin/nuit');
    r = d.rapport;
  }catch(e){ souci = e.message || 'erreur inconnue'; }
  if(jeton !== IGD.jeton) return;        // fermée pendant la lecture
  if(souci || !r){
    toast(souci ? `Rapport illisible - ${souci}` : "Pas encore d'analyse de nuit.", true);
    igdbReglages();
    return;
  }
  IGD.opts = {dates:true, prix:true, jaquettes:true, detail:true, tout:true};
  IGD.source = 'nuit';
  IGD.rapportNuit = {debut: r.debut, fin: r.fin};
  IGD.passes = 0;
  IGD.horsRapport = 0;
  IGD.lignes = [];
  const jeux = r.jeux || {}, reponses = r.reponses || [];
  (IGD.site || []).forEach(g=>{
    const s = jeux[g.id];
    const data = s && reponses[s.r];
    if(!data || !igdbMemeLigne(g, s, data)){ IGD.horsRapport++; return; }
    IGD.lignes.push(igdbRapport(g, data, 'nuit' + s.r));
  });
  igdbRevue();
}

function igdbReglages(){
  IGD.etape = 'reglages';
  igdbEntete('Mise à jour depuis IGDB');
  const journaux = igdbJournaux();
  if(!journaux.length){
    igdbCorps().innerHTML = `
      <p class="igdb-note">Aucun jeu à mettre à jour : la base est vide.</p>
      <div class="frow"><span class="spacer"></span>
        <button class="cta auto" id="igdb_annuler">Fermer</button></div>`;
    $('igdb_annuler').onclick = fermerIgdb;
    return;
  }
  const total = (IGD.site || []).length;
  igdbCorps().innerHTML = `
    ${igdbNuitHTML()}
    <div class="fgrid">
      <label class="fld full"><u>Journal</u>
        <select id="igdb_qui">
          <option value="*">Toute la base du site - ${total} jeu${igdbPluriel(total)}</option>
          ${journaux.map((j,i)=>
            `<option value="${i}">Journal de ${esc(j.pseudo)} - ${j.jeux.length} jeu${igdbPluriel(j.jeux.length)}</option>`
          ).join('')}
        </select></label>
      <label class="fld full" id="igdb_ongletChamp" hidden><u>Onglet</u>
        <select id="igdb_onglet"></select></label>
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
      <label class="fld fcheck full">
        <input id="igdb_tout" type="checkbox"${IGD.opts.tout ? ' checked' : ''}>
        <span>Revérifier aussi les jeux déjà complets (plus long)</span></label>
    </div>
    <div class="frow"><span class="spacer"></span>
      <button class="ghost" id="igdb_annuler">Annuler</button>
      <button class="cta auto" id="igdb_go">Analyser</button></div>`;

  /* Le second menu suit le premier : caché tant qu'on parle de toute la
     base, rempli des onglets de la personne dès qu'on en choisit une. */
  const majOnglets = ()=>{
    const j = igdbChoisi(journaux);
    const champ = $('igdb_ongletChamp');
    champ.hidden = !j;
    if(!j) return;
    $('igdb_onglet').innerHTML =
      `<option value="*">Tous ses onglets - ${j.jeux.length} jeu${igdbPluriel(j.jeux.length)}</option>` +
      j.onglets.map((o,i)=>
        `<option value="${i}">${esc(o.nom)} - ${o.jeux.length} jeu${igdbPluriel(o.jeux.length)}</option>`
      ).join('');
  };
  $('igdb_qui').onchange = majOnglets;
  majOnglets();
  if($('igdb_nuit')) $('igdb_nuit').onclick = igdbNuit;

  $('igdb_annuler').onclick = fermerIgdb;
  $('igdb_go').onclick = ()=>{
    IGD.opts = {
      dates: $('igdb_dates').checked,
      prix: $('igdb_prix').checked,
      jaquettes: $('igdb_jaq').checked,
      detail: $('igdb_detail').checked,
      tout: $('igdb_tout').checked,
    };
    if(!IGD.opts.dates && !IGD.opts.prix && !IGD.opts.jaquettes && !IGD.opts.detail){
      toast("Coche au moins une chose à mettre à jour.", true);
      return;
    }
    IGD.liste = igdbSelection(journaux);
    if(!IGD.liste.length){ toast("Rien à analyser dans ce choix.", true); return; }
    igdbAnalyse();
  };
}
/* Le journal choisi, ou null pour « toute la base ». */
function igdbChoisi(journaux){
  const v = $('igdb_qui') ? $('igdb_qui').value : '*';
  return v === '*' ? null : (journaux[+v] || null);
}
/* Les jeux que les deux menus désignent. */
function igdbSelection(journaux){
  const j = igdbChoisi(journaux);
  if(!j) return (IGD.site || []).slice();
  const o = $('igdb_onglet') ? $('igdb_onglet').value : '*';
  if(o === '*') return j.jeux.slice();
  return (j.onglets[+o] ? j.onglets[+o].jeux : []).slice();
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
  IGD.avance = {fait, total};
  igdbPastilleMaj();
  const barre = $('igdb_barre'), compteur = $('igdb_compteur');
  if(!barre || !compteur) return;
  barre.style.width = (total ? Math.round(fait / total * 100) : 100) + '%';
  compteur.textContent = `${fait} / ${total}`;
  $('igdb_quoi').textContent = quoi || '';
  $('igdb_reste').textContent = igdbReste(fait, total);
}

/* ---------- ce qu'il est inutile de redemander ----------
   Toute la base, c'était une question à IGDB par jeu, à chaque passage - et
   l'immense majorité n'avait plus rien à apprendre. Un jeu est passé quand
   il est rattaché à une fiche (l'identifiant fait foi, voir /api/jeu/maj)
   et qu'il ne lui manque rien de ce qu'on a coché :

     - dates : une date connue et déjà passée ne bouge plus. Seuls les jeux
       à venir, ou sans date, peuvent encore en changer.
     - prix : le prix de base est rempli.
     - fiche : plateforme, développeur et genres sont là. Pas le thème :
       IGDB n'en donne pas à beaucoup de jeux, qui seraient sinon
       redemandés à chaque fois pour rien.
     - jaquettes : l'image est sur le disque, d'après le manifeste. Sans
       manifeste on ne sait pas, donc on demande.

   La case « Revérifier aussi les jeux déjà complets » repasse sur tout,
   pour une fiche qu'IGDB aurait corrigée depuis. */
function igdbAujourdhui(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function igdbComplet(g, aujourdhui){
  if(!g.idIgdb) return false;
  const o = IGD.opts;
  if(o.dates && !(/^\d{4}-\d{2}-\d{2}$/.test(g.release || '') && g.release <= aujourdhui)) return false;
  if(o.prix && (g.base === null || g.base === undefined)) return false;
  if(o.detail && !(g.plateforme && g.developpeur && g.genres)) return false;
  if(o.jaquettes && !(JAQUETTES && (cleJaquette(g) in JAQUETTES))) return false;
  return true;
}

/* ---------- étape 2 : l'analyse ---------- */
async function igdbAnalyse(){
  const jeton = ++IGD.jeton;
  IGD.etape = 'analyse';
  IGD.stop = false;
  IGD.source = '';
  IGD.horsRapport = 0;
  IGD.lignes = [];
  IGD.t0 = Date.now();
  igdbEntete('Analyse en cours');
  igdbCorps().innerHTML = `
    ${igdbJauge()}
    <div class="frow"><span class="spacer"></span>
      <button class="ghost" id="igdb_stop">Interrompre</button></div>`;
  $('igdb_stop').onclick = ()=>{ IGD.stop = true; };

  const aujourdhui = igdbAujourdhui();
  const aInterroger = IGD.opts.tout
    ? IGD.liste
    : IGD.liste.filter(g => !igdbComplet(g, aujourdhui));
  IGD.passes = IGD.liste.length - aInterroger.length;
  const total = aInterroger.length;
  /* Le même jeu revient d'un journal à l'autre : sur toute la base, « Elden
     Ring » c'est douze lignes et une seule question à IGDB. La réponse est
     donc gardée le temps de l'analyse.

     Sous l'identifiant IGDB quand la ligne en a un : /api/jeu/maj suit
     alors cette fiche quoi que disent le nom et la date, et c'est aussi
     sous lui que le serveur range la jaquette (voir cle_jaquette dans
     jaquettes.py). Deux journaux qui notent la même fiche avec deux dates
     différentes - l'un à jour, l'autre pas - ne font donc qu'une question.

     Sans identifiant, sous le couple (nom, date connue) - le couple et pas
     le nom seul, parce que c'est la date qui départage « Doom » de 1993 de
     celui de 2016, et que deux lignes qui ne la donnent pas pareil n'ont
     aucune raison de tomber sur la même fiche.

     Les échecs ne sont pas gardés : une coupure réseau sur une ligne n'est
     pas une réponse sur ce jeu, et la suivante mérite sa chance. */
  const vues = new Map();
  for(let i = 0; i < total; i++){
    if(jeton !== IGD.jeton) return;      // la fenêtre a été fermée
    if(IGD.stop) break;                  // interrompu : on garde ce qu'on a
    const g = aInterroger[i];
    igdbAvance(i, total, g.name);
    const cle = g.idIgdb ? 'id' + g.idIgdb : norm(g.name) + '|' + (g.release || '');
    let data = vues.get(cle);
    if(!data){
      try{
        data = await apiPatient('/api/jeu/maj', {
          nom: g.name,
          sortie: g.release || '',
          /* Le rattachement du jeu, quand il en a un. Sans lui, le serveur
             cherchait la jaquette sous « nom_du_jeu.webp » alors qu'un jeu
             rattaché range la sienne sous « 113112.webp » : il ne la
             trouvait jamais, répondait « absente », et l'analyse proposait
             de récupérer une image déjà là - pour tous les jeux du site à
             la fois. Voir cle_jaquette dans jaquettes.py. */
          id_igdb: g.idIgdb || null,
          prix: IGD.opts.prix,
          detail: IGD.opts.detail,
          // Flask attend un mot, pas un booléen : « aucune » lui évite de
          // rassembler des propositions dont personne ne veut
          jaquettes: IGD.opts.jaquettes ? 'manquantes' : 'aucune',
        });
      }catch(e){
        data = {etat:'injoignable', raison: raisonReseau(e)};
      }
      if(data.etat === 'ok' || data.etat === 'introuvable') vues.set(cle, data);
    }
    if(jeton !== IGD.jeton) return;
    IGD.lignes.push(igdbRapport(g, data, cle));
  }
  if(jeton !== IGD.jeton) return;
  igdbAvance(IGD.lignes.length, total, '');
  igdbRevue();
}

/* Ce qu'on retient d'un jeu : les écarts, et rien d'autre. Une valeur
   identique n'est pas un changement - la liste ne montrerait que du bruit.
   `cle` désigne la question posée à IGDB : plusieurs lignes la partagent, et
   c'est en les comptant qu'on sait combien de jeux ont été analysés. */
function igdbRapport(g, data, cle){
  const l = {
    g: g,
    cle: cle,
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
     cherche ici, ceux qui n'ont encore ni identifiant ni plateforme - et,
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

/* L'identifiant sous lequel l'image du jeu sera rangée APRÈS l'écriture.
   Celui du jeu s'il en a déjà un, sinon celui de la fiche que l'écriture
   s'apprête à lui donner : un jeu qu'on rattache voit son fichier passer de
   « nom_du_jeu.webp » à « 113112.webp », et c'est ce dernier nom qui compte
   pour savoir si l'image manque vraiment. */
function igdbIdFinal(l){
  return l.g.idIgdb || ((l.detail || l.rattache) && l.fiche ? l.fiche.id : null);
}
function igdbCleFinale(l){
  const id = igdbIdFinal(l);
  return id ? String(id) : slug(l.g.name);
}

/* Les jaquettes à proposer : celles qui manquent, et rien d'autre.

   Deux dédoublonnages, tous deux par nom de fichier final, parce que les
   jaquettes ne vivent pas dans un journal mais sur le disque, en un seul
   exemplaire pour tout le site :

     - le même jeu rejoué dans deux onglets, ou joué par deux personnes,
       ne se demande qu'une fois ;
     - un jeu que l'analyse a trouvé illustré chez quelqu'un n'est pas
       proposé chez le voisin qui, lui, ne l'a pas encore rattaché : c'est
       le même fichier, et il est déjà là.

   Le second cas ne se voyait pas tant que la fenêtre ne parlait que d'un
   classeur ; sur la base entière, il vaut des dizaines de propositions
   inutiles. */
function igdbFileJaquettes(){
  if(!IGD.opts.jaquettes) return [];
  // ce que l'analyse a vu de présent sur le disque, sous le nom de fichier
  // qu'elle a justement demandé au serveur de regarder
  const presentes = new Set();
  IGD.lignes.forEach(l=>{
    if(l.etat === 'ok' && l.jaquette === 'presente') presentes.add(cleJaquette(l.g));
  });
  /* Et le manifeste par-dessus : c'est la liste des fichiers réellement
     présents dans Cover/, celle qui décide déjà si le mur affiche une
     jaquette ou des initiales. Un jeu dont l'image est là n'a rien à
     proposer, qu'une autre ligne de l'analyse l'ait rencontrée ou non. */
  const dejaLa = cle => presentes.has(cle) || !!(JAQUETTES && (cle in JAQUETTES));

  const file = [], vus = new Set();
  IGD.lignes.forEach(l=>{
    if(l.etat !== 'ok' || !l.propositions.length) return;
    // déjà illustré : le bouton de la tuile sert à en changer, un par un
    if(l.jaquette !== 'absente') return;
    const cle = igdbCleFinale(l);
    if(!cle || vus.has(cle) || dejaLa(cle)) return;
    vus.add(cle);
    file.push({nom: l.g.name, jeuId: l.g.id, idIgdb: igdbIdFinal(l),
               propositions: l.propositions});
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
/* ---------- un jeu, une ligne ----------
   « Clair Obscur » tenu par deux personnes, c'était deux lignes identiques
   à relire et à cocher l'une après l'autre. Les lignes qui tombent sur la
   même fiche IGDB n'en font plus qu'une : une seule case, et l'écriture
   part dans chaque journal concerné.

   La fiche seule suffit quand le rapprochement est sûr - c'est le même
   jeu, quel que soit le titre que chacun lui a donné. Sinon le titre fait
   partie de la clé : deux noms différents rapprochés de la même fiche par
   simple ressemblance sont deux paris, à vérifier chacun. Le degré de
   sûreté aussi, pour que la ligne arrive cochée ou non d'un seul tenant.

   Seules les lignes qui ont quelque chose à écrire se regroupent : un
   journal déjà à jour n'est ni montré ni réécrit. Chaque ligne garde ses
   propres écarts - l'un a la mauvaise date, l'autre aussi le mauvais prix -
   et c'est ligne par ligne que l'écriture les envoie (igdbCharge). */
function igdbCleGroupe(l){
  return l.fiche.id + '|' + l.surete + (l.surete === 'sure' ? '' : '|' + norm(l.g.name));
}
function igdbGroupes(lignes){
  const par = new Map();
  lignes.forEach(l=>{
    const cle = igdbCleGroupe(l);
    if(!par.has(cle)) par.set(cle, []);
    par.get(cle).push(l);
  });
  const groupes = [...par.values()];
  /* Une seule case pour tout le groupe. Deux groupes peuvent se rejoindre
     après « Changer de jeu », l'un coché, l'autre pas : la case dit alors
     oui, et le dit pour toutes ses lignes, pour que ce qui part soit bien
     ce qu'elle montre. */
  groupes.forEach(gr=>{
    const coche = gr.some(l => l.coche);
    gr.forEach(l=>{ l.coche = coche; });
  });
  return groupes;
}
/* Ce qu'il y avait avant, ligne par ligne : une seule valeur si tous les
   journaux disaient la même chose, sinon chacune, séparées d'une barre. */
function igdbAvants(lignes, lire){
  return [...new Set(lignes.map(lire))].join(' / ');
}
function igdbOu(gr){
  const ou = gr.map(x => x.g.pseudo ? x.g.pseudo + ' · ' + x.g.bucket : x.g.bucket);
  return ou.length > 3 ? ou.slice(0, 3).join(', ') + ` +${ou.length - 3}` : ou.join(', ');
}
function igdbLigneHTML(gr, i){
  const l = gr[0], f = l.fiche;
  const meme = norm(f.titre) === norm(l.g.name);
  const dates = gr.filter(x => x.date), prix = gr.filter(x => x.prix);
  const detail = (gr.find(x => x.detail) || {}).detail;
  return `<label class="igdb-ligne">
    <input type="checkbox" data-i="${i}"${l.coche ? ' checked' : ''}>
    <span class="igdb-corps">
      <b class="igdb-nom">${esc(l.g.name)} <em>${esc(igdbOu(gr))}</em></b>
      <span class="igdb-match">${meme ? '' : esc(f.titre) + ' · '}${esc(f.date || 'date inconnue')} <i
        class="igdb-tag ${l.surete}">${esc(SURETE[l.surete] || '')}</i></span>
      ${dates.length ? igdbDelta('Date',
        igdbAvants(dates, x => x.date.avant ? dateFmt(x.date.avant) : 'aucune'),
        dateFmt(dates[0].date.apres)) : ''}
      ${prix.length ? igdbDelta('Prix',
        igdbAvants(prix, x => money(x.prix.avant)), money(prix[0].prix.apres)) : ''}
      ${detail ? `<span class="igdb-delta"><u>Fiche</u>
        <b class="igdb-ap">${esc([detail.developpeur, detail.genres, detail.themes].filter(Boolean).join(' · ') || 'plateforme, genres et thèmes')}</b></span>` : ''}
    </span>
    ${l.surete === 'sure' ? '' :
      `<button type="button" class="igdb-fiche-btn" data-corr="${i}">Changer de jeu</button>`}
  </label>`;
}
/* Les jeux dont le rapprochement n'est pas sûr. Ce sont les seuls qui
   demandent un œil : sur toute la base, la liste des changements se compte
   en centaines de lignes, dont l'immense majorité sont des dates que
   personne ne relira une par une. Les douteuses, elles, arrivent décochées
   et il faut bien aller les chercher - d'où le filtre. */
function igdbAVerifier(l){
  return l.surete !== 'sure';
}
function igdbRevue(){
  IGD.etape = 'revue';
  IGD.file = igdbFileJaquettes();
  const groupes = igdbGroupes(IGD.lignes.filter(igdbAChanger));
  const rates = igdbRates();
  const flous = groupes.filter(gr => igdbAVerifier(gr[0]));
  // le filtre ne survit pas à une liste qui n'a plus rien de douteux : il
  // laisserait une liste vide sans que rien ne dise pourquoi
  if(!flous.length) IGD.filtre = false;
  igdbEntete(IGD.source === 'nuit' ? 'Analyse de la nuit' : 'Ce qui va changer');

  // les jeux et non les lignes : douze « Elden Ring » sont une seule question
  const nJeux = new Set(IGD.lignes.map(l => l.cle)).size;
  const nJaq = IGD.file.length;
  const hors = IGD.horsRapport;
  igdbCorps().innerHTML = `
    <p class="igdb-info">
      ${IGD.source === 'nuit' && IGD.rapportNuit ? `Faite le ${esc(igdbQuand(IGD.rapportNuit.debut))}, comparée à la base telle qu'elle est maintenant. ` : ''}
      <b>${nJeux}</b> jeu${igdbPluriel(nJeux)} analysé${nJeux > 1 ? 's' : ''} :
      <b>${groupes.length}</b> à corriger${flous.length ? `, dont <b>${flous.length}</b> à vérifier` : ''}${
        nJaq ? `, <b>${nJaq}</b> jaquette${nJaq > 1 ? 's' : ''} à proposer` : ''}.${
        IGD.passes ? ` <b>${IGD.passes}</b> jeu${igdbPluriel(IGD.passes)} déjà complet${
          IGD.passes > 1 ? 's' : ''}, non interrogé${IGD.passes > 1 ? 's' : ''}.` : ''}${
        hors ? ` <b>${hors}</b> ligne${hors > 1 ? 's' : ''} ajoutée${hors > 1 ? 's' : ''} ou modifiée${
          hors > 1 ? 's' : ''} depuis n'y figure${hors > 1 ? 'nt' : ''} pas.` : ''}
      ${groupes.length ? `Seules les cellules « Date de sortie », « Prix de base »${
        IGD.opts.detail ? ' et la fiche détaillée (plateforme, développeur, genres, thèmes)' : ''} sont touchées.` : ''}
    </p>
    ${flous.length ? `<label class="fld fcheck igdb-filtre">
      <input type="checkbox" id="igdb_flous"${IGD.filtre ? ' checked' : ''}>
      <span>N'afficher que les ${flous.length} jeu${igdbPluriel(flous.length)} à vérifier</span></label>` : ''}
    ${groupes.length
      ? `<div class="igdb-liste">${groupes.map((gr,i)=>
          (!IGD.filtre || igdbAVerifier(gr[0])) ? igdbLigneHTML(gr, i) : '').join('')}</div>`
      : `<p class="igdb-note">Rien à corriger${nJaq ? ' - il reste les jaquettes.' : " : tout est déjà à jour."}</p>`}
    ${rates.length ? `<details class="igdb-repli">
      <summary>${rates.length} jeu${rates.length > 1 ? 'x' : ''} sans réponse d'IGDB</summary>
      ${igdbMotifsHTML(rates.map(gr => gr[0]))}
      <ul>${rates.map(gr=>{
        const qui = [...new Set(gr.map(l => l.g.pseudo).filter(Boolean))].join(', ');
        return `<li>${esc(gr[0].g.name)}${qui ? ` <em>${esc(qui)}</em>` : ''} <i>- ${esc(motifLigne(gr[0]))}</i></li>`;
      }).join('')}</ul>
    </details>` : ''}
    <div class="frow">
      ${groupes.length ? `<button class="ghost" id="igdb_tous">Cocher ${IGD.filtre ? 'la liste' : 'tout'}</button>
        <button class="ghost" id="igdb_aucun">Décocher ${IGD.filtre ? 'la liste' : 'tout'}</button>` : ''}
      <span class="spacer"></span>
      <button class="ghost" id="igdb_annuler">Annuler</button>
      <button class="cta auto" id="igdb_ok"></button>
    </div>`;

  /* data-i pointe dans `groupes`, pas dans IGD.lignes : c'est la liste des
     jeux à corriger qui est indexée, un groupe par jeu. Elle n'est pas
     forcément affichée en entier - le filtre peut n'en montrer qu'une
     partie - mais l'index, lui, reste celui de `groupes` : une case cochée
     doit désigner le même jeu que le filtre soit mis ou non. Cocher un jeu
     coche chacune de ses lignes, dans chaque journal. */
  const pose = (c, v)=>{ c.checked = v; groupes[+c.dataset.i].forEach(l=>{ l.coche = v; }); };
  igdbCorps().querySelectorAll('.igdb-ligne input').forEach(c=>{
    c.onchange = ()=>{ pose(c, c.checked); igdbBouton(); };
  });
  /* Cocher ce qui est SOUS LES YEUX, et non tout le rapport : filtrer sur
     les jeux à vérifier puis « Décocher la liste » écarte d'un geste tout ce
     dont on n'est pas sûr, en laissant passer le reste. C'est justement la
     raison d'être du filtre, et c'est pourquoi les deux boutons changent de
     nom quand il est mis. */
  const cocher = v => igdbCorps().querySelectorAll('.igdb-ligne input').forEach(c => pose(c, v));
  if($('igdb_flous')) $('igdb_flous').onchange = e=>{
    IGD.filtre = e.target.checked;
    igdbRevue();               // la liste se redessine, les cases gardent leur état
  };
  /* « Changer de jeu » : le bouton vit dans le <label> de la ligne, donc un
     clic cocherait la case en passant - d'où le preventDefault. */
  igdbCorps().querySelectorAll('.igdb-fiche-btn').forEach(b=>{
    b.onclick = e=>{
      e.preventDefault(); e.stopPropagation();
      corrigeFiche(groupes[+b.dataset.corr]);
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
/* Les jeux restés sans réponse, une entrée par question posée : le même
   jeu raté dans trois journaux est un seul échec, pas trois. */
function igdbRates(){
  const par = new Map();
  IGD.lignes.forEach(l=>{
    if(l.etat === 'ok') return;
    if(!par.has(l.cle)) par.set(l.cle, []);
    par.get(l.cle).push(l);
  });
  return [...par.values()];
}
/* Pourquoi une ligne n'a rien donné. « Aucune fiche trouvée » veut dire
   qu'IGDB a répondu mais ne connaît pas ce titre ; tout le reste est une
   panne de liaison, et c'est le motif exact qui permet d'y remédier. */
function motifLigne(l){
  if(l.etat === 'introuvable') return 'aucune fiche trouvée';
  return l.raison || 'IGDB injoignable';
}
/* Les échecs regroupés par motif. Trente jeux qui échouent pour la même
   raison, c'est un seul problème à régler - la liste nom par nom, elle, ne
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
   Sur un titre que plusieurs jeux portent - « Doom », « God of War »,
   « Tomb Raider » - ou qu'IGDB n'a pas reconnu, le rapprochement
   automatique se trompe. La date de sortie tranche presque toujours (elle
   suffit pour 96 % du journal), mais quand elle ne suffit pas, seul un
   œil humain peut décider. La grille des jaquettes sert déjà exactement à
   ça ailleurs : on la réutilise telle quelle, titres et dates affichés.

   La fiche retenue est celle qui sera écrite : c'est son identifiant qui
   part, et le serveur en tire plateforme, développeur et genres. Elle vaut
   pour toutes les lignes du jeu (voir igdbGroupes) : c'est le même titre
   rapproché de la même fiche, il se trompait partout pareil. */
async function corrigeFiche(gr, terme){
  const l = gr[0];
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
    gr.forEach(x=>{
      x.fiche = choix;
      x.surete = 'sure';            // choisi à la main : plus rien à deviner
      x.rattache = true;            // l'identifiant part, options ou pas
      /* on repart du choix : la date suit la fiche, et les trois colonnes
         seront relues côté serveur à partir de l'identifiant. Le prix, lui,
         était celui de la fiche écartée : il ne part pas, la prochaine
         analyse demandera celui de la bonne. */
      x.date = (IGD.opts.dates && choix.iso && choix.iso !== (x.g.release || ''))
        ? {avant: x.g.release || '', apres: choix.iso} : null;
      x.prix = null;
      if(IGD.opts.detail) x.detail = {plateforme: null, developpeur: null, genres: null, themes: null};
      x.coche = igdbAChanger(x);
    });
    igdbRevue();                    // la liste se redessine avec le nouveau choix
  }, null, {
    titre: `Quel jeu est « ${l.g.name} » ?`,
    terme: cherche,
    surRecherche: t => corrigeFiche(gr, t),
  });
}

/* Le bouton principal dit ce qu'il va faire, et il change à chaque case
   décochée : « Écrire 12 jeux (15 lignes) », puis « Voir les jaquettes »,
   puis « Fermer » quand il ne reste plus rien. Les lignes entre
   parenthèses quand un jeu est dans plusieurs journaux : c'est ce que
   l'écriture va réellement toucher. */
function igdbBouton(){
  const b = $('igdb_ok');
  if(!b) return;
  const lignes = IGD.lignes.filter(l => l.coche && igdbAChanger(l));
  const n = lignes.length;
  const jeux = new Set(lignes.map(igdbCleGroupe)).size;
  if(n) b.textContent = `Écrire ${jeux} jeu${igdbPluriel(jeux)}` + (n > jeux ? ` (${n} lignes)` : '');
  else if(IGD.file.length) b.textContent = `Voir les ${IGD.file.length} jaquette${IGD.file.length > 1 ? 's' : ''}`;
  else b.textContent = 'Fermer';
}

/* ---------- étape 4 : l'écriture ---------- */
/* Ce qui part pour un jeu : les deux champs concernés, pas un de plus.
   Le serveur ne touche qu'aux champs présents dans `values` - la note, le
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

/* Écriture par paquets : un aller-retour pour vingt jeux au lieu de vingt.
   C'est le voyage qui coûte, pas l'écriture - et sur toute la base, vingt
   lignes à la fois font la différence entre une minute et vingt.

   Vingt et pas cent (ce que le serveur accepte, voir LOT_MAXI) : chaque jeu
   rattaché à une fiche neuve fait relire cette fiche à IGDB, et un paquet
   trop gros finirait par tenir la requête ouverte plus longtemps que ne le
   supporte le proxy. */
const IGDB_LOT = 20;

/* Écrit un paquet et renvoie les motifs d'échec, un par jeu. Les compteurs
   sont tenus ici : c'est le seul endroit qui sache exactement lequel des
   jeux est passé et lequel a résisté. */
async function igdbEnvoyerPaquet(paquet){
  const echecs = [], utiles = [];
  paquet.forEach(l=>{
    try{ utiles.push({ligne: l, charge: igdbCharge(l)}); }
    catch(e){ echecs.push(`${l.g.name} - ${e.message || 'erreur inconnue'}`); }
  });
  if(!utiles.length) return echecs;
  const compter = u => {
    if(u.ligne.date) IGD.compte.dates++;
    if(u.ligne.prix) IGD.compte.prix++;
    if(u.ligne.detail || u.ligne.rattache) IGD.compte.detail++;
  };

  try{
    /* La route d'administration, pas celle du propriétaire : le paquet peut
       tenir les jeux de dix journaux différents. Elle ne renvoie pas le
       classeur relu - il y en aurait dix - mais seulement ce qui a raté ;
       la page relit le journal affiché une fois l'écriture finie. */
    const dit = await envoiBrut('PUT', '/api/journal/admin/lot',
                                {modifs: utiles.map(u => u.charge)});
    const refuses = ((dit.fait || {}).echecs) || [];
    const rates = {};
    refuses.forEach(e=>{
      rates[e.i] = true;
      /* Le nom vient d'ici et non de la réponse : l'écriture n'envoie que
         les colonnes d'IGDB, donc pas le nom du jeu, et le serveur n'a rien
         à citer dans son motif d'échec. */
      const rate = utiles[e.i];
      echecs.push(`${(rate && rate.ligne.g.name) || e.jeu || '?'} - ${e.error}`);
    });
    utiles.forEach((u,k)=>{ if(!rates[k]) compter(u); });
    if(refuses.length < utiles.length) IGD.ecrit = true;
    return echecs;
  }catch(e){
    // panne franche : le paquet entier n'est pas passé, on le dit
    const motif = e.message || 'erreur inconnue';
    return echecs.concat(utiles.map(u => `${u.ligne.g.name} - ${motif}`));
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
  igdbEntete('Écriture en base');
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

  /* Le classeur affiché est relu une seule fois, à la fin, plutôt qu'un
     rendu complet par paquet - et seulement s'il a pu changer. Les autres
     journaux touchés se reliront tout seuls chez leurs propriétaires. */
  igdbRelitLeClasseur();
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
        <button class="jaq-item${p.suggere ? ' suggeree' : ''}" data-i="${i}">
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
    b.onclick = ()=> igdbPoser(b, e, e.propositions[+b.dataset.i]);
  });
}
async function igdbPoser(btn, entree, choix){
  const nom = entree.nom;
  const jeton = ++IGD.jeton;
  igdbCorps().querySelectorAll('.jaq-item').forEach(b=>{ b.disabled = true; });
  btn.classList.add('pris');
  /* Le jeu est d'abord relu dans GAMES : l'écriture vient de passer, et
     c'est elle qui a pu lui donner son identifiant IGDB. À défaut - un jeu
     d'un autre journal, que la page n'affiche pas - c'est celui que la file
     a retenu à la relecture. */
  const jeu = GAMES.find(x => x.id === entree.jeuId);
  const idIgdb = (jeu && jeu.idIgdb) || entree.idIgdb || null;
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
    toast('Téléchargement impossible' + (data && data.raison ? ' - ' + data.raison : ''), true);
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
      ? '<p class="igdb-note">Rien à changer : tout était déjà à jour.</p>' : ''}
    ${c.echecs ? `<div class="ferr">${c.echecs} ligne${c.echecs > 1 ? 's n\'ont' : " n'a"} pas pu être écrite${c.echecs > 1 ? 's' : ''} :<br>${IGD.echecs.map(esc).join('<br>')}</div>` : ''}
    <div class="frow"><span class="spacer"></span>
      <button class="cta auto" id="igdb_fin">Fermer</button></div>`;
  $('igdb_fin').onclick = fermerIgdb;
}

fermeSurFond('igdb', fermerIgdb);
$('igdbBtn').addEventListener('click', ouvrirIgdb);
