#!/usr/bin/env python3
"""Nihongo : apprendre le japonais, un peu chaque jour.

app.py branche ce fichier en une ligne :

    app.register_blueprint(nihongo.branche(STATIQUE / "nihongo"))

Le projet est en chantier, donc reserve a l'administration : la tuile ne
s'affiche que pour elle (voir `admin: true` dans abyss/accueil.html), et
toutes les routes de ce module repondent 404 aux autres -- la meme parade
que cartes.py.

Ce que le serveur garde, et ce qu'il ne garde pas
-------------------------------------------------
La matiere -- les kanas et les kanjis, leurs traces, le vocabulaire, la
grammaire, plus tard les phrases -- ne vit pas en base. Ce sont des fichiers
figes sous static/nihongo/, fabriques une fois depuis des sources ouvertes
(voir « La matiere : les sources ») ou ecrites a la main (matiere/), et
servis comme n'importe quel JSON : ils sont les memes pour tout le monde et
ne changent qu'a la main.

La base ne garde que ce qui est a quelqu'un :

  - `nihongo_carte` : une ligne par chose apprise et par facon de la
    travailler. « kana:あ:lire » (voir あ, taper « a ») et « kana:あ:ecrire »
    (entendre « a », tracer あ) sont deux cartes : on reconnait un caractere
    bien avant de savoir l'ecrire, et les melanger ferait revenir trop tot
    l'un ou trop tard l'autre. Meme chose pour « kanji:日:sens » et
    « kanji:日:ecrire », et pour les trois cartes d'un mot :
    « mot:食べる・たべる:sens », « :lire » et « :dire » (voir mots.js), et
    pour la carte d'un point de grammaire, « gram:te-kudasai:completer » ;
  - `nihongo_jour` : ce qui a ete fait chaque jour, d'ou la serie de jours
    d'affilee et l'historique de la page Progres ;
  - `nihongo_lecture` : les textes lus, combien de fois, et ce qu'on en a
    compris ; `nihongo_demande`, les mots qu'on a demande a apprendre en
    lisant (voir « La lecture »).

La repetition espacee
---------------------
Chaque reponse donne une note de 1 a 4 (raté, difficile, bien, facile) et la
carte revient quand on a encore neuf chances sur dix de s'en souvenir :
c'est FSRS-5, l'algorithme d'Anki depuis 2023, avec ses poids par defaut.
Il tient en une vingtaine de lignes (voir « FSRS » plus bas) et retient
deux nombres par carte -- la stabilite, en jours, et la difficulte, de 1 a
10.

Deux entorses, toutes deux du cote de la prudence :

  - une carte ratee revient dix minutes plus tard, et non le lendemain : la
    seance la repose d'elle-meme, mais quelqu'un qui revient dans la soiree
    doit la retrouver ;
  - une carte vue pour la premiere fois aujourd'hui revient demain, quoi
    qu'en dise la formule. FSRS laisserait trois jours a un kana « bien »
    reconnu trente secondes apres l'avoir decouvert ; revoir le lendemain ce
    qu'on vient d'apprendre est la plus vieille regle de la memorisation.

Les jours basculent a 4 h, heure de Paris, comme dans Anki : une seance
finie a une heure du matin compte pour la veille, et les cartes du jour
arrivent toutes ensemble au reveil plutot qu'a l'heure exacte ou on les a
vues la veille.

Le test de niveau
-----------------
Quelqu'un qui sait deja lire les kanas, ou qui a le N3, ne doit pas les
redecouvrir un par un. Le test (voir « Le test de niveau » dans nihongo.js)
dit ce qui est su ; ses cartes naissent d'un coup, deja solides (voir
`place`), et ne reviennent que de loin en loin, pour verifier. Elles ont
zero revision : c'est a cela que la page les distingue des decouvertes du
jour.

Les fichiers
------------
    static/nihongo/traces-kana.json        les traits des kanas
    static/nihongo/kanji.json              les 2 230 kanjis du JLPT : sens,
                                           lectures, morceaux, mots courants
    static/nihongo/traces-kanji-n5.json    leurs traits, un fichier par niveau
    ...                                    (N1 pese 1,2 Mo : la page ne le
    static/nihongo/traces-kanji-n1.json     demande que si on en est la)
    static/nihongo/vocabulaire.json        les 7 900 mots du JLPT
    static/nihongo/grammaire.json          les points de grammaire, N5 a N1
    static/nihongo/romaji.json             la grammaire et les textes en romaji,
                                           pour qui regle la page ainsi
    matiere/vocabulaire-fr.tsv             les sens francais des mots
    matiere/grammaire-n5.txt ... -n1.txt   la grammaire : explications et
                                           phrases d'exemple
    (matiere/ : des sources ecrites a la main, et non des produits)

Les traits sont des chemins SVG de KanjiVG, dans l'ordre. La page les
dessine, les anime, et en tire elle-meme les points qu'elle compare au doigt
(static/nihongo/trace.js) : des chemins seuls pesent deux fois moins que
chemins et points. Le meme calcul existe ici (polyligne) pour refuser a la
fabrication tout chemin que la page ne saurait pas lire.

    venv/bin/python nihongo.py matiere     # refait tous les fichiers

Les sources sont telechargees une fois dans donnees/nihongo/ (une vingtaine
de Mo, jamais servis) ; refaire les fichiers prend une dizaine de secondes.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import random
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Blueprint, request

from comptes import Refus, actuel, corps, cx, echec, reponse

BASE = Path(__file__).parent.resolve()
DOSSIER_CACHE = BASE / "donnees" / "nihongo"
STATIQUE = BASE / "static" / "nihongo"

KANJIVG = ("https://github.com/KanjiVG/kanjivg/releases/download/"
           "r20260714/kanjivg-20260714.xml.gz")

PARIS = ZoneInfo("Europe/Paris")
BASCULE = 4                    # le jour d'apprentissage commence a 4 h

# --------------------------------------------------------------------------
#   FSRS
# --------------------------------------------------------------------------
# Les 19 poids par defaut de FSRS-5. Ils ont ete ajustes sur des centaines
# de millions de revisions Anki ; les recalculer pour une seule personne
# demanderait des milliers de revisions, on verra le jour ou il y en aura.
POIDS = (0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
         1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
         2.9898, 0.51655, 0.6621)
RETENTION = 0.9                # la carte revient a 90 % de chances de s'en souvenir
DECROISSANCE = -0.5
FACTEUR = 0.9 ** (1 / DECROISSANCE) - 1        # 19/81 : R(S) = 90 %
INTERVALLE_MAXI = 3650         # dix ans : au-dela, ce n'est plus une revision
REPRISE = timedelta(minutes=10)                # une carte ratee revient vite

NOTES = (1, 2, 3, 4)           # rate, difficile, bien, facile
MOTIF_CLE = re.compile(r"^[a-z]{2,12}:[^\s:]{1,24}:[a-z]{2,12}$")
MOTIF_TEXTE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MOTIF_MOT = re.compile(r"^mot:[^\s:]{1,24}$")
SECONDES_MAXI = 120            # une reponse laissee ouverte pendant le cafe
SECONDES_LECTURE = 3600        # un texte se lit plus longtemps qu'une carte
COMPRIS = (1, 2, 3)            # peu, l'essentiel, tout


def _borne(d: float) -> float:
    return min(10.0, max(1.0, d))


def difficulte_initiale(note: int) -> float:
    w = POIDS
    return w[4] - math.exp(w[5] * (note - 1)) + 1


def recuperabilite(jours: float, stabilite: float) -> float:
    """Les chances de s'en souvenir, `jours` apres la derniere revision."""
    return (1 + FACTEUR * jours / stabilite) ** DECROISSANCE


def intervalle(stabilite: float) -> int:
    """Dans combien de jours la carte tombe a RETENTION."""
    jours = stabilite / FACTEUR * (RETENTION ** (1 / DECROISSANCE) - 1)
    return max(1, min(INTERVALLE_MAXI, round(jours)))


def prochaine_difficulte(d: float, note: int) -> float:
    w = POIDS
    d2 = d - w[6] * (note - 3) * (10 - d) / 9        # amortie pres de 10
    return _borne(w[7] * difficulte_initiale(4) + (1 - w[7]) * d2)


def stabilite_apres_succes(d, s, r, note) -> float:
    w = POIDS
    penalite = w[15] if note == 2 else 1
    bonus = w[16] if note == 4 else 1
    return s * (1 + math.exp(w[8]) * (11 - d) * s ** -w[9]
                * (math.exp((1 - r) * w[10]) - 1) * penalite * bonus)


def stabilite_apres_oubli(d, s, r) -> float:
    w = POIDS
    longue = w[11] * d ** -w[12] * ((s + 1) ** w[13] - 1) * math.exp((1 - r) * w[14])
    return min(longue, s / math.exp(w[17] * w[18]))


def stabilite_meme_jour(s, note) -> float:
    """Une deuxieme revision le meme jour : la memoire n'a pas eu le temps
    d'oublier, la formule a long terme n'a rien a mesurer."""
    w = POIDS
    return s * math.exp(w[17] * (note - 3 + w[18]))


def jour_de(quand: datetime) -> date:
    """Le jour d'apprentissage : la date de Paris, decalee de BASCULE heures."""
    return (quand.astimezone(PARIS) - timedelta(hours=BASCULE)).date()


def debut_du_jour(jour: date) -> datetime:
    return datetime.combine(jour, time(BASCULE), tzinfo=PARIS).astimezone(timezone.utc)


def _iso(quand: datetime) -> str:
    return quand.astimezone(timezone.utc).isoformat(timespec="seconds")


def revise(carte, note: int, quand: datetime) -> dict:
    """Le nouvel etat d'une carte apres une reponse. `carte` vaut None la
    premiere fois. Ne touche pas a la base : c'est ce qui se teste."""
    aujourd_hui = jour_de(quand)
    if carte is None:
        s = max(0.1, POIDS[note - 1])
        d = _borne(difficulte_initiale(note))
        revisions, oublis, cree = 1, 0, aujourd_hui
    else:
        vue = jour_de(datetime.fromisoformat(carte["vue_le"]))
        ecart = (aujourd_hui - vue).days
        s0, d0 = carte["stabilite"], carte["difficulte"]
        if ecart <= 0:
            s = stabilite_meme_jour(s0, note)
        else:
            r = recuperabilite(ecart, s0)
            s = (stabilite_apres_succes(d0, s0, r, note) if note > 1
                 else stabilite_apres_oubli(d0, s0, r))
        d = prochaine_difficulte(d0, note)
        revisions = carte["revisions"] + 1
        oublis = carte["oublis"] + (1 if note == 1 and ecart > 0 else 0)
        cree = jour_de(datetime.fromisoformat(carte["cree_le"]))
    s = max(0.1, s)

    if note == 1:
        echeance = quand + REPRISE
    else:
        jours = 1 if cree == aujourd_hui else intervalle(s)
        echeance = debut_du_jour(aujourd_hui + timedelta(days=jours))
    return {"stabilite": round(s, 4), "difficulte": round(d, 4),
            "echeance": _iso(echeance), "vue_le": _iso(quand),
            "revisions": revisions, "oublis": oublis,
            "cree_le": carte["cree_le"] if carte else _iso(quand)}


# --------------------------------------------------------------------------
#   Base
# --------------------------------------------------------------------------
def _carte(uid, cle):
    l = cx().execute("SELECT * FROM nihongo_carte WHERE utilisateur_id = ? AND cle = ?",
                     (uid, cle)).fetchone()
    return dict(l) if l else None


def _publique(l) -> dict:
    """Ce que la page garde d'une carte : court, elle en recoit des centaines."""
    return {"e": l["echeance"], "s": l["stabilite"], "d": l["difficulte"],
            "n": l["revisions"], "o": l["oublis"], "c": l["cree_le"]}


def _journee(uid, jour: date) -> dict:
    l = cx().execute("SELECT revisions, justes, nouvelles, secondes, lectures FROM nihongo_jour"
                     " WHERE utilisateur_id = ? AND jour = ?",
                     (uid, jour.isoformat())).fetchone()
    return dict(l) if l else {"revisions": 0, "justes": 0, "nouvelles": 0, "secondes": 0,
                              "lectures": 0}


def serie(uid, aujourd_hui: date) -> int:
    """Les jours d'affilee avec au moins une revision ou un texte lu. Une
    serie qui s'arrete hier tient encore : la journee n'est pas finie."""
    jours = {date.fromisoformat(l[0]) for l in cx().execute(
        "SELECT jour FROM nihongo_jour WHERE utilisateur_id = ?"
        " AND (revisions > 0 OR lectures > 0) ORDER BY jour DESC LIMIT 4000", (uid,))}
    j = aujourd_hui if aujourd_hui in jours else aujourd_hui - timedelta(days=1)
    n = 0
    while j in jours:
        n += 1
        j -= timedelta(days=1)
    return n


def enregistre(uid, cle, note, secondes, quand=None) -> dict:
    """Une reponse : la carte avance, la journee se remplit."""
    quand = quand or datetime.now(timezone.utc)
    ancienne = _carte(uid, cle)
    neuve = revise(ancienne, note, quand)
    jour = jour_de(quand).isoformat()
    c = cx()
    with c:
        c.execute(
            "INSERT INTO nihongo_carte(utilisateur_id, cle, stabilite, difficulte,"
            " echeance, vue_le, revisions, oublis, cree_le)"
            " VALUES (?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(utilisateur_id, cle) DO UPDATE SET"
            "  stabilite = excluded.stabilite, difficulte = excluded.difficulte,"
            "  echeance = excluded.echeance, vue_le = excluded.vue_le,"
            "  revisions = excluded.revisions, oublis = excluded.oublis",
            (uid, cle, neuve["stabilite"], neuve["difficulte"], neuve["echeance"],
             neuve["vue_le"], neuve["revisions"], neuve["oublis"], neuve["cree_le"]))
        c.execute(
            "INSERT INTO nihongo_jour(utilisateur_id, jour, revisions, justes, nouvelles, secondes)"
            " VALUES (?,?,1,?,?,?)"
            " ON CONFLICT(utilisateur_id, jour) DO UPDATE SET"
            "  revisions = revisions + 1, justes = justes + excluded.justes,"
            "  nouvelles = nouvelles + excluded.nouvelles,"
            "  secondes = secondes + excluded.secondes",
            (uid, jour, 1 if note > 1 else 0, 1 if ancienne is None else 0, secondes))
    return neuve


# Ce que le test de niveau juge su : (stabilite, premier et dernier jour
# ou la carte peut revenir). Le test lit et comprend, il ne trace pas :
# l'ecriture revient donc dans les trois mois, pour verifier ; le reste dans
# l'annee. Les echeances s'etalent au hasard sur ces jours, sinon tout le N4
# reviendrait le meme matin.
PLACEE = (365.0, 7, 365)
PLACEE_ECRIRE = (90.0, 2, 90)
PLACEES_MAXI = 25000           # tout le JLPT, kanas compris, avec de la marge


def place(uid, cles, quand=None, hasard=None) -> int:
    """Les cartes de ce que le test de niveau juge su. Une carte qui existe
    deja ne bouge pas : le test ajoute, il ne corrige rien. Rend le nombre
    de cartes creees."""
    quand = quand or datetime.now(timezone.utc)
    hasard = hasard or random.Random()
    aujourd_hui = jour_de(quand)
    d = round(_borne(difficulte_initiale(3)), 4)
    lignes = []
    for cle in cles:
        s, de, a = PLACEE_ECRIRE if cle.endswith(":ecrire") else PLACEE
        echeance = debut_du_jour(aujourd_hui + timedelta(days=hasard.randint(de, a)))
        lignes.append((uid, cle, s, d, _iso(echeance), _iso(quand), _iso(quand)))
    c = cx()
    with c:
        avant = c.total_changes
        c.executemany(
            "INSERT OR IGNORE INTO nihongo_carte(utilisateur_id, cle, stabilite, difficulte,"
            " echeance, vue_le, revisions, oublis, cree_le) VALUES (?,?,?,?,?,?,0,0,?)", lignes)
        return c.total_changes - avant


def lit_texte(uid, texte, compris, secondes, quand=None) -> dict:
    """Un texte lu jusqu'au bout : sa ligne, et la journee."""
    quand = _iso(quand or datetime.now(timezone.utc))
    jour = jour_de(datetime.fromisoformat(quand)).isoformat()
    c = cx()
    with c:
        c.execute(
            "INSERT INTO nihongo_lecture(utilisateur_id, texte, premiere_le, lu_le, fois, compris)"
            " VALUES (?,?,?,?,1,?)"
            " ON CONFLICT(utilisateur_id, texte) DO UPDATE SET"
            "  lu_le = excluded.lu_le, fois = fois + 1, compris = excluded.compris",
            (uid, texte, quand, quand, compris))
        c.execute(
            "INSERT INTO nihongo_jour(utilisateur_id, jour, lectures, secondes) VALUES (?,?,1,?)"
            " ON CONFLICT(utilisateur_id, jour) DO UPDATE SET"
            "  lectures = lectures + 1, secondes = secondes + excluded.secondes",
            (uid, jour, secondes))
    return _lectures(uid)[texte]


def _lectures(uid) -> dict:
    """{texte: {p: premiere lecture, l: derniere, f: fois, c: compris}}"""
    return {l["texte"]: {"p": l["premiere_le"], "l": l["lu_le"], "f": l["fois"], "c": l["compris"]}
            for l in cx().execute("SELECT * FROM nihongo_lecture WHERE utilisateur_id = ?", (uid,))}


def _demandes(uid) -> list:
    """Les mots demandes en lisant et pas encore decouverts, du plus ancien
    au plus recent. Ceux qui ont leur premiere carte s'effacent."""
    c = cx()
    with c:
        c.execute("DELETE FROM nihongo_demande WHERE utilisateur_id = ? AND EXISTS ("
                  " SELECT 1 FROM nihongo_carte k WHERE k.utilisateur_id = nihongo_demande.utilisateur_id"
                  " AND k.cle = nihongo_demande.mot || ':sens')", (uid,))
    return [l[0] for l in c.execute("SELECT mot FROM nihongo_demande WHERE utilisateur_id = ?"
                                    " ORDER BY demande_le, mot", (uid,))]


# --------------------------------------------------------------------------
#   Routes
# --------------------------------------------------------------------------
blueprint_nihongo = Blueprint("nihongo", __name__, url_prefix="/api/nihongo")


def branche(dossier) -> Blueprint:
    """Dit au module ou vit sa matiere, et rend le blueprint."""
    global STATIQUE
    STATIQUE = Path(dossier)
    return blueprint_nihongo


@blueprint_nihongo.before_request
def reserve():
    """Reserve a l'administration tant que le projet est en chantier.

    Le controle est ici et non route par route, comme dans cartes.py : un
    oubli en ajoutant la prochaine route ne pardonnerait pas. Le jour de
    l'ouverture, c'est cette fonction qu'on assouplit -- un compte suffira,
    puisque chacun a sa propre progression.
    """
    if request.method in ("POST", "PUT", "PATCH") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    u = actuel()
    if u is None or not u["admin"]:
        return echec("introuvable", "Page inconnue.", 404)
    return None


@blueprint_nihongo.errorhandler(Refus)
def _refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_nihongo.get("/etat")
def etat():
    """Tout ce que la page doit savoir pour composer la seance du jour.

    Toutes les cartes partent d'un coup : la page en tire ce qui est du, ce
    qui est nouveau et la couleur de chaque case du tableau des kanas, et
    quelques centaines de lignes courtes pesent moins qu'un aller-retour par
    ecran.
    """
    u = actuel()
    maintenant = datetime.now(timezone.utc)
    aujourd_hui = jour_de(maintenant)
    cartes = {l["cle"]: _publique(l) for l in cx().execute(
        "SELECT * FROM nihongo_carte WHERE utilisateur_id = ?", (u["id"],))}
    depuis = (aujourd_hui - timedelta(days=182)).isoformat()
    historique = [dict(l) for l in cx().execute(
        "SELECT jour, revisions, justes, secondes, lectures FROM nihongo_jour"
        " WHERE utilisateur_id = ? AND jour >= ? ORDER BY jour", (u["id"], depuis))]
    return reponse({"ok": True, "maintenant": _iso(maintenant),
                    "jour": aujourd_hui.isoformat(),
                    # le debut du jour d'apprentissage : ce qui a ete cree
                    # depuis est nouveau d'aujourd'hui
                    "debut": _iso(debut_du_jour(aujourd_hui)),
                    "aujourdhui": _journee(u["id"], aujourd_hui),
                    "serie": serie(u["id"], aujourd_hui),
                    "cartes": cartes, "historique": historique,
                    "lectures": _lectures(u["id"]), "demandes": _demandes(u["id"])})


@blueprint_nihongo.post("/reponse")
def repond():
    """Une reponse a une carte. {cle, note (1 a 4), secondes}."""
    u = actuel()
    d = corps()
    cle = d.get("cle")
    note = d.get("note")
    if not isinstance(cle, str) or not MOTIF_CLE.match(cle):
        raise Refus("cle", "Carte inconnue.")
    if isinstance(note, bool) or note not in NOTES:
        raise Refus("note", "La note va de 1 a 4.")
    secondes = d.get("secondes")
    secondes = (0 if isinstance(secondes, bool) or not isinstance(secondes, (int, float))
                else max(0, min(SECONDES_MAXI, int(secondes))))
    carte = enregistre(u["id"], cle, note, secondes)
    aujourd_hui = jour_de(datetime.now(timezone.utc))
    return reponse({"ok": True, "cle": cle, "carte": _publique(carte),
                    "aujourdhui": _journee(u["id"], aujourd_hui),
                    "serie": serie(u["id"], aujourd_hui)})


@blueprint_nihongo.post("/lu")
def lu():
    """Un texte lu jusqu'au bout. {texte, compris (1 a 3), secondes}."""
    u = actuel()
    d = corps()
    texte, compris = d.get("texte"), d.get("compris")
    if not isinstance(texte, str) or len(texte) > 40 or not MOTIF_TEXTE.match(texte):
        raise Refus("texte", "Texte inconnu.")
    if isinstance(compris, bool) or compris not in COMPRIS:
        raise Refus("compris", "Compris : de 1 a 3.")
    secondes = d.get("secondes")
    secondes = (0 if isinstance(secondes, bool) or not isinstance(secondes, (int, float))
                else max(0, min(SECONDES_LECTURE, int(secondes))))
    lecture = lit_texte(u["id"], texte, compris, secondes)
    aujourd_hui = jour_de(datetime.now(timezone.utc))
    return reponse({"ok": True, "texte": texte, "lecture": lecture,
                    "aujourdhui": _journee(u["id"], aujourd_hui),
                    "serie": serie(u["id"], aujourd_hui)})


@blueprint_nihongo.post("/niveau")
def niveau():
    """Ce que le test de niveau juge su. {cles: [« kana:あ:lire », ...]}."""
    u = actuel()
    cles = corps().get("cles")
    if not isinstance(cles, list) or not 1 <= len(cles) <= PLACEES_MAXI \
            or not all(isinstance(k, str) and MOTIF_CLE.match(k) for k in cles):
        raise Refus("cles", "Cartes inconnues.")
    return reponse({"ok": True, "placees": place(u["id"], dict.fromkeys(cles))})


DEMANDES_MAXI = 300            # les mots d'un texte de N1, et de la marge


@blueprint_nihongo.post("/demande")
def demande():
    """Demander a apprendre des mots rencontres en lisant, ou y renoncer.
    {mots: [« mot:食べる・たべる », ...], oui}."""
    u = actuel()
    d = corps()
    mots, oui = d.get("mots"), d.get("oui", True)
    if not isinstance(mots, list) or not 1 <= len(mots) <= DEMANDES_MAXI \
            or not all(isinstance(m, str) and MOTIF_MOT.match(m) for m in mots):
        raise Refus("mots", "Mots inconnus.")
    if not isinstance(oui, bool):
        raise Refus("oui", "oui : vrai ou faux.")
    c = cx()
    with c:
        quand = _iso(datetime.now(timezone.utc))
        if oui:
            c.executemany("INSERT OR IGNORE INTO nihongo_demande(utilisateur_id, mot, demande_le)"
                          " VALUES (?,?,?)", [(u["id"], m, quand) for m in mots])
        else:
            c.executemany("DELETE FROM nihongo_demande WHERE utilisateur_id = ? AND mot = ?",
                          [(u["id"], m) for m in mots])
    return reponse({"ok": True, "demandes": _demandes(u["id"])})


