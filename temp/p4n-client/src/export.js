// Export des lieux (PlaceDto) en JSON / CSV.
import fs from 'node:fs';
import path from 'node:path';
import { PLACE_TYPES } from './client.js';

// Colonnes prioritaires en tête du CSV (les autres suivent, dans l'ordre rencontré).
const PREFERRED = [
  'id', 'titre', 'name', 'code', 'type_label', 'latitude', 'longitude',
  'route', 'ville', 'code_postal', 'pays', 'pays_iso',
  'note_moyenne', 'nb_commentaires', 'nb_visites', 'nb_photos',
  'tel', 'mail', 'site_internet', 'hauteur_limite',
  'date_creation', 'utilisateur_creation', 'user_id', 'url',
];

/** Ajoute des colonnes dérivées lisibles (libellé de type + URL web du lieu). */
export function enrich(places = []) {
  return places.map((p) => ({
    ...p,
    type_label: PLACE_TYPES[p.code] || p.code || '',
    url: p.id ? `https://www.park4night.com/lieu/${p.id}` : '',
  }));
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n;]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Construit le CSV (union des clés de tous les lieux, colonnes prioritaires d'abord). */
export function toCSV(places = [], { delimiter = ',' } = {}) {
  if (!places.length) return '';
  const keys = [];
  const seen = new Set();
  for (const k of PREFERRED) if (places.some((p) => k in p) && !seen.has(k)) { keys.push(k); seen.add(k); }
  for (const p of places) for (const k of Object.keys(p)) if (!seen.has(k)) { keys.push(k); seen.add(k); }
  const lines = [keys.map(csvCell).join(delimiter)];
  for (const p of places) lines.push(keys.map((k) => csvCell(p[k])).join(delimiter));
  return lines.join('\r\n');
}

export function toJSON(places = []) {
  return JSON.stringify(places, null, 2);
}

/**
 * Écrit les lieux dans un fichier.
 * @returns {{path:string, count:number, bytes:number}}
 */
export function writeExport(places, format, outPath, opts = {}) {
  const fmt = (format || 'json').toLowerCase();
  const dir = path.dirname(path.resolve(outPath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let content;
  if (fmt === 'csv') {
    // BOM UTF-8 pour qu'Excel affiche correctement les accents.
    content = '﻿' + toCSV(places, opts);
  } else if (fmt === 'json') {
    content = toJSON(places);
  } else {
    throw new Error(`Format inconnu: ${fmt} (attendu: json | csv)`);
  }
  fs.writeFileSync(outPath, content, 'utf8');
  return { path: outPath, count: places.length, bytes: Buffer.byteLength(content, 'utf8') };
}
