/* =======================================================================
   Archive Jeux Vidéos - archive-formulaire.js

   Ajouter, modifier, supprimer un jeu.

   Le formulaire, le constructeur d'onglet (« 2019 », « Avant 2019 »,
   « Entre 2015 et 2019 »), la détection de doublon, la validation champ
   par champ, et les deux fonctions d'appel à l'API (api / apiPatient) dont
   se servent aussi les modules suivants.

   Chargé par templates/archive/archive.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */

/* =======================================================================
   Ajouter / modifier / supprimer - tout part vers le Google Sheet.
   La page n'invente rien : elle renvoie au script les colonnes qu'elle a
   elle-même repérées à la lecture, donc elle réécrit exactement là où
   elle avait lu.
   ======================================================================= */
let EDIT = null;

function toast(txt, mauvais){
  const t = $('toast');
  t.textContent = txt;
  t.className = 'toast show' + (mauvais ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>{ t.classList.remove('show'); }, 3000);
}
function isoDate(d){ return /^\d{4}-\d{2}-\d{2}$/.test(d||'') ? d : ''; }
function numText(n){ return (n===null||n===undefined||n==='') ? '' : String(n).replace('.',','); }
/* Le temps de jeu tel qu'il se pose dans la case du formulaire - et non tel
   qu'il s'affiche sur une fiche, ce qui est le travail de hoursFmt.

   Un nombre, et rien d'autre : « 25 », « 25,5 ». Ni « 25h », puisque
   l'etiquette de la case dit deja « Temps de jeu (h) » et que l'unite s'y
   ecrivait donc deux fois ; ni « 25h30 », qui melait un separateur horaire
   a un champ ou les trois voisins - note, prix de base, prix paye - sont
   des decimaux a virgule. Trois cases qui se ressemblent doivent se saisir
   pareil, et une demi-heure s'ecrit ici « ,5 » comme un demi-euro.

   Deux decimales au plus : un quart d'heure fait 0,25 tout rond, mais un
   tiers d'heure ne tombe pas juste et 25,333333333333332 dans une case
   n'aide personne. Ce qu'on perd a l'arrondi vaut une vingtaine de
   secondes, et seulement pour qui reenregistre un temps qu'il n'a pas
   touche. toHours relit tout ca sans broncher - et relit encore « 25h30 »
   ou « 25:30 » pour qui prefere les taper. */
function timeText(h){
  if(h===null||h===undefined) return '';
  return numText(Math.round(h * 100) / 100);
}

/* Le chevron qui descend : « va-t'en en bas ». Le même dessin que les
   menus déroulants de la page, retourné par l'usage plutôt que par un
   second tracé - on le reconnaît sans l'apprendre. */
