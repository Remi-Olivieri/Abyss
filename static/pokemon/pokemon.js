/* =========================================================
   La collection Pokémon

   Une cousine du classeur Yu-Gi-Oh, dont elle reprend la reliure, les pages
   qui tournent, la carte qu'on sort de sa pochette, l'annuaire et l'adresse
   qu'on peut donner (/pokemon/<pseudo>). Trois choses changent :

     - le classeur n'est plus une liste de familles mais le catalogue : des
       blocs (« Écarlate et Violet »), leurs séries (« 151 »), et une série
       par classeur. On arrive sur les blocs, on ouvre une série ;
     - une carte a des versions - normale, reverse, holo... - et chacune se
       possède à part. Une pastille par version, un clic l'ajoute ou la
       retire, et rien ne se recharge : la carte, la jauge et la tuile de la
       série suivent sur place ;
     - une série se filtre : possédées, manquantes, et quelle version
       manque. En grille, seules les cartes qui répondent restent ; dans le
       classeur, les autres s'effacent sans quitter leur pochette.

   Le Pokédex croise les séries : tous les Pokémon, puis toutes les cartes
   de l'un d'eux, de série en série, qui se rangent comme dans la grille.

   Le catalogue vient de TCGdex (voir pokemon_stock.py) ; ce que chacun
   possède, de la base (voir pokemon.py).
   ========================================================= */

const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* Les versions, dans l'ordre de pokemon.VERSIONS. La lettre est ce que le
   serveur envoie et reçoit. */
const VERSIONS = ['N', 'R', 'H', 'E', 'W'];
const NOM_VERSION = { N:'Normale', R:'Reverse', H:'Holo', E:'1re édition', W:'Promo W' };
const LETTRE = { N:'N', R:'R', H:'H', E:'1re', W:'W' };
const NOM_CATEGORIE = { P:'Pokémon', D:'Dresseur', E:'Énergie' };

/* Une carte est un petit tableau, comme dans le classeur Yu-Gi-Oh (voir
   ligne_de dans pokemon.py) :

     [0] numéro   [1] nom   [2] rareté   [3] versions (« NR »)
     [4] catégorie   [5] fichier de l'image   [6] versions possédées */
const NUM = 0, NOM = 1, RAR = 2, VER = 3, CAT = 4, ART = 5, POS = 6;
/* La page d'un Pokémon y ajoute deux cases, ses cartes venant de toutes les
   séries (voir vue_pokemon) : [7] la série   [8] le type (« ex », « mega »...) */
const SID = 7, FRM = 8;
/* Un Pokémon du Pokédex (voir vue_pokedex) :
     [0] numéro   [1] nom   [2] cartes   [3] possédées   [4] portrait */
const P_NUM = 0, P_NOM = 1, P_TOT = 2, P_POS = 3, P_IMG = 4;

/* Le format du classeur, série par série : pochettes par face, pages par
   classeur (vide : juste la taille de la série), une pochette par version
   ou par carte. Voir « le format du classeur » dans pokemon.py. */
const FORMAT_DEFAUT = { colonnes: 3, rangees: 3, pages: null, versions: false };
const FORMAT_BORNES = { colonnes: [2, 4], rangees: [2, 4], pages: [5, 100] };

let MOI = { connecte: false, pseudo: null, compte: null, admin: false };
let SOURCES = [];        // l'annuaire : les collections qu'on peut ouvrir
let SRC = 0;
let CAN_WRITE = false;
let ENS = null;          // la vue d'ensemble : blocs, séries, ce qu'on en a
let SER = null;          // la série ouverte
let PDX = null;          // le Pokédex de la collection
let PK = null;           // le Pokémon ouvert, ou le dernier qu'on a vu
let VUE = 'aucune';      // 'blocs' | 'serie' | 'pokedex' | 'pokemon' | 'aucune'
let MODE = 'classeur';   // 'classeur' | 'grille'
let COMMENCEES = false;
const FILTRE = { etat: 'toutes', rarete: '', texte: '' };
const FILTRE_PK = { forme: '', etat: 'toutes' };
const S = { c: 0, spread: 0, sel: null, zoom: false, hit: null, pose: null };

try {
  MODE = localStorage.getItem('pokemon-mode') === 'grille' ? 'grille' : 'classeur';
  COMMENCEES = localStorage.getItem('pokemon-commencees') === '1';
} catch(e){}

const narrow = () => matchMedia('(max-width:900px)').matches;
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const source = () => SOURCES[SRC] || null;
const urlCollection = pseudo => '/api/pokemon/' + encodeURIComponent(pseudo);

/* ---------------- normalisation : recherche et pseudos ---------------- */
function norm(s){
  return String(s == null ? '' : s).replace(/[œŒ]/g, 'oe').replace(/[æÆ]/g, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,' ').trim();
}
function initiales(nom){
  const mots = String(nom || '?').trim().split(/\s+/).filter(Boolean);
  return ((mots[0] || '?')[0] + (mots.length > 1 ? mots[mots.length - 1][0] : '')).toUpperCase();
}
function teinteAvatar(nom){
  let h = 0;
  for (const c of (nom || '?')) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}
const pluriel = n => n > 1 ? 's' : '';
const nombre = n => Number(n || 0).toLocaleString('fr-FR');
function dateFr(d){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
  return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
}
const annee = d => (/^(\d{4})/.exec(d || '') || [])[1] || '';

/* ---------------- ce que la carte a, ce qu'on en a ---------------- */
const possede = (c, v) => !!c && String(c[POS] || '').indexOf(v) >= 0;
const aUne = c => !!(c && c[POS]);
const complete = c => String(c[VER]).split('').every(v => possede(c, v));
const ordonne = s => VERSIONS.filter(v => s.indexOf(v) >= 0).join('');
/* Les pastilles d'une carte : ses versions, plus une autre qu'on aurait
   déjà rangée - une version possédée ne disparaît jamais. */
const versionsMontrees = c => ordonne(String(c[VER]) + String(c[POS] || '')).split('');
/* Deux cases par carte, quoi que TCGdex distingue (voir versions_de dans
   pokemon.py) : la carte elle-même, et sa reverse quand elle en a une. La
   première garde la lettre de sa version - N, ou H pour une holo, d'où son
   reflet -, mais se dit toujours « Possédée ». */
const principale = c => String(c[VER]).replace('R', '')[0] || 'R';
function nomVersion(c, v){
  if (v === principale(c)) return 'Possédée';
  return v === 'R' ? 'Reverse' : NOM_VERSION[v];
}

/* « 001/198 » comme sur la carte, quand le numéro est un nombre ; « TG12 »
   tel quel sinon. */
function numeroDe(c){
  const n = String(c[NUM]), off = SER && SER.serie.officiel;
  return /^\d+$/.test(n) && off ? n + '/' + String(off).padStart(n.length, '0') : n;
}

/* ---------------- l'annuaire, qui suis-je ---------------- */
async function chargeAnnuaire(){
  const r = await fetch('/api/pokemon', { credentials: 'same-origin' });
  const d = await r.json().catch(() => null);
  if (!d || !d.ok) throw new Error((d && d.message) || 'annuaire illisible');
  MOI = { connecte: !!d.connecte, pseudo: d.moi ? d.moi.pseudo : null, compte: d.compte || null,
          admin: d.admin === true };
  SOURCES = (d.classeurs || []).map(c => ({
    nom: c.pseudo, cartes: c.cartes, avatar: c.avatar, banniere: c.banniere,
    url: urlCollection(c.pseudo),
  }));
  /* La sienne d'abord, même privée : c'est celle qu'on vient voir neuf fois
     sur dix, et la seule qu'on puisse modifier. */
  if (MOI.pseudo){
    const i = SOURCES.findIndex(x => x.nom === MOI.pseudo);
    if (i > 0) SOURCES.unshift(SOURCES.splice(i, 1)[0]);
    else if (i < 0) SOURCES.unshift({ nom: MOI.pseudo, url: urlCollection(MOI.pseudo) });
    Object.assign(SOURCES[0], { moi: true, cartes: d.moi.cartes, avatar: d.moi.avatar,
                                banniere: d.moi.banniere });
  }
  el('stockBtn').hidden = !MOI.admin;
}

/* La pastille de l'engrenage : verte en ligne, ambrée pendant une
   actualisation, rouge si elle a échoué. Même code que le classeur Yu-Gi-Oh. */
function setSync(mode, txt){
  const g = el('gear');
  g.dataset.etat = mode;
  g.setAttribute('aria-label', 'Réglages - ' + txt);
}

let toastT;
function toast(msg, bad){
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 4200);
}

/* ---------------- le cache de la vue d'ensemble ----------------
   Affichée tout de suite au chargement, le temps que la vraie requête
   reparte en arrière-plan : une clé par collection. */
const cleCache = url => 'pokemon-data:' + url;
function lireCache(url){
  try { return JSON.parse(localStorage.getItem(cleCache(url))); } catch(e){ return null; }
}
function ecrireCache(url, d){
  try { localStorage.setItem(cleCache(url), JSON.stringify(d)); } catch(e){}
}

/* =========================================================
   Les écrans
   ========================================================= */
const VUES = ['gate', 'invite', 'accueil', 'vueBlocs', 'vueSerie', 'vuePokedex', 'vuePokemon'];
const montreSeule = id => VUES.forEach(k => { el(k).hidden = k !== id; });
function cacheTout(){
  fermerNet(); fermerRecherche(); closeMenu(); fermerModale();
  montreSeule(null);
}

/* Où l'on en était dans une liste, pour y retomber en revenant : c'est la
   page qui défile sur un téléphone, la liste elle-même sur un grand écran
   (voir pokemon.css). La page d'un Pokémon ne reprend que le même. */
const DEFILE = {};
const DEFILANTS = { blocs: 'blocs', pokedex: 'pokedex', pokemon: 'pkGrille' };
function retiensDefile(){
  if (!DEFILANTS[VUE]) return;
  DEFILE[VUE] = { fenetre: scrollY, liste: el(DEFILANTS[VUE]).scrollTop,
                  n: VUE === 'pokemon' && PK ? PK.pokemon.numero : null };
}
function rendsDefile(vue, n){
  const d = DEFILE[vue];
  const ok = d && (vue !== 'pokemon' || d.n === n);
  el(DEFILANTS[vue]).scrollTop = ok ? d.liste : 0;
  scrollTo(0, ok ? d.fenetre : 0);
}
function outils(visibles){
  el('gear').hidden = !visibles;
  el('shine').hidden = !visibles;
}

function showGate(erreur, refus){
  cacheTout();
  VUE = 'aucune';
  const s = source();
  majEntete();
  setSync('offline', s ? 'non connecté' : 'aucune collection');
  outils(!!s);
  cacheSaut();
  el('gTitle').textContent = refus ? 'Cette collection ne peut pas être ouverte'
    : (s ? 'Cette collection ne répond pas' : 'Aucune collection');
  el('gMsg').textContent = refus || !s ? ''
    : 'Le serveur d’Abyss n’a pas renvoyé la collection de ' + (s.nom || '?') + '.';
  el('gErr').hidden = !erreur;
  if (erreur) el('gErr').innerHTML = erreur;
  el('gRetry').hidden = !s || !!refus;
  el('gate').hidden = false;
}

function ecranSansCollection(quel){
  cacheTout();
  VUE = 'aucune';
  SRC = -1;
  CAN_WRITE = false;
  ENS = null; SER = null;
  el('brand-title').textContent = 'Collection Pokémon';
  cacheSaut();
  outils(false);
  majVerrou();
  el(quel).hidden = false;
}
function showInvite(){ ecranSansCollection('invite'); }
function showAccueil(){ ecranSansCollection('accueil'); monteRecherche(el('accueilRech')); }

function majEntete(){
  const s = source();
  el('brand-title').textContent = s && s.nom
    ? (s.moi ? 'Ma collection' : 'Collection de ' + s.nom) : 'Collection Pokémon';
}

function majVerrou(){
  el('homeBtn').hidden = !MOI.pseudo || CAN_WRITE;
  el('unlock').hidden = CAN_WRITE;
  el('favBtn').hidden = !CAN_WRITE;
  el('formatBtn').hidden = !CAN_WRITE;
  el('unlock').textContent = !MOI.connecte ? 'Se connecter sur Abyss'
    : MOI.pseudo ? 'Ouvrir ma collection' : 'Créer ma collection';
  if (S.sel !== null) majPanel();
}

/* =========================================================
   La recherche : quelle collection ouvrir
   Le même contenu dans sa fenêtre et sur l'écran du visiteur, d'où des
   classes et aucun identifiant. Repris du classeur Yu-Gi-Oh.
   ========================================================= */
const LOUPE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"'
  + ' stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';

function monteRecherche(hote){
  hote.innerHTML = '<label class="rsearch-box">' + LOUPE
    + '<input class="rsearch-input" type="text" placeholder="Nom du collectionneur..."'
    + ' autocomplete="off" spellcheck="false" aria-label="Rechercher une collection"></label>'
    + '<div class="rsearch-list"></div>';
  const champ = hote.querySelector('.rsearch-input');
  const liste = hote.querySelector('.rsearch-list');
  function dessine(){
    const brut = champ.value, q = norm(brut);
    const items = SOURCES.map((s, i) => ({ s: s, i: i })).filter(x => !q || norm(x.s.nom).includes(q));
    if (!items.length){
      liste.removeAttribute('role');
      liste.innerHTML = '<p class="rsearch-vide">' + esc('Aucune collection ne correspond à « ' + brut + ' ».') + '</p>';
      return;
    }
    liste.setAttribute('role', 'list');
    liste.innerHTML = items.map(x => {
      const s = x.s;
      const n = typeof s.cartes === 'number' ? s.cartes + ' carte' + pluriel(s.cartes) : 'collection publique';
      const sous = s.moi ? 'Ta collection - ' + n : n.charAt(0).toUpperCase() + n.slice(1);
      const avatar = s.avatar
        ? '<img class="rsearch-avatar" src="' + esc(s.avatar) + '" alt="">'
        : '<span class="rsearch-avatar" style="--h:' + teinteAvatar(s.nom) + '">' + esc(initiales(s.nom)) + '</span>';
      return '<button class="rsearch-item' + (x.i === SRC ? ' on' : '') + (s.banniere ? ' rsearch-orne' : '')
        + '" data-i="' + x.i + '">' + avatar
        + '<span class="rsearch-meta"><b>' + esc(s.nom || '?') + '</b><i>' + esc(sous) + '</i></span>'
        + (x.i === SRC ? '<span class="tick">✓</span>' : '') + '</button>';
    }).join('');
    liste.querySelectorAll('.rsearch-item').forEach(b => {
      b.onclick = () => choisirCollection(+b.dataset.i);
      const s = SOURCES[+b.dataset.i];
      if (s && s.banniere) b.style.setProperty('--banniere', 'url("' + s.banniere + '")');
    });
  }
  champ.addEventListener('input', dessine);
  champ.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const premier = liste.querySelector('.rsearch-item');
    if (premier) premier.click();
  });
  dessine();
  return { champ: champ };
}
function fermerRecherche(){
  const host = el('recherche');
  if (host.hidden) return;
  host.hidden = true;
  host.innerHTML = '';
}
function ouvrirRecherche(){
  closeMenu();
  const host = el('recherche');
  host.innerHTML = '<div class="rsearch-sheet" role="dialog" aria-modal="true" aria-label="Rechercher une collection">'
    + '<div class="rsearch-tete"><b>Rechercher une collection</b>'
    + '<button class="rsearch-x" aria-label="Fermer">&times;</button></div>'
    + '<div class="rsearch-in"></div></div>';
  host.hidden = false;
  host.querySelector('.rsearch-x').onclick = fermerRecherche;
  monteRecherche(host.querySelector('.rsearch-in')).champ.focus();
}
el('recherche').addEventListener('click', e => { if (e.target === el('recherche')) fermerRecherche(); });
el('jnlSearchBtn').addEventListener('click', e => { e.stopPropagation(); ouvrirRecherche(); });

