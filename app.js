'use strict';

const $ = (s) => document.querySelector(s);

// ---------- Salvataggio locale (può fallire in finestre private) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignora */ }
  },
};

const DEFAULTS = {
  source: 'streetview',
  rounds: 5,
  timeLimit: 120,
  moveMode: 'move',
  maxPoints: 5000,
  tolerance: 'auto',
  toleranceKm: 50,
  weighting: 'area',
  panoOnly: false,
  showBorder: true,
  showCompass: true,
  // difficoltà: all = qualsiasi posto, hard / medium / easy = fasce di punteggio del posto (vedi "Difficoltà"),
  // custom = solo la Zona scelta a mano
  level: 'all',
  // zona (solo con level "custom"): any = ovunque, inhabited = zone abitate, cities = centri di città e paesi,
  // main = centro principale di ogni area
  zone: 'any',
  filterOfficial: false,
  filterNoHighways: false,
  filterNoTunnels: false,
};

// Filtri consigliati per ogni livello: si applicano quando si sceglie il livello, poi si possono cambiare
const LEVEL_FILTERS = {
  all: { filterOfficial: false, filterNoHighways: false, filterNoTunnels: false },
  hard: { filterOfficial: false, filterNoHighways: false, filterNoTunnels: true },
  medium: { filterOfficial: true, filterNoHighways: true, filterNoTunnels: true },
  easy: { filterOfficial: true, filterNoHighways: true, filterNoTunnels: true },
};

function loadSettings() {
  const saved = store.get('dovesono.settings', {});
  // versioni precedenti: il filtro "Solo zone abitate" è diventato la zona "inhabited",
  // e prima dei livelli la difficoltà era solo la zona
  if (saved.filterInhabited && !saved.zone) saved.zone = 'inhabited';
  delete saved.filterInhabited;
  if (!saved.level) saved.level = saved.zone && saved.zone !== 'any' ? 'custom' : 'all';
  // valori vuoti o di versioni precedenti tornano al predefinito
  Object.keys(saved).forEach((k) => {
    if (saved[k] === '' || saved[k] == null || (k in DEFAULTS && typeof saved[k] !== typeof DEFAULTS[k])) delete saved[k];
  });
  return { ...DEFAULTS, ...saved };
}

const state = {
  settings: loadSettings(),
  areas: store.get('dovesono.areas', []), // { id, name, kind, geometry }
  token: store.get('dovesono.token', '') || (window.GEO_CONFIG && window.GEO_CONFIG.mapillaryToken) || '',
  game: null,
};

// ---------- Geometria ----------
function polygonParts(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function prepareArea(area) {
  const parts = polygonParts(area.geometry).map((coords) => {
    const feature = turf.polygon(coords);
    return { feature, bbox: turf.bbox(feature), area: turf.area(feature) };
  });
  const total = parts.reduce((s, p) => s + p.area, 0);
  return { ...area, parts, totalArea: total };
}

function weightedPick(items, weightOf) {
  const total = items.reduce((s, it) => s + weightOf(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function randomPointInArea(prepared) {
  const part = weightedPick(prepared.parts, (p) => p.area);
  const [minX, minY, maxX, maxY] = part.bbox;
  for (let i = 0; i < 1000; i++) {
    const pt = [minX + Math.random() * (maxX - minX), minY + Math.random() * (maxY - minY)];
    if (turf.booleanPointInPolygon(pt, part.feature)) return pt;
  }
  return turf.centroid(part.feature).geometry.coordinates;
}

function pointInArea(pt, prepared) {
  return prepared.parts.some((p) => turf.booleanPointInPolygon(pt, p.feature));
}

function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function areasBbox(areas) {
  const fc = turf.featureCollection(areas.map((a) => turf.feature(a.geometry)));
  return turf.bbox(fc);
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100000) return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(m / 1000).toLocaleString('it-IT')} km`;
}

// ---------- Punteggio ----------
// Distanza (in metri) a cui si prende metà dei punti.
function halfPointsDistance(settings, areas) {
  if (settings.tolerance === 'manual') return Math.max(50, settings.toleranceKm * 1000);
  const [minX, minY, maxX, maxY] = areasBbox(areas);
  const diagonal = haversine([minX, minY], [maxX, maxY]);
  return Math.max(50, (diagonal / 10) * Math.LN2);
}

function scoreFor(distance, settings, halfDist) {
  if (distance <= 25) return settings.maxPoints;
  return Math.round(settings.maxPoints * Math.pow(0.5, distance / halfDist));
}

// ---------- Rete ----------
async function fetchJson(url, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}

// Scarica l'immagine in anticipo: verifica che il server risponda e la mette in cache.
function preloadImage(url, crossOrigin, ms = 10000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; reject(new Error('TIMEOUT')); }, ms);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('LOAD')); };
    img.src = url;
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- Fonte: Mapillary ----------
async function searchImages(token, bbox, panoOnly) {
  const params = new URLSearchParams({
    access_token: token,
    fields: 'id,geometry,is_pano',
    bbox: bbox.map((n) => n.toFixed(6)).join(','),
    limit: '100',
  });
  if (panoOnly) params.set('is_pano', 'true');

  let r;
  try {
    r = await fetchJson(`https://graph.mapillary.com/images?${params}`);
  } catch {
    return [];
  }
  // Un token non valido torna come 400/401/403 con un OAuthException
  if (r.res.status === 401 || r.res.status === 403 || (r.body.error && r.body.error.type === 'OAuthException')) {
    throw new Error('TOKEN');
  }
  return r.res.ok && Array.isArray(r.body.data) ? r.body.data : [];
}

// Alcune app Mapillary appena create hanno un token valido ma ricevono sempre zero foto.
// Lo verifico su una zona piena di foto (Tour Eiffel) prima di iniziare.
const checkedTokens = new Set();
async function checkToken(token) {
  if (checkedTokens.has(token)) return;
  const data = await searchImages(token, [2.29, 48.85, 2.30, 48.86], false);
  if (!data.length) throw new Error('EMPTY_APP');
  checkedTokens.add(token);
}

function mapillaryComponents(settings) {
  const base = { cover: false, bearing: settings.showCompass };
  if (settings.moveMode === 'move') return base;
  const still = { ...base, sequence: false, direction: false, keyboard: false };
  if (settings.moveMode === 'pan') return still;
  return { ...still, mouse: false, zoom: false };
}

let mlyViewer = null;

const mapillarySource = {
  name: 'Mapillary',
  needsToken: true,
  boxes: [0.004, 0.015, 0.049], // mezza larghezza in gradi: Mapillary accetta al massimo 0,01 gradi quadrati
  check: () => checkToken(state.token),
  async search(bbox, settings) {
    const data = await searchImages(state.token, bbox, settings.panoOnly);
    return data.filter((im) => im.geometry)
      .map((im) => ({ id: im.id, coords: im.geometry.coordinates, isPano: !!im.is_pano }));
  },
  async prepare() {},
  async show(pic, settings) {
    if (!mlyViewer) {
      mlyViewer = new mapillary.Viewer({
        accessToken: state.token,
        container: 'viewer',
        imageId: pic.id,
        component: mapillaryComponents(settings),
      });
    } else {
      await mlyViewer.moveTo(pic.id);
    }
  },
  resize() { if (mlyViewer) mlyViewer.resize(); },
  destroy() {
    if (mlyViewer) { mlyViewer.remove(); mlyViewer = null; }
    $('#viewer').innerHTML = '';
  },
};

// ---------- Fonte: Panoramax ----------
// Catalogo che raccoglie tutte le istanze Panoramax; le foto restano sui server delle singole istanze.
const PANORAMAX_API = 'https://api.panoramax.xyz/api';
const hostFailures = new Map();
const deadHosts = new Set();
let pxViewer = null;   // viewer Pannellum per le foto a 360°
let pxCurrent = null;  // foto mostrata ora (cambia quando ci si sposta)

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

function markHostFailure(url, reason) {
  const host = hostOf(url);
  const n = (hostFailures.get(host) || 0) + 1;
  hostFailures.set(host, n);
  if (reason === 'TIMEOUT' || n >= 3) deadHosts.add(host);
}

function panoramaxPicture(f) {
  const props = f.properties || {};
  const io = props['pers:interior_orientation'] || {};
  const isPano = io.field_of_view === 360;
  const width = (io.sensor_array_dimensions || [])[0] || 0;
  const assets = f.assets || {};
  // Le panoramiche più larghe di 8192 px non entrano in una texture WebGL: uso la versione ridotta
  const asset = isPano && assets.hd && width && width <= 8192 ? assets.hd : (assets.sd || assets.hd);
  const link = (rel) => ((f.links || []).find((l) => l.rel === rel) || {}).href || null;
  return {
    id: f.id,
    coords: f.geometry.coordinates,
    isPano,
    url: asset ? asset.href : null,
    azimuth: props['view:azimuth'] || 0,
    producer: props['geovisio:producer'] || ((f.providers || [])[0] || {}).name || '',
    license: props.license || '',
    prev: link('prev'),
    next: link('next'),
  };
}

function showPanoramaxPicture(pic, settings) {
  pxCurrent = pic;
  const still = settings.moveMode === 'nmpz';
  if (pxViewer) { pxViewer.destroy(); pxViewer = null; }
  $('#px-pano').innerHTML = '';
  $('#px-pano').style.display = pic.isPano ? '' : 'none';
  $('#px-flat').style.display = pic.isPano ? 'none' : '';

  if (pic.isPano) {
    pxViewer = pannellum.viewer('px-pano', {
      type: 'equirectangular',
      panorama: pic.url,
      autoLoad: true,
      crossOrigin: 'anonymous',
      hfov: 100,
      compass: settings.showCompass,
      northOffset: pic.azimuth,
      showFullscreenCtrl: false,
      showZoomCtrl: !still,
      draggable: !still,
      mouseZoom: !still,
      keyboardZoom: !still,
      disableKeyboardCtrl: still,
    });
  } else {
    $('#px-flat').src = pic.url;
  }

  // Per le foto normali la bussola è una freccia che indica il nord rispetto all'inquadratura
  $('#px-compass').style.display = settings.showCompass && !pic.isPano ? '' : 'none';
  $('#px-compass-needle').style.transform = `rotate(${-pic.azimuth}deg)`;
  $('#px-credit').textContent = `Foto: ${pic.producer || 'anonimo'} · ${pic.license} · Panoramax`;
  $('#px-nav').style.display = settings.moveMode === 'move' ? '' : 'none';
  showNavState(pic);
}

async function panoramaxStep(dir) {
  const g = state.game;
  const href = pxCurrent && pxCurrent[dir];
  if (!g || g.locked || !href) return;
  $('#px-prev').disabled = true;
  $('#px-next').disabled = true;
  try {
    const { res, body } = await fetchJson(href);
    if (!res.ok || !body.geometry) throw new Error('ITEM');
    const pic = panoramaxPicture(body);
    await preloadImage(pic.url, pic.isPano);
    if (state.game === g && !g.locked) showPanoramaxPicture(pic, g.settings);
  } catch {
    // foto vicina non disponibile: resto dove sono, senza quella direzione
    if (pxCurrent) pxCurrent[dir] = null;
    if (pxCurrent) showNavState(pxCurrent);
  }
}

function showNavState(pic) {
  $('#px-prev').disabled = !pic.prev;
  $('#px-next').disabled = !pic.next;
}

const panoramaxSource = {
  name: 'Panoramax',
  needsToken: false,
  boxes: [0.004, 0.015, 0.05, 0.15], // le foto sono più rade: allargo di più la ricerca
  async check() {},
  async search(bbox) {
    const params = new URLSearchParams({ bbox: bbox.map((n) => n.toFixed(6)).join(','), limit: '100' });
    let r;
    try {
      r = await fetchJson(`${PANORAMAX_API}/search?${params}`);
    } catch {
      return [];
    }
    const features = r.res.ok && Array.isArray(r.body.features) ? r.body.features : [];
    return features
      .filter((f) => f.geometry && f.assets)
      .map(panoramaxPicture)
      .filter((p) => p.url && !deadHosts.has(hostOf(p.url)));
  },
  async prepare(pic) {
    try {
      await preloadImage(pic.url, pic.isPano);
    } catch (err) {
      markHostFailure(pic.url, err.message);
      throw err;
    }
  },
  async show(pic, settings) { showPanoramaxPicture(pic, settings); },
  resize() { if (pxViewer) pxViewer.resize(); },
  destroy() {
    if (pxViewer) { pxViewer.destroy(); pxViewer = null; }
    pxCurrent = null;
    $('#px-pano').innerHTML = '';
    $('#px-flat').removeAttribute('src');
  },
};

// ---------- Fonte: Google Street View (incorporamento senza chiave) ----------
// Il riquadro di Google cerca da solo il panorama più vicino, ma solo entro pochi metri.
// Per scegliere punti dove Street View c'è davvero leggo le immagini di copertura di Google
// (le linee blu di Google Maps): ogni pixel colorato è un tratto fotografato.
// Dove non c'è copertura Google restituisce un'immagine vuota di 1×1 pixel.
// La ricerca parte da uno zoom adatto alla grandezza dell'area (il mondo intero sta in pochi riquadri)
// e scende a passi di 3 livelli fino a COVERAGE_MAX_ZOOM, dove un pixel è circa un metro.
const COVERAGE_MAX_ZOOM = 16;
const COVERAGE_STEP = 3;
const LINE_MIN_EXTENT = 24; // pixel: sotto questa lunghezza la macchia blu è una foto isolata, non una strada
const coverageCache = new Map();

function tileOf(lon, lat, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

function tilePixelToLonLat(x, y, px, py, z) {
  const n = 2 ** z;
  const lon = ((x + px / 256) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / 256)) / n))) * 180) / Math.PI;
  return [lon, lat];
}