const ICONE_REDUIRE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
/* Et le même, retourné pour de bon, sur la pastille : elle fait remonter. */
const ICONE_AGRANDIR = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>`;

function formHTML(g){
  const mois = MONTHS.map((m,i)=>`<option value="${i+1}">${m}</option>`).join('');
  const avis = g ? g.review.join('\n') : '';
  return `<div class="sheet form-sheet" role="dialog" aria-modal="true">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">${g ? 'Modifier un jeu' : 'Ajouter un jeu'}</b></span>
      <!-- Réduire, puis fermer. Dans cet ordre parce que c'est celui du
           risque : la flèche met de côté, la croix jette. -->
      <span class="grp">
        <button class="sbtn form-reduire" aria-label="Réduire, pour aller voir le journal"
          title="Réduire - le formulaire attend en bas à droite">${ICONE_REDUIRE}</button>
        <button class="sbtn form-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="form-in">
      <div class="fgrid">
        <div class="fld full acw">
          <label for="f_name"><u>Nom du jeu <span class="req" aria-hidden="true">*</span></u></label>
          <input id="f_name" type="text" value="${esc(g?g.name:'')}" autocomplete="off"
                 spellcheck="false" role="combobox" aria-controls="f_ac"
                 aria-autocomplete="list" aria-expanded="false">
          <div class="ac" id="f_ac" role="listbox" aria-label="Jeux trouvés sur IGDB" hidden></div>
        </div>
        <p class="fld full doublon-avis" id="f_doublon" hidden></p>
        <button type="button" class="fpick" id="f_pick" hidden>
          <img id="f_pickimg" alt="" decoding="async">
          <span class="fpick-txt">
            <b id="f_pickt"></b>
            <i id="f_pickd"></i>
            <small>Clique pour changer le jeu</small>
          </span>
        </button>
        <label class="fld fcheck">
          <input id="f_encours" type="checkbox">
          <span>Jeu en cours</span></label>
        <label class="fld fcheck wish">
          <input id="f_wish" type="checkbox">
          <span>Wishlist</span></label>
        <div class="fld full" id="f_bucketwrap">
          <u>Année <span class="req" aria-hidden="true">*</span></u>
          ${constructeurHTML('f', `<label class="bkd-mois" id="f_monthwrap">
            <span>Mois</span>
            <select id="f_month"><option value="">-</option>${mois}</select></label>`)}
        </div>
        <label class="fld" id="f_ratingwrap"><u>Note sur 10</u>
          <input id="f_rating" type="text" inputmode="decimal" value="${esc(numText(g?g.rating:null))}"></label>
        <label class="fld" id="f_timewrap"><u>Temps de jeu (h)</u>
          <input id="f_time" type="text" inputmode="decimal"
                 value="${esc(timeText(g?g.hours:null))}"></label>
        <label class="fld"><u>Prix de base (€)</u>
          <input id="f_base" type="text" inputmode="decimal" value="${esc(numText(g?g.base:null))}"></label>
        <label class="fld" id="f_paidwrap"><u>Prix payé (€)</u>
          <input id="f_paid" type="text" inputmode="decimal" value="${esc(numText(g?g.paid:null))}"></label>
        <!-- La date de sortie ne se saisit plus : elle vient de la fiche IGDB
             retenue (voir alignePick) et s'affiche déjà sous le nom du jeu sur
             la fiche. Le champ reste, caché, parce que c'est encore lui qui
             porte la valeur entre le choix d'une jaquette et l'enregistrement. -->
        <input id="f_release" type="hidden" value="${esc(isoDate(g?g.release:''))}"
               data-orig="${esc(g&&g.release?g.release:'')}">
        <!-- Un <div> et non un <label> comme les autres champs : il y a
             maintenant deux commandes ici, l'avis et la case « spoiler ». Un
             label qui en enveloppe deux ne sait plus laquelle il désigne, et
             cliquer sur « Avis » aurait coché la case. D'où l'attribut
             for= explicite, comme pour le nom du jeu (.acw plus haut). -->
        <div class="fld full" id="f_reviewwrap">
          <div class="favis-tete">
            <label for="f_review"><u>Avis (Commencer par + ou -)</u></label>
            <!-- La case vit sur la ligne du titre, contre le champ qu'elle
                 qualifie : c'est de CET avis qu'elle parle, pas du jeu. -->
            <label class="fspoil" title="Les autres verront l'avis flouté, sauf s'ils ont déjà terminé le jeu">
              <input id="f_spoiler" type="checkbox"${g && g.spoiler ? ' checked' : ''}>
              <span>Marquer en tant que spoiler</span></label>
          </div>
          <span class="ta-wrap"><span class="ta-hl" id="f_review_hl" aria-hidden="true"></span
            ><textarea id="f_review" rows="5">${esc(avis)}</textarea></span></div>
      </div>
      <div class="frow">
        ${g ? '<button class="ghost danger" id="f_del">Supprimer ce jeu</button>' : ''}
        <span class="spacer"></span>
        <button class="ghost" id="f_cancel">Annuler</button>
        <button class="cta auto" id="f_ok">${g ? 'Enregistrer' : 'Ajouter'}</button>
      </div>
    </div>
  </div>`;
}

/* Les deux cases s'excluent : un jeu qu'on a commencé n'est plus une envie.
   Cocher l'une décoche l'autre, plutôt que d'interdire - on ne se bat pas
   avec un formulaire qui refuse un clic sans rien dire. */
function statutCoche(){ return $('f_encours').checked || $('f_wish').checked; }
function cibleOnglet(){
  if($('f_wish').checked) return ongletWishlist();
  if($('f_encours').checked) return ongletEnCours();
  return valeurConstructeur('f');
}

/* =======================================================================
   Le constructeur d'onglet

   Un onglet ne se tape plus, il se compose. Quatre formes, et rien d'autre :

       2019                  une année
       Avant 2019            tout ce qui précède
       Après 2019            tout ce qui suit
       Entre 2015 et 2019    un intervalle, la seconde année après la première

   Le champ libre d'avant laissait cohabiter « Avant 2025 », « A long long
   time ago » et « oui » : trois façons de dire une époque, dont deux que
   rien ne sait relire - ni le tri, ni le mois, ni un futur filtre par date.
   On ne peut plus les écrire ; celles qui existent déjà, elles, ne
   disparaissent pas (voir `garder` plus bas, et le renommage d'onglet).

   Le même constructeur sert au formulaire d'un jeu et à la fenêtre de
   renommage : d'où le préfixe d'identifiants passé en paramètre, plutôt que
   deux copies qui finiraient par diverger.
   ======================================================================= */
const FORMES = [
  { cle:'annee', nom:'Une année',  n:1 },
  { cle:'avant', nom:'Avant',      n:1 },
  { cle:'apres', nom:'Après',      n:1 },
  { cle:'entre', nom:'Entre',      n:2 },
];
const ANNEE_MINI = 1980;
/* Une de plus que l'année en cours : on range parfois un jeu fini le
   31 décembre dans l'année qui commence. */
const anneeMaxi = () => new Date().getFullYear() + 1;

/* Le nom que produit une composition. Un seul endroit l'écrit, parce que le
   serveur le relit avec des motifs qui doivent y correspondre au caractère
   près (voir periode_valide dans journal.py). */
function libellePeriode(forme, a1, a2){
  if(forme === 'avant') return `Avant ${a1}`;
  if(forme === 'apres') return `Après ${a1}`;
  if(forme === 'entre') return `Entre ${a1} et ${a2}`;
  return String(a1);
}

/* L'inverse : d'un onglet existant vers la composition qui le produit, ou
   null si personne ne saurait le recomposer - c'est exactement la
   définition d'un onglet d'avant la règle. */
function decomposePeriode(p){
  const t = String(p || '').trim();
  let m;
  if(/^\d{4}$/.test(t)) return { forme:'annee', a1:+t, a2:null };
  if((m = /^Avant (\d{4})$/.exec(t))) return { forme:'avant', a1:+m[1], a2:null };
  if((m = /^Après (\d{4})$/.exec(t))) return { forme:'apres', a1:+m[1], a2:null };
  if((m = /^Entre (\d{4}) et (\d{4})$/.exec(t)) && +m[2] > +m[1])
    return { forme:'entre', a1:+m[1], a2:+m[2] };
  return null;
}
const periodeValide = p => estStatutNom(p) || decomposePeriode(p) !== null;

/* Les onglets du journal que la règle ne sait pas relire. Ils restent
   affichés et utilisables : ce sont des jeux rangés dedans, pas des fautes
   à effacer. La page les signale, et propose de les renommer. */
function ongletsVieux(){
  return BUCKETS.filter(b => !estStatutNom(b) && !periodeValide(b));
}

function anneesPossibles(){
  const liste = [];
  for(let a = anneeMaxi(); a >= ANNEE_MINI; a--) liste.push(a);
  return liste;
}

/* `apres` : ce qu'on pose sur la même ligne que les années. Le formulaire y
   met le mois, pour que les deux listes déroulantes soient côte à côte et
   alignées - l'une au-dessus de l'autre dans deux colonnes, elles ne se
   rejoignaient jamais, la première étant précédée des pastilles de forme.
   La fenêtre de renommage n'y met rien : un onglet n'a pas de mois. */
/* ---------- le choix, en un clic ----------
   Neuf fois sur dix on range un jeu dans un onglet qui existe déjà, ou dans
   l'année qui vient de commencer. Ça doit donc être UN clic sur une
   pastille, pas trois listes déroulantes à parcourir.

   Les formes composées - avant, après, entre - sont rares : elles vivent
   derrière « Autre… », qui ne s'ouvre que si on le demande. Ce qu'on y
   compose vient s'ajouter aux pastilles, sélectionné : il y a toujours
   exactement une pastille allumée, et elle porte le nom qui sera écrit.
   On ne compose plus à l'aveugle, et on ne lit plus un aperçu pour savoir
   ce qu'on vient de faire. */
function constructeurHTML(p, apres){
  const annees = anneesPossibles().map(a => `<option value="${a}">${a}</option>`).join('');
  return `<div class="bkd" id="${p}_bkd">
    <div class="bkd-ligne">
      <div class="bkd-choix" id="${p}_choix" role="group" aria-label="Onglet"></div>
      ${apres || ''}
    </div>
    <div class="bkd-plus" id="${p}_plus" hidden>
      <div class="bkd-formes" role="group" aria-label="Forme de l'onglet">
        ${FORMES.map(f => `<button type="button" class="bkd-forme" data-forme="${f.cle}"
          aria-pressed="false">${esc(f.nom)}</button>`).join('')}
      </div>
      <div class="bkd-annees">
        <select class="sel" id="${p}_a1" aria-label="Année">${annees}</select>
        <span class="bkd-et" id="${p}_et" hidden>et</span>
        <select class="sel" id="${p}_a2" aria-label="Seconde année" hidden>${annees}</select>
      </div>
    </div>
  </div>`;
}

/* L'état d'un constructeur, par préfixe : deux peuvent vivre en même temps
   (le formulaire d'un jeu, la fenêtre de renommage). `valeur` est la seule
   vérité - les pastilles et le panneau ne font que la poser. */
const BKD = {};

/* Les pastilles proposées, dans l'ordre du temps.

   Les onglets du journal d'abord : ce sont eux qu'on choisit presque
   toujours. Puis l'année en cours si elle n'y est pas encore - commencer
   une nouvelle année doit rester un clic. Puis la valeur composée, si elle
   n'est déjà nulle part.

   Un onglet d'avant la règle n'apparaît QUE s'il est déjà celui du jeu
   ouvert : on ne force personne à déménager un jeu rangé dans « oui »,
   mais on n'en propose pas non plus l'entrée à un jeu neuf. */
function pastillesPossibles(p){
  const e = BKD[p];
  const liste = BUCKETS.filter(b => !estStatutNom(b)
    && (periodeValide(b) || b === e.depart));
  const auj = String(new Date().getFullYear());
  if(liste.indexOf(auj) < 0) liste.push(auj);
  if(e.valeur && liste.indexOf(e.valeur) < 0) liste.push(e.valeur);
  return liste;
}

function brancheConstructeur(p, depart, surChangement){
  const dec = decomposePeriode(depart);
  const auj = new Date().getFullYear();
  BKD[p] = {
    depart: depart || '',
    valeur: depart || String(auj),
    ouvert: false,
    forme: dec ? dec.forme : 'annee',
    a1: dec ? dec.a1 : auj,
    a2: dec && dec.a2 ? dec.a2 : auj + 1,
    sur: surChangement || null,
  };
  const e = BKD[p];
  if(e.a2 <= e.a1) e.a2 = Math.min(e.a1 + 1, anneeMaxi());

  $(p + '_bkd').querySelectorAll('.bkd-forme').forEach(b => {
    b.addEventListener('click', ()=>{
      const avant = e.forme;
      e.forme = b.dataset.forme;
      /* On arrive sur « Entre » : l'intervalle part serré, l'année suivante,
         et on l'élargit ensuite. Le laisser à la dernière valeur du second
         sélecteur proposait « Entre 2023 et 2027 » sans que personne ne
         l'ait demandé. « Entre 2019 et 2015 » ne veut rien dire non plus :
         la seconde année suit la première, et on la remonte plutôt que de
         refuser au moment d'enregistrer. */
      if(e.forme === 'entre' && (avant !== 'entre' || e.a2 <= e.a1))
        e.a2 = Math.min(e.a1 + 1, anneeMaxi());
      composeConstructeur(p);
    });
  });
  $(p + '_a1').addEventListener('change', ()=>{
    e.a1 = +$(p + '_a1').value;
    if(e.forme === 'entre' && e.a2 <= e.a1) e.a2 = Math.min(e.a1 + 1, anneeMaxi());
    composeConstructeur(p);
  });
  $(p + '_a2').addEventListener('change', ()=>{
    e.a2 = +$(p + '_a2').value;
    if(e.a2 <= e.a1) e.a1 = Math.max(e.a2 - 1, ANNEE_MINI);
    composeConstructeur(p);
  });
  peintConstructeur(p);
}

/* Le panneau vient de bouger : sa composition devient la valeur. */
function composeConstructeur(p){
  const e = BKD[p];
  e.valeur = libellePeriode(e.forme, e.a1, e.a2);
  peintConstructeur(p);
}

function valeurConstructeur(p){
  return BKD[p] ? BKD[p].valeur : '';
}

function peintConstructeur(p){
  const e = BKD[p];
  const zone = $(p + '_choix');

  /* Une pastille pointillée pour un onglet qui n'existe pas encore : on
     voit qu'on est en train d'en créer un avant de l'avoir créé. */
  zone.innerHTML = pastillesPossibles(p).map(b => {
    const existe = BUCKETS.indexOf(b) >= 0;
    const n = existe ? GAMES.filter(g => g.bucket === b).length : 0;
    return `<button type="button" class="bkd-p${existe ? '' : ' neuf'}${
      periodeValide(b) ? '' : ' vieux'}" data-b="${esc(b)}"
      aria-pressed="${b === e.valeur}" title="${existe
        ? esc(`${n} jeu${n > 1 ? 'x' : ''}`) : 'Nouvel onglet'}">${esc(b)}</button>`;
  }).join('') + `<button type="button" class="bkd-p autre" id="${p}_autre"
      aria-expanded="${e.ouvert}">${e.ouvert ? 'Fermer' : 'Ajouter'}</button>`;

  zone.querySelectorAll('[data-b]').forEach(b => {
    b.addEventListener('click', ()=>{
      e.valeur = b.dataset.b;
      /* choisir une pastille remet le panneau d'accord avec elle : le
         rouvrir doit repartir de ce qu'on voit, pas d'un vieil état */
      const d = decomposePeriode(e.valeur);
      if(d){ e.forme = d.forme; e.a1 = d.a1; if(d.a2) e.a2 = d.a2; }
      peintConstructeur(p);
    });
  });
  $(p + '_autre').addEventListener('click', ()=>{
    e.ouvert = !e.ouvert;
    if(e.ouvert) composeConstructeur(p); else peintConstructeur(p);
  });

  const deux = e.forme === 'entre';
  $(p + '_plus').hidden = !e.ouvert;
  $(p + '_bkd').querySelectorAll('.bkd-forme').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.forme === e.forme)));
  $(p + '_a1').value = String(e.a1);
  $(p + '_a2').value = String(e.a2);
  $(p + '_et').hidden = !deux;
  $(p + '_a2').hidden = !deux;

  if(e.sur) e.sur(e.valeur);
}
/* Un jeu en cours n'a rien à dire de sa fin : on retire de l'écran l'année,
   le mois, la note, le temps de jeu et l'avis. Décocher les fait revenir,
   c'est le geste qui termine un jeu.
   Un jeu de la wishlist cache la même chose, plus le prix payé : il n'est
   pas acheté, la case n'aurait aucun sens. Le prix de base reste, c'est
   justement ce qu'on veut noter. */
