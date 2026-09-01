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

import base64
import binascii
import hashlib
import os
import re
import secrets
import smtplib
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

from flask import Blueprint, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

# Uniquement pour construire l'adresse d'un artwork de banniere. jaquettes
# n'importe rien d'ici, donc pas de cycle -- et redefinir l'adresse de base
# d'IGDB dans un second fichier serait la garantie qu'un jour les deux ne
# diront plus la meme chose.
from jaquettes import IGDB_IMG

# --------------------------------------------------------------------------
#   Reglages
# --------------------------------------------------------------------------
CHEMIN = Path(os.environ.get(
    "ABYSS_BASE", Path(__file__).parent.resolve() / "donnees" / "abyss.sqlite3"))

# Sous static/, donc servi tel quel par envoie() dans app.py : pas de route
# a part pour l'avatar, juste un fichier de plus a cote des jaquettes.
DOSSIER_AVATARS = Path(__file__).parent.resolve() / "static" / "Avatars"
AVATAR_MAXI = 2 * 1024 * 1024  # 2 Mo decodes ; MAX_CONTENT_LENGTH (app.py)
                                # plafonne deja le corps entier a 4 Mo

# La banniere du profil, meme principe que l'avatar.
DOSSIER_BANNIERES = Path(__file__).parent.resolve() / "static" / "Bannieres"
BANNIERE_MAXI = 3 * 1024 * 1024

# Format conseille a l'envoi. Large et court : la banniere est un bandeau,
# pas une photo. 1500x500 couvre un ecran courant sans exiger une image
# enorme, et c'est le rapport 3:1 qu'utilise le CSS -- une image d'un autre
# rapport n'est pas refusee, elle sera recadree a l'affichage.
BANNIERE_LARGEUR, BANNIERE_HAUTEUR = 1500, 500

# Un identifiant d'image IGDB : que des minuscules et des chiffres. Ce
# motif est ce qui empeche une banniere « igdb: » de designer autre chose
# qu'une image d'IGDB -- la valeur finit dans une adresse, et une valeur
# non filtree y ferait entrer ce qu'on veut.
MOTIF_IMAGE_IGDB = re.compile(r"^[a-z0-9]{2,40}$")

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
    "abyss", "admin", "api", "archive", "cartes", "collection", "compte",
    "connexion", "cover", "deconnexion", "inscription", "index", "jaquettes",
    "jeux-videos", "login", "moi", "profil", "quiz", "reinitialiser",
    "static", "templates", "www", "yugiquiz",
}

MDP_MINI = 8
MDP_MAXI = 200          # scrypt sur une entree enorme = deni de service gratuit

DUREE_SESSION = timedelta(days=30)       # « rester connecte »
DUREE_COURTE = timedelta(hours=12)       # sinon
DUREE_REINIT = timedelta(hours=1)        # lien de reinitialisation du mot de passe

FENETRE_ESSAIS = timedelta(minutes=15)
ESSAIS_MAX = 10

COOKIE = "abyss_session"
# En local sur http://127.0.0.1:8000, un cookie Secure ne serait jamais
# renvoye. On suit donc le protocole reellement vu, avec possibilite de
# forcer en production.
FORCE_SECURE = os.environ.get("ABYSS_COOKIE_SECURE", "").strip() in ("1", "oui", "true")

# Serveur SMTP pour le lien de reinitialisation. Sans ABYSS_SMTP_HOTE, rien
# n'est configure : le lien part sur la console au lieu d'un vrai mail,
# assez pour developper et tester en local sans brancher de serveur de mail.
SMTP_HOTE = os.environ.get("ABYSS_SMTP_HOTE", "").strip()
SMTP_PORT = int(os.environ.get("ABYSS_SMTP_PORT", "587") or 587)
SMTP_UTILISATEUR = os.environ.get("ABYSS_SMTP_UTILISATEUR", "").strip()
SMTP_MDP = os.environ.get("ABYSS_SMTP_MDP", "")
SMTP_EXPEDITEUR = os.environ.get("ABYSS_SMTP_EXPEDITEUR", "").strip() or SMTP_UTILISATEUR


