#!/usr/bin/env python3
"""Yu-Gi-Oh! Survivor : un survivor au tour par tour, avec des cartes.

Le jeu tourne tout entier dans la page (static/survivor/) : le moteur, les
regles, l'equilibrage. Ce fichier fait deux choses.

1. Il ecrit la matiere que la page lit -- static/survivor/cartes.json --
   depuis le catalogue ygoprodeck que la Collection tient deja a jour
   (donnees/cartes/fr.json, voir cartes.py) :

       venv/bin/python survivor.py

   et les vignettes des cartes, static/survivor/art/<id>.webp (192 px) : le
   plateau dessine des cases de 40 pixels, et les artworks du stock en font
   624 pour 120 Ko chacun -- une partie en chargerait douze mega-octets sur
   un telephone. Comme les autres images du site, elles restent hors du
   depot (voir .gitignore) ; la page reprend l'artwork complet quand l'une
   manque.

   Pourquoi un fichier fabrique plutot qu'une route : les stats d'une carte
   ne changent pas, et le catalogue complet pese 18 Mo. Tout ce qui se
   regle -- degats, cadence des vagues, PV des boss -- vit dans le
   JavaScript, en ligne a la seconde ou on l'enregistre.

2. Il tient ce que chacun garde d'une partie a l'autre (/api/survivor) :
   ses Points de Duel, les cartes qu'il a achetees, son deck -- les 40
   cartes que les boosters peuvent lui faire trouver pendant le duel -- et
   son Extra Deck, les 5 fusions au plus que Polymerisation peut sortir. Le
   duelliste, lui, arrive toujours avec le meme deck de depart (voir
   DUELLISTES) : Yugi d'abord, Joey quand Yugi a battu Obelisk, puis Mai,
   Kaiba et Ishizu, chacun par un succes a sa facon. Et ses
   succes (SUCCES), qui rapportent des Points de Duel et des cartes qu'on
   n'a que par eux.
   C'est la part « rogue-lite » du jeu : on ne monte pas ses stats entre
   deux parties, on achete des cartes pour mieux choisir ce qu'on trouvera.
   Le serveur fait foi pour les prix, la collection et les gains -- la page
   ne fait que demander.

Les cartes sont nommees par leur nom anglais : c'est le seul qui ne bouge
pas d'une traduction a l'autre. La page, elle, ne voit que les noms
francais.

Reserve a l'administration tant que le jeu est en chantier : la page et
l'API repondent 404 aux autres (voir PAGES_ADMIN dans app.py).
"""

from __future__ import annotations

import json
import random
import secrets
import sys
import threading
import time
from pathlib import Path

BASE = Path(__file__).parent.resolve()
CATALOGUE = BASE / "donnees" / "cartes" / "fr.json"
SORTIE = BASE / "static" / "survivor" / "cartes.json"
ARTWORKS = BASE / "static" / "yugioh" / "CardsCropped"
VIGNETTES = BASE / "static" / "survivor" / "art"
COTE_VIGNETTE = 192

