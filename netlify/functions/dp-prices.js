// netlify/functions/dp-prices.js
// Dyskont Paliwowy Live-Preise
// Caching: Netlify CDN Edge-Cache (s-maxage) — kein Blobs nötig
// Die Netlify CDN cached diese Function-Antwort 10 Min. am Edge,
// d.h. die DP-API wird max. 6x/Stunde aufgerufen, egal wie viel Traffic.

const CACHE_SECONDS = 600; // 10 Minuten CDN-Cache

const DP_API_URL  = 'https://api.dyskontpaliwowy.pl/api/v1/station-prices';
const NBP_API_URL = 'https://api.nbp.pl/api/exchangerates/rates/a/eur/last/1/?format=json';

// Haversine-Distanz in km
function dist(lat1, lng1, lat2, lng2) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// EUR/PLN Kurs von der Polnischen Nationalbank
// Kostenlos, unlimitiert, kein Key — last/1 funktioniert auch am Wochenende
async function fetchPlnRate() {
  try {
    const res = await fetch(NBP_API_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`NBP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.[0]?.mid;
    if (!rate || isNaN(rate)) throw new Error('NBP: kein Kurs');
    return +rate.toFixed(4);
  } catch (err) {
    console.warn('NBP Fallback 4.25:', err.message);
    return 4.25;
  }
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};

  const DP_KEY = process.env.DP_API_KEY;
  if (!DP_KEY) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ status: 'no_key', message: 'DP_API_KEY fehlt im Netlify Dashboard', stations: [] }),
    };
  }

  // DP-API + NBP parallel — spart ~200ms
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
    console.error('API-Fehler:', err.message);
    return {
      statusCode: err.status === 401 ? 401 : 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message, stations: [] }),
    };
  }

  if (dpData.status !== 'success' || !Array.isArray(dpData.stations)) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Unerwartetes API-Format', stations: [] }),
    };
  }

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

  const lat = parseFloat(params.lat) || null;
  const lng = parseFloat(params.lng) || null;
  const rad = parseFloat(params.rad) || 50;

  let result = stations.map(s => ({
    ...s,
    dist_km: (lat && lng) ? +dist(lat, lng, s.lat, s.lng).toFixed(1) : null,
  }));

  if (lat && lng) {
    result = result
      .filter(s => s.dist_km <= rad)
      .sort((a, b) => a.dist_km - b.dist_km);
  }

  console.log(`✅ DP: ${result.length} Stationen, Kurs: ${plnRate} PLN/EUR`);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // Netlify CDN cached die Antwort 10 Min. am Edge-Server
      // Egal wie viele Nutzer gleichzeitig anfragen — Lambda läuft nur 1x alle 10 Min.
      'Cache-Control': `public, s-maxage=${CACHE_SECONDS}, max-age=120, stale-while-revalidate=60`,
      'Netlify-CDN-Cache-Control': `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`,
    },
    body: JSON.stringify({
      status:         'success',
      data_timestamp: dpData.data_timestamp,
      pln_eur_rate:   plnRate,
      count:          result.length,
      stations:       result,
    }),
  };
};
