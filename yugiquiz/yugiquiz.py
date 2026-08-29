#!/usr/bin/env python3
"""
Serveur du quiz Abyss:DUEL (Yu-Gi-Quiz), branché sur le hub Abyss.

Usage :
    pip install flask flask-socketio flask-cors
    python yugiquiz/yugiquiz.py   ->  http://127.0.0.1:5000

Le hub (app.py, port 8000) le lance déjà tout seul en sous-processus : cette
commande ne sert qu'à le démarrer isolément. Les deux serveurs restent
indépendants, le hub y renvoie par un simple lien externe.
"""

from pathlib import Path
from flask import Flask, redirect, render_template, request, jsonify, session, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
import os
import random
import threading
import time
import datetime
import json
import unicodedata
import re
import uuid

BASE = Path(__file__).parent.resolve()
# les artworks (Cards/CardsCropped) et les fichiers de noms sont partagés avec
# le reste d'Abyss (la Collection Yu-Gi-Oh! s'en sert aussi) : un seul dossier
# static/ à la racine du projet, pas de copie par sous-projet.
STATIC = BASE.parent / "static"

app = Flask(__name__, static_folder=str(STATIC), static_url_path='/static')
app.secret_key = os.environ.get('YUGIQUIZ_SECRET_KEY') or os.urandom(24).hex()

# les artworks ne changent jamais : une semaine de cache navigateur, sinon
# chaque carte affichee repart en requete reseau (6 connexions max par origine)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 604800

socketio = SocketIO(app, cors_allowed_origins="*",
                    async_mode='threading',
                    ping_timeout=20, ping_interval=25)
CORS(app)

list_cards = os.listdir(STATIC / "Cards")

# Salles { room_id: { id, name, status, players: [{pseudo, sid, ready}], game_state } }
rooms = {}
# Timer de lancement { room_id: threading.Timer }
launch_timers = {}
# Timers de déconnexion différée { (pseudo, sid): threading.Timer }
disconnect_timers = {}
# Parties actives { room_id: { current_image, next_image, date_last, scores } }
game_states = {}

TIME_DEFAULT = 10
SCORE_DEFAULT = 20

TIME_DISCONNECT = 5

DIFFICULTY_THRESHOLDS = {
    "1": 200000,  # Facile
    "2": 50000,   # Normal
    "3": 25000,   # Difficile
    "4": 0        # Toutes
}

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
    
list_cards_set = set(list_cards)
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
    if room_id not in rooms:
        return
    room = rooms[room_id]
    players = room["players"]
    if not players:
        return

    all_ready = all(p["ready"] for p in players)

    if all_ready:
        cancel_launch_timer(room_id)
        socketio.emit('launchCountdown', {'roomId': room_id, 'seconds': 5}, room=room_id)
        t = threading.Timer(5.0, start_game, args=[room_id])
        t.daemon = True
        launch_timers[room_id] = t
        t.start()
    else:
        if cancel_launch_timer(room_id):
            socketio.emit('countdownCancelled', {'roomId': room_id}, room=room_id)

def cancel_launch_timer(room_id):
    if room_id in launch_timers and launch_timers[room_id] is not None:
        launch_timers[room_id].cancel()
        launch_timers[room_id] = None
        return True
    return False

def start_game(room_id):
    if room_id not in rooms:
        return
    room = rooms[room_id]
    if room["status"] != "waiting":
        return
    
    room["status"] = "in_game"
    card_pool = get_cards_for_difficulty(room["difficulty"])
    current = random.choice(card_pool)
    nxt = random.choice(card_pool)
    
    game_states[room_id] = {
        "current_id": current,
        "next_id": nxt,
        "current_name": id_to_name_fr[current],
        "card_pool": card_pool,
        "date_last": datetime.datetime.now(),
        "scores": {p["pseudo"]: 0 for p in room["players"]},
        "time": room["time"],
        "score_to_win": room["score_to_win"],
        "locked_players": set()
    }

    socketio.emit('gameStart', {
        'roomId': room_id,
        'time': room["time"],
        'score_to_win': room["score_to_win"]
    }, room=room_id)
    broadcast_rooms()

    t = threading.Thread(target=game_loop, args=[room_id])
    t.daemon = True
    t.start()