// Riquadro di copertura (256×256): restituisce i pixel coperti, o null se non c'è copertura
async function coverageTile(x, y, z) {
  const key = `${z}/${x}/${y}`;
  if (coverageCache.has(key)) return coverageCache.get(key);
  const url = `https://mts1.googleapis.com/vt?hl=it&lyrs=svv|cb_client:apiv3&style=40,18&x=${x}&y=${y}&z=${z}`;
  const img = await preloadImage(url, true, 8000);
  let tile = null;
  if (img.width >= 256) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, 256, 256).data;
    const alpha = new Uint8Array(256 * 256);
    const covered = [];
    for (let i = 0; i < 256 * 256; i++) {
      alpha[i] = data[i * 4 + 3];
      // solo i pixel ben coperti: il centro delle linee, non i bordi sfumati
      if (alpha[i] > 128) covered.push(i);
    }
    if (covered.length) tile = { x, y, z, alpha, covered };
  }
  if (coverageCache.size > 300) coverageCache.delete(coverageCache.keys().next().value);
  coverageCache.set(key, tile);
  return tile;
}

const pixelLonLat = (tile, i) => tilePixelToLonLat(tile.x, tile.y, (i % 256) + 0.5, Math.floor(i / 256) + 0.5, tile.z);

// La macchia blu che contiene il pixel è lunga almeno LINE_MIN_EXTENT pixel? (strada, non foto isolata)
function isLineLike(tile, start) {
  const seen = new Set([start]);
  const queue = [start];
  let minX = 255, maxX = 0, minY = 255, maxY = 0;
  while (queue.length && seen.size < 800) {
    const i = queue.pop();
    const px = i % 256, py = Math.floor(i / 256);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    if (maxX - minX >= LINE_MIN_EXTENT || maxY - minY >= LINE_MIN_EXTENT) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || ny < 0 || nx > 255 || ny > 255) return true; // continua nel riquadro accanto
      const j = ny * 256 + nx;
      if (!seen.has(j) && tile.alpha[j] > 0) { seen.add(j); queue.push(j); }
    }
  }
  return seen.size >= 800;
}