# --------------------------------------------------------------------------
#   Les cartes du joueur
# --------------------------------------------------------------------------
# (nom anglais, rarete, reglages). Rien que des cartes sorties pendant l'ere
# Duel Monsters (jusqu'a 2004 au Japon) : le Dragon Alexandrite, de 2012, a
# ete retire. L'attaque d'un monstre vient de son Type
# (un Dragon frappe en zone, un Magicien vise les deux plus proches...) et
# son attribut y ajoute un bonus (le FEU brule, l'EAU ralentit...) : voir
# ATTAQUES et BONUS dans moteur.js. Sa DEF te protege : plus ton terrain en
# a, moins les coups te font mal (voir protection dans moteur.js).
#
# Un monstre normal (cadre jaune) n'a pas d'effet : il frappe selon son Type
# et son attribut, rien de plus. Les monstres a effet (cadre orange) et les
# fusions sont les cartes speciales. Les reglages ne disent que ce que la
# carte fait de plus :
#   effet   son effet propre (voir TEXTES_EFFETS dans moteur.js, qui les
#           nomme tous) ;
#   effets  la meme chose, quand une carte en a plusieurs ;
#   types   pour un terrain : les types de monstres qu'il renforce ;
#   cherche une carte qu'elle va prendre dans le deck (nom anglais) ;
#   ramene  les cartes qu'elle ramene du cimetiere (noms anglais) ;
#   sorte   la place d'une magie, quand le jeu n'en fait pas ce que dit sa
#           categorie (une magie d'equipement qui fait son effet et part).
#
# Chaque famille a de quoi faire un deck : des monstres de bas niveau, un
# ou deux qui demandent des sacrifices, une fusion, son terrain et sa
# magie de soutien.
JOUEUR = [
    # -- Demons : la malediction, le cimetiere, les sacrifices
    ("Kuriboh", "rare", {"effet": "kuriboh"}),
    ("Sangan", "rare", {"effet": "sangan"}),
    ("Feral Imp", "commune", {}),
    ("Wall of Illusion", "rare", {"effet": "illusion"}),
    ("Berfomet", "rare", {"effet": "recherche", "cherche": "Gazelle the King of Mythical Beasts"}),
    ("Summoned Skull", "rare", {}),
    # -- Magiciens : le sort, et chaque magie jouee les nourrit
    ("Magician of Faith", "rare", {"effet": "foi"}),
    ("Time Wizard", "super", {"effet": "temps"}),
    ("Mystical Elf", "commune", {}),
    ("Witch of the Black Forest", "rare", {"effet": "sorciere"}),
    ("Breaker the Magical Warrior", "rare", {"effet": "brise-sort"}),
    ("Lord of D.", "rare", {"effet": "protecteur"}),
    ("Dark Magician Girl", "super", {"effet": "disciple"}),
    ("Dark Magician", "super", {}),
    ("Maha Vailo", "rare", {"effet": "equipement"}),
    ("Copycat", "rare", {"effet": "copie"}),
    # -- Dragons : le souffle, en zone
    ("Baby Dragon", "commune", {}),
    ("Luster Dragon", "commune", {}),
    ("Curse of Dragon", "rare", {}),
    ("Red-Eyes Black Dragon", "super", {}),
    ("Blue-Eyes White Dragon", "ultra", {}),
    ("Twin-Headed Fire Dragon", "rare", {}),
    # -- Guerriers : la taille, au corps a corps
    ("Celtic Guardian", "commune", {}),
    ("Big Shield Gardna", "rare", {"effet": "rempart"}),
    ("Gearfried the Iron Knight", "rare", {"effet": "cuirasse"}),
    ("Gaia The Fierce Knight", "super", {}),
    ("Buster Blader", "super", {"effet": "anti-dragon"}),
    # -- Betes : le bond, de proie en proie
    ("Man-Eater Bug", "rare", {"effet": "mange"}),
    ("Silver Fang", "commune", {}),
    ("Battle Ox", "commune", {}),
    ("Mystic Horseman", "commune", {}),
    ("Gazelle the King of Mythical Beasts", "commune", {}),
    # -- Tonnerre et Eau : la foudre, le tourbillon, le poisson vorace
    ("Thunder Dragon", "rare", {"effet": "tonnerre"}),
    ("Kaiser Sea Horse", "rare", {"effet": "hippocampe"}),
    ("7 Colored Fish", "commune", {}),
    ("Kairyu-Shin", "rare", {}),
    ("Mermaid Knight", "commune", {"effet": "sirene"}),
    # -- les serres et la pierre
    ("Harpie Lady", "commune", {"famille": "harpie"}),
    ("Giant Soldier of Stone", "commune", {}),
    ("Alpha The Magnet Warrior", "commune", {}),
    ("Beta The Magnet Warrior", "commune", {}),
    ("Gamma the Magnet Warrior", "commune", {}),
    # -- les Machines : la bombe, et l'usine qui les renforce
    ("Mechanicalchaser", "commune", {}),
    ("Machine Conversion Factory", "commune", {"effet": "usine"}),
    # -- les magies qu'on joue et qui partent au cimetiere
    ("Raigeki", "ultra", {"effet": "raigeki"}),
    ("Swords of Revealing Light", "rare", {"effet": "epees"}),
    ("Pot of Greed", "rare", {"effet": "pot"}),
    ("Monster Reborn", "super", {"effet": "reborn"}),
    ("Polymerization", "super", {"effet": "fusion"}),
    ("Dian Keto the Cure Master", "commune", {"effet": "dian-keto"}),
    ("Scapegoat", "rare", {"effet": "moutons"}),
    ("Fissure", "commune", {"effet": "fissure"}),
    ("Mystical Space Typhoon", "rare", {"effet": "typhon"}),
    ("Card Destruction", "rare", {"effet": "destruction"}),
    ("Skull Dice", "rare", {"effet": "de-crane"}),
    ("Graceful Dice", "rare", {"effet": "de-grace", "sorte": "continue"}),
    ("Soul Exchange", "rare", {"effet": "echange", "sorte": "continue"}),
    ("Change of Heart", "super", {"effet": "coeur"}),
    ("Soul Release", "rare", {"effet": "liberation"}),
    ("Premature Burial", "rare", {"effet": "enterrement", "sorte": "normale"}),
    # -- celles qui restent posees : les passifs, dans les zones magie/piege
    ("Axe of Despair", "rare", {"effet": "hache"}),
    ("Book of Secret Arts", "rare", {"effet": "arts-secrets"}),
    ("Dragon Treasure", "rare", {"effet": "tresor-dragon"}),
    ("Banner of Courage", "super", {"effet": "banniere"}),
    ("Ring of Magnetism", "commune", {"effet": "aimant"}),
    # -- les terrains : un seul a la fois, et la table change de couleur.
    # Les types sont ceux des vraies cartes.
    ("Yami", "rare", {"effet": "terrain", "types": ["Démon", "Magicien"]}),
    ("Sogen", "rare", {"effet": "terrain", "types": ["Guerrier", "Bête-Guerrier"]}),
    ("Umi", "rare", {"effet": "terrain",
                     "types": ["Aqua", "Poisson", "Serpent de Mer", "Tonnerre"]}),
    ("Mountain", "rare", {"effet": "terrain", "types": ["Dragon", "Bête Ailée", "Tonnerre"]}),
    ("Forest", "rare", {"effet": "terrain",
                        "types": ["Insecte", "Bête", "Plante", "Bête-Guerrier"]}),
    # -- les pieges
    ("Trap Hole", "commune", {"effet": "trappe"}),
    ("Mirror Force", "super", {"effet": "miroir"}),
    ("Magic Cylinder", "rare", {"effet": "cylindre"}),
    ("Solemn Judgment", "rare", {"effet": "jugement"}),
    ("Magical Hats", "rare", {"effet": "chapeaux"}),
    # -- les cartes de Joey : elles rejoignent la collection avec lui (voir
    # DUELLISTES), ni avant, ni a la boutique
    ("Rocket Warrior", "rare", {"effet": "roquette"}),
    ("Flame Manipulator", "commune", {}),
    ("Panther Warrior", "rare", {"effet": "fierte"}),
    ("Salamandra", "rare", {"effet": "salamandra"}),
    # -- celles de Mai : ses Harpies (« famille » : ce que le Dragon de harpie
    # et le Cyberbouclier comptent), sorties de la horde avec elle
    ("Harpie Lady Sisters", "super", {"effet": "trois-soeurs", "famille": "harpie"}),
    ("Cyber Harpie Lady", "rare", {"effet": "harpie", "famille": "harpie"}),
    ("Harpie's Pet Dragon", "super", {"effet": "dresse"}),
    ("Elegant Egotist", "rare", {"effet": "egotiste", "cherche": "Harpie Lady Sisters"}),
    ("Harpie's Feather Duster", "rare", {"effet": "plumeau"}),
    ("Cyber Shield", "rare", {"effet": "cyberbouclier"}),
    # -- celles de Kaiba : X, Y et Z, des Machines, et le Virus
    ("X-Head Cannon", "commune", {}),
    ("Y-Dragon Head", "commune", {"effet": "union"}),
    ("Z-Metal Tank", "commune", {"effet": "union"}),
    ("Crush Card Virus", "super", {"effet": "virus"}),
    # -- celles d'Ishizu : ses Elfes, et le cimetiere
    ("Keldo", "commune", {"effet": "keldo"}),
    ("Agido", "rare", {"effet": "agido"}),
    ("Zolga", "commune", {"effet": "zolga"}),
    ("Mudora", "rare", {"effet": "priere"}),
    ("Exchange of the Spirit", "rare", {"effet": "permutation"}),
    # -- celles des succes qui demandent une facon de jouer : chacune la
    # renforce (voir SUCCES)
    ("Fusion Sage", "rare", {"effet": "recherche", "cherche": "Polymerization"}),
    ("Shield & Sword", "rare", {"effet": "bouclier-epee"}),
    ("Royal Magical Library", "rare", {"effet": "bibliotheque"}),
    ("Bottomless Trap Hole", "super", {"effet": "trappe", "rayon": 2}),
    ("Megamorph", "super", {"effet": "megamorphe"}),
    ("Mage Power", "super", {"effet": "puissance-du-mage"}),
]

# Les jetons que des cartes posent sur le terrain : (nom anglais, carte dont
# ils prennent l'artwork, fiche). Le Jeton Mouton n'a pas d'artwork a lui :
# il prend celui du Bouc Emissaire. Il ne fait rien, sinon servir de
# sacrifice.
JETONS = {
    "mouton": ("Sheep Token", "Scapegoat",
               {"nom": "Jeton Mouton", "cadre": "token", "genre": "monstre", "niveau": 1, "atk": 0,
                "df": 0, "attribut": "EARTH", "type": "Bête"}),
}

