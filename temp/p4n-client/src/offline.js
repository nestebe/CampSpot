// ============================================================
//  Mode hors-ligne park4night — export COMPLET d'une zone en 1 téléchargement.
//
//  Mécanisme (reverse OfflineDownloadService) :
//   1. getOfflineConfig  → liste des zones (bbox monde entier découpé)
//   2. getMapConfig(id)  → { url } du .zip CDN
//   3. le .zip contient  lieux*.json  ({status,lieux:[PlaceDto]})
//                        commentaires*.json ({status,commentaires:[ReviewDto]})
//
//  Extraction ZIP en Node pur (zlib) — aucune dépendance.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { enrich } from './export.js';

/** Décompresse un buffer ZIP → { 'nom.json': Buffer, ... } (méthodes store/deflate). */
export function unzip(buf) {
  const EOCD = 0x06054b50, CEN = 0x02014b50;
  let i = buf.length - 22;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  while (i >= min && buf.readUInt32LE(i) !== EOCD) i--;
  if (i < min) throw new Error('Archive ZIP invalide (EOCD introuvable)');
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error('Entrée central-directory invalide');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp);
    p += 46 + nameLen + extraLen + commLen;
  }
  return out;
}

/** Fusionne tous les lieux*.json d'une archive extraite. */
export function placesFromFiles(files) {
  const places = [];
  for (const [name, buf] of Object.entries(files)) {
    if (/^lieux\d*\.json$/i.test(name)) {
      const j = JSON.parse(buf.toString('utf8'));
      const arr = Array.isArray(j) ? j : (j.lieux || []);
      places.push(...arr);
    }
  }
  return places;
}

/** Fusionne tous les commentaires*.json d'une archive extraite. */
export function reviewsFromFiles(files) {
  const reviews = [];
  for (const [name, buf] of Object.entries(files)) {
    if (/^commentaires\d*\.json$/i.test(name)) {
      const j = JSON.parse(buf.toString('utf8'));
      const arr = Array.isArray(j) ? j : (j.commentaires || []);
      reviews.push(...arr);
    }
  }
  return reviews;
}

/** Télécharge une URL vers un fichier, avec callback de progression (reçu, total). */
export async function downloadToFile(url, dest, userAgent, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const ws = fs.createWriteStream(dest);
  let received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
    if (onProgress) onProgress(received, total);
  }
  await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
  return { bytes: received, total };
}

// ---------- Lecture ZIP distante via HTTP Range (sans tout télécharger) ----------

function rangeFetcher(url, ua) {
  return async (start, end) => {
    const res = await fetch(url, { headers: { 'User-Agent': ua, Range: `bytes=${start}-${end}` } });
    if (!(res.status === 206 || res.status === 200)) throw new Error(`HTTP ${res.status} (range)`);
    return Buffer.from(await res.arrayBuffer());
  };
}

/** Lit le catalogue (central directory) d'un zip distant. total = taille du fichier. */
export async function readRemoteZipDir(url, total, ua) {
  const range = rangeFetcher(url, ua);
  const tail = await range(Math.max(0, total - 262144), total - 1);
  let i = tail.length - 22;
  while (i >= 0 && tail.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('EOCD introuvable');
  const count = tail.readUInt16LE(i + 10);
  const cdSize = tail.readUInt32LE(i + 12);
  const cdOff = tail.readUInt32LE(i + 16);
  const cd = await range(cdOff, cdOff + cdSize - 1);
  let p = 0; const entries = [];
  for (let n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commLen = cd.readUInt16LE(p + 32);
    const lho = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, csize, usize, lho });
    p += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

/** Télécharge + décompresse UNE entrée du zip distant. */
export async function fetchRemoteEntry(url, entry, ua) {
  const range = rangeFetcher(url, ua);
  const buf = await range(entry.lho, entry.lho + 30 + 320 + entry.csize);
  const lNameLen = buf.readUInt16LE(26), lExtraLen = buf.readUInt16LE(28);
  const start = 30 + lNameLen + lExtraLen;
  const comp = buf.subarray(start, start + entry.csize);
  return entry.method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp);
}