# --------------------------------------------------------------------------
#   La matiere : les sources
# --------------------------------------------------------------------------
# Toutes libres, toutes telechargees une fois dans donnees/nihongo/ (jamais
# servi) et relues a chaque fabrication :
#
#   - KanjiVG (Ulrich Apel, CC BY-SA 3.0) : les traits de chaque caractere,
#     dans l'ordre, et sa decomposition (休 = 亻 + 木) ;
#   - KANJIDIC2 (EDRDG, CC BY-SA 4.0) : sens -- en francais pour tous les
#     kanjis de N5 a N2 --, lectures, nombre de traits, annee d'ecole,
#     rang de frequence ;
#   - les niveaux du JLPT : le JLPT ne publie plus de liste depuis 2010, on
#     prend celles de Jonathan Waller, la reference, telles que les reprend
#     le jeu de donnees kanji-data (MIT) ;
#   - JMdict (EDRDG, CC BY-SA 4.0) : les mots d'exemple, avec ses marques de
#     frequence, et sa traduction francaise par jmdict-simplified quand elle
#     existe (un peu plus d'un mot courant sur deux) ;
#   - le vocabulaire du JLPT : les listes de Jonathan Waller (CC BY), que
#     yomitan-jlpt-vocab (CC BY-SA 4.0) a rattachees mot par mot a leur
#     entree de JMdict. Leurs sens francais sont traduits a la main, dans
#     matiere/vocabulaire-fr.tsv (voir « Le vocabulaire »).
VOCABULAIRE_JLPT = ("https://raw.githubusercontent.com/stephenmk/yomitan-jlpt-vocab/"
                    "b062d4e38c4bdd0950ae1d4ec55f04b176182e03/original_data/n{}.csv")
SOURCES = {
    "kanjivg.xml.gz": KANJIVG,
    "kanjidic2.xml.gz": "http://www.edrdg.org/kanjidic/kanjidic2.xml.gz",
    "jlpt.json": "https://raw.githubusercontent.com/davidluzgouveia/kanji-data/master/kanji.json",
    "JMdict_e.gz": "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz",
    "jmdict-fre.json.tgz": ("https://github.com/scriptin/jmdict-simplified/releases/download/"
                            "3.6.2+20260928191014/jmdict-fre-3.6.2+20260928191014.json.tgz"),
    **{f"vocabulaire-n{n}.csv": VOCABULAIRE_JLPT.format(n) for n in range(1, 6)},
}
KVG = "{http://kanjivg.tagaini.net}"
MOTS_PAR_KANJI = 3


def source(nom) -> Path:
    """Le fichier `nom`, telecharge la premiere fois et garde ensuite."""
    chemin = DOSSIER_CACHE / nom
    if not chemin.is_file():
        import requests
        DOSSIER_CACHE.mkdir(parents=True, exist_ok=True)
        r = requests.get(SOURCES[nom], timeout=180)
        r.raise_for_status()
        chemin.write_bytes(r.content)
    return chemin


# --------------------------------------------------------------------------
#   Les traces (KanjiVG)
# --------------------------------------------------------------------------
_NOMBRE = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_JETON = re.compile(r"[MmCcSsLl]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _cubique(p0, p1, p2, p3, pas=16):
    """Les points d'une courbe de Bezier cubique, extremites comprises sauf p0."""
    for i in range(1, pas + 1):
        t = i / pas
        u = 1 - t
        yield (u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
               u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1])


def polyligne(d: str) -> list:
    """Un chemin SVG de KanjiVG mis a plat en points.

    KanjiVG n'emploie que M, C et S, en absolu et en relatif, avec des
    repetitions implicites (« c 1,2 3,4 5,6 7,8 9,10 11,12 » : deux
    courbes). L et l sont acceptes en plus, par prudence ; tout autre
    commande leve ValueError plutot que de dessiner faux.

    La page fait le meme calcul (static/nihongo/trace.js, polyligne) : les
    fichiers ne portent que les chemins, deux fois plus legers que chemins
    et points. Ici, il sert de garde -- un chemin que cette fonction refuse
    n'entre pas dans un fichier, la page ne saurait pas le lire non plus.
    """
    jetons = _JETON.findall(d)
    i, cmd = 0, None
    x = y = 0.0
    dernier_ctrl = None
    points = []

    def nombres(n):
        nonlocal i
        morceau = jetons[i:i + n]
        if len(morceau) < n or any(not _NOMBRE.fullmatch(v) for v in morceau):
            raise ValueError(f"chemin tronque : {d!r}")
        i += n
        return [float(v) for v in morceau]

    while i < len(jetons):
        if not _NOMBRE.fullmatch(jetons[i]):
            cmd = jetons[i]
            i += 1
        elif cmd is None:
            raise ValueError(f"chemin sans commande : {d!r}")
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            dx, dy = nombres(2)
            x, y = (x + dx, y + dy) if rel else (dx, dy)
            points.append((x, y))
            dernier_ctrl = None
            cmd = "l" if rel else "L"           # la suite d'un M est un L
        elif c == "L":
            dx, dy = nombres(2)
            x, y = (x + dx, y + dy) if rel else (dx, dy)
            points.append((x, y))
            dernier_ctrl = None
        elif c in ("C", "S"):
            if c == "C":
                x1, y1, x2, y2, x3, y3 = nombres(6)
                if rel:
                    x1, y1, x2, y2, x3, y3 = x + x1, y + y1, x + x2, y + y2, x + x3, y + y3
            else:
                x2, y2, x3, y3 = nombres(4)
                if rel:
                    x2, y2, x3, y3 = x + x2, y + y2, x + x3, y + y3
                # le premier point de controle : le reflet du precedent
                x1, y1 = ((2 * x - dernier_ctrl[0], 2 * y - dernier_ctrl[1])
                          if dernier_ctrl else (x, y))
            points.extend(_cubique((x, y), (x1, y1), (x2, y2), (x3, y3)))
            dernier_ctrl = (x2, y2)
            x, y = x3, y3
        else:
            raise ValueError(f"commande {cmd!r} non geree : {d!r}")
    if len(points) < 2:
        raise ValueError(f"chemin vide : {d!r}")
    return points


def _composants(g, caractere) -> list:
    """Les morceaux d'un caractere, au premier niveau : 語 = 言 + 吾, et non
    言 + 口 + 五 + 二. Un groupe sans nom (le haut de 学) est traverse :
    ses morceaux a lui sont ceux qu'on voit. -> [(element, original)]"""
    vus = []
    for enfant in g.findall("g"):
        el = enfant.get(KVG + "element")
        if el and el != caractere:
            couple = (el, enfant.get(KVG + "original"))
            if couple not in vus:
                vus.append(couple)
        elif not el:
            vus.extend(c for c in _composants(enfant, caractere) if c not in vus)
    return vus


def extrait(xml: str, caracteres) -> dict:
    """{caractere: {"traits": [chemin, ...], "composants": [(el, original)]}}
    pour ceux que KanjiVG connait. Les variantes (« kanji_04e00-Kaisho »)
    sont ignorees : c'est la forme ordinaire qu'on apprend a tracer."""
    voulus = {f"kvg:kanji_{ord(c):05x}": c for c in caracteres}
    sortie = {}
    for kanji in ET.fromstring(xml).iter("kanji"):
        c = voulus.get(kanji.get("id"))
        if c is None:
            continue
        # l'ordre des traits est celui des id -s1, -s2... et non celui
        # d'apparition dans le fichier, que les groupes peuvent melanger
        traits = sorted((int(p.get("id").rsplit("-s", 1)[1]), p.get("d"))
                        for p in kanji.iter("path"))
        for _, d in traits:
            polyligne(d)
        racine = kanji.find("g")
        sortie[c] = {"traits": [d for _, d in traits],
                     "composants": _composants(racine, c) if racine is not None else []}
    return sortie


def kanas() -> str:
    """Les kanas que la page enseigne : les deux syllabaires entiers, petits
    caracteres et signes compris, sauf les formes que plus personne n'ecrit
    (ゐ ゑ ヰ ヱ, les katakanas a dakuten de ヷ a ヺ) et les signes d'iteration."""
    exclus = set("ゐゑゕゖヰヱヷヸヹヺ・ヽヾゝゞ゛゜")
    hira = [chr(c) for c in range(0x3041, 0x3097)]
    kata = [chr(c) for c in range(0x30A1, 0x30FB)] + ["ー"]
    return "".join(c for c in hira + kata if c not in exclus)


def catalogue() -> str:
    """Le XML de KanjiVG."""
    return gzip.decompress(source("kanjivg.xml.gz").read_bytes()).decode("utf-8")


ATTRIBUTION = "KanjiVG (kanjivg.tagaini.net), Ulrich Apel, CC BY-SA 3.0"


def _ecrit(cible: Path, charge) -> Path:
    cible.parent.mkdir(parents=True, exist_ok=True)
    cible.write_text(json.dumps(charge, ensure_ascii=False, separators=(",", ":")),
                     encoding="utf-8")
    return cible


# --------------------------------------------------------------------------
#   Les kanjis
# --------------------------------------------------------------------------
# Les morceaux qui ne sont pas des kanjis : les formes que prend une cle a
# gauche, en haut ou en bas d'un caractere. KANJIDIC n'a pas de sens pour
# elles ; KanjiVG donne parfois l'original (亻 -> 人), sinon c'est ici.
SENS_DES_CLES = {
    "亻": "personne", "氵": "eau", "扌": "main", "忄": "cœur", "艹": "herbe",
    "辶": "avancer", "⻌": "avancer", "⻍": "avancer", "宀": "toit", "冖": "couvercle",
    "礻": "autel", "衤": "vêtement", "犭": "bête", "刂": "sabre", "灬": "feu",
    "罒": "filet", "攵": "frapper", "疒": "maladie", "廴": "allonger", "彳": "pas",
    "冫": "glace", "亠": "couvercle", "尸": "corps", "广": "abri", "厂": "falaise",
    "囗": "enclos", "勹": "envelopper", "匚": "boîte", "卩": "sceau", "彡": "ornement",
    "夂": "pas lent", "⺍": "petit", "⺌": "petit", "𠂉": "homme", "⺮": "bambou",
    "⺈": "couteau", "龸": "petit", "癶": "pieds écartés", "⺗": "cœur", "⺡": "eau",
    "⺅": "personne", "⺖": "cœur", "⺘": "main", "⻏": "village", "⻖": "colline",
    "阝": "colline, village", "⺾": "herbe", "⺼": "chair", "⺹": "vieillard",
    "耂": "vieillard", "⻊": "pied", "飠": "manger", "糹": "fil", "釒": "métal",
    "訁": "parole", "⺧": "vache", "牜": "vache", "⺨": "bête", "⻗": "pluie",
    "⺲": "filet", "⺳": "filet", "⺊": "divination", "丷": "huit", "⺤": "griffe",
    "爫": "griffe", "⺩": "joyau", "𧾷": "pied", "⺺": "pinceau", "⺻": "pinceau",
    "肀": "pinceau", "⺶": "mouton", "⺷": "mouton", "𦍌": "mouton", "王": "roi",
    "丆": "falaise", "乚": "crochet", "亅": "crochet", "丿": "trait penché", "丶": "point",
    "乙": "second", "丨": "trait", "⻎": "avancer", "⺀": "glace", "⺄": "second",
    "儿": "jambes", "气": "vapeur", "乂": "croiser", "冂": "cadre", "几": "table",
    "匕": "cuillère", "卜": "divination", "厶": "privé", "夊": "pas lent", "巛": "rivière",
    "彐": "groin", "戈": "hallebarde", "攴": "frapper", "爪": "griffe", "疋": "pied",
    "禸": "trace", "隹": "oiseau", "龶": "vie", "业": "métier", "云": "nuage",
    "亼": "réunir", "𠂇": "main", "𡗗": "vigoureux", "夋": "avancer", "俞": "réponse",
    "マ": "forme de ma", "电": "éclair", "亚": "second", "乡": "village", "习": "apprendre",
    "又": "main", "禾": "céréale", "⺕": "groin", "𠂊": "envelopper",
    # les morceaux qui reviennent le plus souvent sans sens francais dans
    # KANJIDIC : des cles, et surtout des parties phonetiques
    "巾": "tissu", "殳": "lance", "艮": "obstiné", "廾": "deux mains", "豕": "cochon",
    "莫": "ne pas", "幺": "petit fil", "聿": "pinceau", "昜": "soleil levant", "覀": "couvrir",
    "虍": "tigre", "凵": "réceptacle", "歹": "os", "咅": "cracher", "兌": "échanger",
    "尞": "feu de joie", "翟": "plumes", "㑒": "tous", "戋": "petit", "圣": "saint",
    "啇": "racine", "甫": "commencer", "曷": "pourquoi", "夌": "franchir", "㐮": "aider",
    "也": "aussi", "巴": "virgule", "乍": "soudain", "匸": "cacher", "关": "barrière",
    "开": "ouvrir", "畐": "plein", "氺": "eau", "亦": "aussi", "⺦": "main gauche",
    "冓": "assembler", "侖": "ordre", "禺": "singe", "韋": "cuir", "爰": "tirer",
    "𢦏": "couper", "卆": "soldat", "䍃": "vase",
}


# Ce que KANJIDIC range parmi les sens et qui n'en est pas : le numero de
# la cle dans le dictionnaire (« radical un (no. 1) ») et la mention
# « (kokuji) », kanji ne au Japon. Ni l'un ni l'autre ne se repond a une
# question « que veut dire ce kanji ? ».
PAS_UN_SENS = re.compile(r"\(no\.? ?\d+\)|^\(kokuji\)$")


def lit_kanjidic() -> dict:
    racine = ET.fromstring(gzip.decompress(source("kanjidic2.xml.gz").read_bytes()))
    kd = {}
    for c in racine.iter("character"):
        fr, en, on, kun = [], [], [], []
        for g in c.iter("rmgroup"):
            for m in g.findall("meaning"):
                if PAS_UN_SENS.search(m.text):
                    continue
                (fr if m.get("m_lang") == "fr" else en if m.get("m_lang") is None
                 else []).append(m.text)
            for r in g.findall("reading"):
                if r.get("r_type") == "ja_on":
                    on.append(r.text)
                elif r.get("r_type") == "ja_kun":
                    kun.append(r.text)
        misc = c.find("misc")
        entier = lambda balise: int(misc.findtext(balise)) if misc.findtext(balise) else None
        kd[c.findtext("literal")] = {"fr": fr, "en": en, "on": on, "kun": kun,
                                     "g": entier("grade"), "t": entier("stroke_count"),
                                     "f": entier("freq")}
    return kd


# Les niveaux de l'ancien JLPT (4 = le plus facile), pour la vingtaine de
# kanjis que kanji-data a oublie de ranger dans le nouveau : 分 (自分, 半分,
# 五分) en est, et le site ne l'apprenait pas. L'ancien niveau 2 s'est
# partage entre le N3 et le N2 : on prend le N3, ce sont des kanjis courants
# (的, 無, 身, 可).
ANCIENS_NIVEAUX = {4: 5, 3: 4, 2: 3, 1: 1}


def niveaux_jlpt() -> dict:
    """{kanji: 5 pour N5 ... 1 pour N1}."""
    donnees = json.loads(source("jlpt.json").read_text(encoding="utf-8"))
    return {k: v.get("jlpt_new") or ANCIENS_NIVEAUX[v["jlpt_old"]]
            for k, v in donnees.items() if v.get("jlpt_new") or v.get("jlpt_old")}


def _rang(priorites):
    """La frequence d'un mot d'apres ses marques JMdict, plus petit = plus
    courant. -> (rang, tranche du journal), ou None pour un mot qui n'est
    pas marque courant.

    nf01 a nf48 sont les tranches de 500 mots du corpus du Mainichi. Elles
    sous-estiment les verbes -- le journal compte chaque forme conjuguee a
    part, et 食べる n'y est qu'en tranche 25 -- d'ou le poids de ichi1, la
    liste du vocabulaire de base (Ichimango) : un mot qui y figure compte
    comme l'un des 4 000 premiers."""
    p = set(priorites)
    nf = next((int(x[2:]) for x in priorites if x.startswith("nf")), None)
    candidats = [nf or 99]
    if "ichi1" in p:
        candidats.append(8)
    if "spec1" in p:
        candidats.append(20)
    if {"ichi2", "spec2", "news1"} & p:
        candidats.append(30)
    if {"news2", "gai1"} & p:
        candidats.append(45)
    rang = min(candidats)
    return None if rang == 99 else (rang, nf or 99)


def _cjk(c) -> bool:
    return "㐀" <= c <= "鿿" or "豈" <= c <= "﫿"


