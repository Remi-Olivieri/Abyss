#!/usr/bin/env python3
"""Yu-Gi-Quiz! : deviner une carte a son seul artwork, a plusieurs.

Une salle, des duellistes, une carte a la fois : le premier qui ecrit le bon
nom marque, et la premiere personne au score demande gagne. Tout se passe en
temps reel, d'ou le SocketIO -- c'est le seul coin du site qui pousse quelque
chose vers les pages plutot que d'attendre qu'elles demandent.

CE QUI A CHANGE EN ARRIVANT ICI. Le quiz etait un second serveur Flask, sur
le port 5000, lance en sous-processus par le hub et rejoint par un lien
externe. Il partageait deja les artworks et les fichiers de noms de static/,
mais rien d'autre -- surtout pas la session : arriver sur le quiz, c'etait
retaper un pseudo alors qu'on venait de traverser un site ou l'on est
connecte. Deux serveurs, deux origines, deux identites pour la meme
personne.

Il est desormais un blueprint du hub, sur le meme port que le reste :

  - QUI JOUE vient du compte Abyss quand il y en a un (voir `pseudo`). La
    page de connexion ne s'affiche donc plus pour qui est connecte, et le
    pseudo suit le compte -- le renommer renomme le duelliste ;
  - QUI N'A PAS DE COMPTE garde l'ancienne porte : un pseudo tape a la main,
    range dans la session Flask signee. Un quiz « seul ou avec des amis » ne
    peut pas exiger un compte de chaque ami. Ce pseudo d'invite ne peut pas
    etre celui d'un compte existant, sans quoi n'importe qui pourrait se
    presenter sous le nom de n'importe qui ;
  - LE SOCKET arrive avec les memes cookies que la page, puisque c'est la
    meme origine. Il n'y a plus de CORS a ouvrir, et plus de port a exposer.

L'identite d'un joueur, ici, c'est son pseudo -- les salles, les scores et
les verrous sont indexes dessus. C'est ce qui rend le controle sur les
pseudos d'invite necessaire, et ce qui explique PSEUDOS : une fois la
connexion socket etablie, on fige qui elle est. Sans quoi une session Abyss
qui expire en pleine partie ferait disparaitre un joueur du milieu de sa
propre salle.

Tout l'etat des parties vit en memoire (`rooms`, `game_states`) : un
redemarrage vide les salles, et c'est tres bien -- une partie de quiz ne se
reprend pas trois jours plus tard.
"""

from pathlib import Path

from flask import (Blueprint, jsonify, redirect, render_template, request,
                   send_from_directory, session, url_for)
from flask_socketio import emit, join_room, leave_room
import os
import random
import threading
import time
import datetime
import json
import unicodedata
import re
import uuid

import comptes

BASE = Path(__file__).parent.resolve()
# les artworks (Cards/CardsCropped) et les fichiers de noms sont partages avec
# le reste d'Abyss (la Collection Yu-Gi-Oh! s'en sert aussi) : un seul dossier
# static/ a la racine du projet, pas de copie par sous-projet.
STATIC = BASE / "static"

# Deux blueprints, comme partout ailleurs sur le site : les pages sous
# /yugiquiz, ce qu'elles demandent sous /api/yugiquiz. La separation n'est pas
# cosmetique -- app.py repond en JSON, et non par la page 404 en HTML, a tout
# ce qui commence par /api/.
blueprint_yugiquiz = Blueprint("yugiquiz", __name__, url_prefix="/yugiquiz")
blueprint_api = Blueprint("yugiquiz_api", __name__, url_prefix="/api/yugiquiz")

# Pose par branche(), au demarrage. Les emissions spontanees en ont besoin :
# la boucle de jeu et les minuteries tournent hors requete, elles ne peuvent
# pas remonter jusqu'au serveur par le contexte.
socketio = None

# Les gestionnaires d'evenements socket, ranges a la declaration et poses sur
# le serveur par branche(). Le serveur appartient a app.py -- ce module ne le
# connait qu'au demarrage, donc trop tard pour un decorateur.
_EVENEMENTS = {}


def sur(nom):
    """Declare un gestionnaire d'evenement socket. Voir _EVENEMENTS."""
    def pose(fonction):
        _EVENEMENTS[nom] = fonction
        return fonction
    return pose


def branche(sio):
    """Donne au module le serveur SocketIO du hub, et rend ses deux blueprints.

    Meme facon de faire que quiz.branche ou blueprint_jaquettes : ce qui
    appartient a l'application est decide dans app.py, pas ici.
    """
    global socketio
    socketio = sio
    for nom, fonction in _EVENEMENTS.items():
        sio.on_event(nom, fonction)
    return (blueprint_yugiquiz, blueprint_api)


# --------------------------------------------------------------------------
#   L'etat des parties, en memoire
# --------------------------------------------------------------------------
list_cards = os.listdir(STATIC / "Cards")

# Salles { room_id: { id, name, status, players: [{pseudo, sid, ready}], ... } }
rooms = {}
# Timer de lancement { room_id: threading.Timer }
launch_timers = {}
# Timers de deconnexion differee { (pseudo, sid): threading.Timer }
disconnect_timers = {}
# Parties actives { room_id: { current_image, next_image, date_last, scores } }
game_states = {}

