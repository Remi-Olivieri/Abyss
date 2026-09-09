#!/usr/bin/env python3
"""Le journal de jeux video, servi depuis la base au lieu de Google Sheets.

app.py branche ce fichier en une ligne :

    app.register_blueprint(journal.blueprint_journal)

Les tables `page` et `jeu` sont creees par comptes.py (migration 2) : le
schema du site tient dans une seule liste, parce que PRAGMA user_version est
un unique compteur pour toute la base.

Ce qui change par rapport aux feuilles
--------------------------------------
Un jeu etait repere par « onglet + numero de ligne ». Il porte maintenant un
`id` qui ne bouge jamais. Renommer une periode, en inserer une, trier
autrement : plus rien ne casse. C'est le vrai gain de la bascule, avant meme
la vitesse.

L'onglet devient la colonne `periode`, avec exactement le meme sens qu'avant :
c'est le tiroir ou le jeu est range. '2026' pour une annee finie, 'En cours'
et 'Wishlist' pour les deux statuts. La page continue de deduire le statut du
nom du tiroir, comme elle le faisait des noms d'onglets.

Les noms different des deux cotes : la base parle francais, le JavaScript
garde les noms qu'il tenait des feuilles (name, base, paid...). La traduction
tient en deux fonctions ci-dessous, ce qui evite de renommer un millier
d'occurrences dans jeux-videos.html.
"""

from __future__ import annotations

import re

from flask import Blueprint, request

import comptes
import jaquettes
import social
from comptes import Refus, actuel, corps, cx, echec, maintenant, reponse

PROJET = "jeux-videos"

# Les seuls champs qu'une ecriture peut toucher, et leur colonne. L'annee, le
# rang et les horodatages sont calcules ici : le navigateur n'a pas a les
# fournir, et ne doit pas pouvoir les inventer.
#
# id_igdb est le seul des quatre champs de la fiche detaillee qu'on accepte
# ici : c'est un simple rattachement, choisi par la fenetre de jaquette
# existante. plateforme/developpeur/genres n'y figurent pas -- ils ne sont
# jamais envoyes par le navigateur, seulement deduits d'id_igdb par
# enrichit_igdb() ci-dessous, pour qu'aucune ecriture ne puisse les inventer.
CHAMPS = {
    "name": "nom",
    "rating": "note",
    "month": "mois",
    "hours": "heures",
    "base": "prix_base",
    "paid": "prix_paye",
    "release": "sortie",
    "id_igdb": "id_igdb",
}

NOM_MAXI = 200
AVIS_MAXI = 5000
JEUX_MAXI = 5000        # par page : garde-fou contre un script qui s'emballe


# --------------------------------------------------------------------------
#   Traduction base <-> page
# --------------------------------------------------------------------------
def en_json(l) -> dict:
    """Une ligne SQL vers l'objet que jeux-videos.html manipule."""
    return {
        "id": l["id"],
        "bucket": l["periode"],
        "name": l["nom"],
        "year": l["annee"],
        "month": l["mois"],
        "rating": l["note"],
        "hours": l["heures"],
        "base": l["prix_base"],
        "paid": l["prix_paye"],
        "release": l["sortie"],
        # la page attend une liste de lignes, comme du temps ou l'avis
        # sortait d'un commentaire de cellule
        "review": [x for x in (l["avis"] or "").splitlines() if x.strip()],
        # pas editables : voir enrichit_igdb(). Absents pour un jeu jamais
        # rattache a une fiche IGDB, comme un jeu ajoute a la main.
        "idIgdb": l["id_igdb"],
        "plateforme": l["plateforme"],
        "developpeur": l["developpeur"],
        "genres": l["genres"],
        # le theme part avec le reste : la mise a jour groupee compare ce
        # champ pour savoir quels jeux d'avant lui manquent encore
        "themes": l["themes"],
    }


def nombre(v, mini=None, maxi=None):
    """Un nombre, ou None. Refuse ce qui n'en est pas un plutot que d'ecrire 0."""
    if v is None or v == "":
        return None
    try:
        n = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        raise Refus("valeur", "Nombre attendu.")
    if n != n or n in (float("inf"), float("-inf")):
        raise Refus("valeur", "Nombre attendu.")
    if mini is not None and n < mini:
        raise Refus("valeur", f"Valeur trop basse (minimum {mini}).")
    if maxi is not None and n > maxi:
        raise Refus("valeur", f"Valeur trop haute (maximum {maxi}).")
    return n