function choisirCollection(i){
  fermerRecherche();
  if (i === SRC || !SOURCES[i]) return;
  SRC = i;
  ENS = null; SER = null; PDX = null; PK = null; CAN_WRITE = false;
  Object.keys(DEFILE).forEach(k => { delete DEFILE[k]; });
  majEntete(); majVerrou();
  ouvrirEnsemble({});
}

/* =========================================================
   L'adresse : /pokemon/<pseudo>?serie=<serie>, ?pokedex, ?pokemon=<numéro>
   Une collection a son adresse, une série et un Pokémon aussi : un
   rechargement retombe dessus, et un lien partagé montre ce qu'il promet.
   Ouvrir une série, le Pokédex ou un Pokémon ajoute une entrée à
   l'historique - le bouton Retour, ou le geste du téléphone, ramène d'où
   l'on vient, comme on l'attend d'une page qu'on a « ouverte ». Changer
   de collection, lui, remplace l'adresse.
   ========================================================= */
function pseudoDeURL(){
  const m = location.pathname.match(/^\/pokemon\/([^/]+)\/?$/);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch(e){ return m[1]; }
}
/* Ce que l'adresse demande : { serie }, { pokemon }, { pokedex }, ou {}
   pour les blocs. */
function cibleDeURL(){
  const p = new URLSearchParams(location.search);
  if (p.get('serie')) return { serie: p.get('serie') };
  const n = parseInt(p.get('pokemon'), 10);
  if (n > 0) return { pokemon: n };
  return p.has('pokedex') ? { pokedex: true } : {};
}
function allerA(cible, pousser){
  if (cible.serie) ouvrirSerie(cible.serie, { pousser: pousser });
  else if (cible.pokemon) ouvrirPokemon(cible.pokemon, { pousser: pousser });
  else if (cible.pokedex) montrerPokedex({ pousser: pousser });
  else { majAdresse('', pousser); montrerBlocs(); }
}
/* `q` : la requête sans son « ? » - « serie=sv01 », « pokedex »... */
function adresse(q){
  const s = source();
  return ((s && s.nom) ? '/pokemon/' + encodeURIComponent(s.nom) : '/pokemon') + (q ? '?' + q : '');
}
/* Une entrée poussée par la page porte `interne` : la flèche de retour peut
   alors revenir en arrière dans l'historique. Arrivé par une adresse, elle
   sortirait du site - elle remplace plutôt l'adresse par celle d'au-dessus
   (voir retour). Remplacer l'adresse garde ce qu'on savait de l'entrée. */
function majAdresse(q, pousser){
  const voulue = adresse(q);
  if (location.pathname + location.search === voulue) return;
  const interne = !!pousser || !!(history.state && history.state.interne);
  try {
    if (pousser) history.pushState({ interne: true }, '', voulue);
    else history.replaceState({ interne: interne }, '', voulue);
  } catch(e){}
}
function retour(parent){
  if (history.state && history.state.interne) history.back();
  else allerA(parent, false);
}
addEventListener('popstate', () => {
  if (SRC < 0 || !source()) return;
  allerA(cibleDeURL(), false);
});
function rangDeLaCollection(nom){
  const i = SOURCES.findIndex(x => norm(x.nom) === norm(nom));
  if (i >= 0) return i;
  SOURCES.push({ nom: nom, url: urlCollection(nom) });
  return SOURCES.length - 1;
}

/* =========================================================
   La vue d'ensemble : les blocs et leurs séries
   ========================================================= */
async function chargeEnsemble(silencieux){
  const s = source();
  let data = null, pourquoi = '', statut = 0;
  try {
    const r = await fetch(s.url, { credentials: 'same-origin' });
    statut = r.status;
    data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok){
      pourquoi = (data && data.message) || ('réponse HTTP ' + r.status);
      data = null;
    }
  } catch(e){ pourquoi = 'serveur injoignable'; }
  if (!data){
    if (silencieux){ setSync('erreur', 'actualisation impossible'); toast(pourquoi, true); return null; }
    const refus = statut === 403 || statut === 404;
    showGate(refus ? '<b>' + esc(pourquoi) + '</b>'
                   : '<b>Impossible de charger la collection.</b> ' + esc(pourquoi), refus);
    return null;
  }
  ecrireCache(s.url, data);
  return data;
}

function appliqueEnsemble(d, frais){
  ENS = d;
  ENS.blocs = Array.isArray(ENS.blocs) ? ENS.blocs : [];
  CAN_WRITE = d.write === true;
  majEntete(); majVerrou();
  setSync(frais ? 'live' : 'stale', frais ? (CAN_WRITE ? 'modifiable' : 'lecture seule') : 'actualisation...');
}

/* Le cache s'affiche tout de suite ; la vraie réponse le remplace dès
   qu'elle arrive. Puis ce que l'adresse demande (`cible`, voir cibleDeURL). */
async function ouvrirEnsemble(o){
  const opts = o || {};
  const s = source();
  if (!s){ showGate(null); return; }
  setSync('offline', 'connexion...');
  const cache = lireCache(s.url);
  const avait = !!(cache && cache.blocs);
  const premier = () => allerA(opts.cible || {}, false);
  if (avait){ appliqueEnsemble(cache, false); premier(); }
  const d = await chargeEnsemble(avait);
  if (!d || source() !== s) return;
  appliqueEnsemble(d, true);
  if (!avait) premier();
  else if (VUE === 'blocs'){ dessineBlocs(); renderSaut(); }
  else if (VUE === 'serie') renderSaut();
}

function montrerBlocs(){
  if (!ENS) return;
  jetonVue++;
  retiensDefile();
  fermerNet();
  VUE = 'blocs';
  SER = null;
  montreSeule('vueBlocs');
  outils(true);
  dessineBlocs();
  renderSaut();
  if (!ENS.blocs.length){
    el('blocs').innerHTML = '<p class="vide">Le catalogue est vide pour l’instant.'
      + (MOI.admin ? ' Le bouton « Mettre à jour », en bas à gauche, va chercher les séries chez TCGdex.' : '')
      + '</p>';
  }
  rendsDefile('blocs');
}

/* La recherche ne vise que les séries : leur nom, leur sigle (« MEW »,
   « OBF ») ou celui de leur bloc. Chaque mot tapé doit s'y trouver, d'où
   « écarlate 151 ». Elle s'ajoute au choix « Commencées ». */
const motsCherches = () => norm(el('qBlocs').value).split(' ').filter(Boolean);
function seriesVisibles(b, mots){
  return b.series.filter(s => {
    if (COMMENCEES && !s.possedees) return false;
    if (!mots.length) return true;
    const ou = norm([b.nom, s.nom, s.sigle, s.id].join(' '));
    return mots.every(m => ou.indexOf(m) >= 0);
  });
}

function dessineBlocs(){
  let cartes = 0, commencees = 0;
  ENS.blocs.forEach(b => b.series.forEach(s => {
    cartes += s.possedees;
    if (s.possedees) commencees++;
  }));
  el('resume').innerHTML = '<b>' + nombre(cartes) + '</b> carte' + pluriel(cartes)
    + ' · <b>' + commencees + '</b> série' + pluriel(commencees) + ' commencée' + pluriel(commencees);
  document.querySelectorAll('[data-commencees]').forEach(b =>
    b.classList.toggle('on', (b.dataset.commencees === '1') === COMMENCEES));
  const mots = motsCherches();
  const html = ENS.blocs.map(b => {
    const series = seriesVisibles(b, mots);
    if (!series.length) return '';
    let own = 0, tot = 0;
    b.series.forEach(s => { own += s.possedees; tot += s.total; });
    const pct = tot ? own / tot * 100 : 0;
    return '<section class="bloc" id="bloc-' + esc(b.id) + '">'
      + '<div class="bloc-tete"><h2>' + esc(b.nom) + '</h2>'
      + '<span class="bloc-info">' + esc([annee(b.date), b.series.length + ' série' + pluriel(b.series.length)]
          .filter(Boolean).join(' · ')) + '</span>'
      + '<span class="bloc-jauge"><span class="bar"><i style="width:' + pct.toFixed(2) + '%"></i></span>'
      + '<span class="val"><b>' + nombre(own) + '</b> / ' + nombre(tot) + '</span></span></div>'
      + '<div class="series">' + series.map(tuileSerie).join('') + '</div></section>';
  }).join('');
  /* rien à montrer : la phrase en grand, au milieu, comme dans la grille */
  const brut = el('qBlocs').value.trim();
  const rien = !mots.length ? 'Aucune série commencée pour l’instant : ouvre une série et range ta première carte.'
    : 'Aucune série' + (COMMENCEES ? ' commencée' : '') + ' ne correspond à « ' + brut + ' ».';
  el('blocs').innerHTML = html || (ENS.blocs.length ? '<p class="vide-grand">' + esc(rien) + '</p>' : '');
  el('blocs').classList.toggle('sans-serie', !html && ENS.blocs.length > 0);
}

function tuileSerie(s){
  const pct = s.total ? s.possedees / s.total * 100 : 0;
  const finie = s.total && s.possedees >= s.total;
  const maitre = s.versions && s.versions_possedees >= s.versions;
  return '<button class="serie' + (finie ? ' finie' : '') + (maitre ? ' maitre' : '')
    + (s.possedees ? ' commencee' : '') + '" data-s="' + esc(s.id) + '">'
    + '<span class="serie-logo">' + logoHTML(s) + '</span>'
    + '<span class="serie-nom">' + esc(s.nom) + '</span>'
    + '<span class="serie-info">' + esc([s.sigle, dateFr(s.date)].filter(Boolean).join(' · ')) + '</span>'
    + '<span class="bar"><i style="width:' + pct.toFixed(2) + '%"></i></span>'
    + '<span class="serie-val"><span><b>' + s.possedees + '</b> / ' + s.total + '</span>'
    + (finie ? '<span class="serie-fin">' + (maitre ? 'Master set' : 'Complète') + '</span>' : '')
    + '</span></button>';
}
function logoHTML(s){
  return s.logo && ENS && ENS.logos
    ? '<img src="' + esc(ENS.logos + s.id + '.webp') + '" alt="" loading="lazy" decoding="async">'
    : '<span class="serie-sigle">' + esc(s.sigle || s.nom) + '</span>';
}

el('blocs').addEventListener('click', e => {
  const b = e.target.closest('.serie[data-s]');
  if (b) ouvrirSerie(b.dataset.s, { pousser: true });
});
document.querySelectorAll('[data-commencees]').forEach(b => b.onclick = () => {
  COMMENCEES = b.dataset.commencees === '1';
  try { localStorage.setItem('pokemon-commencees', COMMENCEES ? '1' : '0'); } catch(e){}
  dessineBlocs(); renderSaut();
});
el('qBlocs').addEventListener('input', () => {
  dessineBlocs(); renderSaut();
  el('blocs').scrollTop = 0;
});
el('qBlocs').addEventListener('keydown', e => {
  if (e.key === 'Enter'){
    const premiere = el('blocs').querySelector('.serie[data-s]');
    if (premiere) premiere.click();
  }
  if (e.key === 'Escape' && el('qBlocs').value){
    el('qBlocs').value = '';
    dessineBlocs(); renderSaut();
  }
});
el('pokedexBtn').onclick = () => montrerPokedex({ pousser: true });

/* La liste qui se déroule, à côté de la recherche : les blocs sur la vue
   d'ensemble, les séries du bloc dans une série - le bouton porte alors le
   nom du bloc -, les générations dans le Pokédex. Une liste et non une
   rangée d'onglets : dix-huit blocs, et jusqu'à vingt-cinq séries dans un
   seul, ne tenaient pas sur une ligne. Elle ne montre que ce que la
   recherche laisse voir : un bloc caché n'a pas où descendre. */
const HOTE_SAUT = { blocs: 'searchBlocs', serie: 'searchSerie', pokedex: 'searchPokedex' };
function renderSaut(){
  fermeSaut();
  let mot = '', items = [];
  if (VUE === 'blocs' && ENS){
    mot = 'Blocs';
    const mots = motsCherches();
    items = ENS.blocs.filter(b => seriesVisibles(b, mots).length)
      .map(b => itemSaut('data-b="' + esc(b.id) + '"', b.nom, annee(b.date)));
  } else if (VUE === 'serie' && ENS && SER){
    const bloc = ENS.blocs.find(b => b.id === SER.serie.bloc);
    const series = bloc ? bloc.series : [];
    mot = bloc ? bloc.nom : '';
    if (series.length > 1) items = series.map(s => itemSaut('data-s="' + esc(s.id) + '"'
      + (s.id === SER.serie.id ? ' aria-current="true"' : ''), s.nom, s.possedees + '/' + s.total));
  } else if (VUE === 'pokedex' && PDX){
    mot = 'Générations';
    const vues = new Set(pokemonVisibles().map(p => generationDe(p[P_NUM])));
    GENERATIONS.forEach((g, k) => {
      if (vues.has(k)) items.push(itemSaut('data-g="' + k + '"', g[2], bornesGeneration(g)));
    });
  }
  const hote = el(HOTE_SAUT[VUE]);
  if (hote && hote.nextElementSibling !== el('saut')) hote.after(el('saut'));
  el('sautMot').textContent = mot;
  el('sautMenu').innerHTML = items.join('');
  el('saut').hidden = !items.length;
}
const itemSaut = (attributs, nom, n) => '<button type="button" class="menu-item saut-item" role="menuitem" '
  + attributs + '><span class="saut-nom">' + esc(nom) + '</span><span class="n">' + esc(n) + '</span></button>';
function fermeSaut(){
  el('sautMenu').hidden = true;
  el('sautBtn').setAttribute('aria-expanded', 'false');
}
function cacheSaut(){
  fermeSaut();
  el('saut').hidden = true;
}
el('sautBtn').onclick = e => {
  e.stopPropagation();
  const ouvrir = el('sautMenu').hidden;
  if (ouvrir){ closeMenu(); fermerRecherche(); }
  el('sautMenu').hidden = !ouvrir;
  el('sautBtn').setAttribute('aria-expanded', ouvrir ? 'true' : 'false');
  /* la série ouverte en vue, sans faire défiler la page */
  const ici = ouvrir && el('sautMenu').querySelector('[aria-current="true"]');
  if (ici) el('sautMenu').scrollTop = ici.offsetTop - el('sautMenu').clientHeight / 2 + ici.offsetHeight / 2;
};
el('sautMenu').onclick = e => {
  const b = e.target.closest('.saut-item'); if (!b) return;
  fermeSaut();
  if (b.dataset.s){
    if (!SER || b.dataset.s !== SER.serie.id) ouvrirSerie(b.dataset.s, { pousser: false });
    return;
  }
  const cible = b.dataset.g !== undefined ? el('gen-' + b.dataset.g) : el('bloc-' + b.dataset.b);
  if (cible) cible.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' });
};
document.addEventListener('click', e => {
  if (!el('sautMenu').hidden && !e.target.closest('.saut')) fermeSaut();
});

/* =========================================================
   Une série
   ========================================================= */
/* Chaque changement de vue prend un jeton : une série ou un Pokémon qui
   arrive après qu'on est passé à autre chose ne s'affiche pas. */
let jetonVue = 0;
async function ouvrirSerie(sid, o){
  const opts = o || {};
  const s = source();
  if (!s || !ENS) return;
  const jeton = ++jetonVue;
  const depuis = VUE;
  retiensDefile();
  landFlip(); fermerNet();
  majAdresse('serie=' + encodeURIComponent(sid), opts.pousser);
  let d = null, pourquoi = '';
  try {
    const r = await fetch(s.url + '/serie/' + encodeURIComponent(sid), { credentials: 'same-origin' });
    d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.ok){ pourquoi = (d && d.message) || 'réponse HTTP ' + r.status; d = null; }
  } catch(e){ pourquoi = 'serveur injoignable'; }
  if (jeton !== jetonVue) return;
  if (!d){
    toast('Série illisible : ' + pourquoi, true);
    majAdresse('', false);
    montrerBlocs();
    return;
  }
  SER = d;
  SER.cartes.forEach(c => { c[POS] = avecAttente(sid, c[NUM], c[POS]); });
  SER.format = formatSur(SER.format);
  CAN_WRITE = d.write === true;
  majVerrou();
  VUE = 'serie';
  S.c = 0; S.spread = 0; S.sel = null; S.hit = null; S.pose = null;
  FILTRE.rarete = '';
  FILTRE.texte = '';
  el('qSerie').value = '';
  relie();
  montreSeule('vueSerie');
  if (depuis !== 'serie') scrollTo(0, 0);
  outils(true);
  dessineTeteSerie();
  dessineFiltres();
  renderSaut();
  afficheMode();
  /* Arrivé par la recherche : on montre la carte, comme le classeur
     Yu-Gi-Oh montre celle qu'on a cherchée. */
  if (opts.carte !== undefined){
    const i = SER.cartes.findIndex(c => c[NUM] === opts.carte);
    if (i >= 0) allerALaCarte(i);
  }
}

