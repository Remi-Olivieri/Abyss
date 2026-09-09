/* =======================================================================
   Archive Jeux Vidéos - archive-journal.js

   Le journal affiché : le charger, le garder, en changer.

   L'annuaire des journaux publics, la requête vers /api/journal, le cache
   local affiché avant elle, l'état de la page (GAMES, BUCKETS, S), les
   quatre écrans d'accueil, la recherche d'un journal ou d'un jeu, et
   l'adresse /archive/<pseudo> qui rend tout ça partageable.

   Vient après archive-noyau.js, dont il utilise les formats et les
   statuts.

   Chargé par templates/jeux-videos.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */


/* ---------- Lecture d'un onglet ---------- */
/* Le serveur envoie des jeux tout faits. Les fonctions qui devinaient les
   colonnes d'une feuille (HEAD, mapHeaders, guessMonthColumn, noteFor,
   readSheet) n'ont plus d'objet : un jeu arrive avec ses champs nommés, et
   son `id` remplace le couple « onglet + numéro de ligne ». */

/* Plus de jeton : l'autorisation d'écrire vient de la session Abyss, et le
   cookie part tout seul avec chaque requête. Le serveur répond `write: true`
   quand le journal demandé est celui du visiteur connecté. */

try{
  if(localStorage.getItem('journal-de-jeu:version') !== 'abyss-4'){
    /* le cache d'avant est indexé par adresse Apps Script, et contient des
       feuilles au lieu de jeux : illisible pour la nouvelle version.
       Les jetons partent avec, ils ne servent plus à rien. */
    Object.keys(localStorage)
      .filter(k => k.startsWith('journal-de-jeu:'))
      .forEach(k => localStorage.removeItem(k));
    localStorage.setItem('journal-de-jeu:version', 'abyss-4');
  }
}catch(e){}

/* ---------- dernière réponse connue : affichée tout de suite au chargement,
   le temps que la vraie requête reparte en arrière-plan ---------- */
const cacheStore = {
  cle(url){ return 'journal-de-jeu:data:' + url; },
  get(url){ try{ return JSON.parse(localStorage.getItem(this.cle(url)) || 'null'); }catch(e){ return null; } },
  set(url, v){ try{ localStorage.setItem(this.cle(url), JSON.stringify(v)); }catch(e){} },
};

let GAMES = [], BUCKETS = [], CAN_WRITE = false, SRC = 0, PREMIERE_FOIS = true, TITRE = '';
/* L'onglet sur lequel le classeur affiché s'ouvre, choisi par son auteur.
   Vide = aucun choix, on retombe sur l'année la plus récente. */
let ONGLET_DEFAUT = '';
/* Les onglets qui ne rangent aucun jeu : ce sont des vues sur le classeur,
   pas des tiroirs. Ils ne figurent donc jamais dans BUCKETS, et tout ce qui
   valide un nom d'onglet doit les connaître à part. */
const ONGLETS_VUE = ['all', 'stats'];
/* le journal affiché, ou null si SOURCES est vide */
const source = () => SOURCES[SRC] || null;

/* Le classeur ouvert la dernière fois était retenu ici, pour rouvrir le
   même journal public d'une visite à l'autre. Plus personne ne le lisait :
   qui a un journal ouvre le sien, et qui n'en a pas voit l'écran d'accueil
   et choisit dans la recherche. Un souvenir que rien ne relit ne fait que
   laisser croire qu'il sert encore. */
/* L'année la plus récente : la plus grande parmi les onglets, et à défaut
   d'onglet nommé comme une année, le dernier de la liste.

   Ne sert plus qu'à proposer une catégorie au formulaire d'ajout - un jeu
   qu'on vient de finir appartient presque toujours à l'année en cours.
   L'ouverture du classeur, elle, se fait sur « Tout » ou sur l'onglet que
   son auteur a désigné (voir ONGLET_DEFAUT). */
function derniereAnnee(){
  const annees = BUCKETS.filter(b => /^\d{4}$/.test(String(b).trim()));
  if(annees.length) return annees.reduce((a,b) => +String(b).trim() > +String(a).trim() ? b : a);
  // « En cours » et « Wishlist » ne sont pas des périodes : on ne range pas
  // un jeu terminé dans un statut, ils sont donc écartés d'office
  const autres = BUCKETS.filter(b => !estStatutNom(b));
  return autres[autres.length - 1] || BUCKETS[BUCKETS.length - 1] || 'all';
}

async function charger(opts = {}){
  const s = source();
  if(!s || !s.url){ showGate(null); return; }
  // silencieux : rafraîchissement en arrière-plan pendant qu'on affiche déjà le cache
  const silencieux = !!opts.silencieux;

  /* Plus de jeton dans l'adresse : le cookie de session part tout seul,
     même origine oblige, et c'est le serveur qui décide de `write`. */
  let data = null, pourquoi = '', statut = 0;
  try{
    const r = await fetch(s.url, {credentials: 'same-origin'});
    statut = r.status;
    if(r.ok) data = await r.json();
    else{
      try{ data = await r.json(); }catch(e){}
      pourquoi = (data && data.message) || ('réponse HTTP ' + r.status);
      data = null;
    }
  }catch(e){ pourquoi = 'serveur injoignable'; }

  if(!data || !data.ok){
    if(silencieux){ majEtat('erreur', 'actualisation impossible'); return; }
    // 403 privé, 404 inconnu : le serveur a répondu, et il a dit non
    const refus = statut === 403 || statut === 404;
    // sa phrase se suffit à elle-même quand il a dit pourquoi
    const dit = pourquoi ? (/[.!?]$/.test(pourquoi) ? pourquoi : pourquoi + '.') : '';
    showGate(!dit ? null
      : refus ? `<b>${esc(dit)}</b>`
              : `<b>Impossible de charger le journal.</b> ${esc(dit)}`, refus);
    return;
  }

  cacheStore.set(s.url, data);
  applyData(data, true);
  showApp();
  render();
}