# Qui est derriere une connexion socket { sid: pseudo }. Fige a la connexion :
# voir l'en-tete du fichier.
PSEUDOS = {}

# La cle du pseudo d'invite dans la session Flask. Prefixee : la session est
# partagee avec tout le hub, et un jour une autre page y rangera autre chose.
CLE_INVITE = "yugiquiz_invite"

TIME_DEFAULT = 10
SCORE_DEFAULT = 20

TIME_DISCONNECT = 5

# Tout l'etat des parties (rooms, game_states, launch_timers) est touche par
# trois sortes de threads : les gestionnaires socket, la boucle de jeu, et les
# minuteries de lancement et de deconnexion. Il ne l'etait par aucun verrou --
# deux `del rooms[id]` qui se croisent, ou un score lu dans une salle qu'on
# vient de supprimer, et c'est une KeyError dans un thread que personne ne
# regarde. RLock et non Lock : _join_room appelle check_all_ready, qui le
# reprend.
VERROU = threading.RLock()

# Ce qu'une salle a le droit de demander. La page propose des <select> fermes,
# mais un emit fabrique a la main n'a pas de <select> : `time` valait ce qu'on
# voulait -- y compris "abc", qui faisait tomber le gestionnaire sans un mot
# (l'utilisateur cliquait, il ne se passait rien), ou une difficulte inconnue,
# qui laissait la salle marquee « en jeu » sans partie derriere, bloquee pour
# de bon.
TEMPS_MIN, TEMPS_MAX = 3, 60
SCORE_MIN, SCORE_MAX = 1, 200
LONG_NOM_SALLE = 24
LONG_MDP_SALLE = 64
LONG_REPONSE = 80

# Ce qui separe la fin du decompte de la revelation. Le joueur decompte de son
# cote et envoie sa reponse en arrivant a zero : sans cette marge, le seul
# temps d'aller du message suffirait a la faire refuser.
DELAI_GRACE = 1.0
# Ce que dure l'affichage de la reponse avant la carte suivante. Les deux font
# les cinq secondes que la boucle attendait deja.
DUREE_REVELATION = 4.0

DIFFICULTY_THRESHOLDS = {
    "1": 200000,  # Facile
    "2": 50000,   # Normal
    "3": 25000,   # Difficile
    "4": 0        # Toutes
}


# --------------------------------------------------------------------------
#   Qui joue
# --------------------------------------------------------------------------
def _resout_pseudo():
    """Le compte Abyss s'il y en a un, sinon le pseudo d'invite. None sinon.

    Le compte passe AVANT l'invite, et pas l'inverse : quelqu'un qui a joue
    en invite puis s'est connecte doit redevenir lui-meme, pas rester sous
    le nom de passage qu'il s'etait donne.
    """
    u = comptes.actuel()
    if u is not None:
        return u["pseudo"]
    invite = session.get(CLE_INVITE)
    return invite if isinstance(invite, str) and invite else None


def pseudo_courant():
    """Qui joue, pour la requete ou l'evenement socket en cours.

    Sur un socket, la reponse est figee a la premiere question et gardee :
    une session Abyss qui expire en pleine partie ne doit pas faire
    disparaitre un joueur du milieu de sa salle -- et cela evite au passage
    une lecture en base a chaque evenement.
    """
    sid = getattr(request, "sid", None)
    if sid is not None and sid in PSEUDOS:
        return PSEUDOS[sid]
    p = _resout_pseudo()
    if sid is not None and p:
        PSEUDOS[sid] = p
    return p


# Ce qu'un invite a le droit de se donner comme nom. Plus large que
# comptes.MOTIF_PSEUDO (l'espace passe, et un seul caractere suffit), mais
# ferme sur tout ce qui n'est ni lettre, ni chiffre, ni ponctuation douce :
# un pseudo finit dans du texte de page, et rien n'oblige a y accepter des
# chevrons.
MOTIF_INVITE = re.compile(r"^[\w .'-]{1,20}$", re.UNICODE)


def pseudo_libre(voulu):
    """Le pseudo d'invite, verifie, ou None s'il ne convient pas.

    Refuse ce qui appartient a un compte : ici, l'identite d'un joueur EST
    son pseudo (les scores, les salles et les verrous sont indexes dessus).
    Sans ce controle, il suffirait de taper le pseudo de quelqu'un pour se
    presenter sous son nom -- et, en salle, pour recuperer ses points.

    Ce qui n'est PAS verifie ici, et ne l'a jamais ete : deux invites peuvent
    se donner le meme pseudo. Dans une meme salle ils se confondraient en un
    seul joueur, scores compris. C'est une limite d'avant, laissee telle
    quelle -- la corriger demande de decider ce qui identifie un invite, et
    ce n'est plus une question de nom.
    """
    voulu = " ".join((voulu or "").split())      # pas de blancs en rafale
    if not MOTIF_INVITE.match(voulu):
        return None
    if comptes.par_pseudo(voulu) is not None:
        return None
    return voulu


def normalize(text):
    text = text.lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^a-z0-9 ]", " ", text)
    return text.strip()

with open(STATIC / "cards_fr.json", encoding="utf-8") as f:
    cards_fr = json.load(f)
with open(STATIC / "cards_en.json", encoding="utf-8") as f:
    cards_en = json.load(f)
