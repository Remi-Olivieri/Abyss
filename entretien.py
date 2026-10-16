"""L'analyse IGDB de toute la base, chaque nuit.

La mise a jour depuis IGDB (archive-igdb.js) interroge IGDB et Steam jeu par
jeu, depuis la page : sur toute la base, avec les jeux deja complets, c'est
une demi-heure a garder la fenetre ouverte. Ce module fait la meme analyse
sur le serveur, a minuit (heure de Paris), et garde le resultat dans
donnees/entretien-igdb.json. Le matin, la fenetre propose de relire ce
rapport : il ne reste qu'a verifier puis ecrire.

Rien n'est ecrit dans les journaux ici. Comme l'analyse de la page, c'est un
rapport ; l'ecriture reste un second geste, fait a la main apres relecture,
par la meme route d'administration (/api/journal/admin/lot).

Le rapport garde les reponses d'IGDB, pas les ecarts : c'est la page qui
les compare a la base telle qu'elle est quand on l'ouvre, avec le code de
l'analyse manuelle. Un jeu corrige a la main dans la matinee ne revient
donc pas, et rien n'est compare deux fois de deux facons differentes.

Une seule question par jeu : la meme fiche IGDB tenue dans trois journaux
ne coute qu'un passage. Les appels sont espaces au-dela de la cadence de
jaquettes.py, pour rester sous le plafond de Steam (environ 200 appels par
tranche de cinq minutes) sur des centaines de jeux d'affilee.

Meme mecanique qu'alertes.py et sauvegarde.py : pas de cron, un fil dans le
serveur, un seul processus gunicorn donc une seule analyse. Au demarrage, si
celle du jour manque, elle part tout de suite : un serveur relance dans la
journee ne saute pas une nuit.
"""

import json
import os
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import comptes
import jaquettes

PARIS = ZoneInfo("Europe/Paris")
HEURE = 0                     # minuit
PROJET = "jeux-videos"

# Entre deux jeux. Chaque jeu coute trois ou quatre appels a IGDB et un a
# Steam ; avec cette pause, Steam en recoit un toutes les deux ou trois
# secondes, sous son plafond. Sept cents jeux font une demi-heure : la nuit
# a le temps.
PAUSE = 1.0


def fichier() -> Path:
    """Le rapport, a cote de la base. Relu a chaque appel : les tests
    changent la base de place entre deux cas."""
    return Path(os.environ.get("ABYSS_ENTRETIEN_FICHIER")
                or comptes.CHEMIN.parent / "entretien-igdb.json")


# L'analyse en cours, pour que la fenetre puisse dire ou elle en est :
# {"debut": iso, "fait": n, "total": t}, ou None.
_EN_COURS = None
_VERROU = threading.Lock()


def _cle(jeu):
    """Sous quoi deux lignes ont la meme reponse d'IGDB.

    L'identifiant quand le jeu est rattache : /api/jeu/maj suit alors cette
    fiche, quel que soit le nom. Sinon le nom et la date connue -- c'est la
    date qui departage « Doom » de 1993 de celui de 2016.
    """
    if jeu["id_igdb"]:
        return ("id", jeu["id_igdb"])
    return ("nom", jaquettes.slug(jeu["nom"]), jeu["sortie"] or "")


def _signature(jeu, indice):
    """Ce que la page compare avant de se servir d'une reponse.

    Une ligne renommee ou rattachee depuis minuit n'est plus celle qu'on a
    analysee : la reponse ne la decrit peut-etre plus, et la page l'ecarte.
    """
    if jeu["id_igdb"]:
        return {"r": indice, "id_igdb": jeu["id_igdb"]}
    return {"r": indice, "nom": jeu["nom"], "sortie": jeu["sortie"] or ""}


def _allege(reponse):
    """Les propositions de jaquette ne servent qu'aux jeux qui n'en ont pas.

    Huit images par jeu, pour sept cents jeux qui en ont presque tous une,
    feraient un rapport dix fois plus lourd pour rien : la page ne les
    regarde que si la jaquette est absente.
    """
    if reponse.get("jaquette") != "absente":
        reponse.pop("propositions", None)
    return reponse