function dessineTeteSerie(){
  const s = SER.serie;
  el('sLogo').innerHTML = logoHTML(s);
  el('sNom').textContent = s.nom;
  el('sInfo').textContent = [s.bloc_nom, s.sigle, dateFr(s.date)].filter(Boolean).join(' · ');
  majJauge();
}

/* La jauge : les cartes dont on a au moins une version, puis les versions
   elles-mêmes, pour qui vise le « master set ». */
function majJauge(){
  if (!SER) return;
  let own = 0, ver = 0, verTot = 0;
  SER.cartes.forEach(c => {
    if (aUne(c)) own++;
    const vs = String(c[VER]);
    verTot += vs.length;
    for (const v of vs) if (possede(c, v)) ver++;
  });
  const tot = SER.cartes.length, pct = tot ? own / tot * 100 : 0;
  el('mOwn').textContent = own;
  el('mTot').textContent = tot;
  el('mBar').style.width = pct + '%';
  el('mPct').textContent = pct.toFixed(1).replace('.', ',') + ' %';
  el('mVer').textContent = verTot > tot ? ver + ' / ' + verTot + ' versions' : '';
  /* la tuile de la série, sur la vue d'ensemble, suit sans rien redemander */
  if (ENS){
    ENS.blocs.forEach(b => b.series.forEach(x => {
      if (x.id === SER.serie.id){ x.possedees = own; x.versions_possedees = ver; }
    }));
    const src = source();
    if (src) ecrireCache(src.url, ENS);
  }
}

/* ---------------- les filtres ----------------
   Toutes, possédées, manquantes. Une carte est possédée dès qu'on en a une
   version - la reverse seule suffit -, manquante sinon ; dans un classeur
   à une pochette par version, c'est la pochette qu'on juge. Le filtre
   survit au changement de série : on passe d'une série à l'autre en
   cherchant la même chose. */
try {
  const f = JSON.parse(localStorage.getItem('pokemon-filtre') || 'null');
  if (f && ['toutes', 'possedees', 'manquantes'].indexOf(f.etat) >= 0) FILTRE.etat = f.etat;
} catch(e){}

function dessineFiltres(){
  el('fMode').querySelectorAll('.exp-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === MODE));
  el('fEtat').querySelectorAll('.exp-btn').forEach(b => b.classList.toggle('on', b.dataset.etat === FILTRE.etat));
  const raretes = SER.raretes || [];
  el('fRar').innerHTML = '<option value="">Toutes les raretés</option>'
    + raretes.map(r => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');
  el('fRar').value = raretes.indexOf(FILTRE.rarete) >= 0 ? FILTRE.rarete : '';
  el('fRar').hidden = raretes.length < 2;
}
function filtreChange(){
  try { localStorage.setItem('pokemon-filtre', JSON.stringify({ etat: FILTRE.etat })); } catch(e){}
  dessineFiltres();
  fermerNet();
  if (MODE === 'grille') dessineGrille(); else render();
  majCompte();
}
el('fEtat').addEventListener('click', e => {
  const b = e.target.closest('[data-etat]'); if (!b) return;
  FILTRE.etat = b.dataset.etat;
  filtreChange();
});
el('fRar').addEventListener('change', () => { FILTRE.rarete = el('fRar').value; filtreChange(); });
let texteT = null;
el('qSerie').addEventListener('input', () => {
  clearTimeout(texteT);
  texteT = setTimeout(() => { FILTRE.texte = el('qSerie').value; filtreChange(); }, 140);
});
el('fMode').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === MODE) return;
  MODE = b.dataset.mode;
  try { localStorage.setItem('pokemon-mode', MODE); } catch(e){}
  fermerNet();
  dessineFiltres();
  afficheMode();
});

/* Une carte répond-elle au filtre ? `v` : la version de la pochette, quand
   le classeur en a une par version - c'est alors elle qu'on juge. */
function correspond(c, v){
  if (FILTRE.rarete && c[RAR] !== FILTRE.rarete) return false;
  const q = norm(FILTRE.texte);
  if (q){
    /* un nombre désigne un numéro : « 25 » trouve la 025, pas toutes les
       cartes dont le numéro contient un 2 et un 5 */
    if (/^\d+$/.test(q)){ if (String(c[NUM]).replace(/^0+(?=\d)/, '') !== String(+q)) return false; }
    else if (norm(c[NOM] + ' ' + c[NUM]).indexOf(q) < 0) return false;
  }
  if (FILTRE.etat === 'toutes') return true;
  const a = v ? possede(c, v) : aUne(c);
  return FILTRE.etat === 'possedees' ? a : !a;
}
const filtreActif = () => FILTRE.etat !== 'toutes' || !!FILTRE.rarete || !!norm(FILTRE.texte);

function majCompte(){
  if (!SER) return;
  if (!filtreActif()){ el('fCompte').textContent = ''; return; }
  const n = SER.cartes.filter(c => correspond(c, null)).length;
  el('fCompte').textContent = n + ' carte' + pluriel(n);
}

function afficheMode(){
  const classeur = MODE === 'classeur';
  el('stage').hidden = !classeur;
  el('foot').hidden = !classeur;
  el('grille').hidden = classeur;
  document.body.classList.toggle('en-grille', !classeur);
  if (classeur){ fit(); renderClasseurs(); render(); }
  else dessineGrille();
  majCompte();
}

/* =========================================================
   La grille : toutes les cartes de la série, ou celles du filtre
   Chaque carte porte ses pastilles de versions, qui se cochent sur place :
   c'est l'écran pour ranger vite. Une carte qui cesse de répondre au
   filtre ne disparaît pas sous le doigt - elle partirait au moment où on
   allait cliquer la suivante -, elle reste jusqu'au prochain filtre.
   ========================================================= */
function dessineGrille(){
  const lignes = [];
  SER.cartes.forEach((c, i) => { if (correspond(c, null)) lignes.push(tuileHTML(i)); });
  el('grille').innerHTML = lignes.join('')
    || '<p class="grille-vide">' + (SER.cartes.length ? 'Aucune carte trouvée' : 'Cette série est vide') + '</p>';
  el('grille').classList.toggle('sans-carte', !lignes.length);
}
function etatDe(c){ return aUne(c) ? (complete(c) ? 'complete' : 'partielle') : 'absente'; }
function tuileHTML(i){
  const c = SER.cartes[i];
  const src = vignetteDe(c);
  return '<div class="tuile ' + etatDe(c) + '" data-i="' + i + '">'
    + '<button class="tuile-img" data-i="' + i + '" aria-label="' + esc(c[NOM]) + '">'
    + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">'
           : '<span class="sans-image">' + esc(c[NOM]) + '</span>')
    + '</button>'
    + '<div class="tuile-pied"><span class="tuile-num">' + esc(numeroDe(c)) + '</span>'
    + '<span class="tuile-nom">' + esc(c[NOM]) + '</span></div>'
    + '<div class="tuile-ver">' + pastilles(i) + '</div></div>';
}
/* `cle` : l'attribut qui retrouve la carte au clic - data-i dans une série,
   data-k sur la page d'un Pokémon. */
function pastillesDe(c, cle){
  return versionsMontrees(c).map(v => {
    const a = possede(c, v);
    return '<button type="button" class="pastille v-' + v + (a ? ' on' : '') + '" ' + cle + ' data-v="' + v
      + '" aria-pressed="' + a + '"' + (CAN_WRITE ? '' : ' disabled') + '>' + esc(nomVersion(c, v)) + '</button>';
  }).join('');
}
const pastilles = i => pastillesDe(SER.cartes[i], 'data-i="' + i + '"');
el('grille').addEventListener('click', e => {
  const p = e.target.closest('.pastille[data-v]');
  if (p){ basculer(+p.dataset.i, p.dataset.v); return; }
  const t = e.target.closest('.tuile-img[data-i]');
  if (t) ouvrir(+t.dataset.i, null, t);
});

/* =========================================================
   Ranger une version, ou la retirer
   La carte change tout de suite à l'écran, sans attendre le serveur : on
   coche une série entière à la suite, et chaque aller-retour qu'on
   attendrait se sentirait sous le doigt.

   Les coches partent ensuite par paquets, un peu plus d'une fois par seconde :
   en ligne, Nginx limite /api/ à deux requêtes par seconde (quarante
   d'avance), et une requête par pastille y butait dès la quarantième carte
   cochée d'affilée. Un paquet refusé pour une panne passagère - cette
   limite, le réseau - repart seul un peu plus tard ; un vrai refus fait
   relire la série, et l'écran reprend ce que la base dit.
   ========================================================= */
const ATTENTE = new Map();   // « serie|carte|version » -> le changement voulu
let envoiT = null, enVol = false, ratesSuite = 0;
const cleEnvoi = x => x.serie + '|' + x.carte + '|' + x.version;
const enAttente = (serie, carte) => {
  for (const k of ATTENTE.keys()) if (k.startsWith(serie + '|' + carte + '|')) return true;
  return false;
};

/* Ce que la base dira d'une carte une fois partis les clics qui attendent
   encore : une série ou un Pokémon relu entre-temps ne doit pas les effacer. */
function avecAttente(serie, carte, pos){
  let s = String(pos || '');
  for (const x of ATTENTE.values()){
    if (x.serie !== serie || x.carte !== carte) continue;
    s = x.possede ? (s.indexOf(x.version) < 0 ? s + x.version : s) : s.replace(x.version, '');
  }
  return ordonne(s);
}

function peutRanger(){
  if (CAN_WRITE) return true;
  toast(MOI.connecte ? "Cette collection n'est pas la tienne : lecture seule."
                     : 'Connecte-toi sur Abyss pour ranger tes cartes.', true);
  return false;
}
/* La carte `c` gagne ou perd la version `v`, à l'écran tout de suite ; le
   changement attend son paquet. Rend ce qu'on voulait. */
function bascule(c, serie, v){
  const voulu = !possede(c, v);
  c[POS] = ordonne(voulu ? String(c[POS] || '') + v : String(c[POS] || '').replace(v, ''));
  const x = { serie: serie, carte: c[NUM], version: v, possede: voulu };
  ATTENTE.set(cleEnvoi(x), x);
  planifieEnvoi(800);
  return voulu;
}
function basculer(i, v){
  if (!peutRanger()) return;
  bascule(SER.cartes[i], SER.serie.id, v);
  majCarte(i);
}
function planifieEnvoi(ms){
  if (envoiT || enVol) return;
  envoiT = setTimeout(envoie, ms);
}
async function envoie(){
  envoiT = null;
  if (enVol || !ATTENTE.size) return;
  const lot = Array.from(ATTENTE.values()).slice(0, 400);
  lot.forEach(x => ATTENTE.delete(cleEnvoi(x)));
  enVol = true;
  let d = null, statut = 0, pourquoi = '';
  try {
    const r = await fetch('/api/pokemon/cartes', {
      method: 'PUT', credentials: 'same-origin',
      // application/json : la parade CSRF, comme partout sur le site
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changements: lot }),
    });
    statut = r.status;
    d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.ok) pourquoi = (d && d.message) || 'réponse HTTP ' + r.status;
  } catch(e){ pourquoi = 'serveur injoignable'; }
  enVol = false;
  if (pourquoi && (!statut || statut === 429 || statut >= 500)){
    /* une panne passagère : le paquet repart plus tard, sans écraser un
       clic plus récent sur la même pastille */
    lot.forEach(x => { if (!ATTENTE.has(cleEnvoi(x))) ATTENTE.set(cleEnvoi(x), x); });
    ratesSuite++;
    if (ratesSuite === 3) toast('Le serveur ne répond pas : tes cartes attendent, elles repartiront seules.', true);
    envoiT = setTimeout(envoie, Math.min(15000, 1000 * 2 ** ratesSuite));
    return;
  }
  if (pourquoi){
    ratesSuite = 0;
    toast('Pas enregistré : ' + pourquoi, true);
    if (VUE === 'pokemon' && PK) ouvrirPokemon(PK.pokemon.numero, { pousser: false });
    else relireSerie();
  } else {
    if (ratesSuite >= 3) toast('C’est reparti : tout est enregistré.');
    ratesSuite = 0;
    /* ce que la base dit des cartes touchées, sauf de celles qu'un clic plus
       récent attend encore d'envoyer */
    (d.cartes || []).forEach(x => {
      if (enAttente(x.serie, x.carte)) return;
      if (SER && SER.serie.id === x.serie){
        const i = SER.cartes.findIndex(c => c[NUM] === x.carte);
        if (i >= 0 && SER.cartes[i][POS] !== x.possedees){ SER.cartes[i][POS] = x.possedees; majCarte(i); }
      }
      if (PK) PK.cartes.forEach((c, k) => {
        if (c[SID] === x.serie && c[NUM] === x.carte && c[POS] !== x.possedees){ c[POS] = x.possedees; majTuilePk(k); }
      });
    });
  }
  if (ATTENTE.size) planifieEnvoi(800);
}
/* On quitte la page avec des coches pas encore parties : un dernier envoi,
   que le navigateur mène à son terme même la page fermée (keepalive). */
function envoiDeSortie(){
  if (!ATTENTE.size) return;
  const lot = Array.from(ATTENTE.values());
  ATTENTE.clear();
  try {
    fetch('/api/pokemon/cartes', { method: 'PUT', keepalive: true, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changements: lot }) });
  } catch(e){}
}
addEventListener('pagehide', envoiDeSortie);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') envoiDeSortie();
});

async function relireSerie(){
  const s = source();
  if (!s || !SER) return;
  const ser = SER;
  try {
    const r = await fetch(s.url + '/serie/' + encodeURIComponent(ser.serie.id), { credentials: 'same-origin' });
    const d = await r.json();
    if (!d.ok || SER !== ser) return;
    ser.cartes.forEach((c, i) => {
      if (d.cartes[i] && d.cartes[i][NUM] === c[NUM] && !enAttente(ser.serie.id, c[NUM])) c[POS] = d.cartes[i][POS];
    });
    if (MODE === 'grille') dessineGrille(); else render();
    if (S.sel !== null){ majPanel(); majGrandeCarte(); }
    majJauge();
  } catch(e){}
}

/* Tout ce qui montre la carte `i` suit : sa tuile, ses pochettes, le
   panneau et la grande carte si elle est sortie, la jauge. */
function majCarte(i){
  const t = el('grille').querySelector('.tuile[data-i="' + i + '"]');
  if (t) t.outerHTML = tuileHTML(i);
  el('binder').querySelectorAll('.slot[data-i="' + i + '"]').forEach(s => { s.outerHTML = slotHTML(+s.dataset.k); });
  if (S.sel === i){ majPanel(); majGrandeCarte(); }
  majJauge();
  const n = el('sautMenu').querySelector('[aria-current="true"] .n');
  if (n) n.textContent = el('mOwn').textContent + '/' + SER.cartes.length;
}

/* =========================================================
   Le classeur
   Repris du classeur Yu-Gi-Oh : une série, ce sont des pochettes dans
   l'ordre de leurs numéros - une par carte, ou une par version -, coupées
   en classeurs si le format fixe un nombre de pages.
   ========================================================= */