/* L'état de la connexion tient dans la pastille de l'engrenage - verte quand
   les données viennent du script, ambrée pendant une actualisation, rouge
   quand celle-ci a échoué, éteinte quand rien n'a pu être joint. */
function majEtat(mode, txt){
  const c = document.getElementById('cog');
  c.dataset.etat = mode;
  c.setAttribute('aria-label', 'Paramètres - ' + txt);
}

/* Range la réponse dans GAMES / BUCKETS. Appelée aussi après chaque
   écriture : le serveur renvoie le journal relu, comme le faisait le script.
   frais=false : c'est le cache local qui vient d'être affiché, la vraie
   requête est encore en vol - on le dit au lieu d'annoncer une synchro. */
function applyData(data, frais){
  /* Les jeux arrivent tout faits, avec les mêmes noms de champs que
     produisait readSheet. Seul `id` est nouveau, et il remplace le couple
     « onglet + numéro de ligne » qui servait à retrouver la bonne case. */
  GAMES = (data.jeux || []).map(j => Object.assign({}, j, {
    review: Array.isArray(j.review) ? j.review : [],
  }));
  BUCKETS = (data.periodes || []).slice();
  CAN_WRITE = data.write === true;
  TITRE = data.titre || '';
  IDENTITE = {avatar: data.avatar || null, banniere: data.banniere || null};
  oublieTuiles();   // le mur garde ses tuiles : celles des jeux partis s'en vont
  // à l'ouverture seulement : on se place sur l'année la plus récente
  ONGLET_DEFAUT = data.ongletDefaut || '';
  /* Sans choix de l'auteur, on ouvre sur « Tout » : c'est la vue qui montre
     le classeur entier, donc celle qui ne cache rien à qui arrive. Ouvrir
     sur l'année en cours, comme avant, donnait un classeur presque vide en
     janvier et laissait croire qu'il n'y avait que ça.
     derniereAnnee() reste utilisée à l'ajout d'un jeu, où « Tout » n'est
     pas une catégorie où ranger quoi que ce soit.

     Le choix de l'auteur passe devant, à condition qu'il existe encore : un
     onglet vidé de ses jeux disparaît de BUCKETS, et s'ouvrir sur un onglet
     absent afficherait une page vide sans que rien n'explique pourquoi. */
  if(PREMIERE_FOIS && BUCKETS.length){
    S.bucket = ongletEntree();
    PREMIERE_FOIS = false;
  }
  /* « stats » et « all » ne sont pas des tiroirs du classeur : ils
     n'apparaissent pas dans BUCKETS et ce garde-fou les effacerait. */
  if(!ONGLETS_VUE.includes(S.bucket) && BUCKETS.indexOf(S.bucket) < 0) S.bucket = 'all';
  majEntete();
  if(frais) majEtat('live', CAN_WRITE ? 'modifiable' : 'lecture seule');
  else majEtat('stale', 'actualisation...');
  majVerrou();
  /* Chez moi elle se remplit sur place, chez un autre elle part la
     chercher : dans les deux cas c'est ici qu'on sait quel classeur est à
     l'écran. Rien ne l'attend - une fiche déjà ouverte se repeindra. */
  chargeMaBiblio();
  /* Le serveur ne dit « rattrapage » qu'au propriétaire d'un classeur
     rempli avant que les fiches IGDB existent. On laisse la page finir de
     s'afficher avant de lancer quoi que ce soit : le rattrapage est long
     et secondaire, il n'a aucune raison de retarder le premier écran. */
  if(frais && data.rattrapage && CAN_WRITE && !RATTRAPAGE_FAIT){
    RATTRAPAGE_FAIT = true;
    setTimeout(rattrapageIgdb, 1200);
  }
}

/* ---------- écritures ----------
   Une requête JSON vers Flask, cookie de session compris. Le serveur répond
   le journal entier relu : la page se repose dessus au lieu de recoller à la
   main ce qu'elle vient d'envoyer. */
async function envoyer(methode, chemin, charge){
  if(!CAN_WRITE) throw new Error('lecture seule : connecte-toi sur Abyss');
  const opts = {method: methode, credentials: 'same-origin'};
  if(charge !== undefined){
    // application/json : un formulaire posté depuis un autre site ne peut
    // pas produire ce type sans pré-vol CORS. C'est la parade CSRF.
    opts.headers = {'Content-Type': 'application/json'};
    opts.body = JSON.stringify(charge);
  }
  let data = null, pourquoi = '';
  try{
    const r = await fetch(chemin, opts);
    try{ data = await r.json(); }catch(e){}
    if(!r.ok) pourquoi = (data && data.message) || ('réponse HTTP ' + r.status);
  }catch(e){ pourquoi = 'serveur injoignable'; }
  if(!data || data.ok === false) throw new Error(pourquoi || 'erreur inconnue');
  return data;
}

