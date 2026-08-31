#!/usr/bin/env python3
"""Verifie que le site fait bien ce qu'il promet : comptes et journal.

    python -m unittest tests -v

A quoi ca sert : une regression sur un mot de passe ou un cookie ne se voit
pas a l'oeil nu. Ces tests attrapent les fautes silencieuses (un mot de passe
stocke en clair, un cookie sans HttpOnly, un pote qui verrait les preferences
d'un autre) avant qu'elles ne partent en ligne. Rien a installer : la
bibliotheque standard et Flask, qui est deja la.

Chaque test repart d'une base neuve dans un dossier temporaire. Rien ne
touche a donnees/abyss.sqlite3.
"""

import importlib
import os
import tempfile
import unittest
from pathlib import Path

import comptes as module
import journal as mod_journal


class Socle(unittest.TestCase):
    def setUp(self):
        self.dossier = tempfile.TemporaryDirectory()
        os.environ["ABYSS_BASE"] = str(Path(self.dossier.name) / "test.sqlite3")
        self.c = importlib.reload(module)
        self.c.init()
        self.j = importlib.reload(mod_journal)

        from flask import Flask
        app = Flask(__name__)
        app.config["TESTING"] = True
        app.register_blueprint(self.c.blueprint_comptes)
        app.register_blueprint(self.j.blueprint_journal)
        self.client = app.test_client()

    def tearDown(self):
        self.c.ferme()
        self.dossier.cleanup()

    def inscrit(self, pseudo="jokrem", mdp="motdepasse1"):
        return self.client.post("/api/inscription",
                                json={"pseudo": pseudo, "mdp": mdp})

    def connecte(self, pseudo="jokrem", mdp="motdepasse1", memoriser=True):
        return self.client.post("/api/connexion",
                                json={"pseudo": pseudo, "mdp": mdp,
                                      "memoriser": memoriser})


# ==========================================================================
class TestSecrets(Socle):
    """Rien de sensible ne doit trainer en clair."""

    def test_le_mot_de_passe_est_hache(self):
        uid = self.c.cree_compte("jokrem", "motdepasse1")
        u = self.c.cx().execute("SELECT * FROM utilisateur WHERE id = ?", (uid,)).fetchone()
        self.assertNotIn("motdepasse1", u["empreinte"])
        self.assertTrue(u["empreinte"].startswith(("scrypt:", "pbkdf2:", "argon2")))

    def test_le_jeton_de_session_est_hache(self):
        uid = self.c.cree_compte("jokrem", "motdepasse1")
        jeton = self.c.ouvre_session(uid)
        garde = self.c.cx().execute("SELECT empreinte FROM session").fetchone()["empreinte"]
        self.assertNotEqual(garde, jeton)
        self.assertEqual(len(garde), 64)            # sha256 en hexa

    def test_la_reponse_ne_fuite_rien(self):
        r = self.inscrit()
        self.assertNotIn("empreinte", r.json["utilisateur"])
        self.assertNotIn("motdepasse1", r.get_data(as_text=True))


class TestPseudo(Socle):
    def test_refuses(self):
        for mauvais in ["ab", "-jokrem", "jokrem-", "jok rem", "jok@rem",
                        "a" * 21, "api", "STATIC", "jeux-videos"]:
            with self.subTest(pseudo=mauvais), self.assertRaises(self.c.Refus):
                self.c.verifie_pseudo(mauvais)

    def test_acceptes(self):
        for bon in ["jok", "Jokrem", "ilarak_2", "a-b", "j0k-r3m_x"]:
            with self.subTest(pseudo=bon):
                self.assertEqual(self.c.verifie_pseudo(bon), bon)

    def test_insensible_a_la_casse(self):
        self.inscrit(pseudo="Jokrem")
        self.client.delete_cookie(self.c.COOKIE)
        self.assertEqual(self.inscrit(pseudo="JOKREM").status_code, 409)
        self.assertEqual(self.connecte(pseudo="jOkReM").status_code, 200)

    def test_mot_de_passe_trop_court_ou_trop_long(self):
        self.assertEqual(self.inscrit(mdp="court1").status_code, 400)
        self.assertEqual(self.inscrit(mdp="x" * 500).status_code, 400)