def valeurs_propres(values: dict) -> dict:
    """Filtre et verifie ce qui arrive du formulaire.

    Un champ absent est laisse tranquille par l'appelant ; un champ present a
    None vide bien la case. Cette distinction est la meme que celle du script
    Apps Script, et c'est elle qui permet a la mise a jour IGDB de ne toucher
    qu'a la date et au prix sans reecrire le reste.
    """
    propres = {}
    for cle, colonne in CHAMPS.items():
        if cle not in values:
            continue
        v = values[cle]
        if cle == "name":
            v = str(v or "").strip()
            if not v:
                raise Refus("nom", "Il faut au moins un nom de jeu.")
            propres[colonne] = v[:NOM_MAXI]
        elif cle == "release":
            v = str(v or "").strip()
            propres[colonne] = v[:40] or None
        elif cle == "month":
            propres[colonne] = None if v in (None, "") else int(nombre(v, 1, 12))
        elif cle == "rating":
            # la note est sur 10 partout dans la page (champ, couleurs,
            # classement) : 100 ne serait pas une plage large mais une
            # faute de frappe (85 au lieu de 8,5) acceptee sans un mot
            propres[colonne] = nombre(v, 0, 10)
        elif cle == "hours":
            propres[colonne] = nombre(v, 0, 100000)
        elif cle == "id_igdb":
            propres[colonne] = None if v in (None, "") else int(nombre(v, 1, None))
        else:                                   # prix_base, prix_paye
            propres[colonne] = nombre(v, 0, 100000)
    return propres


def annee_de(periode):
    """'2026' -> 2026. 'En cours' -> None. La periode reste la seule verite."""
    p = (periode or "").strip()
    return int(p) if p.isdigit() and len(p) == 4 else None


# --------------------------------------------------------------------------
#   La forme d'une periode
# --------------------------------------------------------------------------
# Un onglet nomme librement, c'etait « Avant 2025 » a cote de « A long long
# time ago » et de « oui » : trois facons de dire une epoque, dont deux que
# rien ne sait relire. Une periode s'ecrit donc desormais d'une de ces
# quatre facons, et d'aucune autre :
#
#     2019                  une annee
#     Avant 2019            tout ce qui precede
#     Apres 2019            tout ce qui suit
#     Entre 2015 et 2019    un intervalle, la seconde annee apres la premiere
#
# La page ne les fait pas taper : elle les fait choisir (voir le
# constructeur d'onglet dans jeux-videos.html). Ces motifs sont la pour que
# le serveur ne depende pas d'elle -- une ecriture directe sur l'API doit
# obeir aux memes regles.
MOTIF_ANNEE = re.compile(r"^\d{4}$")
MOTIF_AVANT = re.compile(r"^Avant (\d{4})$")
MOTIF_APRES = re.compile(r"^Après (\d{4})$")
MOTIF_ENTRE = re.compile(r"^Entre (\d{4}) et (\d{4})$")

ANNEE_MINI, ANNEE_MAXI = 1950, 2200


def _annee_sensee(*annees):
    return all(ANNEE_MINI <= int(a) <= ANNEE_MAXI for a in annees)


def periode_valide(periode) -> bool:
    """Vrai si la periode suit une des quatre formes. Les statuts aussi :
    « En cours » et « Wishlist » sont des tiroirs fixes, pas des epoques."""
    p = (periode or "").strip()
    if p in STATUTS:
        return True
    if MOTIF_ANNEE.match(p):
        return _annee_sensee(p)
    for motif in (MOTIF_AVANT, MOTIF_APRES):
        m = motif.match(p)
        if m:
            return _annee_sensee(m.group(1))
    m = MOTIF_ENTRE.match(p)
    if m:
        # « Entre 2019 et 2015 » se lit mal et trie mal : l'ordre fait
        # partie de la forme, pas de la presentation.
        return _annee_sensee(*m.groups()) and int(m.group(2)) > int(m.group(1))
    return False


def cle_chrono(periode):
    """De quoi ranger les onglets dans l'ordre du temps, ou None.

    Un couple (annee, rang) :

        Avant 2000            (-1, 2000)     tout ce qui precede, donc en tete
        Entre 2015 et 2019    (2015, 1)      range a son annee de depart
        2019                  (2019, 0)      l'annee elle-meme
        Apres 2019            (2020, 2)      la premiere annee qu'il couvre

    Le second nombre departage deux onglets qui commencent la meme annee :
    l'annee seule d'abord (c'est la plus precise), l'intervalle ensuite,
    l'ouvert en dernier. « 2020 » se lit donc avant « Apres 2019 », qui le
    contient.

    Les « Avant » partagent tous -1 et se departagent par leur annee : deux
    fourre-tout se suivent, du plus etroit au plus large.

    None pour ce que la regle ne sait pas relire -- un onglet d'avant elle
    n'a pas de place dans une frise.
    """
    p = (periode or "").strip()
    m = MOTIF_AVANT.match(p)
    if m:
        return (-1, int(m.group(1)))
    m = MOTIF_ENTRE.match(p)
    if m and int(m.group(2)) > int(m.group(1)):
        return (int(m.group(1)), 1)
    m = MOTIF_APRES.match(p)
    if m:
        return (int(m.group(1)) + 1, 2)
    if MOTIF_ANNEE.match(p):
        return (int(p), 0)
    return None


