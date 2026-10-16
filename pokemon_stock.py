#!/usr/bin/env python3
"""Le stock de cartes Pokemon, tenu a jour depuis TCGdex.

app.py branche ce fichier en une ligne, apres pokemon.py dont il remplit le
catalogue :

    app.register_blueprint(pokemon_stock.branche())

La source
---------
TCGdex (tcgdex.net) : une base libre, en francais, a jour le jour de la
sortie d'une serie, avec une API ouverte sans cle. C'est l'equivalent
d'ygoprodeck pour le classeur Yu-Gi-Oh, avec un avantage -- les noms
francais y sont, il n'y a pas de detour par l'editeur.

Une serie se lit en deux fois :

  - en francais, par l'API REST : le nom de la serie, ses dates, et ses
    cartes avec leur nom francais et l'adresse de leur image ;
  - par l'API GraphQL : la rarete, les versions (normale, reverse, holo...)
    et la categorie de chaque carte, cent par requete. Ce que la liste
    francaise ne dit pas, et qu'il faudrait sinon demander carte par carte
    -- trois cents requetes par serie au lieu de trois. Le GraphQL ne parle
    qu'anglais : la rarete est traduite ici (voir RARETES). Une carte qu'il
    ne connait pas est lue seule, en francais.

Une carte sans image francaise prend l'anglaise -- tout le bloc Diamant &
Perle, par exemple, n'a pas ses scans francais chez TCGdex. Elle est notee
dans `images_en` de sa serie, et la mise a jour suivante remplace l'image le
jour ou la francaise parait.

Les images
----------
Rangees par bloc et par serie, en grand pour la carte qu'on sort du classeur
et en vignette pour les pochettes :

    static/pokemon/Cartes/sv/sv01/001.webp       600 px, ~75 Ko
    static/pokemon/Vignettes/sv/sv01/001.webp    320 px, ~20 Ko

La vignette est fabriquee dans la foulee, comme pour le classeur Yu-Gi-Oh :
c'est quelques millisecondes ici contre un classeur qui rame pour la
premiere personne qui l'ouvre. Les deux dossiers sont hors du depot.

Le chantier
-----------
Une serie, ce sont deux cents images ; tout le catalogue, dix-huit mille --
une heure et demie. Ca ne tient pas dans une requete, et la page ne doit pas
avoir a rester ouverte : le telechargement tourne dans un fil a part, serie
apres serie, et la page vient demander ou il en est (voir /chantier). Un
redemarrage du serveur l'interrompt ; le relancer reprend ou il en etait,
puisqu'une image deja sur le disque n'est pas retelechargee.

Reserve a l'administration, comme le stock Yu-Gi-Oh : ce qui s'ecrit ici est
le catalogue de tout le monde.
"""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
import urllib.parse
from pathlib import Path

from flask import Blueprint, request

import jaquettes
import pokemon
from comptes import Refus, actuel, corps, echec, maintenant, reponse

API = "https://api.tcgdex.net/v2"
GRAPHQL = API + "/graphql"

ENTETES = {
    "User-Agent": jaquettes.NAVIGATEUR,
    "Accept": "application/json,*/*;q=0.8",
    "Connection": "close",
}
ENTETES_GRAPHQL = {**ENTETES, "Content-Type": "application/json"}
ENTETES_IMAGE = {**jaquettes.ENTETES_IMAGE}

# TCGdex ne publie pas de limite, mais son serveur d'images repond 503 a
# une rafale : deux images sur deux cents, a cinq par seconde. Un appel
# tous les dixiemes de seconde au plus, et une seconde passe sur ce qui a
# rate (voir fais_serie). La cadence est declaree dans le robinet commun,
# voir _patiente dans jaquettes.py.
jaquettes.CADENCE.setdefault("tcgdex", 0.1)

MAX_JSON = 16 * 1024 * 1024
MAX_IMAGE = 4 * 1024 * 1024
# La liste des series parues est gardee une heure : on la consulte en
# ouvrant la fenetre du stock, pas a chaque clic.
FRAICHEUR = 3600
PAR_PAGE = 100              # ce que le GraphQL de TCGdex rend par requete