const fmt = () => (SER && SER.format) || FORMAT_DEFAUT;
const parFace = () => fmt().colonnes * fmt().rangees;
const parPage = () => 2 * parFace();
let POCHES = [];          // [{ i, v }] : la carte, et la version si une pochette par version
let TOMES = [{ n: 1, debut: 0, fin: 0 }];
const T = () => TOMES[S.c] || TOMES[0];
const sheets = () => fmt().pages || Math.max(1, Math.ceil((T().fin - T().debut) / parPage()));

function formatSur(f){
  const sortie = Object.assign({}, FORMAT_DEFAUT);
  if (!f || typeof f !== 'object') return sortie;
  ['colonnes', 'rangees', 'pages'].forEach(k => {
    const v = f[k], b = FORMAT_BORNES[k];
    if (Number.isInteger(v) && v >= b[0] && v <= b[1]) sortie[k] = v;
  });
  if (typeof f.versions === 'boolean') sortie.versions = f.versions;
  return sortie;
}

function relie(){
  POCHES = [];
  SER.cartes.forEach((c, i) => {
    if (fmt().versions) for (const v of String(c[VER])) POCHES.push({ i: i, v: v });
    else POCHES.push({ i: i, v: null });
  });
  const place = fmt().pages ? parPage() * fmt().pages : Math.max(1, POCHES.length);
  TOMES = [];
  for (let k = 0; k < POCHES.length; k += place){
    TOMES.push({ n: TOMES.length + 1, debut: k, fin: Math.min(k + place, POCHES.length) });
  }
  if (!TOMES.length) TOMES = [{ n: 1, debut: 0, fin: 0 }];
  S.c = Math.min(S.c, TOMES.length - 1);
}

/* emplacement d'une pochette du tome : page, face, numéro dans la face */
function pos(k){
  const pp = parPage(), pf = parFace(), m = k % pp;
  return { page: Math.floor(k / pp) + 1, face: m < pf ? 'recto' : 'verso', slot: m % pf + 1 };
}

const vignetteDe = c => (c && c[ART] && SER) ? SER.vignettes + SER.dossier + c[ART] : '';
const imageDe = c => (c && c[ART] && SER) ? SER.images + SER.dossier + c[ART] : '';
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const FOIL = '<i class="foil"><span></span></i>';

/* Ce qui brille : la holo sur l'illustration, la reverse sur tout le reste
   de la carte. Une pochette par version brille de la sienne ; une pochette
   par carte, de la plus belle qu'on ait. */
function reflet(c, v){
  if (v) return possede(c, v) ? (v === 'H' ? 'holo' : v === 'R' ? 'reverse' : '') : '';
  return possede(c, 'H') ? 'holo' : possede(c, 'R') ? 'reverse' : '';
}

function slotHTML(k){
  const p = POCHES[T().debut + k];
  if (!p || T().debut + k >= T().fin) return '<span class="slot void" aria-hidden="true"></span>';
  const c = SER.cartes[p.i];
  const a = p.v ? possede(c, p.v) : aUne(c);
  const src = RAPIDE ? '' : vignetteDe(c);
  const cls = ['slot', a ? 'owned' : 'miss'];
  if (!p.v && a && !complete(c)) cls.push('partielle');
  if (src) cls.push('art');
  const r = reflet(c, p.v);
  if (r) cls.push('brille', r);
  if (filtreActif() && !correspond(c, p.v)) cls.push('estompee');
  if (S.zoom && S.sel === p.i) cls.push('sortie');
  if (S.hit === p.i) cls.push('hit');
  if (S.pose === p.i) cls.push('pose');
  /* les versions au pied de la pochette : celle de la pochette quand il y
     en a une par version, toutes sinon - pleines si on les a */
  const vs = p.v ? '<span class="slot-pts"><i class="' + (a ? 'on' : '') + '">' + esc(LETTRE[p.v]) + '</i></span>'
    : (String(c[VER]).length > 1 || String(c[POS] || '').length > 1
        ? '<span class="slot-pts">' + versionsMontrees(c).map(v =>
            '<i class="' + (possede(c, v) ? 'on' : '') + '">' + esc(LETTRE[v]) + '</i>').join('') + '</span>' : '');
  return '<button class="' + cls.join(' ') + '" style="--d:' + ((k * 7) % 9 * 0.62).toFixed(2) + 's"'
    + ' data-k="' + k + '" data-i="' + p.i + '"' + (p.v ? ' data-v="' + p.v + '"' : '')
    + ' aria-label="' + esc(c[NOM] + ', ' + numeroDe(c)) + '">'
    + (src ? '<img class="art" alt="" decoding="async" data-art="1" src="' + esc(src) + '">' : '')
    + (r ? FOIL : '')
    + '<span class="slot-num">' + esc(c[NUM]) + '</span>'
    + vs
    + '<span class="nm">' + esc(c[NOM]) + '</span></button>';
}

/* Une image qui ne vient pas : un second essai une seconde plus tard,
   puis la pochette rend son nom. Même filet que le classeur Yu-Gi-Oh. */
document.addEventListener('error', e => {
  const im = e.target;
  if (!im || im.tagName !== 'IMG' || !im.dataset || !im.dataset.art) return;
  if (!im.dataset.essai){
    im.dataset.essai = '1';
    const src = im.getAttribute('src');
    setTimeout(() => { if (im.isConnected && im.dataset.art) im.src = src; }, 1000);
    return;
  }
  const p = im.parentNode;
  im.remove();
  if (p) p.classList.remove('art');
}, true);

function faceHTML(sheet, face){
  const side = face === 'recto' ? 'r' : 'l';
  if (sheet < 1 || sheet > sheets()) return '<div class="page ' + side + ' cover"></div>';
  const start = (sheet - 1) * parPage() + (face === 'recto' ? 0 : parFace());
  let slots = '';
  for (let j = 0; j < parFace(); j++) slots += slotHTML(start + j);
  return '<div class="page ' + side + '">'
    + '<div class="face"><span class="pg">Page ' + sheet + '</span></div>'
    + '<div class="grid">' + slots + '</div></div>';
}
const SPINE = '<div class="spine">' + '<i class="ring"></i>'.repeat(4) + '</div>';

function draw(gauche, droite){
  const b = el('binder');
  const vieilles = b.querySelectorAll('img[data-art]');
  for (let k = 0; k < vieilles.length; k++){
    vieilles[k].removeAttribute('data-art');
    vieilles[k].src = PIXEL;
  }
  b.innerHTML = faceHTML(gauche, 'verso') + SPINE + faceHTML(droite, 'recto');
}
function render(){
  if (!SER || MODE !== 'classeur' || el('vueSerie').hidden) return;
  fit();
  S.spread = Math.min(S.spread, sheets());
  draw(S.spread, S.spread + 1);
  el('prev').disabled = S.spread <= 0 && S.c <= 0;
  el('next').disabled = S.spread >= sheets() && S.c >= TOMES.length - 1;
  el('goPage').max = sheets();
  if (document.activeElement !== el('goPage')) el('goPage').value = Math.min(S.spread + 1, sheets());
  el('ofPages').textContent = '/ ' + sheets();
}
function renderClasseurs(){
  const barre = el('classeurs');
  barre.classList.toggle('serres', TOMES.length > 4);
  barre.innerHTML = TOMES.length < 2 ? '' : TOMES.map((t, i) =>
    '<button data-c="' + i + '" aria-pressed="' + (i === S.c) + '" aria-label="Classeur ' + t.n + '">'
    + '<span class="cl-mot">Classeur </span>' + t.n + '</button>').join('');
  const ouvert = barre.querySelector('[aria-pressed="true"]');
  if (ouvert){
    const a = ouvert.getBoundingClientRect(), b = barre.getBoundingClientRect();
    barre.scrollLeft += (a.left + a.width / 2) - (b.left + b.width / 2);
  }
}
const slotEl = i => el('binder').querySelector('.slot[data-i="' + i + '"]');

/* ---------------- dimensionnement : le classeur remplit l'écran ---------------- */
function fit(){
  const st = el('stage');
  if (!st || el('vueSerie').hidden || MODE !== 'classeur') return;
  const cols = fmt().colonnes, rangs = fmt().rangees;
  const r = document.documentElement.style;
  r.setProperty('--cols', cols);
  const gap = 8, pad = 13, head = 28, marge = 6;
  let ch;
  if (narrow()){
    const cw = (st.clientWidth - (cols - 1) * gap - 2 * pad - marge) / cols;
    ch = cw * 88 / 63;
  } else {
    const dispoW = st.clientWidth - 2 * (38 + 10) - 20 - marge;
    const dispoH = st.clientHeight - marge;
    const parLargeur = ((dispoW / 2 - 2 * pad - (cols - 1) * gap) / cols) * 88 / 63;
    const parHauteur = (dispoH - 2 * pad - head - (rangs - 1) * gap) / rangs;
    ch = Math.min(parLargeur, parHauteur);
  }
  ch = Math.max(72, Math.floor(ch));
  r.setProperty('--ch', ch + 'px');
  r.setProperty('--cw', Math.floor(ch * 63 / 88) + 'px');
}

/* ---------------- tourner les pages ---------------- */
let flip = null, swap = null, lastTurn = 0;
let RAPIDE = false, rapideT = null;
function feuilletage(){
  RAPIDE = true;
  clearTimeout(rapideT);
  rapideT = setTimeout(() => { RAPIDE = false; if (!flip && !swap) render(); }, 160);
}
function landFlip(){
  landSwap();
  if (!flip) return;
  S.spread = flip.target;
  flip.anim.onfinish = null;
  flip.anim.cancel();
  flip.el.remove();
  flip = null;
  el('binder').style.minHeight = '';
}
function landSwap(){
  if (!swap) return;
  const s = swap;
  swap = null;
  s.anim.onfinish = null;
  s.anim.cancel();
  s.appliquer();
}
const classeurVoisin = dir => { const c = S.c + dir; return (c >= 0 && c < TOMES.length) ? c : -1; };