def periodes_existantes(page_id) -> set:
    """Les periodes deja presentes dans ce journal.

    Sert a laisser vivre ce qui a ete cree avant la regle : « A long long
    time ago » ne se cree plus, mais un jeu qui y est deja doit pouvoir
    etre modifie sans qu'on l'oblige a demenager. Ce qui existe reste,
    ce qui nait obeit.
    """
    return {l["periode"] for l in cx().execute(
        "SELECT DISTINCT periode FROM jeu WHERE page_id = ?", (page_id,)).fetchall()}


def verifie_periode(page_id, periode) -> str:
    """La periode nettoyee, ou un Refus. Voir periodes_existantes."""
    p = (periode or "").strip()[:60]
    if not p:
        raise Refus("periode", "Il faut dire dans quel onglet ranger le jeu.")
    if periode_valide(p) or p in periodes_existantes(page_id):
        return p
    raise Refus("periode", "Un onglet s'écrit « 2019 », « Avant 2019 »,"
                           " « Après 2019 » ou « Entre 2015 et 2019 ».")


# --------------------------------------------------------------------------
#   Pages
# --------------------------------------------------------------------------
# Le compte porte l'identite -- photo et banniere -- et la page porte le
# journal. Les deux voyagent ensemble depuis que l'en-tete du journal montre
# qui l'ecrit.
#
# L'identifiant du compte s'appelle `compte_id` et surtout pas `id` : `p.*`
# ramene deja un `id`, celui de la PAGE, dont tout le fichier se sert. Deux
# colonnes du meme nom sur une ligne sqlite3.Row, et l'une des deux gagne en
# silence -- ici ce serait tout le journal qui lirait le mauvais numero.
IDENTITE = ("p.*, u.pseudo, u.id AS compte_id, u.avatar, u.avatar_maj_le,"
            " u.banniere, u.banniere_maj_le")


def identite(page) -> dict:
    """La photo et la banniere de qui tient ce journal, prets a afficher.

    comptes.url_avatar et url_banniere lisent `id` sur la ligne qu'on leur
    donne ; ici `id` est celui de la page. On leur passe donc les trois
    colonnes qui les concernent, sous les noms qu'ils attendent -- meme
    parade que _avatar() dans social.py, et pour la meme raison.
    """
    compte = {"id": page["compte_id"],
              "avatar": page["avatar"], "avatar_maj_le": page["avatar_maj_le"],
              "banniere": page["banniere"], "banniere_maj_le": page["banniere_maj_le"]}
    return {"avatar": comptes.url_avatar(compte),
            "banniere": comptes.url_banniere(compte)}


def page_de(pseudo):
    return cx().execute(
        f"SELECT {IDENTITE} FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE u.pseudo_norm = ? AND p.projet = ?",
        (comptes.normalise(pseudo), PROJET)).fetchone()


def ma_page(u):
    if u is None:
        return None
    return cx().execute(
        f"SELECT {IDENTITE} FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE p.utilisateur_id = ? AND p.projet = ?", (u["id"], PROJET)).fetchone()


def cree_page(u):
    c = cx()
    with c:
        c.execute("INSERT INTO page(utilisateur_id, projet, titre, cree_le)"
                  " VALUES(?,?,?,?)",
                  (u["id"], PROJET, f"Journal de {u['pseudo']}", maintenant()))
    return ma_page(u)


STATUTS = ("En cours", "Wishlist")

# Les onglets qui ne rangent aucun jeu (voir ONGLETS_VUE cote page).
ONGLETS_VUE = ("all", "stats")


def annuaire():
    """Les journaux publics, avec leur nombre de jeux termines.

    Le compte sert a mettre les journaux vivants en tete : un classeur vide
    n'a aucune raison d'ouvrir la liste. « En cours » et « Wishlist » ne
    sont pas des jeux termines : les compter aurait gonfle le chiffre
    affiche avec des parties pas commencees ou pas finies.
    """
    lignes = cx().execute(
        "SELECT u.id, u.pseudo, u.avatar, u.avatar_maj_le,"
        " u.banniere, u.banniere_maj_le, p.titre,"
        " COUNT(CASE WHEN j.periode NOT IN (?, ?) THEN j.id END) AS jeux"
        " FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " LEFT JOIN jeu j ON j.page_id = p.id"
        " WHERE p.projet = ? AND p.visibilite = 'publique'"
        " GROUP BY p.id ORDER BY jeux DESC, u.pseudo", (*STATUTS, PROJET)).fetchall()
    return [{"pseudo": l["pseudo"], "titre": l["titre"] or f"Journal de {l['pseudo']}",
             "jeux": l["jeux"], "avatar": comptes.url_avatar(l),
             # la banniere sert de fond a la ligne dans la fenetre de
             # recherche, comme l'avatar sert de vignette
             "banniere": comptes.url_banniere(l)} for l in lignes]


def nb_jeux(page_id) -> int:
    """Le nombre de jeux termines, comme dans l'annuaire."""
    return cx().execute(
        "SELECT COUNT(*) FROM jeu WHERE page_id = ? AND periode NOT IN (?, ?)",
        (page_id, *STATUTS)).fetchone()[0]


