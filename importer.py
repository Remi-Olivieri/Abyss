#!/usr/bin/env python3
"""Recopie un journal Google Sheets dans la base. A lancer une seule fois.

    python importer.py jokrem "https://script.google.com/macros/s/AKfy.../exec"

Le compte doit deja exister : inscris-toi sur le site d'abord, le script
refuse de creer un compte a ta place. La page du journal, elle, est creee
automatiquement si elle manque.

Ce que ca fait
--------------
Interroge l'adresse Apps Script comme le faisait la page, puis relit chaque
onglet avec les memes regles qu'elle : reperage des colonnes par leur
intitule, colonne des mois devinee quand elle n'a pas de titre, avis pris
dans la colonne « Avis » ou, a defaut, dans le commentaire de cellule.

Le classeur n'est pas touche. Il reste intact, et sert de sauvegarde le temps
que tu sois sur de la bascule.

Options
-------
    --remplacer   efface les jeux deja importes avant de recommencer
    --essai       montre ce qui serait importe, sans rien ecrire
"""

import argparse
import json
import re
import sys
import unicodedata
import urllib.request

import comptes
import journal

# Les memes intitules que reconnaissait la page. Le premier qui correspond
# gagne, et une colonne deja prise ne peut pas servir deux fois.
ENTETES = {
    "name":    ["nom du jeu", "nom", "jeu", "titre"],
    "release": ["date de sortie", "sortie", "date"],
    "base":    ["prix de base", "prix officiel", "prix fort"],
    "paid":    ["prix que j ai paye", "prix paye", "paye", "prix reel"],
    "time":    ["temps de jeu", "temps", "duree", "heures"],
    "rating":  ["note", "score"],
    "month":   ["mois"],
    "played":  ["annee", "annee faite", "quand"],
    "review":  ["avis", "commentaire", "commentaires", "points"],
}


# --------------------------------------------------------------------------
#   Les memes conversions que la page, portees en Python
# --------------------------------------------------------------------------
def propre(v) -> str:
    return str("" if v is None else v).replace("\u00a0", " ").strip()


def norm(v) -> str:
    s = unicodedata.normalize("NFD", propre(v))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"\s+", " ", re.sub(r"[’'`.:]", " ", s)).strip()


def en_nombre(v):
    s = propre(v).replace("€", "").replace(" ", "").replace(",", ".")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def en_heures(v):
    s = propre(v)
    if not s:
        return None
    m = re.match(r"^PT(\d+)H(?:(\d+)M)?", s, re.I)          # duree ISO
    if m:
        return int(m[1]) + int(m[2] or 0) / 60
    m = re.match(r"^(\d+)\s*[h:]\s*(\d+)?", s, re.I)        # « 12 h 30 »
    if m:
        return int(m[1]) + int(m[2] or 0) / 60
    return en_nombre(s)


def en_date(v):
    s = propre(v)
    if not s:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s[:10]
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", s)        # JJ/MM/AAAA
    if m:
        return f"{m[3]}-{int(m[2]):02d}-{int(m[1]):02d}"
    return s


def colonnes(entete) -> dict:
    idx, heads = {}, [norm(h) for h in entete]
    for cle, noms in ENTETES.items():
        i = next((k for k, h in enumerate(heads) if h and h in noms), -1)
        if i < 0:
            i = next((k for k, h in enumerate(heads)
                      if h and any(h.startswith(n) for n in noms)
                      and k not in idx.values()), -1)
        if i >= 0 and i not in idx.values():
            idx[cle] = i
    return idx


def devine_mois(lignes, idx):
    """La colonne des mois n'a souvent pas d'intitule : on la reconnait a ce
    qu'elle contient. Un symbole isole (une puce, un « ² ») ne compte pas
    comme un intitule, sinon des onglets entiers perdaient leurs mois."""
    largeur = max((len(l) for l in lignes), default=0)
    for c in range(largeur):
        if c in idx.values():
            continue
        if re.search(r"[a-z]", norm(lignes[0][c] if c < len(lignes[0]) else "")):
            continue
        bons = mauvais = 0
        for l in lignes[1:]:
            v = propre(l[c]) if c < len(l) else ""
            if not v:
                continue
            n = en_nombre(v)
            if n is not None and n == int(n) and 1 <= n <= 12:
                bons += 1
            else:
                mauvais += 1
        if bons >= 3 and mauvais == 0:
            return c
    return None


def avis_de(notes, r, col_nom, largeur):
    """L'avis vient de la colonne « Avis », ou du commentaire de cellule."""
    cle = f"{r},{col_nom}"
    if notes.get(cle):
        return notes[cle]
    for c in range(largeur):
        if notes.get(f"{r},{c}"):
            return notes[f"{r},{c}"]
    return ""


def cellule(ligne, i):
    return ligne[i] if i is not None and i < len(ligne) else None


