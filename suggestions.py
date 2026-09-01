#!/usr/bin/env python3
"""Suggestions et rapports de bug.

Deux destinations pour une meme ecriture, et c'est voulu :

  - changements.txt, le fichier de travail. Une suggestion y arrive sous la
    forme « Pseudo - Message », rangee sous la section du projet concerne,
    exactement comme si elle avait ete tapee a la main. C'est ce fichier
    qu'on relit pour decider quoi faire ensuite, et il n'a aucune raison de
    changer de forme parce que la ligne vient du web.
  - la table `suggestion`, qui porte ce qu'un fichier texte ne sait pas
    dire : qui a ecrit la ligne, quand, et si c'est un bug ou une envie.

C'est le FICHIER qui fait autorite. La page d'administration l'affiche en
entier -- les lignes venues du web comme celles tapees a la main -- et la
table ne sert qu'a enrichir celles qu'elle reconnait, en les rapprochant
par leur texte exact. Le fichier peut donc etre reorganise a la main sans
rien casser, et « resolu » retire la ligne des deux cotes a la fois : il
n'y a jamais deux listes a tenir.
"""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path

from flask import Blueprint, request

from comptes import (ESSAIS_MAX, FENETRE_ESSAIS, Refus, actuel, corps, cx,
                     echec, maintenant, note_essai, reponse, trop_d_essais)

# ABYSS_CHANGEMENTS deplace le fichier, comme ABYSS_BASE deplace la base.
# Sans ca, un serveur lance sur une base de test ecrit quand meme dans le
# vrai changements.txt -- ce qui est arrive, et ce qui n'a rien d'evident
# tant qu'on n'a pas relu le fichier apres coup.
FICHIER = Path(os.environ.get(
    "ABYSS_CHANGEMENTS", Path(__file__).parent.resolve() / "changements.txt"))

# Les sections de changements.txt, dans l'ordre ou elles y apparaissent.
# La cle est ce que la page envoie, la valeur le titre exact de la section.
# Un projet absent d'ici est refuse : mieux vaut un refus net qu'une
# section inventee au milieu du fichier de quelqu'un.
SECTIONS = {
    "abyss": "Abyss",
    "jeux-videos": "Archive Jeux Vidéos",
    "collection": "Collection Yu-Gi-Oh!",
}

GENRES = ("suggestion", "bug")

MESSAGE_MAXI = 1000

# Un fichier, plusieurs requetes possibles en meme temps (gunicorn tourne
# avec huit fils) : sans ce verrou, deux envois simultanes reliraient tous
# les deux la version d'avant et le second effacerait le premier.
_verrou = threading.Lock()

MOTIF_SECTION = re.compile(r"^-{3,}\s*(.+?)\s*-{3,}\s*$")

blueprint_suggestions = Blueprint("suggestions", __name__, url_prefix="/api")


@blueprint_suggestions.before_request
def exige_json():
    """Meme parade CSRF qu'ailleurs : les ecritures sont en JSON."""
    if request.method in ("POST", "PUT", "PATCH") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    return None


# --------------------------------------------------------------------------
#   changements.txt
# --------------------------------------------------------------------------
def _lignes():
    try:
        return FICHIER.read_text(encoding="utf-8").split("\n")
    except OSError:
        return []


def _ecrit(lignes) -> None:
    """Ecrit a cote puis renomme : une coupure au mauvais moment laisserait
    sinon le fichier a moitie ecrit, et c'est le seul endroit ou vivent des
    idees que personne n'a notees ailleurs.
    """
    provisoire = FICHIER.with_name(FICHIER.name + ".neuf")
    provisoire.write_text("\n".join(lignes), encoding="utf-8")
    os.replace(provisoire, FICHIER)


def _fin_de_section(lignes, depart):
    """L'indice ou inserer dans la section qui commence a `depart`.

    Juste apres sa derniere ligne non vide : les lignes vides qui separent
    deux sections doivent rester entre elles, sinon le fichier se tasse un
    peu plus a chaque suggestion.
    """
    fin = len(lignes)
    for i in range(depart + 1, len(lignes)):
        if MOTIF_SECTION.match(lignes[i]):
            fin = i
            break
    while fin > depart + 1 and not lignes[fin - 1].strip():
        fin -= 1
    return fin