function nearestCovered(tile, lon, lat) {
  const n = 2 ** tile.z;
  const rad = (lat * Math.PI) / 180;
  const fx = (((lon + 180) / 360) * n - tile.x) * 256;
  const fy = (((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n - tile.y) * 256;
  let best = tile.covered[0], bestD = Infinity;
  for (const i of tile.covered) {
    const d = ((i % 256) - fx) ** 2 + (Math.floor(i / 256) - fy) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Zoom di partenza: un riquadro grande più o meno quanto l'area
function coverageStartZoom(area) {
  if (area.coverageZoom == null) {
    const [minX, minY, maxX, maxY] = turf.bbox(area.geometry);
    const extent = Math.max(maxX - minX, (maxY - minY) * 1.5, 0.0001);
    area.coverageZoom = Math.max(2, Math.min(COVERAGE_MAX_ZOOM, Math.floor(Math.log2(360 / extent))));
  }
  return area.coverageZoom;
}

// Punti sulla copertura Street View vicino al punto dato, dentro l'area.
// local: il punto è già dove deve essere (centro di un paese): parto dal livello della strada
// e prendo il tratto coperto più vicino, invece di un pixel a caso.
async function coveragePointsNear(lon, lat, area, { local = false, count = 40 } = {}) {
  let z = local ? COVERAGE_MAX_ZOOM : coverageStartZoom(area);
  const start = tileOf(lon, lat, z);
  let tile = await coverageTile(start.x, start.y, z);
  if (!tile) return [];

  // primo passo: un pixel coperto a caso nel riquadro, purché dentro l'area
  let target = local ? pixelLonLat(tile, nearestCovered(tile, lon, lat)) : null;
  for (let k = 0; k < 60 && !target; k++) {
    const p = pixelLonLat(tile, tile.covered[Math.floor(Math.random() * tile.covered.length)]);
    if (pointInArea(p, area)) target = p;
  }
  if (!target) return [];

  // poi scendo di zoom intorno a quel pixel, restando sulla copertura
  while (z < COVERAGE_MAX_ZOOM) {
    z = Math.min(COVERAGE_MAX_ZOOM, z + COVERAGE_STEP);
    const { x, y } = tileOf(target[0], target[1], z);
    tile = await coverageTile(x, y, z);
    if (!tile) return [];
    target = pixelLonLat(tile, nearestCovered(tile, target[0], target[1]));
  }

  // all'ultimo zoom: pixel coperti entro ~60 m dal punto trovato
  const center = nearestCovered(tile, target[0], target[1]);
  const cx = center % 256, cy = Math.floor(center / 256);
  const near = tile.covered.filter((i) => Math.abs((i % 256) - cx) <= 32 && Math.abs(Math.floor(i / 256) - cy) <= 32);
  return shuffle(near).slice(0, count).map((i) => ({ coords: pixelLonLat(tile, i), lineLike: isLineLike(tile, i) }));
}

function streetViewUrl(lon, lat, heading) {
  // Formato di incorporamento storico di Google Maps: non richiede chiave
  const params = new URLSearchParams({
    layer: 'c',
    cbll: `${lat.toFixed(6)},${lon.toFixed(6)}`,
    cbp: `11,${Math.round(heading)},0,0,0`,
    output: 'svembed',
  });
  return `https://maps.google.com/maps?${params}`;
}

const streetViewSource = {
  name: 'Street View',
  needsToken: false,
  async check() {},
  // cerca da sola intorno al punto, scendendo di zoom sulla copertura
  async searchAt(lon, lat, area, opts) {
    let points;
    try {
      points = await coveragePointsNear(lon, lat, area, opts);
    } catch {
      return [];
    }
    return points.map(({ coords, lineLike }) => ({
      id: `${coords[0].toFixed(5)},${coords[1].toFixed(5)}`,
      coords,
      lineLike,
      isPano: true,
    }));
  },
  async prepare() {},
  async show(pic, settings) {
    // La direzione iniziale resta la stessa quando si torna alla partenza
    if (pic.heading == null) pic.heading = Math.random() * 360;
    $('#sv-frame').src = streetViewUrl(pic.coords[0], pic.coords[1], pic.heading);
    $('#sv-block-all').style.display = settings.moveMode === 'nmpz' ? '' : 'none';
  },
  resize() {},
  destroy() {
    $('#sv-frame').src = 'about:blank';
  },
};

const SOURCES = { streetview: streetViewSource, mapillary: mapillarySource, panoramax: panoramaxSource };

// ---------- Filtri sui posti (dati OpenStreetMap da OpenFreeMap) ----------
// Tutti spenti di default: senza filtri si gioca su qualsiasi posto.
const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
const OFM_ZOOM = 14;
const CAR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track']);
const FAST_ROADS = new Set(['motorway', 'trunk']); // autostrade e superstrade
const BUILT_UP = new Set(['residential', 'commercial', 'retail', 'industrial', 'neighbourhood', 'suburb', 'quarter']);
const ROAD_SNAP_M = 25;    // la foto "sta" sulla strada più vicina se è entro questa distanza
const INHABITED_M = 120;   // distanza massima da un edificio per dire che la zona è abitata
let vectorTileLibs = null;
let ofmTilesUrl = null;
const ofmCache = new Map();

function activeFilters(settings, source) {
  return {
    official: settings.filterOfficial && source === streetViewSource,
    noHighways: settings.filterNoHighways,
    noTunnels: settings.filterNoTunnels,
    inhabited: settings.level === 'custom' && settings.zone === 'inhabited',
  };
}

function loadVectorTileLibs() {
  if (!vectorTileLibs) {
    vectorTileLibs = Promise.all([
      import('https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm'),
      import('https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm'),
    ]).then(([vt, pbf]) => ({ VectorTile: vt.VectorTile, Pbf: pbf.default }));
    vectorTileLibs.catch(() => { vectorTileLibs = null; });
  }
  return vectorTileLibs;
}

// Riquadro di mappa vettoriale OpenFreeMap. Restituisce una funzione che estrae un livello
// (strade, edifici, etichette…) come oggetti GeoJSON in lon/lat.
function ofmTile(x, y, z) {
  const key = `${z}/${x}/${y}`;
  if (!ofmCache.has(key)) {
    const load = (async () => {
      const { VectorTile, Pbf } = await loadVectorTileLibs();
      if (!ofmTilesUrl) {
        const { res, body } = await fetchJson(OFM_TILEJSON);
        if (!res.ok || !body.tiles) throw new Error('TILES');
        ofmTilesUrl = body.tiles[0];
      }
      const url = ofmTilesUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      let buf;
      try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) throw new Error('TILE');
        buf = await res.arrayBuffer();
      } finally {
        clearTimeout(timer);
      }
      const vt = new VectorTile(new Pbf(buf));
      return (name, keep) => {
        const layer = vt.layers[name];
        const out = [];
        if (!layer) return out;
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          if (!keep || keep(f.properties)) out.push(f.toGeoJSON(x, y, z));
        }
        return out;
      };
    })();
    load.catch(() => ofmCache.delete(key));
    if (ofmCache.size > 80) ofmCache.delete(ofmCache.keys().next().value);
    ofmCache.set(key, load);
  }
  return ofmCache.get(key);
}

// Strade, edifici e zone urbane del riquadro di mappa che contiene il punto
const ofmFeatureCache = new Map();
async function ofmFeatures(lon, lat) {
  const { x, y } = tileOf(lon, lat, OFM_ZOOM);
  const key = `${x}/${y}`;
  if (!ofmFeatureCache.has(key)) {
    const geo = await ofmTile(x, y, OFM_ZOOM);
    if (ofmFeatureCache.size > 60) ofmFeatureCache.delete(ofmFeatureCache.keys().next().value);
    ofmFeatureCache.set(key, {
      roads: geo('transportation', (p) => CAR_ROADS.has(p.class)),
      buildings: geo('building'),
      builtUp: geo('landuse', (p) => BUILT_UP.has(p.class)),
      pois: geo('poi'), // negozi, bar, chiese, uffici…: gli "indizi" per la difficoltà
    });
  }
  return ofmFeatureCache.get(key);
}

// ---------- Zona dei posti ----------
// "Ovunque" e "Zone abitate" partono da un punto a caso nell'area; "Centri" e "Centro principale"
// partono dal centro di una città o di un paese e cercano la foto entro pochi minuti a piedi.
const PLACE_WEIGHTS = { city: 8, town: 4, village: 1 }; // le città escono più spesso dei paesini
const PLACE_RADIUS_M = { city: 1500, town: 700, village: 350 };
// Aree che hanno un "loro" centro (il municipio, la piazza): per regioni e nazioni uso le città
const MUNICIPAL_KINDS = new Set(['city', 'town', 'village', 'municipality', 'hamlet', 'suburb',
  'quarter', 'neighbourhood', 'city_district', 'borough', 'isolated_dwelling']);

// Città e paesi (dalle etichette della mappa) nel riquadro di zoom z che contiene il punto
async function placesNear(lon, lat, z) {
  const { x, y } = tileOf(lon, lat, z);
  const geo = await ofmTile(x, y, z);
  return geo('place', (p) => p.class in PLACE_WEIGHTS)
    .filter((f) => f.geometry.type === 'Point')
    .map((f) => ({ coords: f.geometry.coordinates, cls: f.properties.class, name: f.properties.name }));
}

function randomPointInDisk([lon, lat], radiusM) {
  const r = radiusM * Math.sqrt(Math.random());
  const a = Math.random() * 2 * Math.PI;
  const dLat = (r * Math.sin(a)) / 110540;
  const dLon = (r * Math.cos(a)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lon + dLon, lat + dLat];
}

// Il centro intorno a cui cercare il posto, o null se nella zona non ce n'è uno adatto
async function pickCenter(area, zone) {
  if (zone === 'main' && area.center && MUNICIPAL_KINDS.has(area.kind)) {
    return { coords: area.center, radius: PLACE_RADIUS_M[area.kind] || PLACE_RADIUS_M.town };
  }
  // riquadro di ~8 km per i comuni, ~35 km per regioni, nazioni e continenti
  const z = Math.max(10, Math.min(12, coverageStartZoom(area)));
  const [lon, lat] = randomPointInArea(area);
  const places = (await placesNear(lon, lat, z)).filter((p) => pointInArea(p.coords, area));
  let pool = places;
  if (zone === 'main') {
    // per regioni e nazioni il "centro principale" sono le città; se qui non ce ne sono, i paesi più grandi
    pool = places.filter((p) => p.cls === 'city');
    if (!pool.length) pool = places.filter((p) => p.cls === 'town');
  }
  if (!pool.length) return null;
  const p = weightedPick(pool, (q) => PLACE_WEIGHTS[q.cls]);
  return { coords: p.coords, radius: PLACE_RADIUS_M[p.cls] };
}

// Distanza in metri tra il punto p e il segmento a-b (approssimazione locale, va bene sotto il km)
function distToSegment(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180) * 111320;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * 110540;
  const bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * 110540;
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function linesOf(geometry) {
  switch (geometry.type) {
    case 'LineString': return [geometry.coordinates];
    case 'MultiLineString': return geometry.coordinates;
    case 'Polygon': return geometry.coordinates;
    case 'MultiPolygon': return geometry.coordinates.flat();
    default: return [];
  }
}

function nearestRoad(p, roads) {
  let best = null;
  for (const f of roads) {
    for (const line of linesOf(f.geometry)) {
      for (let j = 1; j < line.length; j++) {
        const d = distToSegment(p, line[j - 1], line[j]);
        if (!best || d < best.dist) best = { dist: d, class: f.properties.class, brunnel: f.properties.brunnel };
      }
    }
  }
  return best;
}

function isInhabited(p, data) {
  for (const f of data.builtUp) {
    if (/Polygon/.test(f.geometry.type) && turf.booleanPointInPolygon(p, f)) return true;
  }
  for (const f of data.buildings) {
    for (const line of linesOf(f.geometry)) {
      for (const v of line) if (distToSegment(p, v, v) <= INHABITED_M) return true;
    }
  }
  return false;
}

async function passesFilters(pic, settings, source) {
  const f = activeFilters(settings, source);
  if (!f.official && !f.noHighways && !f.noTunnels && !f.inhabited) return true;
  // Le foto degli utenti sono puntini blu isolati, le auto di Google tracciano linee lungo le strade
  if (f.official && pic.lineLike === false) return false;

  const data = await ofmFeatures(pic.coords[0], pic.coords[1]);
  const road = nearestRoad(pic.coords, data.roads);
  const onRoad = road && road.dist <= ROAD_SNAP_M;
  if (f.official && !onRoad) return false;
  if (f.noHighways && onRoad && FAST_ROADS.has(road.class)) return false;
  if (f.noTunnels && onRoad && road.brunnel === 'tunnel') return false;
  if (f.inhabited && !isInhabited(pic.coords, data)) return false;
  return true;
}

// ---------- Difficoltà: punteggio del posto ----------
// Ogni posto riceve un punteggio da 0 (difficile) a 10 (facile) sommando quattro criteri:
//   notorietà  0–3  quanto si scrive dei dintorni: KB totali degli articoli di Wikipedia inglese entro 500 m
//                   (Times Square ~6.700, Colosseo ~560, centro di Livorno ~150, periferie e paesini ~0).
//                   Le letture giornaliere sarebbero più adatte, ma Wikipedia le dà solo per poche pagine a richiesta.
//   grandezza  0–3  città 3, paese 2, villaggio 1 (se il posto è dentro il centro abitato)
//   indizi     0–3  negozi, bar, chiese, uffici… entro 150 m (OpenStreetMap)
//   strada     0–1  sta su una strada principale
// e ogni livello accetta una fascia di punteggio.
const FAME_RADIUS_M = 500;
const CLUES_RADIUS_M = 150;
const MAIN_ROADS = new Set(['trunk', 'primary', 'secondary', 'tertiary']);
const PLACE_SIZE = { city: 3, town: 2, village: 1 };
const fameCache = new Map();

const LEVEL_HINTS = {
  all: 'Qualsiasi posto con Street View, anche campagna, montagna e autostrade.',
  easy: 'Centri di città con negozi e strade principali, spesso vicino a luoghi noti.',
  medium: 'Centri di paesi e città con qualche indizio, ma non i posti famosi.',
  hard: 'Frazioni, periferie e paesini con pochi indizi e niente di noto nei dintorni.',
  custom: 'Scegli tu la zona qui sotto; i filtri si applicano come al solito.',
};

// relax (0–2) allarga la fascia dopo vari tentativi falliti: in un paese piccolo nessun posto
// è famoso, quindi "Facile" deve accontentarsi di un punteggio più basso.
const LEVELS = {
  easy: (s, relax = 0) => s.punteggio >= 6 - relax,
  medium: (s) => s.punteggio >= 3 && s.punteggio <= 5 && s.notorieta <= 1, // niente posti famosi
  hard: (s, relax = 0) => s.punteggio <= 2 + relax && s.abitato, // periferie e frazioni, non campagna aperta
};

// Articoli di Wikipedia inglese entro radius metri, con la lunghezza in KB
async function wikiArticlesNear([lon, lat], radius, limit = 100) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'geosearch',
    ggscoord: `${lat.toFixed(5)}|${lon.toFixed(5)}`, ggsradius: String(radius), ggslimit: String(limit),
    prop: 'info|coordinates', colimit: 'max',
  });
  const { res, body } = await fetchJson(`https://en.wikipedia.org/w/api.php?${params}`, 10000);
  if (!res.ok) throw new Error('WIKI');
  return Object.values((body.query && body.query.pages) || {}).map((p) => ({
    title: p.title,
    kb: (p.length || 0) / 1000,
    coords: p.coordinates ? [p.coordinates[0].lon, p.coordinates[0].lat] : null,
  }));
}