# --------------------------------------------------------------------------
#   Lecture d'un onglet
# --------------------------------------------------------------------------
def lit_onglet(nom, lignes, notes):
    """Renvoie les jeux d'un onglet, ou [] si ce n'en est pas un.

    Un onglet sans colonne « Nom du jeu » est une feuille annexe : la page
    l'ignorait deja, on fait pareil.
    """
    if not lignes:
        return []
    idx = colonnes(lignes[0])
    if "name" not in idx:
        return []
    if "month" not in idx:
        devine = devine_mois(lignes, idx)
        if devine is not None:
            idx["month"] = devine

    annee_onglet = int(nom.strip()) if re.fullmatch(r"\d{4}", nom.strip()) else None
    jeux = []
    for r in range(1, len(lignes)):
        ligne = lignes[r]
        titre = propre(cellule(ligne, idx["name"]))
        if not titre:
            continue
        avis = propre(cellule(ligne, idx.get("review")))
        if not avis:
            avis = propre(avis_de(notes, r, idx["name"], max(len(ligne), 1)))
        annee = annee_onglet
        if annee is None:
            n = en_nombre(cellule(ligne, idx.get("played")))
            annee = int(n) if n else None
        mois = en_nombre(cellule(ligne, idx.get("month")))
        jeux.append({
            "periode": nom.strip(),
            "nom": titre[:journal.NOM_MAXI],
            "annee": annee,
            "mois": int(mois) if mois and 1 <= mois <= 12 else None,
            "note": en_nombre(cellule(ligne, idx.get("rating"))),
            "heures": en_heures(cellule(ligne, idx.get("time"))),
            "prix_base": en_nombre(cellule(ligne, idx.get("base"))),
            "prix_paye": en_nombre(cellule(ligne, idx.get("paid"))),
            "sortie": en_date(cellule(ligne, idx.get("release"))),
            "avis": avis[:journal.AVIS_MAXI],
            # l'ordre du classeur est conserve : sans lui, deux jeux de meme
            # note se retrouveraient dans un ordre arbitraire a l'affichage
            "rang": r,
        })
    return jeux


def telecharge(url):
    print(f"  Lecture de {url[:70]}...")
    with urllib.request.urlopen(url, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))
    if not data.get("ok"):
        sys.exit(f"  Le script a repondu une erreur : {data.get('error', 'inconnue')}")
    return data


# --------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="Importe un journal Sheets dans la base")
    p.add_argument("pseudo", help="le compte qui recevra le journal")
    p.add_argument("url", help="l'adresse /exec du script Apps Script")
    p.add_argument("--remplacer", action="store_true",
                   help="efface les jeux deja presents avant d'importer")
    p.add_argument("--essai", action="store_true",
                   help="montre le resultat sans rien ecrire")
    args = p.parse_args()

    comptes.init()
    u = comptes.par_pseudo(args.pseudo)
    if u is None:
        sys.exit(f"  Le compte « {args.pseudo} » n'existe pas. Inscris-toi sur le site "
                 f"d'abord, puis relance.")

    data = telecharge(args.url)
    jeux, ignores = [], []
    for feuille in data.get("sheets", []):
        trouves = lit_onglet(feuille.get("name", ""), feuille.get("rows") or [],
                             feuille.get("notes") or {})
        if trouves:
            jeux.extend(trouves)
        else:
            ignores.append(feuille.get("name", "?"))

    if not jeux:
        sys.exit("  Aucun jeu trouve. Verifie que l'adresse est la bonne.")

    par_periode = {}
    for j in jeux:
        par_periode[j["periode"]] = par_periode.get(j["periode"], 0) + 1

    print(f"\n  {len(jeux)} jeux dans {len(par_periode)} onglets :")
    for nom in sorted(par_periode):
        print(f"    {nom:<18} {par_periode[nom]:>4}")
    if ignores:
        print(f"  Onglets ignores (pas de colonne « Nom du jeu ») : {', '.join(ignores)}")

    # Un apercu vaut mieux qu'une promesse : si les colonnes ont ete mal
    # reperees, ca se voit ici et pas apres coup dans la base.
    print("\n  Apercu des trois premiers :")
    for j in jeux[:3]:
        print(f"    {j['nom']!r} — {j['periode']}, note {j['note']}, "
              f"{j['heures']} h, base {j['prix_base']}, paye {j['prix_paye']}, "
              f"sortie {j['sortie']}, avis {len(j['avis'])} car.")

    if args.essai:
        print("\n  Essai : rien n'a ete ecrit.\n")
        return

    page = journal.ma_page(u) or journal.cree_page(u)
    c = comptes.cx()
    deja = c.execute("SELECT COUNT(*) FROM jeu WHERE page_id = ?",
                     (page["id"],)).fetchone()[0]
    if deja and not args.remplacer:
        sys.exit(f"\n  Ce journal contient deja {deja} jeux. Relance avec --remplacer "
                 f"pour les ecraser, ou --essai pour voir sans rien changer.")

    with c:
        if args.remplacer:
            c.execute("DELETE FROM jeu WHERE page_id = ?", (page["id"],))
        c.executemany(
            "INSERT INTO jeu(page_id, periode, nom, annee, mois, note, heures,"
            " prix_base, prix_paye, sortie, avis, rang, cree_le, maj_le)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(page["id"], j["periode"], j["nom"], j["annee"], j["mois"], j["note"],
              j["heures"], j["prix_base"], j["prix_paye"], j["sortie"], j["avis"],
              j["rang"], comptes.maintenant(), comptes.maintenant()) for j in jeux])

    print(f"\n  {len(jeux)} jeux importes dans le journal de {u['pseudo']}.")
    print(f"  Le classeur Google n'a pas ete touche : garde-le le temps de verifier.\n")


if __name__ == "__main__":
    main()