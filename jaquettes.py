#!/usr/bin/env python3
"""
Recuperation automatique des jaquettes de jeux, pour le journal Jeux Videos.

Se branche sur le hub en deux lignes, dans app.py :

    from jaquettes import blueprint_jaquettes
    app.register_blueprint(blueprint_jaquettes(STATIQUE / "Cover"))

Pour voir ce qui se passe, ce fichier se lance tout seul :

    python jaquettes.py "Hollow Knight"

Il affiche l'etat des identifiants, le motif exact d'un echec et les fiches
trouvees. Rien n'est telecharge : c'est un diagnostic, pas une commande.

Identifiants
------------
On interroge l'API d'IGDB, qui s'authentifie par Twitch (meme maison).
A faire une fois :

  1. https://dev.twitch.tv/console/apps -> Register Your Application
     (URL de redirection : http://localhost, categorie : Application Integration)
  2. relever le Client ID, puis « New Secret » pour le Client Secret
  3. creer igdb.json a cote de ce fichier :
       { "client_id": "...", "client_secret": "..." }

Les variables d'environnement IGDB_CLIENT_ID / IGDB_CLIENT_SECRET passent
avant le fichier, si tu preferes ne rien poser sur le disque. Le jeton
d'acces qui en decoule dure deux mois ; il est garde dans un fichier cache
et renouvele tout seul quand il expire ou qu'il est refuse.

Pourquoi pas stash.games
------------------------
C'etait la premiere piste, et sa page portait bien l'adresse de la jaquette
en clair. Mais le site repond 403 a tout ce qui n'est pas un navigateur :
protection anti-robot, rien a negocier. IGDB fournit exactement les memes
images -- stash n'etait qu'une facade dessus -- avec en prime une vraie
recherche : un titre approximatif remonte quand meme des resultats, la ou
stash exigeait l'adresse exacte.

Plus de mystere des "--1", du coup : ce numero etait la numerotation des
adresses de stash quand deux fiches portaient le meme titre. Ici on a les
fiches elles-memes, avec leur date de sortie et leur nature (jeu, portage,
mod, DLC...), donc de quoi choisir en connaissance de cause.

Completion du nom, et d'ou vient le prix
----------------------------------------
Le formulaire « Ajouter un jeu » interroge /api/jeu/suggestions a chaque
frappe : ce sont les memes fiches IGDB que pour la jaquette, en gardant
cette fois celles qui n'ont pas d'image (un nom et une date restent utiles).

IGDB ne publie aucun prix -- ce n'est pas un magasin, c'est un catalogue.
Ce qu'il donne, c'est le lien vers la fiche Steam du jeu (external_games).
On suit ce lien et c'est Steam qui repond son prix fort, en euros, via son
API de boutique. Consequence a connaitre : un jeu qui n'est pas sur Steam
(exclusivite Nintendo, PlayStation, jeu physique...) n'a pas de prix ici,
et la case reste vide. Rien n'est devine.

Mise a jour de tout le journal
------------------------------
Le menu des reglages de la page peut relancer la recherche sur chaque jeu
deja enregistre, pour corriger les dates de sortie, rattraper les prix et
proposer les jaquettes manquantes. C'est /api/jeu/maj qui repond, un jeu
par appel : une seule recherche IGDB sert a la fois a identifier la fiche
(date, prix) et a lister les jaquettes possibles.

Cette route ne decide rien toute seule. Elle renvoie ce qu'IGDB dit, avec
sa « surete » -- titre identique et annee qui colle, titre identique seul,
ou simple ressemblance -- et c'est la page qui montre la liste avant que
quoi que ce soit ne parte dans le classeur.

Quelques centaines d'appels d'affilee, ca depasse vite les quatre requetes
par seconde qu'IGDB tolere : _patiente() espace les appels sortants, cote
serveur, pour que le navigateur n'ait pas a s'en soucier.
"""

from pathlib import Path
import datetime
import json
import os
import re
import ssl
import threading
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

from flask import Blueprint, jsonify, request

# --------------------------------------------------------------------------
#   Reglages
# --------------------------------------------------------------------------
JETON_URL = "https://id.twitch.tv/oauth2/token"
IGDB_URL = "https://api.igdb.com/v4/games"
IGDB_IMG = "https://images.igdb.com/igdb/image/upload"
# le prix ne vient pas d'IGDB (il n'en a pas) mais de la boutique Steam,
# dont IGDB donne le lien. cc= decide du pays, donc de la devise.
STEAM_URL = "https://store.steampowered.com/api/appdetails"
PAYS = "fr"

ICI = Path(__file__).parent.resolve()
FICHIER_IDENTIFIANTS = ICI / "igdb.json"
FICHIER_JETON = ICI / ".igdb-jeton.json"

# taille de l'image gardee sur le disque : la resolution d'origine, sans
# recadrage ni compression -- c'est celle que stash.games affichait aussi,
# puisqu'il ne faisait que la relayer depuis IGDB.
TAILLE = "t_original"
# taille des apercus de la fenetre de choix : charges depuis IGDB par le
# navigateur, jamais ecrits sur le disque -- pas besoin de l'originale pour
# une vignette de 130 px, ca ralentirait juste l'ouverture de la fenetre
TAILLE_APERCU = "t_cover_big"

# L'extension des jaquettes sur le disque. En constante parce que trois
# endroits doivent s'accorder dessus : l'ecriture du fichier, l'adresse
# publique qu'on renvoie, et le manifeste qui liste ce qui existe. Si l'un
# des trois s'ecarte, la page redemande a l'infini des fichiers presents.
EXTENSION = ".webp"

PROPOSITIONS_MAX = 8       # au-dela on ne choisit plus, on subit
# jeux traites par appel a /api/wishlist/prix : la page envoie de petits
# paquets pour voir les pastilles arriver, ce plafond n'est qu'un garde-fou
WISHLIST_MAX = 40
SUGGESTIONS_MAX = 7        # la liste deroulante sous le champ « Nom du jeu »
DELAI = 10                 # secondes avant d'abandonner une requete

# Secondes minimum entre deux appels sortants vers un meme service. IGDB
# coupe au-dela de quatre requetes par seconde ; Steam n'annonce pas de
# chiffre mais finit par repondre 429 quand on insiste. Une frappe dans le
# formulaire n'atteint jamais ces plafonds -- c'est la mise a jour de tout
# le journal qui les frole, avec ses trois appels par jeu.
CADENCE = {"igdb": 0.26, "steam": 0.30}
MAX_IMAGE = 20 * 1024 * 1024  # une jaquette en resolution d'origine peut peser lourd
MAX_REPONSE = 4 * 1024 * 1024

NAVIGATEUR = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0.0.0 Safari/537.36")