class Refus(Exception):
    """Erreur previsible, a montrer telle quelle a la personne."""

    def __init__(self, code, message, statut=400):
        super().__init__(message)
        self.code, self.message, self.statut = code, message, statut


def envoie_mail(destinataire, sujet, corps) -> None:
    """Un mail texte brut, ou son contenu sur la console si aucun serveur
    SMTP n'est configure.

    Ce deuxieme cas n'est pas une erreur : en local, personne n'a envie de
    brancher un vrai serveur de mail pour tester la reinitialisation. En
    ligne, ABYSS_SMTP_HOTE (et les reglages qui vont avec) font partir un
    vrai message.
    """
    if not SMTP_HOTE:
        # flush=True : sous gunicorn ou une sortie redirigee, la sortie
        # standard est bufferisee par bloc et n'apparaitrait sinon jamais
        # a temps pour suivre le lien pendant que le jeton est valide
        print(f"\n---- mail (SMTP non configure) pour {destinataire} ----\n"
              f"Sujet : {sujet}\n\n{corps}\n---- fin du mail ----\n", flush=True)
        return
    msg = EmailMessage()
    msg["Subject"] = sujet
    msg["From"] = SMTP_EXPEDITEUR
    msg["To"] = destinataire
    msg.set_content(corps)
    with smtplib.SMTP(SMTP_HOTE, SMTP_PORT, timeout=10) as s:
        s.starttls()
        if SMTP_UTILISATEUR:
            s.login(SMTP_UTILISATEUR, SMTP_MDP)
        s.send_message(msg)


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

# Migration 3 : la reinitialisation de mot de passe. Meme forme que
# `session` (jeton en clair nulle part, sha256 en base) et meme duree de
# vie courte, mais dans sa propre table : un compte n'a jamais qu'un lien
# de reinitialisation valide a la fois, sans rapport avec ses sessions.
REINIT = """
CREATE TABLE reinitialisation(
  empreinte      TEXT PRIMARY KEY,
  utilisateur_id INTEGER NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  expire_le      TEXT NOT NULL
);
"""

# Migration 4 : la photo de profil. Le fichier vit sous static/Avatars/,
# nomme par l'id du compte ; ces deux colonnes disent juste son extension
# et quand il a change, pour que l'adresse porte un ?v= qui varie et que
# le navigateur n'affiche jamais une photo perimee depuis son cache.
AVATAR = """
ALTER TABLE utilisateur ADD COLUMN avatar TEXT;
ALTER TABLE utilisateur ADD COLUMN avatar_maj_le TEXT;
"""

# Migration 5 : la fiche detaillee d'un jeu. id_igdb rattache le jeu a une
# fiche precise -- il n'existait aucun lien stable jusqu'ici, seulement une
# recherche par nom refaite a chaque fois. plateforme/developpeur/genres en
# decoulent, ecrits une fois pour toutes quand le rattachement se fait ;
# description, captures et note critique ne sont eux jamais stockes (voir
# jaquettes.detail_complet), donc n'ont pas de colonne.
DETAIL_JEU = """
ALTER TABLE jeu ADD COLUMN id_igdb INTEGER;
ALTER TABLE jeu ADD COLUMN plateforme TEXT;
ALTER TABLE jeu ADD COLUMN developpeur TEXT;
ALTER TABLE jeu ADD COLUMN genres TEXT;
"""

# Migration 6 : le rattrapage automatique. Les classeurs remplis avant la
# migration 5 n'ont ni id_igdb ni plateforme/developpeur/genres, et on ne
# peut pas demander a chacun d'aller lancer la mise a jour a la main. La
# page le fait donc d'elle-meme, une fois, a la premiere connexion qui
# suit -- et cette colonne est ce qui garantit le « une fois » : la date
# du passage, ou NULL tant qu'il n'a pas eu lieu.
#
# Une date plutot qu'un booleen : le jour ou une nouvelle donnee justifiera
# un second rattrapage, il suffira de comparer cette date a celle de la
# livraison au lieu d'inventer une deuxieme colonne.
RATTRAPAGE = """
ALTER TABLE page ADD COLUMN igdb_rattrape_le TEXT;
"""