// KB totali degli articoli vicini al punto; null se Wikipedia non risponde
async function fameAt(p) {
  const key = `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  if (!fameCache.has(key)) {
    const load = wikiArticlesNear(p, FAME_RADIUS_M)
      .then((articles) => Math.round(articles.reduce((s, a) => s + a.kb, 0)))
      .catch(() => null);
    if (fameCache.size > 300) fameCache.delete(fameCache.keys().next().value);
    fameCache.set(key, load);
  }
  return fameCache.get(key);
}

async function placeScore(p) {
  const [kb, data, places] = await Promise.all([
    fameAt(p),
    ofmFeatures(p[0], p[1]),
    placesNear(p[0], p[1], 12).catch(() => []),
  ]);
  // Wikipedia non risponde: notorietà "media", per non bloccare il gioco
  const notorieta = kb == null ? 1 : kb >= 400 ? 3 : kb >= 100 ? 2 : kb >= 15 ? 1 : 0;
  const grandezza = places.reduce((best, pl) =>
    (haversine(p, pl.coords) <= PLACE_RADIUS_M[pl.cls] ? Math.max(best, PLACE_SIZE[pl.cls]) : best), 0);
  let negozi = 0;
  for (const f of data.pois) {
    if (f.geometry.type === 'Point' && distToSegment(p, f.geometry.coordinates, f.geometry.coordinates) <= CLUES_RADIUS_M) negozi++;
  }
  const indizi = negozi >= 10 ? 3 : negozi >= 4 ? 2 : negozi >= 1 ? 1 : 0;
  const road = nearestRoad(p, data.roads);
  const strada = road && road.dist <= ROAD_SNAP_M && MAIN_ROADS.has(road.class) ? 1 : 0;
  return {
    punteggio: notorieta + grandezza + indizi + strada,
    notorieta, grandezza, indizi, strada,
    kbWikipedia: kb, attivitaVicine: negozi,
    abitato: isInhabited(p, data),
  };
}

// Da dove partire per ogni livello: { start, center } (center limita quanto ci si allontana)
async function levelStart(area, level) {
  if (level === 'easy') {
    // più spesso: vicino a un articolo di Wikipedia molto letto, nei dintorni di una città
    // ("main": le città per regioni e nazioni, il centro del paese per un comune; i paesini non hanno luoghi famosi)
    const place = await pickCenter(area, 'main').catch(() => null);
    if (place && Math.random() < 0.7) {
      // gli articoli lunghi sono i luoghi di cui si parla di più (monumenti, piazze, quartieri noti)
      const famous = (await wikiArticlesNear(place.coords, 10000, 500).catch(() => []))
        .filter((a) => a.coords && a.kb >= 20 && pointInArea(a.coords, area));
      if (famous.length) {
        const a = weightedPick(famous, (x) => x.kb);
        return { start: a.coords, center: { coords: a.coords, radius: 250 } };
      }
    }
    const main = await pickCenter(area, 'main').catch(() => null);
    if (main) return { start: randomPointInDisk(main.coords, main.radius), center: main };
    return { start: randomPointInArea(area), center: null };
  }
  if (level === 'medium') {
    const place = await pickCenter(area, 'cities').catch(() => null);
    if (place) return { start: randomPointInDisk(place.coords, place.radius), center: place };
    return { start: randomPointInArea(area), center: null };
  }
  // difficile: metà delle volte un punto a caso, metà nei dintorni di un paese o di un villaggio
  if (Math.random() < 0.5) {
    const place = await pickCenter(area, 'cities').catch(() => null);
    if (place) {
      const ring = { coords: place.coords, radius: 1500 };
      return { start: randomPointInDisk(place.coords, ring.radius), center: ring };
    }
  }
  return { start: randomPointInArea(area), center: null };
}

// ---------- Ricerca di un posto ----------
const PARALLEL = 4;   // punti cercati contemporaneamente
const BATCHES = 8;    // tentativi prima di arrendersi

async function tryRandomPoint(source, prepared, settings, usedIds, relax = 0) {
  const area = settings.weighting === 'equal'
    ? prepared[Math.floor(Math.random() * prepared.length)]
    : weightedPick(prepared, (a) => a.totalArea);

  const level = settings.level || 'all';
  const accepts = LEVELS[level];
  let center = null;
  let start = null;
  if (level === 'custom' && (settings.zone === 'cities' || settings.zone === 'main')) {
    // Zona a mano: centri di città e paesi, parto vicino al centro e non mi allontano troppo
    center = await pickCenter(area, settings.zone);
    if (!center) throw new Error('NOT_FOUND');
  } else if (accepts) {
    ({ start, center } = await levelStart(area, level));
  }
  if (!start) start = center ? randomPointInDisk(center.coords, center.radius) : randomPointInArea(area);
  const [lon, lat] = start;
  const nearCenter = (p) => !center || haversine(p.coords, center.coords) <= center.radius * 1.25;

  // searchAt: la fonte cerca da sola intorno al punto (Street View); search: dentro bbox sempre più grandi
  const searches = source.searchAt
    ? [() => source.searchAt(lon, lat, area, { local: !!center })]
    : source.boxes.map((h) => () => source.search([lon - h, lat - h, lon + h, lat + h], settings));

  for (const search of searches) {
    const found = await search();
    const candidates = shuffle(found.filter((p) =>
      !usedIds.has(p.id) &&
      (!settings.panoOnly || p.isPano) &&
      pointInArea(p.coords, area) &&
      nearCenter(p)));

    let prepared = 0;
    for (const pic of candidates.slice(0, 12)) {
      try {
        if (!(await passesFilters(pic, settings, source))) continue;
      } catch {
        continue; // dati dei filtri non disponibili per questo punto
      }
      if (accepts) {
        // i candidati di un tentativo sono tutti vicini: se il primo non è nella fascia, cambio zona
        let score;
        try { score = await placeScore(pic.coords); } catch { break; }
        // in un comune non c'è quasi mai un posto famoso: "Facile" parte già un punto più in basso
        const startRelax = level === 'easy' && MUNICIPAL_KINDS.has(area.kind) ? 1 : 0;
        if (!accepts(score, Math.min(2, relax + startRelax))) break;
        pic.difficulty = score;
      }
      try {
        await source.prepare(pic);
        return { ...pic, areaName: area.name };
      } catch {
        // foto non scaricabile: provo la prossima, ma non all'infinito
        if (++prepared >= 3) break;
      }
    }
  }
  throw new Error('NOT_FOUND');
}

async function findLocation(source, prepared, settings, usedIds, onProgress) {
  for (let batch = 0; batch < BATCHES; batch++) {
    if (onProgress) onProgress(batch + 1, BATCHES);
    // ogni 3 giri a vuoto la fascia di difficoltà si allarga di un punto (al massimo 2)
    const relax = Math.min(2, Math.floor(batch / 3));
    const tries = Array.from({ length: PARALLEL }, () => tryRandomPoint(source, prepared, settings, usedIds, relax));
    try {
      return await Promise.any(tries);
    } catch (err) {
      if (err.errors.some((e) => e.message === 'TOKEN')) throw new Error('TOKEN');
    }
  }
  // Rete di sicurezza: se la fascia di difficoltà non dà risultati, meglio un posto qualsiasi
  // della zona che interrompere la partita. Il posto resta segnato nei registri delle segnalazioni.
  if (LEVELS[settings.level]) {
    diag(`difficoltà "${settings.level}": nessun posto nella fascia, uso un posto qualsiasi`);
    const anySettings = { ...settings, level: 'all' };
    for (let batch = 0; batch < 2; batch++) {
      const tries = Array.from({ length: PARALLEL }, () => tryRandomPoint(source, prepared, anySettings, usedIds));
      try {
        return { ...(await Promise.any(tries)), levelFallback: true };
      } catch {
        // si riprova una volta, poi errore
      }
    }
  }
  throw new Error(deadHosts.size ? 'SERVERS_DOWN' : 'NOT_FOUND');
}

function locationError(code, source) {
  switch (code) {
    case 'TOKEN':
      return 'Mapillary ha rifiutato il token: controlla di aver copiato il "Client Token" (inizia con MLY|).';
    case 'EMPTY_APP':
      return 'Il token è valido, ma Mapillary non restituisce nessuna foto, nemmeno alla Tour Eiffel. ' +
        'È un problema noto di alcune app Mapillary appena create: registra una nuova applicazione ' +
        'su mapillary.com/dashboard/developers con il solo permesso "Read" e usa il suo Client Token, ' +
        'oppure scegli Panoramax come fonte delle foto.';
    case 'SERVERS_DOWN':
      return `Non ho trovato foto utilizzabili in quest'area: alcuni server ${source.name} non rispondono ` +
        `(${[...deadHosts].join(', ')}). Riprova più tardi, scegli un'area più grande o un'altra fonte.`;
    default:
      return `Non ho trovato foto ${source.name} in quest'area. Prova un'area più grande, aggiungine altre, ` +
        'disattiva "Solo foto a 360°" o scegli una difficoltà più alta (meno vincoli su dove cadono i posti).';
  }
}