ENTETES_IMAGE = {
    "User-Agent": NAVIGATEUR,
    "Accept": "image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Encoding": "identity",
    "Connection": "close",
}

# Steam repond 403 a ce qui n'annonce pas un navigateur : sa boutique n'est
# pas une API publique, meme si tout le monde s'en sert comme telle.
ENTETES_STEAM = {
    "User-Agent": NAVIGATEUR,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Connection": "close",
}

# IGDB range ses fiches par nature. Celles marquees ici ne sont pas le jeu
# lui-meme : elles gardent souvent la meme jaquette, d'ou l'interet de le
# dire plutot que de laisser choisir a l'aveugle.
NATURES = {
    0: "", 1: "DLC", 2: "extension", 3: "bundle", 4: "extension",
    5: "mod", 6: "episode", 7: "saison", 8: "remake", 9: "remaster",
    10: "edition augmentee", 11: "portage", 12: "fork", 13: "pack",
    14: "mise a jour",
}
DERIVEES = {1, 2, 4, 5, 6, 7, 10, 11, 12, 13, 14}

MOIS_FR = ["janv.", "fevr.", "mars", "avr.", "mai", "juin",
           "juil.", "aout", "sept.", "oct.", "nov.", "dec."]

# mis a False pour faire taire la console du serveur
BAVARD = True


def _dit(message):
    if BAVARD:
        print(f"  jaquettes : {message}")


# --------------------------------------------------------------------------
#   Nommage
# --------------------------------------------------------------------------
def slug(nom, sep="_"):
    """Meme regle que le slug() de jeux-videos.html.

    Minuscules, sans accents, toute suite de caracteres speciaux devient un
    seul separateur. sep="_" donne le nom de fichier (nom_du_jeu.webp) ;
    sep="-" sert a comparer deux titres sans se soucier de la ponctuation.
    """
    texte = unicodedata.normalize("NFD", str(nom or ""))
    texte = "".join(c for c in texte if unicodedata.category(c) != "Mn")
    texte = re.sub(r"[^a-z0-9]+", sep, texte.lower())
    return texte.strip(sep)


def _annee(valeur):
    """Premiere annee lisible dans une date de Sheet (2017-02-24, 24/02/2017...)."""
    trouve = re.search(r"(19|20)\d{2}", str(valeur or ""))
    return int(trouve.group(0)) if trouve else None


def _date_fr(horodatage):
    """1487894400 -> ('24 fevr. 2017', 2017, '2017-02-24').

    IGDB compte en secondes UTC. La troisieme forme est celle que comprend
    un <input type="date"> : c'est elle que le formulaire recopie.
    """
    if not horodatage:
        return "", None, ""
    try:
        j = datetime.datetime.fromtimestamp(int(horodatage), datetime.timezone.utc)
    except (ValueError, OSError, OverflowError):
        return "", None, ""
    return (f"{j.day} {MOIS_FR[j.month - 1]} {j.year}", j.year,
            f"{j.year:04d}-{j.month:02d}-{j.day:02d}")


# --------------------------------------------------------------------------
#   Requetes
# --------------------------------------------------------------------------
def _motif(err):
    """Pourquoi ca a rate, en une ligne lisible dans un toast."""
    if isinstance(err, urllib.error.HTTPError):
        return "absent" if err.code in (404, 410) else f"HTTP {err.code}"
    if isinstance(err, urllib.error.URLError):
        cause = getattr(err, "reason", err)
        if isinstance(cause, ssl.SSLCertVerificationError):
            return "certificat SSL refuse par Python"
        if isinstance(cause, TimeoutError):
            return f"pas de reponse en {DELAI} s"
        return str(cause)[:120]
    if isinstance(err, TimeoutError):
        return f"pas de reponse en {DELAI} s"
    return f"{type(err).__name__}: {err}"[:120]


_DERNIER_APPEL = {}
_VERROU_CADENCE = threading.Lock()


def _patiente(service):
    """Espace les appels sortants vers `service`.

    Le serveur est « threaded » : deux onglets, ou la mise a jour de tout le
    journal, peuvent taper sur IGDB en meme temps. Le verrou est garde
    pendant l'attente -- c'est exactement le but : le deuxieme appelant
    patiente, il ne double pas le premier.

    Une seule requete de temps en temps ne paye rien : l'attente n'existe
    que si l'appel precedent date de moins de CADENCE secondes.
    """
    intervalle = CADENCE.get(service, 0)
    if not intervalle:
        return
    with _VERROU_CADENCE:
        attente = intervalle - (time.time() - _DERNIER_APPEL.get(service, 0.0))
        if attente > 0:
            time.sleep(attente)
        _DERNIER_APPEL[service] = time.time()


def _appelle(adresse, entetes=None, corps=None, limite=MAX_REPONSE):
    """(donnees, type de contenu, souci). souci vaut None, 'absent' ou un motif.

    Une resolution DNS qui echoue, une coupure reseau d'une fraction de
    seconde : ca arrive et ca n'a rien a voir avec l'adresse demandee, donc
    un second essai suffit generalement. Un code HTTP (403, 404...) est en
    revanche definitif -- IGDB ne va pas changer d'avis une seconde plus
    tard -- inutile d'attendre pour rien.
    """
    for essai in (0, 1):
        requete = urllib.request.Request(adresse, data=corps, headers=entetes or {})
        try:
            with urllib.request.urlopen(requete, timeout=DELAI) as reponse:
                brut = reponse.read(limite)
                type_contenu = (reponse.headers.get("Content-Type") or "").lower()
            return brut, type_contenu, None
        except urllib.error.HTTPError as err:
            souci = _motif(err)
            if souci != "absent":
                _dit(f"{adresse} -> {souci}")
            return None, "", souci
        except Exception as err:                  # noqa: BLE001 - on veut tout attraper
            souci = _motif(err)
            if essai == 0:
                _dit(f"{adresse} -> {souci} (nouvel essai)")
                time.sleep(0.6)
                continue
            _dit(f"{adresse} -> {souci}")
            return None, "", souci


# --------------------------------------------------------------------------
#   Identifiants et jeton d'acces
# --------------------------------------------------------------------------
def identifiants():
    """(client_id, client_secret) ou (None, None). L'environnement d'abord."""
    cid = os.environ.get("IGDB_CLIENT_ID", "").strip()
    secret = os.environ.get("IGDB_CLIENT_SECRET", "").strip()
    if cid and secret:
        return cid, secret
    try:
        contenu = json.loads(FICHIER_IDENTIFIANTS.read_text(encoding="utf-8"))
        cid = str(contenu.get("client_id", "")).strip()
        secret = str(contenu.get("client_secret", "")).strip()
        if cid and secret:
            return cid, secret
    except (OSError, ValueError):
        pass
    return None, None


