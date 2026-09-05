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
    "quiz": "Mini-Jeux / Quiz",
}

# Les projets qu'on ne propose qu'a l'administration : un projet pas encore
# ouvert ne doit pas se faire annoncer ici par la liste des suggestions
# alors que sa tuile, elle, ne s'affiche pas.
#
# Vide aujourd'hui, et c'est voulu. Le quiz y figurait tant que ses jeux
# n'etaient pas finis ; ils le sont, sa tuile est visible de tous et ses
# routes repondent aux visiteurs (voir quiz.py). L'y laisser revenait a
# refuser un rapport de bug sur la seule page ou l'on peut en trouver.
#
# Le mecanisme reste : le prochain projet en chantier s'ajoute ici, et
# static/suggestion.js porte la meme liste sous le nom `reserve`.
RESERVEES = ()

GENRES = ("suggestion", "bug")

# L'importance d'une ligne. 0 n'est pas un niveau mais son absence : une
# ligne que personne n'a encore jugee ne doit pas se faire passer pour la
# moins pressante, elle n'a simplement pas ete regardee.
PRIORITES = (0, 1, 2, 3)

# « [!2] » en tete de message. Relu depuis le fichier comme il y est ecrit :
# une importance posee a la main compte autant qu'un clic sur la page.
MOTIF_PRIORITE = re.compile(r"^\[!([123])\]\s*")

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


def _ligne_pour(pseudo, message, genre, priorite=0) -> str:
    """La ligne exacte qu'une suggestion produit dans le fichier.

    Un seul endroit la fabrique, parce que deux endroits doivent la
    reconnaitre : celui qui l'ecrit, et celui qui la retrouve pour dire
    « cette ligne-la vient du web, voila sa date et son auteur ».

    L'importance vient avant [Bug] : c'est ce qu'on cherche en premier en
    parcourant le fichier des yeux, savoir ce qui presse passe avant savoir
    ce qui est casse. Sans pseudo -- une ligne tapee a la main qui ne suit
    pas la forme -- il n'y a pas de « Pseudo - » a remettre devant.
    """
    texte = " ".join((message or "").split())
    debut = f"{pseudo} - " if pseudo else ""
    marque = f"[!{priorite}] " if priorite in (1, 2, 3) else ""
    return f"{debut}{marque}{'[Bug] ' if genre == 'bug' else ''}{texte}"


def _projet_de(titre):
    """Le titre d'une section vers l'identifiant de projet, ou None."""
    for cle, valeur in SECTIONS.items():
        if valeur == titre:
            return cle
    return None


def _detaille(texte):
    """« Pseudo - [!1] [Bug] Message » redecoupe, au mieux.

Une ligne ecrite a la main peut ne pas suivre la forme : elle reste
affichee telle quelle, sans auteur. Rien de ce que contient le fichier
ne doit disparaitre de la page -- c'est justement ce qui permet de ne
plus l'ouvrir a la main.

Les deux marques sont relues dans n'importe quel ordre, parce qu'une
main qui les tape ne se souviendra pas de celui qu'on a choisi ici.
"""
    pseudo, separateur, message = texte.partition(" - ")
    if not separateur:
        pseudo, message = None, texte
    priorite, genre = 0, "suggestion"
    for _ in range(2):
        if message.startswith("[Bug] "):
            genre, message = "bug", message[len("[Bug] "):]
            continue
        m = MOTIF_PRIORITE.match(message)
        if m:
            priorite = int(m.group(1))
            message = message[m.end():]
    return pseudo, message, genre, priorite
