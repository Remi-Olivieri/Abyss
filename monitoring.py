#!/usr/bin/env python3
"""Le monitoring du site : qui passe, ou, et combien.

Ce que ca compte, et ce que ca ne compte pas :

  - une ligne par (jour, visiteur, page), pas une par vue. Dix minutes sur
    la page d'un journal, c'est une ligne qui compte jusqu'a dix -- la
    table reste petite et les deux vraies questions (combien de monde
    aujourd'hui, qui est la maintenant) se lisent directement dedans ;
  - `visiteur` est une empreinte, pas une adresse. Elle est salee avec le
    jour ET un secret tire une fois pour toutes : rien dans la base ne
    permet de remonter a une adresse IP, et l'empreinte change chaque nuit.
    On peut donc compter les visiteurs d'une journee, jamais suivre
    quelqu'un d'un jour a l'autre. C'est une limite assumee, pas un oubli ;
  - seules les pages du site sont notees, par leur *regle de route* et non
    par leur adresse exacte. /archive/Jokrem et /archive/Ilarak comptent
    tous deux pour « /archive/<pseudo> » : la liste des pages reste courte
    et ne se remplit pas d'un pseudo par visiteur. L'API, les fichiers
    statiques, les redirections et les erreurs ne sont pas notes ;
  - un robot n'est pas un visiteur. Ceux qui se declarent (Googlebot, les
    apercus de lien) se reconnaissent a leur agent ; les autres se font
    passer pour un navigateur, et seul le battement de presence.js les
    trahit -- ils chargent la page sans jamais l'executer. Une visite n'est
    donc comptee qu'une fois ce battement arrive (voir confirme). Sans ce
    tri, /abyss voyait passer 1 400 « visiteurs » par mois pour dix comptes.

A cote de ces compteurs, deux tables disent qui est la et ce qu'il fait
(migration PRESENCE, voir comptes.py) :

  - `presence`, une ligne par visiteur : la page exacte ou il se trouve
    (/archive/Ilarak, et non la regle), son dernier geste, son appareil,
    l'heure de son arrivee. Elle bouge a chaque page chargee, a chaque appel
    a l'API, et au battement de static/commun/presence.js tant que l'onglet
    est visible -- sans lui, quelqu'un qui lit un journal dix minutes sans
    rien recharger disparaissait au bout de cinq ;
  - `activite`, l'historique des gestes des comptes connectes, gardes
    JOURS_ACTIVITE jours.

La regle de l'empreinte tient toujours pour qui n'a pas de compte : un
visiteur anonyme n'a dans `presence` que son empreinte du jour et un
appareil deduit de l'agent (« Telephone · Android · Firefox »), jamais son
adresse ni l'agent lui-meme, et rien dans `activite`. Un compte connecte,
lui, est nomme -- c'est toute la question « qui est la ».

Noter une visite ne doit jamais casser une page : tout est sous un
try/except large, et un echec passe en silence. Une statistique manquante
vaut mieux qu'une page blanche.
"""

from __future__ import annotations

import hashlib
import os
import re
import signal
import threading
import time
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import unquote

from flask import Blueprint, current_app, g, request

from comptes import (Refus, actuel, cx, depuis, echec, maintenant, par_identifiant,
                     reponse, url_avatar)

# « en ce moment » : cinq minutes. Assez pour qu'on ne disparaisse pas en
# lisant une fiche, assez court pour que le chiffre veuille encore dire
# quelque chose quand on le regarde.
FENETRE_PRESENCE = timedelta(minutes=5)

# Ce qu'on garde. Au-dela, une visite ne sert plus qu'a faire grossir la
# base : la courbe n'en montre que quinze jours, et personne ne remontera
# a l'automne dernier pour comparer.
JOURS_GARDES = 120
JOURS_COURBE = 15

# Une demi-heure sans le moindre signe de vie, et la visite suivante en est
# une nouvelle : son heure d'arrivee repart de zero. C'est aussi ce que la
# page montre sous « partis il y a peu ».
PAUSE_VISITE = timedelta(minutes=30)

# L'historique des gestes. Un mois suffit a repondre « qu'est-ce qu'il a
# fait la semaine derniere », et la page n'en montre que sept jours.
JOURS_ACTIVITE = 30
JOURS_FIL = 7

# Un signe de vie qui n'apporte rien de neuf -- ni page, ni geste -- n'est
# ecrit qu'une fois par tranche de vingt secondes et par visiteur. Le
# journal enchaine parfois dix appels pour un seul clic ; dix ecritures
# pour dire dix fois « il est encore la » ne disent rien de plus.
ECART_ECRITURE = 20

# Les pages du site, et leur nom en clair. La cle est la regle de route
# telle que Flask la connait ; une page absente d'ici n'est pas notee --
# c'est ce qui tient la liste courte et previsible, plutot que d'y voir
# arriver un jour /static/archive/Cover/machin.webp.
PAGES = {
    "/abyss": "Abyss",
    "/abyss/profil": "Profil",
    "/abyss/suggestions": "Suggestions",
    "/abyss/monitoring": "Monitoring",
    "/archive": "Jeux Vidéos",
    "/archive/<pseudo>": "Jeux Vidéos - journal partagé",
    "/archive/feed": "Social",
    "/collection": "Collection Yu-Gi-Oh!",
    "/collection/<pseudo>": "Collection Yu-Gi-Oh! - classeur partagé",
    "/quiz": "Mini-Jeux / Quiz",
    "/chainz": "L'Atelier Chainz",
    "/nihongo": "Nihongo",
    "/nihongo/<rubrique>": "Nihongo",
    "/yugiquiz": "Yu-Gi-Quiz",
    "/yugiquiz/jeu/<room_id>": "Yu-Gi-Quiz - partie",
}

blueprint_monitoring = Blueprint("monitoring", __name__, url_prefix="/api")


# --------------------------------------------------------------------------
#   Noter une visite
# --------------------------------------------------------------------------
_SEL = None


def _sel() -> str:
    """Le secret qui sale les empreintes. Ecrit une fois par la migration.

    Lu une fois par processus : il ne change jamais, et chaque appel a
    l'API passe maintenant par ici -- une lecture en base a chaque fois
    pour relire la meme valeur ne servirait a rien.
    """
    global _SEL
    if _SEL is None:
        ligne = cx().execute(
            "SELECT valeur FROM reglage WHERE cle = 'sel_visites'").fetchone()
        _SEL = ligne["valeur"] if ligne else ""
    return _SEL