_JETON = {"valeur": "", "fin": 0}


def jeton(forcer=False):
    """Le jeton d'acces IGDB. Renvoie (jeton, souci).

    Garde en memoire ET sur disque : redemarrer le serveur ne doit pas
    redemander un jeton a Twitch, qui finirait par se lasser.
    """
    maintenant = time.time()
    if not forcer:
        if _JETON["valeur"] and _JETON["fin"] > maintenant + 60:
            return _JETON["valeur"], None
        try:
            garde = json.loads(FICHIER_JETON.read_text(encoding="utf-8"))
            if garde.get("valeur") and garde.get("fin", 0) > maintenant + 60:
                _JETON.update(valeur=garde["valeur"], fin=garde["fin"])
                return _JETON["valeur"], None
        except (OSError, ValueError):
            pass

    cid, secret = identifiants()
    if not cid:
        return "", "identifiants IGDB manquants (voir igdb.json)"

    corps = urllib.parse.urlencode({
        "client_id": cid,
        "client_secret": secret,
        "grant_type": "client_credentials",
    }).encode()
    brut, _, souci = _appelle(JETON_URL, {"Accept": "application/json"}, corps)
    if souci:
        return "", ("identifiants IGDB refuses par Twitch"
                    if souci in ("HTTP 400", "HTTP 401", "HTTP 403") else souci)
    try:
        reponse = json.loads(brut.decode("utf-8"))
        valeur = reponse["access_token"]
        fin = maintenant + int(reponse.get("expires_in", 3600))
    except (ValueError, KeyError, TypeError):
        return "", "reponse inattendue de Twitch"

    _JETON.update(valeur=valeur, fin=fin)
    try:
        FICHIER_JETON.write_text(json.dumps(_JETON), encoding="utf-8")
    except OSError:
        pass       # pas grave : on redemandera au prochain demarrage
    return valeur, None


def interroge(requete):
    """Envoie une requete APICalypse. Renvoie (liste de fiches, souci).

    Un 401 veut dire jeton perime cote serveur alors qu'on le croyait bon :
    on en redemande un et on rejoue, une seule fois.
    """
    for essai in (0, 1):
        acces, souci = jeton(forcer=bool(essai))
        if souci:
            return [], souci
        cid, _ = identifiants()
        if not cid:
            # ne devrait pas arriver si jeton() vient de reussir, mais un
            # en-tete absent ferait planter urllib plus loin avec un message
            # illisible -- autant s'arreter ici, proprement
            return [], "identifiants IGDB manquants (voir igdb.json)"
        entetes = {
            "Client-ID": cid,
            "Authorization": f"Bearer {acces}",
            "Accept": "application/json",
            "Content-Type": "text/plain",
        }
        _patiente("igdb")
        brut, _, souci = _appelle(IGDB_URL, entetes, requete.encode("utf-8"))
        if souci == "HTTP 401" and not essai:
            continue
        if souci:
            return [], souci
        try:
            return json.loads(brut.decode("utf-8")), None
        except ValueError:
            return [], "reponse inattendue d'IGDB"
    return [], "jeton IGDB refuse"


# --------------------------------------------------------------------------
#   Recherche
# --------------------------------------------------------------------------
CHAMPS = ("id, name, slug, url, first_release_date, category, "
          "parent_game, version_parent, cover.image_id")


def _fiche(jeu, cherche, exige_jaquette=True):
    """Ce qu'on retient d'un resultat : de quoi choisir, rien de plus.

    exige_jaquette=False sert a la completion du nom : une fiche sans image
    reste utile, elle porte quand meme un titre, une date et un lien Steam.
    Pour le choix d'une jaquette, elle ne servirait a rien -- d'ou le
    comportement par defaut, inchange.
    """
    couverture = (jeu.get("cover") or {}).get("image_id")
    if not couverture and exige_jaquette:
        return None
    date, annee, iso = _date_fr(jeu.get("first_release_date"))
    categorie = jeu.get("category", 0)
    return {
        "id": jeu.get("id") or 0,
        "titre": jeu.get("name") or "",
        "date": date,
        "annee": annee,
        "iso": iso,
        "nature": NATURES.get(categorie, ""),
        "derive": categorie in DERIVEES
                  or bool(jeu.get("version_parent") or jeu.get("parent_game")),
        # le titre est exactement celui qu'on cherchait, ponctuation mise a part
        "exact": slug(jeu.get("name"), "-") == cherche,
        "image": couverture or "",
        "apercu": f"{IGDB_IMG}/{TAILLE_APERCU}/{couverture}.webp" if couverture else "",
        "lien": jeu.get("url") or "",
    }


def toutes_les_fiches(nom, limite=40):
    """Tout ce qu'IGDB renvoie pour ce nom. Renvoie (fiches, souci).

    Une seule requete, trois usages : la liste deroulante du formulaire, le
    choix d'une jaquette, et la mise a jour de tout le journal -- qui a
    besoin des deux a la fois (la fiche pour la date et le prix, les images
    pour proposer une jaquette). Les fiches sans image sont gardees : elles
    portent quand meme un titre, une date et un lien Steam.

    Les titres identiques au tien passent devant, puis viennent les autres
    resultats de la recherche : c'est ce qui sauve « Zelda BOTW » ou une
    faute de frappe, la ou une correspondance exacte n'aurait rien donne.
    """
    nom = (nom or "").strip()
    if not nom:
        return [], None
    echappe = nom.replace("\\", " ").replace('"', " ")
    resultats, souci = interroge(
        f'search "{echappe}"; fields {CHAMPS}; limit {int(limite)};')
    if souci:
        return [], souci

    cherche = slug(nom, "-")
    fiches, vues = [], set()
    for jeu in resultats:
        # deux fiches sans image ne sont pas la meme : on dedoublonne par
        # identifiant, pas par jaquette
        fiche = _fiche(jeu, cherche, exige_jaquette=False)
        if not fiche or not fiche["titre"] or fiche["id"] in vues:
            continue
        vues.add(fiche["id"])
        fiches.append(fiche)

    # titre identique d'abord, jeu avant portage/DLC, fiche illustree avant
    # fiche nue -- le reste dans l'ordre de pertinence renvoye par IGDB
    fiches.sort(key=lambda f: (not f["exact"], f["derive"], not f["image"]))
    return fiches, None


def _illustrees(fiches, maximum=PROPOSITIONS_MAX):
    """Celles qui portent une jaquette, dedoublonnees par image.

    Deux editions d'un meme jeu partagent souvent la meme image : la montrer
    deux fois ne donne pas un choix, juste une case en plus a lire.
    """
    sortie, vues = [], set()
    for fiche in fiches:
        if not fiche["image"] or fiche["image"] in vues:
            continue
        vues.add(fiche["image"])
        sortie.append(fiche)
    return sortie[:maximum]


