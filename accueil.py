#!/usr/bin/env python3
"""Ce que l'accueil d'Abyss montre de chacun : les images de ses projets.

Les vignettes de l'accueil sont de vraies images du site (voir VISUELS dans
templates/abyss/accueil.html). Trois d'entre elles parlent de la personne
qui regarde :

- les jeux video : les trois jeux qu'elle a le mieux notes dans son
  journal, et a note egale ceux ou elle a passe le plus d'heures ;
- la collection : les trois cartes favorites choisies dans les reglages de
  son classeur (voir collection.favorites) ;
- la collection Pokemon : de meme, ses trois favorites (voir
  pokemon.favorites).

Rien trouve -- un visiteur, un journal vide, aucune favorite -- et la liste
revient vide : la page garde alors ses images par defaut.

app.py branche ce fichier comme les autres :

    app.register_blueprint(accueil.branche(STATIQUE / "archive" / "Cover"))
"""

from __future__ import annotations

from pathlib import Path

from flask import Blueprint

import collection
import journal
import pokemon
from comptes import actuel, cx, reponse
from jaquettes import EXTENSION, cle_jaquette

JEUX_MAXI = 3

DOSSIER_JAQUETTES = None   # pose par branche(), comme apercu.py
URL_JAQUETTES = "/static/archive/Cover/"

blueprint_accueil = Blueprint("accueil", __name__, url_prefix="/api/accueil")


def branche(dossier_jaquettes, url_publique="/static/archive/Cover/") -> Blueprint:
    """Dit au module ou vivent les jaquettes, et rend le blueprint."""
    global DOSSIER_JAQUETTES, URL_JAQUETTES
    DOSSIER_JAQUETTES = Path(dossier_jaquettes)
    URL_JAQUETTES = url_publique if url_publique.endswith("/") else url_publique + "/"
    return blueprint_accueil


def jeux_preferes(u) -> list:
    """Les trois jeux preferes de `u`, ceux qui ont une jaquette sur le disque.

    Les jeux finis seulement, comme la mosaique d'un journal partage (voir
    apercu._jaquettes) : un jeu en cours n'a pas encore sa note definitive,
    et la Wishlist n'est pas ce qu'on a joue. Un jeu sans note passe apres
    tous les autres -- SQLite range NULL en dernier dans un tri descendant.
    """
    page = journal.ma_page(u)
    if page is None or DOSSIER_JAQUETTES is None:
        return []
    sortie, vus = [], set()
    for l in cx().execute(
            "SELECT nom, id_igdb FROM jeu WHERE page_id = ? AND periode NOT IN (?, ?)"
            " ORDER BY note DESC, heures DESC, id DESC",
            (page["id"], *journal.STATUTS)):
        fichier = cle_jaquette(l["nom"], l["id_igdb"]) + EXTENSION
        if fichier in vus or not (DOSSIER_JAQUETTES / fichier).is_file():
            continue
        vus.add(fichier)
        sortie.append({"nom": l["nom"], "image": URL_JAQUETTES + fichier})
        if len(sortie) == JEUX_MAXI:
            break
    return sortie


def cartes_favorites(u) -> list:
    """Les cartes favorites du classeur de `u`, en vignettes : l'eventail
    de l'accueil fait cent pixels de large, l'original en fait 813."""
    page = collection.ma_page(u)
    if page is None:
        return []
    return [{"nom": c["nom"], "image": collection.URL_VIGNETTES + c["fichier"]}
            for c in collection.favorites(page)]


def pokemon_favorites(u) -> list:
    """Les favorites de la collection Pokemon de `u`, celles qui ont leur
    image sur le disque : une place vide dans l'eventail ne dit rien."""
    page = pokemon.ma_page(u)
    if page is None:
        return []
    return [{"nom": c["nom"], "image": c["image"]}
            for c in pokemon.favorites(page) if c["image"]]


@blueprint_accueil.get("")
def visuels():
    u = actuel()
    return reponse({"ok": True, "jeux": jeux_preferes(u), "cartes": cartes_favorites(u),
                    "pokemon": pokemon_favorites(u)})