def empreinte(jour, u, adresse, agent) -> str:
    """L'identifiant anonyme d'un visiteur, pour aujourd'hui seulement.

    Le jour est dans l'entree, donc l'empreinte change a minuit : deux
    visites du meme ordinateur a un jour d'intervalle ne se ressemblent
    pas. C'est ce qui distingue un compteur de visiteurs d'un mouchard.

    Connecte, c'est le compte qui identifie le visiteur et non la machine.
    Deux personnes derriere la meme connexion familiale ne se confondent
    donc plus, et une meme personne sur son telephone puis son ordinateur
    compte pour une seule -- ce qui est la verite.

    Sinon, l'adresse et l'agent. L'agent accompagne l'adresse parce que
    deux appareils d'un meme foyer la partagent sans etre la meme personne.
    Ce n'est pas exact -- deux telephones identiques comptent pour un --
    mais c'est plus juste que l'adresse seule.

    Une reserve a connaitre : derriere un proxy, toutes les adresses valent
    127.0.0.1 tant qu'ABYSS_PROXY n'est pas active, et tous les visiteurs
    anonymes se confondent alors en un seul. Voir app.py, ProxyFix.
    """
    base = f"compte:{u['id']}" if u else f"{adresse}|{agent}"
    graine = f"{jour}|{base}|{_sel()}"
    return hashlib.blake2s(graine.encode("utf-8"), digest_size=16).hexdigest()


# ---------- l'appareil ----------
# Ce qui n'est pas quelqu'un : moteurs de recherche, apercus de lien des
# messageries, scripts. Ils restent notes dans `visite`, mais ne sont jamais
# confirmes (voir confirme) : ni visiteurs du jour, ni dans la liste de ceux
# qui sont la -- seulement dans le compte des passages ecartes.
ROBOTS = re.compile(r"bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|"
                    r"telegram|discord|embedly|curl|wget|python|httpx|go-http|"
                    r"java/|headless|monitor|uptime", re.I)
SYSTEMES = ((r"iPhone|iPad|iPod", "iOS"), (r"Android", "Android"),
            (r"Windows", "Windows"), (r"Macintosh|Mac OS X", "macOS"),
            (r"CrOS", "ChromeOS"), (r"Linux", "Linux"))
# L'ordre compte : Edge, Opera et Samsung se declarent aussi « Chrome », et
# Chrome se declare aussi « Safari ».
NAVIGATEURS = ((r"Edg(?:A|iOS)?/", "Edge"), (r"OPR/|Opera", "Opera"),
               (r"SamsungBrowser", "Samsung Internet"), (r"Firefox/|FxiOS/", "Firefox"),
               (r"Chrome/|CriOS/", "Chrome"), (r"Safari/", "Safari"))


def appareil(agent):
    """« Téléphone · Android · Firefox », ou None pour un robot.

    De quoi distinguer deux visiteurs anonymes l'un de l'autre, et savoir
    d'ou quelqu'un se connecte -- jamais l'agent lui-meme, qui est presque
    une empreinte a lui seul.
    """
    a = agent or ""
    if not a or ROBOTS.search(a):
        return None
    if re.search(r"iPad|Tablet", a) or ("Android" in a and "Mobile" not in a):
        genre = "Tablette"
    elif re.search(r"Mobi|iPhone|iPod", a):
        genre = "Téléphone"
    else:
        genre = "Ordinateur"
    systeme = next((nom for motif, nom in SYSTEMES if re.search(motif, a)), None)
    nav = next((nom for motif, nom in NAVIGATEURS if re.search(motif, a)), None)
    return " · ".join(x for x in (genre, systeme, nav) if x)


# ---------- les gestes ----------
# Ce qu'un appel a l'API veut dire, en clair. La cle est la methode et la
# regle de route, comme PAGES ; un appel absent d'ici garde la personne
# « presente » sans rien dire de ce qu'elle fait.
#
# Chaque geste : (genre, garde, phrase).
#   - genre : la famille, qui sert a la page a regrouper vingt cartes
#     rangees d'affilee en une seule ligne ;
#   - garde : True pour ce qui entre dans l'historique (une ecriture, une
#     connexion, une partie lancee). False pour une simple lecture -- ouvrir
#     une fiche dit ce que quelqu'un fait en ce moment, pas ce qu'il a fait
#     de sa semaine ;
#   - phrase : le verbe et son objet, sans sujet. Toujours avec « avoir » :
#     « a ouvert une session » plutot que « s'est connecte », qui
#     s'accorderait avec une personne dont on ne sait rien.
#
# Ce que la route va effacer ou changer est lu AVANT elle (voir avant()) :
# un jeu supprime n'a plus de nom apres coup, et un j'aime retire ne se
# distingue d'un j'aime pose que par ce qu'il y avait avant.
QUIZ = {
    "/api/quiz/jaquette-floue": "Jaquette floue",
    "/api/quiz/chronologie": "Chronologie",
    "/api/quiz/chronologie-sans-fin": "Chronologie sans fin",
    "/api/quiz/grille": "Grille de connexions",
}


def _titre(nom, defaut="un jeu") -> str:
    nom = " ".join(str(nom or "").split())[:80]
    return f"« {nom} »" if nom else defaut


def _de(cible, u) -> str:
    """« de Ilarak », ou rien quand le jeu est a celui qui agit."""
    p = (cible or {}).get("pseudo")
    if not p or (u is not None and p.lower() == u["pseudo"].lower()):
        return ""
    return f" de {p}"


def _sur(x) -> str:
    return f"{_titre(x.cible.get('nom'))}{_de(x.cible, x.u)}"


def _ajout_jeu(x):
    v = x.corps.get("values") or {}
    return f"a ajouté {_titre(v.get('name'))} ({x.corps.get('periode') or 'sans onglet'})"


def _modif_jeu(x):
    nom = _titre(x.cible.get("nom") or (x.corps.get("values") or {}).get("name"))
    vers = x.corps.get("periode")
    if vers and vers != x.cible.get("periode"):
        return f"a déplacé {nom} vers {vers}"
    return f"a modifié {nom}"


def _carte(x):
    nom = _titre(x.cible.get("nom"), "une carte")
    rarete = x.corps.get("rarete")
    if rarete:
        return f"a rangé {nom} ({rarete}) dans son classeur"
    return f"a retiré {nom} de son classeur"