function syncStatut(){
  const sansFin = statutCoche();
  // le mois n'est plus dans cette liste : il vit maintenant DANS f_bucketwrap,
  // sur la même ligne que l'année - le cacher deux fois ne le cache pas mieux
  ['f_bucketwrap','f_ratingwrap','f_timewrap','f_reviewwrap']
    .forEach(id => { $(id).hidden = sansFin; });
  $('f_paidwrap').hidden = $('f_wish').checked;
  syncMois();
}

/* Un mois ne veut dire quelque chose que dans une année pleine : « mars »
   de « Avant 2019 » ne désigne aucun moment. Le champ se ferme donc, et se
   vide - le laisser rempli mais grisé garderait à l'écran une valeur que
   l'enregistrement effacera de toute façon (voir sans_mois dans journal.py,
   qui tient la même règle du côté qui compte).

   Grisé plutôt que caché : un champ qui disparaît laisse croire qu'il
   n'existe pas, alors qu'il suffit de repasser sur une année pour le
   retrouver. */
function syncMois(){
  const champ = $('f_month');
  if(!champ) return;
  const e = BKD['f'];
  /* La valeur, pas la forme : on peut avoir choisi « 2019 » d'un clic sur
     une pastille sans jamais ouvrir le panneau des formes. */
  const annee = !statutCoche() && !!e && /^\d{4}$/.test(e.valeur);
  champ.disabled = !annee;
  if(!annee) champ.value = '';
  const enveloppe = $('f_monthwrap');
  if(enveloppe) enveloppe.classList.toggle('inerte', !annee);
  // le titre du champ dit ce qui manque, plutôt que de laisser deviner
  const titre = $('f_bucketwrap');
  if(titre) titre.title = annee ? '' :
    "Le mois ne se choisit que dans une année pleine.";
}

