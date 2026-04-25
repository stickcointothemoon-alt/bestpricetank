// netlify/functions/dp-prices.js
// Dyskont Paliwowy / Citronex Live-Preise
// Keys in Netlify Dashboard: DP_API_KEY, DP_API_URL
// Caching: 10 Minuten — schützt vor Rate-Limit-Ban

let _cache     = null;
let _cacheTime = 0;
const CACHE_MS = 10 * 60 * 1000; // 10 Minuten

exports.handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // Cache zurückgeben wenn frisch genug
  if (_cache && (Date.now() - _cacheTime) < CACHE_MS) {
    return { statusCode: 200, headers, body: JSON.stringify({ ..._cache, cached: true }) };
  }

  const DP_KEY = process.env.DP_API_KEY;
  const DP_URL = process.env.DP_API_URL;

  // Noch kein Key → Fallback-Daten zurückgeben
  if (!DP_KEY || !DP_URL) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'fallback',
        message: 'DP API key nicht konfiguriert — Fallback-Preise',
        stations: []
      }),
    };
  }

  try {
    const res  = await fetch(DP_URL, {
      headers: {
        'Authorization': `Bearer ${DP_KEY}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000), // 8s Timeout
    });

    if (!res.ok) throw new Error(`DP API ${res.status}`);

    const data = await res.json();

    // PLN → EUR Umrechnung
    // Wechselkurs: wenn verfügbar aus exchangerate-api, sonst Fallback
    let plnRate = 4.25;
    try {
      const er = await fetch('https://v6.exchangerate-api.com/v6/latest/EUR');
      const erd = await er.json();
      if (erd.result === 'success') plnRate = erd.conversion_rates.PLN;
    } catch (_) { /* Fallback-Kurs */ }

    const transformed = {
      status: data.status || 'success',
      data_timestamp: data.data_timestamp,
      currency_original: 'PLN',
      pln_eur_rate: +plnRate.toFixed(4),
      stations: (data.stations || [])
        .filter(s => s.is_active !== false)
        .map(s => ({
          id:      s.id,
          name:    s.name,
          brand:   s.brand,
          address: s.address,
          city:    s.city,
          country: 'pl',
          lat:     s.coordinates?.lat,
          lng:     s.coordinates?.lng,
          last_update: s.last_update,
          prices_pln: s.prices,
          // Preise in EUR (3 Nachkommastellen)
          diesel: s.prices?.ON   ? +(s.prices.ON   / plnRate).toFixed(3) : null,
          e5:     s.prices?.PB95 ? +(s.prices.PB95 / plnRate).toFixed(3) : null,
          e10:    s.prices?.PB98 ? +(s.prices.PB98 / plnRate).toFixed(3) : null,
          lpg:    s.prices?.LPG  ? +(s.prices.LPG  / plnRate).toFixed(3) : null,
        })),
    };

    _cache     = transformed;
    _cacheTime = Date.now();

    return { statusCode: 200, headers, body: JSON.stringify(transformed) };

  } catch (err) {
    console.error('dp-prices error:', err.message);
    // Bei Fehler: alten Cache zurückgeben wenn vorhanden
    if (_cache) {
      return { statusCode: 200, headers, body: JSON.stringify({ ..._cache, stale: true }) };
    }
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'DP API vorübergehend nicht verfügbar' }),
    };
  }
};
