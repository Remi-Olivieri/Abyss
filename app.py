#!/usr/bin/env python3

from pathlib import Path
import argparse
import atexit
import os
import socket
import subprocess
import sys

from flask import Flask, abort, jsonify, redirect, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

import comptes
import journal
from jaquettes import blueprint_jaquettes

BASE = Path(__file__).parent.resolve() # le dossier du projet
STATIQUE = (BASE / "static").resolve() # images, css, json
TEMPLATES = (BASE / "templates").resolve() # les pages html
DONNEES = (BASE / "donnees").resolve() # la base sqlite : jamais servie
ACCUEIL = "Abyss.html"
PROFIL = "profil.html"
JEUX_VIDEOS = "jeux-videos.html"
COLLECTION = "collection-yugioh.html"
YUGIQUIZ = BASE / "yugiquiz" / "yugiquiz.py"
PORT_YUGIQUIZ = 5000

# On ne sert QUE static/ et templates/. Servir BASE revenait a publier le
# dossier du projet : http://<ip>:8000/app.py renvoyait ce fichier, et
# /yugiquiz/yugiquiz.py celui du quiz. Avec --reseau, a tout le wifi.
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

app.register_blueprint(comptes.blueprint_comptes)
app.register_blueprint(journal.blueprint_journal)
app.register_blueprint(blueprint_jaquettes(STATIQUE / "Cover"))

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

@app.route("/jeux-videos.html")
def ancien_archive():
    return redirect("/archive", code=301)

@app.route("/archive")
def archive():
    return envoie(JEUX_VIDEOS)

@app.route("/collection-yugioh.html")
def ancienne_collection():
    return redirect("/collection", code=301)

@app.route("/collection")
def collection():
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
<title>Perdu dans l'abysse</title>
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
  <p>Ce fichier n'existe pas dans le dossier du hub.</p>
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

# --------------------------------------------------------------------------
#   Yu-Gi-Quiz
# --------------------------------------------------------------------------
def lance_yugiquiz():
    """Demarre yugiquiz/yugiquiz.py en sous-processus (serveur independant, port 5000)."""
    if not YUGIQUIZ.is_file():
        print(f"  !! {YUGIQUIZ} introuvable : Yu-Gi-Quiz ne sera pas lance")
        return None

    env = os.environ.copy()
    env["YUGIQUIZ_NO_RELOAD"] = "1" # un seul processus, pour pouvoir l'arreter proprement
    processus = subprocess.Popen(
        [sys.executable, str(YUGIQUIZ)], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return processus

def arrete_yugiquiz(processus):
    if processus is None or processus.poll() is not None:
        return
    processus.terminate()
    try:
        processus.wait(timeout=5)
    except subprocess.TimeoutExpired:
        processus.kill()

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
    parser.add_argument("--sans-quiz", action="store_true",
                        help="ne pas demarrer le Yu-Gi-Quiz")
    args = parser.parse_args()

    processus_quiz = None if args.sans_quiz else lance_yugiquiz()
    if processus_quiz:
        atexit.register(arrete_yugiquiz, processus_quiz)

    print(f"  Abyss : http://127.0.0.1:{args.port}/abyss")
    print(f"  Base  : {comptes.CHEMIN}")
    # Ce serveur est celui de developpement : en ligne, passe par gunicorn
    # derriere Caddy ou Nginx (voir les notes de deploiement).
    try:
        app.run(host="0.0.0.0", port=args.port, debug=False)
    finally:
        arrete_yugiquiz(processus_quiz)