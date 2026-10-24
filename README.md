# Abyss

Le hub, et les projets qui vivent dedans. Un seul serveur Flask, un seul port,
un seul compte : `app.py` branche chaque projet comme un blueprint.

## Les projets

| Projet | Adresse | Python | `static/` | `templates/` |
|---|---|---|---|---|
| **Abyss** — le hub, le compte, le profil | `/abyss` | `comptes.py` `monitoring.py` `suggestions.py` `apercu.py` `accueil.py` | `abyss/` | `abyss/` |
| **Archive Jeux Vidéos** — journaux, fil social | `/archive` | `journal.py` `jaquettes.py` `social.py` `entretien.py` | `archive/` | `archive/` |
| **Mini-Jeux Vidéo** — jaquette floue, chronologie, grille | `/quiz` | `quiz.py` | `quiz/` | `quiz/` |
| **Collection Yu-Gi-Oh!** — le classeur | `/collection` | `collection.py` `cartes.py` | `collection/` | `collection/` |
| **Collection Pokémon** — série par série, version par version *(en chantier, admin seul)* | `/pokemon` | `pokemon.py` `pokemon_stock.py` | `pokemon/` | `pokemon/` |
| **Yu-Gi-Quiz** — deviner une carte à son artwork | `/yugiquiz` | `yugiquiz.py` | `yugiquiz/` | `yugiquiz/` |
| **Chainz** — le site du jeu | `/chainz` | *(page seule)* | `chainz/` | `chainz/` |
| **Nihongo** — le japonais, un peu chaque jour | `/nihongo` | `nihongo.py` | `nihongo/` | `nihongo/` |
| **Yu-Gi-Oh! Survivor** : un survivor au tour par tour *(en chantier, admin seul)* | `/survivor` | `survivor.py` | `survivor/` | `survivor/` |

## Où vit quoi

```
static/
├── commun/       ce que plusieurs projets chargent : compte.js, champs.js,
│                 gestes.js, neige.js, presence.js, suggestion.js, polices/,
│                 vendor/, logo/ (la méduse : favicon, icônes, en-tête),
│                 manifest.webmanifest (le site installable sur téléphone)
├── Avatars/      les photos de profil        (Bannieres/ : pas encore)
├── abyss/        abyss.css (le dessin de toutes les pages d'Abyss),
│                 accueil.css
├── archive/      archive.css, social.css, archive-*.js · Cover/
├── quiz/         quiz.css, quiz.js   (jaquettes : voir archive/Cover/)
├── yugioh/       cartes-fr.json, cartes-en.json, cartes-vues.json,
│                 cartes-rarity.json, cartes-ignorees.json ·
│                 Cards/ CardsCropped/
├── collection/   collection.css, collection.js (cartes : voir yugioh/)
├── pokemon/      pokemon.css, pokemon.js · blocs.json, series/<serie>.json (le catalogue,
│                 écrit par pokemon_stock.py depuis TCGdex) ·
│                 Cartes/<bloc>/<serie>/ Vignettes/<bloc>/<serie>/ Logos/
├── yugiquiz/     yugiquiz.css, commun.js     (cartes : voir yugioh/)
├── survivor/     survivor.css, survivor.js, moteur.js (les règles, sans DOM) ·
│                 cartes.json (écrit par survivor.py depuis le catalogue
│                 ygoprodeck) · art/ (les vignettes, hors du dépôt)
├── chainz/       cartes.json, images.json, art/{old,new}/
└── nihongo/      nihongo.css, nihongo.js, kana.js, kanji.js, mots.js,
                  grammaire.js, lecture.js, trace.js, romaji.js, traces-kana.json,
                  kanji.json, vocabulaire.json, grammaire.json, lecture.json,
                  romaji.json, traces-kanji-n{5..1}.json
                  (fabriqués par nihongo.py, voir plus bas) · voix/ ·
                  libre/ (les phrases de la lecture libre, hors du dépôt)

matiere/          la matière de Nihongo écrite à la main, et non fabriquée :
├── vocabulaire-fr.tsv       les sens français des 7 913 mots
├── grammaire-n5.txt … -n1.txt  les points de grammaire : explications et
│                               phrases d'exemple (le format est décrit en
│                               tête de grammaire-n5.txt)
├── lecture-n5.txt … -n1.txt    les textes à lire, du N5 au N1 (format en
│                               tête de lecture-n5.txt)
├── lecture-mots.tsv            les mots des textes que le vocabulaire n'a
│                               pas : noms propres, mots hors des listes
└── libre-mots.tsv              ceux des phrases de la lecture libre (Tatoeba)
```

Un dossier par projet, sauf deux **matières partagées**, qui portent le nom de
ce qu'elles contiennent et non celui d'un projet :

- `static/yugioh/` — les noms de cartes, lus par la **Collection** *et* par le
  **Yu-Gi-Quiz** ;
- les jaquettes de jeux — téléchargées par l'**Archive**, rejouées par le
  **Quiz**, et jointes au mail de la veille d'une sortie (`alertes.py`).