function changeClasseur(c, dir, debut){
  if (c < 0 || c === S.c) return false;
  const appliquer = () => {
    S.c = c;
    S.spread = debut ? 0 : sheets();
    S.hit = null; S.pose = null;
    renderClasseurs(); render();
  };
  if (reduce() || narrow()){ appliquer(); return true; }
  const dx = dir > 0 ? -46 : 46;
  const sortie = el('binder').animate([
    { transform: 'translateX(0) scale(1)', opacity: 1 },
    { transform: 'translateX(' + dx + 'px) scale(.93)', opacity: 0 }
  ], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  swap = { anim: sortie, appliquer: appliquer };
  sortie.onfinish = () => {
    swap = null;
    appliquer();
    el('binder').animate([
      { transform: 'translateX(' + (-dx) + 'px) scale(.93)', opacity: 0 },
      { transform: 'translateX(0) scale(1)', opacity: 1 }
    ], { duration: 240, easing: 'cubic-bezier(0,0,.3,1)' });
    sortie.cancel();
  };
  return true;
}

function turn(dir){
  if (!SER || MODE !== 'classeur') return;
  landFlip();
  const from = S.spread, to = from + dir;
  if (to < 0 || to > sheets()){
    if (!changeClasseur(classeurVoisin(dir), dir, dir > 0)) render();
    return;
  }
  const sheet = dir > 0 ? from + 1 : from;
  const now = performance.now();
  const enchaine = now - lastTurn < 340;
  lastTurn = now;
  if (enchaine) feuilletage();
  if (reduce() || narrow() || sheet < 1 || sheet > sheets()){ S.spread = to; render(); return; }
  /* La reliure garde sa hauteur pendant que la feuille tourne. Les deux
     pages de dessous peuvent manquer toutes les deux - une feuille unique,
     tournée dans un sens ou dans l'autre - et elle tombait alors à la
     hauteur du dos : la feuille qui tourne, qui prend la sienne, débordait
     en bas, tordue par la perspective. landFlip la lui rend. */
  el('binder').style.minHeight = el('binder').offsetHeight + 'px';
  if (dir > 0) draw(from, from + 2); else draw(from - 1, from + 1);
  const f = document.createElement('div');
  f.className = 'flipper';
  f.innerHTML = faceHTML(sheet, 'recto') + faceHTML(sheet, 'verso').replace('class="page l"', 'class="page l back"');
  el('binder').appendChild(f);
  const a0 = dir > 0 ? 0 : -180, a1 = dir > 0 ? -180 : 0;
  const anim = f.animate([{ transform: 'rotateY(' + a0 + 'deg)' }, { transform: 'rotateY(' + a1 + 'deg)' }],
    { duration: enchaine ? 200 : 460, easing: 'cubic-bezier(.35,.02,.28,1)', fill: 'forwards' });
  flip = { el: f, anim: anim, target: to };
  anim.onfinish = () => { landFlip(); render(); };
}
function goToSpread(n){
  landFlip();
  const target = Math.max(0, Math.min(sheets(), n));
  if (Math.abs(target - S.spread) === 1) turn(target > S.spread ? 1 : -1);
  else { S.spread = target; render(); }
}

/* La double-page où se trouve la pochette `k` du tome `c`. */
function spreadDe(k){
  const o = pos(k);
  return o.face === 'recto' ? o.page - 1 : o.page;
}
/* Aller à une carte, et la sortir de sa pochette : pour la recherche. */
let hitT = null;
function allerALaCarte(i){
  const g = POCHES.findIndex(p => p.i === i);
  if (MODE === 'classeur' && g >= 0){
    const c = TOMES.findIndex(t => g >= t.debut && g < t.fin);
    S.c = Math.max(0, c);
    S.spread = spreadDe(g - T().debut);
    S.hit = i;
    clearTimeout(hitT);
    hitT = setTimeout(() => { S.hit = null; }, 3600);
    renderClasseurs(); render();
    ouvrir(i, null, slotEl(i));
  } else {
    const t = el('grille').querySelector('.tuile[data-i="' + i + '"]');
    if (t) t.scrollIntoView({ block: 'center' });
    ouvrir(i, null, t);
  }
}

/* =========================================================
   La carte au premier plan, et son panneau
   ========================================================= */
let ZOOM = null;      // { box, rect, i, v }

/* Les pastilles du panneau : une par version de la carte, et « Autre
   version » pour celles que TCGdex ne donne pas - un catalogue a des trous,
   et une carte qu'on a en main doit pouvoir se ranger. */
function majPanel(){
  const i = S.sel;
  const c = SER && SER.cartes[i];
  if (!c) return;
  el('pName').textContent = c[NOM];
  el('pCm').href = '/api/pokemon/cardmarket?serie=' + encodeURIComponent(SER.serie.id)
    + '&carte=' + encodeURIComponent(c[NUM]);
  const a = aUne(c);
  el('pStat').innerHTML = esc([numeroDe(c), c[RAR], NOM_CATEGORIE[c[CAT]]].filter(Boolean).join(' · '))
    + ' · ' + (a ? (complete(c) ? '<b class="oui">Possédée</b>' : '<b class="mi">En partie</b>')
                 : '<b class="non">Non possédée</b>');
  const g = POCHES.findIndex(p => p.i === i && (!ZOOM || !ZOOM.v || p.v === ZOOM.v));
  if (MODE === 'classeur' && g >= 0){
    const t = TOMES.findIndex(x => g >= x.debut && g < x.fin);
    const o = pos(g - TOMES[Math.max(0, t)].debut);
    const cases = (TOMES.length > 1 ? [['Classeur', TOMES[Math.max(0, t)].n]] : [])
      .concat([['Page', o.page], ['Face', o.face === 'recto' ? 'R' : 'V'], ['Place', o.slot]]);
    el('pCoord').innerHTML = cases.map(kv => '<div class="cbox"><div class="k">' + kv[0]
      + '</div><div class="v">' + kv[1] + '</div></div>').join('');
    el('pCoord').hidden = false;
  } else {
    el('pCoord').hidden = true;
  }
  el('pVers').innerHTML = versionsMontrees(c).map(v => {
    const on = possede(c, v);
    return '<button type="button" class="ver v-' + v + (on ? ' on' : '') + '" data-v="' + v + '" aria-pressed="' + on + '"'
      + (CAN_WRITE ? '' : ' disabled') + '><span class="ver-coche" aria-hidden="true"></span>'
      + esc(nomVersion(c, v)) + '</button>';
  }).join('');
}
el('pVers').addEventListener('click', e => {
  const b = e.target.closest('.ver[data-v]');
  if (b && S.sel !== null) basculer(S.sel, b.dataset.v);
});

function rectCible(){
  const marge = narrow() ? 12 : 22;
  const ph = el('panel').offsetHeight || 120;
  const dispoW = innerWidth - marge * 2;
  const dispoH = innerHeight - ph - marge * 2;
  const h = Math.max(120, Math.min(dispoH, dispoW * 88 / 63));
  const w = h * 63 / 88;
  return { w: w, h: h, x: (innerWidth - w) / 2, y: marge + (dispoH - h) / 2 };
}
function grandeCarteHTML(c, v){
  const src = imageDe(c);
  const a = v ? possede(c, v) : aUne(c);
  const r = reflet(c, v);
  const cls = ['bigcard'];
  if (src) cls.push('art');
  if (!a) cls.push('absente');
  if (r) cls.push('brille', r);
  return '<div class="' + cls.join(' ') + '" style="--d:.35s">'
    + (src ? '<img class="bigart" alt="" decoding="async" data-src="' + esc(src) + '" src="' + esc(src) + '">' : '')
    + '<div class="bigfb"><span>' + esc(c[NOM]) + '</span></div>'
    + (r ? FOIL : '')
    + (a ? '' : '<span class="bigmiss">Non possédée</span>')
    + '</div>';
}
function majGrandeCarte(){
  if (!ZOOM || !SER) return;
  const c = SER.cartes[ZOOM.i];
  if (!c) return;
  const vieille = ZOOM.box.querySelector('.bigart');
  const neuf = imageDe(c);
  /* l'image ne change que si l'on a changé de carte : la garder évite un
     clignotement à chaque pastille cochée */
  if (vieille && vieille.dataset.src === neuf){
    const big = ZOOM.box.querySelector('.bigcard');
    const tmp = document.createElement('div');
    tmp.innerHTML = grandeCarteHTML(c, ZOOM.v);
    const neuve = tmp.firstChild;
    big.className = neuve.className;
    big.querySelectorAll('.foil,.bigmiss').forEach(x => x.remove());
    neuve.querySelectorAll('.foil,.bigmiss').forEach(x => big.appendChild(x));
  } else {
    ZOOM.box.innerHTML = grandeCarteHTML(c, ZOOM.v);
  }
}
function poserRect(box, r){
  box.style.left = r.x + 'px'; box.style.top = r.y + 'px';
  box.style.width = r.w + 'px'; box.style.height = r.h + 'px';
}
function animEntree(box, s, r){
  let dx = 0, dy = 50, sc = .82, depuis = false;
  if (s && s.width > 4){
    sc = s.width / r.w;
    dx = (s.left + s.width / 2) - (r.x + r.w / 2);
    dy = (s.top + s.height / 2) - (r.y + r.h / 2);
    depuis = true;
  }
  const mid = sc + (1 - sc) * .8;
  return box.animate([
    { offset: 0, opacity: depuis ? .45 : 0,
      transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) rotateY(-26deg) rotateX(7deg) scale(' + sc + ')' },
    { offset: .62, opacity: 1,
      transform: 'translate3d(' + (dx * .2) + 'px,' + (dy * .2) + 'px,110px) rotateY(-8deg) rotateX(2deg) scale(' + mid + ')' },
    { offset: 1, opacity: 1, transform: 'translate3d(0,0,0) rotateY(0deg) rotateX(0deg) scale(1)' }
  ], { duration: reduce() ? 1 : 540, easing: 'cubic-bezier(.24,.68,.26,1)', fill: 'both' });
}
function animSortie(box, s, r, a){
  let dx = 0, dy = 60, sc = .8, vers = false;
  if (s && s.width > 4){
    sc = s.width / r.w;
    dx = (s.left + s.width / 2) - (r.x + r.w / 2);
    dy = (s.top + s.height / 2) - (r.y + r.h / 2);
    vers = true;
  }
  const mid = sc + (1 - sc) * .72;
  return box.animate([
    { offset: 0, opacity: 1, transform: 'translate3d(0,0,0) rotateY(0deg) rotateX(0deg) scale(1)' },
    { offset: .42, opacity: 1,
      transform: 'translate3d(' + (dx * .24) + 'px,' + (dy * .24) + 'px,70px) rotateY(-10deg) rotateX(3deg) scale(' + mid + ')' },
    { offset: 1, opacity: vers && a ? .92 : 0,
      transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) rotateY(-20deg) rotateX(6deg) scale(' + (sc * .97) + ')' }
  ], { duration: reduce() ? 1 : 470, easing: 'cubic-bezier(.42,.02,.28,1)', fill: 'both' });
}

/* `v` : la version de la pochette, quand le classeur en a une par version. */
function ouvrir(i, v, srcEl){
  const c = SER && SER.cartes[i];
  if (!c) return;
  if (flip){ landFlip(); render(); }
  if (ZOOM) fermerNet();
  const cible = srcEl || slotEl(i);
  const depart = cible ? cible.getBoundingClientRect() : null;
  S.sel = i; S.zoom = true;
  ZOOM = { box: null, rect: null, i: i, v: v || null };
  majPanel();
  el('panel').classList.add('open');
  el('scrim').classList.add('on');
  el('zPrev').hidden = false; el('zNext').hidden = false;
  majNavZoom();
  const r = rectCible();
  const box = document.createElement('div');
  box.className = 'zoomwrap';
  poserRect(box, r);
  box.innerHTML = grandeCarteHTML(c, ZOOM.v);
  el('zoom').appendChild(box);
  ZOOM.box = box; ZOOM.rect = r;
  if (cible && cible.classList.contains('slot')) cible.classList.add('sortie');
  const a = animEntree(box, depart, r);
  a.onfinish = () => { try { a.cancel(); } catch(e){} };
}

function cibleDeRetour(i){
  if (MODE === 'classeur') return slotEl(i);
  return el('grille').querySelector('.tuile[data-i="' + i + '"] .tuile-img');
}
function fermer(){
  el('panel').classList.remove('open');
  el('scrim').classList.remove('on');
  el('zPrev').hidden = true; el('zNext').hidden = true;
  if (!ZOOM){ S.sel = null; S.zoom = false; return; }
  const z = ZOOM;
  const dstEl = cibleDeRetour(z.i);
  const dst = dstEl ? dstEl.getBoundingClientRect() : null;
  const c = SER && SER.cartes[z.i];
  const a = !!c && (z.v ? possede(c, z.v) : aUne(c));
  ZOOM = null;
  let fait = false;
  const fini = () => {
    if (fait) return;
    fait = true;
    z.box.remove();
    S.zoom = false; S.sel = null;
    el('binder').querySelectorAll('.slot.sortie').forEach(s => s.classList.remove('sortie'));
  };
  const an = animSortie(z.box, dst, z.rect, a);
  an.onfinish = fini;
  if (reduce()) setTimeout(fini, 20);
}
function fermerNet(){
  if (ZOOM){ ZOOM.box && ZOOM.box.remove(); ZOOM = null; }
  el('panel').classList.remove('open');
  el('scrim').classList.remove('on');
  el('zPrev').hidden = true; el('zNext').hidden = true;
  S.sel = null; S.zoom = false;
  el('binder').querySelectorAll('.slot.sortie').forEach(s => s.classList.remove('sortie'));
}

/* Passer d'une carte à l'autre, carte sortie : dans l'ordre du classeur, ou
   dans celui de la grille - seulement les cartes du filtre, alors. */
function listeNav(){
  if (MODE === 'classeur') return POCHES.map((p, g) => ({ i: p.i, v: p.v, g: g }));
  const l = [];
  SER.cartes.forEach((c, i) => { if (correspond(c, null)) l.push({ i: i, v: null }); });
  return l;
}
function posDansNav(l){
  return l.findIndex(x => x.i === ZOOM.i && (!ZOOM.v || x.v === ZOOM.v));
}
function majNavZoom(){
  if (!ZOOM || !SER) return;
  const l = listeNav(), k = posDansNav(l);
  el('zPrev').disabled = k <= 0;
  el('zNext').disabled = k < 0 || k >= l.length - 1;
}
function navCarte(dir){
  if (!ZOOM || !SER) return;
  const l = listeNav(), k = posDansNav(l);
  const cible = l[k + dir];
  if (k < 0 || !cible) return;
  landFlip();
  if (MODE === 'classeur'){
    const t = TOMES.findIndex(x => cible.g >= x.debut && cible.g < x.fin);
    const change = t !== S.c;
    S.c = t;
    S.spread = spreadDe(cible.g - T().debut);
    if (change) renderClasseurs();
  }
  S.sel = cible.i;
  ZOOM.i = cible.i; ZOOM.v = cible.v;
  if (MODE === 'classeur') render();
  majPanel(); majGrandeCarte(); majNavZoom();
  if (MODE === 'classeur'){ const s = slotEl(cible.i); if (s) s.classList.add('sortie'); }
}
el('zPrev').onclick = () => navCarte(-1);
el('zNext').onclick = () => navCarte(1);
el('pClose').onclick = () => fermer();
el('scrim').onclick = () => fermer();

/* ---------------- événements du classeur ---------------- */
el('binder').addEventListener('click', e => {
  const s = e.target.closest('.slot[data-i]');
  if (s) ouvrir(+s.dataset.i, s.dataset.v || null, s);
});
el('classeurs').onclick = e => {
  const b = e.target.closest('[data-c]'); if (!b) return;
  landFlip(); fermerNet();
  const c = +b.dataset.c;
  if (c === S.c){ S.spread = 0; render(); return; }
  changeClasseur(c, c > S.c ? 1 : -1, true);
};
el('prev').onclick = () => turn(-1);
el('next').onclick = () => turn(1);
el('retourBlocs').onclick = () => retour({});
el('goPage').addEventListener('change', () => {
  const p = parseInt(el('goPage').value, 10);
  if (!isNaN(p)) goToSpread(Math.max(1, Math.min(sheets(), p)) - 1);
});
el('goPage').addEventListener('keydown', e => { if (e.key === 'Enter') el('goPage').blur(); });

glissement(el('binder'), { gauche: () => turn(1), droite: () => turn(-1) });
glissement(el('zoom'), { gauche: () => navCarte(1), droite: () => navCarte(-1), bas: () => fermer() });
glissement(el('panel'), { bas: () => fermer() });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape'){
    if (el('modal').classList.contains('open')){ fermerModale(); return; }
    if (!el('recherche').hidden){ fermerRecherche(); return; }
    if (!el('menu').hidden){ closeMenu(); return; }
    if (!el('sautMenu').hidden){ fermeSaut(); el('sautBtn').focus(); return; }
    if (ZOOM){ fermer(); return; }
  }
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (el('modal').classList.contains('open')) return;
  if (ZOOM){
    if (e.key === 'ArrowLeft'){ e.preventDefault(); navCarte(-1); }
    if (e.key === 'ArrowRight'){ e.preventDefault(); navCarte(1); }
    return;
  }
  if (VUE !== 'serie' || MODE !== 'classeur') return;
  if (e.key === 'ArrowLeft') turn(-1);
  if (e.key === 'ArrowRight') turn(1);
});

let resizeT;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    if (VUE === 'serie' && MODE === 'classeur') render();
    if (ZOOM){ ZOOM.rect = rectCible(); poserRect(ZOOM.box, ZOOM.rect); }
  }, 120);
});

/* =========================================================
   Le Pokédex
   Tous les Pokémon qui ont une carte, par génération, avec ce qu'on a de
   chacun ; un clic ouvre toutes ses cartes. La liste est redemandée à
   chaque visite - ce qu'on a change pendant qu'on range -, mais celle
   qu'on a déjà s'affiche en attendant.
   ========================================================= */
const GENERATIONS = [
  [1, 151, 'Kanto'], [152, 251, 'Johto'], [252, 386, 'Hoenn'], [387, 493, 'Sinnoh'],
  [494, 649, 'Unys'], [650, 721, 'Kalos'], [722, 809, 'Alola'], [810, 905, 'Galar'],
  [906, 1025, 'Paldea'], [1026, Infinity, 'Nouveaux Pokémon'],
];
const generationDe = n => GENERATIONS.findIndex(g => n >= g[0] && n <= g[1]);
const trois = n => String(n).padStart(3, '0');
const numeroPokedex = n => 'N° ' + trois(n);
const bornesGeneration = g => trois(g[0]) + (g[1] === Infinity ? '+' : '-' + trois(g[1]));
const nomGeneration = k => GENERATIONS[k][1] === Infinity ? '' : (k ? (k + 1) + 'e' : '1re') + ' génération';

async function montrerPokedex(o){
  const opts = o || {};
  const s = source();
  if (!s || !ENS) return;
  const jeton = ++jetonVue;
  retiensDefile();
  fermerNet();
  majAdresse('pokedex', opts.pousser);
  VUE = 'pokedex';
  SER = null;
  montreSeule('vuePokedex');
  outils(true);
  const pret = !!PDX && PDX.url === s.url;
  if (pret){ dessinePokedex(); rendsDefile('pokedex'); }
  else {
    el('pokedex').innerHTML = '<p class="vide">Le Pokédex arrive…</p>';
    el('pokedex').classList.remove('sans-serie');
    el('pdxInfo').textContent = '';
    scrollTo(0, 0);
  }
  renderSaut();
  let d = null, pourquoi = '';
  try {
    const r = await fetch(s.url + '/pokedex', { credentials: 'same-origin' });
    d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.ok){ pourquoi = (d && d.message) || 'réponse HTTP ' + r.status; d = null; }
  } catch(e){ pourquoi = 'serveur injoignable'; }
  if (jeton !== jetonVue) return;
  if (!d){
    if (pret) return;
    toast('Pokédex illisible : ' + pourquoi, true);
    majAdresse('', false);
    montrerBlocs();
    return;
  }
  d.url = s.url;
  PDX = d;
  dessinePokedex();
  renderSaut();
  if (!pret) rendsDefile('pokedex');
}

/* Le nom, ou le numéro : « 25 », « 025 » et « #25 » trouvent Pikachu. */
function pokemonVisibles(){
  const q = norm(el('qPokedex').value);
  if (!q) return PDX.pokemon;
  const mots = q.split(' ');
  return PDX.pokemon.filter(p => /^\d+$/.test(q) ? p[P_NUM] === +q
    : mots.every(m => norm(p[P_NOM]).indexOf(m) >= 0));
}

function dessinePokedex(){
  const visibles = pokemonVisibles();
  const groupes = GENERATIONS.map(() => []);
  visibles.forEach(p => { const k = generationDe(p[P_NUM]); if (k >= 0) groupes[k].push(p); });
  let commences = 0;
  const parGen = GENERATIONS.map(() => ({ own: 0, tot: 0, n: 0 }));
  PDX.pokemon.forEach(p => {
    if (p[P_POS]) commences++;
    const g = parGen[generationDe(p[P_NUM])];
    if (g){ g.own += p[P_POS]; g.tot += p[P_TOT]; g.n++; }
  });
  el('pdxInfo').textContent = nombre(PDX.pokemon.length) + ' Pokémon · '
    + nombre(commences) + ' commencé' + pluriel(commences);
  const html = GENERATIONS.map((g, k) => {
    if (!groupes[k].length) return '';
    const t = parGen[k], pct = t.tot ? t.own / t.tot * 100 : 0;
    return '<section class="bloc" id="gen-' + k + '">'
      + '<div class="bloc-tete"><h2>' + esc(g[2]) + '</h2>'
      + '<span class="bloc-info">' + esc([nomGeneration(k), t.n + ' Pokémon'].filter(Boolean).join(' · ')) + '</span>'
      + '<span class="bloc-jauge"><span class="bar"><i style="width:' + pct.toFixed(2) + '%"></i></span>'
      + '<span class="val"><b>' + nombre(t.own) + '</b> / ' + nombre(t.tot) + ' cartes</span></span></div>'
      + '<div class="series">' + groupes[k].map(tuilePokemon).join('') + '</div></section>';
  }).join('');
  const brut = el('qPokedex').value.trim();
  el('pokedex').innerHTML = html || '<p class="vide-grand">'
    + esc(PDX.pokemon.length ? 'Aucun Pokémon ne correspond à « ' + brut + ' ».' : 'Le Pokédex est vide pour l’instant.') + '</p>';
  el('pokedex').classList.toggle('sans-serie', !html);
  el('pdxCompte').textContent = brut && html ? visibles.length + ' Pokémon' : '';
}