def _identite(texte):
    """La ligne debarrassee de son importance.

    C'est par la qu'une ligne du fichier et une ligne de la table se
    reconnaissent. L'importance en est exclue expres : elle change, et une
    ligne repassee de urgent a plus tard reste la meme ligne -- si elle
    entrait dans la comparaison, un simple changement de niveau ferait
    perdre a la ligne son auteur et sa date.
    """
    pseudo, message, genre, _priorite = _detaille(texte)
    return _ligne_pour(pseudo, message, genre)


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
        pseudo, message, genre, priorite = _detaille(texte)
        connue = connues.get((courante["projet"], _identite(texte)))
        courante["lignes"].append({
            "texte": texte,
            "pseudo": pseudo,
            "message": message,
            "genre": connue["genre"] if connue else genre,
            "priorite": priorite,
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


def repriorise_le_fichier(projet, texte, priorite):
    """Repose cette ligne exacte avec son nouveau niveau. La ligne obtenue,
    ou None si elle n'etait plus la.

    Meme recherche par texte que `retire_du_fichier`, et pour la meme
    raison : le fichier a pu etre edite a la main depuis l'affichage de la
    page, et un numero de ligne designerait alors celle du voisin.

    La ligne est reecrite a sa place et non deplacee : c'est la page qui
    met l'urgent en haut, le fichier garde l'ordre dans lequel les idees
    sont arrivees.
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
            pseudo, message, genre, _ = _detaille(ligne)
            lignes[i] = _ligne_pour(pseudo, message, genre, priorite)
            _ecrit(lignes)
            return lignes[i]
    return None


# --------------------------------------------------------------------------
#   Enregistrement
# --------------------------------------------------------------------------
def enregistre(u, projet, genre, message) -> int:
    projet = str(projet or "").strip()
    genre = str(genre or "suggestion").strip()
    message = str(message or "").strip()
    if projet not in SECTIONS or (projet in RESERVEES and not u["admin"]):
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
    identite = _identite(texte)
    with _verrou:
        trouvee = retire_du_fichier(projet, texte)
        c = cx()
        with c:
            for l in c.execute("SELECT * FROM suggestion WHERE projet = ?",
                               (projet,)).fetchall():
                if _ligne_pour(l["pseudo"], l["message"], l["genre"]) == identite:
                    c.execute("DELETE FROM suggestion WHERE id = ?", (l["id"],))
    # `trouvee` faux n'est pas une erreur : la ligne avait deja ete retiree
    # du fichier a la main, et la page va simplement se relire
    return reponse({"ok": True, "retiree": trouvee})


@blueprint_suggestions.post("/changement/priorite")
def priorite():
    """L'importance d'une ligne : 1 urgent, 2 important, 3 plus tard, 0 rien.

    Le fichier d'abord, la table ensuite, comme pour l'envoi : si la ligne
    n'est plus dans le fichier c'est qu'elle a ete traitee ou reecrite a la
    main, et il n'y a rien a classer. On renvoie la ligne telle qu'elle est
    maintenant, pour que la page continue a la designer par son texte exact
    sans avoir a tout recharger.
    """
    _admin_ou_refus()
    d = corps()
    projet = d.get("projet")
    texte = str(d.get("texte") or "")
    try:
        niveau = int(d.get("priorite"))
    except (TypeError, ValueError):
        niveau = -1
    if niveau not in PRIORITES:
        raise Refus("priorite", "Niveau d'importance inconnu.")
    if not texte:
        raise Refus("ligne", "Ligne introuvable.")

    identite = _identite(texte)
    with _verrou:
        neuve = repriorise_le_fichier(projet, texte, niveau)
        if neuve is None:
            raise Refus("ligne", "Cette ligne n'est plus dans le fichier.", 404)
        c = cx()
        with c:
            for l in c.execute("SELECT * FROM suggestion WHERE projet = ?",
                               (projet,)).fetchall():
                if _ligne_pour(l["pseudo"], l["message"], l["genre"]) == identite:
                    c.execute("UPDATE suggestion SET priorite = ? WHERE id = ?",
                              (niveau, l["id"]))
    return reponse({"ok": True, "texte": neuve})


@blueprint_suggestions.post("/changements/vus")
def vus():
    """« J'ai vu » : la pastille du bouton Suggestions repart de zero.

    Un POST, et non un effet de bord du GET qui liste les changements : une
    lecture ne doit rien ecrire. Un navigateur qui precharge l'adresse, ou
    un rechargement machinal, effacerait sinon la pastille sans que
    personne n'ait rien lu.

    On enregistre une date, pas un compteur remis a zero : ce qui arrivera
    apres elle sera neuf, et il n'y a rien a tenir a jour entre-temps.
    """
    u = _admin_ou_refus()
    c = cx()
    with c:
        c.execute("UPDATE utilisateur SET suggestions_vues_le = ? WHERE id = ?",
                  (maintenant(), u["id"]))
    return reponse({"ok": True})