def candidats(nom):
    """Les jaquettes qu'IGDB propose pour ce nom. Renvoie (fiches, souci)."""
    fiches, souci = toutes_les_fiches(nom)
    if souci:
        return [], souci
    return _illustrees(fiches), None


def tranche(fiches, annee):
    """La fiche la plus probable, ou None si rien ne se detache.

    Elle n'est pas telechargee d'office -- c'est toi qui cliques -- mais
    elle passe en tete de la liste et porte un lisere dore.
    """
    if len(fiches) == 1:
        return fiches[0]
    exactes = [f for f in fiches if f["exact"]]
    if not exactes:
        return None          # aucun titre identique : rien a suggerer
    if annee:
        for ecart in (0, 1):   # +-1 an : les sorties decalees par plateforme
            colle = [f for f in exactes
                     if f["annee"] and abs(f["annee"] - annee) <= ecart]
            if len(colle) == 1:
                return colle[0]
        return None
    # sans date de sortie : le seul vrai jeu parmi les titres identiques,
    # sinon on laisse choisir (portages et DLC portent le meme nom)
    vrais = [f for f in exactes if not f["derive"]]
    return vrais[0] if len(vrais) == 1 else None


def suggestions(nom, maximum=SUGGESTIONS_MAX):
    """Ce qu'on propose sous le champ « Nom du jeu ». Renvoie (fiches, souci).

    On s'arrete a deux lettres : une recherche sur « a » ne renvoie rien
    d'utile et coute un aller-retour a chaque frappe.
    """
    nom = (nom or "").strip()
    if len(nom) < 2:
        return [], None
    fiches, souci = toutes_les_fiches(nom, limite=25)
    if souci:
        return [], souci
    return fiches[:maximum], None


def retenue_pour(fiches, annee):
    """La fiche a laquelle ce nom correspond. Renvoie (fiche, surete).

    Sert a la mise a jour de masse, ou personne ne regarde chaque jeu : la
    surete dit a quel point on peut y aller les yeux fermes, et la page
    coche ou non la ligne en consequence.

      « sure »      un seul titre identique, ou l'annee tranche entre eux
      « probable »  plusieurs fiches portent exactement ce titre
      « douteuse »  aucun titre identique : simple ressemblance

    tranche() n'est pas appelee sur la liste entiere exprès : elle renvoie
    l'unique resultat quand il n'y en a qu'un, meme si son titre n'a rien a
    voir. Bon pour une jaquette qu'on regarde avant de cliquer, mauvais
    pour une date qu'on ecrit en serie.
    """
    if not fiches:
        return None, ""
    exactes = [f for f in fiches if f["exact"]]
    if not exactes:
        return fiches[0], "douteuse"
    evidente = tranche(exactes, annee)
    return (evidente or exactes[0]), ("sure" if evidente else "probable")


# --------------------------------------------------------------------------
#   Prix : IGDB donne le lien Steam, Steam donne le prix
# --------------------------------------------------------------------------
CHAMPS_BOUTIQUE = "external_games.category, external_games.uid, external_games.url"


def boutique_steam(id_igdb):
    """L'identifiant Steam de ce jeu IGDB. Renvoie (appid, souci).

    ("", None) veut dire « pas sur Steam » : ce n'est pas une panne, c'est
    une reponse. La categorie 1 designe Steam dans external_games ; IGDB
    l'a marquee obsolete au profit d'external_game_source, donc si la
    requete est refusee on la rejoue sans elle et on lit l'adresse, qui
    porte l'appid en clair.
    """
    try:
        numero = int(id_igdb)
    except (TypeError, ValueError):
        return "", "identifiant IGDB invalide"

    souci = None
    resultats = []
    for champs in (CHAMPS_BOUTIQUE, "external_games.uid, external_games.url"):
        resultats, souci = interroge(f"fields {champs}; where id = {numero}; limit 1;")
        if not souci:
            break
    if souci:
        return "", souci
    if not resultats:
        return "", None

    liens = resultats[0].get("external_games") or []
    for lien in liens:
        if lien.get("category") == 1 and str(lien.get("uid") or "").isdigit():
            return str(lien["uid"]), None
    for lien in liens:
        trouve = re.search(r"store\.steampowered\.com/app/(\d+)",
                           str(lien.get("url") or ""))
        if trouve:
            return trouve.group(1), None
    return "", None


# Steam limite le nombre d'appels par quart d'heure, et un prix ne bouge
# pas dans la matinee : on garde ce qu'on a deja demande.
_PRIX = {}
DUREE_PRIX = 6 * 3600


def _euros(centimes):
    """Des centimes Steam en euros, ou None si ce n'est pas un nombre."""
    try:
        return round(int(centimes) / 100, 2)
    except (TypeError, ValueError):
        return None


def tarif_steam(appid):
    """Ce que Steam annonce aujourd'hui. Renvoie (tarif, souci).

        tarif = {"plein": 59.99, "actuel": 23.99, "remise": 60}

    « plein » est le prix hors promotion (initial), « actuel » celui du jour
    (final), et la remise le pourcentage. Les trois viennent du meme bloc
    price_overview, dans la meme reponse : on ne lisait qu'initial alors que
    les deux autres etaient deja la, sans un appel de plus.

    (None, None) veut dire que Steam n'annonce pas de prix pour ce pays :
    jeu retire, precommande sans tarif, edition regionale... La case reste
    vide, ce qui vaut mieux qu'un chiffre invente.
    """
    if not re.fullmatch(r"\d+", appid or ""):
        return None, "identifiant Steam invalide"

    garde = _PRIX.get(appid)
    if garde and time.time() - garde[1] < DUREE_PRIX:
        return garde[0], None

    parametres = urllib.parse.urlencode({
        "appids": appid, "cc": PAYS, "l": "fr",
        "filters": "price_overview,is_free",
    })
    _patiente("steam")
    brut, _, souci = _appelle(f"{STEAM_URL}?{parametres}", ENTETES_STEAM)
    if souci:
        return None, ("fiche Steam absente" if souci == "absent" else souci)
    try:
        reponse = json.loads((brut or b"").decode("utf-8"))
    except (ValueError, AttributeError, UnicodeDecodeError):
        return None, "reponse inattendue de Steam"

    bloc = reponse.get(str(appid)) or {}
    donnees = bloc.get("data")
    if not bloc.get("success") or not isinstance(donnees, dict):
        return None, None            # Steam connait l'appid mais ne dit rien

    apercu = donnees.get("price_overview") or {}
    plein = _euros(apercu.get("initial"))
    if plein is None:
        # un jeu gratuit n'a pas de price_overview du tout : 0, pas « inconnu »
        tarif = {"plein": 0.0, "actuel": 0.0, "remise": 0} if donnees.get("is_free") else None
    else:
        actuel = _euros(apercu.get("final"))
        if actuel is None:
            actuel = plein
        try:
            remise = int(apercu.get("discount_percent") or 0)
        except (TypeError, ValueError):
            remise = 0
        # Steam annonce parfois une remise sans baisser le prix affiche, et
        # l'inverse : on ne garde la promotion que si les deux concordent
        if remise <= 0 or actuel >= plein:
            actuel, remise = plein, 0
        tarif = {"plein": plein, "actuel": actuel, "remise": remise}

    _PRIX[appid] = (tarif, time.time())
    return tarif, None


