/* =======================================================================
   Archive Jeux Vidéos - archive-demarrage.js

   Le rendu global, les contrôles, et le démarrage de la page.

   render() décide de ce qui s'affiche et rappelle les modules précédents
   dans l'ordre ; en dessous viennent les écouteurs de la barre d'outils.

   Le démarrage ferme la marche, et c'est délibéré : il vivait au milieu du
   fichier d'un seul tenant, ce qui obligeait plusieurs déclarations à
   remonter loin du code qui s'en sert pour ne pas être lues avant leur
   ligne. Dernier de la chaîne, il ne s'exécute qu'une fois tout le reste
   en place, et cette contrainte disparaît.

   Chargé par templates/archive/archive.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */

/* ---------- rendu global ---------- */
function render(){
  /* La fiche ouverte survit au rendu. render() commençait par closeSheet(),
     si bien qu'un rafraîchissement de fond qui aboutissait pendant qu'on
     lisait une fiche la refermait sous les yeux. On retient plutôt quel jeu
     est affiché, et on va le rechercher dans les données neuves.

     Son identité, c'est le couple (onglet, ligne) - celui-là même qui sert
     déjà à réécrire la bonne cellule du classeur - plus le nom. Le nom
     n'est pas du luxe : quand une ligne est supprimée, les suivantes
     remontent d'un cran, et (onglet, ligne) désignerait alors le voisin. */
  const iAvant = S.open;
  const vu = iAvant !== null ? SHEET_LIST[iAvant] : null;
  const avant = vu ? JSON.stringify(vu) : '';
  const nAvant = SHEET_LIST.length;

  majEntete();
  document.getElementById('addBtn').hidden = !CAN_WRITE;
  /* Le résumé en image dessine un bilan de jeux terminés : une moyenne, un
     podium, des heures. Les statistiques n'ont pas de liste à résumer, « En
     cours » et la wishlist n'ont ni note ni heures - l'image y serait vide.
     Plutôt que de laisser le bouton et de répondre par un refus au clic, il
     ne se montre pas là où il n'a rien à faire. */
  const vueStats = S.bucket === 'stats';
  document.getElementById('bilanBtn').hidden = vueStats || estStatutNom(S.bucket);
  /* Et l'entrée qui y mène non plus, quand on y est déjà : elle ne ferait
     que refermer le menu sans rien changer à l'écran. On en ressort par la
     barre d'onglets, restée affichée pour ça. */
  document.getElementById('statsBtn').hidden = vueStats;
  renderTabs();

  /* L'onglet des statistiques n'est pas un tiroir : il n'a ni mur, ni tri,
     ni recherche, ni histogramme. Tout ce qui parle d'une liste de jeux est
     donc rangé, et lui seul s'affiche - plutôt que de laisser un bandeau de
     stats et une barre d'outils sans objet flotter au-dessus du vide. */
  document.getElementById('analyse').hidden = !vueStats;
  document.getElementById('statsWrap').hidden = vueStats;
  document.getElementById('dist').hidden = vueStats;
  document.querySelector('.tools').hidden = vueStats;
  document.getElementById('out').hidden = vueStats;
  if(vueStats){
    document.getElementById('deco').hidden = true;
    renderAnalyse();
    closeSheet();
    return;
  }

  renderSort(); renderStats(); renderDist();
  // reconstruire les tuiles pendant que l'une d'elles voyage vers la fiche
  // casse la transition en cours (voir TRANSITION_EN_COURS) : on la repousse
  if(TRANSITION_EN_COURS) RENDU_MUR_EN_ATTENTE = true;
  else renderWall();
  /* Prix Steam et suggestions : uniquement quand la wishlist est à l'écran.
     Les suggestions, en plus, uniquement chez moi - elles ne s'affichent pas
     ailleurs (voir renderDecouverte), et les demander quand même coûterait
     un appel IGDB pour une section que personne ne verra. Les tarifs, eux,
     s'affichent partout : c'est le prix du jeu, pas un conseil. */
  if(estWishlistNom(S.bucket)){
    majTarifs();
    if(estMonJournal()) chargeDecouverte();
  }
  renderDecouverte();

  if(iAvant === null) return;          // aucune fiche n'était ouverte
  if(!vu){ closeSheet(); return; }     // index sans jeu en face : on ferme
  /* filtered() est relu ici et pas plus haut : renderSort() peut changer le
     tri et renderDist() annuler la tranche de notes, donc l'ordre de la
     liste - et le rang de la fiche dedans. */
  const liste = filtered();
  const i = liste.findIndex(x => x.id === vu.id);
  // plus là : ligne supprimée, ou sortie du filtre affiché
  if(i < 0){ closeSheet(); return; }
  SHEET_LIST = liste;
  S.open = i;
  /* Repeindre seulement si quelque chose a bougé pour ce jeu, pour sa place
     ou pour le total affiché à côté. Repeindre pour rien remettrait la
     fiche tout en haut et volerait le focus à chaque passage du
     rafraîchissement de fond, alors qu'il ne rapporte presque toujours
     exactement les mêmes données. */
  if(JSON.stringify(liste[i]) !== avant || i !== iAvant || liste.length !== nAvant){
    paintSheet();
  }
}