def game_loop(room_id):
    while True:
        if room_id not in rooms:
            break
        if rooms[room_id]["status"] != "in_game":
            break
        gs = game_states.get(room_id)
        if not gs:
            break
        now = datetime.datetime.now()
        if (now - gs["date_last"]).total_seconds() >= gs["time"] + 5:
            if room_id not in rooms:
                break
            gs["current_id"] = gs["next_id"]
            gs["current_name"] = id_to_name_fr[gs["current_id"]]
            gs["next_id"] = random.choice(gs["card_pool"])
            gs["date_last"] = now
            socketio.emit('nouvelle_image', {'OK': True}, room=room_id)
        time.sleep(0.25)
        
def get_cards_for_difficulty(difficulty):
    return CARD_POOLS.get(str(difficulty))

# -----------------------------------------------------------------------------

@app.route('/')
def index():
    if not session.get('pseudo'):
        return redirect(url_for('connexion'))
    return redirect(url_for('lobby'))

@app.route('/lobby')
def lobby():
    if not session.get('pseudo'):
        return redirect(url_for('connexion'))
    return render_template('lobby.html')

@app.route('/connexion', methods=['GET', 'POST'])
def connexion():
    if request.method == 'POST':
        pseudo = request.form.get('pseudo')
        if pseudo:
            session['pseudo'] = pseudo
            return redirect(url_for('lobby'))
    return render_template('connexion.html')

@app.route('/jeu/<room_id>')
def jeu(room_id):
    if not session.get('pseudo'):
        return redirect(url_for('connexion'))
    if room_id not in rooms:
        return redirect(url_for('lobby'))
    
    room = rooms[room_id]
    pseudo = session.get('pseudo')
    
    if room.get('password') and not any(p['pseudo'] == pseudo for p in room['players']):
        return redirect(url_for('lobby'))
    
    return render_template('jeu.html', room_id=room_id)

@app.route('/get_card/<room_id>')
def get_card(room_id):
    gs = game_states.get(room_id)
    if not gs:
        return jsonify({'image_name': '', 'next_image_name': '', 'time': TIME_DEFAULT, 'score_to_win': SCORE_DEFAULT})
    return jsonify({
        'image_name': gs['current_id'] + '.jpg',
        'next_image_name': gs['next_id'] + '.jpg',
        'correct_name': gs['current_name'],
        'next_correct_name': id_to_name_fr.get(gs['next_id'], ''),
        'time': gs['time'],
        'score_to_win': gs['score_to_win']
    })

@app.route('/r_time/<room_id>')
def get_remaining_time(room_id):
    gs = game_states.get(room_id)
    if not gs:
        return jsonify({'rtime': 0})
    now = datetime.datetime.now()
    return jsonify({'rtime': gs['time'] - (now - gs['date_last']).total_seconds()})

@app.route('/check_session')
def check_session():
    username = session.get('pseudo')
    if username:
        return jsonify({'pseudo': username}), 200
    return jsonify({'pseudo': None}), 401

@app.route('/autocomplete')
def autocomplete():
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

@app.route('/my_room')
def my_room():
    pseudo = session.get('pseudo')
    if not pseudo:
        return jsonify({'room_id': None})
    for room_id, room in rooms.items():
        if any(p['pseudo'] == pseudo for p in room['players']):
            return jsonify({'room_id': room_id, 'status': room['status']})
    return jsonify({'room_id': None})

@app.route('/card_pools_info')
def card_pools_info():
    return jsonify({diff: len(pool) for diff, pool in CARD_POOLS.items()})

# -----------------------------------------------------------------------------