function closeMenu(){
  document.getElementById('menu').hidden = true;
  document.getElementById('cog').setAttribute('aria-expanded', 'false');
}
function toggleMenu(){
  const m = document.getElementById('menu'), ouvert = m.hidden;
  if(ouvert){ fermerRecherche(); closePer(); }   // un seul menu ouvert à la fois
  m.hidden = !ouvert;
  document.getElementById('cog').setAttribute('aria-expanded', ouvert ? 'true' : 'false');
}
document.getElementById('cog').addEventListener('click', e=>{ e.stopPropagation(); toggleMenu(); });
/* Une sélection de texte commencée dans un de ces menus et relâchée dehors
   ne doit pas le fermer : on ne ferme que si le clic ET le mousedown qui
   l'a précédé visaient tous les deux en dehors, comme fermeSurFond(). */
let HORS_COG = false, HORS_TAB = false;
document.addEventListener('mousedown', e=>{
  HORS_COG = !e.target.closest('.cog-wrap');
  HORS_TAB = !e.target.closest('.tab-wrap');
});
document.addEventListener('click', e=>{
  if(HORS_COG && !document.getElementById('menu').hidden && !e.target.closest('.cog-wrap')) closeMenu();
  if(HORS_TAB && !e.target.closest('.tab-wrap')) closePer();
});
document.addEventListener('keydown', e=>{
  if(e.key === 'Escape'){
    if(!document.getElementById('menu').hidden) closeMenu();
    closePer();
  }
});

/* ---------- changer de classeur ----------
   Plus un menu déroulant sous le titre, mais une recherche façon réseau
   social : le bouton loupe ouvre #recherche, où taper un nom filtre les
   journaux connus (le sien, et les journaux publics de l'annuaire). */
/* ---------- qui tient ce journal ----------
   La photo et la bannière arrivent avec le journal (voir identite() dans
   journal.py) plutôt que d'être repêchées dans l'annuaire : celui-ci ne
   liste que les journaux publics, et son propriétaire serait donc arrivé
   sans visage sur son propre journal privé. */
let IDENTITE = {avatar: null, banniere: null};

function majEntete(){ majIdentite(); }

/* ---------- moi, dans la barre du haut ----------
   Ma photo et mon pseudo, quel que soit le journal ouvert. C'est le seul
   élément de la barre qui ne change jamais, et c'est ce qui en fait un
   point de repère : on sait sous quel compte on est sans avoir à ouvrir un
   menu, et on rentre chez soi en cliquant dessus.

   Ça remplace la petite maison, qui disait la même chose sans le dire - une
   icône de plus dans une barre qui en comptait déjà cinq.

   Posé une fois, après l'annuaire : il ne dépend pas du journal affiché, et
   n'a donc rien à faire dans majIdentite() qui, elle, se rejoue à chaque
   changement de classeur. */
function majMoi(){
  const bouton = document.getElementById('moiBtn');
  const titre = document.getElementById('brand-title');
  bouton.hidden = !MOI.pseudo;
  // sans compte, la barre porte le nom du site : elle ne peut pas rester nue
  titre.hidden = !!MOI.pseudo;
  if(!MOI.pseudo) return;
  bouton.href = '/archive/' + encodeURIComponent(MOI.pseudo);
  document.getElementById('moiAva').innerHTML = avatarHTML(MOI.pseudo, MOI.avatar);
  document.getElementById('moiNom').textContent = MOI.pseudo;
  bouton.onclick = e=>{
    /* On est déjà sur la page : changer de classeur sur place vaut mieux
       que de la recharger. L'adresse reste vraie pour le clic du milieu et
       le menu contextuel, qui n'entrent pas ici. */
    e.preventDefault();
    closeMenu(); fermerRecherche();
    ouvrirLeMien();
  };
}

/* La pastille de l'en-tête et le bandeau du haut, remplis d'un seul geste :
   ils montrent la même personne, et deux fonctions finiraient par ne plus
   dire pareil.

   Sans photo, les initiales sur une teinte tirée du pseudo - la même que
   dans la recherche, pour que quelqu'un garde sa couleur d'un écran à
   l'autre. Sans bannière, un dégradé de la page : le bandeau existe quand
   même, avec sa place vide bien visible, et c'est précisément ce qui
   donne envie de la remplir. */
