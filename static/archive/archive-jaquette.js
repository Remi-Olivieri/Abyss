/* =======================================================================
   Archive Jeux Vidéos - archive-jaquette.js

   Choisir une jaquette, et compléter un nom depuis IGDB.

   La fenêtre de choix d'image, et la liste déroulante du champ « Nom du
   jeu » : deux façons de désigner la même chose, une fiche IGDB précise,
   qui alignent ensuite la date de sortie et le prix sur elle.

   Chargé par templates/archive/archive.html, dans l'ordre : ces fichiers
   partagent une seule portée globale, comme quand ils n'en faisaient
   qu'un. L'ordre des balises <script> est donc l'ordre des dépendances.
   ======================================================================= */

/* =======================================================================
   Jaquette automatique - uniquement à l'ajout d'un jeu.
   C'est Flask qui va la chercher (jaquettes.py) : ni le navigateur ni
   Apps Script ne savent écrire dans static/Cover/. Rien n'atterrit sur le
   disque sans un clic : même quand une seule jaquette est trouvée, elle
   est montrée d'abord. Si la route n'existe pas - vieux serveur, page
   ouverte sans Flask - tout se tait et le jeu garde ses initiales.
   ======================================================================= */
/* Les trois aides HTTP - api(), raisonReseau() et apiPatient() - vivaient
   ici, parce que la jaquette a été la première à parler à Flask. Elles n'ont
   jamais rien eu de propre aux images, et deux autres pages les demandent
   maintenant : elles sont passées dans archive-noyau.js, qui est justement
   la boîte à outils que tout le monde charge. */
/* la jaquette est arrivée : on la remet en jeu sous un nouveau numéro */
function poseJaquette(cle){
  const f = cle;
  /* le manifeste est tenu à jour sur place : redemander la liste entière
     pour une seule image serait un aller-retour de plus pour rien. La date
     posée ici n'est pas exactement celle du fichier, mais elle ne sert qu'à
     casser le cache - le prochain manifeste rétablira la vraie. */
  if(f){
    if(!JAQUETTES) JAQUETTES = {};
    JAQUETTES[f] = Date.now();
    retientManifeste();
  }
  renderWall();
  // la fiche ouverte montre la même jaquette en grand : elle aussi
  if(!$('sheet').hidden && S.open !== null) paintSheet();
}
/* `idIgdb` est celui du JEU tel qu'il est enregistré, pas celui de la fiche
   qu'IGDB va proposer : c'est lui qui décide du nom du fichier, et la page
   ira le chercher sous ce nom-là. Les faire diverger reviendrait à écrire
   une image que personne ne redemande jamais. */
async function jaquetteAuto(nom, sortie, force, idIgdb){
  const cle = idIgdb ? String(idIgdb) : slug(nom);
  let data;
  try{ data = await api('/api/jaquette',
    {nom: nom, sortie: sortie || '', force: !!force, id_igdb: idIgdb || null}); }
  catch(e){ return; }
  if(data.etat === 'telechargee'){ poseJaquette(cle); toast('Jaquette récupérée'); }
  else if(data.etat === 'deja-la'){ poseJaquette(cle); }
  else if(data.etat === 'choix'){ openJaq(nom, data.propositions || [], null, idIgdb); }
  else if(data.etat === 'introuvable'){ toast(`Aucune jaquette trouvée pour « ${nom} »`); }
  // le motif exact plutôt qu'un « ça n'a pas marché » : HTTP 403, certificat
  // SSL, délai dépassé... c'est la seule chose qui permette d'y remédier
  else if(data.etat === 'injoignable'){ toast('IGDB injoignable : ' + (data.raison || 'pas de réponse'), true); }
}

/* On montre toujours ce qui a été trouvé, même une seule jaquette : c'est
   le clic qui télécharge. Les aperçus viennent directement d'IGDB, donc
   refuser ne laisse rien derrière - il n'y a rien à supprimer. Quand
   plusieurs fiches portent le même nom, la plus probable (celle dont
   l'année colle à la date de sortie) est en tête, en doré. */