/* ---------- contrôles ---------- */
document.getElementById('q').addEventListener('input',e=>{
  S.q = e.target.value; majCroixQ(); renderWall();
});
document.getElementById('qClear').addEventListener('click', ()=>{
  const champ = document.getElementById('q');
  champ.value = ''; S.q = ''; majCroixQ(); renderWall();
  champ.focus();
});
/* Firefox restaure le contenu des champs sur un simple rechargement. Le
   filtre doit repartir de ce qui est écrit, et la croix être là si le
   texte l'est - sinon le champ dit une chose et le mur en montre une
   autre. */
S.q = document.getElementById('q').value;
majCroixQ();
document.getElementById('sort').addEventListener('change',e=>{
  const famille = familleTri();
  S.sort = e.target.value;
  // chaque critère arrive dans le sens où on le lit d'habitude
  S.dir  = sensNaturel(S.sort, famille);
  TRI_MEMO[famille] = {tri:S.sort, dir:S.dir};   // retenu pour cette famille
  renderSortDir();
  renderWall();
});
document.getElementById('sortDir').addEventListener('click', ()=>{
  S.dir = S.dir === 'asc' ? 'desc' : 'asc';
  TRI_MEMO[familleTri()] = {tri:S.sort, dir:S.dir};
  renderSortDir();
  renderWall();
});
window.addEventListener('resize', ()=>{ document.getElementById('tip').classList.remove('show'); });

/* ---------- « Suggestion / Bug » ----------
   Le bouton menait à /abyss?suggestion=jeux-videos : signaler un bug de
   l'Archive faisait quitter l'Archive, avec la recherche en cours et la
   position dans le mur, pour revenir à la main une fois le message parti.
   La fenêtre s'ouvre maintenant ici, habillée comme le reste de la page
   (voir .sg-* dans la feuille de style). Le lien reste dans le HTML et
   reste vrai : c'est ce qui se passe si le script n'arrive pas.

   'sgFond' rejoint FENETRES plus haut : c'est verrouFond() qui décide du
   défilement de l'arrière-plan, et il ne connaît que cette liste. */
if(window.Suggestion){
  Suggestion.branche({
    bouton: 'suggBtn',
    projet: 'jeux-videos',
    estConnecte: ()=> MOI.connecte,
    surVisiteur: ()=>{ location.href = '/abyss?connexion=1'; },
    toast: (txt, mauvais)=> toast(txt, mauvais),
    surBascule: verrouFond,
  });
}

/* ---------- la cloche ----------
   Le bouton existe dans le balisage mais reste caché tant qu'on n'est pas
   connecté : sans compte, personne ne peut rien nous notifier, et un bouton
   qui n'ouvre jamais que « rien de neuf » n'a rien à faire dans la barre.

   Le panneau, lui, est monté par archive-social.js - partagé avec la page
   Social, qui a exactement le même bouton au même endroit. */