Ce qui explique pourquoi `cartes-fr.json` (Yu-Gi-Oh) et `cartes.json` (Chainz)
existent tous les deux : deux projets sans rapport, deux dossiers.

### Les dossiers d'images

`Avatars/`, `Bannieres/`, `archive/Cover/`, `yugioh/Cards/`,
`yugioh/CardsCropped/`, `chainz/art/` et les images de `pokemon/` sont dans
`.gitignore` : lourds, jamais édités à la main, déjà sur le serveur. Les cartes
Pokémon se téléchargent depuis la page, bouton « Mettre à jour » (admin) :
environ 2 Go et une heure et demie pour tout le catalogue, une minute par série
nouvelle.

Chacun vit dans le dossier du projet qui l'alimente, comme le reste : l'Archive
télécharge les jaquettes, donc `archive/Cover/` ; les artworks de cartes sont
une matière Yu-Gi-Oh, donc `yugioh/Cards/` à côté des noms de cartes. Que le
Quiz rejoue les jaquettes et que le Yu-Gi-Quiz rejoue les artworks ne change
rien : le dossier porte le nom de qui remplit, pas de qui lit.

Seuls `Avatars/` et `Bannieres/` sont restés à la racine de `static/` : leur
adresse publique est celle de la photo de profil d'un compte, recopiée dans des
pages et des caches qu'on ne maîtrise pas.

## Les adresses

Chaque page a une adresse propre (`/archive`, `/collection`, `/quiz`…). Les
anciennes en `.html` répondent encore en 301, pour ne pas casser un marque-page.
Deux exceptions qui **servent** au lieu de rediriger :

- `/reinitialiser.html`, parce qu'une redirection perdrait le `?jeton=` du
  lien envoyé par mail — `/abyss/reinitialiser` est la nouvelle adresse ;
- `/archive/<pseudo>` et `/collection/<pseudo>`, qui sont la même page que
  `/archive` et `/collection`.

## Lancer

```sh
venv/bin/python app.py            # http://127.0.0.1:8000/abyss
venv/bin/python -m unittest tests  # 513 tests
venv/bin/python nihongo.py matiere # refait les JSON de static/nihongo/
venv/bin/python survivor.py        # refait static/survivor/cartes.json et ses vignettes
```

Les JSON de Nihongo sont versionnés : on ne les refait que si une source
change (KanjiVG, KANJIDIC2, JMdict, listes JLPT) ou que `matiere/` change -
une traduction, un point de grammaire, un texte. Un test refuse un
`grammaire.json`, un `lecture.json` ou un `romaji.json` en retard sur ses fichiers. Les sources
(une quarantaine de Mo) sont téléchargées une fois dans `donnees/nihongo/`.

La lecture libre sert, une à une, des phrases de Tatoeba (CC BY 2.0 FR) :
celles qui ont une traduction française et dont l'analyseur explique chaque
mot, 22 000 environ, du N5 au N1. Les trier prend deux minutes ;
`nihongo.py matiere` garde le résultat dans `donnees/nihongo/libre.json` et
ne le refait que si le vocabulaire, la grammaire, un glossaire ou l'analyseur
ont changé. Ses paquets (`static/nihongo/libre/`, ~7 Mo) restent hors du
dépôt : ils se refont à l'identique depuis les sources.

Les textes à lire sont découpés en mots à la fabrication, par SudachiPy, et
chaque mot relié à son entrée du vocabulaire ou du glossaire : la page
n'embarque aucun analyseur. SudachiPy découpe aussi, pour le réglage
« rōmaji », les phrases de la grammaire et le japonais glissé dans ses
explications (`romaji.json`). Il ne sert qu'à `nihongo.py matiere` :

```sh
venv/bin/pip install sudachipy sudachidict_core
```

Les sons de Nihongo (`static/nihongo/voix/`, hors du dépôt comme les
images) sont fabriqués par VOICEVOX, voix Nemo : une voix de femme (`f1`) et
une d'homme (`h3`), au choix sur la page Aujourd'hui. Plus de 12 000 sons
par voix (les kanas, le vocabulaire, les mots d'exemple des kanjis, les
phrases de la grammaire et des textes), ~120 Mo chacune. Le moteur ne tourne pas dans le serveur web : il s'installe
une fois, puis fabrique ce qui manque.

```sh
venv/bin/pip install soundfile https://github.com/VOICEVOX/voicevox_core/releases/download/0.17.0/voicevox_core-0.17.0-cp310-abi3-manylinux_2_34_x86_64.whl
cd donnees/nihongo/voicevox      # le téléchargeur « download-linux-x64 » de la même page
./download --only onnxruntime dict models --models-pattern n0.vvm -o .
cd - && nice venv/bin/python nihongo.py voix   # ~4 h par voix, niveau par niveau ; reprend où il s'arrête
```

En ligne : `gunicorn -k gthread -w 1 --threads 64 app:app`. **Un seul worker** —
les salles du Yu-Gi-Quiz vivent en mémoire, deux workers ne verraient pas les
mêmes. **64 fils et pas 8** : chaque onglet connecté (Archive, fil, Yu-Gi-Quiz)
garde un fil pour son temps réel, et à 8 onglets le site ne répondait plus.