# Les fusions vont dans l'Extra Deck (5 au plus) : Polymerisation n'en sort
# que celles-la, avec des matieres prises dans la main ou sur le terrain,
# comme au JCC. Une matiere est un nom anglais, ou « type:Dragon » pour
# n'importe quel monstre de ce type : le Dragon Ultime demande trois Dragons
# Blancs dans le JCC, ici un Dragon Blanc et deux autres Dragons -- sinon
# personne ne le verrait jamais. La rarete est celle de la boutique.
FUSIONS = [
    ("Dark Paladin", "super", ["Dark Magician", "Buster Blader"],
     {"effets": ["anti-dragon", "magie-noire"]}),
    ("Black Skull Dragon", "super", ["Summoned Skull", "Red-Eyes Black Dragon"], {"effet": "meteore"}),
    ("Blue-Eyes Ultimate Dragon", "ultra", ["Blue-Eyes White Dragon", "type:Dragon", "type:Dragon"],
     {"effet": "trois-tetes"}),
    ("Gaia the Dragon Champion", "rare", ["Gaia The Fierce Knight", "Curse of Dragon"],
     {"effet": "charge-celeste"}),
    ("Twin-Headed Thunder Dragon", "rare", ["Thunder Dragon", "Thunder Dragon"], {"effet": "chaine"}),
    ("Thousand Dragon", "rare", ["Baby Dragon", "Time Wizard"], {"effet": "souffle-du-temps"}),
    ("Rabid Horseman", "rare", ["Battle Ox", "Mystic Horseman"], {"effet": "furie"}),
    ("Valkyrion the Magna Warrior", "rare", ["Alpha The Magnet Warrior", "Beta The Magnet Warrior",
                                             "Gamma the Magnet Warrior"], {"effet": "magnetique"}),
    ("Chimera the Flying Mythical Beast", "rare", ["Gazelle the King of Mythical Beasts", "Berfomet"],
     {"effet": "chimere", "ramene": ["Gazelle the King of Mythical Beasts", "Berfomet"]}),
    # le Spadassin de Joey : le Manipulateur de Flammes et Masaki au JCC.
    # Masaki reste dans la horde : n'importe quel Guerrier le remplace.
    ("Flame Swordsman", "rare", ["Flame Manipulator", "type:Guerrier"], {"effet": "epee-de-flammes"}),
    # celui de Kaiba : X, Y et Z, par Polymerisation comme Valkyrion
    ("XYZ-Dragon Cannon", "super", ["X-Head Cannon", "Y-Dragon Head", "Z-Metal Tank"], {"effet": "triple-canon"}),
]

# Les duellistes qu'on peut jouer, chacun avec son deck de depart, le meme
# a chaque duel : un monstre faible sur le terrain, comme le fouet de
# Vampire Survivors, et quatre cartes dans la pioche, dont il tire deux au
# hasard pour sa premiere main. Pas de fusion en plus : l'Extra Deck est
# celui du joueur (Remi, 23/10/2026). Son portrait :
# static/survivor/duellistes/<cle>.webp.
#
# Le premier est la des le depart. Un autre se debloque avec le succes
# nomme par « succes » (voir SUCCES), et ses « cartes » rejoignent alors
# la collection : on ne les a qu'avec lui. Joey : ses cartes de Duelist
# Kingdom et de Battle City -- le Guerrier Roquette sur le terrain, le Bebe
# Dragon et le Magicien du Temps du Dragon Millenaire, le Manipulateur de
# Flammes de son Spadassin, le De gracieux du joueur de hasard ; une
# Polymerisation trouvee dans un booster fait l'une ou l'autre fusion. Avec
# la Polymerisation au depart, le robot d'equilibrage gagnait 8 % de ses
# parties avec Joey, aucune avec Yugi.
#
# Les trois suivants s'ouvrent chacun par un succes qui demande de jouer a
# sa facon (Remi, 23/10/2026) : Mai par ses Betes Ailees, Kaiba par un coup
# enorme, Ishizu par le cimetiere. Mai, ses Harpies (la Dame Harpie, deja
# dans la collection, sur le terrain) ; Kaiba, X, Y et Z, ses Machines de
# Battle City, et l'Usine qui les renforce ; Ishizu, ses Elfes et
# l'Enterrement Premature. Le robot, sur 40 parties : Kaiba 237 tours en
# mediane, Mai 240 et Ishizu 223, contre 220 pour Yugi. L'Egotiste Elegant
# au depart de Mai lui donnait les Soeurs trop tot (273 tours, 4 victoires).
DUELLISTES = [
    {"cle": "yugi", "nom": "Yugi",
     "terrain": ["Feral Imp"],
     "deck": ["Kuriboh", "Trap Hole", "Celtic Guardian", "Swords of Revealing Light"]},
    {"cle": "joey", "nom": "Joey", "succes": "roi-des-jeux",
     "terrain": ["Rocket Warrior"],
     "deck": ["Baby Dragon", "Time Wizard", "Flame Manipulator", "Graceful Dice"],
     "cartes": ["Rocket Warrior", "Flame Manipulator", "Panther Warrior", "Salamandra", "Flame Swordsman"]},
    {"cle": "mai", "nom": "Mai", "succes": "serres",
     "terrain": ["Harpie Lady"],
     "deck": ["Cyber Harpie Lady", "Harpie's Pet Dragon", "Harpie's Feather Duster", "Cyber Shield"],
     "cartes": ["Harpie Lady Sisters", "Cyber Harpie Lady", "Harpie's Pet Dragon", "Elegant Egotist",
                "Harpie's Feather Duster", "Cyber Shield"]},
    {"cle": "kaiba", "nom": "Kaiba", "succes": "puissance",
     "terrain": ["Z-Metal Tank"],
     "deck": ["Y-Dragon Head", "X-Head Cannon", "Machine Conversion Factory", "Mechanicalchaser"],
     "cartes": ["X-Head Cannon", "Y-Dragon Head", "Z-Metal Tank", "XYZ-Dragon Cannon", "Crush Card Virus"]},
    {"cle": "ishizu", "nom": "Ishizu", "succes": "resurrections",
     "terrain": ["Keldo"],
     "deck": ["Agido", "Zolga", "Mudora", "Premature Burial"],
     "cartes": ["Keldo", "Agido", "Zolga", "Mudora", "Exchange of the Spirit"]},
]

