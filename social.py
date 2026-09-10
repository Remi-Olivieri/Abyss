"""Le social de l'Archive Jeux Videos : le fil, les j'aime, les commentaires
et les notifications.

Ce dont on parle
----------------
Tout s'accroche a UNE ligne de journal -- « le Silksong de Jokrem » -- et non
au titre du jeu. Un jeu n'est pas un sujet de discussion en soi : ce qu'on
commente, c'est ce que quelqu'un en a dit dans son journal, avec sa note, son
temps de jeu et ses points positifs et negatifs. Deux personnes qui finissent
le meme jeu ouvrent donc deux fils separes.

La page « Avis » (voir avis_du_jeu) est ce qui les rassemble : elle part d'un
titre et liste toutes les lignes de journal qui le portent, celles qui ont un
avis ecrit d'abord. On y entre par un titre, on en ressort dans un fil.

Ce qui est visible
------------------
Les journaux publics, et rien d'autre. Un journal repasse en prive et ses
lignes quittent le fil le temps qu'il le reste -- les commentaires, eux,
restent en base et reviennent avec lui. C'est verifie a chaque lecture et a
chaque ecriture (voir _ligne_visible) plutot qu'au moment de publier : la
visibilite d'une page change apres coup, une copie prise a l'ecriture aurait
menti dans un sens comme dans l'autre.

Seuls les jeux TERMINES entrent dans le fil : « En cours » et « Wishlist » ne
racontent pas encore quelque chose qu'on puisse commenter.

Qui peut ecrire
---------------
Il faut un compte pour aimer et pour commenter ; il n'en faut pas pour lire.
C'est la meme regle que le reste de l'Archive, ou le journal de quelqu'un
s'ouvre a qui a le lien.

Les notifications
-----------------
Ecrites au moment du geste, jamais deduites apres coup. Quatre cas -- on a
aime ta ligne, on l'a commentee, on a repondu a ton commentaire, on a parle
apres toi -- et le dernier est la raison de cette table : « quelqu'un a
commente un fil ou tu as commente » ne se retrouve pas sans rejouer toute la
table des commentaires. Une notification est aussi un fait date -- elle doit
survivre au retrait du j'aime qui l'a provoquee.

Une discussion a deux niveaux
-----------------------------
Un commentaire, et des reponses sous lui. Pas trois niveaux : `parent_id` ne
pointe jamais vers une reponse (voir _parent_ou_refus), parce qu'un fil qui
s'indente a l'infini ne se lit plus sur la largeur d'un telephone. Repondre a
une reponse revient donc a repondre au commentaire qui la porte, et la
mention du pseudo dans le texte dit a qui l'on parle.
"""

from __future__ import annotations

import re
import unicodedata

from flask import Blueprint, request
from flask_socketio import join_room

import comptes
from comptes import Refus, actuel, corps, cx, echec, maintenant, reponse

PROJET = "jeux-videos"

# Les deux onglets qui ne rangent pas des jeux termines. Repris de journal.py
# a l'identique -- le fil doit dire la meme chose que le journal sur ce qui
# compte comme « termine », sans quoi l'un annoncerait des jeux que l'autre
# ne compte pas.
STATUTS = ("En cours", "Wishlist")

# Une page de fil. Assez pour remplir un ecran et le suivant, assez peu pour
# que la premiere reponse arrive vite : c'est la page d'accueil du social.
FEED_LOT = 20

# Au-dela, ce n'est plus un commentaire mais un billet, et rien dans la carte
# n'est fait pour le lire. Le compte se fait sur les caracteres tapes, pas sur
# les octets : personne ne compte en UTF-8.
COMMENTAIRE_MAX = 1000

# Les notifications gardees a l'ecran. Au-dela on ne les lit plus, on les
# subit -- et celles qui comptent sont les recentes.
NOTIFS_MAX = 40

# Le debit des commentaires reprend le compteur d'essais du site
# (comptes.note_essai) plutot que d'en ouvrir un second : dix gestes par
# quart d'heure, la meme regle que partout ailleurs. Une conversation ne
# depasse pas ce rythme ; un script, si.


# --------------------------------------------------------------------------
#   Le titre d'un jeu, reduit a ce qui l'identifie
# --------------------------------------------------------------------------
def slug(nom) -> str:
    """« Pokémon GO » et « pokemon go » donnent la meme chose.

    Meme regle que le slug() de jaquettes.py, et pour la meme raison : deux
    journaux ecrivent rarement un titre a l'identique, entre les accents, les
    deux-points et les majuscules. C'est cette forme-la qui rassemble les
    avis d'un meme jeu quand les fiches IGDB manquent.
    """
    texte = unicodedata.normalize("NFD", str(nom or ""))
    texte = "".join(c for c in texte if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "-", texte.lower()).strip("-")


def _avec_slug(c):
    """Rend `slug` utilisable dans une requete SQL.

    Comparer les titres en Python demanderait de lire toutes les lignes de
    tous les journaux pour n'en garder qu'une poignee. SQLite sait appeler
    une fonction Python : autant la lui donner et le laisser filtrer.

    Reenregistree a chaque usage : c'est un appel C sans cout mesurable, et
    la connexion est creee par comptes.cx(), qui n'a pas a connaitre les
    besoins du social.
    """
    c.create_function("slug", 1, slug, deterministic=True)
    return c


# --------------------------------------------------------------------------
#   Lecture
# --------------------------------------------------------------------------
# Tout ce qu'une carte du fil affiche. En constante parce que quatre requetes
# la reprennent mot pour mot -- le fil, un fil seul, la page « Avis » et la
# notification qui renvoie vers l'un d'eux -- et qu'un champ ajoute a l'une
# sans les autres donnerait des cartes qui ne se ressemblent plus.
CHAMPS_POST = (
    "j.id, j.nom, j.note, j.heures, j.mois, j.annee, j.periode, j.avis,"
    " j.id_igdb, j.cree_le,"
    " u.id AS auteur_id, u.pseudo, u.avatar, u.avatar_maj_le"
)

DE_LA_LIGNE = (
    " FROM jeu j"
    " JOIN page p ON p.id = j.page_id"
    " JOIN utilisateur u ON u.id = p.utilisateur_id"
)

# Ce qui a le droit d'apparaitre : un jeu termine, dans un journal public.
VISIBLE = (
    " p.projet = ? AND p.visibilite = 'publique'"
    " AND j.periode NOT IN (?, ?)"
)
VISIBLE_ARGS = (PROJET, *STATUTS)

