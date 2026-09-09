#!/usr/bin/env python3

from pathlib import Path
import argparse
import os
import socket

from flask import Flask, abort, jsonify, redirect, request, send_from_directory
from flask_socketio import SocketIO
from werkzeug.middleware.proxy_fix import ProxyFix

import collection
import comptes
import journal
import monitoring
import quiz
import social
import yugiquiz
from jaquettes import blueprint_jaquettes
from monitoring import blueprint_monitoring
from suggestions import blueprint_suggestions

BASE = Path(__file__).parent.resolve() # le dossier du projet
STATIQUE = (BASE / "static").resolve() # images, css, json
TEMPLATES = (BASE / "templates").resolve() # les pages html
DONNEES = (BASE / "donnees").resolve() # la base sqlite : jamais servie
ACCUEIL = "Abyss.html"
PROFIL = "profil.html"
JEUX_VIDEOS = "jeux-videos.html"
COLLECTION = "collection-yugioh.html"
SUGGESTIONS = "suggestions.html"
MONITORING = "monitoring.html"
QUIZ = "quiz.html"
FEED = "archive-feed.html"
# La cle qui signe les cookies de session Flask. Elle ne sert qu'au pseudo
# d'invite du Yu-Gi-Quiz : les comptes Abyss, eux, ont leur propre cookie et
# leur table de sessions (voir comptes.COOKIE). Gardee dans donnees/, qui
# n'est jamais servi -- sinon elle changerait a chaque redemarrage et
# deconnecterait les invites en cours de partie.
CLE_SECRETE = DONNEES / "cle_secrete"

# On ne sert QUE static/ et templates/. Servir BASE revenait a publier le
# dossier du projet : http://<ip>:8000/app.py renvoyait ce fichier.
# Avec --reseau, a tout le wifi.
# donnees/ n'est volontairement pas dans cette liste : la base contient les
# empreintes de mots de passe.
DOSSIERS = (STATIQUE, TEMPLATES)

# images/artworks : jamais modifiees une fois ajoutees, autant laisser le
# navigateur les garder en cache (sinon chaque affichage retelecharge tout,
# et un defilement rapide sature les connexions HTTP disponibles)
EXTENSIONS_CACHABLES = {".jpg", ".jpeg", ".png", ".webp", ".gif",
                        ".svg", ".ico", ".woff2", ".woff"}
# 24 h : assez pour qu'un defilement rapide ne retelecharge rien, assez court
# pour qu'une jaquette remplacee sous le meme nom finisse par reapparaitre.
# Monte a 31536000 (un an) le jour ou les images ne bougent plus du tout.
DUREE_CACHE = 86400

app = Flask(__name__, static_folder=None) # on gere les fichiers nous-memes


def cle_secrete() -> str:
    """La cle de signature des cookies de session. Creee au premier besoin.

    ABYSS_SECRET_KEY la fixe en production ; sinon un fichier de 64 caracteres
    dans donnees/, en lecture pour son seul proprietaire. Une cle tiree a
    chaque demarrage marcherait tout aussi bien pour Flask, mais viderait les
    pseudos d'invite du quiz a chaque redemarrage -- et un redemarrage, en
    developpement, arrive a chaque sauvegarde de fichier.
    """
    depuis_env = os.environ.get("ABYSS_SECRET_KEY", "").strip()
    if depuis_env:
        return depuis_env
    if CLE_SECRETE.is_file():
        return CLE_SECRETE.read_text(encoding="utf-8").strip()
    CLE_SECRETE.parent.mkdir(parents=True, exist_ok=True)
    valeur = os.urandom(32).hex()
    CLE_SECRETE.write_text(valeur, encoding="utf-8")
    os.chmod(CLE_SECRETE, 0o600)
    return valeur


app.secret_key = cle_secrete()