# --------------------------------------------------------------------------
#   Lecture
# --------------------------------------------------------------------------
def periodes_de(page_id) -> list:
    """Les onglets, dans l'ordre ou la page les affiche.

    Dans l'ordre du temps, puis les onglets que la regle ne sait pas relire,
    puis les deux statuts a la fin. La page s'en sert tel quel pour dessiner
    ses pastilles et remplir son menu : l'ordre se decide ici, une fois, et
    non a deux endroits qui finiraient par ne plus dire la meme chose.

    Chronologique et non alphabetique : « Avant 2000 », « Entre 2015 et
    2019 » et « Apres 2019 » se rangeaient jusqu'ici entre eux par leur
    premiere lettre, ce qui donnait un menu ou l'on ne trouvait rien. Voir
    cle_chrono.

    « En cours » et « Wishlist » sont toujours la, meme sans jeu dedans :
    ce sont des tiroirs fixes du journal, pas des periodes qui apparaissent
    et disparaissent avec ce qu'on y range.

    Un journal tout neuf n'a encore aucune annee : sans exemple, « categorie »
    ne dit rien a personne. L'annee en cours tient lieu de modele, vide,
    jusqu'au premier jeu range ailleurs.
    """
    vues = [l["periode"] for l in cx().execute(
        "SELECT DISTINCT periode FROM jeu WHERE page_id = ?", (page_id,)).fetchall()]
    datees = sorted([p for p in vues if p not in STATUTS and cle_chrono(p) is not None],
                    key=cle_chrono)
    if not datees:
        datees = [maintenant()[:4]]
    # ce que la regle ne sait pas relire n'a pas de place dans le temps : a
    # la fin, dans l'ordre alphabetique, en attendant d'etre renomme
    vieux = sorted(p for p in vues
                   if p not in STATUTS and p not in datees and cle_chrono(p) is None)
    return datees + vieux + list(STATUTS)


def contenu(page, u) -> dict:
    """Le journal complet, tel que la page l'attend."""
    jeux = cx().execute(
        "SELECT * FROM jeu WHERE page_id = ? ORDER BY periode, rang, id",
        (page["id"],)).fetchall()
    return {
        "ok": True,
        "pseudo": page["pseudo"],
        "titre": page["titre"] or f"Journal de {page['pseudo']}",
        # calcule a chaque requete, jamais mis en cache : c'est la reponse a
        # « est-ce que CE visiteur peut ecrire », pas une propriete du journal
        "write": u is not None and u["id"] == page["utilisateur_id"],
        # Le rattrapage n'est propose qu'au proprietaire, et seulement s'il
        # a quelque chose a rattraper : il ecrit dans le classeur, donc un
        # visiteur ne doit jamais le declencher. Se calcule ici, avec les
        # jeux deja en main -- aucune requete de plus.
        "rattrapage": (u is not None and u["id"] == page["utilisateur_id"]
                       and not page["igdb_rattrape_le"]
                       and any(l["id_igdb"] is None for l in jeux)),
        # L'onglet d'ouverture voyage pour tout le monde, pas seulement
        # pour le proprietaire : c'est une propriete du classeur, comme son
        # titre. Un visiteur arrive donc sur l'onglet que son auteur a
        # choisi de montrer en premier.
        "ongletDefaut": page["onglet_defaut"],
        # Qui tient ce journal : sa photo et sa banniere. L'en-tete de la
        # page les affiche en grand, et elles voyagent donc avec le journal
        # plutot que d'etre repechees dans l'annuaire -- lequel ne liste que
        # les journaux PUBLICS, et laisserait donc son proprietaire arriver
        # sans visage sur son propre journal prive.
        **identite(page),
        "periodes": periodes_de(page["id"]),
        "jeux": [en_json(l) for l in jeux],
    }


# --------------------------------------------------------------------------
#   Ecriture
# --------------------------------------------------------------------------
def ma_page_ou_refus():
    """La page de l'utilisateur connecte. Leve si absent ou pas connecte."""
    u = actuel()
    if u is None:
        raise Refus("connexion", "Connecte-toi sur Abyss pour modifier ton journal.", 401)
    page = ma_page(u)
    if page is None:
        raise Refus("page", "Tu n'as pas encore de journal.", 404)
    return u, page


def jeu_a_moi(jeu_id, page):
    """Le jeu, s'il appartient bien a cette page.

    Meme reponse pour « n'existe pas » et « appartient a quelqu'un d'autre » :
    sinon on renseignerait sur le contenu des journaux des autres.
    """
    l = cx().execute("SELECT * FROM jeu WHERE id = ? AND page_id = ?",
                     (jeu_id, page["id"])).fetchone()
    if l is None:
        raise Refus("introuvable", "Ce jeu n'existe pas dans ton journal.", 404)
    return l


