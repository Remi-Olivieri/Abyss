#!/usr/bin/env python3
"""Les comptes d'Abyss : base de donnees et routes web, dans un seul fichier.

C'est tout le systeme de connexion. app.py l'appelle deux fois et n'a rien
d'autre a en savoir :

    comptes.init()                                      # cree la base
    app.register_blueprint(comptes.blueprint_comptes)    # branche les routes

Ce que ca fait :
  - un compte = un pseudo + un mot de passe hache (scrypt, jamais en clair) ;
  - la connexion pose un cookie valable pour tout jokrem.fr. Abyss, le journal
    et le classeur etant servis par le meme Flask sur la meme origine, il n'y
    a rien a propager entre eux : le cookie part tout seul ;
  - l'inscription est libre, dans la limite d'INSCRIPTIONS_PAR_JOUR ;
  - chacun choisit les projets qu'il ne veut pas voir sur Abyss.

Les quatre tables tiennent dans donnees/abyss.sqlite3, hors des dossiers
publies : app.py ne sert que static/ et templates/.

Trois protections :
  - le cookie est HttpOnly (le JS ne peut pas le lire), SameSite=Lax, et
    Secure des que le site repond en HTTPS ;
  - toute ecriture exige `Content-Type: application/json`, ce qu'un formulaire
    poste depuis un autre site ne peut pas produire sans pre-vol CORS. C'est
    la parade CSRF, et elle remplace le jeton en URL d'avant ;
  - la connexion est limitee en debit, par IP et par pseudo vise.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Blueprint, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

# --------------------------------------------------------------------------
#   Reglages
# --------------------------------------------------------------------------
CHEMIN = Path(os.environ.get(
    "ABYSS_BASE", Path(__file__).parent.resolve() / "donnees" / "abyss.sqlite3"))

# Combien de comptes peuvent naitre par tranche de 24 h. Fenetre glissante et
# non remise a zero a minuit : aucun fuseau horaire a gerer, et pas d'heure
# fixe ou un robot n'aurait qu'a attendre pour rafler les places d'un coup.
# Baisse ce chiffre quand tes potes seront tous inscrits.
INSCRIPTIONS_PAR_JOUR = 20
FENETRE_INSCRIPTIONS = timedelta(hours=24)

# Les identifiants de projets masquables. Ils doivent correspondre aux `id`
# du tableau PROJETS dans Abyss.html.
PROJETS = ("jeux-videos", "collection", "chainz", "quiz")

# 3 a 20 caracteres, ni tiret ni souligne aux extremites : le pseudo finira
# dans une URL (/jeux-videos/jokrem), autant qu'il reste lisible.
MOTIF_PSEUDO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,18}[A-Za-z0-9]$")

# Ces mots occuperaient un segment d'URL deja pris : un compte nomme "api"
# rendrait /jeux-videos/api ambigu.
RESERVES = {
    "abyss", "admin", "api", "cartes", "collection", "compte", "connexion",
    "cover", "deconnexion", "inscription", "index", "jaquettes", "jeux-videos",
    "login", "moi", "quiz", "static", "templates", "www", "yugiquiz",
}

MDP_MINI = 8
MDP_MAXI = 200          # scrypt sur une entree enorme = deni de service gratuit

DUREE_SESSION = timedelta(days=30)       # « rester connecte »
DUREE_COURTE = timedelta(hours=12)       # sinon

FENETRE_ESSAIS = timedelta(minutes=15)
ESSAIS_MAX = 10

COOKIE = "abyss_session"
# En local sur http://127.0.0.1:8000, un cookie Secure ne serait jamais
# renvoye. On suit donc le protocole reellement vu, avec possibilite de
# forcer en production.
FORCE_SECURE = os.environ.get("ABYSS_COOKIE_SECURE", "").strip() in ("1", "oui", "true")


class Refus(Exception):
    """Erreur previsible, a montrer telle quelle a la personne."""

    def __init__(self, code, message, statut=400):
        super().__init__(message)
        self.code, self.message, self.statut = code, message, statut


# --------------------------------------------------------------------------
#   Base de donnees
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE utilisateur(
  id          INTEGER PRIMARY KEY,
  pseudo      TEXT NOT NULL,
  pseudo_norm TEXT NOT NULL UNIQUE,   -- minuscules : unicite insensible a la casse
  email       TEXT,
  empreinte   TEXT NOT NULL,
  cree_le     TEXT NOT NULL
);
CREATE INDEX idx_utilisateur_cree ON utilisateur(cree_le);

CREATE TABLE session(
  empreinte      TEXT PRIMARY KEY,     -- sha256 du jeton : la base volee ne donne pas les sessions
  utilisateur_id INTEGER NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  expire_le      TEXT NOT NULL
);

CREATE TABLE preference(
  utilisateur_id INTEGER NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  projet         TEXT NOT NULL,        -- present = masque
  PRIMARY KEY (utilisateur_id, projet)
);

CREATE TABLE essai(
  cle   TEXT NOT NULL,
  quand TEXT NOT NULL
);
CREATE INDEX idx_essai ON essai(cle, quand);
"""