class TestInscription(Socle):
    def test_ouvre_une_session_directement(self):
        r = self.inscrit()
        self.assertEqual(r.status_code, 201)
        self.assertTrue(r.json["connecte"])
        self.assertEqual(r.json["utilisateur"]["pseudo"], "jokrem")
        self.assertIn(self.c.COOKIE, r.headers.get("Set-Cookie", ""))

    def test_aucun_code_n_est_demande(self):
        """L'inscription est libre : pseudo et mot de passe suffisent."""
        self.assertEqual(self.inscrit().status_code, 201)


class TestQuota(Socle):
    def remplit(self, n):
        for i in range(n):
            self.c.cree_compte(f"pote{i}", "motdepasse1")

    def test_quota_atteint(self):
        self.c.INSCRIPTIONS_PAR_JOUR = 2
        self.remplit(2)
        r = self.inscrit()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json["erreur"], "quota")

    def test_les_vieux_comptes_ne_comptent_plus(self):
        self.c.INSCRIPTIONS_PAR_JOUR = 1
        self.remplit(1)
        cx = self.c.cx()
        with cx:
            cx.execute("UPDATE utilisateur SET cree_le = ?", ("2020-01-01T00:00:00+00:00",))
        self.assertEqual(self.inscrit().status_code, 201)

    def test_supprimer_un_compte_libere_sa_place(self):
        self.c.INSCRIPTIONS_PAR_JOUR = 1
        uid = self.c.cree_compte("pote0", "motdepasse1")
        self.assertFalse(self.c.etat_inscriptions()["ouvertes"])
        cx = self.c.cx()
        with cx:
            cx.execute("DELETE FROM utilisateur WHERE id = ?", (uid,))
        self.assertTrue(self.c.etat_inscriptions()["ouvertes"])

    def test_la_page_est_prevenue_avant_de_remplir(self):
        self.assertTrue(self.client.get("/api/moi").json["inscriptions"]["ouvertes"])
        self.c.INSCRIPTIONS_PAR_JOUR = 1
        self.remplit(1)
        ins = self.client.get("/api/moi").json["inscriptions"]
        self.assertFalse(ins["ouvertes"])
        self.assertEqual(ins["restantes"], 0)
        self.assertGreater(ins["libre_a"], self.c.maintenant())   # dans le futur

    def test_un_pseudo_invalide_ne_consomme_pas_de_place(self):
        self.c.INSCRIPTIONS_PAR_JOUR = 1
        self.inscrit(pseudo="x")
        self.assertTrue(self.c.etat_inscriptions()["ouvertes"])


class TestConnexion(Socle):
    def setUp(self):
        super().setUp()
        self.inscrit()
        self.client.delete_cookie(self.c.COOKIE)

    def test_valide(self):
        self.assertEqual(self.connecte().status_code, 200)

    def test_mauvais_mot_de_passe(self):
        self.assertEqual(self.connecte(mdp="pasbon12345").status_code, 401)

    def test_compte_inexistant_repond_pareil(self):
        """Le message ne doit pas dire si le compte existe."""
        a = self.connecte(pseudo="fantome", mdp="pasbon12345")
        b = self.connecte(mdp="pasbon12345")
        self.assertEqual(a.status_code, b.status_code)
        self.assertEqual(a.json["message"], b.json["message"])

    def test_cookie_httponly_et_samesite(self):
        entete = self.connecte().headers.get("Set-Cookie", "")
        self.assertIn("HttpOnly", entete)
        self.assertIn("SameSite=Lax", entete)

    def test_sans_memoriser_le_cookie_meurt_avec_le_navigateur(self):
        self.assertIn("Expires", self.connecte(memoriser=True).headers["Set-Cookie"])
        self.client.delete_cookie(self.c.COOKIE)
        self.assertNotIn("Expires", self.connecte(memoriser=False).headers["Set-Cookie"])

    def test_limitation_de_debit(self):
        for _ in range(self.c.ESSAIS_MAX):
            self.connecte(mdp="pasbon12345")
        self.assertEqual(self.connecte(mdp="pasbon12345").status_code, 429)
        # meme avec le bon mot de passe, la porte reste fermee
        self.assertEqual(self.connecte().status_code, 429)

    def test_une_reussite_remet_le_compteur_a_zero(self):
        for _ in range(3):
            self.connecte(mdp="pasbon12345")
        self.assertEqual(self.connecte().status_code, 200)
        self.assertFalse(self.c.trop_d_essais("conn:@jokrem"))