function majIdentite(){
  const s = source();
  const nom = (s && s.nom) || '';
  const avatar = IDENTITE.avatar;

  const ligne = document.getElementById('ident');
  if(!nom){ ligne.hidden = true; return; }
  ligne.hidden = false;
  /* La classe va sur la tête entière et non sur la ligne d'identité : c'est
     elle qui porte le fond, et il court derrière les statistiques et la
     courbe des notes. */
  document.getElementById('jtete').classList.toggle('sans-banniere', !IDENTITE.banniere);
  /* L'adresse est posée en JavaScript et non écrite dans le HTML : esc()
     n'échappe pas l'apostrophe, qui suffirait à sortir d'un url('...') et
     à injecter du CSS. Rien à échapper, rien à oublier. */
  const fond = document.getElementById('identFond');
  fond.style.backgroundImage = IDENTITE.banniere ? `url("${IDENTITE.banniere}")` : '';

  document.getElementById('identAva').innerHTML = avatarHTML(nom, avatar, 'xl');
  /* Le pseudo seul. « Journal de Jokrem » disait deux fois où l'on est -
     on est sur l'Archive, la page ne parle que de journaux - et le mot
     poussait le nom, qui est la seule chose à lire ici, à mi-chemin de la
     ligne. Le titre que l'auteur s'est choisi passe devant s'il en a mis
     un autre que celui d'origine. */
  const titre = TITRE && TITRE !== `Journal de ${nom}` ? TITRE : nom;
  document.getElementById('identNom').textContent = titre;
  document.getElementById('identSous').textContent = sousIdentite();
  majIdentiteCta(avatar);
}

function avatarHTML(nom, url, taille){
  const cls = 'ava' + (taille ? ' ' + taille : '');
  if(url) return `<img class="${cls}" src="${esc(url)}" alt="" decoding="async">`;
  return `<span class="${cls} ava-vide" style="--h:${teinteAvatar(nom)}"
    >${esc(initials(nom || '?'))}</span>`;
}

/* Ce que le journal pèse, sous son nom : les jeux terminés, et le temps
   passé dessus quand il est noté. Deux chiffres qu'on lit avant d'entrer
   dans le mur, et qui disent à quoi on a affaire. */
function sousIdentite(){
  const finis = GAMES.filter(g => !estStatut(g));
  const heures = finis.reduce((t, g) => t + (g.hours || 0), 0);
  const bouts = [`${finis.length} jeu${finis.length > 1 ? 'x' : ''} terminé${
    finis.length > 1 ? 's' : ''}`];
  if(heures >= 1) bouts.push(`${Math.round(heures)} h de jeu`);
  return bouts.join(' · ');
}

/* L'invitation, chez soi et seulement chez soi : on ne dit pas à quelqu'un
   d'autre qu'il lui manque une photo. Elle nomme ce qui manque, parce que
   « personnalise ton journal » n'a jamais dit où cliquer ni pour quoi. */
function majIdentiteCta(avatar){
  const cta = document.getElementById('identCta');
  if(!CAN_WRITE){ cta.hidden = true; return; }
  const manque = [!avatar && 'une photo', !IDENTITE.banniere && 'une bannière']
    .filter(Boolean);
  cta.hidden = !manque.length;
  if(manque.length) cta.textContent = 'Ajoute ' + manque.join(' et ');
}

/* La recherche - un journal, ou un jeu - vivait ici, avec l'annuaire
   qu'elle fouille. Elle est passée dans archive-recherche.js : la page
   Social ouvre la même fenêtre, et deux exemplaires d'un même écran
   finissent toujours par ne plus dire pareil.

   Ce qui reste de ce côté-ci, c'est ce qu'elle DÉCLENCHE : choisir un
   journal, ici, change de classeur sans quitter la page (choisirClasseur
   ci-dessous) ; sur le Social, ça mène à l'adresse du journal. Les deux
   gestes partent en paramètre - voir monteRecherche. */

function choisirClasseur(i){
  fermerRecherche();
  if(i === SRC || !SOURCES[i]) return;
  SRC = i;
  majAdresse();
  GAMES = []; BUCKETS = []; CAN_WRITE = false;
  /* on change de journal : la fiche ouverte parle d'un jeu qui n'est plus
     dans le classeur affiché. render() ne ferme plus rien de lui-même, donc
     c'est ici que ça se dit. */
  closeSheet();
  PREMIERE_FOIS = true; S.bucket = 'all'; S.q = ''; S.range = null; S.open = null;
  document.getElementById('q').value = ''; majCroixQ();
  majEntete();
  majEtat('offline', 'connexion...');
  const s = source();
  const cache = cacheStore.get(s.url);
  if(cache && cache.jeux && cache.jeux.length){
    applyData(cache, false); showApp(); render();
    charger({silencieux:true});
  } else {
    // rien en cache : le mur de l'autre classeur ne doit pas rester à l'écran,
    // et l'attente est la même qu'au tout premier chargement
    squelette();
    charger();
  }
}

/* Écran d'aide : aucun journal configuré, celui-ci ne répond pas, ou le
   serveur a dit non. Plus rien à saisir ici - l'adresse est dans le fichier.

   `refus` distingue le troisième cas : journal privé, pseudo inconnu. Un
   lien /archive/<pseudo> partagé tombe surtout là-dessus, et « ne répond
   pas » serait faux - il a répondu, c'est justement le problème. Ni adresse
   d'API ni bouton « Réessayer » dans ce cas : la première ne parle à
   personne, le second ne peut que faire redire non. */
