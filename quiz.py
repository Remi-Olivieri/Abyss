#!/usr/bin/env python3
"""Les mini-jeux du Quiz Jeux Video.

Trois : « Jaquette floue », « Chronologie » et « Grille de connexions ».
Tous puisent au meme endroit -- les journaux de jeu deja remplis -- et rien
n'est prevu a l'avance pour des jeux qui n'existent pas encore.

D'ou vient la matiere : de la base, et d'elle seule. Le nom d'un jeu et son
identifiant IGDB donnent le nom du fichier deja telecharge sous static/Cover
(voir jaquettes.cle_jaquette) ; la date de sortie est deja en colonne, et la
grille lit en plus le studio et les genres, ecrits une fois pour toutes au
rattachement IGDB (voir journal.enrichit_igdb). Rien n'est demande a IGDB
ici, et une partie ne coute donc aucun appel exterieur.

Deux viviers, au choix de qui joue. Le choix est garde dans le compte
(utilisateur.quiz_source, voir comptes.quiz_source) et vaut pour tous les
mini-jeux : c'est une facon de jouer, pas un reglage de partie -- la page
l'envoie donc en parametre a chaque tirage sans jamais le redemander :

  - « tous » : les journaux publics. Une jaquette est un fichier public,
    mais le titre qui va avec dirait « untel possede ce jeu » -- un journal
    prive n'alimente donc rien ;
  - « moi » : son propre journal, prive ou non. Ce qu'on y a mis, on sait
    deja qu'on l'a.

Et dans les deux cas, uniquement des jeux DEJA SORTIS : une jaquette de jeu
a paraitre est souvent une image d'annonce que personne n'a vue, et la
deviner tient du hasard. Un jeu sans date connue est ecarte avec eux -- on
ne peut pas affirmer qu'il est sorti, et « Chronologie » n'aurait de toute
facon rien a en faire.

CE QUI RESTE A FAIRE LE JOUR OU IL Y AURA DES SCORES : la reponse est
envoyee avec la manche, et la page corrige donc elle-meme. C'est le plus
simple tant que rien n'est enregistre -- personne ne triche contre soi. Un
score qui compte demanderait l'inverse : garder la manche cote serveur et ne
lui envoyer que les propositions.
"""

from __future__ import annotations

import collections
import itertools
import random
import re
import unicodedata
from pathlib import Path

from flask import Blueprint, request

from comptes import Refus, actuel, cx, echec, reponse
from jaquettes import EXTENSION, cle_jaquette

# Une partie : cinq jaquettes. Assez pour que la chance se dilue, assez
# court pour rejouer sans y penser.
MANCHES = 5

# Trois paliers de nettete, donc trois propositions : la jaquette se
# devoile d'un cran a chaque erreur, et la troisieme erreur perd la manche.
#
# Les deux premieres se tapent au clavier ; la troisieme, et elle seule,
# affiche des titres a choisir. Une manche donne donc sa chance a la memoire
# avant de la donner a la reconnaissance -- et une manche perdue l'est apres
# avoir vu la reponse passer sous les yeux, ce qui vaut mieux que de sortir
# d'une manche sans jamais avoir eu de prise dessus.
PROPOSITIONS = 3

# Ce que rapporte une bonne reponse, selon le rang de la proposition.
#
# Une partie sans faute vaut 1000, comme une chronologie sans faute et comme
# une grille parfaite (voir CHRONO_PAR_JEU et GRILLE_PAR_GROUPE) : trois
# mini-jeux qui se jouent a la suite doivent se comparer, et un maximum de
# 5000 d'un cote contre 1000 des deux autres faisait passer la jaquette pour
# le jeu qui rapporte, alors qu'elle est seulement celle qui compte
# autrement. MANCHES * 200 = 1000 pile, et le partage entre les trois
# propositions reste celui d'avant : moitie, puis quart.
POINTS = (200, 100, 50)

# Combien de titres proposes a la derniere proposition, la bonne reponse
# comprise. Six : quatre laisseraient une chance sur quatre a qui n'en sait
# rien, ce qui rachete trop facilement deux essais rates.
CHOIX = 6

# En dessous, il n'y a pas de quoi faire une partie honnete : il faut la
# bonne reponse de chaque manche plus de quoi remplir les leurres.
MINIMUM = CHOIX + MANCHES

# --- Chronologie -----------------------------------------------------------
# Cinq jeux a remettre dans l'ordre de sortie. Cinq et pas plus : au-dela,
# une grille a reordonner devient un travail de tri plutot qu'un souvenir a
# retrouver, et il faudrait faire defiler la page pour voir sa propre reponse.
CHRONO_JEUX = 5

