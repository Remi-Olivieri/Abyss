#!/usr/bin/env python3
"""Les apercus de lien : ce qu'une messagerie montre d'une page d'Abyss.

Coller /archive/Jokrem dans Discord ou WhatsApp ne donnait qu'une adresse
nue. Les pages se remplissent en JavaScript, et un robot d'apercu n'en
execute pas une ligne : il ne lit que les balises Open Graph de l'en-tete.
Elles sont donc ecrites ici, cote serveur, et glissees dans la page juste
avant </head> (voir app.envoie).

Deux sortes d'apercu :

  - une page du site (/abyss, /quiz...) : son nom, une phrase et le logo,
    toujours les memes ;
  - un journal ou un classeur PUBLIC : son titre, ce qu'il contient, et une
    mosaique de ses jaquettes ou de ses cartes, fabriquee ici (voir
    mosaique). C'est l'apercu de quelqu'un -- celui qu'on partage.

Un journal prive et un pseudo inconnu recoivent le meme apercu, celui de la
page generique : l'apercu n'en dit jamais plus que ce que n'importe qui voit
en ouvrant le lien.

Les adresses sont absolues (une messagerie ne sait pas de quel site vient
une image en /api/...) et lues dans la requete. Derriere nginx, elles ne
sont justes qu'avec ABYSS_PROXY : sans lui, Flask se croit en http sur
127.0.0.1 -- voir ProxyFix dans app.py.
"""

from __future__ import annotations

import hashlib
import io
import threading
from html import escape
from pathlib import Path

from flask import Blueprint, Response, abort, request

import collection
import journal
from comptes import cx
from jaquettes import EXTENSION, cle_jaquette

SITE = "Abyss"

# Les pages du site : leur nom et leur phrase. La cle est la regle de route,
# comme monitoring.PAGES. Une page absente d'ici n'a pas d'apercu : le
# profil, les suggestions ou le monitoring ne se partagent pas.
PAGES = {
    "/abyss": ("Abyss", "Journaux de jeux vidéo, collection Yu-Gi-Oh!, mini-jeux et quiz."),
    "/archive": ("Archive Jeux Vidéos",
                 "Liste de jeux terminés par année avec notes et temps de jeu."),
    "/archive/feed": ("Social - Archive Jeux Vidéos",
                      "Les jeux que chacun vient de terminer, au fil des journaux."),
    "/collection": ("Collection Yu-Gi-Oh!", "Suivi de collection Yu-Gi-Oh!"),
    "/quiz": ("Mini-Jeux / Quiz", "Deviner un jeu à sa jaquette, ranger des sorties"
                                  " dans l'ordre, trouver les liens d'une grille."),
    "/chainz": ("L'Atelier Chainz", "Le site du jeu vidéo Chainz."),
}
# Le journal ou le classeur de quelqu'un, quand il n'a pas d'apercu a lui :
# celui de la page dont il fait partie.
PARENTS = {"/archive/<pseudo>": "/archive", "/collection/<pseudo>": "/collection"}

# La mosaique. 1200 x 630 : le format que toutes les messageries attendent
# pour une grande image, et qu'elles recadrent le moins.
LARGEUR, HAUTEUR = 1200, 630
MARGE, ECART = 36, 16
IMAGES_MAXI = 10              # deux rangees de cinq, au plus
# largeur / hauteur : une jaquette IGDB (264 x 374), une carte (813 x 1185)
RATIO_JAQUETTE = 264 / 374
RATIO_CARTE = 813 / 1185
# le fond des pages, du bleu de la surface au noir du fond
FOND_HAUT, FOND_BAS = (11, 21, 36), (3, 6, 11)

# L'image d'une page sans mosaique : le logo, carre (voir static/commun/logo/).
LOGO = "/static/commun/logo/abyss-512.png"
LOGO_COTE = 512

blueprint_apercu = Blueprint("apercu", __name__, url_prefix="/api/apercu")

DOSSIER_JAQUETTES = None


def branche(dossier_jaquettes) -> Blueprint:
    """Dit au module ou vivent les jaquettes, et rend le blueprint.

    Meme facon de faire que quiz.branche. Les cartes, elles, se trouvent
    par collection.illustrations, deja branche par app.py.
    """
    global DOSSIER_JAQUETTES
    DOSSIER_JAQUETTES = Path(dossier_jaquettes)
    return blueprint_apercu