function showGate(erreur, refus){
  closeSheet(); closeForm(); closeMenu(); fermerRecherche();
  majEntete();
  majEtat('offline', source() ? 'non connecté' : 'aucun journal');
  document.getElementById('app').hidden = true;
  document.getElementById('tabs').hidden = true;
  document.getElementById('cog').hidden = !source();
  document.getElementById('invite').hidden = true;
  document.getElementById('accueil').hidden = true;
  document.getElementById('gate').hidden = false;
  const s = source();
  document.getElementById('gTitle').textContent = refus
    ? 'Ce journal ne peut pas être ouvert'
    : (s ? 'Ce journal ne répond pas' : 'Aucun journal configuré');
  document.getElementById('gMsg').textContent = refus ? ''
    : (s ? `Adresse interrogée : ${s.url}`
         : "Ajoute l'adresse de ton script Apps Script dans le tableau SOURCES, tout en haut du fichier.");
  const box = document.getElementById('gErr');
  box.hidden = !erreur;
  if(erreur) box.innerHTML = erreur;
  document.getElementById('gRetry').hidden = !s || !!refus;
}
function showApp(){
  document.getElementById('gate').hidden = true;
  document.getElementById('invite').hidden = true;
  document.getElementById('accueil').hidden = true;
  document.getElementById('tabs').hidden = false;
  document.getElementById('cog').hidden = false;
  document.getElementById('app').hidden = false;
  document.querySelector('.tools').hidden = false;
  // le squelette les avait rendus inertes le temps de l'attente
  document.getElementById('q').disabled = false;
  document.getElementById('sort').disabled = false;
  document.getElementById('sortDir').disabled = false;
}

/* Connecté mais aucun journal : plutôt que d'atterrir sur celui d'un
   inconnu ou de cacher la création dans les paramètres, l'écran d'accueil
   propose directement de créer le sien. */
function showInvite(){
  closeSheet(); closeForm(); closeMenu(); fermerRecherche();
  /* Aucun journal n'est réellement affiché ici : SRC restait à sa valeur
     par défaut (0), si bien que la recherche marquait le premier journal
     public comme déjà sélectionné - cocher une coche sur laquelle cliquer
     ne faisait rien, puisque choisirClasseur() ignore un clic sur ce qui
     est déjà "SRC". -1 n'existe dans aucune liste : rien ne coche, et le
     premier clic ouvre bien le journal visé. */
  SRC = -1;
  // pas de source affichée ici : SOURCES[0] serait le journal public de
  // quelqu'un d'autre, et l'annoncer dans l'en-tête serait trompeur
  document.getElementById('brand-title').textContent = 'Jeux Vidéos';
  document.getElementById('app').hidden = true;
  document.getElementById('tabs').hidden = true;
  document.getElementById('cog').hidden = true;
  document.getElementById('gate').hidden = true;
  document.getElementById('accueil').hidden = true;
  document.getElementById('invite').hidden = false;
}

/* Personne n'est connecte : on n'ouvre le journal de personne.

   La page tombait jusqu'ici sur SOURCES[0], c'est-a-dire le premier
   journal public venu -- un visiteur atterrissait donc chez quelqu'un
   qu'il n'avait pas demande, sans qu'aucun mot ne lui dise ou il etait ni
   ce que la page savait faire. Il y a maintenant un ecran qui le dit, et
   la recherche dessous pour aller lire ceux qui sont publics. */
function showAccueil(){
  closeSheet(); closeForm(); closeMenu(); fermerRecherche();
  /* Aucun journal affiché : SRC restait à 0, si bien que la recherche
     marquait le premier journal public comme déjà sélectionné - cocher une
     coche sur laquelle cliquer ne fait rien, puisque choisirClasseur()
     ignore un clic sur ce qui est déjà « SRC ». Même raison qu'à
     showInvite(), et même remède : -1 n'existe dans aucune liste. */
  SRC = -1;
  document.getElementById('brand-title').textContent = 'Jeux Vidéos';
  document.getElementById('app').hidden = true;
  document.getElementById('tabs').hidden = true;
  document.getElementById('cog').hidden = true;
  document.getElementById('gate').hidden = true;
  document.getElementById('invite').hidden = true;
  document.getElementById('accueil').hidden = false;
  monteRecherche(document.getElementById('accueilRech'));
}

/* ---------- squelette du premier chargement ----------
   Sans cache local il n'y a rien à montrer tant que le script n'a pas
   répondu, et une page vide pendant deux secondes ressemble à une panne
   plutôt qu'à une attente. On dresse donc la page entière en gris -
   onglets, stats, histogramme, mur - à la forme exacte de ce qui va
   arriver : les vraies données se posent dessus sans rien faire sauter.

   Deux choses ne sont pas des fantômes, parce qu'elles n'ont pas besoin
   des données pour être justes : le titre « Répartition des notes », déjà
   dans le HTML, et la liste des tris, qui ne dépend que de l'onglet. Les
   deux champs sont seulement désactivés - une recherche lancée maintenant
   remplacerait le squelette par « aucun jeu trouvé ».

   Tous les fantômes portent aria-hidden : ils ne décrivent rien. */
const FANTOMES = 12;
/* Hauteurs des barres, en % de la case. Volontairement irrégulières : une
   belle courbe en cloche se lirait comme une vraie mesure. */
const FANTOMES_HIST = [22,34,30,46,58,72,66,88,74,60,44,36,26,18];
/* Largeurs des pastilles : « Tout », le menu des années, puis les deux
   onglets de statut. */
const FANTOMES_TABS = [46,84,92,98];

