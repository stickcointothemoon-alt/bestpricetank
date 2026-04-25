// netlify/functions/fuelo-prices.js
// Fuelo.net API — PL + CZ Tankstellen Live-Preise
// Key: FUELO_KEY in Netlify Dashboard (nie im Code!)
// Docs: https://fuelo.net/

let _cache = null;
let _cacheTime = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 Minuten

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // Serve cache if fresh
  if (_cache && (Date.now() - _cacheTime) < CACHE_MS) {
    return { statusCode: 200, headers, body: JSON.stringify({..._cache, cached: true}) };
  }

  const FUELO_KEY = process.env.FUELO_KEY;
  if (!FUELO_KEY) {
    return { statusCode: 200, headers, body: JSON.stringify({status:'no_key', stations:[]}) };
  }

  // Query params from frontend
  const params = event.queryStringParameters || {};
  const lat  = params.lat  || '51.1534';
  const lng  = params.lng  || '14.9853';
  const rad  = params.rad  || '25';
  const fuel = params.fuel || 'diesel';

  try {
    // Fuelo API endpoint — adjust if they change it
    const url = `https://fuelo.net/api/stations?key=${FUELO_KEY}&lat=${lat}&lng=${lng}&radius=${rad}&fuel=${fuel}&format=json`;
    const res = await fetch(url, {signal: AbortSignal.timeout(8000)});

    if (!res.ok) throw new Error(`Fuelo ${res.status}: ${await res.text().then(t=>t.slice(0,80))}`);
    const data = await res.json();

    // Normalize response
    const stations = (data.stations || data.data || data || []).map(s => ({
      id:      'fuelo_' + (s.id || s.station_id || Math.random().toString(36).slice(2)),
      name:    s.name || s.station_name || 'Tankstelle',
      country: (s.country || s.cc || 'pl').toLowerCase(),
      lat:     +(s.lat || s.latitude || 0),
      lng:     +(s.lng || s.longitude || s.lon || 0),
      diesel:  +(s.diesel || s.prices?.diesel || s.prices?.ON || 0),
      e5:      +(s.petrol || s.e5 || s.prices?.PB95 || s.prices?.['95'] || 0),
      e10:     +(s.e10 || s.prices?.PB98 || s.prices?.['98'] || 0),
      lpg:     +(s.lpg || s.prices?.LPG || 0),
      logo:    (s.brand || s.name || 'FL').substring(0,2).toUpperCase(),
      source:  'fuelo',
      last_update: s.last_update || s.updated_at || null,
    })).filter(s => s.lat && s.lng && (s.diesel > 0 || s.e5 > 0));

    const result = { status: 'success', count: stations.length, stations };
    _cache = result;
    _cacheTime = Date.now();

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch(err) {
    console.error('Fuelo error:', err.message);
    if (_cache) return { statusCode: 200, headers, body: JSON.stringify({..._cache, stale:true}) };
    return { statusCode: 503, headers, body: JSON.stringify({error: err.message, stations:[]}) };
  }
};