# Le seul coin du site qui pousse quelque chose vers les pages au lieu
# d'attendre qu'elles demandent : le Yu-Gi-Quiz, ou une carte tombe pour tout
# le monde en meme temps. Il vivait sur un second serveur, port 5000, lance en
# sous-processus -- donc une autre origine, d'autres cookies, et un pseudo a
# retaper alors qu'on venait de traverser un site ou l'on est connecte. Il est
# maintenant ici, sur le meme port et avec la meme session.
#
# async_mode='threading' : le serveur de developpement de Flask suffit, et
# c'est ce qui permet de ne rien changer au reste du site (pas de monkey
# patching eventlet/gevent, qui casserait sqlite3 et requests). En ligne
# derriere gunicorn, il faut alors un worker compatible -- voir le bloc de
# lancement en bas de fichier.
socketio = SocketIO(app, async_mode="threading",
                    ping_timeout=20, ping_interval=25)

# Derriere Caddy ou Nginx, request.remote_addr vaut 127.0.0.1 pour tout le
# monde : la limitation de debit compterait les essais de tous les visiteurs
# dans le meme seau, et request.is_secure serait toujours faux, donc le
# cookie ne serait jamais marque Secure. ProxyFix relit X-Forwarded-*.
# A n'activer QUE derriere un proxy de confiance : sans lui, n'importe qui
# peut se declarer a l'adresse qu'il veut.
if os.environ.get("ABYSS_PROXY", "").strip() in ("1", "oui", "true"):
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 # aucune de nos routes n'envoie plus

# La base est creee a l'import, pas dans le bloc __main__ : sous gunicorn,
# ce bloc ne s'execute jamais.
comptes.init()
monitoring.menage()          # les visites d'il y a quatre mois ne servent plus

app.register_blueprint(comptes.blueprint_comptes)
app.register_blueprint(journal.blueprint_journal)
app.register_blueprint(collection.branche(STATIQUE / "Cards",
                                          STATIQUE / "cards_fr.json"))
app.register_blueprint(blueprint_jaquettes(STATIQUE / "Cover"))
app.register_blueprint(blueprint_suggestions)
app.register_blueprint(social.blueprint_social)
# Le temps reel du Social se branche sur le meme serveur SocketIO que le
# Yu-Gi-Quiz, sur son propre namespace : un jeu termine apparait dans le fil
# et une pastille de cloche bouge sans qu'on recharge. Voir social.NS.
social.branche_temps_reel(socketio)
app.register_blueprint(blueprint_monitoring)
app.register_blueprint(quiz.branche(STATIQUE / "Cover"))
# Deux blueprints, les pages et leur API : voir yugiquiz.branche.
for bp in yugiquiz.branche(socketio):
    app.register_blueprint(bp)


@app.after_request
def note_la_visite(r):
    """Compte la visite, si c'en est une. Voir monitoring.note.

    Apres la reponse et non avant : on ne note que ce qui a reellement ete
    servi. Une redirection, une erreur ou un fichier statique n'ont rien a
    faire dans un compteur de pages vues, et monitoring.note les ecarte.
    """
    monitoring.note(request, r.status_code)
    return r

# --------------------------------------------------------------------------
#   Envoi des fichiers
# --------------------------------------------------------------------------
def cibles(chemin: str):
    """Ou chercher `chemin`, dans l'ordre.

    /static/Cards/123.jpg  ->  static/Cards/123.jpg
    /collection-yugioh.html ->  templates/collection-yugioh.html
    """
    if chemin.startswith("static/"):
        yield STATIQUE, chemin[len("static/"):]
        return
    yield TEMPLATES, chemin
    yield STATIQUE, chemin # tolerance : /style.css trouve aussi dans static/