def mots_d_exemple(niveaux, n=MOTS_PAR_KANJI) -> dict:
    """{kanji: [[mot, lecture, sens, (1 si le sens est en anglais)]]}.

    Pour chaque kanji, les mots courants qui l'emploient, dans cet ordre :
    d'abord ceux qu'on sait lire a ce niveau (tous leurs kanjis sont du
    meme niveau ou d'un plus facile), puis les plus frequents par tranches
    de 5 000 mots, et dans une meme tranche ceux qui ont une traduction
    francaise. Les mots qui s'ecrivent d'habitude en kanas sont ecartes :
    ils n'apprendraient rien sur le kanji.
    """
    import tarfile
    francais = {}
    with tarfile.open(source("jmdict-fre.json.tgz")) as archive:
        membre = next(m for m in archive if m.name.endswith(".json"))
        for w in json.load(archive.extractfile(membre))["words"]:
            if w["sense"]:
                francais[w["id"]] = [g["text"] for g in w["sense"][0]["gloss"]]

    candidats = {}
    with gzip.open(source("JMdict_e.gz")) as f:
        for _, el in ET.iterparse(f):
            if el.tag != "entry":
                continue
            sens = el.find("sense")
            if sens is None or any("kana alone" in (m.text or "") for m in sens.findall("misc")):
                el.clear()
                continue
            ident = el.findtext("ent_seq")
            anglais = [g.text for g in sens.findall("gloss")]
            lectures = [(r.findtext("reb"), {x.text for x in r.findall("re_restr")},
                         r.find("re_nokanji") is not None) for r in el.findall("r_ele")]
            for k in el.findall("k_ele"):
                mot = k.findtext("keb")
                frequence = _rang([p.text for p in k.findall("ke_pri")])
                if frequence is None or k.find("ke_inf") is not None or len(mot) > 5:
                    continue
                rang, nf = frequence
                lecture = next((r for r, restr, sans in lectures
                                if not sans and (not restr or mot in restr)), None)
                if lecture is None:
                    continue
                kanjis = [c for c in mot if _cjk(c)]
                for c in set(kanjis):
                    if c not in niveaux:
                        continue
                    lisible = all(x in niveaux and niveaux[x] >= niveaux[c] for x in kanjis)
                    fr = francais.get(ident)
                    texte = ", ".join(list(dict.fromkeys(fr or anglais))[:3])
                    if len(texte) > 70:
                        texte = texte[:67].rsplit(" ", 1)[0] + "…"
                    cle = (not lisible, rang // 10, fr is None, nf, len(mot), mot)
                    candidats.setdefault(c, []).append(
                        (cle, [mot, lecture, texte] + ([] if fr else [1])))
            el.clear()

    # De la variete : au plus deux composes (日本, 毎日...), au plus deux
    # mots ou le kanji est seul avec ses kanas (日, 休む...) -- les premiers
    # montrent ses lectures on, les seconds ses lectures kun.
    sortie = {}
    for c, liste in candidats.items():
        vus, choix, genres = set(), [], {}
        for _, mot in sorted(liste, key=lambda x: x[0]):
            genre = sum(1 for x in mot[0] if _cjk(x)) > 1
            if mot[0] in vus or genres.get(genre, 0) >= n - 1:
                continue
            vus.add(mot[0])
            genres[genre] = genres.get(genre, 0) + 1
            choix.append(mot)
            if len(choix) == n:
                break
        sortie[c] = choix
    return sortie


# Les 80 kanjis du N5 par themes, dans l'ordre ou un debutant les apprend :
# les nombres, les jours de la semaine (le soleil, la lune et les cinq
# elements), les gens, la nature, les positions, le temps, l'ecole et la
# famille, les directions, les verbes de base, le reste. L'ordre de l'ecole
# (annee, puis nombre de traits) melait 一 人 十 二 九 入 : les chiffres
# arrivaient en desordre, 火 et 水 apres 千.
ORDRE_N5 = ("一二三四五六七八九十百千万円" "日月火水木金土" "人子女男" "山川天気雨"
            "上下中大小" "年今午前後時分半間毎" "本学生先校名語友父母" "右左東西南北外"
            "行来出入休見食書話聞読" "何国長高白車電")


def construit_kanjis(traduits=None) -> tuple[list, dict]:
    """La liste des kanjis dans l'ordre ou on les apprend, et leurs traits
    par niveau.

    L'ordre : N5 d'abord, par themes (ORDRE_N5), puis N4... ; a partir du
    N4, ceux de l'ecole primaire avant les autres, une annee apres l'autre,
    et a annee egale les plus simples (le moins de traits) d'abord. La page
    fait passer devant, dans chaque niveau, les kanjis des mots qu'on
    apprend (voir kanjisADecouvrir dans nihongo.js).

    `traduits` : {(mot, lecture): [sens]} du vocabulaire. Un mot d'exemple
    qui en fait partie prend ces sens-la, traduits a la main, plutot que
    ceux de jmdict-simplified.
    """
    niveaux = niveaux_jlpt()
    kd = lit_kanjidic()
    kvg = extrait(catalogue(), niveaux)
    mots = mots_d_exemple(niveaux)
    for exemples in mots.values():
        for i, (mot, lecture, *_) in enumerate(exemples):
            sens = (traduits or {}).get((mot, lecture))
            if sens:
                exemples[i] = [mot, lecture, ", ".join(sens[:3])]
    manquants = sorted(set(niveaux) - set(kvg))
    if manquants:
        print(f"  sans traces KanjiVG, laisses de cote : {''.join(manquants)}")

    def sens_de(el, original=None):
        """Le sens d'un morceau, en francais : de SENS_DES_CLES ou de
        KANJIDIC. Sinon rien -- l'anglais de KANJIDIC pour ces morceaux-la
        (« fuel used for sacrifices ») n'apprendrait rien a personne."""
        # l'ordre compte : 月 tout seul est la lune, mais 月 venu de 肉
        # (original) est la chair, dans 腕 ou 肺
        for c, table in ((el, "cles"), (original, "kd"), (el, "kd"), (original, "cles")):
            if not c:
                continue
            if table == "cles" and c in SENS_DES_CLES:
                return SENS_DES_CLES[c]
            if table == "kd" and c in kd and kd[c]["fr"]:
                return kd[c]["fr"][0]
        return None

    def ordre(k):
        d = kd.get(k, {})
        theme = ORDRE_N5.find(k) if niveaux[k] == 5 else -1
        return (-niveaux[k], theme if theme >= 0 else len(ORDRE_N5), d.get("g") or 99,
                len(kvg[k]["traits"]), d.get("f") or 9999)

    liste, traces = [], {}
    for k in sorted((k for k in niveaux if k in kvg), key=ordre):
        d = kd.get(k, {"fr": [], "en": [], "on": [], "kun": [], "g": None, "f": None})
        liste.append({
            "k": k, "n": niveaux[k], "g": d["g"], "t": len(kvg[k]["traits"]), "f": d["f"],
            "fr": d["fr"][:6], "en": d["en"][:5], "on": d["on"][:5], "kun": d["kun"][:8],
            # un nom a plusieurs lettres (« CDP-8BC4 ») est une forme sans
            # caractere Unicode : rien a afficher
            "c": [[el, sens_de(el, orig)] for el, orig in kvg[k]["composants"] if len(el) == 1],
            "m": mots.get(k, []),
        })
        traces.setdefault(niveaux[k], {})[k] = kvg[k]["traits"]
    return liste, traces


# --------------------------------------------------------------------------
#   Le vocabulaire
# --------------------------------------------------------------------------
# Les mots du JLPT, du N5 au N1, d'apres les listes de Waller. Chaque ligne
# y donne une graphie, une lecture, un sens en anglais et l'entree JMdict du
# mot ; de JMdict on tire sa nature (verbe, nom...), sa frequence, et la
# graphie sous laquelle il s'ecrit vraiment : Waller a garde des graphies
# que plus personne n'emploie (終る, 明い).
#
# Un mot de la page est une graphie : 開ける (ouvrir) et 明ける (se lever,
# pour le jour) partagent une entree JMdict mais pas un sens -- deux mots a
# apprendre. A l'inverse, 今日 se lit きょう (N5) ou こんにち (N3) : un seul
# mot, deux lectures, toutes deux acceptees.
#
# Les sens : l'anglais de Waller, court et propre a chaque mot, et le
# francais de matiere/vocabulaire-fr.tsv, traduit a la main depuis le mot
# japonais. La traduction francaise de JMdict suit les sens de l'entree et
# non ceux du mot (明ける y « ouvre » et « vide ») : elle ne sert pas ici.
# Un mot pas encore traduit garde son anglais, et la page le dit ; un mot
# traduit le perd : Waller se trompe parfois (工夫 « labourer », 統計
# « scattering », せめて « offense »), et la page n'a pas a le montrer.
TRADUCTIONS = BASE / "matiere" / "vocabulaire-fr.tsv"
# Les graphies que JMdict marque comme a eviter : de recherche seulement,
# rares, vieillies, ou aux kanas mal repartis.
GRAPHIES_A_EVITER = {"sK", "rK", "oK", "iK", "io"}
_KANA = re.compile(r"[ぁ-ゖァ-ヺー]")


def _entites(chemin) -> dict:
    """{description: code} des entites de JMdict : ElementTree remplace
    « &v1; » par « Ichidan verb », la page veut « v1 »."""
    with gzip.open(chemin, "rt", encoding="utf-8") as f:
        tete = f.read(300_000)
    return {desc: code for code, desc in re.findall(r'<!ENTITY ([\w-]+) "([^"]*)">', tete)}


def lit_jmdict(seqs) -> dict:
    """{numero: entree} pour les entrees voulues de JMdict : graphies,
    lectures et sens."""
    chemin = source("JMdict_e.gz")
    code = _entites(chemin)
    codes = lambda el, balise: [code.get(x.text, x.text) for x in el.findall(balise)]
    sortie = {}
    with gzip.open(chemin) as f:
        for _, el in ET.iterparse(f):
            if el.tag != "entry":
                continue
            seq = el.findtext("ent_seq")
            if seq in seqs:
                sens, pos = [], []
                for s in el.findall("sense"):
                    # la nature d'un sens vaut pour les suivants, jusqu'a
                    # la prochaine
                    pos = codes(s, "pos") or pos
                    sens.append({"pos": pos, "misc": codes(s, "misc"),
                                 "stagk": [x.text for x in s.findall("stagk")],
                                 "stagr": [x.text for x in s.findall("stagr")],
                                 "gloss": [g.text for g in s.findall("gloss")]})
                sortie[seq] = {
                    "k": [{"m": k.findtext("keb"), "pri": [p.text for p in k.findall("ke_pri")],
                           "inf": codes(k, "ke_inf")} for k in el.findall("k_ele")],
                    "r": [{"l": r.findtext("reb"), "pri": [p.text for p in r.findall("re_pri")],
                           "restr": [x.text for x in r.findall("re_restr")],
                           "sans": r.find("re_nokanji") is not None} for r in el.findall("r_ele")],
                    "s": sens,
                }
            el.clear()
    return sortie


def _frequence(priorites) -> int:
    f = _rang(priorites)
    return f[0] if f else 99


def _graphies(entree, lecture) -> list:
    """Les graphies de l'entree qui se lisent `lecture`."""
    r = next((r for r in entree["r"] if r["l"] == lecture), None)
    if r is None:
        return entree["k"]
    if r["sans"]:
        return []
    return [k for k in entree["k"] if not r["restr"] or k["m"] in r["restr"]]


def graphie(entree, ecrit, lecture) -> str:
    """La graphie a montrer pour une ligne de Waller.

    La sienne, sauf quand elle n'est qu'une variante d'une autre : une
    autre repartition des kanas (終る pour 終わる), une graphie que JMdict dit
    rare ou vieillie (明い pour 明るい), ou une graphie sans marque de
    frequence quand une autre en a (好い pour 良い). Une graphie qui a ses
    propres sens dans JMdict (街 a cote de 町) reste elle-meme."""
    if not ecrit:
        return lecture
    formes = (_graphies(entree, lecture) or entree["k"]) if entree else []
    k = next((x for x in formes if x["m"] == ecrit), None)
    if k is None or any(ecrit in s["stagk"] for s in entree["s"]):
        return ecrit
    rang = lambda x: (bool(set(x["inf"]) & GRAPHIES_A_EVITER), _frequence(x["pri"]))
    courantes = [x for x in formes if not set(x["inf"]) & GRAPHIES_A_EVITER]
    soeurs = [x for x in courantes if _KANA.sub("", x["m"]) == _KANA.sub("", ecrit)]
    if soeurs and rang(min(soeurs, key=rang)) < rang(k):
        return min(soeurs, key=rang)["m"]
    if set(k["inf"]) & GRAPHIES_A_EVITER or not k["pri"]:
        frequentes = [x for x in courantes if x["pri"]]
        if frequentes:
            return min(frequentes, key=rang)["m"]
    return ecrit


def _sens_du_mot(entree, ecrit, lecture) -> list:
    """Les sens de l'entree qui valent pour cette graphie et cette lecture."""
    if not entree:
        return []
    return [s for s in entree["s"]
            if (not s["stagk"] or ecrit in s["stagk"]) and (not s["stagr"] or lecture in s["stagr"])]


# Les marques de JMdict restees dans les sens de Waller : « (uk) there »,
# « (X) (col) ... ». Elles ne disent rien a qui apprend le mot.
_MARQUES = re.compile(r"\((?:uk|X|col|n|abbr|hon|hum|sl|conj|adv|int|adv int|ateji|P|vs|exp)\)\s*")


def _liste_de_sens(texte) -> list:
    """« to open, to become open » -> ["to open", "to become open"] ; les
    virgules entre parentheses ne coupent pas ; les numeros (« (1) »,
    « 2. »), les marques de JMdict et un sens coupe en route partent. Une
    lettre seule reste un sens (おいて : « à ») ; un signe seul n'en est pas."""
    texte = re.sub(r"\(\d+\)\s*|(?:^|(?<=[\s,;]))\d+\.\s+", "", texte or "")
    texte = _MARQUES.sub("", texte)
    morceaux = (re.sub(r"\s*\([^)]*$", "", m).strip(" .") for m in
                re.split(r"[,;]\s*(?![^()]*\))", texte))
    return _uniques(m for m in morceaux if len(m) > 1 or m.isalpha())


def _uniques(liste) -> list:
    """Sans doublons, majuscules comprises (« This » et « this »)."""
    vus, sortie = set(), []
    for x in liste:
        if x.casefold() not in vus:
            vus.add(x.casefold())
            sortie.append(x)
    return sortie


# Les mots que yomitan-jlpt-vocab rattache a la mauvaise entree de JMdict :
# これ au « これ ! » qui rappelle a l'ordre plutot qu'au pronom, こと a une
# particule. Releves en comparant le sens de Waller a celui de l'entree.
BONNES_ENTREES = {
    "2216120": "1628530",      # これ : this
    "2216210": "1006970",      # それ : that
    "2847612": "1000580",      # あれ : that
    "2524270": "1313580",      # こと : thing, matter
    "2607730": "1012500",      # もし : if
    "2546180": "1597350",      # だんだん : gradually
    "2771700": "1570120",      # やや : a little
}


def lit_listes_vocabulaire() -> list:
    """[(niveau, numero JMdict, lecture, graphie de Waller, sens anglais)],
    du N5 au N1, dans l'ordre des listes."""
    import csv
    lignes = []
    for n in (5, 4, 3, 2, 1):
        with open(source(f"vocabulaire-n{n}.csv"), encoding="utf-8", newline="") as f:
            for l in csv.DictReader(f):
                if l["jmdict_seq"] and l["kana"]:
                    seq = BONNES_ENTREES.get(l["jmdict_seq"], l["jmdict_seq"])
                    lignes.append((n, seq, l["kana"].strip(), l["kanji"].strip(),
                                   l["waller_definition"]))
    return lignes


def lit_traductions(chemin=None) -> dict:
    """{cle du mot: [sens francais]} depuis matiere/vocabulaire-fr.tsv :
    une ligne par mot, « 会う・あう<TAB>rencontrer, voir (quelqu'un) ». Les
    lignes vides et celles qui commencent par # ne comptent pas."""
    chemin = Path(chemin or TRADUCTIONS)
    if not chemin.is_file():
        return {}
    sortie = {}
    for ligne in chemin.read_text(encoding="utf-8").splitlines():
        if not ligne.strip() or ligne.startswith("#"):
            continue
        cle, _, texte = ligne.partition("\t")
        sens = _liste_de_sens(texte)
        if sens:
            sortie[cle.strip()] = sens
    return sortie


def construit_vocabulaire(lignes=None, entrees=None, traductions=None) -> list:
    """Les mots du JLPT dans l'ordre ou on les apprend : N5 d'abord, et dans
    un niveau les plus frequents d'abord.

    Chaque mot : m (sa graphie), l (ses lectures, la principale d'abord),
    n (niveau), p (sa nature, codes JMdict : v5k, v1, adj-i, n, vs...),
    fr (ses sens), en (son anglais, s'il n'est pas traduit), a (une autre
    graphie, s'il y a lieu).

    Un mot que JMdict dit « d'habitude en kanas » s'ecrit en kanas, et sa
    graphie en kanjis passe en `a` : on ecrit ある et ください, pas 有る ni
    下さい."""
    lignes = lit_listes_vocabulaire() if lignes is None else lignes
    entrees = lit_jmdict({l[1] for l in lignes}) if entrees is None else entrees
    traductions = lit_traductions() if traductions is None else traductions

    mots = {}                          # (numero, graphie) -> mot
    for rang_ligne, (n, seq, lecture, ecrit, anglais) in enumerate(lignes):
        e = entrees.get(seq)
        m = graphie(e, ecrit, lecture)
        autre = None
        sens = _sens_du_mot(e, m, lecture)
        if m != lecture and sens and "uk" in sens[0]["misc"]:
            m, autre = lecture, m
        mot = mots.get((seq, m))
        if mot is None:
            k = next((x for x in (e or {}).get("k", []) if x["m"] == m), None)
            r = next((x for x in (e or {}).get("r", []) if x["l"] == lecture), None)
            mot = mots[(seq, m)] = {
                "m": m, "l": [], "n": n, "p": sens[0]["pos"] if sens else [],
                "en": [], "a": autre,
                "_ordre": (-n, min(_frequence(k["pri"]) if k else 99,
                                   _frequence(r["pri"]) if r else 99), rang_ligne),
            }
        if lecture not in mot["l"]:
            mot["l"].append(lecture)
        # une quarantaine de lignes de Waller n'ont pas de sens : celui de
        # JMdict, a defaut
        anglais = _liste_de_sens(anglais) or (sens[0].get("gloss", [])[:4] if sens else [])
        mot["en"] = _uniques(mot["en"] + anglais)

    # deux entrees JMdict qui s'ecrivent et se lisent pareil (いる, etre, et
    # いる, falloir, quand Waller les donne en kanas) : un seul mot, ses sens
    # mis bout a bout
    par_cle = {}
    for mot in sorted(mots.values(), key=lambda x: x["_ordre"]):
        cle = cle_audio(mot["m"], mot["l"][0])
        if cle in par_cle:
            premier = par_cle[cle]
            premier["en"] = _uniques(premier["en"] + mot["en"])
            premier["l"] += [l for l in mot["l"] if l not in premier["l"]]
            continue
        par_cle[cle] = mot
    sortie = []
    for cle, mot in par_cle.items():
        del mot["_ordre"]
        mot["fr"] = traductions.get(cle, [])[:6]
        if mot["fr"]:
            del mot["en"]
        else:
            mot["en"] = mot["en"][:6]
        if not mot["a"]:
            del mot["a"]
        sortie.append(mot)
    return sortie


# --------------------------------------------------------------------------
#   La grammaire
# --------------------------------------------------------------------------
# Les points de grammaire du JLPT, du N5 au N1, ecrits pour ce site dans
# matiere/grammaire-n5.txt a matiere/grammaire-n1.txt. Comme les sens du
# vocabulaire, c'est une matiere ecrite et non fabriquee : aucune source
# libre ne donne, en francais et dans un ordre qui se tient, des
# explications et des phrases dont on puisse faire des exercices. Le format
# est decrit en tete de chaque fichier.
#
# Une carte par point, « gram:te-kudasai:completer » : une phrase d'exemple
# a trou, sa traduction, et ce qui manque a taper. Chaque revision prend une
# autre phrase du point : c'est la regle qu'on retient, pas la phrase.
#
# Tout kanji porte ses furigana ({学生|がくせい}) : la fabrication refuse un
# kanji qui n'en a pas. La page les montre ou les cache, et la voix sait
# ainsi ce qu'elle doit dire.
GRAMMAIRE = {n: BASE / "matiere" / f"grammaire-n{n}.txt" for n in (5, 4, 3, 2, 1)}
PREFIXE_PHRASE = "p-"          # le nom des sons des phrases : p-<empreinte>
EXEMPLES_MINI = 3              # de quoi varier d'une revision a l'autre
_RUBI = re.compile(r"\{([^{}|]+)\|([^{}|]+)\}")
_KANAS = re.compile(r"^[ぁ-ゖァ-ヺー]+$")
_TROU = re.compile(r"\[([^\[\]]+)\]")
_NOM_POINT = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_CHAMP = re.compile(r"^(titre|sens|forme|voir)\s*:\s*(.+)$")


class ErreurGrammaire(ValueError):
    """Une faute dans un fichier de grammaire : ou, et laquelle."""


def _hira(s) -> str:
    return re.sub(r"[ァ-ヶ]", lambda m: chr(ord(m.group()) - 0x60), s)


def surface(texte) -> str:
    """Le texte tel qu'il s'ecrit : {学生|がくせい}です -> 学生です."""
    return _RUBI.sub(r"\1", texte)


def lecture_de(texte) -> str:
    """Le texte tel qu'il se lit : {学生|がくせい}です -> がくせいです."""
    return _RUBI.sub(r"\2", texte)


def _verifie_rubis(texte, ou, erreur=None) -> None:
    """Des furigana en kanas, et pas un kanji sans les siens."""
    erreur = erreur or ErreurGrammaire
    for base, lu in _RUBI.findall(texte):
        if not _KANAS.match(lu):
            raise erreur(f"{ou} : la lecture de {base} s'ecrit en kanas, pas « {lu} »")
    nu = _RUBI.sub("", texte)
    if "{" in nu or "}" in nu:
        raise erreur(f"{ou} : accolade sans furigana ({texte})")
    nus = "".join(c for c in nu if _cjk(c) or c in "々〆")
    if nus:
        raise erreur(f"{ou} : {nus} sans furigana")


def _exemple(ligne, ou) -> dict:
    """« {私|わたし}[は]{学生|がくせい}です。 | Je suis étudiant. » ->
    a (avant le trou), t (la reponse, telle qu'elle s'ecrit), p (apres),
    r (les reponses justes, en hiraganas), e (les memes avec leurs kanjis,
    s'il y en a), i (ce que montre le trou, s'il montre quelque chose), fr
    (la traduction) et son (le nom de son fichier son)."""
    jp, sep, fr = ligne.rpartition(" | ")
    if not sep or not jp.strip() or not fr.strip():
        raise ErreurGrammaire(f"{ou} : un exemple s'ecrit « phrase | traduction »")
    trous = _TROU.findall(jp)
    if len(trous) != 1:
        raise ErreurGrammaire(f"{ou} : un exemple a un trou entre crochets, et un seul")
    avant, _, apres = jp.strip().partition(f"[{trous[0]}]")
    dedans, indice = trous[0], ""
    m = re.fullmatch(r"(.*)<([^<>]+)>", dedans)
    if m:
        dedans, indice = m.group(1), m.group(2).strip()
    reponses = [r.strip() for r in dedans.split("/")]
    for morceau in (avant, apres, indice, *reponses):
        _verifie_rubis(morceau, ou)
    for r in reponses:
        if not r or not _KANAS.match(_hira(lecture_de(r))):
            raise ErreurGrammaire(f"{ou} : la reponse « {r} » doit pouvoir se taper en kanas")
    phrase = avant + reponses[0] + apres
    texte, lu = surface(phrase), lecture_de(phrase)
    ex = {"a": avant, "t": reponses[0], "p": apres,
          "r": list(dict.fromkeys(_hira(lecture_de(r)) for r in reponses)),
          "e": list(dict.fromkeys(surface(r) for r in reponses)),
          "fr": fr.strip(),
          "son": PREFIXE_PHRASE + hashlib.sha1(f"{texte}|{lu}".encode()).hexdigest()[:10]}
    if ex["e"] == ex["r"]:     # tout en kanas : rien a ajouter
        del ex["e"]
    if indice:
        ex["i"] = indice
    return ex


def lit_grammaire(chemin, n) -> tuple:
    """Les chapitres et les points d'un fichier de grammaire, dans l'ordre
    du fichier. Un chapitre peut s'ouvrir sur quelques lignes qui disent ce
    qu'il contient, avant son premier point."""
    chemin = Path(chemin)
    chapitres, points, chapitre, point = [], [], None, None
    champs = False             # juste apres « ## nom » : titre, sens, forme, voir
    bloc = None                # le bloc de texte en cours
    for numero, brute in enumerate(chemin.read_text(encoding="utf-8").splitlines(), 1):
        ou = f"{chemin.name}:{numero}"
        ligne = brute.rstrip()
        if ligne.startswith("#") and not ligne.startswith("##"):
            continue
        if not ligne.strip():
            champs, bloc = False, None
            continue
        if ligne.startswith("=== "):
            chapitre = {"n": n, "nom": ligne[4:].strip(), "intro": "", "_ou": ou}
            chapitres.append(chapitre)
            point, bloc = None, None
            continue
        if ligne.startswith("## "):
            nom = ligne[3:].strip()
            if not _NOM_POINT.match(nom) or len(nom) > 24:
                raise ErreurGrammaire(f"{ou} : « {nom} » : un nom de point en minuscules, "
                                      "chiffres et tirets, 24 signes au plus")
            if not chapitre:
                raise ErreurGrammaire(f"{ou} : un point avant tout chapitre (=== ...)")
            point = {"nom": nom, "n": n, "chap": chapitre["nom"], "titre": "", "sens": "",
                     "formes": [], "texte": [], "ex": [], "voir": [], "_ou": ou}
            points.append(point)
            champs, bloc = True, None
            continue
        if point is None:
            if not chapitre:
                raise ErreurGrammaire(f"{ou} : du texte hors d'un chapitre (=== ...)")
            _verifie_rubis(ligne.strip(), ou)
            chapitre["intro"] = f"{chapitre['intro']} {ligne.strip()}".strip()
            continue
        m = _CHAMP.match(ligne) if champs else None
        if m:
            cle, valeur = m.group(1), m.group(2).strip()
            if cle == "forme":
                point["formes"].append(valeur)
            elif cle == "voir":
                point["voir"] += [v.strip() for v in valeur.split(",") if v.strip()]
            elif point[cle]:
                raise ErreurGrammaire(f"{ou} : deux fois « {cle} »")
            else:
                point[cle] = valeur
            _verifie_rubis(valeur, ou)
            continue
        champs = False
        if ligne.startswith("- "):
            point["ex"].append(_exemple(ligne[2:], ou))
            bloc = None
            continue
        genre, contenu = next(((g, ligne[2:]) for g, debut in
                               (("l", "* "), ("t", "| "), ("note", "> ")) if ligne.startswith(debut)),
                              ("p", ligne))
        contenu = contenu.strip()
        _verifie_rubis(contenu, ou)
        if bloc is None or genre not in bloc:
            bloc = {genre: []}
            point["texte"].append(bloc)
        bloc[genre].append([c.strip() for c in contenu.split(" | ")] if genre == "t" else contenu)
    for point in points:
        for bloc in point["texte"]:
            for genre in ("p", "note"):
                if genre in bloc:
                    bloc[genre] = " ".join(bloc[genre])
    return chapitres, points


def construit_grammaire(fichiers=None) -> dict:
    """Tous les chapitres et tous les points, du N5 au N1, verifies : un
    titre, un sens, assez d'exemples, des renvois qui menent quelque part,
    aucune phrase deux fois (elle aurait deux fois le meme son)."""
    fichiers = GRAMMAIRE if fichiers is None else fichiers
    chapitres, points = [], []
    for n in sorted(fichiers, reverse=True):
        if Path(fichiers[n]).is_file():
            c, p = lit_grammaire(fichiers[n], n)
            chapitres += c
            points += p
    vus = set()
    for c in chapitres:
        lieu = c.pop("_ou")
        if (c["n"], c["nom"]) in vus:
            raise ErreurGrammaire(f"{lieu} : le chapitre « {c['nom']} » existe deja")
        vus.add((c["n"], c["nom"]))
        if not any(p["n"] == c["n"] and p["chap"] == c["nom"] for p in points):
            raise ErreurGrammaire(f"{lieu} : le chapitre « {c['nom']} » n'a aucun point")
    noms, sons, ou = set(), set(), {}
    for p in points:
        ou[p["nom"]] = lieu = p.pop("_ou")
        if p["nom"] in noms:
            raise ErreurGrammaire(f"{lieu} : le point « {p['nom']} » existe deja")
        noms.add(p["nom"])
        if not p["titre"] or not p["sens"]:
            raise ErreurGrammaire(f"{lieu} : il manque « titre: » ou « sens: »")
        if len(p["ex"]) < EXEMPLES_MINI:
            raise ErreurGrammaire(f"{lieu} : {len(p['ex'])} exemples, il en faut {EXEMPLES_MINI}")
        for ex in p["ex"]:
            if ex["son"] in sons:
                raise ErreurGrammaire(f"{lieu} : « {surface(ex['a'] + ex['t'] + ex['p'])} » "
                                      "est deja l'exemple d'un autre point")
            sons.add(ex["son"])
    for p in points:
        for v in p["voir"]:
            if v not in noms or v == p["nom"]:
                raise ErreurGrammaire(f"{ou[p['nom']]} : « voir: {v} » ne mene a aucun autre point")
    return {"chapitres": chapitres, "points": points}


# --------------------------------------------------------------------------
#   La lecture
# --------------------------------------------------------------------------
# Des textes a lire, du N5 au N1, ecrits pour ce site dans
# matiere/lecture-n5.txt a -n1.txt : dialogues du quotidien, recits, contes,
# lettres, articles. Les premiers suivent Lea, une etudiante francaise
# arrivee a Tokyo pour apprendre le japonais ; les suivants s'en eloignent a
# mesure que la langue s'eleve. Le format est decrit en tete de
# matiere/lecture-n5.txt.
#
# Comme la grammaire, chaque phrase porte ses furigana. La fabrication la
# decoupe en mots avec SudachiPy (un analyseur morphologique libre, Apache
# 2.0) et relie chacun a ce qui l'explique :
#
#   - un mot du vocabulaire : ses sens, sa lecture, ses cartes -- la page
#     sait s'il est deja appris, et peut le faire apprendre ;
#   - sinon une entree du glossaire de la lecture (matiere/lecture-mots.tsv) :
#     les noms propres, les mots que les listes du JLPT n'ont pas ;
#   - un nombre et son compteur (七時, 三人) se disent tout seuls ;
#   - une particule ou une terminaison, au point de grammaire qui l'explique.
#
# Un verbe ou un adjectif garde ses terminaisons : 起きました est un seul mot
# a toucher, « 起きる, poli, passe ». Les furigana ecrits a la main font foi
# sur l'analyseur : il coupe 一日中 en 一 + 日中, les furigana
# {一日中|いちにちじゅう} recousent le mot.
#
# Un mot sans explication arrete la fabrication : tout mot d'un texte doit
# pouvoir se toucher.
#
# SudachiPy ne sert qu'a la fabrication, pas au serveur :
#   venv/bin/pip install sudachipy sudachidict_core
LECTURE = {n: BASE / "matiere" / f"lecture-n{n}.txt" for n in (5, 4, 3, 2, 1)}
GLOSSAIRE = BASE / "matiere" / "lecture-mots.tsv"
GENRES_TEXTE = ("dialogue", "récit", "journal", "lettre", "conte", "article", "essai",
                "entretien", "annonce")
QUESTIONS_MINI = 2
_CHAMP_TEXTE = re.compile(r"^(titre|fr|genre|intro)\s*:\s*(.+)$")
_QUI = re.compile(r"^((?:\{[^{}|]+\|[^{}|]+\}|[^：|{}]){1,20})：(.+)$")     # {田中|たなか}：はい。
_PONCTUATION = ("補助記号", "空白")


class ErreurLecture(ValueError):
    """Une faute dans un texte a lire : ou, et laquelle."""


def lit_lecture(chemin, n) -> list:
    """Les textes d'un fichier, dans l'ordre du fichier : leurs champs,
    leurs paragraphes de phrases (en balisage, pas encore decoupees) et
    leurs questions."""
    chemin = Path(chemin)
    textes, texte, paragraphe = [], None, None
    for numero, brute in enumerate(chemin.read_text(encoding="utf-8").splitlines(), 1):
        ou = f"{chemin.name}:{numero}"
        ligne = brute.rstrip()
        if ligne.startswith("#"):
            continue
        if not ligne.strip():
            paragraphe = None
            continue
        if ligne.startswith("=== "):
            nom = ligne[4:].strip()
            if not _NOM_POINT.match(nom) or len(nom) > 40:
                raise ErreurLecture(f"{ou} : « {nom} » : un nom de texte en minuscules, "
                                    "chiffres et tirets, 40 signes au plus")
            texte = {"nom": nom, "n": n, "titre": "", "fr": "", "genre": "", "intro": "",
                     "p": [], "q": [], "_ou": ou}
            textes.append(texte)
            paragraphe = None
            continue
        if texte is None:
            raise ErreurLecture(f"{ou} : du texte avant le premier « === nom »")
        m = _CHAMP_TEXTE.match(ligne)
        if m and not texte["p"] and not texte["q"]:
            cle, valeur = m.group(1), m.group(2).strip()
            if texte[cle]:
                raise ErreurLecture(f"{ou} : deux fois « {cle} »")
            _verifie_rubis(valeur, ou, ErreurLecture)
            texte[cle] = valeur
            continue
        if ligne.startswith("? "):
            texte["q"].append({"q": ligne[2:].strip(), "c": [], "r": None, "_ou": ou})
            continue
        if ligne.startswith(("+ ", "- ")):
            if not texte["q"]:
                raise ErreurLecture(f"{ou} : une reponse avant toute question (« ? »)")
            q = texte["q"][-1]
            if ligne[0] == "+":
                if q["r"] is not None:
                    raise ErreurLecture(f"{ou} : deux bonnes reponses")
                q["r"] = len(q["c"])
            q["c"].append(ligne[2:].strip())
            continue
        if texte["q"]:
            raise ErreurLecture(f"{ou} : une phrase apres les questions")
        jp, sep, reste = ligne.partition(" | ")
        if not sep or not jp.strip() or not reste.strip():
            raise ErreurLecture(f"{ou} : une phrase s'ecrit « japonais | traduction »")
        fr, _, points = reste.partition(" | ")
        phrase = {"jp": jp.strip(), "fr": fr.strip(), "_ou": ou}
        m = _QUI.match(phrase["jp"])
        if m:
            phrase["qui"], phrase["jp"] = m.group(1).strip(), m.group(2).strip()
            _verifie_rubis(phrase["qui"], ou, ErreurLecture)
        _verifie_rubis(phrase["jp"], ou, ErreurLecture)
        if points.strip():
            phrase["g"] = [p.strip() for p in points.split(",") if p.strip()]
        if paragraphe is None:
            paragraphe = []
            texte["p"].append(paragraphe)
        paragraphe.append(phrase)
    return textes


def lit_glossaire(chemin=None) -> list:
    """matiere/lecture-mots.tsv : les mots des textes que le vocabulaire n'a
    pas. Une ligne par mot : graphie, lecture, sens (separes par « ; ») et,
    s'il le faut, sa nature (« prénom », « nom de lieu »).
    -> [{m, l, fr, nature}]"""
    chemin = Path(chemin or GLOSSAIRE)
    if not chemin.is_file():
        return []
    entrees, vues = [], set()
    for numero, ligne in enumerate(chemin.read_text(encoding="utf-8").splitlines(), 1):
        if not ligne.strip() or ligne.startswith("#"):
            continue
        ou = f"{chemin.name}:{numero}"
        champs = [c.strip() for c in ligne.split("\t")]
        if len(champs) not in (3, 4) or not all(champs[:3]):
            raise ErreurLecture(f"{ou} : graphie, lecture, sens (et nature), separes par des tabulations")
        m, l, fr = champs[:3]
        if not _KANAS.match(l):
            raise ErreurLecture(f"{ou} : la lecture de {m} s'ecrit en kanas")
        if (m, _hira(l)) in vues:
            raise ErreurLecture(f"{ou} : {m} ({l}) est deja dans le glossaire")
        vues.add((m, _hira(l)))
        entrees.append({"m": m, "l": l, "fr": [s.strip() for s in fr.split(";") if s.strip()],
                        "nature": champs[3] if len(champs) == 4 else ""})
    return entrees


def _decoupe_rubis(balise) -> tuple:
    """« {私|わたし}は » -> ("私は", [(0, 1, "わたし")]) : le texte, et chaque
    groupe de furigana (debut, fin, lecture)."""
    texte, groupes, i = "", [], 0
    for m in _RUBI.finditer(balise):
        texte += balise[i:m.start()]
        groupes.append((len(texte), len(texte) + len(m.group(1)), m.group(2)))
        texte += m.group(1)
        i = m.end()
    return texte + balise[i:], groupes


def _compare(s) -> str:
    """Une lecture, pour comparer : en hiraganas, le trait des voyelles
    longues remplace par la voyelle qu'il allonge (コーヒー, こおひい)."""
    sortie = ""
    for c in _hira(s):
        sortie += _hira(_VOYELLES.get(_kata(sortie[-1]), "")) if c == "ー" and sortie else c
    return sortie


# Les nombres : 七, 十二, 千五百, 2024.
_CHIFFRES = dict(zip("〇一二三四五六七八九", range(10)))
_PUISSANCES = {"十": 10, "百": 100, "千": 1000}


def _nombre(s):
    """« 千五百 » -> 1500, « ２０ » -> 20 ; None si ce n'est pas un nombre."""
    s = s.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    if s.isdigit():
        return int(s)
    if not s or any(c not in _CHIFFRES and c not in _PUISSANCES and c != "万" for c in s):
        return None
    total, bloc, chiffre = 0, 0, None
    for c in s:
        if c in _CHIFFRES:
            chiffre = (chiffre or 0) * 10 + _CHIFFRES[c] if chiffre is not None else _CHIFFRES[c]
        elif c in _PUISSANCES:
            bloc += (chiffre if chiffre is not None else 1) * _PUISSANCES[c]
            chiffre = None
        else:                  # 万
            total += (bloc + (chiffre or 0)) * 10000
            bloc, chiffre = 0, None
    return total + bloc + (chiffre or 0)


MOIS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
        "septembre", "octobre", "novembre", "décembre")