with open(STATIC / "cards_views.json", encoding="utf-8") as f:
    cards_views = json.load(f)
    
# Une carte n'est jouable que si ses DEUX images existent : l'artwork
# recadre pour la deviner, la carte entiere pour la reveler. Le vivier ne
# regardait que Cards/ -- un recadrage manquant donnait une manche a deviner
# sur une image cassee, donc impossible.
list_cards_set = set(list_cards) & set(os.listdir(STATIC / "CardsCropped"))
id_to_name_fr = {str(card_id): nom_fr for card_id, nom_fr in cards_fr.items() if nom_fr}

CARD_POOLS = {}
for diff, threshold in DIFFICULTY_THRESHOLDS.items():
    if threshold == 0:
        pool = [cid for cid in id_to_name_fr if f"{cid}.jpg" in list_cards_set]
    else:
        pool = [
            cid for cid in id_to_name_fr
            if f"{cid}.jpg" in list_cards_set
            and cards_views.get(cards_en.get(cid, ''), 0) >= threshold
        ]
    CARD_POOLS[diff] = pool if pool else list(id_to_name_fr.keys())

CARD_INDEX = []
for card_id, nom_fr in cards_fr.items():
    if not nom_fr:
        continue
    nom_en = cards_en.get(str(card_id), "")
    CARD_INDEX.append({
        "fr_norm": normalize(nom_fr),
        "en_norm": normalize(nom_en),
        "display": nom_fr,
    })

def room_summary(room):
    return {
        "id": room["id"],
        "name": room["name"],
        "status": room["status"],
        "players": len(room["players"]),
        "private": bool(room.get("password")),
        "time": room.get("time", 15),
        "score_to_win": room.get("score_to_win", 30),
        "difficulty": room.get("difficulty", "2")
    }

def room_detail(room):
    return {
        "id": room["id"],
        "name": room["name"],
        "status": room["status"],
        "players": [{"pseudo": p["pseudo"], "ready": p["ready"]} for p in room["players"]],
        "time": room.get("time", 15),
        "score_to_win": room.get("score_to_win", 30),
        "difficulty": room.get("difficulty", "2")
    }

def broadcast_rooms():
    socketio.emit('roomsList', {'rooms': [room_summary(r) for r in rooms.values()]})

def broadcast_room_update(room_id):
    if room_id not in rooms:
        return
    socketio.emit('roomUpdated', {'room': room_detail(rooms[room_id])}, room=room_id)

def check_all_ready(room_id):
    with VERROU:
        room = rooms.get(room_id)
        if not room or not room["players"]:
            return

        if all(p["ready"] for p in room["players"]):
            cancel_launch_timer(room_id)
            socketio.emit('launchCountdown', {'roomId': room_id, 'seconds': 5}, room=room_id)
            t = threading.Timer(5.0, start_game, args=[room_id])
            t.daemon = True
            launch_timers[room_id] = t
            t.start()
        elif cancel_launch_timer(room_id):
            socketio.emit('countdownCancelled', {'roomId': room_id}, room=room_id)


def cancel_launch_timer(room_id):
    """Annule le decompte de lancement d'une salle. Vrai s'il y en avait un."""
    with VERROU:
        t = launch_timers.pop(room_id, None)   # pop et non `= None` : la cle
        if t is None:                          # restait sinon a vie, une par
            return False                       # salle jamais lancee
        t.cancel()
        return True


def tire_carte(vivier, sauf=None):
    """Une carte du vivier, jamais celle qu'on vient de montrer."""
    if sauf is not None and len(vivier) > 1:
        while True:
            choix = random.choice(vivier)
            if choix != sauf:
                return choix
    return random.choice(vivier)


def jeton_pour(gs, card_id):
    """Range une carte derriere un jeton opaque, et rend le jeton.

    L'identifiant d'une carte, c'est son passcode -- et static/cards_fr.json,
    que la Collection telecharge en clair, dit quel nom porte quel passcode.
    Servir l'artwork sous /static/CardsCropped/<passcode>.jpg revenait donc a
    donner la reponse dans l'URL de l'enigme : l'onglet reseau suffisait.
    Le jeton ne veut rien dire hors de la salle qui l'a tire.
    """
    jeton = uuid.uuid4().hex
    gs["jetons"][jeton] = card_id
    return jeton


def start_game(room_id):
    with VERROU:
        room = rooms.get(room_id)
        if not room or room["status"] != "waiting":
            return
        # Timer.cancel() ne fait que poser un drapeau : un decompte deja parti
        # arrive quand meme jusqu'ici. On revoit donc les « pret » a la
        # seconde ou la partie commence, et pas seulement a l'armement.
        if not room["players"] or not all(p["ready"] for p in room["players"]):
            return
        card_pool = CARD_POOLS.get(str(room["difficulty"]))
        if not card_pool:
            return

        room["status"] = "in_game"
        current = tire_carte(card_pool)
        gs = {
            "current_id": current,
            "next_id": tire_carte(card_pool, current),
            "current_name": id_to_name_fr[current],
            "card_pool": card_pool,
            "date_last": datetime.datetime.now(),
            "scores": {p["pseudo"]: 0 for p in room["players"]},
            "time": room["time"],
            "score_to_win": room["score_to_win"],
            "locked_players": set(),
            # ce qu'on a repondu a la carte en cours { pseudo: {answer, correct} }
            "reponses": {},
            # la manche est-elle close ? c'est ce qui autorise le nom a sortir
            "revele": False,
            "jetons": {},
        }
        game_states[room_id] = gs
        gs["jeton_courant"] = jeton_pour(gs, gs["current_id"])
        gs["jeton_suivant"] = jeton_pour(gs, gs["next_id"])

        socketio.emit('gameStart', {
            'roomId': room_id,
            'time': room["time"],
            'score_to_win': room["score_to_win"]
        }, room=room_id)
        broadcast_rooms()

        t = threading.Thread(target=game_loop, args=[room_id])
        t.daemon = True
        t.start()