function brancheCloche(){
  const cloche = document.getElementById('cloche');
  if(!cloche || !MOI.connecte) return;
  cloche.hidden = false;
  monteCloche(cloche);
  socialMajNeuves(MOI.notifs || 0);
  /* La pastille en direct : quelqu'un aime ou commente pendant qu'on
     range son classeur, et le chiffre bouge sans qu'on recharge. Cette
     page n'a pas de fil à remplir - elle ne prend que la cloche.
     Voir socialTempsReel dans archive-social.js. */
  socialTempsReel();
}

(async function demarrer(){
  document.documentElement.style.setProperty('--cov-ratio', CONFIG.coverRatio);
  /* Part avant tout le reste, et sans qu'on l'attende : le rendu se fait
     avec le manifeste de la dernière visite, celui-ci le corrige derrière
     s'il a changé. Attendre sa réponse retarderait l'affichage du cache,
     qui est justement ce qu'on veut instantané. */
  chargeManifeste();
  majEtat('offline', 'connexion...');

  /* L'annuaire vient avant tout : sans lui on ne sait même pas quel journal
     ouvrir. C'est le seul temps d'attente incompressible de la page. */
  try{ await chargeAnnuaire(); }
  catch(e){ showGate('<b>Serveur injoignable.</b> Le hub Abyss ne répond pas.'); return; }

  brancheCloche();
  /* Ma pastille d'identité : posée une fois, juste après l'annuaire qui la
     renseigne. Elle ne dépend pas du journal ouvert - c'est justement ce
     qui en fait un repère fixe. */
  majMoi();

  /* La recherche demandée par l'adresse. C'est le bouton « Rechercher » de
     la page Social qui mène ici : la fenêtre vit avec les journaux qu'elle
     fouille, donc de ce côté-ci.

     Le paramètre est effacé aussitôt - il a servi. Le garder ferait rouvrir
     la fenêtre à chaque rechargement, et il partirait dans le lien qu'on
     copie pour donner son journal. */
  if(new URLSearchParams(location.search).get('recherche')){
    const propre = new URLSearchParams(location.search);
    propre.delete('recherche');
    const reste = propre.toString();
    try{ history.replaceState(null, '', location.pathname + (reste ? '?' + reste : '')); }catch(e){}
    ouvrirRecherche();
  }

  /* Une adresse /archive/<pseudo> passe avant tout le reste : elle dit
     exactement quel journal ouvrir, et c'est pour ça qu'on l'a suivie. Elle
     court-circuite donc l'écran d'accueil comme le « ouvre le mien » - un
     lien partagé doit montrer ce qu'il promet, pas une invitation à se
     connecter. */
  const demande = pseudoDeURL();
  if(demande){
    SRC = rangDuJournal(demande);
  }else if(!MOI.connecte){
    /* Pas connecté et rien de demandé : aucun journal ne s'ouvre tout
       seul. Voir showAccueil. */
    showAccueil(); return;
  }else if(!MOI.pseudo){
    /* Connecté sans journal : plutôt que d'atterrir par défaut sur celui
       d'un inconnu, on propose tout de suite d'en créer un. */
    showInvite(); return;
  }else{
    /* Le sien, et rien d'autre : chargeAnnuaire() l'a placé en tête de
       SOURCES, donc c'est toujours lui qui s'ouvre en arrivant depuis
       Abyss. */
    SRC = 0;
  }
  majAdresse();

  majEntete();
  const s = source();
  if(!s || !s.url){ showGate(null); return; }

  // le cache s'affiche tout de suite, quitte à ne pas être à jour : la vraie
  // requête part en même temps, en silence, et remplace dès qu'elle répond
  const cache = cacheStore.get(s.url);
  if(cache && cache.jeux && cache.jeux.length){
    applyData(cache, false);
    showApp();
    render();
    charger({silencieux:true});
  } else {
    squelette();
    charger();
  }
})();
