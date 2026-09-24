#!/usr/bin/env python3
"""Le stock de cartes Yu-Gi-Oh, tenu a jour depuis ygoprodeck.

app.py branche ce fichier en une ligne :

    app.register_blueprint(cartes.branche(STATIQUE / "yugioh"))

Ce que ce module remplace
-------------------------
Trois outils qu'il fallait lancer a la main, dans le bon ordre, depuis un
dossier qui n'etait pas celui du site :

  - « Update Images.py », qui allait lire les noms francais sur cardcluster.fr
    avec un navigateur pilote par Selenium, puis telechargeait les images ;
  - « getViews.py », qui recopiait les vues de chaque carte, dont le
    Yu-Gi-Quiz tire ses niveaux de difficulte ;
  - « Cartes.xlsx », une colonne de noms francais qui servait de filtre : ce
    qu'on acceptait de telecharger, et le reste.

Le premier ne fonctionne plus : cardcluster.fr repond 403 derriere une
protection anti-robot, et il n'y a pas de navigateur a piloter sur le
serveur. Il se trouve que le detour n'a plus lieu d'etre -- ygoprodeck
publie les noms francais (language=fr), et ce sont les memes, au caractere
pres, que ceux que Selenium ramenait. Le stock se tient donc avec une seule
source, sans navigateur, et depuis la page plutot qu'en ligne de commande.

Le troisieme a ete remplace par son contraire. Une liste de ce qu'on veut
demande d'y penser a chaque sortie, sinon elle vieillit -- et c'est ce qui
lui est arrive : 597 cartes ont leur image sur le disque sans etre dans le
fichier, 281 y sont sans avoir d'image. Ce qui se maintient tout seul, c'est
la liste de ce qu'on ne veut PAS (voir « la liste noire » plus bas) : elle
ne se remplit que d'un refus explicite, et tout ce qu'on n'a jamais refuse
continue d'etre propose.

Ce que ce module ne fait pas
----------------------------
Il n'ecrase jamais un nom deja connu, et ne supprime rien. Les fichiers de
noms ne se reconstruisent pas, ils se completent :

  - static/yugioh/cartes-fr.json nomme 2 360 cartes que l'API francaise ne
    connait pas -- elles viennent de cardcluster, qui etait plus complet.
    Les reconstruire reviendrait a les effacer, donc a retirer 2 354 cartes
    du Yu-Gi-Quiz et a laisser autant de pochettes sans illustration ;
  - 34 noms different de ceux de l'API apres normalisation. Les adopter
    renommerait des cartes deja rangees dans les classeurs, et l'API n'a pas
    toujours raison : elle ecrit « Inifini Ephemere », « Talent des Triples
    Tacitques ».

Une carte dont on n'a pas le nom francais n'entre pas : elle sera reproposee
au passage suivant, quand la traduction sera parue. C'est le cas courant a la
sortie d'une serie -- Chaos Origins est sortie avec cent cartes et aucun nom
francais.
"""

from __future__ import annotations

import html
import json
import os
import re
import threading
import time
from datetime import date as _date, timedelta
from pathlib import Path

from flask import Blueprint, request

import collection
import comptes
import jaquettes
from comptes import Refus, actuel, corps, cx, echec, maintenant, reponse

PROJET = "collection"

BASE = Path(__file__).parent.resolve()

# Les deux catalogues pesent une quarantaine de mega-octets a eux deux : ils
# sont gardes sur le disque, hors de static/ -- personne n'a besoin de les
# telecharger depuis le site, et donnees/ n'est jamais servi (voir DOSSIERS
# dans app.py).
DOSSIER_CACHE = BASE / "donnees" / "cartes"

API = "https://db.ygoprodeck.com/api/v7/cardinfo.php"
API_SETS = "https://db.ygoprodeck.com/api/v7/cardsets.php"
IMAGES = "https://images.ygoprodeck.com/images"

ENTETES = {
    "User-Agent": jaquettes.NAVIGATEUR,
    "Accept": "application/json,*/*;q=0.8",
    "Connection": "close",
}

# ygoprodeck demande de rester sous vingt appels par seconde. On est loin du
# compte -- deux catalogues au debut, puis une image par clic -- mais le
# telechargement en rafale d'une serie entiere s'en approcherait sans ca.
# La cadence est declaree dans le robinet commun plutot que redite ici :
# c'est lui qui espace les appels, voir _patiente dans jaquettes.py.
jaquettes.CADENCE.setdefault("ygo", 0.06)

# La base officielle Konami, d'ou viennent les noms francais (voir la section
# « les noms francais » plus bas). Une fiche a la fois, une seconde entre
# deux : c'est le site de l'editeur, pas une API, et une serie entiere ne
# represente qu'une centaine de pages.
KONAMI = "https://www.db.yugioh-card.com/yugiohdb/card_search.action"
jaquettes.CADENCE.setdefault("konami", 1.0)
ENTETES_KONAMI = {
    "User-Agent": jaquettes.NAVIGATEUR,
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Connection": "close",
}
MAX_FICHE = 4 * 1024 * 1024
# Cartes resolues par appel a /noms : assez pour avancer vite, assez peu pour
# que la page montre sa progression plutot que de bloquer trois minutes.
KONAMI_PAR_LOT = 8
# Une carte que Konami ne nomme pas encore est reessayee au bout d'une
# semaine. Sans ce delai, une serie fraiche ferait redemander cent fiches a
# chaque analyse ; sans reessai du tout, elle ne serait jamais traduite.
KONAMI_REESSAI = timedelta(days=7)

# Le Yu-Gi-Quiz ne joue une carte que s'il a l'artwork recadre ET la carte
# entiere (voir telecharge). Trois cartes du catalogue n'ont pas d'artwork
# recadre chez ygoprodeck : le telechargement echoue, la carte reste sans ses
# deux images, et l'analyse suivante la repropose -- indefiniment. L'echec est
# donc retenu, et la carte reessayee au bout d'une semaine : un artwork
# manquant arrive souvent quelques jours apres la sortie.
IMAGE_REESSAI = timedelta(days=7)

# Ce que rend _telecharge_image quand ygoprodeck repond 404 : le fichier
# n'existe pas, et il ne servira a rien d'insister tout de suite. Distingue
# d'une panne de reseau, qui elle merite un nouvel essai.
IMAGE_ABSENTE = "image absente d'ygoprodeck"

# Un catalogue complet fait 25 Mo (anglais, vues comprises) et 19 Mo
# (francais). Le plafond de jaquettes.py (4 Mo) est fait pour des reponses
# d'IGDB, pas pour ca.
MAX_CATALOGUE = 64 * 1024 * 1024
# Au-dela, on redemande. Une serie parait rarement deux fois dans la journee,
# et un catalogue relu a chaque clic couterait 44 Mo par carte regardee.
FRAICHEUR = 6 * 3600

# Les cartes qui n'ont rien a faire dans un classeur ni dans le quiz : le
# « Skill » est une carte de Duel Links, le « Token » un jeton sans artwork
# propre. Ni l'un ni l'autre ne se collectionne.
TYPES_ECARTES = ("Skill Card", "Token")