# Un seul essai, et chaque jeu bien place rapporte. Pas de tout ou rien :
# une frise a moitie juste est a moitie sue, et la compter zero effacerait
# la difference entre s'etre trompe de deux places et n'avoir rien reconnu.
# Le maximum d'une partie vaut donc CHRONO_JEUX * CHRONO_PAR_JEU, soit les
# 1000 sur lesquels les trois mini-jeux se comptent (voir POINTS).
CHRONO_PAR_JEU = 200

blueprint_quiz = Blueprint("quiz", __name__, url_prefix="/api/quiz")

DOSSIER = None            # pose par blueprint_quiz_jaquettes, comme jaquettes.py
URL_PUBLIQUE = "/static/Cover/"


def branche(dossier, url_publique="/static/Cover/") -> Blueprint:
    """Dit au module ou vivent les jaquettes, et rend le blueprint.

    Meme facon de faire que blueprint_jaquettes : le chemin du dossier est
    decide par app.py, pas ecrit en dur ici.
    """
    global DOSSIER, URL_PUBLIQUE
    DOSSIER = Path(dossier)
    URL_PUBLIQUE = url_publique if url_publique.endswith("/") else url_publique + "/"
    return blueprint_quiz


def _vivier(u=None, jaquette_requise=True, details=False):
    """Les jeux jouables : un titre, une date de sortie, parfois une jaquette.

    `u` non nul : son journal a lui, prive ou non. Sinon tous les journaux
    publics.

    `jaquette_requise` : « Jaquette floue » ne peut rien faire d'un jeu dont
    l'image manque, mais « Chronologie » se joue sur des dates. Lui imposer
    la meme condition retirerait du vivier des jeux parfaitement jouables,
    pour une vignette qui n'est chez lui qu'une decoration.

    `details` : le studio, les genres et les themes en plus, dont seule la
    grille de connexions a besoin. Ils ne sont pas ajoutes d'office parce que les deux
    autres jeux renvoient leur vivier tel quel a la page -- des colonnes de
    plus y partiraient pour rien.

    Dedoublonne par titre : le meme jeu dans trois journaux, c'est une
    seule bonne reponse -- et le voir sortir deux fois dans une partie de
    cinq manches se remarquerait tout de suite.

    L'existence du fichier est verifiee ici et pas a l'affichage : une
    manche dont l'image manque, c'est une manche impossible a gagner, et
    la page n'aurait aucun moyen de le rattraper.

    `sortie <= date('now')` ecarte les jeux a paraitre, et `sortie IS NOT
    NULL` ceux dont on ignore la date -- on ne peut pas affirmer qu'ils
    sont sortis. Comparaison de texte et non de dates : `sortie` est
    ecrite en 'AAAA-MM-JJ', ou l'ordre alphabetique EST l'ordre
    chronologique.
    """
    if DOSSIER is None:
        return []
    ou, args = ("p.utilisateur_id = ?", (u["id"],)) if u else ("p.visibilite = 'publique'", ())
    vus, vivier = set(), []
    # Le meme jeu peut figurer dans plusieurs journaux, dont l'un seulement
    # rattache a une fiche IGDB : c'est la ligne la mieux renseignee qu'on
    # veut garder, et le dedoublonnage ci-dessous retient la premiere venue.
    lignes = cx().execute(
        "SELECT DISTINCT j.nom, j.id_igdb, j.sortie, j.developpeur, j.genres,"
        "       j.themes FROM jeu j"
        " JOIN page p ON p.id = j.page_id"
        f" WHERE {ou} AND j.nom IS NOT NULL AND j.nom <> ''"
        "   AND j.sortie IS NOT NULL AND j.sortie <= date('now')"
        " ORDER BY (j.developpeur IS NULL), (j.genres IS NULL), (j.themes IS NULL)", args
    ).fetchall()
    for l in lignes:
        titre = l["nom"].strip()
        cle = titre.casefold()
        if not titre or cle in vus:
            continue
        fichier = cle_jaquette(titre, l["id_igdb"])
        if fichier and (DOSSIER / (fichier + EXTENSION)).is_file():
            image = URL_PUBLIQUE + fichier + EXTENSION
        elif jaquette_requise:
            continue
        else:
            image = None
        vus.add(cle)
        jeu = {"titre": titre, "sortie": l["sortie"], "image": image}
        if details:
            jeu["developpeur"] = l["developpeur"]
            jeu["genres"] = l["genres"]
            jeu["themes"] = l["themes"]
        vivier.append(jeu)
    return vivier


