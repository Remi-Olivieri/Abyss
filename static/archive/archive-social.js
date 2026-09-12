/* =======================================================================
   Archive Jeux Vidéos - archive-social.js

   Le fil, les j'aime, les commentaires, la cloche, et la page « Avis ».

   Chargé par DEUX pages, et c'est tout l'intérêt :

     - templates/archive/feed.html, la page Social, qui n'est presque que ça ;
     - templates/archive/archive.html, où la fiche d'un jeu ouvre les avis des
       autres et retombe exactement sur la même fenêtre de discussion.

   Un fil ouvert depuis le mur et un fil ouvert depuis le Social doivent se
   ressembler au pixel près : c'est la même chose. D'où un seul fichier
   plutôt qu'un par page.

   Il ne dépend que de archive-noyau.js - esc, coverURL, cleJaquette,
   initials, noteColor, hoursFmt, MONTHS, verrouFond, fermeSurFond - qui est
   justement écrit pour se lire seul. Rien d'autre du journal n'est requis :
   la page Social n'a ni classeur, ni mur, ni formulaire.
   ======================================================================= */


/* ---------- parler au serveur ----------
   Le `api()` de archive-jaquette.js ne fait que du POST sans cookie, et
   `envoyer()` de archive-journal.js exige le mode éditeur : ni l'un ni
   l'autre ne convient ici, et aucun des deux n'existe sur la page Social.
   Celui-ci porte le cookie de session - tout le social est nominatif - et
   rapporte le message du serveur tel quel : « Connecte-toi pour
   participer » se lit mieux qu'un code HTTP. */