# L'ordre du fil : la date d'entree dans le fil, c'est-a-dire le jour ou le
# jeu a ete TERMINE, et non celui ou sa ligne a ete creee. On ajoute souvent
# un jeu bien avant de le finir -- range en « Wishlist » en janvier, termine
# en septembre -- et l'ordre des identifiants l'aurait alors pose au milieu du
# fil, sous des dizaines de jeux plus recents.
#
# COALESCE parce que `entre_le` peut manquer sur une ligne ancienne que la
# migration 18 n'aurait pas vue : `cree_le` est alors ce que le fil montrait
# jusqu'ici, ce qui est la bonne reponse par defaut.
ENTREE = "COALESCE(j.entre_le, j.cree_le)"


def _avatar(ligne):
    """L'adresse de la photo de profil de l'auteur d'une ligne.

    comptes.url_avatar construit le chemin a partir de trois colonnes de la
    ligne qu'on lui donne : `id`, `avatar` et `avatar_maj_le`. Or ici `id`
    est celui de la table de tete -- le jeu, le commentaire, la notification
    -- et l'auteur voyage sous `auteur_id`, parce que les deux ne peuvent pas
    porter le meme nom dans un SELECT.

    Lui passer la ligne telle quelle batissait donc l'adresse sur le mauvais
    identifiant : /static/Avatars/<numero du jeu>.jpg, un fichier qui
    n'existe pas. Toutes les photos manquaient, et seules les initiales
    s'affichaient.
    """
    return comptes.url_avatar({"id": ligne["auteur_id"],
                               "avatar": ligne["avatar"],
                               "avatar_maj_le": ligne["avatar_maj_le"]})


def _post(ligne, u, jaime=0, aime=False, commentaires=0) -> dict:
    """Une ligne de journal telle que la carte du fil l'attend.

    `avis` part decoupe en lignes, comme dans journal.en_json : la page range
    les « + » d'un cote et les « - » de l'autre, et c'est elle qui sait a
    quoi ils ressemblent.
    """
    return {
        "id": ligne["id"],
        "pseudo": ligne["pseudo"],
        "avatar": _avatar(ligne),
        "nom": ligne["nom"],
        "note": ligne["note"],
        "heures": ligne["heures"],
        # le mois et l'annee de fin : c'est la date que la carte affiche,
        # et non l'anciennete de la ligne. « septembre 2026 » dit quand on a
        # fini le jeu ; « il y a deux jours » ne disait que quand on l'avait
        # note, ce qui n'interesse personne.
        "mois": ligne["mois"],
        "annee": ligne["annee"],
        # l'onglet quand l'annee manque : « Avant 2000 » n'est pas une annee
        # mais c'est quand meme la seule date qu'on ait, et la carte
        # l'affiche plutot que rien
        "periode": ligne["periode"],
        "avis": [x for x in (ligne["avis"] or "").splitlines() if x.strip()],
        # la page reconstruit l'adresse de la jaquette elle-meme (voir
        # cleJaquette dans archive-noyau.js) : elle a le manifeste, donc elle
        # sait ce qui existe sur le disque et ce qui n'y est pas
        "idIgdb": ligne["id_igdb"],
        "jaime": jaime,
        # `null` et non `false` pour un visiteur : le coeur est alors une
        # invitation a se connecter, pas un coeur vide qu'on aurait le droit
        # de remplir
        "aime": aime if u is not None else None,
        "commentaires": commentaires,
        "moi": u is not None and u["id"] == ligne["auteur_id"],
    }


def _compte(ids) -> tuple[dict, dict]:
    """Les j'aime et les commentaires de plusieurs lignes, en deux requetes.

    Une par carte en aurait fait quarante pour une page de fil. GROUP BY les
    fait toutes d'un coup, et une ligne sans rien n'apparait simplement pas
    dans le resultat -- d'ou les .get(id, 0) chez l'appelant.
    """
    if not ids:
        return {}, {}
    trous = ",".join("?" * len(ids))
    aimes = {l["jeu_id"]: l["n"] for l in cx().execute(
        f"SELECT jeu_id, COUNT(*) AS n FROM jaime"
        f" WHERE jeu_id IN ({trous}) GROUP BY jeu_id", ids)}
    dits = {l["jeu_id"]: l["n"] for l in cx().execute(
        f"SELECT jeu_id, COUNT(*) AS n FROM commentaire"
        f" WHERE jeu_id IN ({trous}) GROUP BY jeu_id", ids)}
    return aimes, dits


def _miens(ids, u) -> set:
    """Parmi ces lignes, celles que cette personne a deja aimees."""
    if not ids or u is None:
        return set()
    trous = ",".join("?" * len(ids))
    return {l["jeu_id"] for l in cx().execute(
        f"SELECT jeu_id FROM jaime WHERE utilisateur_id = ?"
        f" AND jeu_id IN ({trous})", (u["id"], *ids))}


def _habille(lignes, u) -> list:
    """Des lignes SQL vers des cartes completes, compteurs compris."""
    ids = [l["id"] for l in lignes]
    aimes, dits = _compte(ids)
    miens = _miens(ids, u)
    return [_post(l, u, aimes.get(l["id"], 0), l["id"] in miens,
                  dits.get(l["id"], 0)) for l in lignes]


def fil(u, avant=None, limite=FEED_LOT) -> dict:
    """Le fil : les derniers jeux termines, du plus recent au plus ancien.

    « Recent » se compte a la date d'entree dans le fil (voir ENTREE), et
    l'identifiant departage les jeux termines la meme seconde -- deux lignes
    importees ensemble en ont beaucoup.

    Le curseur reste un identifiant de ligne, et non le couple date+id qui
    fait l'ordre : un entier tient dans une adresse, ne se reencode pas et ne
    se perime pas. C'est la requete qui va relire la date de cette ligne-la,
    et la comparaison porte sur le couple entier -- comparer la seule date
    aurait saute les jeux termines a la meme seconde que le dernier affiche.
    """
    conditions = [VISIBLE]
    args = list(VISIBLE_ARGS)
    if avant:
        conditions.append(
            f" ({ENTREE}, j.id) <"
            " (SELECT COALESCE(entre_le, cree_le), id FROM jeu WHERE id = ?)")
        args.append(int(avant))
    lignes = cx().execute(
        f"SELECT {CHAMPS_POST}{DE_LA_LIGNE}"
        f" WHERE {' AND '.join(conditions)}"
        f" ORDER BY {ENTREE} DESC, j.id DESC LIMIT ?",
        (*args, int(limite) + 1)).fetchall()

    # une ligne de plus que demande : sa presence dit qu'il y a une suite,
    # sans avoir a compter tout le fil pour le savoir
    encore = len(lignes) > limite
    lignes = lignes[:limite]
    return {
        "ok": True,
        "posts": _habille(lignes, u),
        "suite": lignes[-1]["id"] if (encore and lignes) else None,
    }