def partie_jaquette_floue(u=None):
    """Une partie de « Jaquette floue » : MANCHES tirages, sans repetition.

    `u` : le vivier de son journal a soi plutot que celui de tout le monde.

    Une manche part avec tout ce qu'il lui faut pour ses trois propositions :
    les titres a choisir, dont la page ne se sert qu'a la troisieme. Les
    envoyer au dernier moment demanderait un aller-retour au milieu d'une
    manche, pour une liste de six lignes qu'on a deja sous la main.

    Les leurres sont tires du meme vivier, donc ce sont de vrais jeux que
    quelqu'un possede : une liste ou cinq titres sur six sont inventes se
    devine sans regarder l'image.
    """
    vivier = _vivier(u)
    if len(vivier) < MINIMUM:
        raise Refus("vide", "Pas assez de jeux sortis avec une jaquette pour"
                            f" jouer ({len(vivier)} trouvé{'s' if len(vivier) > 1 else ''},"
                            f" {MINIMUM} au moins).", 409)

    manches = []
    for bonne in random.sample(vivier, MANCHES):
        autres = [j["titre"] for j in vivier if j["titre"] != bonne["titre"]]
        choix = random.sample(autres, CHOIX - 1) + [bonne["titre"]]
        random.shuffle(choix)
        manches.append({"image": bonne["image"], "titre": bonne["titre"], "choix": choix})

    # La page complete la saisie a partir du vivier. Les titres partent donc
    # avec la partie plutot qu'a chaque frappe : une liste de quelques
    # centaines de noms pese moins qu'un aller-retour, et la completion
    # repond alors sans attendre.
    #
    # Ca ne revele rien de plus : les bonnes reponses sont deja dans
    # `manches`, et savoir que le jeu cherche est dans les journaux du site,
    # c'est la regle du jeu, pas une fuite.
    return {
        "ok": True,
        "manches": manches,
        "points": list(POINTS),
        "propositions": PROPOSITIONS,
        "vivier": len(vivier),
        "titres": sorted((j["titre"] for j in vivier), key=str.casefold),
    }


def partie_chronologie(u=None):
    """Une partie de « Chronologie » : CHRONO_JEUX jeux a remettre en ordre.

    `u` : le vivier de son journal a soi plutot que celui de tout le monde,
    exactement comme pour la jaquette -- c'est le meme reglage, et il n'y a
    aucune raison qu'il se comporte autrement d'un jeu a l'autre.

    Une date ne sort qu'une fois. Deux jeux sortis le meme jour donneraient
    deux ordres justes pour une seule reponse acceptee : la partie serait
    imperdable a l'oeil et invalidable au clic. On tire donc des DATES, puis
    un jeu au hasard parmi ceux qui la portent.

    L'ordre envoye est melange, et melange jusqu'a ce qu'il ne soit pas deja
    le bon : commencer une partie sur la solution affichee n'est pas un coup
    de chance, c'est une partie qui n'a pas eu lieu.

    Comme pour la jaquette, la reponse part avec la question -- ici les dates
    elles-memes, dont la page a besoin pour l'affichage final. Tant qu'aucun
    score n'est enregistre, c'est le plus simple ; voir l'avertissement en
    tete de module pour le jour ou ca comptera.
    """
    vivier = _vivier(u, jaquette_requise=False)
    par_date = {}
    for j in vivier:
        par_date.setdefault(j["sortie"], []).append(j)
    if len(par_date) < CHRONO_JEUX:
        n = len(par_date)
        raise Refus("vide", "Pas assez de jeux sortis à des dates différentes"
                            f" pour jouer ({n} date{'s' if n > 1 else ''} trouvée"
                            f"{'s' if n > 1 else ''}, {CHRONO_JEUX} au moins).", 409)

    jeux = [random.choice(par_date[d]) for d in random.sample(sorted(par_date), CHRONO_JEUX)]
    ordre = sorted(jeux, key=lambda j: j["sortie"])
    while jeux == ordre:
        random.shuffle(jeux)

    return {
        "ok": True,
        "jeux": jeux,
        "parJeu": CHRONO_PAR_JEU,
        "vivier": len(vivier),
    }