/* ---------- doublon ----------
   Le nom seul dit s'il y a doublon ; l'avis flotte pendant la frappe, et
   submitForm() bloque l'ajout une première fois sur ce même repérage - un
   second clic confirme, pour ne pas empêcher un vrai replay d'un jeu déjà
   terminé (voir submitForm et le bouton "Ajouter quand même ?"). */
function trouveDoublon(nom){
  const q = norm(nom);
  if(!q) return null;
  return GAMES.find(g => (!EDIT || g.id !== EDIT.id) && norm(g.name) === q) || null;
}
function majDoublon(){
  const zone = $('f_doublon');
  // le nom a changé : la confirmation « Ajouter quand même ? » ne valait
  // que pour l'ancien, sans quoi un second clic confirmerait le mauvais jeu
  const ok = $('f_ok');
  if(ok && ok.classList.contains('armed')){
    ok.classList.remove('armed');
    ok.textContent = EDIT ? 'Enregistrer' : 'Ajouter';
  }
  if(!zone) return;
  const g = trouveDoublon($('f_name').value);
  if(!g){ zone.hidden = true; return; }
  const ou = estStatut(g) ? g.bucket : (g.year || g.bucket);
  zone.hidden = false;
  zone.innerHTML = `Déjà dans ton journal - <b>${esc(ou)}</b>`
    + (g.rating !== null ? `, noté <b>${fr(g.rating,1)}</b>` : '') + '.';
}
/* ---------- validation ----------
   Un champ en faute s'entoure de rouge, et le premier motif part en toast
   - plus lisible qu'un bloc de texte qui poussait le reste du formulaire.
   L'entourage se dissipe dès que le champ est retouché : pas besoin de
   resoumettre pour voir l'erreur partir. */
/* f_bucket n'y est plus : l'onglet se compose au lieu de se taper, et une
   composition ne peut pas être en faute - c'est tout l'intérêt. */
const CHAMPS_VALIDES = ['f_name','f_rating','f_time','f_base','f_paid'];
function champErr(id, actif){
  const champ = $(id);
  const wrap = champ && champ.closest('.fld');
  if(wrap) wrap.classList.toggle('err', actif);
}
function razErreurs(){
  CHAMPS_VALIDES.forEach(id => champErr(id, false));
}
/* vide = optionnel, ce n'est pas une erreur ; non vide mais illisible en
   est une - c'était jusque-là avalé en silence et transformé en case vide */
function champInvalide(id, parseur, mini, maxi){
  const brut = clean($(id).value);
  if(!brut) return false;
  const n = parseur(brut);
  if(n === null) return true;
  if(mini !== undefined && n < mini) return true;
  if(maxi !== undefined && n > maxi) return true;
  return false;
}
function validerFormulaire(){
  const sansFin = statutCoche();
  const erreurs = [];
  if(!clean($('f_name').value))
    erreurs.push({champ:'f_name', message:'Il faut au moins un nom de jeu.'});
  /* Un ajout passe forcément par une fiche IGDB. C'est ce rattachement qui
     apporte la jaquette, la date de sortie, la plateforme, le développeur
     et les genres : un jeu tapé à la main n'a rien de tout ça et reste un
     trou dans les statistiques - exactement ce qu'un rattrapage entier a
     servi à combler après coup.
     Seulement à l'ajout : une modification doit rester possible sur les
     jeux d'avant, qui n'ont jamais eu de fiche. */
  if(!EDIT && !(JEU_PICK && JEU_PICK.id))
    erreurs.push({champ:'f_name', message:
      "Choisis le jeu dans la liste qui s'ouvre sous le nom."});
  // la note est sur 10 partout dans la page : 85 tapé pour 8,5 doit se
  // voir tout de suite, pas finir en 85/10 dans les stats sans un mot
  if(!sansFin && champInvalide('f_rating', toNum, 0, 10))
    erreurs.push({champ:'f_rating', message:'Note incorrecte.'});
  if(!sansFin && champInvalide('f_time', toHours))
    erreurs.push({champ:'f_time', message:'Temps de jeu incorrect.'});
  if(champInvalide('f_base', toNum))
    erreurs.push({champ:'f_base', message:'Prix de base incorrect.'});
  if(!$('f_wish').checked && champInvalide('f_paid', toNum))
    erreurs.push({champ:'f_paid', message:'Prix payé incorrect.'});
  return erreurs;
}
/* Rejoue le texte de l'avis dans le calque colore : une ligne qui commence
   par + passe en vert, par - en rouge, le reste garde la couleur normale.
   Le \n final garde la bonne hauteur quand le texte finit par un retour. */