async function socialAppel(chemin, methode, charge){
  const opts = {method: methode || 'GET', credentials: 'same-origin'};
  if(charge !== undefined){
    // application/json : un formulaire posté depuis un autre site ne peut
    // pas produire ce type sans pré-vol CORS. C'est la parade CSRF, la
    // même que pour le reste des écritures du site.
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

/* Le bandeau d'information. La page du journal en a un (archive-formulaire.js) ;
   la page Social pose le sien au même endroit. On prend celui qui est là. */
function socialMot(txt, mauvais){
  if(typeof toast === 'function'){ toast(txt, mauvais); return; }
  console.log(txt);
}

/* ---------- ce que la carte affiche ---------- */

/* « septembre 2026 », « 2026 », « Avant 2011 ».

   La carte dit QUAND LE JEU A ÉTÉ TERMINÉ, et non depuis combien de temps
   la ligne existe. « Il y a 2 jours » ne parlait que de la saisie : deux
   personnes qui finissent le même jeu la même semaine et le notent à un
   mois d'écart racontent pourtant la même chose. Le mois de fin, lui, est
   ce qu'on a joué. */
function socialQuand(p){
  if(p.mois && p.annee) return `${MONTHS[p.mois - 1]} ${p.annee}`;
  if(p.annee) return String(p.annee);
  // ni mois ni année : reste l'onglet, qui est parfois « Avant 2011 » -
  // une date approximative vaut mieux qu'un blanc
  return p.periode || '';
}

/* La ligne sous le pseudo : quand, et en combien de temps. Le temps de jeu
   n'est pas toujours noté, et un « - h de jeu » ne dirait rien. */
function socialSous(p){
  const bouts = [socialQuand(p)];
  if(p.heures !== null && p.heures !== undefined) bouts.push(hoursFmt(p.heures) + ' de jeu');
  return bouts.filter(Boolean).join(' · ');
}

/* L'avatar, ou les initiales à défaut. Même repli que partout ailleurs sur
   le site : un compte sans photo n'est pas un trou dans la page. */
function socialAvatar(pseudo, url, taille){
  const cls = 'soc-ava' + (taille ? ' ' + taille : '');
  if(url) return `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" decoding="async">`;
  return `<span class="${cls} soc-ava-vide">${esc(initials(pseudo || '?'))}</span>`;
}

/* ---------- aller chez quelqu'un ----------
   La photo et le pseudo mènent au journal de la personne. C'est le geste
   qu'on fait partout ailleurs, et sur une page qui montre ce que les autres
   ont fini, « c'est qui ? » est la question d'après - elle ne doit pas
   demander de repasser par la recherche.

   De vrais liens, et pas des écoutes de clic : on peut les ouvrir dans un
   nouvel onglet, les copier, et le navigateur montre l'adresse au survol.
   C'est aussi ce qui permet aux cartes de rester cliquables d'un bout à
   l'autre - les gestionnaires laissent simplement passer ce qui vise un
   <a> (voir socialVersProfil). */
function socialProfil(pseudo){
  return '/archive/' + encodeURIComponent(pseudo || '');
}
function socialAvatarLien(pseudo, url, taille){
  return `<a class="soc-perso soc-perso-ava" href="${socialProfil(pseudo)}"
    aria-label="Journal de ${esc(pseudo)}">${socialAvatar(pseudo, url, taille)}</a>`;
}
function socialNomLien(pseudo){
  return `<a class="soc-perso" href="${socialProfil(pseudo)}"><b>${esc(pseudo)}</b></a>`;
}
/* Un clic qui vise un lien s'en va chez quelqu'un : la carte qui l'entoure
   ne doit pas ouvrir sa discussion par-dessus. Une seule question posée au
   même endroit par les trois listes qui empilent des cartes. */
function socialVersProfil(e){ return !!e.target.closest('a'); }

/* La jaquette, reconstruite comme partout : la clé vient de l'identifiant
   IGDB quand il existe, du titre sinon, et le manifeste dit ce qui est
   réellement sur le disque. Rien à demander au serveur pour ça. */
function socialCover(p){
  const url = coverURL(cleJaquette({idIgdb: p.idIgdb, name: p.nom}));
  if(url) return `<img class="soc-cov" src="${esc(url)}" alt="" loading="lazy" decoding="async">`;
  return `<span class="soc-cov soc-cov-vide" style="--c:${noteColor(p.note)}"
    >${esc(initials(p.nom))}</span>`;
}

/* L'avis tel qu'il est écrit dans le journal : les « + » puis les « − ».
   Exactement le balisage de la fiche (.pros / .pt), et volontairement : un
   avis doit se lire pareil qu'on soit sur le mur ou dans le fil.

   `court` réduit la carte du fil à ses premiers points - un avis de vingt
   lignes ferait défiler trois écrans pour une seule carte. Le fil ouvert,
   lui, les montre tous. */
const SOC_POINTS_COURT = 4;
function socialAvisHTML(p, court){
  const lignes = (p && p.avis) || [];
  if(!lignes.length) return '';
  const garde = court ? lignes.slice(0, SOC_POINTS_COURT) : lignes;
  const reste = lignes.length - garde.length;
  const pt = t => {
    const cls = t.startsWith('+') ? 'plus' : (t.startsWith('-') ? 'minus' : '');
    const texte = cls ? t.slice(1).trim() : t.trim();
    return `<span class="pt ${cls}">${esc(texte)}</span>`;
  };
  const bloc = `<div class="pros">${garde.map(pt).join('')}${
    reste > 0 ? `<span class="pt soc-reste">+${reste} autre${reste > 1 ? 's' : ''}</span>` : ''}</div>`;
  /* La carte entière plutôt que l'avis seul : c'est le serveur qui a décidé
     (voir censeur dans social.py), la page ne fait que poser le voile. Le
     « +3 autres » du fil part flou avec le reste - il compte des lignes
     qu'on ne montre pas, mais il dit combien il y en a, et c'est déjà
     quelque chose qu'on n'a pas demandé à savoir. */
  return (p && p.flou) ? spoilerHTML(bloc) : bloc;
}

/* ---------- une carte ----------
   `court` : la carte du fil, qui tronque l'avis et se clique en entier vers
   sa discussion. Sans lui, la carte de tête d'une discussion : elle montre
   l'avis en entier, et sa jaquette comme son titre ouvrent la fiche du jeu
   - description, captures, bande-annonce, temps pour finir.

   La jaquette et le titre, eux, ouvrent la fiche du jeu dans les deux cas.
   Deux destinations dans un même rectangle, donc, mais elles ne se
   disputent rien : celle du jeu est portée par deux éléments précis, tout
   le reste de la carte reste à la discussion. C'est le partage qu'on trouve
   partout - le titre mène au sujet, la carte mène au fil.

   `sansJeu` retire la jaquette ET le titre, et ne sert qu'à un endroit : la
   fenêtre « Avis », où toutes les cartes SONT le même jeu - c'est ce qu'elle
   rassemble, et son en-tête le montre une fois pour toutes. Les répéter à
   chaque personne, c'était écrire dix fois la même jaquette et le même titre
   dans une colonne de dix avis : soixante pixels de large et deux lignes de
   haut pris à chaque carte pour redire ce qu'on savait en arrivant, et les
   avis - la seule chose qui change d'une carte à l'autre - repoussés dans
   ce qui restait.

   Ils n'y menaient déjà nulle part, d'ailleurs : la jaquette rouvrait la
   fiche du jeu où l'on était déjà, ce qui faisait tourner en rond :

     Plus d'informations -> Avis des joueurs -> clic sur la jaquette
       -> Plus d'informations du même jeu -> Avis des joueurs -> ...

   à chaque tour une fenêtre de plus par-dessus la précédente, un z-index de
   plus, et une requête IGDB + HowLongToBeat relancée pour réafficher la
   fiche qu'on venait de quitter. Le garde-fou n'est pas dans l'empilement :
   c'est le lien lui-même qui n'avait rien à proposer, et maintenant plus
   rien à occuper.

   « a terminé un jeu » tombe avec eux, et pour la même raison : sous un
   en-tête qui nomme le jeu, la phrase ne dit plus rien qu'on ignore. Reste
   ce qui distingue vraiment une carte de sa voisine - qui, quand, en
   combien d'heures, avec quelle note, et ce qu'il en a écrit. */
function socialCarteHTML(p, court, sansJeu){
  const aime = p.aime === true;
  /* Le nom et l'identifiant IGDB voyagent sur la carte : c'est par eux que
     la jaquette et le titre ouvrent la fiche du jeu, et les trois listes qui
     empilent des cartes n'ont alors rien d'autre à retenir que du HTML. */
  return `<article class="soc-post${court ? ' soc-cliquable' : ''}${
      sansJeu ? ' soc-post-nu' : ''}" data-id="${p.id}"
    data-jeu="${esc(p.nom)}" data-igdb="${p.idIgdb || ''}">
    <header class="soc-tete">
      ${socialAvatarLien(p.pseudo, p.avatar)}
      <span class="soc-qui">
        ${socialNomLien(p.pseudo)}${sansJeu ? '' : '<i>a terminé un jeu</i>'}
        <u>${esc(socialSous(p))}</u>
      </span>
      ${p.note === null || p.note === undefined ? '' :
        `<span class="soc-note" style="color:${noteColor(p.note)}">${fr(p.note, 1)}</span>`}
    </header>
    <div class="soc-corps">
      ${sansJeu ? ''
        : `<button type="button" class="soc-vers-jeu" data-act="jeu">${socialCover(p)}</button>`}
      <div class="soc-texte">
        ${sansJeu ? ''
          : `<button type="button" class="soc-jeu soc-vers-jeu" data-act="jeu"
              >${esc(p.nom)}</button>`}
        ${socialAvisHTML(p, court)
          || `<p class="soc-muet">Pas d'avis écrit${sansJeu ? '' : ' pour ce jeu'}.</p>`}
      </div>
    </div>
    <footer class="soc-pied">
      <button type="button" class="soc-act soc-aime${aime ? ' on' : ''}"
        data-act="jaime" aria-pressed="${aime ? 'true' : 'false'}"
        aria-label="J'aime">${SOC_COEUR}<span>${p.jaime || 0}</span></button>
      ${court
        ? `<button type="button" class="soc-act" data-act="fil">${SOC_BULLE}<span>${
            p.commentaires ? `${p.commentaires} réponse${p.commentaires > 1 ? 's' : ''}`
                           : 'Commenter'}</span></button>`
        /* Dans la discussion ouverte, le compte n'est plus un bouton : il n'y
           a nulle part où aller, on y est. Un bouton qui ne fait rien se
           clique quand même, deux fois, avant qu'on renonce. */
        /* data-act="fil" quand même : c'est par là que socialAccordeFil
           retrouve le compteur pour le corriger après un envoi. Rien ne
           l'écoute dans la fenêtre d'une discussion. */
        : `<span class="soc-act soc-compteur" data-act="fil">${SOC_BULLE}<span>${
            p.commentaires ? `${p.commentaires} réponse${p.commentaires > 1 ? 's' : ''}`
                           : 'Aucune réponse'}</span></span>`}
    </footer>
  </article>`;
}

const SOC_COEUR = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M20.8 6.6a5 5 0 0 0-7.1 0L12 8.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 22l8.8-8.3a5 5 0 0 0 0-7.1z"/></svg>`;
const SOC_BULLE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>`;

/* ---------- aimer ----------
   Le compteur bouge tout de suite et la requête part derrière. Un cœur qui
   attend l'aller-retour du serveur pour se remplir donne l'impression que
   le clic n'a pas pris, et on reclique - donc on retire ce qu'on venait de
   mettre. En cas d'échec on remet exactement ce qui était affiché.

   Le serveur renvoie le compte qu'il a réellement en base : c'est lui qui
   fait foi à l'arrivée, pas notre pari. */
async function socialAimer(bouton){
  const carte = bouton.closest('.soc-post');
  const id = carte && carte.dataset.id;
  if(!id) return;
  const compteur = bouton.querySelector('span');
  const avant = {on: bouton.classList.contains('on'), n: compteur.textContent};
  const n = parseInt(avant.n, 10) || 0;
  bouton.classList.toggle('on', !avant.on);
  bouton.setAttribute('aria-pressed', avant.on ? 'false' : 'true');
  compteur.textContent = String(Math.max(0, n + (avant.on ? -1 : 1)));
  try{
    const data = await socialAppel(`/api/social/jeu/${id}/jaime`, 'POST', {});
    bouton.classList.toggle('on', !!data.aime);
    bouton.setAttribute('aria-pressed', data.aime ? 'true' : 'false');
    compteur.textContent = String(data.jaime);
    /* Toutes les copies de cette carte à l'écran, pas seulement celle qu'on
       vient de cliquer : le même jeu peut être dans le fil ET dans la
       fenêtre ouverte par-dessus. */
    socialAccorde(id, data);
  }catch(e){
    bouton.classList.toggle('on', avant.on);
    bouton.setAttribute('aria-pressed', avant.on ? 'true' : 'false');
    compteur.textContent = avant.n;
    socialMot(e.message || 'Impossible pour le moment', true);
  }
}

/* Le même jeu peut être affiché plusieurs fois : dans le fil, et dans la
   fenêtre ouverte par-dessus. Un compteur mis à jour d'un côté seulement
   laisserait deux chiffres différents pour une même chose. */
function socialAccorde(id, data){
  document.querySelectorAll(`.soc-post[data-id="${id}"] .soc-aime`).forEach(b=>{
    b.classList.toggle('on', !!data.aime);
    b.setAttribute('aria-pressed', data.aime ? 'true' : 'false');
    const s = b.querySelector('span');
    if(s) s.textContent = String(data.jaime);
  });
}
/* Le compteur de réponses, partout où ce jeu est affiché. Deux formulations
   selon l'endroit : une carte du fil invite à commenter, la discussion
   ouverte constate - on y est déjà, il n'y a rien à proposer. */
function socialAccordeFil(id, n){
  document.querySelectorAll(`.soc-post[data-id="${id}"] [data-act="fil"]`)
    .forEach(b=>{
      const s = b.querySelector('span');
      if(!s) return;
      s.textContent = n ? `${n} réponse${n > 1 ? 's' : ''}`
                        : (b.classList.contains('soc-compteur') ? 'Aucune réponse' : 'Commenter');
    });
}

/* La fiche IGDB d'un jeu - description, captures, bande-annonce, temps pour
   finir. C'est la même fenêtre que « Voir plus d'informations » sur le mur
   et que la recherche d'un jeu : ouvrirDetailIgdb vit dans
   archive-export.js, chargé par les deux pages.

   Sans identifiant IGDB, le nom suffit : le serveur ne rendra pas la fiche
   d'IGDB, mais HowLongToBeat cherche par titre et répondra quand même les
   temps pour finir. */
function ouvrirFicheJeu(p){
  if(!p) return;
  ouvrirDetailIgdb(p.idIgdb || null, p.nom);
}
/* La même chose depuis un clic : la carte porte le nom et l'identifiant, il
   n'y a rien à retrouver ailleurs. Renvoie true quand elle a agi, pour que
   l'appelant sache qu'il n'a plus rien à faire de ce clic - la même forme
   que socialVersProfil juste au-dessus. */
function socialVersJeu(e){
  if(!e.target.closest('[data-act="jeu"]')) return false;
  const carte = e.target.closest('.soc-post');
  if(carte) ouvrirFicheJeu({nom: carte.dataset.jeu, idIgdb: carte.dataset.igdb || null});
  return true;
}

/* ---------- la fenêtre d'une discussion ----------
   Une seule à l'écran, posée sur le <body> : la page Social et celle du
   journal n'ont pas le même balisage, et une fenêtre qui se crée elle-même
   n'oblige ni l'une ni l'autre à lui réserver une place. */
function socialHote(id){
  let h = document.getElementById(id);
  if(!h){
    h = document.createElement('div');
    h.id = id;
    h.className = 'sheet-back';
    h.hidden = true;
    document.body.appendChild(h);
    fermeSurFond(id, ()=> socialFerme(id));
  }
  return h;
}
function socialFerme(id){
  const h = document.getElementById(id);
  if(!h || h.hidden) return;
  h.hidden = true; h.innerHTML = '';
  verrouFond();
}
function socialFermeTout(){ socialFerme('socFil'); socialFerme('socAvis'); }

/* Un seul bouton pour sortir, et c'est la croix. Il y avait une flèche
   « retour » à gauche du titre quand la fenêtre s'ouvrait par-dessus une
   autre : elle refermait celle-ci pour découvrir celle-là, ce qui est
   exactement, au geste près, ce que fait la croix - la fenêtre du dessous
   n'est jamais fermée, elle attend derrière. Deux boutons pour une seule
   sortie, à quelques pixels l'un de l'autre, font hésiter sur ce qui les
   sépare au lieu d'aider à en sortir. */
function socialCadre(id, titre, corps){
  const h = socialHote(id);
  h.innerHTML = `<div class="sheet soc-sheet" role="dialog" aria-modal="true"
      aria-label="${esc(titre)}">
    <div class="sheet-tools">
      <span class="grp"><b class="fhead">${esc(titre)}</b></span>
      <span class="grp"><button class="sbtn soc-x" aria-label="Fermer">×</button></span>
    </div>
    <div class="soc-in">${corps}</div>
  </div>`;
  h.hidden = false;
  auPremierPlan(h);         // la fiche d'un jeu a pu l'ouvrir, et elle est haute
  verrouFond();
  h.querySelector('.soc-x').onclick = ()=> socialFerme(id);
  return h;
}

/* Ce que CETTE personne a fait du jeu dont on parle, juste après son pseudo :
   « Jokrem - 8,9 », « Cremy - Non noté », « Ange - Pas joué ».

   C'est ce qui manquait à une réponse : « bof » et « bof » ne veulent pas
   dire la même chose sous la plume de quelqu'un qui a mis 8,5 et de
   quelqu'un qui a mis 4 - ni sous celle de quelqu'un qui n'y a jamais joué,
   ce qu'une case vide laissait deviner de travers. Les trois cas s'écrivent
   donc, et se lisent d'un coup d'œil.

   Le silence en garde un quatrième : `sonJeu` vaut `null` quand le journal
   de la personne est privé ou n'existe pas. On n'écrit alors rien - deviner
   « pas joué » d'une page fermée reviendrait à affirmer ce qu'on n'a pas le
   droit de lire. Voir _etats_des_auteurs dans social.py.

   Seule la note prend une couleur. « Non noté » et « Pas joué » sont des
   constats, pas des jugements : les peindre en vert ou en rouge leur
   donnerait un sens qu'ils n'ont pas. */
function socialNoteMsgHTML(sonJeu){
  if(!sonJeu) return '';
  const tiret = '<i class="soc-msg-tiret" aria-hidden="true">-</i>';
  if(!sonJeu.joue){
    return `${tiret}<span class="soc-msg-etat">Pas joué</span>`;
  }
  if(sonJeu.note === null || sonJeu.note === undefined){
    return `${tiret}<span class="soc-msg-etat">Non noté</span>`;
  }
  return `${tiret}<span class="soc-msg-note" style="color:${noteColor(sonJeu.note)}"
    title="Sa note pour ce jeu">${fr(sonJeu.note, 1)}</span>`;
}

/* Un message. Le même dessin qu'on soit un commentaire de tête ou une
   réponse - c'est la même chose écrite par la même personne, seule sa place
   dans le fil change. `reponse` ne retire qu'un bouton : on ne répond pas à
   une réponse (voir _parent_ou_refus dans social.py), un fil qui s'indente
   à l'infini ne se lit plus.

   Les quatre actions du pied ne sont pas les mêmes pour tout le monde : le
   cœur pour tous, « Répondre » sous une tête, « Modifier » sur ses propres
   mots seulement, « Supprimer » pour leur auteur et pour le propriétaire du
   journal. Un bouton qu'on affiche pour le refuser ensuite fait cliquer pour
   rien.

   Les quatre sur une seule ligne, sous le texte. « Supprimer » était une
   croix posée dehors, à droite de la bulle : elle prenait sa place dans la
   rangée, si bien qu'un message effaçable était plus étroit que le message
   d'à côté - deux bulles de largeurs différentes pour une différence qui ne
   regarde que les droits de qui lit. */
function socialMsgHTML(c, reponse){
  const aime = c.aime === true;
  return `<div class="soc-msg" data-id="${c.id}">
    ${socialAvatarLien(c.pseudo, c.avatar, 'p')}
    <div class="soc-msg-in">
      <div class="soc-msg-tete">
        ${socialNomLien(c.pseudo)}
        ${socialNoteMsgHTML(c.sonJeu)}
        ${c.modifie ? '<i class="soc-msg-maj">modifié</i>' : ''}
      </div>
      <p class="soc-msg-texte">${esc(c.texte)}</p>
      <div class="soc-msg-pied">
        <button type="button" class="soc-mini soc-msg-aime${aime ? ' on' : ''}"
          data-act="jaime-msg" aria-pressed="${aime ? 'true' : 'false'}"
          aria-label="J'aime ce message">${SOC_COEUR}<span>${c.jaime || 0}</span></button>
        ${reponse ? '' :
          `<button type="button" class="soc-mini" data-act="repondre">Répondre</button>`}
        ${c.mien ?
          `<button type="button" class="soc-mini" data-act="modifier">Modifier</button>` : ''}
        ${c.effacable ? `<button type="button" class="soc-mini soc-supprime"
          data-efface="${c.id}">Supprimer</button>` : ''}
      </div>
    </div>
  </div>`;
}

/* Un commentaire et ce qu'on lui a répondu. `.soc-repondre` reste vide et
   masqué : c'est la place que prendra le champ de réponse quand on cliquera
   sur « Répondre », et l'avoir déjà réservée évite de deviner où l'insérer
   dans un balisage qu'on vient de réécrire. */
function socialCommentaireHTML(c){
  const reponses = c.reponses || [];
  return `<li class="soc-bloc">
    ${socialMsgHTML(c, false)}
    ${reponses.length
      ? `<ul class="soc-reponses">${reponses.map(r =>
          `<li>${socialMsgHTML(r, true)}</li>`).join('')}</ul>`
      : ''}
    <div class="soc-repondre" hidden></div>
  </li>`;
}

function socialFilHTML(fil){
  if(!fil.length) return '<p class="soc-muet soc-vide">Personne n\'a encore réagi.</p>';
  return `<ul class="soc-msgs">${fil.map(socialCommentaireHTML).join('')}</ul>`;
}

/* La zone d'écriture, ou l'invitation à se connecter. On ne montre pas un
   champ qui refusera à l'envoi : dire tout de suite ce qui manque coûte
   moins cher que de faire taper trois lignes pour rien.

   `rows="1"` : le champ part sur une ligne et pousse à mesure qu'on écrit,
   jusqu'au plafond de .soc-champ - voir static/commun/champs.js. Il n'a plus de
   poignée à tirer, donc plus besoin de partir large « au cas où ». */
function socialEcrireHTML(connecte){
  if(!connecte){
    return `<p class="soc-muet soc-connexion">
      <a href="/abyss?connexion=1">Connecte-toi</a> pour aimer et commenter.</p>`;
  }
  return `<form class="soc-ecrire" autocomplete="off">
    <textarea class="soc-champ" rows="1" maxlength="1000"
      placeholder="Écrire un commentaire..." aria-label="Écrire un commentaire"></textarea>
    <button type="submit" class="cta soc-envoi">Envoyer</button>
  </form>`;
}

/* Le petit formulaire des deux gestes qui se font dans le fil lui-même :
   répondre à un message, et réécrire le sien. Le même dessin pour les deux,
   parce que c'est le même geste - un champ, on valide ou on renonce.

   En colonne et non côte à côte comme la zone du bas : ces formulaires-là
   s'ouvrent déjà en retrait, sous un message, et il ne reste pas la largeur
   d'un bouton à côté du champ. */
function socialMiniFormHTML(valeur, valider){
  return `<form class="soc-ecrire soc-mini-form" autocomplete="off">
    <textarea class="soc-champ" rows="1" maxlength="1000"
      aria-label="${esc(valider)}">${esc(valeur || '')}</textarea>
    <span class="soc-mini-actions">
      <button type="button" class="soc-mini soc-annule">Annuler</button>
      <button type="submit" class="cta soc-envoi">${esc(valider)}</button>
    </span>
  </form>`;
}

/* La même fenêtre d'où qu'on vienne - le fil, la liste des avis, une
   notification. Quand elle s'ouvre par-dessus la liste des avis, celle-ci
   reste dessous : la refermer suffit à la retrouver là où on l'avait
   laissée, sans rien redemander au serveur. */
async function ouvrirFilSocial(jeuId){
  socialCadre('socFil', 'Discussion', '<p class="soc-muet soc-vide">Chargement…</p>');
  let data;
  try{ data = await socialAppel(`/api/social/jeu/${jeuId}`); }
  catch(e){
    const h = document.getElementById('socFil');
    if(h && !h.hidden) h.querySelector('.soc-in').innerHTML =
      `<p class="soc-muet soc-vide">${esc(e.message || 'Discussion introuvable')}</p>`;
    return;
  }
  const h = document.getElementById('socFil');
  if(!h || h.hidden) return;             // fermée pendant le chargement
  const connecte = data.post.aime !== null;
  h.querySelector('.soc-in').innerHTML = `
    ${socialCarteHTML(data.post, false)}
    <div class="soc-fil" id="socFilListe">${socialFilHTML(data.fil)}</div>
    ${socialEcrireHTML(connecte)}`;
  socialBrancheFil(h, jeuId);
}

/* ---------- aimer un message ----------
   Le même geste que sur une carte, et pour la même raison écrit pareil : le
   compteur bouge tout de suite, la requête part derrière, et en cas d'échec
   on remet exactement ce qui était affiché. Voir socialAimer.

   Ce qui change tient en une ligne : l'autre route, et pas de socialAccorde
   au bout - un message n'est affiché qu'une fois, il n'y a rien à accorder
   ailleurs. */
async function socialAimerMsg(bouton){
  const msg = bouton.closest('.soc-msg');
  const id = msg && msg.dataset.id;
  if(!id) return;
  const compteur = bouton.querySelector('span');
  const avant = {on: bouton.classList.contains('on'), n: compteur.textContent};
  const n = parseInt(avant.n, 10) || 0;
  bouton.classList.toggle('on', !avant.on);
  bouton.setAttribute('aria-pressed', avant.on ? 'false' : 'true');
  compteur.textContent = String(Math.max(0, n + (avant.on ? -1 : 1)));
  try{
    const data = await socialAppel(`/api/social/commentaire/${id}/jaime`, 'POST', {});
    bouton.classList.toggle('on', !!data.aime);
    bouton.setAttribute('aria-pressed', data.aime ? 'true' : 'false');
    compteur.textContent = String(data.jaime);
  }catch(e){
    bouton.classList.toggle('on', avant.on);
    bouton.setAttribute('aria-pressed', avant.on ? 'true' : 'false');
    compteur.textContent = avant.n;
    socialMot(e.message || 'Impossible pour le moment', true);
  }
}

/* Entrée envoie, Maj+Entrée passe à la ligne. C'est ce que fait toute zone
   de commentaire, et un <textarea> sans ça oblige à viser le bouton pour une
   phrase de six mots. Posé sur les trois champs du fil - le grand du bas,
   celui d'une réponse, celui d'une modification - parce que trois champs qui
   se ressemblent doivent obéir à la même touche. */
function socialToucheEnvoi(champ, envoi){
  champ.addEventListener('keydown', e=>{
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); envoi(); }
  });
}

/* Tout ce qui se clique dans la fenêtre d'une discussion. Une seule écoute
   posée sur la fenêtre plutôt qu'une par bouton : la liste des commentaires
   est réécrite à chaque envoi, et des écoutes posées sur ses boutons
   partiraient avec elle. */
function socialBrancheFil(h, jeuId){
  const liste = ()=> h.querySelector('#socFilListe');
  /* Une réponse du serveur, une liste redessinée. `commentaires` vient de lui
     et non d'un compte fait ici : depuis que le fil a deux niveaux, la
     longueur de la liste ne dit plus combien de messages elle porte - et
     effacer une tête en emporte plusieurs d'un coup. */
  const redessine = data=>{
    liste().innerHTML = socialFilHTML(data.fil);
    socialAccordeFil(jeuId, data.commentaires);
  };

  /* Le formulaire d'une réponse ou d'une modification, une fois posé dans la
     page : les deux se valident et s'annulent pareil, seul l'appel au
     serveur les sépare. `apresAnnuler` remet en place ce que la modification
     avait caché ; une réponse, elle, n'a qu'à disparaître. */
  const brancheMini = (form, envoie, apresAnnuler)=>{
    const champ = form.querySelector('.soc-champ');
    const bouton = form.querySelector('.soc-envoi');
    const valide = async ()=>{
      const texte = champ.value.trim();
      if(!texte) return;
      bouton.disabled = true;
      try{ redessine(await envoie(texte)); }
      catch(err){
        bouton.disabled = false;
        socialMot(err.message || 'Envoi impossible', true);
      }
    };
    form.addEventListener('submit', e=>{ e.preventDefault(); valide(); });
    form.querySelector('.soc-annule').onclick = apresAnnuler;
    socialToucheEnvoi(champ, valide);
    /* Échap referme, comme partout ailleurs. `stopPropagation` parce que la
       page écoute la même touche pour fermer la fenêtre entière : sans lui,
       renoncer à une réponse fermait la discussion avec elle. */
    champ.addEventListener('keydown', e=>{
      if(e.key === 'Escape'){ e.stopPropagation(); apresAnnuler(); }
    });
    champ.focus();
    /* Le curseur au bout du texte et non au début : on rouvre son message
       pour ajouter ou corriger la fin, pas pour écrire par-dessus. */
    champ.setSelectionRange(champ.value.length, champ.value.length);
    if(window.Champs) Champs.ajuste(champ);
  };

  /* Répondre : le champ s'ouvre sous le commentaire et ses réponses, à la
     place que `.soc-repondre` gardait vide. Un seul ouvert à la fois - deux
     champs ouverts dans une même discussion, on ne sait plus lequel on
     remplit. */
  const repondre = bloc=>{
    h.querySelectorAll('.soc-repondre').forEach(z=>{
      if(z !== bloc.querySelector('.soc-repondre')){ z.innerHTML = ''; z.hidden = true; }
    });
    const zone = bloc.querySelector('.soc-repondre');
    if(!zone || !zone.hidden) return;             // déjà ouvert : on le laisse
    const parent = bloc.querySelector('.soc-msg').dataset.id;
    zone.innerHTML = socialMiniFormHTML('', 'Répondre');
    zone.hidden = false;
    brancheMini(zone.querySelector('form'),
      texte => socialAppel(`/api/social/jeu/${jeuId}/commentaire`, 'POST',
                           {texte: texte, parent: parent}),
      ()=>{ zone.innerHTML = ''; zone.hidden = true; });
  };

  /* Modifier : le champ prend la place du texte, dans la bulle même. Le
     message ne bouge pas de sa place dans le fil - on corrige une phrase, on
     ne la republie pas. */
  const modifier = msg=>{
    const boite = msg.querySelector('.soc-msg-in');
    if(boite.querySelector('.soc-mini-form')) return;    // déjà ouvert
    const texte = boite.querySelector('.soc-msg-texte');
    const pied = boite.querySelector('.soc-msg-pied');
    texte.hidden = true; pied.hidden = true;
    boite.insertAdjacentHTML('beforeend',
      socialMiniFormHTML(texte.textContent, 'Enregistrer'));
    const form = boite.querySelector('.soc-mini-form');
    brancheMini(form,
      t => socialAppel(`/api/social/commentaire/${msg.dataset.id}`, 'PATCH', {texte: t}),
      ()=>{ form.remove(); texte.hidden = false; pied.hidden = false; });
  };

  h.onclick = async e=>{
    if(socialVersProfil(e)) return;
    if(socialVersJeu(e)) return;   // la jaquette et le titre : la fiche du jeu
    const jaimeMsg = e.target.closest('[data-act="jaime-msg"]');
    if(jaimeMsg){ socialAimerMsg(jaimeMsg); return; }
    const jaime = e.target.closest('[data-act="jaime"]');
    if(jaime){ socialAimer(jaime); return; }
    const rep = e.target.closest('[data-act="repondre"]');
    if(rep){ repondre(rep.closest('.soc-bloc')); return; }
    const mod = e.target.closest('[data-act="modifier"]');
    if(mod){ modifier(mod.closest('.soc-msg')); return; }
    const efface = e.target.closest('[data-efface]');
    if(efface){
      /* Deux temps, comme la suppression d'un jeu (voir f_del dans
         archive-formulaire.js) : le bouton demande confirmation, et se
         désarme tout seul au bout de cinq secondes si on passe son chemin.

         Il n'en avait pas besoin quand c'était une croix posée au bord de la
         bulle ; il en a besoin maintenant qu'il est dans la rangée, collé à
         « Modifier ». Deux mots de large, à côté du bouton qu'on visait —
         et rien ne rattrape un message effacé. */
      if(!efface.classList.contains('armed')){
        efface.classList.add('armed');
        efface.textContent = 'Confirmer ?';
        setTimeout(()=>{
          if(efface.isConnected){
            efface.classList.remove('armed');
            efface.textContent = 'Supprimer';
          }
        }, 5000);
        return;
      }
      efface.disabled = true;
      try{
        redessine(await socialAppel(
          `/api/social/commentaire/${efface.dataset.efface}`, 'DELETE', {}));
      }catch(err){
        efface.disabled = false;
        efface.classList.remove('armed');
        efface.textContent = 'Supprimer';
        socialMot(err.message || 'Suppression impossible', true);
      }
    }
  };

  const form = h.querySelector('.soc-ecrire');
  if(!form) return;
  const champ = form.querySelector('.soc-champ');
  const envoi = async ()=>{
    const texte = champ.value.trim();
    if(!texte) return;
    const bouton = form.querySelector('.soc-envoi');
    bouton.disabled = true;
    try{
      const data = await socialAppel(
        `/api/social/jeu/${jeuId}/commentaire`, 'POST', {texte: texte});
      champ.value = '';
      /* Le champ a grandi avec le texte : vidé, il doit redescendre. Rien ne
         le lui dit tout seul - on n'a pressé aucune touche. */
      if(window.Champs) Champs.ajuste(champ);
      redessine(data);
      /* Le dernier commentaire est celui qu'on vient d'écrire : on va le
         voir plutôt que de laisser deviner qu'il est parti. */
      const dernier = liste().querySelector('.soc-bloc:last-child');
      if(dernier) dernier.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    }catch(err){
      socialMot(err.message || 'Envoi impossible', true);
    }finally{ bouton.disabled = false; }
  };
  form.addEventListener('submit', e=>{ e.preventDefault(); envoi(); });
  socialToucheEnvoi(champ, envoi);
  champ.focus();
}

/* Les chiffres d'un jeu, à côté de sa jaquette en haut de ses avis :
   combien l'ont terminé, combien en ont écrit quelque chose, et la note
   qu'ils lui donnent en moyenne.

   Trois nombres et trois mots, là où il y avait une phrase. « 1 joueur a
   terminé ce jeu, dont 1 avec un avis écrit. » se lit en entier pour en
   tirer deux chiffres ; ceux-ci se comptent d'un regard, et c'est tout ce
   qu'on leur demande avant de descendre dans la liste.

   La moyenne ne compte que les notes existantes : un jeu terminé sans note
   ne vaut pas zéro, il ne dit rien. Elle disparaît quand personne n'a noté,
   plutôt que d'afficher un tiret dont il faudrait deviner le sens. */
function socialChiffresHTML(posts){
  const avec = posts.filter(p => p.avis && p.avis.length).length;
  const notes = posts.map(p => p.note).filter(n => n !== null && n !== undefined);
  const moy = notes.length ? notes.reduce((a, b) => a + b, 0) / notes.length : null;
  const bouts = [
    `<b>${posts.length}</b> terminé${posts.length > 1 ? 's' : ''}`,
    // « avis » ne prend pas de s : il en a déjà un
    `<b>${avec}</b> avis`,
  ];
  if(moy !== null){
    bouts.push(`<b style="color:${noteColor(moy)}">${fr(moy, 1)}</b> de moyenne`);
  }
  return `<p class="soc-compte">${bouts.join('<i>·</i>')}</p>`;
}

/* L'en-tête de la fenêtre « Avis » : le jeu, une fois, avec ses chiffres.

   C'est là que tient la page. En dessous, toutes les cartes parlent de ce
   jeu-ci et d'aucun autre - elles n'ont donc plus à se le rappeler l'une
   après l'autre, et ce qu'on lit en descendant n'est plus que des gens et
   des avis. La jaquette peut alors être vue plutôt que devinée : une seule
   à l'écran, et assez grande pour reconnaître le jeu du premier coup d'œil.

   Elle ne se clique pas, et le titre non plus : on arrive ici depuis la
   fiche du jeu, qui attend juste derrière. Voir `sansJeu` dans
   socialCarteHTML pour le tour en rond que ça évitait déjà. */
function socialAvisTeteHTML(nom, idIgdb, posts){
  return `<header class="soc-avis-tete">
    ${socialCover({nom: nom, idIgdb: idIgdb, note: null})}
    <div class="soc-avis-ident">
      <b class="soc-avis-jeu">${esc(nom)}</b>
      ${posts.length ? socialChiffresHTML(posts) : ''}
    </div>
  </header>`;
}

/* ---------- la page « Avis » d'un jeu ----------
   Ouverte depuis la fiche du mur : tous ceux qui ont terminé ce jeu, ceux
   qui ont écrit quelque chose d'abord. C'est le seul endroit du site où le
   même titre rassemble plusieurs journaux - partout ailleurs, un jeu est
   une ligne dans le classeur de quelqu'un. */
async function ouvrirAvisSocial(nom, idIgdb){
  /* Le titre de la barre ne répète plus le nom du jeu : l'en-tête juste
     dessous le porte, en grand et avec sa jaquette. Deux fois le même titre
     à trente pixels d'écart, c'était la première des redites de cette
     fenêtre. */
  socialCadre('socAvis', 'Avis des joueurs',
              '<p class="soc-muet soc-vide">Chargement…</p>');
  let data;
  const params = new URLSearchParams({nom: nom || ''});
  if(idIgdb) params.set('idIgdb', idIgdb);
  try{ data = await socialAppel('/api/social/avis?' + params.toString()); }
  catch(e){
    const h = document.getElementById('socAvis');
    if(h && !h.hidden) h.querySelector('.soc-in').innerHTML =
      `<p class="soc-muet soc-vide">${esc(e.message || 'Rien à afficher')}</p>`;
    return;
  }
  const h = document.getElementById('socAvis');
  if(!h || h.hidden) return;
  const posts = data.posts || [];
  /* Le jeu en tête, puis les gens. Entre les deux, une ligne qui dit ce
     qu'on va lire et combien : sans elle, la liste commençait au ras de
     l'en-tête et le premier avis se lisait comme la suite de celui-ci.
     Elle sert aussi de prise pour le défilement - on sait où la lecture
     commence, et où revenir. */
  h.querySelector('.soc-in').innerHTML = `
    ${socialAvisTeteHTML(nom, idIgdb, posts)}
    ${posts.length
      ? `<h3 class="soc-avis-sous">${posts.length} joueur${posts.length > 1 ? 's' : ''}
           ${posts.length > 1 ? 'ont' : 'a'} terminé ce jeu</h3>
         <div class="soc-liste">${posts.map(p => socialCarteHTML(p, true, true)).join('')}</div>`
      : `<p class="soc-muet soc-vide">Personne n'a encore terminé ce jeu.</p>`}`;
  h.onclick = e=>{
    if(socialVersProfil(e)) return;
    /* Pas de socialVersJeu ici : plus une seule carte ne porte de jaquette
       ni de titre cliquables, il n'y a donc rien à intercepter avant la
       discussion. Le fil, lui, en a toujours besoin. */
    const jaime = e.target.closest('[data-act="jaime"]');
    if(jaime){ socialAimer(jaime); return; }
    const carte = e.target.closest('.soc-post');
    /* Rien à passer : cette liste reste ouverte derrière la discussion, et
       la croix de celle-ci la redécouvre telle qu'on l'avait laissée. La
       redemander au serveur aurait tout redessiné, et perdu la position de
       lecture pour rien - les compteurs, eux, sont tenus à jour au fil des
       clics (voir socialAccorde). */
    if(carte) ouvrirFilSocial(carte.dataset.id);
  };
}

/* ---------- la cloche ----------
   Montée sur n'importe quel bouton qu'on lui donne : la page du journal a le
   sien dans l'en-tête, la page Social aussi. Le panneau, lui, est construit
   ici une fois pour toutes.

   La pastille arrive avec /api/moi comme celle des suggestions - voir
   comptes.notifications_neuves - et se corrige ensuite à chaque ouverture. */
let SOC_NOTIFS = null;      // le panneau, une fois monté
/* Le dernier compte connu, gardé même quand il n'y a personne à qui le
   montrer. Le temps réel peut arriver avant que la cloche soit montée - la
   page demande d'abord au serveur qui elle est, et monte la cloche à la
   réponse, ce qui laisse une poignée de millisecondes où l'événement n'a
   nulle part où se poser. Sans cette mémoire il était perdu, et la pastille
   restait à zéro jusqu'au rechargement. */
let SOC_NEUVES = 0;

/* Le compte fait foi, d'où qu'il vienne : /api/moi au démarrage, le serveur
   en direct ensuite, et zéro quand on ouvre le panneau. Un seul chemin pour
   les trois, sans quoi ils se contrediraient. */
function socialMajNeuves(n){
  SOC_NEUVES = n || 0;
  if(SOC_NOTIFS) socialPastille(SOC_NOTIFS.bouton, SOC_NEUVES);
  else{
    // la cloche de la page, si elle est là mais pas encore montée
    const b = document.getElementById('cloche');
    if(b) socialPastille(b, SOC_NEUVES);
  }
}

function socialPastille(bouton, n){
  if(!bouton) return;
  let p = bouton.querySelector('.soc-pastille');
  if(!n){ if(p) p.remove(); return; }
  if(!p){
    p = document.createElement('i');
    p.className = 'soc-pastille';
    bouton.appendChild(p);
  }
  p.textContent = n > 9 ? '9+' : String(n);
}

const SOC_GENRES = {
  jaime:       'a aimé ton avis sur',
  commentaire: 'a commenté ton avis sur',
  // « a répondu à ton commentaire » et « a répondu après toi » ne disent pas
  // la même chose : la première s'adresse à nous, la seconde nous tient au
  // courant. Deux phrases pour deux gestes, et la cloche ne sonne qu'une
  // fois par personne et par message (voir ajoute_commentaire).
  reponse:     'a répondu à ton commentaire sur',
  fil:         'a répondu après toi sur',
};

function socialNotifHTML(n){
  /* `data-fil` et non `data-jeu` : ce qu'on ouvre ici est une discussion,
     désignée par la ligne de journal dont elle parle. `data-jeu` porte un
     titre sur les cartes, et deux sens pour un même nom finiraient par se
     croiser. */
  return `<li class="soc-notif${n.lu ? '' : ' neuve'}" data-fil="${n.jeuId}">
    ${socialAvatar(n.pseudo, n.avatar, 'p')}
    <span class="soc-notif-in">
      <b>${esc(n.pseudo)}</b> ${esc(SOC_GENRES[n.genre] || 'a réagi à')}
      <u>${esc(n.jeu)}</u>
      ${n.texte ? `<i>« ${esc(n.texte)} »</i>` : ''}
    </span>
  </li>`;
}

/* La cloche vue de dehors : l'engrenage, le menu des périodes et la
   recherche la referment quand ils s'ouvrent - un seul menu ouvert à la
   fois, la règle que ces trois-là se disaient déjà entre eux.

   Elle vit ici plutôt que dans monteCloche parce que ce sont d'autres
   fichiers qui l'appellent, et qu'ils n'ont pas de prise sur ce qui se
   passe dans cette fermeture. `SOC_NOTIFS` suffit à retrouver le panneau et
   son bouton, et valoir `null` - une page Social sans compte n'a pas de
   cloche - est un cas normal, pas une panne. */
function socialClocheFerme(){
  if(!socialClocheOuverte()) return;
  SOC_NOTIFS.panneau.hidden = true;
  SOC_NOTIFS.bouton.setAttribute('aria-expanded', 'false');
}
/* La même question, pour qui doit décider ce que fait Échap : le panneau de
   la cloche n'est pas une fenêtre de la pile - il pend sous son bouton -
   donc FERMETURES ne le connaît pas, et c'est la chaîne « aucune fenêtre
   ouverte » d'archive-demarrage.js qui s'en occupe. */
function socialClocheOuverte(){
  return !!SOC_NOTIFS && !SOC_NOTIFS.panneau.hidden;
}

function monteCloche(bouton){
  if(!bouton) return;
  const panneau = document.createElement('div');
  panneau.className = 'soc-cloche-panneau';
  panneau.hidden = true;
  panneau.setAttribute('role', 'menu');
  (bouton.parentNode || document.body).appendChild(panneau);
  SOC_NOTIFS = {bouton: bouton, panneau: panneau};
  // ce que le temps réel a pu annoncer avant que la cloche existe
  socialPastille(bouton, SOC_NEUVES);

  const ferme = socialClocheFerme;
  const ouvre = async ()=>{
    /* Les autres menus de la barre s'en vont, et c'est à l'ouverture qu'on
       le fait : le clic posé sur le document ne peut pas s'en charger, parce
       que ce bouton-ci et celui de l'engrenage appellent tous les deux
       stopPropagation sur le leur - justement pour que le clic qui ouvre un
       menu ne le referme pas aussitôt en remontant. Aucun des deux ne voyait
       donc l'autre partir, et cloche puis engrenage - ou l'inverse -
       laissait les deux panneaux ouverts l'un par-dessus l'autre.

       `typeof` : la page Social n'a ni engrenage ni onglets de période, elle
       ne charge ni archive-journal.js ni archive-mur.js. */
    if(typeof closeMenu === 'function') closeMenu();
    if(typeof closePer === 'function') closePer();
    if(typeof fermerRecherche === 'function') fermerRecherche();
    panneau.hidden = false;
    bouton.setAttribute('aria-expanded', 'true');
    panneau.innerHTML = '<p class="soc-muet soc-vide">Chargement…</p>';
    let data;
    try{ data = await socialAppel('/api/social/notifications'); }
    catch(e){
      panneau.innerHTML = `<p class="soc-muet soc-vide">${
        esc(e.message || 'Rien à afficher')}</p>`;
      return;
    }
    const liste = data.notifications || [];
    panneau.innerHTML = liste.length
      ? `<ul class="soc-notifs">${liste.map(socialNotifHTML).join('')}</ul>`
      : `<p class="soc-muet soc-vide">Aucune notification.</p>`;
    /* Marqué lu à l'ouverture, pas au clic : ouvrir le panneau, c'est les
       avoir vues. La pastille s'éteint donc tout de suite, mais les lignes
       gardent leur point le temps qu'on les lise - le panneau qu'on a sous
       les yeux ne doit pas se vider pendant qu'on le regarde. */
    socialMajNeuves(0);
    if(data.neuves) socialAppel('/api/social/notifications/vues', 'POST', {}).catch(()=>{});
  };

  bouton.addEventListener('click', e=>{
    e.stopPropagation();
    if(panneau.hidden) ouvre(); else ferme();
  });
  panneau.addEventListener('click', e=>{
    const ligne = e.target.closest('.soc-notif');
    if(!ligne) return;
    ferme();
    ouvrirFilSocial(ligne.dataset.fil);
  });
  document.addEventListener('click', e=>{
    if(!panneau.hidden && !panneau.contains(e.target) && e.target !== bouton) ferme();
  });
  document.addEventListener('keydown', e=>{ if(e.key === 'Escape') ferme(); });
}

/* ---------- le temps réel ----------
   Deux choses arrivent sans qu'on ait rien demandé : quelqu'un termine un
   jeu, et quelqu'un réagit à ce qu'on a écrit. Les deux se voyaient au
   rechargement suivant, c'est-à-dire jamais - on ne recharge pas une page
   qu'on est en train de lire.

   Le canal est celui du hub, monté pour le Yu-Gi-Quiz, sur un namespace à
   part : voir NS et branche_temps_reel dans social.py. La page du journal
   s'y branche aussi, pour sa cloche - elle n'a pas de fil à remplir, elle
   passe donc `surJeu` vide.

   Tout est facultatif. Sans socket.io - le script du CDN qui n'arrive pas,
   un réseau qui coupe - la fonction rend `null` et la page se comporte
   exactement comme avant : ce qu'on a chargé reste juste, ce qui arrive
   ensuite attend le prochain chargement. C'est un supplément, pas une
   dépendance, et rien ici n'a le droit de lever. */
function socialTempsReel(quoi){
  if(typeof io !== 'function') return null;
  let prise;
  try{ prise = io('/social'); }
  catch(e){ return null; }

  /* La pastille rouge, en direct. Le serveur envoie le COMPTE et non « une
     de plus » : une page ouverte depuis trois heures a pu rater un
     événement, et un nombre juste se pose là où un incrément se décale. */
  prise.on('cloche', d => socialMajNeuves(d && d.neuves));

  if(quoi && quoi.surJeu) prise.on('jeu', d => d && d.post && quoi.surJeu(d.post));
  /* Un jeu qui quitte le fil : remis en cours, reclassé en wishlist, ou
     effacé. Le retirer aussi, sinon le fil garde à l'écran un jeu que
     personne ne retrouvera en rechargeant. */
  if(quoi && quoi.surRetrait) prise.on('jeu-retire', d => d && quoi.surRetrait(d.id));
  return prise;
}

/* Échap n'a plus d'écoute à lui ici. Ces deux fenêtres se sont inscrites
   auprès de fermeSurFond en se créant (voir socialHote), et c'est
   archive-noyau.js qui ferme celle du dessus - la vraie, celle qu'auPremierPlan
   a mise devant, et non celle qu'un ordre écrit à la main croyait être là.

   Ce qui était écrit ici marchait pour ces deux-là entre elles - le fil
   avant les avis - mais rien ne le disait au reste de la page : la cascade
   d'archive-fiche.js ne les connaissait pas, si bien qu'Échap sur les avis
   refermait la fiche du dessous en même temps. Deux ordres partiels valent
   moins qu'un seul qui regarde. */