# --- Grille de connexions --------------------------------------------------
# Seize jeux en carre, quatre groupes de quatre a retrouver. La regle tient
# en une phrase ; toute la difficulte est dans le tirage.
#
# Une grille n'est jouable que si elle a UNE lecture. Trois conditions, et
# il a fallu les trois :
#
#   1. chaque categorie retenue est vraie pour ses quatre jeux et fausse
#      pour les douze autres -- c'est l'invariant tenu par _tire_grille() ;
#   2. aucun AUTRE paquet de quatre du plateau ne forme une categorie que le
#      jeu aurait pu proposer (_sans_ambiguite). Sans elle, un plateau ou
#      « Developpes par Rare » designe trois Donkey Kong plus Sea of Thieves
#      laisse passer un quatrieme Donkey Kong ailleurs : le joueur les voit,
#      les propose, a raison -- et le jeu lui repond non ;
#   3. et le plateau entier ne se range que d'une seule facon
#      (_solution_unique). Une categorie qui couvre six cases n'en designe
#      aucune en particulier -- c'est meme une excellente fausse piste --,
#      mais elle offre quinze paquets de quatre, dont certains se combinent
#      en une seconde solution complete que 2. ne voit pas.
#
# La troisieme n'a ete ajoutee qu'apres coup : tant que les categories
# etaient rares, elle etait vraie par accident. En ouvrant les genres et les
# themes, une grille tiree sur cinq est devenue resoluble de deux facons.
GRILLE_TAILLE = 4          # jeux par groupe
GRILLE_GROUPES = 4         # groupes par plateau -> 16 cases
GRILLE_ERREURS = 4         # au quatrieme faux pas, la partie est perdue

# Un groupe trouve rapporte, meme si la partie se perd ensuite : trois
# groupes sur quatre, ce sont trois liens qu'on a vus, et les compter zero
# effacerait la difference avec une grille ou l'on n'a rien reconnu. C'est
# le meme parti pris que « Chronologie ». Les vies restantes comptent a
# part -- seule facon de distinguer une grille finie du premier coup d'une
# grille finie de justesse.
#
# Le bareme est cale pour qu'une grille parfaite vaille 1000, comme une
# chronologie sans faute (CHRONO_JEUX * CHRONO_PAR_JEU) et comme cinq
# jaquettes trouvees du premier coup (MANCHES * POINTS[0]) : trois mini-jeux
# qui se jouent a la suite doivent se comparer, et un maximum de 1400 d'un
# cote contre 1000 de l'autre faisait passer la grille pour le jeu qui
# rapporte, alors qu'elle est seulement celle qui compte autrement.
#   4 groupes * 150 = 600, 4 vies * 100 = 400 -> 1000 pile.
# Le partage entre les deux reste celui d'avant, aux arrondis pres : ce
# sont les groupes qui pesent le plus, les vies departagent.
GRILLE_PAR_GROUPE = 150
GRILLE_PAR_VIE = 100

# Une categorie qui couvre plus de cette part du vivier n'est jamais
# retenue : il faudrait que les douze autres jeux du plateau y echappent
# tous. « Aventure » colle a six jeux sur dix, « PC » a huit -- ce ne sont
# pas des liens entre quatre jeux, ce sont des banalites. Le plafond les
# ecarte d'entree plutot que de les laisser faire echouer mille tirages.
#
# Il est plus haut pour le genre et le theme, et c'est voulu : « jeu de
# role », « tir », « science-fiction » sont exactement les liens qu'on
# cherche a proposer, et ils couvrent forcement une grosse part d'un vivier
# de jeux video. Les tenir sous 15 % revenait a ne jamais les sortir. Le
# surcout est supporte par le tirage, pas par le joueur : une categorie
# large contraint simplement les douze autres cases.
#
# Ce plafond definit aussi l'univers des categories PLAUSIBLES, celui contre
# lequel _sans_ambiguite() cherche une seconde solution : ce que le jeu ne
# proposera jamais, il n'a pas a l'interdire au joueur.
GRILLE_PART_MAXI = 0.15
GRILLE_PART_MAXI_PAR_NATURE = {"genre": 0.32, "theme": 0.32}

# Une seule categorie de chaque sorte par grille. Deux annees d'affilee, ou
# deux « des titres avec... », font une grille qui ne pose qu'une question
# repetee : on trouve la premiere, et la seconde se cherche exactement de la
# meme facon. Quatre sortes differentes obligent a changer de regard quatre
# fois, ce qui est tout l'interet.
#
# Il y a six natures pour quatre places : le tirage a de quoi varier.
GRILLE_MEME_NATURE = 1

# Tirages tentes avant d'abandonner. Un echec ne veut pas dire que le vivier
# est pauvre, seulement que ce melange-la n'a pas abouti : on recommence
# avec les categories dans un autre ordre. Deux tirages sur trois passent,
# donc quatre cents essais ne servent qu'a rendre l'echec impossible en
# pratique sur un vivier qui, lui, tient la route.
GRILLE_ESSAIS = 400