def _aime(x, objet):
    verbe = "n'aime plus" if x.cible.get("aimait") else "a aimé"
    return f"{verbe} {objet}"


def _lot(x):
    n = len(x.corps.get("modifs") or [])
    return f"a modifié {n} jeu{'x' if n > 1 else ''} d'un coup"


GESTES = {
    # ---- le compte ----
    ("POST", "/api/connexion"):        ("compte", True, lambda x: "a ouvert une session"),
    ("POST", "/api/inscription"):      ("compte", True, lambda x: "a créé son compte"),
    ("POST", "/api/deconnexion"):      ("compte", True, lambda x: "a fermé sa session"),
    ("POST", "/api/compte/supprimer"): ("compte", True, lambda x: "a supprimé son compte"),
    ("POST", "/api/mot-de-passe"):     ("compte", True, lambda x: "a changé son mot de passe"),
    ("POST", "/api/email"):            ("compte", True, lambda x: "a changé son adresse e-mail"),
    ("POST", "/api/avatar"):           ("profil", True, lambda x: "a changé sa photo de profil"),
    ("DELETE", "/api/avatar"):         ("profil", True, lambda x: "a retiré sa photo de profil"),
    ("POST", "/api/banniere"):         ("profil", True, lambda x: "a changé sa bannière"),
    ("DELETE", "/api/banniere"):       ("profil", True, lambda x: "a retiré sa bannière"),
    ("PUT", "/api/couleur"):           ("profil", True, lambda x: "a changé de couleur"),
    ("PUT", "/api/preferences"):       ("profil", True, lambda x: "a choisi les projets affichés"),
    ("PUT", "/api/alertes-sortie"):    ("profil", True, lambda x:
        "a activé les alertes de sortie" if x.corps.get("actif") is True
        else "a coupé les alertes de sortie"),
    # ---- le journal ----
    ("POST", "/api/journal"):                     ("journal", True, lambda x: "a créé son journal"),
    ("POST", "/api/journal/jeu"):                 ("journal", True, _ajout_jeu),
    ("PUT", "/api/journal/jeu/<int:jeu_id>"):     ("journal", True, _modif_jeu),
    ("DELETE", "/api/journal/jeu/<int:jeu_id>"):  ("journal", True, lambda x:
        f"a retiré {_titre(x.cible.get('nom'))} de son journal"),
    ("PUT", "/api/journal/lot"):                  ("journal", True, _lot),
    ("PUT", "/api/journal/periode"):              ("journal", True, lambda x:
        f"a renommé l'onglet {_titre(x.corps.get('avant'), '?')}"
        f" en {_titre(x.corps.get('apres'), '?')}"),
    ("POST", "/api/journal/onglet-defaut"):       ("journal", True, lambda x:
        "a changé l'onglet ouvert par défaut"),
    ("GET", "/api/journal/jeu/<int:jeu_id>/detail"): ("lecture", False, lambda x:
        f"a ouvert la fiche de {_sur(x)}"),
    ("POST", "/api/jeu/detail"):   ("lecture", False, lambda x:
        f"a ouvert la fiche de {_titre(x.corps.get('nom'))}"),
    ("POST", "/api/decouverte"):   ("lecture", False, lambda x: "a cherché des jeux à découvrir"),
    ("POST", "/api/jeu/maj"):      ("journal", False, lambda x: "met son journal à jour depuis IGDB"),
    # ---- le social ----
    ("GET", "/api/social/feed"):               ("lecture", False, lambda x: "a ouvert le fil du Social"),
    ("GET", "/api/social/jeu/<int:jeu_id>"):   ("lecture", False, lambda x:
        f"a ouvert la discussion sur {_sur(x)}"),
    ("GET", "/api/social/avis"):               ("lecture", False, lambda x:
        f"a lu les avis sur {_titre(x.query.get('nom'))}"),
    ("POST", "/api/social/jeu/<int:jeu_id>/jaime"): ("social", True, lambda x: _aime(x, _sur(x))),
    ("POST", "/api/social/jeu/<int:jeu_id>/commentaire"): ("social", True, lambda x:
        f"a répondu sous {_sur(x)}" if x.corps.get("parent") else f"a commenté {_sur(x)}"),
    ("PATCH", "/api/social/commentaire/<int:commentaire_id>"): ("social", True, lambda x:
        f"a modifié un commentaire sous {_sur(x)}"),
    ("DELETE", "/api/social/commentaire/<int:commentaire_id>"): ("social", True, lambda x:
        f"a supprimé un commentaire sous {_sur(x)}"),
    ("POST", "/api/social/commentaire/<int:commentaire_id>/jaime"): ("social", True, lambda x:
        _aime(x, f"un commentaire sous {_sur(x)}")),
    # ---- le classeur ----
    ("POST", "/api/collection"):                       ("classeur", True, lambda x: "a créé son classeur"),
    ("PUT", "/api/collection/carte/<int:carte_id>"):   ("classeur", True, _carte),
    # ---- les mini-jeux ----
    **{("GET", regle): ("quiz", True, lambda x: f"a lancé une partie de {QUIZ[x.regle]}")
       for regle in QUIZ},
    ("POST", "/api/yugiquiz/connexion"): ("quiz", True, lambda x: "a rejoint le Yu-Gi-Quiz!"),
    # ---- le reste ----
    ("POST", "/api/suggestion"):       ("suggestion", True, lambda x: "a envoyé une suggestion"),
    ("POST", "/api/cartes/ecrire"):    ("admin", True, lambda x: "a mis à jour le stock de cartes"),
    ("PUT", "/api/journal/admin/lot"): ("admin", True, lambda x: "a corrigé des jeux du site"),
}

# Les routes de l'API qui servent des images : une page en demande des
# dizaines, et chacune aurait relu la session pour dire ce que la page
# elle-meme vient deja de dire. (Les vignettes du classeur, elles, sont hors
# de /api/ -- voir collection.URL_VIGNETTES.)
MUETTES = {
    "/api/yugiquiz/image/<room_id>/<jeton>",
    "/api/yugiquiz/image/<room_id>/<jeton>/pleine",
    "/api/apercu/<genre>/<pseudo>.jpg",  # demandee par les messageries, pas par une page
    "/api/presence",                     # il a sa propre route, voir battement()
}