function majAvis(){
  const ta = $('f_review'), hl = $('f_review_hl');
  if(!ta || !hl) return;
  hl.innerHTML = ta.value.split('\n').map(ligne=>{
    const t = ligne.trimStart();
    const cls = t.startsWith('+') ? 'plus' : (t.startsWith('-') ? 'minus' : '');
    return cls ? `<span class="${cls}">${esc(ligne)}</span>` : esc(ligne);
  }).join('\n') + '\n';
  hl.scrollTop = ta.scrollTop;
}
function openForm(g){
  /* Un formulaire replié attend en bas à droite : on ne l'écrase pas sous un
     autre. « Modifier » ou « + Ajouter un jeu » le font revenir, et c'est
     tout - le rouvrir sur un autre jeu jetterait sans un mot ce qui y était
     tapé, exactement ce que la pastille sert à éviter. Pour passer à autre
     chose, il y a sa croix. */
  if(formEstReduit()){
    const memeJeu = !!EDIT && !!g && EDIT.id === g.id;
    rouvrirForm();
    if(!memeJeu) toast('Un formulaire est déjà en cours - termine-le ou abandonne-le.', true);
    return;
  }
  EDIT = g || null;
  const host = $('form');
  host.innerHTML = formHTML(g);
  host.hidden = false;
  verrouFond();
  const enCours = !!(g && estEnCours(g));
  const wish    = !!(g && estWishlist(g));
  $('f_encours').checked = enCours;
  $('f_wish').checked = wish;
  // en ajout - et pour un jeu en cours ou convoité qu'on vient de terminer -
  // on propose toujours l'année la plus récente, pas l'onglet affiché
  const defaut = (g && !enCours && !wish) ? g.bucket : derniereAnnee();
  // le mois suit la forme : il ne se remplit que dans une année pleine
  brancheConstructeur('f', defaut, syncMois);
  /* Le mois enregistré du jeu, et rien du tout pour un ajout. Le champ
     partait sur le mois courant : c'était vrai le jour où on ajoute un jeu
     le jour où on le finit, et faux tout le reste du temps - un jeu terminé
     en juin et rangé en août prenait « août » sans que personne ne le
     remarque, puisqu'un champ déjà rempli ne se relit pas. Vide, il se
     regarde : le mois est facultatif, et celui qui l'écrit le choisit. */
  $('f_month').value = (g && g.month) ? String(g.month) : '';
  syncStatut();
  syncMois();
  $('f_encours').onchange = ()=>{
    if($('f_encours').checked) $('f_wish').checked = false;
    syncStatut();
  };
  $('f_wish').onchange = ()=>{
    if($('f_wish').checked) $('f_encours').checked = false;
    syncStatut();
  };
  host.querySelector('.form-x').onclick = demandeFermerForm;
  host.querySelector('.form-reduire').onclick = reduireForm;
  $('f_cancel').onclick = demandeFermerForm;
  $('f_ok').onclick = submitForm;
  const del = $('f_del');
  if(del) del.onclick = ()=>{
    if(del.classList.contains('armed')) return supprimerJeu(del);
    del.classList.add('armed');
    del.textContent = 'Confirmer la suppression';
    setTimeout(()=>{ if(del.isConnected){ del.classList.remove('armed'); del.textContent = 'Supprimer ce jeu'; } }, 5000);
  };
  const ta = $('f_review');
  ta.addEventListener('input', majAvis);
  ta.addEventListener('scroll', ()=>{ $('f_review_hl').scrollTop = ta.scrollTop; });
  majAvis();
  brancherAuto();          // complétion du nom depuis IGDB (voir plus bas)
  $('f_name').addEventListener('input', majDoublon);
  majDoublon();
  posePick(null);          // pose aussi le rappel « choisis une fiche »
  // un champ retouché n'est plus en faute : inutile de resoumettre pour
  // voir son entourage rouge partir
  CHAMPS_VALIDES.forEach(id=>{
    const champ = $(id);
    if(champ) champ.addEventListener('input', ()=> champErr(id, false));
  });
  /* Le formulaire devient « sale » au premier geste, et le reste : c'est ce
     qui décide si la croix pose une question. Posé sur la boîte entière et
     en capture, une fois - une écoute par champ serait à tenir à jour à
     chaque champ ajouté, et les cases à cocher, les listes déroulantes et
     les pastilles d'onglet n'émettent pas toutes `input`. */
  FORM_SALE = false;
  ['input', 'change', 'click'].forEach(quoi=>
    host.addEventListener(quoi, e=>{
      /* La barre d'outils n'est pas une modification : réduire ou fermer ne
         doit pas rendre sale un formulaire qu'on n'a fait qu'ouvrir. */
      if(e.target.closest('.sheet-tools')) return;
      if(quoi === 'click' && !e.target.closest('.bkd-p,.fcheck,.fpick,.ac-item')) return;
      FORM_SALE = true;
    }, true));
  $('f_name').focus();
}
/* ---------- fermer, ou mettre de côté ----------
   Le formulaire est le seul endroit de la page où l'on ÉCRIT. Tout le reste
   se lit, et s'y referme sans conséquence ; ici, un clic à côté du cadre
   effaçait dix lignes d'avis sans un mot. Deux réponses à ça, et elles ne
   règlent pas la même chose :

     - la croix demande confirmation quand quelque chose a été tapé. Deux
       clics, comme « Supprimer ce jeu » juste en dessous : c'est le même
       geste irréversible, il doit se défendre pareil.
     - la flèche ne ferme rien du tout. Elle replie le formulaire en une
       pastille, en bas à droite, et rend le journal - on va relire les
       notes des trois jeux d'à côté avant de décider de celle-ci, puis on
       reprend là où on s'était arrêté. C'est le geste qui manquait : noter
       un jeu, c'est le comparer, et il fallait jusqu'ici fermer pour
       comparer, donc choisir entre voir et garder.

   `FORM_SALE` ne regarde pas si la valeur a réellement changé, seulement si
   on a touché au formulaire. Comparer champ par champ à l'état de départ
   coûterait plus et se tromperait plus souvent qu'une question de trop. */
