#!/usr/bin/env node
// ============================================================
//  CLI de lecture — API park4night (reverse v7.1.60)
//  Usage : node index.js <commande> [args]
// ============================================================
import { loadEnv } from './src/env.js';
import { clientFromEnv, PLACE_TYPES } from './src/client.js';
import { enrich, writeExport } from './src/export.js';
import { fetchZone, exportWorldByCountry, aggregateWorld, attachReviews, writeJsonArrayStream } from './src/offline.js';

loadEnv();

// --- Parsing arguments : sépare positionnels et options --flag / --flag=valeur ---
const [, , cmd, ...rawArgs] = process.argv;
const FLAGS = {};
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) {
    // --format csv  OU  --format=csv
    if (m[2] === undefined && rawArgs[i + 1] && !rawArgs[i + 1].startsWith('--')) FLAGS[m[1]] = rawArgs[++i];
    else FLAGS[m[1]] = m[2] === undefined ? true : m[2];
  } else {
    args.push(a);
  }
}
const DEBUG = process.env.P4N_DEBUG === '1' || Boolean(FLAGS.debug);
const client = clientFromEnv({ debug: DEBUG });

// --- helpers d'affichage ---
const j = (o) => JSON.stringify(o, null, 2);
function placeLine(p) {
  const type = PLACE_TYPES[p.code] || p.code || '?';
  const note = p.note_moyenne ? `★${p.note_moyenne}` : '—';
  const nb = p.nb_commentaires ? `(${p.nb_commentaires} avis)` : '';
  const ville = [p.ville, p.pays_iso?.toUpperCase()].filter(Boolean).join(', ');
  return `  #${p.id}  ${type.padEnd(24)} ${note.padEnd(6)} ${nb.padEnd(10)} ${p.titre || p.name || ''} ${ville ? '— ' + ville : ''}`;
}
function printPlaces(resp, limit = 20) {
  const list = resp?.lieux || [];
  console.log(`\n${list.length} lieu(x) — statut: ${resp?.status ?? '?'}`);
  list.slice(0, limit).forEach((p) => console.log(placeLine(p)));
  if (list.length > limit) console.log(`  … et ${list.length - limit} autres`);
}
function printReviews(resp, limit = 15) {
  const list = resp?.commentaires || [];
  console.log(`\n${list.length} avis — statut: ${resp?.status ?? '?'}`);
  list.slice(0, limit).forEach((r) => {
    const note = r.note ? `★${r.note}` : '—';
    const txt = (r.commentaire || '').replace(/\s+/g, ' ').slice(0, 100);
    console.log(`  ${note.padEnd(5)} ${(r.uuid || r.user_id || '?').padEnd(16)} ${r.date_creation || ''}  ${txt}`);
  });
}

