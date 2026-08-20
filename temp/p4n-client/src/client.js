// ============================================================
//  Client park4night — LECTURE SEULE
//  Reconstitué depuis fr.tramb.park4night 7.1.60 (Ktor / KMP).
//
//  Reproduit fidèlement :
//   - makeUrl()       : schéma d'URL selon apiType + sous-domaine
//   - fullContext()   : paramètres de contexte ajoutés à chaque requête
//   - getHash()       : motdepasse = SHA-256(mot de passe) hexa
// ============================================================
import crypto from 'node:crypto';

// --- Sous-domaines (enum `o`) : préfixe d'hôte ---
const SUBDOMAIN = { WRITE: '', LOGIN: '', REQUEST: '', P4N: '', PUB: 'pub.', PLUS: 'plus.', GUEST: 'guest.', DEFAULT: '' };

// --- Préfixe de chemin selon apiType (enum `a`) ---
const API_PREFIX = { LEGACY: 'services/V4.1', V2: 'api', CUSTOM: 'services' };

// --- Table des endpoints en LECTURE (enum `c`, filtré aux GET/lectures) ---
// { url, sub, api, method }  — method: GET par défaut ; certains "get" sont des POST (corps vide).
export const ENDPOINTS = {
  getPlace:               { url: 'lieuGetOneLieux.php',  sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getPlacesAroundMe:      { url: 'lieuxGetAroundMe.php', sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getPlacesFiltered:      { url: 'lieuxGetFilter.php',   sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getPlaceInfo:           { url: 'lieuGetInfos.php',     sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getPlacePhotos:         { url: 'lieuGetPhotos.php',    sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getPlacesCommented:     { url: 'lieuGetCommUser.php',  sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getPlacesCreated:       { url: 'lieuGetUser.php',      sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getPlacesForCustomMap:  { url: 'lieuGetMapCustom.php', sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getReviewsOfPlace:      { url: 'commGet.php',          sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getReviewsOfUser:       { url: 'commGet.php',          sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  translateReview:        { url: 'commGetTrad.php',      sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getUser:                { url: 'userGet.php',          sub: 'LOGIN',   api: 'LEGACY', method: 'GET'  }, // login
  getPublicUserProfile:   { url: 'userGetPublic.php',    sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  getPrivacy:             { url: 'privacyGet.php',       sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  checkSubscription:      { url: 'proGet.php',           sub: 'REQUEST', api: 'LEGACY', method: 'GET'  },
  geocoding:              { url: 'geocoding.php',        sub: 'REQUEST', api: 'LEGACY', method: 'POST' }, // corps vide, q en query
  getAds:                 { url: 'pubService.php',       sub: 'PUB',     api: 'LEGACY', method: 'GET'  },
  getMenuLinks:           { url: 'menu_dynamique/V1/config_menu.php', sub: 'PUB', api: 'CUSTOM', method: 'GET' },
  getCurrentSubscription: { url: 'user/subscription/last', sub: 'REQUEST', api: 'V2',  method: 'GET'  },
  // Mode hors-ligne : export complet d'une zone (pays/région) en 1 téléchargement.
  getOfflineConfig:       { url: 'offline/V3/map/config.json', sub: 'P4N', api: 'CUSTOM', method: 'POST' },
  getMapConfig:           { url: 'offline/V3/bdd/index.php',   sub: 'P4N', api: 'CUSTOM', method: 'POST' },
};

/** SHA-256 hexadécimal minuscule — équivalent de tools.h.getHash(). */
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

export class Park4NightClient {
  /**
   * @param {object} cfg
   *  host, pubHost, appVersion, platform, userAgent, lang, locale,
   *  lat, lon, username, password, userId, isMonthPremium, isYearPremium, timeout, debug
   */
  constructor(cfg = {}) {
    this.host = cfg.host || 'park4night.com';
    this.pubHost = cfg.pubHost || 'pub.park4night.com';
    this.appVersion = cfg.appVersion || '7.1.60';
    this.platform = cfg.platform || 'ANDROID';
    this.userAgent = cfg.userAgent || 'shared - 0.4.31';
    this.lang = cfg.lang || 'fr';
    this.locale = cfg.locale || 'fr_FR';
    this.lat = cfg.lat != null ? String(cfg.lat) : '';
    this.lon = cfg.lon != null ? String(cfg.lon) : '';
    this.username = cfg.username || '';
    this.password = cfg.password || '';
    this.userId = cfg.userId || '';
    this.isMonthPremium = Boolean(cfg.isMonthPremium);
    this.isYearPremium = Boolean(cfg.isYearPremium);
    this.vehicle = cfg.vehicle || '';
    this.timeout = cfg.timeout || 20000;
    this.debug = Boolean(cfg.debug);

    // Le mot de passe circule haché (SHA-256). Vide en mode invité.
    this.motdepasse = this.password ? sha256Hex(this.password) : '';
    this.isGuest = !this.username || this.username === 'guest';
  }

  get subscribed() { return this.isMonthPremium || this.isYearPremium; }

  /** Résout le préfixe de sous-domaine (reproduit la logique de makeUrl). */
  resolveSubdomain(ep) {
    if (ep.sub === 'REQUEST') {
      if (this.subscribed) return SUBDOMAIN.PLUS;
      if (this.isGuest) return SUBDOMAIN.GUEST;
      return SUBDOMAIN.DEFAULT;
    }
    return SUBDOMAIN[ep.sub] ?? '';
  }

  /** Construit l'URL de base d'un endpoint (sans query). */
  makeUrl(ep) {
    const sub = this.resolveSubdomain(ep);
    const domain = ep.sub === 'PUB' || sub === 'pub.' ? this.pubHost : this.host;
    // domaine "nu" (sans un éventuel préfixe déjà présent) + préfixe résolu
    const bareDomain = domain.replace(/^(pub\.|plus\.|guest\.)/, '');
    return `https://${sub}${bareDomain}/${API_PREFIX[ep.api]}/${ep.url}`;
  }

  /** Paramètres de contexte ajoutés à CHAQUE requête (fullContext). */
  contextParams() {
    const p = new URLSearchParams();
    p.set('context_user', this.isGuest ? 'guest' : this.username);
    p.set('context_os', this.platform);
    p.set('context_lang', this.lang);
    p.set('langue_locale', this.locale);
    p.set('context_latitude', this.lat);
    p.set('context_longitude', this.lon);
    p.set('context_version', this.appVersion);
    p.set('isMonthPremium', String(this.isMonthPremium));
    p.set('isYearPremium', String(this.isYearPremium));
    p.set('context_id_user', this.isGuest ? 'guest' : (this.userId || ''));
    p.set('os', this.platform);
    if (this.vehicle) p.set('context_vehicule', this.vehicle);
    if (this.motdepasse) p.set('motdepasse', this.motdepasse);
    return p;
  }

  /** Requête générique. `query` = objet de params spécifiques à l'endpoint. */
  async request(endpointName, query = {}) {
    const ep = ENDPOINTS[endpointName];
    if (!ep) throw new Error(`Endpoint inconnu: ${endpointName}`);

    const params = this.contextParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      params.set(k, String(v));
    }

    const base = this.makeUrl(ep);
    const url = `${base}?${params.toString()}`;
    if (this.debug) console.error(`[${ep.method}] ${url}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let res;
    try {
      res = await fetch(url, {
        method: ep.method,
        headers: { 'User-Agent': this.userAgent, 'Accept': 'application/json' },
        // geocoding est POST mais sans corps (le q est en query)
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* réponse non-JSON */ }

    if (!res.ok) {
      const msg = data?.message || data?.status || text?.slice(0, 200) || res.statusText;
      const err = new Error(`HTTP ${res.status} sur ${ep.url} — ${msg}`);
      err.status = res.status; err.body = data ?? text; err.url = url;
      throw err;
    }
    // Erreurs "legacy" renvoyées en 200 avec {status:"error"|...}
    if (data && typeof data.status === 'string' && /error|do not find/i.test(data.status) && !data.lieux && !data.results) {
      const err = new Error(`Erreur API (${ep.url}) — ${data.message || data.status}`);
      err.body = data; err.url = url;
      throw err;
    }
    return data ?? text;
  }

  // ---------------- Méthodes de lecture ----------------

  /** Connexion : valide les identifiants et renvoie le UserDto. */
  login() {
    if (this.isGuest) throw new Error('login() nécessite P4N_USERNAME/P4N_PASSWORD dans .env');
    return this.request('getUser', { uuid: this.username, motdepasse: this.motdepasse });
  }

  getPlace(id)                { return this.request('getPlace', { id, appli: 'park4night' }); }
  getPlacesAroundMe(lat = this.lat, lon = this.lon) { return this.request('getPlacesAroundMe', { latitude: lat, longitude: lon }); }
  getPlaceInfo(idLieu)        { return this.request('getPlaceInfo', { id_lieu: idLieu }); }
  getPlacePhotos(placeId)     { return this.request('getPlacePhotos', { pn_lieu_id: placeId }); }
  getReviewsOfPlace(placeId)  { return this.request('getReviewsOfPlace', { lieu_id: placeId, appli: 'park4night' }); }
  getReviewsOfUser(userId)    { return this.request('getReviewsOfUser', { user_id: userId, appli: 'park4night' }); }
  translateReview(reviewId)   { return this.request('translateReview', { id_comm: reviewId }); }
  getPublicUserProfile(uid)   { return this.request('getPublicUserProfile', { id_user: uid }); }
  getPlacesCreated(username = this.username) { return this.request('getPlacesCreated', { uuid: username, visites: 'true' }); }
  getPlacesCommented(userId, username = this.username) { return this.request('getPlacesCommented', { user_id: userId, uuid: username }); }
  getPlacesForCustomMap(mapId){ return this.request('getPlacesForCustomMap', { map: mapId }); }
  getPrivacy()                { return this.request('getPrivacy'); }
  checkSubscription()         { return this.request('checkSubscription'); }

  // --- Mode hors-ligne ---
  getOfflineConfig()          { return this.request('getOfflineConfig'); }
  async getOfflineZones()     { const r = await this.getOfflineConfig(); return r?.zones || []; }
  /** Métadonnées + URL du .zip d'une zone : { status, name, size, url }. */
  getZoneInfo(zoneId)         { return this.request('getMapConfig', { map: zoneId }); }
  getMenuLinks()              { return this.request('getMenuLinks'); }
  getAds(mode = 'map')        { return this.request('getAds', { mode }); }
  geocoding(q)                { return this.request('geocoding', { q }); }

  /**
   * Recherche filtrée.
   * @param {object} f  { lat, lon, types:[], activities:[], services:[], note, heightLimit, allYear, onlineBooking }
   *  types: codes PlaceType (ex: ['C','ACC_G']) ; activities/services: codes minuscules.
   */
  getPlacesFiltered(f = {}) {
    const q = {
      latitude: f.lat ?? this.lat,
      longitude: f.lon ?? this.lon,
    };
    if (f.heightLimit != null) q.hauteur_limite = f.heightLimit;
    if (f.types?.length) q.types = f.types.join('-');
    if (f.activities?.length) q.activites = f.activities.join('-');
    if (f.services?.length) q.services = f.services.join('-');
    if (f.note != null) q.note = f.note;
    if (f.allYear) q.all_year = '1';
    if (f.onlineBooking) q.online_booking = '1';
    return this.request('getPlacesFiltered', q);
  }
}

/** Construit un client depuis les variables d'environnement (.env déjà chargé). */
export function clientFromEnv(extra = {}) {
  return new Park4NightClient({
    host: process.env.P4N_HOST,
    pubHost: process.env.P4N_PUB_HOST,
    appVersion: process.env.P4N_APP_VERSION,
    platform: process.env.P4N_PLATFORM,
    userAgent: process.env.P4N_USER_AGENT,
    lang: process.env.P4N_LANG,
    locale: process.env.P4N_LOCALE,
    lat: process.env.P4N_LAT,
    lon: process.env.P4N_LON,
    username: process.env.P4N_USERNAME,
    password: process.env.P4N_PASSWORD,
    userId: process.env.P4N_USER_ID,
    isMonthPremium: process.env.P4N_IS_MONTH_PREMIUM === 'true',
    isYearPremium: process.env.P4N_IS_YEAR_PREMIUM === 'true',
    ...extra,
  });
}

// Codes utiles (rappel)
export const PLACE_TYPES = {
  C: 'Camping', ACC_P: 'Aire CC payante', ACC_G: 'Aire CC gratuite', ACC_PR: 'Aire CC privée',
  PN: 'Aire pleine nature', APN: 'Aire pique-nique', AR: 'Aire autoroute', ASS: 'Stationnement sans services',
  DS: 'Point services', EP: 'Entre particuliers', OR: 'Off-road', F: 'Fermé',
  P: 'Parking', PSS: 'Parking sans services', PJ: 'Parking de jour',
};
export const ACTIVITIES = ['jeux_enfants','point_de_vue','baignade','escalade','eaux_vives','peche','peche_pied','rando','visites','vtt','windsurf','moto'];
export const SERVICES = ['electricite','point_eau','eau_noire','eau_usee','poubelle','boulangerie','wc_public','douche','wifi','caravaneige','animaux','piscine','laverie','gpl','gaz','donnees_mobile','lavage'];