# Il faut de quoi remplir seize cases et de quoi choisir : en dessous, la
# meme grille reviendrait a chaque partie.
GRILLE_MINIMUM = 40

# Les genres viennent d'IGDB, donc en anglais. Le reste du site parle
# francais, et une categorie qu'il faut traduire de tete avant de la
# comprendre n'est pas une categorie, c'est un obstacle de plus. Ce qui
# manque a la table s'affiche tel quel : un genre inconnu vaut mieux qu'une
# categorie absente.
GENRES_FR = {
    "Adventure": "Aventure",
    "Arcade": "Arcade",
    "Card & Board Game": "Cartes et plateau",
    "Fighting": "Combat",
    "Hack and slash/Beat 'em up": "Beat'em all",
    "Indie": "Indépendant",
    "MOBA": "MOBA",
    "Music": "Musique",
    "Pinball": "Flipper",
    "Platform": "Plateforme",
    "Point-and-click": "Point'n click",
    "Puzzle": "Réflexion",
    "Quiz/Trivia": "Quiz",
    "Racing": "Course",
    "Real Time Strategy (RTS)": "Stratégie en temps réel",
    "Role-playing (RPG)": "Jeu de rôle",
    "Shooter": "Tir",
    "Simulator": "Simulation",
    "Sport": "Sport",
    "Strategy": "Stratégie",
    "Tactical": "Tactique",
    "Turn-based strategy (TBS)": "Stratégie au tour par tour",
    "Visual Novel": "Visual novel",
}

# Les themes IGDB, ecrits en base depuis la migration 14. Le genre dit ce
# qu'on FAIT dans un jeu -- tirer, courir, resoudre --, le theme dit dans
# quoi : la fantasy, l'espace, l'horreur, le monde ouvert. Ce sont deux
# liens differents entre quatre jeux, et le second est souvent le plus
# amusant a trouver.
#
# Le 4X traine ses quatre mots jusque dans son nom chez IGDB : personne n'a
# besoin de les lire pour reconnaitre la categorie.
THEMES_FR = {
    "Action": "Action",
    "Fantasy": "Fantasy",
    "Science fiction": "Science-fiction",
    "Horror": "Horreur",
    "Thriller": "Thriller",
    "Survival": "Survie",
    "Historical": "Historique",
    "Stealth": "Infiltration",
    "Comedy": "Humour",
    "Business": "Gestion",
    "Drama": "Drame",
    "Non-fiction": "Non-fiction",
    "Sandbox": "Bac à sable",
    "Educational": "Éducatif",
    "Kids": "Pour enfants",
    "Open world": "Monde ouvert",
    "Warfare": "Guerre",
    "Party": "Jeu de soirée",
    "4X (explore expand exploit and exterminate)": "4X",
    "Erotic": "Érotique",
    "Mystery": "Mystère",
    "Romance": "Romance",
}

# IGDB nomme les divisions internes des gros editeurs : « Nintendo EAD
# Software Development Group No.3 », « Square Enix Creative Business Unit
# IV ». C'est exact, illisible dans une etiquette, et surtout ca decoupe
# Nintendo en cinq studios dont aucun n'atteint quatre jeux. On coupe au
# premier marqueur de division ; « Blizzard Entertainment » et « Team
# NINJA » n'en portent aucun et passent intacts.
MOTIF_DIVISION = re.compile(
    r"\s+(?:Entertainment\s+Analysis|EAD|EPD|Creative\s+Business\s+Unit"
    r"|Creative\s+Studio|Business\s+Division|Product\s+Development"
    r"|Software\s+Development|Studio\s+\d|Division\s+\d|Team\s+\d)\b.*$",
    re.IGNORECASE)

# Passe ce cap, l'etiquette deborde de sa pastille et personne ne la lit :
# un studio de moins vaut mieux qu'une categorie illisible.
STUDIO_MAXI = 30

# Les mots qu'on ne retient pas pour former une categorie de titre : ils ne
# disent rien d'une serie. Les nombres partent avec eux -- « Portal 2 » et
# « Final Fantasy II » ne forment pas un groupe.
MOTS_VIDES = {
    "the", "of", "and", "a", "an", "to", "in", "on", "at", "for", "with",
    "le", "la", "les", "de", "des", "du", "un", "une", "et", "au", "aux",
    "el", "los", "las", "der", "die", "das", "ii", "iii", "iv", "vii",
    "viii", "ix", "xi", "xii", "xiii", "xiv", "xv", "xvi",
    "edition", "remastered", "remaster", "deluxe", "definitive", "goty",
    "game", "complete", "collection", "anniversary", "director", "cut",
    "enhanced", "ultimate", "special", "redux", "reloaded", "version",
}