/* Le portrait d'un Pokémon : le haut d'une de ses cartes, là où est son
   illustration (voir _RARETES_PORTRAIT dans pokemon.py). Son nom attend
   dessous, si l'image ne vient pas. */
function tuilePokemon(p){
  const pct = p[P_TOT] ? p[P_POS] / p[P_TOT] * 100 : 0;
  const fini = p[P_TOT] && p[P_POS] >= p[P_TOT];
  return '<button class="serie pdx-poke' + (p[P_POS] ? ' commencee' : '') + (fini ? ' finie' : '')
    + '" data-n="' + p[P_NUM] + '">'
    + '<span class="pdx-art"><span class="pdx-sans">' + esc(p[P_NOM]) + '</span>'
    + (p[P_IMG] ? '<img src="' + esc(PDX.vignettes + p[P_IMG]) + '" alt="" loading="lazy" decoding="async" data-art="1">' : '')
    + '</span>'
    + '<span class="serie-nom">' + esc(p[P_NOM]) + '</span>'
    + '<span class="serie-info">' + numeroPokedex(p[P_NUM]) + '</span>'
    + '<span class="bar"><i style="width:' + pct.toFixed(2) + '%"></i></span>'
    + '<span class="serie-val"><span><b>' + p[P_POS] + '</b> / ' + p[P_TOT] + ' carte' + pluriel(p[P_TOT]) + '</span></span>'
    + '</button>';
}

el('pokedex').addEventListener('click', e => {
  const b = e.target.closest('.pdx-poke[data-n]');
  if (b) ouvrirPokemon(+b.dataset.n, { pousser: true });
});
el('qPokedex').addEventListener('input', () => {
  if (!PDX) return;
  dessinePokedex(); renderSaut();
  el('pokedex').scrollTop = 0;
});
el('qPokedex').addEventListener('keydown', e => {
  if (e.key === 'Enter'){
    const premier = el('pokedex').querySelector('.pdx-poke[data-n]');
    if (premier) premier.click();
  }
  if (e.key === 'Escape' && el('qPokedex').value){
    el('qPokedex').value = '';
    if (PDX){ dessinePokedex(); renderSaut(); }
  }
});
el('retourPokedex').onclick = () => retour({});

/* =========================================================
   Un Pokémon : toutes ses cartes
   Comme la grille d'une série, mais les cartes viennent de partout. Elles
   se rangent sur place ; un clic sur l'une ouvre sa série, la carte sortie
   de sa pochette - c'est là qu'on voit où elle se classe.
   ========================================================= */
async function ouvrirPokemon(n, o){
  const opts = o || {};
  const s = source();
  if (!s || !ENS) return;
  const jeton = ++jetonVue;
  retiensDefile();
  fermerNet();
  majAdresse('pokemon=' + n, opts.pousser);
  let d = null, pourquoi = '';
  try {
    const r = await fetch(s.url + '/pokedex/' + n, { credentials: 'same-origin' });
    d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.ok){ pourquoi = (d && d.message) || 'réponse HTTP ' + r.status; d = null; }
  } catch(e){ pourquoi = 'serveur injoignable'; }
  if (jeton !== jetonVue) return;
  if (!d){
    toast('Pokémon illisible : ' + pourquoi, true);
    majAdresse('pokedex', false);
    montrerPokedex();
    return;
  }
  /* le type choisi tient tant qu'on reste sur le même Pokémon - le temps
     d'aller voir une carte dans sa série et d'en revenir */
  if (!PK || PK.pokemon.numero !== n) FILTRE_PK.forme = '';
  PK = d;
  PK.cartes.forEach(c => { c[POS] = avecAttente(c[SID], c[NUM], c[POS]); });
  if (!PK.formes.some(f => f[0] === FILTRE_PK.forme)) FILTRE_PK.forme = '';
  CAN_WRITE = d.write === true;
  majVerrou();
  VUE = 'pokemon';
  SER = null;
  montreSeule('vuePokemon');
  outils(true);
  dessinePokemon();
  renderSaut();
  rendsDefile('pokemon', n);
}

function dessinePokemon(){
  const p = PK.pokemon, k = generationDe(p.numero);
  el('pkNom').textContent = p.nom;
  el('pkInfo').textContent = [numeroPokedex(p.numero), k >= 0 ? GENERATIONS[k][2] : '',
    PK.cartes.length + ' carte' + pluriel(PK.cartes.length)].filter(Boolean).join(' · ');
  const voisin = (id, v, avant) => {
    const b = el(id);
    b.hidden = !v;
    if (!v) return;
    b.dataset.n = v[0];
    b.textContent = avant ? '‹ ' + v[1] : v[1] + ' ›';
    b.setAttribute('aria-label', (avant ? 'Pokémon précédent : ' : 'Pokémon suivant : ') + v[1]);
  };
  voisin('pkPrec', PK.precedent, true);
  voisin('pkSuiv', PK.suivant, false);
  dessineFiltresPk();
  majJaugePk();
  dessineGrillePk();
}

/* Les types que ce Pokémon a vraiment, avec leur nombre de cartes : ni
   bouton « VMAX » pour un Pokémon qui n'en a pas, ni rangée de boutons
   pour un seul type. */
function dessineFiltresPk(){
  el('pkFormes').innerHTML = '<button type="button" class="exp-btn" data-forme="">Tous les types <span class="n">'
    + PK.cartes.length + '</span></button>'
    + PK.formes.map(f => '<button type="button" class="exp-btn" data-forme="' + esc(f[0]) + '">' + esc(f[1])
      + ' <span class="n">' + f[2] + '</span></button>').join('');
  el('pkFormes').hidden = PK.formes.length < 2;
  el('pkFormes').querySelectorAll('.exp-btn').forEach(b => b.classList.toggle('on', b.dataset.forme === FILTRE_PK.forme));
  el('pkEtat').querySelectorAll('.exp-btn').forEach(b => b.classList.toggle('on', b.dataset.etat === FILTRE_PK.etat));
}

function majJaugePk(){
  const own = PK.cartes.filter(aUne).length, tot = PK.cartes.length;
  const pct = tot ? own / tot * 100 : 0;
  el('pkOwn').textContent = own;
  el('pkTot').textContent = tot;
  el('pkBar').style.width = pct + '%';
  el('pkPct').textContent = pct.toFixed(1).replace('.', ',') + ' %';
}

function correspondPk(c){
  if (FILTRE_PK.forme && c[FRM] !== FILTRE_PK.forme) return false;
  if (FILTRE_PK.etat === 'toutes') return true;
  return FILTRE_PK.etat === 'possedees' ? aUne(c) : !aUne(c);
}
/* Une carte qui cesse de répondre au filtre reste jusqu'au prochain, comme
   dans la grille d'une série. */
function dessineGrillePk(){
  const lignes = [];
  PK.cartes.forEach((c, k) => { if (correspondPk(c)) lignes.push(tuilePkHTML(k)); });
  el('pkGrille').innerHTML = lignes.join('') || '<p class="grille-vide">Aucune carte trouvée</p>';
  el('pkGrille').classList.toggle('sans-carte', !lignes.length);
  const filtre = !!FILTRE_PK.forme || FILTRE_PK.etat !== 'toutes';
  el('pkCompte').textContent = filtre ? lignes.length + ' carte' + pluriel(lignes.length) : '';
}
function tuilePkHTML(k){
  const c = PK.cartes[k], s = PK.series[c[SID]] || {};
  const src = c[ART] ? PK.vignettes + s.bloc + '/' + c[SID] + '/' + c[ART] : '';
  const n = String(c[NUM]);
  const num = /^\d+$/.test(n) && s.officiel ? n + '/' + String(s.officiel).padStart(n.length, '0') : n;
  return '<div class="tuile ' + etatDe(c) + '" data-k="' + k + '">'
    + '<button class="tuile-img" data-k="' + k + '" aria-label="' + esc(c[NOM] + ', ' + (s.nom || '')) + '">'
    + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async">'
           : '<span class="sans-image">' + esc(c[NOM]) + '</span>')
    + '</button>'
    + '<div class="tuile-pied"><span class="tuile-num">' + esc(num) + '</span>'
    + '<span class="tuile-nom">' + esc(c[NOM]) + '</span></div>'
    + '<div class="tuile-serie">' + esc([s.nom, annee(s.date)].filter(Boolean).join(' · ')) + '</div>'
    + '<div class="tuile-ver">' + pastillesDe(c, 'data-k="' + k + '"') + '</div></div>';
}
function majTuilePk(k){
  const t = el('pkGrille').querySelector('.tuile[data-k="' + k + '"]');
  if (t) t.outerHTML = tuilePkHTML(k);
  majJaugePk();
}

function basculerPk(k, v){
  if (!peutRanger()) return;
  const c = PK.cartes[k];
  const avant = aUne(c);
  const voulu = bascule(c, c[SID], v);
  majTuilePk(k);
  suitAilleurs(c, avant, v, voulu);
}
/* Rangée depuis la page d'un Pokémon, la carte compte aussi pour la tuile
   de sa série, sur la vue d'ensemble, et pour la ligne du Pokémon dans le
   Pokédex : elles suivent sans rien redemander, comme majJauge le fait
   depuis une série. */
function suitAilleurs(c, avant, v, voulu){
  const d = (aUne(c) ? 1 : 0) - (avant ? 1 : 0);
  if (ENS){
    ENS.blocs.forEach(b => b.series.forEach(x => {
      if (x.id !== c[SID]) return;
      x.possedees += d;
      if (String(c[VER]).indexOf(v) >= 0) x.versions_possedees += voulu ? 1 : -1;
    }));
    const src = source();
    if (src) ecrireCache(src.url, ENS);
  }
  const p = PDX && PDX.pokemon.find(x => x[P_NUM] === PK.pokemon.numero);
  if (p) p[P_POS] += d;
}

el('pkGrille').addEventListener('click', e => {
  const p = e.target.closest('.pastille[data-v]');
  if (p){ basculerPk(+p.dataset.k, p.dataset.v); return; }
  const t = e.target.closest('.tuile-img[data-k]');
  if (!t) return;
  const c = PK.cartes[+t.dataset.k];
  ouvrirSerie(c[SID], { pousser: true, carte: c[NUM] });
});
el('pkFormes').addEventListener('click', e => {
  const b = e.target.closest('[data-forme]'); if (!b) return;
  FILTRE_PK.forme = b.dataset.forme;
  dessineFiltresPk(); dessineGrillePk();
});
el('pkEtat').addEventListener('click', e => {
  const b = e.target.closest('[data-etat]'); if (!b) return;
  FILTRE_PK.etat = b.dataset.etat;
  dessineFiltresPk(); dessineGrillePk();
});
['pkPrec', 'pkSuiv'].forEach(id => {
  el(id).onclick = () => ouvrirPokemon(+el(id).dataset.n, { pousser: false });
});
el('retourPokemon').onclick = () => retour({ pokedex: true });

/* ---------------- le menu de l'engrenage ---------------- */
function closeMenu(){
  el('menu').hidden = true;
  el('gear').setAttribute('aria-expanded', 'false');
}
el('gear').onclick = e => {
  e.stopPropagation();
  const ouvert = el('menu').hidden;
  if (ouvert){ fermerRecherche(); fermeSaut(); }
  el('menu').hidden = !ouvert;
  el('gear').setAttribute('aria-expanded', ouvert ? 'true' : 'false');
};
let HORS_COG = false;
document.addEventListener('mousedown', e => { HORS_COG = !e.target.closest('.cog-wrap'); });
document.addEventListener('click', e => {
  if (HORS_COG && !el('menu').hidden && !e.target.closest('.cog-wrap')) closeMenu();
});

el('gRetry').onclick = () => ouvrirEnsemble({ cible: cibleDeURL() });
el('inviteCreate').onclick = creerMaCollection;
el('homeBtn').onclick = () => { closeMenu(); fermerRecherche(); ouvrirLaMienne(); };
el('unlock').onclick = () => {
  closeMenu();
  if (!MOI.connecte){ location.href = '/abyss?connexion=1'; return; }
  if (MOI.pseudo){ ouvrirLaMienne(); return; }
  creerMaCollection();
};
function ouvrirLaMienne(){
  const i = SOURCES.findIndex(x => x.nom === MOI.pseudo);
  if (i < 0) return;
  if (i !== SRC){ choisirCollection(i); return; }
  majAdresse('', true);
  montrerBlocs();
}

async function creerMaCollection(){
  const b = el('inviteCreate');
  b.disabled = true;
  try {
    const r = await fetch('/api/pokemon', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.message || 'création impossible');
    MOI.pseudo = d.pseudo;
    SOURCES.unshift({ nom: d.pseudo, moi: true, cartes: 0, url: urlCollection(d.pseudo) });
    SRC = 0;
    ecrireCache(SOURCES[0].url, d);
    appliqueEnsemble(d, true);
    majAdresse('', false);
    montrerBlocs();
    toast('Ta collection est prête. Ouvre une série et range ta première carte.');
  } catch(e){
    toast('Création impossible : ' + (e.message || 'erreur inconnue'), true);
  }
  b.disabled = false;
}

/* ---------------- modales ---------------- */
/* `stock` : l'écran vient du stock, dont le suivi redessine la fenêtre
   toutes les deux secondes. N'importe quelle autre fenêtre l'arrête - sans
   ça, il se redessinerait par-dessus l'export qu'on vient d'ouvrir. */
function ouvrirModale(html, stock){
  if (ST && !stock) ST.jeton++;
  el('sheetbox').innerHTML = html;
  el('modal').classList.add('open');
}
function fermerModale(){
  el('modal').classList.remove('open');
  el('sheetbox').innerHTML = '';
  if (ST) ST.jeton++;
}
el('modal').addEventListener('click', e => { if (e.target === el('modal')) fermerModale(); });

/* =========================================================
   Personnaliser le classeur
   Pochettes par face, pages par classeur, une pochette par carte ou par
   version. Pour la série ouverte, ou pour toutes : les classeurs d'une
   même étagère ont souvent le même format, et le régler série par série
   sur deux cents séries serait une corvée.
   ========================================================= */
const FMT = { choix: null, partout: false };
const borne = (k, v) => Math.max(FORMAT_BORNES[k][0], Math.min(FORMAT_BORNES[k][1], v));