def analyse(dossier=None, pause=PAUSE) -> dict:
    """Interroge IGDB et Steam pour chaque jeu de la base, et ecrit le rapport.

    Les quatre volets de la fenetre a la fois -- dates, prix, fiche
    detaillee, jaquettes manquantes -- et sur tous les jeux, deja complets
    compris : c'est la nuit, et un prix ne se surveille qu'en le redemandant.
    Renvoie le rapport.
    """
    global _EN_COURS
    if not _VERROU.acquire(blocking=False):
        raise RuntimeError("une analyse est deja en cours")
    try:
        debut = datetime.now(PARIS)
        lignes = comptes.cx().execute(
            "SELECT j.id, j.nom, j.sortie, j.id_igdb FROM jeu j"
            " JOIN page p ON p.id = j.page_id"
            " WHERE p.projet = ? ORDER BY j.id", (PROJET,)).fetchall()
        par_cle = {}
        for jeu in lignes:
            par_cle.setdefault(_cle(jeu), []).append(jeu)
        _EN_COURS = {"debut": debut.isoformat(timespec="seconds"),
                     "fait": 0, "total": len(par_cle)}

        reponses, signatures = [], {}
        for jeux in par_cle.values():
            modele = jeux[0]
            try:
                reponse = jaquettes.rapport_maj(
                    modele["nom"], modele["sortie"], modele["id_igdb"],
                    veut_prix=True, veut_detail=True, jaquettes="manquantes",
                    dossier=dossier)
            except Exception as err:            # noqa: BLE001 - un jeu n'arrete pas la nuit
                reponse = {"etat": "injoignable",
                           "raison": f"{type(err).__name__}: {err}"[:160]}
            reponses.append(_allege(reponse))
            for jeu in jeux:
                signatures[str(jeu["id"])] = _signature(jeu, len(reponses) - 1)
            _EN_COURS["fait"] += 1
            if pause:
                time.sleep(pause)

        rapport = {
            "debut": debut.isoformat(timespec="seconds"),
            "fin": datetime.now(PARIS).isoformat(timespec="seconds"),
            "jeux": signatures,
            "reponses": reponses,
        }
        _ecrit(rapport)
        return rapport
    finally:
        _EN_COURS = None
        _VERROU.release()


def _ecrit(rapport) -> None:
    """Ecrit d'abord a cote, renomme a la fin : un serveur coupe en pleine
    ecriture ne laisse jamais un rapport tronque sous le bon nom."""
    cible = fichier()
    cible.parent.mkdir(parents=True, exist_ok=True)
    temporaire = cible.with_suffix(".partiel")
    temporaire.write_text(json.dumps(rapport, ensure_ascii=False, separators=(",", ":")),
                          encoding="utf-8")
    temporaire.replace(cible)


def rapport():
    """Le dernier rapport ecrit, ou None s'il n'y en a pas (ou qu'il est
    illisible : la fenetre proposera simplement l'analyse manuelle)."""
    try:
        return json.loads(fichier().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def etat() -> dict:
    """Ce que la fenetre affiche avant d'ouvrir le rapport : de quand il
    date, combien de jeux il couvre, et l'analyse en cours s'il y en a une.

    Sans les reponses : la fenetre lit cet etat a chaque ouverture, le
    rapport entier seulement quand on choisit de le relire.
    """
    dernier = rapport()
    resume = None
    if dernier:
        resume = {"debut": dernier.get("debut"), "fin": dernier.get("fin"),
                  "jeux": len(dernier.get("reponses") or [])}
    en_cours = dict(_EN_COURS) if _EN_COURS else None
    return {"rapport": resume, "en_cours": en_cours}


def _fait_aujourd_hui() -> bool:
    dernier = rapport()
    try:
        debut = datetime.fromisoformat(dernier["debut"]).astimezone(PARIS)
    except (TypeError, KeyError, ValueError):
        return False
    return debut.date() == datetime.now(PARIS).date()


def _passage(dossier):
    try:
        r = analyse(dossier)
        print(f"entretien IGDB : {len(r['reponses'])} jeux analysés", flush=True)
    except Exception as err:                # noqa: BLE001 - le fil ne doit jamais mourir
        print(f"entretien IGDB impossible : {type(err).__name__}: {err}", flush=True)
        traceback.print_exc()


def _boucle(dossier):
    if not _fait_aujourd_hui():
        _passage(dossier)
    while True:
        maintenant = datetime.now(PARIS)
        demain = maintenant.date() + timedelta(days=1)
        prochain = datetime(demain.year, demain.month, demain.day, HEURE, tzinfo=PARIS)
        # Meme prudence qu'alertes.py : attente calculee en UTC, sommeil par
        # tranches, pour qu'un changement d'heure ne decale rien.
        while True:
            reste = (prochain.astimezone(timezone.utc)
                     - datetime.now(timezone.utc)).total_seconds()
            if reste <= 0:
                break
            time.sleep(min(reste, 300))
        _passage(dossier)


_LANCE = False


def lance(dossier) -> None:
    """Demarre le fil, une seule fois par processus. `dossier` est celui des
    jaquettes : l'analyse regarde lesquelles manquent.

    ABYSS_ENTRETIEN=0 le coupe : c'est ce que font les tests.
    """
    global _LANCE
    if _LANCE or os.environ.get("ABYSS_ENTRETIEN", "1").strip().lower() in ("0", "non", "false"):
        return
    _LANCE = True
    threading.Thread(target=_boucle, args=(Path(dossier),), name="entretien-igdb",
                     daemon=True).start()