def _ligne_visible(jeu_id):
    """La ligne de journal, ou None si elle n'a rien a faire ici.

    Un seul chemin pour toutes les routes : lire un fil, l'aimer, le
    commenter. Chacune poserait sinon sa propre question sur la visibilite,
    et il suffirait d'en oublier une.
    """
    return cx().execute(
        f"SELECT {CHAMPS_POST}{DE_LA_LIGNE}"
        f" WHERE j.id = ? AND {VISIBLE}", (jeu_id, *VISIBLE_ARGS)).fetchone()


def _ligne_ou_refus(jeu_id):
    ligne = _ligne_visible(jeu_id)
    if ligne is None:
        raise Refus("introuvable", "Ce jeu n'existe pas ou son journal est privé.", 404)
    return ligne


def _compte_commentaires(ids, u) -> tuple[dict, set]:
    """Les coeurs de plusieurs commentaires, et ceux qu'on a mis soi-meme.

    Jumelle de _compte() et _miens() plus haut, pour la table jumelle : deux
    requetes pour tout un fil, et un commentaire sans coeur n'apparait
    simplement pas dans le resultat -- d'ou les .get(id, 0) chez l'appelant.
    """
    if not ids:
        return {}, set()
    trous = ",".join("?" * len(ids))
    aimes = {l["commentaire_id"]: l["n"] for l in cx().execute(
        f"SELECT commentaire_id, COUNT(*) AS n FROM jaime_commentaire"
        f" WHERE commentaire_id IN ({trous}) GROUP BY commentaire_id", ids)}
    miens = set()
    if u is not None:
        miens = {l["commentaire_id"] for l in cx().execute(
            f"SELECT commentaire_id FROM jaime_commentaire WHERE utilisateur_id = ?"
            f" AND commentaire_id IN ({trous})", (u["id"], *ids))}
    return aimes, miens


def _journaux_publics(ids) -> set:
    """Parmi ces comptes, ceux dont le journal de jeux est public.

    Sert a distinguer deux silences qui ne se ressemblent pas : « cette
    personne n'a pas ce jeu » -- une information, qu'on peut ecrire -- et
    « on n'en sait rien », parce qu'elle n'a pas de journal ou qu'il est
    ferme. Sans cette liste, les deux donnaient la meme case vide, et ecrire
    « pas joue » dans les deux cas aurait ete un mensonge une fois sur deux.
    """
    if not ids:
        return set()
    trous = ",".join("?" * len(ids))
    return {l["utilisateur_id"] for l in cx().execute(
        f"SELECT utilisateur_id FROM page"
        f" WHERE projet = ? AND visibilite = 'publique'"
        f" AND utilisateur_id IN ({trous})", (PROJET, *ids))}


def _etats_des_auteurs(ligne, ids) -> dict:
    """Ce que chacun de ces comptes a fait DU JEU dont on parle.

    Ce qui manquait a une reponse : « c'est mon jeu de l'annee » ne veut pas
    dire la meme chose sous la plume de quelqu'un qui l'a mis a 9 et de
    quelqu'un qui l'a mis a 6. La note est deja dans son journal, il n'y a
    rien a lui demander -- juste a aller la lire.

    Trois reponses possibles, et le silence en vaut une quatrieme :

      {"joue": True,  "note": 8.9}  -- il l'a fini, et note
      {"joue": True,  "note": None} -- il l'a fini sans le noter
      {"joue": False, "note": None} -- il ne l'a pas fait, et on le sait
      absent du dictionnaire      -- on n'en sait rien (journal prive ou
                                     inexistant), et on n'ecrit rien

    La derniere ligne compte autant que les autres : deviner « pas joue »
    d'un journal ferme reviendrait a affirmer quelque chose qu'on n'a pas le
    droit de lire.

    Meme facon de reconnaitre le meme jeu que la page « Avis » : la fiche
    IGDB d'abord quand les deux lignes en ont une, le titre reduit a son slug
    sinon (voir avis_du_jeu). Et meme regle de visibilite que partout
    ailleurs -- ce qu'on lit vient d'un journal PUBLIC.
    """
    if not ids or ligne is None:
        return {}
    cle = slug(ligne["nom"])
    id_igdb = ligne["id_igdb"]
    if not cle and not id_igdb:
        return {}
    # le point de depart : ceux dont on a le droit de parler. Les autres
    # n'entreront jamais dans le resultat, quoi que dise la suite.
    connus = _journaux_publics(ids)
    etats = {uid: {"joue": False, "note": None} for uid in connus}
    if not connus:
        return {}

    trous = ",".join("?" * len(connus))
    quel = ["slug(j.nom) = ?"]
    args = [cle]
    if id_igdb:
        quel.append("j.id_igdb = ?")
        args.append(int(id_igdb))
    lignes = _avec_slug(cx()).execute(
        f"SELECT p.utilisateur_id AS uid, j.note, j.id_igdb"
        f"{DE_LA_LIGNE}"
        f" WHERE {VISIBLE}"
        f" AND p.utilisateur_id IN ({trous})"
        f" AND ({' OR '.join(quel)})"
        # deux tris, et le second n'est pas un detail : la ligne rattachee a
        # la meme fiche IGDB passe devant -- c'est un identifiant, il ne se
        # discute pas, la ou deux titres qui donnent le meme slug peuvent
        # etre deux jeux differents (une suite, un remake). Et a fiche egale,
        # une ligne notee passe devant une ligne sans note : quelqu'un qui a
        # le jeu deux fois dans son journal l'a bien note quelque part.
        f" ORDER BY (j.id_igdb IS NOT NULL AND j.id_igdb = ?) DESC,"
        f" (j.note IS NOT NULL) DESC, j.id DESC",
        (*VISIBLE_ARGS, *sorted(connus), *args, id_igdb)).fetchall()
    for l in lignes:
        etat = etats[l["uid"]]
        if etat["joue"]:
            continue                      # deja servi par une meilleure ligne
        etat["joue"] = True
        etat["note"] = l["note"]
    return etats