let FORM_SALE = false;
let FORM_ARME = 0;                 // quand la croix a été refusée une fois
const FORM_ARME_MS = 5000;

function formArmeRaz(){
  FORM_ARME = 0;
  const x = document.querySelector('#form .form-x');
  if(x){
    x.classList.remove('armed');
    x.textContent = '×';
    x.setAttribute('aria-label', 'Fermer');
  }
  const annule = $('f_cancel');
  if(annule && annule.classList.contains('armed')){
    annule.classList.remove('armed');
    annule.textContent = 'Annuler';
  }
}

/* Le geste de qui ferme : la croix, « Annuler », Échap, le clic sur le fond,
   la feuille repoussée au doigt. Tous passent par ici - c'est ce qui fait
   qu'aucun d'eux ne peut effacer un avis en silence. closeForm(), elle,
   reste inconditionnelle : elle sert après un enregistrement réussi, après
   une suppression, et aux écrans d'accueil, où il n'y a plus rien à
   sauver et rien à demander. */
function demandeFermerForm(){
  const host = $('form');
  if(host.hidden) return;
  if(!FORM_SALE || Date.now() - FORM_ARME < FORM_ARME_MS){ closeForm(); return; }
  /* La croix s'ouvre et se nomme, là où l'on vient de cliquer : « Abandonner ? »
     en rouge plein. Pas de bandeau en bas de l'écran pour l'expliquer - le
     bouton qui a refusé est le bon endroit pour poser la question, et il
     répond du même clic. « Annuler », en pied de formulaire, prend le même
     mot : les deux ferment, les deux doivent demander pareil.

     Et aucune secousse sur la feuille. Elle en avait une, pour signaler le
     refus au doigt - la feuille repoussée revient d'un coup à sa place, et
     le mouvement rendait ce retour lisible. Mais il partait vers le BAS
     avant de remonter, ce qui se lisait comme un tremblement, et il écrasait
     `animation` sur .sheet - donc le retirer relançait l'animation d'entrée
     `rise` et faisait clignoter tout le formulaire. Deux ennuis pour un
     détail : le bouton rouge dit la même chose sans bouger. */
  const arme = FORM_ARME = Date.now();
  const x = host.querySelector('.form-x');
  if(x){
    x.classList.add('armed');
    x.textContent = 'Abandonner ?';
    x.setAttribute('aria-label', 'Abandonner les modifications');
  }
  const annule = $('f_cancel');
  if(annule){ annule.classList.add('armed'); annule.textContent = 'Abandonner ?'; }
  /* Le relevé exact, et non « cinq secondes se sont-elles écoulées » : la
     minuterie se réveille pile à l'échéance, où la soustraction tombait
     tantôt à 4999 tantôt à 5000 - un désarmement sur deux ne se faisait
     pas, et la croix restait rouge indéfiniment. */
  setTimeout(()=>{ if(FORM_ARME === arme) formArmeRaz(); }, FORM_ARME_MS);
}

function closeForm(){
  const host = $('form');
  /* Replié, le formulaire est caché mais bien là, avec tout ce qu'on y a
     tapé : c'est la pastille qui dit qu'il existe encore. Sans ce relevé,
     `host.hidden` faisait sortir d'ici sans rien nettoyer, et un formulaire
     replié survivait à un enregistrement ou à un retour à l'accueil. */
  const reduit = !!pastille();
  pastilleEnleve();
  if(host.hidden && !reduit) return;
  // ce qui est encore en vol ne concerne plus personne : la liste, le prix
  // et la jaquette retenue partent avec le formulaire
  oublieAuto();
  host.hidden = true; host.innerHTML = '';
  /* La réouverture d'une pastille remonte le formulaire au-dessus de ce qui
     s'était ouvert entre-temps (voir rouvrirForm), ce qui lui laisse un
     z-index en dur. On le rend, sinon la prochaine ouverture hériterait du
     rang d'une pile qui n'existe plus. */
  host.style.zIndex = '';
  EDIT = null;
  FORM_SALE = false;
  FORM_ARME = 0;
  verrouFond();
}
fermeSurFond('form', demandeFermerForm);

/* ---------- la pastille, en bas à droite ----------
   Le formulaire replié. Pas une notification - on ne l'informe de rien : un
   travail en cours, posé là où il ne gêne pas la lecture du mur, et qui se
   rouvre d'un clic. La croix qu'elle porte est la même que celle du
   formulaire, confirmation comprise : abandonner depuis la pastille ne doit
   pas être plus facile qu'abandonner depuis le cadre.

   Trois coins sont déjà pris en bas de l'écran : le toast au centre, la
   bannière de rattrapage à gauche (voir .rattrapage). Le dernier est libre,
   et c'est celui où l'on va chercher ce genre de chose. */
const FORM_REDUIT_MS = 300, FORM_ROUVRE_MS = 340;
let FORM_ANIME = false;
const sansMouvement = ()=>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Ce que la pastille annonce : le jeu dont il s'agit. Le nom tapé plutôt que
   celui du classeur, parce qu'en pleine frappe c'est celui-là qu'on vient
   d'écrire - et « Nouveau jeu » tant qu'il n'y a rien, ce qui vaut mieux
   qu'une pastille anonyme. */
function formTitreCourt(){
  const tape = clean(($('f_name') || {}).value || '');
  if(tape) return tape;
  if(EDIT && EDIT.name) return EDIT.name;
  return 'Nouveau jeu';
}

