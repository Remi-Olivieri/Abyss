/* Les zones de texte qui grandissent en écrivant.
 *
 * Une poignée de redimensionnement dans le coin d'un <textarea>, c'est une
 * chose à faire avant d'écrire : on tape trois lignes, on ne voit plus que
 * les deux dernières, on lâche le clavier, on tire la poignée, on reprend.
 * Le champ sait pourtant très bien quelle hauteur il lui faudrait -- il n'y
 * a qu'à la lui donner.
 *
 * Une taille de départ (celle de `rows` et du `min-height` de la feuille de
 * style), qui suit le texte à mesure qu'il s'allonge, jusqu'à un plafond
 * au-delà duquel c'est le champ qui défile. Le plafond compte autant que le
 * reste : sans lui, un long message pousse le bouton « Envoyer » hors de
 * l'écran, et il faut remonter tout ce qu'on vient d'écrire pour le trouver.
 *
 * Rien à brancher champ par champ, et c'est le but : trois fichiers de
 * l'Archive, la fenêtre de suggestion et le hub construisent leurs
 * formulaires en JavaScript, à des moments qui ne se ressemblent pas. Une
 * écoute posée sur le document attrape la frappe où qu'elle arrive, et un
 * observateur attrape les champs à leur naissance. Une page n'a qu'à charger
 * ce fichier.
 *
 * Un champ qui veut garder sa poignée le dit : data-taille="fixe".
 */
(function () {
  "use strict";

  /* Sans plafond dans la feuille de style, celui-ci : assez pour une dizaine
     de lignes, ce qui couvre un commentaire et un avis. C'est un filet, pas
     un réglage -- chaque champ a intérêt à écrire son propre `max-height`,
     qui dépend de la fenêtre où il vit. */
  const PLAFOND_DEFAUT = 320;

  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  function ajuste(ta) {
    if (!ta || ta.tagName !== "TEXTAREA") return;
    if (ta.dataset.taille === "fixe") return;
    /* Pas encore à l'écran -- construit dans une fenêtre encore masquée.
       Mesurer maintenant donnerait zéro et écraserait le champ à rien : on
       attend qu'il soit visible, et c'est le premier `focus` ou la première
       frappe qui repassera par ici. */
    if (ta.offsetParent === null) return;

    const st = getComputedStyle(ta);
    if (st.display === "none") return;
    const plafond = st.maxHeight === "none" ? PLAFOND_DEFAUT : px(st.maxHeight);
    const plancher = px(st.minHeight);
    /* scrollHeight mesure la boîte de contenu et son remplissage, jamais les
       bordures : en border-box il faut les rajouter, sinon le champ perd deux
       pixels à chaque mesure et finit par montrer une barre de défilement
       pour une ligne qui tenait. */
    const bordures = st.boxSizing === "border-box"
      ? px(st.borderTopWidth) + px(st.borderBottomWidth) : 0;

    /* `auto` d'abord, et c'est tout le tour de main : tant qu'une hauteur est
       posée, scrollHeight ne redescend jamais en dessous -- le champ saurait
       grandir mais pas rétrécir quand on efface. Remis à `auto`, il reprend
       la hauteur de son attribut `rows`, qui devient du même coup son
       plancher naturel : un champ de quatre lignes ne se replie pas sur une
       seule parce qu'on vient d'y taper un mot. */
    ta.style.height = "auto";
    const voulu = ta.scrollHeight + bordures;
    ta.style.height = Math.min(Math.max(voulu, plancher), plafond) + "px";
    /* Le défilement n'apparaît qu'au plafond. En le laissant sur `auto` tout
       le temps, Firefox garde une gouttière vide à droite du texte et le
       champ n'est plus tout à fait de la largeur des autres. */
    ta.style.overflowY = voulu > plafond ? "auto" : "hidden";
  }

  function tous(racine) {
    (racine || document).querySelectorAll("textarea").forEach(ajuste);
  }

  /* La frappe, où qu'elle arrive : `input` remonte jusqu'au document, donc
     une seule écoute suffit pour tous les champs de la page, ceux qui
     n'existent pas encore compris. */
  document.addEventListener("input", (e) => ajuste(e.target));
  /* Le focus rattrape ce que l'observateur ne peut pas voir : un champ écrit
     dans une fenêtre masquée, qu'on découvre plus tard sans que le balisage
     bouge (la fenêtre de suggestion, construite une fois pour toutes et
     seulement démasquée ensuite). Il est vide à ce moment-là, donc rien ne
     saute aux yeux -- mais un champ rouvert sur un brouillon, si. */
  document.addEventListener("focusin", (e) => ajuste(e.target));

  /* Les champs qui arrivent après coup. L'Archive construit ses fenêtres en
     JavaScript : sans cet observateur, un avis de vingt lignes s'ouvrirait
     replié sur cinq et il faudrait y toucher pour qu'il se déplie. */
  if (window.MutationObserver) {
    new MutationObserver((lots) => {
      for (const lot of lots) {
        for (const n of lot.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === "TEXTAREA") ajuste(n);
          else if (n.querySelector) tous(n);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener("DOMContentLoaded", () => tous());
  /* Une fenêtre plus étroite, c'est plus de lignes pour le même texte : la
     hauteur qui allait ne va plus. */
  addEventListener("resize", () => tous());

  /* Pour les rares cas où l'on remplit un champ par programme -- l'avis d'un
     jeu qu'on ouvre pour le modifier, un brouillon reposé : la valeur change
     sans qu'aucune touche soit pressée, donc sans `input`. */
  window.Champs = { ajuste: ajuste, tous: tous };
})();