def revele_manche(room_id):
    """Fin de manche : c'est ici, et nulle part avant, que le nom sort.

    La page recevait le nom de la carte en meme temps que son image -- et
    celui de la SUIVANTE avec -- puis disait elle-meme si la reponse etait
    bonne. Deviner n'etait plus qu'une politesse. Le nom part maintenant une
    fois les reponses closes, et c'est le serveur qui a compare.

    A appeler sous VERROU.
    """
    gs = game_states.get(room_id)
    room = rooms.get(room_id)
    if not gs or gs["revele"]:
        return
    gs["revele"] = True

    socketio.emit('mancheFinie', {
        'correct_name': gs['current_name'],
        'resultats': [{'pseudo': p, 'answer': r['answer'], 'correct': r['correct']}
                      for p, r in gs['reponses'].items()],
        'scores': gs['scores'],
    }, room=room_id)

    # La victoire se decide ici, une fois tous les points de la manche
    # comptes : deux joueurs peuvent atteindre le score sur la meme carte.
    # Parmi ceux qui sont encore la, uniquement -- les scores gardent trace
    # de qui est parti, et une partie ne se gagne pas en ayant ferme l'onglet.
    if not room:
        return
    presents = [p['pseudo'] for p in room['players'] if p['pseudo'] in gs['scores']]
    if not presents:
        return
    gagnant = max(presents, key=lambda p: gs['scores'][p])
    if gs['scores'][gagnant] >= gs['score_to_win']:
        socketio.emit('gameOver', {'winner': gagnant, 'scores': gs['scores']}, room=room_id)
        room['status'] = 'waiting'
        room['players'] = [{**p, 'ready': False} for p in room['players']]
        game_states.pop(room_id, None)
        broadcast_rooms()


def carte_suivante(room_id):
    """Passe a la carte d'apres. A appeler sous VERROU."""
    gs = game_states[room_id]
    gs["current_id"] = gs["next_id"]
    gs["current_name"] = id_to_name_fr[gs["current_id"]]
    gs["next_id"] = tire_carte(gs["card_pool"], gs["current_id"])
    gs["date_last"] = datetime.datetime.now()
    gs["revele"] = False
    gs["reponses"] = {}
    gs["locked_players"] = set()
    # les jetons de la manche passee ne designent plus rien : les garder
    # ferait grossir la partie d'une entree par carte jusqu'a la fin
    gs["jetons"] = {}
    gs["jeton_courant"] = jeton_pour(gs, gs["current_id"])
    gs["jeton_suivant"] = jeton_pour(gs, gs["next_id"])
    socketio.emit('nouvelle_image', {'OK': True}, room=room_id)


def game_loop(room_id):
    """Le battement d'une partie : reveler, puis passer a la suivante.

    La boucle ne connaissait qu'un seul instant, `time + 5`, et laissait la
    page decider toute seule de la fin de la manche. Elle en connait deux :
    la revelation ferme les reponses et dit le nom, l'avancee sort la carte
    d'apres. Les deux font les cinq secondes d'avant.
    """
    while True:
        with VERROU:
            room = rooms.get(room_id)
            gs = game_states.get(room_id)
            if not room or room["status"] != "in_game" or not gs:
                break
            ecoule = (datetime.datetime.now() - gs["date_last"]).total_seconds()
            if not gs["revele"]:
                if ecoule >= gs["time"] + DELAI_GRACE:
                    revele_manche(room_id)
            elif ecoule >= gs["time"] + DELAI_GRACE + DUREE_REVELATION:
                carte_suivante(room_id)
        time.sleep(0.25)

# --------------------------------------------------------------------------
#   Les pages
# --------------------------------------------------------------------------
# Une seule adresse d'entree, /yugiquiz : c'est le salon, et c'est ce qu'on
# donne a quelqu'un pour l'inviter. La page de connexion n'existe plus que
# pour qui n'a pas de compte -- les autres passent au travers.
@blueprint_yugiquiz.route('', strict_slashes=False)
def salon():
    if not pseudo_courant():
        return redirect(url_for('yugiquiz.connexion'))
    return render_template('yugiquiz-lobby.html')


@blueprint_yugiquiz.get('/connexion')
def connexion():
    """La porte des invites. Connecte a Abyss, on ne la voit jamais.

    Elle ne prend plus le pseudo elle-meme : c'est /api/yugiquiz/connexion
    qui le pose, en JSON. Un formulaire d'un autre site ne sait pas emettre
    ce type de requete -- meme parade CSRF que comptes.exige_json, et le
    refus a de quoi s'expliquer plutot que de recharger une page muette.
    """
    if pseudo_courant():
        return redirect(url_for('yugiquiz.salon'))
    return render_template('yugiquiz-connexion.html')