def envoie(chemin):
    """Sert un fichier de static/ ou de templates/. Refuse tout le reste."""
    if any(bout.startswith(".") for bout in chemin.split("/")):
        abort(404)

    for dossier, relatif in cibles(chemin):
        try:
            cible = (dossier / relatif).resolve()
            cible.relative_to(dossier) # leve ValueError si on sort du dossier
        except (ValueError, OSError):
            continue

        if cible.is_dir():
            cible = cible / "index.html"

        if cible.is_file():
            reponse = send_from_directory(dossier, cible.relative_to(dossier).as_posix())
            if cible.suffix.lower() in EXTENSIONS_CACHABLES:
                # une image ne change pas : la redemander a chaque affichage
                # saturait les 6 connexions que Chrome accorde par origine
                reponse.headers["Cache-Control"] = f"public, max-age={DUREE_CACHE}"
            else:
                # pages et scripts : F5 et tu vois tout de suite tes modifs
                reponse.headers["Cache-Control"] = "no-store, max-age=0"
            return reponse

    abort(404)

# --------------------------------------------------------------------------
#   Pages
# --------------------------------------------------------------------------
# Une seule adresse pour le hub : /abyss. La racine y mene, et /Abyss.html
# aussi, pour que les liens et marque-pages d'avant continuent de marcher.
@app.route("/")
def racine():
    return redirect("/abyss", code=301)

@app.route("/Abyss.html")
def ancien_abyss():
    return redirect("/abyss", code=301)

@app.route("/abyss")
def accueil():
    return envoie(ACCUEIL)

# Meme principe pour les trois autres pages : une adresse propre, et
# l'ancien nom en .html qui redirige dessus plutot que de casser un
# marque-page. /abyss/profil est sous /abyss : c'est une page du hub,
# pas un projet a cote.
@app.route("/profil.html")
def ancien_profil():
    return redirect("/abyss/profil", code=301)

@app.route("/abyss/profil")
def profil():
    return envoie(PROFIL)

# La page est servie a tout le monde ; c'est l'API qu'elle interroge qui
# repond 404 a qui n'est pas admin. Garder la page ouverte evite un
# deuxieme controle d'acces a tenir, celui qui compte etant cote donnees.
@app.route("/abyss/suggestions")
def page_suggestions():
    return envoie(SUGGESTIONS)

# Meme principe : la page est servie a tout le monde, /api/monitoring repond
# 404 a qui n'est pas admin.
@app.route("/abyss/monitoring")
def page_monitoring():
    return envoie(MONITORING)

@app.route("/jeux-videos.html")
def ancien_archive():
    return redirect("/archive", code=301)

# strict_slashes=False sur les deux : un lien recopie a la main finit
# souvent par une barre oblique, et /archive/Jokrem/ ne doit pas etre une
# page introuvable. La page remet l'adresse au propre elle-meme une fois
# chargee (voir majAdresse).
@app.route("/archive", strict_slashes=False)
def archive():
    return envoie(JEUX_VIDEOS)

# Declaree avant /archive/<pseudo>, et surtout distincte de lui : Werkzeug
# fait passer une regle en dur avant une regle a variable, donc l'ordre
# n'est ici qu'une politesse de lecture -- mais personne ne pourra plus
# prendre « feed » comme pseudo sans se voler sa propre page.
@app.route("/archive/feed", strict_slashes=False)
def archive_feed():
    return envoie(FEED)


@app.route("/archive/<pseudo>", strict_slashes=False)
def archive_de(pseudo):
    """Le journal de quelqu'un, a une adresse qu'on peut donner.

    C'est la meme page : elle lit le pseudo dans l'adresse et ouvre le bon
    journal, meme chez qui n'a pas de compte -- c'est tout l'interet d'un
    lien qu'on partage.

    Rien n'est verifie ici, et `pseudo` n'est meme pas regarde. Un journal
    prive ou un pseudo inconnu, c'est /api/journal/<pseudo> qui le dit, et
    la page sait l'afficher. Repondre 404 depuis ici demanderait de relire
    la base a chaque chargement de page, et surtout confirmerait au passage
    quels comptes existent, un essai a la fois.
    """
    return envoie(JEUX_VIDEOS)

# Ouverte a tout le monde, page et API : les jeux sont finis, et jouer avec
# les journaux publics ne demande pas de compte. Un compte n'ajoute qu'une
# chose -- le choix de jouer avec son propre journal.
@app.route("/quiz")
def page_quiz():
    return envoie(QUIZ)