# Migration 7 : les suggestions et les rapports de bug, et le compte qui
# peut les lire. La table double le fichier changements.txt plutot que de
# le remplacer : le fichier reste ce qu'on lit pour travailler, la table
# est ce qui permet de les relire depuis le profil, de savoir qui a ecrit
# quoi et quand, et de marquer ce qui est traite. Un fichier texte ne sait
# rien faire de tout ca.
#
# `pseudo` est fige a l'ecriture et non relu depuis le compte : une
# suggestion doit rester attribuable meme si le compte disparait, et c'est
# ce meme pseudo qui part dans changements.txt.
SUGGESTIONS = """
ALTER TABLE utilisateur ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE suggestion(
  id             INTEGER PRIMARY KEY,
  utilisateur_id INTEGER REFERENCES utilisateur(id) ON DELETE SET NULL,
  pseudo         TEXT NOT NULL,          -- fige : le compte peut disparaitre
  projet         TEXT NOT NULL,          -- la section de changements.txt
  genre          TEXT NOT NULL,          -- 'suggestion' ou 'bug'
  message        TEXT NOT NULL,
  cree_le        TEXT NOT NULL,
  traite_le      TEXT                    -- NULL tant que ce n'est pas fait
);
CREATE INDEX idx_suggestion ON suggestion(traite_le, cree_le);

UPDATE utilisateur SET admin = 1 WHERE pseudo_norm = 'jokrem';
"""

# Migration 8 : la banniere du profil. Deux origines possibles, d'ou le
# prefixe stocke dans la colonne :
#   'fichier:webp'  -- une image envoyee, posee sous static/Bannieres/
#   'igdb:co1x2y'   -- un artwork d'IGDB, servi par IGDB, jamais copie chez
#                      nous : c'est une adresse, pas un fichier.
# Le second cas est la raison d'etre du prefixe. Sans lui il faudrait
# telecharger l'artwork pour l'afficher, alors qu'IGDB le sert deja tres
# bien -- et personne n'a envie d'heberger 500 images qu'il n'a pas prises.
BANNIERE = """
ALTER TABLE utilisateur ADD COLUMN banniere TEXT;
ALTER TABLE utilisateur ADD COLUMN banniere_maj_le TEXT;
"""

# Migration 9 : l'onglet sur lequel un classeur s'ouvre. Colonne de `page`
# et non de `utilisateur` : c'est une propriete du classeur, pas de la
# personne -- le jour ou un compte aura deux pages, chacune gardera la
# sienne. NULL = pas de choix, on retombe sur l'annee la plus recente,
# comme avant.
ONGLET_DEFAUT = """
ALTER TABLE page ADD COLUMN onglet_defaut TEXT;
"""

MIGRATIONS = [SCHEMA, PAGES, REINIT, AVATAR, DETAIL_JEU, RATTRAPAGE,
              SUGGESTIONS, BANNIERE, ONGLET_DEFAUT]

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
        c.execute("DELETE FROM reinitialisation WHERE expire_le <= ?", (maintenant(),))
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


def verifie_email(email):
    """None pour vider le champ (facultatif) ; sinon une adresse plausible.

    Pas un vrai validateur RFC : juste de quoi attraper une faute de frappe
    avant qu'elle ne rende un compte impossible a recuperer plus tard.
    """
    email = (email or "").strip()
    if not email:
        return None
    if len(email) > 200 or "@" not in email or " " in email:
        raise Refus("email", "Cette adresse n'a pas l'air valide.")
    return email


def par_pseudo(pseudo):
    return cx().execute("SELECT * FROM utilisateur WHERE pseudo_norm = ?",
                        (normalise(pseudo),)).fetchone()


def par_email(email):
    """Le compte portant cette adresse, ou None. Insensible a la casse.

    None aussi quand PLUSIEURS comptes portent la meme adresse : rien
    n'interdit deux inscriptions avec le meme e-mail (la colonne n'est pas
    UNIQUE, et l'imposer casserait les comptes existants). Dans ce cas
    l'adresse ne designe plus un compte, elle en designe deux -- se
    connecter avec elle reviendrait a tirer au sort. Le pseudo, lui, reste
    toujours sans ambiguite.
    """
    valeur = (email or "").strip().lower()
    if not valeur:
        return None
    lignes = cx().execute("SELECT * FROM utilisateur WHERE lower(email) = ?",
                          (valeur,)).fetchall()
    return lignes[0] if len(lignes) == 1 else None