let JAQ_NOM = null, JAQ_SUITE = null, JAQ_IGDB = null;
function jaqHTML(nom, propositions, retenir, opts){
  opts = opts || {};
  /* La barre de recherche n'apparaît que pour désigner un jeu : le titre
     du classeur ne trouve pas toujours la bonne fiche - « Getting Over It »
     ne ramène rien, « Getting Over It with Bennett Foddy » tombe dessus du
     premier coup - et sans moyen de reformuler, ces cas-là resteraient
     impossibles à corriger. */
  const barre = opts.terme === undefined ? '' : `
      <div class="jaq-chercher">
        <input type="text" id="jaqTerme" value="${esc(opts.terme)}"
               placeholder="Chercher un autre titre..." autocomplete="off" spellcheck="false">
        <button type="button" class="ghost" id="jaqChercher">Chercher</button>
      </div>`;
  return `<div class="sheet jaq-sheet" role="dialog" aria-modal="true">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">${opts.titre ? esc(opts.titre) : `Jaquette de « ${esc(nom)} »`}</b></span>
      <span class="grp"><button class="sbtn jaq-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="jaq-in">
      ${barre}
      <div class="jaq-grid">
        ${propositions.map((p,i)=>`
          <button class="jaq-item${p.suggere ? ' suggeree' : ''}" data-i="${i}" title="${esc(p.lien||'')}">
            <img src="${esc(p.apercu)}" alt="" loading="lazy" decoding="async">
            <b>${esc(p.titre)}</b>
            <span>${esc(p.date || 'date inconnue')}${p.nature ? ' · ' + esc(p.nature) : ''}</span>
          </button>`).join('')}
      </div>
      <div class="frow"><span class="spacer"></span>
        <button class="ghost jaq-non">${retenir ? 'Annuler' : "N'en télécharger aucune"}</button></div>
    </div>
  </div>`;
}
/* `suite` transforme la fenêtre en simple sélecteur : au lieu de télécharger,
   le clic rappelle cette fonction avec la fiche choisie. C'est ce que fait le
   formulaire, où le fichier ne peut pas encore être nommé - le nom du jeu
   n'est arrêté qu'à l'enregistrement. */
function openJaq(nom, propositions, suite, idIgdb, opts){
  opts = opts || {};
  if(!propositions.length && opts.terme === undefined) return;
  JAQ_NOM = nom;
  JAQ_IGDB = idIgdb || null;
  JAQ_SUITE = suite || null;
  const host = $('jaq');
  host.innerHTML = jaqHTML(nom, propositions, !!suite, opts);
  host.hidden = false;
  /* Devant ce qui est déjà ouvert : « Changer de jeu », dans la relecture de
     la mise à jour depuis IGDB, ouvrait cette fenêtre-ci sous celle qui
     venait de la demander (#jaq est à 75, #igdb à 76). Le bouton semblait ne
     rien faire, alors que la grille était bien là - derrière.
     Voir auPremierPlan dans archive-noyau.js. */
  auPremierPlan(host);
  verrouFond();
  host.querySelector('.jaq-x').onclick = closeJaq;
  host.querySelector('.jaq-non').onclick = closeJaq;
  host.querySelectorAll('.jaq-item').forEach(b=>{
    b.onclick = ()=> choisirJaq(b, propositions[+b.dataset.i]);
  });
  const champ = $('jaqTerme');
  if(champ && opts.surRecherche){
    const relance = ()=>{
      const t = clean(champ.value);
      if(t) opts.surRecherche(t);
    };
    $('jaqChercher').onclick = relance;
    champ.addEventListener('keydown', e=>{
      if(e.key !== 'Enter') return;
      // la fenêtre ne doit pas se refermer sur un Entrée de recherche
      e.preventDefault(); e.stopPropagation();
      relance();
    });
    champ.focus();
    champ.select();
  }
}
function closeJaq(){
  const host = $('jaq');
  if(host.hidden) return;
  host.hidden = true; host.innerHTML = '';
  JAQ_NOM = null; JAQ_SUITE = null; JAQ_IGDB = null;
  verrouFond();
}
async function choisirJaq(btn, choix){
  const nom = JAQ_NOM, idIgdb = JAQ_IGDB;
  // mode sélecteur : on rend la main au formulaire, rien ne part sur le disque
  if(JAQ_SUITE){
    const suite = JAQ_SUITE;
    closeJaq();
    suite(choix);
    return;
  }
  const host = $('jaq');
  host.querySelectorAll('.jaq-item').forEach(b=>{ b.disabled = true; });
  btn.classList.add('pris');
  let data;
  try{ data = await api('/api/jaquette/choisir',
    {nom: nom, image: choix.image, id_igdb: idIgdb || null}); }
  catch(e){ data = null; }
  if(data && data.etat === 'telechargee'){
    closeJaq(); poseJaquette(idIgdb ? String(idIgdb) : slug(nom)); toast('Jaquette enregistrée');
  }else{
    closeJaq();
    toast('Téléchargement impossible' + (data && data.raison ? ' - ' + data.raison : ''), true);
  }
}
fermeSurFond('jaq', closeJaq);

