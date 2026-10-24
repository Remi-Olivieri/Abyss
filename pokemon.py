#!/usr/bin/env python3
"""La collection Pokemon : le classeur de chacun, serie par serie.

app.py branche ce fichier en une ligne, comme le classeur Yu-Gi-Oh :

    app.register_blueprint(pokemon.branche(STATIQUE / "pokemon"))

Ouverte a tous depuis le 16/10/2026, apres un chantier reserve a
l'administration : une collection publique se lit sans compte, chacun
n'ecrit que dans la sienne. Le stock, qui remplit le catalogue de tout le
monde, reste a l'administration (voir pokemon_stock.py).

Les mots
--------
Ceux de la page, et non ceux de TCGdex, d'ou viennent les cartes :

  - un **bloc** est une ere du jeu : « Ecarlate et Violet », « Epee et
    Bouclier ». TCGdex l'appelle `serie` ;
  - une **serie** est une extension : « Evolutions a Paldea », « 151 ».
    TCGdex l'appelle `set` ;
  - une **carte** est un numero dans une serie (« 001 », « TG12 ») -- le
    `localId` de TCGdex ;
  - une **version** est une impression de cette carte : normale, reverse,
    holo, 1re edition, promo W. La collection n'en suit que deux : la carte
    elle-meme, et sa reverse quand elle en a une (voir versions_de).
    Presque toutes les communes existent en normale ET en reverse, et
    chacune se possede a part.

Ce qui vit ou
-------------
Le catalogue n'est pas en base : c'est une matiere du site, comme les noms
des cartes Yu-Gi-Oh, ecrite par la mise a jour du stock (voir
pokemon_stock.py) sous static/pokemon/ :

    blocs.json                 l'ordre des blocs et des series
    series/<serie>.json        les cartes d'une serie
    pokedex.json               le nom de chaque Pokemon, par numero (voir
                               « le Pokedex » plus bas)
    Cartes/<bloc>/<serie>/     les images en grand  (hors du depot)
    Vignettes/<bloc>/<serie>/  les memes, a la taille d'une pochette
    Logos/<serie>.webp         le logo de chaque serie

La base ne garde que ce qui est a chacun : les versions possedees, et le
format de son classeur (voir la migration POKEMON dans comptes.py). Une
ligne presente = une version possedee ; il n'y a pas de pochette vide a
recopier pour chaque compte comme dans le classeur Yu-Gi-Oh.
"""

from __future__ import annotations

import bisect
import json
import os
import re
import threading
import unicodedata
from collections import Counter
from pathlib import Path

from flask import Blueprint, redirect, request

import comptes
from comptes import Refus, actuel, corps, cx, echec, maintenant, reponse

PROJET = "pokemon"

# Les versions, dans l'ordre ou la page les montre. La lettre est ce que la
# base et les reponses portent : une carte en a souvent deux ou trois, et
# « NR » se lit aussi bien que ["normale", "reverse"] pour dix fois moins.
VERSIONS = ("N", "R", "H", "E", "W")
NOMS_VERSIONS = {"N": "Normale", "R": "Reverse", "H": "Holo",
                 "E": "1re edition", "W": "Promo W"}

# Les raretes, de la plus courante a la plus rare, telles que pokemon_stock
# les ecrit : c'est l'ordre du filtre de la page. Une rarete absente d'ici
# (venue telle quelle de TCGdex) passe a la fin, par ordre alphabetique.
ORDRE_RARETES = (
    "Commune", "Peu commune", "Rare", "Rare Holo", "Rare Holo NIV.X", "Rare Prime",
    "LÉGENDE", "Rare Holo V", "Rare Holo VMAX", "Rare Holo VSTAR", "Double rare",
    "Ultra rare", "Illustration rare", "Illustration spéciale rare", "Hyper rare",
    "Méga hyper rare", "Rare Méga Attaque", "HIGH-TECH rare", "Magnifique", "Radieux",
    "Rare secrète", "Chromatique rare", "Chromatique rare V", "Chromatique rare VMAX",
    "Chromatique ultra rare", "Rare Noir & Blanc", "Collection classique",
    "Dresseur Full Art", "Pikachu rare", "Rare futuriste", "Rare RGB", "Promo",
    "Sans rareté",
)

# Ou vit le catalogue : pose par branche(), comme collection.py.
DOSSIER = None              # static/pokemon
URL = "/static/pokemon/"

# Un identifiant de serie ou de bloc vient du navigateur. TCGdex en a de
# toutes les formes -- « sv01 », « sv10.5b », « 30th-c », « 2019sm-fr » --
# mais jamais de barre oblique ni de point-point : on refuse tout le reste
# avant meme de chercher, puisque ces noms finissent dans des chemins.
IDENTIFIANT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")

RECHERCHE_MAXI = 30
FAVORITES_MAXI = 3
VERSIONS_MAXI = 60000       # par export : garde-fou, pas une limite du jeu

_catalogue = None
_verrou = threading.Lock()


def branche(dossier, url_publique="/static/pokemon/"):
    """Dit au module ou vit le catalogue, et rend le blueprint."""
    global DOSSIER, URL, _catalogue
    DOSSIER = Path(dossier)
    URL = url_publique if url_publique.endswith("/") else url_publique + "/"
    _catalogue = None
    return blueprint_pokemon


def chemins() -> dict:
    """Les dossiers du catalogue. Une seule source : pokemon_stock.py ecrit
    exactement la ou ce module lit."""
    d = DOSSIER or Path("static/pokemon")
    return {"blocs": d / "blocs.json", "series": d / "series", "cartes": d / "Cartes",
            "vignettes": d / "Vignettes", "logos": d / "Logos", "pokedex": d / "pokedex.json"}