/** Écrivain de tableaux JSON par pays, en flux (mémoire bornée, ne stocke rien). */
class CountryWriter {
  constructor(dir, suffix) { this.dir = dir; this.suffix = suffix; this.started = new Set(); this.n = {}; }
  file(iso) { return path.join(this.dir, `${iso}_${this.suffix}.json`); }
  writeBatch(iso, items) {
    if (!items.length) return;
    const first = !this.started.has(iso);
    if (first) { this.started.add(iso); this.n[iso] = 0; }
    const parts = items.map((o) => (this.n[iso]++ > 0 ? ',\n' : '') + JSON.stringify(o));
    // 1re écriture : writeFileSync (tronque un éventuel fichier d'un run précédent) ; ensuite append.
    if (first) fs.writeFileSync(this.file(iso), '[\n' + parts.join(''));
    else fs.appendFileSync(this.file(iso), parts.join(''));
  }
  close() { for (const iso of this.started) fs.appendFileSync(this.file(iso), '\n]\n'); }
}

/**
 * ⭐ Export MONDIAL par pays en 1 commande : télécharge base_map (jeu mondial),
 *    écrit exports/world/{iso}_lieux.json (+ _avis.json) + _index.json.
 * Mémoire bornée (traitement entrée par entrée via HTTP Range).
 */
export async function exportWorldByCountry(client, { outDir, withReviews = true, onProgress } = {}) {
  const info = await client.getZoneInfo('base_map');
  if (!info || info.status !== 'OK' || !info.url) throw new Error('base_map indisponible: ' + (info?.msg || info?.status));
  fs.mkdirSync(outDir, { recursive: true });

  const entries = await readRemoteZipDir(info.url, info.size, client.userAgent);
  const want = entries.filter((e) => /^lieux\d*\.json$/i.test(e.name) || (withReviews && /^commentaires\d*\.json$/i.test(e.name)));
  const totalBytes = want.reduce((s, e) => s + e.csize, 0);

  const lw = new CountryWriter(outDir, 'lieux');
  const rw = new CountryWriter(outDir, 'avis');
  const idx = {};
  let done = 0;

  for (const e of want) {
    const data = await fetchRemoteEntry(info.url, e, client.userAgent);
    done += e.csize;
    const isLieux = /^lieux/i.test(e.name);
    const j = JSON.parse(data.toString('utf8'));
    const arr = isLieux ? (j.lieux || []) : (j.commentaires || []);
    const groups = new Map();
    for (const it of arr) {
      const iso = (it.pays_iso || 'xx').toLowerCase();
      if (!groups.has(iso)) groups.set(iso, []);
      groups.get(iso).push(it);
    }
    for (const [iso, items] of groups) {
      idx[iso] = idx[iso] || { iso, pays: '', lieux: 0, avis: 0 };
      if (isLieux) {
        lw.writeBatch(iso, enrich(items));
        idx[iso].lieux += items.length;
        if (!idx[iso].pays && items[0].pays) idx[iso].pays = items[0].pays;
      } else {
        rw.writeBatch(iso, items);
        idx[iso].avis += items.length;
      }
    }
    if (onProgress) onProgress(done, totalBytes, e.name);
  }
  lw.close(); rw.close();

  const summary = Object.values(idx).sort((a, b) => b.lieux - a.lieux);
  fs.writeFileSync(path.join(outDir, '_index.json'), JSON.stringify(summary, null, 2));
  return { outDir, countries: summary, totalPlaces: summary.reduce((s, c) => s + c.lieux, 0), totalReviews: summary.reduce((s, c) => s + c.avis, 0) };
}

// ---------- Agrégation par POI (lieu + sa liste `reviews`) ----------

