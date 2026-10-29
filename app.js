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
  // filtri sui posti: spenti = qualsiasi posto
  filterOfficial: false,
  filterNoHighways: false,
  filterNoTunnels: false,
  filterInhabited: false,
};

const state = {
  settings: { ...DEFAULTS, ...store.get('dovesono.settings', {}) },
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

// Punti sulla copertura Street View vicino al punto dato, dentro l'area
async function coveragePointsNear(lon, lat, area, count = 40) {
  let z = coverageStartZoom(area);
  const start = tileOf(lon, lat, z);
  let tile = await coverageTile(start.x, start.y, z);
  if (!tile) return [];

  // primo passo: un pixel coperto a caso nel riquadro, purché dentro l'area
  let target = null;
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
  async searchAt(lon, lat, area) {
    let points;
    try {
      points = await coveragePointsNear(lon, lat, area);
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
    inhabited: settings.filterInhabited,
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

// Strade, edifici e zone urbane del riquadro di mappa che contiene il punto, già in lon/lat
async function ofmFeatures(lon, lat) {
  const { x, y } = tileOf(lon, lat, OFM_ZOOM);
  const key = `${x}/${y}`;
  if (!ofmCache.has(key)) {
    const load = (async () => {
      const { VectorTile, Pbf } = await loadVectorTileLibs();
      if (!ofmTilesUrl) {
        const { res, body } = await fetchJson(OFM_TILEJSON);
        if (!res.ok || !body.tiles) throw new Error('TILES');
        ofmTilesUrl = body.tiles[0];
      }
      const url = ofmTilesUrl.replace('{z}', OFM_ZOOM).replace('{x}', x).replace('{y}', y);
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
      const geo = (name, keep) => {
        const layer = vt.layers[name];
        const out = [];
        if (!layer) return out;
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          if (!keep || keep(f.properties)) out.push(f.toGeoJSON(x, y, OFM_ZOOM));
        }
        return out;
      };
      return {
        roads: geo('transportation', (p) => CAR_ROADS.has(p.class)),
        buildings: geo('building'),
        builtUp: geo('landuse', (p) => BUILT_UP.has(p.class)),
      };
    })();
    load.catch(() => ofmCache.delete(key));
    if (ofmCache.size > 60) ofmCache.delete(ofmCache.keys().next().value);
    ofmCache.set(key, load);
  }
  return ofmCache.get(key);
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

// ---------- Ricerca di un posto ----------
const PARALLEL = 4;   // punti cercati contemporaneamente
const BATCHES = 8;    // tentativi prima di arrendersi

async function tryRandomPoint(source, prepared, settings, usedIds) {
  const area = settings.weighting === 'equal'
    ? prepared[Math.floor(Math.random() * prepared.length)]
    : weightedPick(prepared, (a) => a.totalArea);
  const [lon, lat] = randomPointInArea(area);

  // searchAt: la fonte cerca da sola intorno al punto (Street View); search: dentro bbox sempre più grandi
  const searches = source.searchAt
    ? [() => source.searchAt(lon, lat, area)]
    : source.boxes.map((h) => () => source.search([lon - h, lat - h, lon + h, lat + h], settings));

  for (const search of searches) {
    const found = await search();
    const candidates = shuffle(found.filter((p) =>
      !usedIds.has(p.id) &&
      (!settings.panoOnly || p.isPano) &&
      pointInArea(p.coords, area)));

    let prepared = 0;
    for (const pic of candidates.slice(0, 12)) {
      try {
        if (!(await passesFilters(pic, settings, source))) continue;
      } catch {
        continue; // dati dei filtri non disponibili per questo punto
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
    const tries = Array.from({ length: PARALLEL }, () => tryRandomPoint(source, prepared, settings, usedIds));
    try {
      return await Promise.any(tries);
    } catch (err) {
      if (err.errors.some((e) => e.message === 'TOKEN')) throw new Error('TOKEN');
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
        'disattiva "Solo foto a 360°" o qualche filtro sui posti.';
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
    else s[k] = el.value;
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
  if (s.filterNoHighways || s.filterNoTunnels || s.filterInhabited || (s.filterOfficial && s.source === 'streetview')) {
    notes.push('Con i filtri attivi la ricerca di ogni posto è un po\' più lenta.');
  }
  $('#source-hint').textContent = notes.join(' ');
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
  const preset = PRESETS[key];
  const id = `preset-${key}`;
  if (!preset || state.areas.some((a) => a.id === id)) return;
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
  state.areas.push({ id, name: preset.name, kind: preset.kind, geometry: { type: 'MultiPolygon', coordinates: polygons } });
  saveAreas();
  renderAreas();
  updateHints();
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
      const id = `${it.osm_type}${it.osm_id}`;
      if (!state.areas.some((a) => a.id === id)) {
        state.areas.push({ id, name: it.name || it.display_name.split(',')[0], kind: it.addresstype, geometry: it.geojson });
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
  $('#token-input').addEventListener('change', (e) => {
    state.token = e.target.value.trim();
    store.set('dovesono.token', state.token);
  });
  $('#start-btn').addEventListener('click', startGame);
  renderSetup();
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
  };

  show('game');
  Object.values(SOURCES).forEach((s) => s.destroy());
  $('#viewer').style.display = source === mapillarySource ? '' : 'none';
  $('#px-viewer').style.display = source === panoramaxSource ? '' : 'none';
  $('#sv-viewer').style.display = source === streetViewSource ? '' : 'none';
  $('#skip-btn').style.display = source === streetViewSource ? '' : 'none';
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
  g.locked = true;
  clearInterval(timerId);

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
  Object.values(SOURCES).forEach((s) => s.destroy());
  $('#loading').classList.remove('show');
}

// Con Street View senza chiave non posso sapere se il panorama c'è: il giocatore può chiedere un altro posto.
function skipLocation() {
  const g = state.game;
  if (!g || g.locked) return;
  clearInterval(timerId);
  g.round -= 1;
  playRound();
}

// Riporta al punto di partenza del round ricaricando la vista
// (serve anche quando il riquadro di Street View diventa nero).
async function backToStart() {
  const g = state.game;
  if (!g || g.locked || !g.current) return;
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

$('#next-btn').addEventListener('click', nextRound);
$('#skip-btn').addEventListener('click', skipLocation);
$('#start-pos-btn').addEventListener('click', backToStart);
$('#px-prev').addEventListener('click', () => panoramaxStep('prev'));
$('#px-next').addEventListener('click', () => panoramaxStep('next'));
$('#again-btn').addEventListener('click', () => { endGame(); startGame(); });
$('#setup-btn').addEventListener('click', () => { endGame(); show('setup'); previewMap.invalidateSize(); });

initSetup();