# Un mot de trois lettres peut designer une serie -- « Ori » --, deux
# lettres jamais.
MOT_MINI = 3


def _sans_accent(texte):
    return "".join(c for c in unicodedata.normalize("NFD", texte)
                   if unicodedata.category(c) != "Mn")


def _mots_du_titre(titre):
    """Les mots d'un titre qui peuvent designer une serie.

    « The Legend of Zelda: Ocarina of Time » donne legend, zelda, ocarina,
    time. C'est ce qui permet a une categorie de dire « des titres avec
    Zelda » sans qu'on ait la moindre liste de series a tenir a jour -- et
    donc sans qu'une serie nouvelle doive etre ajoutee quelque part pour
    devenir jouable.

    La cle est sans accent et sans casse (deux titres ecrivent rarement le
    meme mot pareil), l'etiquette garde la premiere graphie rencontree :
    on affiche « Zelda » et non « zelda ».
    """
    mots = {}
    for brut in re.split(r"[^0-9A-Za-zÀ-ÿ']+", titre):
        cle = _sans_accent(brut).casefold().strip("'")
        if len(cle) < MOT_MINI or cle in MOTS_VIDES or cle.isdigit():
            continue
        mots.setdefault(cle, brut)
    return mots


def _decoupe(champ):
    """« Valve, Nintendo » -> ['Valve', 'Nintendo']. Vide si la colonne l'est."""
    return [m.strip() for m in (champ or "").split(",") if m.strip()]


def _studio(nom):
    """Le studio tel qu'on l'affichera, ou None s'il ne vaut pas la peine."""
    court = MOTIF_DIVISION.sub("", nom).strip(" ,-")
    return court if 0 < len(court) <= STUDIO_MAXI else None


def _cles_de(jeu):
    """Toutes les categories auxquelles ce jeu appartient, avec leur libelle.

    Une categorie est un couple (nature, valeur). La nature sert a deux
    choses : limiter le nombre de categories de meme sorte sur un plateau,
    et ecrire l'etiquette sans avoir a la deviner.

    Six natures, et pas de plateforme : un jeu sort sur sept machines,
    « sortis sur PlayStation 5 » n'est donc presque jamais un lien entre
    quatre jeux, et le hasard en fabrique sans arret -- c'est cette
    nature-la, a elle seule, qui rendait la moitie des tirages ambigus.
    """
    cles = {}
    annee = (jeu.get("sortie") or "")[:4]
    if annee.isdigit():
        cles[("annee", annee)] = f"Sortis en {annee}"
    for brut in _decoupe(jeu.get("developpeur")):
        nom = _studio(brut)
        if nom:
            cles[("studio", nom)] = f"Développés par {nom}"
    for g in _decoupe(jeu.get("genres")):
        cles[("genre", g)] = f"Genre : {GENRES_FR.get(g, g)}"
    for t in _decoupe(jeu.get("themes")):
        cles[("theme", t)] = f"Thème : {THEMES_FR.get(t, t)}"
    for cle, mot in _mots_du_titre(jeu["titre"]).items():
        cles[("mot", cle)] = f"Des titres avec « {mot} »"
    initiale = _sans_accent(jeu["titre"].strip()[:1]).upper()
    if initiale.isalpha():
        cles[("initiale", initiale)] = f"Des titres qui commencent par {initiale}"
    return cles


def _sans_ambiguite(groupes, univers):
    """Le plateau n'admet-il qu'une lecture ?

    On rassemble, pour chaque categorie plausible, les jeux du plateau qui
    lui appartiennent. Un paquet de quatre qui n'est pas l'un des quatre
    groupes attendus est une seconde solution : le joueur peut la trouver,
    elle est juste, et le jeu la refuserait. La grille part a la poubelle.

    Un paquet de cinq ou plus ne pose pas ce probleme : il ne forme aucun
    groupe, et six jeux Pokemon repartis dans trois groupes font meme une
    tres bonne fausse piste.
    """
    attendus = {frozenset(j["titre"] for j in g["jeux"]) for g in groupes}
    _seize, dedans = _groupes_possibles(groupes, univers)
    return all(len(s) != GRILLE_TAILLE or frozenset(s) in attendus
               for s in dedans.values())


def _groupes_possibles(groupes, univers):
    """Tous les paquets de quatre du plateau qu'une categorie plausible
    designe. C'est la matiere premiere des deux verifications ci-dessous."""
    par_titre = {j["titre"]: j for g in groupes for j in g["jeux"]}
    dedans = {}
    for titre, jeu in par_titre.items():
        for cle in jeu["_cles"]:
            if cle in univers:
                dedans.setdefault(cle, set()).add(titre)
    return frozenset(par_titre), dedans