def jeu_visible(jeu_id):
    """Le jeu, si sa page est publique ou si c'est la mienne.

    Sert a la fiche detaillee : elle se consulte comme le jeu lui-meme,
    depuis n'importe quel journal public, pas seulement le sien. Meme
    reponse uniforme que jeu_a_moi pour « n'existe pas » et « prive ». """
    l = cx().execute(
        "SELECT jeu.*, page.visibilite AS page_visibilite,"
        " page.utilisateur_id AS page_utilisateur_id"
        " FROM jeu JOIN page ON page.id = jeu.page_id WHERE jeu.id = ?",
        (jeu_id,)).fetchone()
    u = actuel()
    prive = l is not None and l["page_visibilite"] != "publique" \
        and (u is None or u["id"] != l["page_utilisateur_id"])
    if l is None or prive:
        raise Refus("introuvable", "Ce jeu n'existe pas.", 404)
    return l


def rang_suivant(page_id, periode) -> int:
    l = cx().execute("SELECT MAX(rang) FROM jeu WHERE page_id = ? AND periode = ?",
                     (page_id, periode)).fetchone()[0]
    return (l or 0) + 1


def enrichit_igdb(v: dict) -> None:
    """Complete v avec plateforme/developpeur/genres/themes, si v porte un id_igdb.

    Un seul appel IGDB de plus, uniquement quand le jeu vient d'etre
    rattache a une fiche precise (choix d'une jaquette, ou frappe d'un nom
    que la liste deroulante reconnait) -- jamais a chaque sauvegarde d'un
    jeu deja rattache, puisque id_igdb n'est alors pas dans values.

    Au mieux : IGDB injoignable ne fait pas echouer l'ecriture, la fiche
    garde juste ces trois champs vides, comme un jeu jamais rattache.
    """
    id_igdb = v.get("id_igdb")
    if not id_igdb:
        return
    detail, souci = jaquettes.detail_complet(id_igdb)
    if souci or not detail:
        return
    v["plateforme"] = detail.get("plateforme")
    v["developpeur"] = detail.get("developpeur")
    v["genres"] = detail.get("genres")
    v["themes"] = detail.get("themes")


def suit_jaquette(jeu, v: dict) -> None:
    """Renomme la jaquette du jeu si sa cle vient de changer.

    Un jeu qu'on rattache a une fiche IGDB voit son image passer de
    « nom_du_jeu.webp » a « 113112.webp » : sans ce renommage, la page la
    croirait absente et la redemanderait a IGDB alors qu'elle est deja la.

    Le renommage rate sans bruit (fichier absent, destination deja prise) :
    au pire la jaquette sera retelechargee au prochain clic, ce qui n'est
    pas une raison de faire echouer une ecriture qui, elle, a reussi.
    """
    if "id_igdb" not in v:
        return                     # le rattachement n'a pas bouge
    avant = jaquettes.cle_jaquette(jeu["nom"], jeu["id_igdb"])
    apres = jaquettes.cle_jaquette(v.get("nom", jeu["nom"]), v["id_igdb"])
    jaquettes.renomme_jaquette(avant, apres)


def sans_mois(periode, v) -> None:
    """Efface le mois quand la periode n'est pas une annee pleine.

    Un mois ne veut dire quelque chose que dans une annee : « mars » de
    « Avant 2019 » ne designe rien, et « mars » de « En cours » encore
    moins. La regle vit ici et pas seulement dans le formulaire -- c'est
    l'ecriture qui doit la tenir, sinon un appel direct a l'API la
    contournerait, et un jeu deplace de « 2019 » vers « Avant 2019 »
    garderait un mois orphelin.

    On ecrit None plutot que de retirer la cle : le mois d'avant doit
    partir, pas rester tel quel.
    """
    if annee_de(periode) is None:
        v["mois"] = None


def peut_toucher_au_mois(periode, v) -> bool:
    """Cette ecriture-la parle-t-elle de la periode ou du mois ?

    La mise a jour groupee IGDB repasse sur chaque jeu pour n'y ecrire
    qu'une date de sortie et un prix. Elle ne dit rien de l'onglet, et
    n'a donc rien a effacer : sans ce garde-fou, un rafraichissement de
    routine viderait au passage le mois de tous les jeux ranges ailleurs
    que dans une annee. On ne nettoie que ce qu'on est en train d'ecrire.
    """
    return periode is not None or "mois" in v


def ajoute(page, periode, values, avis):
    if cx().execute("SELECT COUNT(*) FROM jeu WHERE page_id = ?",
                    (page["id"],)).fetchone()[0] >= JEUX_MAXI:
        raise Refus("plein", "Ce journal a atteint sa limite de jeux.", 409)
    periode = verifie_periode(page["id"], periode)
    v = valeurs_propres(values)
    if "nom" not in v:
        raise Refus("nom", "Il faut au moins un nom de jeu.")
    sans_mois(periode, v)
    enrichit_igdb(v)
    colonnes = ["page_id", "periode", "annee", "avis", "rang", "cree_le", "maj_le"]
    donnees = [page["id"], periode, annee_de(periode), (avis or "")[:AVIS_MAXI],
               rang_suivant(page["id"], periode), maintenant(), maintenant()]
    for col, val in v.items():
        colonnes.append(col)
        donnees.append(val)
    c = cx()
    with c:
        cur = c.execute(f"INSERT INTO jeu({','.join(colonnes)})"
                        f" VALUES({','.join('?' * len(colonnes))})", donnees)
    # l'identifiant sert au fil du Social, qui annonce en direct les jeux
    # termines (voir social.annonce_jeu)
    return cur.lastrowid