def par_identifiant(valeur):
    """Le compte, qu'on ait donne son pseudo ou son e-mail.

    L'arobase tranche sans ambiguite possible : MOTIF_PSEUDO n'accepte que
    lettres, chiffres, tiret et souligne, donc un pseudo n'en contient
    jamais. Pas besoin d'essayer les deux ni de choisir un gagnant.
    """
    return par_email(valeur) if "@" in (valeur or "") else par_pseudo(valeur)


def cree_compte(pseudo, mdp, email=None) -> int:
    pseudo = verifie_pseudo(pseudo)
    verifie_mdp(mdp)
    email = verifie_email(email)
    c = cx()
    try:
        with c:
            cur = c.execute(
                "INSERT INTO utilisateur(pseudo, pseudo_norm, email, empreinte, cree_le)"
                " VALUES(?,?,?,?,?)",
                (pseudo, normalise(pseudo), email,
                 generate_password_hash(mdp), maintenant()))
    except sqlite3.IntegrityError:
        raise Refus("pseudo", "Ce pseudo est deja pris.", 409)
    return cur.lastrowid


# Empreinte d'un mot de passe bidon, verifiee quand le compte n'existe pas :
# sans elle, le temps de reponse dirait quels comptes existent.
_LEURRE = None


def identifiants_bons(identifiant, mdp):
    """Le compte si le couple est bon. `identifiant` : pseudo ou e-mail."""
    global _LEURRE
    u = par_identifiant(identifiant)
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
#   Reinitialisation du mot de passe
# --------------------------------------------------------------------------
def demande_reinitialisation(identifiant) -> None:
    """Envoie un lien si le compte existe et a un e-mail. Silencieuse sinon.

    `identifiant` est l'adresse e-mail -- c'est ce que demande la page --
    mais un pseudo marche aussi : quelqu'un qui se souvient de l'un et pas
    de l'autre ne doit pas rester bloque devant un champ trop strict.

    Silencieuse est le mot important. La route qui l'appelle repond
    exactement pareil dans tous les cas, y compris quand l'envoi echoue :
    un message different pour « adresse inconnue » laisserait n'importe qui
    tester des adresses pour savoir lesquelles ont un compte ici.
    """
    u = par_identifiant(identifiant)
    if u is None or not u["email"]:
        return
    jeton = secrets.token_urlsafe(32)
    c = cx()
    with c:
        # un seul lien valide a la fois : en redemander un invalide le precedent
        c.execute("DELETE FROM reinitialisation WHERE utilisateur_id = ?", (u["id"],))
        c.execute("INSERT INTO reinitialisation(empreinte, utilisateur_id, expire_le)"
                  " VALUES(?,?,?)", (_empreinte(jeton), u["id"], dans(DUREE_REINIT)))
    lien = f"{request.host_url}reinitialiser.html?jeton={jeton}"
    corps = (
        f"Bonjour {u['pseudo']},\n\n"
        "Quelqu'un (toi, on espere) a demande a reinitialiser le mot de passe "
        "de ton compte Abyss.\n\n"
        f"Choisis-en un nouveau ici, le lien est valable une heure :\n{lien}\n\n"
        "Si ce n'est pas toi qui as fait cette demande, ignore ce message : "
        "rien ne change a ton compte.\n"
    )
    try:
        envoie_mail(u["email"], "Reinitialiser ton mot de passe Abyss", corps)
    except Exception as err:               # noqa: BLE001 - SMTP casse de mille facons
        # Laisser remonter donnait un 500 -- mais SEULEMENT pour un compte
        # qui existe et a un e-mail. La difference entre 500 et 200 disait
        # donc exactement ce que le message uniforme s'applique a taire.
        # Le souci part dans le journal, ou il sert a quelque chose.
        print(f"envoi du lien de reinitialisation impossible : "
              f"{type(err).__name__}: {err}", flush=True)