function squelette(){
  document.getElementById('gate').hidden = true;
  document.getElementById('invite').hidden = true;
  document.getElementById('accueil').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('cog').hidden = false;
  document.getElementById('tabs').hidden = false;
  document.getElementById('statsWrap').hidden = false;
  document.getElementById('dist').hidden = false;
  document.querySelector('.tools').hidden = false;

  renderSort();
  document.getElementById('q').disabled = true;
  document.getElementById('sort').disabled = true;
  document.getElementById('sortDir').disabled = true;

  // le retard repart à zéro toutes les six cases : au-delà, la dernière
  // scintillerait une demi-seconde après la première
  const retard = i => `--d:${(i % 6) * 90}ms`;
  const pose = (id, html) => { document.getElementById(id).innerHTML = html; };

  pose('tabs', FANTOMES_TABS.map((w,i)=>
    `<span class="fantome-tab" aria-hidden="true" style="width:${w}px;${retard(i)}"></span>`).join(''));

  pose('stats', Array.from({length:4}, (_,i)=>
    `<div class="stat" aria-hidden="true" style="${retard(i)}">
       <span class="fantome-l f-u"></span>
       <span class="fantome-l f-b"></span>
       <span class="fantome-l f-i"></span>
     </div>`).join(''));

  pose('hist', FANTOMES_HIST.map((h,i)=>
    `<span class="fantome-bar" aria-hidden="true" style="height:${h}%;${retard(i)}"></span>`).join(''));
  pose('haxis', '');   // la graduation n'a pas de forme sans les notes

  pose('out', `<div class="wall" aria-hidden="true">${
    Array.from({length: FANTOMES}, (_, i) =>
      `<div class="tile fantome" style="${retard(i)}">
         <span class="cov big chargement"></span>
         <span class="tcap">
           <span class="fantome-l"></span>
           <span class="fantome-l court"></span>
         </span>
       </div>`).join('')}</div>`);
}

/* ---------- verrou : lecture seule / modification ----------
   Il n'y a plus rien à déverrouiller. Le serveur répond `write: true` quand
   le journal affiché est celui du visiteur connecté, et `false` sinon. Le
   bouton mène donc à Abyss au lieu d'ouvrir une boîte à jeton. */
function majVerrou(){
  const chezMoi = CAN_WRITE;
  document.getElementById('unlock').hidden = chezMoi;
  document.getElementById('relock').hidden = true;   // plus de retour arrière à faire
  document.getElementById('addBtn').hidden = !chezMoi;
  // la mise à jour de masse écrit dans le journal : en lecture seule elle
  // n'aurait rien à proposer d'autre qu'un refus, autant ne pas la montrer
  document.getElementById('igdbBtn').hidden = !chezMoi;
  document.getElementById('unlock').textContent =
    MOI.connecte ? 'Ouvrir mon journal' : 'Se connecter sur Abyss';
}

document.getElementById('gRetry').addEventListener('click', ()=> charger());
document.getElementById('unlock').addEventListener('click', ()=>{
  closeMenu();
  /* Connecté sans journal : on lui en crée un et on l'y emmène. Connecté
     avec un journal : on l'ouvre. Pas connecté : direction Abyss. */
  /* ?connexion : Abyss ouvre sa fenêtre de connexion en arrivant. Sans ça
     on atterrissait sur le hub, à charge de retrouver le bouton - un clic
     de plus pour la seule chose qu'on venait faire. */
  if(!MOI.connecte){ location.href = '/abyss?connexion=1'; return; }
  if(MOI.pseudo){ ouvrirLeMien(); return; }
  creerMonJournal();
});
document.getElementById('inviteCreate').addEventListener('click', creerMonJournal);

/* ---------- état ----------
   Ce que la page affiche en ce moment, et rien d'autre : l'onglet, la
   recherche, le tri, la fiche ouverte, la tranche de notes retenue.

   range garde le découpage exact (lo / step / n) qui a servi à dessiner
   les barres, pour que le filtre range exactement les mêmes jeux que
   celles-ci comptaient. */
/* `anBucket` : l'onglet dont l'onglet « Statistiques » parle. Séparé de
   `bucket` parce que les statistiques ne sont pas un tiroir mais une
   lecture - on y entre depuis un onglet, et c'est de celui-là qu'on veut
   d'abord des chiffres, quitte à en choisir un autre une fois sur place. */
const S = { bucket:'all', q:'', sort:'note', dir:'desc', open:null, range:null,
            anBucket:'all' };

/* ---------- qui suis-je, et quels journaux existent ----------
   Un seul appel au démarrage : l'annuaire des journaux publics, plus l'état
   de la session. C'est lui qui remplit SOURCES, jusqu'ici écrit en dur. */
/* MOI est déclaré dans archive-noyau.js : la page Social s'en sert aussi,
   et c'est le seul fichier que les deux chargent. */