def ajoute_au_fichier(projet, pseudo, message, genre) -> None:
    """Range « Pseudo - Message » sous la bonne section.

    Un bug porte la marque [Bug] : la forme reste « Pseudo - Message », mais
    on voit d'un coup d'oeil, en relisant le fichier, ce qui est casse et ce
    qui est une envie.
    """
    titre = SECTIONS[projet]
    ligne = _ligne_pour(pseudo, message, genre)

    lignes = _lignes()
    depart = next((i for i, l in enumerate(lignes)
                   if (m := MOTIF_SECTION.match(l)) and m.group(1) == titre), None)
    if depart is None:
        # section absente : on la cree a la fin plutot que de refuser une
        # suggestion deja ecrite
        if lignes and lignes[-1].strip():
            lignes.append("")
        lignes += [f"----- {titre} -----", ligne, ""]
    else:
        lignes.insert(_fin_de_section(lignes, depart), ligne)
    _ecrit(lignes)


def _ligne_pour(pseudo, message, genre) -> str:
    """La ligne exacte qu'une suggestion produit dans le fichier.

    Un seul endroit la fabrique, parce que deux endroits doivent la
    reconnaitre : celui qui l'ecrit, et celui qui la retrouve pour dire
    « cette ligne-la vient du web, voila sa date et son auteur ».
    """
    texte = " ".join((message or "").split())
    return f"{pseudo} - {'[Bug] ' if genre == 'bug' else ''}{texte}"


def _projet_de(titre):
    """Le titre d'une section vers l'identifiant de projet, ou None."""
    for cle, valeur in SECTIONS.items():
        if valeur == titre:
            return cle
    return None


def _detaille(texte):
    """« Pseudo - Message » redecoupe, au mieux.

    Une ligne ecrite a la main peut ne pas suivre la forme : elle reste
    affichee telle quelle, sans auteur. Rien de ce que contient le fichier
    ne doit disparaitre de la page -- c'est justement ce qui permet de ne
    plus l'ouvrir a la main.
    """
    pseudo, separateur, message = texte.partition(" - ")
    if not separateur:
        return None, texte, "suggestion"
    genre = "bug" if message.startswith("[Bug] ") else "suggestion"
    if genre == "bug":
        message = message[len("[Bug] "):]
    return pseudo, message, genre


def lit_changements():
    """changements.txt tel qu'il est, section par section.

    C'est le fichier qui fait autorite, pas la table : il contient aussi
    les lignes ecrites a la main, qui n'ont jamais eu de suggestion
    derriere elles. La table ne sert qu'a enrichir celles qu'elle
    reconnait -- date, auteur, nature -- en les rapprochant par leur texte
    exact.
    """
    connues = {}
    try:
        for l in cx().execute("SELECT * FROM suggestion").fetchall():
            cle = (l["projet"], _ligne_pour(l["pseudo"], l["message"], l["genre"]))
            connues.setdefault(cle, l)
    except Exception:                     # noqa: BLE001 - la table peut manquer
        pass

    sections, courante = [], None
    for texte in _lignes():
        titre = MOTIF_SECTION.match(texte)
        if titre:
            courante = {"titre": titre.group(1), "projet": _projet_de(titre.group(1)),
                        "lignes": []}
            sections.append(courante)
            continue
        if not texte.strip():
            continue
        if courante is None:
            # des lignes avant la premiere section : elles existent, donc
            # elles s'affichent. Les taire reviendrait a obliger a rouvrir
            # le fichier pour savoir ce qu'il contient vraiment.
            courante = {"titre": "Sans section", "projet": None, "lignes": []}
            sections.append(courante)
        pseudo, message, genre = _detaille(texte)
        connue = connues.get((courante["projet"], texte))
        courante["lignes"].append({
            "texte": texte,
            "pseudo": pseudo,
            "message": message,
            "genre": connue["genre"] if connue else genre,
            "creeLe": connue["cree_le"] if connue else None,
            "duSite": connue is not None,
        })
    return sections


def retire_du_fichier(projet, texte) -> bool:
    """Retire cette ligne exacte de sa section. Vrai si elle y etait.

    On cherche par texte et non par numero de ligne : le fichier peut
    avoir ete edite a la main entre l'affichage de la page et le clic, et
    un numero designerait alors la ligne du voisin.
    """
    lignes = _lignes()
    titre = SECTIONS.get(projet)
    dans_la_bonne = titre is None            # sans section : tout le fichier
    for i, ligne in enumerate(lignes):
        m = MOTIF_SECTION.match(ligne)
        if m:
            dans_la_bonne = (m.group(1) == titre)
            continue
        if dans_la_bonne and ligne == texte:
            del lignes[i]
            _ecrit(lignes)
            return True
    return False