# Les succes : ce qu'une partie peut accomplir, une fois pour toutes, et ce
# que cela rapporte -- des Points de Duel, des cartes, un duelliste (celui
# dont « succes » le nomme). Les cartes d'un succes ne s'obtiennent que la,
# ni dans la collection de depart, ni a la boutique (Remi, 23/10/2026 :
# « ca donne vraiment envie de debloquer »). La condition dit ce que le
# bilan de la partie doit atteindre au moins (tours, tues, boss vaincus,
# exodia : les cinq pieces reunies, niveau...) ; « duelliste », celui qui
# l'a jouee, « victoire », Obelisk abattu ; « types », les monstres vaincus
# par les monstres d'un Type. Le robot d'equilibrage tient 222 tours et bat
# 1,1 boss en mediane avec Yugi.
#
# Les premiers ne demandent que de tenir et de gagner. Les suivants
# demandent de jouer autrement (Remi, 23/10/2026) : une facon de jouer
# chacun, et souvent une carte qui la renforce -- le Sage Fusion pour qui
# fusionne, Bouclier et Epee pour qui empile la DEF. Leurs seuils sont
# hors de portee du robot, qui fuit avec le deck propose (sur 80 parties,
# au mieux : 3 fusions, 11 magies, 24 monstres pris aux pieges, 131 de
# coup, 4 zones, 44 % de Defense) ; il tient 40 tours sans bouger une fois
# sur huit, d'ou 60. Une Dame Harpie posee des le premier tour, montee
# d'une etoile tous les 40 tours, en abat une centaine : 75.
SUCCES = [
    {"cle": "survivant", "nom": "Survivant", "texte": "Tiens 100 tours.",
     "condition": {"tours": 100}, "dp": 100},
    {"cle": "un-dieu", "nom": "Un dieu tombe", "texte": "Bats un dieu égyptien.",
     "condition": {"boss": 1}, "dp": 150},
    {"cle": "niveau-20", "nom": "Duelliste confirmé", "texte": "Atteins le niveau 20.",
     "condition": {"niveau": 20}, "dp": 200},
    {"cle": "exodia", "nom": "Oblitération", "texte": "Réunis les cinq pièces d'Exodia.",
     "condition": {"exodia": 1}, "dp": 300},
    {"cle": "deux-dieux", "nom": "Deux dieux", "texte": "Bats deux dieux égyptiens dans le même duel.",
     "condition": {"boss": 2}, "cartes": ["Monster Reborn"], "dp": 250},
    {"cle": "massacre", "nom": "Raz-de-marée", "texte": "Vaincs 600 monstres dans le même duel.",
     "condition": {"tues": 600}, "cartes": ["Raigeki"], "dp": 250},
    {"cle": "roi-des-jeux", "nom": "Le Roi des Jeux", "texte": "Bats Obélisk avec Yugi.",
     "condition": {"victoire": True, "duelliste": "yugi"}, "cartes": ["Dark Magician"], "dp": 500},
    {"cle": "cran-de-joey", "nom": "Le cran de Joey", "texte": "Bats Obélisk avec Joey.",
     "condition": {"victoire": True, "duelliste": "joey"}, "cartes": ["Red-Eyes Black Dragon"], "dp": 500},
    # ceux qui ouvrent un duelliste (voir DUELLISTES)
    {"cle": "serres", "nom": "Les serres de la harpie",
     "texte": "Vaincs 75 monstres avec tes Bêtes Ailées dans le même duel.",
     "condition": {"types": {"Bête Ailée": 75}}, "dp": 200},
    {"cle": "puissance", "nom": "Puissance absolue",
     "texte": "Inflige 300 dégâts d'un seul coup avec un de tes monstres.",
     "condition": {"coup": 300}, "dp": 200},
    {"cle": "resurrections", "nom": "Le passé revient",
     "texte": "Fais revenir 5 cartes de ton cimetière dans le même duel.",
     "condition": {"ramenees": 5}, "dp": 200},
    # une facon de jouer, et la carte qui va avec
    {"cle": "fusions", "nom": "Maître de la fusion", "texte": "Invoque 3 fusions dans le même duel.",
     "condition": {"fusions": 3}, "cartes": ["Fusion Sage"], "dp": 150},
    {"cle": "forteresse", "nom": "Forteresse",
     "texte": "Atteins 50 % de Défense avec la seule DEF de tes monstres.",
     "condition": {"defense": 50}, "cartes": ["Shield & Sword"], "dp": 150},
    {"cle": "grimoire", "nom": "Grimoire", "texte": "Joue 15 magies dans le même duel.",
     "condition": {"magies": 15}, "cartes": ["Royal Magical Library"], "dp": 150},
    {"cle": "pieges", "nom": "Maître des pièges", "texte": "Détruis 40 monstres avec tes pièges dans le même duel.",
     "condition": {"pieges": 40}, "cartes": ["Bottomless Trap Hole"], "dp": 150},
    {"cle": "arsenal", "nom": "Arsenal", "texte": "Remplis tes 5 zones magie et piège.",
     "condition": {"zones": 5}, "cartes": ["Mage Power"], "dp": 150},
    {"cle": "sur-le-fil", "nom": "Sur le fil", "texte": "Bats un dieu égyptien avec moins de 1000 LP.",
     "condition": {"fil": 1}, "cartes": ["Megamorph"], "dp": 200},
    {"cle": "immobile", "nom": "Inébranlable", "texte": "Ne bouge pas pendant 60 tours d'affilée.",
     "condition": {"immobile": 60}, "dp": 200},
    # chacun des autres duellistes au bout du jeu
    {"cle": "reine-des-harpies", "nom": "La reine des harpies", "texte": "Bats Obélisk avec Mai.",
     "condition": {"victoire": True, "duelliste": "mai"}, "dp": 500},
    {"cle": "orgueil-de-kaiba", "nom": "L'orgueil de Kaiba", "texte": "Bats Obélisk avec Kaiba.",
     "condition": {"victoire": True, "duelliste": "kaiba"}, "dp": 500},
    {"cle": "prophetie", "nom": "La prophétie", "texte": "Bats Obélisk avec Ishizu.",
     "condition": {"victoire": True, "duelliste": "ishizu"}, "dp": 500},
]

# --------------------------------------------------------------------------
#   La collection, le deck, la boutique
# --------------------------------------------------------------------------
# Les boosters : les 40 cartes differentes qu'ils peuvent proposer pendant
# le duel (la cle « deck » de cartes.json et de l'API, d'avant ce nom), et
# l'Extra Deck : les fusions que Polymerisation peut sortir, 5 au plus.
# Chacun les compose dans sa collection. Le deck, en partie, c'est autre
# chose : les cartes qu'on a et qu'on pioche (voir moteur.js).
TAILLE_DECK = 40
TAILLE_EXTRA = 5

# Ce qui n'est qu'a la boutique : les cartes-phares de chaque famille, et
# ce qui va avec elles. Tout le reste du joueur est dans la collection de
# depart, sauf les cartes des duellistes a debloquer (DUELLISTES) et celles
# des succes (SUCCES).
BOUTIQUE = [
    "Blue-Eyes White Dragon", "Buster Blader", "Dark Magician Girl", "Time Wizard",
    "Banner of Courage", "Kaiser Sea Horse", "Scapegoat", "Breaker the Magical Warrior",
    "Lord of D.", "Berfomet", "Gearfried the Iron Knight", "Twin-Headed Fire Dragon",
    "Kairyu-Shin", "Mermaid Knight", "Umi",
    "Maha Vailo", "Copycat", "Change of Heart", "Soul Release", "Premature Burial",
    "Graceful Dice", "Mechanicalchaser", "Machine Conversion Factory", "Skull Dice", "Solemn Judgment",
    "Soul Exchange", "Card Destruction", "Magical Hats", "Fissure", "Mystical Space Typhoon",
    # les fusions de leurs cartes-phares
    "Dark Paladin", "Black Skull Dragon", "Blue-Eyes Ultimate Dragon",
    "Chimera the Flying Mythical Beast",
]

# Celles de la collection qui restent hors des boosters proposes au depart.
HORS_DU_DECK = ["Ring of Magnetism"]

# La boutique ne vend plus une carte au choix (Remi, 22/10/2026) : un
# booster d'une carte, tiree au hasard parmi celles qu'on n'a pas encore,
# selon sa rarete, ou une carte de la pioche du jour, cinq cartes tirees
# chaque jour pour chacun, dont on n'achete qu'une, un peu plus cher. Une
# fusion n'a pas sa rarete de boutique dans sa fiche (elle y porte
# « fusion », ce qui la range dans l'Extra Deck) : elle vient de FUSIONS.
PRIX_BOOSTER = 400
PRIX_JOUR = 600
CARTES_DU_JOUR = 5
POIDS_RARETE = {"commune": 60, "rare": 26, "super": 10, "ultra": 3}

