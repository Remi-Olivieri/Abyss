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
    statiques, les redirections et les erreurs ne sont pas notes.

Noter une visite ne doit jamais casser une page : tout est sous un
try/except large, et un echec passe en silence. Une statistique manquante
vaut mieux qu'une page blanche.
"""

from __future__ import annotations

import hashlib
from datetime import timedelta

from flask import Blueprint, request

from comptes import Refus, actuel, cx, depuis, echec, maintenant, reponse

# « en ce moment » : cinq minutes. Assez pour qu'on ne disparaisse pas en
# lisant une fiche, assez court pour que le chiffre veuille encore dire
# quelque chose quand on le regarde.
FENETRE_PRESENCE = timedelta(minutes=5)

# Ce qu'on garde. Au-dela, une visite ne sert plus qu'a faire grossir la
# base : la courbe n'en montre que quinze jours, et personne ne remontera
# a l'automne dernier pour comparer.
JOURS_GARDES = 120
JOURS_COURBE = 15

# Les pages du site, et leur nom en clair. La cle est la regle de route
# telle que Flask la connait ; une page absente d'ici n'est pas notee --
# c'est ce qui tient la liste courte et previsible, plutot que d'y voir
# arriver un jour /static/Cover/machin.webp.
PAGES = {
    "/abyss": "Abyss",
    "/abyss/profil": "Profil",
    "/abyss/suggestions": "Suggestions",
    "/abyss/monitoring": "Monitoring",
    "/archive": "Jeux Vidéos",
    "/archive/<pseudo>": "Jeux Vidéos — journal partagé",
    "/collection": "Collection Yu-Gi-Oh!",
    "/quiz": "Mini-Jeux / Quiz",
    "/yugiquiz": "Yu-Gi-Quiz",
}

blueprint_monitoring = Blueprint("monitoring", __name__, url_prefix="/api")


# --------------------------------------------------------------------------
#   Noter une visite
# --------------------------------------------------------------------------
def _sel() -> str:
    """Le secret qui sale les empreintes. Ecrit une fois par la migration."""
    ligne = cx().execute(
        "SELECT valeur FROM reglage WHERE cle = 'sel_visites'").fetchone()
    return ligne["valeur"] if ligne else ""


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


def note(requete, statut) -> None:
    """Note la visite si c'en est une. Silencieuse en cas de probleme.

    Les filtres passent avant `actuel()`, et c'est important : resoudre la
    session coute une lecture en base, et l'immense majorite des requetes
    d'une page sont des images et du CSS qui n'ont rien a compter. On ne
    paie donc cette lecture que pour les quelques vraies pages -- ou elle
    a de toute facon deja ete faite et mise de cote pour la requete.
    """
    try:
        if requete.method != "GET" or statut != 200:
            return
        regle = requete.url_rule.rule if requete.url_rule else ""
        if regle not in PAGES:
            return
        u = actuel()
        quand = maintenant()
        jour = quand[:10]
        qui = empreinte(jour, u, requete.remote_addr or "?",
                        requete.headers.get("User-Agent", "")[:200])
        c = cx()
        with c:
            # COALESCE sur utilisateur_id : on visite souvent une page en
            # visiteur avant de se connecter dans le meme onglet. La
            # deuxieme visite apporte le compte, la premiere ne doit pas
            # l'effacer -- et une deconnexion ne doit pas le retirer non
            # plus, la journee a bien vu passer ce compte.
            c.execute(
                "INSERT INTO visite(jour, visiteur, chemin, utilisateur_id,"
                " vues, premier_le, dernier_le) VALUES(?,?,?,?,1,?,?)"
                " ON CONFLICT(jour, visiteur, chemin) DO UPDATE SET"
                "   vues = vues + 1,"
                "   dernier_le = excluded.dernier_le,"
                "   utilisateur_id = COALESCE(excluded.utilisateur_id, utilisateur_id)",
                (jour, qui, regle, u["id"] if u else None, quand, quand))
    except Exception:                     # noqa: BLE001 - jamais au prix d'une page
        pass


def menage() -> None:
    """Oublie les visites trop vieilles. Appele au demarrage."""
    try:
        c = cx()
        with c:
            c.execute("DELETE FROM visite WHERE jour < ?",
                      (depuis(timedelta(days=JOURS_GARDES))[:10],))
    except Exception:                     # noqa: BLE001 - la table peut manquer
        pass


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


def resume() -> dict:
    """Tout ce que la page de monitoring affiche, en une requete web."""
    c = cx()
    aujourdhui = maintenant()[:10]
    seuil = depuis(FENETRE_PRESENCE)

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
    presents = _un("SELECT COUNT(DISTINCT visiteur) FROM visite WHERE dernier_le >= ?",
                   (seuil,))
    connectes = [l["pseudo"] for l in c.execute(
        "SELECT DISTINCT u.pseudo FROM visite v JOIN utilisateur u"
        " ON u.id = v.utilisateur_id WHERE v.dernier_le >= ? ORDER BY u.pseudo",
        (seuil,)).fetchall()]
    ici = [{"chemin": l["chemin"], "nom": PAGES.get(l["chemin"], l["chemin"]),
            "visiteurs": l["n"]}
           for l in c.execute(
               "SELECT chemin, COUNT(DISTINCT visiteur) AS n FROM visite"
               " WHERE dernier_le >= ? GROUP BY chemin ORDER BY n DESC",
               (seuil,)).fetchall()]

    # ---- la courbe des jours ----
    par_jour = {l["jour"]: l for l in c.execute(
        "SELECT jour, COUNT(DISTINCT visiteur) AS visiteurs, SUM(vues) AS vues"
        " FROM visite WHERE jour >= ? GROUP BY jour",
        (_jours_recents()[0],)).fetchall()}
    jours = [{"jour": j,
              "visiteurs": par_jour[j]["visiteurs"] if j in par_jour else 0,
              "vues": (par_jour[j]["vues"] or 0) if j in par_jour else 0}
             for j in _jours_recents()]

    # ---- les pages, sur la periode de la courbe ----
    pages = [{"chemin": l["chemin"], "nom": PAGES.get(l["chemin"], l["chemin"]),
              "visiteurs": l["visiteurs"], "vues": l["vues"] or 0}
             for l in c.execute(
                 "SELECT chemin, COUNT(DISTINCT visiteur) AS visiteurs,"
                 " SUM(vues) AS vues FROM visite WHERE jour >= ?"
                 " GROUP BY chemin ORDER BY visiteurs DESC, vues DESC",
                 (_jours_recents()[0],)).fetchall()]

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
        "maintenant": {"visiteurs": presents, "connectes": connectes, "pages": ici,
                       "minutes": int(FENETRE_PRESENCE.total_seconds() // 60)},
        "aujourdhui": {
            "visiteurs": jours[-1]["visiteurs"] if jours else 0,
            "vues": jours[-1]["vues"] if jours else 0,
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