const commands = {
  async geocode(q) {
    if (!q) return help('geocode <recherche>');
    const r = await client.geocoding(q);
    console.log(`\nRésultats pour "${q}" — statut: ${r?.status ?? '?'}`);
    (r?.results || []).forEach((g) => console.log(`  ${String(g.lat).padEnd(10)} ${String(g.lng).padEnd(10)} ${g.name}`));
    return r;
  },
  async around(lat, lon) {
    const r = await client.getPlacesAroundMe(lat, lon);
    printPlaces(r);
    return r;
  },
  async filter() {
    const r = await client.getPlacesFiltered({
      types: (process.env.FILTER_TYPES || 'ACC_G-ACC_P').split('-'),
      note: process.env.FILTER_NOTE || undefined,
    });
    printPlaces(r);
    return r;
  },
  // Liste les zones hors-ligne (régions/pays téléchargeables en 1 bloc).
  async zones() {
    const zones = await client.getOfflineZones();
    console.log(`\n${zones.length} zones hors-ligne disponibles :\n`);
    console.log('  ' + 'ID'.padEnd(24) + 'NOM'.padEnd(30) + 'BBOX (N/S/E/W)');
    for (const z of zones) {
      const bbox = `${(+z.N).toFixed(1)}/${(+z.S).toFixed(1)}/${(+z.E).toFixed(1)}/${(+z.W).toFixed(1)}`;
      console.log('  ' + String(z.id).padEnd(24) + String(z.nom).padEnd(30) + bbox);
    }
    console.log(`\n→ node index.js offline <ID> [--format csv] [--reviews]`);
    return zones;
  },

  // ⭐ UNE commande : exporte TOUS les pays (jeu mondial) + avis en JSON dans exports/world/.
  async world() {
    const withReviews = !FLAGS['no-reviews'];
    const outDir = FLAGS.out || 'exports/world';
    console.error(`Export mondial → ${outDir}  (${withReviews ? 'lieux + avis' : 'lieux seuls'})`);
    console.error(withReviews ? '⚠  ~810 Mo à télécharger (base_map complet).' : '⚠  ~177 Mo à télécharger (lieux seuls).');

    let last = 0;
    const onProgress = (done, total, name) => {
      const now = Date.now();
      if (now - last < 150 && done !== total) return;
      last = now;
      const pct = ((done / total) * 100).toFixed(0);
      const bar = '█'.repeat(Math.round(pct / 4)).padEnd(25);
      process.stderr.write(`\r  ⬇  [${bar}] ${pct}%  ${(done / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} Mo  ${name.padEnd(20)}`);
    };

    const r = await exportWorldByCountry(client, { outDir, withReviews, onProgress });
    process.stderr.write('\n');
    console.log(`✓ ${r.countries.length} pays exportés — ${r.totalPlaces} lieux` + (withReviews ? `, ${r.totalReviews} avis` : '') + ` → ${r.outDir}/`);
    console.log(`  Fichiers : {iso}_lieux.json` + (withReviews ? ` + {iso}_avis.json` : '') + ` + _index.json`);
    console.log('\n  Top 10 pays :');
    r.countries.slice(0, 10).forEach((c, i) => console.log(`   ${String(i + 1).padStart(2)}. ${c.iso.toUpperCase().padEnd(4)} ${String(c.lieux).padStart(6)} lieux` + (withReviews ? `, ${String(c.avis).padStart(6)} avis` : '') + `  ${c.pays}`));
    return r;
  },

  // Agrège un export mondial (2 fichiers/pays) en 1 fichier POI/pays (lieu + reviews[]).
  async aggregate() {
    const inDir = FLAGS.in || 'exports/world';
    const outDir = FLAGS.out || 'exports/world_poi';
    const key = FLAGS['reviews-key'] || 'reviews';
    const fs = await import('node:fs');
    if (!fs.existsSync(inDir)) { console.error(`Dossier introuvable: ${inDir} — lance d'abord: node index.js world`); process.exitCode = 1; return; }
    console.error(`Agrégation POI : ${inDir} → ${outDir}/  (clé "${key}")`);
    const r = await aggregateWorld(inDir, outDir, {
      key,
      onProgress: (i, n, c) => process.stderr.write(`\r  ${c.iso.toUpperCase().padEnd(4)} (${i}/${n}) — ${c.lieux} POI, ${c.avis} avis embarqués `),
    });
    process.stderr.write('\n');
    console.log(`✓ ${r.countries.length} pays → ${outDir}/{iso}.json  (${r.totalPlaces} POI, ${r.totalReviews} avis embarqués, 1 fichier/pays)`);
    return r;
  },

  // Télécharge + extrait UNE zone entière (tous les lieux) en 1 requête.
  async offline(zoneId) {
    if (!zoneId) return help('offline <zoneId> [--format json|csv] [--out fichier] [--reviews] [--keep-zip]');
    const format = String(FLAGS.format || 'json').toLowerCase();
    if (!['json', 'csv'].includes(format)) return help('offline … --format json|csv');
    const withReviews = Boolean(FLAGS.reviews);

    // barre de progression du téléchargement
    let last = 0;
    const onProgress = (received, total) => {
      const now = Date.now();
      if (now - last < 120 && received !== total) return;
      last = now;
      const mb = (received / 1048576).toFixed(1);
      if (total) {
        const pct = ((received / total) * 100).toFixed(0);
        const bar = '█'.repeat(Math.round(pct / 4)).padEnd(25);
        process.stderr.write(`\r  ⬇  [${bar}] ${pct}%  ${mb}/${(total / 1048576).toFixed(1)} Mo `);
      } else {
        process.stderr.write(`\r  ⬇  ${mb} Mo téléchargés `);
      }
    };

    console.error(`Zone "${zoneId}" — récupération de l'URL…`);
    const poi = Boolean(FLAGS.poi);
    const r = await fetchZone(client, zoneId, { onProgress, withReviews: withReviews || poi, keepZip: Boolean(FLAGS['keep-zip']) });
    process.stderr.write('\n');
    console.log(`✓ Téléchargé & extrait : ${r.places.length} lieux` + (r.reviews.length ? `, ${r.reviews.length} avis` : ''));

    const base = FLAGS.out ? FLAGS.out.replace(/\.(json|csv)$/i, '') : `park4night_${zoneId}`;

    // --poi : 1 seul fichier JSON, chaque lieu contient sa liste `reviews`.
    if (poi) {
      const places = attachReviews(enrich(r.places), r.reviews, 'reviews');
      const out = FLAGS.out || `${base}_poi.json`;
      const bytes = writeJsonArrayStream(out, places);
      console.log(`  → POI    : ${places.length} lieux (avis embarqués) → ${out} (${(bytes / 1048576).toFixed(1)} Mo)`);
      return r;
    }

    const placesOut = FLAGS.out && !withReviews ? FLAGS.out : `${base}.${format}`;
    const w1 = writeExport(enrich(r.places), format, placesOut);
    console.log(`  → lieux  : ${w1.count} → ${w1.path} (${(w1.bytes / 1048576).toFixed(1)} Mo)`);
    if (withReviews) {
      const w2 = writeExport(r.reviews, format, `${base}_avis.${format}`);
      console.log(`  → avis   : ${w2.count} → ${w2.path} (${(w2.bytes / 1048576).toFixed(1)} Mo)`);
    }
    return r;
  },

  // Export JSON/CSV. Sources : around | filter | user-places | commented | map
  async export(source, ...rest) {
    const src = source || 'around';
    const format = String(FLAGS.format || 'json').toLowerCase();
    if (!['json', 'csv'].includes(format)) return help('export … --format json|csv');
    const limit = FLAGS.limit ? parseInt(FLAGS.limit, 10) : undefined;

    let resp, label;
    switch (src) {
      case 'around':
        resp = await client.getPlacesAroundMe(rest[0], rest[1]);
        label = 'around'; break;
      case 'filter':
        resp = await client.getPlacesFiltered({
          types: (process.env.FILTER_TYPES || '').split('-').filter(Boolean),
          services: (process.env.FILTER_SERVICES || '').split('-').filter(Boolean),
          note: process.env.FILTER_NOTE || undefined,
          heightLimit: process.env.FILTER_HEIGHT || undefined,
        });
        label = 'filter'; break;
      case 'user-places':
        resp = await client.getPlacesCreated(rest[0]);
        label = 'user-' + (rest[0] || client.username || 'me'); break;
      case 'commented':
        resp = await client.getPlacesCommented(rest[0], rest[1]);
        label = 'commented-' + (rest[0] || ''); break;
      case 'map':
        resp = await client.getPlacesForCustomMap(rest[0]);
        label = 'map-' + (rest[0] || ''); break;
      default:
        return help('export <around|filter|user-places|commented|map> [args] [--format json|csv] [--out fichier] [--limit N]');
    }

    let places = resp?.lieux || [];
    if (limit) places = places.slice(0, limit);
    if (!places.length) { console.error('Aucun lieu à exporter (statut: ' + (resp?.status ?? '?') + ').'); process.exitCode = 1; return; }

    places = enrich(places);
    const out = FLAGS.out || `park4night_${label}.${format}`;
    const r = writeExport(places, format, out);
    console.log(`✓ ${r.count} lieux exportés — ${format.toUpperCase()}, ${(r.bytes / 1024).toFixed(1)} Ko → ${r.path}`);
    return r;
  },
  async place(id) {
    if (!id) return help('place <idLieu>');
    const r = await client.getPlace(id);
    const p = r?.lieux?.[0];
    if (!p) { console.log('Lieu introuvable'); return r; }
    console.log(`\n#${p.id} — ${p.titre || p.name}`);
    console.log(`  Type      : ${PLACE_TYPES[p.code] || p.code}`);
    console.log(`  Position  : ${p.latitude}, ${p.longitude}`);
    console.log(`  Adresse   : ${[p.route, p.ville, p.code_postal, p.pays].filter(Boolean).join(', ')}`);
    console.log(`  Note      : ${p.note_moyenne || '—'} (${p.nb_commentaires || 0} avis, ${p.nb_photos || 0} photos)`);
    console.log(`  Contact   : ${p.tel || '—'} ${p.site_internet || ''}`);
    if (p.description_fr) console.log(`  Descriptif: ${p.description_fr.replace(/\s+/g, ' ').slice(0, 200)}`);
    return r;
  },
  async info(id) {
    if (!id) return help('info <idLieu>');
    const r = await client.getPlaceInfo(id);
    console.log(j(r));
    return r;
  },
  async photos(id) {
    if (!id) return help('photos <idLieu>');
    const r = await client.getPlacePhotos(id);
    const list = r?.p4n_photos || [];
    console.log(`\n${list.length} photo(s)`);
    list.forEach((ph) => console.log(`  #${ph.id}  ${ph.link_large || ph.link_thumb}`));
    return r;
  },
  async reviews(id) {
    if (!id) return help('reviews <idLieu>');
    printReviews(await client.getReviewsOfPlace(id));
  },
  async 'user-reviews'(userId) {
    if (!userId) return help('user-reviews <userId>');
    printReviews(await client.getReviewsOfUser(userId));
  },
  async 'user'(userId) {
    if (!userId) return help('user <userId>');
    console.log(j(await client.getPublicUserProfile(userId)));
  },
  async 'user-places'(username) {
    printPlaces(await client.getPlacesCreated(username));
  },
  async privacy() { console.log(j(await client.getPrivacy())); },
  async menu() { console.log(j(await client.getMenuLinks())); },
  async ads(mode) { console.log(j(await client.getAds(mode || 'map'))); },
  async subscription() { console.log(j(await client.checkSubscription())); },
  async login() {
    const r = await client.login();
    const u = r?.results;
    console.log(`\nConnecté — statut: ${r?.status}`);
    if (u) console.log(`  id=${u.id} uuid=${u.uuid} véhicule=${u.type_vehicule || '—'} abo_mensuel_fin=${u.abo_mensuel_date_fin || '—'} abo_annuel_fin=${u.abo_annuel_date_fin || '—'}`);
    return r;
  },
  async me() {
    // profil de l'utilisateur .env (nécessite login pour l'id)
    const login = await client.login();
    const uid = login?.results?.id;
    console.log(`\n== Mes lieux créés ==`);
    printPlaces(await client.getPlacesCreated());
    if (uid) { console.log(`\n== Mes avis ==`); printReviews(await client.getReviewsOfUser(uid)); }
  },
  async demo() {
    console.log('=== DEMO (mode ' + (client.isGuest ? 'invité' : client.username) + ') ===');
    const g = await commands.geocode('Annecy');
    const first = g?.results?.[0];
    if (first) await commands.around(first.lat, first.lng);
  },
};

