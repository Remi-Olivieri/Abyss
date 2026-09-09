/* =======================================================================
   Archive Jeux Vidéos - archive-formulaire.js

   Ajouter, modifier, supprimer un jeu.

   Le formulaire, le constructeur d'onglet (« 2019 », « Avant 2019 »,
   « Entre 2015 et 2019 »), la détection de doublon, la validation champ
   par champ, et les deux fonctions d'appel à l'API (api / apiPatient) dont
   se servent aussi les modules suivants.

   Chargé par templates/jeux-videos.html, dans l'ordre : ces fichiers
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
function timeText(h){
  if(h===null||h===undefined) return '';
  const H = Math.floor(h), M = Math.round((h-H)*60);
  return M ? `${H}h${String(M).padStart(2,'0')}` : `${H}h`;
}
function numText(n){ return (n===null||n===undefined||n==='') ? '' : String(n).replace('.',','); }

function formHTML(g){
  const mois = MONTHS.map((m,i)=>`<option value="${i+1}">${m}</option>`).join('');
  const avis = g ? g.review.join('\n') : '';
  return `<div class="sheet form-sheet" role="dialog" aria-modal="true">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">${g ? 'Modifier un jeu' : 'Ajouter un jeu'}</b></span>
      <span class="grp"><button class="sbtn form-x" aria-label="Fermer">×</button></span>
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
          <input id="f_time" type="text" value="${esc(timeText(g?g.hours:null))}"></label>
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
        <label class="fld full" id="f_reviewwrap"><u>Avis (Commencer par + ou -)</u>
          <span class="ta-wrap"><span class="ta-hl" id="f_review_hl" aria-hidden="true"></span
            ><textarea id="f_review" rows="5">${esc(avis)}</textarea></span></label>
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
    erreurs.push({champ:'f_rating', message:'Note illisible - un nombre entre 0 et 10, par exemple 8.5.'});
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
  host.querySelector('.form-x').onclick = closeForm;
  $('f_cancel').onclick = closeForm;
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
  $('f_name').focus();
}
function closeForm(){
  const host = $('form');
  if(host.hidden) return;
  // ce qui est encore en vol ne concerne plus personne : la liste, le prix
  // et la jaquette retenue partent avec le formulaire
  oublieAuto();
  host.hidden = true; host.innerHTML = '';
  EDIT = null;
  verrouFond();
}
fermeSurFond('form', closeForm);

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
