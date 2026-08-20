# park4night-client (lecture seule)

Client Node.js **sans dépendance** pour interroger l'API park4night en lecture, reconstitué par reverse-engineering de l'app Android **v7.1.60**.

> ⚠️ À but d'interopérabilité / documentation. Respectez les CGU de park4night. Pas d'écriture (aucune création/suppression/modification n'est implémentée).

## Prérequis

- Node.js **≥ 18** (utilise `fetch` natif ; testé sur Node 22). Aucune install : `npm install` inutile.

## Configuration

Tout est dans `.env` (déjà pré-rempli avec les constantes de l'app) :

```bash
cp .env.example .env   # si besoin
```

La **lecture publique fonctionne en mode invité, sans compte**. Renseignez `P4N_USERNAME` / `P4N_PASSWORD` uniquement pour accéder à vos données personnelles (vos lieux, abonnement…).

| Variable | Rôle | Défaut |
|---|---|---|
| `P4N_HOST` / `P4N_PUB_HOST` | hôtes API | `park4night.com` / `pub.park4night.com` |
| `P4N_APP_VERSION` | version envoyée | `7.1.60` |
| `P4N_USER_AGENT` | User-Agent | `shared - 0.4.31` |
| `P4N_LAT` / `P4N_LON` | position par défaut | Lyon |
| `P4N_USERNAME` / `P4N_PASSWORD` | **identifiants (sensible)** — mot de passe **en clair**, haché SHA-256 par le client | *(vide = invité)* |
| `P4N_USER_ID` | id utilisateur (pour certaines requêtes) | — |
| `GOOGLE_MAPS_KEY` | clé extraite du binaire (facultative) | *(pré-remplie)* |

## Utilisation (CLI)

```bash
node index.js <commande> [args] [--debug]
```

| Commande | Description |
|---|---|
| `geocode <recherche>` | recherche géographique (renvoie lat/lon) |
| `around [lat] [lon]` | lieux autour d'une position |
| `filter` | recherche filtrée (`FILTER_TYPES`, `FILTER_NOTE` en env) |
| `zones` | liste les zones hors-ligne (régions/pays) |
| `offline <zoneId>` | **⭐ télécharge TOUTE une zone (pays/région) en 1 bloc** (voir ci-dessous) |
| `export <source> [args]` | exporte des lieux en JSON/CSV (voir ci-dessous) |
| `place <id>` | détail d'un lieu |
| `photos <id>` | photos d'un lieu |
| `reviews <id>` | avis d'un lieu |
| `user <userId>` | profil public |
| `user-reviews <userId>` | avis d'un utilisateur |
| `user-places <pseudo>` | lieux créés par un utilisateur |
| `privacy` \| `menu` \| `ads` | endpoints de config |
| `login` \| `me` \| `subscription` | nécessitent des identifiants |
| `demo` | démo enchaînée geocode → around |

Exemples :

```bash
node index.js geocode "Annecy"
node index.js around 45.899 6.129
node index.js place 2493
node index.js reviews 2493 --debug     # --debug affiche les URLs appelées
```

Sortie réelle (`place 2493`) :

```
#2493 — Annecy, 3 Route du Semnoz
  Type      : Camping
  Position  : 45.890499, 6.132250
  Note      : 4.03 (209 avis, 5 photos)
```

## ⭐⭐⭐ Agrégation par POI — 1 fichier/pays, avis embarqués

Pour éviter les 2 fichiers (`_lieux` + `_avis`), chaque lieu porte sa propre liste `reviews[]`.

**Sur une zone** (téléchargement + agrégation en 1 passe) :
```bash
node index.js offline island --poi --out islande.json   # 1 fichier, lieux avec reviews[]
```

**Sur l'export mondial** (post-traitement, sans re-télécharger) :
```bash
node index.js world        # d'abord (produit exports/world/ : 2 fichiers/pays)
node index.js aggregate    # → exports/world_poi/{iso}.json : 1 fichier/pays, avis embarqués
```
Options `aggregate` : `--in <dir>` · `--out <dir>` · `--reviews-key <nom>` (défaut `reviews`).

Chaque objet POI = le lieu (enrichi `type_label` + `url`) + `reviews: [ {note, commentaire, uuid, date_creation, …} ]`. Testé : 161 pays, 392 142 POI, 4 718 322 avis embarqués.

> **Lecture des gros fichiers** : l'agrégateur écrit **un POI par ligne**. Les petits pays se lisent
> avec `JSON.parse`, mais `fr.json` (~655 Mo) dépasse la taille max d'une string Node — lisez-le
> **ligne par ligne** (chaque ligne = 1 POI JSON, sauf `[` / `]`) :
> ```js
> import readline from 'node:readline'; import fs from 'node:fs';
> const rl = readline.createInterface({ input: fs.createReadStream('fr.json'), crlfDelay: Infinity });
> for await (let l of rl) { l = l.trim().replace(/,$/, ''); if (l[0] !== '{') continue; const poi = JSON.parse(l); /* … */ }
> ```
> (ou `jq -c '.[]' fr.json`).

## ⭐⭐ Export MONDIAL — tous les pays + avis en 1 commande

```bash
node index.js world                 # tous les pays (161) + avis → exports/world/
node index.js world --no-reviews    # lieux seuls (~177 Mo au lieu de ~810 Mo)
node index.js world --out data/monde
```

Une **seule commande** télécharge le jeu mondial (`base_map`) et écrit dans `exports/world/` :

- `{iso}_lieux.json` — un tableau JSON de lieux par pays (`fr_lieux.json`, `es_lieux.json`, …)
- `{iso}_avis.json` — les avis du pays (sauf `--no-reviews`)
- `_index.json` — récapitulatif `[{ iso, pays, lieux, avis }]` trié

**161 pays, ~392 000 lieux** (jeu mondial « lite »). Traitement en flux (HTTP Range + décompression à la volée), **mémoire bornée** — rien n'est chargé entièrement en RAM. Top pays : 🇫🇷 France ~80k, 🇪🇸 Espagne ~41k, 🇮🇹 Italie ~38k, 🇩🇪 Allemagne ~36k, 🇬🇧 UK ~22k.

> Pour la donnée **complète** (non « lite ») d'une région précise, utilisez `offline <zone>` ci-dessous.

## ⭐ Export complet d'un pays / région (mode hors-ligne)

Le plus efficace : le **mode hors-ligne** de l'app télécharge la base de lieux d'une zone entière dans **un seul `.zip`** (des fichiers `lieux*.json` + `commentaires*.json`). Une région = **1 téléchargement**, sans pagination.

```bash
node index.js zones                                   # liste les 24 zones (monde découpé)
node index.js offline island --format csv --reviews   # Islande : 964 lieux + 9227 avis
node index.js offline espagne_portugal --format json  # Espagne+Portugal, ~150 Mo
```

Options : `--format json|csv` · `--reviews` (exporte aussi les avis dans `_avis`) · `--out <fichier>` · `--keep-zip`.

**Zones disponibles** (24, couvrent le monde) — ex. `weast_europe`, `north_europe`, `south_europe`,
`espagne_portugal`, `United_kingdom_Eire`, `usa`, `canada`, `quebec`, `australie`, `island`, `base_map`…
(voir `node index.js zones`). Chaque zone est un pavé géographique (bounding box N/S/E/W).

> ⚠️ Les grosses zones sont volumineuses (Europe de l'Ouest ≈ 460 Mo, Europe du Sud ≈ 750 Mo).
> `node index.js zones` puis `offline <id>` affiche une barre de progression.

Mécanisme (reverse) : `getOfflineConfig` liste les zones → `getMapConfig(id)` donne l'URL CDN
`https://cdn7.park4night.com/offline/V3/bdd/fichier/<id>.zip` → le zip contient les lieux en JSON.
L'extraction ZIP est faite en Node pur (`zlib`), sans dépendance.

## Export JSON / CSV (par requête réseau)

```bash
node index.js export <source> [args] [--format json|csv] [--out <fichier>] [--limit <N>]
```

**Sources :**

| Source | Args | Description |
|---|---|---|
| `around` | `[lat] [lon]` | lieux autour d'une position (défaut) |
| `filter` | — | recherche filtrée (`FILTER_TYPES`, `FILTER_SERVICES`, `FILTER_NOTE`, `FILTER_HEIGHT` en env) |
| `user-places` | `<pseudo>` | lieux créés par un utilisateur |
| `commented` | `<userId>` | lieux commentés par un utilisateur |
| `map` | `<mapId>` | lieux d'une carte personnalisée |

**Options :** `--format json|csv` (défaut `json`) · `--out <fichier>` (défaut `park4night_<source>.<ext>`) · `--limit <N>`.

Exemples :

```bash
node index.js export around 45.899 6.129 --format csv --out annecy.csv
node index.js export around --format json --limit 20
FILTER_TYPES=ACC_G-ACC_P FILTER_NOTE=4 node index.js export filter --format csv
```

- **CSV** : union de toutes les colonnes (74+), colonnes utiles en tête, **BOM UTF-8** (accents OK dans Excel), échappement RFC correct. Deux colonnes dérivées ajoutées : `type_label` (libellé lisible du type) et `url` (`https://www.park4night.com/lieu/<id>`).
- **JSON** : tableau des `PlaceDto` enrichis.

En bibliothèque :

```js
import { enrich, toCSV, toJSON, writeExport } from './src/export.js';
const { lieux } = await p4n.getPlacesAroundMe(45.9, 6.13);
writeExport(enrich(lieux), 'csv', 'sortie.csv');   // → { path, count, bytes }
```

## Utilisation (bibliothèque)

```js
import { loadEnv } from './src/env.js';
import { clientFromEnv } from './src/client.js';

loadEnv();
const p4n = clientFromEnv();               // ou new Park4NightClient({...})

const around = await p4n.getPlacesAroundMe(45.899, 6.129);
console.log(around.lieux.length, 'lieux');

const detail = await p4n.getPlace('2493');
const reviews = await p4n.getReviewsOfPlace('2493');

// recherche filtrée
const filtered = await p4n.getPlacesFiltered({
  lat: 45.9, lon: 6.13,
  types: ['ACC_G', 'ACC_P'],   // aires camping-car gratuites + payantes
  services: ['electricite', 'eau_noire'],
  note: '4',                    // ≥ 4 ★
});

// avec compte (P4N_USERNAME/P4N_PASSWORD dans .env)
const me = await p4n.login();   // valide et renvoie le UserDto
```

### Méthodes disponibles

`login`, `getPlace`, `getPlacesAroundMe`, `getPlacesFiltered`, `getPlaceInfo`, `getPlacePhotos`,
`getReviewsOfPlace`, `getReviewsOfUser`, `translateReview`, `getPublicUserProfile`,
`getPlacesCreated`, `getPlacesCommented`, `getPlacesForCustomMap`, `getPrivacy`,
`checkSubscription`, `getMenuLinks`, `getAds`, `geocoding`.

## Comment ça marche

Le client reproduit fidèlement la couche réseau de l'app :

1. **`makeUrl()`** — `https://{sousDomaine}{domaine}/{services/V4.1|api|services}/{endpoint}`.
   Le sous-domaine dépend de l'abonnement : `plus.` (Premium), `guest.` (invité), sinon domaine nu.
2. **`fullContext()`** — chaque requête reçoit `context_user`, `context_os=ANDROID`, `context_version`,
   `context_latitude/longitude`, `context_id_user`, etc. en query string.
3. **Auth** — `motdepasse = SHA-256(mot de passe)` en hexadécimal (calculé par `sha256Hex`).
   Aucune signature HMAC/token : l'auth repose sur ces paramètres.

Voir `../API_park4night.md` pour la documentation complète des 48 endpoints.

## Codes utiles

- **Types de lieu** (`code` / filtre `types`) : `C` camping, `ACC_G`/`ACC_P` aires CC gratuites/payantes,
  `PN` pleine nature, `P` parking, `PJ` parking de jour… (voir `PLACE_TYPES` dans `src/client.js`).
- **Activités** / **services** : codes minuscules (ex. `baignade`, `electricite`), joints par `-`.
- **Filtre note** : `4.75`, `4` ou `3`.

## Sécurité

- `.env` est ignoré par git (`.gitignore`). Ne committez jamais vos identifiants.
- Le mot de passe n'est jamais transmis en clair : seul son hash SHA-256 circule (comme l'app).