/* La jaquette désignée dans le formulaire : elle part sur le disque
   maintenant que le jeu existe et que son nom est arrêté. */
async function poseJaquetteChoisie(nom, image, idIgdb){
  let data;
  try{ data = await api('/api/jaquette/choisir',
    {nom: nom, image: image, id_igdb: idIgdb || null}); }
  catch(e){ return; }
  if(data.etat === 'telechargee'){
    poseJaquette(idIgdb ? String(idIgdb) : slug(nom)); toast('Jaquette enregistrée'); }
  else toast('Téléchargement impossible' + (data.raison ? ' - ' + data.raison : ''), true);
}

/* =======================================================================
   Complétion du nom depuis IGDB

   Le champ « Nom du jeu » interroge Flask pendant la frappe : IGDB renvoie
   les fiches qui collent, avec leur date de sortie et leur jaquette. Un clic
   remplit la date, va chercher le prix de base et retient la jaquette - qui
   ne part sur le disque qu'à l'enregistrement, pas avant, parce que son nom
   de fichier dépend d'un champ qu'on peut encore retoucher.

   Le prix ne vient pas d'IGDB, qui n'en publie aucun : IGDB donne le lien
   vers la fiche Steam, et c'est Steam qui répond son prix fort en euros. Un
   jeu absent de Steam - exclusivité Nintendo, PlayStation, jeu physique -
   laisse donc la case vide. C'est voulu : rien n'est deviné.

   Deux règles pour ne jamais écraser une saisie par accident : un champ
   rempli à la main ne bouge plus tant qu'on se contente de taper (data-auto
   le distingue d'un champ rempli par une fiche), et toute réponse arrivée
   après un changement de fiche est jetée - la frappe est plus rapide que le
   réseau, l'inverse serait une loterie. Désigner une fiche dans la liste,
   en revanche, aligne date et prix dessus quoi qu'il y ait dans les cases,
   et le dit - voir alignePick().
   ======================================================================= */
const AC = { minuteur:0, jeton:0, jetonPrix:0, jeux:[], i:-1 };
let JEU_PICK = null;   // la fiche IGDB retenue : {nom, titre, image, apercu...}

function oublieAuto(){
  clearTimeout(AC.minuteur);
  AC.jeton++; AC.jetonPrix++;      // ce qui répondra après nous ne sert plus
  AC.jeux = []; AC.i = -1;
  JEU_PICK = null;
}

/* ---------- la liste déroulante ---------- */
function acFerme(){
  const b = $('f_ac'), champ = $('f_name');
  AC.jeux = []; AC.i = -1;
  if(b){ b.hidden = true; b.innerHTML = ''; }
  if(champ) champ.setAttribute('aria-expanded', 'false');
}
/* acHTML - le dessin d'une ligne de résultat IGDB - est parti dans
   archive-recherche.js, qui s'en sert aussi pour sa liste : c'est le même
   service rendu, et il n'y a donc qu'un endroit à corriger le jour où IGDB
   changera la forme de ses réponses. Il vit toujours dans la même portée
   globale, acOuvre ci-dessous l'appelle sans rien savoir de son fichier. */