@blueprint_yugiquiz.route('/jeu/<room_id>')
def jeu(room_id):
    """La table de jeu. On y arrive par le salon, jamais par l'adresse seule.

    Elle ne refusait que les salles a mot de passe, donc taper l'adresse
    d'une salle publique en cours suffisait a s'y asseoir. On rejoint une
    salle dans le salon -- cette page ne fait que retrouver sa place.
    """
    qui = pseudo_courant()
    if not qui:
        return redirect(url_for('yugiquiz.connexion'))
    with VERROU:
        room = rooms.get(room_id)
        if not room or not any(p['pseudo'] == qui for p in room['players']):
            return redirect(url_for('yugiquiz.salon'))
    return render_template('yugiquiz-jeu.html', room_id=room_id)


# --------------------------------------------------------------------------
#   Ce que les pages demandent
# --------------------------------------------------------------------------
@blueprint_api.post('/connexion')
def prend_pseudo():
    """Pose un pseudo d'invite dans la session. Refuse celui d'un compte."""
    if request.mimetype != "application/json":
        return jsonify({'ok': False, 'message': "Les ecritures attendent du JSON."}), 415
    if pseudo_courant():
        return jsonify({'ok': True})

    demande = request.get_json(silent=True) or {}
    voulu = pseudo_libre(demande.get('pseudo'))
    if not voulu:
        brut = (demande.get('pseudo') or '').strip()
        return jsonify({'ok': False, 'message':
            "Ce pseudo est celui d'un compte Abyss : connecte-toi plutot."
            if comptes.par_pseudo(brut) is not None else
            "Un pseudo de 1 a 20 caracteres, lettres, chiffres, tiret, "
            "souligne ou espace."}), 400

    session[CLE_INVITE] = voulu
    # pas de session permanente : un pseudo de passage n'a pas a survivre
    # a la fermeture du navigateur, contrairement a un compte
    session.permanent = False
    return jsonify({'ok': True})


@blueprint_api.get('/moi')
def moi():
    qui = pseudo_courant()
    if qui:
        return jsonify({'pseudo': qui})
    return jsonify({'pseudo': None}), 401


def _membre(room, qui):
    """Ce joueur est-il assis dans cette salle ? A appeler sous VERROU."""
    return bool(room) and any(p['pseudo'] == qui for p in room['players'])


@blueprint_api.get('/carte/<room_id>')
def get_card(room_id):
    """L'etat de la manche en cours, pour qui joue dans cette salle.

    Deux choses ont disparu de cette reponse, et c'est tout le correctif :
    `correct_name` et `next_correct_name`. Le nom de la carte a deviner --
    et celui de la suivante -- arrivaient ici, au debut du tour. Ils ne
    sortent plus qu'a la fin de la manche, dans mancheFinie.

    Les images ne viennent plus non plus sous leur passcode (voir
    jeton_pour) : il aurait suffi de le lire dans cards_fr.json.
    """
    qui = pseudo_courant()
    with VERROU:
        room = rooms.get(room_id)
        if not qui or not _membre(room, qui):
            return jsonify({'message': "Cette salle n'est pas la tienne."}), 403
        gs = game_states.get(room_id)
        if not gs:
            return jsonify({'jeton': '', 'jeton_suivant': '',
                            'time': TIME_DEFAULT, 'score_to_win': SCORE_DEFAULT,
                            'revele': False})
        return jsonify({
            'jeton': gs['jeton_courant'],
            'jeton_suivant': gs['jeton_suivant'],
            'time': gs['time'],
            'score_to_win': gs['score_to_win'],
            'revele': gs['revele'],
        })


def _sert_image(room_id, jeton, pleine):
    """Un artwork de la partie, sous son jeton. Voir jeton_pour."""
    qui = pseudo_courant()
    with VERROU:
        room = rooms.get(room_id)
        gs = game_states.get(room_id)
        if not qui or not _membre(room, qui) or not gs:
            return jsonify({'message': "Cette salle n'est pas la tienne."}), 403
        card_id = gs['jetons'].get(jeton)
        # La carte entiere porte son nom en toutes lettres : on ne la sert
        # qu'une fois la manche close, et seulement pour la carte du tour.
        if not card_id or (pleine and not (gs['revele'] and card_id == gs['current_id'])):
            return jsonify({'message': 'Image inconnue.'}), 404

    reponse = send_from_directory(STATIC / ("Cards" if pleine else "CardsCropped"),
                                  card_id + '.jpg')
    # pas de cache : un jeton ne vaut que pour sa manche, et l'image d'une
    # enigme n'a pas a rester dans le disque du navigateur
    reponse.headers['Cache-Control'] = 'no-store'
    return reponse


@blueprint_api.get('/image/<room_id>/<jeton>')
def image_carte(room_id, jeton):
    return _sert_image(room_id, jeton, pleine=False)


@blueprint_api.get('/image/<room_id>/<jeton>/pleine')
def image_carte_pleine(room_id, jeton):
    return _sert_image(room_id, jeton, pleine=True)


