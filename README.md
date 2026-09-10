# Abyss

Le hub, et les projets qui vivent dedans. Un seul serveur Flask, un seul port,
un seul compte : `app.py` branche chaque projet comme un blueprint.

## Les projets

| Projet | Adresse | Python | `static/` | `templates/` |
|---|---|---|---|---|
| **Abyss** — le hub, le compte, le profil | `/abyss` | `comptes.py` `monitoring.py` `suggestions.py` | `abyss/` | `abyss/` |
| **Archive Jeux Vidéos** — journaux, fil social | `/archive` | `journal.py` `jaquettes.py` `social.py` | `archive/` | `archive/` |
| **Mini-Jeux / Quiz** — jaquette floue, chronologie, grille | `/quiz` | `quiz.py` | `quiz/` | `quiz/` |
| **Collection Yu-Gi-Oh!** — le classeur | `/collection` | `collection.py` | `collection/` | `collection/` |
| **Yu-Gi-Quiz** — deviner une carte à son artwork | `/yugiquiz` | `yugiquiz.py` | `yugiquiz/` | `yugiquiz/` |
| **Chainz** — le site du jeu | `/chainz` | *(page seule)* | `chainz/` | `chainz/` |

## Où vit quoi

```
static/
├── commun/       ce que plusieurs projets chargent : compte.js, champs.js,
│                 gestes.js, neige.js, suggestion.js, polices/, vendor/
├── abyss/        abyss.css · Avatars/ Bannieres/
├── archive/      archive.css, social.css, archive-*.js · Cover/
├── quiz/         quiz.css                    (jaquettes : voir Cover/)
├── yugioh/       cartes-fr.json, cartes-en.json, cartes-vues.json
│                 · Cards/ CardsCropped/
├── collection/   collection.css              (cartes : voir yugioh/)
├── yugiquiz/     yugiquiz.css, commun.js     (cartes : voir yugioh/)
└── chainz/       cartes.json, images.json, art/{old,new}/
```

Un dossier par projet, sauf deux **matières partagées**, qui portent le nom de
ce qu'elles contiennent et non celui d'un projet :

- `static/yugioh/` — les noms de cartes, lus par la **Collection** *et* par le
  **Yu-Gi-Quiz** ;
- les jaquettes de jeux — téléchargées par l'**Archive**, rejouées par le
  **Quiz**.

Ce qui explique pourquoi `cartes-fr.json` (Yu-Gi-Oh) et `cartes.json` (Chainz)
existent tous les deux : deux projets sans rapport, deux dossiers.

### Les dossiers d'images

`Avatars/`, `Bannieres/`, `Cards/`, `CardsCropped/`, `Cover/` et `chainz/art/`
sont dans `.gitignore` : lourds, jamais édités à la main, déjà sur le serveur.
Ils sont restés à la racine de `static/`, sauf `chainz/art/` qui a rejoint son
projet. Le tableau ci-dessus dit à quel projet chacun se rattache.

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
venv/bin/python -m unittest tests # 154 tests
```

En ligne : `gunicorn -k gthread -w 1 --threads 8 app:app`. **Un seul worker** —
les salles du Yu-Gi-Quiz vivent en mémoire, deux workers ne verraient pas les
mêmes.