# --------------------------------------------------------------------------
#   Ce qu'on montre
# --------------------------------------------------------------------------
def _nombre(n) -> str:
    """2108 -> « 2 108 », avec une espace insecable comme en francais."""
    return f"{n:,}".replace(",", " ")


def _page_publique(module, pseudo):
    page = module.page_de(pseudo)
    return page if page is not None and page["visibilite"] == "publique" else None


def _jaquettes(page) -> list:
    """Les jaquettes de la mosaique d'un journal : ses jeux les mieux notes.

    Ses coups de coeur plutot que ses derniers ajouts : un journal importe
    d'un bloc a tous ses jeux « ajoutes » le meme soir, et la mosaique
    montrerait alors ce que l'import a range en dernier. A note egale, le
    plus recemment termine passe devant. Les statuts n'y entrent pas : la
    Wishlist n'est pas ce qu'on a joue.
    """
    fichiers, vus = [], set()
    if DOSSIER_JAQUETTES is None:
        return fichiers
    for l in cx().execute(
            "SELECT nom, id_igdb FROM jeu WHERE page_id = ? AND periode NOT IN (?, ?)"
            " ORDER BY note DESC, annee DESC, mois DESC, id DESC",
            (page["id"], *journal.STATUTS)):
        chemin = DOSSIER_JAQUETTES / (cle_jaquette(l["nom"], l["id_igdb"]) + EXTENSION)
        if chemin.name in vus or not chemin.is_file():
            continue
        vus.add(chemin.name)
        fichiers.append(chemin)
        if len(fichiers) == IMAGES_MAXI:
            break
    return fichiers


def _cartes(page) -> list:
    """Les cartes de la mosaique d'un classeur : les dernieres rangees.

    Leur vignette plutot que l'original, quand elle existe : 320 pixels
    suffisent largement a une case de deux cents, et elles sont deja la.
    """
    if collection.DOSSIER_CARTES is None:
        return []
    index = collection.illustrations()
    fichiers, vus = [], set()
    for l in cx().execute(
            "SELECT nom FROM carte WHERE page_id = ? AND rarete IS NOT NULL"
            " ORDER BY maj_le DESC, id DESC", (page["id"],)):
        fichier = index.get(collection.normalise_nom(l["nom"]))
        if not fichier or fichier in vus:
            continue
        vus.add(fichier)
        fichiers.append(collection.vignette(fichier) or collection.DOSSIER_CARTES / fichier)
        if len(fichiers) == IMAGES_MAXI:
            break
    return fichiers


def _signature(fichiers) -> str:
    """Change des qu'une image de la mosaique change : c'est sa version."""
    morceaux = []
    for f in fichiers:
        try:
            morceaux.append(f"{f.name}:{int(f.stat().st_mtime)}")
        except OSError:
            morceaux.append(f.name)
    return hashlib.blake2s("|".join(morceaux).encode("utf-8"), digest_size=6).hexdigest()


def _description_journal(page) -> str:
    """« 323 jeux terminés · 14 279 h de jeu »

    Les deux chiffres que le journal affiche sous le nom de son auteur (voir
    sousIdentite dans archive-journal.js), comptes de la meme facon : les
    jeux termines seulement, et leurs heures arrondies a la plus proche --
    int(x + 0.5) et non round(), qui arrondit 0,5 au pair et donnerait une
    heure de moins que la page.
    """
    n = journal.nb_jeux(page["id"])
    morceaux = [f"{_nombre(n)} jeux terminés" if n > 1
                else "1 jeu terminé" if n == 1 else "Aucun jeu terminé pour l'instant"]
    heures = cx().execute(
        "SELECT COALESCE(SUM(heures), 0) FROM jeu WHERE page_id = ? AND periode NOT IN (?, ?)",
        (page["id"], *journal.STATUTS)).fetchone()[0]
    if heures >= 1:
        morceaux.append(f"{_nombre(int(heures + 0.5))} h de jeu")
    return " · ".join(morceaux)