# Ce qu'un nombre devient devant son compteur ; {n}, le nombre. Avec 何,
# la question.
COMPTEURS = {
    "時": ("{n} h", "quelle heure ?"), "時半": ("{n} h 30", "à quelle heure et demie ?"),
    "分": ("{n} min", "combien de minutes ?"), "秒": ("{n} s", "combien de secondes ?"),
    "時間": ("{n} heure(s), en durée", "combien d'heures ?"),
    "分間": ("{n} minute(s), en durée", "combien de minutes ?"),
    "日間": ("{n} jour(s), en durée", "combien de jours ?"),
    "週間": ("{n} semaine(s)", "combien de semaines ?"),
    "か月": ("{n} mois, en durée", "combien de mois ?"), "ヶ月": ("{n} mois, en durée", "combien de mois ?"),
    "年間": ("{n} an(s), en durée", "combien d'années ?"),
    "年": ("{n} an(s), ou l'an {n}", "quelle année ?"), "月": ("{mois}", "quel mois ?"),
    "年代": ("les années {n}", "quelle décennie ?"),
    "戸": ("{n} logement(s)", "combien de logements ?"),
    "日": ("le {n} du mois, ou {n} jour(s)", "quel jour ?"),
    "人": ("{n} personne(s)", "combien de personnes ?"), "名": ("{n} personne(s)", "combien de personnes ?"),
    "歳": ("{n} an(s), l'âge", "quel âge ?"), "才": ("{n} an(s), l'âge", "quel âge ?"),
    "円": ("{n} yens", "combien de yens ?"), "回": ("{n} fois", "combien de fois ?"),
    "度": ("{n} fois, ou {n} degrés", "combien de fois ?"), "階": ("au {n}e étage", "quel étage ?"),
    "番": ("le numéro {n}", "quel numéro ?"), "番目": ("le {n}{e}", "le combientième ?"),
    "日目": ("le {n}{e} jour", "le combientième jour ?"),
    "番線": ("la voie {n}", "quelle voie ?"), "号": ("le numéro {n}", "quel numéro ?"),
    "号室": ("la chambre {n}", "quelle chambre ?"), "号車": ("la voiture {n} (d'un train)", "quelle voiture ?"),
    "つ": ("{n} (objets)", "combien ?"), "個": ("{n} (petits objets)", "combien ?"),
    "本": ("{n} (objets longs : bouteilles, crayons…)", "combien (d'objets longs) ?"),
    "枚": ("{n} (objets plats : feuilles, billets…)", "combien (d'objets plats) ?"),
    "冊": ("{n} livre(s), cahier(s)", "combien de livres ?"), "匹": ("{n} (petits animaux)", "combien d'animaux ?"),
    "頭": ("{n} (gros animaux)", "combien d'animaux ?"), "羽": ("{n} (oiseaux)", "combien d'oiseaux ?"),
    "杯": ("{n} verre(s), tasse(s), bol(s)", "combien de verres ?"), "台": ("{n} (machines, voitures)", "combien ?"),
    "軒": ("{n} maison(s)", "combien de maisons ?"), "足": ("{n} paire(s)", "combien de paires ?"),
    "着": ("{n} vêtement(s)", "combien de vêtements ?"), "通": ("{n} lettre(s)", "combien de lettres ?"),
    "点": ("{n} point(s)", "combien de points ?"), "倍": ("{n} fois plus", "combien de fois plus ?"),
    "曜日": ("", "quel jour de la semaine ?"), "キロ": ("{n} kilo(s)", "combien de kilos ?"),
    "メートル": ("{n} mètre(s)", "combien de mètres ?"), "度目": ("la {n}{re} fois", "la combientième fois ?"),
    "年生": ("en {n}{re} année", "en quelle année ?"), "か国": ("{n} pays", "combien de pays ?"),
    "ページ": ("page {n}", "quelle page ?"), "駅": ("{n} station(s)", "combien de stations ?"),
}
INTERROGATIFS = ("何", "なに", "なん", "誰", "だれ", "どこ", "いつ", "どれ", "どちら", "どっち", "いくつ",
                 "いくら", "なぜ", "どう")
# 何 + compteur + も : beaucoup, et non plus une question (何時間も, des heures).
BEAUCOUP = {
    "時間": "des heures (entières)", "分": "de longues minutes", "日": "des jours (entiers)",
    "日間": "des jours (entiers)", "週間": "des semaines", "か月": "des mois", "ヶ月": "des mois",
    "年": "des années", "年間": "des années", "人": "de nombreuses personnes", "名": "de nombreuses personnes",
    "回": "maintes fois", "度": "maintes fois", "倍": "bien des fois plus",
}


def sens_du_nombre(texte):
    """« 七時半 » -> « 7 h 30 », « 何人 » -> « combien de personnes ? » ;
    None si ce n'est pas un nombre suivi d'un compteur."""
    for compteur in sorted(COMPTEURS, key=len, reverse=True):
        if not texte.endswith(compteur) or len(texte) == len(compteur):
            continue
        tete = texte[:-len(compteur)]
        affirme, question = COMPTEURS[compteur]
        if tete == "何":
            return question
        n = _nombre(tete)
        if n is None or not affirme:
            return None
        if compteur == "年":        # 三年 : trois ans ; 二千七年 : l'an 2007
            return f"l'an {n}" if n >= 1000 else f"{n} an{'s' if n > 1 else ''}"
        if compteur == "階":       # le rez-de-chaussee est le premier niveau
            return "le rez-de-chaussée" if n == 1 else \
                f"le {n - 1}{'er' if n == 2 else 'e'} étage (au Japon, 一階 est le rez-de-chaussée)"
        return affirme.format(n=f"{n:,}".replace(",", "\u202f") if n >= 10000 else n,
                              mois=MOIS[n - 1] if 1 <= n <= 12 else n,
                              e="er" if n == 1 else "e", re="re" if n == 1 else "e")
    return None


# Les particules et ce qu'elles font, avec les points de grammaire qui les
# expliquent. Une particule a plusieurs emplois (に : le moment, le lieu, la
# destination...) : la page les donne tous, la phrase dit lequel.
PARTICULES = {
    "は": ("le thème : ce dont on parle (« quant à… »)", ["desu"]),
    "が": ("le sujet : qui fait, ce qui est", ["ga-sujet", "aru-iru", "ga-suki"]),
    "が:mais": ("mais", ["ga-mais"]),
    "を": ("le complément d'objet : ce que l'on fait, voit, mange…", ["wo"]),
    "に": ("à, dans, vers : le moment, le lieu où l'on est, la destination, la personne",
           ["ni-temps", "ni-aru", "he-ni", "ni-personne", "ni-iku"]),
    "へ": ("vers : la direction", ["he-ni"]),
    "で": ("à, dans, en, avec : le lieu de l'action, le moyen", ["de-lieu", "de-moyen"]),
    "と": ("avec, et ; ou ce que l'on dit, pense (« … »)", ["to-avec", "to-ya", "to-omou", "to-iu"]),
    "と:si": ("si, quand (à chaque fois, forcément)", ["to-condition"]),
    "も": ("aussi ; non plus ; même", ["mo"]),
    "の": ("de : relie deux noms (le livre de Léa)", ["no"]),
    "の:nom": ("celui, celle ; le fait de ; c'est que…", ["no-pronom", "nominal", "n-desu"]),
    "の:fin": ("(fin de phrase, à l'oral) explique, adoucit ; en montant, une question", ["n-desu"]),
    "か": ("la question (« ? »)", ["ka"]),
    "か:ou": ("quelque… (何か, quelque chose) ; ou", ["nanika-nanimo", "ka-incluse"]),
    "から": ("depuis, de (un point de départ)", ["kara-made"]),
    "から:raison": ("parce que, comme", ["kara-raison"]),
    "まで": ("jusqu'à", ["kara-made"]),
    "までに": ("avant, d'ici (une limite)", ["made-ni"]),
    "や": ("et (entre autres)", ["to-ya"]),
    "など": ("etc., entre autres", ["to-ya"]),
    "ね": ("n'est-ce pas ? : on partage ce qu'on dit", ["ne-yo"]),
    "よ": ("je te le dis : on apprend quelque chose à l'autre", ["ne-yo"]),
    "よね": ("n'est-ce pas ? (on en est presque sûr)", ["ne-yo"]),
    "けど": ("mais ; … (on laisse la phrase en suspens)", ["ga-mais"]),
    "より": ("que (comparer) ; depuis ; de la part de (au bas d'une lettre)", ["yori"]),
    "だけ": ("seulement, juste", ["dake"]),
    "ぐらい": ("environ, à peu près", ["gurai-goro"]),
    "しか": ("ne… que (avec un verbe au négatif)", ["shika"]),
    "ので": ("parce que, comme (une raison posée)", ["node"]),
    "のに": ("alors que, pourtant", ["noni"]),
    "し": ("et en plus (on ajoute une raison)", ["shi"]),
    "ほど": ("autant que ; à peu près", ["hodo"]),
    "ずつ": ("chacun ; petit à petit", ["zutsu"]),
    "でも": ("même ; … ou quelque chose", ["demo"]),
    "ばかり": ("rien que ; seulement", ["bakari"]),
    "って": ("(à l'oral) « … », dit-on ; quant à", ["to-iu"]),
    "な": ("ne… pas ! (défense) ; ou une exclamation", ["meirei"]),
    "かな": ("je me demande si…", []),
    "わ": ("(fin de phrase) une affirmation douce", []),
    "ぞ": ("(fin de phrase) une affirmation forte", []),
    "さ": ("(fin de phrase, oral) tu vois", []),
    "こそ": ("justement, précisément", []),
    "さえ": ("même ; il suffit de", []),
    "とか": ("par exemple, ou encore", []),
    "なんて": ("des choses comme… ! (surprise, mépris)", ["nante"]),
    # les particules faites de plusieurs mots : に + つい + て
    "について": ("au sujet de, à propos de", ["ni-tsuite"]),
    "についての": ("au sujet de (devant un nom)", ["ni-tsuite"]),
    "に対して": ("envers, à l'égard de ; par opposition à", ["ni-taishite"]),
    "に対する": ("envers (devant un nom)", ["ni-taishite"]),
    "にとって": ("pour (du point de vue de)", ["ni-totte"]),
    "によって": ("selon, en fonction de ; par (l'auteur, le moyen)", ["ni-yotte"]),
    "による": ("dû à, par (devant un nom)", ["ni-yotte"]),
    "によると": ("d'après, selon (une source)", ["ni-yoru-to"]),
    "によれば": ("d'après, selon (une source)", ["ni-yoru-to"]),
    "として": ("en tant que, comme", ["to-shite"]),
    "に比べて": ("par rapport à, comparé à", ["ni-kurabete"]),
    "に比べると": ("par rapport à, comparé à", ["ni-kurabete"]),
    "に関して": ("à propos de, concernant", ["ni-kanshite"]),
    "に関する": ("concernant (devant un nom)", ["ni-kanshite"]),
    "を通して": ("par l'intermédiaire de ; tout au long de", ["wo-tooshite"]),
    "に代わって": ("à la place de", ["ni-kawatte"]),
    "を中心に": ("autour de, centré sur", ["wo-chuushin-ni"]),
    "に従って": ("à mesure que ; conformément à", ["ni-shitagatte"]),
    "につれて": ("à mesure que", ["ni-tsurete"]),
    "をはじめ": ("à commencer par", ["wo-hajime"]),
    "のみ": ("seulement (à l'écrit)", ["dake"]),
    "ばかりか": ("non seulement… mais (aussi)", ["bakari-ka"]),
    "どころか": ("loin de…, bien au contraire", ["dokoroka"]),
    "といえども": ("même, aussi… soit-il (écrit)", ["to-iedomo"]),
    "たりとも": ("(avec une négation) pas même un seul", ["tari-tomo"]),
    "たり得る": ("peut être, mérite d'être (〜たり得る, écrit)", ["taru", "eru"]),
    "や否や": ("dès que, à peine… que", ["ya-ina-ya"]),
    "なり": ("dès que (écrit) ; ou bien (〜なり〜なり)", ["nari", "nari-nari"]),
    "ならでは": ("propre à, qu'on ne trouve que chez", ["naradewa"]),
    "ならではの": ("propre à, qu'on ne trouve que chez (devant un nom)", ["naradewa"]),
    "ごとき": ("comme, semblable à (écrit, devant un nom)", ["gotoki"]),
    "ごとく": ("comme, à la manière de (écrit)", ["gotoki"]),
    "ごとし": ("être comme, semblable à (écrit)", ["gotoki"]),
    "めく": ("prendre l'air de, sentir (le printemps, l'automne…)", ["meku"]),
    "とはいえ": ("cela dit, bien que", ["to-wa-ie"]),
    "といっても": ("même si l'on dit…, bien que", ["to-ittemo"]),
    "よう": ("comme, semblable à ; il semble que (〜ようだ, 〜ように)", ["you-da", "you-ni"]),
    "みたい": ("comme ; on dirait (à l'oral)", ["you-da"]),
    "そう": ("on dirait (〜そう) ; il paraît que (〜そうだ)", ["sou-apparence", "sou-ouidire"]),
    "のみならず": ("non seulement… mais aussi (à l'écrit)", ["nomi-narazu"]),
    "において": ("dans, en (le cadre : un lieu, un domaine)", ["ni-oite"]),
    "における": ("dans, en (devant un nom)", ["ni-oite"]),
    "にわたって": ("pendant tout, sur toute l'étendue de", ["ni-watatte"]),
    "にわたる": ("qui s'étend sur (devant un nom)", ["ni-watatte"]),
    "をめぐって": ("autour de (un débat, un conflit)", ["wo-megutte"]),
    "をめぐる": ("autour de (devant un nom)", ["wo-megutte"]),
    "に応じて": ("selon, en fonction de", ["ni-oujite"]),
    "に応じた": ("adapté à (devant un nom)", ["ni-oujite"]),
    "に伴って": ("avec, à mesure que (un changement entraîne l'autre)", ["ni-tomonatte"]),
    "に伴い": ("avec, à mesure que (un changement entraîne l'autre)", ["ni-tomonatte"]),
    "に伴う": ("qui accompagne (devant un nom)", ["ni-tomonatte"]),
    "とともに": ("avec ; en même temps que", ["to-tomo-ni"]),
    "に加えて": ("en plus de", ["ni-kuwaete"]),
    "に基づいて": ("sur la base de, d'après", ["ni-motozuite"]),
    "に基づく": ("fondé sur (devant un nom)", ["ni-motozuite"]),
    "をもとに": ("à partir de, en s'appuyant sur", ["wo-moto-ni"]),
    "に沿って": ("le long de ; conformément à", ["ni-sotte"]),
    "にかけて": ("de… à… (une période, une étendue)", ["ni-kakete"]),
    "を問わず": ("quel que soit, sans distinction de", ["wo-towazu"]),
    "にかかわらず": ("indépendamment de, que… ou non", ["ni-kakawarazu"]),
    "に関わらず": ("indépendamment de, que… ou non", ["ni-kakawarazu"]),
    "にもかかわらず": ("malgré, bien que", ["ni-mo-kakawarazu"]),
    "に限らず": ("pas seulement, pas uniquement", ["ni-kagirazu"]),
    "をきっかけに": ("à l'occasion de, à partir de (un déclic)", ["wo-kikkake-ni"]),
    "に際して": ("à l'occasion de, lors de", ["ni-saishite"]),
    "にあたって": ("au moment de, en vue de", ["ni-atatte"]),
    "に当たって": ("au moment de, en vue de", ["ni-atatte"]),
    "のもとで": ("sous (l'autorité, l'influence de)", ["no-moto-de"]),
    "に反して": ("contrairement à", ["ni-hanshite"]),
    "を抜きに": ("sans, en laissant de côté", ["wo-nuki-ni"]),
    "に先立って": ("avant, en préalable à", ["ni-sakidatte"]),
    "に先立ち": ("avant, en préalable à", ["ni-sakidatte"]),
    "を皮切りに": ("à commencer par", ["wo-kawakiri-ni"]),
    "を経て": ("après être passé par", ["wo-hete"]),
    "をもって": ("au moyen de ; à compter de", ["wo-motte"]),
    "に即して": ("conformément à, en suivant", ["ni-sokushite"]),
    "を踏まえて": ("en tenant compte de", ["wo-fumaete"]),
    "に照らして": ("à la lumière de", ["ni-terashite"]),
    "をよそに": ("sans se soucier de, au mépris de", ["wo-yoso-ni"]),
    "を契機に": ("à l'occasion de, à la faveur de", ["wo-keiki-ni"]),
    "に至っては": ("quant à (le cas le plus extrême)", ["ni-itatte-wa"]),
    "にもまして": ("plus encore que", ["ni-mo-mashite"]),
    "をおいて": ("en dehors de, à part (personne d'autre)", ["wo-oite"]),
    "かもしれない": ("peut-être, il se peut que", ["kamoshirenai"]),
    "そうだ": ("il paraît que (ce qu'on a entendu dire)", ["sou-ouidire"]),
    "うちに": ("pendant que, tant que (avant que cela change)", ["uchi-ni"]),
    "って:sujet": ("(à l'oral) quant à", []),
    "か:incluse": ("une question dans la phrase : si…, ce que…, comment…", ["ka-incluse"]),
    "と:concession": ("(après 〜よう) même si, quoi que", ["you-ga-mai-ga"]),
    "とあって": ("vu que, comme c'est (une occasion particulière)", ["to-atte"]),
    "とあっては": ("s'il s'agit de, dès lors que", ["to-atte"]),
    "ともなれば": ("quand on en arrive à, dès lors qu'il s'agit de", ["to-mo-nareba"]),
    "ともなると": ("quand on en arrive à, dès lors qu'il s'agit de", ["to-mo-nareba"]),
    "にほかならない": ("n'être rien d'autre que, c'est précisément", ["ni-hokanaranai"]),
    "に他ならない": ("n'être rien d'autre que, c'est précisément", ["ni-hokanaranai"]),
    "にすぎない": ("n'être qu'un simple, ne… que", ["ni-suginai"]),
    "に過ぎない": ("n'être qu'un simple, ne… que", ["ni-suginai"]),
    "にすぎなかった": ("n'avoir été qu'un simple, ne… que", ["ni-suginai"]),
    "に足る": ("digne de, qui mérite de", ["ni-taru"]),
    "までもない": ("inutile de, il va sans dire", ["made-mo-nai"]),
    "きらい": ("(〜きらいがある) avoir une fâcheuse tendance à", ["kirai-ga-aru"]),
}


