/* =======================================================================
   Archive Jeux Vidéos — archive-journal.js

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

   Ne sert plus qu'à proposer une catégorie au formulaire d'ajout — un jeu
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

/* L'état de la connexion tient dans la pastille de l'engrenage — verte quand
   les données viennent du script, ambrée pendant une actualisation, rouge
   quand celle-ci a échoué, éteinte quand rien n'a pu être joint. */
function majEtat(mode, txt){
  const c = document.getElementById('cog');
  c.dataset.etat = mode;
  c.setAttribute('aria-label', 'Paramètres — ' + txt);
}

/* Range la réponse dans GAMES / BUCKETS. Appelée aussi après chaque
   écriture : le serveur renvoie le journal relu, comme le faisait le script.
   frais=false : c'est le cache local qui vient d'être affiché, la vraie
   requête est encore en vol — on le dit au lieu d'annoncer une synchro. */
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
     l'écran. Rien ne l'attend — une fiche déjà ouverte se repeindra. */
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
function majEntete(){
  const s = source();
  document.getElementById('brand-title').textContent =
    s && s.nom ? `Journal de ${s.nom}` : 'Journal de jeu';
}

/* Une teinte stable par pseudo, pour que l'avatar d'une même personne ne
   change pas de couleur d'une recherche à l'autre. */
function teinteAvatar(nom){
  let h = 0;
  for(const c of (nom || '?')) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}
/* =======================================================================
   La recherche : un journal, ou un jeu
   Deux choses à chercher et une seule barre. Le choix se fait dedans, à
   côté de ce qu'on tape, et non entre deux boutons de l'en-tête : il
   fallait alors trancher avant de savoir ce qu'on trouverait derrière
   l'un ou l'autre. Un journal se cherche parmi ceux d'ici, déjà chargés ;
   un jeu se cherche chez IGDB, donc à chaque frappe et avec un délai.

   Elle se monte où on le lui demande — dans sa fenêtre quand on clique sur
   « Rechercher », et à même l'écran d'accueil quand personne n'est
   connecté, où elle est tout ce qu'un visiteur peut faire et n'a donc pas
   à être derrière un bouton. D'où l'absence d'identifiants ici : deux
   exemplaires peuvent vivre en même temps dans la page, et deux id
   identiques n'en désigneraient qu'un.
   ======================================================================= */