function acOuvre(jeux){
  const b = $('f_ac');
  if(!b) return;
  if(!jeux.length){ acFerme(); return; }
  AC.jeux = jeux; AC.i = -1;
  b.innerHTML = acHTML(jeux);
  b.hidden = false;
  $('f_name').setAttribute('aria-expanded', 'true');
  b.querySelectorAll('.ac-item').forEach(el=>{
    /* mousedown et pas click : sinon le champ perd le focus en premier, la
       liste se referme, et le clic atterrit dans le vide */
    el.addEventListener('mousedown', e=>{ e.preventDefault(); acChoisir(+el.dataset.i); });
  });
}
function acBouge(pas){
  const b = $('f_ac');
  if(!b || b.hidden || !AC.jeux.length) return;
  const n = AC.jeux.length;
  AC.i = AC.i < 0 ? (pas > 0 ? 0 : n - 1) : (AC.i + pas + n) % n;
  b.querySelectorAll('.ac-item').forEach((el,k)=>{
    const on = k === AC.i;
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    if(on) el.scrollIntoView({block:'nearest'});
  });
}
async function acCherche(texte){
  const jeton = ++AC.jeton;
  let data;
  // pas de Flask (page ouverte sans serveur, vieille version) : le champ
  // reste un champ, personne n'est prévenu de rien
  try{ data = await api('/api/jeu/suggestions', {nom: texte}); }
  catch(e){ return; }
  if(jeton !== AC.jeton || !$('f_ac')) return;   // une frappe est passée devant
  if(data.etat === 'ok') acOuvre(data.jeux || []);
  else acFerme();
}
function acFrappe(){
  const champ = $('f_name');
  const texte = clean(champ.value);
  // le nom ne correspond plus à la fiche choisie : sa jaquette non plus
  if(JEU_PICK && norm(texte) !== norm(JEU_PICK.nom)) posePick(null);
  clearTimeout(AC.minuteur);
  AC.jeton++;
  // deux lettres minimum, et un temps de répit : une recherche par caractère
  // ferait huit allers-retours pour « Hollow K »
  if(texte.length < 2){ acFerme(); return; }
  AC.minuteur = setTimeout(()=> acCherche(texte), 250);
}
function acTouche(e){
  const b = $('f_ac');
  const ouvert = b && !b.hidden && AC.jeux.length;
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    if(!ouvert) return;
    e.preventDefault(); acBouge(e.key === 'ArrowDown' ? 1 : -1);
  }else if(e.key === 'Enter'){
    if(!ouvert || AC.i < 0) return;
    e.preventDefault(); acChoisir(AC.i);
  }else if(e.key === 'Escape'){
    if(!ouvert) return;
    // la liste se referme, le formulaire reste ouvert : stopPropagation
    // empêche le gestionnaire global de prendre Échap pour lui
    e.preventDefault(); e.stopPropagation(); acFerme();
  }
}

/* ---------- la fiche retenue et son aperçu ---------- */
function posePick(fiche){
  JEU_PICK = fiche;
  const b = $('f_pick');
  if(!b) return;
  /* Rien à montrer tant qu'aucune fiche n'est retenue : la case reste
     vide. Un encart « Aucun jeu choisi » occupait la place pour ne rien
     dire - la liste sous le nom du jeu se charge déjà d'en proposer une,
     et la validation refuse un ajout sans fiche avec son propre message. */
  if(!fiche || !fiche.image){ b.hidden = true; return; }
  $('f_pickimg').src = fiche.apercu;
  $('f_pickt').textContent = fiche.titre;
  $('f_pickd').textContent = (fiche.date || 'date inconnue')
    + (fiche.nature ? ' · ' + fiche.nature : '');
  b.hidden = false;
}
/* Un champ rempli par une fiche peut être remplacé par la fiche suivante.
   Un champ rempli à la main, jamais : c'est ce que dit data-auto. `force`
   passe outre - voir alignePick().

   Renvoie true seulement si une valeur qui était là a été remplacée :
   remplir une case vide n'a rien qui mérite d'être annoncé, écraser une
   valeur qu'on avait sous les yeux, si. */
function acRemplit(champ, valeur, force){
  if(!champ || !valeur || champ.value === valeur) return false;
  if(champ.value && champ.dataset.auto !== '1' && !force) return false;
  const remplace = !!champ.value;
  champ.value = valeur;
  champ.dataset.auto = '1';
  return remplace;
}
function acChoisir(i){
  const j = AC.jeux[i];
  if(!j) return;
  acFerme();
  const champ = $('f_name');
  champ.value = j.titre;
  posePick(Object.assign({}, j, {nom: j.titre}));
  champ.focus();
  alignePick(j);           // la date et le prix suivent la fiche choisie
}
/* `force` : le prix est réécrit même s'il a été saisi à la main. Réservé au
   choix explicite d'une fiche - voir alignePick(). Renvoie true si un prix
   qui était déjà là a été remplacé, pour que l'appelant sache quoi annoncer ;
   une case vide qu'on remplit ne compte pas. */