def _cle_particule(p):
    """La cle de PARTICULES d'un morceau-particule, ou None."""
    t, sorte = p["t"], p["pos2"]
    if p.get("kamo"):
        return "かもしれない"
    if p.get("compose"):
        return t
    if p.get("ouidire"):
        return "そうだ"
    if t == "が" and sorte == "接続助詞":
        return "が:mais"
    if t == "と" and sorte == "接続助詞":
        return "と:si"
    if t in ("の", "ん") and sorte == "準体助詞":
        return "の:nom"
    if t == "の" and sorte == "終助詞":
        return "の:fin"
    if t == "から" and sorte == "接続助詞":
        return "から:raison"
    if t == "か" and sorte != "終助詞":
        return "か:ou"
    if t in ("けど", "けれど", "けれども", "だけど"):
        return "けど"
    if t == "くらい":
        return "ぐらい"
    return t if t in PARTICULES else None


# Ce qu'un verbe peut avoir derriere sa forme en -te, et ce qu'il dit alors.
APRES_TE = {
    "いる": ("〜ている", ["te-iru", "te-iru-etat"]), "おる": ("〜ている (humble)", ["te-iru", "kenjougo"]),
    "ある": ("〜てある", ["te-aru"]), "しまう": ("〜てしまう", ["te-shimau"]),
    "ちゃう": ("〜てしまう", ["te-shimau"]), "おく": ("〜ておく", ["te-oku"]),
    "みる": ("〜てみる (essayer)", ["te-miru"]), "いく": ("〜ていく", ["te-iku-kuru"]),
    "くる": ("〜てくる", ["te-iku-kuru"]), "あげる": ("〜てあげる", ["te-ageru"]),
    "くれる": ("〜てくれる", ["te-kureru"]), "もらう": ("〜てもらう", ["te-morau"]),
    "いただく": ("〜ていただく", ["te-morau", "te-itadakemasenka"]),
    "くださる": ("〜てください", ["te-kudasai"]), "ほしい": ("〜てほしい", ["te-hoshii"]),
    "いただける": ("〜ていただける (pourriez-vous… ?)", ["te-itadakemasenka"]),
    "やる": ("〜てやる (faire pour quelqu'un, de haut en bas)", ["te-ageru"]),
    "もらえる": ("〜てもらえる (pourrais-tu… ?)", ["te-morau"]),
    "いらっしゃる": ("〜ていらっしゃる (respect)", ["te-iru", "sonkeigo"]),
    "やむ": ("ne cesser de (〜てやまない)", ["te-yamanai"]), "止む": ("ne cesser de (〜てやまない)", ["te-yamanai"]),
}
# Les verbes et adjectifs qui se collent a la forme en -masu : 書き始める.
APRES_MASU = {
    "始める": ("commencer à (〜始める)", ["hajimeru"]), "終わる": ("finir de (〜終わる)", ["hajimeru"]),
    "続ける": ("continuer à (〜続ける)", ["hajimeru"]), "出す": ("se mettre à (〜出す)", ["dasu"]),
    "過ぎる": ("trop (〜すぎる)", ["sugiru"]), "すぎる": ("trop (〜すぎる)", ["sugiru"]),
    "やすい": ("facile à (〜やすい)", ["yasui-nikui"]), "にくい": ("difficile à (〜にくい)", ["yasui-nikui"]),
    "易い": ("facile à (〜やすい)", ["yasui-nikui"]), "難い": ("difficile à (〜にくい)", ["yasui-nikui"]),
    "終える": ("finir de (〜終える)", ["hajimeru"]),
    "なさる": ("(respect)", ["sonkeigo"]),
    "きる": ("jusqu'au bout, complètement (〜きる)", ["kiru"]),
    "切る": ("jusqu'au bout, complètement (〜きる)", ["kiru"]),
    "得る": ("pouvoir (arriver) (〜得る, écrit)", ["eru"]),
    "がたい": ("difficile, impossible à (〜がたい, écrit)", ["gatai"]),
}


def _forme(unite):
    """Ce que les terminaisons d'un verbe, d'un adjectif ou de です disent :
    (« poli · négatif · passé », [points de grammaire])."""
    tete, suite = unite[0], unite[1:]
    if tete.get("sanhen"):
        tete, suite = suite[0], suite[1:]
    marques, points = [], []

    def marque(texte, *noms):
        if texte and texte not in marques:
            marques.append(texte)
        points.extend(n for n in noms if n not in points)

    adjectif = tete["pos"] == "形容詞"
    tout = "".join(p["t"] for p in unite)
    for motif, texte, nom in (("ずにはおか", "ne peut manquer de (〜ずにはおかない)", "zu-ni-wa-okanai"),
                              ("ずにはいられ", "ne pas pouvoir s'empêcher de (〜ずにはいられない)", "zu-ni-wa-irarenai"),
                              ("ずにはすま", "ne pas pouvoir se dispenser de (〜ずにはすまない)", "zu-ni-wa-sumanai"),
                              ("ずには済ま", "ne pas pouvoir se dispenser de (〜ずにはすまない)", "zu-ni-wa-sumanai"),
                              ("ざるを得", "ne pas pouvoir faire autrement que (〜ざるを得ない)", "zaru-wo-enai"),
                              ("ざるをえ", "ne pas pouvoir faire autrement que (〜ざるを得ない)", "zaru-wo-enai")):
        if motif in tout:
            reste = tout.split(motif, 1)[1]
            plus = (" · poli" if "ま" in reste and "ませ" in reste else "") \
                + (" · passé" if reste.endswith(("た", "だ")) else "") \
                + (" · devenir (〜なくなる)" if "なくな" in reste else "")
            return texte + plus, [nom]
    if not suite and tete["pos"] == "動詞" and tete["cform"].startswith("連用形"):
        marque("radical (la forme en -masu, sans ます)")
    if tete.get("factitif"):
        marque("factitif (faire faire, laisser faire)", "shieki")
    if tete["cform"].startswith("意志推量形"):
        marque("volonté (〜よう)", "ikou")
    elif tete["cform"].startswith("命令形"):
        marque("impératif", "meirei")
    elif tete["cform"].startswith("仮定形") and not suite:
        marque("condition (〜ば)", "ba")
    if tete.get("potentiel"):
        marque("potentiel (pouvoir)", "kanou")
    precedent = tete
    for k, p in enumerate(suite):
        d, sorte = p["dic"], p["ctype"]
        suivant = suite[k + 1] if k + 1 < len(suite) else None
        if p["pos"] == "助動詞":
            if sorte == "助動詞-マス":
                if p["cform"].startswith("意志推量形"):
                    marque("poli · invitation (〜ましょう)", "mashou")
                else:
                    marque("poli")
            elif sorte in ("助動詞-ナイ", "助動詞-ヌ"):
                if precedent["dic"] in ("やむ", "止む") and precedent is not tete:
                    pass                       # 〜てやまない : ne cesser de
                elif p["cform"].startswith("仮定形") and (not suivant or suivant["dic"] == "ば") \
                        or p["t"] in ("なきゃ", "なくちゃ"):
                    marque("obligation : il faut (〜なければならない)", "nakereba")
                elif any(m.startswith("obligation") for m in marques):
                    pass                       # なりません : la negation de l'obligation
                elif p["t"] == "なく" and suivant and suivant["dic"] == "て" \
                        and k + 3 < len(suite) and suite[k + 2]["dic"] == "も" \
                        and suite[k + 3]["dic"] in ("いい", "良い", "よい", "かまう"):
                    marque("pas obligé de (〜なくてもいい)", "nakute-mo-ii")
                else:
                    marque("négatif")
            elif sorte == "助動詞-タ":
                if p["cform"].startswith("仮定形"):
                    marque("si, quand (〜たら)", "tara")
                else:
                    marque("passé")
            elif sorte == "助動詞-デス":
                if p["cform"].startswith("意志推量形"):
                    marque("sans doute (〜でしょう)", "deshou")
                elif not any(x["ctype"] == "助動詞-マス" for x in suite[:k]):
                    marque("poli")
            elif sorte == "助動詞-タイ":
                marque("envie (〜たい)", "tai")
            elif sorte == "助動詞-レル":
                marque("passif ou potentiel", "ukemi", "kanou")
            elif sorte == "助動詞-セル" or d in ("せる", "させる"):
                marque("factitif (faire faire, laisser faire)", "shieki")
            elif sorte == "助動詞-ダ":
                if p["cform"].startswith("意志推量形"):
                    marque("sans doute (〜だろう)", "darou")
                elif precedent["dic"] in ("そう", "よう", "みたい"):
                    pass
            elif d == "ちゃう":
                marque("〜てしまう", "te-shimau")
            elif sorte == "文語助動詞-ム":
                marque("intention, supposition (〜ん, écrit)")
            elif sorte == "文語助動詞-ベシ":
                if p["t"] == "べく":
                    marque("pour, afin de (〜べく, écrit)", "beku")
                elif p["t"] == "べから":
                    marque("à ne pas faire, interdit (〜べからず, écrit)", "bekarazu")
                else:
                    marque("devoir, mériter de (〜べき)", "beki")
            elif sorte == "助動詞-マイ":
                marque("ne… sans doute pas ; ne pas vouloir (〜まい)", "mai")
            elif d == "らしい":
                marque("il paraît (〜らしい)", "rashii")
            elif d in ("う", "よう") and not p["t"].startswith("よう"):
                marque("volonté (〜よう)", "ikou")
        elif p["pos"] == "助詞":
            if d == "で" and precedent["ctype"] == "助動詞-ナイ":
                if suivant and suivant["dic"] == "くださる":
                    marque("défense polie (〜ないでください)", "naide-kudasai")
                    if "négatif" in marques:
                        marques.remove("négatif")
                else:
                    marque("sans (〜ないで)", "naide")
            elif d in ("て", "で"):
                nxt = suivant
                if nxt and nxt["pos"] in ("動詞", "形容詞") and nxt["dic"] in APRES_TE:
                    pass                       # le verbe qui suit dit tout
                elif nxt and nxt["dic"] == "も":
                    pass
                elif nxt and nxt["dic"] == "は":
                    pass
                else:
                    marque("forme en -te", "adj-te" if adjectif else "te-enchaine")
            elif d == "も" and precedent["dic"] in ("て", "で"):
                if any(m.startswith("pas obligé") for m in marques):
                    pass
                elif suivant and suivant["dic"] in ("いい", "良い", "よい", "かまう"):
                    marque("permission (〜てもいい)", "te-mo-ii")
                else:
                    marque("même si (〜ても)", "te-mo")
            elif d == "は" and precedent["dic"] in ("て", "で") or d in ("ては", "では"):
                if suivant and (suivant["dic"] in ("いける", "なる") or suivant["pos"] == "bloc"):
                    marque("interdiction (〜てはいけない)", "te-wa-ikenai")
            elif d == "ば":
                if precedent["ctype"] != "助動詞-ナイ":
                    marque("condition (〜ば)", "ba")
            elif d == "ながら":
                marque("tout en (〜ながら)", "nagara")
            elif d == "つつ":
                if suivant and suivant["dic"] == "ある":
                    marque("est en train de (〜つつある)", "tsutsu-aru")
                else:
                    marque("tout en (〜つつ, écrit)", "tsutsu")
            elif d in ("たり", "だり"):
                marque("entre autres (〜たり)", "tari")
        elif d == "ある" and precedent["dic"] == "つつ":
            pass
        elif p["pos"] in ("動詞", "形容詞") and p.get("passe_inclus"):
            marque("〜てしまう", "te-shimau")       # しまった, lu comme un seul mot
            marque("passé")
        elif p["pos"] == "接尾辞" and (d in APRES_MASU or p["norm"] in APRES_MASU):
            texte, noms = APRES_MASU.get(d) or APRES_MASU[p["norm"]]
            marque(texte, *noms)
        elif d == "方" and p["t"] == "方":
            marque("la manière de (〜方)", "kata")
        elif p["pos"] in ("動詞", "形容詞"):
            if precedent["dic"] == "で" and d == "くださる" and any(m.startswith("défense") for m in marques):
                pass
            elif precedent["dic"] in ("て", "で") and d in APRES_TE:
                texte, noms = APRES_TE[d]
                marque(texte, *noms)
            elif precedent["dic"] in ("も",) and d in ("いい", "良い", "よい"):
                pass
            elif precedent["dic"] in ("は", "ては", "では") and d in ("いける", "行く", "なる"):
                pass
            elif d == "なさる" and p["cform"].startswith("命令形"):
                marque("ordre, conseil (〜なさい)", "nasai")
            elif d in APRES_MASU or p["norm"] in APRES_MASU:
                texte, noms = APRES_MASU.get(d) or APRES_MASU[p["norm"]]
                marque(texte, *noms)
            elif d in ("なる", "成る") and precedent["dic"] == "ば":
                pass
            elif d == "ない" or p["norm"] == "無い":
                marque("négatif")
        elif p["pos"] == "接尾辞" and d == "さ":
            marque("devenu nom : la mesure, la qualité (〜さ)", "sa")
        elif p["pos"] == "接尾辞" and d == "がる":
            marque("montrer un sentiment, chez un autre (〜がる)", "garu")
        elif p["pos"] == "形状詞" and d == "そう":
            if precedent["cform"].startswith(("終止形", "連体形")) or precedent["ctype"] == "助動詞-タ":
                marque("il paraît que (〜そうだ)", "sou-ouidire")
            else:
                marque("on dirait (〜そう)", "sou-apparence")
        elif p["pos"] == "形状詞" and d in ("よう", "みたい"):
            if suivant and suivant["t"] == "に":
                marque("pour que, de façon à (〜ように)", "you-ni")
            elif suivant and suivant["t"] == "な":
                marque("comme, semblable à (〜ような)", "you-da")
            else:
                marque("on dirait que (〜ようだ)", "you-da")
        precedent = p
    if any(m.startswith(("obligation", "pas obligé")) for m in marques) and "négatif" in marques:
        marques.remove("négatif")
    if adjectif:
        points = ["adj-neg" if x == "nai" else "adj-passe" if x == "ta" else x for x in points]
        points.append("adj-i")
    # le point du verbe poli : 〜ます, 〜ません, 〜ました
    if "poli" in marques or any(m.startswith("poli") for m in marques):
        if not adjectif and not any(m.startswith("poli ·") for m in marques):
            if "passé" in marques:
                points.insert(0, "mashita")
            elif "négatif" in marques:
                points.insert(0, "masen")
            else:
                points.insert(0, "masu")
    elif not adjectif:
        if "passé" in marques:
            points.insert(0, "ta")
        if "négatif" in marques and "nakereba" not in points:
            points.insert(0, "nai")
    elif "négatif" in marques:
        points.insert(0, "adj-neg")
    elif "passé" in marques:
        points.insert(0, "adj-passe")
    # いけません : la negation est dans l'interdiction, le point reste
    if any(m.startswith("interdiction") for m in marques) and "négatif" in marques:
        marques.remove("négatif")
    return " · ".join(marques), points


def _forme_copule(unite, adjectif=False):
    """です, でした, じゃありません... : ce que dit la copule -- apres un nom,
    ou apres un adjectif en な (`adjectif`)."""
    texte = "".join(p["t"] for p in unite)
    neg = any(p["ctype"] in ("助動詞-ヌ", "助動詞-ナイ") or p["dic"] in ("ない", "無い") for p in unite)
    passe = any(p["ctype"] == "助動詞-タ" for p in unite)
    poli = any(p["ctype"] in ("助動詞-マス", "助動詞-デス") for p in unite)
    if any(p["cform"].startswith("意志推量形") for p in unite):
        plus = "négatif · " if neg else ""
        return (plus + "sans doute (〜でしょう)", ["deshou"]) if poli else (plus + "sans doute (〜だろう)", ["darou"])
    if unite[0]["cform"].startswith("仮定形") and unite[0]["dic"] == "だ":
        return "si c'est (〜なら)", ["nara"]
    if texte in ("な",):
        return "« qui est » : relie un adjectif en な à son nom", ["adj-na"]
    if texte.startswith("であ"):
        return "être (à l'écrit : である)" + (" · négatif" if neg else "") + (" · passé" if passe else ""), ["neutre"]
    if texte in ("に",):
        return "« -ment » : adverbe d'un adjectif en な", ["adverbes"]
    if texte in ("で",):
        return "« est, et… » : la forme en -te de です", ["adj-te"]
    marques = ([] if adjectif else ["être"]) + (["poli"] if poli else ["neutre"]) \
        + (["négatif"] if neg else []) + (["passé"] if passe else [])
    if neg:
        points = ["ja-arimasen"] if poli else ["ja-arimasen", "nai"]
        if passe:
            points.append("adj-passe")
    elif passe:
        points = ["deshita"] if poli else ["neutre", "ta"]
    else:
        points = ["desu"] if poli else ["neutre"]
    return " · ".join(marques), points


# Les rangees de kanas : le potentiel 書ける revient a 書く, le radical de
# 書く est 書き.
_VERS_U = dict(zip("えけげせてねべめれ", "うくぐすつぬぶむる"))
_VERS_I = dict(zip("うくぐすつぬぶむる", "いきぎしちにびみり"))


def _radical(graphie, lecture, genres):
    """(radical, sa lecture) d'un verbe : 取る (とる) -> (取り, とり) ;
    None si ce n'est pas un verbe."""
    if any(g.startswith("v5") for g in genres) and graphie[-1:] in _VERS_I and lecture[-1:] in _VERS_I:
        return graphie[:-1] + _VERS_I[graphie[-1]], _hira(lecture[:-1] + _VERS_I[lecture[-1]])
    if any(g in ("v1", "v1-s") for g in genres) and graphie.endswith("る") and len(graphie) > 1:
        return graphie[:-1], _hira(lecture[:-1])
    return None