# ------------------------------------------------------------------
#   De la carte a l'onglet du classeur
# ------------------------------------------------------------------
# Le classeur a six onglets, et six seulement : Fusion, Rituel, Synchro, Xyz,
# Pendule, Lien. Un monstre de deck principal, une Magie, un Piege n'y ont pas
# de place -- ils comptent pour le Yu-Gi-Quiz (nom, artwork, vues), pas pour
# le classeur. C'est pourquoi une serie de cent cartes n'en pose qu'une
# vingtaine dans les pochettes.
#
# La table est batie sur frameType et non sur type : c'est lui qui distingue
# un Pendule d'un monstre a effet, la ou `type` melange les deux (« Pendulum
# Effect Monster »). Verifiee sur les 2 096 pochettes deja rangees : elle
# les retrouve toutes, « Synchro Tuner Monster » compris.
#
# Un Pendule croise avec autre chose -- Fusion Pendule, Xyz Pendule, Synchro
# Pendule, Rituel Pendule -- va dans l'onglet Pendule, et non dans celui de son
# Extra Deck. C'est le classement du proprietaire du classeur : le Pendule
# prime, parce que c'est lui qui decide de la place de la carte dans une
# collection. Aucune carte deja rangee ne bouge -- le classeur n'en contenait
# aucune de ce genre au moment ou la regle a ete inversee.
FAMILLES = {
    "fusion": "fusion",
    "synchro": "synchro",
    "xyz": "xyz",
    "link": "lien",
    "ritual": "rituel",
    "normal_pendulum": "pendule",
    "effect_pendulum": "pendule",
    "fusion_pendulum": "pendule",
    "synchro_pendulum": "pendule",
    "xyz_pendulum": "pendule",
    "ritual_pendulum": "pendule",
}

# ------------------------------------------------------------------
#   De la rarete d'ygoprodeck a celle du classeur
# ------------------------------------------------------------------
# Une carte n'est pas parue dans toutes les raretes : le « Dragon Blanc aux
# Yeux Bleus » existe en Commune, en Ultra et en Secrete, jamais en Gold
# Secrete. Le classeur ne doit donc proposer que ce qui existe, et c'est
# cartes-rarity.json qui le dit -- ecrit ici, lu par collection.py.
#
# Le classeur connait treize raretes (voir RARETES dans collection.py),
# ygoprodeck en publie quarante-huit. La conversion tient en deux regles :
#
#   - ce que le classeur sait nommer prend son code. « Prismatic Secret
#     Rare » et « Extra Secret Rare » sont des Secretes ; les parallelles du
#     Duel Terminal suivent le niveau qu'elles portent, « Duel Terminal
#     Super Parallel Rare » est une Super ;
#   - tout le reste tombe dans SPE, « Special ». Starfoil, Shatterfoil,
#     Mosaic, Ghost, Grand Master sont de vraies raretes -- elles existent,
#     elles se collectionnent -- mais le classeur n'a pas une case pour
#     chacune : il en a une pour ca.
#
# « Quarter Century Secret Rare » est rangee en Starlight. Elle compte mille
# tirages a elle seule, les series recentes en sont pleines, et les deux se
# ressemblent assez pour tenir la meme case.
#
# Les cles sont en minuscules : ygoprodeck ecrit « PLatinum Secret Rare »
# aussi bien que « Platinum Secret Rare ».
RARETES_API = {
    "common": "C",
    "short print": "C",
    "super short print": "C",
    "normal parallel rare": "C",
    "duel terminal normal parallel rare": "C",
    "duel terminal normal rare parallel rare": "C",
    "rare": "R",
    "duel terminal rare parallel rare": "R",
    "super rare": "SR",
    "super parallel rare": "SR",
    "duel terminal super parallel rare": "SR",
    "ultra rare": "UR",
    "ultra parallel rare": "UR",
    "duel terminal ultra parallel rare": "UR",
    "ultra rare (pharaoh's rare)": "UR",
    "secret rare": "SE",
    "prismatic secret rare": "SE",
    "extra secret rare": "SE",
    "extra secret": "SE",
    "ultra secret rare": "SE",
    "10000 secret rare": "SE",
    "quarter century secret rare": "STAR",
    "starlight rare": "STAR",
    "collector's rare": "CR",
    "cr": "CR",
    "ultimate rare": "ULTI",
    "gold rare": "G",
    "gold secret rare": "GSE",
    "premium gold rare": "PG",
    "platinum rare": "PLAT",
    "platinum secret rare": "PLAT",
}

# Ce qui occupe la case « rarete » d'ygoprodeck sans etre une rarete : un
# numero d'edition, une note de reimpression, la mention d'une premiere
# sortie regionale. Les laisser tomber dans SPE donnerait une rarete
# « Speciale » a deux cents tirages qui n'en ont jamais eu.
BRUIT_RARETE = {
    "new", "new artwork", "reprint", "2", "3", "force-smw",
    "european debut", "oceanian debut", "european & oceanian debut",
}


def raretes_de(carte) -> list:
    """Les raretes du classeur sous lesquelles cette carte est parue.

    Dans l'ordre du classeur, et sans doublon : une carte reimprimee dix fois
    en Commune n'est parue qu'en Commune.
    """
    parues = set()
    for s in carte.get("card_sets") or []:
        libelle = (s.get("set_rarity") or "").strip().lower()
        if not libelle or libelle in BRUIT_RARETE:
            continue
        parues.add(RARETES_API.get(libelle, "SPE"))
    return [r for r in collection.RARETES if r in parues]


def raretes_du_catalogue(en) -> dict:
    """{ passcode -> raretes parues } pour tout le catalogue.

    Une carte dont aucun tirage ne porte de rarete n'y figure pas : le
    classeur proposera les treize, comme avant. Mieux vaut ne rien savoir
    qu'affirmer qu'aucune rarete n'existe -- ce sont six cents cartes qu'on
    ne pourrait plus ranger.
    """
    catalogue = {}
    for cid, carte in en.items():
        parues = raretes_de(carte)
        if parues:
            catalogue[cid] = parues
    # Les illustrations alternatives portent leur propre passcode -- le
    # « Dragon Ultime aux Yeux Bleus » est nomme sous 23995346 alors que le
    # catalogue le range sous 23995348 -- et cartes-fr.json nomme parfois la
    # carte sous celui-la : c'est l'artwork qu'on a telecharge. Sans ce
    # rattrapage, ces cartes-la n'ont aucune rarete alors que le catalogue
    # les connait tres bien.
    #
    # Jamais par-dessus une carte du catalogue : un passcode qui designe une
    # vraie carte garde les siennes.
    for cid, carte in en.items():
        parues = catalogue.get(cid)
        if not parues:
            continue
        for image in carte.get("card_images") or []:
            autre = str(image.get("id") or "")
            if autre and autre != cid and autre not in en:
                catalogue.setdefault(autre, parues)
    return catalogue