@blueprint_api.get('/temps/<room_id>')
def get_remaining_time(room_id):
    qui = pseudo_courant()
    with VERROU:
        room = rooms.get(room_id)
        if not qui or not _membre(room, qui):
            return jsonify({'message': "Cette salle n'est pas la tienne."}), 403
        gs = game_states.get(room_id)
        if not gs:
            return jsonify({'rtime': 0})
        ecoule = (datetime.datetime.now() - gs['date_last']).total_seconds()
        return jsonify({'rtime': gs['time'] - ecoule})


@blueprint_api.get('/completion')
def autocomplete():
    # 13 000 cartes parcourues par appel : pas de quoi laisser n'importe qui
    # le demander en boucle sans meme jouer
    if not pseudo_courant():
        return jsonify([]), 401
    query = normalize(request.args.get("q", ""))
    if len(query) < 2:
        return jsonify([])
    words = query.split()
    results = []
    for card in CARD_INDEX:
        if all(w in card["fr_norm"] or w in card["en_norm"] for w in words):
            results.append(card["display"])
            if len(results) >= 25:
                break
    return jsonify(results)


@blueprint_api.get('/ma-salle')
def my_room():
    qui = pseudo_courant()
    if not qui:
        return jsonify({'room_id': None})
    with VERROU:
        for room_id, room in rooms.items():
            if _membre(room, qui):
                return jsonify({'room_id': room_id, 'status': room['status']})
    return jsonify({'room_id': None})


@blueprint_api.get('/viviers')
def card_pools_info():
    if not pseudo_courant():
        return jsonify({}), 401
    return jsonify({diff: len(pool) for diff, pool in CARD_POOLS.items()})


# -----------------------------------------------------------------------------

@sur('lobbyJoin')
def handle_lobby_join():
    if not pseudo_courant():
        return
    with VERROU:
        emit('roomsList', {'rooms': [room_summary(r) for r in rooms.values()]})

@sur('createRoom')
def handle_create_room(data):
    pseudo = pseudo_courant()
    if not pseudo:
        emit('error', {'message': 'Non connecté'})
        return

    data = data if isinstance(data, dict) else {}
    # Coupe a la longueur au lieu de faire confiance au maxlength de la page :
    # un nom de salle est rediffuse a tous les sockets du site a chaque
    # broadcast_rooms, et rien n'obligeait celui-la a tenir sur une ligne.
    name = " ".join(str(data.get('name') or '').split())[:LONG_NOM_SALLE]
    if not name:
        emit('error', {'message': 'Nom de salle invalide'})
        return
    password = str(data.get('password') or '').strip()[:LONG_MDP_SALLE]

    try:
        time_per_card = int(data.get('time', TIME_DEFAULT))
        score_to_win = int(data.get('scoreToWin', SCORE_DEFAULT))
    except (TypeError, ValueError):
        emit('error', {'message': 'Réglages de salle invalides'})
        return
    if not (TEMPS_MIN <= time_per_card <= TEMPS_MAX):
        emit('error', {'message': 'Réglages de salle invalides'})
        return
    if not (SCORE_MIN <= score_to_win <= SCORE_MAX):
        emit('error', {'message': 'Réglages de salle invalides'})
        return

    difficulty = str(data.get('difficulty', '2'))
    if difficulty not in CARD_POOLS:
        emit('error', {'message': 'Difficulté inconnue'})
        return

    with VERROU:
        # creer une salle, c'est quitter celle ou l'on est : sans cette ligne
        # (joinRoom l'avait, createRoom non) on restait dans les deux, compte
        # deux fois dans les « pret » de la premiere
        _leave_current_room(pseudo)
        room_id = str(uuid.uuid4())[:8]
        rooms[room_id] = {
            "id": room_id,
            "name": name,
            "status": "waiting",
            "players": [],
            "password": password,
            "time": time_per_card,
            "score_to_win": score_to_win,
            "difficulty": difficulty
        }
        _join_room(pseudo, request.sid, room_id)
        broadcast_rooms()

@sur('joinRoom')
def handle_join_room(data):
    pseudo = pseudo_courant()
    if not pseudo:
        emit('error', {'message': 'Non connecté'})
        return

    data = data if isinstance(data, dict) else {}
    room_id = data.get('roomId')

    with VERROU:
        room = rooms.get(room_id)
        if not room:
            emit('error', {'message': 'Salle introuvable'})
            return

        # deja assis ici : on ne redemande pas le mot de passe a quelqu'un qui
        # revient d'un rechargement de page
        deja = _membre(room, pseudo)
        if room.get('password') and not deja:
            if str(data.get('password') or '').strip() != room['password']:
                emit('error', {'message': 'Mot de passe incorrect'})
                return

        if not deja:
            _leave_current_room(pseudo)

        if room['status'] == 'in_game':
            join_room(room_id)
            if not deja:
                room['players'].append({'pseudo': pseudo, 'sid': request.sid, 'ready': True})
                if room_id in game_states:
                    game_states[room_id]['scores'].setdefault(pseudo, 0)
            else:
                for p in room['players']:
                    if p['pseudo'] == pseudo:
                        p['sid'] = request.sid
            emit('gameStart', {'roomId': room_id})
            broadcast_rooms()
            return

        _join_room(pseudo, request.sid, room_id)
        broadcast_rooms()

@sur('leaveRoom')
def handle_leave_room(data):
    pseudo = pseudo_courant()
    if not pseudo:
        return
    room_id = (data or {}).get('roomId')
    with VERROU:
        if room_id not in rooms:
            emit('roomLeft')
            return
        leave_room(room_id)
        _retire(room_id, pseudo)
        emit('roomLeft')
        broadcast_rooms()