class TestSession(Socle):
    def setUp(self):
        super().setUp()
        self.inscrit()

    def test_moi_connecte(self):
        self.assertEqual(self.client.get("/api/moi").json["utilisateur"]["pseudo"], "jokrem")

    def test_moi_visiteur(self):
        self.client.delete_cookie(self.c.COOKIE)
        r = self.client.get("/api/moi")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json["connecte"])

    def test_jamais_mis_en_cache(self):
        self.assertIn("no-store", self.client.get("/api/moi").headers["Cache-Control"])

    def test_cookie_bidon_ignore(self):
        self.client.set_cookie(self.c.COOKIE, "jetoninvente")
        self.assertFalse(self.client.get("/api/moi").json["connecte"])

    def test_session_expiree_refusee_et_effacee(self):
        cx = self.c.cx()
        with cx:
            cx.execute("UPDATE session SET expire_le = ?", ("2000-01-01T00:00:00+00:00",))
        self.assertFalse(self.client.get("/api/moi").json["connecte"])
        self.assertEqual(cx.execute("SELECT COUNT(*) FROM session").fetchone()[0], 0)

    def test_deconnexion_tue_la_session_en_base(self):
        self.client.post("/api/deconnexion", json={})
        self.assertEqual(
            self.c.cx().execute("SELECT COUNT(*) FROM session").fetchone()[0], 0)
        self.assertFalse(self.client.get("/api/moi").json["connecte"])

    def test_changer_de_mot_de_passe_chasse_les_autres_appareils(self):
        uid = self.c.par_pseudo("jokrem")["id"]
        autre = self.c.ouvre_session(uid)
        r = self.client.post("/api/mot-de-passe",
                             json={"actuel": "motdepasse1", "nouveau": "nouveaumdp2"})
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(self.c.session_valide(autre))
        # ... mais pas celui qui vient de le changer
        self.assertTrue(self.client.get("/api/moi").json["connecte"])

    def test_mauvais_mot_de_passe_actuel(self):
        r = self.client.post("/api/mot-de-passe",
                             json={"actuel": "pasbon12345", "nouveau": "nouveaumdp2"})
        self.assertEqual(r.status_code, 403)

    def test_supprimer_un_compte_emporte_ses_sessions(self):
        cx = self.c.cx()
        with cx:
            cx.execute("DELETE FROM utilisateur")
        self.assertEqual(cx.execute("SELECT COUNT(*) FROM session").fetchone()[0], 0)


class TestPreferences(Socle):
    def setUp(self):
        super().setUp()
        self.inscrit()

    def test_enregistrer_et_relire(self):
        r = self.client.put("/api/preferences", json={"masques": ["collection", "quiz"]})
        self.assertEqual(r.json["masques"], ["collection", "quiz"])
        self.assertEqual(self.client.get("/api/moi").json["masques"], ["collection", "quiz"])

    def test_liste_vide_demasque_tout(self):
        self.client.put("/api/preferences", json={"masques": ["quiz"]})
        self.client.put("/api/preferences", json={"masques": []})
        self.assertEqual(self.client.get("/api/moi").json["masques"], [])

    def test_projet_inconnu_ignore(self):
        self.assertEqual(
            self.client.put("/api/preferences", json={"masques": ["licorne"]}).json["masques"],
            [])

    def test_refuse_aux_visiteurs(self):
        self.client.delete_cookie(self.c.COOKIE)
        self.assertEqual(
            self.client.put("/api/preferences", json={"masques": ["quiz"]}).status_code, 401)

    def test_chacun_les_siennes(self):
        self.client.put("/api/preferences", json={"masques": ["quiz"]})
        self.client.delete_cookie(self.c.COOKIE)
        self.inscrit(pseudo="ilarak")
        self.assertEqual(self.client.get("/api/moi").json["masques"], [])

    def test_format_invalide(self):
        self.assertEqual(
            self.client.put("/api/preferences", json={"masques": "quiz"}).status_code, 400)


