#!/usr/bin/env python3
"""Le classeur Yu-Gi-Oh, servi depuis la base au lieu de Google Sheets.

app.py branche ce fichier en une ligne :

    app.register_blueprint(collection.blueprint_collection)

Les tables `famille` et `carte` sont creees par comptes.py (migration 15) :
tout le schema du site tient dans une seule liste, parce que PRAGMA
user_version est un unique compteur pour toute la base.

Ce qui change par rapport aux feuilles
--------------------------------------
Meme bascule que le journal de jeux, et le meme gain. Une carte etait reperee
par « feuille + ligne + colonne » : ecrire demandait de renvoyer ces trois
coordonnees, et inserer une ligne dans le classeur Google decalait
silencieusement tout ce qui suivait. Elle porte maintenant un `id` qui ne
bouge jamais.

Le jeton disparait avec le script. La lecture reste ouverte a tout le monde
-- un classeur public se feuillette sans compte, comme un journal -- et
l'ecriture est reservee au proprietaire, reconnu par sa session Abyss. Il n'y
a plus de « mode editeur » a deverrouiller : ou c'est ton classeur, ou tu le
regardes.

Ce qui ne change pas, c'est la forme de la reponse. La page continue de
recevoir des `types` qui portent des `classeurs` qui portent des `cards`, et
une carte reste un petit tableau plutot qu'un objet -- deux mille cartes en
JSON, ce sont deux mille fois les memes quatre noms de champs a ne pas
repeter. Seules ses cases changent :

    [nom, rarete, etat, ligne, colonne]   <- le Sheet
    [nom, rarete, etat, id]               <- la base

`sheet` (le nom de la feuille Google) n'a plus d'objet et ne sort plus d'ici ;
`key` devient la colonne `cle`, qui garde exactement le meme role.
"""

from __future__ import annotations

import json
import os
import re
import threading
import unicodedata
from pathlib import Path

from flask import Blueprint, redirect, request, send_file

import comptes
from comptes import Refus, actuel, corps, cx, echec, maintenant, reponse

PROJET = "collection"

# Les raretes que la page propose, dans son ordre a elle (voir RARETES cote
# navigateur). Une ecriture qui en apporte une autre est refusee : la rarete
# decide de l'aspect de la pochette, et une valeur inconnue donnerait une
# carte sans reflet, ni commune ni rien.
RARETES = ("C", "R", "SR", "UR", "SE", "CR", "ULTI", "G", "GSE",
           "PG", "SPE", "PLAT", "STAR")

# 3 bon, 2 moyen, 1 mauvais -- comme ETATS cote page.
ETATS = (1, 2, 3)

# Une couleur d'onglet part dans un style="" de la page : on n'accepte que ce
# qui est vraiment une couleur, jamais un morceau de CSS. Meme garde-fou que
# COULEUR cote navigateur, qui la revalide de son cote -- la page se protege
# des classeurs des autres, et la base se protege de ce qu'on lui donne.
COULEUR = re.compile(r"^(#[0-9a-f]{3,8}|rgba?\([0-9\s.,%/]+\)|[a-z]{3,20})$", re.I)
COULEUR_DEFAUT = "#A086B7"

# Un garde-fou pose ici parce que c'est une regle du classeur et non de
# l'outil qui le remplit.
CARTES_MAXI = 20000        # par page : garde-fou contre un import qui s'emballe

# Un tome du classeur : 30 pages de 18 pochettes, comme PAGES_PAR_CLASSEUR et
# PER_PAGE cote page. Une carte ajoutee au bout d'un tome plein ouvre le
# suivant, exactement comme l'import l'a fait pour Fusion et Xyz.
CARTES_PAR_CLASSEUR = 30 * 18


# --------------------------------------------------------------------------
#   Les illustrations
# --------------------------------------------------------------------------
# Le fonds d'artworks est un dossier plat, un fichier par passcode, partage
# avec le quiz. Une carte du classeur ne connait que son nom : il faut donc
# passer par static/yugioh/cartes-fr.json, qui dit « passcode -> nom francais ».
#
# La page faisait ce travail elle-meme, et il lui coutait cher : 570 Ko de
# noms a telecharger avant de pouvoir afficher la moindre illustration, un
# index de quatorze mille entrees a normaliser dans le fil principal, puis
# une adresse tentee au hasard des extensions -- avec les 404 que ca suppose.
# Rien de tout ca ne dependait de qui regarde : c'est le meme index pour tout
# le monde, il se construit une fois ici et chaque carte part avec son
# fichier tout trouve.
#
# C'est la meme facon de faire que les jaquettes du journal, ou l'adresse de
# l'image se deduit d'un identifiant deja connu du serveur -- personne ne
# telecharge un catalogue pour afficher une vignette.
DOSSIER_CARTES = None      # poses par branche(), comme jaquettes.py
FICHIER_NOMS = None
# { passcode -> raretes parues }, ecrit par la mise a jour du stock (voir
# raretes_du_catalogue dans cartes.py). Meme detour que les illustrations :
# le fichier est range par passcode, une pochette ne connait que son nom.
FICHIER_RARETES = None
# { passcode -> nom anglais }, ecrit par la mise a jour du stock, lu pour la
# liste de souhaits Cardmarket (voir « les noms anglais » plus bas).
FICHIER_EN = None
URL_CARTES = "/static/yugioh/Cards/"