VIGNETTE_LARGEUR = 320
VIGNETTE_QUALITE = 80

# Pokemon TCG Pocket est un jeu mobile : ses « cartes » ne s'achetent pas en
# boosters et ne se rangent dans aucun classeur. TCGdex les publie a cote
# des autres, on ne les propose pas.
BLOCS_ECARTES = {"tcgp"}

# La rarete telle que TCGdex l'ecrit en anglais, et telle que les cartes
# francaises l'impriment. La traduction de TCGdex est parfois fausse --
# « Secret Rare » y devient « Magnifique rare », qui est la Amazing Rare --
# d'ou une table a nous. Une rarete inconnue garde son nom anglais plutot
# que de disparaitre : le filtre de la page la proposera telle quelle.
# pokemon.ORDRE_RARETES doit toutes les citer, voir tests.py.
RARETES = {
    "Common": "Commune",
    "Uncommon": "Peu commune",
    "Rare": "Rare",
    "Rare Holo": "Rare Holo",
    "Holo Rare": "Rare Holo",
    "Rare Holo LV.X": "Rare Holo NIV.X",
    "Rare PRIME": "Rare Prime",
    "LEGEND": "LÉGENDE",
    "Holo Rare V": "Rare Holo V",
    "Holo Rare VMAX": "Rare Holo VMAX",
    "Holo Rare VSTAR": "Rare Holo VSTAR",
    "Double rare": "Double rare",
    "Ultra Rare": "Ultra rare",
    "Illustration rare": "Illustration rare",
    "Special illustration rare": "Illustration spéciale rare",
    "Hyper rare": "Hyper rare",
    "Mega Hyper Rare": "Méga hyper rare",
    "Mega Attack Rare": "Rare Méga Attaque",
    "ACE SPEC Rare": "HIGH-TECH rare",
    "Amazing Rare": "Magnifique",
    "Radiant Rare": "Radieux",
    "Secret Rare": "Rare secrète",
    "Shiny rare": "Chromatique rare",
    "Shiny rare V": "Chromatique rare V",
    "Shiny rare VMAX": "Chromatique rare VMAX",
    "Shiny Ultra Rare": "Chromatique ultra rare",
    "Black White Rare": "Rare Noir & Blanc",
    "Classic Collection": "Collection classique",
    "Full Art Trainer": "Dresseur Full Art",
    "Pikachu Rare": "Pikachu rare",
    "Futuristic Rare": "Rare futuriste",
    "RGB Rare": "Rare RGB",
    "Promo": "Promo",
    "None": "Sans rareté",
}

# Les versions telles que TCGdex les nomme, et leur lettre (voir
# pokemon.VERSIONS).
VARIANTES = (("normal", "N"), ("reverse", "R"), ("holo", "H"),
             ("firstEdition", "E"), ("wPromo", "W"))

CATEGORIES = {"pokemon": "P", "pokémon": "P", "trainer": "D", "dresseur": "D",
              "energy": "E", "énergie": "E"}

_verrou = threading.Lock()          # le chantier
_verrou_liste = threading.Lock()    # la liste des series parues
_LISTE = {"quand": 0.0, "blocs": None}


def _dit(message):
    if jaquettes.BAVARD:
        print(f"  pokemon : {message}", flush=True)


def branche() -> Blueprint:
    """Rend le blueprint. Les chemins sont ceux de pokemon.py : le stock
    ecrit exactement la ou le classeur lit (voir pokemon.chemins)."""
    return blueprint_stock