class TestCSRF(Socle):
    def test_une_ecriture_sans_json_est_refusee(self):
        """Un formulaire poste depuis un autre site ne peut pas fixer ce type
        de contenu sans declencher un pre-vol CORS."""
        for typ in ["application/x-www-form-urlencoded", "text/plain",
                    "multipart/form-data"]:
            with self.subTest(type=typ):
                r = self.client.post("/api/connexion", data="pseudo=jokrem",
                                     content_type=typ)
                self.assertEqual(r.status_code, 415)

    def test_la_lecture_reste_libre(self):
        self.assertEqual(self.client.get("/api/moi").status_code, 200)


class Journal(Socle):
    """Un compte connecte avec un journal qui contient un jeu."""

    def setUp(self):
        super().setUp()
        self.inscrit()
        self.client.post("/api/journal", json={})
        self.ajoute("Elden Ring", "2025", rating=9.5, hours=112.5, base=59.99,
                    paid=39.99, release="2022-02-25", review="Immense.\nRude.")

    def ajoute(self, nom, periode, review="", **champs):
        return self.client.post("/api/journal/jeu", json={
            "periode": periode, "review": review,
            "values": dict(champs, name=nom)})

    def jeux(self):
        return self.client.get("/api/journal/jokrem").json["jeux"]

    def par_nom(self, nom):
        return next(j for j in self.jeux() if j["name"] == nom)


class TestJournalLecture(Journal):
    def test_le_jeu_revient_entier(self):
        j = self.par_nom("Elden Ring")
        self.assertEqual(j["bucket"], "2025")
        self.assertEqual(j["year"], 2025)            # deduite de la periode
        self.assertEqual(j["rating"], 9.5)
        self.assertEqual(j["hours"], 112.5)
        self.assertEqual(j["review"], ["Immense.", "Rude."])
        self.assertIsInstance(j["id"], int)

    def test_les_periodes_sont_ordonnees(self):
        self.ajoute("Silksong", "2026")
        self.ajoute("BG3", "En cours")
        self.ajoute("HK2", "Wishlist")
        self.ajoute("Vieux jeu", "2023")
        # annees croissantes d'abord, les deux statuts a la fin
        self.assertEqual(self.client.get("/api/journal/jokrem").json["periodes"],
                         ["2023", "2025", "2026", "En cours", "Wishlist"])

    def test_un_statut_n_a_pas_d_annee(self):
        self.ajoute("BG3", "En cours")
        self.assertIsNone(self.par_nom("BG3")["year"])

    def test_journal_inconnu(self):
        self.assertEqual(self.client.get("/api/journal/fantome").status_code, 404)

    def test_l_annuaire_liste_les_journaux(self):
        r = self.client.get("/api/journal")
        self.assertEqual(r.json["moi"], "jokrem")
        self.assertEqual(r.json["journaux"][0]["jeux"], 1)


class TestJournalVisiteur(Journal):
    def setUp(self):
        super().setUp()
        self.client.delete_cookie(self.c.COOKIE)

    def test_lecture_publique(self):
        r = self.client.get("/api/journal/jokrem")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json["jeux"]), 1)

    def test_mais_pas_d_ecriture(self):
        self.assertFalse(self.client.get("/api/journal/jokrem").json["write"])
        self.assertEqual(self.ajoute("Pirate", "2025").status_code, 401)

    def test_un_journal_prive_est_refuse(self):
        cx = self.c.cx()
        with cx:
            cx.execute("UPDATE page SET visibilite = 'privee'")
        self.assertEqual(self.client.get("/api/journal/jokrem").status_code, 403)