# --------------------------------------------------------------------------
#   Les monstres d'en face
# --------------------------------------------------------------------------
# Par palier, du plus faible au plus fort : le moteur ouvre un palier de
# plus a mesure que les tours passent (voir PALIERS dans moteur.js). Aucune
# de ces cartes n'est aussi au joueur : un monstre qu'on vient d'invoquer
# ne doit pas se retrouver en face.
ENNEMIS = [
    ["Mokey Mokey", "Skull Servant", "Petit Dragon", "Basic Insect", "Hinotama Soul",
     "Thunder Kid", "Mega Thunderball", "Kagemusha of the Blue Flame", "Penguin Soldier",
     "Giant Germ"],
    # Dissolveroc (900/1000) remplace le Manipulateur de Flammes, passe a Joey
    ["Ryu-Kishin", "Wolf", "Mammoth Graveyard", "Dissolverock", "Mystical Sheep #2",
     "Dragon Zombie", "Armored Zombie", "Saggi the Dark Clown", "Kurama",
     "Lady of Faith"],
    ["Hitotsu-Me Giant", "Griffore", "Fireyarou", "Water Omotics", "Fiend Kraken", "Tyhone",
     "Dark Assailant", "Koumori Dragon", "Yaranzo", "Melchid the Four-Face Beast",
     "Bean Soldier", "Water Magician", "Great White", "Blackland Fire Dragon",
     "Masaki the Legendary Swordsman"],
    # Garoozis et le Dragon a Trois Cornes remplacent les Harpies, passees a
    # Mai
    ["Archfiend Soldier", "Vorse Raider", "La Jinn the Mystical Genie of the Lamp",
     "Dark Blade", "Battle Steer", "Ansatsu", "Doma The Angel of Silence", "Garoozis",
     "Dark Elf", "Gemini Elf", "Crawling Dragon"],
    ["Zoa", "Hyozanryu", "Pumpking the King of Ghosts", "Tri-Horned Dragon", "Jinzo",
     "Kazejin", "Sanga of the Thunder", "Suijin"],
]

# Dans l'ordre ou ils arrivent (voir BOSS dans moteur.js pour le tour, les
# PV et leur frappe) : les trois dieux egyptiens, Slifer qui tire en ligne,
# Ra en croix, Obelisk et son poing en zone. Leur version jouable est sortie
# apres l'ere Duel Monsters (2009 a 2011), mais ce sont les dieux de Battle
# City : la seule exception a la regle de l'ere.
BOSS = ["Slifer the Sky Dragon", "The Winged Dragon of Ra", "Obelisk the Tormentor"]

# Les cinq pieces : les reunir balaie l'ecran, et l'on peut recommencer.
EXODIA = ["Exodia the Forbidden One", "Right Arm of the Forbidden One",
          "Left Arm of the Forbidden One", "Right Leg of the Forbidden One",
          "Left Leg of the Forbidden One"]

# --------------------------------------------------------------------------
#   Ce que le catalogue dit, en francais
# --------------------------------------------------------------------------
TYPES = {
    "Spellcaster": "Magicien", "Fiend": "Démon", "Warrior": "Guerrier", "Dragon": "Dragon",
    "Beast": "Bête", "Beast-Warrior": "Bête-Guerrier", "Winged Beast": "Bête Ailée",
    "Rock": "Rocher", "Insect": "Insecte", "Zombie": "Zombie", "Thunder": "Tonnerre",
    "Aqua": "Aqua", "Pyro": "Pyro", "Machine": "Machine", "Dinosaur": "Dinosaure",
    "Plant": "Plante", "Sea Serpent": "Serpent de Mer", "Fish": "Poisson", "Fairy": "Elfe",
    "Divine-Beast": "Bête Divine", "Reptile": "Reptile", "Psychic": "Psychique",
}

# humanReadableCardType -> la place de la carte une fois jouee
SORTES = {
    "Normal Spell": "normale", "Quick-Play Spell": "normale", "Ritual Spell": "normale",
    "Equip Spell": "continue", "Continuous Spell": "continue", "Field Spell": "terrain",
    "Normal Trap": "normale", "Continuous Trap": "continue", "Counter Trap": "normale",
}


class Introuvable(Exception):
    pass


def charge_catalogue(chemin=CATALOGUE) -> dict:
    """Les cartes du catalogue, par nom anglais."""
    with open(chemin, encoding="utf-8") as f:
        brut = json.load(f)
    cartes = brut["data"] if isinstance(brut, dict) else brut
    return {c["name_en"]: c for c in cartes if c.get("name_en")}


def fiche(c, rarete=None, reglages=None) -> dict:
    """Ce que la page garde d'une carte : son nom francais, ce qu'il faut
    pour la jouer, et rien du texte -- les effets du jeu ne sont pas ceux
    du JCC, la page ecrit les siens (voir texte dans moteur.js)."""
    f = {"nom": c["name"], "cadre": c.get("frameType", "")}
    if "Monster" in c.get("type", ""):
        f.update(genre="monstre", niveau=c.get("level") or 1, atk=c.get("atk") or 0,
                 df=c.get("def") or 0, attribut=c.get("attribute", ""),
                 type=TYPES.get(c.get("race"), c.get("race", "")))
    else:
        f.update(genre="piege" if "Trap" in c.get("type", "") else "magie",
                 sorte=SORTES.get(c.get("humanReadableCardType"), "normale"))
    if rarete:
        f["rarete"] = rarete
    f.update(reglages or {})
    return f


