"""Le mail de la veille : un jeu de ta wishlist sort demain.

Une option du compte, eteinte par defaut (voir alertes_sortie dans
comptes.py). A minuit, heure de Paris, on cherche les jeux convoites dont la
date de sortie est le lendemain, et chaque personne qui a coche l'option
recoit UN mail qui les liste tous -- trois jeux le meme jour ne valent pas
trois mails.

Pas de cron ni de timer systemd : un fil d'execution dans le serveur, qui
dort jusqu'a minuit. Le site tourne dans un seul processus gunicorn (voir
app.py), donc un seul fil, donc un seul envoi. Ce qui est deja parti est
note dans la table alerte_sortie : un redemarrage juste apres minuit relance
l'envoi du jour sans rien envoyer deux fois.
"""

import os
import threading
import time
from datetime import datetime, timedelta, timezone
from html import escape
from zoneinfo import ZoneInfo

import comptes

PARIS = ZoneInfo("Europe/Paris")
PROJET = "jeux-videos"

# Le fil tourne hors de toute requete : pas de request.host_url pour
# composer les liens, d'ou l'adresse publique ecrite ici.
SITE = os.environ.get("ABYSS_URL_PUBLIQUE", "https://jokrem.fr").strip().rstrip("/")

# Un serveur relance dans cette fenetre apres minuit rattrape l'envoi du
# jour. Au-dela, un mail « sort demain » recu en plein apres-midi n'aurait
# plus grand sens, et c'est le prochain minuit qui s'en charge.
RATTRAPAGE_HEURES = 6

JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
        "août", "septembre", "octobre", "novembre", "décembre"]


def _date_fr(iso):
    """'2026-10-01' -> 'jeudi 1er octobre'."""
    d = datetime.strptime(iso, "%Y-%m-%d").date()
    jour = "1er" if d.day == 1 else str(d.day)
    return f"{JOURS[d.weekday()]} {jour} {MOIS[d.month - 1]}"


def a_prevenir(jour_iso) -> dict:
    """{utilisateur_id: (pseudo, email, [(jeu_id, nom), ...])} pour ce jour.

    Seulement les jeux encore en wishlist, dans le journal de quelqu'un qui
    a coche l'option et donne une adresse, et pas deja annonces pour cette
    date-la.
    """
    lignes = comptes.cx().execute(
        "SELECT u.id AS uid, u.pseudo, u.email, j.id AS jeu_id, j.nom"
        " FROM jeu j"
        " JOIN page p ON p.id = j.page_id"
        " JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE p.projet = ? AND j.periode = 'Wishlist' AND j.sortie = ?"
        "   AND u.alertes_sortie = 1 AND u.email IS NOT NULL AND u.email != ''"
        "   AND NOT EXISTS (SELECT 1 FROM alerte_sortie a"
        "                   WHERE a.utilisateur_id = u.id AND a.jeu_id = j.id"
        "                     AND a.sortie = j.sortie)"
        " ORDER BY u.id, j.nom COLLATE NOCASE",
        (PROJET, jour_iso)).fetchall()
    parts = {}
    for l in lignes:
        parts.setdefault(l["uid"], (l["pseudo"], l["email"], []))[2].append(
            (l["jeu_id"], l["nom"]))
    return parts