// ---------- Mappe Leaflet ----------
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function makeMap(el, options = {}) {
  const map = L.map(el, { worldCopyJump: true, ...options });
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
  return map;
}

function pinIcon(kind, label = '') {
  return L.divIcon({
    className: '',
    html: `<div class="pin ${kind}${label ? ' pin-num' : ''}">${label}</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

const latLng = ([lon, lat]) => [lat, lon];
const borderStyle = { color: '#e0900b', weight: 3, fillOpacity: 0.06 };
const lineStyle = { color: '#1f2937', dashArray: '8 6', weight: 3 };

// Inquadra i punti lasciando libera la parte coperta dal riquadro in basso
function fitAboveCard(map, points, cardSel, maxZoom) {
  const cardH = document.querySelector(cardSel).offsetHeight;
  map.fitBounds(points, { paddingTopLeft: [50, 50], paddingBottomRight: [50, cardH + 50], maxZoom });
}

// ---------- Schermate ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

// ---------- Setup ----------
let previewMap, previewLayer;

function renderSetup() {
  document.querySelectorAll('[data-key]').forEach((el) => {
    const v = state.settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
  $('#token-input').value = state.token;
  renderAreas();
  updateHints();
}

function readSettings() {
  const s = { ...state.settings };
  document.querySelectorAll('[data-key]').forEach((el) => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') s[k] = el.checked;
    else if (el.type === 'number') s[k] = Number(el.value) || DEFAULTS[k];
    else s[k] = el.value || DEFAULTS[k];
  });
  s.rounds = Math.max(1, Math.min(50, Math.round(s.rounds)));
  s.timeLimit = Math.max(0, Math.round(Number(document.querySelector('[data-key="timeLimit"]').value) || 0));
  return s;
}

function updateHints() {
  const s = readSettings();
  state.settings = s;
  store.set('dovesono.settings', s);
  $('#tolerance-km-row').style.display = s.tolerance === 'manual' ? '' : 'none';
  $('#token-section').style.display = s.source === 'mapillary' ? '' : 'none';
  const notes = [];
  if (s.source === 'streetview') {
    if (s.moveMode === 'pan') notes.push('Con Street View non si può impedire di spostarsi: "Fermo" funziona come "Libero".');
    if (!s.showCompass) notes.push('Con Street View la bussola di Google resta sempre visibile.');
    if (s.panoOnly) notes.push('Le foto di Street View sono già tutte a 360°.');
  } else if (s.filterOfficial) {
    notes.push('"Solo foto delle auto Google" vale solo con Street View.');
  }
  if (s.level === 'custom' && s.zone === 'main' && state.areas.some((a) => !MUNICIPAL_KINDS.has(a.kind))) {
    notes.push('Per regioni, nazioni e continenti il "centro principale" sono i centri delle città.');
  }
  $('#source-hint').textContent = notes.join(' ');

  // La Zona si sceglie a mano solo con la difficoltà "Personalizzata"
  $('#zone-row').hidden = s.level !== 'custom';
  $('#level-hint').textContent = LEVEL_HINTS[s.level] || '';
  if (!state.areas.length) {
    $('#score-hint').textContent = 'Aggiungi almeno un\'area per vedere come verrà calcolato il punteggio.';
    return;
  }
  const half = halfPointsDistance(s, state.areas);
  $('#score-hint').textContent =
    `Con queste regole: ${s.maxPoints.toLocaleString('it-IT')} punti entro 25 m, ` +
    `metà dei punti a ${formatDistance(half)}, un quarto a ${formatDistance(half * 2)}.`;
}

function renderAreas() {
  const chips = $('#chips');
  chips.innerHTML = '';
  if (!state.areas.length) {
    chips.innerHTML = '<span class="empty">Nessuna area scelta: cerca qui sopra e clicca un risultato.</span>';
  }
  state.areas.forEach((a) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = a.name;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Rimuovi';
    x.onclick = () => {
      state.areas = state.areas.filter((b) => b.id !== a.id);
      saveAreas();
      renderAreas();
      updateHints();
    };
    chip.appendChild(x);
    chips.appendChild(chip);
  });

  previewLayer.clearLayers();
  state.areas.forEach((a) => L.geoJSON(a.geometry, { style: borderStyle }).addTo(previewLayer));
  if (state.areas.length) {
    const [minX, minY, maxX, maxY] = areasBbox(state.areas);
    previewMap.fitBounds([[minY, minX], [maxY, maxX]], { padding: [20, 20] });
  }
}

function saveAreas() {
  store.set('dovesono.areas', state.areas);
}

const KIND_LABELS = {
  country: 'nazione', state: 'regione', region: 'regione', province: 'provincia', county: 'provincia',
  city: 'città', town: 'comune', village: 'paese', municipality: 'comune', hamlet: 'frazione',
  suburb: 'quartiere', quarter: 'quartiere', neighbourhood: 'quartiere', island: 'isola',
  continent: 'continente', city_district: 'quartiere', borough: 'municipio', administrative: 'area',
};

// ---------- Continenti e mondo intero ----------
// OpenStreetMap non ha i continenti come aree: uso i confini dei paesi di Natural Earth
// (scala 1:110 milioni, ~800 KB), raggruppati per continente. Si scaricano solo quando servono.
const NATURAL_EARTH_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_110m_admin_0_countries.geojson';
// Natural Earth mette tutta la Russia (e la Guyana francese, con la Francia) in Europa:
// taglio l'Europa agli Urali e all'Atlantico e aggiungo all'Asia la Russia a est degli Urali.
const URALS_LON = 60;
const PRESETS = {
  world: { name: 'Mondo intero', kind: 'mondo', continents: ['Europe', 'Asia', 'Africa', 'North America', 'South America', 'Oceania'] },
  europe: { name: 'Europa', kind: 'continente', continents: ['Europe'], clip: [-32, 27, URALS_LON, 82] },
  asia: { name: 'Asia', kind: 'continente', continents: ['Asia'], extra: [{ iso: 'RU', clip: [URALS_LON, -90, 180, 90] }] },
  africa: { name: 'Africa', kind: 'continente', continents: ['Africa'] },
  northAmerica: { name: 'Nord America', kind: 'continente', continents: ['North America'] },
  southAmerica: { name: 'Sud America', kind: 'continente', continents: ['South America'] },
  oceania: { name: 'Oceania', kind: 'continente', continents: ['Oceania'] },
};
let naturalEarth = null;

function loadNaturalEarth() {
  if (!naturalEarth) {
    naturalEarth = fetchJson(NATURAL_EARTH_URL, 30000).then(({ res, body }) => {
      if (!res.ok || !Array.isArray(body.features)) throw new Error('NATURAL_EARTH');
      return body.features;
    });
    naturalEarth.catch(() => { naturalEarth = null; });
  }
  return naturalEarth;
}

async function addPreset(key) {
  const id = `preset-${key}`;
  if (!PRESETS[key] || state.areas.some((a) => a.id === id)) return;
  state.areas.push(await buildPresetArea(key));
  saveAreas();
  renderAreas();
  updateHints();
}

async function buildPresetArea(key) {
  const preset = PRESETS[key];
  const id = `preset-${key}`;
  const features = await loadNaturalEarth();
  const round = (ring) => ring.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  const polygons = [];
  const addPolygon = (rings, clip) => {
    if (clip) {
      rings = turf.bboxClip(turf.polygon(rings), clip).geometry.coordinates.filter((r) => r.length >= 4);
      if (!rings.length) return;
    }
    polygons.push(rings.map(round));
  };
  const addFeature = ({ geometry: g }, clip) => {
    if (g.type === 'Polygon') addPolygon(g.coordinates, clip);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => addPolygon(p, clip));
  };
  features
    .filter((f) => preset.continents.includes(f.properties.CONTINENT))
    .forEach((f) => addFeature(f, preset.clip));
  (preset.extra || []).forEach(({ iso, clip }) => {
    features.filter((f) => f.properties.ISO_A2 === iso).forEach((f) => addFeature(f, clip));
  });
  return { id, name: preset.name, kind: preset.kind, geometry: { type: 'MultiPolygon', coordinates: polygons } };
}

// Area di gioco da un risultato di Nominatim (ricerca o lookup)
function areaFromNominatim(it) {
  return {
    id: `${it.osm_type}${it.osm_id}`,
    name: it.name || it.display_name.split(',')[0],
    kind: it.addresstype,
    center: [Number(it.lon), Number(it.lat)], // per un comune: il centro del paese
    geometry: it.geojson,
  };
}

async function searchPlaces(query) {
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', polygon_geojson: '1', polygon_threshold: '0.003',
    limit: '10', 'accept-language': 'it',
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error('Ricerca non riuscita');
  const data = await res.json();
  return data.filter((d) => d.geojson && /Polygon/.test(d.geojson.type));
}

function renderResults(items, message) {
  const ul = $('#search-results');
  ul.innerHTML = '';
  if (message) {
    const li = document.createElement('li');
    li.className = 'msg';
    li.textContent = message;
    ul.appendChild(li);
    return;
  }
  items.forEach((it) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = it.display_name;
    const kind = document.createElement('small');
    kind.textContent = KIND_LABELS[it.addresstype] || it.addresstype || it.type || '';
    li.append(name, kind);
    li.onclick = () => {
      const area = areaFromNominatim(it);
      if (!state.areas.some((a) => a.id === area.id)) {
        state.areas.push(area);
        saveAreas();
      }
      ul.innerHTML = '';
      $('#search-input').value = '';
      renderAreas();
      updateHints();
    };
    ul.appendChild(li);
  });
}

// ---------- Le mie liste ----------
// Una lista è un nome più i codici delle aree: "R12345" (relazione OSM, anche W/N) o "preset:europe".
// Niente confini: al caricamento si riscaricano (Nominatim lookup, Natural Earth). Le liste restano
// in questo browser; si condividono solo come file o come link, quindi non c'è nessun elenco pubblico.
const LISTS_KEY = 'dovesono.lists';
const LIST_FILE_FORMAT = 'dove-sono-lista';
const MAX_LIST_NAME = 60;
const MAX_LIST_AREAS = 50; // limite di una richiesta di lookup di Nominatim

const cleanListName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LIST_NAME);

function areaRef(area) {
  if (area.id.startsWith('preset-')) return `preset:${area.id.slice(7)}`;
  const m = /^(relation|way|node)(\d+)$/.exec(area.id);
  return m ? m[1][0].toUpperCase() + m[2] : null;
}

const validRef = (ref) => /^[RWN]\d{1,12}$/.test(ref) || (/^preset:\w+$/.test(ref) && ref.slice(7) in PRESETS);

function loadLists() {
  const lists = store.get(LISTS_KEY, []);
  return Array.isArray(lists) ? lists.filter((l) => l && cleanListName(l.name) && Array.isArray(l.refs)) : [];
}

function saveLists(lists) {
  store.set(LISTS_KEY, lists);
}

// Riscarica le aree di una lista. Restituisce { areas, missing } (missing = codici non trovati).
async function resolveRefs(refs) {
  const wanted = refs.filter(validRef).slice(0, MAX_LIST_AREAS);
  const osm = wanted.filter((r) => !r.startsWith('preset:'));
  const found = new Map();
  if (osm.length) {
    const params = new URLSearchParams({
      osm_ids: osm.join(','), format: 'jsonv2', polygon_geojson: '1', polygon_threshold: '0.003', 'accept-language': 'it',
    });
    const { res, body } = await fetchJson(`https://nominatim.openstreetmap.org/lookup?${params}`, 20000);
    if (!res.ok || !Array.isArray(body)) throw new Error('LOOKUP');
    body
      .filter((it) => it.geojson && /Polygon/.test(it.geojson.type))
      .forEach((it) => { const a = areaFromNominatim(it); found.set(areaRef(a), a); });
  }
  for (const ref of wanted.filter((r) => r.startsWith('preset:'))) {
    found.set(ref, await buildPresetArea(ref.slice(7)));
  }
  return {
    areas: wanted.filter((r) => found.has(r)).map((r) => found.get(r)),
    missing: refs.length - wanted.filter((r) => found.has(r)).length,
  };
}

function listsMessage(msg) {
  $('#lists-msg').textContent = msg;
}

// Sostituisce le aree scelte con quelle della lista
async function applyList(name, refs) {
  listsMessage(`Carico "${name}"…`);
  let result;
  try {
    result = await resolveRefs(refs);
  } catch {
    listsMessage(`Non riesco a caricare "${name}": controlla la connessione e riprova.`);
    return false;
  }
  if (!result.areas.length) {
    listsMessage(`Nessuna area di "${name}" è stata trovata.`);
    return false;
  }
  state.areas = result.areas;
  saveAreas();
  renderAreas();
  updateHints();
  listsMessage(`Caricata "${name}": ${result.areas.length} ${result.areas.length === 1 ? 'area' : 'aree'}` +
    (result.missing ? ` (${result.missing} non trovate).` : '.'));
  return true;
}

function saveCurrentAsList() {
  const name = cleanListName($('#list-name').value);
  if (!name) { listsMessage('Scrivi un nome per la lista.'); $('#list-name').focus(); return; }
  const refs = state.areas.map(areaRef).filter(Boolean);
  if (!refs.length) { listsMessage('Scegli prima almeno un\'area.'); return; }
  if (refs.length > MAX_LIST_AREAS) { listsMessage(`Una lista può avere al massimo ${MAX_LIST_AREAS} aree.`); return; }
  const lists = loadLists();
  const existing = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.refs = refs;
  else lists.push({ name, refs });
  saveLists(lists);
  $('#list-name').value = '';
  renderLists();
  listsMessage(existing ? `Lista "${name}" aggiornata.` : `Lista "${name}" salvata.`);
}

function shareLink(list) {
  const params = new URLSearchParams({ lista: list.name, aree: list.refs.join(',') });
  return `${location.origin}${location.pathname}?${params}`;
}

async function copyShareLink(list) {
  const link = shareLink(list);
  try {
    await navigator.clipboard.writeText(link);
    listsMessage(`Link di "${list.name}" copiato: incollalo dove vuoi per condividere la lista.`);
  } catch {
    // appunti non disponibili: mostro il link da copiare a mano
    $('#list-link').value = link;
    $('#list-link').hidden = false;
    $('#list-link').select();
    listsMessage(`Copia il link di "${list.name}":`);
  }
}

function exportList(list) {
  const data = { formato: LIST_FILE_FORMAT, versione: 1, nome: list.name, aree: list.refs };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${list.name.replace(/[^\w\- àèéìòù]/gi, '').trim() || 'lista'}.dovesono.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  listsMessage(`File di "${list.name}" scaricato.`);
}

// Aggiunge (o aggiorna) una lista arrivata da file o link e la carica
async function addIncomingList(name, refs) {
  name = cleanListName(name) || 'Lista condivisa';
  refs = (Array.isArray(refs) ? refs : []).map(String).filter(validRef).slice(0, MAX_LIST_AREAS);
  if (!refs.length) { listsMessage('La lista non contiene aree valide.'); return; }
  if (!(await applyList(name, refs))) return;
  const lists = loadLists();
  const existing = lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.refs = refs;
  else lists.push({ name, refs });
  saveLists(lists);
  renderLists();
}

async function importListFile(file) {
  let data;
  try {
    if (file.size > 100000) throw new Error('SIZE');
    data = JSON.parse(await file.text());
    if (data.formato !== LIST_FILE_FORMAT) throw new Error('FORMAT');
  } catch {
    listsMessage('Questo file non è una lista di Dove Sono?.');
    return;
  }
  await addIncomingList(data.nome, data.aree);
}

// Link condiviso: ?lista=Nome&aree=R1,R2,preset:europe
async function handleSharedLink() {
  const params = new URLSearchParams(location.search);
  if (!params.has('aree')) return;
  const refs = params.get('aree').split(',');
  const name = params.get('lista');
  history.replaceState(null, '', location.pathname); // il link non resta nella barra degli indirizzi
  await addIncomingList(name, refs);
}

let listDeleteArmed = null;
function renderLists() {
  const ul = $('#lists');
  ul.innerHTML = '';
  const lists = loadLists();
  $('#lists-empty').hidden = lists.length > 0;
  lists.forEach((list, i) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'list-name';
    name.textContent = list.name;
    const count = document.createElement('small');
    count.textContent = `${list.refs.length} ${list.refs.length === 1 ? 'area' : 'aree'}`;
    name.appendChild(count);
    const actions = document.createElement('span');
    actions.className = 'list-actions';
    const button = (label, title, onClick, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      if (cls) b.className = cls;
      b.onclick = onClick;
      actions.appendChild(b);
      return b;
    };
    button('Carica', 'Sostituisce le aree scelte con quelle della lista', () => applyList(list.name, list.refs), 'primary');
    button('Link', 'Copia un link che apre il gioco con questa lista', () => copyShareLink(list));
    button('File', 'Scarica la lista come file da passare ad altri', () => exportList(list));
    const del = button(listDeleteArmed === i ? 'Sicuro?' : '✕', 'Elimina la lista', () => {
      if (listDeleteArmed !== i) { listDeleteArmed = i; renderLists(); setTimeout(() => { if (listDeleteArmed === i) { listDeleteArmed = null; renderLists(); } }, 3000); return; }
      listDeleteArmed = null;
      saveLists(loadLists().filter((_, j) => j !== i));
      renderLists();
      listsMessage(`Lista "${list.name}" eliminata.`);
    }, listDeleteArmed === i ? 'danger' : '');
    del.setAttribute('aria-label', `Elimina la lista ${list.name}`);
    li.append(name, actions);
    ul.appendChild(li);
  });
}

