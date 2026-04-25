// netlify/functions/dp-prices.js
// Dyskont Paliwowy Live-Preise — exakt nach API-Spec von Jarosław Kłębucki
// Endpoint: GET https://api.dyskontpaliwowy.pl/api/v1/station-prices
// Auth:     X-API-Key header
// Key:      DP_API_KEY in Netlify Dashboard (nie im Code!)

let _cache    = null;
let _cacheTs  = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 Minuten — wie vom API-Anbieter empfohlen

const API_URL = 'https://api.dyskontpaliwowy.pl/api/v1/station-prices';

// Haversine-Distanz in km
function dist(lat1, lng1, lat2, lng2) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // Cache noch frisch?
  if (_cache && (Date.now() - _cacheTs) < CACHE_MS) {
    return filterAndRespond(_cache, event.queryStringParameters, headers, true);
  }

  const DP_KEY = process.env.DP_API_KEY;
  if (!DP_KEY) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'no_key', message: 'DP_API_KEY not configured', stations: [] })
    };
  }

  try {
    const res = await fetch(API_URL, {
      headers: {
        'Accept': 'application/json',
        'X-API-Key': DP_KEY,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 401) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired API key' }) };
    }
    if (!res.ok) {
      throw new Error(`DP API ${res.status}`);
    }

    const data = await res.json();

    if (data.status !== 'success' || !Array.isArray(data.stations)) {
      throw new Error('Unexpected API response');
    }

    // Hole aktuellen EUR/PLN Kurs für Umrechnung
    let plnRate = 4.25; // Fallback
    try {
      const erRes = await fetch('https://v6.exchangerate-api.com/v6/latest/EUR', {signal: AbortSignal.timeout(3000)});
      const erData = await erRes.json();
      if (erData.result === 'success') plnRate = +erData.conversion_rates.PLN.toFixed(4);
    } catch(_) {}

    // Normalisierung — alle aktiven Stationen
    const normalized = data.stations
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
        // Preise in PLN (Original)
        prices_pln: {
          diesel: s.prices.ON     ?? null,
          e5:     s.prices.PB95   ?? null,
          e10:    s.prices.PB98   ?? null,
          lpg:    s.prices.LPG    ?? null,
          adblue: s.prices.ADBLUE ?? null,
        },
        // Preise in EUR (umgerechnet, 3 Nachkommastellen)
        diesel: s.prices.ON   ? +(s.prices.ON   / plnRate).toFixed(3) : null,
        e5:     s.prices.PB95 ? +(s.prices.PB95 / plnRate).toFixed(3) : null,
        e10:    s.prices.PB98 ? +(s.prices.PB98 / plnRate).toFixed(3) : null,
        lpg:    s.prices.LPG  ? +(s.prices.LPG  / plnRate).toFixed(3) : null,
        logo:   'DP',
        source: 'dyskont_paliwowy',
        last_update: s.last_update,
        pln_eur_rate: plnRate,
      }));

    _cache   = { data_timestamp: data.data_timestamp, currency: 'PLN', pln_eur_rate: plnRate, stations: normalized };
    _cacheTs = Date.now();

    console.log(`✅ DP: ${normalized.length} Stationen geladen, Kurs: ${plnRate} PLN/EUR`);
    return filterAndRespond(_cache, event.queryStringParameters, headers, false);

  } catch (err) {
    console.error('dp-prices error:', err.message);
    // Stale Cache zurückgeben wenn vorhanden
    if (_cache) {
      return filterAndRespond(_cache, event.queryStringParameters, headers, true, true);
    }
    return { statusCode: 503, headers, body: JSON.stringify({ error: err.message, stations: [] }) };
  }
};

function filterAndRespond(cache, params, headers, cached, stale = false) {
  const lat  = parseFloat(params?.lat)  || null;
  const lng  = parseFloat(params?.lng)  || null;
  const rad  = parseFloat(params?.rad)  || 50; // default 50km wenn kein Filter

  // Distanz berechnen + filtern wenn lat/lng angegeben
  let stations = cache.stations.map(s => ({
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
      status:        'success',
      data_timestamp: cache.data_timestamp,
      pln_eur_rate:  cache.pln_eur_rate,
      cached,
      stale:         stale || undefined,
      count:         stations.length,
      stations,
    }),
  };
}