def prix_steam(appid):
    """Le prix fort en euros. Renvoie (prix, souci).

    Le prix hors promotion, c'est-a-dire ce qu'on inscrit dans la colonne
    « Prix de base » : une remise du jour n'a rien a y faire.
    """
    tarif, souci = tarif_steam(appid)
    return (tarif["plein"] if tarif else None), souci


def tarif_du_jeu(id_igdb):
    """Le tarif complet d'une fiche IGDB. Renvoie (tarif, appid, souci).

    Voir tarif_steam pour la forme du tarif : prix fort, prix du jour et
    remise. Les trois viennent du meme appel, il n'y a rien a economiser en
    n'en demandant qu'un.
    """
    appid, souci = boutique_steam(id_igdb)
    if souci:
        return None, "", souci
    if not appid:
        return None, "", None
    tarif, souci = tarif_steam(appid)
    return tarif, appid, souci


def prix_du_jeu(id_igdb):
    """Le prix fort d'une fiche IGDB. Renvoie (prix, appid, souci)."""
    tarif, appid, souci = tarif_du_jeu(id_igdb)
    return (tarif["plein"] if tarif else None), appid, souci


# L'appid d'un jeu ne change jamais, et le trouver coute deux appels a IGDB
# (chercher la fiche, puis lire son lien boutique). C'est ce cache qui rend
# la deuxieme visite a la wishlist immediate ; la premiere paie la recherche.
_APPID = {}
DUREE_APPID = 30 * 86400


# --------------------------------------------------------------------------
#   Decouverte : ce qu'IGDB juge proche de ce qu'on a aime
# --------------------------------------------------------------------------
SIMILAIRES_MAX = 8         # par jeu source : au-dela IGDB s'eloigne du sujet
DECOUVERTE_SOURCES = 8     # jeux sources acceptes en un appel
DECOUVERTE_MAX = 12        # suggestions renvoyees
# les gouts d'IGDB ne changent pas d'un jour a l'autre, et chaque source
# coute deux requetes : on garde longtemps
DUREE_SIMILAIRES = 7 * 86400
_SIMILAIRES = {}


def similaires_de(nom, sortie=None):
    """Les identifiants IGDB des jeux juges proches. Renvoie (ids, souci).

    Deux requetes : retrouver la fiche du jeu, puis lire son champ
    similar_games. Le resultat est garde une semaine par nom.
    """
    cle = slug(nom)
    if not cle:
        return [], None
    garde = _SIMILAIRES.get(cle)
    if garde and time.time() - garde[1] < DUREE_SIMILAIRES:
        return garde[0], None

    fiches, souci = toutes_les_fiches(nom)
    if souci:
        return [], souci
    choix, _surete = retenue_pour(fiches, _annee(sortie))
    if not choix:
        return [], None
    resultats, souci = interroge(
        f"fields similar_games; where id = {int(choix['id'])}; limit 1;")
    if souci:
        return [], souci

    bruts = (resultats[0].get("similar_games") if resultats else None) or []
    ids = []
    for numero in bruts[:SIMILAIRES_MAX]:
        try:
            ids.append(int(numero))
        except (TypeError, ValueError):
            continue
    _SIMILAIRES[cle] = (ids, time.time())
    return ids, None


def fiches_par_id(ids):
    """Les fiches de ces identifiants, en une seule requete.

    Renvoie ({id: fiche}, souci). Une requete pour toutes plutot qu'une par
    jeu : c'est la difference entre un aller-retour et quarante.
    """
    numeros = []
    for numero in ids:
        try:
            numeros.append(int(numero))
        except (TypeError, ValueError):
            continue
    if not numeros:
        return {}, None
    liste = ",".join(str(n) for n in numeros)
    resultats, souci = interroge(
        f"fields {CHAMPS}; where id = ({liste}); limit {len(numeros)};")
    if souci:
        return {}, souci
    sortie = {}
    for jeu in resultats:
        # exige_jaquette=False : une fiche sans image reste une suggestion
        # valable, elle passera juste apres celles qui en ont une
        fiche = _fiche(jeu, "", exige_jaquette=False)
        if fiche and fiche["titre"]:
            sortie[fiche["id"]] = fiche
    return sortie, None


def appid_du_nom(nom, sortie=None):
    """L'identifiant Steam d'un jeu designe par son nom. Renvoie (appid, souci).

    ("", None) veut dire « pas sur Steam ». C'est une reponse, pas un echec,
    et elle est gardee comme les autres : inutile d'y revenir a chaque fois.
    """
    cle = slug(nom)
    if not cle:
        return "", None
    garde = _APPID.get(cle)
    if garde and time.time() - garde[1] < DUREE_APPID:
        return garde[0], None

    fiches, souci = toutes_les_fiches(nom)
    if souci:
        return "", souci
    choix, _surete = retenue_pour(fiches, _annee(sortie))
    if not choix:
        return "", None
    appid, souci = boutique_steam(choix["id"])
    if souci:
        return "", souci
    _APPID[cle] = (appid, time.time())
    return appid, None


# --------------------------------------------------------------------------
#   Telechargement
# --------------------------------------------------------------------------
def telecharge(image, cible):
    """Ecrit la jaquette dans `cible`. Renvoie (ok, motif d'echec).

    Passage par un fichier temporaire : une coupure en cours de route
    laisserait sinon un .webp tronque, que le navigateur mettrait en cache.
    """
    if not re.fullmatch(r"[a-z0-9]+", image or "", re.I):
        return False, "identifiant d'image invalide"

    donnees, type_contenu, souci = _appelle(
        f"{IGDB_IMG}/{TAILLE}/{image}.webp", ENTETES_IMAGE, None, MAX_IMAGE + 1)
    if souci:
        return False, ("image absente d'IGDB" if souci == "absent" else souci)
    if not type_contenu.startswith("image/"):
        return False, f"IGDB a renvoye {type_contenu or 'un contenu inconnu'}"
    if not donnees:
        return False, "image vide"
    if len(donnees) > MAX_IMAGE:
        return False, "image trop lourde"

    temporaire = cible.with_name(cible.name + ".part")
    try:
        cible.parent.mkdir(parents=True, exist_ok=True)
        temporaire.write_bytes(donnees)
        os.replace(temporaire, cible)
        return True, ""
    except OSError as err:
        _dit(f"ecriture de {cible} -> {err}")
        return False, f"ecriture impossible ({err.strerror or err})"
    finally:
        if temporaire.exists():
            try:
                temporaire.unlink()
            except OSError:
                pass