def _solution_unique(groupes, univers):
    """Le plateau ne se range-t-il que d'une seule facon ?

    On enumere les couvertures exactes des seize cases par quatre paquets
    valides. Deux suffisent a faire jeter la grille -- inutile de les
    compter toutes.

    Le pivot est la premiere case encore libre : toute solution doit la
    couvrir, donc il suffit d'essayer les paquets qui la contiennent. C'est
    ce qui rend l'enumeration instantanee malgre les quelques centaines de
    paquets possibles.
    """
    seize, dedans = _groupes_possibles(groupes, univers)
    valides = {frozenset(p) for s in dedans.values() if len(s) >= GRILLE_TAILLE
               for p in itertools.combinations(sorted(s), GRILLE_TAILLE)}
    par_case = {}
    for paquet in valides:
        for titre in paquet:
            par_case.setdefault(titre, []).append(paquet)

    trouvees = 0

    def cherche(restant):
        nonlocal trouvees
        if trouvees > 1:
            return
        if not restant:
            trouvees += 1
            return
        for paquet in par_case.get(min(restant), ()):
            if paquet <= restant:
                cherche(restant - paquet)
                if trouvees > 1:
                    return

    cherche(seize)
    return trouvees == 1


def _tire_grille(vivier):
    """Quatre groupes de quatre, ou None si ce vivier n'en donne pas.

    L'invariant, tenu a chaque ajout plutot que verifie a la fin :

      - aucun jeu deja retenu n'appartient a la categorie qu'on ajoute ;
      - aucun jeu qu'on ajoute n'appartient a une categorie deja retenue.

    Les deux ensemble disent exactement « sur ce plateau, chaque categorie
    ne designe que ses quatre jeux » -- la demande de depart. _sans_ambiguite()
    verifie ensuite l'autre moitie du contrat : qu'aucune AUTRE categorie ne
    designe quatre jeux du plateau.
    """
    for j in vivier:
        j["_cles"] = _cles_de(j)

    par_cle, etiquettes, frequence = {}, {}, collections.Counter()
    for j in vivier:
        for cle, nom in j["_cles"].items():
            par_cle.setdefault(cle, []).append(j)
            etiquettes[cle] = nom
            frequence[cle] += 1

    def plafond(nature):
        part = GRILLE_PART_MAXI_PAR_NATURE.get(nature, GRILLE_PART_MAXI)
        return max(GRILLE_TAILLE, int(len(vivier) * part))

    univers = {c for c, n in frequence.items()
               if GRILLE_TAILLE <= n <= plafond(c[0])}
    if len(univers) < GRILLE_GROUPES:
        return None

    # Le tirage se fait par NATURE d'abord, pas par categorie. En melangeant
    # les categories toutes ensemble, celles d'une nature nombreuse sortaient
    # bien plus souvent que les autres : il y a une cinquantaine de mots de
    # titre pour une douzaine de themes, et les grilles finissaient par se
    # ressembler. Tirer d'abord l'ordre des natures donne a chacune la meme
    # chance d'occuper l'une des quatre places -- ce qui est justement le
    # point, puisqu'il n'y en a qu'une par grille.
    par_nature = {}
    for c in sorted(univers):
        par_nature.setdefault(c[0], []).append(c)
    natures_dispo = sorted(par_nature)

    for _ in range(GRILLE_ESSAIS):
        random.shuffle(natures_dispo)
        cles = []
        for nature in natures_dispo:
            random.shuffle(par_nature[nature])
            cles.extend(par_nature[nature])
        groupes, pris, titres, prises = [], [], set(), set()
        natures = collections.Counter()
        for cle in cles:
            if len(groupes) == GRILLE_GROUPES:
                break
            if natures[cle[0]] >= GRILLE_MEME_NATURE:
                continue
            # aucun jeu deja retenu n'appartient a cette categorie-ci...
            if any(cle in j["_cles"] for j in pris):
                continue
            # ...et aucun jeu qu'on prendrait n'appartient a une categorie
            # deja retenue, ni n'est deja sur le plateau
            libres = [j for j in par_cle[cle]
                      if j["titre"] not in titres and prises.isdisjoint(j["_cles"])]
            if len(libres) < GRILLE_TAILLE:
                continue
            choix = random.sample(libres, GRILLE_TAILLE)
            groupes.append({"titre": etiquettes[cle], "nature": cle[0], "jeux": choix})
            pris.extend(choix)
            titres.update(j["titre"] for j in choix)
            prises.add(cle)
            natures[cle[0]] += 1
        if len(groupes) != GRILLE_GROUPES:
            continue
        # la seconde est bien plus couteuse que la premiere : on ne la pose
        # qu'aux plateaux qui ont deja passe l'autre
        if _sans_ambiguite(groupes, univers) and _solution_unique(groupes, univers):
            return groupes
    return None


