/* =======================================================================
   Archive Jeux Vidéos - archive-recherche.js

   La recherche : un journal, ou un jeu.

   Deux choses à chercher et une seule barre. Le choix se fait dedans, à
   côté de ce qu'on tape, et non entre deux boutons : il fallait sinon
   trancher avant de savoir ce qu'on trouverait derrière l'un ou l'autre.
   Un journal se cherche parmi ceux d'ici, déjà chargés ; un jeu se cherche
   chez IGDB, donc à chaque frappe et avec un délai.

   Chargé par DEUX pages, et c'est pour ça qu'il est à part :

     - templates/archive/archive.html, où la fenêtre s'ouvre depuis l'adresse
       (?recherche=1) et se déplie à même l'écran d'accueil ;
     - templates/archive/feed.html, où c'est la pastille de l'en-tête qui
       l'ouvre, à la place qu'occupe « Social » sur le journal.

   Ce qui change d'une page à l'autre n'est pas la fenêtre, c'est ce qu'un
   résultat DÉCLENCHE : sur le journal, choisir quelqu'un change de classeur
   sans quitter la page ; sur le Social, ça mène à l'adresse de son journal.
   Les deux gestes arrivent en paramètre (voir monteRecherche), le reste est
   identique au pixel près - et doit le rester.

   Ne dépend que de archive-noyau.js : SOURCES, esc, norm, clean, initials,
   api, raisonReseau, verrouFond, fermeSurFond.
   ======================================================================= */

/* Le dessin d'une ligne de résultat IGDB. Il vivait dans
   archive-jaquette.js, qui s'en sert pour la liste déroulante du champ
   « Nom du jeu » : même service rendu, même dessin, une seule fonction à
   corriger le jour où IGDB changera la forme de ses réponses. */
function acHTML(jeux){
  return jeux.map((j,i)=>`
    <button type="button" class="ac-item" role="option" aria-selected="false" data-i="${i}">
      ${j.apercu
        ? `<img src="${esc(j.apercu)}" alt="" loading="lazy" decoding="async">`
        : '<span class="ac-vide"></span>'}
      <span class="ac-txt">
        <b>${esc(j.titre)}</b>
        <i>${esc(j.date || 'date inconnue')}${j.nature ? ' · ' + esc(j.nature) : ''}</i>
      </span>
    </button>`).join('');
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

   Elle se monte où on le lui demande - dans sa fenêtre quand on clique sur
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

/* `hote` : l'élément où la recherche se dessine.
   `opts` : ce qu'un résultat déclenche, et rien d'autre.

     surJournal(i)      le rang dans SOURCES du journal choisi
     surJeu(id, titre)  la fiche IGDB choisie
     actif()            le rang du journal déjà affiché, pour la coche -
                        -1 quand aucun ne l'est, ce qui est le cas partout
                        sauf sur le journal lui-même

   Sans `opts`, les trois valent ce que fait la page du journal : c'est
   elle qui monte la recherche à deux endroits, et lui faire répéter ses
   propres réglages n'aurait rien appris à personne. */
function monteRecherche(hote, opts){
  const o = opts || {};
  const surJournal = o.surJournal || (i => choisirClasseur(i));
  const surJeu     = o.surJeu     || ((id, titre) => ouvrirDetailIgdb(id, titre));
  const actif      = o.actif      || (() => (typeof SRC === 'number' ? SRC : -1));
  hote.innerHTML = `
    <!-- deux bascules, et non des onglets : un onglet doit désigner le
         panneau qu'il ouvre, et il n'y en a pas - c'est la même liste qui
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
    const ici = actif();
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
      return `<button class="rsearch-item${i===ici?' on':''}${
          s.banniere ? ' rsearch-orne' : ''}" data-i="${i}">
        ${avatar}
        <span class="rsearch-meta"><b>${esc(s.nom || '?')}</b><i>${esc(sous)}</i></span>
        ${i===ici?'<span class="tick">✓</span>':''}
      </button>`;
    }).join('');
    liste.querySelectorAll('.rsearch-item').forEach(b=>{
      b.onclick = ()=> surJournal(+b.dataset.i);
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
      el.onclick = ()=> surJeu(trouves[i].id, trouves[i].titre);
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
/* Les options de la fenêtre, posées une fois par la page qui la charge.
   ouvrirRecherche() est appelée de six endroits - un bouton, une adresse,
   une touche - et aucun n'a de raison de connaître ce que fait un clic sur
   un résultat. La page le dit une fois, ici. */
let RECHERCHE_OPTS = null;
function regleRecherche(opts){ RECHERCHE_OPTS = opts; }

function ouvrirRecherche(){
  /* Les deux premiers n'existent que sur la page du journal : elle a un menu
     d'engrenage et un sélecteur de période à refermer, le Social n'a ni
     l'un ni l'autre. La cloche, elle, est sur les deux pages - mais pas
     avant qu'on soit connecté. */
  if(typeof closeMenu === 'function') closeMenu();
  if(typeof closePer === 'function') closePer();
  if(typeof socialClocheFerme === 'function') socialClocheFerme();
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
  RECHERCHE = monteRecherche(host.querySelector('.rsearch-in'), RECHERCHE_OPTS);
  RECHERCHE.champ.focus();
}
fermeSurFond('recherche', fermerRecherche);
/* Le bouton de l'en-tête, quand la page en a un. Sur le journal, cette
   place est prise par « Social » et la fenêtre s'ouvre depuis l'adresse
   (?recherche=1) ; sur le Social, c'est ce bouton-ci qui l'ouvre.

   preventDefault, mais le lien porte quand même une adresse de repli vers
   /archive?recherche=1 : sans script, le bouton fait tout de même quelque
   chose plutôt que rien. */
const jnlSearchBtn = document.getElementById('jnlSearchBtn');
if(jnlSearchBtn){
  jnlSearchBtn.addEventListener('click', e=>{
    e.preventDefault(); e.stopPropagation(); ouvrirRecherche();
  });
}
