const express = require('express');
const cors = require('cors');
const axios = require('axios');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const DATA_DIR = path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'subs.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUBS_FILE)) fs.writeFileSync(SUBS_FILE, '[]');
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '[]');

function loadSubs() { try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch { return []; } }
function saveSubs(s) { fs.writeFileSync(SUBS_FILE, JSON.stringify(s, null, 2)); }
function appendEvent(ev) {
  try { const e = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); e.unshift(ev); fs.writeFileSync(EVENTS_FILE, JSON.stringify(e.slice(0, 500), null, 2)); } catch {}
}

let vapid;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  console.log('[VAPID] Usando variables de entorno');
} else {
  vapid = JSON.parse(fs.readFileSync(path.join(__dirname, 'vapid.json')));
  console.log('[VAPID] Usando vapid.json local');
}
webpush.setVapidDetails('mailto:geomontior@local', vapid.publicKey, vapid.privateKey);

const cache = { quakes: { data: null, ts: 0 }, weather: { data: null, ts: 0 }, cyclones: { data: null, ts: 0 }, tsunami: { data: null, ts: 0 } };
const seenQuakes = new Set();

app.get('/api/quakes', async (req, res) => {
  if (Date.now() - cache.quakes.ts < 60000 && cache.quakes.data) return res.json(cache.quakes.data);
  try {
    const { data } = await axios.get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson', { timeout: 15000 });
    cache.quakes = { data, ts: Date.now() };
    data.features.filter(f => f.properties.mag >= 5.0).forEach(async (f) => {
      if (seenQuakes.has(f.id)) return;
      seenQuakes.add(f.id);
      const p = f.properties; const [lon, lat, prof] = f.geometry.coordinates;
      await broadcastPush({ title: `🔴 Sismo M${p.mag}`, body: `${p.place || 'Global'} · Prof ${prof.toFixed(1)} km`, url: `/?lat=${lat}&lon=${lon}&z=8` });
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/weather', async (req, res) => {
  if (Date.now() - cache.weather.ts < 10 * 60000 && cache.weather.data) return res.json(cache.weather.data);
  try {
    const lats = [], lons = [];
    for (let lat = -50; lat <= 70; lat += 15) for (let lon = -180; lon <= 180; lon += 20) { lats.push(lat); lons.push(lon); }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=temperature_2m,wind_speed_10m,precipitation,weather_code&wind_speed_unit=kmh&timezone=UTC`;
    const { data } = await axios.get(url, { timeout: 20000 });
    const arr = Array.isArray(data) ? data : [data];
    const features = [];
    arr.forEach((item, i) => {
      if (!item.current) return;
      const c = item.current;
      let type = null, color = null, icon = '';
      if (c.weather_code === 96 || c.weather_code === 99) { type = 'Granizo'; color = '#22d3ee'; icon = '🧊'; }
      else if (c.weather_code >= 95) { type = 'Tormenta eléctrica'; color = '#ef4444'; icon = '⛈️'; }
      else if (c.wind_speed_10m > 60) { type = 'Viento fuerte'; color = '#f97316'; icon = '💨'; }
      else if (c.precipitation > 5) { type = 'Lluvia intensa'; color = '#3b82f6'; icon = '🌧️'; }
      if (type) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lons[i], lats[i]] }, properties: { type, color, icon, wind: c.wind_speed_10m, precip: c.precipitation, temp: c.temperature_2m } });
    });
    cache.weather = { data: { type: 'FeatureCollection', features }, ts: Date.now() };
    res.json(cache.weather.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cyclones', async (req, res) => {
  if (Date.now() - cache.cyclones.ts < 5 * 60000 && cache.cyclones.data) return res.json(cache.cyclones.data);
  try {
    const { data } = await axios.get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&limit=15', { timeout: 15000 });
    const features = (data.features || []).map(f => ({ type: 'Feature', geometry: f.geometry, properties: f.properties }));
    cache.cyclones = { data: { type: 'FeatureCollection', features }, ts: Date.now() };
    res.json(cache.cyclones.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tsunami', async (req, res) => {
  if (Date.now() - cache.tsunami.ts < 10 * 60000 && cache.tsunami.data) return res.json(cache.tsunami.data);
  try {
    const { data: xml } = await axios.get('https://www.tsunami.gov/events/xml/PAAQAtom.xml', { timeout: 15000 });
    const matches = [...xml.matchAll(/<title>([^<]*(?:Warning|Advisory)[^<]*)<\/title>/gi)];
    const features = matches.map((m, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-150 + (i * 5), 30 + (i * 2)] }, properties: { title: m[1] } }));
    cache.tsunami = { data: { type: 'FeatureCollection', features }, ts: Date.now() };
    res.json(cache.tsunami.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Predictor sísmico (EWMA-cuántil en JS) ----------
let predictCache = { data: null, ts: 0 };

function ewma(series, alpha = 0.3) {
  const r = new Array(series.length).fill(0);
  r[0] = series[0];
  for (let i = 1; i < series.length; i++) r[i] = alpha * series[i] + (1 - alpha) * r[i - 1];
  return r;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

app.get('/api/predict', async (req, res) => {
  if (Date.now() - predictCache.ts < 30 * 60000 && predictCache.data) return res.json(predictCache.data);
  try {
    const end = new Date();
    const start = new Date(Date.now() - 90 * 86400000);
    const fmt = d => d.toISOString().slice(0, 10);
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${fmt(start)}&endtime=${fmt(end)}&minmagnitude=3.0`;
    const { data } = await axios.get(url, { timeout: 40000 });
    const mags = data.features.map(f => f.properties.mag).filter(m => m != null);

    if (mags.length < 20) return res.json({ error: 'Catálogo insuficiente', n: mags.length });

    const trend = ewma(mags);
    const last10diff = [];
    for (let i = trend.length - 10; i < trend.length; i++) last10diff.push(trend[i] - trend[i - 1]);
    const avgDiff = last10diff.reduce((a, b) => a + b, 0) / last10diff.length;
    const residuals = mags.map((m, i) => m - trend[i]).sort((a, b) => a - b);

    const q10 = quantile(residuals, 0.10);
    const q50 = quantile(residuals, 0.50);
    const q90 = quantile(residuals, 0.90);

    const forecast50 = trend[trend.length - 1] + avgDiff;
    const recent = mags.slice(-30);
    const freq5plus = recent.filter(m => m >= 5.0).length / recent.length;
    const probM5 = Math.min(99, freq5plus * 100 * 7);

    const result = {
      magnitud_esperada: Math.round((forecast50 + q50) * 100) / 100,
      intervalo_80: [
        Math.round((forecast50 + q10) * 100) / 100,
        Math.round((forecast50 + q90) * 100) / 100
      ],
      probabilidad_M5: Math.round(probM5 * 10) / 10,
      eventos_analizados: mags.length,
      ventana_dias: 90,
      modelo: 'EWMA-Cuántil (JS)',
      actualizado: new Date().toISOString()
    };
    predictCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/subscribe', (req, res) => {
  try {
    const subs = loadSubs();
    const s = JSON.stringify(req.body);
    if (!subs.find(x => JSON.stringify(x) === s)) { subs.push(req.body); saveSubs(subs); }
    res.status(201).json({ ok: true, total: subs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/vapid-public', (req, res) => res.json({ key: vapid.publicKey }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), subs: loadSubs().length }));

async function broadcastPush(payload) {
  const subs = loadSubs(); const survivors = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); survivors.push(sub); }
    catch (e) { if (e.statusCode !== 410 && e.statusCode !== 404) survivors.push(sub); }
  }
  saveSubs(survivors);
  appendEvent({ type: 'push', data: payload, ts: Date.now() });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[GeoMonitor] Backend en http://localhost:${PORT}`);
});