class Analyseur:
    """Decoupe une phrase en mots et relie chacun a ce qui l'explique (voir
    « La lecture » plus haut)."""

    def __init__(self, vocabulaire, glossaire, points=()):
        try:
            from sudachipy import Dictionary, SplitMode
        except ImportError:
            raise SystemExit("La lecture a besoin de SudachiPy : "
                             "venv/bin/pip install sudachipy sudachidict_core") from None
        dico = Dictionary(dict="core")
        self._decoupeur = dico.tokenizer(mode=SplitMode.C)
        self._fin = dico.tokenizer(mode=SplitMode.A)        # pour recouper un mot inconnu
        self.vocabulaire, self.glossaire, self.points = vocabulaire, glossaire, set(points)
        self._vocab, self._gloss = {}, {}
        for i, m in enumerate(vocabulaire):
            for g in {m["m"], m.get("a") or m["m"]}:
                self._vocab.setdefault(g, []).append(i)
        for i, e in enumerate(glossaire):
            self._gloss.setdefault(e["m"], []).append(i)
        # le radical (forme en -masu) de chaque verbe : 取る -> (取り, とり)
        self._radicaux = {}
        for sorte, liste in (("v", vocabulaire), ("x", glossaire)):
            for i, e in enumerate(liste):
                genres = e.get("p") or (["v5"] if "verbe en -u" in e.get("nature", "") else
                                        ["v1"] if "verbe en -ru" in e.get("nature", "") else [])
                for l in (e["l"] if isinstance(e["l"], list) else [e["l"]])[:1]:
                    for g in {e["m"], e.get("a") or e["m"]}:
                        r = _radical(g, l, genres)
                        if r:
                            self._radicaux.setdefault(r, {sorte: i})
        self.servis = set()            # les entrees du glossaire qui servent
        self.particules = set()        # les cles de PARTICULES qui servent

    # ---------- les morceaux de l'analyseur ----------
    def _morceaux(self, texte):
        sortie = []
        for m in self._decoupeur.tokenize(texte):
            pos = m.part_of_speech()
            sortie.append({"s": m.begin(), "e": m.end(), "t": m.surface(), "dic": m.dictionary_form(),
                           "norm": m.normalized_form(), "lu": _hira(m.reading_form()),
                           "pos": pos[0], "pos2": pos[1], "pos3": pos[2], "ctype": pos[4], "cform": pos[5]})
        return sortie

    @staticmethod
    def _recousu(morceaux, a, b, texte, **plus):
        s, e = morceaux[a]["s"], morceaux[b]["e"]
        morceaux[a:b + 1] = [{"s": s, "e": e, "t": texte[s:e], "dic": texte[s:e], "norm": texte[s:e],
                              "lu": "".join(p["lu"] for p in morceaux[a:b + 1]), "pos": "名詞",
                              "pos2": "普通名詞", "pos3": "", "ctype": "*", "cform": "*", **plus}]

    def _accorde(self, morceaux, groupes, texte):
        """Recoud les morceaux que l'analyseur coupe en travers d'un groupe de
        furigana -- sauf si ses lectures, mises bout a bout, sont celles des
        furigana (七時 : 七 + 時, しち + じ)."""
        i = 0
        while i < len(groupes):
            debut, fin, lu = groupes[i]
            dedans = [k for k, p in enumerate(morceaux) if p["s"] < fin and p["e"] > debut]
            if len(dedans) > 1:
                ps = [morceaux[k] for k in dedans]
                if ps[0]["s"] == debut and ps[-1]["e"] == fin \
                        and "".join(p["lu"] for p in ps) == _hira(lu):
                    for p in ps:
                        p["coupe"] = True
                else:
                    nombre = ps[0]["pos2"] == "数詞"
                    self._recousu(morceaux, dedans[0], dedans[-1], texte,
                                  pos2="数詞" if nombre else "普通名詞", recousu=True)
                    i = 0
                    continue
            i += 1
        # un nombre et son compteur ne font qu'un : 三 + 月, 七 + 時半
        k = 0
        while k + 1 < len(morceaux):
            p, q = morceaux[k], morceaux[k + 1]
            nombre = p["pos2"] == "数詞" or p["t"] == "何" or sens_du_nombre(p["t"])
            if nombre and q["pos"] not in ("助詞", "助動詞") and sens_du_nombre(p["t"] + q["t"]):
                coupe = p.get("coupe") or q.get("coupe")
                self._recousu(morceaux, k, k + 1, texte, pos2="数詞",
                              sous=[dict(p), dict(q)] if coupe else None)
                continue
            k += 1
        return morceaux

    @staticmethod
    def _habille(p, groupes, texte):
        """Le morceau avec ses furigana, {起|お}き, et sa lecture, おき."""
        if p.get("coupe"):
            return f"{{{p['t']}|{p['lu']}}}", p["lu"]
        if p.get("sous"):
            habits = [Analyseur._habille(q, groupes, texte) for q in p["sous"]]
            return "".join(h[0] for h in habits), "".join(h[1] for h in habits)
        if not any(g[0] < p["e"] and g[1] > p["s"] for g in groupes) and re.search(r"[A-Za-zＡ-Ｚａ-ｚ]", p["t"]):
            return p["t"], p["lu"]             # AI : えーあい
        balise, lu, k = "", "", p["s"]
        while k < p["e"]:
            g = next((g for g in groupes if g[0] == k and g[1] <= p["e"]), None)
            if g:
                balise += f"{{{texte[g[0]:g[1]]}|{g[2]}}}"
                lu += g[2]
                k = g[1]
            else:
                balise += texte[k]
                lu += texte[k]
                k += 1
        return balise, _hira(lu)

    # ---------- les mots d'un bloc : お + じい + さん ----------
    def _entrees(self, graphie):
        return [("v", i, self.vocabulaire[i]) for i in self._vocab.get(graphie, [])] \
            + [("x", i, self.glossaire[i]) for i in self._gloss.get(graphie, [])]

    def _bloc(self, seq, debut_de_phrase, suivant=None):
        graphie = "".join(p["t"] for p in seq)
        entrees = self._entrees(graphie)
        if not entrees or any(p["pos"] in _PONCTUATION for p in seq):
            return False
        lu = _compare("".join(p["x"][1] for p in seq))
        if not any(lu in {_compare(l) for l in (e["l"] if isinstance(e["l"], list) else [e["l"]])}
                   for _, _, e in entrees):
            return False
        figee = any({"exp", "int"} & set(e.get("p", [])) or e.get("nature") == "expression"
                    for _, _, e in entrees)
        conj = all({"conj"} & set(e.get("p", [])) or e.get("nature") == "conjonction"
                   for _, _, e in entrees)
        # でも, では, それに : une conjonction en tete de phrase seulement --
        # ailleurs, 学校でも est 学校 + で + も
        if conj:
            # それに対して : それ + に対して, pas la conjonction それに
            return debut_de_phrase and not (suivant and suivant["t"] in (
                "対して", "対し", "対する", "比べ", "比べて", "よって", "とって", "ついて", "関して",
                "伴い", "伴って", "伴う", "加えて", "応じて"))
        if seq[0]["pos"] in ("助詞", "助動詞"):
            return False
        flexion = seq[0]["pos"] in ("動詞", "形容詞", "形状詞") \
            and all(p["pos"] in ("助動詞", "助詞", "動詞", "形容詞") for p in seq[1:])
        if (flexion or any(p["pos"] == "助詞" for p in seq[1:])) and not figee:
            return False
        return True

    def _blocs(self, morceaux):
        sortie, i = [], 0
        while i < len(morceaux):
            debut = not sortie or sortie[-1]["pos"] in _PONCTUATION
            pris = next((k for k in range(min(7, len(morceaux) - i), 1, -1)
                         if self._bloc(morceaux[i:i + k], debut,
                                       morceaux[i + k] if i + k < len(morceaux) else None)), 1)
            if pris > 1:
                seq = morceaux[i:i + pris]
                t = "".join(p["t"] for p in seq)
                # une entree du glossaire qui fait un bloc sert, meme si le
                # vocabulaire donne le sens (必ずしも)
                self.servis.update(k for sorte, k, _ in self._entrees(t) if sorte == "x")
                sortie.append({**seq[0], "e": seq[-1]["e"], "t": t, "dic": t, "norm": t, "pos": "bloc",
                               "x": ("".join(p["x"][0] for p in seq), "".join(p["x"][1] for p in seq))})
            else:
                sortie.append(morceaux[i])
            i += pris
        return sortie

    # ---------- les mots qui se tiennent : un verbe et ses terminaisons ----------
    @staticmethod
    def _tete(p):
        return p["pos"] in ("動詞", "形容詞", "形状詞") or (p["pos"] == "接尾辞" and p["ctype"] != "*")

    def _unites(self, morceaux):
        """[[morceau, ...]] : un mot par liste, avec ses terminaisons."""
        unites, i = [], 0
        while i < len(morceaux):
            p = morceaux[i]
            j = i + 1
            # かな, よね : deux particules qui n'en font qu'une
            if p["pos"] == "助詞" and j < len(morceaux) and morceaux[j]["pos"] == "助詞" \
                    and p["t"] + morceaux[j]["t"] in PARTICULES and p["t"] not in ("の", "ん"):
                q = morceaux[j]
                unites.append([{**p, "e": q["e"], "t": p["t"] + q["t"], "pos2": q["pos2"],
                                "x": (p["x"][0] + q["x"][0], p["x"][1] + q["x"][1])}])
                i = j + 1
                continue
            # 降るそうです : le oui-dire, apres une forme finale (l'analyseur lit
            # souvent ce そう comme l'adverbe « ainsi »)
            if p["t"] == "そう" and unites and j < len(morceaux) and morceaux[j]["dic"] in ("です", "だ") \
                    and unites[-1][-1]["cform"].startswith(("終止形", "連体形")) \
                    and unites[-1][-1]["pos"] in ("動詞", "形容詞", "助動詞"):
                k = j + 1
                while k < len(morceaux) and morceaux[k]["pos"] == "助動詞":
                    k += 1
                seq = morceaux[i:k]
                unites.append([{**p, "e": seq[-1]["e"], "t": "".join(q["t"] for q in seq), "pos": "助詞",
                                "pos2": "副助詞", "ouidire": True,
                                "x": ("".join(q["x"][0] for q in seq), "".join(q["x"][1] for q in seq))}])
                i = k
                continue
            # について, にとって, として : une particule de plusieurs mots
            if p["pos"] in ("助詞", "助動詞"):
                compose = next((n for n in (5, 4, 3, 2) if i + n <= len(morceaux)
                                and "".join(q["t"] for q in morceaux[i:i + n]) in PARTICULES
                                and any(q["pos"] != "助詞" for q in morceaux[i:i + n])), None)
                if compose and "".join(q["t"] for q in morceaux[i:i + compose]) == "として" and not (
                        unites and unites[-1][-1]["pos"] in ("名詞", "代名詞", "接尾辞")):
                    compose = None     # 寝ようとして : ce n'est pas « en tant que »
                if compose:
                    seq = morceaux[i:i + compose]
                    unites.append([{**p, "e": seq[-1]["e"], "t": "".join(q["t"] for q in seq),
                                    "pos2": "格助詞", "compose": True,
                                    "x": ("".join(q["x"][0] for q in seq), "".join(q["x"][1] for q in seq))}])
                    i += compose
                    continue
            # お正月なのに : な + の + に, l'analyseur ne voit pas のに
            if p["t"] == "の" and p["pos2"] == "準体助詞" and j < len(morceaux) and morceaux[j]["t"] == "に" \
                    and unites and unites[-1][-1]["t"] == "な":
                q = morceaux[j]
                unites.append([{**p, "e": q["e"], "t": "のに", "dic": "のに", "pos2": "接続助詞",
                                "x": (p["x"][0] + q["x"][0], p["x"][1] + q["x"][1])}])
                i = j + 1
                continue
            # わからなかったので : l'analyseur lit parfois の + で (la copule)
            if p["t"] == "の" and p["pos2"] == "準体助詞" and j + 1 < len(morceaux) \
                    and morceaux[j]["t"] == "で" and morceaux[j + 1]["t"] in "、,":
                q = morceaux[j]
                unites.append([{**p, "e": q["e"], "t": "ので", "dic": "ので", "pos2": "接続助詞",
                                "x": (p["x"][0] + q["x"][0], p["x"][1] + q["x"][1])}])
                i = j + 1
                continue
            # かもしれない, かもしれません : un seul mot, un seul point
            if p["t"] == "か" and j + 1 < len(morceaux) and morceaux[j]["t"] == "も" \
                    and morceaux[j + 1]["dic"] == "しれる":
                k = j + 2
                while k < len(morceaux) and (morceaux[k]["pos"] == "助動詞" or morceaux[k]["dic"] == "ない"):
                    k += 1
                seq = morceaux[i:k]
                unites.append([{**p, "e": seq[-1]["e"], "t": "".join(q["t"] for q in seq), "pos": "助詞",
                                "pos2": "副助詞", "kamo": True,
                                "x": ("".join(q["x"][0] for q in seq), "".join(q["x"][1] for q in seq))}])
                i = k
                continue
            # で : l'analyseur y voit souvent la copule (私は学生で、) quand
            # c'est la particule (部屋で読む, 三人で, 部屋で、). La copule
            # attend une virgule, et un theme ou un sujet plus tot dans la
            # proposition.
            if p["pos"] == "助動詞" and p["t"] == "で":
                virgule = j < len(morceaux) and morceaux[j]["t"] in "、,"
                avant = []
                for q in reversed(morceaux[:i]):
                    if q["t"] in "、。,":
                        break
                    avant.append(q)
                if not virgule or not any(q["pos"] == "助詞" and q["t"] in ("は", "が", "も") for q in avant):
                    p = morceaux[i] = {**p, "pos": "助詞", "pos2": "格助詞", "dic": "で"}
            sanhen = p["pos"] == "名詞" and p["pos3"] == "サ変可能" and j < len(morceaux) \
                and morceaux[j]["pos"] == "動詞" and morceaux[j]["norm"] == "為る"
            if sanhen:
                j += 1
            # です, でした, じゃありません ; ではありません, que l'analyseur
            # lit で (particule) + は + ありません
            copule = (p["pos"] == "助動詞" and p["dic"] in ("だ", "です")) or (
                p["t"] == "で" and p["pos"] == "助詞" and j + 1 < len(morceaux)
                and morceaux[j]["t"] == "は" and morceaux[j + 1]["dic"] in ("ある", "ない")) or (
                p["t"] == "で" and j < len(morceaux) and morceaux[j]["dic"] == "ある")     # である
            if copule:
                p = morceaux[i] = {**p, "copule": True}
            na = p["pos"] == "名詞" and p["pos3"] == "形状詞可能" and j < len(morceaux) \
                and morceaux[j]["pos"] == "助動詞" and morceaux[j]["t"] in ("な", "に")
            if na and _compare(p["lu"]) != _compare(p["x"][1]) and morceaux[j]["t"] == "に":
                # 風に舞う : かぜ, le nom, et non ふう, « à la manière »
                na = False
                morceaux[j] = {**morceaux[j], "pos": "助詞", "pos2": "格助詞", "dic": "に", "norm": "に"}
            if na:
                p = morceaux[i] = {**p, "pos": "形状詞"}
            if self._tete(p) or sanhen or copule:
                while j < len(morceaux):
                    q, avant = morceaux[j], morceaux[j - 1]
                    if q["pos"] == "助動詞":
                        if q["ctype"] in ("助動詞-デス", "助動詞-ダ") and avant["pos"] == "動詞" and not copule:
                            break      # 行くです n'existe pas : c'est autre chose (行くでしょう)
                        j += 1
                    elif q["pos"] == "助詞" and (q["pos2"] == "接続助詞" or q["dic"] in ("たり", "だり")) \
                            and q["dic"] in ("て", "で", "ば", "ながら", "たり", "だり", "つつ", "ては", "では") \
                            and not copule:
                        j += 1
                    elif q["dic"] == "ある" and avant["dic"] == "つつ":
                        j += 1         # 増えつつある
                    elif q["t"] == "に" and avant["t"] == "ず" and j + 1 < len(morceaux) \
                            and morceaux[j + 1]["t"] == "は":
                        j += 1         # 〜ずには
                    elif q["t"] == "は" and avant["t"] == "に" and morceaux[j - 2]["t"] == "ず":
                        j += 1
                    elif q["pos"] == "動詞" and q["dic"] in ("おく", "いる", "すむ", "済む") and avant["t"] == "は" \
                            and morceaux[j - 3]["t"] == "ず":
                        j += 1         # 〜ずにはおかない, 〜ずにはいられない
                    elif q["pos"] == "助詞" and q["dic"] in ("も", "は") and avant["dic"] in ("て", "で") \
                            and avant["pos2"] == "接続助詞" and not copule:
                        j += 1
                    elif q["pos"] == "助詞" and q["dic"] == "は" and copule and avant["t"] in ("で", "じゃ"):
                        j += 1
                    elif q["pos"] in ("動詞", "形容詞") and avant["dic"] in ("て", "で") \
                            and avant["pos2"] == "接続助詞" and q["dic"] in APRES_TE:
                        j += 1
                    elif q["pos"] in ("動詞", "形容詞", "接尾辞") \
                            and (q["dic"] in APRES_MASU or q["norm"] in APRES_MASU) \
                            and avant["cform"].startswith("連用形") and avant["pos"] == "動詞":
                        j += 1
                    elif q["pos"] == "接尾辞" and q["dic"] in ("さ", "がる") and avant is p \
                            and (p["cform"].startswith("語幹") or p["pos"] == "形状詞"):
                        j += 1         # 多さ, かわいがる
                    elif q["t"] == "方" and q["lu"] == "かた" and avant is p and p["pos"] == "動詞" \
                            and p["cform"].startswith("連用形"):
                        j += 1         # 食べ方 : la maniere de manger
                    elif q["t"] == "しまった" and avant["dic"] in ("て", "で") and avant["pos2"] == "接続助詞":
                        morceaux[j] = {**q, "pos": "動詞", "dic": "しまう", "norm": "仕舞う",
                                       "ctype": "五段-ワア行", "cform": "連用形", "passe_inclus": True}
                        j += 1
                    elif q["pos"] == "形容詞" and q["dic"] in ("いい", "良い", "よい") and avant["dic"] == "も" \
                            and avant is not p:
                        j += 1
                    elif (q["pos"] == "動詞" and q["dic"] in ("いける", "なる")
                          or q["pos"] == "bloc" and q["t"].startswith(("いけ", "なら"))) and avant is not p \
                            and (avant["dic"] == "は" and morceaux[j - 2]["dic"] in ("て", "で")
                                 or avant["dic"] in ("ては", "では")):
                        j += 1         # 〜てはいけない, 〜てはならない
                    elif q["t"] == "を" and avant["t"] == "ざる" and j + 1 < len(morceaux) \
                            and morceaux[j + 1]["dic"] in ("得る", "える", "うる"):
                        j += 1         # 〜ざるを得ない
                    elif q["pos"] == "動詞" and q["dic"] in ("得る", "える", "うる") and avant["t"] == "を" \
                            and morceaux[j - 2]["t"] == "ざる":
                        j += 1
                    elif q["pos"] == "動詞" and q["dic"] in ("なる", "いける") and avant["dic"] == "ば" \
                            and morceaux[j - 2]["ctype"] == "助動詞-ナイ":
                        j += 1
                    elif q["pos"] == "形容詞" and q["dic"] == "ない" and q["pos2"] == "非自立可能":
                        j += 1
                    elif q["pos"] == "動詞" and q["dic"] == "ある" and copule:
                        j += 1
                    elif q["pos"] == "形状詞" and q["pos2"] == "助動詞語幹":
                        j += 1
                    else:
                        break
            unite = morceaux[i:j]
            if sanhen:
                unite[0] = {**unite[0], "sanhen": True}
            unites.append(unite)
            i = j
        return unites

    # ---------- relier un mot ----------
    def _lecture_du_lemme(self, p, lemme):
        """La lecture de la forme du dictionnaire, d'apres celle du mot tel
        qu'il est ecrit : 起き (おき) -> 起きる (おきる)."""
        if lemme in ("来る", "來る"):
            return "くる"
        s, lu = p["t"], p["x"][1]
        k = 0
        while k < min(len(s), len(lemme)) and s[k] == lemme[k]:
            k += 1
        reste_s, reste_l = s[k:], lemme[k:]
        if any(_cjk(c) for c in reste_s + reste_l) or not lu.endswith(_hira(reste_s)):
            return None
        return lu[:len(lu) - len(reste_s)] + _hira(reste_l)

    def _cherche(self, graphie, lecture):
        """La meilleure entree pour une graphie et une lecture : celle du
        vocabulaire d'abord, la plus facile d'abord."""
        trouvees = []
        for sorte, i, e in self._entrees(graphie):
            lectures = e["l"] if isinstance(e["l"], list) else [e["l"]]
            if lecture is None or _compare(lecture) in {_compare(l) for l in lectures}:
                trouvees.append((sorte, i))
        return trouvees[0] if trouvees else None

    def _relie(self, unite):
        """{v: indice dans le vocabulaire} ou {x: indice dans le glossaire},
        {n: sens du nombre}, ou None."""
        tete = unite[0]
        if tete["pos"] == "bloc":
            trouve = self._cherche(tete["t"], tete["x"][1])
            return {trouve[0]: trouve[1]} if trouve else None
        lu = tete["x"][1]
        conjugue = tete["ctype"] != "*" and not tete.get("sanhen")
        # ください, une expression du vocabulaire, plutot que くださる
        if conjugue and len(unite) == 1:
            for sorte, i, e in self._entrees(tete["t"]):
                if {"exp", "int"} & set(e.get("p", [])) or e.get("nature") == "expression":
                    tete["fige"] = True
                    return {sorte: i}
        graphies = [tete["dic"], tete["norm"]] if conjugue else [tete["t"], tete["dic"], tete["norm"]]
        # la lecture de la forme du dictionnaire : 起き (おき) -> おきる
        lu_dic = self._lecture_du_lemme(tete, tete["dic"]) if conjugue else lu
        for g in dict.fromkeys(graphies):
            # une autre graphie du meme mot (友だち, 友達 ; よい, 良い) se lit
            # pareil
            lecture = (self._lecture_du_lemme(tete, g) or lu_dic) if conjugue else lu
            if lecture is None and any(_cjk(c) for c in g):
                continue
            if lecture is None:
                lecture = g
            trouve = self._cherche(g, lecture)
            if trouve:
                if conjugue and g == tete["norm"] and g != tete["dic"] and tete["dic"] not in self._vocab:
                    autre = self._lecture_du_lemme(tete, tete["dic"])
                    if autre and _compare(autre) != _compare(lecture or ""):
                        # 休ませる : le factitif ; 行ける : le potentiel
                        factitif = tete["dic"].endswith("させる") or (
                            tete["dic"].endswith("せる") and tete["dic"][-3:-2] in "かさたなまらわがば")
                        if factitif:
                            tete["factitif"] = True
                        elif tete["dic"].endswith("る") and tete["dic"][-2:-1] in _VERS_U:
                            tete["potentiel"] = True
                return {trouve[0]: trouve[1]}
        # もらえる, 聞き取れる : le potentiel d'un verbe en -u, que
        # l'analyseur prend pour un verbe a part
        if conjugue and tete["dic"].endswith("る") and len(tete["dic"]) > 1 \
                and tete["dic"][-2] in _VERS_U and lu_dic:
            base = tete["dic"][:-2] + _VERS_U[tete["dic"][-2]]
            trouve = self._cherche(base, lu_dic[:-2] + _VERS_U.get(lu_dic[-2], ""))
            if trouve:
                tete["potentiel"] = True
                return {trouve[0]: trouve[1]}
        nombre = sens_du_nombre(tete["t"]) if _nombre(tete["t"][:1]) is not None \
            or tete["t"].startswith("何") else None
        if nombre:
            return {"n": nombre}
        n = _nombre(tete["t"])
        if n is not None and not conjugue:
            return {"n": f"{n:,}".replace(",", "\u202f") if n >= 10000 else str(n)}
        # 伝統的 : un nom + 的, « -ique »
        if tete["t"].endswith("的") and len(tete["t"]) > 1 and lu.endswith("てき"):
            trouve = self._cherche(tete["t"][:-1], lu[:-2])
            if trouve:
                tete["teki"] = True
                return {trouve[0]: trouve[1]}
        # 取り (取りに行く) : le radical d'un verbe, que l'analyseur prend
        # pour un nom
        if not conjugue and tete["pos"] == "名詞" and (tete["t"], lu) in self._radicaux:
            tete["radical"] = True
            return self._radicaux[(tete["t"], lu)]
        # une graphie que le vocabulaire n'a pas (昼ごはん, 昼ご飯) : un mot qui se
        # lit pareil et contient les memes kanjis
        if not conjugue and any(_cjk(c) for c in tete["t"]):
            kanjis = {c for c in tete["t"] if _cjk(c)}
            for i, m in enumerate(self.vocabulaire):
                if _compare(lu) in {_compare(l) for l in m["l"]} and kanjis <= set(m["m"] + m.get("a", "")):
                    return {"v": i}
        return None

    def _recoupe(self, p, groupes, texte):
        """Un mot que rien n'explique, recoupe en ses plus petits morceaux
        (昼ごろ : 昼 + ごろ) -- si les furigana le permettent. [] sinon."""
        if p.get("recousu") or p["pos"] == "bloc" or p["ctype"] != "*":
            return []
        sous = []
        for m in self._fin.tokenize(texte[p["s"]:p["e"]]):
            pos = m.part_of_speech()
            sous.append({"s": p["s"] + m.begin(), "e": p["s"] + m.end(), "t": m.surface(),
                         "dic": m.dictionary_form(), "norm": m.normalized_form(),
                         "lu": _hira(m.reading_form()), "pos": pos[0], "pos2": pos[1], "pos3": pos[2],
                         "ctype": pos[4], "cform": pos[5]})
        if len(sous) < 2:
            return []
        dedans = [g for g in groupes if g[0] >= p["s"] and g[1] <= p["e"]]
        sous = self._accorde(sous, dedans, texte)
        if len(sous) < 2:
            return []
        for q in sous:
            q["x"] = self._habille(q, dedans, texte)
        return self._unites(self._blocs(sous))

    def analyse(self, balise, ou):
        """Une phrase en balisage -> ses mots, chacun relie :
        [« 。 » | {t: balise, v | x | n | k, f, g}]. Les erreurs : une liste de
        textes, vide si tout va bien."""
        texte, groupes = _decoupe_rubis(balise)
        morceaux = self._accorde(self._morceaux(texte), groupes, texte)
        for p in morceaux:
            p["x"] = self._habille(p, groupes, texte)
        morceaux = self._blocs(morceaux)
        mots, erreurs = [], []
        unites = self._unites(morceaux)
        while unites:
            unite = unites.pop(0)
            tete = unite[0]
            balise_mot = "".join(p["x"][0] for p in unite)
            if all(p["pos"] in _PONCTUATION for p in unite):
                mots.append(balise_mot)
                continue
            mot = {"t": balise_mot}
            if tete["pos"] == "助詞" and len(unite) == 1:
                cle = _cle_particule(tete)
                if cle:
                    mot["k"] = cle
                    self.particules.add(cle)
                else:
                    erreurs.append(f"{ou} : la particule « {tete['t']} » n'est pas dans PARTICULES")
                mot["_tete"] = tete
                mots.append(mot)
                continue
            if tete["pos"] in ("助動詞", "接尾辞") and not tete.get("copule") \
                    and (tete["t"] in PARTICULES or tete["dic"] in PARTICULES):
                # ごとき, 〜めく : de la grammaire ecrite
                mot["k"] = tete["t"] if tete["t"] in PARTICULES else tete["dic"]
                self.particules.add(mot["k"])
                if len(unite) > 1 or tete["ctype"] != "*":
                    mot["f"], _ = _forme(unite)
                mot["_tete"] = tete
                mots.append(mot)
                continue
            if tete["pos"] == "形状詞" and tete["pos2"] == "助動詞語幹" and tete["dic"] in PARTICULES:
                # ように, ような, そうだ : la grammaire, pas le mot « façon »
                mot["k"] = tete["dic"]
                self.particules.add(tete["dic"])
                suite = "".join(q["t"] for q in unite[1:])
                mot["f"] = {"に": "ように : comme ; pour que, de façon à", "な": "ような : comme, semblable à"}.get(
                    suite, "") if tete["dic"] == "よう" else _forme_copule(unite[1:], adjectif=True)[0] if suite else ""
                mot["_tete"] = tete
                mots.append(mot)
                continue
            if tete.get("copule"):
                mot["f"], mot["g"] = _forme_copule(unite)
            elif tete["pos"] == "助動詞":
                erreurs.append(f"{ou} : « {tete['t']} » seul, sans le mot qu'il termine")
            else:
                lien = self._relie(unite)
                recoupe = self._recoupe(tete, groupes, texte) if lien is None and len(unite) == 1 else []
                if recoupe:
                    unites[:0] = recoupe
                    continue
                if lien is None:
                    lemme = tete["dic"] if tete["ctype"] != "*" else tete["t"]
                    erreurs.append(f"{ou} : « {tete['t']} » ({tete['x'][1]} ; forme du dictionnaire "
                                   f"{lemme}) n'est ni dans le vocabulaire ni dans le glossaire")
                else:
                    mot.update(lien)
                    if "x" in lien:
                        self.servis.add(lien["x"])
                if tete.get("teki"):
                    mot["f"] = "+ 的 : « -ique », un adjectif en な fait d'un nom"
                    if len(unite) > 1:
                        f, g = _forme_copule(unite[1:], adjectif=True)
                        mot["f"] += f" · {f}"
                        mot["g"] = g
                elif tete.get("radical"):
                    mot["f"] = "radical (la forme en -masu, sans ます)"
                elif (tete["ctype"] != "*" or tete.get("sanhen")) and not tete.get("fige"):
                    mot["f"], mot["g"] = _forme(unite)
                elif tete["pos"] == "形状詞" and len(unite) > 1 and unite[1]["pos"] == "接尾辞":
                    mot["f"], mot["g"] = _forme(unite)
                elif tete["pos"] == "形状詞" and len(unite) > 1:
                    mot["f"], mot["g"] = _forme_copule(unite[1:], adjectif=True)
                    mot["g"] = ["adj-na"] + mot["g"]
            mot["_tete"] = tete
            mots.append(mot)
        self._motifs(mots)
        for mot in mots:
            if isinstance(mot, str):
                continue
            del mot["_tete"]
            if "g" in mot:
                mot["g"] = list(dict.fromkeys(g for g in mot["g"] if g in self.points)) or None
                if not mot["g"]:
                    del mot["g"]
            if "f" in mot and not mot["f"]:
                del mot["f"]
        return mots, erreurs

    def _motifs(self, mots):
        """Les points de grammaire que portent plusieurs mots ensemble :
        ために, ことができる, 〜たほうがいい, うちに, ようになる..."""
        pleins = [m for m in mots if not isinstance(m, str)]

        def ajoute(m, nom, devant=False):
            m["g"] = ([nom] if devant else []) + [g for g in m.get("g", []) if g != nom] + ([] if devant else [nom])

        def remplace(m, avant, apres, nom):
            m["f"] = m.get("f", "").replace(avant, apres)
            m["g"] = [nom if g == "ikou" else g for g in m.get("g", [])]

        for k, m in enumerate(pleins):
            tete = m["_tete"]
            s = surface(m["t"])
            apres = [surface(x["t"]) for x in pleins[k + 1:k + 4]]
            lem = [x["_tete"]["dic"] for x in pleins[k + 1:k + 4]]
            avant = pleins[k - 1] if k else None
            predicat = avant is not None and avant["_tete"]["pos"] in ("動詞", "形容詞") or (
                avant is not None and "passé" in avant.get("f", ""))
            passe = avant is not None and "passé" in avant.get("f", "")
            if s == "ため" and apres[:1] == ["に"]:
                ajoute(m, "tame-ni", True)
            elif s in ("ほう", "方") and tete["lu"] == "ほう" and apres[:1] == ["が"] \
                    and lem[1:2] and lem[1] in ("いい", "良い", "よい"):
                ajoute(m, "hou-ga-ii", True)
            elif s == "こと" and apres[:1] == ["が"] and lem[1:2] == ["できる"]:
                ajoute(m, "koto-ga-dekiru", True)
            elif s == "こと" and apres[:1] == ["が"] and lem[1:2] in (["ある"], ["ない"]) and passe:
                ajoute(m, "ta-koto-ga-aru", True)
            elif s == "こと" and apres[:1] == ["に"] and lem[1:2] in (["なる"], ["する"]):
                ajoute(m, "koto-ni-naru" if lem[1] == "なる" else "koto-ni-suru", True)
            elif s == "うち" and apres[:1] == ["に"] and predicat:
                for cle in ("v", "x"):
                    m.pop(cle, None)
                m["k"] = "うちに"
                self.particules.add("うちに")
            elif s in ("つもり",):
                ajoute(m, "tsumori", True)
            elif s == "予定":
                ajoute(m, "yotei", True)
            elif s == "はず" and predicat:
                ajoute(m, "hazu", True)
            elif s == "ところ" and predicat:
                ajoute(m, "tokoro", True)
            elif s in ("とき", "時") and tete["lu"] == "とき" and (predicat or (avant and surface(avant["t"]) == "の")):
                ajoute(m, "toki", True)
            elif s == "前" and apres[:1] == ["に"] and predicat:
                ajoute(m, "mae-ni", True)
            elif s in ("あと", "後") and tete["lu"] == "あと" and apres[:1] == ["で"] and passe:
                ajoute(m, "ta-ato-de", True)
            elif s == "間" and tete["lu"] == "あいだ":
                ajoute(m, "aida", True)
            elif s.endswith("ん") and "écrit" in m.get("f", "") and apres[:1] == ["ばかり"]:
                m["f"] = m["f"].replace("intention, supposition (〜ん, écrit)", "comme sur le point de (〜んばかり)")
                m["g"] = ["n-bakari"]
            elif s.endswith("ん") and "écrit" in m.get("f", "") and apres[:1] == ["が"] and lem[1:2] in (["ため"], ["為"]):
                m["f"] = m["f"].replace("intention, supposition (〜ん, écrit)", "afin de (〜んがため, écrit)")
                m["g"] = ["n-ga-tame"]
            elif s == "ゆえ" and apres[:1] == ["に"]:
                ajoute(m, "yue-ni", True)
            elif s == "まま":
                ajoute(m, "mama", True)
            elif s in ("おかげ", "お陰") and apres[:1] == ["で"]:
                ajoute(m, "okage-de", True)
            elif s == "せい" and apres[:1] == ["で"]:
                ajoute(m, "sei-de", True)
            elif s.endswith("ず") and "négatif" in m.get("f", "") and apres[:1] == ["に"]:
                m["f"] = m["f"].replace("négatif", "sans (〜ずに)")
                m["g"] = ["zu-ni"] + [g for g in m.get("g", []) if g != "nai"]
            # 何時間も : des heures, et non « combien d'heures ? »
            elif "n" in m and s.startswith("何") and apres[:1] == ["も"] and s[1:] in BEAUCOUP:
                m["n"] = BEAUCOUP[s[1:]]
            # 安いか, 来るのか : une question dans la phrase ; 何か reste
            # « quelque chose », 本か雑誌 « ou »
            elif m.get("k") == "か:ou" and avant is not None and (
                    surface(avant["t"]) not in INTERROGATIFS
                    and (avant["_tete"]["pos"] in ("動詞", "形容詞", "助動詞") or avant.get("k") == "の:nom"
                         or avant["_tete"].get("copule"))
                    # 〜ことは何かを考える : « ce que c'est »
                    or surface(avant["t"]) in INTERROGATIFS and k >= 2 and pleins[k - 2].get("k") == "は"
                    and apres[:1] and apres[0] in ("を", "が", "は")):
                m["k"] = "か:incluse"
                self.particules.add(m["k"])
            # どんな道具を使おうと : quoi que l'on fasse
            elif m.get("k") in ("と", "と:si") and avant is not None and "volonté (〜よう)" in avant.get("f", "") \
                    and not (lem[:1] and lem[0] in ("思う", "考える", "する", "決める", "言う", "誓う")):
                m["k"] = "と:concession"
                self.particules.add(m["k"])
                remplace(avant, "volonté (〜よう)", "même si, quoi que (〜(よ)うと)", "you-ga-mai-ga")
            # 隠すきらいがある
            elif s == "きらい" and predicat and apres[:1] == ["が"] and lem[1:2] == ["ある"]:
                for cle in ("v", "x"):
                    m.pop(cle, None)
                m["k"] = "きらい"
                self.particules.add("きらい")
            # 思いがある限り : tant que
            elif s in ("限り", "かぎり") and predicat:
                m["f"] = "tant que, dans la limite de (〜限り)"
                m["g"] = ["nai-kagiri" if "négatif" in avant.get("f", "") else "kagiri"]
            elif s == "余儀なく":
                ajoute(m, "wo-yoginaku-sareru", True)
            elif tete["dic"] in ("禁ずる", "禁じる") and "得" in s:
                m["f"] = "ne pouvoir retenir, ne pouvoir s'empêcher de (〜を禁じ得ない)"
                m["g"] = ["wo-kinjienai", "eru"]
            elif s == "もの" and passe and apres[:1] and apres[0] in ("だ", "です", "だった", "でした"):
                ajoute(m, "ta-mono-da", True)
            elif s in ("わけ", "訳") and tete["lu"] == "わけ":
                if apres[:2] == ["に", "は"] and lem[2:3] in (["いく"], ["行く"]):
                    ajoute(m, "wake-ni-wa-ikanai", True)
                elif apres[:1] and apres[0].startswith(("では", "じゃ")):
                    ajoute(m, "wake-dewa-nai", True)
                elif apres[:1] == ["が"] and lem[1:2] in (["ない"], ["無い"]):
                    ajoute(m, "wake-ga-nai", True)
                elif apres[:1] and apres[0] in ("だ", "です"):
                    ajoute(m, "wake-da", True)
            elif s == "なし" and apres[:1] == ["に"]:
                ajoute(m, "nashi-ni", True)
            # 〜ように + なる, + する
            if "you-ni" in m.get("g", []) and lem[:1] in (["なる"], ["する"]):
                m["g"] = [("you-ni-naru" if lem[0] == "なる" else "you-ni-suru") if g == "you-ni" else g
                          for g in m["g"]]
            # 〜なんです : な + の
            if s == "な" and m.get("f", "").startswith("« qui est »") and apres[:1] and apres[0] in ("の", "ん"):
                m["f"], m["g"] = "« c'est que… » (〜なんです)", ["n-desu"]
            # おかけする : お + radical + する, la modestie
            if tete["dic"] == "する" and k >= 2 and surface(pleins[k - 2]["t"]) == "お" \
                    and pleins[k - 1]["_tete"]["pos"] == "動詞":
                ajoute(m, "o-suru", True)