def normalise(v) -> str:
    """Accents retires, minuscules, et ce qui n'est ni lettre ni chiffre
    devient une espace -- meme cle que normalise_nom dans collection.py."""
    s = unicodedata.normalize("NFD", str(v or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = s.replace("œ", "oe").replace("æ", "ae")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def fichier_de(numero) -> str:
    """Le nom de fichier de l'image d'une carte : son numero, sans ce qui
    poserait probleme dans une adresse ou sur un disque.

    « 001 » -> « 001.webp », mais les Zarbi d'EX Forces Cachees portent « ! »
    et « ? » pour numeros : un « ? » dans une adresse ouvre sa requete. Tout
    ce qui n'est pas lettre, chiffre, tiret ou souligne s'ecrit donc par son
    code (« _3f »), ce qui garde les noms distincts deux a deux.
    """
    return re.sub(r"[^A-Za-z0-9-]", lambda m: "_%02x" % ord(m.group()), str(numero)) + ".webp"


# --------------------------------------------------------------------------
#   Le catalogue
# --------------------------------------------------------------------------
def _lit(chemin, defaut):
    try:
        with open(chemin, encoding="utf-8") as f:
            charge = json.load(f)
    except (OSError, ValueError):
        return defaut
    return charge if isinstance(charge, type(defaut)) else defaut


def _presentes(dossier) -> set:
    try:
        return {f for f in os.listdir(dossier) if f.endswith(".webp")}
    except OSError:
        return set()


def _construit() -> dict:
    """Le catalogue tel que les routes le servent, lu une fois sur le disque.

    Une serie citee par blocs.json mais dont le fichier manque, ou illisible,
    est sautee : mieux vaut un bloc qui en compte une de moins qu'une page
    qui ne s'ouvre plus. Les images sont celles qui sont reellement la --
    une carte dont le telechargement a echoue part sans, et la page affiche
    son nom plutot qu'une image qui ne viendra pas.
    """
    c = chemins()
    brut = _lit(c["blocs"], {})
    logos = _presentes(c["logos"])
    officiels = [str(n) for n in _lit(c["pokedex"], {}).get("pokemon") or []]
    par_nom = {}
    for n, nom in enumerate(officiels, 1):
        par_nom.setdefault(normalise(nom), n)
    blocs, series, index, liste = [], {}, {}, []
    pokedex = {}
    for b in brut.get("blocs") or []:
        if not isinstance(b, dict) or not IDENTIFIANT.match(str(b.get("id") or "")):
            continue
        ids = []
        for sid in b.get("series") or []:
            sid = str(sid)
            if not IDENTIFIANT.match(sid) or sid in series:
                continue
            s = _lit(c["series"] / f"{sid}.json", {})
            cartes = [l for l in s.get("cartes") or []
                      if isinstance(l, list) and len(l) >= 4 and isinstance(l[0], str)]
            if not cartes:
                continue
            vignettes = _presentes(c["vignettes"] / b["id"] / sid)
            serie = {
                "id": sid, "nom": s.get("nom") or sid, "bloc": b["id"],
                "date": s.get("date") or "", "officiel": s.get("officiel") or 0,
                "sigle": s.get("sigle") or "",
                "logo": f"{sid}.webp" in logos,
                "cartes": cartes,
                "numeros": {l[0]: i for i, l in enumerate(cartes)},
                "images": {l[0] for l in cartes if fichier_de(l[0]) in vignettes},
                "anglaises": set(s.get("images_en") or []),
                "sans_image": len(s.get("sans_image") or []),
            }
            serie["versions"] = sum(len(versions_de(l)) for l in cartes)
            series[sid] = serie
            ids.append(sid)
            for i, l in enumerate(cartes):
                index[f"{sid}-{l[0]}"] = (sid, i)
                liste.append((normalise(l[1]), sid, i))
                for n in numeros_de(l, par_nom):
                    pokedex.setdefault(n, []).append((sid, i))
        if ids:
            blocs.append({"id": b["id"], "nom": b.get("nom") or b["id"],
                          "date": b.get("date") or "", "series": ids})
    cat = {"blocs": blocs, "series": series, "index": index, "liste": liste}
    cat.update(_range_pokedex(pokedex, series, blocs, officiels))
    return cat


def catalogue() -> dict:
    """Le catalogue, construit au premier besoin et garde ensuite."""
    global _catalogue
    if _catalogue is None:
        with _verrou:
            if _catalogue is None:
                _catalogue = _construit()
    return _catalogue


def oublie_catalogue() -> None:
    """A appeler quand le stock a change : la prochaine lecture relit tout."""
    global _catalogue
    _catalogue = None


def versions_de(l) -> str:
    """Ce qu'on range d'une carte du catalogue, dans l'ordre de VERSIONS :
    la carte elle-meme, et sa reverse quand elle en a une.

    TCGdex en distingue davantage -- holo, 1re edition, promo W -- mais la
    page ne propose que « Possedee » et « Reverse » : cinq cases par carte,
    dont trois que personne ne cochait, noyaient les deux qui comptent. La
    jauge, le master set et les pochettes par version suivent d'eux-memes.

    La carte elle-meme garde la lettre de sa premiere version hors reverse :
    « N » le plus souvent, « H » pour une carte qui n'existe qu'en holo --
    c'est ce qui lui donne son reflet. Une carte qui n'existe qu'en reverse
    n'a que celle-la ; une carte dont TCGdex ne dit rien existe au moins en
    normale : sans ca, elle n'aurait aucune pochette a remplir.
    """
    v = str(l[3] or "")
    carte = next((x for x in VERSIONS if x != "R" and x in v), "")
    if not carte:
        return "R" if "R" in v else "N"
    return "".join(x for x in VERSIONS if x == carte or (x == "R" and x in v))


def serie_ou_refus(sid):
    s = catalogue()["series"].get(sid if isinstance(sid, str) else "")
    if s is None:
        raise Refus("serie", "Cette serie n'est pas au catalogue.", 404)
    return s


# --------------------------------------------------------------------------
#   Pages
# --------------------------------------------------------------------------
def page_de(pseudo):
    return cx().execute(
        "SELECT p.*, u.pseudo FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE u.pseudo_norm = ? AND p.projet = ?",
        (comptes.normalise(pseudo), PROJET)).fetchone()


def ma_page(u):
    if u is None:
        return None
    return cx().execute(
        "SELECT p.*, u.pseudo FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE p.utilisateur_id = ? AND p.projet = ?", (u["id"], PROJET)).fetchone()


def cree_page(u):
    """Cree la collection de `u`. Rien a recopier : le catalogue est le meme
    pour tout le monde, et ce qui est a chacun commence vide."""
    c = cx()
    with c:
        c.execute("INSERT OR IGNORE INTO page(utilisateur_id, projet, titre, cree_le)"
                  " VALUES(?,?,?,?)",
                  (u["id"], PROJET, f"Collection de {u['pseudo']}", maintenant()))
    return ma_page(u)


def possedees(page_id, sid=None) -> dict:
    """{ (serie, numero) -> « NR » } : les versions possedees, dans l'ordre
    de VERSIONS. Toute la collection, ou une serie."""
    if sid is None:
        lignes = cx().execute("SELECT serie, carte, version FROM pokemon_carte WHERE page_id = ?",
                              (page_id,))
    else:
        lignes = cx().execute("SELECT serie, carte, version FROM pokemon_carte"
                              " WHERE page_id = ? AND serie = ?", (page_id, sid))
    brut = {}
    for l in lignes:
        brut.setdefault((l["serie"], l["carte"]), set()).add(l["version"])
    return {k: "".join(v for v in VERSIONS if v in vs) for k, vs in brut.items()}


def compte(page_id) -> int:
    """Le nombre de cartes possedees -- une carte, quelle qu'en soit la
    version : c'est le chiffre de l'annuaire, comme pour le classeur
    Yu-Gi-Oh. Une version d'une carte sortie du catalogue ne compte pas."""
    series = catalogue()["series"]
    return sum(1 for (sid, num) in possedees(page_id)
               if sid in series and num in series[sid]["numeros"])


def annuaire():
    """Les collections publiques, avec leur nombre de cartes."""
    lignes = cx().execute(
        "SELECT p.id, u.pseudo, u.avatar, u.avatar_maj_le, u.banniere, u.banniere_maj_le,"
        " p.titre FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE p.projet = ? AND p.visibilite = 'publique' ORDER BY u.pseudo",
        (PROJET,)).fetchall()
    sortie = [{"pseudo": l["pseudo"], "titre": l["titre"] or f"Collection de {l['pseudo']}",
               "cartes": compte(l["id"]), "avatar": comptes.url_avatar(l),
               "banniere": comptes.url_banniere(l)} for l in lignes]
    sortie.sort(key=lambda x: (-x["cartes"], x["pseudo"].lower()))
    return sortie


# --------------------------------------------------------------------------
#   Le format du classeur
# --------------------------------------------------------------------------
# Pochettes par face, en colonnes et en rangees, pages par classeur, et une
# pochette par version ou par carte : de quoi faire du classeur a l'ecran
# celui qu'on a sur l'etagere. Les classeurs Pokemon vont de quatre a douze
# pochettes par face, d'ou les bornes.
#
# `pages` vide : le classeur a juste la taille de sa serie. C'est le defaut,
# et la difference avec le Yu-Gi-Oh -- une serie de trente cartes dans un
# classeur de trente pages, ce seraient vingt-huit pages blanches. Un nombre
# coupe la serie en autant de classeurs qu'il faut, et le dernier garde ses
# pages vides, comme sur l'etagere.
#
# `versions` : une pochette par version (le « master set » des
# collectionneurs, la reverse a cote de la normale) plutot qu'une par carte.
FORMAT_DEFAUT = {"colonnes": 3, "rangees": 3, "pages": None, "versions": False}
FORMAT_BORNES = {"colonnes": (2, 4), "rangees": (2, 4), "pages": (5, 100)}
FORMAT_MOTS = {"colonnes": "colonnes", "rangees": "rangees", "pages": "pages"}


def _entier_borne(cle, v) -> bool:
    bas, haut = FORMAT_BORNES[cle]
    return isinstance(v, int) and not isinstance(v, bool) and bas <= v <= haut


def format_sur(f) -> dict:
    """Un format complet. Ce qui manque ou sort des bornes retombe sur le
    defaut -- une base ecrite a la main, une version future."""
    sortie = dict(FORMAT_DEFAUT)
    if isinstance(f, dict):
        for cle in ("colonnes", "rangees", "pages"):
            if _entier_borne(cle, f.get(cle)):
                sortie[cle] = f[cle]
        if isinstance(f.get("versions"), bool):
            sortie["versions"] = f["versions"]
    return sortie


def formats(page_id) -> dict:
    """{ serie -> format } ; la serie '' porte le format par defaut."""
    sortie = {}
    for l in cx().execute("SELECT serie, format FROM pokemon_format WHERE page_id = ?",
                          (page_id,)):
        try:
            sortie[l["serie"]] = format_sur(json.loads(l["format"]))
        except (ValueError, TypeError):
            continue
    return sortie


def format_de(page_id, sid) -> dict:
    f = formats(page_id)
    return f.get(sid) or f.get("") or dict(FORMAT_DEFAUT)


def format_propre(d) -> dict:
    """Le format d'une ecriture. Les colonnes et les rangees sont exigees ;
    des pages vides veulent dire « a la taille de la serie »."""
    propre = {}
    for cle in ("colonnes", "rangees"):
        v = d.get(cle)
        if not _entier_borne(cle, v):
            bas, haut = FORMAT_BORNES[cle]
            raise Refus(cle, f"Entre {bas} et {haut} {FORMAT_MOTS[cle]}.", 400)
        propre[cle] = v
    pages = d.get("pages")
    if pages in (None, "", 0):
        propre["pages"] = None
    elif _entier_borne("pages", pages):
        propre["pages"] = pages
    else:
        bas, haut = FORMAT_BORNES["pages"]
        raise Refus("pages", f"Entre {bas} et {haut} pages, ou automatique.", 400)
    propre["versions"] = d.get("versions") is True
    return propre


def enregistre_format(page, sid, d, partout=False) -> dict:
    """Le format d'une serie, ou de toutes (`partout`) : celui par defaut
    est alors remplace, et les formats propres a une serie s'effacent --
    « pour toutes les series » ne doit pas en oublier une."""
    propre = format_propre(d)
    c = cx()
    with c:
        if partout:
            c.execute("DELETE FROM pokemon_format WHERE page_id = ?", (page["id"],))
            if propre != FORMAT_DEFAUT:
                c.execute("INSERT INTO pokemon_format(page_id, serie, format) VALUES(?,?,?)",
                          (page["id"], "", json.dumps(propre)))
        else:
            c.execute("INSERT OR REPLACE INTO pokemon_format(page_id, serie, format)"
                      " VALUES(?,?,?)", (page["id"], sid, json.dumps(propre)))
    return propre


# --------------------------------------------------------------------------
#   Lecture
# --------------------------------------------------------------------------
def adresses() -> dict:
    """Les adresses des images, dites une fois par reponse : une carte ne
    porte que son nom de fichier, la page colle le reste devant."""
    return {"images": URL + "Cartes/", "vignettes": URL + "Vignettes/",
            "logos": URL + "Logos/"}


def vue_ensemble(page, u) -> dict:
    """Tous les blocs, leurs series, et ce qu'on en possede : l'ecran
    d'arrivee. Les plus recents d'abord, blocs comme series -- c'est ce
    qu'on collectionne en ce moment qu'on vient chercher."""
    cat = catalogue()
    a_moi = possedees(page["id"])
    par_serie = {}
    for (sid, num), vs in a_moi.items():
        s = cat["series"].get(sid)
        if s is None or num not in s["numeros"]:
            continue
        cartes, versions = par_serie.get(sid, (0, 0))
        attendues = versions_de(s["cartes"][s["numeros"][num]])
        par_serie[sid] = (cartes + 1, versions + sum(1 for v in vs if v in attendues))
    blocs = []
    for b in reversed(cat["blocs"]):
        series = []
        for sid in reversed(b["series"]):
            s = cat["series"][sid]
            cartes, versions = par_serie.get(sid, (0, 0))
            series.append({"id": sid, "nom": s["nom"], "date": s["date"],
                           "sigle": s["sigle"], "officiel": s["officiel"],
                           "total": len(s["cartes"]), "versions": s["versions"],
                           "logo": s["logo"], "possedees": cartes,
                           "versions_possedees": versions})
        blocs.append({"id": b["id"], "nom": b["nom"], "date": b["date"], "series": series})
    return {
        "ok": True,
        "pseudo": page["pseudo"],
        "titre": page["titre"] or f"Collection de {page['pseudo']}",
        # calcule a chaque requete : c'est la reponse a « est-ce que CE
        # visiteur peut ecrire », pas une propriete de la collection
        "write": u is not None and u["id"] == page["utilisateur_id"],
        "blocs": blocs,
        **adresses(),
    }


def ligne_de(s, l, a_moi) -> list:
    """Une carte telle que la page la recoit :

        [numero, nom, rarete, versions, categorie, fichier, possedees]

    Un petit tableau et non un objet, pour la meme raison que le classeur
    Yu-Gi-Oh : trois cents cartes, ce sont trois cents fois les memes noms
    de champs a ne pas repeter. `fichier` vaut null quand l'image n'est pas
    sur le disque.
    """
    return [l[0], l[1], l[2] or "", versions_de(l), l[4] if len(l) > 4 else "",
            fichier_de(l[0]) if l[0] in s["images"] else None,
            a_moi.get((s["id"], l[0]), "")]


def vue_serie(page, u, sid) -> dict:
    """Une serie, ses cartes dans l'ordre de leur numero, et ce qu'on en a."""
    cat = catalogue()
    s = serie_ou_refus(sid)
    bloc = next((b for b in cat["blocs"] if b["id"] == s["bloc"]), {"nom": s["bloc"]})
    a_moi = possedees(page["id"], sid)
    presentes = {l[2] for l in s["cartes"] if l[2]}
    raretes = [r for r in ORDRE_RARETES if r in presentes] \
        + sorted(presentes - set(ORDRE_RARETES))
    return {
        "ok": True,
        "raretes": raretes,
        "serie": {"id": s["id"], "nom": s["nom"], "bloc": s["bloc"], "bloc_nom": bloc["nom"],
                  "date": s["date"], "sigle": s["sigle"], "officiel": s["officiel"],
                  "logo": s["logo"]},
        "dossier": f"{s['bloc']}/{s['id']}/",
        "cartes": [ligne_de(s, l, a_moi) for l in s["cartes"]],
        "format": format_de(page["id"], sid),
        "write": u is not None and u["id"] == page["utilisateur_id"],
        **adresses(),
    }


def export(page, ids) -> dict:
    """Les series demandees (toutes si `ids` est vide), avec ce qu'on en a :
    la page en fait un JSON ou un CSV, comme l'export du classeur Yu-Gi-Oh."""
    cat = catalogue()
    a_moi = possedees(page["id"])
    noms_blocs = {b["id"]: b["nom"] for b in cat["blocs"]}
    voulues = [i for i in ids if i in cat["series"]] if ids else \
        [sid for b in reversed(cat["blocs"]) for sid in reversed(b["series"])]
    sortie, n = [], 0
    for sid in voulues:
        s = cat["series"][sid]
        n += len(s["cartes"])
        if n > VERSIONS_MAXI:
            break
        sortie.append({"id": sid, "nom": s["nom"], "bloc": noms_blocs.get(s["bloc"], s["bloc"]),
                       "officiel": s["officiel"],
                       "cartes": [[l[0], l[1], l[2] or "", versions_de(l),
                                   a_moi.get((sid, l[0]), "")] for l in s["cartes"]]})
    return {"ok": True, "series": sortie}


# --------------------------------------------------------------------------
#   Ecriture
# --------------------------------------------------------------------------
def ma_page_ou_refus():
    u = actuel()
    if u is None:
        raise Refus("connexion", "Connecte-toi sur Abyss pour modifier ta collection.", 401)
    page = ma_page(u)
    if page is None:
        raise Refus("page", "Tu n'as pas encore de collection.", 404)
    return u, page


def carte_ou_refus(sid, numero):
    s = serie_ou_refus(sid)
    if not isinstance(numero, str) or numero not in s["numeros"]:
        raise Refus("carte", "Cette carte n'est pas dans cette serie.", 404)
    return s, s["cartes"][s["numeros"][numero]]


CHANGEMENTS_MAXI = 500     # par envoi : un ecran de coches, largement


def pose(page, sid, numero, version, a_moi, valider=True) -> str:
    """Ajoute une version a la collection, ou l'en retire. Rend les versions
    possedees de la carte apres coup.

    N'importe laquelle des cinq versions est acceptee, et pas seulement
    celles que versions_de donne pour cette carte : la page n'en propose
    plus d'autres, mais une version deja rangee doit toujours pouvoir se
    retirer, et le serveur n'a pas a refuser ce qui existe en main.

    Rejouable : poser ce qui est deja la, ou retirer ce qui n'y est plus,
    ne change rien et ne leve rien -- deux clics rapides sur la meme
    pastille ne doivent pas finir en erreur.

    Pas de commit ici quand `valider` est faux : pose_lot fait passer tout
    un envoi d'un coup.
    """
    if version not in VERSIONS:
        raise Refus("version", "Version inconnue.")
    carte_ou_refus(sid, numero)
    c = cx()
    with (c if valider else _sans_commit()):
        if a_moi:
            c.execute("INSERT OR IGNORE INTO pokemon_carte(page_id, serie, carte, version, maj_le)"
                      " VALUES(?,?,?,?,?)", (page["id"], sid, numero, version, maintenant()))
        else:
            c.execute("DELETE FROM pokemon_carte WHERE page_id = ? AND serie = ?"
                      " AND carte = ? AND version = ?", (page["id"], sid, numero, version))
    vs = {l["version"] for l in c.execute(
        "SELECT version FROM pokemon_carte WHERE page_id = ? AND serie = ? AND carte = ?",
        (page["id"], sid, numero))}
    return "".join(v for v in VERSIONS if v in vs)


class _sans_commit:
    """Un « with » qui ne valide rien : c'est l'appelant qui le fera."""
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def pose_lot(page, changements) -> list:
    """Plusieurs versions d'un coup, toutes ou aucune. Rend les versions
    possedees de chaque carte touchee, dans l'ordre ou elles arrivent.

    C'est ainsi que la page ecrit : elle groupe les coches et les envoie au
    plus deux fois par seconde. Une requete par pastille butait sur la limite
    que Nginx met a /api/ (deux par seconde, quarante d'avance) des qu'on
    cochait une serie entiere a la suite -- et c'est exactement ce que la
    grille est faite pour.

    Tout est verifie avant d'ecrire : un changement refuse n'en laisse pas
    passer la moitie.
    """
    if not isinstance(changements, list) or not changements:
        raise Refus("changements", "Aucune carte a ranger.")
    if len(changements) > CHANGEMENTS_MAXI:
        raise Refus("changements", "Trop de cartes d'un coup.")
    propres = []
    for d in changements:
        if not isinstance(d, dict):
            raise Refus("changements", "Changement illisible.")
        sid, numero, version = d.get("serie"), d.get("carte"), d.get("version")
        if version not in VERSIONS:
            raise Refus("version", "Version inconnue.")
        carte_ou_refus(sid, numero)
        propres.append((sid, numero, version, d.get("possede") is True))
    c = cx()
    touchees = []
    try:
        for sid, numero, version, a_moi in propres:
            pose(page, sid, numero, version, a_moi, valider=False)
            if (sid, numero) not in touchees:
                touchees.append((sid, numero))
        c.commit()
    except Exception:
        c.rollback()
        raise
    sortie = []
    for sid, numero in touchees:
        vs = {l["version"] for l in c.execute(
            "SELECT version FROM pokemon_carte WHERE page_id = ? AND serie = ? AND carte = ?",
            (page["id"], sid, numero))}
        sortie.append({"serie": sid, "carte": numero,
                       "possedees": "".join(v for v in VERSIONS if v in vs)})
    return sortie


# --------------------------------------------------------------------------
#   Chercher une carte, les favorites
# --------------------------------------------------------------------------
def carte_publique(sid, i) -> dict:
    """Une carte du catalogue, pour la recherche et les favorites."""
    s = catalogue()["series"][sid]
    l = s["cartes"][i]
    image = (URL + "Vignettes/" + f"{s['bloc']}/{sid}/" + fichier_de(l[0])
             if l[0] in s["images"] else None)
    return {"id": f"{sid}-{l[0]}", "serie": sid, "serie_nom": s["nom"], "sigle": s["sigle"],
            "numero": l[0], "officiel": s["officiel"], "nom": l[1], "rarete": l[2] or "",
            "versions": versions_de(l), "image": image}


def cherche(texte) -> list:
    """Les cartes dont le nom contient tous les mots tapes. Le nom exact
    d'abord, puis ceux qui commencent par la saisie, puis les autres ; a rang
    egal, la serie la plus recente -- Pikachu existe en deux cents cartes,
    et c'est d'habitude la derniere qu'on cherche.

    Un mot qui n'est pas dans le nom peut designer la serie, par son nom ou
    son sigle : « pikachu 151 », « dracaufeu obf ».
    """
    mots = normalise(texte).split()
    if not mots:
        return []
    cat = catalogue()
    rang_serie = {sid: k for k, sid in enumerate(
        sid for b in cat["blocs"] for sid in b["series"])}
    saisie = " ".join(mots)
    trouvees = []
    for cle, sid, i in cat["liste"]:
        reste = [m for m in mots if m not in cle]
        if not reste:
            rang = 0 if cle == saisie else 1 if cle.startswith(saisie) else 2
        else:
            # au moins un mot dans le nom : sans ca, « 151 » sortirait les
            # cent soixante-cinq cartes de la serie
            if len(reste) == len(mots):
                continue
            s = cat["series"][sid]
            serie = normalise(" ".join((s["nom"], s["sigle"], sid)))
            if not all(m in serie for m in reste):
                continue
            rang = 3
        trouvees.append((rang, -rang_serie.get(sid, 0), i, sid))
    trouvees.sort()
    return [carte_publique(sid, i) for _, _, i, sid in trouvees[:RECHERCHE_MAXI]]


def favorites(page) -> list:
    """Les favorites d'une collection, dans l'ordre choisi. Une carte sortie
    du catalogue est sautee plutot que de laisser un trou dans l'eventail."""
    try:
        ids = json.loads(page["favorites"] or "[]")
    except (ValueError, TypeError, IndexError, KeyError):
        ids = []
    index = catalogue()["index"]
    sortie = [carte_publique(*index[i]) for i in (ids if isinstance(ids, list) else [])
              if isinstance(i, str) and i in index]
    return sortie[:FAVORITES_MAXI]


def enregistre_favorites(page, ids) -> None:
    if not isinstance(ids, list):
        raise Refus("format", "Les favorites attendent une liste de cartes.", 400)
    index = catalogue()["index"]
    propres = []
    for i in ids:
        if not isinstance(i, str) or i not in index:
            raise Refus("carte", "Cette carte n'est pas dans le catalogue.", 400)
        if i not in propres:
            propres.append(i)
    if len(propres) > FAVORITES_MAXI:
        raise Refus("trop", f"{FAVORITES_MAXI} cartes favorites au plus.", 400)
    c = cx()
    with c:
        c.execute("UPDATE page SET favorites = ? WHERE id = ?",
                  (json.dumps(propres) if propres else None, page["id"]))


# --------------------------------------------------------------------------
#   Le Pokedex : chaque Pokemon, et toutes ses cartes
# --------------------------------------------------------------------------
# Une carte Pokemon porte le numero de son Pokemon au Pokedex national -- le
# `dexId` de TCGdex, 6e case des lignes de series/<serie>.json : de quoi
# retrouver les deux cents Pikachu, de serie en serie.
#
# Les noms viennent de pokedex.json : les noms francais officiels, tires de
# PokeAPI, un par numero et dans l'ordre. Un numero qu'il ne connait pas
# encore -- un Pokemon paru depuis -- prend le nom que ses cartes portent le
# plus souvent, sans son « -ex » ni son « V » (voir _nom_court).

# Le type d'une carte, tel que la page Pokemon le filtre, dans l'ordre de
# ses boutons. Les cles sont celles du jeu : « ex » (2003 et 2023) et « EX »
# (2012) sont deux mecaniques differentes.
FORMES = (
    ("normale", "Normales"), ("mega", "Méga"), ("ex", "ex"), ("EX", "EX"),
    ("GX", "GX"), ("V", "V"), ("VMAX", "VMAX"), ("VSTAR", "VSTAR"),
    ("TURBO", "TURBO"), ("NIVX", "NIV.X"), ("LEGENDE", "LÉGENDE"), ("prime", "Prime"),
    ("radieux", "Radieux"), ("etoile", "Étoile ☆"), ("prisme", "Prisme ◇"),
)

# Le type se lit dans le nom : « Dracaufeu-ex », « M-Dracaufeu EX »,
# « Pikachu VMAX ». Le premier motif qui repond l'emporte, d'ou l'ordre :
# une Mega-ex est une Mega, une carte a deux Pokemon « ... GX » une GX.
_MOTIFS_FORMES = tuple((cle, re.compile(motif, drapeaux)) for cle, motif, drapeaux in (
    ("VSTAR", r"(?:^|[\s-])VSTAR\b", 0),
    ("VMAX", r"(?:^|[\s-])VMAX\b", 0),
    ("V", r"(?:^|[\s-])V(?:-UNION)?(?=$|[\s)])", 0),
    ("GX", r"[\s-]GX\b", 0),
    ("TURBO", r"\sTURBO\b", 0),
    ("NIVX", r"\bNIV\.?\s?X\b", re.IGNORECASE),     # « Niv. 53 » est un niveau, pas un NIV.X
    ("LEGENDE", r"\bLÉGENDE\b", 0),
    ("mega", r"^(?:Méga|M)[-\s]", 0),                 # « M. Mime » n'en est pas une
    ("EX", r"[\s-]EX\b", 0),
    ("ex", r"[\s-]ex\b", 0),
    ("radieux", r"\sRadieux\b", 0),
    ("etoile", r"☆", 0),
    ("prisme", r"◇", 0),
))
# ... et dans la rarete, quand le nom n'en dit rien : les Prime ont un nom
# ordinaire, et quelques V ou NIV.X ont perdu leur suffixe chez TCGdex.
_FORMES_PAR_RARETE = {
    "Rare Holo V": "V", "Rare Holo VMAX": "VMAX", "Rare Holo VSTAR": "VSTAR",
    "Rare Holo NIV.X": "NIVX", "LÉGENDE": "LEGENDE", "Rare Prime": "prime", "Radieux": "radieux",
}

# Le portrait d'un Pokemon, dans la liste : sa carte la plus recente au
# cadre ordinaire, dont la page ne garde que l'illustration. Une carte
# illustration rare ou une ex couvre toute la carte -- son haut ne montre
# qu'un morceau du dessin.
_RARETES_PORTRAIT = {"Commune", "Peu commune", "Rare", "Rare Holo"}

_NOM_COURT = re.compile(r"[\s-]+(?:ex|EX|GX|V|VMAX|VSTAR|V-UNION|TURBO|Radieux|☆|◇|δ)$")


def forme_de(nom, rarete="") -> str:
    nom = str(nom or "")
    for cle, motif in _MOTIFS_FORMES:
        if motif.search(nom):
            return cle
    return _FORMES_PAR_RARETE.get(rarete or "", "normale")


def _numeros_cites(nom, par_nom) -> list:
    """Les Pokemon d'une carte qui en montre plusieurs : « Reshiram et
    Dracaufeu GX », « Arceus, Dialga et Palkia GX ». TCGdex n'en donne
    souvent qu'un numero ; les autres se retrouvent par leur nom, en
    otant un mot a la fin tant qu'il ne colle pas (« Raikou LÉGENDE (haut) »
    finit en « Raikou »)."""
    if not re.search(r",| et | & ", nom):
        return []
    sortie = []
    for morceau in re.split(r",\s*|\s+(?:et|&)\s+", nom):
        mots = normalise(morceau).split()
        essais = [mots, mots[1:]] if mots[:1] in (["mega"], ["m"]) else [mots]
        for essai in essais:
            n = next((par_nom[" ".join(essai[:k])] for k in range(len(essai), 0, -1)
                      if " ".join(essai[:k]) in par_nom), None)
            if n:
                sortie.append(n)
                break
    return sortie


def numeros_de(l, par_nom) -> list:
    """Les numeros au Pokedex d'une carte du catalogue : aucun pour un
    Dresseur ou une Energie, un d'habitude, plusieurs pour une carte a deux
    ou trois Pokemon. Le stock ecrit un nombre, ou une liste depuis le
    16/10/2026 (voir pokemon_stock._dex)."""
    d = l[5] if len(l) > 5 else None
    entier = lambda x: isinstance(x, int) and not isinstance(x, bool) and 0 < x < 10000
    nums = [d] if entier(d) else [x for x in d if entier(x)] if isinstance(d, list) else []
    if nums:
        for n in _numeros_cites(str(l[1]), par_nom):
            if n not in nums:
                nums.append(n)
    return nums


def _nom_court(nom) -> str:
    nom = re.sub(r"^(?:Méga|M)[-\s]", "", str(nom or "").strip())
    while _NOM_COURT.search(nom):
        nom = _NOM_COURT.sub("", nom)
    return nom


def _range_pokedex(pokedex, series, blocs, officiels) -> dict:
    """Le Pokedex du catalogue : pour chaque numero, ses cartes de la serie
    la plus recente a la plus ancienne, son nom et son portrait."""
    rang = {sid: k for k, sid in enumerate(sid for b in blocs for sid in b["series"])}
    noms, portraits = {}, {}
    for n, cartes in pokedex.items():
        cartes.sort(key=lambda x: (-rang[x[0]], x[1]))
        if n <= len(officiels):
            noms[n] = officiels[n - 1]
        else:
            seules = Counter(_nom_court(series[sid]["cartes"][i][1]) for sid, i in cartes
                             if len(numeros_de(series[sid]["cartes"][i], {})) == 1)
            noms[n] = (seules.most_common(1) or [(f"N° {n}", 0)])[0][0]
        portrait = None
        for sid, i in cartes:
            s, l = series[sid], series[sid]["cartes"][i]
            if l[0] not in s["images"]:
                continue
            chemin = f"{s['bloc']}/{sid}/{fichier_de(l[0])}"
            if l[2] in _RARETES_PORTRAIT and forme_de(l[1], l[2]) == "normale":
                portrait = chemin
                break
            portrait = portrait or chemin
        portraits[n] = portrait
    return {"pokedex": pokedex, "noms": noms, "portraits": portraits,
            "numeros_pokedex": sorted(pokedex)}


def vue_pokedex(page, u) -> dict:
    """Tous les Pokemon qui ont une carte, par numero, et combien on en a :

        [numero, nom, cartes, possedees, portrait]

    `portrait` est le chemin de la vignette sous `vignettes`, ou null."""
    cat = catalogue()
    a_moi = possedees(page["id"])
    series = cat["series"]
    pokemon = []
    for n in cat["numeros_pokedex"]:
        cartes = cat["pokedex"][n]
        miennes = sum(1 for sid, i in cartes if (sid, series[sid]["cartes"][i][0]) in a_moi)
        pokemon.append([n, cat["noms"][n], len(cartes), miennes, cat["portraits"][n]])
    return {"ok": True, "pokemon": pokemon, "vignettes": URL + "Vignettes/",
            "write": u is not None and u["id"] == page["utilisateur_id"]}


def vue_pokemon(page, u, n) -> dict:
    """Un Pokemon et toutes ses cartes, de la serie la plus recente a la
    plus ancienne. Une carte est la ligne d'une serie (voir ligne_de), plus
    sa serie et son type :

        [numero, nom, rarete, versions, categorie, fichier, possedees, serie, forme]
    """
    cat = catalogue()
    cartes = cat["pokedex"].get(n)
    if not cartes:
        raise Refus("pokemon", "Ce Pokemon n'a aucune carte au catalogue.", 404)
    a_moi = possedees(page["id"])
    series, lignes, formes = {}, [], Counter()
    for sid, i in cartes:
        s = cat["series"][sid]
        l = s["cartes"][i]
        forme = forme_de(l[1], l[2])
        formes[forme] += 1
        lignes.append(ligne_de(s, l, a_moi) + [sid, forme])
        if sid not in series:
            series[sid] = {"nom": s["nom"], "bloc": s["bloc"], "sigle": s["sigle"],
                           "officiel": s["officiel"], "date": s["date"]}
    numeros = cat["numeros_pokedex"]
    k = bisect.bisect_left(numeros, n)
    voisin = lambda j: [numeros[j], cat["noms"][numeros[j]]] if 0 <= j < len(numeros) else None
    return {
        "ok": True,
        "pokemon": {"numero": n, "nom": cat["noms"][n]},
        "precedent": voisin(k - 1), "suivant": voisin(k + 1),
        "cartes": lignes,
        "series": series,
        "formes": [[cle, nom, formes[cle]] for cle, nom in FORMES if formes[cle]],
        "write": u is not None and u["id"] == page["utilisateur_id"],
        **adresses(),
    }


# --------------------------------------------------------------------------
#   Les routes
# --------------------------------------------------------------------------
blueprint_pokemon = Blueprint("pokemon", __name__, url_prefix="/api/pokemon")


@blueprint_pokemon.before_request
def exige_json():
    """Meme parade CSRF que pour le classeur Yu-Gi-Oh : les ecritures sont
    en JSON.

    Reservee a l'administration pendant son chantier, la collection est
    ouverte depuis le 16/10/2026 aux memes conditions que le classeur
    Yu-Gi-Oh : une collection publique se lit sans compte, et chacun n'ecrit
    que dans la sienne (voir ma_page_ou_refus et _page_lisible). Le stock,
    lui, reste a l'administration : voir pokemon_stock.reserve.
    """
    if request.method in ("POST", "PUT", "PATCH") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    return None


@blueprint_pokemon.errorhandler(Refus)
def refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_pokemon.get("")
def liste():
    """L'annuaire : qui a une collection, et la mienne si elle existe."""
    u = actuel()
    mienne = ma_page(u)
    moi = None if mienne is None else {
        "pseudo": mienne["pseudo"], "cartes": compte(mienne["id"]),
        "avatar": comptes.url_avatar(u), "banniere": comptes.url_banniere(u),
    }
    return reponse({"ok": True, "classeurs": annuaire(), "connecte": u is not None,
                    # le pseudo du compte, collection ou pas : voir la meme
                    # cle dans collection.py
                    "compte": u["pseudo"] if u is not None else None,
                    # pour montrer le bouton du stock, et rien d'autre : le
                    # serveur ne s'en remet pas a la page (voir pokemon_stock)
                    "admin": u is not None and bool(u["admin"]),
                    "moi": moi})


@blueprint_pokemon.post("")
def creer():
    """Cree ma collection. Rejouable : renvoie l'existante plutot qu'une erreur."""
    u = actuel()
    if u is None:
        return echec("connexion", "Connecte-toi sur Abyss pour creer ta collection.", 401)
    page = ma_page(u) or cree_page(u)
    return reponse(vue_ensemble(page, u), 201)


# Les routes en dur avant /<pseudo> : Werkzeug les fait passer devant de
# toute facon, et « catalogue » et « favorites » sont des pseudos reserves
# (voir comptes.RESERVES).
@blueprint_pokemon.get("/catalogue")
def chercher():
    """Toutes les cartes dont le nom ressemble a ?q=. Ce n'est que le
    catalogue, rien de ce que chacun a."""
    return reponse({"ok": True, "cartes": cherche((request.args.get("q") or "")[:80])})


@blueprint_pokemon.get("/cardmarket")
def vers_cardmarket():
    """La page Cardmarket d'une carte, ?serie=sv01&carte=001 : une redirection.

    Le numero du produit vient de TCGdex, a la demande : voir « Cardmarket »
    dans pokemon_stock.py. Seule une carte du catalogue fait appeler TCGdex ;
    le reste repart sur l'accueil Pokemon de Cardmarket. Ouverte a tout le
    monde, comme le catalogue.
    """
    import pokemon_stock           # import tardif : pokemon_stock importe ce module
    cle = f"{request.args.get('serie') or ''}-{request.args.get('carte') or ''}"
    place = catalogue()["index"].get(cle)
    if place is None:
        return redirect(pokemon_stock.CARDMARKET, code=302)
    sid, i = place
    nom = catalogue()["series"][sid]["cartes"][i][1]
    return redirect(pokemon_stock.adresse_cardmarket(cle, nom), code=302)


@blueprint_pokemon.get("/favorites")
def lire_favorites():
    _, page = ma_page_ou_refus()
    return reponse({"ok": True, "cartes": favorites(page)})


@blueprint_pokemon.put("/favorites")
def poser_favorites():
    u, page = ma_page_ou_refus()
    enregistre_favorites(page, corps().get("cartes"))
    return reponse({"ok": True, "cartes": favorites(ma_page(u))})


@blueprint_pokemon.put("/cartes")
def poser():
    """Des versions de plus, ou de moins.
    { changements: [{ serie, carte, version, possede }] }

    La reponse ne porte que les cartes touchees : rien d'autre ne bouge, et
    renvoyer la serie entiere a chaque envoi serait un aller-retour de trop.
    """
    _, page = ma_page_ou_refus()
    return reponse({"ok": True, "cartes": pose_lot(page, corps().get("changements"))})


@blueprint_pokemon.put("/format")
def poser_format():
    """Le format d'une serie de ma collection, ou de toutes.
    { serie, colonnes, rangees, pages, versions, partout }"""
    _, page = ma_page_ou_refus()
    d = corps()
    partout = d.get("partout") is True
    sid = d.get("serie")
    if not partout:
        serie_ou_refus(sid)
    return reponse({"ok": True, "serie": sid, "partout": partout,
                    "format": enregistre_format(page, sid, d, partout)})


def _page_lisible(pseudo):
    """La collection de `pseudo`, si ce visiteur a le droit de la lire."""
    page = page_de(pseudo)
    if page is None:
        raise Refus("introuvable", "Cette collection n'existe pas.", 404)
    u = actuel()
    if page["visibilite"] != "publique" and (u is None or u["id"] != page["utilisateur_id"]):
        raise Refus("prive", "Cette collection est privee.", 403)
    return page, u


@blueprint_pokemon.get("/<pseudo>")
def lire(pseudo):
    page, u = _page_lisible(pseudo)
    return reponse(vue_ensemble(page, u))


@blueprint_pokemon.get("/<pseudo>/serie/<sid>")
def lire_serie(pseudo, sid):
    page, u = _page_lisible(pseudo)
    return reponse(vue_serie(page, u, sid))


@blueprint_pokemon.get("/<pseudo>/pokedex")
def lire_pokedex(pseudo):
    page, u = _page_lisible(pseudo)
    return reponse(vue_pokedex(page, u))


@blueprint_pokemon.get("/<pseudo>/pokedex/<int:n>")
def lire_pokemon(pseudo, n):
    page, u = _page_lisible(pseudo)
    return reponse(vue_pokemon(page, u, n))


@blueprint_pokemon.get("/<pseudo>/export")
def exporter(pseudo):
    """?series=sv01,sv02 -- ou rien, pour toute la collection."""
    page, _ = _page_lisible(pseudo)
    ids = [i for i in (request.args.get("series") or "").split(",") if IDENTIFIANT.match(i)]
    return reponse(export(page, ids))
