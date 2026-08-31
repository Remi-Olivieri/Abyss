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

from flask import Blueprint, request

import comptes
from comptes import Refus, actuel, corps, cx, echec, maintenant, reponse

PROJET = "jeux-videos"

# Les seuls champs qu'une ecriture peut toucher, et leur colonne. L'annee, le
# rang et les horodatages sont calcules ici : le navigateur n'a pas a les
# fournir, et ne doit pas pouvoir les inventer.
CHAMPS = {
    "name": "nom",
    "rating": "note",
    "month": "mois",
    "hours": "heures",
    "base": "prix_base",
    "paid": "prix_paye",
    "release": "sortie",
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
            propres[colonne] = nombre(v, 0, 100)
        elif cle == "hours":
            propres[colonne] = nombre(v, 0, 100000)
        else:                                   # prix_base, prix_paye
            propres[colonne] = nombre(v, 0, 100000)
    return propres


def annee_de(periode):
    """'2026' -> 2026. 'En cours' -> None. La periode reste la seule verite."""
    p = (periode or "").strip()
    return int(p) if p.isdigit() and len(p) == 4 else None


# --------------------------------------------------------------------------
#   Pages
# --------------------------------------------------------------------------
def page_de(pseudo):
    return cx().execute(
        "SELECT p.*, u.pseudo FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE u.pseudo_norm = ? AND p.projet = ?",
        (comptes.normalise(pseudo), PROJET)).fetchone()


def ma_page(u):
    if u is None:
        return None
    return cx().execute(
        "SELECT p.*, u.pseudo FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " WHERE p.utilisateur_id = ? AND p.projet = ?", (u["id"], PROJET)).fetchone()


def cree_page(u):
    c = cx()
    with c:
        c.execute("INSERT INTO page(utilisateur_id, projet, titre, cree_le)"
                  " VALUES(?,?,?,?)",
                  (u["id"], PROJET, f"Journal de {u['pseudo']}", maintenant()))
    return ma_page(u)


def annuaire():
    """Les journaux publics, avec leur nombre de jeux.

    Le compte sert a mettre les journaux vivants en tete : un classeur vide
    n'a aucune raison d'ouvrir la liste.
    """
    lignes = cx().execute(
        "SELECT u.pseudo, p.titre, COUNT(j.id) AS jeux"
        " FROM page p JOIN utilisateur u ON u.id = p.utilisateur_id"
        " LEFT JOIN jeu j ON j.page_id = p.id"
        " WHERE p.projet = ? AND p.visibilite = 'publique'"
        " GROUP BY p.id ORDER BY jeux DESC, u.pseudo", (PROJET,)).fetchall()
    return [{"pseudo": l["pseudo"], "titre": l["titre"] or f"Journal de {l['pseudo']}",
             "jeux": l["jeux"]} for l in lignes]


# --------------------------------------------------------------------------
#   Lecture
# --------------------------------------------------------------------------
def periodes_de(page_id) -> list:
    """Les onglets, dans l'ordre ou la page les affiche.

    Les annees d'abord et croissantes, puis les autres periodes, puis les
    deux statuts a la fin : c'est l'ordre qu'avaient les onglets du classeur,
    et la page s'en sert tel quel pour dessiner ses pastilles.
    """
    vues = [l["periode"] for l in cx().execute(
        "SELECT DISTINCT periode FROM jeu WHERE page_id = ?", (page_id,)).fetchall()]
    annees = sorted([p for p in vues if annee_de(p) is not None], key=lambda p: int(p))
    statuts = [p for p in ("En cours", "Wishlist") if p in vues]
    autres = sorted(p for p in vues if p not in annees and p not in statuts)
    return annees + autres + statuts


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


def rang_suivant(page_id, periode) -> int:
    l = cx().execute("SELECT MAX(rang) FROM jeu WHERE page_id = ? AND periode = ?",
                     (page_id, periode)).fetchone()[0]
    return (l or 0) + 1


def ajoute(page, periode, values, avis):
    if cx().execute("SELECT COUNT(*) FROM jeu WHERE page_id = ?",
                    (page["id"],)).fetchone()[0] >= JEUX_MAXI:
        raise Refus("plein", "Ce journal a atteint sa limite de jeux.", 409)
    periode = (periode or "").strip()[:60]
    if not periode:
        raise Refus("periode", "Il faut dire dans quel onglet ranger le jeu.")
    v = valeurs_propres(values)
    if "nom" not in v:
        raise Refus("nom", "Il faut au moins un nom de jeu.")
    colonnes = ["page_id", "periode", "annee", "avis", "rang", "cree_le", "maj_le"]
    donnees = [page["id"], periode, annee_de(periode), (avis or "")[:AVIS_MAXI],
               rang_suivant(page["id"], periode), maintenant(), maintenant()]
    for col, val in v.items():
        colonnes.append(col)
        donnees.append(val)
    c = cx()
    with c:
        c.execute(f"INSERT INTO jeu({','.join(colonnes)})"
                  f" VALUES({','.join('?' * len(colonnes))})", donnees)


def modifie(jeu, page, periode, values, avis):
    """Ne touche qu'aux champs recus.

    Un champ absent de `values` reste tel quel, un champ a None se vide. La
    mise a jour groupee IGDB repose entierement la-dessus : elle envoie la
    date et le prix, et le reste du jeu n'est pas reecrit.
    """
    v = valeurs_propres(values)
    if periode is not None:
        periode = str(periode).strip()[:60]
        if not periode:
            raise Refus("periode", "Il faut dire dans quel onglet ranger le jeu.")
        if periode != jeu["periode"]:
            v["periode"] = periode
            v["annee"] = annee_de(periode)
            v["rang"] = rang_suivant(page["id"], periode)
    if avis is not None:
        v["avis"] = avis[:AVIS_MAXI]
    if not v:
        return
    v["maj_le"] = maintenant()
    c = cx()
    with c:
        c.execute(f"UPDATE jeu SET {','.join(k + ' = ?' for k in v)} WHERE id = ?",
                  list(v.values()) + [jeu["id"]])


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
    """L'annuaire : qui a un journal, et le mien s'il existe."""
    u = actuel()
    mienne = ma_page(u)
    return reponse({"ok": True,
                    "journaux": annuaire(),
                    "connecte": u is not None,
                    "moi": None if mienne is None else mienne["pseudo"]})


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


@blueprint_journal.post("/jeu")
def ajouter():
    u, page = ma_page_ou_refus()
    d = corps()
    ajoute(page, d.get("periode"), d.get("values") or {}, d.get("review") or "")
    return reponse(contenu(page, u), 201)


@blueprint_journal.put("/jeu/<int:jeu_id>")
def modifier(jeu_id):
    u, page = ma_page_ou_refus()
    d = corps()
    modifie(jeu_a_moi(jeu_id, page), page, d.get("periode"),
            d.get("values") or {}, d.get("review"))
    return reponse(contenu(page, u))


@blueprint_journal.delete("/jeu/<int:jeu_id>")
def supprimer(jeu_id):
    u, page = ma_page_ou_refus()
    jeu = jeu_a_moi(jeu_id, page)
    c = cx()
    with c:
        c.execute("DELETE FROM jeu WHERE id = ?", (jeu["id"],))
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