function ouvrirFormat(){
  closeMenu();
  FMT.choix = Object.assign({}, VUE === 'serie' && SER ? fmt() : FORMAT_DEFAUT);
  FMT.partout = VUE !== 'serie';
  const bascule = (k, titre) => {
    let boutons = '';
    for (let v = FORMAT_BORNES[k][0]; v <= FORMAT_BORNES[k][1]; v++){
      boutons += '<button type="button" class="exp-btn" data-v="' + v + '">' + v + '</button>';
    }
    return '<div class="fmt-axe"><span class="fmt-mot">' + titre + '</span>'
      + '<div class="exp-format" role="group" aria-label="' + titre + '" data-k="' + k + '">' + boutons + '</div></div>';
  };
  ouvrirModale(
    '<h2>Personnaliser le classeur</h2>'
    + (VUE === 'serie' && SER
        ? '<div class="exp-format portee" role="group" aria-label="Pour quelles séries">'
          + '<button type="button" class="exp-btn" data-partout="0">' + esc(SER.serie.nom) + '</button>'
          + '<button type="button" class="exp-btn" data-partout="1">Toutes les séries</button></div>'
        : '<p>Pour toutes les séries de la collection.</p>')
    + '<div class="fmt-apercu" id="fmtApercu" aria-hidden="true"></div>'
    + '<div class="exp-section"><div class="exp-tete"><span class="exp-titre">Pochettes par face</span></div>'
    +   '<div class="fmt-axes">' + bascule('colonnes', 'Colonnes') + bascule('rangees', 'Rangées') + '</div></div>'
    + '<div class="exp-section"><div class="exp-tete"><span class="exp-titre">Pages</span>'
    +   '<span class="exp-note">recto verso</span></div>'
    +   '<div class="fmt-pages">'
    +     '<button type="button" class="exp-btn fmt-auto" id="fmtAuto">Juste la série</button>'
    +     '<button type="button" class="fmt-pas" data-pas="-1" aria-label="Une page de moins">&minus;</button>'
    +     '<input id="fmtPages" type="number" inputmode="numeric" min="' + FORMAT_BORNES.pages[0]
    +     '" max="' + FORMAT_BORNES.pages[1] + '" aria-label="Nombre de pages">'
    +     '<button type="button" class="fmt-pas" data-pas="1" aria-label="Une page de plus">+</button>'
    +   '</div></div>'
    + '<div class="exp-section"><div class="exp-tete"><span class="exp-titre">Les versions</span></div>'
    +   '<div class="exp-format fmt-versions" role="group" aria-label="Les versions">'
    +     '<button type="button" class="exp-btn" data-versions="0">Une pochette par carte</button>'
    +     '<button type="button" class="exp-btn" data-versions="1">Une par version</button></div></div>'
    + '<p class="exp-info" id="fmtInfo"></p>'
    + '<div class="row"><button class="act ghost" id="fmtAnnuler">Annuler</button>'
    + '<button class="act" id="fmtGo">Enregistrer</button></div>');
  const b = el('sheetbox'), champ = el('fmtPages');
  el('fmtAnnuler').onclick = fermerModale;
  el('fmtGo').onclick = enregistrerFormat;
  b.querySelectorAll('.fmt-axe .exp-format').forEach(g => g.querySelectorAll('.exp-btn').forEach(x =>
    x.onclick = () => { FMT.choix[g.dataset.k] = +x.dataset.v; dessineFormat(); }));
  b.querySelectorAll('[data-partout]').forEach(x => x.onclick = () => { FMT.partout = x.dataset.partout === '1'; dessineFormat(); });
  b.querySelectorAll('[data-versions]').forEach(x => x.onclick = () => { FMT.choix.versions = x.dataset.versions === '1'; dessineFormat(); });
  el('fmtAuto').onclick = () => { FMT.choix.pages = FMT.choix.pages ? null : 20; dessineFormat(); };
  champ.addEventListener('input', () => {
    const v = parseInt(champ.value, 10);
    if (v === borne('pages', v)){ FMT.choix.pages = v; dessineFormat(); }
  });
  champ.addEventListener('change', () => {
    const v = parseInt(champ.value, 10);
    if (!isNaN(v)) FMT.choix.pages = borne('pages', v);
    dessineFormat();
  });
  champ.addEventListener('keydown', e => { if (e.key === 'Enter') champ.blur(); });
  b.querySelectorAll('.fmt-pas').forEach(x => x.onclick = () => {
    FMT.choix.pages = borne('pages', (FMT.choix.pages || 20) + Number(x.dataset.pas));
    dessineFormat();
  });
  dessineFormat();
}
function dessineFormat(){
  const f = FMT.choix, b = el('sheetbox');
  if (!f || !el('fmtApercu')) return;
  b.querySelectorAll('.fmt-axe .exp-format').forEach(g => g.querySelectorAll('.exp-btn').forEach(x => {
    const on = +x.dataset.v === f[g.dataset.k];
    x.classList.toggle('on', on);
    x.setAttribute('aria-pressed', on);
  }));
  b.querySelectorAll('[data-partout]').forEach(x => x.classList.toggle('on', (x.dataset.partout === '1') === FMT.partout));
  b.querySelectorAll('[data-versions]').forEach(x => x.classList.toggle('on', (x.dataset.versions === '1') === f.versions));
  el('fmtAuto').classList.toggle('on', !f.pages);
  el('fmtPages').disabled = !f.pages;
  el('fmtPages').value = f.pages || '';
  el('fmtPages').placeholder = f.pages ? '' : 'auto';
  b.querySelectorAll('.fmt-pas').forEach(x => {
    x.disabled = !f.pages || borne('pages', f.pages + Number(x.dataset.pas)) === f.pages;
  });
  const haut = 78, ecart = 3;
  const h = (haut - (f.rangees - 1) * ecart) / f.rangees;
  const a = el('fmtApercu');
  a.style.setProperty('--fc', f.colonnes);
  a.style.setProperty('--fh', h.toFixed(2) + 'px');
  a.style.setProperty('--fw', (h * 63 / 88).toFixed(2) + 'px');
  const face = '<div class="fmt-face">' + '<i></i>'.repeat(f.colonnes * f.rangees) + '</div>';
  a.innerHTML = face + '<span class="fmt-dos"></span>' + face;
  const parPg = 2 * f.colonnes * f.rangees;
  let info = '<b>' + parPg + '</b> pochettes par page';
  if (VUE === 'serie' && SER && !FMT.partout){
    const n = f.versions ? SER.cartes.reduce((t, c) => t + String(c[VER]).length, 0) : SER.cartes.length;
    const pages = Math.ceil(n / parPg);
    info += ' · ' + esc(SER.serie.nom) + ' : <b>' + n + '</b> pochette' + pluriel(n) + ', ';
    if (!f.pages) info += '<b>' + pages + '</b> page' + pluriel(pages);
    else {
      const tomes = Math.max(1, Math.ceil(n / (parPg * f.pages)));
      info += '<b>' + tomes + '</b> classeur' + pluriel(tomes) + ' de ' + f.pages + ' pages';
    }
  }
  el('fmtInfo').innerHTML = info;
}
async function enregistrerFormat(){
  const f = FMT.choix;
  const b = el('fmtGo');
  b.disabled = true;
  let d = null, pourquoi = '';
  try {
    const r = await fetch('/api/pokemon/format', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ serie: SER ? SER.serie.id : '', partout: FMT.partout }, f)),
    });
    d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.ok) pourquoi = (d && d.message) || 'réponse HTTP ' + r.status;
  } catch(e){ pourquoi = 'serveur injoignable'; }
  if (pourquoi){ toast('Pas enregistré : ' + pourquoi, true); b.disabled = false; return; }
  fermerModale();
  if (SER){
    /* la même carte reste sous les yeux, où que le nouveau découpage
       l'envoie : la première pochette de la double-page affichée */
    const debut = T().debut + (S.spread === 0 ? 0 : (S.spread - 1) * parPage() + parFace());
    const ici = POCHES[Math.min(debut, POCHES.length - 1)];
    if (FMT.partout || d.serie === SER.serie.id) SER.format = formatSur(d.format);
    relie();
    if (ici){
      const g = POCHES.findIndex(p => p.i === ici.i);
      const t = TOMES.findIndex(x => g >= x.debut && g < x.fin);
      S.c = Math.max(0, t);
      S.spread = Math.min(sheets(), spreadDe(Math.max(0, g) - T().debut));
    }
    renderClasseurs(); render();
  }
  toast(FMT.partout ? 'Format enregistré pour toutes les séries.' : 'Format enregistré.');
}
el('formatBtn').onclick = ouvrirFormat;

/* =========================================================
   Exporter
   Une ligne par version : c'est la seule façon de dire « j'ai la normale,
   il me manque la reverse ». La série ouverte, les séries commencées, ou
   toute la collection - qui vient alors du serveur, la page n'en ayant
   qu'une série en main.
   ========================================================= */