function help(usage) {
  if (usage) { console.error(`Usage: node index.js ${usage}`); process.exitCode = 2; return; }
  console.log(`park4night — client lecture (reverse 7.1.60)

Commandes :
  geocode <recherche>       Recherche géographique (nom de lieu/ville)
  around [lat] [lon]        Lieux autour d'une position (défaut: .env)
  filter                    Recherche filtrée (FILTER_TYPES, FILTER_NOTE en env)
  world                     ⭐ Exporte TOUS les pays (161) + avis en JSON dans exports/world/
                            options: --no-reviews  --out <dossier>
  zones                     Liste les zones hors-ligne (régions/pays)
  offline <zoneId>          Télécharge TOUTE une zone (pays/région) en 1 bloc
                            options: --format json|csv  --reviews  --poi  --out <f>  --keep-zip
                            --poi : 1 fichier, chaque lieu contient sa liste reviews[]
  aggregate                 Fusionne l'export mondial en 1 fichier POI/pays (lieu+reviews[])
                            options: --in <dir>  --out <dir>  --reviews-key <nom>
  export <source> [args]    Exporte des lieux en JSON/CSV
                            sources: around [lat] [lon] | filter | user-places <pseudo>
                                     | commented <userId> | map <mapId>
                            options: --format json|csv  --out <fichier>  --limit <N>
  place <idLieu>            Détail d'un lieu
  info <idLieu>             Boutons/popup d'un lieu (brut)
  photos <idLieu>           Photos d'un lieu
  reviews <idLieu>          Avis d'un lieu
  user-reviews <userId>     Avis rédigés par un utilisateur
  user <userId>             Profil public d'un utilisateur
  user-places <pseudo>      Lieux créés par un utilisateur
  privacy | menu | ads      Endpoints de config
  subscription              État d'abonnement (nécessite compte)
  login | me                Connexion / mes données (nécessite .env identifiants)
  demo                      Démo enchaînée (geocode → around)

Options : --debug (affiche les URLs)
Config  : éditez .env (identifiants optionnels : lecture publique en invité).`);
}

(async () => {
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return help();
  const fn = commands[cmd];
  if (!fn) { console.error(`Commande inconnue: ${cmd}\n`); return help(); }
  try {
    await fn(...args);
  } catch (e) {
    console.error(`\n✖ Erreur: ${e.message}`);
    if (e.url && DEBUG) console.error(`  URL: ${e.url}`);
    if (e.body && DEBUG) console.error(`  Body: ${typeof e.body === 'string' ? e.body.slice(0, 300) : JSON.stringify(e.body).slice(0, 300)}`);
    process.exitCode = 1;
  }
})();