# --- les vignettes ---------------------------------------------------------
# Le fonds est fait pour etre regarde de pres : 813 x 1185 pixels, 160 Ko par
# carte. Une pochette du classeur en fait cent de large. Servir l'original y
# revenait a telecharger 2,8 Mo par double-page pour afficher dix-huit
# timbres-poste -- c'est ca, et rien d'autre, qui donnait au classeur son
# temps de chargement, meme une fois les donnees passees en base.
#
# Chaque artwork a donc une vignette, fabriquee au premier affichage et
# gardee sur le disque a cote du fonds. 320 pixels de large : de quoi rester
# net sur un ecran a forte densite, pour 23 Ko au lieu de 160.
#
# L'original ne disparait pas : c'est lui qu'on veut quand la carte s'ouvre
# en grand, et c'est la seule fois ou ses 813 pixels servent a quelque chose.
VIGNETTES = ".min"         # sous-dossier du fonds ; le point le range a part
VIGNETTE_LARGEUR = 320
VIGNETTE_QUALITE = 80
URL_VIGNETTES = "/api/collection/vignette/"
# Un nom de fichier vient du navigateur : on n'accepte que ce qui ressemble a
# un artwork, sans separateur ni point-point, avant meme de toucher au disque.
NOM_FICHIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.[A-Za-z0-9]{1,5}$")

_illustrations = None      # nom normalise -> nom de fichier ('12345678.jpg')
_raretes = None            # nom normalise -> [raretes parues]
_anglais = None            # (nom exact, nom normalise) -> [noms anglais]
_verrou = threading.Lock()