def modifie(jeu, page, periode, values, avis):
    """Ne touche qu'aux champs recus.

    Un champ absent de `values` reste tel quel, un champ a None se vide. La
    mise a jour groupee IGDB repose entierement la-dessus : elle envoie la
    date et le prix, et le reste du jeu n'est pas reecrit.
    """
    v = valeurs_propres(values)
    enrichit_igdb(v)
    if periode is not None:
        periode = verifie_periode(page["id"], periode)
        if periode != jeu["periode"]:
            v["periode"] = periode
            v["annee"] = annee_de(periode)
            v["rang"] = rang_suivant(page["id"], periode)
    if peut_toucher_au_mois(periode, v):
        sans_mois(periode if periode is not None else jeu["periode"], v)
    if avis is not None:
        v["avis"] = avis[:AVIS_MAXI]
    if not v:
        return
    v["maj_le"] = maintenant()
    c = cx()
    with c:
        c.execute(f"UPDATE jeu SET {','.join(k + ' = ?' for k in v)} WHERE id = ?",
                  list(v.values()) + [jeu["id"]])

    suit_jaquette(jeu, v)


# ==========================================================================
#   Routes
# ==========================================================================
blueprint_journal = Blueprint("journal", __name__, url_prefix="/api/journal")


@blueprint_journal.before_request
def exige_json():
    """Meme parade CSRF que pour les comptes : les ecritures sont en JSON."""
    # Seules les methodes qui portent un corps sont concernees. DELETE n'en a
    # pas, et n'a pas besoin de la regle : un formulaire HTML ne sait emettre
    # que GET et POST, et un fetch DELETE d'un autre site declenche un pre-vol
    # CORS. Exiger un type de contenu la aurait juste casse la suppression.
    if request.method in ("POST", "PUT", "PATCH") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les ecritures attendent du JSON.", 415)
    return None


@blueprint_journal.errorhandler(Refus)
def refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_journal.get("")
def liste():
    """L'annuaire : qui a un journal, et le mien s'il existe.

    Le sien porte son nombre de jeux, comme les autres : un journal prive
    n'apparait pas dans l'annuaire public, sa page le sait quand meme.
    """
    u = actuel()
    mienne = ma_page(u)
    moi = None if mienne is None else {
        "pseudo": mienne["pseudo"], "jeux": nb_jeux(mienne["id"]),
        "avatar": comptes.url_avatar(u),   # u vient de actuel() : u.* complet
        "banniere": comptes.url_banniere(u),
    }
    return reponse({"ok": True,
                    "journaux": annuaire(),
                    "connecte": u is not None,
                    "moi": moi,
                    # la pastille de la cloche voyage avec l'annuaire : la
                    # page demande deja cette reponse-la pour savoir quel
                    # journal ouvrir, un second aller-retour pour un chiffre
                    # serait un aller-retour de trop
                    "notificationsNeuves": comptes.notifications_neuves(u)})


@blueprint_journal.post("")
def creer():
    """Cree mon journal. Rejouable : renvoie l'existant plutot qu'une erreur."""
    u = actuel()
    if u is None:
        return echec("connexion", "Connecte-toi sur Abyss pour creer ton journal.", 401)
    page = ma_page(u) or cree_page(u)
    return reponse(contenu(page, u), 201)


@blueprint_journal.get("/<pseudo>")
def lire(pseudo):
    page = page_de(pseudo)
    if page is None:
        return echec("introuvable", "Ce journal n'existe pas.", 404)
    u = actuel()
    if page["visibilite"] != "publique" and (u is None or u["id"] != page["utilisateur_id"]):
        return echec("prive", "Ce journal est prive.", 403)
    return reponse(contenu(page, u))


BANNIERE_NOTE = 9.0    # « les jeux que j'ai adores », pas « bien aimes »
BANNIERE_JEUX = 12     # de quoi choisir sans faire une requete enorme