# Ceux qui ouvrent ou ferment une session : la presence change de main.
OUVRENT = ("/api/connexion", "/api/inscription")
FERMENT = ("/api/deconnexion", "/api/compte/supprimer")


def _corps(requete) -> dict:
    d = requete.get_json(silent=True)
    return d if isinstance(d, dict) else {}


def _cible(args, u) -> dict:
    """Le jeu, le commentaire ou la carte que la route va toucher, tels
    qu'ils sont avant elle. {} si rien de tout cela."""
    c = cx()
    if "jeu_id" in args:
        l = c.execute(
            "SELECT j.nom, j.periode, u.pseudo FROM jeu j JOIN page p ON p.id = j.page_id"
            " JOIN utilisateur u ON u.id = p.utilisateur_id WHERE j.id = ?",
            (args["jeu_id"],)).fetchone()
        d = dict(l) if l else {}
        if u is not None:
            d["aimait"] = c.execute(
                "SELECT 1 FROM jaime WHERE jeu_id = ? AND utilisateur_id = ?",
                (args["jeu_id"], u["id"])).fetchone() is not None
        return d
    if "commentaire_id" in args:
        l = c.execute(
            "SELECT j.nom, u.pseudo FROM commentaire m JOIN jeu j ON j.id = m.jeu_id"
            " JOIN page p ON p.id = j.page_id JOIN utilisateur u ON u.id = p.utilisateur_id"
            " WHERE m.id = ?", (args["commentaire_id"],)).fetchone()
        d = dict(l) if l else {}
        if u is not None:
            d["aimait"] = c.execute(
                "SELECT 1 FROM jaime_commentaire WHERE commentaire_id = ? AND utilisateur_id = ?",
                (args["commentaire_id"], u["id"])).fetchone() is not None
        return d
    if "carte_id" in args:
        l = c.execute("SELECT nom FROM carte WHERE id = ?", (args["carte_id"],)).fetchone()
        return dict(l) if l else {}
    return {}


# ---------- l'adresse exacte ----------
def _regle_de(adresse):
    """(regle, arguments) de cette adresse, ou (None, {}) si rien n'y repond."""
    try:
        regle, args = current_app.url_map.bind("abyss").match(
            adresse, method="GET", return_rule=True)
        return regle.rule, args
    except Exception:                     # noqa: BLE001 - 404, redirection...
        return None, {}


def adresse_propre(adresse):
    """L'adresse d'une page du site, telle que la page la donne, ou None.

    Elle vient du navigateur : on n'en garde que le chemin, decode, et
    seulement s'il mene a une page de PAGES. N'importe quoi d'autre --
    une adresse inventee, un fichier, l'API -- est ignore.
    """
    if not isinstance(adresse, str) or not adresse.startswith("/") or len(adresse) > 300:
        return None
    adresse = unquote(adresse.split("?", 1)[0].split("#", 1)[0])
    adresse = adresse.rstrip("/") or "/"
    return adresse if _regle_de(adresse)[0] in PAGES else None


# ---------- noter ----------
_ECRITS = {}                # cle de presence -> derniere ecriture, en secondes
_MENAGE = [0.0]             # dernier menage fait en cours de route


def avant(requete) -> None:
    """Avant la route : qui agit, et sur quoi. Silencieuse, comme note().

    Qui, parce que la deconnexion et la suppression du compte ferment la
    session pendant la route : apres, `actuel()` ne saurait plus le dire.
    Il est donc resolu ici, et garde pour la requete.
    """
    try:
        regle = requete.url_rule.rule if requete.url_rule else ""
        if (requete.method, regle) not in GESTES:
            return
        g.monitoring_cible = _cible(requete.view_args or {}, actuel())
    except Exception:                     # noqa: BLE001 - jamais au prix d'une page
        pass


def note(requete, statut) -> None:
    """Note la visite, la presence et le geste. Silencieuse en cas de probleme.

    Les filtres passent avant `actuel()`, et c'est important : resoudre la
    session coute une lecture en base, et l'immense majorite des requetes
    d'une page sont des images et du CSS qui n'ont rien a compter. On ne
    paie donc cette lecture que pour les pages et l'API -- ou elle a presque
    toujours deja ete faite et mise de cote pour la requete.
    """
    try:
        regle = requete.url_rule.rule if requete.url_rule else ""
        page = requete.method == "GET" and regle in PAGES
        api = regle.startswith("/api/") and regle not in MUETTES
        if not (page or api) or statut >= 500:
            return
        u = actuel()
        geste = GESTES.get((requete.method, regle)) if 200 <= statut < 300 else None
        if geste and u is None and regle in OUVRENT:
            # la session vient de s'ouvrir : son cookie part avec la reponse,
            # la requete ne le portait pas encore
            u = par_identifiant(str(_corps(requete).get("pseudo") or ""))
        quand = maintenant()
        ip = requete.remote_addr or "?"
        agent = requete.headers.get("User-Agent", "")[:200]

        if page and statut == 200:
            _note_visite(u, quand, ip, agent, regle)

        texte = None
        if geste:
            genre, garde, phrase = geste
            x = SimpleNamespace(regle=regle, corps=_corps(requete), query=requete.args,
                                cible=g.get("monitoring_cible") or {}, u=u)
            texte = (phrase(x) or "")[:200] or None
            if garde and texte and u is not None:
                _note_geste(u, quand, appareil(agent), genre, texte)

        _note_presence(u, quand, ip, agent,
                       adresse=(requete.path.rstrip("/") or "/")
                       if page and statut == 200 else None,
                       action=texte,
                       ouvre=bool(texte) and regle in OUVRENT,
                       ferme=regle if texte and regle in FERMENT else None)
        _menage_en_route()
    except Exception:                     # noqa: BLE001 - jamais au prix d'une page
        pass