def _description_classeur(page) -> str:
    """« 2 108 cartes rangées · dernière arrivée : Magicien Sombre »"""
    n = collection.nb_cartes(page["id"])
    morceaux = [f"{_nombre(n)} cartes Yu-Gi-Oh! rangées" if n > 1
                else "1 carte Yu-Gi-Oh! rangée" if n == 1 else "Un classeur encore vide"]
    derniere = cx().execute(
        "SELECT nom FROM carte WHERE page_id = ? AND rarete IS NOT NULL"
        " ORDER BY maj_le DESC, id DESC LIMIT 1", (page["id"],)).fetchone()
    if derniere:
        morceaux.append(f"dernière arrivée : {derniere['nom']}")
    return " · ".join(morceaux)


# Ce qui distingue les deux sortes de pages partagees : ou chercher la page,
# son titre par defaut, sa description et ses images.
GENRES = {
    "journal": (journal, "archive", "Journal de {}", _description_journal,
                _jaquettes, RATIO_JAQUETTE),
    "classeur": (collection, "collection", "Classeur de {}", _description_classeur,
                 _cartes, RATIO_CARTE),
}
REGLES = {"/archive/<pseudo>": "journal", "/collection/<pseudo>": "classeur"}


# --------------------------------------------------------------------------
#   Les balises
# --------------------------------------------------------------------------
def _html(racine, titre, description, url, mosaique=None, alt=None) -> str:
    """Les balises. Avec sa mosaique, un journal s'affiche en grande image ;
    sans elle, c'est le logo du site, en vignette a cote du texte."""
    if mosaique:
        image = [("og:image", mosaique), ("og:image:type", "image/jpeg"),
                 ("og:image:width", str(LARGEUR)), ("og:image:height", str(HAUTEUR)),
                 ("og:image:alt", alt or titre)]
    else:
        image = [("og:image", racine + LOGO), ("og:image:type", "image/png"),
                 ("og:image:width", str(LOGO_COTE)), ("og:image:height", str(LOGO_COTE)),
                 ("og:image:alt", "Le logo d'Abyss, une méduse")]
    proprietes = [("og:site_name", SITE), ("og:type", "website"), ("og:locale", "fr_FR"),
                  ("og:title", titre), ("og:description", description), ("og:url", url),
                  *image]
    noms = [("description", description),
            ("twitter:card", "summary_large_image" if mosaique else "summary")]
    lignes = ([f'<meta property="{p}" content="{escape(v)}">' for p, v in proprietes]
              + [f'<meta name="{n}" content="{escape(v)}">' for n, v in noms])
    return "<!-- l'apercu de lien : voir apercu.py -->\n" + "\n".join(lignes) + "\n"


def _de_quelqu_un(genre, pseudo, racine):
    """Les balises du journal ou du classeur public de `pseudo`, ou None."""
    module, dossier, titre_defaut, decrit, images, _ = GENRES[genre]
    page = _page_publique(module, pseudo)
    if page is None:
        return None
    titre = page["titre"] or titre_defaut.format(page["pseudo"])
    fichiers = images(page)
    mosaique = (f"{racine}/api/apercu/{genre}/{page['pseudo']}.jpg?v={_signature(fichiers)}"
                if fichiers else None)
    alt = f"{'Les jaquettes' if genre == 'journal' else 'Les cartes'} de {page['pseudo']}"
    return _html(racine, titre, decrit(page), f"{racine}/{dossier}/{page['pseudo']}",
                 mosaique, alt)


def balises(regle, args) -> str:
    """Les balises Open Graph de cette page, ou "" pour une page sans apercu.

    Jamais au prix d'une page : une base indisponible ou une jaquette
    illisible donnent l'apercu generique, pas une erreur 500.
    """
    racine = request.url_root.rstrip("/")
    pseudo = (args or {}).get("pseudo")
    if regle in REGLES and pseudo:
        try:
            propres = _de_quelqu_un(REGLES[regle], pseudo, racine)
        except Exception:                 # noqa: BLE001 - l'apercu generique suffit
            propres = None
        if propres:
            return propres
    page = PAGES.get(regle) or PAGES.get(PARENTS.get(regle))
    if page is None:
        return ""
    return _html(racine, page[0], page[1], racine + (request.path.rstrip("/") or "/"))