function pastille(){ return document.getElementById('formPastille'); }
function pastilleEnleve(){
  const p = pastille();
  if(p) p.remove();
}
function pastilleMonte(){
  pastilleEnleve();
  const p = document.createElement('div');
  p.id = 'formPastille';
  p.className = 'form-pastille mesure';
  p.innerHTML = `<button type="button" class="fp-ouvre"
      aria-label="Reprendre la modification">
      <span class="fp-fleche">${ICONE_AGRANDIR}</span>
      <span class="fp-txt">
        <b></b>
        <i>${EDIT ? 'Modification en cours' : 'Ajout en cours'}</i>
      </span>
    </button>
    <button type="button" class="fp-x" aria-label="Abandonner les modifications">×</button>`;
  // textContent et non le gabarit : un titre de jeu vient d'un champ libre
  p.querySelector('.fp-txt b').textContent = formTitreCourt();
  document.body.appendChild(p);
  /* `()=>` et non la fonction nue : onclick passe l'événement en premier
     argument, qui serait pris pour le `apres` de rouvrirForm. */
  p.querySelector('.fp-ouvre').onclick = ()=> rouvrirForm();
  p.querySelector('.fp-x').onclick = ()=>{
    /* Le formulaire est replié : la confirmation a besoin de lui à l'écran
       pour armer sa croix et se laisser voir. On le rouvre donc d'abord, et
       la question se pose dans le cadre - là où sont les mots qu'on risque
       de perdre. Rien n'a été tapé : ça se ferme sans rien demander. */
    if(!FORM_SALE){ closeForm(); return; }
    rouvrirForm(()=> demandeFermerForm());
  };
  return p;
}

/* Le vol de la feuille vers la pastille, et le retour. On mesure les deux
   boîtes plutôt que de pousser la feuille dans une direction choisie à
   l'avance : elle atterrit alors exactement sur la pastille, et le
   mouvement dit où le formulaire est parti - ce qui est toute la raison de
   l'animer. Les trois nombres partent en variables CSS, les images-clés
   s'en servent (voir .form-sheet.part / .revient). */
function poseVolForm(feuille, p){
  const a = feuille.getBoundingClientRect(), b = p.getBoundingClientRect();
  if(!a.width || !b.width) return;
  feuille.style.setProperty('--dx', Math.round((b.left + b.width/2) - (a.left + a.width/2)) + 'px');
  feuille.style.setProperty('--dy', Math.round((b.top + b.height/2) - (a.top + a.height/2)) + 'px');
  /* Le rapport des largeurs, mais plafonne : une pastille et une feuille
     n'ont pas la meme forme - l'une est large et plate, l'autre haute - donc
     aucune echelle unique ne colle aux deux. Celle des largeurs vise juste
     sur grand ecran ; sur telephone la pastille prend toute la largeur et le
     rapport frolait 1, si bien que la feuille glissait sans retrecir et que
     le geste ne disait plus « ca se replie ». Le plafond de .55 lui rend son
     sens partout. */
  const ds = Math.min(0.55, Math.max(0.12, b.width / a.width));
  feuille.style.setProperty('--ds', ds.toFixed(3));
}

/* ---------- pourquoi la feuille garde sa classe ----------
   `.sheet` porte son animation d'entrée dans la feuille de style :
   `animation:rise .22s`. Toute classe qui écrase cette propriété - et
   `.part` comme `.revient` n'ont pas le choix, c'est par elle qu'on anime -
   devient donc la seule à valoir... jusqu'à ce qu'on la retire. À cet
   instant `animation` redevient `rise`, et changer de nom d'animation
   DÉMARRE l'animation : le formulaire rejouait son entrée - opacité zéro,
   quatorze pixels plus bas - après avoir fini de s'agrandir. C'était tout
   le clignotement, et il venait de la ligne de ménage qui semblait la plus
   innocente.

   Alors on ne nettoie pas. La feuille porte `.part` tant qu'elle est
   repliée et `.revient` tant qu'elle est ouverte, et l'on passe de l'une à
   l'autre - un nom d'animation remplacé par un autre, jamais rendu. Un
   formulaire fraîchement ouvert, lui, est un élément neuf sans aucune de
   ces classes : il joue `rise` comme toutes les autres fenêtres du site.

   `.part` tient son état d'arrivée (`forwards`), `.revient` non, et la
   feuille de style dit pourquoi : une animation finie qui tient son état
   l'emporte sur le style en ligne, et c'est par le style en ligne que le
   doigt pousse la feuille vers le bas pour la refermer. */
function reduireForm(){
  const host = $('form');
  const feuille = host.querySelector('.form-sheet');
  if(host.hidden || !feuille || FORM_ANIME) return;
  FORM_ANIME = true;
  formArmeRaz();       // une croix armée n'a plus de question en attente
  const p = pastilleMonte();
  poseVolForm(feuille, p);
  const vite = sansMouvement();
  if(!vite){
    feuille.classList.remove('revient');
    feuille.classList.add('part');
    host.classList.add('part');
  }
  setTimeout(()=>{
    host.hidden = true;
    /* Le voile, lui, peut rendre son animation : il est caché à cette
       seconde même, et le `fade` que ça relance ne se voit donc pas - c'est
       d'ailleurs celui qu'on veut à la réouverture. */
    host.classList.remove('part');
    verrouFond();                       // le journal redevient défilable
    p.classList.remove('mesure');
    if(!vite) p.classList.add('arrive');
    FORM_ANIME = false;
  }, vite ? 0 : FORM_REDUIT_MS);
}

/* `apres` : ce qu'on vient faire une fois le formulaire revenu - la croix de
   la pastille s'en sert pour poser sa question dans le cadre. */
function rouvrirForm(apres){
  const host = $('form');
  const feuille = host.querySelector('.form-sheet');
  const p = pastille();
  if(!feuille || FORM_ANIME) return;
  FORM_ANIME = true;
  const vite = sansMouvement();
  host.hidden = false;
  /* Au-dessus de ce qui s'est ouvert pendant qu'il attendait : on est allé
     lire la fiche d'un autre jeu, elle est peut-être encore là. C'est le
     même arbitrage que pour toutes les fenêtres qui s'ouvrent les unes sur
     les autres (voir auPremierPlan dans archive-noyau.js). */
  auPremierPlan(host);
  verrouFond();
  if(p){
    poseVolForm(feuille, p);
    p.classList.remove('arrive');
    if(vite) p.remove(); else { p.classList.add('repart'); setTimeout(()=> p.remove(), 200); }
  }
  if(!vite){
    /* L'une remplace l'autre dans le même souffle : `form-part` cède la
       place à `form-revient`, et c'est ce changement de nom qui démarre le
       retour. Pas de `void offsetWidth` à forcer ici - il servait à rejouer
       la MÊME animation, ce qui n'est pas le cas. Et surtout pas de retrait
       au bout : voir le commentaire de reduireForm. */
    feuille.classList.remove('part');
    feuille.classList.add('revient');
  }
  setTimeout(()=>{
    FORM_ANIME = false;
    if(typeof apres === 'function') apres();
  }, vite ? 0 : FORM_ROUVRE_MS);
}
const formEstReduit = ()=> !!pastille();