def _note_visite(u, quand, ip, agent, regle) -> None:
    jour = quand[:10]
    qui = empreinte(jour, u, ip, agent)
    c = cx()
    with c:
        # COALESCE sur utilisateur_id : on visite souvent une page en
        # visiteur avant de se connecter dans le meme onglet. La
        # deuxieme visite apporte le compte, la premiere ne doit pas
        # l'effacer -- et une deconnexion ne doit pas le retirer non
        # plus, la journee a bien vu passer ce compte.
        #
        # `humain` : d'emblee pour un compte connecte, une session ouverte
        # n'etant pas un robot. Sinon, ce que les autres pages du jour en
        # savent deja : un visiteur confirme ne l'est pas page par page. Et
        # 0 a defaut, en attendant le battement (voir confirme).
        c.execute(
            "INSERT INTO visite(jour, visiteur, chemin, utilisateur_id,"
            " vues, premier_le, dernier_le, humain)"
            " VALUES(:jour, :qui, :chemin, :uid, 1, :quand, :quand,"
            "   CASE WHEN :uid IS NOT NULL THEN 1 ELSE COALESCE("
            "     (SELECT MAX(humain) FROM visite WHERE jour = :jour AND visiteur = :qui),"
            "     0) END)"
            " ON CONFLICT(jour, visiteur, chemin) DO UPDATE SET"
            "   vues = vues + 1,"
            "   dernier_le = excluded.dernier_le,"
            "   utilisateur_id = COALESCE(excluded.utilisateur_id, utilisateur_id),"
            "   humain = MAX(COALESCE(humain, 0), excluded.humain)",
            {"jour": jour, "qui": qui, "chemin": regle,
             "uid": u["id"] if u else None, "quand": quand})


def confirme(u, quand, ip, agent) -> None:
    """Le battement est arrive : un navigateur est bien derriere ces visites.

    Toutes les pages du jour de ce visiteur, sous ses deux empreintes : celle
    du compte, et celle de la machine sans compte -- on visite souvent une
    page avant de se connecter, et cette visite-la etait deja la sienne.
    """
    if appareil(agent) is None:
        return                       # un robot qui execute la page reste un robot
    jour = quand[:10]
    c = cx()
    with c:
        c.execute("UPDATE visite SET humain = 1"
                  " WHERE jour = ? AND visiteur IN (?, ?) AND humain IS NOT 1",
                  (jour, empreinte(jour, u, ip, agent), empreinte(jour, None, ip, agent)))


def _note_geste(u, quand, app, genre, texte) -> None:
    c = cx()
    with c:
        # le sous-select plutot que l'identifiant tel quel : un compte qui
        # vient de se supprimer n'existe plus, et la ligne garde alors son
        # pseudo sans pointer vers rien
        c.execute(
            "INSERT INTO activite(quand, utilisateur_id, pseudo, appareil, genre, action)"
            " VALUES(?, (SELECT id FROM utilisateur WHERE id = ?), ?, ?, ?, ?)",
            (quand, u["id"], u["pseudo"], app, genre, texte))


def cle_presence(u, quand, ip, agent) -> str:
    """« compte:12 » pour un compte, qui garde sa ligne d'un jour a l'autre ;
    l'empreinte du jour pour un visiteur anonyme, comme dans `visite`."""
    return f"compte:{u['id']}" if u is not None else empreinte(quand[:10], None, ip, agent)


def _note_presence(u, quand, ip, agent, adresse=None, action=None,
                   ouvre=False, ferme=None) -> None:
    """Le signe de vie d'un visiteur : ou il est, ce qu'il vient de faire.

    `ouvre` : il vient de se connecter. La ligne anonyme de la meme machine
    lui revient -- c'etait lui une seconde plus tot, pas une personne de
    plus -- avec la page ou il etait et l'heure de son arrivee.
    `ferme` : la regle qui ferme sa session. Une deconnexion le marque
    parti ; un compte supprime n'a plus de ligne du tout.
    """
    app = appareil(agent)
    if app is None:
        return                                       # un robot
    cle = cle_presence(u, quand, ip, agent)
    c = cx()
    if ferme == "/api/compte/supprimer":
        with c:
            c.execute("DELETE FROM presence WHERE cle = ?", (cle,))
        return
    neuf = adresse or action or ouvre or ferme
    if not neuf and time.time() - _ECRITS.get(cle, 0) < ECART_ECRITURE:
        return
    arrive = quand
    with c:
        if ouvre:
            anonyme = empreinte(quand[:10], None, ip, agent)
            avant_lui = c.execute(
                "SELECT arrive_le, adresse FROM presence WHERE cle = ? AND vu_le >= ?",
                (anonyme, depuis(PAUSE_VISITE))).fetchone()
            c.execute("DELETE FROM presence WHERE cle = ?", (anonyme,))
            if avant_lui:
                arrive = avant_lui["arrive_le"]
                adresse = adresse or avant_lui["adresse"]
        # Une visite qui reprend apres une longue pause en est une nouvelle :
        # son heure d'arrivee repart. Une deconnexion ne la fait pas
        # repartir -- on se reconnecte souvent dans la minute.
        c.execute(
            "INSERT INTO presence(cle, utilisateur_id, appareil, arrive_le, vu_le,"
            " parti_le, adresse, action, action_le)"
            " VALUES(:cle, :uid, :app, :arrive, :quand, :parti, :adresse, :action, :action_le)"
            " ON CONFLICT(cle) DO UPDATE SET"
            "   utilisateur_id = excluded.utilisateur_id,"
            "   appareil = excluded.appareil,"
            "   arrive_le = CASE WHEN presence.vu_le < :pause"
            "               THEN excluded.arrive_le ELSE presence.arrive_le END,"
            "   vu_le = excluded.vu_le,"
            "   parti_le = excluded.parti_le,"
            "   adresse = COALESCE(excluded.adresse, presence.adresse),"
            "   action = COALESCE(excluded.action, presence.action),"
            "   action_le = COALESCE(excluded.action_le, presence.action_le)",
            {"cle": cle, "uid": u["id"] if u is not None else None, "app": app,
             "arrive": arrive, "quand": quand, "parti": quand if ferme else None,
             "adresse": adresse, "action": action, "action_le": quand if action else None,
             "pause": depuis(PAUSE_VISITE)})
    _ECRITS[cle] = time.time()