def _commentaire(l, u, proprietaire, etats, aimes, miens) -> dict:
    """Un commentaire tel que la discussion l'affiche."""
    return {
        "id": l["id"],
        "pseudo": l["pseudo"],
        "avatar": _avatar(l),
        "texte": l["texte"],
        "quand": l["cree_le"],
        # `maj_le` non nul veut dire « retouche depuis » : la page ecrit
        # « modifie » sous ceux-la, et rien sous les autres. Pas de
        # comparaison de dates a la seconde pres -- une colonne vide est une
        # reponse plus franche.
        "modifie": bool(l["maj_le"]),
        # ce qu'il a fait de ce jeu-la, quand son journal est ouvert : sa
        # note, ou le fait qu'il l'a fini sans noter, ou qu'il ne l'a pas
        # fait. `null` quand on n'en sait rien -- la page n'ecrit alors rien
        # du tout plutot que d'inventer. Voir _etats_des_auteurs.
        "sonJeu": etats.get(l["auteur_id"]),
        "jaime": aimes.get(l["id"], 0),
        # `null` et non `false` pour un visiteur, comme sur une carte : le
        # coeur est alors une invitation a se connecter
        "aime": (l["id"] in miens) if u is not None else None,
        # « mien » veut dire « c'est moi qui l'ai ecrit », et c'est ce qui
        # ouvre la modification : on ne retouche pas les mots de quelqu'un
        # d'autre, meme chez soi.
        "mien": u is not None and u["id"] == l["auteur_id"],
        # effacer, en revanche, va plus loin : le proprietaire du journal a le
        # dernier mot chez lui -- c'est sa ligne, il doit pouvoir la tenir
        # sans passer par quelqu'un. Meme regle que supprime_commentaire.
        "effacable": u is not None and u["id"] in (l["auteur_id"], proprietaire),
    }


def commentaires_de(jeu_id, u) -> list:
    """Le fil de discussion d'une ligne, du plus ancien au plus recent.

    L'ordre d'une conversation, et non celui d'une liste de nouveautes : on
    lit une reponse apres ce a quoi elle repond.

    Deux niveaux, pas trois : les commentaires de tete portent leurs reponses
    dans `reponses`, et une reponse n'en a pas (voir la migration 17 dans
    comptes.py). Un fil qui s'indente a l'infini ne se suit plus.

    Tout ce que la page affiche part d'ici en une fois -- coeurs, notes,
    droits -- et en un nombre de requetes qui ne depend pas de la longueur du
    fil : c'est ce que font _compte_commentaires et _etats_des_auteurs.
    """
    lignes = cx().execute(
        "SELECT c.id, c.texte, c.cree_le, c.maj_le, c.parent_id,"
        " u.id AS auteur_id, u.pseudo, u.avatar, u.avatar_maj_le"
        " FROM commentaire c JOIN utilisateur u ON u.id = c.utilisateur_id"
        " WHERE c.jeu_id = ? ORDER BY c.cree_le, c.id", (jeu_id,)).fetchall()
    if not lignes:
        return []
    # la ligne de journal dont on parle : son proprietaire (qui peut moderer)
    # et le jeu (dont on va chercher la note de chacun). Relue ici plutot que
    # passee par les trois appelants, qui ne l'ont pas tous sous la main.
    ligne = _ligne_visible(jeu_id)
    proprietaire = ligne["auteur_id"] if ligne is not None else None
    etats = _etats_des_auteurs(ligne, sorted({l["auteur_id"] for l in lignes}))
    aimes, miens = _compte_commentaires([l["id"] for l in lignes], u)

    tetes, par_parent = [], {}
    for l in lignes:
        c = _commentaire(l, u, proprietaire, etats, aimes, miens)
        if l["parent_id"]:
            par_parent.setdefault(l["parent_id"], []).append(c)
        else:
            c["reponses"] = []
            tetes.append(c)
    for c in tetes:
        c["reponses"] = par_parent.pop(c["id"], [])
    # Une reponse dont la tete a disparu ne peut pas exister : la cascade de
    # `parent_id` l'emporte avec elle. Si elle arrivait quand meme -- une base
    # bricolee a la main -- mieux vaut la montrer a plat que la perdre.
    for orphelines in par_parent.values():
        tetes.extend(orphelines)
    return tetes


def post(jeu_id, u) -> dict:
    """Une ligne et toute sa discussion : ce que la fenetre d'un fil affiche."""
    ligne = _ligne_ou_refus(jeu_id)
    cartes = _habille([ligne], u)
    return {"ok": True, "post": cartes[0], "fil": commentaires_de(jeu_id, u)}


# --------------------------------------------------------------------------
#   Les avis d'un meme jeu, tous journaux confondus
# --------------------------------------------------------------------------
def avis_du_jeu(nom, id_igdb, u) -> dict:
    """Toutes les lignes de journal qui portent ce jeu.

    Deux facons de reconnaitre le meme jeu, et la premiere prime : la fiche
    IGDB quand les deux lignes en ont une -- c'est un identifiant, il ne se
    discute pas -- et le titre reduit a son slug sinon, pour les jeux
    ajoutes a la main qui n'ont jamais ete rattaches a une fiche.

    Ceux qui ont ecrit un avis passent devant. C'est ce qu'on vient chercher :
    une note seule ne se lit pas, elle se compte. A egalite, le plus recent
    d'abord, comme dans le fil.
    """
    nom = str(nom or "").strip()
    cle = slug(nom)
    if not cle and not id_igdb:
        raise Refus("vide", "Il faut un jeu à chercher.", 400)

    conditions = ["slug(j.nom) = ?"]
    args = [cle]
    if id_igdb:
        conditions.append("j.id_igdb = ?")
        args.append(int(id_igdb))

    lignes = _avec_slug(cx()).execute(
        f"SELECT {CHAMPS_POST}{DE_LA_LIGNE}"
        f" WHERE {VISIBLE} AND ({' OR '.join(conditions)})"
        # `avis` vide ou absent passe derriere : c'est un seul tri, pas deux
        # listes a recoller ensuite
        f" ORDER BY (COALESCE(TRIM(j.avis), '') = ''), j.id DESC",
        (*VISIBLE_ARGS, *args)).fetchall()
    return {"ok": True, "jeu": nom, "posts": _habille(lignes, u)}