async function acPrix(j, force){
  const cible = $('f_base');
  if(!cible || !j.id) return false;
  // un prix saisi ne s'écrase pas
  if(!force && cible.value && cible.dataset.auto !== '1') return false;
  const jeton = ++AC.jetonPrix;
  cible.classList.add('cherche');
  let data;
  try{ data = await api('/api/jeu/prix', {id: j.id}); }
  catch(e){ data = null; }
  // une autre fiche a été choisie depuis, ou le formulaire s'est fermé
  if(jeton !== AC.jetonPrix || $('f_base') !== cible) return false;
  cible.classList.remove('cherche');
  if(data && data.etat === 'ok' && data.prix !== null && data.prix !== undefined){
    const txt = numText(data.prix);
    // remplacer un prix qu'on avait sous les yeux se dit ; remplir une case
    // vide, non - même règle que acRemplit()
    const remplace = cible.value !== '' && cible.value !== txt;
    cible.value = txt;
    cible.dataset.auto = '1';

    /* Le prix payé, proposé au moment où l'achat a lieu : à l'ajout d'un
       jeu, ou quand on sort de la wishlist un jeu qu'on vient d'acheter.
       Jamais sur un vieux jeu qu'on retouche - ce que Steam demande
       aujourd'hui n'a rien à voir avec ce qu'on a déboursé il y a trois
       ans, et une somme fausse est pire qu'une case vide.

       C'est « actuel » et non « prix » : promotion comprise, c'est ce
       qu'on paie réellement. Et posé par acRemplit(), donc jamais en
       force, même quand on vient de choisir une jaquette explicitement -
       un montant saisi à la main ne se devine pas. */
    if((!EDIT || estWishlist(EDIT)) && data.actuel !== null && data.actuel !== undefined){
      acRemplit($('f_paid'), numText(data.actuel));
    }
    return remplace;
  }
  // « inconnu » n'est pas une erreur : le jeu n'est pas sur Steam, la case
  // reste vide et se remplit à la main. Pas de toast pour si peu.
  return false;
}

/* Aligner la date et le prix sur la fiche qu'on vient de désigner - celle
   d'une jaquette choisie, ou celle prise dans la liste sous le nom du jeu.
   Les deux gestes disent la même chose : « c'est ce jeu-là », et depuis le
   même écran. Deux règles :

     - on écrase même une valeur saisie à la main. Désigner une fiche précise
       est un geste délibéré, et surtout, en modification, les champs
       viennent de la base : aucun ne porte data-auto, donc la règle
       habituelle ne laisserait jamais rien changer. C'est ce qui faisait
       qu'un jeu rattaché à la mauvaise fiche gardait sa vieille date de
       sortie - on choisissait bien 2016 dans la liste, la fiche repartait
       avec plateforme, développeur et genres du bon jeu, mais la date de
       2023 restait.
     - une valeur absente chez IGDB ne vide rien. Un jeu hors Steam n'a pas
       de prix à donner : ce n'est pas une raison pour effacer le tien.

   Le toast est là parce qu'on vient d'écraser une valeur : il faut la voir
   partir. Une case vide qu'on remplit ne le déclenche pas - à l'ajout d'un
   jeu, tout se remplit, il n'y a rien à signaler. */
async function alignePick(p){
  const change = [];
  if(acRemplit($('f_release'), p.iso, true)) change.push('date');
  if(await acPrix(p, true)) change.push('prix');
  if(!change.length) return;
}

/* ---------- changer la jaquette retenue ---------- */
async function changerPick(){
  const nom = clean($('f_name').value);
  if(!nom) return;
  const b = $('f_pick');
  b.classList.add('busy');
  let data;
  // force : le fichier existe peut-être déjà, on veut quand même la liste
  try{ data = await api('/api/jaquette', {nom: nom, sortie: $('f_release').value || '', force: true}); }
  catch(e){ data = null; }
  b.classList.remove('busy');
  if(!data) return;
  if(data.etat === 'choix'){
    openJaq(nom, data.propositions || [], p=>{
      /* la fiche choisie remplace l'ancienne en entier, id et date compris :
         « Resident Evil 4 » de 2005 et celui de 2023 ne partagent que le
         titre, et c'est justement la jaquette qui les distingue */
      posePick({nom: nom, titre: p.titre, date: p.date, nature: p.nature,
                image: p.image, apercu: p.apercu, iso: p.iso,
                id: p.id, lien: p.lien});
      alignePick(p);
    });
  }
  else if(data.etat === 'introuvable'){ toast(`Aucune jaquette trouvée pour « ${nom} »`); }
  else if(data.etat === 'injoignable'){ toast('IGDB injoignable : ' + (data.raison || 'pas de réponse'), true); }
}

function brancherAuto(){
  const champ = $('f_name');
  if(!champ) return;
  champ.addEventListener('input', acFrappe);
  champ.addEventListener('keydown', acTouche);
  champ.addEventListener('blur', ()=> setTimeout(acFerme, 0));
  const pick = $('f_pick');
  if(pick) pick.onclick = changerPick;
  // une valeur retapée à la main n'est plus « remplie automatiquement » :
  // la fiche suivante ne doit pas passer par-dessus. f_release n'y est pas :
  // lui n'accepte plus la frappe (readonly), donc data-auto ne s'y efface
  // jamais autrement qu'en choisissant une autre fiche.
  ['f_base'].forEach(id=>{
    const ch = $(id);
    if(ch) ch.addEventListener('input', ()=>{ ch.dataset.auto = ''; });
  });
}