# --------------------------------------------------------------------------
#   Enregistrement
# --------------------------------------------------------------------------
def enregistre(u, projet, genre, message) -> int:
    projet = str(projet or "").strip()
    genre = str(genre or "suggestion").strip()
    message = str(message or "").strip()
    if projet not in SECTIONS:
        raise Refus("projet", "Choisis le projet concerné.")
    if genre not in GENRES:
        raise Refus("genre", "Suggestion ou bug, il faut choisir.")
    if not message:
        raise Refus("message", "Le message est vide.")
    if len(message) > MESSAGE_MAXI:
        raise Refus("message", f"Message trop long ({MESSAGE_MAXI} caractères maximum).")

    # le fichier d'abord : si l'ecriture echoue, rien n'est enregistre nulle
    # part et la personne le sait tout de suite. L'inverse laisserait une
    # ligne en base que le fichier ne montrerait jamais.
    with _verrou:
        ajoute_au_fichier(projet, u["pseudo"], message, genre)
        c = cx()
        with c:
            cur = c.execute(
                "INSERT INTO suggestion(utilisateur_id, pseudo, projet, genre,"
                " message, cree_le) VALUES(?,?,?,?,?,?)",
                (u["id"], u["pseudo"], projet, genre, message, maintenant()))
    return cur.lastrowid


# --------------------------------------------------------------------------
#   Routes
# --------------------------------------------------------------------------
def _connecte_ou_refus():
    u = actuel()
    if u is None:
        raise Refus("connexion", "Connecte-toi pour envoyer une suggestion.", 401)
    return u


def _admin_ou_refus():
    u = _connecte_ou_refus()
    # 404 et non 403 : repondre « interdit » confirmerait que la route
    # existe et qu'il y a quelque chose derriere.
    if not u["admin"]:
        raise Refus("introuvable", "Page inconnue.", 404)
    return u


@blueprint_suggestions.errorhandler(Refus)
def _refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_suggestions.post("/suggestion")
def envoyer():
    u = _connecte_ou_refus()
    # ESSAIS_MAX envois par FENETRE_ESSAIS et par compte : largement de quoi
    # vider son sac, jamais de quoi remplir changements.txt par accident.
    # Le compteur est celui des comptes, table `essai` -- une deuxieme
    # mecanique de limitation n'aurait rien appris de plus.
    cle = f"suggestion:{u['id']}"
    if trop_d_essais(cle):
        return echec("debit", f"Doucement : {ESSAIS_MAX} suggestions par"
                     f" {int(FENETRE_ESSAIS.total_seconds() // 60)} minutes, pas plus.", 429)
    note_essai(cle)
    d = corps()
    enregistre(u, d.get("projet"), d.get("genre"), d.get("message"))
    return reponse({"ok": True}, 201)


@blueprint_suggestions.get("/changements")
def changements():
    """Tout changements.txt, pret a afficher.

    Le fichier entier, et pas seulement ce qui est arrive par le web : les
    lignes ecrites a la main sont exactement celles qu'on veut aussi voir
    sur le site plutot que d'ouvrir un editeur.
    """
    _admin_ou_refus()
    return reponse({"ok": True, "sections": lit_changements()})


@blueprint_suggestions.post("/changement/resolu")
def resolu():
    """« C'est fait » : la ligne quitte le fichier et la table.

    Un seul geste pour les deux, parce qu'ils ne disaient pas deux choses
    differentes -- marquer traite d'un cote et rayer de l'autre laissait
    juste deux listes a tenir. Ce qui est fait disparait, point.

    Le verrou est le meme que pour l'ecriture : sans lui, une suppression
    et un envoi simultanes reliraient tous les deux la version d'avant.
    """
    _admin_ou_refus()
    d = corps()
    projet = d.get("projet")
    texte = str(d.get("texte") or "")
    if not texte:
        raise Refus("ligne", "Ligne introuvable.")
    with _verrou:
        trouvee = retire_du_fichier(projet, texte)
        c = cx()
        with c:
            for l in c.execute("SELECT * FROM suggestion WHERE projet = ?",
                               (projet,)).fetchall():
                if _ligne_pour(l["pseudo"], l["message"], l["genre"]) == texte:
                    c.execute("DELETE FROM suggestion WHERE id = ?", (l["id"],))
    # `trouvee` faux n'est pas une erreur : la ligne avait deja ete retiree
    # du fichier a la main, et la page va simplement se relire
    return reponse({"ok": True, "retiree": trouvee})