def reinitialisation_valide(jeton):
    """La ligne utilisateur si le jeton ouvre une reinitialisation vivante."""
    if not jeton:
        return None
    c = cx()
    ligne = c.execute(
        "SELECT r.expire_le, u.* FROM reinitialisation r"
        " JOIN utilisateur u ON u.id = r.utilisateur_id WHERE r.empreinte = ?",
        (_empreinte(jeton),)).fetchone()
    if ligne is None or ligne["expire_le"] <= maintenant():
        return None
    return ligne


def consomme_reinitialisation(jeton, nouveau):
    """Change le mot de passe et rend le lien inutilisable. Renvoie le compte.

    Chasse aussi toutes les sessions ouvertes : si ce lien a fuite ou a ete
    devine, changer le mot de passe doit couper qui serait deja entre.
    """
    u = reinitialisation_valide(jeton)
    if u is None:
        raise Refus("jeton", "Ce lien n'est plus valide. Demande-en un nouveau.", 400)
    nouveau = verifie_mdp(nouveau)
    c = cx()
    with c:
        c.execute("UPDATE utilisateur SET empreinte = ? WHERE id = ?",
                  (generate_password_hash(nouveau), u["id"]))
        c.execute("DELETE FROM reinitialisation WHERE utilisateur_id = ?", (u["id"],))
    ferme_toutes(u["id"])
    return u


# --------------------------------------------------------------------------
#   Avatar
# --------------------------------------------------------------------------
def url_avatar(u):
    """L'adresse de la photo, ou None si le compte n'en a pas.

    ?v= porte la date d'enregistrement : remplacer la photo change
    l'adresse, donc le navigateur ne peut pas la garder en cache par erreur.
    """
    if not u["avatar"]:
        return None
    v = (u["avatar_maj_le"] or "").replace(":", "").replace("+", "")
    return f"/static/Avatars/{u['id']}.{u['avatar']}?v={v}"