function initLists() {
  $('#list-save-form').addEventListener('submit', (e) => { e.preventDefault(); saveCurrentAsList(); });
  $('#list-import').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importListFile(file);
  });
  renderLists();
  handleSharedLink();
}

function initSetup() {
  previewMap = makeMap('preview-map').setView([42.5, 12.5], 5);
  previewLayer = L.layerGroup().addTo(previewMap);

  $('#search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim();
    if (!q) return;
    renderResults([], 'Cerco…');
    try {
      const items = await searchPlaces(q);
      if (items.length) renderResults(items);
      else renderResults([], 'Nessuna area trovata con un confine. Prova un nome diverso (es. "Comune di …", "Provincia di …").');
    } catch {
      renderResults([], 'Errore di rete durante la ricerca. Riprova tra qualche secondo.');
    }
  });

  document.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', async () => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Carico…';
    try {
      await addPreset(btn.dataset.preset);
    } catch {
      renderResults([], 'Non riesco a scaricare i confini dei continenti. Riprova tra qualche secondo.');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }));

  document.querySelectorAll('[data-key]').forEach((el) => el.addEventListener('change', updateHints));
  $('#difficulty').addEventListener('change', (e) => {
    const preset = LEVEL_FILTERS[e.target.value];
    if (!preset) return;
    Object.entries(preset).forEach(([key, value]) => {
      const el = document.querySelector(`[data-key="${key}"]`);
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    });
    updateHints();
  });
  $('#token-input').addEventListener('change', (e) => {
    state.token = e.target.value.trim();
    store.set('dovesono.token', state.token);
  });
  $('#start-btn').addEventListener('click', startGame);
  renderSetup();
  initLists();
}

// ---------- Partita ----------
let guessMap, guessMarker, guessBorder, resultMap, summaryMap, timerId;

