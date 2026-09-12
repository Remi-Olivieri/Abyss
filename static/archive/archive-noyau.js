/* =======================================================================
   Archive Jeux Vidéos - archive-noyau.js

   Les fondations : formats, échelle de couleur, jaquettes, tarifs.

   Rien ici ne connaît le classeur affiché ni le DOM de la page. Ce sont
   les outils dont tout le reste se sert : mise en forme des nombres et des
   dates, statuts « En cours » / « Wishlist », table des tris, manifeste
   des jaquettes, prix Steam des jeux convoités, couleur d'une note.

   Premier de la chaîne, donc, et le seul qu'on puisse lire seul.

   Chargé par templates/archive/archive.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */

/* Les journaux disponibles, remplis par l'annuaire au démarrage. Plus
   aucune adresse en dur : le serveur sait qui a un journal public, et les
   pseudos changent sans qu'on touche à ce fichier.
   L'`url` est le chemin de l'API : tout le reste de la page (cache local,
   mémoire du dernier classeur ouvert) continue de s'en servir comme clé. */
let SOURCES = [];

const CONFIG = { // Configs pour les covers
  imageDir: "/static/Cover/",
  imageExt: "webp",
  coverRatio: "3 / 4",
};

/* ---------- Utilitaires ---------- */
const EUR = new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'});
const MONTHS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const norm = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[’'`.:]/g,' ').replace(/\s+/g,' ').trim();
const clean = s => (s||'').toString().replace(/\u00a0/g,' ').trim();
const $ = id => document.getElementById(id);
/* Ferme une fenêtre au clic sur son fond, mais pas quand ce clic est en
   fait la fin d'une sélection de texte commencée dans la fenêtre : le
   mousedown part du contenu, la souris dérape pendant le geste, et le
   'click' qui suit atterrit sur le fond - sans ce garde-fou ça fermait la
   fenêtre en pleine modification. On ne ferme que si le clic ET le
   mousedown qui le précède visaient tous les deux le fond lui-même. */
function fermeSurFond(id, ferme){
  const fond = $(id);
  let surFond = false;
  fond.addEventListener('mousedown', e=>{ surFond = e.target.id === id; });
  fond.addEventListener('click', e=>{
    if(surFond && e.target.id === id) ferme();
    surFond = false;
  });
  /* Sur un téléphone, la même fermeture au doigt : la feuille se repousse
     par sa poignée. C'est ici qu'on la branche parce que chaque fenêtre
     passe déjà par là pour dire « voici mon fond, voici comment je me
     ferme » - les deux seules choses dont le geste a besoin. Voir
     static/commun/gestes.js. */
  poigneeFeuille(fond, ferme);
  /* Et c'est aussi ce qui suffit à Échap : le fond dit quelle fenêtre, la
     fonction dit comment la fermer. On retient les deux (voir FERMETURES
     plus bas) plutôt que de tenir ailleurs une liste des fenêtres et de
     leurs fermetures - une liste pareille était écrite à la main dans
     archive-fiche.js, et trois fenêtres y manquaient. */
  FERMETURES.set(id, ferme);
}
/* ---------- Échap ferme la fenêtre du dessus ----------
   Rempli par fermeSurFond ci-dessus : toute fenêtre qui se ferme au clic
   sur son fond y est, et aucune ne peut être oubliée - c'est le même appel
   qui l'inscrit. La fenêtre de suggestion n'y est pas et n'a pas à y être :
   elle prend Échap pour son compte, en capture (voir
   static/commun/suggestion.js).

   Il y avait à la place une cascade de dix `if` dans archive-fiche.js, à
   tenir à jour à la main - « si le zoom est ouvert..., sinon si le détail
   est ouvert..., sinon la fiche ». Trois fenêtres arrivées après elle n'y
   figuraient pas : le renommage d'un onglet (rattrapé), puis les avis des
   joueurs et une discussion. D'où le dégât : les avis ouverts par-dessus
   une fiche, Échap tombait sur la dernière branche et refermait LA FICHE
   DESSOUS - et les avis avec, par l'écoute d'archive-social.js. Une touche
   qui ferme deux fenêtres dont une qu'on ne visait pas.

   La pile n'a de toute façon pas d'ordre écrit d'avance : la fiche ouvre
   les avis, un avis ouvre sa discussion, la discussion rouvre la fiche du
   jeu, et c'est auPremierPlan() qui tranche au moment où ça arrive. Échap
   lit donc la même chose que l'œil - qui est devant - au lieu d'une liste
   qui prétend le savoir. */
const FERMETURES = new Map();
/* La plus haute des fenêtres visibles. À z-index égal, la dernière dans le
   document : c'est déjà l'ordre dans lequel le navigateur les peint, donc
   celle qu'on voit. Le cas ne se présente guère - tout ce qui peut
   s'empiler passe par auPremierPlan - mais le départage doit dire vrai. */
function fenetreDuDessus(){
  let haut = null, z = -1;
  document.querySelectorAll('.sheet-back').forEach(el=>{
    if(el.hidden || !FERMETURES.has(el.id)) return;
    const v = parseInt(getComputedStyle(el).zIndex, 10);
    const n = isNaN(v) ? 0 : v;
    if(n >= z){ z = n; haut = el; }
  });
  return haut;
}
/* « Est-ce moi qu'on regarde ? » - la question des flèches. Feuilleter la
   fiche du mur ou les captures d'un jeu ne doit se faire que sur la fenêtre
   du dessus : les flèches changeaient le jeu de la fiche pendant qu'on
   lisait les avis posés par-dessus, sous une fenêtre qui continuait, elle,
   de parler du premier. */
const estDuDessus = id => { const el = fenetreDuDessus(); return !!el && el.id === id; };
function fermeFenetreDuDessus(){
  const el = fenetreDuDessus();
  if(!el) return false;
  const ferme = FERMETURES.get(el.id);
  if(ferme) ferme();
  return true;
}
/* Ce qu'Échap fait quand il n'y a AUCUNE fenêtre ouverte : refermer un
   panneau de la barre du haut, ou enlever la tranche de notes choisie. La
   page du journal pose sa chaîne ici, depuis archive-demarrage.js qui est
   le seul à connaître tout le monde ; le Social n'a rien à y mettre.

   Dans le même écouteur que la fenêtre du dessus, et c'est tout l'intérêt :
   deux écouteurs séparés se déclenchaient l'un après l'autre sur la même
   touche, et le second défaisait, derrière la fenêtre qu'on venait de
   fermer, quelque chose qu'on ne regardait pas. */
let ECHAP_SANS_FENETRE = null;
document.addEventListener('keydown', e=>{
  if(e.key !== 'Escape') return;
  if(fermeFenetreDuDessus()) return;
  if(ECHAP_SANS_FENETRE) ECHAP_SANS_FENETRE();
});
const esc = s => (s===null||s===undefined?'':String(s))
  .replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fr = (n,d=1) => n.toFixed(d).replace('.',',');

function money(v){ return (v===null||v===undefined||v==='') ? '-' : EUR.format(v); }
function hoursFmt(h){
  if(h===null||h===undefined) return '-';
  const H = Math.floor(h), M = Math.round((h-H)*60);
  return M ? `${H} h ${String(M).padStart(2,'0')}` : `${H} h`;
}
function toNum(v){
  if(v===null||v===undefined) return null;
  const s = clean(v).replace(/[€\s]/g,'').replace(',','.');
  if(s==='') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function toHours(v){
  const s = clean(v);
  if(!s) return null;
  let m = s.match(/^PT(\d+)H(?:(\d+)M)?/i);
  if(m) return +m[1] + (+(m[2]||0))/60;
  m = s.match(/^(\d+)\s*[h:]\s*(\d+)?/i);
  if(m) return +m[1] + (+(m[2]||0))/60;
  const n = parseFloat(s.replace(',','.'));
  return isNaN(n) ? null : n;
}
function toDate(v){
  const s = clean(v);
  if(!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m) return s.slice(0,10);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // DD/MM/YYYY
  if(m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  return s;
}
function dateFmt(d){
  const m=(d||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return d || '-';
  return `${+m[3]} ${MONTHS[+m[2]-1]} ${m[1]}`;
}
function yearOf(d){ const m=(d||'').match(/(\d{4})/); return m ? +m[1] : null; }

/* ---------- compte à rebours d'une sortie ----------
   Ce qu'on veut lire d'un jeu convoité : dans combien de temps il sort, ou
   depuis combien de temps il est sorti. Renvoie null quand la date est
   inconnue ou illisible - une wishlist contient des jeux sans date
   annoncée, et « dans NaN jours » vaut moins que rien.

   Le calcul porte sur des dates à minuit et pas sur des millisecondes :
   sinon un jeu qui sort demain matin afficherait « dans 0 jour » dès qu'on
   ouvre la page en fin d'après-midi. */
function compteARebours(iso){
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return null;
  const t = new Date();
  const jours = Math.round(
    (new Date(+m[1], +m[2] - 1, +m[3]) - new Date(t.getFullYear(), t.getMonth(), t.getDate()))
    / 86400000);
  if(jours === 0) return { avant:true, txt:"sort aujourd'hui" };

  const n = Math.abs(jours);
  let duree;
  if(n < 31)       duree = `${n} jour${n > 1 ? 's' : ''}`;
  else if(n < 365) duree = `${Math.round(n / 30.44)} mois`;
  else { const a = Math.round(n / 365.25); duree = `${a} an${a > 1 ? 's' : ''}`; }

  return jours > 0
    ? { avant:true,  txt:`dans ${duree}` }
    : { avant:false, txt:`sorti depuis ${duree}` };
}

/* Neuf fenêtres peuvent se recouvrir : la fiche, le formulaire, le choix de
   jaquette, le bilan en image, la mise à jour depuis IGDB, la recherche de
   journal, l'export, le détail d'un jeu et une capture en grand. Chacune
   décidait du défilement de la page pour son propre compte, donc en fermer
   une pendant qu'une autre est encore ouverte rendait la page défilable
   derrière. Un seul endroit regarde maintenant l'état des neuf. */
/* =======================================================================
   Rattrapage automatique des fiches IGDB.

   Les classeurs remplis avant l'arrivée des fiches détaillées n'ont ni
   identifiant IGDB ni plateforme/développeur/genres. Demander à chacun
   d'aller lancer la mise à jour à la main ne marche pas : personne ne le
   fait. La page s'en charge donc seule, une fois, à la première ouverture
   qui suit - le serveur dit quand (voir contenu(), journal.py).

   Deux garde-fous, parce que ça écrit dans le classeur de quelqu'un sans
   qu'il l'ait demandé :

     - seules les correspondances SÛRES sont écrites. « plusieurs fiches »
       et « à vérifier » sont précisément les cas où l'on risque d'attacher
       le mauvais jeu - et un mauvais identifiant renomme aussi la jaquette.
       Ceux-là restent pour la mise à jour manuelle, qui les montre.
     - seul l'identifiant part. Ni date, ni prix : ces colonnes-là ont pu
       être corrigées à la main, et rien ne justifie de les écraser au dos
       de leur propriétaire. Les trois autres colonnes sont relues par le
       serveur à partir de l'identifiant.
   ======================================================================= */
let RATTRAPAGE_FAIT = false;
let RATTRAPAGE_STOP = false;
const RATTRAPAGE_ABANDON = 8;    // échecs d'affilée = le serveur ne suit plus

function rattrapageBanniere(texte, fini){
  let b = $('rattrapage');
  if(!b){
    b = document.createElement('div');
    b.id = 'rattrapage';
    b.className = 'rattrapage';
    document.body.appendChild(b);
  }
  b.innerHTML = `<span class="rattrapage-txt">${esc(texte)}</span>` +
    (fini ? '' : '<button class="rattrapage-x" type="button">Plus tard</button>');
  const x = b.querySelector('.rattrapage-x');
  if(x) x.onclick = ()=>{ RATTRAPAGE_STOP = true; };
  return b;
}
function rattrapageFerme(){
  const b = $('rattrapage');
  if(b) b.remove();
}
/* Que la passe aille au bout, soit interrompue ou tombe en panne, la
   question a été posée : on ne la reposera pas à chaque ouverture. Ce qui
   reste sans fiche demeure accessible par la mise à jour manuelle. */
async function rattrapageClos(){
  try{ await envoyer('POST', '/api/journal/rattrapage', {}); }catch(e){}
}

async function rattrapageIgdb(){
  const aFaire = GAMES.filter(g => !g.idIgdb);
  if(!aFaire.length){ rattrapageClos(); return; }

  RATTRAPAGE_STOP = false;
  let vus = 0, surs = 0, echecs = 0, ecrits = 0, abandon = false;
  let file = [];
  rattrapageBanniere(`Mise à jour de ton classeur… 0/${aFaire.length}`);

  // les écritures partent par paquets : une relecture du journal pour
  // vingt jeux au lieu d'une par jeu, comme la mise à jour manuelle
  const vide = async ()=>{
    if(!file.length) return;
    const paquet = file.splice(0, file.length);
    try{
      const rep = await envoyer('PUT', '/api/journal/lot', {modifs: paquet});
      const refuses = ((rep.fait || {}).echecs) || [];
      ecrits += paquet.length - refuses.length;
      if(rep.jeux) applyData(rep, true);
    }catch(e){ /* le paquet est perdu, la passe continue */ }
  };

  for(const g of aFaire){
    if(RATTRAPAGE_STOP) break;
    let data;
    try{
      data = await apiPatient('/api/jeu/maj', {
        nom: g.name,
        sortie: g.release || '',
        prix: false,           // le prix payé est une donnée personnelle
        detail: true,
        jaquettes: 'aucune',   // une jaquette se choisit, ça ne s'automatise pas
      });
      echecs = 0;
    }catch(e){
      // le serveur ne répond plus : s'acharner ne ferait qu'empirer
      if(++echecs >= RATTRAPAGE_ABANDON){ abandon = true; break; }
      continue;
    }finally{
      vus++;
      rattrapageBanniere(`Mise à jour de ton classeur… ${vus}/${aFaire.length}`);
    }
    if(data.etat === 'ok' && data.fiche && data.surete === 'sure'){
      surs++;
      file.push({id: g.id, values: {id_igdb: data.fiche.id}});
      if(file.length >= IGDB_LOT) await vide();
    }
  }
  await vide();
  /* Une passe qui s'arrête parce que le serveur ne répondait plus n'a rien
     tranché du tout : la marquer « faite » brûlerait l'unique chance du
     rattrapage sur une panne passagère. On ne clôt que si on est allé au
     bout, ou si la personne a écarté la bannière elle-même. */
  if(!abandon) await rattrapageClos();

  render();
  if(ecrits){
    rattrapageBanniere(`${ecrits} jeu${ecrits > 1 ? 'x' : ''} complété${
      ecrits > 1 ? 's' : ''} depuis IGDB.`, true);
    setTimeout(rattrapageFerme, 6000);
  }else{
    rattrapageFerme();
  }
}

const FENETRES = ['sheet','form','jaq','bilan','igdb','recherche','export','renom','detail','zoom',
                 'sgFond',    // la fenêtre de suggestion, posée par static/commun/suggestion.js
                 // le social, posé par archive-social.js : ces deux-là se
                 // créent d'eux-mêmes et peuvent manquer, ce que la boucle
                 // ci-dessous accepte déjà
                 'socFil','socAvis'];
/* ---------- la fenêtre du dessus ----------
   Les fenêtres de l'Archive s'ouvrent les unes depuis les autres, et pas
   toujours dans le même ordre : la fiche d'un jeu ouvre les avis des
   joueurs, un avis ouvre sa discussion, et la discussion rouvre la fiche du
   jeu. Aucun empilement écrit d'avance ne peut satisfaire ce cycle - c'est
   ce qui faisait que « Avis des joueurs » semblait ne rien faire : la
   fenêtre s'ouvrait bel et bien, mais sous celle qu'on regardait (#detail
   est à 79, les fenêtres du social bien plus bas).

   Celle qu'on vient d'ouvrir passe donc devant celles qui étaient déjà là,
   et rien d'autre n'a besoin d'être décidé. */
function auPremierPlan(el){
  if(!el) return;
  let haut = 60;
  document.querySelectorAll('.sheet-back').forEach(f=>{
    if(f === el || f.hidden) return;
    const z = parseInt(getComputedStyle(f).zIndex, 10);
    if(!isNaN(z) && z > haut) haut = z;
  });
  el.style.zIndex = haut + 1;
}

/* Qui je suis. Déclaré ici plutôt que dans archive-journal.js depuis que la
   page Social s'en sert aussi : c'est le fichier que les deux chargent.
   Rempli par chargeAnnuaire() sur le journal, par le démarrage de la page
   sur le Social. */
let MOI = { connecte: false, pseudo: null, avatar: null, notifs: 0, admin: false };

function verrouFond(){
  const ouverte = FENETRES.some(id => { const e = $(id); return e && !e.hidden; });
  document.body.style.overflow = ouverte ? 'hidden' : '';
}

/* La croix d'effacement ne s'affiche que s'il y a quelque chose à effacer.
   Appelée aussi après les vidages programmés du champ - changement de
   classeur, retour à l'accueil - sinon elle resterait seule sur un champ
   déjà vide. */
function majCroixQ(){
  const croix = document.getElementById('qClear');
  if(croix) croix.hidden = !document.getElementById('q').value;
}

/* ---------- Jeux en cours ---------- */

const EN_COURS = 'En cours';
const estEnCoursNom = nom => norm(nom) === norm(EN_COURS);
const estEnCours = g => estEnCoursNom(g.bucket);
/* le nom exact de l'onglet s'il existe déjà, sinon celui qu'on créera */
function ongletEnCours(){
  return BUCKETS.find(estEnCoursNom) || EN_COURS;
}

/* ---------- Wishlist ---------- */
const WISHLIST = 'Wishlist';
const estWishlistNom = nom => norm(nom) === norm(WISHLIST);
const estWishlist = g => estWishlistNom(g.bucket);
function ongletWishlist(){
  return BUCKETS.find(estWishlistNom) || WISHLIST;
}

const estStatutNom = nom => estEnCoursNom(nom) || estWishlistNom(nom);
const estStatut = g => estStatutNom(g.bucket);

function statutDe(g){
  return estWishlist(g) ? WISHLIST : (estEnCours(g) ? EN_COURS : '');
}

/* La clé du tri chronologique : quand j'ai fini ce jeu-là.

   Ici et non auprès des autres filtres du mur, parce que la table TRIS
   juste en dessous ne s'en sert pas plus tard - elle la range dans une
   case au moment même où elle se construit. Une fonction déclarée dans un
   fichier chargé après celui-ci n'existerait pas encore à cet instant :
   les déclarations ne remontent qu'en tête de LEUR fichier, pas en tête de
   la page. */
function chronoKey(g){
  // un jeu en cours n'a pas de date de fin : il se range après tout le reste,
  // sinon sa date de sortie l'éparpillerait au milieu des années terminées.
  // La wishlist vient encore après : elle n'a même pas de date de début.
  if(estWishlist(g)) return 9.1e9;
  if(estEnCours(g)) return 9e9;
  return (g.year ?? yearOf(g.release) ?? 0)*100 + (g.month ?? 0);
}

/* Un critère de tri par ligne, et non plus un par sens : la liste
   déroulante dit *sur quoi* on trie, la flèche à côté dit *dans quel
   sens*. Deux entrées « Note ↓ » / « Note ↑ » pour la même chose
   doublaient le menu et obligeaient à rouvrir la liste pour retourner un
   classement qu'on avait déjà sous les yeux.

   [clé, libellé, sens naturel, valeur comparée, départage].
   La valeur peut manquer (pas de note, pas de prix payé) : voir
   comparateur(), qui range ces jeux-là en fin de liste dans les deux sens.
   Le départage, lui, ne se retourne jamais - il n'est là que pour donner
   un ordre stable aux ex æquo, pas pour être lu. */
const TRIS = [
  ['note',    'Note',                     'desc', x => x.rating],
  ['chrono',  'Ordre où je les ai faits', 'asc',  chronoKey,
              (a,b)=>(b.rating??0)-(a.rating??0)],
  ['solde',   'Solde',                    'desc', remiseDe,
              (a,b)=>String(a.release||'9999').localeCompare(String(b.release||'9999'))],
  ['release', 'Date de sortie',           'desc', x => x.release || null],
  ['time',    'Temps de jeu',             'desc', x => x.hours],
  ['paid',    'Prix payé',                'desc', x => x.paid],
  ['base',    'Prix de base',             'desc', x => x.base],
  ['az',      'Titre',                    'asc',  x => x.name],
];
const DEPART_NOM = (a,b)=>a.name.localeCompare(b.name,'fr');

/* Les tris proposés selon la famille d'onglets. La wishlist a la sienne
   parce qu'elle ne se lit pas comme le reste : c'est un calendrier, et
   rien n'y a été payé - le prix payé n'y dirait que des tirets. Le solde
   fait le chemin inverse : un jeu déjà terminé ou en cours n'est plus à
   vendre, ce tri n'a de sens que là où les prix bougent encore. */
const TRIS_PAR_FAMILLE = {
  periode:  TRIS.map(([k]) => k).filter(k => k !== 'solde'),
  statut:   ['release', 'paid', 'base', 'az'],
  wishlist: ['solde', 'release', 'base', 'az'],
};
/* Le sens qu'un critère prend quand on vient de le choisir, là où celui de
   la table serait à contresens : dans un calendrier de sorties à venir,
   c'est la prochaine qu'on veut en haut, pas la plus lointaine. */
const SENS_PAR_FAMILLE = { wishlist: { release: 'asc' } };
/* Le tri retenu pour chaque famille d'onglets, sens compris. */
const TRI_MEMO = {
  periode:  { tri:'note',    dir:'desc' },
  statut:   { tri:'release', dir:'desc' },
  wishlist: { tri:'solde',   dir:'desc' },
};

/* ---------- parler à Flask ----------
   Ces trois-là vivaient dans archive-jaquette.js, première venue à
   interroger le serveur. Elles n'ont pourtant rien qui touche aux images,
   et la page Social comme la recherche en ont besoin sans rien savoir des
   jaquettes : leur place est ici, dans le fichier que tout le monde charge.
   ======================================================================= */
async function api(chemin, corps){
  const r = await fetch(chemin, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(corps),
  });
  /* Le code de retour est accroché à l'erreur, pas seulement écrit dedans :
     un 503 (nginx qui limite le débit de /api/) et un câble débranché
     appellent deux réactions opposées, et seul l'appelant sait laquelle.
     Sans ce champ les deux se ressemblaient sous un même « serveur
     injoignable » - de quoi chercher la panne chez IGDB pendant des heures
     alors que le refus venait de nginx, trois couches plus tôt. */
  if(!r.ok){
    const err = new Error('http ' + r.status);
    err.statut = r.status;
    throw err;
  }
  return r.json();
}
/* Ce que le navigateur affichera d'un appel qui n'a pas abouti. Nommer qui
   a refusé, toujours : « injoignable » est le seul cas où personne n'a
   répondu, et c'est le seul qui mérite ce mot. */
function raisonReseau(e){
  const s = e && e.statut;
  if(s === 503 || s === 429) return 'trop de requêtes (limite de débit du serveur)';
  if(s) return `refus du serveur (HTTP ${s})`;
  return 'serveur injoignable';
}
/* nginx plafonne le débit de /api/ pour qu'un inconnu ne puisse pas griller
   le quota IGDB depuis internet. Or une mise à jour du classeur, c'est un
   appel par jeu à la file : elle tape dans ce plafond bien avant la fin.
   Un refus de débit n'est pas une panne, il dit « pas tout de suite » -
   alors on patiente et on redemande, plutôt que de faire tomber des
   centaines de jeux d'affilée pendant que tout va bien. */
const ATTENTE_DEBIT = [3000, 6000];
async function apiPatient(chemin, corps){
  for(let essai = 0; ; essai++){
    try{
      return await api(chemin, corps);
    }catch(e){
      if((e.statut === 503 || e.statut === 429) && essai < ATTENTE_DEBIT.length){
        await new Promise(reprend => setTimeout(reprend, ATTENTE_DEBIT[essai]));
        continue;
      }
      throw e;
    }
  }
}

/* ---------- Jaquettes ---------- */

// Le titre en minuscules, sans accents, les mots reliés par des underscores -> nom_du_jeu.webp
function slug(n){
  return n.normalize('NFD').replace(/[̀-ͯ]/g,'')
          .toLowerCase().replace(/[^a-z0-9]+/g,'_')
          .replace(/^_+|_+$/g,'');
}

const IMG_DIR = CONFIG.imageDir.endsWith('/') ? CONFIG.imageDir : CONFIG.imageDir + '/';
/* ---------- manifeste des jaquettes ----------
   { slug: horodatage } pour chaque fichier réellement présent dans Cover/,
   servi par /api/jaquettes. Il évite de demander une image qui n'existe pas :
   sans lui, chaque jeu sans jaquette valait un 404 par rendu, et sa case
   d'initiales n'arrivait qu'après l'échec réseau - d'où le clignotement.

   Gardé en localStorage pour être là dès le premier pixel : la requête, si
   rapide soit-elle, arrive après le premier rendu, et c'est ce rendu-là
   qu'on veut juste.

   null tant qu'on n'a jamais rien reçu. On tente alors l'adresse comme
   avant, plutôt que de décréter qu'aucun jeu n'a de jaquette : le manifeste
   est une amélioration, pas une dépendance. */
const CLE_JAQUETTES = 'journal-de-jeu:jaquettes';
let JAQUETTES = null;
try{ JAQUETTES = JSON.parse(localStorage.getItem(CLE_JAQUETTES) || 'null'); }catch(e){}
function retientManifeste(){
  try{ localStorage.setItem(CLE_JAQUETTES, JSON.stringify(JAQUETTES)); }catch(e){}
}
/* Relit le disque et redessine si quelque chose y a bougé depuis la
   dernière visite. En silence : si Flask ne répond pas, on garde ce qu'on
   avait - au pire on retombe sur le comportement d'avant, un 404 par
   jaquette manquante, ce qui reste une page qui marche. */
async function chargeManifeste(){
  let data;
  try{
    const r = await fetch('/api/jaquettes');
    if(!r.ok) return;
    data = await r.json();
  }catch(e){ return; }
  if(!data || data.etat !== 'ok' || !data.jaquettes) return;
  const avant = JSON.stringify(JAQUETTES);
  JAQUETTES = data.jaquettes;
  retientManifeste();
  if(JSON.stringify(JAQUETTES) === avant) return;   // le disque n'a pas bougé
  /* Le Social charge ce fichier sans le mur : ni renderWall ni paintSheet
     n'y existent, et #sheet non plus. Les trois lignes qui suivent y
     levaient donc « renderWall is not defined » à chaque chargement, ce qui
     tuait la suite de la fonction - et avec elle la mise à jour du
     manifeste, qui est justement ce qu'on était venu faire.

     Rien à redessiner là-bas de toute façon : les jaquettes du fil sont
     posées à la construction des cartes (voir socialCover), et les cartes
     arrivent après. On s'arrête donc, au lieu d'échouer. */
  if(typeof renderWall !== 'function') return;
  /* Redessiner ne coûte presque rien : les tuiles sont réutilisées, seules
     celles dont l'adresse de jaquette a changé sont refaites. */
  renderWall();
  const feuille = document.getElementById('sheet');
  if(feuille && !feuille.hidden && S.open !== null) paintSheet();
}
/* ---------- prix du jour des jeux convoités ----------
   { nom: {plein, actuel, remise} }. Rien de tout ça ne peut vivre dans le
   classeur : une promotion change tous les jours, et c'est précisément
   celle du moment qu'on veut voir. La page demande donc à Flask, qui
   demande à Steam.

   Gardé en localStorage pour que les pastilles soient là dès l'ouverture,
   et rafraîchi derrière - les deux caches côté serveur, l'appid un mois et
   le tarif six heures, rendent ce rafraîchissement quasi gratuit. */
const CLE_TARIFS = 'journal-de-jeu:tarifs';
let TARIFS = {};
try{ TARIFS = JSON.parse(localStorage.getItem(CLE_TARIFS) || '{}') || {}; }catch(e){}

const TARIFS_PAQUET = 8;    // assez petit pour voir les pastilles arriver
let tarifsEnVol = false, tarifsVus = 0;
async function majTarifs(){
  if(tarifsEnVol || Date.now() - tarifsVus < 600000) return;   // déjà demandé
  const jeux = GAMES.filter(estWishlist).map(x => ({nom:x.name, sortie:x.release || ''}));
  if(!jeux.length) return;
  tarifsEnVol = true;
  /* Ce qui n'est plus dans la wishlist n'a plus de tarif à afficher. Sans
     ce ménage, un jeu acheté - donc sorti de la liste - gardait sa ligne
     pour toujours, et le localStorage enflait d'une visite à l'autre
     jusqu'à saturer son quota. Fait ici, une fois, avant les écritures
     ci-dessous : elles enregistrent alors la version déjà propre. */
  const vivants = new Set(jeux.map(j => j.nom));
  Object.keys(TARIFS).forEach(nom => { if(!vivants.has(nom)) delete TARIFS[nom]; });
  try{
    /* Par paquets, et redessiné après chacun : la première visite paie la
       recherche IGDB pour chaque jeu, autant voir les pastilles apparaître
       au fur et à mesure plutôt que rien pendant vingt secondes. */
    for(let i = 0; i < jeux.length; i += TARIFS_PAQUET){
      let data;
      try{ data = await api('/api/wishlist/prix', {jeux: jeux.slice(i, i + TARIFS_PAQUET)}); }
      catch(e){ return; }        // Flask muet : on garde ce qu'on avait
      if(!data || data.etat !== 'ok' || !data.tarifs) return;
      Object.assign(TARIFS, data.tarifs);
      try{ localStorage.setItem(CLE_TARIFS, JSON.stringify(TARIFS)); }catch(e){}
      renderWall();              // seules les tuiles concernées se refont
      // la fiche ouverte affiche le même prix : elle aussi
      if(!document.getElementById('sheet').hidden && S.open !== null) paintSheet();
    }
    tarifsVus = Date.now();
  } finally { tarifsEnVol = false; }
}
/* La promotion fait partie de ce que la tuile montre : sans elle dans la
   signature, une pastille arrivée après coup ne s'afficherait jamais. */
function sigPromo(x){
  const t = estWishlist(x) && TARIFS[x.name];
  return t && t.remise > 0 ? t.remise + '@' + t.actuel : '';
}
/* Le pourcentage de remise, 0 quand il n'y en a pas ou qu'on ne sait pas
   encore. Sert au tri « Solde », d'où le 0 plutôt que null : un jeu dont
   Steam ne dit rien se range avec ceux qui ne sont pas soldés, pas devant. */
function remiseDe(x){
  const t = estWishlist(x) && TARIFS[x.name];
  return t && t.remise > 0 ? t.remise : 0;
}

/* =======================================================================
   Les avis qui racontent la fin

   Un avis marqué « spoiler » par la personne qui l'a écrit arrive flouté
   chez les autres, avec un bouton pour le découvrir. Le serveur a déjà
   tranché avant nous - `flou` sur le jeu comme sur la carte du fil (voir
   censeur dans social.py) : chez soi il est toujours faux, et chez
   quelqu'un d'autre il l'est aussi dès qu'on a terminé le jeu. La page ne
   redécide rien, elle habille.

   Ici plutôt que dans archive-fiche.js ou archive-social.js parce que les
   deux en ont besoin, et que ce fichier-ci est le seul que la page du
   journal et celle du Social chargent toutes les deux - c'est déjà la
   raison qui a fait descendre `api` et `MOI` jusqu'ici.
   ======================================================================= */
function spoilerHTML(dedans){
  return `<div class="spoil spoil-ferme">
    <div class="spoil-dedans">${dedans}</div>
    <button type="button" class="spoil-x">Spoiler - cliquer pour afficher</button>
  </div>`;
}
/* Une seule écoute pour toute la page, et en capture.

   En capture parce que dans le fil, la carte entière mène à la discussion :
   posée en remontée, l'écoute du conteneur aurait déjà ouvert le fil avant
   que celle-ci ne voie le clic - le bouton aurait « marché », mais sous une
   fenêtre qui venait de s'ouvrir par-dessus. Prendre le clic à la descente
   et l'arrêter là est le seul endroit d'où l'on peut le lui reprendre.

   Rien à retenir d'un avis découvert : la classe part du DOM, et le
   prochain rendu de la liste le refera flou. C'est voulu - la question
   « veux-tu vraiment lire ça ? » se repose à chaque fois qu'on retombe
   dessus, et rien n'est écrit nulle part sur ce qu'on a lu. */
document.addEventListener('click', e=>{
  const b = e.target.closest && e.target.closest('.spoil-x');
  if(!b) return;
  e.preventDefault();
  e.stopPropagation();
  const boite = b.closest('.spoil');
  if(boite) boite.classList.remove('spoil-ferme');
}, true);

/* Le nom de fichier d'une jaquette : l'identifiant IGDB quand le jeu en a
   un, son nom sinon. Deux jeux au titre identique - « God of War » de 2005
   et celui de 2018, « Doom », « Tomb Raider » - tombaient jusqu'ici sur le
   même fichier, donc sur une seule image pour les deux.

   Doit dire exactement la même chose que cle_jaquette() en Python : c'est
   le serveur qui écrit les fichiers, la page qui les demande. */
function cleJaquette(g){
  return g && g.idIgdb ? String(g.idIgdb) : slug(g ? g.name : '');
}
function coverURL(cle){
  const f = cle;
  if(!f) return '';
  // le manifeste dit ce qui existe : on ne demande jamais un fichier absent
  if(JAQUETTES && !(f in JAQUETTES)) return '';
  const url = IMG_DIR + encodeURIComponent(f) + '.' + CONFIG.imageExt;
  /* l'horodatage du fichier fait office de numéro de version : une jaquette
     remplacée sous le même nom change de date, donc d'adresse, et le cache
     du navigateur ne peut pas renvoyer l'ancienne */
  const v = JAQUETTES && JAQUETTES[f];
  return v ? url + '?v=' + v : url;
}
function initials(n){
  return n.replace(/[^\p{L}\p{N} ]/gu,' ').split(/\s+/).filter(Boolean).slice(0,2)
          .map(w=>w[0].toUpperCase()).join('');
}
/* Les jaquettes du premier écran, celles qu'on voit avant d'avoir fait quoi
   que ce soit. Six, c'est la première rangée du mur : .wall tient six
   colonnes de 158 px dans les 1120 px de la page. */
const PRIORITAIRES = 6;
function coverTag(g, cls, prioritaire){
  /* Les premières partent tout de suite et en priorité haute. « lazy »
     n'aurait pas retardé leur affichage - elles sont dans le champ - mais
     leur requête, que le navigateur ne lance qu'une fois la mise en page
     connue. Les suivantes restent paresseuses : un mur de trois cents jeux
     chargé d'un bloc saturerait les connexions, et les premières
     attendraient derrière les autres. */
  const charge = prioritaire
    ? 'loading="eager" fetchpriority="high"'
    : 'loading="lazy"';
  return `<img class="cov ${cls}" alt="" ${charge} decoding="async"
    data-name="${esc(g.name)}" data-release="${esc(g.release || '')}"
    data-cle="${esc(cleJaquette(g))}" data-igdb="${esc(g.idIgdb || '')}"
    data-color="${noteColor(g.rating)}">`;
}

// Un bouton dans le coin de la cover pour télécharger l'image
function boutonJaquette(nom, sortie, idIgdb){
  const b = document.createElement('span');
  b.className = 'cov-get';
  b.setAttribute('role', 'button');
  b.setAttribute('tabindex', '0');
  b.title = 'Chercher une jaquette';
  b.setAttribute('aria-label', `Chercher une jaquette pour ${nom}`);
  b.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>`;
  const lance = e=>{
    e.stopPropagation(); e.preventDefault();
    if(b.classList.contains('busy')) return;
    b.classList.add('busy');
    // force : le fichier existe peut-être déjà, mais le navigateur garde un vieil échec en cache
    jaquetteAuto(nom, sortie, true, idIgdb).finally(()=> b.classList.remove('busy'));
  };
  b.addEventListener('click', lance);
  b.addEventListener('keydown', e=>{ if(e.key === 'Enter' || e.key === ' ') lance(e); });
  return b;
}
function hydrateCovers(root){
  root.querySelectorAll('img.cov').forEach(img=>{
    const url = coverURL(img.dataset.cle);
    const initiales = ()=>{
      const d = document.createElement('div');
      d.className = Array.from(img.classList).filter(c=>c!=='chargement').join(' ') + ' ph';
      d.style.setProperty('--c', img.dataset.color);
      d.textContent = initials(img.dataset.name);
      d.appendChild(boutonJaquette(img.dataset.name, img.dataset.release, img.dataset.igdb));
      img.replaceWith(d);
    };
    if(!url){ initiales(); return; }
    /* le temps que la jaquette arrive, la case miroite doucement au lieu
       de rester un rectangle mort : on sait que quelque chose est en route */
    img.classList.add('chargement');
    img.addEventListener('load', ()=>{ img.classList.remove('chargement'); }, {once:true});
    img.addEventListener('error', ()=>{ if(!img.dataset.off) initiales(); });
    img.src = url;
  });
}

/* ---------- Échelle de couleur des notes ---------- */
const SCALE = [[0,'#B4295C'],[3,'#DD5A3C'],[5,'#E9A13C'],[7,'#A8C24A'],[9,'#35C98D'],[10,'#22CFA8']];
function hex2rgb(h){ return [1,3,5].map(i=>parseInt(h.slice(i,i+2),16)); }
function noteColor(n){
  if(n===null||n===undefined) return '#6E6480';
  const v = Math.max(0,Math.min(10,n));
  for(let i=0;i<SCALE.length-1;i++){
    const [a,ca]=SCALE[i], [b,cb]=SCALE[i+1];
    if(v>=a && v<=b){
      const t=(v-a)/(b-a), A=hex2rgb(ca), B=hex2rgb(cb);
      return `rgb(${A.map((x,j)=>Math.round(x+(B[j]-x)*t)).join(',')})`;
    }
  }
  return SCALE[SCALE.length-1][1];
}