function lireForm(){
  // en cours ou wishlist : note, mois et temps de jeu partent vides, quoi
  // qu'il reste dans les champs cachés - la ligne du classeur doit dire la
  // même chose que l'écran. Le prix payé subit le même sort en wishlist.
  const sansFin = statutCoche();
  const wish = $('f_wish').checked;
  const v = {
    name:     clean($('f_name').value),
    rating:   sansFin ? null : toNum($('f_rating').value),
    month:    sansFin ? null : toNum($('f_month').value),
    hours:    sansFin ? null : toHours($('f_time').value),
    base:     toNum($('f_base').value),
    paid:     wish ? null : toNum($('f_paid').value),
  };
  /* Le marquage suit l'avis : un jeu remis « en cours » perd le sien (voir
     chargeUtile), il n'a donc plus rien à cacher. Envoyé à chaque fois, y
     compris à faux - c'est ainsi qu'on décoche. */
  v.spoiler = !statutCoche() && $('f_spoiler').checked;
  const rel = $('f_release');
  // si la date d'origine n'était pas lisible par le champ, on n'y touche pas
  if(rel.value || isoDate(rel.dataset.orig) || !rel.dataset.orig) v.release = rel.value || null;
  // absent si aucune fiche IGDB n'a été retenue cette fois : un jeu déjà
  // rattaché garde son rattachement, la clé n'est envoyée que pour en poser
  // un nouveau - c'est elle qui déclenche plateforme/développeur/genres
  // côté serveur (voir enrichit_igdb en Python).
  if(JEU_PICK && JEU_PICK.id) v.id_igdb = JEU_PICK.id;
  return v;   // ni support ni année : l'onglet suffit, et le Sheet garde ce qu'il a
}
/* Un onglet inexistant n'est plus un problème : il n'y a pas d'en-têtes à
   recopier, la période est un simple champ du jeu. Créer « En cours » revient
   à y ranger un premier jeu. */
function chargeUtile(){
  return {
    id: EDIT ? EDIT.id : null,          // null = ajout
    periode: cibleOnglet(),
    review: statutCoche() ? '' : clean($('f_review').value),
    values: lireForm(),
  };
}
async function submitForm(){
  const btn = $('f_ok'), texte = btn.textContent;
  razErreurs();
  const erreurs = validerFormulaire();
  if(erreurs.length){
    erreurs.forEach(er => champErr(er.champ, true));
    toast(erreurs[0].message, true);
    $(erreurs[0].champ).focus();
    return;
  }
  /* Un jeu du même nom existe déjà ailleurs dans le journal : bloqué une
     première fois - c'est l'ajout tapé deux fois par mégarde qu'on veut
     attraper - mais un second clic confirme que c'est voulu, pour ne pas
     empêcher un vrai replay. armé retombe si le nom change entre-temps
     (voir majDoublon), pour ne jamais confirmer le mauvais jeu. */
  const doublon = !EDIT && trouveDoublon($('f_name').value);
  if(doublon && !btn.classList.contains('armed')){
    champErr('f_name', true);
    btn.classList.add('armed');
    btn.textContent = 'Ajouter quand même ?';
    toast(`« ${doublon.name} » est déjà dans ton journal. Reclique pour l'ajouter quand même.`, true);
    setTimeout(()=>{
      if(btn.isConnected && btn.classList.contains('armed')){
        btn.classList.remove('armed'); btn.textContent = texte;
      }
    }, 5000);
    return;
  }
  const charge = chargeUtile();
  /* La jaquette retenue dans le formulaire, relevée avant l'envoi : closeForm()
     l'oublie, et le nom peut avoir été retouché depuis le choix - auquel cas
     elle ne vaut plus, on repart sur une recherche normale. */
  const retenue = (JEU_PICK && JEU_PICK.image
                   && norm(JEU_PICK.nom) === norm(charge.values.name)) ? JEU_PICK : null;
  btn.disabled = true; btn.textContent = 'Enregistrement...';
  try{
    const ajout = !charge.id;
    const data = ajout
      ? await envoyer('POST', '/api/journal/jeu', charge)
      : await envoyer('PUT', '/api/journal/jeu/' + charge.id, charge);
    cacheStore.set(source().url, data);
    applyData(data, true);
    // le jeu vient d'atterrir dans un autre onglet (En cours, une autre
    // année...) : on s'y place, sinon il disparaît sous les yeux
    if(S.bucket !== 'all' && S.bucket !== charge.periode && BUCKETS.indexOf(charge.periode) >= 0){
      S.bucket = charge.periode; S.range = null;
    }
    closeForm(); render();
    toast(ajout ? `« ${charge.values.name} » ajouté` : `« ${charge.values.name} » mis à jour`);
    /* Une jaquette désignée dans le formulaire l'emporte, même en
       modification : c'est un geste explicite, pas une récupération
       automatique. Sinon, et seulement à l'ajout, on cherche - modifier un
       jeu ne doit pas écraser une jaquette déposée à la main. */
    if(retenue) poseJaquetteChoisie(charge.values.name, retenue.image, charge.values.id_igdb);
    else if(ajout) jaquetteAuto(charge.values.name, charge.values.release, false, charge.values.id_igdb);
  }catch(e){
    toast(e.message, true);
    btn.disabled = false; btn.classList.remove('armed'); btn.textContent = texte;
  }
}
async function supprimerJeu(btn){
  if(!EDIT) return;
  const nom = EDIT.name, id = EDIT.id;
  btn.disabled = true; btn.textContent = 'Suppression...';
  try{
    const data = await envoyer('DELETE', '/api/journal/jeu/' + id);
    cacheStore.set(source().url, data);
    applyData(data, true); closeForm(); render();
    toast(`« ${nom} » retiré du journal`);
  }catch(e){
    toast(e.message, true);
    btn.disabled = false; btn.classList.remove('armed'); btn.textContent = 'Supprimer ce jeu';
  }
}
document.getElementById('addBtn').addEventListener('click', ()=> openForm(null));