@blueprint_journal.get("/banniere/propositions")
def propositions_banniere():
    """Des images de banniere tirees de mes jeux les mieux notes.

    Rien n'est telecharge : on renvoie des adresses d'IGDB, que la page
    affiche directement et dont une seule finira en banniere -- toujours
    comme une adresse (voir comptes.url_banniere). Choisir une banniere ne
    coute donc ni octet sur le disque, ni attente.

    Un jeu sans id_igdb n'a pas de fiche a interroger : il est simplement
    absent de la liste. Le rattrapage automatique en rattache la plupart,
    et la mise a jour manuelle finit le travail.
    """
    u, page = ma_page_ou_refus()
    lignes = cx().execute(
        "SELECT DISTINCT id_igdb FROM jeu WHERE page_id = ? AND note >= ?"
        " AND id_igdb IS NOT NULL ORDER BY note DESC LIMIT ?",
        (page["id"], BANNIERE_NOTE, BANNIERE_JEUX)).fetchall()
    if not lignes:
        return reponse({"ok": True, "images": [], "note": BANNIERE_NOTE})
    images, souci = jaquettes.images_larges([l["id_igdb"] for l in lignes])
    if souci and not images:
        return echec("injoignable", souci, 502)
    return reponse({"ok": True, "images": images, "note": BANNIERE_NOTE})


@blueprint_journal.post("/onglet-defaut")
def onglet_defaut():
    """L'onglet sur lequel mon classeur s'ouvre. `null` pour l'oublier.

    La valeur est verifiee contre les onglets qui existent vraiment : on
    n'enregistre pas un nom que la page n'affichera jamais. Elle peut
    quand meme se perimer plus tard -- le dernier jeu d'une annee change
    de tiroir et l'onglet disparait -- et c'est normal : la page retombe
    alors sur « Tout », comme pour n'importe quel onglet absent.
    """
    u, page = ma_page_ou_refus()
    onglet = corps().get("onglet")
    if onglet is not None:
        onglet = str(onglet).strip()
        # « all » et « stats » sont des vues, pas des tiroirs : elles ne
        # figurent pas dans periodes_de() et doivent etre admises a part.
        if onglet not in ONGLETS_VUE and onglet not in periodes_de(page["id"]):
            raise Refus("onglet", "Cet onglet n'existe pas.")
    c = cx()
    with c:
        c.execute("UPDATE page SET onglet_defaut = ? WHERE id = ?",
                  (onglet or None, page["id"]))
    return reponse(contenu(ma_page(u), u))


@blueprint_journal.post("/rattrapage")
def rattrapage_fait():
    """« Ne me repropose plus le rattrapage automatique. »

    Appelee quand la passe s'est terminee, mais aussi quand elle est
    ecartee : dans les deux cas la question a ete posee et tranchee, et la
    reposer a chaque ouverture serait du harcelement. Ce qui n'a pas ete
    rattache reste accessible par la mise a jour manuelle, qui elle ne
    s'efface jamais.
    """
    u, page = ma_page_ou_refus()
    c = cx()
    with c:
        c.execute("UPDATE page SET igdb_rattrape_le = ? WHERE id = ?",
                  (maintenant(), page["id"]))
    return reponse({"ok": True})


@blueprint_journal.post("/jeu")
def ajouter():
    u, page = ma_page_ou_refus()
    d = corps()
    jeu_id = ajoute(page, d.get("periode"), d.get("values") or {},
                    d.get("review") or "")
    # Le fil du Social, en direct. Apres l'ecriture et jamais avant : on
    # annonce ce qui est en base, pas ce qu'on s'apprete a y mettre. Un jeu
    # ajoute en « En cours » ou en « Wishlist », ou dans un journal prive,
    # n'annonce rien -- social.annonce_jeu repose la question de la
    # visibilite et se tait si la reponse est non.
    social.annonce_jeu(jeu_id)
    return reponse(contenu(page, u), 201)


@blueprint_journal.put("/jeu/<int:jeu_id>")
def modifier(jeu_id):
    u, page = ma_page_ou_refus()
    d = corps()
    # Avant l'ecriture : c'est la seule facon de savoir si la ligne ENTRE
    # dans le fil ou en SORT. Terminer un jeu qui etait « En cours » est de
    # loin la facon la plus courante d'arriver dans le fil -- on ne l'y
    # ajoute pas, on l'y fait passer.
    etait_visible = social.visible_dans_le_fil(jeu_id)
    modifie(jeu_a_moi(jeu_id, page), page, d.get("periode"),
            d.get("values") or {}, d.get("review"))
    social.annonce_changement(jeu_id, etait_visible)
    return reponse(contenu(page, u))


@blueprint_journal.get("/jeu/<int:jeu_id>/detail")
def detail(jeu_id):
    """La fiche detaillee d'un jeu : consultable comme le jeu lui-meme,
    depuis n'importe quel journal public.

    plateforme/developpeur/genres/themes viennent de la base (voir
    enrichit_igdb).
    Le reste -- description, captures, bande-annonce, note critique, temps
    pour finir -- est redemande a IGDB et HowLongToBeat a chaque ouverture,
    jamais stocke (voir jaquettes.detail_complet et jaquettes.temps_hltb).

    id_igdb peut manquer : un jeu ajoute avant cette fonctionnalite, ou
    jamais rattache a une fiche. On cherche alors par nom, comme le fait
    deja la mise a jour groupee -- en degrade, pas en echec.
    """
    jeu = jeu_visible(jeu_id)
    id_igdb, souci = jeu["id_igdb"], None
    if not id_igdb:
        fiches, souci = jaquettes.toutes_les_fiches(jeu["nom"])
        if not souci and fiches:
            choix, _surete = jaquettes.retenue_pour(fiches, jeu["annee"])
            id_igdb = choix["id"] if choix else None

    complet = None
    if id_igdb:
        complet, souci = jaquettes.detail_complet(id_igdb)
    temps, _souci_hltb = jaquettes.temps_hltb(jeu["nom"])
    if not complet and not temps and souci:
        return echec("injoignable", souci, 502)
    return reponse(dict({
        "ok": True,
        "plateforme": jeu["plateforme"],
        "developpeur": jeu["developpeur"],
        "genres": jeu["genres"],
        "themes": jeu["themes"],
    }, **(complet or {}), hltb=temps))