def construit_lecture(fichiers=None, vocabulaire=None, glossaire=None, points=None) -> dict:
    """Tous les textes, du N5 au N1, decoupes, relies et verifies : des
    champs, des questions qui ont une bonne reponse, des points de grammaire
    qui existent, et pas un mot sans explication."""
    fichiers = LECTURE if fichiers is None else fichiers
    if vocabulaire is None:
        vocabulaire = construit_vocabulaire()
    glossaire = lit_glossaire() if glossaire is None else glossaire
    if points is None:
        points = [p["nom"] for p in construit_grammaire()["points"]]
    textes = []
    for n in sorted(fichiers, reverse=True):
        if Path(fichiers[n]).is_file():
            textes += lit_lecture(fichiers[n], n)
    analyseur = Analyseur(vocabulaire, glossaire, points)
    noms, erreurs = set(), []
    for t in textes:
        lieu = t.pop("_ou")
        if t["nom"] in noms:
            raise ErreurLecture(f"{lieu} : le texte « {t['nom']} » existe deja")
        noms.add(t["nom"])
        for champ in ("titre", "fr", "genre", "intro"):
            if not t[champ]:
                raise ErreurLecture(f"{lieu} : il manque « {champ}: »")
        if t["genre"] not in GENRES_TEXTE:
            raise ErreurLecture(f"{lieu} : genre « {t['genre']} » inconnu ({', '.join(GENRES_TEXTE)})")
        if not t["p"]:
            raise ErreurLecture(f"{lieu} : un texte sans phrase")
        if len(t["q"]) < QUESTIONS_MINI:
            raise ErreurLecture(f"{lieu} : {len(t['q'])} question(s), il en faut {QUESTIONS_MINI}")
        for q in t["q"]:
            ou = q.pop("_ou")
            if len(q["c"]) < 2 or q["r"] is None:
                raise ErreurLecture(f"{ou} : une question a au moins deux reponses, dont une bonne (« + »)")
        for paragraphe in t["p"]:
            for ph in paragraphe:
                ou = ph.pop("_ou")
                for g in ph.get("g", []):
                    if g not in analyseur.points:
                        raise ErreurLecture(f"{ou} : le point de grammaire « {g} » n'existe pas")
                ph["m"], fautes = analyseur.analyse(ph.pop("jp"), ou)
                erreurs += fautes
                balise = "".join(m if isinstance(m, str) else m["t"] for m in ph["m"])
                texte, lu = surface(balise), lecture_de(balise)
                ph["son"] = PREFIXE_PHRASE + hashlib.sha1(f"{texte}|{lu}".encode()).hexdigest()[:10]
    if erreurs:
        raise ErreurLecture("\n".join(erreurs))
    inutiles = [e["m"] for i, e in enumerate(glossaire) if i not in analyseur.servis]
    if inutiles and fichiers is LECTURE:
        raise ErreurLecture(f"{GLOSSAIRE.name} : ne sert a aucun texte : {' '.join(inutiles)}")
    return {"textes": textes,
            "glossaire": [{k: v for k, v in e.items() if v} for e in glossaire],
            "particules": {k: {"fr": PARTICULES[k][0], "g": [g for g in PARTICULES[k][1] if g in analyseur.points]}
                           for k in sorted(analyseur.particules)}}


# --------------------------------------------------------------------------
#   Le romaji
# --------------------------------------------------------------------------
# La page peut ecrire le japonais en lettres latines (le reglage « rōmaji »,
# voir static/nihongo/romaji.js) : le Hepburn des dictionnaires et des
# gares, ses voyelles longues marquees (とうきょう : tōkyō), les particules
# comme elles se disent (は : wa, へ : e, を : o), et des espaces entre les
# mots.
#
# Un mot seul, la page le transcrit elle-meme, et les textes de la lecture
# aussi : ils arrivent deja decoupes en mots. Les phrases de la grammaire,
# et le japonais glisse dans les explications en francais, ne le sont pas :
# SudachiPy les decoupe ici, une fois, et static/nihongo/romaji.json garde
# leur transcription -- la page ne le demande qu'en romaji. Les lectures
# sont celles des furigana, pas celles de l'analyseur : 私 se lit わたし,
# comme la phrase l'ecrit.
#
# Meme table et memes regles que static/nihongo/romaji.js.
def _table_romaji() -> dict:
    t = {}
    lignes = {"": "あいうえお", "k": "かきくけこ", "s": "さしすせそ", "t": "たちつてと", "n": "なにぬねの",
              "h": "はひふへほ", "m": "まみむめも", "r": "らりるれろ", "g": "がぎぐげご", "z": "ざじずぜぞ",
              "d": "だぢづでど", "b": "ばびぶべぼ", "p": "ぱぴぷぺぽ"}
    for c, kanas in lignes.items():
        for v, k in zip("aiueo", kanas):
            t[k] = c + v
    t.update({"し": "shi", "ち": "chi", "つ": "tsu", "ふ": "fu", "じ": "ji", "ぢ": "ji", "づ": "zu",
              "や": "ya", "ゆ": "yu", "よ": "yo", "わ": "wa", "ゐ": "i", "ゑ": "e", "を": "o", "ん": "n",
              "ゔ": "vu", "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o", "ゃ": "ya", "ゅ": "yu",
              "ょ": "yo", "ゎ": "wa", "ゕ": "ka", "ゖ": "ke"})
    # les sons contractes : きゃ kya, しゃ sha, じゃ ja
    for k, c in zip("きにひみりぎびぴ", ("k", "n", "h", "m", "r", "g", "b", "p")):
        for petit, v in zip("ゃゅょ", "auo"):
            t[k + petit] = c + "y" + v
    for k, c in (("し", "sh"), ("ち", "ch"), ("じ", "j"), ("ぢ", "j")):
        for petit, v in zip("ゃゅょ", "auo"):
            t[k + petit] = c + v
    # les sons des mots d'ailleurs : ティ, ファ, ヴァ
    t.update({"しぇ": "she", "ちぇ": "che", "じぇ": "je", "てぃ": "ti", "でぃ": "di", "とぅ": "tu",
              "どぅ": "du", "てゅ": "tyu", "でゅ": "dyu", "ふぁ": "fa", "ふぃ": "fi", "ふぇ": "fe",
              "ふぉ": "fo", "ふゅ": "fyu", "うぃ": "wi", "うぇ": "we", "うぉ": "wo", "ゔぁ": "va",
              "ゔぃ": "vi", "ゔぇ": "ve", "ゔぉ": "vo", "つぁ": "tsa", "つぃ": "tsi", "つぇ": "tse",
              "つぉ": "tso", "いぇ": "ye", "くぁ": "kwa", "ぐぁ": "gwa", "きぇ": "kye", "にぇ": "nye",
              "ひぇ": "hye"})
    return t


ROMAJI = _table_romaji()
_PETITS = "ぁぃぅぇぉゃゅょゎ"
_LONGUES = {("a", "あ"), ("u", "う"), ("o", "う"), ("o", "お"), ("e", "え")}
_MACRON = dict(zip("aiueo", "āīūēō"))
PONCTUATION_ROMAJI = {"。": ".", "、": ",", "？": "?", "！": "!", "「": "“", "」": "”", "『": "“",
                      "』": "”", "（": "(", "）": ")", "・": "·", "〜": "~", "～": "~", "―": "—",
                      "　": " ", "，": ",", "．": "."}
COUPURE = "|"                  # entre deux voyelles qui ne font pas une longue
_TENU = "\x01"                 # une marque (**) au milieu d'un mot : passe telle quelle


def _moras(s) -> list:
    """Les kanas un par un, un son contracte (きょ, ティ) comptant pour un."""
    moras, i = [], 0
    while i < len(s):
        if s[i + 1:i + 2] in tuple(_PETITS) and s[i:i + 2] in ROMAJI:
            moras.append(s[i:i + 2])
            i += 2
        else:
            moras.append(s[i])
            i += 1
    return moras


def kana_en_romaji(texte, suite="") -> str:
    """« とうきょう » -> « tōkyō ». っ double la consonne qui suit (がっこう :
    gakkō), ん prend une apostrophe devant une voyelle (こんや : kon'ya), ー
    et une voyelle qui en allonge une autre font une voyelle longue (コーヒー :
    kōhī, おかあさん : okāsan) -- sauf い, qui reste ecrit (せんせい : sensei,
    いいえ : iie). を se dit o. COUPURE separe deux voyelles qui ne font pas
    une longue (おも|う : omou). Le reste passe tel quel. `suite` : les kanas
    du mot colle a celui-ci, pour un っ ou un ん final (吸っ・て : sutte)."""
    moras = _moras(_hira(str(texte or "")))
    apres = _moras(_hira(str(suite or "")))[:1]
    moras_et_suite = moras + apres
    sortie, voyelle = "", None          # la voyelle sur laquelle finit le dernier kana
    for k, m in enumerate(moras):
        if m == COUPURE:
            voyelle = None
            continue
        if m == _TENU:
            sortie += m
            voyelle = None
            continue
        if m == "っ":
            r = ROMAJI.get(next((x for x in moras_et_suite[k + 1:] if x != _TENU), ""), "")
            if r and r[0] not in "aiueo":
                sortie += "t" if r.startswith("ch") else r[0]
            voyelle = None
            continue
        if m == "ん":
            r = ROMAJI.get(next((x for x in moras_et_suite[k + 1:] if x not in (_TENU, COUPURE)), ""), "")
            sortie += "n'" if r[:1] in tuple("aiueoy") and r else "n"
            voyelle = None
            continue
        if m == "ー":
            if voyelle:
                sortie = sortie[:-1] + _MACRON[voyelle]
            voyelle = None
            continue
        r = ROMAJI.get(m)
        if r is None:
            sortie += PONCTUATION_ROMAJI.get(m, m)
            voyelle = None
            continue
        if voyelle and (voyelle, m) in _LONGUES:
            sortie = sortie[:-1] + _MACRON[voyelle]
            voyelle = None
            continue
        sortie += r
        voyelle = r[-1] if r[-1] in "aiueo" else None
    return sortie


_J_ROMAJI = r"\{[^{}|]+\|[^{}|]+\}|[ぁ-ゖァ-ヺー〜々・「」『』。、？！（）]|[㐀-鿿]"
# Le japonais glisse dans du francais : la meme chose que JAPONAIS dans
# nihongo.js, et le gras (**) en son milieu -- {話|はな}せる**ようになりました.
FRAGMENT_JAPONAIS = re.compile(rf"(?:{_J_ROMAJI})(?:{_J_ROMAJI}|\*\*(?=(?:{_J_ROMAJI})))*")
_MORCEAU = re.compile(r"\{([^{}|]+)\|([^{}|]+)\}|(\*\*|\x02)|(.)", re.S)
HONORIFIQUES = {"さん", "さま", "様", "くん", "君", "ちゃん", "殿", "氏"}
_ATTACHES = {"て", "で", "ば", "たり", "だり", "ちゃ", "じゃ", "つつ", "ながら"}
_A_PART = {"だ", "です", "らしい", "べし"}