def partie_grille(u=None):
    """Une partie de « Grille de connexions » : seize jeux, quatre liens.

    `u` : le vivier de son journal a soi plutot que celui de tout le monde,
    comme les deux autres jeux -- c'est le meme reglage.

    La jaquette n'est pas exigee : elle n'est ici qu'un fond de case, et
    l'imposer retirerait du vivier des jeux parfaitement jouables.

    L'ordre des groupes est melange avant l'envoi : la page leur donne une
    couleur dans l'ordre ou ils arrivent, et un tirage qui les rendrait
    toujours dans le meme ordre de nature ferait de la couleur un indice.

    Comme pour les deux autres jeux, la reponse part avec la question et
    c'est la page qui corrige -- voir l'avertissement en tete de module. Ici
    plus qu'ailleurs, la solution se lit en ouvrant la console ; tant
    qu'aucun score n'est enregistre, on ne triche que contre soi.
    """
    vivier = _vivier(u, jaquette_requise=False, details=True)
    if len(vivier) < GRILLE_MINIMUM:
        raise Refus("vide", "Pas assez de jeux sortis pour bâtir une grille"
                            f" ({len(vivier)} trouvé{'s' if len(vivier) > 1 else ''},"
                            f" {GRILLE_MINIMUM} au moins).", 409)

    groupes = _tire_grille(vivier)
    if groupes is None:
        raise Refus("vide", "Ces jeux-là ne donnent aucune grille sans"
                            " ambiguïté : il faudrait des studios, des genres"
                            " ou des années plus variés.", 409)
    random.shuffle(groupes)

    return {
        "ok": True,
        "groupes": [{
            "titre": g["titre"],
            "nature": g["nature"],
            # `_cles` ne sort pas d'ici : c'est un outil de tirage, et la
            # page n'a que faire des categories auxquelles un jeu echappe
            "jeux": [{"titre": j["titre"], "image": j["image"]} for j in g["jeux"]],
        } for g in groupes],
        "erreurs": GRILLE_ERREURS,
        "parGroupe": GRILLE_PAR_GROUPE,
        "parVie": GRILLE_PAR_VIE,
        "vivier": len(vivier),
    }


@blueprint_quiz.errorhandler(Refus)
def _refus(err):
    return echec(err.code, err.message, err.statut)


# Les trois routes ci-dessous etaient reservees a l'administration tant que
# les jeux n'etaient pas finis. Elles sont ouvertes a tout le monde depuis
# qu'ils le sont, visiteurs compris : le vivier par defaut est celui des
# journaux publics, et jouer avec ne demande pas de compte.
#
# `actuel()` peut donc rendre None, et c'est prevu : `u if mien else None`
# passe alors None dans les deux cas, c'est-a-dire les journaux publics. Un
# ?source=moi tape a la main par un visiteur ne lui ouvre le journal de
# personne -- il n'en a simplement pas.


@blueprint_quiz.get("/jaquette-floue")
def jaquette_floue():
    """?source=moi|tous

    Le reglage passe en parametre d'adresse et non en corps : c'est une
    lecture, elle ne change rien, et une partie doit pouvoir se relancer d'un
    simple rechargement.
    """
    u = actuel()
    mien = request.args.get("source", "tous") == "moi"
    return reponse(partie_jaquette_floue(u if mien else None))


@blueprint_quiz.get("/chronologie")
def chronologie():
    """?source=moi|tous

    Le meme reglage que la jaquette, sous le meme nom : deux jeux qui piochent
    dans le meme vivier n'ont pas a se demander de deux facons.
    """
    u = actuel()
    mien = request.args.get("source", "tous") == "moi"
    return reponse(partie_chronologie(u if mien else None))


@blueprint_quiz.get("/grille")
def grille():
    """?source=moi|tous

    Le troisieme jeu, le meme reglage. Un tirage coute quelques centaines de
    tirages rates au pire (voir GRILLE_ESSAIS) : c'est du calcul pur sur une
    liste deja en memoire, pas un aller-retour de plus.
    """
    u = actuel()
    mien = request.args.get("source", "tous") == "moi"
    return reponse(partie_grille(u if mien else None))