async function chargeAnnuaire(){
  const r = await fetch('/api/journal', {credentials: 'same-origin'});
  const d = await r.json();
  if(!d.ok) throw new Error(d.message || 'annuaire illisible');
  MOI = { connecte: !!d.connecte, pseudo: d.moi ? d.moi.pseudo : null,
          // la pastille de l'en-tête montre MA photo, pas celle du journal
          // affiché : elle est le seul point fixe de la barre
          avatar: d.moi ? d.moi.avatar : null,
          // la pastille de la cloche arrive avec l'annuaire, pas par un
          // appel à elle (voir liste() dans journal.py)
          notifs: d.notificationsNeuves || 0 };
  SOURCES = (d.journaux || []).map(j => ({
    nom: j.pseudo,
    titre: j.titre,
    jeux: j.jeux,
    avatar: j.avatar,
    banniere: j.banniere,
    url: '/api/journal/' + encodeURIComponent(j.pseudo),
  }));
  /* Le sien d'abord : c'est celui qu'on vient consulter neuf fois sur dix,
     et c'est le seul qu'on puisse modifier. Un journal prive n'apparait pas
     dans cet annuaire, qui ne liste que les journaux publics : on l'ajoute
     nous-memes plutot que de laisser la page par defaut retomber sur
     n'importe qui d'autre. `moi` sert à la recherche : c'est ce qui lui
     fait dire « Ton journal » - avec son nombre de jeux, connu même quand
     le journal est privé et absent de l'annuaire ci-dessus. */
  if(MOI.pseudo){
    const i = SOURCES.findIndex(x => x.nom === MOI.pseudo);
    if(i > 0) SOURCES.unshift(SOURCES.splice(i, 1)[0]);
    else if(i < 0) SOURCES.unshift({nom: MOI.pseudo,
                                     url: '/api/journal/' + encodeURIComponent(MOI.pseudo)});
    SOURCES[0].moi = true;
    SOURCES[0].jeux = d.moi.jeux;
    SOURCES[0].avatar = d.moi.avatar;
    SOURCES[0].banniere = d.moi.banniere;
  }
}

/* ---------- ma bibliothèque, quand je lis celle de quelqu'un d'autre ----------
   GAMES ne contient que le journal affiché. Chez un autre, il n'y a donc
   nulle part où lire ce que *moi* j'ai pensé du jeu dont j'ouvre la fiche -
   alors que c'est précisément la question qu'on se pose en feuilletant le
   classeur d'un ami : « lui il met 9, moi j'avais mis quoi ? ».
   Le mien est donc gardé de côté, à part, et ne sert qu'à ça.

   Une seule fois par visite : le journal est petit, et le relire à chaque
   changement de classeur ne dirait rien de neuf. Chez moi, il ne coûte même
   pas de requête - GAMES *est* déjà ma bibliothèque. */
let MA_BIBLIO = null;          // Map clé -> mon exemplaire du jeu
let MA_BIBLIO_PRETE = false;   // vrai dès qu'on l'a eue de première main
let MA_BIBLIO_EN_VOL = false;

const estMonJournal = () =>
  !!MOI.pseudo && !!source() && norm(source().nom) === norm(MOI.pseudo);

/* Les clés sous lesquelles un même jeu se reconnaît d'un classeur à
   l'autre : l'identifiant IGDB d'abord, parce que deux « Doom » n'en font
   pas un seul, et le nom normalisé à défaut - les classeurs remplis avant
   que les fiches IGDB existent n'ont que ça. */
function clesJeu(g){
  const c = [];
  if(g.idIgdb) c.push('igdb:' + g.idIgdb);
  if(g.name)   c.push('nom:' + norm(g.name));
  return c;
}
function rangeBiblio(jeux){
  const m = new Map();
  (jeux || []).forEach(j => clesJeu(j).forEach(c => { if(!m.has(c)) m.set(c, j); }));
  return m;
}
/* Mon exemplaire du jeu affiché, ou null. Chez moi : rien à comparer, la
   fiche dit déjà tout. */
function monJeu(g){
  if(!g || !MA_BIBLIO || estMonJournal()) return null;
  for(const c of clesJeu(g)){
    const j = MA_BIBLIO.get(c);
    if(j) return j;
  }
  return null;
}
async function chargeMaBiblio(){
  if(!MOI.pseudo) return;
  if(estMonJournal()){
    // le classeur affiché est le mien : il est déjà chargé, et à jour
    MA_BIBLIO = rangeBiblio(GAMES);
    MA_BIBLIO_PRETE = true;
    return;
  }
  if(MA_BIBLIO_PRETE || MA_BIBLIO_EN_VOL) return;
  MA_BIBLIO_EN_VOL = true;
  const url = '/api/journal/' + encodeURIComponent(MOI.pseudo);
  /* Le cache d'abord, s'il y en a un : la comparaison est là dès la
     première fiche ouverte, quitte à être rattrapée dans la seconde qui
     suit par la vraie réponse. */
  const cache = cacheStore.get(url);
  if(cache && cache.jeux) MA_BIBLIO = rangeBiblio(cache.jeux);
  try{
    const r = await fetch(url, {credentials: 'same-origin'});
    if(r.ok){
      const d = await r.json();
      if(d && d.ok){
        cacheStore.set(url, d);
        MA_BIBLIO = rangeBiblio(d.jeux);
        MA_BIBLIO_PRETE = true;
      }
    }
  }catch(e){
    /* Journal injoignable : on garde le cache s'il y en avait un, et la
       comparaison se tait s'il n'y en avait pas. Elle est un bonus, pas
       une raison de faire échouer l'affichage d'un classeur. */
  }
  MA_BIBLIO_EN_VOL = false;
  // la fiche ouverte ne savait pas encore que j'avais ce jeu : elle se repeint
  if(MA_BIBLIO && !document.getElementById('sheet').hidden && S.open !== null) paintSheet();
}