def stock(catalogue: dict, artworks=ARTWORKS) -> dict:
    """La matiere du jeu. Leve Introuvable si une carte manque au catalogue
    ou n'a pas d'artwork : la page dessinerait une case vide."""
    cartes = {}
    manquantes = []

    def prends(nom, rarete=None, reglages=None) -> str:
        c = catalogue.get(nom)
        if c is None:
            manquantes.append(f"{nom} (absente du catalogue)")
            return ""
        cid = str(c["id"])
        if artworks is not None and not (Path(artworks) / f"{cid}.jpg").is_file():
            manquantes.append(f"{nom} (pas d'artwork {cid}.jpg)")
        if cid not in cartes or rarete:
            cartes[cid] = fiche(c, rarete, reglages)
        return cid

    def noms_en_ids(cid):
        # les cartes citees par leurs reglages, en identifiants
        f = cartes.get(cid, {})
        if "cherche" in f:
            f["cherche"] = prends(f["cherche"])
        if "ramene" in f:
            f["ramene"] = [prends(n) for n in f["ramene"]]

    joueur = [prends(nom, rarete, reglages) for nom, rarete, reglages in JOUEUR]
    fusions = []
    rarete_fusion = {}
    for nom, rarete, matieres, reglages in FUSIONS:
        cid = prends(nom, "fusion", reglages)
        rarete_fusion[cid] = rarete
        fusions.append({"carte": cid, "matieres": [
            {"type": m[len("type:"):]} if m.startswith("type:") else {"id": prends(m)}
            for m in matieres]})
    for cid in list(cartes):
        noms_en_ids(cid)
    ennemis = [[prends(nom) for nom in palier] for palier in ENNEMIS]
    boss = [prends(nom) for nom in BOSS]
    jetons = {}
    for cle, (nom, art, f) in JETONS.items():
        c, source = catalogue.get(nom), catalogue.get(art)
        if c is None or source is None:
            manquantes.append(f"{nom} (absent du catalogue)")
            continue
        cid = str(c["id"])
        cartes[cid] = dict(f, art=str(source["id"]))
        jetons[cle] = cid
    exodia = [prends(nom) for nom in EXODIA]
    duellistes = []
    for d in DUELLISTES:
        du = {"cle": d["cle"], "nom": d["nom"],
              "depart": {k: [prends(nom) for nom in d[k]] for k in ("terrain", "deck")}}
        if d.get("succes"):
            du.update(succes=d["succes"], cartes=[prends(nom) for nom in d.get("cartes", [])])
        duellistes.append(du)
    succes = [{"cle": x["cle"], "nom": x["nom"], "texte": x["texte"], "condition": x["condition"],
               "cartes": [prends(nom) for nom in x.get("cartes", [])], "dp": x.get("dp", 0)} for x in SUCCES]

    if manquantes:
        raise Introuvable("; ".join(manquantes))
    # tout le joueur peut aller dans un deck, les fusions dans l'Extra Deck ;
    # la boutique en garde une part, chaque duelliste a debloquer et chaque
    # succes la leur
    ids_fusions = [f["carte"] for f in fusions]
    a_vendre = {prends(nom) for nom in BOUTIQUE}
    a_debloquer = {cid for d in duellistes for cid in d.get("cartes", [])} \
        | {cid for x in succes for cid in x["cartes"]}
    collection = [cid for cid in joueur + ids_fusions if cid not in a_vendre and cid not in a_debloquer]
    hors_du_deck = {prends(nom) for nom in HORS_DU_DECK}
    deck = [cid for cid in collection if cid not in hors_du_deck and cid not in ids_fusions]
    extra = [cid for cid in collection if cid in ids_fusions][:TAILLE_EXTRA]
    # ce que la boutique peut faire tirer, et la rarete qui pese au tirage
    boutique = {cid: rarete_fusion.get(cid) or cartes[cid]["rarete"]
                for cid in joueur + ids_fusions if cid in a_vendre}

    if manquantes:
        raise Introuvable("; ".join(manquantes))
    if len(deck) != TAILLE_DECK or not a_vendre <= set(joueur + ids_fusions) \
            or not hors_du_deck <= set(collection):
        raise Introuvable(f"le deck propose au depart fait {len(deck)} cartes au lieu de {TAILLE_DECK}, "
                          "ou la boutique cite une carte que le joueur n'a pas")
    cles_succes = [x["cle"] for x in succes]
    cles_duellistes = [d["cle"] for d in duellistes]
    a_part = [cid for d in duellistes for cid in d.get("cartes", [])] + [cid for x in succes for cid in x["cartes"]]
    if not a_debloquer <= set(joueur + ids_fusions) or a_debloquer & a_vendre \
            or len(a_part) != len(set(a_part)) or len(cles_succes) != len(set(cles_succes)) \
            or "succes" in duellistes[0] \
            or any(d.get("succes") not in cles_succes for d in duellistes[1:]) \
            or any(set(x["condition"]) - set(BILAN) - {"duelliste", "victoire", "types"}
                   or set(x["condition"].get("types", {})) - set(TYPES.values())
                   or x["condition"].get("duelliste", cles_duellistes[0]) not in cles_duellistes for x in succes):
        raise Introuvable("une carte a debloquer doit etre au joueur, hors de la boutique, a un seul "
                          "duelliste ou succes ; un duelliste, nommer un succes qui existe ; un succes, "
                          "une condition que le bilan d'une partie connait")
    return {"cartes": cartes, "joueur": joueur, "fusions": fusions, "ennemis": ennemis,
            "boss": boss, "exodia": exodia, "jetons": jetons, "duellistes": duellistes, "succes": succes,
            "taille_deck": TAILLE_DECK, "taille_extra": TAILLE_EXTRA, "collection": collection,
            "deck": deck, "extra": extra, "boutique": boutique}


def ecrit(chemin=SORTIE) -> dict:
    s = stock(charge_catalogue())
    chemin.parent.mkdir(parents=True, exist_ok=True)
    # une carte par ligne : un ajout se lit dans le diff
    lignes = ",\n".join(f"    {json.dumps(cid)}: {json.dumps(f, ensure_ascii=False)}"
                        for cid, f in s["cartes"].items())
    reste = {k: v for k, v in s.items() if k != "cartes"}
    texte = ("{\n  \"cartes\": {\n" + lignes + "\n  },\n"
             + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}"
                          for k, v in reste.items())
             + "\n}\n")
    chemin.write_text(texte, encoding="utf-8")
    return s


def vignettes(cartes, source=ARTWORKS, cible=VIGNETTES) -> int:
    """Les vignettes qui manquent. Rend combien ont ete faites. Pillow vit
    dans venv/ : lance par le python du systeme, ce fichier s'arrete la. Un
    jeton sans artwork a lui (« art ») prend celui d'une autre carte."""
    from PIL import Image
    cible.mkdir(parents=True, exist_ok=True)
    faites = 0
    for cid, f in cartes.items():
        sortie = cible / f"{cid}.webp"
        if sortie.is_file():
            continue
        with Image.open(source / f"{f.get('art', cid)}.jpg") as im:
            im = im.convert("RGB")
            im.thumbnail((COTE_VIGNETTE, COTE_VIGNETTE), Image.LANCZOS)
            im.save(sortie, "WEBP", quality=82, method=6)
        faites += 1
    return faites


# --------------------------------------------------------------------------
#   Ce que chacun garde d'une partie a l'autre
# --------------------------------------------------------------------------
# La table vit dans comptes.py (migration SURVIVOR). Elle ne garde que les
# achats : la collection de depart vient de cartes.json, si bien qu'une
# carte ajoutee a COLLECTION arrive chez tout le monde sans rien migrer.
_matiere = {"mtime": None, "stock": None}
_verrou_matiere = threading.Lock()
# Lire puis ecrire un profil d'un seul tenant : gunicorn tourne avec un seul
# worker (voir app.py), donc un verrou du processus suffit. Sans lui, deux
# achats au meme instant liraient la meme liste et le second effacerait le
# premier, paye quand meme.
_verrou_profil = threading.Lock()


def matiere(chemin=None) -> dict:
    """cartes.json, relu seulement quand il change."""
    chemin = Path(chemin or SORTIE)
    with _verrou_matiere:
        mtime = chemin.stat().st_mtime
        if _matiere["mtime"] != mtime or _matiere.get("chemin") != chemin:
            _matiere.update(mtime=mtime, chemin=chemin,
                            stock=json.loads(chemin.read_text(encoding="utf-8")))
        return _matiere["stock"]


# Le bilan d'une partie, tel que la page l'envoie : ses bornes. La page dit
# ce qu'elle veut, le serveur ne croit que des chiffres possibles. Ce que
# comptent les succes qui demandent de jouer autrement (voir stats dans
# moteur.js) : fusions invoquees, magies jouees, monstres abattus par les
# pieges, cartes revenues du cimetiere, le plus gros coup d'un monstre, les
# dieux battus sous 1000 LP, les zones magie/piege remplies et la part des
# coups que la DEF arrete (en %, 70 au plus), les tours d'affilee sans
# bouger. Une page d'avant ces succes ne les envoie pas : zero.
BILAN = {"tours": 2000, "tues": 10000, "boss": 3, "exodia": 50, "niveau": 200,
         "fusions": 500, "magies": 2000, "pieges": 10000, "ramenees": 2000, "coup": 100000, "fil": 3,
         "zones": 5, "defense": 70, "immobile": 2000}


def bilan(d) -> dict:
    """Le bilan borne ; leve ValueError ou TypeError s'il est illisible.
    « types » : les monstres vaincus par Type du monstre qui les a abattus,
    les Types qu'on connait seulement."""
    b = {k: max(0, min(int(d.get(k, 0)), haut)) for k, haut in BILAN.items()}
    b["victoire"] = d.get("victoire") is True
    types = d.get("types") or {}
    if not isinstance(types, dict):
        raise TypeError("types")
    b["types"] = {t: max(0, min(int(n), BILAN["tues"])) for t, n in types.items() if t in TYPES.values()}
    return b


def succes_atteints(s, b, qui) -> list:
    """Les succes que ce bilan accomplit, joue par le duelliste `qui`."""
    def tient(k, v):
        if k == "duelliste":
            return qui == v
        if k == "victoire":
            return b["victoire"] is v
        if k == "types":
            return all(b["types"].get(t, 0) >= n for t, n in v.items())
        return b[k] >= v
    return [x["cle"] for x in s["succes"] if all(tient(k, v) for k, v in x["condition"].items())]