def note_battement(requete) -> None:
    """Le battement de static/commun/presence.js : { adresse, parti }.

    `parti` arrive quand l'onglet se ferme ou change de page. Il ne marque
    le depart que si la presence est encore sur CETTE page : en passant
    d'une page a l'autre, le battement de depart de la premiere peut
    arriver apres le chargement de la seconde, et ne doit pas l'effacer.

    Tout battement, depart compris, confirme les visites du jour : il vient
    d'une page qui s'est executee, ce qu'un robot ne fait pas.
    """
    d = _corps(requete)
    adresse = adresse_propre(d.get("adresse"))
    u = actuel()
    quand = maintenant()
    ip = requete.remote_addr or "?"
    agent = requete.headers.get("User-Agent", "")[:200]
    confirme(u, quand, ip, agent)
    if d.get("parti"):
        if adresse:
            c = cx()
            with c:
                c.execute("UPDATE presence SET parti_le = ?"
                          " WHERE cle = ? AND adresse = ? AND parti_le IS NULL",
                          (quand, cle_presence(u, quand, ip, agent), adresse))
        return
    _note_presence(u, quand, ip, agent, adresse=adresse)


def menage() -> None:
    """Oublie ce qui est trop vieux. Au demarrage, puis une fois par heure.

    Les lignes anonymes de `presence` portent l'empreinte d'un jour : passe
    minuit, plus aucune requete ne les retrouvera. Celles des comptes
    servent de « dernier geste » dans la liste des comptes, et vivent aussi
    longtemps que l'historique.
    """
    try:
        c = cx()
        with c:
            c.execute("DELETE FROM visite WHERE jour < ?",
                      (depuis(timedelta(days=JOURS_GARDES))[:10],))
            c.execute("DELETE FROM presence WHERE utilisateur_id IS NULL AND vu_le < ?",
                      (depuis(timedelta(days=1)),))
            c.execute("DELETE FROM presence WHERE vu_le < ?",
                      (depuis(timedelta(days=JOURS_ACTIVITE)),))
            c.execute("DELETE FROM activite WHERE quand < ?",
                      (depuis(timedelta(days=JOURS_ACTIVITE)),))
    except Exception:                     # noqa: BLE001 - la table peut manquer
        pass


def _menage_en_route() -> None:
    """Le site tourne des semaines sans redemarrer : le menage du demarrage
    ne suffit plus quand chaque visiteur anonyme laisse une ligne par jour."""
    if time.time() - _MENAGE[0] < 3600:
        return
    _MENAGE[0] = time.time()
    if len(_ECRITS) > 5000:
        _ECRITS.clear()
    menage()


# --------------------------------------------------------------------------
#   Lire les compteurs
# --------------------------------------------------------------------------
def _un(sql, args=()) -> int:
    ligne = cx().execute(sql, args).fetchone()
    return (ligne[0] or 0) if ligne else 0


def _jours_recents():
    """Les JOURS_COURBE derniers jours, du plus ancien au plus recent.

    Construits ici et non tires de la table : un jour sans personne n'y a
    aucune ligne, et une courbe qui saute les jours vides ferait passer un
    creux pour une continuite.
    """
    from datetime import datetime, timezone
    fin = datetime.now(timezone.utc).date()
    return [(fin - timedelta(days=i)).isoformat()
            for i in range(JOURS_COURBE - 1, -1, -1)]


def _meme(a, b) -> bool:
    return bool(a) and bool(b) and a.lower() == b.lower()


def lieu(adresse, pseudo=None):
    """« Journal de Ilarak » plutot que /archive/Ilarak. None sans adresse.

    `pseudo` est celui de la personne qui s'y trouve : chez elle, c'est
    « Son journal » -- le cas le plus courant, et le seul ou le nom du
    proprietaire n'apprendrait rien.
    """
    if not adresse:
        return None
    regle, args = _regle_de(adresse)
    proprio = args.get("pseudo")
    if regle == "/archive/<pseudo>" and proprio:
        return "Son journal" if _meme(proprio, pseudo) else f"Journal de {proprio}"
    if regle == "/collection/<pseudo>" and proprio:
        return "Son classeur" if _meme(proprio, pseudo) else f"Classeur de {proprio}"
    return PAGES.get(regle, adresse)


def _avatar(l):
    if not l["uid"]:
        return None
    return url_avatar({"id": l["uid"], "avatar": l["avatar"],
                       "avatar_maj_le": l["avatar_maj_le"]})


def presences() -> dict:
    """Ceux qui sont la, et ceux qui viennent de partir.

    Present : un signe de vie depuis moins de FENETRE_PRESENCE, et pas de
    depart signale. Parti : vu dans la derniere PAUSE_VISITE, mais plus
    depuis. Les comptes d'abord, puis les visiteurs anonymes, chacun du plus
    recemment vu au plus ancien.

    Un visiteur anonyme n'y figure qu'une fois sa visite confirmee : sans
    ca, chaque robot deguise en navigateur y passait cinq minutes. Sa cle
    de presence est l'empreinte du jour, la meme que dans `visite`, et une
    ligne anonyme ne vit qu'un jour -- d'ou le jour lu dans vu_le.
    """
    seuil = depuis(FENETRE_PRESENCE)
    lignes = cx().execute(
        "SELECT p.*, u.id AS uid, u.pseudo, u.admin, u.avatar, u.avatar_maj_le"
        " FROM presence p LEFT JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE p.vu_le >= ?"
        "   AND (u.id IS NOT NULL OR EXISTS ("
        "     SELECT 1 FROM visite v WHERE v.jour = substr(p.vu_le, 1, 10)"
        "       AND v.visiteur = p.cle AND v.humain = 1))"
        " ORDER BY (u.id IS NULL), p.vu_le DESC",
        (depuis(PAUSE_VISITE),)).fetchall()
    ici, partis = [], []
    for l in lignes:
        d = {"pseudo": l["pseudo"], "avatar": _avatar(l), "admin": bool(l["admin"]),
             "appareil": l["appareil"], "lieu": lieu(l["adresse"], l["pseudo"]),
             "adresse": l["adresse"], "action": l["action"], "action_le": l["action_le"],
             "arrive_le": l["arrive_le"], "vu_le": l["vu_le"], "parti_le": l["parti_le"]}
        (ici if l["vu_le"] >= seuil and not l["parti_le"] else partis).append(d)
    return {"ici": ici, "partis": partis}