/* L'onglet sur lequel ce classeur s'ouvre : le choix de son auteur s'il
   existe encore, « Tout » sinon. La règle est celle d'applyData(), et elle
   sert maintenant à trois endroits - l'ouverture, l'étoile de la barre
   d'onglets, et la maison qui se cache quand on y est déjà - d'où cette
   fonction plutôt que trois copies qui finiraient par diverger.

   « Tout » et non l'année en cours : c'est la vue qui ne cache rien à qui
   arrive, et c'est donc elle que l'étoile marque quand personne n'a choisi. */
function ongletEntree(){
  return (ONGLETS_VUE.includes(ONGLET_DEFAUT) || BUCKETS.indexOf(ONGLET_DEFAUT) >= 0)
    ? ONGLET_DEFAUT : 'all';
}

/* La maison a disparu de la barre : c'est la pastille d'identité qui mène
   maintenant chez soi (voir majMoi). Elle, contrairement à la maison, reste
   là même quand on est déjà chez soi - elle ne sert pas qu'à naviguer, elle
   dit sous quel compte on est. */

/* Mon journal, sur l'onglet que j'y ai choisi comme entrée : la même
   arrivée que depuis Abyss, et ce que promet la maison de l'en-tête.

   Déjà chez soi, choisirClasseur() refuse - il ignore un clic sur le
   journal déjà ouvert - et applyData() ne reposera pas l'onglet, puisque
   PREMIERE_FOIS est retombé depuis longtemps. On se replace donc ici, avec
   la règle qu'applyData applique à l'ouverture : le choix de l'auteur s'il
   existe encore, « Tout » sinon. */
/* =======================================================================
   L'adresse : /archive/<pseudo>
   Un journal a une adresse à lui, qu'on peut copier et donner. C'est ce
   qui rend une page partageable, et c'est aussi le chemin le plus court
   pour arriver chez quelqu'un : le lien ouvre son journal directement,
   même chez qui n'a pas de compte et verrait sinon l'écran d'accueil.
   ======================================================================= */
function pseudoDeURL(){
  const m = location.pathname.match(/^\/archive\/([^/]+)\/?$/);
  if(!m) return '';
  try{ return decodeURIComponent(m[1]); }catch(e){ return m[1]; }
}

/* Le rang d'un journal dans SOURCES, en l'y ajoutant s'il n'y est pas.
   L'annuaire ne liste que les journaux publics : un lien vers un journal
   privé, ou vers un pseudo qui n'existe pas, n'y trouve rien. On l'ajoute
   quand même pour tenter le chargement - c'est le serveur qui doit dire
   « privé » ou « inconnu », pas un silence ici. */
function rangDuJournal(nom){
  const i = SOURCES.findIndex(x => norm(x.nom) === norm(nom));
  if(i >= 0) return i;
  SOURCES.push({nom: nom, url: '/api/journal/' + encodeURIComponent(nom)});
  return SOURCES.length - 1;
}

/* L'adresse suit le journal affiché : elle est copiable telle quelle à tout
   moment, ce qui est tout l'intérêt. replaceState et non pushState - une
   entrée d'historique par changement de classeur ferait du bouton Retour un
   « journal précédent » que personne n'a demandé, et il doit continuer de
   ramener d'où l'on vient. */
function majAdresse(){
  const s = source();
  const voulue = (s && s.nom) ? '/archive/' + encodeURIComponent(s.nom) : '/archive';
  if(location.pathname !== voulue){
    try{ history.replaceState(null, '', voulue + location.search); }catch(e){}
  }
}

function ouvrirLeMien(){
  const i = SOURCES.findIndex(x => x.nom === MOI.pseudo);
  if(i < 0) return;
  if(i !== SRC){ choisirClasseur(i); return; }
  closeSheet();
  S.bucket = ongletEntree();
  S.range = null; S.q = ''; S.open = null;
  document.getElementById('q').value = ''; majCroixQ();
  render();
  charger({silencieux:true});
  window.scrollTo(0, 0);
}


/* Créer son journal : une seule requête, et le serveur renvoie la page vide
   toute prête. Rejouable sans dégât, il rend l'existant s'il y en a un. */
async function creerMonJournal(){
  try{
    const data = await (async ()=>{
      const r = await fetch('/api/journal', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'}, body: '{}',
      });
      const d = await r.json();
      if(!r.ok || d.ok === false) throw new Error(d.message || 'création impossible');
      return d;
    })();
    MOI.pseudo = data.pseudo;
    majMoi();          // la barre du haut me connaît enfin : elle m'affiche
    SOURCES.unshift({nom: data.pseudo, titre: data.titre, moi: true, jeux: 0,
                     url: '/api/journal/' + encodeURIComponent(data.pseudo)});
    SRC = 0;
    majAdresse();
    PREMIERE_FOIS = true;
    applyData(data, true); showApp(); render();
    toast('Ton journal est prêt. Ajoute ton premier jeu.');
  }catch(e){
    toast('Création impossible - ' + (e.message || 'erreur inconnue'), true);
  }
}