def _signature_image(donnees: bytes):
    """Devine le format aux premiers octets, jamais au Content-Type ou a
    l'extension annonces par le navigateur : ni l'un ni l'autre ne prouve
    quoi que ce soit sur le contenu reel du fichier.
    """
    if donnees.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if donnees.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if donnees[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if donnees[:4] == b"RIFF" and donnees[8:12] == b"WEBP":
        return "webp"
    return None


def enregistre_avatar(u, data_url) -> str:
    """Decode l'image (une data: URL, telle que FileReader la donne cote
    navigateur) et l'enregistre. Renvoie l'extension retenue.
    """
    m = re.match(r"^data:image/[\w.+-]+;base64,(.+)$", data_url or "", re.S)
    if not m:
        raise Refus("avatar", "Image illisible.")
    try:
        donnees = base64.b64decode(m.group(1), validate=True)
    except (binascii.Error, ValueError):
        raise Refus("avatar", "Image illisible.")
    if len(donnees) > AVATAR_MAXI:
        raise Refus("avatar", f"Image trop lourde ({AVATAR_MAXI // (1024 * 1024)} Mo maximum).")
    ext = _signature_image(donnees)
    if ext is None:
        raise Refus("avatar", "Format d'image non reconnu (jpg, png, gif ou webp).")
    DOSSIER_AVATARS.mkdir(parents=True, exist_ok=True)
    # une photo posee plus tot sous une autre extension ne doit pas trainer
    for autre in ("jpg", "png", "gif", "webp"):
        if autre != ext:
            (DOSSIER_AVATARS / f"{u['id']}.{autre}").unlink(missing_ok=True)
    (DOSSIER_AVATARS / f"{u['id']}.{ext}").write_bytes(donnees)
    c = cx()
    with c:
        c.execute("UPDATE utilisateur SET avatar = ?, avatar_maj_le = ? WHERE id = ?",
                  (ext, maintenant(), u["id"]))
    return ext


def supprime_avatar(u) -> None:
    for ext in ("jpg", "png", "gif", "webp"):
        (DOSSIER_AVATARS / f"{u['id']}.{ext}").unlink(missing_ok=True)
    c = cx()
    with c:
        c.execute("UPDATE utilisateur SET avatar = NULL, avatar_maj_le = NULL WHERE id = ?",
                  (u["id"],))


# --------------------------------------------------------------------------
#   Banniere
# --------------------------------------------------------------------------
def url_banniere(u):
    """L'adresse de la banniere, ou None. Deux origines, une seule adresse.

    Un artwork d'IGDB n'est pas copie chez nous : on renvoie l'adresse
    d'IGDB, qui le sert deja. C'est tout l'interet du prefixe 'igdb:' --
    choisir une banniere ne coute alors ni octet sur le disque, ni attente
    a la personne qui la choisit.
    """
    valeur = u["banniere"] if "banniere" in u.keys() else None
    if not valeur:
        return None
    origine, _, reste = valeur.partition(":")
    if origine == "igdb":
        # l'artwork est deja filtre a l'ecriture ; on revalide quand meme,
        # parce qu'une base modifiee a la main ne doit pas pouvoir injecter
        # une adresse dans la page
        if not MOTIF_IMAGE_IGDB.match(reste):
            return None
        return f"{IGDB_IMG}/t_1080p/{reste}.jpg"
    if origine == "fichier":
        v = (u["banniere_maj_le"] or "").replace(":", "").replace("+", "")
        return f"/static/Bannieres/{u['id']}.{reste}?v={v}"
    return None


def _oublie_banniere_fichier(uid) -> None:
    for ext in ("jpg", "png", "gif", "webp"):
        (DOSSIER_BANNIERES / f"{uid}.{ext}").unlink(missing_ok=True)


def _pose_banniere(u, valeur) -> None:
    c = cx()
    with c:
        c.execute("UPDATE utilisateur SET banniere = ?, banniere_maj_le = ? WHERE id = ?",
                  (valeur, maintenant(), u["id"]))


def enregistre_banniere(u, data_url) -> str:
    """Une image envoyee par la personne. Meme lecture que l'avatar : le
    format se devine aux premiers octets, jamais a ce que le navigateur
    annonce.
    """
    m = re.match(r"^data:image/[\w.+-]+;base64,(.+)$", data_url or "", re.S)
    if not m:
        raise Refus("banniere", "Image illisible.")
    try:
        donnees = base64.b64decode(m.group(1), validate=True)
    except (binascii.Error, ValueError):
        raise Refus("banniere", "Image illisible.")
    if len(donnees) > BANNIERE_MAXI:
        raise Refus("banniere", f"Image trop lourde ({BANNIERE_MAXI // (1024 * 1024)} Mo maximum).")
    ext = _signature_image(donnees)
    if ext is None:
        raise Refus("banniere", "Format d'image non reconnu (jpg, png, gif ou webp).")
    DOSSIER_BANNIERES.mkdir(parents=True, exist_ok=True)
    _oublie_banniere_fichier(u["id"])
    (DOSSIER_BANNIERES / f"{u['id']}.{ext}").write_bytes(donnees)
    _pose_banniere(u, f"fichier:{ext}")
    return ext


def enregistre_banniere_igdb(u, image_id) -> str:
    """Un artwork d'IGDB, garde comme une simple reference.

    Le fichier eventuellement pose par un envoi precedent s'en va : la
    banniere est unique, et un fichier que plus rien ne designe ne ferait
    qu'occuper le disque.
    """
    image_id = str(image_id or "").strip()
    if not MOTIF_IMAGE_IGDB.match(image_id):
        raise Refus("banniere", "Artwork inconnu.")
    _oublie_banniere_fichier(u["id"])
    _pose_banniere(u, f"igdb:{image_id}")
    return image_id


def supprime_banniere(u) -> None:
    _oublie_banniere_fichier(u["id"])
    c = cx()
    with c:
        c.execute("UPDATE utilisateur SET banniere = NULL, banniere_maj_le = NULL"
                  " WHERE id = ?", (u["id"],))


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
        "utilisateur": None if u is None else
            {"pseudo": u["pseudo"], "email": u["email"], "avatar": url_avatar(u),
             "banniere": url_banniere(u), "admin": bool(u["admin"])},
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
        return echec("identifiants",
                     "Identifiant ou mot de passe incorrect.", 401)

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


@blueprint_comptes.post("/email")
def changer_email():
    """Change l'e-mail associe au compte. Le mot de passe le confirme :

    sans lui, une session volee pourrait poser sa propre adresse et
    detourner « mot de passe oublie » vers une boite qui n'est pas la
    tienne. Contrairement au mot de passe, ca ne chasse pas les autres
    sessions : ce n'est pas un identifiant de connexion.
    """
    u = actuel()
    if u is None:
        return echec("connexion", "Il faut etre connecte.", 401)
    d = corps()
    if identifiants_bons(u["pseudo"], d.get("mdp")) is None:
        return echec("identifiants", "Mot de passe incorrect.", 403)
    email = verifie_email(d.get("email"))
    c = cx()
    with c:
        c.execute("UPDATE utilisateur SET email = ? WHERE id = ?", (email, u["id"]))
    return reponse(etat(par_pseudo(u["pseudo"])))


@blueprint_comptes.post("/avatar")
def poser_avatar():
    u = actuel()
    if u is None:
        return echec("connexion", "Il faut etre connecte.", 401)
    enregistre_avatar(u, corps().get("image"))
    return reponse(etat(par_pseudo(u["pseudo"])))


@blueprint_comptes.delete("/avatar")
def retirer_avatar():
    u = actuel()
    if u is None:
        return echec("connexion", "Il faut etre connecte.", 401)
    supprime_avatar(u)
    return reponse(etat(par_pseudo(u["pseudo"])))


@blueprint_comptes.post("/banniere")
def poser_banniere():
    """Une banniere, d'une origine ou de l'autre.

    Un seul point d'entree pour les deux : c'est la meme decision cote
    utilisateur (« voila ma banniere »), et deux routes obligeraient la
    page a savoir laquelle appeler avant de savoir ce qui a ete choisi.
    """
    u = actuel()
    if u is None:
        return echec("connexion", "Il faut etre connecte.", 401)
    d = corps()
    if d.get("igdb"):
        enregistre_banniere_igdb(u, d.get("igdb"))
    else:
        enregistre_banniere(u, d.get("image"))
    return reponse(etat(par_pseudo(u["pseudo"])))


@blueprint_comptes.delete("/banniere")
def retirer_banniere():
    u = actuel()
    if u is None:
        return echec("connexion", "Il faut etre connecte.", 401)
    supprime_banniere(u)
    return reponse(etat(par_pseudo(u["pseudo"])))


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


@blueprint_comptes.post("/mot-de-passe-oublie")
def mot_de_passe_oublie():
    # `identifiant` depuis que la page demande une adresse ; `pseudo` reste
    # accepte pour ne pas casser un onglet ouvert avant la mise a jour.
    d = corps()
    identifiant = d.get("identifiant") or d.get("pseudo") or ""
    cle_ip = "oubli:" + (request.remote_addr or "?")
    cle_compte = "oubli:@" + normalise(identifiant)
    if trop_d_essais(cle_ip) or trop_d_essais(cle_compte):
        return echec("debit", "Trop d'essais. Reviens dans un quart d'heure.", 429)
    note_essai(cle_ip)
    note_essai(cle_compte)
    demande_reinitialisation(identifiant)
    # Le meme message dans tous les cas : adresse inconnue, compte sans
    # e-mail, ou lien reellement parti. Rien ici ne doit dire lequel --
    # sinon la page devient un testeur d'adresses.
    return reponse({"ok": True, "message":
        "Si un compte correspond, un lien vient de partir sur son adresse e-mail."})


@blueprint_comptes.post("/mot-de-passe-oublie/confirmer")
def mot_de_passe_oublie_confirmer():
    cle_ip = "oubliconf:" + (request.remote_addr or "?")
    if trop_d_essais(cle_ip):
        return echec("debit", "Trop d'essais. Reviens dans un quart d'heure.", 429)
    note_essai(cle_ip)
    d = corps()
    u = consomme_reinitialisation(d.get("jeton", ""), d.get("nouveau"))
    oublie_essais(cle_ip)
    return avec_cookie(reponse(etat(u)), ouvre_session(u["id"], True), True)