def comptes_vus() -> list:
    """Chaque compte, du plus recemment vu au plus ancien.

    « Vu » : la derniere page chargee (gardee JOURS_GARDES jours) ou le
    dernier signe de vie, le plus recent des deux. Jours actifs et pages
    vues sur trente jours, les trois pages ou il passe le plus, son dernier
    geste, et s'il a encore une session ouverte quelque part. Un compte
    jamais vu reste dans la liste, en bas : « inscrit, jamais revenu » est
    aussi une reponse.
    """
    c = cx()
    debut = depuis(timedelta(days=30))[:10]
    favoris = {}
    for l in c.execute(
            "SELECT utilisateur_id, chemin, SUM(vues) AS n FROM visite"
            " WHERE utilisateur_id IS NOT NULL AND jour >= ?"
            " GROUP BY utilisateur_id, chemin ORDER BY n DESC", (debut,)):
        f = favoris.setdefault(l["utilisateur_id"], [])
        if len(f) < 3:
            f.append(PAGES.get(l["chemin"], l["chemin"]))
    sortie = []
    for l in c.execute(
            "SELECT u.id AS uid, u.pseudo, u.cree_le, u.admin, u.avatar, u.avatar_maj_le,"
            "  p.vu_le AS vu_presence, p.action, p.action_le, p.appareil, p.adresse,"
            "  (SELECT MAX(v.dernier_le) FROM visite v WHERE v.utilisateur_id = u.id) AS vu_page,"
            "  (SELECT COUNT(DISTINCT v.jour) FROM visite v"
            "     WHERE v.utilisateur_id = u.id AND v.jour >= :debut) AS jours,"
            "  (SELECT COALESCE(SUM(v.vues), 0) FROM visite v"
            "     WHERE v.utilisateur_id = u.id AND v.jour >= :debut) AS vues,"
            "  (SELECT COUNT(*) FROM session s"
            "     WHERE s.utilisateur_id = u.id AND s.expire_le > :mtn) AS sessions"
            " FROM utilisateur u LEFT JOIN presence p ON p.cle = 'compte:' || u.id",
            {"debut": debut, "mtn": maintenant()}):
        vu = max(filter(None, (l["vu_presence"], l["vu_page"])), default=None)
        sortie.append({
            "pseudo": l["pseudo"], "avatar": _avatar(l), "admin": bool(l["admin"]),
            "cree_le": l["cree_le"], "vu_le": vu, "jours": l["jours"], "vues": l["vues"],
            "sessions": l["sessions"], "favoris": favoris.get(l["uid"], []),
            "appareil": l["appareil"], "lieu": lieu(l["adresse"], l["pseudo"]),
            "action": l["action"], "action_le": l["action_le"]})
    sortie.sort(key=lambda d: d["vu_le"] or "", reverse=True)
    return sortie


def activite_recente(limite=400) -> list:
    """Les gestes des JOURS_FIL derniers jours, du plus recent au plus ancien.

    Le pseudo du moment s'il existe encore, celui recopie au moment du
    geste sinon -- d'ou `supprime`, que la page signale.
    """
    return [{"quand": l["quand"], "pseudo": l["pseudo_actuel"] or l["pseudo"],
             "supprime": l["pseudo_actuel"] is None, "appareil": l["appareil"],
             "genre": l["genre"], "action": l["action"]}
            for l in cx().execute(
                "SELECT a.*, u.pseudo AS pseudo_actuel FROM activite a"
                " LEFT JOIN utilisateur u ON u.id = a.utilisateur_id"
                " WHERE a.quand >= ? ORDER BY a.id DESC LIMIT ?",
                (depuis(timedelta(days=JOURS_FIL)), limite)).fetchall()]