@socketio.on('lobbyJoin')
def handle_lobby_join():
    emit('roomsList', {'rooms': [room_summary(r) for r in rooms.values()]})

@socketio.on('createRoom')
def handle_create_room(data):
    pseudo = session.get('pseudo')
    if not pseudo:
        emit('error', {'message': 'Non connecté'})
        return

    name = data.get('name', '').strip()
    if not name:
        emit('error', {'message': 'Nom de salle invalide'})
        return
    
    password = data.get('password', '').strip()
    time_per_card = int(data.get('time', TIME_DEFAULT))
    score_to_win = int(data.get('scoreToWin', SCORE_DEFAULT))
    difficulty = data.get('difficulty', '2')

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

@socketio.on('joinRoom')
def handle_join_room(data):
    pseudo = session.get('pseudo')
    if not pseudo:
        emit('error', {'message': 'Non connecté'})
        return

    room_id = data.get('roomId')
    if room_id not in rooms:
        emit('error', {'message': 'Salle introuvable'})
        return

    room = rooms[room_id]
    
    if room.get('password'):
        submitted = data.get('password', '').strip()
        if submitted != room['password']:
            emit('error', {'message': 'Mot de passe incorrect'})
            return
    
    _leave_current_room(pseudo, request.sid)
    
    if room['status'] == 'in_game':
        if room.get('password') and not any(p['pseudo'] == pseudo for p in room['players']):
            submitted = data.get('password', '').strip()
            if submitted != room['password']:
                emit('error', {'message': 'Mot de passe incorrect'})
                return
        join_room(room_id)
        if not any(p['pseudo'] == pseudo for p in room['players']):
            room['players'].append({'pseudo': pseudo, 'sid': request.sid, 'ready': True})
            if room_id in game_states:
                game_states[room_id]['scores'].setdefault(pseudo, 0)
        emit('gameStart', {'roomId': room_id})
        broadcast_rooms()
        return

    _join_room(pseudo, request.sid, room_id)
    broadcast_rooms()

@socketio.on('leaveRoom')
def handle_leave_room(data):
    pseudo = session.get('pseudo')
    if not pseudo:
        return
    room_id = data.get('roomId')
    if room_id not in rooms:
        emit('roomLeft')
        return
    room = rooms[room_id]
    room['players'] = [p for p in room['players'] if p['pseudo'] != pseudo]
    leave_room(room_id)
    cancel_launch_timer(room_id)
    
    if room['status'] == 'in_game':
        if not room['players']:
            del rooms[room_id]
            if room_id in game_states:
                del game_states[room_id]
        else:
            players = [p['pseudo'] for p in room['players']]
            scores = game_states[room_id]['scores'] if room_id in game_states else {}
            socketio.emit('updatePlayersList', {'players': players, 'scores': scores}, room=room_id)
    else:
        if room['players']:
            socketio.emit('countdownCancelled', {'roomId': room_id}, room=room_id)
            socketio.emit('roomUpdated', {'room': room_detail(room)}, room=room_id)
            check_all_ready(room_id)
        else:
            del rooms[room_id]
            if room_id in game_states:
                del game_states[room_id]

    emit('roomLeft')
    broadcast_rooms()

@socketio.on('setReady')
def handle_set_ready(data):
    pseudo = session.get('pseudo')
    if not pseudo:
        return
    room_id = data.get('roomId')
    ready = data.get('ready', False)

    if room_id not in rooms:
        return
    room = rooms[room_id]
    for p in room['players']:
        if p['pseudo'] == pseudo:
            p['ready'] = ready
            break

    broadcast_room_update(room_id)
    check_all_ready(room_id)

@socketio.on('checkScores')
def check_scores(data=None):
    room_id = data.get('roomId') if data else None
    if room_id and room_id in game_states:
        emit('updateScores', {'scores': game_states[room_id]['scores']}, broadcast=False)