# Migration 2 : les pages et leur contenu. Le journal (journal.py) se sert de
# ces tables mais ne les cree pas : tout le schema du site tient dans la liste
# MIGRATIONS ci-dessous, parce que PRAGMA user_version est un seul compteur
# pour toute la base. Deux fichiers qui migreraient chacun de leur cote se
# marcheraient dessus.
PAGES = """
-- Une page = le journal ou le classeur d'une personne. Le contenu s'accroche
-- a la page et non au compte : « creer ma page » devient un etat franc, et
-- supprimer une page ne touche pas au compte.
CREATE TABLE page(
  id             INTEGER PRIMARY KEY,
  utilisateur_id INTEGER NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  projet         TEXT NOT NULL,              -- 'jeux-videos' ou 'collection'
  titre          TEXT,                       -- « Journal de Jokrem »
  visibilite     TEXT NOT NULL DEFAULT 'publique',   -- ou 'privee'
  cree_le        TEXT NOT NULL,
  UNIQUE (utilisateur_id, projet)            -- une page par projet et par personne
);

CREATE TABLE jeu(
  id         INTEGER PRIMARY KEY,            -- remplace « onglet + numero de ligne »
  page_id    INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  periode    TEXT NOT NULL,                  -- '2026', 'En cours', 'Wishlist' : l'onglet
  nom        TEXT NOT NULL,
  annee      INTEGER,                        -- deduite de la periode quand c'est une annee
  mois       INTEGER,                        -- 1 a 12, mois de fin
  note       REAL,
  heures     REAL,                           -- 12.5 = 12 h 30
  prix_base  REAL,
  prix_paye  REAL,
  sortie     TEXT,                           -- 'AAAA-MM-JJ'
  avis       TEXT,                           -- lignes separees par des sauts de ligne
  rang       INTEGER NOT NULL DEFAULT 0,     -- ordre d'origine, sert d'egalite au tri
  cree_le    TEXT NOT NULL,
  maj_le     TEXT NOT NULL
);
CREATE INDEX idx_jeu_page ON jeu(page_id, periode, rang);
"""

MIGRATIONS = [SCHEMA, PAGES]

_local = threading.local()


