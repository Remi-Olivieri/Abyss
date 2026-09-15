"""La copie de la base, chaque nuit.

Tout le site tient dans donnees/abyss.sqlite3 : les comptes, les journaux,
les classeurs, les commentaires. Un disque qui lache ou une fausse manoeuvre
et tout part d'un coup. Chaque nuit, a 4 h (heure de Paris), une copie est
posee dans donnees/sauvegardes/, et seules les GARDER plus recentes restent.

Meme mecanique qu'alertes.py : pas de cron, un fil dans le serveur. Un seul
processus gunicorn, donc un seul fil, donc une seule copie par nuit. Au
demarrage, si la copie du jour manque, elle est faite tout de suite : un
serveur relance a 5 h ne saute pas une nuit.

La copie passe par l'API de sauvegarde de SQLite et non par un copier-coller
du fichier : en mode WAL, une partie des ecritures recentes vit dans le
fichier -wal a cote, et un simple cp pendant une ecriture donnerait une base
incoherente. Connection.backup lit une image coherente, sans bloquer le site.

Ces copies restent sur la meme machine : elles protegent d'une erreur, pas
d'un disque mort. Pour ca, recopie de temps en temps donnees/sauvegardes/
ailleurs (rsync, rclone vers un stockage distant...).
"""

import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import comptes

PARIS = ZoneInfo("Europe/Paris")
HEURE = 4                     # la nuit, quand personne n'ecrit
GARDER = 14                   # deux semaines de copies

DOSSIER = Path(os.environ.get(
    "ABYSS_SAUVEGARDES_DOSSIER", comptes.CHEMIN.parent / "sauvegardes"))


def _nom(jour) -> str:
    return f"abyss-{jour.isoformat()}.sqlite3"


def sauvegarde(dossier=None, jour=None) -> Path:
    """Copie la base dans `dossier` sous le nom du jour, et fait le menage.

    Ecrit d'abord dans un fichier temporaire, renomme a la fin : une copie
    interrompue (serveur coupe en plein milieu) ne laisse jamais un fichier
    au bon nom mais a moitie ecrit.
    """
    dossier = Path(dossier or DOSSIER)
    jour = jour or datetime.now(PARIS).date()
    dossier.mkdir(parents=True, exist_ok=True)
    cible = dossier / _nom(jour)
    temporaire = cible.with_suffix(".partiel")
    temporaire.unlink(missing_ok=True)

    # Une connexion a part : ce fil n'est pas celui d'une requete, et
    # comptes.cx() en ouvrirait une qui ne serait jamais refermee.
    source = sqlite3.connect(comptes.CHEMIN, timeout=30)
    try:
        dest = sqlite3.connect(temporaire)
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()
    os.chmod(temporaire, 0o600)       # les empreintes de mots de passe sont dedans
    temporaire.replace(cible)
    menage(dossier)
    return cible


def menage(dossier=None, garder=GARDER) -> None:
    """Ne garde que les `garder` copies les plus recentes.

    Le nom porte la date au format AAAA-MM-JJ : l'ordre alphabetique est
    l'ordre chronologique.
    """
    dossier = Path(dossier or DOSSIER)
    copies = sorted(dossier.glob("abyss-*.sqlite3"))
    for vieille in copies[:-garder] if garder > 0 else copies:
        vieille.unlink(missing_ok=True)


def _passage():
    try:
        cible = sauvegarde()
        print(f"sauvegarde : {cible.name}", flush=True)
    except Exception as err:                # noqa: BLE001 - le fil ne doit jamais mourir
        print(f"sauvegarde impossible : {type(err).__name__}: {err}", flush=True)


def _boucle():
    if not (DOSSIER / _nom(datetime.now(PARIS).date())).exists():
        _passage()
    while True:
        maintenant = datetime.now(PARIS)
        prochain = datetime(maintenant.year, maintenant.month, maintenant.day,
                            HEURE, tzinfo=PARIS)
        if prochain <= maintenant:
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
        _passage()


_LANCE = False


def lance() -> None:
    """Demarre le fil, une seule fois par processus.

    ABYSS_SAUVEGARDES=0 le coupe : c'est ce que font les tests.
    """
    global _LANCE
    if _LANCE or os.environ.get("ABYSS_SAUVEGARDES", "1").strip().lower() in ("0", "non", "false"):
        return
    _LANCE = True
    threading.Thread(target=_boucle, name="sauvegarde", daemon=True).start()