def gain(tours, tues, boss, victoire) -> int:
    """Les Points de Duel d'une partie : 175 en moyenne pour le robot
    d'equilibrage, une carte rare (400) toutes les deux ou trois parties
    et toute la boutique en 90 environ. C'est le quart de la premiere
    version, qui la videait en 24 parties. Bornes : la page dit ce qu'elle
    veut, le serveur ne croit que des chiffres possibles."""
    tours = max(0, min(int(tours), 2000))
    tues = max(0, min(int(tues), 10000))
    boss = max(0, min(int(boss), 3))
    return round(tours / 4 + tues / 12 + boss * 40 + (100 if victoire else 0))


def _route():
    """Le blueprint et ses routes, branches a l'import (Flask vit dans
    venv/ : `python survivor.py` sans lui fabrique quand meme la matiere)."""
    from flask import Blueprint, request
    import comptes
    from comptes import Refus, actuel, corps, echec, maintenant, reponse

    bp = Blueprint("survivor", __name__, url_prefix="/api/survivor")

    @bp.before_request
    def reserve():
        if request.method in ("POST", "PUT", "PATCH") \
                and (request.mimetype or "") != "application/json":
            return echec("format", "Les ecritures attendent du JSON.", 415)
        u = actuel()
        if u is None or not u["admin"]:
            return echec("introuvable", "Page inconnue.", 404)
        return None

    @bp.errorhandler(Refus)
    def refus(err):
        return echec(err.code, err.message, err.statut)

    def profil(uid) -> dict:
        s = matiere()
        c = comptes.cx()
        ligne = c.execute("SELECT * FROM survivor_profil WHERE utilisateur_id = ?", (uid,)).fetchone()
        if ligne is None:
            c.execute("INSERT OR IGNORE INTO survivor_profil(utilisateur_id, maj_le) VALUES (?, ?)",
                      (uid, maintenant()))
            c.commit()
            ligne = c.execute("SELECT * FROM survivor_profil WHERE utilisateur_id = ?", (uid,)).fetchone()
        victoires = [v for v in json.loads(ligne["victoires"] or "[]") if isinstance(v, str)]
        cles = [x["cle"] for x in s["succes"]]
        obtenus = [k for k in json.loads(ligne["succes"] or "[]") if k in cles]
        # une victoire d'avant les succes (Joey s'ouvrait alors par elle)
        for x in s["succes"]:
            if x["condition"].get("victoire") and x["condition"].get("duelliste") in victoires \
                    and x["cle"] not in obtenus:
                obtenus.append(x["cle"])
        ouverts = debloques(s, obtenus)
        # la collection de depart, les cartes des duellistes debloques et des
        # succes, puis ce qu'on a achete : une carte de la boutique, ou passee
        # depuis a un succes (le Magicien Sombre, achete avant le 23/10/2026,
        # reste a qui l'a paye) ; une carte qu'on a de deux facons n'y est
        # qu'une fois
        des_succes = [cid for x in s["succes"] for cid in x["cartes"]]
        achats = [cid for cid in json.loads(ligne["achats"]) if cid in s["boutique"] or cid in des_succes]
        gagnees = [cid for x in s["succes"] if x["cle"] in obtenus for cid in x["cartes"]]
        collection = list(dict.fromkeys(s["collection"] + cartes_de(s, ouverts) + gagnees + achats))
        deck = json.loads(ligne["deck"]) if ligne["deck"] else s["deck"]
        extra = json.loads(ligne["extra"]) if ligne["extra"] is not None else s["extra"]
        deck, extra = complete(deck, extra, collection, s)
        if not deck_valide(deck, extra, collection, s):
            deck, extra = s["deck"], s["extra"]
        reste = [cid for cid in s["boutique"] if cid not in collection]
        jour, offres = ligne["jour"], json.loads(ligne["offres_jour"] or "[]")
        if jour != aujourdhui():
            # la pioche du jour : tiree au premier passage de la journee, la
            # meme ensuite (le tirage ne depend que du joueur et du jour)
            jour, offres = aujourdhui(), pioche_du_jour(uid, aujourdhui(), reste)
            c.execute("UPDATE survivor_profil SET jour = ?, offres_jour = ?, jour_pris = NULL "
                      "WHERE utilisateur_id = ? AND (jour IS NULL OR jour != ?)",
                      (jour, json.dumps(offres), uid, jour))
            c.commit()
            ligne = c.execute("SELECT * FROM survivor_profil WHERE utilisateur_id = ?", (uid,)).fetchone()
        return {"dp": ligne["dp"], "collection": collection, "deck": deck, "extra": extra,
                "boutique": {"booster": PRIX_BOOSTER, "restantes": len(reste), "prix_jour": PRIX_JOUR,
                             "jour": json.loads(ligne["offres_jour"] or "[]"), "jour_pris": ligne["jour_pris"]},
                "taille": s["taille_deck"], "taille_extra": s["taille_extra"],
                "duellistes": ouverts, "victoires": victoires, "succes": obtenus, "achats": achats,
                "parties": ligne["parties"], "partie": ligne["partie"], "duelliste_partie": ligne["duelliste"]}

    def vue(p) -> dict:
        return {"ok": True, **{k: v for k, v in p.items() if k not in ("partie", "duelliste_partie", "achats")}}

    @bp.get("")
    def lire():
        return reponse(vue(profil(actuel()["id"])))

    @bp.put("/deck")
    def change_deck():
        u = actuel()
        p = profil(u["id"])
        d = corps()
        deck, extra = d.get("deck"), d.get("extra", p["extra"])
        if not all(isinstance(l, list) and all(isinstance(x, str) for x in l) for l in (deck, extra)):
            raise Refus("deck", "Le deck est une liste de cartes.")
        if not deck_valide(deck, extra, p["collection"], matiere()):
            raise Refus("deck", f"Tes boosters doivent compter {p['taille']} cartes différentes de ta collection, "
                                f"et l'Extra Deck {p['taille_extra']} fusions au plus.")
        c = comptes.cx()
        c.execute("UPDATE survivor_profil SET deck = ?, extra = ?, maj_le = ? WHERE utilisateur_id = ?",
                  (json.dumps(deck), json.dumps(extra), maintenant(), u["id"]))
        c.commit()
        return reponse(vue(profil(u["id"])))

    def ajoute(uid, p, cid, prix, pris=None):
        """La carte rejoint la collection, payee ; `pris` : la carte du jour
        qu'on vient d'acheter."""
        c = comptes.cx()
        achats = p["achats"] + [cid]
        r = c.execute("UPDATE survivor_profil SET dp = dp - ?, achats = ?, jour_pris = COALESCE(?, jour_pris), "
                      "maj_le = ? WHERE utilisateur_id = ? AND dp >= ?",
                      (prix, json.dumps(achats), pris, maintenant(), uid, prix))
        c.commit()
        if not r.rowcount:
            raise Refus("achat", "Pas assez de Points de Duel.")

    @bp.post("/achat")
    def achete():
        """Une carte de la pioche du jour : une seule par jour."""
        u = actuel()
        cid = corps().get("carte")
        with _verrou_profil:
            p = profil(u["id"])
            b = p["boutique"]
            if cid not in b["jour"] or cid in p["collection"]:
                raise Refus("achat", "Cette carte n'est pas dans la pioche du jour.")
            if b["jour_pris"]:
                raise Refus("achat", "Tu as déjà pris ta carte du jour : reviens demain.")
            if p["dp"] < PRIX_JOUR:
                raise Refus("achat", "Pas assez de Points de Duel.")
            ajoute(u["id"], p, cid, PRIX_JOUR, pris=cid)
        return reponse(vue(profil(u["id"])))

    @bp.post("/booster")
    def ouvre_booster():
        """Un booster d'une carte, tiree parmi celles qu'on n'a pas encore,
        selon sa rarete."""
        u = actuel()
        with _verrou_profil:
            p = profil(u["id"])
            reste = [cid for cid in matiere()["boutique"] if cid not in p["collection"]]
            if not reste:
                raise Refus("booster", "Tu as déjà toutes les cartes.")
            if p["dp"] < PRIX_BOOSTER:
                raise Refus("booster", "Pas assez de Points de Duel.")
            cid = tirage(reste, matiere()["boutique"])
            ajoute(u["id"], p, cid, PRIX_BOOSTER)
        return reponse({**vue(profil(u["id"])), "carte": cid})

    @bp.post("/partie")
    def commence():
        """Une partie commence : son jeton, le duelliste qui la joue (Yugi
        sans autre choix), et le deck qu'elle emporte."""
        u = actuel()
        p = profil(u["id"])
        qui = corps().get("duelliste") or matiere()["duellistes"][0]["cle"]
        if qui not in p["duellistes"]:
            raise Refus("duelliste", "Ce duelliste n'est pas encore débloqué.")
        jeton = secrets.token_urlsafe(16)
        c = comptes.cx()
        c.execute("UPDATE survivor_profil SET partie = ?, duelliste = ?, maj_le = ? WHERE utilisateur_id = ?",
                  (jeton, qui, maintenant(), u["id"]))
        c.commit()
        return reponse({"ok": True, "jeton": jeton, "duelliste": qui, "deck": p["deck"], "extra": p["extra"]})

    @bp.post("/fin")
    def finit():
        """La partie est finie : ses Points de Duel, une seule fois par jeton,
        et les succes qu'elle accomplit pour la premiere fois, avec leurs
        Points de Duel. « nouveaux_succes » les dit, « debloques » les
        duellistes qu'ils ouvrent (Joey, la premiere fois que Yugi bat
        Obelisk)."""
        u = actuel()
        d = corps()
        c = comptes.cx()
        s = matiere()
        with _verrou_profil:
            p = profil(u["id"])
            if not d.get("jeton") or d.get("jeton") != p["partie"]:
                raise Refus("partie", "Cette partie n'est pas en cours.", 409)
            try:
                b = bilan(d)
            except (TypeError, ValueError, AttributeError):
                raise Refus("partie", "Le bilan de la partie est illisible.")
            g = gain(b["tours"], b["tues"], b["boss"], b["victoire"])
            qui = p["duelliste_partie"] or s["duellistes"][0]["cle"]
            victoires = p["victoires"] + ([qui] if b["victoire"] and qui not in p["victoires"] else [])
            nouveaux = [k for k in succes_atteints(s, b, qui) if k not in p["succes"]]
            prime = sum(x["dp"] for x in s["succes"] if x["cle"] in nouveaux)
            ouverts = [cle for cle in debloques(s, p["succes"] + nouveaux) if cle not in p["duellistes"]]
            c.execute("UPDATE survivor_profil SET dp = dp + ?, parties = parties + 1, partie = NULL, "
                      "duelliste = NULL, victoires = ?, succes = ?, maj_le = ? WHERE utilisateur_id = ?",
                      (g + prime, json.dumps(victoires), json.dumps(p["succes"] + nouveaux), maintenant(), u["id"]))
            c.commit()
        return reponse({**vue(profil(u["id"])), "gain": g, "nouveaux_succes": nouveaux, "debloques": ouverts})

    return bp