const LOUPE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`;

const MODES = [
  {cle: 'journal', nom: 'Un journal', invite: 'Nom du joueur...'},
  {cle: 'jeu',     nom: 'Un jeu',     invite: 'Nom du jeu...'},
];

function monteRecherche(hote){
  hote.innerHTML = `
    <!-- deux bascules, et non des onglets : un onglet doit désigner le
         panneau qu'il ouvre, et il n'y en a pas — c'est la même liste qui
         change de contenu. aria-pressed dit exactement ce qui se passe. -->
    <div class="rsearch-modes" role="group" aria-label="Que chercher">
      ${MODES.map((m, k)=>`<button type="button" class="rsearch-mode${k ? '' : ' on'}"
        data-mode="${m.cle}" aria-pressed="${k ? 'false' : 'true'}"
        >${esc(m.nom)}</button>`).join('')}
    </div>
    <label class="rsearch-box">
      ${LOUPE}
      <input class="rsearch-input" type="text" placeholder="${esc(MODES[0].invite)}"
             autocomplete="off" spellcheck="false" aria-label="Rechercher">
    </label>
    <div class="rsearch-list"></div>`;

  const champ = hote.querySelector('.rsearch-input');
  const liste = hote.querySelector('.rsearch-list');
  const etat = {mode: 'journal', jeton: 0, minuteur: null};

  /* Un mot à la place de la liste : « rien trouvé », « ça cherche », « IGDB
     n'a pas répondu ». Une liste qui reste vide sans rien dire laisse croire
     que la frappe n'a pas pris. Le rôle part avec les résultats : une liste
     déroulante qui ne contient qu'une phrase n'en est plus une, et un
     lecteur d'écran l'annoncerait comme une liste vide de choix. */
  function mot(texte){
    liste.removeAttribute('role');
    liste.removeAttribute('aria-label');
    liste.innerHTML = `<p class="rsearch-vide">${esc(texte)}</p>`;
  }
  function nomme(role, etiquette){
    liste.setAttribute('role', role);
    liste.setAttribute('aria-label', etiquette);
  }

  /* ---------- les journaux d'ici ---------- */
  function journaux(){
    const brut = champ.value;
    const q = norm(brut);
    const items = SOURCES.map((s,i)=>({s,i})).filter(({s}) => !q || norm(s.nom).includes(q));
    if(!items.length){ mot(`Aucun journal ne correspond à « ${brut} ».`); return; }
    nomme('list', 'Journaux trouvés');
    liste.innerHTML = items.map(({s,i})=>{
      const compte = typeof s.jeux === 'number' ? `${s.jeux} jeu${s.jeux>1?'x':''} terminé${s.jeux>1?'s':''}` : 'journal public';
      const sous = s.moi ? `Ton journal - ${compte}` : compte.charAt(0).toUpperCase() + compte.slice(1);
      const avatar = s.avatar
        ? `<img class="rsearch-avatar" src="${esc(s.avatar)}" alt="">`
        : `<span class="rsearch-avatar" style="--h:${teinteAvatar(s.nom)}">${esc(initials(s.nom || '?'))}</span>`;
      /* La bannière tapisse la ligne, très en retrait : elle dit à qui
         appartient le journal d'un coup d'œil sans rendre le texte illisible.
         L'adresse n'est pas écrite dans le HTML mais posée juste après, en
         JavaScript : esc() n'échappe pas l'apostrophe, qui suffirait à sortir
         d'un url('...') et à injecter du CSS. Rien à échapper, rien à oublier. */
      return `<button class="rsearch-item${i===SRC?' on':''}${
          s.banniere ? ' rsearch-orne' : ''}" data-i="${i}">
        ${avatar}
        <span class="rsearch-meta"><b>${esc(s.nom || '?')}</b><i>${esc(sous)}</i></span>
        ${i===SRC?'<span class="tick">✓</span>':''}
      </button>`;
    }).join('');
    liste.querySelectorAll('.rsearch-item').forEach(b=>{
      b.onclick = ()=> choisirClasseur(+b.dataset.i);
      const s = SOURCES[+b.dataset.i];
      if(s && s.banniere) b.style.setProperty('--banniere', `url("${s.banniere}")`);
    });
  }

  /* ---------- les jeux, chez IGDB ----------
     Les lignes sont celles de la liste déroulante du formulaire (acHTML) :
     même service rendu, même dessin, une seule fonction à corriger le jour
     où IGDB changera la forme de ses réponses. */
  function jeux(trouves){
    if(!trouves.length){ mot('Aucun jeu ne porte ce nom sur IGDB.'); return; }
    nomme('listbox', 'Jeux trouvés sur IGDB');
    liste.innerHTML = acHTML(trouves);
    liste.querySelectorAll('.ac-item').forEach((el, i)=>{
      el.onclick = ()=> ouvrirDetailIgdb(trouves[i].id, trouves[i].titre);
    });
  }
  async function chercheJeux(texte){
    const jeton = ++etat.jeton;
    let data;
    try{ data = await api('/api/jeu/suggestions', {nom: texte}); }
    catch(e){
      if(jeton === etat.jeton) mot('Recherche impossible : ' + raisonReseau(e));
      return;
    }
    // une frappe est passée devant, ou la recherche a été démontée
    if(jeton !== etat.jeton || !hote.isConnected) return;
    if(data.etat === 'ok') jeux(data.jeux || []);
    else mot(data.raison ? 'IGDB : ' + data.raison : 'Aucun jeu ne porte ce nom sur IGDB.');
  }

  /* ---------- la frappe ----------
     Chercher un journal ne coûte rien : la liste est déjà là, elle se filtre
     à chaque lettre. Chercher un jeu part chez IGDB, et c'est le serveur qui
     paie l'aller-retour : deux lettres minimum et un temps de répit, sans
     quoi « Hollow K » en ferait huit. */
  function frappe(){
    clearTimeout(etat.minuteur);
    etat.jeton++;
    if(etat.mode === 'journal'){ journaux(); return; }
    const texte = clean(champ.value);
    if(texte.length < 2){ mot('Tape au moins deux lettres.'); return; }
    mot('Recherche\u2026');
    etat.minuteur = setTimeout(()=> chercheJeux(texte), 250);
  }

  function bascule(cle){
    if(cle === etat.mode) return;
    etat.mode = cle;
    const m = MODES.find(x => x.cle === cle);
    champ.placeholder = m.invite;
    hote.querySelectorAll('.rsearch-mode').forEach(b=>{
      const on = b.dataset.mode === cle;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // ce qui est déjà tapé vaut pour l'autre liste : on relance dessus
    // plutôt que de vider le champ sous les doigts
    frappe();
    champ.focus();
  }
  hote.querySelectorAll('.rsearch-mode').forEach(b=>{
    b.onclick = ()=> bascule(b.dataset.mode);
  });

  champ.addEventListener('input', frappe);
  champ.addEventListener('keydown', e=>{
    if(e.key !== 'Enter') return;
    const premier = liste.querySelector('.rsearch-item, .ac-item');
    if(premier) premier.click();
  });
  frappe();

  /* `arrete` sert au démontage : sans lui, une réponse d'IGDB en vol
     repeindrait une liste qui n'est plus dans la page. */
  return {champ, arrete(){ clearTimeout(etat.minuteur); etat.jeton++; }};
}

/* ---------- la recherche dans sa fenêtre ---------- */
let RECHERCHE = null;

function fermerRecherche(){
  const host = document.getElementById('recherche');
  if(host.hidden) return;
  if(RECHERCHE){ RECHERCHE.arrete(); RECHERCHE = null; }
  host.hidden = true; host.innerHTML = '';
  verrouFond();
}
function ouvrirRecherche(){
  closeMenu(); closePer();
  const host = document.getElementById('recherche');
  host.innerHTML = `<div class="sheet recherche-sheet" role="dialog" aria-modal="true" aria-label="Rechercher">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">Rechercher</b></span>
      <span class="grp"><button class="sbtn rsearch-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="rsearch-in"></div>
  </div>`;
  host.hidden = false;
  verrouFond();
  host.querySelector('.rsearch-x').onclick = fermerRecherche;
  RECHERCHE = monteRecherche(host.querySelector('.rsearch-in'));
  RECHERCHE.champ.focus();
}
fermeSurFond('recherche', fermerRecherche);
document.getElementById('jnlSearchBtn').addEventListener('click', e=>{ e.stopPropagation(); ouvrirRecherche(); });

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
   serveur a dit non. Plus rien à saisir ici — l'adresse est dans le fichier.

   `refus` distingue le troisième cas : journal privé, pseudo inconnu. Un
   lien /archive/<pseudo> partagé tombe surtout là-dessus, et « ne répond
   pas » serait faux — il a répondu, c'est justement le problème. Ni adresse
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
     public comme déjà sélectionné — cocher une coche sur laquelle cliquer
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
     marquait le premier journal public comme déjà sélectionné — cocher une
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
   plutôt qu'à une attente. On dresse donc la page entière en gris —
   onglets, stats, histogramme, mur — à la forme exacte de ce qui va
   arriver : les vraies données se posent dessus sans rien faire sauter.

   Deux choses ne sont pas des fantômes, parce qu'elles n'ont pas besoin
   des données pour être justes : le titre « Répartition des notes », déjà
   dans le HTML, et la liste des tris, qui ne dépend que de l'onglet. Les
   deux champs sont seulement désactivés — une recherche lancée maintenant
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
  majMaison();
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
     on atterrissait sur le hub, à charge de retrouver le bouton — un clic
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
   lecture — on y entre depuis un onglet, et c'est de celui-là qu'on veut
   d'abord des chiffres, quitte à en choisir un autre une fois sur place. */
const S = { bucket:'all', q:'', sort:'note', dir:'desc', open:null, range:null,
            anBucket:'all' };

/* ---------- qui suis-je, et quels journaux existent ----------
   Un seul appel au démarrage : l'annuaire des journaux publics, plus l'état
   de la session. C'est lui qui remplit SOURCES, jusqu'ici écrit en dur. */
let MOI = { connecte: false, pseudo: null };

async function chargeAnnuaire(){
  const r = await fetch('/api/journal', {credentials: 'same-origin'});
  const d = await r.json();
  if(!d.ok) throw new Error(d.message || 'annuaire illisible');
  MOI = { connecte: !!d.connecte, pseudo: d.moi ? d.moi.pseudo : null };
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
     fait dire « Ton journal » — avec son nombre de jeux, connu même quand
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
   nulle part où lire ce que *moi* j'ai pensé du jeu dont j'ouvre la fiche —
   alors que c'est précisément la question qu'on se pose en feuilletant le
   classeur d'un ami : « lui il met 9, moi j'avais mis quoi ? ».
   Le mien est donc gardé de côté, à part, et ne sert qu'à ça.

   Une seule fois par visite : le journal est petit, et le relire à chaque
   changement de classeur ne dirait rien de neuf. Chez moi, il ne coûte même
   pas de requête — GAMES *est* déjà ma bibliothèque. */
let MA_BIBLIO = null;          // Map clé -> mon exemplaire du jeu
let MA_BIBLIO_PRETE = false;   // vrai dès qu'on l'a eue de première main
let MA_BIBLIO_EN_VOL = false;

const estMonJournal = () =>
  !!MOI.pseudo && !!source() && norm(source().nom) === norm(MOI.pseudo);

/* Les clés sous lesquelles un même jeu se reconnaît d'un classeur à
   l'autre : l'identifiant IGDB d'abord, parce que deux « Doom » n'en font
   pas un seul, et le nom normalisé à défaut — les classeurs remplis avant
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
   sert maintenant à trois endroits — l'ouverture, l'étoile de la barre
   d'onglets, et la maison qui se cache quand on y est déjà — d'où cette
   fonction plutôt que trois copies qui finiraient par diverger.

   « Tout » et non l'année en cours : c'est la vue qui ne cache rien à qui
   arrive, et c'est donc elle que l'étoile marque quand personne n'a choisi. */
function ongletEntree(){
  return (ONGLETS_VUE.includes(ONGLET_DEFAUT) || BUCKETS.indexOf(ONGLET_DEFAUT) >= 0)
    ? ONGLET_DEFAUT : 'all';
}

/* La maison ne se montre que si elle mène quelque part : il faut un journal
   à soi, et ne pas déjà être dessus sur son onglet d'entrée. Sinon elle
   resterait là à ne rien faire — un bouton qui ne change rien à l'écran se
   lit comme une panne. */
function majMaison(){
  document.getElementById('homeBtn').hidden =
    !MOI.pseudo || (CAN_WRITE && S.bucket === ongletEntree());
}

/* Mon journal, sur l'onglet que j'y ai choisi comme entrée : la même
   arrivée que depuis Abyss, et ce que promet la maison de l'en-tête.

   Déjà chez soi, choisirClasseur() refuse — il ignore un clic sur le
   journal déjà ouvert — et applyData() ne reposera pas l'onglet, puisque
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
   quand même pour tenter le chargement — c'est le serveur qui doit dire
   « privé » ou « inconnu », pas un silence ici. */
function rangDuJournal(nom){
  const i = SOURCES.findIndex(x => norm(x.nom) === norm(nom));
  if(i >= 0) return i;
  SOURCES.push({nom: nom, url: '/api/journal/' + encodeURIComponent(nom)});
  return SOURCES.length - 1;
}

/* L'adresse suit le journal affiché : elle est copiable telle quelle à tout
   moment, ce qui est tout l'intérêt. replaceState et non pushState — une
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
document.getElementById('homeBtn').addEventListener('click', ()=>{
  closeMenu(); fermerRecherche();
  ouvrirLeMien();
});

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
    SOURCES.unshift({nom: data.pseudo, titre: data.titre, moi: true, jeux: 0,
                     url: '/api/journal/' + encodeURIComponent(data.pseudo)});
    SRC = 0;
    majAdresse();
    PREMIERE_FOIS = true;
    applyData(data, true); showApp(); render();
    toast('Ton journal est prêt. Ajoute ton premier jeu.');
  }catch(e){
    toast('Création impossible — ' + (e.message || 'erreur inconnue'), true);
  }
}