function telecharge(contenu, type, nom){
  const blob = new Blob([contenu], { type: type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nom; a.style.display = 'none';
  document.body.appendChild(a);
  a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function slug(n){
  return String(n == null ? '' : n).normalize('NFD').replace(/[̀-ͯ]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}
function celluleCSV(v){
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function ouvrirExport(){
  closeMenu();
  if (!ENS){ toast('Rien à exporter.', true); return; }
  const s = source();
  const portees = (VUE === 'serie' && SER ? [['serie', esc(SER.serie.nom)]] : [])
    .concat([['commencees', 'Séries commencées'], ['tout', 'Toute la collection']]);
  ouvrirModale(
    '<h2>Exporter la collection</h2>'
    + '<p>' + esc(s && s.nom ? 'La collection de ' + s.nom : 'Cette collection')
    + ', une ligne par version de carte.</p>'
    + '<div class="exp-format exp-quel" role="group" aria-label="Format du fichier">'
    +   '<button type="button" class="exp-btn on" data-format="csv">CSV</button>'
    +   '<button type="button" class="exp-btn" data-format="json">JSON</button></div>'
    + '<div class="exp-section"><div class="exp-tete"><span class="exp-titre">Séries</span></div>'
    +   '<div class="exp-format exp-ou" role="group" aria-label="Quelles séries">'
    +   portees.map((p, k) => '<button type="button" class="exp-btn' + (k ? '' : ' on') + '" data-ou="' + p[0] + '">' + p[1] + '</button>').join('')
    +   '</div></div>'
    + '<div class="exp-section"><div class="exp-tete"><span class="exp-titre">Quelles versions</span></div>'
    +   '<div class="exp-format exp-quoi" role="group" aria-label="Quelles versions">'
    +     '<button type="button" class="exp-btn on" data-quoi="possedees">Possédées</button>'
    +     '<button type="button" class="exp-btn" data-quoi="manquantes">Manquantes</button>'
    +     '<button type="button" class="exp-btn" data-quoi="tout">Tout</button></div></div>'
    + '<p class="exp-info" id="expInfo"></p>'
    + '<div class="row"><button class="act ghost" id="expAnnuler">Annuler</button>'
    + '<button class="act" id="expGo">Exporter</button></div>');
  const b = el('sheetbox');
  b.querySelectorAll('.exp-format').forEach(g => g.querySelectorAll('.exp-btn').forEach(x => x.onclick = () => {
    g.querySelectorAll('.exp-btn').forEach(y => y.classList.remove('on'));
    x.classList.add('on');
    majExportInfo();
  }));
  el('expAnnuler').onclick = fermerModale;
  el('expGo').onclick = lancerExport;
  majExportInfo();
}
const choixExp = sel => el('sheetbox').querySelector(sel + ' .exp-btn.on').dataset;
function majExportInfo(){
  const ou = choixExp('.exp-ou').ou;
  let n = 0;
  if (ou === 'serie' && SER) n = 1;
  else ENS.blocs.forEach(b => b.series.forEach(s => { if (ou === 'tout' || s.possedees) n++; }));
  el('expInfo').innerHTML = '<b>' + n + '</b> série' + pluriel(n);
}
async function lancerExport(){
  const format = choixExp('.exp-quel').format, ou = choixExp('.exp-ou').ou, quoi = choixExp('.exp-quoi').quoi;
  const ids = ou === 'serie' && SER ? [SER.serie.id]
    : ou === 'commencees' ? ENS.blocs.reduce((t, b) => t.concat(b.series.filter(s => s.possedees).map(s => s.id)), [])
    : [];
  if (ou === 'commencees' && !ids.length){ toast('Aucune série commencée : rien à exporter.', true); return; }
  el('expGo').disabled = true;
  let d = null;
  try {
    const r = await fetch(source().url + '/export' + (ids.length ? '?series=' + ids.map(encodeURIComponent).join(',') : ''),
                          { credentials: 'same-origin' });
    d = await r.json();
  } catch(e){}
  if (!el('expGo')) return;
  if (!d || !d.ok){ toast("L'export n'a pas pu être lu.", true); el('expGo').disabled = false; return; }
  const lignes = [];
  d.series.forEach(s => s.cartes.forEach(c => {
    const vs = ordonne(String(c[3]) + String(c[4] || ''));
    for (const v of vs){
      const a = String(c[4] || '').indexOf(v) >= 0;
      if (quoi === 'possedees' && !a) continue;
      if (quoi === 'manquantes' && a) continue;
      lignes.push({ bloc: s.bloc, serie: s.nom, numero: c[0], nom: c[1], rarete: c[2],
                    version: NOM_VERSION[v], possedee: a ? 'oui' : 'non' });
    }
  }));
  if (!lignes.length){ toast('Rien à exporter avec cette sélection.', true); el('expGo').disabled = false; return; }
  const nom = 'pokemon-' + (slug(source().nom) || 'collection') + (ou === 'serie' && SER ? '-' + slug(SER.serie.nom) : '');
  const colonnes = ['bloc', 'serie', 'numero', 'nom', 'rarete', 'version', 'possedee'];
  if (format === 'json') telecharge(JSON.stringify(lignes, null, 2), 'application/json', nom + '.json');
  else telecharge('﻿' + colonnes.join(',') + '\n'
    + lignes.map(l => colonnes.map(k => celluleCSV(l[k])).join(',')).join('\n'), 'text/csv;charset=utf-8', nom + '.csv');
  fermerModale();
}
el('exportBtn').onclick = ouvrirExport;

/* =========================================================
   Les cartes favorites
   Trois cartes parmi toutes celles du catalogue - une favorite est une
   carte qu'on aime, pas une carte qu'on a. L'accueil d'Abyss les montre en
   éventail sur la tuile de la collection. Rien n'est écrit avant
   « Enregistrer ».
   ========================================================= */
const FAV_MAXI = 3;
const FAV = { cartes: [], minuteur: null, jeton: 0 };
async function apiFav(chemin, corps){
  const r = await fetch('/api/pokemon' + chemin, corps ? {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps),
  } : { credentials: 'same-origin' });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !d.ok) throw new Error((d && d.message) || 'http ' + r.status);
  return d;
}
const vignetteFav = c => c.image
  ? '<img src="' + esc(c.image) + '" alt="" loading="lazy" decoding="async">'
  : '<span class="fav-sans">' + esc(c.nom) + '</span>';
async function ouvrirFavorites(){
  closeMenu();
  FAV.cartes = [];
  ouvrirModale('<h2>Cartes favorites</h2>'
    + '<div class="fav-places" id="favPlaces"></div>'
    + '<input class="fav-champ" id="favChamp" type="search" autocomplete="off" spellcheck="false"'
    + ' placeholder="Chercher une carte…" aria-label="Chercher une carte du catalogue">'
    + '<div class="fav-resultats" id="favResultats"></div>'
    + '<div class="row"><button class="act ghost" id="favAnnuler">Annuler</button>'
    + '<button class="act" id="favGo">Enregistrer</button></div>');
  el('favAnnuler').onclick = fermerModale;
  el('favGo').onclick = enregistrerFavorites;
  el('favChamp').addEventListener('input', () => {
    clearTimeout(FAV.minuteur);
    FAV.minuteur = setTimeout(chercherFavorites, 250);
  });
  dessinePlaces();
  el('favChamp').focus();
  try {
    FAV.cartes = (await apiFav('/favorites')).cartes || [];
    if (el('favPlaces')) dessinePlaces();
  } catch(e){ toast('Favorites illisibles : ' + e.message, true); }
}
function dessinePlaces(){
  const zone = el('favPlaces');
  if (!zone) return;
  let html = '';
  for (let i = 0; i < FAV_MAXI; i++){
    const c = FAV.cartes[i];
    html += c ? '<div class="fav-place pleine">' + vignetteFav(c)
        + '<span class="fav-nom">' + esc(c.nom) + '</span>'
        + '<button type="button" class="fav-retirer" data-i="' + i + '" aria-label="Retirer ' + esc(c.nom) + '">&#10005;</button></div>'
      : '<div class="fav-place"><span class="fav-rang">' + (i + 1) + '</span></div>';
  }
  zone.innerHTML = html;
  zone.querySelectorAll('.fav-retirer').forEach(b => b.onclick = () => {
    FAV.cartes.splice(+b.dataset.i, 1);
    dessinePlaces(); marqueResultats();
  });
}
async function chercherFavorites(){
  const q = el('favChamp') ? el('favChamp').value.trim() : '';
  const jeton = ++FAV.jeton;
  const zone = el('favResultats');
  if (q.length < 2){ zone.innerHTML = ''; return; }
  try {
    const cartes = (await apiFav('/catalogue?q=' + encodeURIComponent(q))).cartes || [];
    if (jeton !== FAV.jeton || !el('favResultats')) return;
    zone.innerHTML = cartes.length ? cartes.map((c, i) =>
      '<button type="button" class="fav-carte" data-k="' + i + '" data-id="' + esc(c.id) + '">' + vignetteFav(c)
      + '<span>' + esc(c.nom) + '<i>' + esc(c.serie_nom + ' · ' + c.numero) + '</i></span></button>').join('')
      : '<p class="fav-info">Aucune carte ne porte ce nom.</p>';
    zone.querySelectorAll('.fav-carte').forEach(b => b.onclick = () => choisirFavorite(cartes[+b.dataset.k]));
    marqueResultats();
  } catch(e){
    if (jeton === FAV.jeton && el('favResultats')) zone.innerHTML = '<p class="fav-info">La recherche n’a pas répondu.</p>';
  }
}
function marqueResultats(){
  const choisies = new Set(FAV.cartes.map(c => c.id));
  document.querySelectorAll('#favResultats .fav-carte').forEach(b => b.classList.toggle('on', choisies.has(b.dataset.id)));
}
function choisirFavorite(c){
  const i = FAV.cartes.findIndex(x => x.id === c.id);
  if (i >= 0) FAV.cartes.splice(i, 1);
  else if (FAV.cartes.length >= FAV_MAXI){ toast('Trois favorites au plus : retires-en une avant.', true); return; }
  else FAV.cartes.push(c);
  dessinePlaces(); marqueResultats();
}
async function enregistrerFavorites(){
  const b = el('favGo');
  b.disabled = true;
  try {
    await apiFav('/favorites', { cartes: FAV.cartes.map(c => c.id) });
    fermerModale();
    toast(FAV.cartes.length ? 'Favorites enregistrées.' : 'Favorites retirées.');
  } catch(e){ toast('Pas enregistrées : ' + e.message, true); b.disabled = false; }
}
el('favBtn').onclick = ouvrirFavorites;

/* ---------------- suggestion / bug : sur place, comme ailleurs ---------------- */
if (window.Suggestion){
  Suggestion.branche({ bouton: 'suggBtn', projet: 'pokemon', estConnecte: () => MOI.connecte,
                       toast: (txt, mauvais) => toast(txt, mauvais) });
}

/* ---------------- bascule des reflets ---------------- */
let REFLETS = true;
try { REFLETS = localStorage.getItem('pokemon-reflets') !== '0'; } catch(e){}
function majReflets(){
  document.body.classList.toggle('sansreflets', !REFLETS);
  el('shine').classList.toggle('off', !REFLETS);
  el('shine').setAttribute('aria-pressed', REFLETS ? 'true' : 'false');
}
el('shine').onclick = () => {
  REFLETS = !REFLETS;
  try { localStorage.setItem('pokemon-reflets', REFLETS ? '1' : '0'); } catch(e){}
  majReflets();
};
majReflets();

/* =========================================================
   Le stock de cartes
   Une série paraît : ses cartes, leurs noms français, leurs raretés,
   leurs versions et leurs images sont chez TCGdex. Ce bouton les fait
   venir, série par série, rangées par bloc. Le téléchargement tourne sur le
   serveur (voir pokemon_stock.py) : la fenêtre peut se fermer, il continue,
   et elle reprend où il en est quand on la rouvre.
   ========================================================= */
let ST = null;
async function apiStock(chemin, corps){
  const r = await fetch('/api/pokemon-stock' + chemin, corps ? {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps),
  } : { credentials: 'same-origin' });
  const d = await r.json().catch(() => null);
  if (r.status === 404) throw new Error("réservé à l'administration");
  if (!r.ok || !d || !d.ok) throw new Error((d && d.message) || 'http ' + r.status);
  return d;
}
function stockEcran(titre, html){
  ouvrirModale('<h2>' + esc(titre) + '</h2><div class="st-corps">' + html + '</div>', true);
}
function stockPanne(titre, souci, reprendre){
  stockEcran(titre, '<div class="st-erreur">' + esc(souci) + '</div>'
    + '<div class="row"><button class="act ghost" id="stFermer">Fermer</button>'
    + (reprendre ? '<button class="act" id="stEncore">Réessayer</button>' : '') + '</div>');
  el('stFermer').onclick = fermerModale;
  if (reprendre) el('stEncore').onclick = reprendre;
}

async function ouvrirStock(frais){
  closeMenu();
  if (!MOI.admin){ toast("Le stock est réservé à l'administration.", true); return; }
  ST = { jeton: 0, blocs: [], choix: new Set(), fini: false };
  const jeton = ++ST.jeton;
  stockEcran('Mettre à jour le stock', '<p class="st-info">Lecture des séries parues chez TCGdex…</p>');
  let d;
  try { d = await apiStock('/series' + (frais ? '?frais=1' : '')); }
  catch(e){
    if (ST.jeton !== jeton) return;
    stockPanne('Mettre à jour le stock', 'La liste des séries n’a pas pu être lue : ' + e.message, () => ouvrirStock(true));
    return;
  }
  if (ST.jeton !== jeton) return;
  ST.blocs = d.blocs || [];
  if (d.chantier && d.chantier.actif){ suivreChantier(); return; }
  ST.blocs.forEach(b => b.series.forEach(s => { if (aFaire(s)) ST.choix.add(s.id); }));
  stockDessineListe();
}

/* Ce qui reste à faire pour une série : rien au catalogue, des images qui
   manquent, ou des cartes que TCGdex a et pas nous. Une image que TCGdex
   n'a dans aucune langue ne manque pas : il n'y a rien à aller chercher. */
const imagesManquantes = s => Math.max(0, s.cartes - s.images - (s.sans_image || 0));
function aFaire(s){ return !s.cartes || imagesManquantes(s) > 0 || s.total > s.cartes; }
function etatStock(s){
  if (!s.cartes) return '<span class="st-tag neuf">nouvelle</span>';
  const bouts = [];
  if (s.total > s.cartes) bouts.push('+' + (s.total - s.cartes) + ' carte' + pluriel(s.total - s.cartes));
  const n = imagesManquantes(s);
  if (n) bouts.push(n + ' image' + pluriel(n));
  return bouts.length ? '<span class="st-tag manque">' + esc(bouts.join(' · ')) + '</span>'
                      : '<span class="st-tag ok">à jour</span>';
}
function stockDessineListe(){
  const blocs = ST.blocs;
  const n = ST.choix.size;
  const images = blocs.reduce((t, b) => t + b.series.reduce((u, s) =>
    u + (ST.choix.has(s.id) ? Math.max(0, s.total - s.images) : 0), 0), 0);
  stockEcran('Mettre à jour le stock',
    '<p class="st-info">Les séries parues en français chez TCGdex. Leurs cartes, leurs raretés, leurs versions'
    + ' et leurs images sont téléchargées et rangées par bloc. Ce qui est déjà sur le disque ne repart pas.</p>'
    + '<div class="st-outils">'
    +   '<button type="button" class="exp-btn" id="stManque">Ce qui manque</button>'
    +   '<button type="button" class="exp-btn" id="stTout">Tout</button>'
    +   '<button type="button" class="exp-btn" id="stRien">Rien</button>'
    +   '<button type="button" class="exp-btn" id="stFrais">Relire TCGdex</button></div>'
    + '<div class="st-blocs">' + blocs.map(b => {
        const tous = b.series.every(s => ST.choix.has(s.id));
        return '<div class="st-bloc"><label class="st-bloc-tete"><input type="checkbox" data-bloc="' + esc(b.id) + '"'
          + (tous ? ' checked' : '') + '><b>' + esc(b.nom) + '</b><span>' + esc(annee(b.date)) + '</span></label>'
          + b.series.map(s => '<label class="st-serie"><input type="checkbox" data-serie="' + esc(s.id) + '"'
            + (ST.choix.has(s.id) ? ' checked' : '') + '><span class="st-serie-nom">' + esc(s.nom) + '</span>'
            + '<span class="st-serie-info">' + esc([dateFr(s.date), s.total + ' carte' + pluriel(s.total)].filter(Boolean).join(' · '))
            + '</span>' + etatStock(s) + '</label>').join('') + '</div>';
      }).join('') + '</div>'
    + '<p class="exp-info"><b>' + n + '</b> série' + pluriel(n) + ', environ <b>' + nombre(images)
    + '</b> image' + pluriel(images) + ' à télécharger</p>'
    + '<div class="row"><button class="act ghost" id="stFermer">Fermer</button>'
    + '<button class="act" id="stGo"' + (n ? '' : ' disabled') + '>Télécharger</button></div>');
  const b = el('sheetbox');
  b.querySelectorAll('[data-serie]').forEach(x => x.onchange = () => {
    if (x.checked) ST.choix.add(x.dataset.serie); else ST.choix.delete(x.dataset.serie);
    redessine();
  });
  b.querySelectorAll('[data-bloc]').forEach(x => x.onchange = () => {
    const bloc = ST.blocs.find(y => y.id === x.dataset.bloc);
    bloc.series.forEach(s => { if (x.checked) ST.choix.add(s.id); else ST.choix.delete(s.id); });
    redessine();
  });
  const tous = f => { ST.choix = new Set(); ST.blocs.forEach(y => y.series.forEach(s => { if (f(s)) ST.choix.add(s.id); })); redessine(); };
  el('stManque').onclick = () => tous(aFaire);
  el('stTout').onclick = () => tous(() => true);
  el('stRien').onclick = () => tous(() => false);
  el('stFrais').onclick = () => ouvrirStock(true);
  el('stFermer').onclick = fermerModale;
  el('stGo').onclick = lancerStock;
  function redessine(){
    const haut = el('sheetbox').querySelector('.st-blocs').scrollTop;
    stockDessineListe();
    el('sheetbox').querySelector('.st-blocs').scrollTop = haut;
  }
}

async function lancerStock(){
  /* dans l'ordre de TCGdex, du plus ancien au plus récent : le classeur
     voit ses blocs se remplir dans l'ordre où ils sont parus */
  const ids = [];
  ST.blocs.slice().reverse().forEach(b => b.series.slice().reverse().forEach(s => { if (ST.choix.has(s.id)) ids.push(s.id); }));
  el('stGo').disabled = true;
  try { await apiStock('/telecharger', { series: ids }); }
  catch(e){ toast('Téléchargement impossible : ' + e.message, true); el('stGo').disabled = false; return; }
  suivreChantier();
}

/* Le chantier, vu d'ici : la page demande toutes les deux secondes où il
   en est, tant que la fenêtre est ouverte. */
async function suivreChantier(){
  const jeton = ST.jeton;
  let d;
  try { d = (await apiStock('/chantier')).chantier; }
  catch(e){
    if (ST.jeton !== jeton) return;
    stockPanne('Téléchargement', 'Le serveur n’a pas répondu : ' + e.message, suivreChantier);
    return;
  }
  if (ST.jeton !== jeton) return;
  dessineChantier(d);
  if (d.actif) setTimeout(() => { if (ST && ST.jeton === jeton) suivreChantier(); }, 2000);
  else if (!ST.fini){ ST.fini = true; rafraichitApresStock(); }
}
function dessineChantier(d){
  const ec = d.en_cours;
  const faites = d.faites || [];
  const images = faites.reduce((t, x) => t + (x.images || 0), 0) + (ec ? ec.images || 0 : 0);
  const reste = (d.file || []).length;
  let tete;
  if (ec){
    const pct = ec.a_telecharger ? Math.round(ec.images / ec.a_telecharger * 100) : 0;
    tete = '<p class="st-info">' + (ec.bloc ? esc(ec.bloc) + ' · ' : '') + '<b>' + esc(ec.nom) + '</b>'
      + (ec.etape === 'catalogue' ? ' : lecture du catalogue…'
         : ' : ' + ec.images + ' / ' + ec.a_telecharger + ' image' + pluriel(ec.a_telecharger)) + '</p>'
      + '<div class="st-jauge"><i style="width:' + pct + '%"></i></div>';
  } else {
    tete = '<p class="st-info">' + (d.arret ? 'Arrêté.' : 'Terminé.') + '</p>';
  }
  stockEcran(d.actif ? 'Téléchargement en cours' : 'Stock à jour',
    tete
    + '<div class="st-chiffres">'
    +   '<span class="st-chiffre"><b>' + faites.length + '</b><u>série' + pluriel(faites.length) + ' faite' + pluriel(faites.length) + '</u></span>'
    +   '<span class="st-chiffre"><b>' + reste + '</b><u>en attente</u></span>'
    +   '<span class="st-chiffre"><b>' + nombre(images) + '</b><u>image' + pluriel(images) + ' téléchargée' + pluriel(images) + '</u></span>'
    + '</div>'
    + (faites.length ? '<div class="st-liste">' + faites.slice().reverse().slice(0, 40).map(x =>
        '<div class="st-ligne"><span class="st-nom">' + esc(x.nom) + '</span>'
        + '<span class="st-date">' + (x.souci ? esc(x.souci)
            : x.cartes + ' carte' + pluriel(x.cartes) + ' · ' + x.images + ' image' + pluriel(x.images)
              + (x.echecs ? ' · ' + x.echecs + ' ratée' + pluriel(x.echecs) : '')
              + (x.sans_image ? ' · ' + x.sans_image + ' sans image chez TCGdex' : '')) + '</span></div>').join('') + '</div>' : '')
    + ((d.erreurs || []).length ? '<details class="st-details"><summary>' + d.erreurs.length + ' souci'
        + pluriel(d.erreurs.length) + '</summary><div class="st-erreur">' + d.erreurs.map(esc).join('<br>') + '</div></details>' : '')
    + (d.actif ? '<p class="st-info st-notes">La fenêtre peut se fermer : le téléchargement continue sur le serveur.</p>' : '')
    + '<div class="row">'
    + (d.actif ? '<button class="act ghost" id="stArret"' + (d.arret ? ' disabled' : '') + '>'
        + (d.arret ? 'Arrêt demandé…' : 'Arrêter') + '</button>' : '<button class="act ghost" id="stListe">Autres séries</button>')
    + '<button class="act" id="stFermer">Fermer</button></div>');
  el('stFermer').onclick = fermerModale;
  if (el('stArret')) el('stArret').onclick = async () => {
    try { await apiStock('/arreter', {}); } catch(e){}
    suivreChantier();
  };
  if (el('stListe')) el('stListe').onclick = () => ouvrirStock(false);
}

/* Le catalogue vient de changer : la vue d'ensemble et la série ouverte
   datent d'avant. On les relit plutôt que de laisser une page qui ment. */
async function rafraichitApresStock(){
  const s = source();
  if (!s || SRC < 0) return;
  const d = await chargeEnsemble(true);
  if (!d) return;
  appliqueEnsemble(d, true);
  PDX = null;
  if (VUE === 'blocs') montrerBlocs();
  else if (VUE === 'serie' && SER) ouvrirSerie(SER.serie.id, { pousser: false });
  else if (VUE === 'pokedex') montrerPokedex({ pousser: false });
  else if (VUE === 'pokemon' && PK) ouvrirPokemon(PK.pokemon.numero, { pousser: false });
}

el('stockBtn').onclick = () => ouvrirStock(false);

/* ---------------- démarrage ----------------
   L'annuaire d'abord : sans lui on ne sait ni quelle collection ouvrir ni
   qui regarde. Une adresse /pokemon/<pseudo> passe avant tout le reste. */
(async function demarrer(){
  setSync('offline', 'connexion...');
  try { await chargeAnnuaire(); }
  catch(e){
    showGate("<b>Serveur injoignable.</b> Le hub Abyss ne répond pas.");
    return;
  }
  const demande = pseudoDeURL();
  // sa propre adresse, avant d'avoir une collection : l'invitation à la
  // créer, et non « n'existe pas » (voir le même cas dans collection.js)
  if (demande && !MOI.pseudo && MOI.compte && norm(demande) === norm(MOI.compte)){
    showInvite(); return;
  }
  if (demande) SRC = rangDeLaCollection(demande);
  else if (!MOI.connecte){ showAccueil(); return; }
  else if (!MOI.pseudo){ showInvite(); return; }
  else SRC = 0;
  majEntete();
  ouvrirEnsemble({ cible: cibleDeURL() });
})();