@blueprint_journal.put("/periode")
def renomme_periode():
    """Renomme un onglet, et avec lui tous les jeux qui y sont ranges.

    C'est la sortie de secours des journaux d'avant la regle : « A long
    long time ago » ne peut plus etre cree, mais il existe, et il faut bien
    pouvoir le tourner en « Avant 2000 » sans rouvrir trois cents jeux un
    par un.

    Renommer vers un onglet qui existe deja les fusionne, et c'est voulu :
    « oui » et « 2019 » finissent souvent par designer la meme annee. Les
    jeux deplaces se rangent alors a la suite de ceux qui y etaient, d'ou le
    decalage des rangs -- deux jeux au meme rang, c'est un ordre d'affichage
    qui depend du hasard.

    Le nom d'arrivee, lui, doit etre valide sans exception : cette route
    existe precisement pour sortir des noms qui ne le sont pas.
    """
    u, page = ma_page_ou_refus()
    d = corps()
    avant = str(d.get("avant") or "").strip()
    apres = str(d.get("apres") or "").strip()[:60]
    if avant in STATUTS or apres in STATUTS:
        raise Refus("periode", "« En cours » et « Wishlist » ne se renomment pas.")
    if not avant or avant not in periodes_existantes(page["id"]):
        raise Refus("periode", "Cet onglet n'existe pas.", 404)
    if not periode_valide(apres):
        raise Refus("periode", "Un onglet s'écrit « 2019 », « Avant 2019 »,"
                               " « Après 2019 » ou « Entre 2015 et 2019 ».")
    if apres == avant:
        return reponse(contenu(page, u))

    annee = annee_de(apres)
    c = cx()
    with c:
        decalage = rang_suivant(page["id"], apres)
        c.execute(
            "UPDATE jeu SET periode = ?, annee = ?, rang = rang + ?, maj_le = ?,"
            "               mois = CASE WHEN ? IS NULL THEN NULL ELSE mois END"
            " WHERE page_id = ? AND periode = ?",
            (apres, annee, decalage, maintenant(), annee, page["id"], avant))
        # l'onglet d'ouverture suivait ce nom-la : il suit le nouveau, sans
        # quoi le classeur s'ouvrirait sur un onglet qui n'existe plus
        if page["onglet_defaut"] == avant:
            c.execute("UPDATE page SET onglet_defaut = ? WHERE id = ?",
                      (apres, page["id"]))
    return reponse(contenu(page_de(u["pseudo"]) or page, u))


@blueprint_journal.delete("/jeu/<int:jeu_id>")
def supprimer(jeu_id):
    u, page = ma_page_ou_refus()
    jeu = jeu_a_moi(jeu_id, page)
    # avant la suppression, tant que la ligne existe encore : apres, plus
    # personne ne peut dire si elle avait sa place dans le fil
    etait_visible = social.visible_dans_le_fil(jeu_id)
    c = cx()
    with c:
        c.execute("DELETE FROM jeu WHERE id = ?", (jeu["id"],))
    if etait_visible:
        social.annonce_retrait(jeu_id)
    return reponse(contenu(page, u))


@blueprint_journal.put("/lot")
def lot():
    """Modifications groupees, pour la mise a jour IGDB.

    Vingt jeux en une requete au lieu de vingt. Un jeu qui echoue n'annule
    pas les autres : ses motifs remontent dans `echecs`, comme le faisait
    l'ancienne action « lot » du script.
    """
    u, page = ma_page_ou_refus()
    modifs = corps().get("modifs") or []
    if not isinstance(modifs, list) or len(modifs) > 100:
        return echec("format", "Liste de modifications attendue (100 au plus).", 400)
    echecs = []
    for i, m in enumerate(modifs):
        try:
            jeu = jeu_a_moi(int(m.get("id", 0)), page)
            modifie(jeu, page, m.get("periode"), m.get("values") or {}, m.get("review"))
        except Refus as err:
            echecs.append({"i": i, "jeu": (m.get("values") or {}).get("name"),
                           "error": err.message})
        except (TypeError, ValueError):
            echecs.append({"i": i, "jeu": None, "error": "identifiant illisible"})
    return reponse(dict(contenu(page, u), fait={"echecs": echecs}))