@socketio.on('userAnswer')
def handle_user_answer(data):
    pseudo = session.get('pseudo')
    answer = data['answer']
    correct_name = data['correct']
    room_id = data.get('roomId')

    if not correct_name or not room_id:
        return
    
    if room_id in game_states:
        game_states[room_id]['locked_players'].discard(pseudo)

    is_correct = normalize(answer) == normalize(correct_name)

    if is_correct and room_id in game_states:
        gs = game_states[room_id]
        gs['scores'][pseudo] = gs['scores'].get(pseudo, 0) + 1
        socketio.emit('updateScores', {'scores': gs['scores']}, room=room_id)
        
        if gs['scores'][pseudo] >= gs['score_to_win']:
            socketio.emit('gameOver', {'winner': pseudo, 'scores': gs['scores']}, room=room_id)
            rooms[room_id]['status'] = 'waiting'
            rooms[room_id]['players'] = [{**p, 'ready': False} for p in rooms[room_id]['players']]
            del game_states[room_id]
            broadcast_rooms()
            return

    socketio.emit('showAnswer', {'pseudo': pseudo, 'answer': answer, 'correct': is_correct}, room=room_id)

@socketio.on('checkPlayers')
def check_players(data=None):
    room_id = data.get('roomId') if data else None
    if not room_id or room_id not in rooms:
        return
    room = rooms[room_id]
    players = [p['pseudo'] for p in room['players']]
    scores = game_states[room_id]['scores'] if room_id in game_states else {}
    emit('updatePlayersList', {'players': players, 'scores': scores})

@socketio.on('joinGameRoom')
def handle_join_game_room(data):
    room_id = data.get('roomId')
    pseudo = session.get('pseudo')
    sid = request.sid
    
    if not room_id or room_id not in rooms:
        emit('roomNotFound')
        return
    
    for key in list(disconnect_timers.keys()):
        if key[0] == pseudo:
            disconnect_timers[key].cancel()
            disconnect_timers.pop(key, None)
            
    if room_id and room_id in rooms:
        join_room(room_id)

        if pseudo and room_id in rooms:
            room = rooms[room_id]
            updated = False
            for p in room['players']:
                if p['pseudo'] == pseudo:
                    p['sid'] = sid
                    updated = True
                    break
            if not updated:
                room['players'].append({'pseudo': pseudo, 'sid': sid, 'ready': True})
                if room_id in game_states:
                    game_states[room_id]['scores'].setdefault(pseudo, 0)
            players = [p['pseudo'] for p in room['players']]
            scores = game_states[room_id]['scores'] if room_id in game_states else {}
            emit('updatePlayersList', {'players': players, 'scores': scores}, room=room_id)
            
            if room_id in game_states:
                gs = game_states[room_id]
                emit('gameParams', {
                    'time': gs['time'],
                    'score_to_win': gs['score_to_win'],
                    'difficulty': rooms[room_id].get('difficulty')
                })

@socketio.on('connect')
def handle_connect():
    pseudo = session.get('pseudo')
    if not pseudo:
        return
    for key in list(disconnect_timers.keys()):
        if key[0] == pseudo:
            disconnect_timers[key].cancel()
            disconnect_timers.pop(key, None)