class TestJournalEcriture(Journal):
    def test_creation_rejouable(self):
        """Recreer sa page ne doit pas effacer ce qu'elle contient."""
        r = self.client.post("/api/journal", json={})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(len(r.json["jeux"]), 1)

    def test_modification_partielle(self):
        """Le coeur de la mise a jour IGDB : ce qui n'est pas envoye ne bouge pas."""
        avant = self.par_nom("Elden Ring")
        self.client.put(f"/api/journal/jeu/{avant['id']}",
                        json={"values": {"base": 49.99}})
        apres = self.par_nom("Elden Ring")
        self.assertEqual(apres["base"], 49.99)
        self.assertEqual(apres["rating"], avant["rating"])
        self.assertEqual(apres["hours"], avant["hours"])
        self.assertEqual(apres["review"], avant["review"])

    def test_un_null_explicite_vide_bien_le_champ(self):
        i = self.par_nom("Elden Ring")["id"]
        self.client.put(f"/api/journal/jeu/{i}", json={"values": {"rating": None}})
        self.assertIsNone(self.par_nom("Elden Ring")["rating"])

    def test_changer_de_periode_recalcule_l_annee(self):
        i = self.par_nom("Elden Ring")["id"]
        self.client.put(f"/api/journal/jeu/{i}", json={"periode": "En cours", "values": {}})
        self.assertEqual(self.par_nom("Elden Ring")["bucket"], "En cours")
        self.assertIsNone(self.par_nom("Elden Ring")["year"])

    def test_suppression(self):
        i = self.par_nom("Elden Ring")["id"]
        # sans corps ni type de contenu, comme le fait la page
        self.assertEqual(self.client.delete(f"/api/journal/jeu/{i}").status_code, 200)
        self.assertEqual(self.jeux(), [])

    def test_valeurs_refusees(self):
        for champs in [{"month": 99}, {"rating": "abc"}, {"hours": -5},
                       {"base": "gratuit"}, {"month": 0}]:
            with self.subTest(champs=champs):
                self.assertEqual(self.ajoute("X", "2025", **champs).status_code, 400)

    def test_un_nom_vide_est_refuse(self):
        # pas dans le tour de boucle ci-dessus : `ajoute` pose le nom
        # elle-meme, elle ecraserait la chaine vide qu'on veut tester
        r = self.client.post("/api/journal/jeu",
                             json={"periode": "2025", "values": {"name": "   "}})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json["erreur"], "nom")

    def test_une_periode_vide_est_refusee(self):
        r = self.client.post("/api/journal/jeu",
                             json={"periode": "  ", "values": {"name": "X"}})
        self.assertEqual(r.status_code, 400)

    def test_l_ordre_d_origine_sert_d_egalite(self):
        self.ajoute("B", "2025", rating=8)
        self.ajoute("C", "2025", rating=8)
        noms = [j["name"] for j in self.jeux() if j["bucket"] == "2025"]
        self.assertEqual(noms, ["Elden Ring", "B", "C"])


class TestJournalLot(Journal):
    def test_un_echec_n_annule_pas_les_autres(self):
        i = self.par_nom("Elden Ring")["id"]
        r = self.client.put("/api/journal/lot", json={"modifs": [
            {"id": i, "values": {"base": 24.99}},
            {"id": 999999, "values": {"name": "Pirate"}},
        ]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json["fait"]["echecs"]), 1)
        self.assertEqual(r.json["fait"]["echecs"][0]["i"], 1)
        self.assertEqual(self.par_nom("Elden Ring")["base"], 24.99)

    def test_lot_trop_gros_refuse(self):
        r = self.client.put("/api/journal/lot",
                            json={"modifs": [{"id": 1} for _ in range(200)]})
        self.assertEqual(r.status_code, 400)


class TestJournalIsolement(Journal):
    """Deux comptes ne doivent jamais se toucher."""

    def setUp(self):
        super().setUp()
        self.sien = self.par_nom("Elden Ring")["id"]
        self.client.delete_cookie(self.c.COOKIE)
        self.inscrit(pseudo="ilarak")
        self.client.post("/api/journal", json={})

    def test_je_ne_vois_que_mes_jeux(self):
        self.assertEqual(self.client.get("/api/journal/ilarak").json["jeux"], [])

    def test_je_ne_peux_pas_modifier_le_jeu_d_un_autre(self):
        r = self.client.put(f"/api/journal/jeu/{self.sien}",
                            json={"values": {"name": "Pirate"}})
        self.assertEqual(r.status_code, 404)   # meme reponse que « n'existe pas »

    def test_ni_le_supprimer(self):
        self.assertEqual(
            self.client.delete(f"/api/journal/jeu/{self.sien}").status_code, 404)
        self.client.delete_cookie(self.c.COOKIE)
        self.assertEqual(len(self.client.get("/api/journal/jokrem").json["jeux"]), 1)

    def test_supprimer_un_compte_emporte_sa_page_et_ses_jeux(self):
        cx = self.c.cx()
        with cx:
            cx.execute("DELETE FROM utilisateur")
        self.assertEqual(cx.execute("SELECT COUNT(*) FROM page").fetchone()[0], 0)
        self.assertEqual(cx.execute("SELECT COUNT(*) FROM jeu").fetchone()[0], 0)