@sur('setReady')
def handle_set_ready(data):
    pseudo = pseudo_courant()
    if not pseudo:
        return
    data = data if isinstance(data, dict) else {}
    room_id = data.get('roomId')
    ready = bool(data.get('ready', False))

    with VERROU:
        room = rooms.get(room_id)
        if not room or not _membre(room, pseudo):
            return
        for p in room['players']:
            if p['pseudo'] == pseudo:
                p['ready'] = ready
                break
        broadcast_room_update(room_id)
        check_all_ready(room_id)

@sur('checkScores')
def check_scores(data=None):
    qui = pseudo_courant()
    room_id = data.get('roomId') if data else None
    with VERROU:
        if not qui or not _membre(rooms.get(room_id), qui):
            return
        if room_id in game_states:
            emit('updateScores', {'scores': game_states[room_id]['scores']}, broadcast=False)

@sur('userAnswer')
def handle_user_answer(data):
    """La reponse d'un joueur pour la manche en cours. Notee ici, pas chez lui.

    La page envoyait sa reponse ET ce qu'elle croyait etre le bon nom, et le
    serveur la croyait sur parole : `{answer:'x', correct:'x'}` marquait un
    point, autant de fois qu'on le repetait -- de quoi gagner une partie en
    une ligne de console, sans jamais voir une carte. Le nom attendu ne
    quitte plus le serveur avant la fin de la manche (revele_manche), et une
    seule reponse par joueur et par carte est comptee.

    Rien n'est diffuse de son contenu ici : le dire, meme a un seul joueur,
    reviendrait a le dire pendant que les autres cherchent encore.
    """
    pseudo = pseudo_courant()
    data = data if isinstance(data, dict) else {}
    room_id = data.get('roomId')
    reponse = str(data.get('answer') or '')[:LONG_REPONSE]

    with VERROU:
        room = rooms.get(room_id)
        gs = game_states.get(room_id)
        if not pseudo or not room or not gs:
            return
        if not _membre(room, pseudo):
            return
        if gs['revele'] or pseudo in gs['reponses']:
            return

        juste = bool(reponse.strip()) and normalize(reponse) == normalize(gs['current_name'])
        gs['reponses'][pseudo] = {'answer': reponse, 'correct': juste}
        if juste:
            gs['scores'][pseudo] = gs['scores'].get(pseudo, 0) + 1

        # « a repondu », sans dire quoi ni si c'est bon
        gs['locked_players'].add(pseudo)
        socketio.emit('playerLocked', {'pseudo': pseudo}, room=room_id)

        # tout le monde a repondu : inutile de laisser tourner le chrono dans
        # le vide, on recule date_last et game_loop revele au prochain battement
        if all(p['pseudo'] in gs['reponses'] for p in room['players']):
            gs['date_last'] = (datetime.datetime.now()
                               - datetime.timedelta(seconds=gs['time'] + DELAI_GRACE))

@sur('checkPlayers')
def check_players(data=None):
    qui = pseudo_courant()
    room_id = data.get('roomId') if data else None
    with VERROU:
        room = rooms.get(room_id)
        if not qui or not _membre(room, qui):
            return
        players = [p['pseudo'] for p in room['players']]
        scores = game_states[room_id]['scores'] if room_id in game_states else {}
        emit('updatePlayersList', {'players': players, 'scores': scores})

@sur('joinGameRoom')
def handle_join_game_room(data):
    """La page de jeu retrouve sa place. Elle ne s'en fabrique pas une.

    Cet evenement ajoutait le joueur a la salle sans regarder ni le mot de
    passe ni le statut : un emit depuis le salon suffisait a s'asseoir au
    milieu d'une partie privee. On rejoint une salle par joinRoom, qui, lui,
    demande le mot de passe.
    """
    pseudo = pseudo_courant()
    room_id = (data or {}).get('roomId')
    sid = request.sid

    with VERROU:
        room = rooms.get(room_id)
        if not pseudo or not room or not _membre(room, pseudo):
            emit('roomNotFound')
            return

        join_room(room_id)
        # le socket a change (rechargement de page) : c'est le nouveau qui
        # designe ce joueur, et c'est ce qui rend inutile d'annuler sa
        # minuterie de deconnexion -- delayed_disconnect ne retire que le
        # (pseudo, sid) exact, donc plus rien apres cette ligne
        for p in room['players']:
            if p['pseudo'] == pseudo:
                p['sid'] = sid
                break

        gs = game_states.get(room_id)
        if gs:
            gs['scores'].setdefault(pseudo, 0)
        socketio.emit('updatePlayersList', {
            'players': [p['pseudo'] for p in room['players']],
            'scores': gs['scores'] if gs else {},
        }, room=room_id)

        if gs:
            emit('gameParams', {
                'time': gs['time'],
                'score_to_win': gs['score_to_win'],
                'difficulty': room.get('difficulty'),
            })