# --------------------------------------------------------------------------
#   Ecriture
# --------------------------------------------------------------------------
def _connecte():
    u = actuel()
    if u is None:
        raise Refus("connexion", "Connecte-toi pour participer.", 401)
    return u


def _notifie(destinataire_id, auteur_id, genre, jeu_id, commentaire_id=None):
    """Une notification, sauf a soi-meme. Rend le destinataire, ou None.

    Personne n'a besoin d'etre prevenu de ce qu'il vient de faire : c'est la
    seule regle, et elle est ici plutot que chez les trois appelants.

    Le retour sert au temps reel : l'appelant rassemble les destinataires et
    fait sonner leurs cloches APRES son commit (voir annonce_cloche). Le faire
    d'ici serait plus court et faux -- on annoncerait une notification qui
    n'est pas encore ecrite, et qui ne le sera jamais si la suite echoue.
    """
    if not destinataire_id or destinataire_id == auteur_id:
        return None
    cx().execute(
        "INSERT INTO notification(destinataire_id, auteur_id, genre, jeu_id,"
        " commentaire_id, cree_le) VALUES (?,?,?,?,?,?)",
        (destinataire_id, auteur_id, genre, jeu_id, commentaire_id, maintenant()))
    return destinataire_id


def bascule_jaime(jeu_id, u) -> dict:
    """Aimer, ou ne plus aimer. Le meme geste dans les deux sens.

    Une notification part au premier j'aime seulement. Retirer puis remettre
    n'en renvoie pas une seconde : ce serait donner a n'importe qui de quoi
    faire sonner la cloche autant de fois qu'il le veut.
    """
    ligne = _ligne_ou_refus(jeu_id)
    c = cx()
    prevenu = None
    deja = c.execute("SELECT 1 FROM jaime WHERE jeu_id = ? AND utilisateur_id = ?",
                     (jeu_id, u["id"])).fetchone()
    if deja:
        c.execute("DELETE FROM jaime WHERE jeu_id = ? AND utilisateur_id = ?",
                  (jeu_id, u["id"]))
    else:
        c.execute("INSERT INTO jaime(jeu_id, utilisateur_id, cree_le) VALUES (?,?,?)",
                  (jeu_id, u["id"], maintenant()))
        vu = c.execute(
            "SELECT 1 FROM notification WHERE destinataire_id = ? AND auteur_id = ?"
            " AND genre = 'jaime' AND jeu_id = ?",
            (ligne["auteur_id"], u["id"], jeu_id)).fetchone()
        if not vu:
            prevenu = _notifie(ligne["auteur_id"], u["id"], "jaime", jeu_id)
    c.commit()
    # apres le commit, jamais avant : voir _notifie
    annonce_cloche(prevenu)
    n = c.execute("SELECT COUNT(*) FROM jaime WHERE jeu_id = ?", (jeu_id,)).fetchone()[0]
    return {"ok": True, "aime": not deja, "jaime": n}


def _taille_fil(fil) -> int:
    """Combien de messages dans cette discussion, reponses comprises.

    Le compteur de la carte dit « 5 reponses » : ce sont cinq choses ecrites,
    peu importe laquelle repond a laquelle. Depuis que le fil arrive en deux
    niveaux, len() ne comptait plus que les tetes -- une reponse envoyee
    laissait donc le compteur immobile, et on la croyait perdue.
    """
    return sum(1 + len(c.get("reponses") or ()) for c in fil)


def _texte_ou_refus(texte) -> str:
    """Le texte d'un message, verifie. Meme regle a l'ecriture et a la retouche."""
    texte = str(texte or "").replace("\r\n", "\n").strip()
    if not texte:
        raise Refus("vide", "Écris quelque chose avant d'envoyer.", 400)
    if len(texte) > COMMENTAIRE_MAX:
        raise Refus("long", f"Un commentaire tient en {COMMENTAIRE_MAX} caractères.", 400)
    return texte


def _debit_ou_refus(u) -> None:
    """Le meme compteur d'essais que partout ailleurs sur le site.

    Partage entre l'envoi et la retouche : effacer et reecrire en boucle
    reviendrait sinon a poster sans compteur.
    """
    cle = f"commentaire:{u['id']}"
    if comptes.trop_d_essais(cle):
        raise Refus("debit", "Doucement : trop de commentaires d'un coup.", 429)
    comptes.note_essai(cle)


def _parent_ou_refus(parent_id, jeu_id):
    """Le commentaire auquel on repond, ou None quand on ne repond a personne.

    Deux verifications, et aucune n'est theorique : le parent doit appartenir
    a CETTE discussion -- sans quoi un identifiant pris ailleurs greffait une
    reponse sur un fil qu'on ne regarde pas -- et il doit etre un commentaire
    de tete. Repondre a une reponse renvoie donc au meme endroit qu'y
    repondre directement : un seul niveau (voir la migration 17).
    """
    if not parent_id:
        return None
    l = cx().execute(
        "SELECT id, jeu_id, parent_id, utilisateur_id FROM commentaire WHERE id = ?",
        (int(parent_id),)).fetchone()
    if l is None or l["jeu_id"] != jeu_id:
        raise Refus("introuvable", "Ce commentaire n'existe plus.", 404)
    if l["parent_id"]:
        raise Refus("niveau", "On ne répond pas à une réponse.", 400)
    return l


