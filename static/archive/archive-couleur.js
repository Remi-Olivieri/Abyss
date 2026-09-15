/* La couleur du profil.

   Tout ce qui etait dore dans l'Archive -- le pseudo, les chiffres, les
   boutons, l'onglet ouvert, la lumiere du plafond -- lit une seule
   variable, --gold. Changer la couleur, c'est la reposer sur <html>.

   Le journal prend celle de son proprietaire (elle arrive avec le journal,
   voir identite() dans journal.py) : on la voit chez soi, et chez les
   autres on voit la leur. Le fil prend la mienne.

   Le choix se fait dans les reglages du journal, a « Personnalisation » :
   un sous-menu qui remplace les entrees du menu le temps de choisir, avec
   la palette en 5 x 5. Le serveur n'accepte que ces teintes-la : la liste
   est la meme que PALETTE dans comptes.py, et tests.py le verifie. */

const PALETTE_PROFIL = [
  {hex:'#E8C064', nom:'Or'}, {hex:'#F5DC3A', nom:'Jaune'}, {hex:'#FFB020', nom:'Ambre'}, {hex:'#FF8A1F', nom:'Orange'}, {hex:'#FF5A36', nom:'Écarlate'},
  {hex:'#F03A47', nom:'Rouge'}, {hex:'#E8336E', nom:'Framboise'}, {hex:'#FF3D9A', nom:'Fuchsia'}, {hex:'#F044D0', nom:'Magenta'}, {hex:'#C74BF0', nom:'Pourpre'},
  {hex:'#A35BFF', nom:'Violet'}, {hex:'#7A6BFF', nom:'Indigo'}, {hex:'#5B7CFF', nom:'Bleu'}, {hex:'#3D9BFF', nom:'Azur'}, {hex:'#22C3F0', nom:'Cyan'},
  {hex:'#1FD1C1', nom:'Turquoise'}, {hex:'#1FC98A', nom:'Émeraude'}, {hex:'#3DD35F', nom:'Vert'}, {hex:'#B5E33A', nom:'Citron vert'}, {hex:'#7FF2C3', nom:'Menthe'},
  {hex:'#FF6F61', nom:'Corail'}, {hex:'#FF9E80', nom:'Saumon'}, {hex:'#B9A3FF', nom:'Lavande'}, {hex:'#B7C4D1', nom:'Argent'}, {hex:'#F1F4F8', nom:'Blanc'},
];

/* null ou absente : l'or de la feuille de style, sans rien poser. */
function appliqueCouleur(hex){
  const racine = document.documentElement;
  if(hex) racine.style.setProperty('--gold', hex);
  else racine.style.removeProperty('--gold');
}

/* ---------- sur le journal ---------- */
function couleurJournal(){
  return (typeof IDENTITE !== 'undefined' && IDENTITE.couleur) || null;
}

/* Rejouee a chaque journal ouvert (voir applyData) : la couleur change avec
   le classeur, et l'entree du menu n'existe que chez soi -- on ne repeint
   pas le journal de quelqu'un d'autre. */
function majCouleurJournal(){
  appliqueCouleur(couleurJournal());
  const b = document.getElementById('persoBtn');
  if(b) b.hidden = !CAN_WRITE;
  if(!CAN_WRITE) persoFerme();
  const p = document.getElementById('perso');
  if(p && !p.hidden) dessinePalette();
}

function persoFerme(){
  const p = document.getElementById('perso');
  if(!p || p.hidden) return;
  p.hidden = true;
  document.getElementById('menu').classList.remove('en-perso');
}

function persoOuvre(){
  const p = document.getElementById('perso');
  if(!p) return;
  document.getElementById('menu').classList.add('en-perso');
  p.hidden = false;
  dessinePalette();
  const choisie = p.querySelector('.perso-teinte[aria-checked="true"]');
  if(choisie) choisie.focus();
}

function indexCourant(){
  const hex = (couleurJournal() || PALETTE_PROFIL[0].hex).toUpperCase();
  const i = PALETTE_PROFIL.findIndex(c => c.hex === hex);
  return i < 0 ? 0 : i;
}

/* Le nom s'affiche sous la grille, et non en infobulle : celle qui est
   choisie au repos, celle qu'on survole ou qu'on atteint au clavier sinon. */
function montreNom(i){
  const c = PALETTE_PROFIL[i];
  const courant = i === indexCourant();
  document.getElementById('persoNom').innerHTML = courant
    ? `<b>${esc(c.nom)}</b>` : `${esc(c.nom)}`;
}

function dessinePalette(){
  const courant = indexCourant();
  document.getElementById('persoGrille').innerHTML = PALETTE_PROFIL.map((c, i) =>
    `<button type="button" class="perso-teinte" role="radio" data-i="${i}"
      aria-checked="${i === courant}" aria-label="${esc(c.nom)}"
      style="--t:${c.hex}"></button>`).join('');
  montreNom(courant);
}

let PERSO_JETON = 0;
async function choisitCouleur(i){
  const c = PALETTE_PROFIL[i];
  if(!c || i === indexCourant()) return;
  const avant = IDENTITE.couleur;
  const hex = i === 0 ? null : c.hex;
  // tout de suite, sans attendre le serveur : on choisit en regardant
  IDENTITE.couleur = hex;
  appliqueCouleur(hex);
  dessinePalette();
  const jeton = ++PERSO_JETON;
  try{
    const r = await fetch('/api/couleur', {
      method: 'PUT', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({couleur: hex}),
    });
    let d = null;
    try{ d = await r.json(); }catch(e){}
    if(!r.ok || !d || d.ok === false)
      throw new Error((d && d.message) || "La couleur n'a pas été enregistrée.");
  }catch(e){
    // un clic plus recent a deja pris la main : ce n'est plus a nous de revenir
    if(jeton !== PERSO_JETON) return;
    IDENTITE.couleur = avant;
    appliqueCouleur(avant);
    const p = document.getElementById('perso');
    if(p && !p.hidden) dessinePalette();
    if(typeof toast === 'function') toast(e.message, true);
  }
}

(function brancheMenuPerso(){
  const b = document.getElementById('persoBtn');
  const grille = document.getElementById('persoGrille');
  if(!b || !grille) return;   // le fil n'a pas de reglages
  b.addEventListener('click', e => { e.stopPropagation(); persoOuvre(); });
  document.getElementById('persoRetour').addEventListener('click', e => {
    e.stopPropagation();
    persoFerme();
    b.focus();
  });
  grille.addEventListener('click', e => {
    const t = e.target.closest('.perso-teinte');
    if(t) choisitCouleur(Number(t.dataset.i));
  });
  grille.addEventListener('mouseover', e => {
    const t = e.target.closest('.perso-teinte');
    if(t) montreNom(Number(t.dataset.i));
  });
  grille.addEventListener('focusin', e => {
    const t = e.target.closest('.perso-teinte');
    if(t) montreNom(Number(t.dataset.i));
  });
  grille.addEventListener('mouseleave', () => montreNom(indexCourant()));
  /* Les fleches parcourent la grille, comme dans tout groupe de boutons
     radio : cinq colonnes, donc haut et bas sautent de cinq. */
  grille.addEventListener('keydown', e => {
    const t = e.target.closest('.perso-teinte');
    if(!t) return;
    const pas = {ArrowRight: 1, ArrowLeft: -1, ArrowDown: 5, ArrowUp: -5}[e.key];
    if(!pas) return;
    e.preventDefault();
    const n = PALETTE_PROFIL.length;
    const i = (Number(t.dataset.i) + pas + n) % n;
    grille.querySelector(`[data-i="${i}"]`).focus();
  });
})();