# Ce qu'une proposition de jaquette emporte avec elle. Pas seulement de quoi
# l'afficher : « id » et « iso » servent au formulaire, qui realigne la date
# de sortie et le prix sur la fiche dont on vient de choisir l'image. Changer
# de jaquette, c'est souvent changer d'edition -- donc de date et de tarif.
CHAMPS_PROPOSITION = ("id", "titre", "date", "iso", "nature",
                      "derive", "image", "apercu", "lien")


# --------------------------------------------------------------------------
#   Les deux routes
# --------------------------------------------------------------------------
def blueprint_jaquettes(dossier, url_publique="/static/Cover/"):
    """Les huit routes du module :

      /api/jaquette          cherche les jaquettes possibles d'un nom
      /api/jaquette/choisir  telecharge celle qu'on a designee
      /api/jaquettes    GET  celles qui sont deja sur le disque, avec leur date
      /api/jeu/suggestions   complete le nom en cours de frappe
      /api/jeu/prix          le prix fort d'une fiche IGDB, via Steam
      /api/jeu/maj           tout ce qu'IGDB sait d'un jeu deja enregistre
      /api/wishlist/prix     le prix du jour des jeux convoites, promos comprises
      /api/decouverte        des jeux proches de ceux qu'on a le mieux notes
    """
    dossier = Path(dossier)
    if not url_publique.endswith("/"):
        url_publique += "/"
    bp = Blueprint("jaquettes", __name__)

    def _cible(nom):
        """Le fichier ou doit atterrir la jaquette, ou None si le nom ne
        donne rien d'ecrivable. Le nom vient du navigateur : on ne garde que
        des lettres, des chiffres et des tirets bas, jamais un chemin."""
        fichier = slug(nom)
        if not fichier or not re.fullmatch(r"[a-z0-9_]+", fichier):
            return None, None
        return dossier / (fichier + EXTENSION), fichier

    def _protege(nom_route, travail):
        """Execute `travail()` et renvoie son resultat JSON. Si quoi que ce
        soit leve une exception qu'on n'a pas prevue, elle finit quand meme
        en JSON lisible plutot qu'en page d'erreur Flask -- le navigateur ne
        recevrait alors qu'un « http 500 » sans un mot de plus. La trace
        complete part dans la console pour qu'on sache exactement quelle
        ligne a casse, la prochaine fois que ca arrive.
        """
        try:
            return travail()
        except Exception as err:                  # noqa: BLE001 - dernier filet
            _dit(f"{nom_route} : {type(err).__name__}: {err}")
            if BAVARD:
                traceback.print_exc()
            return jsonify(etat="injoignable", raison=f"{type(err).__name__}: {err}"[:160])

    @bp.route("/api/jaquette", methods=["POST"])
    def chercher():
        def travail():
            donnees = request.get_json(silent=True) or {}
            nom = str(donnees.get("nom") or "").strip()
            cible, fichier = _cible(nom)
            if not cible:
                return jsonify(etat="introuvable")
            # le bouton d'une tuile sans jaquette force la recherche : le
            # fichier peut exister alors que le navigateur garde un vieil
            # echec en cache
            if cible.is_file() and not donnees.get("force"):
                return jsonify(etat="deja-la", url=url_publique + fichier + EXTENSION)

            fiches, souci = candidats(nom)
            if souci:
                return jsonify(etat="injoignable", raison=souci)
            if not fiches:
                return jsonify(etat="introuvable")

            # rien ne part sur le disque avant un clic, meme quand il n'y a
            # qu'une seule fiche : la meilleure passe juste en tete de liste
            retenue = tranche(fiches, _annee(donnees.get("sortie")))
            if retenue:
                fiches = [retenue] + [f for f in fiches if f is not retenue]
            return jsonify(etat="choix", propositions=[
                dict({k: f[k] for k in CHAMPS_PROPOSITION},
                     suggere=(f is retenue and len(fiches) > 1))
                for f in fiches
            ])
        return _protege("chercher", travail)

    @bp.route("/api/jaquette/choisir", methods=["POST"])
    def choisir():
        def travail():
            donnees = request.get_json(silent=True) or {}
            nom = str(donnees.get("nom") or "").strip()
            cible, fichier = _cible(nom)
            if not cible:
                return jsonify(etat="introuvable")
            ecrit, souci = telecharge(str(donnees.get("image") or ""), cible)
            if ecrit:
                return jsonify(etat="telechargee", url=url_publique + fichier + EXTENSION)
            return jsonify(etat="injoignable", raison=souci)
        return _protege("choisir", travail)

    @bp.route("/api/jeu/suggestions", methods=["POST"])
    def propose():
        """La liste deroulante du champ « Nom du jeu ».

        Appelee a chaque frappe : elle ne touche ni au disque ni au cache
        du jeton, elle ne fait que relayer ce qu'IGDB repond.
        """
        def travail():
            donnees = request.get_json(silent=True) or {}
            fiches, souci = suggestions(str(donnees.get("nom") or ""))
            if souci:
                return jsonify(etat="injoignable", raison=souci)
            return jsonify(etat="ok", jeux=[
                {cle: fiche[cle] for cle in
                 ("id", "titre", "date", "iso", "annee", "nature",
                  "derive", "image", "apercu", "lien")}
                for fiche in fiches
            ])
        return _protege("suggestions", travail)

    @bp.route("/api/jeu/prix", methods=["POST"])
    def prix():
        """Ce que Steam demande pour cette fiche IGDB, en euros.

        Renvoie le prix fort (« prix », pour la colonne « Prix de base ») et
        celui du jour (« actuel », promotion comprise), qui sert a proposer
        le prix paye au moment de l'achat.

        « inconnu » n'est pas une erreur : le jeu n'est pas sur Steam, ou
        Steam n'annonce pas de tarif pour la France. La case du formulaire
        reste alors vide, a remplir a la main.
        """
        def travail():
            donnees = request.get_json(silent=True) or {}
            tarif, appid, souci = tarif_du_jeu(donnees.get("id"))
            if souci:
                return jsonify(etat="injoignable", raison=souci)
            if not tarif:
                return jsonify(etat="inconnu")
            # « prix » reste le prix fort, celui de la colonne « Prix de
            # base » : le nom ne bouge pas pour ne rien casser. « actuel »
            # est ce qu'on paierait aujourd'hui, promotion comprise, et sert
            # a proposer le prix paye au moment de l'achat.
            return jsonify(etat="ok", prix=tarif["plein"], appid=appid,
                           actuel=tarif["actuel"], remise=tarif["remise"])
        return _protege("prix", travail)

    @bp.route("/api/jeu/maj", methods=["POST"])
    def rafraichir():
        """Tout ce qu'IGDB sait d'un jeu deja enregistre, en un appel.

        Le menu des reglages passe ici pour chaque ligne du classeur. Une
        seule recherche IGDB sert aux deux besoins : identifier la fiche
        (pour la date et le prix) et lister les jaquettes possibles. Le
        prix coute deux appels de plus -- un a IGDB pour l'identifiant
        Steam, un a Steam pour le tarif -- donc il ne part que si la page
        l'a demande.

        Rien n'est ecrit ni telecharge ici : c'est un rapport. Le classeur
        est modifie par Apps Script, la jaquette par /api/jaquette/choisir,
        et dans les deux cas apres un clic.
        """
        def travail():
            donnees = request.get_json(silent=True) or {}
            nom = str(donnees.get("nom") or "").strip()
            veut_prix = bool(donnees.get("prix"))
            jaquettes = str(donnees.get("jaquettes") or "manquantes")

            cible, _fichier = _cible(nom)
            # « inconnue » : le nom ne donne aucun nom de fichier ecrivable,
            # donc la question de la jaquette ne se pose meme pas
            if not cible:
                jaquette = "inconnue"
            else:
                jaquette = "presente" if cible.is_file() else "absente"
            if not nom:
                return jsonify(etat="introuvable", jaquette=jaquette)

            fiches, souci = toutes_les_fiches(nom)
            if souci:
                return jsonify(etat="injoignable", raison=souci, jaquette=jaquette)
            if not fiches:
                return jsonify(etat="introuvable", jaquette=jaquette)

            choix, surete = retenue_pour(fiches, _annee(donnees.get("sortie")))

            # les jaquettes possibles, celle de la fiche retenue en tete :
            # c'est presque toujours la bonne, autant ne pas la faire
            # chercher au milieu des autres
            propositions = []
            if jaquettes != "aucune":
                propositions = _illustrees(fiches)
                if choix and choix["image"]:
                    propositions = ([choix] + [f for f in propositions if f is not choix]
                                    )[:PROPOSITIONS_MAX]

            valeur, appid, souci_prix = None, "", None
            if veut_prix and choix:
                valeur, appid, souci_prix = prix_du_jeu(choix["id"])

            return jsonify(
                etat="ok",
                jaquette=jaquette,
                surete=surete,
                fiche={cle: choix[cle] for cle in
                       ("id", "titre", "date", "iso", "annee", "nature",
                        "derive", "image", "apercu", "lien")},
                prix=valeur,
                appid=appid,
                # un prix injoignable n'annule pas la date : on le signale
                # sans transformer toute la ligne en echec
                prix_souci=souci_prix or "",
                propositions=[
                    dict({cle: f[cle] for cle in CHAMPS_PROPOSITION},
                         suggere=(i == 0 and len(propositions) > 1))
                    for i, f in enumerate(propositions)
                ],
            )
        return _protege("maj", travail)

    @bp.route("/api/decouverte", methods=["POST"])
    def decouverte():
        """Des jeux proches de ceux qu'on a le mieux notes.

        La page envoie quelques jeux tires parmi ses mieux notes, et la
        liste de ce qu'elle possede deja. On demande a IGDB ce qu'il juge
        proche de chacun, on retire ce qui est deja au classeur, et on
        renvoie le reste en gardant le jeu qui l'a suggere : c'est cette
        phrase, « parce que tu as mis 9,5 a X », qui fait la valeur de la
        reponse. Une suggestion sans sa raison n'est qu'une liste.

        Deux appels IGDB par jeu source, puis un seul pour toutes les fiches
        d'un coup. Le champ similar_games de chaque source est garde une
        semaine, donc les visites suivantes ne paient plus que la derniere
        requete.
        """
        def travail():
            donnees = request.get_json(silent=True) or {}
            sources = donnees.get("jeux")
            if not isinstance(sources, list):
                sources = []
            connus = {slug(str(nom or "")) for nom in (donnees.get("connus") or [])}

            # la premiere source qui propose un jeu en garde la paternite :
            # c'est elle qu'on nommera, et deux phrases pour un meme jeu
            # n'apporteraient rien
            venu_de = {}
            for source in sources[:DECOUVERTE_SOURCES]:
                if not isinstance(source, dict):
                    continue
                nom = str(source.get("nom") or "").strip()
                if not nom:
                    continue
                ids, souci = similaires_de(nom, source.get("sortie"))
                if souci:
                    continue       # une source muette n'annule pas les autres
                for numero in ids:
                    venu_de.setdefault(numero, source)

            fiches, souci = fiches_par_id(list(venu_de))
            if souci:
                return jsonify(etat="injoignable", raison=souci)

            suggestions = []
            for numero, fiche in fiches.items():
                if slug(fiche["titre"]) in connus:
                    continue                       # deja au classeur
                source = venu_de.get(numero) or {}
                suggestions.append(dict(
                    {cle: fiche[cle] for cle in
                     ("id", "titre", "date", "iso", "annee", "nature",
                      "derive", "image", "apercu", "lien")},
                    parce_que=str(source.get("nom") or ""),
                    note=source.get("note"),
                ))
            # les jeux illustres d'abord, les portages et DLC en dernier :
            # c'est une decouverte, pas un inventaire
            suggestions.sort(key=lambda f: (not f["image"], f["derive"]))
            return jsonify(etat="ok", suggestions=suggestions[:DECOUVERTE_MAX])
        return _protege("decouverte", travail)

    @bp.route("/api/wishlist/prix", methods=["POST"])
    def prix_convoites():
        """Le prix du jour des jeux convoites, promotions comprises.

        Un prix de wishlist ne peut pas etre range dans le classeur : il
        change tous les jours, et c'est justement la remise du moment qu'on
        veut voir. Il est donc demande a l'affichage, par paquets.

        Le chemin coute cher la premiere fois -- chercher la fiche IGDB,
        lire son lien Steam, demander le prix -- et presque rien ensuite :
        l'appid est garde un mois, le tarif six heures. La page peut donc
        rappeler cette route sans remords a chaque visite.

        Un jeu absent de la reponse est un jeu dont on ne sait rien dire :
        pas sur Steam, introuvable, ou Steam muet. La tuile reste alors
        telle quelle, sans pastille -- jamais un prix devine.
        """
        def travail():
            donnees = request.get_json(silent=True) or {}
            jeux = donnees.get("jeux")
            if not isinstance(jeux, list):
                jeux = []
            tarifs = {}
            for jeu in jeux[:WISHLIST_MAX]:
                if not isinstance(jeu, dict):
                    continue
                nom = str(jeu.get("nom") or "").strip()
                if not nom:
                    continue
                appid, souci = appid_du_nom(nom, jeu.get("sortie"))
                if souci or not appid:
                    continue
                tarif, souci = tarif_steam(appid)
                if souci or not tarif:
                    continue
                tarifs[nom] = dict(tarif, appid=appid)
            return jsonify(etat="ok", tarifs=tarifs)
        return _protege("prix wishlist", travail)

    @bp.route("/api/jaquettes", methods=["GET"])
    def manifeste():
        """Les jaquettes presentes sur le disque, avec leur horodatage.

        La page s'en sert pour savoir, avant de dessiner, quels jeux ont une
        image. Sans lui, un jeu sans jaquette demandait quand meme son
        fichier a chaque rendu : un 404 par tuile, et la case d'initiales
        qui n'apparaissait qu'apres l'echec reseau -- d'ou le clignotement.

        L'horodatage sert de numero de version dans l'adresse. Une jaquette
        remplacee sous le meme nom change de date, donc d'URL, et le cache
        du navigateur ne peut pas renvoyer l'ancienne. C'est plus juste
        qu'un compteur en memoire, qui repartait de zero a chaque F5.

        Une seule lecture de dossier, pas un stat() par jeu : scandir()
        rapporte deja la date avec le nom sur les systemes courants.
        """
        def travail():
            jaquettes = {}
            try:
                entrees = list(os.scandir(dossier))
            except OSError:
                # dossier absent : aucune jaquette, ce n'est pas une panne
                entrees = []
            for entree in entrees:
                if not entree.name.lower().endswith(EXTENSION):
                    continue
                try:
                    if not entree.is_file():
                        continue
                    horodatage = int(entree.stat().st_mtime * 1000)
                except OSError:
                    continue        # fichier disparu entre-temps : on l'ignore
                jaquettes[entree.name[: -len(EXTENSION)]] = horodatage
            reponse = jsonify(etat="ok", jaquettes=jaquettes)
            # il change des qu'une jaquette arrive : jamais de version en cache
            reponse.headers["Cache-Control"] = "no-store"
            return reponse
        return _protege("manifeste", travail)

    return bp