@sur('connect')
def handle_connect():
    # Fige qui est au bout de ce socket (voir PSEUDOS et l'en-tete du fichier).
    #
    # Il annulait aussi toutes les minuteries de deconnexion de ce pseudo, ce
    # qui melait les onglets : fermer le premier pendant que le second se
    # connectait annulait le nettoyage du premier, et son joueur restait dans
    # la salle pour de bon -- de quoi bloquer les manches, puisque la
    # revelation anticipee attend que TOUT le monde ait repondu. Plus besoin :
    # delayed_disconnect ne retire que le (pseudo, sid) exact, et joinRoom
    # comme joinGameRoom rafraichissent le sid du joueur qui revient.
    pseudo_courant()

@sur('disconnect')
def handle_disconnect():
    pseudo = pseudo_courant()
    sid = request.sid
    # La connexion est finie : ce sid ne designera plus personne. Sans cette
    # ligne, PSEUDOS grossirait d'une entree par onglet ouvert depuis le
    # demarrage, et ne redescendrait jamais.
    PSEUDOS.pop(sid, None)

    if not pseudo:
        return
    
    def delayed_disconnect(pseudo, sid):
        with VERROU:
            for room_id, room in list(rooms.items()):
                # le sid, et pas seulement le pseudo : si la personne est
                # revenue entre-temps, son entree porte deja le nouveau socket
                # et il n'y a rien a retirer
                if any(p['pseudo'] == pseudo and p['sid'] == sid for p in room['players']):
                    _retire(room_id, pseudo, sid)
                    break
            disconnect_timers.pop((pseudo, sid), None)
        
    t = threading.Timer(TIME_DISCONNECT, delayed_disconnect, args=[pseudo, sid])
    t.daemon = True
    disconnect_timers[(pseudo, sid)] = t
    t.start()
    
# L'evenement entrant `playerLocked` n'existe plus : verrouiller sa reponse,
# c'est l'envoyer, et c'est userAnswer qui s'en charge -- lui seul sait si
# tout le monde a repondu, puisque lui seul detient les reponses. Le nom
# `playerLocked` reste, en sortie, pour dire aux autres pages qu'un joueur a
# rendu sa copie.

# -----------------------------------------------------------------------------

def _join_room(pseudo, sid, room_id):
    """Assied un joueur dans une salle en attente. A appeler sous VERROU."""
    room = rooms[room_id]
    for p in room['players']:
        if p['pseudo'] == pseudo:
            # deja la, sous un autre socket : rechargement de page. C'est le
            # nouveau sid qui le designe desormais -- sans cette mise a jour,
            # la minuterie de deconnexion de l'ancien le sortait de la salle
            # cinq secondes apres son retour.
            p['sid'] = sid
            break
    else:
        room['players'].append({'pseudo': pseudo, 'sid': sid, 'ready': False})
    join_room(room_id)
    emit('roomJoined', {'room': room_detail(room)})
    broadcast_room_update(room_id)
    check_all_ready(room_id) # A enlever si les gens sont chiants


def _retire(room_id, pseudo, sid=None):
    """Sort un joueur d'une salle, et range derriere lui. A appeler sous VERROU.

    Les trois chemins de sortie -- quitter, se deconnecter, aller ailleurs --
    en avaient chacun leur version, avec chacune ses oublis (un timer de
    lancement laisse en place ici, une salle vide gardee la). Il n'y en a
    plus qu'une.

    `sid` restreint le retrait a un socket precis : la deconnexion differee
    ne doit pas sortir quelqu'un qui est deja revenu sous un autre socket.
    """
    room = rooms.get(room_id)
    if not room:
        return
    room['players'] = [p for p in room['players']
                       if p['pseudo'] != pseudo or (sid is not None and p['sid'] != sid)]

    if not room['players']:
        cancel_launch_timer(room_id)
        rooms.pop(room_id, None)
        game_states.pop(room_id, None)
        broadcast_rooms()
        return

    if room['status'] == 'in_game':
        gs = game_states.get(room_id)
        socketio.emit('updatePlayersList', {
            'players': [p['pseudo'] for p in room['players']],
            'scores': gs['scores'] if gs else {},
        }, room=room_id)
        # celui qui part peut etre le dernier qu'on attendait : sans ce
        # rappel, la manche allait au bout du chrono pour personne
        if gs and not gs['revele'] and all(p['pseudo'] in gs['reponses'] for p in room['players']):
            gs['date_last'] = (datetime.datetime.now()
                               - datetime.timedelta(seconds=gs['time'] + DELAI_GRACE))
    else:
        cancel_launch_timer(room_id)
        socketio.emit('countdownCancelled', {'roomId': room_id}, room=room_id)
        broadcast_room_update(room_id)
        check_all_ready(room_id)
    broadcast_rooms()


def _leave_current_room(pseudo):
    """Sort le joueur de la salle ou il se trouve. A appeler sous VERROU.

    Par pseudo seul, et non par (pseudo, sid) : apres un rechargement de
    page, le socket a change mais la personne est la meme, et chercher son
    ancien socket revenait a ne pas la trouver -- donc a la laisser dans deux
    salles a la fois.
    """
    for room_id, room in list(rooms.items()):
        if any(p['pseudo'] == pseudo for p in room['players']):
            leave_room(room_id)
            _retire(room_id, pseudo)
            emit('roomLeft')
            break

# Ce fichier ne se lance plus tout seul : il n'a plus de serveur a lui. Le
# quiz demarre avec le reste du site -- `python app.py`, puis /yugiquiz.