def glisse(html, regle, args) -> str:
    """La page, avec ses balises juste avant </head>."""
    ajout = balises(regle, args)
    return html.replace("</head>", ajout + "</head>", 1) if ajout else html


# --------------------------------------------------------------------------
#   La mosaique
# --------------------------------------------------------------------------
def _grille(n, ratio):
    """(hauteur d'une case, rangees, cases par rangee) : la plus grande case
    qui laisse tenir les n images, sur une rangee ou sur deux."""
    meilleur = (0, 1, n)
    for rangees in (1, 2):
        if rangees > n:
            break
        par_rangee = -(-n // rangees)
        h = min((HAUTEUR - 2 * MARGE - (rangees - 1) * ECART) / rangees,
                (LARGEUR - 2 * MARGE - (par_rangee - 1) * ECART) / par_rangee / ratio)
        if h > meilleur[0]:
            meilleur = (h, rangees, par_rangee)
    return meilleur


def mosaique(fichiers, ratio):
    """Les images cote a cote sur le fond des pages, en JPEG. None si aucune
    ne se lit, ou si Pillow manque."""
    try:
        from PIL import Image, ImageDraw, ImageOps
    except ImportError:
        return None
    images = []
    for f in fichiers:
        try:
            with Image.open(f) as im:
                im.load()
                images.append(im.convert("RGB"))
        except (OSError, ValueError):
            continue                      # une image illisible : les autres suffisent
    if not images:
        return None

    n = len(images)
    h, rangees, par_rangee = _grille(n, ratio)
    h = int(h)
    w = int(h * ratio)
    degrade = Image.linear_gradient("L").resize((LARGEUR, HAUTEUR))
    toile = Image.composite(Image.new("RGB", (LARGEUR, HAUTEUR), FOND_BAS),
                            Image.new("RGB", (LARGEUR, HAUTEUR), FOND_HAUT), degrade)
    masque = Image.new("L", (w, h), 0)
    ImageDraw.Draw(masque).rounded_rectangle((0, 0, w - 1, h - 1),
                                             radius=max(6, w // 22), fill=255)
    y0 = (HAUTEUR - (rangees * h + (rangees - 1) * ECART)) // 2
    for i, im in enumerate(images):
        rangee, colonne = divmod(i, par_rangee)
        sur_la_rangee = min(par_rangee, n - rangee * par_rangee)
        x0 = (LARGEUR - (sur_la_rangee * w + (sur_la_rangee - 1) * ECART)) // 2
        case = ImageOps.fit(im, (w, h), Image.LANCZOS)
        toile.paste(case, (x0 + colonne * (w + ECART), y0 + rangee * (h + ECART)), masque)

    sortie = io.BytesIO()
    toile.save(sortie, "JPEG", quality=85, optimize=True, progressive=True)
    return sortie.getvalue()


# Les mosaiques deja faites, par genre et signature : une messagerie
# redemande souvent l'image plusieurs fois de suite, et la fabriquer coute
# dix lectures d'image. Vide quand elle deborde, comme app._compresses.
_faites = {}
FAITES_MAXI = 32
_verrou = threading.Lock()


@blueprint_apercu.get("/<genre>/<pseudo>.jpg")
def image(genre, pseudo):
    """La mosaique d'un journal ou d'un classeur public. 404 sinon.

    Meme regle que les balises : un journal prive et un pseudo inconnu
    repondent pareil.
    """
    if genre not in GENRES:
        abort(404)
    module, _, _, _, images, ratio = GENRES[genre]
    page = _page_publique(module, pseudo)
    if page is None:
        abort(404)
    fichiers = images(page)
    if not fichiers:
        abort(404)
    cle = (genre, _signature(fichiers))
    with _verrou:
        donnees = _faites.get(cle)
    if donnees is None:
        donnees = mosaique(fichiers, ratio)
        if donnees is None:
            abort(404)
        with _verrou:
            if len(_faites) >= FAITES_MAXI:
                _faites.clear()
            _faites[cle] = donnees
    r = Response(donnees, mimetype="image/jpeg")
    # l'adresse porte la signature : une image qui change change d'adresse
    r.headers["Cache-Control"] = "public, max-age=86400"
    return r

