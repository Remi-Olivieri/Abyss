/* Ce que les trois pages du quiz partagent.

   Pour l'instant : le piege de focus des dialogues. Les trois overlays du
   quiz (quitter la partie, fin de partie, mot de passe de salle) etaient de
   simples <div> poses par-dessus le reste -- sans role, sans aria-modal, et
   sans rien pour retenir le focus. Tabuler dedans en ressortait aussitot,
   dans la page d'en dessous qu'on ne pouvait plus voir : le clavier se
   promenait dans des boutons invisibles pendant que le dialogue attendait
   une reponse.

   Un fichier plutot que deux copies : c'est exactement le defaut que le
   quiz a partout ailleurs -- une fonction ecrite trois fois et absente la
   ou elle compte. */

const Focus = (() => {
  // ce qui peut recevoir le focus, dans l'ordre du document
  const SELECTEUR = 'a[href], button:not([disabled]), input:not([disabled]),' +
                    ' select:not([disabled]), textarea:not([disabled]),' +
                    ' [tabindex]:not([tabindex="-1"])';

  let precedent = null;   // a qui rendre le focus en sortant
  const poses = new WeakMap();

  const cibles = (el) => Array.from(el.querySelectorAll(SELECTEUR))
      .filter((e) => e.offsetWidth || e.offsetHeight || e.getClientRects().length);

  return {
    /* A appeler une fois le dialogue rendu visible : il faut qu'il ait des
       dimensions pour que ses boutons comptent comme focusables. */
    piege(el) {
      if (poses.has(el)) return;
      precedent = document.activeElement;

      const surTouche = (e) => {
        if (e.key !== 'Tab') return;
        const f = cibles(el);
        if (!f.length) { e.preventDefault(); return; }
        const premier = f[0], dernier = f[f.length - 1];
        if (e.shiftKey && document.activeElement === premier) {
          e.preventDefault(); dernier.focus();
        } else if (!e.shiftKey && document.activeElement === dernier) {
          e.preventDefault(); premier.focus();
        }
      };

      el.addEventListener('keydown', surTouche);
      poses.set(el, surTouche);

      const f = cibles(el);
      if (f.length) f[0].focus();
    },

    rend(el) {
      const surTouche = poses.get(el);
      if (!surTouche) return;
      el.removeEventListener('keydown', surTouche);
      poses.delete(el);
      // le dialogue est ferme : rendre le focus la ou il etait, sinon il
      // repart au debut du document et l'on a perdu sa place
      if (precedent && document.contains(precedent)) precedent.focus();
      precedent = null;
    },
  };
})();
