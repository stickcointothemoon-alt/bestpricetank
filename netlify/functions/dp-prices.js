// netlify/functions/dp-prices.js
// Dyskont Paliwowy Live-Preise — mit persistentem Netlify-Blobs-Cache
// Verbesserungen gegenüber v1:
//   ✅ Netlify Blobs statt In-Memory-Cache (überlebt Cold Starts)
//   ✅ NBP (Polnische Nationalbank) statt ExchangeRate-API (kostenlos, unlimitiert)
//   ✅ Cache-Alter im Response mitgeben (für Frontend-Anzeige "Preise von vor X Min.")
//   ✅ Robusteres Error-Handling mit gezielten Fallback-Stufen

const { getStore } = require('@netlify/blobs');

const CACHE_KEY = 'prices-v1';
const CACHE_MS  = 10 * 60 * 1000; // 10 Minuten

const DP_API_URL  = 'https://api.dyskontpaliwowy.pl/api/v1/station-prices';
const NBP_API_URL = 'https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json';

// Haversine-Distanz in km
function dist(lat1, lng1, lat2, lng2) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// EUR/PLN Kurs von der Polnischen Nationalbank (NBP)
// Kostenlos, unlimitiert, offizieller Mittelkurs — kein API-Key nötig
async function fetchPlnRate() {
  try {
    const res = await fetch(NBP_API_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`NBP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.[0]?.mid;
    if (!rate || isNaN(rate)) throw new Error('NBP: kein Kurs im Response');
    return +rate.toFixed(4);
  } catch (err) {
    console.warn('NBP Kurs-Fehler, Fallback 4.25:', err.message);
    return 4.25; // Fallback — NBP aktualisiert nur an Werktagen
  }
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=120', // Browser-Cache 2 Min.
  };

  const params = event.queryStringParameters || {};

  // ── 1. Netlify Blobs Cache prüfen ────────────────────────────────────────
  // Blobs überleben Cold Starts — funktioniert im Gegensatz zu let _cache = null
  let store;
  try {
    store = getStore('dp-prices-cache');
    const blob = await store.get(CACHE_KEY, { type: 'json' });

    if (blob && (Date.now() - blob.ts) < CACHE_MS) {
      console.log(`📦 Cache HIT — Alter: ${Math.round((Date.now() - blob.ts) / 1000)}s`);
      return respond(blob.payload, params, headers, { cached: true, stale: false, cache_age_s: Math.round((Date.now() - blob.ts) / 1000) });
    }
  } catch (blobErr) {
    // Blobs nicht verfügbar (z.B. lokale Entwicklung) — kein Problem, weiter
    console.warn('Blobs nicht verfügbar:', blobErr.message);
    store = null;
  }

  // ── 2. API-Key prüfen ────────────────────────────────────────────────────
  const DP_KEY = process.env.DP_API_KEY;
  if (!DP_KEY) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'no_key', message: 'DP_API_KEY not set in Netlify Dashboard', stations: [] }),
    };
  }

  // ── 3. Dyskont Paliwowy API + NBP parallel abrufen ───────────────────────
  let dpData, plnRate;

  try {
    [dpData, plnRate] = await Promise.all([
      fetch(DP_API_URL, {
        headers: { 'Accept': 'application/json', 'X-API-Key': DP_KEY },
        signal: AbortSignal.timeout(8000),
      }).then(async res => {
        if (res.status === 401) throw Object.assign(new Error('Ungültiger API-Key'), { status: 401 });
        if (!res.ok) throw new Error(`DP API ${res.status}`);
        return res.json();
      }),
      fetchPlnRate(),
    ]);
  } catch (err) {
    console.error('API-Fetch Fehler:', err.message);

    // Stale Cache zurückgeben wenn vorhanden
    if (store) {
      try {
        const staleBlob = await store.get(CACHE_KEY, { type: 'json' });
        if (staleBlob) {
          console.warn('⚠️ Stale Cache zurückgegeben');
          return respond(staleBlob.payload, params, headers, { cached: true, stale: true, cache_age_s: Math.round((Date.now() - staleBlob.ts) / 1000) });
        }
      } catch (_) {}
    }

    const status = err.status === 401 ? 401 : 503;
    return { statusCode: status, headers, body: JSON.stringify({ error: err.message, stations: [] }) };
  }

  // ── 4. Response validieren ───────────────────────────────────────────────
  if (dpData.status !== 'success' || !Array.isArray(dpData.stations)) {
    console.error('Unerwartetes API-Format:', JSON.stringify(dpData).slice(0, 200));
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Unerwartetes API-Response-Format', stations: [] }) };
  }

  // ── 5. Normalisieren ─────────────────────────────────────────────────────
  const stations = dpData.stations
    .filter(s => s.is_active && s.coordinates?.lat && s.coordinates?.lng)
    .map(s => ({
      id:      s.id,
      name:    s.name,
      brand:   s.brand,
      address: s.address,
      city:    s.city,
      country: 'pl',
      lat:     s.coordinates.lat,
      lng:     s.coordinates.lng,
      prices_pln: {
        diesel: s.prices.ON     ?? null,
        e5:     s.prices.PB95   ?? null,
        e10:    s.prices.PB98   ?? null,
        lpg:    s.prices.LPG    ?? null,
        adblue: s.prices.ADBLUE ?? null,
      },
      diesel: s.prices.ON   ? +(s.prices.ON   / plnRate).toFixed(3) : null,
      e5:     s.prices.PB95 ? +(s.prices.PB95 / plnRate).toFixed(3) : null,
      e10:    s.prices.PB98 ? +(s.prices.PB98 / plnRate).toFixed(3) : null,
      lpg:    s.prices.LPG  ? +(s.prices.LPG  / plnRate).toFixed(3) : null,
      logo:        'DP',
      source:      'dyskont_paliwowy',
      last_update: s.last_update,
      pln_eur_rate: plnRate,
    }));

  const payload = {
    data_timestamp: dpData.data_timestamp,
    pln_eur_rate:   plnRate,
    stations,
  };

  // ── 6. In Blobs speichern ────────────────────────────────────────────────
  if (store) {
    try {
      await store.set(CACHE_KEY, JSON.stringify({ ts: Date.now(), payload }));
      console.log(`✅ Cache gesetzt — ${stations.length} Stationen, Kurs: ${plnRate} PLN/EUR`);
    } catch (blobErr) {
      console.warn('Cache-Speichern fehlgeschlagen:', blobErr.message);
    }
  }

  return respond(payload, params, headers, { cached: false, stale: false, cache_age_s: 0 });
};

// ── Filtern nach Radius + Antwort bauen ──────────────────────────────────────
function respond(payload, params, headers, meta) {
  const lat = parseFloat(params.lat) || null;
  const lng = parseFloat(params.lng) || null;
  const rad = parseFloat(params.rad) || 50;

  let stations = payload.stations.map(s => ({
    ...s,
    dist_km: (lat && lng) ? +dist(lat, lng, s.lat, s.lng).toFixed(1) : null,
  }));

  if (lat && lng) {
    stations = stations
      .filter(s => s.dist_km <= rad)
      .sort((a, b) => a.dist_km - b.dist_km);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      status:         'success',
      data_timestamp: payload.data_timestamp,
      pln_eur_rate:   payload.pln_eur_rate,
      ...meta,               // cached, stale, cache_age_s
      count:          stations.length,
      stations,
    }),
  };
}