def normalise_nom(v) -> str:
    """La meme normalisation que norm() cote page : accents retires, tout en
    minuscules, et ce qui n'est ni lettre ni chiffre devient une espace.

    Les deux doivent coincider a la lettre pres : c'est par cette cle que le
    nom d'une carte retrouve son illustration.
    """
    s = unicodedata.normalize("NFD", str(v or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _construit_index() -> dict:
    """{ nom normalise -> fichier } pour les artworks reellement presents.

    Un passcode sans fichier n'entre pas dans l'index : mieux vaut une
    pochette qui affiche le nom de la carte qu'une image qui ne viendra
    jamais. Le premier nom gagne, comme cote page : deux cartes homonymes
    partagent leur illustration, ce qui a toujours ete le cas.
    """
    if not DOSSIER_CARTES or not FICHIER_NOMS:
        return {}
    try:
        with open(FICHIER_NOMS, encoding="utf-8") as f:
            noms = json.load(f)
        fichiers = {}
        for f in os.listdir(DOSSIER_CARTES):
            base, point, ext = f.rpartition(".")
            if point and base not in fichiers:
                fichiers[base] = f
    except OSError:
        # pas d'artworks sous la main : les pochettes afficheront des noms
        return {}
    index = {}
    if isinstance(noms, dict):
        for passcode, nom in noms.items():
            fichier = fichiers.get(str(passcode))
            if not fichier:
                continue
            cle = normalise_nom(nom)
            if cle and cle not in index:
                index[cle] = fichier
    return index


def illustrations() -> dict:
    """L'index, construit au premier besoin et garde ensuite.

    Sous verrou : deux requetes simultanees au demarrage liraient le disque
    chacune de leur cote pour arriver au meme resultat.
    """
    global _illustrations
    if _illustrations is None:
        with _verrou:
            if _illustrations is None:
                _illustrations = _construit_index()
    return _illustrations


def oublie_illustrations() -> None:
    """A appeler si le fonds change en cours de route. Sert aux tests.

    Les trois index d'un coup : une mise a jour du stock pose des artworks,
    complete les noms et refait les raretes parues (voir ecrit() dans
    cartes.py), et les trois se lisent des memes fichiers.
    """
    global _illustrations, _raretes, _anglais
    _illustrations = None
    _raretes = None
    _anglais = None


# --- les raretes parues ----------------------------------------------------
# Une carte n'est pas parue dans toutes les raretes : le « Dragon Blanc aux
# Yeux Bleus » existe en Commune, en Ultra et en Secrete, jamais en Gold
# Secrete. Le panneau ne propose donc que ce qui existe.
#
# Une aide a la saisie, et non une serrure : ygoprodeck ignore des tirages
# qui existent bel et bien -- la Secrete de BLZD, la Starlight de TN23, la
# Secrete de L26D, verifiees contre l'API en direct et non contre le cache.
# Le panneau garde donc une entree « Autre rarete... » qui redeploie les
# treize, et rien ici ne refuse une rarete : rarete_propre continue
# d'accepter les treize codes du classeur.
#
# Ce qui est envoye a la page, ce sont des raretes par carte et non le
# fichier entier : il pese 550 Ko pour quatorze mille cartes, dont un
# classeur n'en montre que deux mille. C'est la meme economie que les
# illustrations, dont la page telechargeait autrefois tout l'index.
def _construit_raretes() -> dict:
    """{ nom normalise -> [raretes parues] }, dans l'ordre de RARETES."""
    if not FICHIER_RARETES or not FICHIER_NOMS:
        return {}
    try:
        with open(FICHIER_NOMS, encoding="utf-8") as f:
            noms = json.load(f)
        with open(FICHIER_RARETES, encoding="utf-8") as f:
            parues = json.load(f)
    except (OSError, ValueError):
        # Pas encore de fichier -- il nait de la premiere mise a jour du
        # stock : le panneau proposera les treize raretes, comme avant. Mieux
        # vaut ca qu'un classeur ou l'on ne peut plus rien ranger.
        return {}
    if not isinstance(noms, dict) or not isinstance(parues, dict):
        return {}
    brut = {}
    for passcode, nom in noms.items():
        codes = parues.get(str(passcode))
        cle = normalise_nom(nom)
        if not cle or not isinstance(codes, list):
            continue
        # Deux cartes homonymes mettent leurs raretes en commun, la ou elles
        # partagent deja leur illustration : garder celles de la premiere
        # seulement ferait refuser a la seconde ses propres tirages.
        brut.setdefault(cle, set()).update(c for c in codes if c in RARETES)
    return {cle: [r for r in RARETES if r in codes]
            for cle, codes in brut.items() if codes}


def raretes() -> dict:
    """L'index des raretes, construit au premier besoin et garde ensuite."""
    global _raretes
    if _raretes is None:
        with _verrou:
            if _raretes is None:
                _raretes = _construit_raretes()
    return _raretes


# --- les noms anglais ------------------------------------------------------
# Cardmarket ne connait les cartes Yu-Gi-Oh que sous leur nom anglais : une
# liste de souhaits collee en francais n'y trouverait rien. Le classeur, lui,
# ne connait que le nom francais -- meme detour par le passcode que les
# illustrations, avec static/yugioh/cartes-en.json en face.
#
# Deux cartes peuvent porter le meme nom francais, ou presque : « Sauvetage »
# (Salvage) et « SAUVETAGE ! » (RESCUE!) ne different que par ce que la
# normalisation efface. Le nom exact de la pochette passe donc en premier ;
# le nom normalise ne sert qu'a rattraper un accent ou une ponctuation ecrits
# autrement. Restent les noms vraiment identiques -- « Lutine a la Cle » est a
# la fois Key Mace et Key Mace #2, sans doute la meme erreur de fichier que
# « Crane Chevalier », qui nommait aussi Skull Knight #2 -- et la rien dans
# une pochette ne permet de trancher : les deux noms repartent ensemble, et
# la page les laisse hors des listes plutot que de parier sur l'un d'eux.
def _construit_anglais() -> tuple:
    """({ nom exact -> [noms anglais] }, { nom normalise -> [noms anglais] })."""
    if not FICHIER_EN or not FICHIER_NOMS:
        return {}, {}
    try:
        with open(FICHIER_NOMS, encoding="utf-8") as f:
            noms = json.load(f)
        with open(FICHIER_EN, encoding="utf-8") as f:
            anglais = json.load(f)
    except (OSError, ValueError):
        return {}, {}
    if not isinstance(noms, dict) or not isinstance(anglais, dict):
        return {}, {}
    exact, proche = {}, {}
    for passcode, nom in noms.items():
        en = anglais.get(str(passcode))
        if not isinstance(nom, str) or not isinstance(en, str) or not en.strip():
            continue
        for index, cle in ((exact, " ".join(nom.split())), (proche, normalise_nom(nom))):
            if not cle:
                continue
            deja = index.setdefault(cle, [])
            if en.strip() not in deja:
                deja.append(en.strip())
    return exact, proche


def anglais() -> tuple:
    """Les deux index des noms anglais, construits au premier besoin."""
    global _anglais
    if _anglais is None:
        with _verrou:
            if _anglais is None:
                _anglais = _construit_anglais()
    return _anglais


def vignette(fichier):
    """Le chemin de la vignette d'un artwork, fabriquee si elle manque.

    None quand rien ne peut etre fabrique -- fichier inconnu, Pillow absent,
    image illisible. L'appelant sert alors l'original : une carte un peu
    lourde vaut mieux qu'une pochette vide.
    """
    if not DOSSIER_CARTES or not NOM_FICHIER.match(fichier or ""):
        return None
    source = DOSSIER_CARTES / fichier
    if not source.is_file():
        return None
    cible = DOSSIER_CARTES / VIGNETTES / (source.stem + ".webp")
    if cible.is_file():
        return cible
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        cible.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as im:
            # draft() laisse le decodeur JPEG sauter des pixels qu'on allait
            # jeter : la fabrication est deux fois plus rapide pour le meme
            # resultat, l'image finale etant de toute facon reechantillonnee.
            im.draft("RGB", (VIGNETTE_LARGEUR * 2, VIGNETTE_LARGEUR * 2))
            im = im.convert("RGB")
            im.thumbnail((VIGNETTE_LARGEUR, VIGNETTE_LARGEUR * 3), Image.LANCZOS)
            # un fichier temporaire puis un renommage : deux requetes
            # simultanees sur la meme carte ne se marchent pas dessus, et
            # aucune vignette a moitie ecrite ne reste sur le disque
            temporaire = cible.with_suffix(".webp.%d" % os.getpid())
            im.save(temporaire, "WEBP", quality=VIGNETTE_QUALITE, method=4)
            os.replace(temporaire, cible)
    except (OSError, ValueError):
        return None
    return cible


def branche(dossier_cartes, fichier_noms, url_publique="/static/yugioh/Cards/",
            fichier_raretes=None) -> Blueprint:
    """Dit au module ou vivent les artworks, et rend le blueprint.

    Meme facon de faire que blueprint_jaquettes et quiz.branche : les chemins
    sont decides par app.py, pas ecrits en dur ici.

    Sans `fichier_raretes`, on le cherche a cote des noms : les deux sortent
    de la meme mise a jour et vivent dans le meme dossier. Les noms anglais
    aussi, toujours a cote -- cartes.py les ecrit la sans qu'on le lui dise.
    """
    global DOSSIER_CARTES, FICHIER_NOMS, FICHIER_RARETES, FICHIER_EN, URL_CARTES
    global _illustrations, _raretes, _anglais
    DOSSIER_CARTES = Path(dossier_cartes)
    FICHIER_NOMS = Path(fichier_noms)
    FICHIER_RARETES = (Path(fichier_raretes) if fichier_raretes
                       else FICHIER_NOMS.with_name("cartes-rarity.json"))
    FICHIER_EN = FICHIER_NOMS.with_name("cartes-en.json")
    URL_CARTES = url_publique if url_publique.endswith("/") else url_publique + "/"
    _illustrations = None
    _raretes = None
    _anglais = None
    return blueprint_collection


# --------------------------------------------------------------------------
#   Traduction base <-> page
# --------------------------------------------------------------------------
def en_json(l, index=None, parues=None) -> list:
    """Une ligne SQL vers la carte que collection/collection.html manipule.

    L'id en quatrieme case : c'est ce que la page renvoie pour ecrire, la ou
    elle renvoyait la ligne et la colonne du Sheet. Le fichier de
    l'illustration en cinquieme, sans son dossier -- il est le meme pour
    toutes, la page le remet (voir CARTES cote navigateur).

    En sixieme, les raretes sous lesquelles la carte est parue : c'est ce que
    le panneau propose d'emblee, « Autre rarete... » restant la pour les
    tirages qu'ygoprodeck ignore. `null` n'est pas une liste vide mais « le
    catalogue ne connait pas cette carte » -- la page propose alors les
    treize raretes plutot que d'interdire de la ranger.

    `index` et `parues` sont passes par contenu(), qui les a deja en main :
    les resoudre carte par carte referait deux mille fois la meme recherche
    de dictionnaire pour rien.
    """
    if index is None:
        index = illustrations()
    if parues is None:
        parues = raretes()
    cle = normalise_nom(l["nom"])
    return [l["nom"], l["rarete"], l["etat"], l["id"],
            index.get(cle), parues.get(cle)]


def couleur_sure(c) -> str:
    c = (c or "").strip()
    return c if COULEUR.match(c) else COULEUR_DEFAUT


def rarete_propre(v):
    """La rarete d'une ecriture. '' ou None = la carte quitte le classeur."""
    if v is None:
        return None
    v = str(v).strip().upper()
    if not v:
        return None
    if v not in RARETES:
        raise Refus("rarete", "Rarete inconnue.")
    return v


def etat_propre(v):
    """L'etat d'une ecriture, quand il y en a un.

    Une carte peut etre possedee sans qu'on ait dit dans quel etat elle est :
    c'est la case laissee vide du panneau, et elle reste vide.
    """
    if v is None or v == "":
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise Refus("etat", "Etat incorrect.")
    if n not in ETATS:
        raise Refus("etat", "Etat incorrect.")
    return n


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


def page_modele():
    """Le classeur qui sert de moule aux nouveaux. None s'il n'y en a aucun.

    Un classeur n'est pas une liste libre : ce sont les memes pochettes pour
    tout le monde -- toutes les Fusion, toutes les Synchro, dans le meme
    ordre -- et ce qui appartient a chacun, c'est ce qu'il a range dedans.
    Creer un classeur, c'est donc recopier ces pochettes, vides.

    Le moule est le classeur le plus complet parmi ceux qui existent : c'est
    lui qui a le plus de chances de contenir toutes les cartes parues, et il
    n'y a rien d'autre ici pour le dire -- la famille d'une carte (Fusion,
    Synchro...) ne se lit dans aucun des fichiers du site, elle vient de
    l'import qui a rempli le premier classeur.

    Un classeur prive fait un moule aussi valable qu'un public : ce qu'on y
    recopie, ce sont des noms de cartes et un ordre de rangement, jamais ce
    que quelqu'un possede. La rarete et l'etat ne sont pas copies.
    """
    return cx().execute(
        "SELECT p.id, COUNT(c.id) AS n FROM page p"
        " LEFT JOIN carte c ON c.page_id = p.id"
        " WHERE p.projet = ? GROUP BY p.id HAVING n > 0"
        " ORDER BY n DESC, p.id LIMIT 1", (PROJET,)).fetchone()


def cree_page(u):
    """Cree le classeur de `u`, avec les pochettes du moule, toutes vides.

    Sans moule -- premier classeur du site -- la page est creee quand meme,
    sans onglet : elle existe, elle est a son proprietaire, et le premier
    import la remplira. Mieux vaut un classeur vide qu'un refus qu'on ne
    saurait pas expliquer.
    """
    modele = page_modele()
    c = cx()
    with c:
        page_id = c.execute(
            "INSERT INTO page(utilisateur_id, projet, titre, cree_le) VALUES(?,?,?,?)",
            (u["id"], PROJET, f"Classeur de {u['pseudo']}", maintenant())).lastrowid
        if modele is not None:
            familles = c.execute(
                "SELECT * FROM famille WHERE page_id = ? ORDER BY rang, id",
                (modele["id"],)).fetchall()
            for f in familles:
                fid = c.execute(
                    "INSERT INTO famille(page_id, cle, label, couleur, rang)"
                    " VALUES(?,?,?,?,?)",
                    (page_id, f["cle"], f["label"], f["couleur"], f["rang"])).lastrowid
                # d'un seul SQL : recopier deux mille pochettes une par une
                # ferait deux mille allers-retours pour la meme chose
                c.execute(
                    "INSERT INTO carte(page_id, famille_id, classeur, rang, nom)"
                    " SELECT ?, ?, classeur, rang, nom FROM carte"
                    " WHERE page_id = ? AND famille_id = ?",
                    (page_id, fid, modele["id"], f["id"]))
    return ma_page(u)


def annuaire():
    """Les classeurs publics, avec leur nombre de cartes possedees.

    Possedees, et non emplacements : c'est le chiffre que la page affiche
    deja sous son compteur, et le seul qui dise quelque chose. Un classeur
    est une liste de pochettes dont la plupart sont vides -- les compter
    toutes ferait passer un classeur a peine commence pour une collection.
    """
    lignes = cx().execute(
        "SELECT u.id, u.pseudo, u.avatar, u.avatar_maj_le,"
        " u.banniere, u.banniere_maj_le, p.titre,"
        " COUNT(c.rarete) AS cartes"
        " FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " LEFT JOIN carte c ON c.page_id = p.id"
        " WHERE p.projet = ? AND p.visibilite = 'publique'"
        " GROUP BY p.id ORDER BY cartes DESC, u.pseudo", (PROJET,)).fetchall()
    return [{"pseudo": l["pseudo"], "titre": l["titre"] or f"Classeur de {l['pseudo']}",
             "cartes": l["cartes"], "avatar": comptes.url_avatar(l),
             "banniere": comptes.url_banniere(l)} for l in lignes]


def nb_cartes(page_id) -> int:
    """Le nombre de cartes possedees, comme dans l'annuaire."""
    return cx().execute("SELECT COUNT(rarete) FROM carte WHERE page_id = ?",
                        (page_id,)).fetchone()[0]


# --------------------------------------------------------------------------
#   Lecture
# --------------------------------------------------------------------------
def contenu(page, u) -> dict:
    """Le classeur complet, tel que la page l'attend.

    Deux requetes, pas une par onglet : les cartes arrivent toutes ensemble,
    deja triees, et sont reparties ici. Un classeur de deux mille cartes, ca
    reste une lecture sequentielle d'un index -- le tri du SQL est celui de
    idx_carte_page, donc il ne coute rien de plus.

    Les tomes (`classeur`) ne sont pas declares quelque part : ils existent
    parce que des cartes les portent. Un onglet sans aucune carte rend quand
    meme un tome vide, sinon la page n'aurait rien a dessiner et afficherait
    un classeur absent la ou il est seulement vide.
    """
    familles = cx().execute(
        "SELECT * FROM famille WHERE page_id = ? ORDER BY rang, id",
        (page["id"],)).fetchall()
    cartes = cx().execute(
        "SELECT * FROM carte WHERE page_id = ? ORDER BY famille_id, classeur, rang, id",
        (page["id"],)).fetchall()

    # famille_id -> { numero de tome -> cartes }
    index = illustrations()
    parues = raretes()
    par_famille = {f["id"]: {} for f in familles}
    for l in cartes:
        tomes = par_famille.get(l["famille_id"])
        if tomes is None:           # carte orpheline : la cascade l'interdit
            continue
        tomes.setdefault(l["classeur"], []).append(en_json(l, index, parues))

    types = []
    for f in familles:
        tomes = par_famille[f["id"]]
        types.append({
            "key": f["cle"],
            "label": f["label"],
            "color": couleur_sure(f["couleur"]),
            "classeurs": [{"n": n, "cards": tomes[n]} for n in sorted(tomes)]
                         or [{"n": 1, "cards": []}],
        })

    return {
        "ok": True,
        "pseudo": page["pseudo"],
        "titre": page["titre"] or f"Classeur de {page['pseudo']}",
        # les deux adresses des artworks, dites une fois plutot que deux
        # mille : la page les colle devant la cinquieme case de chaque carte.
        # `vignettes` pour les pochettes, `images` pour la carte ouverte en
        # grand -- voir la section « les vignettes » plus haut.
        "images": URL_CARTES,
        "vignettes": URL_VIGNETTES,
        # calcule a chaque requete, jamais mis en cache : c'est la reponse a
        # « est-ce que CE visiteur peut ecrire », pas une propriete du classeur
        "write": u is not None and u["id"] == page["utilisateur_id"],
        "types": types,
    }


# --------------------------------------------------------------------------
#   Ecriture
# --------------------------------------------------------------------------
def ma_page_ou_refus():
    """La page de l'utilisateur connecte. Leve si absent ou pas connecte."""
    u = actuel()
    if u is None:
        raise Refus("connexion", "Connecte-toi sur Abyss pour modifier ton classeur.", 401)
    page = ma_page(u)
    if page is None:
        raise Refus("page", "Tu n'as pas encore de classeur.", 404)
    return u, page


def carte_a_moi(carte_id, page):
    """La carte, si elle appartient bien a cette page.

    Meme reponse pour « n'existe pas » et « appartient a quelqu'un d'autre » :
    sinon on renseignerait sur le contenu des classeurs des autres.
    """
    l = cx().execute("SELECT * FROM carte WHERE id = ? AND page_id = ?",
                     (carte_id, page["id"])).fetchone()
    if l is None:
        raise Refus("introuvable", "Cette carte n'est pas dans ton classeur.", 404)
    return l


def pose(carte, rarete, etat) -> None:
    """Range une carte dans le classeur, ou l'en retire.

    Retirer, c'est effacer la rarete : la pochette reste, vide, a sa place.
    L'etat part avec -- il decrit une carte qu'on a en main, pas un
    emplacement, et le garder ferait reapparaitre « Bon » sur la prochaine
    carte qu'on y range.
    """
    if rarete is None:
        etat = None
    cx().execute("UPDATE carte SET rarete = ?, etat = ?, maj_le = ? WHERE id = ?",
                 (rarete, etat, maintenant(), carte["id"]))
    cx().commit()


def ajoute(page, famille, nom):
    """Ajoute une pochette vide au bout d'une famille. Rend son id, ou None si
    la famille contient deja une carte de ce nom.

    Au bout, et pas a une place choisie : une carte qui sort est la plus
    recente, et l'inserer au milieu decalerait toutes les pochettes qui
    suivent -- la page, la face et l'emplacement de cartes deja rangees
    changeraient sans qu'on les ait touchees.

    Pas de commit ici : l'appelant peut ajouter la meme carte a plusieurs
    classeurs d'un coup, et c'est tout ou rien.
    """
    c = cx()
    cle = normalise_nom(nom)
    for l in c.execute("SELECT nom FROM carte WHERE famille_id = ?", (famille["id"],)):
        if normalise_nom(l["nom"]) == cle:
            return None
    dernier = c.execute(
        "SELECT classeur, COUNT(*) AS n, MAX(rang) AS rang FROM carte"
        " WHERE famille_id = ? GROUP BY classeur ORDER BY classeur DESC LIMIT 1",
        (famille["id"],)).fetchone()
    if dernier is None:
        tome, rang = 1, 0
    elif dernier["n"] >= CARTES_PAR_CLASSEUR:
        tome, rang = dernier["classeur"] + 1, 0
    else:
        tome, rang = dernier["classeur"], dernier["rang"] + 1
    return c.execute(
        "INSERT INTO carte(page_id, famille_id, classeur, rang, nom, maj_le)"
        " VALUES(?,?,?,?,?,?)",
        (page["id"], famille["id"], tome, rang, nom, maintenant())).lastrowid


# --------------------------------------------------------------------------
#   Les routes
# --------------------------------------------------------------------------
blueprint_collection = Blueprint("collection", __name__, url_prefix="/api/collection")


@blueprint_collection.before_request
def exige_json():
    """Meme parade CSRF que pour le journal : les ecritures sont en JSON."""
    if request.method in ("POST", "PUT", "PATCH") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    return None


@blueprint_collection.errorhandler(Refus)
def refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_collection.get("")
def liste():
    """L'annuaire : qui a un classeur, et le mien s'il existe.

    Le sien porte son nombre de cartes, comme les autres : un classeur prive
    n'apparait pas dans l'annuaire public, sa page le sait quand meme.
    """
    u = actuel()
    mienne = ma_page(u)
    moi = None if mienne is None else {
        "pseudo": mienne["pseudo"], "cartes": nb_cartes(mienne["id"]),
        "avatar": comptes.url_avatar(u),
        "banniere": comptes.url_banniere(u),
    }
    return reponse({"ok": True,
                    "classeurs": annuaire(),
                    "connecte": u is not None,
                    # La page s'en sert pour montrer le bouton du stock, et
                    # pour rien d'autre : le serveur ne s'en remet pas a elle,
                    # /api/cartes repond 404 a qui n'est pas administrateur.
                    "admin": u is not None and bool(u["admin"]),
                    "moi": moi})


@blueprint_collection.post("")
def creer():
    """Cree mon classeur. Rejouable : renvoie l'existant plutot qu'une erreur.

    Meme route et meme contrat que POST /api/journal : la page d'en face
    fait le meme geste, elle n'a pas a le faire de deux facons.
    """
    u = actuel()
    if u is None:
        return echec("connexion", "Connecte-toi sur Abyss pour creer ton classeur.", 401)
    page = ma_page(u) or cree_page(u)
    return reponse(contenu(page, u), 201)


@blueprint_collection.get("/<pseudo>")
def lire(pseudo):
    page = page_de(pseudo)
    if page is None:
        return echec("introuvable", "Ce classeur n'existe pas.", 404)
    u = actuel()
    if page["visibilite"] != "publique" and (u is None or u["id"] != page["utilisateur_id"]):
        return echec("prive", "Ce classeur est prive.", 403)
    return reponse(contenu(page, u))


@blueprint_collection.get("/vignette/<fichier>")
def voir_vignette(fichier):
    """L'artwork reduit a la taille d'une pochette.

    Ouverte a tout le monde, comme le fonds qu'elle derive : les classeurs
    publics se feuillettent sans compte, leurs images aussi. Le contenu ne
    change jamais pour un nom donne -- un artwork qui change de dessin change
    de passcode -- d'ou le cache d'un an et `immutable`.

    Si la vignette ne peut pas etre fabriquee, on renvoie vers l'original
    plutot que de laisser un trou dans le classeur.
    """
    if not NOM_FICHIER.match(fichier or "") \
            or not DOSSIER_CARTES or not (DOSSIER_CARTES / fichier).is_file():
        return echec("introuvable", "Illustration inconnue.", 404)
    chemin = vignette(fichier)
    if chemin is None:
        # l'artwork est la, mais infabricable en vignette : Pillow manque, ou
        # l'image est illisible. L'original fait l'affaire, en plus lourd.
        return redirect(URL_CARTES + fichier, code=302)
    r = send_file(chemin, mimetype="image/webp", conditional=True)
    r.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return r


@blueprint_collection.put("/carte/<int:carte_id>")
def poser(carte_id):
    """Range une carte, ou la retire. { rarete, etat }

    La reponse ne renvoie que la carte touchee, pas le classeur entier :
    contrairement a un jeu ajoute, rien d'autre ne bouge -- ni l'ordre, ni les
    onglets, ni les tomes -- et renvoyer deux mille cartes a chaque clic sur
    une pochette serait un aller-retour de plus a chaque geste.
    """
    u, page = ma_page_ou_refus()
    carte = carte_a_moi(carte_id, page)
    d = corps()
    pose(carte, rarete_propre(d.get("rarete")), etat_propre(d.get("etat")))
    return reponse({"ok": True, "carte": en_json(carte_a_moi(carte_id, page))})


@blueprint_collection.post("/carte/anglais")
def traduire_noms():
    """Le nom anglais de chaque carte. { noms: [...] } -> { noms: [...] }

    Pour la liste de souhaits Cardmarket, qui ne connait que l'anglais. La
    page choisit les cartes -- elle a deja le classeur en main, avec la
    selection de l'export -- et le serveur ne fait que traduire, dans le
    meme ordre. Un nom, le plus souvent ; une liste quand le francais en
    recouvre plusieurs (voir « les noms anglais ») ; `null` pour une carte
    que le fichier ne connait pas -- un nom tape a la main, ou trop recent
    pour la derniere mise a jour du stock.

    Ouvert a tout le monde : ce ne sont que des noms de cartes. En POST parce que deux mille noms ne tiennent pas dans une
    adresse.
    """
    noms = corps().get("noms")
    if not isinstance(noms, list) or len(noms) > CARTES_MAXI:
        raise Refus("noms", "Une liste de noms de cartes, s'il te plait.")
    exact, proche = anglais()
    sortie = []
    for n in noms:
        en = (exact.get(" ".join(n.split())) or proche.get(normalise_nom(n))
              if isinstance(n, str) else None)
        sortie.append(None if not en else en[0] if len(en) == 1 else en)
    return reponse({"ok": True, "noms": sortie})


# --------------------------------------------------------------------------
#   Prechauffage des vignettes
# --------------------------------------------------------------------------
def prechauffe(sur_place=True) -> tuple:
    """Fabrique toutes les vignettes qui manquent. Rend (faites, ratees).

    Sert a ne pas faire payer la fabrication aux premieres visites : sans ca,
    la premiere personne a ouvrir une page du classeur attend une vignette
    par pochette. Un fonds de quatorze mille artworks demande une vingtaine
    de minutes ; c'est a lancer une fois, apres coup, pas au demarrage du
    site -- d'ou une commande et non un appel automatique :

        python collection.py

    Rejouable sans dommage : une vignette deja sur le disque n'est pas
    refaite.
    """
    if not DOSSIER_CARTES:
        return (0, 0)
    faites = ratees = 0
    for nom in sorted(os.listdir(DOSSIER_CARTES)):
        if not NOM_FICHIER.match(nom):
            continue                       # le sous-dossier des vignettes, entre autres
        if (DOSSIER_CARTES / VIGNETTES / (Path(nom).stem + ".webp")).is_file():
            continue
        if vignette(nom) is None:
            ratees += 1
        else:
            faites += 1
            if sur_place and faites % 200 == 0:
                print(f"  {faites} vignettes...", flush=True)
    return (faites, ratees)


if __name__ == "__main__":
    import sys

    base = Path(__file__).parent.resolve()
    branche(base / "static" / "yugioh" / "Cards", base / "static" / "yugioh" / "cartes-fr.json")
    print(f"Vignettes de {DOSSIER_CARTES} -> {DOSSIER_CARTES / VIGNETTES}")
    faites, ratees = prechauffe()
    print(f"{faites} vignette(s) fabriquee(s), {ratees} illisible(s).")
    sys.exit(0)