@app.route("/collection-yugioh.html")
def ancienne_collection():
    return redirect("/collection", code=301)

@app.route("/collection", strict_slashes=False)
def page_collection():
    return envoie(COLLECTION)

@app.route("/collection/<pseudo>", strict_slashes=False)
def collection_de(pseudo):
    """Le classeur de quelqu'un, a une adresse qu'on peut donner.

    Meme principe que /archive/<pseudo> : c'est la meme page, elle lit le
    pseudo dans l'adresse et ouvre le bon classeur. Rien n'est verifie ici --
    un classeur prive ou un pseudo inconnu, c'est /api/collection/<pseudo>
    qui le dit, et repondre 404 depuis ici confirmerait au passage quels
    comptes existent, un essai a la fois.
    """
    return envoie(COLLECTION)

@app.route("/<path:chemin>")
def fichier(chemin):
    return envoie(chemin)

@app.errorhandler(404)
@app.errorhandler(403)
def introuvable(err):
    # Une requete API qui recoit du HTML casse le `await r.json()` d'en face
    # avec un message incomprehensible : on repond dans la langue demandee.
    if request.path.startswith("/api/"):
        r = jsonify({"ok": False, "erreur": "introuvable",
                     "message": "Cette adresse n'existe pas."})
        r.status_code = err.code
        r.headers["Cache-Control"] = "no-store, max-age=0"
        return r

    page = f"""<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<title>Abyss - 404</title>
<style>
  body{{margin:0;min-height:100vh;display:grid;place-items:center;text-align:center;
       background:linear-gradient(180deg,#0B1524,#060C15 38%,#03060B);
       color:#DCE8F0;font-family:system-ui,sans-serif}}
  h1{{font-size:clamp(38px,9vw,72px);letter-spacing:.11em;text-transform:uppercase;margin:0;
     background:linear-gradient(180deg,#EEF7FC,#89B4CE 52%,#2E4E66);
     -webkit-background-clip:text;background-clip:text;color:transparent}}
  p{{color:#72899D}}
  a{{color:#5B9BF5}}
</style></head><body><div>
  <h1>{err.code}</h1>
  <p>Perdu dans l'Abyss...</p>
  <p><a href="/abyss">&#8592; Retour a l'abysse</a></p>
</div></body></html>"""
    return page, err.code

@app.errorhandler(413)
def trop_lourd(err):
    # Depuis l'avatar, une requete peut depasser MAX_CONTENT_LENGTH avant
    # meme d'atteindre la route : sans ce gestionnaire, Werkzeug renvoyait
    # sa page HTML par defaut, illisible pour un `await r.json()`.
    r = jsonify({"ok": False, "erreur": "trop_lourd",
                 "message": "Ce fichier est trop volumineux."})
    r.status_code = 413
    r.headers["Cache-Control"] = "no-store, max-age=0"
    return r

def ip_locale():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()

# --------------------------------------------------------------------------
#   Lancement
# --------------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hub Abyss")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    print(f"  Abyss : http://127.0.0.1:{args.port}/abyss")
    print(f"  Reseau: http://{ip_locale()}:{args.port}/abyss")
    print(f"  Base  : {comptes.CHEMIN}")
    # socketio.run et non app.run : c'est le meme serveur de developpement
    # Werkzeug, avec en plus la voie WebSocket du Yu-Gi-Quiz.
    #
    # En ligne, gunicorn : `gunicorn -k gthread -w 1 --threads 8 app:app`.
    # Un seul worker, et c'est une contrainte du quiz, pas un oubli -- les
    # salles vivent en memoire (voir yugiquiz), deux workers ne verraient
    # donc pas les memes. Le jour ou il en faudra plusieurs, il faudra un
    # gestionnaire de messages (Redis) et sortir les salles de la memoire.
    socketio.run(app, host="0.0.0.0", port=args.port, debug=False,
                 allow_unsafe_werkzeug=True)