function startGame() {
  $('#setup-error').textContent = '';
  state.token = $('#token-input').value.trim();
  store.set('dovesono.token', state.token);
  const settings = readSettings();
  state.settings = settings;
  const source = SOURCES[settings.source] || panoramaxSource;

  if (!state.areas.length) { $('#setup-error').textContent = 'Scegli almeno un\'area.'; return; }
  if (source.needsToken && !state.token) { $('#setup-error').textContent = 'Serve il token Mapillary (vedi sopra).'; return; }

  const prepared = state.areas.map(prepareArea);
  state.game = {
    settings,
    source,
    prepared,
    halfDist: halfPointsDistance(settings, state.areas),
    round: 0,
    total: 0,
    rounds: [], // { answer, guess, distance, points, areaName }
    usedIds: new Set(),
    next: null,
    // per le segnalazioni: la domanda su "Cambia posto" compare una volta per partita
    askedSkipReason: false,
    skips: 0,
    frameLoads: [],
    startPresses: 0,
  };

  show('game');
  Object.values(SOURCES).forEach((s) => s.destroy());
  $('#viewer').style.display = source === mapillarySource ? '' : 'none';
  $('#px-viewer').style.display = source === panoramaxSource ? '' : 'none';
  $('#sv-viewer').style.display = source === streetViewSource ? '' : 'none';
  $('#skip-btn').style.display = source === streetViewSource ? '' : 'none';
  $('#report-btn').style.display = source === streetViewSource ? '' : 'none';
  setupGuessMap();
  playRound();
}

function setupGuessMap() {
  if (!guessMap) {
    guessMap = makeMap('guess-map');
    guessMap.on('click', (e) => {
      if (!state.game || state.game.locked) return;
      if (!guessMarker) guessMarker = L.marker(e.latlng, { icon: pinIcon('guess') }).addTo(guessMap);
      else guessMarker.setLatLng(e.latlng);
      $('#guess-btn').disabled = false;
      $('#guess-btn').textContent = 'Indovina';
    });
    $('#guess-size').addEventListener('click', () => {
      $('#guess-wrap').classList.toggle('big');
      setTimeout(() => guessMap.invalidateSize(), 220);
    });
    $('#guess-btn').addEventListener('click', () => submitGuess(false));
    $('#quit-btn').addEventListener('click', quitGame);
  }
  if (guessBorder) guessBorder.remove();
  guessBorder = state.game.settings.showBorder
    ? L.geoJSON(turf.featureCollection(state.areas.map((a) => turf.feature(a.geometry))), { style: { ...borderStyle, fillOpacity: 0.03 }, interactive: false }).addTo(guessMap)
    : null;
}

function resetGuessMap() {
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  $('#guess-btn').disabled = true;
  $('#guess-btn').textContent = 'Piazza un segnaposto';
  $('#guess-wrap').classList.remove('big');
  guessMap.invalidateSize();
  const [minX, minY, maxX, maxY] = areasBbox(state.areas);
  guessMap.fitBounds([[minY, minX], [maxY, maxX]], { padding: [10, 10] });
}

function fetchNextLocation(onProgress) {
  const g = state.game;
  const p = g.source.check()
    .then(() => findLocation(g.source, g.prepared, g.settings, g.usedIds, onProgress));
  p.then((loc) => g.usedIds.add(loc.id), () => {});
  return p;
}

async function playRound() {
  const g = state.game;
  g.round += 1;
  g.locked = true;
  $('#hud-round').textContent = `${g.round}/${g.settings.rounds}`;
  $('#hud-score').textContent = g.total.toLocaleString('it-IT');
  $('#hud-timer').textContent = '–';
  $('#loading').classList.add('show');
  $('#loading-text').textContent = 'Cerco un posto…';

  let loc;
  try {
    loc = await (g.next || fetchNextLocation((n, total) => {
      $('#loading-text').textContent = `Cerco un posto… (tentativo ${n} di ${total})`;
    }));
  } catch (err) {
    g.next = null;
    if (state.game === g) showSetupError(locationError(err.message, g.source));
    return;
  }
  if (state.game !== g) return; // partita abbandonata nel frattempo

  g.current = loc;
  g.next = g.round < g.settings.rounds ? fetchNextLocation() : null;
  if (g.next) g.next.catch(() => {});

  resetGuessMap();
  g.frameLoads = [];
  g.startPresses = 0;
  g.roundStartedAt = Date.now();
  try {
    await g.source.show(loc, g.settings);
  } catch {
    // immagine non caricabile: passo a un'altra
    g.round -= 1;
    g.next = null;
    return playRound();
  }
  $('#loading').classList.remove('show');
  g.locked = false;
  diag(`round ${g.round} mostrato`);
  startTimer();
}

function startTimer() {
  clearInterval(timerId);
  const g = state.game;
  const box = $('#hud-timer-box');
  box.classList.remove('warn');
  if (!g.settings.timeLimit) { $('#hud-timer').textContent = '∞'; return; }
  const deadline = Date.now() + g.settings.timeLimit * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = String(left % 60).padStart(2, '0');
    $('#hud-timer').textContent = `${m}:${s}`;
    box.classList.toggle('warn', left <= 10);
    if (left <= 0) submitGuess(true);
  };
  tick();
  timerId = setInterval(tick, 250);
}

function submitGuess(timedOut) {
  const g = state.game;
  if (!g || g.locked) return;
  logRound(timedOut ? 'tempo-scaduto' : 'risposta');
  g.locked = true;
  clearInterval(timerId);
  closeSkipAsk();

  const answer = g.current.coords;
  let guess = null, distance = null, points = 0;
  if (guessMarker) {
    const ll = guessMarker.getLatLng();
    guess = [ll.lng, ll.lat];
    distance = haversine(guess, answer);
    points = scoreFor(distance, g.settings, g.halfDist);
  }
  g.total += points;
  g.rounds.push({ answer, guess, distance, points, areaName: g.current.areaName, timedOut });
  showResult();
}

function showResult() {
  const g = state.game;
  const r = g.rounds[g.rounds.length - 1];
  show('result');

  if (!resultMap) resultMap = makeMap('result-map');
  else resultMap.eachLayer((l) => { if (!(l instanceof L.TileLayer)) l.remove(); });
  resultMap.invalidateSize();

  L.marker(latLng(r.answer), { icon: pinIcon('answer') }).addTo(resultMap);
  if (r.guess) {
    L.marker(latLng(r.guess), { icon: pinIcon('guess') }).addTo(resultMap);
    L.polyline([latLng(r.guess), latLng(r.answer)], lineStyle).addTo(resultMap);
    $('#result-title').textContent = `Eri a ${formatDistance(r.distance)} dal punto giusto`;
  } else {
    $('#result-title').textContent = 'Tempo scaduto, nessuna risposta';
  }
  $('#result-points').textContent = `${r.points.toLocaleString('it-IT')} punti`;
  const pts = r.guess ? [latLng(r.guess), latLng(r.answer)] : [latLng(r.answer)];
  fitAboveCard(resultMap, pts, '#result .result-card', r.guess ? 16 : 13);
  $('#result-bar').style.width = '0';
  requestAnimationFrame(() => { $('#result-bar').style.width = `${(r.points / g.settings.maxPoints) * 100}%`; });
  $('#next-btn').textContent = g.round >= g.settings.rounds ? 'Vedi il risultato finale' : 'Prossimo round';
}

function nextRound() {
  const g = state.game;
  if (g.round >= g.settings.rounds) return showSummary();
  show('game');
  guessMap.invalidateSize();
  g.source.resize();
  playRound();
}