/** Regroupe une liste d'avis par identifiant de lieu (review.pn_lieu_id → lieu.id). */
export function groupReviewsByPlace(reviews) {
  const m = new Map();
  for (const r of reviews) {
    const k = r.pn_lieu_id;
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** Attache à chaque lieu sa liste d'avis sous la clé `key` (défaut "reviews"). */
export function attachReviews(places, reviews, key = 'reviews') {
  const m = reviews instanceof Map ? reviews : groupReviewsByPlace(reviews);
  for (const p of places) p[key] = m.get(p.id) || [];
  return places;
}

/** Écrit un tableau JSON en flux (place par place) sans construire une chaîne géante. */
export function writeJsonArrayStream(file, items, mapFn) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, '[\n');
    items.forEach((it, i) => fs.writeSync(fd, (i > 0 ? ',\n' : '') + JSON.stringify(mapFn ? mapFn(it) : it)));
    fs.writeSync(fd, '\n]\n');
  } finally { fs.closeSync(fd); }
  return fs.statSync(file).size;
}

/** Regroupe les avis d'un fichier {iso}_avis.json en flux (lecture ligne par ligne, mémoire réduite). */
export async function groupReviewsFromFile(file) {
  const m = new Map();
  if (!fs.existsSync(file)) return m;
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let n = 0;
  for await (let line of rl) {
    line = line.trim();
    if (!line || line === '[' || line === ']') continue;
    if (line.endsWith(',')) line = line.slice(0, -1);
    if (line[0] !== '{') continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const k = r.pn_lieu_id;
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
    n++;
  }
  m._count = n;
  return m;
}

/**
 * Agrège un pays : fusionne {iso}_lieux.json + {iso}_avis.json → {iso}.json (POI avec `reviews`).
 * Mémoire bornée à un pays.
 */
export async function aggregateCountry(inDir, outDir, iso, key = 'reviews') {
  const places = JSON.parse(fs.readFileSync(path.join(inDir, `${iso}_lieux.json`), 'utf8'));
  const byLieu = await groupReviewsFromFile(path.join(inDir, `${iso}_avis.json`));
  const nAvis = byLieu._count || 0;
  attachReviews(places, byLieu, key);
  const bytes = writeJsonArrayStream(path.join(outDir, `${iso}.json`), places);
  return { iso, lieux: places.length, avis: nAvis, bytes };
}

/** Agrège tout un dossier d'export mondial (par pays) en fichiers POI. */
export async function aggregateWorld(inDir, outDir, { key = 'reviews', onProgress } = {}) {
  const isos = fs.readdirSync(inDir).filter((f) => /_lieux\.json$/.test(f)).map((f) => f.replace(/_lieux\.json$/, '')).sort();
  fs.mkdirSync(outDir, { recursive: true });
  const summary = [];
  for (let i = 0; i < isos.length; i++) {
    const r = await aggregateCountry(inDir, outDir, isos[i], key);
    summary.push(r);
    if (onProgress) onProgress(i + 1, isos.length, r);
  }
  summary.sort((a, b) => b.lieux - a.lieux);
  fs.writeFileSync(path.join(outDir, '_index.json'), JSON.stringify(summary, null, 2));
  return { outDir, countries: summary, totalPlaces: summary.reduce((s, c) => s + c.lieux, 0), totalReviews: summary.reduce((s, c) => s + c.avis, 0) };
}

/**
 * Télécharge + extrait une zone entière.
 * @returns {Promise<{zone:string, name:string, size:number, places:object[], reviews:object[], zipPath:string}>}
 */
export async function fetchZone(client, zoneId, { onProgress, keepZip = false, withReviews = true, tmpDir = os.tmpdir() } = {}) {
  const info = await client.getZoneInfo(zoneId); // { status, name, size, url }
  if (!info || info.status !== 'OK' || !info.url) {
    throw new Error(`Zone "${zoneId}" indisponible: ${info?.msg || info?.status || 'réponse vide'}`);
  }
  const zipPath = path.join(tmpDir, info.name || `${zoneId}.zip`);
  await downloadToFile(info.url, zipPath, client.userAgent, onProgress);

  const buf = fs.readFileSync(zipPath);
  const files = unzip(buf);
  const places = placesFromFiles(files);
  const reviews = withReviews ? reviewsFromFiles(files) : [];
  if (!keepZip) { try { fs.unlinkSync(zipPath); } catch { /* ignore */ } }

  return { zone: zoneId, name: info.name, size: info.size, places, reviews, zipPath: keepZip ? zipPath : null };
}