def resume() -> dict:
    """Tout ce que la page de monitoring affiche, en une requete web."""
    c = cx()
    aujourdhui = maintenant()[:10]

    # ---- les comptes ----
    comptes = {
        "total": _un("SELECT COUNT(*) FROM utilisateur"),
        "semaine": _un("SELECT COUNT(*) FROM utilisateur WHERE cree_le >= ?",
                       (depuis(timedelta(days=7)),)),
        "mois": _un("SELECT COUNT(*) FROM utilisateur WHERE cree_le >= ?",
                    (depuis(timedelta(days=30)),)),
        "sessions": _un("SELECT COUNT(DISTINCT utilisateur_id) FROM session"
                        " WHERE expire_le > ?", (maintenant(),)),
    }

    # ---- en ce moment ----
    # Lu dans `presence` et non plus dans `visite` : une visite ne bouge
    # qu'au chargement d'une page, et le journal ou le classeur se lisent
    # des heures sans en recharger aucune.
    ici = presences()

    # ---- la courbe des jours ----
    # Seuls les visiteurs confirmes (1) comptent ; les 0 n'ont jamais donne
    # de battement -- robots, pour l'essentiel -- et ne sont que `ecartes`.
    # Les visites notees avant ce tri (NULL) ne disent pas qui etait
    # quelqu'un : la courbe ne commence qu'au premier jour qui n'en a plus
    # aucune, plutot que de mettre cote a cote deux chiffres qui ne se
    # comparent pas.
    avant_tri = c.execute("SELECT MAX(jour) FROM visite WHERE humain IS NULL").fetchone()[0]
    fenetre = [j for j in _jours_recents() if avant_tri is None or j > avant_tri]
    par_jour = {l["jour"]: l for l in c.execute(
        "SELECT jour,"
        "  COUNT(DISTINCT CASE WHEN humain = 1 THEN visiteur END) AS visiteurs,"
        "  SUM(CASE WHEN humain = 1 THEN vues ELSE 0 END) AS vues,"
        "  COUNT(DISTINCT CASE WHEN humain = 0 THEN visiteur END) AS ecartes"
        " FROM visite WHERE jour >= ? GROUP BY jour",
        (fenetre[0] if fenetre else aujourdhui,)).fetchall()}
    vide = {"visiteurs": 0, "vues": 0, "ecartes": 0}
    jours = [{"jour": j,
              "visiteurs": par_jour.get(j, vide)["visiteurs"],
              "vues": par_jour.get(j, vide)["vues"] or 0,
              "ecartes": par_jour.get(j, vide)["ecartes"]}
             for j in fenetre]

    # ---- les pages, sur la periode de la courbe ----
    pages = [{"chemin": l["chemin"], "nom": PAGES.get(l["chemin"], l["chemin"]),
              "visiteurs": l["visiteurs"], "vues": l["vues"] or 0}
             for l in c.execute(
                 "SELECT chemin, COUNT(DISTINCT visiteur) AS visiteurs,"
                 " SUM(vues) AS vues FROM visite WHERE jour >= ? AND humain = 1"
                 " GROUP BY chemin ORDER BY visiteurs DESC, vues DESC",
                 (fenetre[0] if fenetre else aujourdhui,)).fetchall()]

    # ---- ce que le site contient ----
    contenu = {
        "journaux": _un("SELECT COUNT(*) FROM page WHERE projet = 'jeux-videos'"),
        "publics": _un("SELECT COUNT(*) FROM page WHERE projet = 'jeux-videos'"
                       " AND visibilite = 'publique'"),
        "jeux": _un("SELECT COUNT(*) FROM jeu"),
        "suggestions": _un("SELECT COUNT(*) FROM suggestion"),
    }

    return {
        "ok": True,
        "comptes": comptes,
        # l'heure du serveur : la page compte ses « il y a deux minutes »
        # depuis elle, et non depuis une horloge locale qui peut avoir tort
        "heure": maintenant(),
        "maintenant": {"visiteurs": len(ici["ici"]),
                       "connectes": sum(1 for p in ici["ici"] if p["pseudo"]),
                       "presents": ici["ici"], "partis": ici["partis"],
                       "minutes": int(FENETRE_PRESENCE.total_seconds() // 60),
                       "pause": int(PAUSE_VISITE.total_seconds() // 60)},
        "comptes_vus": comptes_vus(),
        "activite": activite_recente(),
        "jours_activite": JOURS_FIL,
        "aujourdhui": {
            "visiteurs": jours[-1]["visiteurs"] if jours else 0,
            "vues": jours[-1]["vues"] if jours else 0,
            "ecartes": jours[-1]["ecartes"] if jours else 0,
            "jour": aujourdhui,
        },
        "jours": jours,
        "pages": pages,
        "contenu": contenu,
    }


# --------------------------------------------------------------------------
#   Route
# --------------------------------------------------------------------------
@blueprint_monitoring.errorhandler(Refus)
def _refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_monitoring.get("/monitoring")
def voir():
    """Les compteurs, pour l'administration seulement.

    404 et non 403, comme les suggestions : repondre « interdit »
    confirmerait que la route existe et qu'il y a quelque chose derriere.
    """
    u = actuel()
    if u is None or not u["admin"]:
        raise Refus("introuvable", "Page inconnue.", 404)
    return reponse(resume())


@blueprint_monitoring.post("/presence")
def battement():
    """Le battement de static/commun/presence.js. Voir note_battement.

    Ouvert a tout le monde, connecte ou non : c'est justement ce qui dit
    qu'un visiteur est encore la. Il ne renvoie rien qui vaille d'etre lu,
    et n'echoue jamais pour de vrai -- un battement perdu n'est pas une
    erreur a montrer, le suivant arrive dans une minute.
    """
    if (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    try:
        note_battement(request)
    except Exception:                     # noqa: BLE001 - jamais au prix d'une page
        pass
    return reponse({"ok": True})


# --------------------------------------------------------------------------
#   Redemarrer le site
# --------------------------------------------------------------------------
# systemd lance le service avec Restart=always et RestartSec=5 : il suffit que
# le processus maitre s'arrete pour qu'il reparte cinq secondes plus tard.
# C'est tout ce que fait ce bouton. Pas de sudo, pas de mot de passe tape dans
# une page web, pas de regle sudoers a tenir : ce que `systemctl restart
# abyss` ferait, l'unite le fait deja d'elle-meme.
#
# Le signal va au MAITRE et non au worker. Gunicorn tourne en deux processus :
# un maitre, qui est le MainPID du service, et un worker qui execute ce code.
# Arreter le worker ne redemarrerait rien -- le maitre en relancerait un
# aussitot et systemd n'aurait rien vu passer. C'est donc le parent qu'on vise.
#
# Deux controles avant d'envoyer quoi que ce soit, un SIGTERM au mauvais
# processus n'ayant pas de retour en arriere :
#
#   - le parent doit etre fils de systemd (PPid 1), ce qu'est le maitre ;
#   - son executable doit vraiment etre gunicorn.
#
# Le mot est cherche dans l'executable et dans les deux premiers arguments,
# jamais n'importe ou dans la ligne de commande : « gunicorn » peut figurer
# dans un chemin de travail sans que le parent soit gunicorn pour autant --
# c'est exactement ce qui m'a donne un faux positif en mettant ce controle au
# point.
#
# Lance a la main (`python app.py`), aucune des deux conditions n'est vraie :
# le parent est un terminal, et la route refuse en le disant. Mieux vaut un
# bouton inerte en developpement qu'un bouton qui ferme le terminal.
DELAI_REDEMARRAGE = 0.7


def _maitre():
    """Le processus a arreter pour que systemd relance le site.

    Rend (pid, "") si on l'a trouve, (None, raison) sinon.
    """
    parent = os.getppid()
    if parent <= 1:
        return None, "le site ne tourne pas sous gunicorn"
    try:
        with open(f"/proc/{parent}/status", encoding="utf-8") as f:
            grand_parent = next(
                (int(l.split()[1]) for l in f if l.startswith("PPid:")), -1)
        with open(f"/proc/{parent}/cmdline", "rb") as f:
            arguments = f.read().split(b"\0")
    except (OSError, ValueError, IndexError):
        return None, "processus parent illisible"
    noms = [a.decode("utf-8", "replace").rsplit("/", 1)[-1] for a in arguments[:2] if a]
    try:
        noms.append(os.path.realpath(f"/proc/{parent}/exe").rsplit("/", 1)[-1])
    except OSError:
        pass
    if grand_parent != 1 or "gunicorn" not in noms:
        return None, "le site ne tourne pas sous systemd"
    return parent, ""


@blueprint_monitoring.post("/monitoring/redemarrer")
def redemarrer():
    """Coupe le site ; systemd le relance. Pour l'administration seulement.

    La reponse part AVANT le signal : une fois le maitre arrete plus rien ne
    repond, et le navigateur n'aurait qu'une connexion coupee a montrer. Le
    fil laisse donc le temps a la reponse d'etre ecrite, puis signale.
    """
    u = actuel()
    if u is None or not u["admin"]:
        raise Refus("introuvable", "Page inconnue.", 404)
    if (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    maitre, raison = _maitre()
    if maitre is None:
        return echec("impossible", f"Redemarrage impossible : {raison}.", 409)

    def coupe():
        time.sleep(DELAI_REDEMARRAGE)
        os.kill(maitre, signal.SIGTERM)

    threading.Thread(target=coupe, daemon=True).start()
    return reponse({"ok": True, "secondes": 5})