def debloques(s, succes) -> list:
    """Les duellistes qu'on peut jouer : le premier, puis chacun dont on a
    le succes qui l'ouvre."""
    return [d["cle"] for d in s["duellistes"] if not d.get("succes") or d["succes"] in succes]


def cartes_de(s, cles) -> list:
    """Les cartes que ces duellistes apportent a la collection."""
    return [cid for d in s["duellistes"] if d["cle"] in cles for cid in d.get("cartes", [])]


def aujourdhui() -> str:
    """Le jour de la pioche du jour, a l'heure de la machine."""
    return time.strftime("%Y-%m-%d")


def pioche_du_jour(uid, jour, reste) -> list:
    """Les cartes du jour d'un joueur : tirees parmi celles qu'il n'a pas,
    toujours les memes pour ce joueur ce jour-la."""
    return random.Random(f"{uid}:{jour}").sample(sorted(reste), min(CARTES_DU_JOUR, len(reste)))


def tirage(reste, raretes) -> str:
    """La carte d'un booster de la boutique : les communes sortent plus
    souvent que les ultra."""
    return random.SystemRandom().choices(reste, weights=[POIDS_RARETE.get(raretes[c], 10) for c in reste])[0]


def complete(deck, extra, collection, s):
    """Un deck enregistre qui cite une carte sortie du jeu (le Dragon
    Alexandrite, retire le 22/10/2026) : elle s'en va, et une carte du deck
    propose au depart, absente du sien, prend sa place. Le reste du deck que
    le joueur a compose ne bouge pas."""
    garde = set(collection)
    if all(cid in garde for cid in deck) and all(cid in garde for cid in extra):
        return deck, extra
    complet = len(deck) >= s["taille_deck"]
    deck = [cid for cid in deck if cid in garde]
    extra = [cid for cid in extra if cid in garde]
    if complet:
        for cid in s["deck"]:
            if len(deck) >= s["taille_deck"]:
                break
            if cid in garde and cid not in deck:
                deck.append(cid)
    return deck, extra


def deck_valide(deck, extra, collection, s) -> bool:
    """40 cartes differentes de la collection, hors fusions ; 5 fusions
    differentes au plus dans l'Extra Deck."""
    fusions = {f["carte"] for f in s["fusions"]}
    return (len(deck) == s["taille_deck"] and len(set(deck)) == len(deck)
            and set(deck) <= set(collection) and not set(deck) & fusions
            and len(extra) <= s["taille_extra"] and len(set(extra)) == len(extra)
            and set(extra) <= set(collection) & fusions)


def branche():
    return _route()


if __name__ == "__main__":
    try:
        s = ecrit()
    except Introuvable as err:
        sys.exit(f"Cartes introuvables : {err}")
    print(f"{SORTIE.relative_to(BASE)} : {len(s['cartes'])} cartes, "
          f"{len(s['joueur'])} au joueur ({len(s['collection'])} au départ, "
          f"{len(s['boutique'])} à la boutique, {len(cartes_de(s, [d['cle'] for d in s['duellistes']]))} "
          f"aux duellistes, {sum(len(x['cartes']) for x in s['succes'])} aux succès), "
          f"{len(s['fusions'])} fusions, "
          f"{sum(map(len, s['ennemis']))} ennemis, {len(s['boss'])} boss")
    try:
        n = vignettes(s["cartes"])
    except ImportError:
        sys.exit("Pillow manque : relance avec venv/bin/python pour faire les vignettes.")
    print(f"{VIGNETTES.relative_to(BASE)} : {n} vignette{'s' if n > 1 else ''} faite{'s' if n > 1 else ''}")