@socketio.on('disconnect')
def handle_disconnect():
    pseudo = session.get('pseudo')
    sid = request.sid
    
    if not pseudo:
        return
    
    def delayed_disconnect(pseudo, sid):
        for room_id, room in list(rooms.items()):
            for p in list(room['players']):
                if p['pseudo'] == pseudo and p['sid'] == sid:
                    room['players'] = [x for x in room['players'] if not (x['pseudo'] == pseudo and x['sid'] == sid)]
                    
                    if room['status'] == 'in_game':
                        if not room['players']:
                            del rooms[room_id]
                            if room_id in game_states:
                                del game_states[room_id]
                        else:
                            players = [x['pseudo'] for x in room['players']]
                            scores = game_states[room_id]['scores'] if room_id in game_states else {}
                            socketio.emit('updatePlayersList', {'players': players, 'scores': scores}, room=room_id)
                        broadcast_rooms()
                    else:
                        cancel_launch_timer(room_id)
                        if room['players']:
                            # broadcast_room_update utilise la room SocketIO, on émet directement
                            socketio.emit('roomUpdated', {'room': room_detail(room)}, room=room_id)
                            socketio.emit('countdownCancelled', {'roomId': room_id}, room=room_id)
                            check_all_ready(room_id)
                        else:
                            del rooms[room_id]
                            if room_id in game_states:
                                del game_states[room_id]
                        broadcast_rooms()
                    break
        disconnect_timers.pop((pseudo, sid), None)
        
    t = threading.Timer(TIME_DISCONNECT, delayed_disconnect, args=[pseudo, sid])
    t.daemon = True
    disconnect_timers[(pseudo, sid)] = t
    t.start()
    
@socketio.on('playerLocked')
def handle_player_locked(data):
    room_id = data.get('roomId')
    pseudo = data.get('pseudo')
    if room_id not in game_states:
        return
    
    gs = game_states[room_id]
    gs['locked_players'].add(pseudo)
    socketio.emit('playerLocked', {'pseudo': pseudo}, room=room_id)
    
    room = rooms.get(room_id)
    if room and all(p['pseudo'] in gs['locked_players'] for p in room['players']):
        gs['locked_players'].clear()
        gs['date_last'] = datetime.datetime.now() - datetime.timedelta(seconds=gs['time'])
        socketio.emit('forceTimeout', {}, room=room_id)
            
# -----------------------------------------------------------------------------

def _join_room(pseudo, sid, room_id):
    room = rooms[room_id]
    if not any(p['pseudo'] == pseudo for p in room['players']):
        room['players'].append({'pseudo': pseudo, 'sid': sid, 'ready': False})
    join_room(room_id)
    emit('roomJoined', {'room': room_detail(room)})
    broadcast_room_update(room_id)
    check_all_ready(room_id) # A enlever si les gens sont chiants

def _leave_room(pseudo, sid, room_id):
    if room_id not in rooms:
        return
    room = rooms[room_id]
    room['players'] = [p for p in room['players'] if not (p['pseudo'] == pseudo and p['sid'] == sid)]
    if room['status'] == 'in_game':
        if not room['players']:
            del rooms[room_id]
            if room_id in game_states:
                del game_states[room_id]
        else:
            players = [p['pseudo'] for p in room['players']]
            scores = game_states[room_id]['scores'] if room_id in game_states else {}
            socketio.emit('updatePlayersList', {'players': players, 'scores': scores}, room=room_id)
        return
    leave_room(room_id)
    cancel_launch_timer(room_id)
    if room['players']:
        socketio.emit('countdownCancelled', {'roomId': room_id}, room=room_id)
        broadcast_room_update(room_id)
        check_all_ready(room_id)
    else:
        if rooms[room_id]['status'] != 'in_game':
            del rooms[room_id]
            if room_id in game_states:
                del game_states[room_id]

def _leave_current_room(pseudo, sid):
    for room_id, room in list(rooms.items()):
        if any(p['pseudo'] == pseudo and p['sid'] == sid for p in room['players']):
            _leave_room(pseudo, sid, room_id)
            emit('roomLeft')
            break

if __name__ == '__main__':
    # lance depuis le hub (app.py) : un seul processus, sinon le rechargeur
    # Werkzeug en sous-processus survivrait a l'arret du hub
    avec_rechargeur = os.environ.get('YUGIQUIZ_NO_RELOAD') != '1'
    # debug=True mettait les artworks en no-cache et empilait le debogueur
    # Werkzeug sur chaque requete d'image : on ne l'active qu'en solo.
    mode_debug = avec_rechargeur
    socketio.run(app, host='0.0.0.0', port=5000,
                 debug=mode_debug, use_reloader=avec_rechargeur,
                 allow_unsafe_werkzeug=True)