def ajoute_commentaire(jeu_id, texte, u, parent_id=None) -> dict:
    """Un commentaire -- ou une reponse a un commentaire -- et ses notifications.

    Trois destinataires possibles, jamais deux cloches pour la meme personne :

      - celui a qui l'on repond, quand on repond (« a repondu a ton
        commentaire ») : c'est le plus concerne, il passe donc en premier ;
      - l'auteur du journal, prevenu qu'on parle de sa ligne ;
      - les autres personnes deja venues commenter, qui suivent la
        conversation.

    Le genre les distingue, et c'est tout ce qui les distingue : une
    notification ne dit pas autre chose selon qui la recoit.
    """
    ligne = _ligne_ou_refus(jeu_id)
    texte = _texte_ou_refus(texte)
    parent = _parent_ou_refus(parent_id, jeu_id)
    _debit_ou_refus(u)

    c = cx()
    cur = c.execute(
        "INSERT INTO commentaire(jeu_id, utilisateur_id, texte, cree_le, parent_id)"
        " VALUES (?,?,?,?,?)",
        (jeu_id, u["id"], texte, maintenant(), parent["id"] if parent else None))
    commentaire_id = cur.lastrowid

    # `prevenus` tient la liste de ceux qui ont deja leur cloche : c'est ce
    # qui garantit une seule notification par personne, quel que soit le
    # nombre de titres qu'elle porte dans cette discussion.
    prevenus = {u["id"]}
    cloches = []                 # qui verra sa pastille bouger, une fois commis
    if parent:
        cloches.append(
            _notifie(parent["utilisateur_id"], u["id"], "reponse", jeu_id, commentaire_id))
        prevenus.add(parent["utilisateur_id"])
    # `not in prevenus` et non un appel sec : repondre au proprietaire du
    # journal dans sa propre discussion -- le cas le plus courant, puisque
    # c'est sa ligne -- lui aurait sinon envoye deux cloches pour un seul
    # message, « a repondu a ton commentaire » et « a commente ton avis ».
    if ligne["auteur_id"] not in prevenus:
        cloches.append(
            _notifie(ligne["auteur_id"], u["id"], "commentaire", jeu_id, commentaire_id))
    prevenus.add(ligne["auteur_id"])
    trous = ",".join("?" * len(prevenus))
    for autre in c.execute(
            f"SELECT DISTINCT utilisateur_id FROM commentaire"
            f" WHERE jeu_id = ? AND utilisateur_id NOT IN ({trous})",
            (jeu_id, *sorted(prevenus))).fetchall():
        cloches.append(_notifie(autre["utilisateur_id"], u["id"], "fil", jeu_id,
                                commentaire_id))
    c.commit()
    for qui in cloches:
        annonce_cloche(qui)
    fil_a_jour = commentaires_de(jeu_id, u)
    return {"ok": True, "fil": fil_a_jour, "commentaires": _taille_fil(fil_a_jour)}


def modifie_commentaire(commentaire_id, texte, u) -> dict:
    """Reecrire son propre message.

    SON message, et rien d'autre : le proprietaire du journal peut effacer un
    commentaire qui n'a pas sa place chez lui (voir supprime_commentaire),
    jamais le reecrire. Effacer, tout le monde le voit ; retoucher les mots de
    quelqu'un d'autre en gardant son pseudo dessus, personne.

    `maj_le` est pose au passage : c'est ce qui fait apparaitre « modifié »
    sous le message, pour qui l'avait lu avant.
    """
    texte = _texte_ou_refus(texte)
    l = cx().execute(
        "SELECT id, jeu_id, utilisateur_id FROM commentaire WHERE id = ?",
        (commentaire_id,)).fetchone()
    if l is None:
        raise Refus("introuvable", "Ce commentaire n'existe plus.", 404)
    if l["utilisateur_id"] != u["id"]:
        raise Refus("interdit", "Ce commentaire n'est pas le tien.", 403)
    # la ligne doit toujours etre visible : un journal repasse en prive ferme
    # sa discussion, en lecture comme en ecriture
    _ligne_ou_refus(l["jeu_id"])
    _debit_ou_refus(u)
    cx().execute("UPDATE commentaire SET texte = ?, maj_le = ? WHERE id = ?",
                 (texte, maintenant(), commentaire_id))
    cx().commit()
    fil_a_jour = commentaires_de(l["jeu_id"], u)
    return {"ok": True, "fil": fil_a_jour, "commentaires": _taille_fil(fil_a_jour)}


def bascule_jaime_commentaire(commentaire_id, u) -> dict:
    """Aimer une reponse, ou ne plus l'aimer.

    Le meme geste que sur une carte (voir bascule_jaime), sur l'autre table.
    Pas de notification, et c'est voulu : une discussion de dix messages en
    aurait fait sonner la cloche dix fois pour des coeurs qu'on ne va pas
    aller relire un par un. Le coeur d'une ligne de journal, lui, previent --
    c'est le jeu de quelqu'un, pas une phrase dans un fil.
    """
    l = cx().execute("SELECT id, jeu_id FROM commentaire WHERE id = ?",
                     (commentaire_id,)).fetchone()
    if l is None:
        raise Refus("introuvable", "Ce commentaire n'existe plus.", 404)
    _ligne_ou_refus(l["jeu_id"])
    c = cx()
    deja = c.execute(
        "SELECT 1 FROM jaime_commentaire WHERE commentaire_id = ? AND utilisateur_id = ?",
        (commentaire_id, u["id"])).fetchone()
    if deja:
        c.execute(
            "DELETE FROM jaime_commentaire WHERE commentaire_id = ? AND utilisateur_id = ?",
            (commentaire_id, u["id"]))
    else:
        c.execute(
            "INSERT INTO jaime_commentaire(commentaire_id, utilisateur_id, cree_le)"
            " VALUES (?,?,?)", (commentaire_id, u["id"], maintenant()))
    c.commit()
    n = c.execute("SELECT COUNT(*) FROM jaime_commentaire WHERE commentaire_id = ?",
                  (commentaire_id,)).fetchone()[0]
    return {"ok": True, "aime": not deja, "jaime": n}


def supprime_commentaire(commentaire_id, u) -> dict:
    """Effacer un commentaire : le sien, ou n'importe lequel sur sa ligne.

    Le proprietaire du journal a le dernier mot chez lui -- c'est sa page, et
    c'est la seule facon pour lui de la tenir sans passer par quelqu'un.
    """
    l = cx().execute(
        "SELECT c.id, c.jeu_id, c.utilisateur_id, p.utilisateur_id AS proprietaire"
        " FROM commentaire c JOIN jeu j ON j.id = c.jeu_id"
        " JOIN page p ON p.id = j.page_id WHERE c.id = ?", (commentaire_id,)).fetchone()
    if l is None:
        raise Refus("introuvable", "Ce commentaire n'existe plus.", 404)
    if u["id"] not in (l["utilisateur_id"], l["proprietaire"]):
        raise Refus("interdit", "Ce commentaire n'est pas le tien.", 403)
    # les reponses partent avec lui : c'est la cascade de `parent_id` qui s'en
    # charge (voir la migration 17). Une reponse a un message effacé n'a plus
    # de question a laquelle repondre.
    cx().execute("DELETE FROM commentaire WHERE id = ?", (commentaire_id,))
    cx().commit()
    fil_a_jour = commentaires_de(l["jeu_id"], u)
    # `commentaires` plutot que de laisser la page compter : depuis que le fil
    # arrive en deux niveaux, la longueur de la liste ne dit plus combien de
    # messages elle porte -- et effacer une tete en emporte plusieurs.
    return {"ok": True, "fil": fil_a_jour, "commentaires": _taille_fil(fil_a_jour)}