function showSummary() {
  const g = state.game;
  show('summary');
  if (!summaryMap) summaryMap = makeMap('summary-map');
  else summaryMap.eachLayer((l) => { if (!(l instanceof L.TileLayer)) l.remove(); });
  summaryMap.invalidateSize();

  const bounds = [];
  g.rounds.forEach((r, i) => {
    const n = String(i + 1);
    L.marker(latLng(r.answer), { icon: pinIcon('answer', n) }).addTo(summaryMap);
    bounds.push(latLng(r.answer));
    if (r.guess) {
      L.marker(latLng(r.guess), { icon: pinIcon('guess', n) }).addTo(summaryMap);
      L.polyline([latLng(r.guess), latLng(r.answer)], lineStyle).addTo(summaryMap);
      bounds.push(latLng(r.guess));
    }
  });

  const max = g.settings.maxPoints * g.settings.rounds;
  $('#summary-total').textContent = `${g.total.toLocaleString('it-IT')} / ${max.toLocaleString('it-IT')} punti`;
  const tbody = $('#summary-rows');
  tbody.innerHTML = '';
  g.rounds.forEach((r, i) => {
    const tr = document.createElement('tr');
    const cells = [
      `Round ${i + 1}`,
      r.areaName,
      r.guess ? formatDistance(r.distance) : 'nessuna risposta',
      r.points.toLocaleString('it-IT'),
    ];
    cells.forEach((text, j) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (j === 1) td.className = 'muted';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  fitAboveCard(summaryMap, bounds, '#summary .result-card', 15);
}

function endGame() {
  clearInterval(timerId);
  state.game = null;
  closeSkipAsk();
  Object.values(SOURCES).forEach((s) => s.destroy());
  $('#loading').classList.remove('show');
}

// Con Street View senza chiave non posso sapere se il panorama c'è: il giocatore può chiedere un altro posto.
// esito: "cambiato" (non piaceva) o "segnalato" (in quel caso parte già la segnalazione completa)
function skipLocation(esito = 'cambiato') {
  const g = state.game;
  if (!g || g.locked) return;
  clearInterval(timerId);
  if (esito === 'cambiato') logRound('cambiato');
  g.skips = (g.skips || 0) + 1;
  diag(`cambia posto (${esito})`);
  g.round -= 1;
  playRound();
}

// Riporta al punto di partenza del round ricaricando la vista
// (serve anche quando il riquadro di Street View diventa nero).
async function backToStart() {
  const g = state.game;
  if (!g || g.locked || !g.current) return;
  g.startPresses += 1;
  diag('torna alla partenza');
  try {
    await g.source.show(g.current, g.settings);
  } catch {
    // vista non ricaricabile: resta com'è
  }
}

// Conferma nella pagina invece di confirm(): alcuni browser integrati bloccano le finestre di dialogo.
let quitArmedTimer = null;
function resetQuitButton() {
  clearTimeout(quitArmedTimer);
  quitArmedTimer = null;
  $('#quit-btn').textContent = 'Esci';
  $('#quit-btn').classList.remove('armed');
}

function quitGame() {
  if (!quitArmedTimer) {
    $('#quit-btn').textContent = 'Sicuro? Esci';
    $('#quit-btn').classList.add('armed');
    quitArmedTimer = setTimeout(resetQuitButton, 3000);
    return;
  }
  resetQuitButton();
  endGame();
  show('setup');
  previewMap.invalidateSize();
}

function showSetupError(msg) {
  endGame();
  show('setup');
  previewMap.invalidateSize();
  $('#setup-error').textContent = msg;
}

// ---------- Segnalazioni anonime e registro dei round ----------
// Il riquadro di Google non dice alla pagina se il panorama manca (e non lascia vedere clic e tocchi
// al suo interno), quindi lo segnala chi gioca: con il tasto ⚠, o rispondendo alla domanda che compare
// la prima volta che si preme "Cambia posto" in una partita. In più, se attivo in config.js, ogni round
// manda un registro leggero, per confrontare i posti riusciti con quelli segnalati.
// Si inviano solo dati tecnici (niente nome, email o account) a un Modulo Google indicato in config.js.
const APP_VERSION = '14';
const diagLog = [];

function diag(msg) {
  diagLog.push(`${Math.round(performance.now() / 1000)}s ${msg}`);
  if (diagLog.length > 40) diagLog.shift();
}
document.addEventListener('visibilitychange', () => diag(`visibilità ${document.visibilityState}`));
window.addEventListener('blur', () => diag('blur (focus fuori dalla pagina o nel riquadro)'));
window.addEventListener('focus', () => diag('focus'));
$('#sv-frame').addEventListener('load', () => {
  diag('riquadro Street View caricato');
  const g = state.game;
  // secondi dall'inizio del round a ogni caricamento del riquadro (Google a volte ricarica dopo un reindirizzamento)
  if (g && g.roundStartedAt) g.frameLoads.push(Math.round((Date.now() - g.roundStartedAt) / 100) / 10);
});

// Ritaglio di 24×24 pixel della copertura intorno al punto (~45 m di lato):
// "#" = linea piena, "+" = bordo sfumato, "." = niente, "O" = il punto del round
function coverageCrop(tile, px, py, half = 12) {
  const rows = [];
  for (let y = py - half; y < py + half; y++) {
    let row = '';
    for (let x = px - half; x < px + half; x++) {
      if (x === px && y === py) { row += 'O'; continue; }
      const a = x < 0 || y < 0 || x > 255 || y > 255 ? 0 : tile.alpha[y * 256 + x];
      row += a > 128 ? '#' : a > 0 ? '+' : '.';
    }
    rows.push(row);
  }
  return rows;
}

// Cosa dice la copertura di Google, adesso, sul punto del round
async function coverageCheck([lon, lat], withCrop) {
  const z = COVERAGE_MAX_ZOOM;
  const { x, y } = tileOf(lon, lat, z);
  const tile = await coverageTile(x, y, z);
  if (!tile) return { zoom: z, riquadroVuoto: true };
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const px = Math.floor((((lon + 180) / 360) * n - x) * 256);
  const py = Math.floor((((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n - y) * 256);
  const nearest = pixelLonLat(tile, nearestCovered(tile, lon, lat));
  return {
    zoom: z,
    riquadroVuoto: false,
    alphaSulPunto: tile.alpha[py * 256 + px],
    pixelCoperti: tile.covered.length,
    metriDalPixelCopertoPiuVicino: Math.round(haversine(nearest, [lon, lat]) * 10) / 10,
    ...(withCrop ? { ritaglio: coverageCrop(tile, px, py) } : {}),
  };
}

// tipo: "segnalazione" (pacchetto completo) o "round" (registro leggero); esito: come è finito il round
async function buildReport(tipo, esito) {
  const g = state.game;
  const loc = g && g.current;
  const s = g ? g.settings : state.settings;
  const full = tipo === 'segnalazione';
  // tutto ciò che riguarda il round va letto subito: durante l'attesa il gioco può già passare al prossimo
  const report = {
    versione: APP_VERSION,
    quando: new Date().toISOString(),
    tipo,
    esito,
    fonte: s.source,
    impostazioni: {
      livello: s.level, zona: s.zone, soloAutoGoogle: s.filterOfficial, nienteAutostrade: s.filterNoHighways,
      nienteGallerie: s.filterNoTunnels, movimento: s.moveMode, solo360: s.panoOnly,
    },
    aree: state.areas.map((a) => ({ nome: a.name, tipo: a.kind })),
    round: g ? g.round : null,
    secondiNelRound: g && g.roundStartedAt ? Math.round((Date.now() - g.roundStartedAt) / 1000) : null,
    caricamentiRiquadro: g ? [...g.frameLoads] : [],
    partenzaPremuta: g ? g.startPresses : 0,
    cambiPostoNellaPartita: g ? g.skips || 0 : 0,
    posto: loc ? {
      lat: Number(loc.coords[1].toFixed(6)),
      lon: Number(loc.coords[0].toFixed(6)),
      direzione: loc.heading == null ? null : Math.round(loc.heading),
      lineaAutoGoogle: loc.lineLike,
      area: loc.areaName,
      difficolta: loc.difficulty || null,
      difficoltaNonRispettata: !!loc.levelFallback,
    } : null,
    riquadro: g && g.source === streetViewSource ? $('#sv-frame').src : null,
    copertura: null,
    ambiente: {
      browser: navigator.userAgent,
      lingua: navigator.language,
      schermo: `${screen.width}x${screen.height}`,
      finestra: `${innerWidth}x${innerHeight}`,
      densitaPixel: devicePixelRatio,
      touch: navigator.maxTouchPoints > 0,
    },
    ...(full ? { eventi: diagLog.slice(-25) } : {}),
  };
  if (loc && g.source === streetViewSource) {
    try {
      report.copertura = await coverageCheck(loc.coords, full);
    } catch {
      report.copertura = { errore: 'riquadro di copertura non scaricabile' };
    }
  }
  return report;
}

const reportConfig = () => window.GEO_CONFIG || {};
const reportsEnabled = () => !!(reportConfig().reportFormUrl && reportConfig().reportFormEntry);

async function sendReport(report) {
  if (report.tipo === 'segnalazione') {
    const saved = store.get('dovesono.reports', []);
    saved.push(report);
    store.set('dovesono.reports', saved.slice(-30));
  }

  const cfg = reportConfig();
  if (reportsEnabled()) {
    // I Moduli Google non rispondono alle pagine di altri siti: l'invio è "alla cieca" (no-cors)
    await fetch(cfg.reportFormUrl, {
      method: 'POST',
      mode: 'no-cors',
      body: new URLSearchParams({ [cfg.reportFormEntry]: JSON.stringify(report) }),
    });
    return 'sent';
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    return 'copied';
  } catch {
    return 'kept';
  }
}

let toastTimer = null;
function toast(msg) {
  clearTimeout(toastTimer);
  $('#toast').textContent = msg;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3000);
}

// Registro leggero di fine round (solo Street View, solo se attivo in config.js). Non blocca il gioco.
function logRound(esito) {
  const g = state.game;
  if (!g || !g.current || g.source !== streetViewSource || !reportsEnabled() || reportConfig().logAllRounds === false) return;
  buildReport('round', esito).then(sendReport).catch(() => {});
}

// Segnalazione "non c'è Street View": raccoglie i dati, invia senza chiedere niente e passa a un altro posto
async function reportNoStreetView() {
  const g = state.game;
  if (!g || g.locked || !g.current) return;
  $('#report-btn').disabled = true;
  let report;
  try {
    report = await buildReport('segnalazione', 'non-ce-street-view');
  } catch {
    report = null;
  }
  // il cambio posto non aspetta l'invio
  if (state.game === g && !g.locked) skipLocation('segnalato');
  $('#report-btn').disabled = false;
  if (!report) return;
  try {
    const result = await sendReport(report);
    diag(`segnalazione inviata (${result})`);
    toast(result === 'sent' ? 'Segnalazione inviata, grazie.' : 'Segnalazione salvata (invio non ancora configurato).');
  } catch {
    toast('Segnalazione non inviata: controlla la connessione.');
  }
}

// "Cambia posto": la prima volta in ogni partita chiede il motivo, poi cambia posto e basta
function onSkipClick() {
  const g = state.game;
  if (!g || g.locked) return;
  if (g.source === streetViewSource && !g.askedSkipReason) {
    g.askedSkipReason = true;
    $('#skip-ask').hidden = false;
    $('#skip-ask-yes').focus();
    return;
  }
  skipLocation();
}

function closeSkipAsk() {
  $('#skip-ask').hidden = true;
}

$('#next-btn').addEventListener('click', nextRound);
$('#skip-btn').addEventListener('click', onSkipClick);
$('#report-btn').addEventListener('click', reportNoStreetView);
$('#skip-ask-yes').addEventListener('click', () => { closeSkipAsk(); reportNoStreetView(); });
$('#skip-ask-no').addEventListener('click', () => { closeSkipAsk(); skipLocation(); });
$('#skip-ask-close').addEventListener('click', closeSkipAsk);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#skip-ask').hidden) closeSkipAsk(); });
$('#start-pos-btn').addEventListener('click', backToStart);
$('#px-prev').addEventListener('click', () => panoramaxStep('prev'));
$('#px-next').addEventListener('click', () => panoramaxStep('next'));
$('#again-btn').addEventListener('click', () => { endGame(); startGame(); });
$('#setup-btn').addEventListener('click', () => { endGame(); show('setup'); previewMap.invalidateSize(); });

initSetup();