def cx() -> sqlite3.Connection:
    """Une connexion par fil d'execution, gardee ouverte.

    Gunicorn reutilise ses fils : rouvrir le fichier a chaque requete serait
    du gaspillage, et sqlite3 interdit de partager une connexion entre fils.
    """
    c = getattr(_local, "cx", None)
    if c is None:
        CHEMIN.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(CHEMIN, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")   # un lecteur n'attend pas un ecrivain
        c.execute("PRAGMA foreign_keys=ON")    # supprimer un compte emporte ses sessions
        _local.cx = c
    return c


def init() -> None:
    """Cree ou complete la base. Sans effet si tout est deja en place.

    Le jour ou le schema change, ajoute un bloc SQL a la fin de MIGRATIONS
    sans jamais toucher aux precedents : PRAGMA user_version retient combien
    ont deja ete joues, et les bases existantes rattrapent leur retard toutes
    seules au prochain demarrage.
    """
    c = cx()
    faites = c.execute("PRAGMA user_version").fetchone()[0]
    for i in range(faites, len(MIGRATIONS)):
        c.executescript(MIGRATIONS[i])
        c.execute(f"PRAGMA user_version={i + 1}")
        c.commit()
    menage()


def ferme() -> None:
    """Ferme la connexion du fil courant. Sert aux tests."""
    c = getattr(_local, "cx", None)
    if c is not None:
        c.close()
        _local.cx = None


def maintenant() -> str:
    """Horodatage ISO en UTC. Comparable tel quel avec < et >."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def dans(duree) -> str:
    return (datetime.now(timezone.utc) + duree).isoformat(timespec="seconds")


def depuis(duree) -> str:
    return (datetime.now(timezone.utc) - duree).isoformat(timespec="seconds")


def menage() -> None:
    """Sessions expirees et vieux compteurs. Appele au demarrage."""
    c = cx()
    with c:
        c.execute("DELETE FROM session WHERE expire_le <= ?", (maintenant(),))
        c.execute("DELETE FROM essai WHERE quand < ?", (depuis(FENETRE_ESSAIS * 4),))


# --------------------------------------------------------------------------
#   Comptes
# --------------------------------------------------------------------------
def normalise(pseudo) -> str:
    return (pseudo or "").strip().lower()


def verifie_pseudo(pseudo) -> str:
    pseudo = (pseudo or "").strip()
    if not MOTIF_PSEUDO.match(pseudo):
        raise Refus("pseudo", "Le pseudo fait 3 a 20 caracteres : lettres, chiffres, "
                              "tiret ou souligne, sans tiret au debut ni a la fin.")
    if normalise(pseudo) in RESERVES:
        raise Refus("pseudo", "Ce pseudo est reserve par le site.")
    return pseudo


def verifie_mdp(mdp) -> str:
    mdp = mdp or ""
    if len(mdp) < MDP_MINI:
        raise Refus("mdp", f"Le mot de passe fait au moins {MDP_MINI} caracteres.")
    if len(mdp) > MDP_MAXI:
        raise Refus("mdp", f"Le mot de passe depasse {MDP_MAXI} caracteres.")
    return mdp


def par_pseudo(pseudo):
    return cx().execute("SELECT * FROM utilisateur WHERE pseudo_norm = ?",
                        (normalise(pseudo),)).fetchone()


def cree_compte(pseudo, mdp, email=None) -> int:
    pseudo = verifie_pseudo(pseudo)
    verifie_mdp(mdp)
    c = cx()
    try:
        with c:
            cur = c.execute(
                "INSERT INTO utilisateur(pseudo, pseudo_norm, email, empreinte, cree_le)"
                " VALUES(?,?,?,?,?)",
                (pseudo, normalise(pseudo), (email or "").strip() or None,
                 generate_password_hash(mdp), maintenant()))
    except sqlite3.IntegrityError:
        raise Refus("pseudo", "Ce pseudo est deja pris.", 409)
    return cur.lastrowid


# Empreinte d'un mot de passe bidon, verifiee quand le pseudo n'existe pas :
# sans elle, le temps de reponse dirait quels comptes existent.
_LEURRE = None


def identifiants_bons(pseudo, mdp):
    global _LEURRE
    u = par_pseudo(pseudo)
    if u is None:
        if _LEURRE is None:
            _LEURRE = generate_password_hash(secrets.token_urlsafe(16))
        check_password_hash(_LEURRE, mdp or "")
        return None
    return u if check_password_hash(u["empreinte"], mdp or "") else None


# --------------------------------------------------------------------------
#   Sessions
# --------------------------------------------------------------------------
def _empreinte(jeton) -> str:
    return hashlib.sha256(jeton.encode("utf-8")).hexdigest()


def ouvre_session(uid, memoriser=True) -> str:
    """Cree une session. Le jeton n'existe en clair qu'ici et dans le cookie."""
    jeton = secrets.token_urlsafe(32)
    c = cx()
    with c:
        c.execute("INSERT INTO session(empreinte, utilisateur_id, expire_le) VALUES(?,?,?)",
                  (_empreinte(jeton), uid,
                   dans(DUREE_SESSION if memoriser else DUREE_COURTE)))
    return jeton


def session_valide(jeton):
    """La ligne utilisateur si le jeton ouvre une session vivante, sinon None."""
    if not jeton:
        return None
    c = cx()
    ligne = c.execute(
        "SELECT s.expire_le, u.* FROM session s"
        " JOIN utilisateur u ON u.id = s.utilisateur_id WHERE s.empreinte = ?",
        (_empreinte(jeton),)).fetchone()
    if ligne is None:
        return None
    if ligne["expire_le"] <= maintenant():
        with c:
            c.execute("DELETE FROM session WHERE empreinte = ?", (_empreinte(jeton),))
        return None
    return ligne


def ferme_session(jeton) -> None:
    if jeton:
        c = cx()
        with c:
            c.execute("DELETE FROM session WHERE empreinte = ?", (_empreinte(jeton),))


def ferme_toutes(uid) -> None:
    c = cx()
    with c:
        c.execute("DELETE FROM session WHERE utilisateur_id = ?", (uid,))


# --------------------------------------------------------------------------
#   Quota d'inscription
# --------------------------------------------------------------------------
def inscriptions_recentes() -> int:
    return cx().execute("SELECT COUNT(*) FROM utilisateur WHERE cree_le > ?",
                        (depuis(FENETRE_INSCRIPTIONS),)).fetchone()[0]


def place_libre_a():
    """Quand la prochaine place s'ouvrira, ou None s'il en reste.

    Avec N inscriptions dans la fenetre et un quota Q, la suivante s'ouvre
    quand la (N - Q + 1)-ieme plus ancienne en sort.
    """
    n = inscriptions_recentes()
    if n < INSCRIPTIONS_PAR_JOUR:
        return None
    ligne = cx().execute(
        "SELECT cree_le FROM utilisateur WHERE cree_le > ? ORDER BY cree_le LIMIT 1 OFFSET ?",
        (depuis(FENETRE_INSCRIPTIONS), n - INSCRIPTIONS_PAR_JOUR)).fetchone()
    if ligne is None:
        return None
    return (datetime.fromisoformat(ligne["cree_le"])
            + FENETRE_INSCRIPTIONS).isoformat(timespec="seconds")


def etat_inscriptions() -> dict:
    reste = INSCRIPTIONS_PAR_JOUR - inscriptions_recentes()
    return {"ouvertes": reste > 0,
            "restantes": max(0, reste),
            "libre_a": None if reste > 0 else place_libre_a()}


# --------------------------------------------------------------------------
#   Projets masques
# --------------------------------------------------------------------------
def masques(uid) -> list:
    return [l["projet"] for l in cx().execute(
        "SELECT projet FROM preference WHERE utilisateur_id = ?", (uid,)).fetchall()]


def enregistre_masques(uid, projets) -> list:
    """Remplace la liste entiere. Rejouable sans effet de bord.

    Les identifiants inconnus sont ignores : le jour ou tu retires un projet
    d'Abyss.html, les vieilles preferences ne doivent pas tout faire echouer.
    """
    gardes = sorted({p for p in (projets or []) if p in PROJETS})
    c = cx()
    with c:
        c.execute("DELETE FROM preference WHERE utilisateur_id = ?", (uid,))
        c.executemany("INSERT INTO preference(utilisateur_id, projet) VALUES(?,?)",
                      [(uid, p) for p in gardes])
    return gardes


# --------------------------------------------------------------------------
#   Limitation de debit
# --------------------------------------------------------------------------
def note_essai(cle) -> None:
    c = cx()
    with c:
        c.execute("INSERT INTO essai(cle, quand) VALUES(?,?)", (cle, maintenant()))


def trop_d_essais(cle) -> bool:
    return cx().execute("SELECT COUNT(*) FROM essai WHERE cle = ? AND quand > ?",
                        (cle, depuis(FENETRE_ESSAIS))).fetchone()[0] >= ESSAIS_MAX


def oublie_essais(cle) -> None:
    c = cx()
    with c:
        c.execute("DELETE FROM essai WHERE cle = ?", (cle,))


# ==========================================================================
#   Routes
# ==========================================================================
blueprint_comptes = Blueprint("comptes", __name__, url_prefix="/api")


def reponse(charge, statut=200):
    """JSON jamais mis en cache : l'etat de connexion ne se garde nulle part."""
    r = jsonify(charge)
    r.status_code = statut
    r.headers["Cache-Control"] = "no-store, max-age=0"
    return r


def echec(code, message, statut=400):
    return reponse({"ok": False, "erreur": code, "message": message}, statut)


def corps() -> dict:
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


def actuel():
    """L'utilisateur de la session en cours, resolu une seule fois par requete."""
    if "utilisateur" not in g:
        g.utilisateur = session_valide(request.cookies.get(COOKIE, ""))
    return g.utilisateur


def etat(u) -> dict:
    """Tout ce que la page doit savoir. Jamais l'empreinte du mot de passe."""
    return {
        "ok": True,
        "connecte": u is not None,
        "utilisateur": None if u is None else {"pseudo": u["pseudo"], "email": u["email"]},
        "masques": [] if u is None else masques(u["id"]),
        # accompagne les deux cas : la page doit savoir, avant d'afficher le
        # formulaire, s'il reste des places
        "inscriptions": etat_inscriptions(),
    }


def avec_cookie(r, jeton, memoriser):
    r.set_cookie(COOKIE, jeton,
                 max_age=int(DUREE_SESSION.total_seconds()) if memoriser else None,
                 httponly=True, secure=FORCE_SECURE or request.is_secure,
                 samesite="Lax", path="/")
    return r


@blueprint_comptes.before_request
def exige_json():
    """Parade CSRF : un formulaire d'un autre site ne peut pas poser ce type."""
    # Seules les methodes qui portent un corps sont concernees. DELETE n'en a
    # pas, et n'a pas besoin de la regle : un formulaire HTML ne sait emettre
    # que GET et POST, et un fetch DELETE d'un autre site declenche un pre-vol
    # CORS. Exiger un type de contenu la aurait juste casse la suppression.
    if request.method in ("POST", "PUT", "PATCH") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    return None


@blueprint_comptes.errorhandler(Refus)
def refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_comptes.get("/moi")
def moi():
    return reponse(etat(actuel()))


@blueprint_comptes.post("/inscription")
def inscription():
    ip = "insc:" + (request.remote_addr or "?")
    if trop_d_essais(ip):
        return echec("debit", "Trop d'essais. Reviens dans un quart d'heure.", 429)
    note_essai(ip)

    d = corps()
    # Le pseudo et le mot de passe sont valides avant de consommer une place :
    # une faute de frappe ne doit rien couter.
    pseudo = verifie_pseudo(d.get("pseudo"))
    verifie_mdp(d.get("mdp"))
    if par_pseudo(pseudo) is not None:
        return echec("pseudo", "Ce pseudo est deja pris.", 409)
    if not etat_inscriptions()["ouvertes"]:
        return echec("quota", "Les inscriptions sont pleines pour le moment. "
                              "Reessaie plus tard.", 429)

    uid = cree_compte(pseudo, d.get("mdp"), d.get("email"))
    oublie_essais(ip)
    return avec_cookie(reponse(etat(par_pseudo(pseudo)), 201),
                       ouvre_session(uid, True), True)


@blueprint_comptes.post("/connexion")
def connexion():
    d = corps()
    pseudo, mdp = d.get("pseudo", ""), d.get("mdp", "")
    memoriser = bool(d.get("memoriser", True))

    # Deux compteurs : l'IP protege le site, le pseudo protege un compte
    # precis contre quelqu'un qui changerait d'adresse.
    cle_ip = "conn:" + (request.remote_addr or "?")
    cle_compte = "conn:@" + normalise(pseudo)
    if trop_d_essais(cle_ip) or trop_d_essais(cle_compte):
        return echec("debit", "Trop d'essais. Reviens dans un quart d'heure.", 429)

    u = identifiants_bons(pseudo, mdp)
    if u is None:
        note_essai(cle_ip)
        note_essai(cle_compte)
        # Un seul message pour les deux cas : dire « ce compte n'existe pas »
        # reviendrait a publier la liste des comptes.
        return echec("identifiants", "Pseudo ou mot de passe incorrect.", 401)

    oublie_essais(cle_ip)
    oublie_essais(cle_compte)
    return avec_cookie(reponse(etat(u)), ouvre_session(u["id"], memoriser), memoriser)


@blueprint_comptes.post("/deconnexion")
def deconnexion():
    ferme_session(request.cookies.get(COOKIE, ""))
    r = reponse(etat(None))
    r.set_cookie(COOKIE, "", max_age=0, httponly=True,
                 secure=FORCE_SECURE or request.is_secure, samesite="Lax", path="/")
    return r


@blueprint_comptes.put("/preferences")
def preferences():
    """Masquage des projets sur Abyss. Cosmetique et personnel.

    On remplace la liste entiere plutot que d'empiler des bascules : deux
    onglets ouverts ne peuvent pas diverger.
    """
    u = actuel()
    if u is None:
        return echec("connexion", "Il faut etre connecte.", 401)
    demande = corps().get("masques", [])
    if not isinstance(demande, list):
        return echec("format", "« masques » doit etre une liste.", 400)
    return reponse({"ok": True, "masques": enregistre_masques(u["id"], demande)})


@blueprint_comptes.post("/mot-de-passe")
def mot_de_passe():
    u = actuel()
    if u is None:
        return echec("connexion", "Il faut etre connecte.", 401)
    d = corps()
    if identifiants_bons(u["pseudo"], d.get("actuel")) is None:
        return echec("identifiants", "Mot de passe actuel incorrect.", 403)
    nouveau = verifie_mdp(d.get("nouveau"))
    c = cx()
    with c:
        c.execute("UPDATE utilisateur SET empreinte = ? WHERE id = ?",
                  (generate_password_hash(nouveau), u["id"]))
    # Toutes les sessions tombent, puis on en rouvre une ici : changer son mot
    # de passe doit chasser qui serait entre, sans se deconnecter soi-meme.
    ferme_toutes(u["id"])
    return avec_cookie(reponse({"ok": True}), ouvre_session(u["id"], True), True)