# --------------------------------------------------------------------------
#   Parler a TCGdex
# --------------------------------------------------------------------------
def _json(adresse, requete=None):
    """(donnees, souci). `requete` : une requete GraphQL, envoyee en POST."""
    jaquettes._patiente("tcgdex")
    corps_brut = json.dumps({"query": requete}).encode("utf-8") if requete else None
    brut, type_contenu, souci = jaquettes._appelle(
        adresse, ENTETES_GRAPHQL if requete else ENTETES, corps_brut, MAX_JSON + 1,
        service="tcgdex")
    if souci:
        return None, ("TCGdex ne connait pas cette adresse" if souci == "absent" else souci)
    if not brut or len(brut) > MAX_JSON:
        return None, "reponse vide ou trop lourde de TCGdex"
    try:
        charge = json.loads(brut.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None, "reponse illisible de TCGdex"
    if requete:
        if not isinstance(charge, dict) or charge.get("errors") and not charge.get("data"):
            return None, "TCGdex a refuse la requete"
        return charge.get("data") or {}, None
    return charge, None


def _quote(v) -> str:
    return urllib.parse.quote(str(v), safe="")


def disponibles(force=False):
    """Les blocs et les series parus en francais, dans l'ordre de TCGdex --
    du plus ancien au plus recent. (blocs, souci).

    Un appel pour les blocs, un par bloc pour ses series, et un au GraphQL
    pour les dates de sortie, que la liste francaise ne donne pas. Une serie
    que le GraphQL ignore (les promos McDonald's francaises) part sans date :
    elle est datee a son telechargement, par sa propre fiche.
    """
    with _verrou_liste:
        if not force and _LISTE["blocs"] is not None \
                and time.time() - _LISTE["quand"] < FRAICHEUR:
            return _LISTE["blocs"], None
        liste, souci = _json(f"{API}/fr/series")
        if souci:
            return None, souci
        dates = {}
        d, _ = _json(GRAPHQL, "{ sets { id releaseDate } }")
        for s in (d or {}).get("sets") or []:
            if isinstance(s, dict) and s.get("id"):
                dates[s["id"]] = s.get("releaseDate") or ""
        blocs = []
        for b in liste if isinstance(liste, list) else []:
            bid = str(b.get("id") or "")
            if not pokemon.IDENTIFIANT.match(bid) or bid in BLOCS_ECARTES:
                continue
            detail, souci = _json(f"{API}/fr/series/{_quote(bid)}")
            if souci:
                return None, f"bloc {b.get('name') or bid} : {souci}"
            series = []
            for s in detail.get("sets") or []:
                sid = str(s.get("id") or "")
                if not pokemon.IDENTIFIANT.match(sid):
                    continue
                compte = s.get("cardCount") or {}
                series.append({"id": sid, "nom": s.get("name") or sid,
                               "date": dates.get(sid, ""),
                               "total": compte.get("total") or 0,
                               "officiel": compte.get("official") or 0})
            if series:
                blocs.append({"id": bid, "nom": b.get("name") or bid,
                              "date": detail.get("releaseDate") or "", "series": series})
        _LISTE.update(quand=time.time(), blocs=blocs)
        return blocs, None


def _graphql_serie(sid):
    """{ id TCGdex -> rarete, versions, categorie, dex, image anglaise }."""
    details, page = {}, 1
    prefixe = sid + "-"
    while page <= 60:
        requete = ('{ cards(filters:{id:%s}, pagination:{page:%d, count:%d}) {'
                   ' id rarity category dexId image'
                   ' variants { normal reverse holo firstEdition wPromo } } }'
                   % (json.dumps(prefixe), page, PAR_PAGE))
        d, souci = _json(GRAPHQL, requete)
        if souci:
            return None, souci
        cartes = d.get("cards") or []
        for c in cartes:
            if isinstance(c, dict) and str(c.get("id") or "").startswith(prefixe):
                details[c["id"]] = c
        if len(cartes) < PAR_PAGE:
            break
        page += 1
    return details, None


def _versions(variantes) -> str:
    v = variantes if isinstance(variantes, dict) else {}
    return "".join(lettre for cle, lettre in VARIANTES if v.get(cle) is True) or "N"


def _categorie(c) -> str:
    return CATEGORIES.get(str(c or "").strip().lower(), "")


def _dex(c):
    d = c.get("dexId") if isinstance(c, dict) else None
    if isinstance(d, list) and d and isinstance(d[0], int):
        return d[0]
    return None


def lit_serie(sid):
    """Une serie telle que TCGdex la donne aujourd'hui. (serie, souci).

        { id, nom, bloc, bloc_nom, date, officiel, total, sigle, logo,
          cartes: [[numero, nom, rarete, versions, categorie, dex]],
          images: { numero -> (adresse, langue) } }
    """
    fr, souci = _json(f"{API}/fr/sets/{_quote(sid)}")
    if souci:
        return None, souci
    if not isinstance(fr, dict) or not isinstance(fr.get("cards"), list):
        return None, "fiche de serie illisible"
    bloc = fr.get("serie") or {}
    if not pokemon.IDENTIFIANT.match(str(bloc.get("id") or "")):
        return None, "serie sans bloc"
    details, souci = _graphql_serie(sid)
    if souci:
        # Le GraphQL a refuse la serie entiere -- une seule carte sans
        # rarete suffit a lui faire rendre une erreur. Chaque carte sera
        # lue seule : plus lent, mais la serie entre quand meme.
        _dit(f"GraphQL de {sid} : {souci}, lecture carte par carte")
        details = {}
    cartes, images, secours = [], {}, {}
    for c in fr["cards"]:
        numero, nom = str(c.get("localId") or ""), str(c.get("name") or "").strip()
        if not numero or not nom:
            continue
        g = details.get(str(c.get("id")))
        if g is not None:
            rarete = RARETES.get(g.get("rarity") or "None", g.get("rarity") or "")
            versions, categorie, dex = _versions(g.get("variants")), _categorie(g.get("category")), _dex(g)
            anglaise = g.get("image")
        else:
            # Inconnue du GraphQL : sa fiche francaise, seule. Sa rarete y
            # est deja traduite, par TCGdex -- faute de mieux.
            seule, souci = _json(f"{API}/fr/cards/{_quote(c.get('id'))}")
            if souci:
                return None, f"carte {numero} : {souci}"
            rarete = str(seule.get("rarity") or "")
            versions, categorie, dex = (_versions(seule.get("variants")),
                                        _categorie(seule.get("category")), _dex(seule))
            anglaise = None
        cartes.append([numero, nom, rarete, versions, categorie, dex])
        if c.get("image"):
            images[numero] = (c["image"], "fr")
            # TCGdex annonce parfois une image francaise qu'il n'a pas : on
            # garde l'anglaise sous la main, voir fais_serie
            if anglaise:
                secours[numero] = anglaise
        elif anglaise:
            images[numero] = (anglaise, "en")
    compte = fr.get("cardCount") or {}
    sigle = (fr.get("abbreviation") or {}).get("official") or ""
    return {"id": sid, "nom": fr.get("name") or sid, "bloc": bloc["id"],
            "bloc_nom": bloc.get("name") or bloc["id"], "date": fr.get("releaseDate") or "",
            "officiel": compte.get("official") or 0, "total": compte.get("total") or 0,
            "sigle": sigle, "logo": fr.get("logo"), "cartes": cartes, "images": images,
            "secours": secours}, None


# --------------------------------------------------------------------------
#   Ecrire le catalogue
# --------------------------------------------------------------------------
def _ecrit(chemin, texte) -> None:
    """Par un fichier temporaire, puis un renommage : une coupure ne laisse
    jamais un catalogue a moitie ecrit, que la page ne saurait plus lire."""
    chemin = Path(chemin)
    temporaire = chemin.with_name(chemin.name + ".part")
    try:
        chemin.parent.mkdir(parents=True, exist_ok=True)
        temporaire.write_text(texte, encoding="utf-8")
        os.replace(temporaire, chemin)
    finally:
        if temporaire.exists():
            try:
                temporaire.unlink()
            except OSError:
                pass


def texte_serie(s) -> str:
    """Le fichier d'une serie : l'en-tete lisible, puis une carte par ligne.

    `sans_image` : les cartes dont TCGdex n'a l'image dans aucune langue --
    les Energies d'Ecarlate et Violet, les kits du dresseur. Elles ne sont
    pas « a telecharger », la fenetre du stock ne les repropose pas.

    Un JSON indente mettrait chaque case de chaque carte sur sa ligne --
    deux mille lignes pour cent cartes, et un diff illisible a chaque
    mise a jour."""
    tete = {k: s[k] for k in ("id", "nom", "bloc", "date", "officiel", "total", "sigle")}
    anglaises = json.dumps(sorted(s.get("images_en") or []), ensure_ascii=False)
    sans = json.dumps([l[0] for l in s["cartes"] if l[0] not in s.get("images", {})],
                      ensure_ascii=False)
    lignes = ",\n".join("    " + json.dumps(l, ensure_ascii=False) for l in s["cartes"])
    return (json.dumps(tete, ensure_ascii=False, indent=2)[:-2]
            + ',\n  "images_en": ' + anglaises
            + ',\n  "sans_image": ' + sans
            + ',\n  "cartes": [\n' + lignes + "\n  ]\n}\n")


def ecrit_serie(s, ordre=None) -> None:
    """Ecrit la serie et la range dans blocs.json, a sa place.

    `ordre` est la liste de disponibles() : blocs et series y sont dans
    l'ordre de TCGdex, que blocs.json reprend. Sans elle -- TCGdex n'a pas
    rendu sa liste --, une serie nouvelle se pose au bout de son bloc, et un
    bloc nouveau au bout du catalogue : elle sera remise a sa place au
    prochain passage.
    """
    c = pokemon.chemins()
    _ecrit(c["series"] / f"{s['id']}.json", texte_serie(s))
    brut = pokemon._lit(c["blocs"], {})
    blocs = [b for b in brut.get("blocs") or [] if isinstance(b, dict) and b.get("id")]
    bloc = next((b for b in blocs if b["id"] == s["bloc"]), None)
    if bloc is None:
        bloc = {"id": s["bloc"], "nom": s["bloc_nom"], "date": s["date"], "series": []}
        blocs.append(bloc)
    bloc["nom"] = s["bloc_nom"] or bloc.get("nom") or s["bloc"]
    date = next((b["date"] for b in ordre or [] if b["id"] == s["bloc"] and b.get("date")), "")
    if date:
        bloc["date"] = date
    elif not bloc.get("date") or (s["date"] and s["date"] < bloc["date"]):
        bloc["date"] = s["date"]
    # une serie ne vit que dans un bloc : si TCGdex l'a deplacee, elle part
    for autre in blocs:
        if autre is not bloc and s["id"] in (autre.get("series") or []):
            autre["series"] = [x for x in autre["series"] if x != s["id"]]
    if s["id"] not in (bloc.get("series") or []):
        bloc["series"] = list(bloc.get("series") or []) + [s["id"]]
    if ordre:
        rang_bloc = {b["id"]: i for i, b in enumerate(ordre)}
        rang_serie = {x["id"]: i for b in ordre for i, x in enumerate(b["series"])}
        for b in blocs:
            b["series"] = sorted(b["series"], key=lambda x: rang_serie.get(x, 10 ** 6))
        blocs.sort(key=lambda b: (rang_bloc.get(b["id"], 10 ** 6), b.get("date") or ""))
    blocs = [b for b in blocs if b.get("series")]
    _ecrit(c["blocs"], json.dumps({"blocs": blocs}, ensure_ascii=False, indent=2) + "\n")


# --------------------------------------------------------------------------
#   Les images
# --------------------------------------------------------------------------
def _telecharge(adresse, cible) -> tuple:
    """(ok, souci). Un .part puis un renommage, comme partout."""
    jaquettes._patiente("tcgdex")
    donnees, type_contenu, souci = jaquettes._appelle(
        adresse, ENTETES_IMAGE, None, MAX_IMAGE + 1, service="tcgdex")
    if souci:
        return False, ("image absente de TCGdex" if souci == "absent" else souci)
    if not donnees or len(donnees) > MAX_IMAGE:
        return False, "image vide ou trop lourde"
    if not (type_contenu or "").startswith("image/"):
        return False, f"TCGdex a renvoye {type_contenu or 'un contenu inconnu'}"
    cible = Path(cible)
    temporaire = cible.with_name(cible.name + ".part")
    try:
        cible.parent.mkdir(parents=True, exist_ok=True)
        temporaire.write_bytes(donnees)
        os.replace(temporaire, cible)
        return True, ""
    except OSError as err:
        return False, f"ecriture impossible ({err.strerror or err})"
    finally:
        if temporaire.exists():
            try:
                temporaire.unlink()
            except OSError:
                pass


def vignette(source, cible) -> bool:
    """La vignette d'une image : 320 pixels de large, de quoi rester net dans
    une pochette sur un ecran a forte densite. Sans Pillow, l'image entiere
    fait l'affaire -- plus lourde, mais la pochette n'est pas vide."""
    cible = Path(cible)
    temporaire = cible.with_name(cible.name + ".part")
    try:
        cible.parent.mkdir(parents=True, exist_ok=True)
        try:
            from PIL import Image
        except ImportError:
            temporaire.write_bytes(Path(source).read_bytes())
            os.replace(temporaire, cible)
            return True
        with Image.open(source) as im:
            im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
            im.thumbnail((VIGNETTE_LARGEUR, VIGNETTE_LARGEUR * 3), Image.LANCZOS)
            im.save(temporaire, "WEBP", quality=VIGNETTE_QUALITE, method=4)
        os.replace(temporaire, cible)
        return True
    except (OSError, ValueError):
        return False
    finally:
        if temporaire.exists():
            try:
                temporaire.unlink()
            except OSError:
                pass


def a_faire(s, deja_en) -> list:
    """Les images a telecharger : (numero, adresse, langue). Une image deja
    sur le disque ne repart pas, sauf l'anglaise d'une carte dont la
    francaise vient de paraitre."""
    c = pokemon.chemins()
    dossier = c["vignettes"] / s["bloc"] / s["id"]
    grand = c["cartes"] / s["bloc"] / s["id"]
    sortie = []
    for numero, (adresse, langue) in s["images"].items():
        fichier = pokemon.fichier_de(numero)
        present = (dossier / fichier).is_file() and (grand / fichier).is_file()
        if present and not (numero in deja_en and langue == "fr"):
            continue
        sortie.append((numero, adresse, langue))
    return sortie


# --------------------------------------------------------------------------
#   Le chantier
# --------------------------------------------------------------------------
# Un seul a la fois, dans un fil a part. Son etat vit ici, en memoire : la
# page le demande toutes les deux secondes pendant qu'elle est ouverte, et
# rien ne se perd a la fermer -- le fil continue sans elle.
_CHANTIER = {"actif": False, "arret": False, "file": [], "faites": [], "en_cours": None,
             "erreurs": [], "debut": None, "fin": None}
ERREURS_MAXI = 30


def etat() -> dict:
    with _verrou:
        return json.loads(json.dumps(_CHANTIER))


def _note(**champs):
    with _verrou:
        _CHANTIER.update(champs)


def _erreur(texte):
    _dit(texte)
    with _verrou:
        _CHANTIER["erreurs"] = (_CHANTIER["erreurs"] + [texte])[-ERREURS_MAXI:]


def lance(ids) -> dict:
    """Ajoute des series au chantier, et le demarre s'il dormait.

    Rejouable : une serie deja dans la file ou en cours n'y entre pas deux
    fois. Une serie deja faite y rentre -- c'est « mettre a jour ».
    """
    with _verrou:
        en_cours = (_CHANTIER["en_cours"] or {}).get("id")
        for sid in ids:
            if sid != en_cours and sid not in _CHANTIER["file"]:
                _CHANTIER["file"].append(sid)
        # un arret demande puis une relance aussitot : le fil n'est pas
        # encore sorti, il reprend la file au lieu de la laisser en plan
        if _CHANTIER["actif"] and _CHANTIER["file"]:
            _CHANTIER["arret"] = False
        demarre = not _CHANTIER["actif"] and bool(_CHANTIER["file"])
        if demarre:
            _CHANTIER.update(actif=True, arret=False, faites=[], erreurs=[],
                             debut=maintenant(), fin=None)
    if demarre:
        threading.Thread(target=_travaille, name="pokemon-stock", daemon=True).start()
    return etat()


def arrete() -> dict:
    """Demande l'arret. L'image en cours finit, la file se vide ; ce qui est
    deja telecharge reste."""
    with _verrou:
        if _CHANTIER["actif"]:
            _CHANTIER["arret"] = True
            _CHANTIER["file"] = []
    return etat()


def _arret_demande() -> bool:
    with _verrou:
        return _CHANTIER["arret"]


def _travaille():
    ordre, _ = disponibles()
    while True:
        with _verrou:
            if _CHANTIER["arret"] or not _CHANTIER["file"]:
                _CHANTIER.update(actif=False, en_cours=None, fin=maintenant())
                return
            sid = _CHANTIER["file"].pop(0)
            _CHANTIER["en_cours"] = {"id": sid, "nom": sid, "etape": "catalogue",
                                     "cartes": 0, "images": 0, "a_telecharger": 0}
        try:
            bilan = fais_serie(sid, ordre)
        except Exception as err:                  # noqa: BLE001 - le fil ne doit pas mourir
            traceback.print_exc()
            _erreur(f"{sid} : {err}")
            bilan = {"id": sid, "nom": sid, "cartes": 0, "images": 0, "echecs": 0,
                     "souci": str(err)}
        pokemon.oublie_catalogue()
        with _verrou:
            _CHANTIER["faites"].append(bilan)


def _progres(**champs):
    with _verrou:
        if _CHANTIER["en_cours"] is not None:
            _CHANTIER["en_cours"].update(champs)


def fais_serie(sid, ordre=None) -> dict:
    """Une serie de bout en bout : le catalogue, le logo, puis les images.

    Le catalogue s'ecrit d'abord : la serie apparait tout de suite dans les
    classeurs, avec les noms dans les pochettes, et les images arrivent
    ensuite au fil du telechargement.
    """
    s, souci = lit_serie(sid)
    if souci:
        _erreur(f"{sid} : {souci}")
        return {"id": sid, "nom": sid, "cartes": 0, "images": 0, "echecs": 0, "souci": souci}
    c = pokemon.chemins()
    ancien = pokemon._lit(c["series"] / f"{sid}.json", {})
    deja_en = set(ancien.get("images_en") or [])
    taches = a_faire(s, deja_en)
    # Les images anglaises sur le disque : celles qui l'etaient deja, et
    # celles qu'on va prendre en anglais. Une francaise qui arrive en fait
    # sortir une, au fil du telechargement.
    anglaises = (deja_en & set(s["images"])) | {
        n for n, (_, langue) in s["images"].items() if langue == "en"}
    s["images_en"] = set(anglaises)
    ecrit_serie(s, ordre)
    pokemon.oublie_catalogue()
    _progres(nom=s["nom"], bloc=s["bloc_nom"], etape="images", cartes=len(s["cartes"]),
             a_telecharger=len(taches))

    if s.get("logo") and not (c["logos"] / f"{sid}.webp").is_file():
        ok, souci = _telecharge(s["logo"] + ".webp", c["logos"] / f"{sid}.webp")
        if not ok and "/fr/" in s["logo"]:
            # le logo francais n'est pas toujours la le jour de la sortie
            ok, souci = _telecharge(s["logo"].replace("/fr/", "/en/") + ".webp",
                                    c["logos"] / f"{sid}.webp")
        if not ok:
            _dit(f"logo de {sid} : {souci}")

    faites, ratees = 0, []
    for passe in (1, 2):
        # La seconde passe reprend ce qui a rate, apres une pause : un 503
        # du serveur d'images ne dure pas, et une serie a qui il manque
        # deux cartes pour un hoquet serait a relancer a la main.
        if passe == 2:
            if not ratees or _arret_demande():
                break
            taches, ratees = [t for t, _ in ratees], []
            time.sleep(5)
        for numero, adresse, langue in taches:
            if _arret_demande():
                break
            fichier = pokemon.fichier_de(numero)
            grand = c["cartes"] / s["bloc"] / sid / fichier
            ok, souci = _telecharge(adresse + "/high.webp", grand)
            if not ok and langue == "fr" and souci == "image absente de TCGdex" \
                    and s.get("secours", {}).get(numero):
                # annoncee en francais, absente en francais : l'anglaise vaut
                # mieux qu'une pochette vide, et la francaise la remplacera
                # le jour ou elle paraitra
                adresse, langue = s["secours"][numero], "en"
                ok, souci = _telecharge(adresse + "/high.webp", grand)
                if ok:
                    anglaises.add(numero)
            if ok and not vignette(grand, c["vignettes"] / s["bloc"] / sid / fichier):
                ok, souci = False, "vignette impossible a fabriquer"
            if ok:
                faites += 1
                if langue == "fr":
                    anglaises.discard(numero)
            else:
                ratees.append(((numero, adresse, langue), souci))
            if passe == 1:
                _progres(images=faites + len(ratees))
            # tous les cinquante, le classeur voit les images deja arrivees
            if faites % 50 == 0:
                pokemon.oublie_catalogue()
    for (numero, _, _), souci in ratees:
        _erreur(f"{s['nom']} n°{numero} : {souci}")
    echecs = len(ratees)
    if anglaises != s["images_en"]:
        s["images_en"] = anglaises
        ecrit_serie(s, ordre)
    return {"id": sid, "nom": s["nom"], "cartes": len(s["cartes"]), "images": faites,
            "echecs": echecs, "sans_image": len(s["cartes"]) - len(s["images"]),
            "souci": None}


# --------------------------------------------------------------------------
#   Les routes
# --------------------------------------------------------------------------
blueprint_stock = Blueprint("pokemon_stock", __name__, url_prefix="/api/pokemon-stock")


@blueprint_stock.before_request
def reserve():
    """Tout est reserve a l'administration, et repond 404 au reste du monde,
    comme le stock Yu-Gi-Oh (voir reserve dans cartes.py)."""
    if request.method in ("POST", "PUT", "PATCH") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    u = actuel()
    if u is None or not u["admin"]:
        return echec("introuvable", "Page inconnue.", 404)
    return None


@blueprint_stock.errorhandler(Refus)
def refus(err):
    return echec(err.code, err.message, err.statut)


def _avec_le_local(blocs) -> list:
    """La liste de TCGdex, plus ce que le catalogue en a deja : combien de
    cartes, combien d'images. C'est ce qui dit, serie par serie, s'il y a
    quelque chose a faire."""
    series = pokemon.catalogue()["series"]
    sortie = []
    for b in reversed(blocs):
        lignes = []
        for x in reversed(b["series"]):
            s = series.get(x["id"])
            lignes.append({**x, "cartes": len(s["cartes"]) if s else 0,
                           "images": len(s["images"]) if s else 0,
                           "sans_image": s["sans_image"] if s else 0,
                           "date": x["date"] or (s["date"] if s else "")})
        sortie.append({**b, "series": lignes})
    return sortie


@blueprint_stock.get("/series")
def voir_series():
    """Les blocs et les series parus, les plus recents d'abord, avec ce que
    le catalogue en a deja -- et l'etat du chantier, pour reprendre la ou
    il en est si la fenetre se rouvre en plein telechargement."""
    blocs, souci = disponibles(force=request.args.get("frais") == "1")
    if souci:
        return echec("injoignable", souci, 502)
    return reponse({"ok": True, "blocs": _avec_le_local(blocs), "chantier": etat()})


@blueprint_stock.post("/telecharger")
def telecharger():
    """Met des series au chantier. { series: [...] }"""
    ids = corps().get("series")
    if not isinstance(ids, list) or not ids or len(ids) > 500:
        raise Refus("series", "Choisis au moins une serie.")
    blocs, souci = disponibles()
    if souci:
        return echec("injoignable", souci, 502)
    connues = {x["id"] for b in blocs for x in b["series"]}
    propres = []
    for sid in ids:
        if not isinstance(sid, str) or sid not in connues:
            raise Refus("serie", f"Serie inconnue de TCGdex : {sid}.")
        if sid not in propres:
            propres.append(sid)
    return reponse({"ok": True, "chantier": lance(propres)})


@blueprint_stock.get("/chantier")
def voir_chantier():
    return reponse({"ok": True, "chantier": etat()})


@blueprint_stock.post("/arreter")
def arreter():
    return reponse({"ok": True, "chantier": arrete()})