class Romaniseur:
    """Du japonais balise ({学生|がくせい}です), en romaji : « gakusei desu »."""

    def __init__(self):
        try:
            from sudachipy import Dictionary, SplitMode
        except ImportError:
            raise SystemExit("Le romaji a besoin de SudachiPy : "
                             "venv/bin/pip install sudachipy sudachidict_core") from None
        self._decoupeur = Dictionary(dict="core").tokenizer(mode=SplitMode.C)

    def _mots(self, balise):
        """Les mots de la phrase : des morceaux de l'analyseur, recousus quand
        un groupe de furigana passe a cheval ; leur lecture (celle des
        furigana), et les marques (**, \\x02) qui tombent en leur milieu."""
        morceaux, marques, texte = [], [], ""
        for m in _MORCEAU.finditer(balise):
            base, lu, marque, car = m.groups()
            if marque:
                marques.append((len(texte), marque))
            else:
                s = base or car
                morceaux.append((len(texte), s, lu or (car if not _cjk(car) else None)))
                texte += s
        bornes = {debut for debut, _, _ in morceaux} | {len(texte)}
        jetons = list(self._decoupeur.tokenize(texte)) if texte.strip() else []
        mots, courant = [], None
        for j in jetons:
            if courant is None:
                pos = j.part_of_speech()
                courant = {"s": j.begin(), "pos": pos, "dic": j.dictionary_form(),
                           "lu_analyseur": "", "fin_pos": pos}
            courant["e"] = j.end()
            courant["fin_pos"] = j.part_of_speech()
            courant["lu_analyseur"] += _hira(j.reading_form())
            if j.end() in bornes:
                mots.append(courant)
                courant = None
        for mot in mots:
            mot["t"] = texte[mot["s"]:mot["e"]]
            dedans = [(d, s, lu) for d, s, lu in morceaux if mot["s"] <= d < mot["e"]]
            if any(lu is None for _, _, lu in dedans):
                mot["lu"] = mot["lu_analyseur"]           # un kanji sans furigana
            else:
                lu = ""
                for d, s, l in dedans:
                    lu += "".join(_TENU for p, _ in marques if p == d and d > mot["s"]) + l
                mot["lu"] = lu
        return mots, marques

    @staticmethod
    def _joint(avant, mot):
        """Ce qui separe deux mots : une espace, rien (たべ・ました, ご・はん),
        ou un trait d'union (田中-さん, 3-時)."""
        p0, p1, p2 = mot["pos"][:3]
        a0, a1 = avant["pos"][:2]
        if avant["t"] in ("「", "『", "（", "〜", "～") or a0 == "接頭辞":
            return ""
        if avant["t"] == "・":
            return " "
        if p0 in ("補助記号", "空白"):
            return " " if mot["t"] in ("「", "『", "（", "・", "〜", "～") else ""
        chiffres = avant["t"].isascii() and avant["t"].isdigit()
        if p0 == "接尾辞":
            return "-" if mot["t"] in HONORIFIQUES or chiffres else ""
        if a1 == "数詞" and (p1 == "数詞" or p2 == "助数詞可能"):
            return "-" if chiffres and p1 != "数詞" else ""
        if p0 == "助動詞":
            return " " if mot["dic"] in _A_PART else ""
        if p0 == "助詞" and ((p1 == "接続助詞" and mot["t"] in _ATTACHES) or (p1 == "準体助詞" and mot["t"] == "ん")):
            return ""
        fin = avant["fin_pos"]
        if p0 == "動詞" and p1 == "非自立可能" and fin[0] == "動詞" and fin[5].startswith("連用形"):
            return ""
        if p0 == "形状詞" and p1 == "助動詞語幹" and mot["t"] == "そう" and fin[0] in ("動詞", "形容詞"):
            return ""
        return " "

    @staticmethod
    def _kana(mot):
        """La lecture d'un mot, prete a transcrire : les particules comme elles
        se disent, et le う final d'un verbe (思う) qui n'allonge rien."""
        lu, p0 = mot["lu"], mot["pos"][0]
        if p0 == "助詞" and mot["t"] in ("は", "へ"):
            return "わ" if mot["t"] == "は" else "え"
        if p0 in ("接続詞", "感動詞") and lu.endswith("は"):
            return lu[:-1] + "わ"
        fin = mot["fin_pos"]
        if fin[0] == "動詞" and fin[4] == "五段-ワア行" and fin[5].startswith(("終止形", "連体形")) \
                and lu.endswith("う"):
            return lu[:-1] + COUPURE + "う"
        return lu

    def transcrit(self, balise, phrase=None, gras=0) -> str:
        """`phrase` : capitaliser son debut et celui de chaque phrase (par
        defaut, s'il y a un point). `gras` : 1 si le texte commence dans du
        gras, pour savoir quel ** ouvre et lequel ferme. Un ** qui ouvre se
        colle au mot qui suit, un ** qui ferme a celui d'avant -- de meme pour
        les \\x02 qui bornent le trou d'une phrase a completer."""
        mots, marques = self._mots(balise)
        if phrase is None:
            phrase = bool(re.search(r"[。？！]", balise))
        compte = {"**": gras, "\x02": 0}
        sens = []                           # chaque marque : ouvre (True) ou ferme
        for _, m in marques:
            sens.append(compte[m] % 2 == 0)
            compte[m] += 1
        joints = [self._joint(avant, mot) if k else "" for k, (avant, mot) in enumerate(zip([None] + mots, mots))]
        kanas = [self._kana(mot) for mot in mots]
        sortie, majuscule = "", phrase
        for k, mot in enumerate(mots):
            ici = [(m, o) for (d, m), o in zip(marques, sens) if d == mot["s"]]
            sortie += "".join(m for m, o in ici if not o) + joints[k] + "".join(m for m, o in ici if o)
            colle = k + 1 < len(mots) and joints[k + 1] == ""
            r = kana_en_romaji(kanas[k], kanas[k + 1] if colle else "")
            for d, m in marques:
                if mot["s"] < d < mot["e"]:
                    r = r.replace(_TENU, m, 1)
            if mot["pos"][1] == "固有名詞" or (majuscule and re.search(r"[a-z]", r)):
                r = re.sub(r"[a-zāīūēō]", lambda x: x.group().upper(), r, count=1)
                majuscule = False
            if phrase and mot["t"] in ("。", "？", "！"):
                majuscule = True
            sortie += r
        fin = len(surface(balise.replace("**", "").replace("\x02", "")))
        return sortie + "".join(m for d, m in marques if d >= fin)

    def fragments(self, texte, sortie) -> None:
        """Le japonais glisse dans un texte en francais, chaque morceau vers sa
        transcription -- la page les remplace un a un (voir texteHtml dans
        nihongo.js)."""
        for m in FRAGMENT_JAPONAIS.finditer(texte or ""):
            if m.group() not in sortie:
                sortie[m.group()] = self.transcrit(m.group(), gras=texte[:m.start()].count("**") % 2)

    def exemple(self, ex) -> dict:
        """Une phrase a trou : avant, le trou, apres -- chacun avec ses espaces,
        les morceaux mis bout a bout font la phrase. Et ce que montre le trou,
        les autres reponses justes."""
        a, t, p = self.transcrit(f"{ex['a']}\x02{ex['t']}\x02{ex['p']}", phrase=True).split("\x02")
        sortie = {"a": a, "t": t, "p": p}
        if ex.get("i"):
            sortie["i"] = self.transcrit(ex["i"], phrase=False)
        if len(ex["r"]) > 1:
            sortie["r"] = [self.transcrit(f"{ex['a']}\x02{r}\x02{ex['p']}", phrase=True).split("\x02")[1].strip()
                           for r in ex["r"][1:]]
        return sortie


def construit_romaji(grammaire, lecture) -> dict:
    """static/nihongo/romaji.json : le japonais de la grammaire et des
    textes qui n'est pas decoupe en mots (voir plus haut). « fragments » :
    chaque morceau de japonais d'un texte en francais, d'un titre, d'un
    motif ; « phrases » : chaque phrase a trou, par le nom de son son."""
    r = Romaniseur()
    fragments, phrases = {}, {}
    for c in grammaire["chapitres"]:
        r.fragments(c["nom"], fragments)
        r.fragments(c.get("intro", ""), fragments)
    for point in grammaire["points"]:
        for texte in (point["titre"], point["sens"], *point["formes"]):
            r.fragments(texte, fragments)
        for b in point["texte"]:
            for texte in [b.get("p"), b.get("note"), *b.get("l", []), *(c for l in b.get("t", []) for c in l)]:
                r.fragments(texte, fragments)
        for ex in point["ex"]:
            phrases[ex["son"]] = r.exemple(ex)
    for t in lecture["textes"]:
        for texte in (t["titre"], t["intro"]):
            r.fragments(texte, fragments)
        for q in t["q"]:
            for texte in (q["q"], *q["c"]):
                r.fragments(texte, fragments)
        for par in t["p"]:
            for ph in par:
                r.fragments(ph.get("qui"), fragments)
    for pa in lecture["particules"].values():
        r.fragments(pa["fr"], fragments)
    return {"fragments": dict(sorted(fragments.items())), "phrases": phrases}


def ecrit_matiere(dossier=None) -> list:
    """Refait tous les fichiers de static/nihongo/ qui viennent des sources."""
    dossier = Path(dossier or STATIQUE)
    ecrits = []
    kana = extrait(catalogue(), kanas())
    manquants = [c for c in kanas() if c not in kana]
    if manquants:
        raise SystemExit(f"KanjiVG ne trace pas : {''.join(manquants)}")
    ecrits.append(_ecrit(dossier / "traces-kana.json", {
        "source": ATTRIBUTION, "taille": 109,
        "traces": {c: v["traits"] for c, v in kana.items()}}))

    vocabulaire = construit_vocabulaire()
    ecrits.append(_ecrit(dossier / "vocabulaire.json", {
        "source": "Listes du JLPT de Jonathan Waller (CC BY), rattachees a JMdict par "
                  "yomitan-jlpt-vocab (CC BY-SA 4.0) ; JMdict (EDRDG, CC BY-SA 4.0)",
        "mots": vocabulaire}))

    try:
        grammaire = construit_grammaire()
    except ErreurGrammaire as e:
        raise SystemExit(f"Grammaire : {e}") from None
    ecrits.append(_ecrit(dossier / "grammaire.json", {
        "source": "Ecrite pour Nihongo (matiere/grammaire-n5.txt a grammaire-n1.txt)",
        **grammaire}))

    try:
        lecture = construit_lecture(vocabulaire=vocabulaire,
                                    points=[p["nom"] for p in grammaire["points"]])
    except ErreurLecture as e:
        raise SystemExit(f"Lecture : {e}") from None
    ecrits.append(_ecrit(dossier / "lecture.json", {
        "source": "Ecrite pour Nihongo (matiere/lecture-n5.txt a lecture-n1.txt), "
                  "decoupee en mots par SudachiPy (Apache 2.0)",
        **lecture}))

    ecrits.append(_ecrit(dossier / "romaji.json", {
        "source": "Transcrit pour Nihongo, decoupe en mots par SudachiPy (Apache 2.0)",
        **construit_romaji(grammaire, lecture)}))

    traduits ={(m["m"], l): m["fr"] for m in vocabulaire if m["fr"] for l in m["l"][:1]}
    liste, traces = construit_kanjis(traduits)
    ecrits.append(_ecrit(dossier / "kanji.json", {
        "source": "KANJIDIC2 et JMdict (EDRDG, CC BY-SA 4.0), niveaux JLPT de "
                  "Jonathan Waller (via kanji-data, MIT), traductions de jmdict-simplified",
        "kanji": liste}))
    for n, t in sorted(traces.items(), reverse=True):
        ecrits.append(_ecrit(dossier / f"traces-kanji-n{n}.json",
                             {"source": ATTRIBUTION, "taille": 109, "traces": t}))
    return ecrits


# --------------------------------------------------------------------------
#   La voix (VOICEVOX Nemo)
# --------------------------------------------------------------------------
# La synthese vocale du navigateur depend de l'appareil : passable sur un
# telephone, robotique sur bien des ordinateurs, absente sur un Firefox de
# Linux. Les sons sont donc fabriques ici, une fois, par VOICEVOX -- le
# meilleur moteur japonais libre, qui place l'accent de hauteur d'apres un
# vrai dictionnaire -- avec une voix de Nemo, la serie de voix « realistes »
# faite pour la narration plutot que pour l'anime. Libre d'usage, a
# condition de citer « VOICEVOX Nemo » (c'est fait en bas de page).
#
# Un fichier MP3 par son et par voix, sous static/nihongo/voix/<voix>/, au
# nom de ce qu'il dit : « あ.mp3 », « 毎日・まいにち.mp3 » -- le mot, puis sa
# lecture, parce que 一行 se lit いちぎょう ou いっこう selon le sens. La page
# calcule le meme nom (voir Voix dans nihongo.js), essaie la voix choisie,
# puis l'autre, puis celle de l'appareil si aucun fichier n'existe encore.
#
# Deux voix, au choix sur la page : une femme et un homme. Entendre plus
# d'une voix aide a reconnaitre un mot quel que soit celui qui le dit.
#
# Le moteur ne vit pas dans le serveur web : il pese 500 Mo en memoire et
# met plus d'une seconde par mot sur cette machine. Il s'installe a part :
#
#   venv/bin/pip install https://github.com/VOICEVOX/voicevox_core/releases/download/0.17.0/voicevox_core-0.17.0-cp310-abi3-manylinux_2_34_x86_64.whl soundfile
#   (dans donnees/nihongo/voicevox/, le telechargeur de la meme page)
#   ./download --only onnxruntime dict models --models-pattern n0.vvm -o .
#
# puis `nice venv/bin/python nihongo.py voix` fabrique ce qui manque : les
# kanas, puis niveau par niveau le vocabulaire, les mots d'exemple des
# kanjis, les phrases de la grammaire et celles des textes a lire, chaque
# niveau dans toutes les voix avant le suivant. Plus de 12 000 sons par voix, une seconde par mot et
# trois ou quatre par phrase : quatre heures par voix. `voix h3`
# n'en fait qu'une.
DOSSIER_VOICEVOX = DOSSIER_CACHE / "voicevox"
# Le dossier de chaque voix, et son numero de style dans VOICEVOX. La page
# porte la meme liste (VOIX dans static/nihongo/nihongo.js).
VOIX = {
    "f1": 10005,               # Nemo, voix feminine 1
    "h3": 10002,               # Nemo, voix masculine 3
}
VITESSE = 0.95                 # a peine ralentie : on apprend, mais pas au ralenti
# Ce que dit le bouton « Écouter » du choix de la voix, pour comparer.
PHRASE_ESSAI = "こんにちは。一緒に日本語を勉強しましょう。"


def cle_audio(texte, lecture=None) -> str:
    """Le nom du fichier d'un son. Meme regle que cleAudio dans nihongo.js."""
    return texte if not lecture or lecture == texte else f"{texte}・{lecture}"


def _kata(s) -> str:
    return re.sub(r"[ぁ-ゖ]", lambda m: chr(ord(m.group()) + 0x60), s)


_VOYELLES = {c: ligne[0] for ligne in (
    "アカサタナハマヤラワガザダバパァャ", "イキシチニヒミリギジヂビピィ",
    "ウクスツヌフムユルグズヅブプゥュヴ", "エケセテネヘメレゲゼデベペェ",
    "オコソトノホモヨロヲゴゾドボポォョ") for c in ligne}


def prononciation(s) -> str:
    """Une lecture telle qu'elle se dit, pour comparer celle du dictionnaire
    a celle du moteur : せんせい et センセー sont la meme chose, ou を et オ."""
    s = _kata(s).replace("ヲ", "オ").replace("ヅ", "ズ").replace("ヂ", "ジ")
    sortie = []
    for c in re.sub(r"[^ァ-ヺー]", "", s):          # sans le point médian ・
        v = _VOYELLES.get(sortie[-1]) if sortie else None
        if (c, v) in {("イ", "エ"), ("イ", "イ"), ("ウ", "オ"), ("ウ", "ウ"),
                      ("ア", "ア"), ("エ", "エ"), ("オ", "オ")}:
            c = "ー"
        if not (c == "ー" and sortie and sortie[-1] == "ー"):
            sortie.append(c)
    return "".join(sortie)


def groupes_de_sons() -> list:
    """[(nom, [(cle, texte a donner au moteur, lecture attendue)])] : les
    kanas, puis niveau par niveau du N5 au N1 le vocabulaire, les mots
    d'exemple des kanjis, les phrases de la grammaire et celles des textes
    a lire -- l'ordre ou on en aura besoin. Un kana est dit depuis son katakana : は tout seul, le
    moteur le lit « wa », comme la particule ; ハ, il le lit « ha »."""
    kanas_dits = []
    simples = [c for c in kanas() if c not in "ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶー"]
    yoon = [c + p for c in "きしちにひみりぎじびぴ" for p in "ゃゅょ"]
    for c in simples + yoon + [_kata(x) for x in yoon]:
        if c in "ゔヴ":
            continue
        kanas_dits.append((c, _kata(c), _kata(c)))
    groupes = [("kanas", kanas_dits)]
    vus = {cle for cle, *_ in kanas_dits}

    def lit(nom):
        chemin = STATIQUE / nom
        return json.loads(chemin.read_text(encoding="utf-8")) if chemin.is_file() else {}
    mots = lit("vocabulaire.json").get("mots", [])
    kanji = lit("kanji.json").get("kanji", [])
    points = lit("grammaire.json").get("points", [])
    textes = lit("lecture.json").get("textes", [])
    for n in (5, 4, 3, 2, 1):
        sons = []
        couples = [(m["m"], m["l"][0]) for m in mots if m["n"] == n]
        couples += [(mot, lecture) for x in kanji if x["n"] == n for mot, lecture, *_ in x["m"]]
        for mot, lecture in couples:
            cle = cle_audio(mot, lecture)
            if cle not in vus:
                vus.add(cle)
                sons.append((cle, mot, lecture))
        # une phrase s'appelle par son empreinte (p-1a2b3c4d5e) : son texte
        # ferait un nom de fichier trop long
        for ex in (ex for p in points if p["n"] == n for ex in p["ex"]):
            if ex["son"] not in vus:
                vus.add(ex["son"])
                phrase = ex["a"] + ex["t"] + ex["p"]
                sons.append((ex["son"], surface(phrase), lecture_de(phrase)))
        # les phrases des textes a lire, nommees de la meme facon : une
        # phrase deja dans la grammaire garde son son
        for ph in (ph for t in textes if t["n"] == n for par in t["p"] for ph in par):
            if ph["son"] not in vus:
                vus.add(ph["son"])
                balise = "".join(m if isinstance(m, str) else m["t"] for m in ph["m"])
                sons.append((ph["son"], surface(balise), lecture_de(balise)))
        groupes.append((f"N{n}", sons))
    return groupes


def sons_a_faire() -> list:
    """Tous les sons, a la suite : [(cle, texte, lecture)]."""
    return [s for _, sons in groupes_de_sons() for s in sons]


def synthetiseur():
    from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile
    lib = next((DOSSIER_VOICEVOX / "onnxruntime" / "lib").glob("libvoicevox_onnxruntime.so*"))
    dico = next((DOSSIER_VOICEVOX / "dict").glob("open_jtalk_dic_*"))
    syn = Synthesizer(Onnxruntime.load_once(filename=str(lib)), OpenJtalk(str(dico)),
                      cpu_num_threads=2)
    with VoiceModelFile.open(str(DOSSIER_VOICEVOX / "models" / "vvms" / "n0.vvm")) as modele:
        syn.load_voice_model(modele)
    return syn


def _comme_dit(s) -> str:
    """Une phrase telle qu'elle se dit. Ses furigana ecrivent les particules
    は et へ comme elles s'ecrivent, le moteur les dit ワ et エ : on confond
    ces sons partout, ce qui suffit a reconnaitre une mauvaise lecture."""
    return prononciation(_kata(s).replace("ハ", "ワ").replace("ヘ", "エ"))


def _requete(syn, style, texte, lecture, phrase=False):
    """La requete du moteur, avec la bonne lecture. Le moteur choisit seul
    entre les lectures d'un mot (七 : なな plutot que しち) : s'il ne dit pas
    celle du dictionnaire, on lui donne le mot en katakanas, qu'il lit tels
    quels. Meme chose quand il ne sait pas lire le mot du tout (舗 seul).

    Une phrase ne passe pas en katakanas : la particule は y deviendrait
    « ha ». Si le moteur lit mal un de ses kanjis, on lui redonne la phrase
    en kanas, qu'il decoupe lui-meme en mots ; et si ce n'est pas mieux,
    on garde sa lecture.
    -> (requete, lecture respectee ?)"""
    from voicevox_core import AnalyzeTextError
    lue = lambda q: "".join(m.text for ph in q.accent_phrases for m in ph.moras)
    if phrase:
        q = syn.create_audio_query(texte, style)
        if _comme_dit(lue(q)) != _comme_dit(lecture):
            en_kanas = syn.create_audio_query(lecture, style)
            if _comme_dit(lue(en_kanas)) == _comme_dit(lecture):
                q = en_kanas
        juste = _comme_dit(lue(q)) == _comme_dit(lecture)
    else:
        try:
            q = syn.create_audio_query(texte, style)
        except AnalyzeTextError:
            if not lecture:
                raise
            q = None
        if q is None or (lecture and prononciation(lue(q)) != prononciation(lecture)):
            q = syn.create_audio_query(_kata(lecture), style)
        juste = not lecture or prononciation(lue(q)) == prononciation(lecture)
    q.speed_scale = VITESSE
    q.pre_phoneme_length = 0.08    # un navigateur rogne parfois le debut
    q.post_phoneme_length = 0.15
    return q, juste


def ecrit_voix(voix="f1", dossier=None, sons=None, syn=None, journal=print) -> dict:
    """Fabrique les sons qui manquent pour une voix. Reprend ou il s'etait
    arrete : un fichier deja la n'est pas refait."""
    import io
    import time as chrono
    import soundfile
    style = VOIX[voix]
    dossier = Path(dossier or STATIQUE / "voix" / voix)
    dossier.mkdir(parents=True, exist_ok=True)
    sons = sons_a_faire() if sons is None else sons
    a_faire = [s for s in sons if not (dossier / f"{s[0]}.mp3").is_file()]
    bilan = {"faits": 0, "lectures_forcees": [], "echecs": [], "a_faire": len(a_faire)}
    if not a_faire:
        return bilan
    syn = syn or synthetiseur()
    debut = chrono.time()
    deja = {}                  # は et ハ se disent pareil : un seul passage
    for i, (cle, texte, lecture) in enumerate(a_faire, 1):
        provisoire = dossier / f".{cle}.mp3"
        if (texte, lecture) in deja and deja[(texte, lecture)].is_file():
            provisoire.write_bytes(deja[(texte, lecture)].read_bytes())
        else:
            try:
                q, juste = _requete(syn, style, texte, lecture,
                                    phrase=cle.startswith(PREFIXE_PHRASE))
                donnees, frequence = soundfile.read(io.BytesIO(syn.synthesis(q, style)))
            except Exception as e:     # un son de moins, pas deux heures perdues
                bilan["echecs"].append(cle)
                journal(f"  {voix} : {cle} impossible ({type(e).__name__})")
                continue
            if not juste:
                bilan["lectures_forcees"].append(cle)
            soundfile.write(provisoire, donnees, frequence, format="MP3", compression_level=0.4)
        provisoire.replace(dossier / f"{cle}.mp3")
        deja[(texte, lecture)] = dossier / f"{cle}.mp3"
        bilan["faits"] += 1
        if i % 100 == 0 or i == len(a_faire):
            reste = (chrono.time() - debut) / i * (len(a_faire) - i)
            journal(f"  {voix} : {i} / {len(a_faire)} sons, encore {reste / 60:.0f} min")
    return bilan


def ecrit_voix_toutes(voix=None, journal=print) -> None:
    """Toutes les voix, groupe apres groupe : les kanas dans chaque voix,
    puis le N5 dans chaque voix, etc. -- un niveau a toutes ses voix avant
    que le suivant commence. Et d'abord la phrase d'essai de chacune, pour
    que le choix de la voix marche tout de suite."""
    voix = voix or list(VOIX)
    syn = synthetiseur()
    for v in voix:
        ecrit_voix(v, sons=[(PHRASE_ESSAI, PHRASE_ESSAI, None)], syn=syn, journal=journal)
    for nom, sons in groupes_de_sons():
        for v in voix:
            bilan = ecrit_voix(v, sons=sons, syn=syn, journal=journal)
            if not bilan["a_faire"]:
                continue
            journal(f"{v} {nom} : {bilan['faits']} sons fabriques")
            if bilan["lectures_forcees"]:
                journal(f"{v} {nom} : le moteur n'a pas tenu la lecture du dictionnaire pour "
                        + " ".join(bilan["lectures_forcees"]))
            if bilan["echecs"]:
                journal(f"{v} {nom} : sans son (la voix de l'appareil prendra le relais) : "
                        + " ".join(bilan["echecs"]))


if __name__ == "__main__":
    if sys.argv[1:] == ["matiere"]:
        for chemin in ecrit_matiere():
            print(f"{chemin} : {chemin.stat().st_size // 1024} Ko")
    elif sys.argv[1:2] == ["voix"] and all(v in VOIX for v in sys.argv[2:]):
        ecrit_voix_toutes(sys.argv[2:] or None)
    else:
        print(f"usage : venv/bin/python nihongo.py matiere | voix [{' '.join(VOIX)}]")