# Poses par branche(), comme dans collection.py : les chemins sont decides
# par app.py, pas ecrits en dur ici.
DOSSIER = None          # static/yugioh
CARDS = None            # static/yugioh/Cards
CROPPED = None          # static/yugioh/CardsCropped
FICHIER_FR = None
FICHIER_EN = None
FICHIER_VUES = None
FICHIER_RARETES = None
FICHIER_NOIRE = None
FICHIER_KONAMI = None
FICHIER_SANS_IMAGE = None

_verrou = threading.Lock()

# Un code de serie : trois ou quatre lettres et chiffres. Quatre pour
# l'immense majorite (898 series sur 1 035), trois pour les anciennes -- AST,
# CRV, DB1. Il vient du navigateur et part dans une comparaison de chaines,
# jamais dans un chemin, mais autant refuser tout de suite ce qui n'est pas
# un code.
CODE = re.compile(r"^[A-Za-z0-9]{2,5}$")


def _dit(message):
    if jaquettes.BAVARD:
        print(f"  cartes : {message}")


# --------------------------------------------------------------------------
#   Lire et ecrire les fichiers de noms
# --------------------------------------------------------------------------
def _lit(chemin, defaut):
    """Le JSON de `chemin`, ou `defaut` s'il est absent ou illisible.

    Illisible et absent donnent la meme chose a dessein : ce module complete
    des fichiers, il ne s'arrete pas parce que l'un d'eux manque -- le
    premier passage sur une installation neuve en creerait un.
    """
    try:
        with open(chemin, encoding="utf-8") as f:
            charge = json.load(f)
    except (OSError, ValueError):
        return defaut
    return charge if isinstance(charge, type(defaut)) else defaut


def _ecrit(chemin, donnees) -> None:
    """Ecrit le JSON par un fichier temporaire, puis renomme.

    Le renommage est atomique : une coupure en cours d'ecriture laisserait
    sinon un cartes-fr.json tronque, et le site ne redemarrerait pas --
    yugiquiz.py le lit a l'import, il n'a rien sur quoi retomber.
    """
    chemin = Path(chemin)
    temporaire = chemin.with_name(chemin.name + ".part")
    try:
        chemin.parent.mkdir(parents=True, exist_ok=True)
        with open(temporaire, "w", encoding="utf-8") as f:
            json.dump(donnees, f, ensure_ascii=False, indent=2)
        os.replace(temporaire, chemin)
    finally:
        if temporaire.exists():
            try:
                temporaire.unlink()
            except OSError:
                pass


def noms_fr() -> dict:
    return _lit(FICHIER_FR, {})


def noms_en() -> dict:
    return _lit(FICHIER_EN, {})


def vues() -> dict:
    return _lit(FICHIER_VUES, {})


# --------------------------------------------------------------------------
#   La liste noire
# --------------------------------------------------------------------------
# « Ne plus proposer cette carte » : une promo, une variante, tout ce qu'on
# ne veut ni dans le classeur ni dans le quiz. Elle ne se remplit que d'un
# refus explicite, et rien ne l'efface tout seul -- c'est ce qui la distingue
# du filtre Excel qu'elle remplace, qu'il fallait penser a tenir a jour.
def liste_noire() -> set:
    return {str(x) for x in _lit(FICHIER_NOIRE, [])}


def ignore(cid) -> None:
    noire = liste_noire()
    noire.add(str(cid))
    _ecrit(FICHIER_NOIRE, sorted(noire))