# --------------------------------------------------------------------------
#   Diagnostic : python jaquettes.py "Nom du jeu"
# --------------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    import tempfile

    nom_jeu = " ".join(a for a in sys.argv[1:] if not a.startswith("-")) or "Hollow Knight"
    cid_vu, _ = identifiants()
    print(f"\n  jeu          : {nom_jeu}")
    print(f"  fichier      : {slug(nom_jeu)}{EXTENSION}")
    print(f"  identifiants : {'oui (' + cid_vu[:6] + '...)' if cid_vu else 'ABSENTS'}")

    if not cid_vu:
        print(f"\n  Cree {FICHIER_IDENTIFIANTS} :")
        print('    { "client_id": "...", "client_secret": "..." }')
        print("\n  Les deux se recuperent sur https://dev.twitch.tv/console/apps")
        print("  (Register Your Application -> Client ID, puis New Secret).\n")
        sys.exit(1)

    acces, probleme = jeton()
    print(f"  jeton        : {'ok' if acces else 'ECHEC — ' + probleme}\n")
    if not acces:
        sys.exit(1)

    trouvees, probleme = candidats(nom_jeu)
    if probleme:
        print(f"  ECHEC : {probleme}\n")
        sys.exit(1)
    if not trouvees:
        print("  IGDB ne connait aucun jeu de ce nom (ou aucun avec jaquette).\n")
        sys.exit(1)

    meilleure = tranche(trouvees, None)
    for fiche in trouvees:
        marques = []
        if fiche is meilleure:
            marques.append("suggeree")
        if fiche["exact"]:
            marques.append("titre exact")
        if fiche["nature"]:
            marques.append(fiche["nature"])
        suffixe = "  (" + ", ".join(marques) + ")" if marques else ""
        print(f"  - {fiche['titre']}  [{fiche['date'] or 'date inconnue'}]{suffixe}")
        print(f"    {IGDB_IMG}/{TAILLE}/{fiche['image']}.webp")

    # La recherche passe par api.igdb.com, le telechargement par
    # images.igdb.com : deux adresses differentes, deux resolutions DNS
    # differentes. Un pare-feu, un filtre DNS ou un blip reseau peut tres
    # bien laisser passer l'une et bloquer l'autre -- la recherche qui
    # marche ne garantit donc rien sur le telechargement. On teste les
    # deux ici, avec exactement le code que la page appelle.
    # le prix ne vient pas d'IGDB mais de store.steampowered.com : encore une
    # adresse de plus, donc encore une facon de tomber en panne toute seule
    retenue = meilleure or trouvees[0]
    print(f"\n  test du prix ({retenue['titre']})...")
    valeur, appid, probleme = prix_du_jeu(retenue["id"])
    if probleme:
        print(f"  prix           : ECHEC — {probleme}")
    elif not appid:
        print("  prix           : pas de fiche Steam (exclusivite console, jeu physique...)")
    elif valeur is None:
        print(f"  prix           : Steam (app {appid}) n'annonce aucun tarif pour la France")
    else:
        print(f"  prix           : {valeur:.2f} EUR  (Steam, app {appid})")

    cible = Path(tempfile.gettempdir()) / "jaquettes-diagnostic.webp"
    print(f"\n  test de telechargement ({retenue['titre']})...")
    ecrit, probleme = telecharge(retenue["image"], cible)
    if ecrit:
        poids = cible.stat().st_size
        print(f"  telechargement : ok ({poids // 1024} Ko -> {cible})\n")
        cible.unlink(missing_ok=True)
    else:
        print(f"  telechargement : ECHEC — {probleme}")
        print("\n  La recherche passe par api.igdb.com, ce test par images.igdb.com :")
        print("  ce sont deux adresses differentes, donc deux resolutions DNS")
        print("  differentes. Si la recherche marche mais pas ce test, le souci")
        print("  vise precisement images.igdb.com sur cette machine (pare-feu,")
        print("  filtre DNS, VPN...), pas IGDB en general.\n")
        sys.exit(1)