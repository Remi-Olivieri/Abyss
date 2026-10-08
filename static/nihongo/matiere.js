/* =======================================================================
   Nihongo - matiere.js

   La matière (kanji.json, vocabulaire.json, grammaire.json, lecture.json,
   les traits) pèse 2,6 Mo, 760 Ko une fois compressée - et en ligne, nginx
   sert les .json en « no-store » : sans rien d'autre, chaque ouverture de
   la page la retéléchargeait en entier.

   Elle ne change pourtant qu'à la main (nihongo.py matiere). La page la
   garde donc elle-même, dans le Cache Storage du navigateur, sous son
   adresse versionnée : la page les cite en <link data-matiere>, et le
   serveur y ajoute la date de chaque fichier (?v=, voir versionne dans
   app.py), comme pour les scripts. Un fichier refait change de date, donc
   d'adresse : la page le retélécharge et oublie l'ancien. Sans Cache
   Storage (navigation privée, vieux navigateur), un simple fetch.
   ======================================================================= */
(function () {
  "use strict";

  const CACHE = "nihongo-matiere";
  const DOSSIER = "/static/nihongo/";

  /* L'adresse versionnée d'un fichier, telle que la page la cite. */
  function adresse(nom) {
    const lien = [...document.querySelectorAll("link[data-matiere]")]
      .find((l) => new URL(l.href).pathname === DOSSIER + nom);
    return lien ? new URL(lien.href).pathname + new URL(lien.href).search : DOSSIER + nom;
  }

  let ouvert = null;
  function cache() {
    if (!ouvert) {
      ouvert = typeof caches === "undefined" ? Promise.resolve(null)
        : caches.open(CACHE).catch(() => null);
    }
    return ouvert;
  }

  /* Le JSON d'un fichier de la matière. `message` : l'erreur à lever s'il
     n'arrive pas. */
  async function json(nom, message) {
    const url = adresse(nom);
    const versionnee = url.includes("?v=");
    const c = versionnee ? await cache() : null;
    if (c) {
      try {
        const garde = await c.match(url);
        if (garde) return await garde.json();
      } catch (e) { /* illisible : on le redemande */ }
    }
    let r;
    try { r = await fetch(url, { credentials: "same-origin" }); } catch (e) { r = null; }
    if (!r || !r.ok) throw new Error(message || "La matière n'a pas pu être chargée.");
    if (c) {
      try {
        await c.put(url, r.clone());
        // les versions d'avant de ce fichier ne serviront plus
        (await c.keys()).forEach((q) => {
          const u = new URL(q.url);
          if (u.pathname === DOSSIER + nom && u.pathname + u.search !== url) c.delete(q);
        });
      } catch (e) { /* plein, ou refusé : tant pis, il reviendra par le réseau */ }
    }
    return r.json();
  }

  window.Matiere = { json, adresse };
})();