# --------------------------------------------------------------------------
#   Les deux catalogues
# --------------------------------------------------------------------------
def _telecharge_catalogue(adresse, cible):
    """(donnees, souci). Garde une copie sur le disque au passage."""
    jaquettes._patiente("ygo")
    brut, type_contenu, souci = jaquettes._appelle(
        adresse, ENTETES, None, MAX_CATALOGUE + 1, service="ygo")
    if souci:
        return None, ("ygoprodeck ne repond pas" if souci == "absent" else souci)
    if not brut:
        return None, "reponse vide d'ygoprodeck"
    if len(brut) > MAX_CATALOGUE:
        return None, "catalogue trop lourd"
    if "json" not in (type_contenu or ""):
        return None, f"ygoprodeck a renvoye {type_contenu or 'un contenu inconnu'}"
    try:
        charge = json.loads(brut.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None, "catalogue illisible"
    try:
        DOSSIER_CACHE.mkdir(parents=True, exist_ok=True)
        temporaire = cible.with_name(cible.name + ".part")
        temporaire.write_bytes(brut)
        os.replace(temporaire, cible)
    except OSError as err:
        # Le cache n'est qu'un confort : on continue avec ce qu'on vient de
        # lire plutot que d'echouer parce que le disque est plein.
        _dit(f"cache {cible.name} -> {err}")
    return charge, None


def _catalogue(adresse, nom_cache, force=False):
    """Un catalogue, du disque s'il est frais, du reseau sinon."""
    cible = DOSSIER_CACHE / nom_cache
    if not force and cible.is_file():
        try:
            if time.time() - cible.stat().st_mtime < FRAICHEUR:
                charge = _lit(cible, {})
                if charge:
                    return charge, None
        except OSError:
            pass
    charge, souci = _telecharge_catalogue(adresse, cible)
    if souci and cible.is_file():
        # Le reseau a lache mais on a une copie d'hier : mieux vaut un
        # catalogue un peu vieux que pas de catalogue du tout.
        charge = _lit(cible, {})
        if charge:
            _dit(f"{nom_cache} : {souci}, on repart du cache")
            return charge, None
    return charge, souci


def catalogues(force=False):
    """(anglais, francais, souci). Deux dictionnaires passcode -> carte / nom.

    L'anglais porte tout : les series, les vues, les images. Il vient
    d'ygoprodeck, qui est a jour le jour de la sortie.

    Le francais ne vient PAS d'ygoprodeck. Sa traduction a plus de deux ans
    de retard -- Chaos Origins est sortie avec cent cartes et pas une seule --
    et une collection batie dessus ne serait jamais a jour. Les noms viennent
    de la base officielle Konami, une fiche a la fois, et ce qui est rendu
    ici n'est que ce qu'on en a deja lu (voir nom_konami et resout_noms).
    """
    with _verrou:
        brut_en, souci = _catalogue(f"{API}?misc=yes", "en.json", force)
        if souci:
            return {}, {}, souci
    en = {str(c["id"]): c for c in brut_en.get("data", [])
          if c.get("type") not in TYPES_ECARTES}
    return en, noms_konami(), None


def series(force=False):
    """Les series parues, la plus recente en tete. (liste, souci).

    Sert au menu qui evite de taper le code a la main. Le code n'y est pas
    unique -- 142 codes designent plusieurs entrees, les reeditions et les
    variantes regionales partageant le prefixe de la serie d'origine -- d'ou
    le regroupement par code plutot qu'une ligne par entree.
    """
    brut, souci = _catalogue(API_SETS, "sets.json", force)
    if souci:
        return [], souci
    par_code = {}
    for s in brut if isinstance(brut, list) else []:
        code = (s.get("set_code") or "").upper()
        if not code:
            continue
        date = s.get("tcg_date") or ""
        garde = par_code.get(code)
        if garde is None or date > garde["date"]:
            par_code[code] = {"code": code, "nom": s.get("set_name") or code,
                              "date": date, "cartes": s.get("num_of_cards") or 0}
    liste = sorted(par_code.values(), key=lambda s: s["date"], reverse=True)
    return liste, None


# --------------------------------------------------------------------------
#   Les noms francais : la base officielle Konami
# --------------------------------------------------------------------------
# Trois sources ont ete essayees, dans cet ordre :
#
#   - cardcluster.fr, que l'ancien script lisait avec un navigateur pilote.
#     Il repond aujourd'hui 403 derriere un bouclier anti-robot, y compris
#     depuis ce serveur. Ce n'est plus une option, navigateur ou pas ;
#   - ygoprodeck en francais (language=fr). Les noms sont justes, mais la
#     traduction a plus de deux ans de retard : elle ignorait les cent cartes
#     de Chaos Origins et quatre-vingt-quatorze des cent vingt-six de
#     Magnificent Monsters. Batir la collection dessus revenait a ne jamais
#     l'avoir a jour, ce qui est exactement ce qu'on veut eviter ;
#   - la base officielle de l'editeur, celle-ci. Elle publie la fiche de
#     chaque carte dans chaque langue, et elle est a jour parce que c'est
#     elle qui fait foi.
#
# On y entre par le `konami_id` qu'ygoprodeck donne deja dans misc_info :
# aucun rapprochement par le nom, donc aucune confusion possible entre deux
# cartes homonymes. Douze noms tires au hasard dans le classeur, toutes
# familles confondues, sont revenus identiques au caractere pres a ceux que
# cardcluster avait ramenes ; et les quinze cartes de Magnificent Monsters
# que personne ne nommait ont toutes leur nom ici.
#
# Deux cent trois cartes n'ont pas de konami_id -- des jetons, des cartes de
# Duel Links, quelques promotions. Deux d'entre elles seulement portent un
# nom dans cartes-fr.json : le trou est negligeable, et il est traite comme
# une carte non traduite.
_NOM_KONAMI = re.compile(r'id="cardname"[^>]*>(.*?)</h1>', re.S)
# Present sur toute page de la base, fiche ou non. C'est lui qui separe deux
# situations que rien d'autre ne distingue : une vraie fiche sans bloc de nom
# francais -- la carte n'est pas encore traduite -- et une page qui n'est pas
# une fiche du tout. Le site repond 200 et une page d'erreur de 80 Ko a une
# adresse inconnue : sans ce controle, une panne ou un changement d'adresse
# ferait retenir « pas traduite » pour une serie entiere, et pour une semaine.
MARQUEUR_FICHE = 'id="article_body"'


def _meme_nom(a, b) -> bool:
    """Deux noms qui se valent une fois normalises.

    Sert a reperer les bouche-trous : une carte dont le « nom francais » du
    fichier est en realite son nom anglais. L'import d'origine en a laisse
    836, faute d'avoir la traduction sous la main -- et comme le fichier les
    croit nommees, l'analyse les comptait completes et ne les proposait
    jamais. C'est ce qui manquait sur Magnificent Monsters : « Decode Talker
    Integration » et « Cyberse Contract Witch » etaient la, avec leur image,
    sous leur nom anglais.

    L'egalite ne suffit pas a conclure : « Abaki », « Aitsu », « Agido »,
    « I:P Masquerena » portent le meme nom dans les deux langues. C'est
    pourquoi on redemande a Konami et qu'on ne remplace que s'il donne autre
    chose (voir analyse et ecrit).
    """
    return collection.normalise_nom(a) == collection.normalise_nom(b)


def _cache_konami() -> dict:
    """{ passcode -> {"n": nom ou None, "d": date de lecture} }."""
    return _lit(FICHIER_KONAMI, {})


def noms_konami() -> dict:
    """{ passcode -> nom francais } pour ce qu'on a deja lu chez Konami."""
    return {cid: v["n"] for cid, v in _cache_konami().items()
            if isinstance(v, dict) and v.get("n")}


def _a_redemander(entree) -> bool:
    """Faut-il (re)lire cette fiche ? Absente, ou non traduite depuis une
    semaine -- une serie fraiche finit toujours par etre traduite."""
    if not isinstance(entree, dict):
        return True
    if entree.get("n"):
        return False
    try:
        vue = _date.fromisoformat(str(entree.get("d") or ""))
    except ValueError:
        return True
    return _date.today() - vue >= KONAMI_REESSAI


def nom_konami(carte) -> tuple:
    """Le nom francais officiel d'une carte. (nom, souci).

    (None, None) n'est pas un echec : c'est une carte que Konami ne nomme pas
    encore en francais, le cas courant d'une serie qui vient de paraitre.
    """
    kid = (carte.get("misc_info") or [{}])[0].get("konami_id")
    if not kid:
        return None, None
    jaquettes._patiente("konami")
    brut, _type, souci = jaquettes._appelle(
        f"{KONAMI}?ope=2&cid={int(kid)}&request_locale=fr",
        ENTETES_KONAMI, None, MAX_FICHE, service="konami")
    if souci:
        return None, ("fiche absente de la base Konami" if souci == "absent" else souci)
    if not brut:
        return None, "fiche vide"
    page = brut.decode("utf-8", "replace")
    trouve = _NOM_KONAMI.search(page)
    if trouve:
        # La fiche donne le nom francais, puis le nom anglais en dessous.
        lignes = [l.strip() for l in
                  html.unescape(re.sub(r"<[^>]+>", "\n", trouve.group(1))).split("\n")
                  if l.strip()]
        if lignes:
            return lignes[0], None
    # Pas de bloc de nom : ou bien Konami ne traduit pas encore cette carte,
    # et c'est une reponse qu'on retient, ou bien ce n'est pas une fiche et
    # il ne faut surtout rien retenir. Voir MARQUEUR_FICHE.
    if MARQUEUR_FICHE not in page:
        return None, "reponse inattendue de la base Konami"
    return None, None


def resout_noms(ids) -> tuple:
    """Lit chez Konami les noms qui manquent. (noms trouves, restants, soucis).

    Par petits paquets : une fiche prend deux secondes, une serie entiere
    prendrait donc quelques minutes d'un seul tenant. La page rappelle cette
    route tant qu'il reste des cartes, et montre ou elle en est.
    """
    en, _noms, souci = catalogues()
    if souci:
        return {}, 0, [souci]
    cache = _cache_konami()
    fichier = noms_fr()
    # Les cartes sans nom, et celles que le fichier nomme en anglais : ces
    # dernieres sont peut-etre des bouche-trous, et seule une lecture chez
    # Konami permet de le dire. Voir _meme_nom.
    a_faire = [str(i) for i in ids or []
               if str(i) in en
               and (not fichier.get(str(i))
                    or _meme_nom(fichier[str(i)], en[str(i)].get("name")))
               and _a_redemander(cache.get(str(i)))]
    trouves, soucis, faits = {}, [], 0
    aujourdhui = _date.today().isoformat()
    for cid in a_faire[:KONAMI_PAR_LOT]:
        nom, souci = nom_konami(en[cid])
        if souci:
            # Rien n'est retenu : la carte reste a faire et repassera au
            # prochain appel. La compter comme reglee, c'est ce que faisait
            # la version d'avant -- elle annoncait un lot entier traite alors
            # qu'une fiche sur huit avait pu echouer, et la page s'arretait
            # en croyant avoir fini.
            soucis.append(f"{en[cid].get('name') or cid} : {souci}")
            continue
        cache[cid] = {"n": nom, "d": aujourdhui}
        faits += 1
        if nom:
            trouves[cid] = nom
    _ecrit(FICHIER_KONAMI, cache)
    return trouves, max(0, len(a_faire) - faits), soucis


# --------------------------------------------------------------------------
#   Ce qui manque
# --------------------------------------------------------------------------
def code_propre(v) -> str:
    code = str(v or "").strip().upper()
    if code and not CODE.match(code):
        raise Refus("code", "Un code de serie, c'est trois ou quatre lettres.")
    return code


def _du_set(carte, code) -> bool:
    """Cette carte parait-elle dans cette serie ?

    On compare le prefixe du code de chaque tirage (« CORI-EN067 ») et non le
    nom de la serie : le nom change d'une edition a l'autre, le prefixe non,
    et seize prefixes ne figurent dans aucune entree de cardsets.php.
    """
    for s in carte.get("card_sets") or []:
        if (s.get("set_code") or "").split("-")[0].upper() == code:
            return True
    return False


def _dates_des_series() -> dict:
    """{ code de serie -> date de sortie TCG la plus ancienne }."""
    brut, souci = _catalogue(API_SETS, "sets.json")
    if souci:
        return {}
    dates = {}
    for s in brut if isinstance(brut, list) else []:
        code = (s.get("set_code") or "").upper()
        if code and s.get("tcg_date"):
            dates[code] = min(dates.get(code, "9999"), s["tcg_date"])
    return dates


# Ce qui separe le code de serie du numero : « CORI-EN067 ». EN pour
# l'anglais, FR pour le francais -- et ENS, ENSE, ENSP pour les variantes
# (secrete, speciale) d'une meme carte dans une meme serie. Le numero du
# tirage principal fait foi : « Premier des Dragons » est la cinquantieme
# carte de sa serie (NECH-EN050), pas la huitieme (NECH-ENS08). Prendre le
# plus petit numero toutes variantes confondues, c'est ce que faisait la
# premiere version, et ca suffisait a inverser des cartes voisines.
LANGUES = {"EN", "FR", "E", "", "PT", "DE", "IT", "SP"}


def _ordre(carte, dates) -> tuple:
    """Ou cette carte se range : (date de sortie TCG, numero dans la serie).

    C'est la moitie de la regle du classeur qui ne fait aucun doute : dans
    une meme serie, les cartes se suivent par leur numero. Ce qui departage
    deux series, en revanche, n'est pas une formule -- le classeur compte des
    dizaines de cartes placees a la main, et aucune regle de date ne les
    reproduit. C'est pourquoi cet ordre n'est qu'une PROPOSITION : la page le
    montre a la relecture, le proprietaire le corrige, et /ecrire suit
    l'ordre qu'on lui donne sans jamais le recalculer.
    """
    meilleur = None
    for s in carte.get("card_sets") or []:
        code = (s.get("set_code") or "").upper()
        if "-" not in code:
            continue
        prefixe, reste = code.split("-", 1)
        decoupe = re.match(r"^([A-Z]*)(\d+)$", reste)
        date = dates.get(prefixe)
        if not decoupe or not date:
            continue
        candidat = (date, 0 if decoupe.group(1) in LANGUES else 1,
                    int(decoupe.group(2)))
        if meilleur is None or candidat < meilleur:
            meilleur = candidat
    # Sans date connue, la carte part en fin de liste plutot qu'en tete :
    # une serie que le catalogue ne date pas ne doit pas passer devant tout.
    return (meilleur[0], meilleur[2]) if meilleur else ("9999-99-99", 0)


def famille_de(carte):
    """L'onglet du classeur ou cette carte se range, ou None."""
    return FAMILLES.get(carte.get("frameType") or "")


def _images_de(carte):
    """(image, recadree) pour cette carte, ou ('', '').

    La premiere entree seulement : les suivantes sont les illustrations
    alternatives, qui portent leur propre passcode et feraient un deuxieme
    fichier pour la meme carte.
    """
    images = carte.get("card_images") or []
    if not images:
        return "", ""
    return images[0].get("image_url") or "", images[0].get("image_url_cropped") or ""


def a_ses_images(cid) -> bool:
    return (CARDS / f"{cid}.jpg").is_file() and (CROPPED / f"{cid}.jpg").is_file()


# --------------------------------------------------------------------------
#   Les artworks qu'ygoprodeck n'a pas
# --------------------------------------------------------------------------
# Rien a voir avec la liste noire, qui est un refus du proprietaire et ne
# s'efface jamais : ici c'est un constat sur le catalogue, date, et qui
# s'efface de lui-meme au bout d'une semaine. « Sanctity of Dragon » et
# « Noritoshi in Darkest Rainment » sont dans ce cas -- leur carte entiere
# est publiee, leur artwork recadre non.
def _sans_image() -> dict:
    """{ passcode -> date du dernier essai }."""
    return _lit(FICHIER_SANS_IMAGE, {})


def _a_ressayer(quand) -> bool:
    """Peut-on retenter cette carte ? Jamais essayee, ou il y a une semaine."""
    try:
        essai = _date.fromisoformat(str(quand or ""))
    except ValueError:
        return True
    return _date.today() - essai >= IMAGE_REESSAI


def _note_sans_image(cid) -> None:
    cache = _sans_image()
    cache[str(cid)] = _date.today().isoformat()
    _ecrit(FICHIER_SANS_IMAGE, cache)


def _oublie_sans_image(cid) -> None:
    """L'artwork est arrive : la carte redevient une carte comme une autre."""
    cache = _sans_image()
    if cache.pop(str(cid), None) is not None:
        _ecrit(FICHIER_SANS_IMAGE, cache)


def analyse(code="", force=False):
    """Ce qui manque, pour une serie ou pour tout le site.

    Rend un rapport, jamais un changement : rien n'est telecharge ni ecrit
    ici. C'est la meme prudence que la mise a jour depuis IGDB -- on montre
    d'abord, on ecrit apres un clic.

    Une carte est « a faire » s'il lui manque une image, ou son nom francais
    dans le fichier alors que Konami le donne. Le reste est compte a part :

      - `a_resoudre`: son nom francais n'est pas connu et n'a pas encore ete
                      demande a Konami. La page les fait lire par /noms, puis
                      redemande l'analyse -- une fiche prend deux secondes,
                      on ne les lit pas toutes en bloquant la fenetre.
      - `sans_fr`  : Konami ne la traduit pas encore. Elle attend, et sera
                     redemandee dans une semaine (voir KONAMI_REESSAI).
      - `ignorees` : refusee une fois, voir la liste noire.
      - `sans_image`: ygoprodeck n'a pas son artwork recadre. Le
                      telechargement a deja echoue dessus ; elle repassera
                      dans une semaine (voir IMAGE_REESSAI).
      - `completes`: image et nom deja la, il n'y a rien a en faire.
    """
    en, konami, souci = catalogues(force)
    if souci:
        return None, souci
    fr = noms_fr()
    noire = liste_noire()
    vus = _cache_konami()
    sans_artwork = _sans_image()
    dates = _dates_des_series()

    if code:
        lot = {cid: c for cid, c in en.items() if _du_set(c, code)}
        if not lot:
            return None, f"aucune carte ne porte le code {code}"
    else:
        lot = en

    manquantes, a_resoudre, sans_fr = [], [], 0
    ignorees = completes = sans_image = 0
    for cid, carte in lot.items():
        if cid in noire:
            ignorees += 1
            continue
        au_fichier = fr.get(cid)
        du_konami = konami.get(cid)
        # Un nom de fichier identique au nom anglais est ambigu : vrai nom
        # francais, ou bouche-trou d'import ? Tant que Konami n'a pas
        # repondu, on ne peut rien en dire -- voir _meme_nom.
        anglais = bool(au_fichier) and _meme_nom(au_fichier, carte.get("name"))
        if anglais and not du_konami:
            if _a_redemander(vus.get(cid)):
                a_resoudre.append(cid)
            else:
                completes += 1
            continue
        nom_fr = du_konami if anglais else (au_fichier or du_konami)
        images = not a_ses_images(cid)
        noms = bool(nom_fr) and nom_fr != au_fichier
        if not images and not noms:
            completes += 1
            continue
        # Proposer une carte dont l'artwork n'existe pas chez ygoprodeck ne
        # menerait qu'a un echec de plus : elle attend son tour, comme une
        # carte que Konami ne traduit pas encore.
        if images and not _a_ressayer(sans_artwork.get(cid)):
            sans_image += 1
            continue
        if not nom_fr:
            # Sans nom francais elle n'a sa place ni dans un classeur ni dans
            # le quiz, qui tire ses reponses de cartes-fr.json. Ou bien on ne
            # l'a jamais demandee a Konami -- la page va le faire -- ou bien
            # Konami ne la traduit pas encore, et elle attend son tour.
            if _a_redemander(vus.get(cid)):
                a_resoudre.append(cid)
            else:
                sans_fr += 1
            continue
        image, recadree = _images_de(carte)
        famille = famille_de(carte)
        manquantes.append({
            "id": cid,
            "en": carte.get("name") or "",
            "fr": nom_fr,
            "type": carte.get("humanReadableCardType") or carte.get("type") or "",
            "famille": famille,
            "nouveau_nom": noms,
            "image": image,
            "recadree": recadree,
            "a_limage": not images,
            # (date de sortie, numero dans la serie) : l'ordre propose a la
            # relecture, et celui dans lequel les cartes defilent. Voir _ordre.
            "ordre": list(_ordre(carte, dates)),
        })
    # Par ordre de parution, et non par ordre alphabetique : c'est celui du
    # classeur, donc celui dans lequel on veut les voir passer. Le nom ne
    # departage plus que deux cartes de meme numero.
    manquantes.sort(key=lambda c: (c["ordre"], c["fr"]))
    return {
        "code": code,
        "total": len(lot),
        "manquantes": manquantes,
        "a_resoudre": a_resoudre,
        "sans_fr": sans_fr,
        "sans_image": sans_image,
        "ignorees": ignorees,
        "completes": completes,
    }, None


# --------------------------------------------------------------------------
#   Telecharger une carte
# --------------------------------------------------------------------------
def _telecharge_image(adresse, cible):
    """(ok, souci). Meme precaution que les jaquettes : un .part, puis un
    renommage -- une coupure ne laisse pas une image tronquee que le
    navigateur mettrait en cache pour un an (voir voir_vignette)."""
    if cible.is_file():
        return True, ""
    jaquettes._patiente("ygo")
    donnees, type_contenu, souci = jaquettes._appelle(
        adresse, jaquettes.ENTETES_IMAGE, None, jaquettes.MAX_IMAGE + 1, service="ygo")
    if souci:
        return False, (IMAGE_ABSENTE if souci == "absent" else souci)
    if not donnees:
        return False, "image vide"
    if not (type_contenu or "").startswith("image/"):
        return False, f"ygoprodeck a renvoye {type_contenu or 'un contenu inconnu'}"
    if len(donnees) > jaquettes.MAX_IMAGE:
        return False, "image trop lourde"
    temporaire = cible.with_name(cible.name + ".part")
    try:
        cible.parent.mkdir(parents=True, exist_ok=True)
        temporaire.write_bytes(donnees)
        os.replace(temporaire, cible)
        return True, ""
    except OSError as err:
        _dit(f"ecriture de {cible} -> {err}")
        return False, f"ecriture impossible ({err.strerror or err})"
    finally:
        if temporaire.exists():
            try:
                temporaire.unlink()
            except OSError:
                pass


def telecharge(cid) -> tuple:
    """Les deux images d'une carte, et sa vignette. (ok, souci).

    Les deux, et pas l'une ou l'autre : le Yu-Gi-Quiz ne joue une carte que
    si l'artwork recadre ET la carte entiere sont la (voir list_cards_set
    dans yugiquiz.py). Une carte a moitie telechargee ne servirait a rien.

    Toutes les illustrations sont essayees, et non la premiere seulement.
    ygoprodeck publie parfois la carte entiere sans son artwork recadre :
    « Mercurium le Mercure Vivant » n'a pas de cards_cropped sous son
    identifiant, mais en a un sous celui de sa seconde illustration -- et
    c'est le meme dessin, seul le cadre de la carte differe. La premiere
    version s'arretait a la premiere illustration : le telechargement
    echouait, la carte restait sans ses deux images, et chaque analyse la
    reproposait.

    L'artwork recadre passe avant la carte entiere, parce que c'est lui qui
    manque : inutile de poser sur le disque une carte entiere dont l'artwork
    ne viendra pas.

    La vignette est fabriquee dans la foulee plutot qu'a la premiere visite :
    c'est trois secondes ici contre un classeur qui rame pour la premiere
    personne qui l'ouvre.
    """
    en, _fr, souci = catalogues()
    if souci:
        return False, souci
    carte = en.get(str(cid))
    if carte is None:
        return False, "carte inconnue d'ygoprodeck"
    illustrations = [(i.get("image_url") or "", i.get("image_url_cropped") or "")
                     for i in carte.get("card_images") or []]
    illustrations = [(i, r) for i, r in illustrations if i and r]
    if not illustrations:
        _note_sans_image(cid)
        return False, "ygoprodeck n'a pas d'image pour cette carte"
    souci = ""
    for image, recadree in illustrations:
        ok, souci = _telecharge_image(recadree, CROPPED / f"{cid}.jpg")
        if not ok:
            # 404 : cette illustration-la n'a pas d'artwork, la suivante en a
            # peut-etre un. Une panne de reseau, elle, arrete tout -- essayer
            # les autres reviendrait a s'acharner sur une ligne coupee.
            if souci == IMAGE_ABSENTE:
                continue
            return False, souci
        ok, souci = _telecharge_image(image, CARDS / f"{cid}.jpg")
        if not ok:
            return False, souci
        collection.vignette(f"{cid}.jpg")
        _oublie_sans_image(cid)
        return True, ""
    _note_sans_image(cid)
    return False, souci or "ygoprodeck n'a pas l'artwork de cette carte"


# --------------------------------------------------------------------------
#   Ecrire les noms, poser les pochettes
# --------------------------------------------------------------------------
def _pochettes_par_nom() -> dict:
    """{ nom normalise -> [id de pochette] } pour tout le site.

    Lu une fois par ecriture : chercher carte par carte referait la meme
    lecture des milliers de fois, et le classeur en compte deux mille.
    """
    index = {}
    for l in cx().execute("SELECT id, nom FROM carte"):
        index.setdefault(collection.normalise_nom(l["nom"]), []).append(l["id"])
    return index


def _renomme(index, ancien, nouveau) -> int:
    """Fait suivre les pochettes quand une carte change de nom. Rend combien.

    Quand un bouche-trou anglais est remplace par son vrai nom francais, la
    pochette deja rangee doit suivre, sans quoi deux degats a la fois :

      - elle perd son illustration. collection.py associe le nom normalise au
        fichier de l'artwork, et l'ancien nom ne figure plus dans le fichier
        des noms ;
      - pose_pochettes, ne reconnaissant pas de doublon (les deux noms ne se
        normalisent pas pareil), en ajoute une SECONDE sous le nouveau nom.

    Soixante-seize cartes du classeur sont dans ce cas. La plupart ne
    bougeront pas -- Konami confirme le plus souvent le nom, « Bickuribox »,
    « Baronne de Fleur » et « Daigusto Sphreez » s'ecrivent pareil dans les
    deux langues -- mais il suffit d'une pour laisser une pochette vide.
    """
    cle = collection.normalise_nom(ancien)
    ids = index.get(cle) or []
    if not ids:
        return 0
    c = cx()
    for pochette in ids:
        c.execute("UPDATE carte SET nom = ?, maj_le = ? WHERE id = ?",
                  (nouveau, maintenant(), pochette))
    # l'index suit le renommage : sans ca, deux cartes du meme lot qui
    # portent l'ancien nom se chercheraient encore a l'ancienne cle
    index.setdefault(collection.normalise_nom(nouveau), []).extend(ids)
    index.pop(cle, None)
    return len(ids)


def pose_pochettes(nom, cle) -> int:
    """Ajoute cette carte au bout de cet onglet, dans tous les classeurs.

    Le meme geste que l'administration qui ajoute une carte depuis le
    classeur (voir ajouter() dans collection.py) : les classeurs partagent
    les memes pochettes, une carte qui parait les concerne tous. `ajoute`
    rend None quand l'onglet a deja cette carte, ce qui rend l'operation
    rejouable sans creer de doublon.
    """
    if not cle:
        return 0
    c = cx()
    poses = 0
    for f in c.execute(
            "SELECT f.* FROM famille f JOIN page p ON p.id = f.page_id"
            " WHERE p.projet = ? AND f.cle = ?", (PROJET, cle)).fetchall():
        if collection.ajoute({"id": f["page_id"]}, f, nom) is not None:
            poses += 1
    return poses


def ecrit(ids) -> tuple:
    """Complete les fichiers de noms et pose les pochettes. (bilan, souci).

    Trois fichiers, et aucun n'est reconstruit :

      - cartes-fr.json et cartes-en.json ne recoivent que ce qui leur
        manque. Un nom deja la ne bouge pas, meme si l'API en propose un
        autre : voir l'en-tete du module.
      - cartes-vues.json est fusionne lui aussi. Les vues sont rangees sous
        le nom anglais exact, alors que l'ancien getViews.py en retirait les
        guillemets -- « "A" Cell Incubator » y devenait « A" Cell
        Incubator », que cartes-en.json ne contient pas. Les 411 cartes dont
        le nom commence par un guillemet n'avaient donc jamais de vues, et
        tombaient hors des niveaux Facile, Normal et Difficile. Les
        anciennes cles sont gardees : elles ne genent personne, et les
        effacer priverait de vues les cartes qu'ygoprodeck ne connait plus.
      - cartes-rarity.json, lui, est refait : ce n'est pas une matiere qu'on
        complete mais un reflet du catalogue, et une carte peut y perdre une
        rarete comme en gagner une. Rien ne s'y perd pour autant -- c'est
        ygoprodeck qui le dit, et ce que le classeur contient deja n'en
        depend pas (voir raretes_de).
    """
    en, konami, souci = catalogues()
    if souci:
        return None, souci
    # L'ordre donne fait foi, et n'est jamais recalcule ici. C'est celui que
    # la page a montre a la relecture et que le proprietaire a pu corriger a
    # la main : une pochette se pose au bout de son onglet, donc cet ordre
    # est exactement celui du classeur. Trier sur le passcode, comme le
    # faisait la premiere version, posait les cartes dans un ordre qui ne
    # veut rien dire.
    voulus, deja = [], set()
    for i in ids or []:
        cid = str(i)
        if cid not in deja:
            deja.add(cid)
            voulus.append(cid)
    noire = liste_noire()

    fr, base_en, vu = noms_fr(), noms_en(), vues()
    bilan = {"noms_fr": 0, "noms_en": 0, "pochettes": 0, "cartes": 0, "renommees": 0}
    # les pochettes deja posees, pour les faire suivre si un nom change
    au_classeur = _pochettes_par_nom()

    for cid in voulus:
        carte = en.get(cid)
        if carte is None or cid in noire:
            continue
        au_fichier = fr.get(cid)
        du_konami = konami.get(cid)
        anglais = bool(au_fichier) and _meme_nom(au_fichier, carte.get("name"))
        nom_fr = du_konami if anglais else (au_fichier or du_konami)
        if not nom_fr:
            continue
        if nom_fr != au_fichier:
            # Le seul cas ou un nom deja present est remplace : c'etait le nom
            # anglais, et Konami en donne un autre. Un vrai nom francais n'est
            # jamais touche, meme quand Konami n'est pas d'accord -- l'API se
            # trompe parfois (« Inifini Ephemere », « Tacitques »).
            #
            # La pochette suit AVANT que pose_pochettes ne tourne : sinon
            # celle-ci ajouterait un doublon sous le nouveau nom, et
            # l'ancienne resterait sans illustration. Voir _renomme.
            if au_fichier:
                bilan["renommees"] += _renomme(au_classeur, au_fichier, nom_fr)
            fr[cid] = nom_fr
            bilan["noms_fr"] += 1
        if not base_en.get(cid) and carte.get("name"):
            base_en[cid] = carte["name"]
            bilan["noms_en"] += 1
        bilan["cartes"] += 1
        bilan["pochettes"] += pose_pochettes(nom_fr, famille_de(carte))

    # Les vues de tout le catalogue, et pas seulement des cartes du lot :
    # elles bougent d'un mois sur l'autre, c'est ce qui fait qu'une carte
    # change de niveau de difficulte. Le fichier entier coute une recopie.
    for cid, carte in en.items():
        misc = (carte.get("misc_info") or [{}])[0]
        n, nom = misc.get("views"), carte.get("name")
        if nom and isinstance(n, int):
            vu[nom] = n

    # Les raretes de tout le catalogue, pour la meme raison que les vues :
    # elles ne concernent pas que le lot. Une carte rangee depuis des annees
    # parait en reimpression sous une rarete de plus, et le classeur doit
    # pouvoir la proposer sans attendre qu'on retouche cette carte-la.
    _ecrit(FICHIER_RARETES, raretes_du_catalogue(en))

    cx().commit()
    _ecrit(FICHIER_FR, fr)
    _ecrit(FICHIER_EN, base_en)
    _ecrit(FICHIER_VUES, vu)

    # Les noms et les artworks viennent de changer : l'index que la
    # Collection garde en memoire date d'avant, et le vivier du Yu-Gi-Quiz
    # aussi. Les deux se refont a la demande plutot qu'au redemarrage.
    collection.oublie_illustrations()
    _recharge_le_quiz()
    return bilan, None


def _recharge_le_quiz() -> None:
    """Refait les viviers du Yu-Gi-Quiz, s'il est branche.

    Import tardif et volontairement tolerant : cartes.py sert aussi sans le
    quiz (les tests ne branchent que la Collection), et un quiz absent ne
    doit pas faire echouer une mise a jour qui s'est bien passee.
    """
    try:
        import yugiquiz
        yugiquiz.recharge()
    except Exception as err:                      # noqa: BLE001 - dernier filet
        _dit(f"viviers du quiz non recharges : {err}")


# --------------------------------------------------------------------------
#   Les routes
# --------------------------------------------------------------------------
blueprint_cartes = Blueprint("cartes", __name__, url_prefix="/api/cartes")


def branche(dossier_yugioh) -> Blueprint:
    """Dit au module ou vit le stock, et rend le blueprint."""
    # FICHIER_KONAMI en fait partie : sans lui dans cette liste, l'affectation
    # plus bas creait une variable locale, le module gardait None, et la
    # premiere lecture du cache tombait en 500. Toute variable posee ici doit
    # y figurer -- voir test_branche_pose_tous_les_chemins.
    global DOSSIER, CARDS, CROPPED, FICHIER_FR, FICHIER_EN, FICHIER_VUES
    global FICHIER_RARETES, FICHIER_NOIRE, FICHIER_KONAMI, FICHIER_SANS_IMAGE
    DOSSIER = Path(dossier_yugioh)
    CARDS = DOSSIER / "Cards"
    CROPPED = DOSSIER / "CardsCropped"
    FICHIER_FR = DOSSIER / "cartes-fr.json"
    FICHIER_EN = DOSSIER / "cartes-en.json"
    FICHIER_VUES = DOSSIER / "cartes-vues.json"
    # Celui-ci vit dans static/ comme les noms, et pour la meme raison : la
    # page le lit par le serveur, mais c'est une matiere du site.
    FICHIER_RARETES = DOSSIER / "cartes-rarity.json"
    FICHIER_NOIRE = DOSSIER / "cartes-ignorees.json"
    # Le cache des noms lus chez Konami vit a cote de la base et non dans
    # static/ : c'est un cache de travail, pas une matiere du site. Les noms
    # retenus, eux, partent dans cartes-fr.json comme avant.
    FICHIER_KONAMI = DOSSIER_CACHE / "konami.json"
    # Meme raison pour les artworks qu'ygoprodeck n'a pas : c'est un cache de
    # travail, pas une matiere du site.
    FICHIER_SANS_IMAGE = DOSSIER_CACHE / "sans-image.json"
    return blueprint_cartes


@blueprint_cartes.before_request
def reserve():
    """Tout est reserve a l'administration, et repond 404 au reste du monde.

    404 et non 403 : la meme parade que suggestions.py et les routes /admin
    du journal -- repondre « interdit » confirmerait qu'il y a quelque chose
    derriere. Le controle est ici plutot que route par route : il n'y a pas
    une seule route de ce module qui soit ouverte, et un oubli en ajoutant
    la prochaine ne pardonnerait pas.
    """
    if request.method in ("POST", "PUT", "PATCH") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    u = actuel()
    if u is None or not u["admin"]:
        return echec("introuvable", "Page inconnue.", 404)
    return None


@blueprint_cartes.errorhandler(Refus)
def refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_cartes.get("/series")
def voir_series():
    """Les series parues, la plus recente en tete."""
    liste, souci = series()
    if souci:
        return echec("injoignable", souci, 502)
    return reponse({"ok": True, "series": liste[:60]})


@blueprint_cartes.post("/analyse")
def voir_analyse():
    """Ce qui manque. { code } -- code vide = tout le site."""
    d = corps()
    rapport, souci = analyse(code_propre(d.get("code")), force=bool(d.get("force")))
    if souci:
        return echec("injoignable", souci, 502)
    return reponse({"ok": True, **rapport})


@blueprint_cartes.post("/noms")
def lire_noms():
    """Lit chez Konami les noms francais qui manquent. { ids: [...] }

    Par paquets, parce qu'une fiche prend deux secondes : la page rappelle
    cette route tant qu'il reste des cartes et montre ou elle en est. Elle
    s'arrete d'elle-meme si `restants` cesse de descendre -- une fiche qui
    echoue reste a faire, et il ne sert a rien de tourner en rond dessus.
    """
    ids = corps().get("ids")
    if not isinstance(ids, list) or not ids:
        raise Refus("ids", "Aucune carte a nommer.")
    if len(ids) > collection.CARTES_MAXI:
        raise Refus("ids", "Trop de cartes d'un coup.")
    trouves, restants, soucis = resout_noms(ids)
    return reponse({"ok": True, "noms": trouves, "restants": restants,
                    "soucis": soucis[:5]})


@blueprint_cartes.post("/image")
def prendre_image():
    """Les images d'une carte. { id }"""
    cid = str(corps().get("id") or "").strip()
    if not cid.isdigit():
        raise Refus("id", "Identifiant de carte invalide.")
    ok, souci = telecharge(cid)
    if not ok:
        return echec("injoignable", souci, 502)
    return reponse({"ok": True, "id": cid})


@blueprint_cartes.post("/ignorer")
def ne_plus_proposer():
    """« Ne plus proposer cette carte ». { id }"""
    cid = str(corps().get("id") or "").strip()
    if not cid.isdigit():
        raise Refus("id", "Identifiant de carte invalide.")
    ignore(cid)
    return reponse({"ok": True, "id": cid})


@blueprint_cartes.post("/ecrire")
def ecrire():
    """Complete les fichiers et pose les pochettes. { ids: [...] }"""
    ids = corps().get("ids")
    if not isinstance(ids, list) or not ids:
        raise Refus("ids", "Aucune carte a ecrire.")
    if len(ids) > collection.CARTES_MAXI:
        raise Refus("ids", "Trop de cartes d'un coup.")
    bilan, souci = ecrit(ids)
    if souci:
        return echec("injoignable", souci, 502)
    return reponse({"ok": True, **bilan})