def _mail(pseudo, jeux, jour_iso):
    """(sujet, texte, html) pour une personne et ses jeux du lendemain."""
    quand = _date_fr(jour_iso)
    noms = [nom for _, nom in jeux]
    journal = f"{SITE}/archive/{pseudo}"
    profil = f"{SITE}/abyss/profil"
    if len(noms) == 1:
        sujet = f"« {noms[0]} » sort demain"
        annonce = f"Un jeu de ta wishlist sort demain ({quand}) :"
    else:
        sujet = f"{len(noms)} jeux de ta wishlist sortent demain"
        annonce = f"{len(noms)} jeux de ta wishlist sortent demain ({quand}) :"

    texte = (
        f"Bonjour {pseudo},\n\n"
        f"{annonce}\n"
        + "".join(f"- {nom}\n" for nom in noms)
        + f"\nTon journal : {journal}\n\n"
        "Tu reçois ce mail parce que tu as activé l'alerte de sortie dans les "
        f"paramètres de ton compte. Pour ne plus le recevoir : {profil}\n"
        "Abyss - jokrem.fr\n"
    )

    liste = "".join(
        f'<li style="margin:0 0 6px;font-size:15px"><b>{escape(nom)}</b></li>' for nom in noms)
    html = f"""<!doctype html>
<html lang="fr"><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2733">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:10px;padding:28px">
    <p style="margin:0 0 16px;font-size:15px">Bonjour {escape(pseudo)},</p>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5">{escape(annonce)}</p>
    <ul style="margin:0 0 22px;padding-left:20px">{liste}</ul>
    <p style="margin:0 0 22px">
      <a href="{escape(journal)}" style="display:inline-block;background:#2e6f96;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">Voir mon journal</a>
    </p>
    <p style="margin:0;font-size:13px;color:#5b6773">Tu reçois ce mail parce que tu as activé l'alerte de sortie dans les paramètres de ton compte.
      <a href="{escape(profil)}" style="color:#2e6f96">Ne plus recevoir ces mails</a></p>
  </div>
  <p style="text-align:center;font-size:12px;color:#8a95a1;margin:16px 0 0">Abyss - jokrem.fr</p>
</body></html>"""
    return sujet, texte, html


def envoie_alertes(jour_iso) -> int:
    """Envoie les alertes des jeux qui sortent ce jour-la. Rend le nombre de
    mails partis.

    Chaque personne est traitee a part : un envoi qui echoue n'empeche pas
    les autres, et seul ce qui est reellement parti est note -- l'echec sera
    retente au prochain passage du meme jour, s'il y en a un.
    """
    envoyes = 0
    for uid, (pseudo, email, jeux) in a_prevenir(jour_iso).items():
        sujet, texte, html = _mail(pseudo, jeux, jour_iso)
        try:
            comptes.envoie_mail(email, sujet, texte, html)
        except Exception as err:            # noqa: BLE001 - SMTP casse de mille facons
            print(f"alerte de sortie impossible pour {pseudo} : "
                  f"{type(err).__name__}: {err}", flush=True)
            continue
        c = comptes.cx()
        with c:
            c.executemany(
                "INSERT OR IGNORE INTO alerte_sortie(utilisateur_id, jeu_id, sortie, envoye_le)"
                " VALUES(?,?,?,?)",
                [(uid, jeu_id, jour_iso, comptes.maintenant()) for jeu_id, _ in jeux])
        envoyes += 1
    return envoyes


def _demain_a_paris():
    return (datetime.now(PARIS).date() + timedelta(days=1)).isoformat()


def _passage():
    try:
        n = envoie_alertes(_demain_a_paris())
        if n:
            print(f"alertes de sortie : {n} mail{'s' if n > 1 else ''} envoyé{'s' if n > 1 else ''}",
                  flush=True)
    except Exception as err:                # noqa: BLE001 - le fil ne doit jamais mourir
        print(f"alertes de sortie : {type(err).__name__}: {err}", flush=True)


def _boucle():
    # Relance dans les heures qui suivent minuit : on rattrape l'envoi du jour.
    if datetime.now(PARIS).hour < RATTRAPAGE_HEURES:
        _passage()
    while True:
        demain = datetime.now(PARIS).date() + timedelta(days=1)
        minuit = datetime(demain.year, demain.month, demain.day, tzinfo=PARIS)
        # Le calcul en UTC et non en heure de Paris : deux heures de Paris
        # se soustraient « a l'horloge murale », et la nuit d'un changement
        # d'heure l'attente serait fausse d'une heure. Le sommeil se fait par
        # tranches de cinq minutes pour la meme raison : une horloge corrigee
        # en cours de route ne decale jamais l'envoi de plus d'une tranche.
        while True:
            reste = (minuit.astimezone(timezone.utc)
                     - datetime.now(timezone.utc)).total_seconds()
            if reste <= 0:
                break
            time.sleep(min(reste, 300))
        _passage()


_LANCE = False


def lance() -> None:
    """Demarre le fil, une seule fois par processus.

    ABYSS_ALERTES=0 le coupe : c'est ce que font les tests, qui chargent
    l'application sans vouloir d'un fil qui enverrait des mails.
    """
    global _LANCE
    if _LANCE or os.environ.get("ABYSS_ALERTES", "1").strip().lower() in ("0", "non", "false"):
        return
    _LANCE = True
    threading.Thread(target=_boucle, name="alertes-sortie", daemon=True).start()