# --------------------------------------------------------------------------
#   Notifications
# --------------------------------------------------------------------------
def notifications(u) -> dict:
    """La cloche : ce qui s'est passe sans nous, du plus recent au plus vieux.

    Les non lues sont comptees a part et servent la pastille. La liste, elle,
    garde les deja lues : une notification qu'on vient d'ouvrir ne doit pas
    disparaitre sous les yeux de qui la lit.

    Une notification dont la ligne a disparu, ou dont le journal est repasse
    en prive, ne se montre pas : la jointure la retire d'elle-meme. On ne va
    pas ouvrir un fil qui n'existe plus.
    """
    lignes = cx().execute(
        "SELECT n.id, n.genre, n.jeu_id, n.lu, n.cree_le,"
        " a.id AS auteur_id, a.pseudo, a.avatar, a.avatar_maj_le, j.nom,"
        " c.texte AS commentaire"
        " FROM notification n"
        " JOIN utilisateur a ON a.id = n.auteur_id"
        " JOIN jeu j ON j.id = n.jeu_id"
        " JOIN page p ON p.id = j.page_id"
        " LEFT JOIN commentaire c ON c.id = n.commentaire_id"
        f" WHERE n.destinataire_id = ? AND {VISIBLE}"
        " ORDER BY n.cree_le DESC, n.id DESC LIMIT ?",
        (u["id"], *VISIBLE_ARGS, NOTIFS_MAX)).fetchall()
    return {
        "ok": True,
        "notifications": [{
            "id": l["id"],
            "genre": l["genre"],
            "jeu": l["nom"],
            "jeuId": l["jeu_id"],
            "pseudo": l["pseudo"],
            "avatar": _avatar(l),
            "texte": l["commentaire"] or "",
            "quand": l["cree_le"],
            "lu": bool(l["lu"]),
        } for l in lignes],
        "neuves": sum(0 if l["lu"] else 1 for l in lignes),
    }


def marque_lues(u) -> dict:
    """Tout est lu. Appele a l'ouverture du panneau, pas a chaque clic.

    On marque la table entiere et non les seules lignes affichees : une
    notification trop vieille pour la liste ne doit pas garder la pastille
    allumee pour toujours.
    """
    cx().execute("UPDATE notification SET lu = 1 WHERE destinataire_id = ? AND lu = 0",
                 (u["id"],))
    cx().commit()
    return {"ok": True, "neuves": 0}


def neuves(u) -> int:
    """Le compte de la pastille, pour /api/moi. 0 pour un visiteur.

    Meme jointure que la liste : une notification qu'on ne peut pas ouvrir
    ne doit pas etre comptee, sans quoi la pastille annoncerait un chiffre
    que le panneau ne montre pas.
    """
    if u is None:
        return 0
    try:
        return cx().execute(
            "SELECT COUNT(*) FROM notification n"
            " JOIN jeu j ON j.id = n.jeu_id"
            " JOIN page p ON p.id = j.page_id"
            f" WHERE n.destinataire_id = ? AND n.lu = 0 AND {VISIBLE}",
            (u["id"], *VISIBLE_ARGS)).fetchone()[0]
    except Exception:               # noqa: BLE001 - la table peut manquer
        return 0


# --------------------------------------------------------------------------
#   Le temps reel
# --------------------------------------------------------------------------
# Deux choses arrivent sans qu'on ait rien demande : quelqu'un finit un jeu,
# et le fil doit le montrer ; quelqu'un reagit a ce qu'on a ecrit, et la
# pastille de la cloche doit bouger. Les deux se voyaient au rechargement
# suivant, c'est-a-dire jamais -- on ne recharge pas une page qu'on est en
# train de lire.
#
# Le hub a deja un serveur SocketIO, monte pour le Yu-Gi-Quiz (voir app.py) :
# on s'y branche plutot que d'ouvrir un second canal ou de faire interroger
# le serveur toutes les dix secondes par toutes les pages ouvertes.
#
# SUR SON PROPRE NAMESPACE, et ce n'est pas un detail : le quiz enregistre
# `connect` et `disconnect` sur le namespace par defaut (voir @sur dans
# yugiquiz.py). Deux gestionnaires pour un meme evenement au meme endroit, et
# le second remplace le premier -- l'Archive aurait casse le lobby du quiz en
# arrivant.
#
# Rien de tout cela n'est indispensable : une page dont le socket ne se
# connecte pas se comporte comme avant. C'est un supplement, jamais une
# dependance -- d'ou les gardes silencieuses de _emet.
NS = "/social"

# Le salon de tout le monde, connecte ou non : le fil est public, ce qu'on y
# annonce l'est aussi.
SALON_FIL = "fil"

_SIO = None


def _salon_de(uid) -> str:
    """Le salon d'une personne. Sa cloche n'interesse qu'elle."""
    return f"moi:{uid}"


def branche_temps_reel(sio) -> None:
    """Donne au module le serveur SocketIO du hub.

    Meme facon de faire que yugiquiz.branche : ce qui appartient a
    l'application est decide dans app.py, pas ici.
    """
    global _SIO
    _SIO = sio

    @sio.on("connect", namespace=NS)
    def _connexion(auth=None):          # noqa: ARG001 - signature imposee
        """Qui vient d'arriver, et ce qu'il a le droit d'entendre.

        Le cookie de session voyage avec la poignee de main -- c'est le meme
        navigateur et la meme origine. On s'en sert exactement comme une
        route HTTP s'en sert : c'est la seule identite du site, et le socket
        n'en invente pas une seconde.

        Un visiteur non connecte entre quand meme dans le salon du fil : le
        fil se lit sans compte. Il n'entre dans aucun salon personnel, ce qui
        suffit a ne jamais lui envoyer la cloche de quelqu'un.
        """
        join_room(SALON_FIL, namespace=NS)
        try:
            u = comptes.session_valide(request.cookies.get(comptes.COOKIE, ""))
        except Exception:               # noqa: BLE001 - une base qui hoquete
            u = None                    # ne doit pas refuser la connexion
        if u is not None:
            join_room(_salon_de(u["id"]), namespace=NS)