class TestImport(unittest.TestCase):
    """Les conversions du script d'import, sans reseau."""

    def test_les_formats_du_classeur(self):
        import importer
        self.assertEqual(importer.en_nombre("9,5"), 9.5)
        self.assertEqual(importer.en_nombre("59,99 €"), 59.99)
        self.assertIsNone(importer.en_nombre(""))
        self.assertEqual(importer.en_heures("112 h 30"), 112.5)
        self.assertEqual(importer.en_heures("41h"), 41)
        self.assertEqual(importer.en_heures("PT2H30M"), 2.5)
        self.assertEqual(importer.en_date("25/02/2022"), "2022-02-25")
        self.assertEqual(importer.en_date("2020-09-17"), "2020-09-17")

    def test_reperage_des_colonnes(self):
        import importer
        idx = importer.colonnes(["Nom du jeu", "Note", "Temps de jeu",
                                 "Prix de base", "Prix payé", "Date de sortie"])
        self.assertEqual(idx["name"], 0)
        self.assertEqual(idx["rating"], 1)
        self.assertEqual(idx["paid"], 4)

    def test_la_colonne_des_mois_sans_intitule(self):
        import importer
        lignes = [["Nom du jeu", "Note", "", "Temps"],
                  ["A", "9", "3", "10h"], ["B", "8", "7", "5h"], ["C", "7", "12", "2h"]]
        idx = importer.colonnes(lignes[0])
        self.assertEqual(importer.devine_mois(lignes, idx), 2)
        # un vrai intitule protege la colonne
        lignes[0][2] = "Support"
        self.assertIsNone(importer.devine_mois(lignes, idx))

    def test_un_onglet_sans_nom_de_jeu_est_ignore(self):
        import importer
        self.assertEqual(importer.lit_onglet("Notes", [["Truc", "Machin"], ["a", "b"]], {}), [])

    def test_l_avis_vient_du_commentaire_de_cellule(self):
        import importer
        jeux = importer.lit_onglet("2025", [["Nom du jeu", "Note"], ["Hades", "9"]],
                                   {"1,0": "Roguelite parfait."})
        self.assertEqual(jeux[0]["avis"], "Roguelite parfait.")


class TestRoutage(unittest.TestCase):
    """L'application complete : redirections, et ce qui ne doit pas etre servi."""

    def setUp(self):
        self.dossier = tempfile.TemporaryDirectory()
        os.environ["ABYSS_BASE"] = str(Path(self.dossier.name) / "app.sqlite3")
        importlib.reload(module)
        import app
        importlib.reload(app)
        app.app.config["TESTING"] = True
        self.client = app.app.test_client()

    def tearDown(self):
        module.ferme()
        self.dossier.cleanup()

    def test_la_racine_mene_a_abyss(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 301)
        self.assertTrue(r.headers["Location"].endswith("/abyss"))

    def test_l_ancienne_adresse_aussi(self):
        self.assertEqual(self.client.get("/Abyss.html").status_code, 301)

    def test_abyss_est_servie(self):
        r = self.client.get("/abyss")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Abyss", r.get_data(as_text=True))

    def test_rien_de_sensible_n_est_servi(self):
        for chemin in ["/donnees/abyss.sqlite3", "/app.py", "/comptes.py", "/journal.py",
                       "/static/../app.py", "/.git/config"]:
            with self.subTest(chemin=chemin):
                self.assertEqual(self.client.get(chemin).status_code, 404)

    def test_404_d_api_repond_en_json(self):
        r = self.client.get("/api/nimportequoi")
        self.assertEqual(r.status_code, 404)
        self.assertFalse(r.json["ok"])

    def test_404_de_page_repond_en_html(self):
        r = self.client.get("/nimportequoi.html")
        self.assertEqual(r.status_code, 404)
        self.assertIn("<!DOCTYPE html>", r.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main(verbosity=2)