def _emet(evenement, charge, salon) -> None:
    """Un evenement, si le temps reel est la. Ne fait jamais echouer l'appelant.

    Tous les appels partent de la fin d'une ecriture qui, elle, a reussi :
    un socket ferme, un client parti, une version de bibliotheque qui rale --
    rien de tout cela ne doit transformer un commentaire enregistre en erreur
    a l'ecran. La page se rattrapera au prochain chargement.
    """
    if _SIO is None:
        return
    try:
        _SIO.emit(evenement, charge, to=salon, namespace=NS)
    except Exception:                   # noqa: BLE001 - supplement, jamais dependance
        pass


def annonce_cloche(uid) -> None:
    """La pastille de quelqu'un vient de changer. On lui dit son nouveau compte.

    Le compte et non « +1 » : c'est le serveur qui fait foi, et une page
    ouverte depuis trois heures aura peut-etre rate un evenement. Un nombre
    juste se pose ; un increment se decale.
    """
    if not uid or _SIO is None:
        return
    u = cx().execute("SELECT * FROM utilisateur WHERE id = ?", (uid,)).fetchone()
    if u is None:
        return
    _emet("cloche", {"neuves": neuves(u)}, _salon_de(uid))


def visible_dans_le_fil(jeu_id) -> bool:
    """Cette ligne a-t-elle sa place dans le fil ? Lue AVANT une ecriture.

    C'est la moitie de la question que se pose annonce_changement : une ligne
    qui etait deja la n'est pas une nouveaute, une ligne qui n'y etait pas et
    qui y entre en est une. Sans la reponse d'avant, on ne sait pas laquelle
    des deux vient de se produire.
    """
    return _ligne_visible(jeu_id) is not None


def annonce_jeu(jeu_id) -> None:
    """Un jeu vient d'entrer dans le fil : sa carte part a tout le monde.

    La carte est batie comme pour un visiteur (`u=None`) : une seule et meme
    pour tous les navigateurs ouverts, plutot qu'une par personne. Le compte
    de coeurs est juste ; seul « je l'ai deja aime » ne l'est pas -- et une
    ligne qui vient d'entrer dans le fil n'a de coeur de personne. Le cas
    tordu ou elle en aurait (un jeu remis en cours puis retermine) se corrige
    au rechargement, et ne vaut pas une carte fabriquee par client.
    """
    ligne = _ligne_visible(jeu_id)
    if ligne is None:
        return
    _emet("jeu", {"post": _habille([ligne], None)[0]}, SALON_FIL)


def annonce_retrait(jeu_id) -> None:
    """Un jeu quitte le fil : remis en cours, reclasse en wishlist, ou efface."""
    _emet("jeu-retire", {"id": int(jeu_id)}, SALON_FIL)


def annonce_changement(jeu_id, etait_visible) -> None:
    """Apres modification d'une ligne : entree, sortie, ou rien du tout.

    On n'annonce que les passages de frontiere. Renvoyer la carte a chaque
    retouche aurait demande aux pages de la remplacer sur place, et une carte
    remplacee perd l'etat que le navigateur tenait pour son lecteur -- le
    coeur qu'il venait de cliquer, en premier. Une correction de note se lit
    au rechargement ; un jeu qui apparait ou disparait, non.
    """
    est_visible = visible_dans_le_fil(jeu_id)
    if est_visible and not etait_visible:
        annonce_jeu(jeu_id)
    elif etait_visible and not est_visible:
        annonce_retrait(jeu_id)


# --------------------------------------------------------------------------
#   Les routes
# --------------------------------------------------------------------------
blueprint_social = Blueprint("social", __name__, url_prefix="/api/social")


@blueprint_social.before_request
def exige_json():
    """Meme parade CSRF qu'ailleurs : les ecritures sont en JSON."""
    if request.method in ("POST", "PUT", "PATCH", "DELETE") \
            and (request.mimetype or "") != "application/json":
        return echec("format", "Les écritures attendent du JSON.", 415)
    return None


@blueprint_social.errorhandler(Refus)
def refus(err):
    return echec(err.code, err.message, err.statut)


@blueprint_social.get("/feed")
def route_feed():
    return reponse(fil(actuel(), request.args.get("avant")))


@blueprint_social.get("/jeu/<int:jeu_id>")
def route_post(jeu_id):
    return reponse(post(jeu_id, actuel()))


@blueprint_social.post("/jeu/<int:jeu_id>/jaime")
def route_jaime(jeu_id):
    return reponse(bascule_jaime(jeu_id, _connecte()))


@blueprint_social.post("/jeu/<int:jeu_id>/commentaire")
def route_commente(jeu_id):
    """Un commentaire, ou une reponse quand `parent` accompagne le texte.

    La meme route pour les deux : c'est le meme geste, le meme texte et les
    memes verifications -- seule la place dans le fil change.
    """
    charge = corps()
    return reponse(ajoute_commentaire(jeu_id, charge.get("texte"), _connecte(),
                                      charge.get("parent")))


@blueprint_social.patch("/commentaire/<int:commentaire_id>")
def route_modifie(commentaire_id):
    return reponse(modifie_commentaire(commentaire_id, corps().get("texte"), _connecte()))


@blueprint_social.post("/commentaire/<int:commentaire_id>/jaime")
def route_jaime_commentaire(commentaire_id):
    return reponse(bascule_jaime_commentaire(commentaire_id, _connecte()))


@blueprint_social.delete("/commentaire/<int:commentaire_id>")
def route_efface(commentaire_id):
    return reponse(supprime_commentaire(commentaire_id, _connecte()))


@blueprint_social.get("/avis")
def route_avis():
    return reponse(avis_du_jeu(request.args.get("nom"),
                               request.args.get("idIgdb"), actuel()))


@blueprint_social.get("/notifications")
def route_notifications():
    return reponse(notifications(_connecte()))


@blueprint_social.post("/notifications/vues")
def route_notifications_vues():
    return reponse(marque_lues(_connecte()))
