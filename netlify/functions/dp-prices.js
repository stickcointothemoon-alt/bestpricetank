// netlify/functions/dp-prices.js
// Dyskont Paliwowy Live-Preise + EUR/PLN + EUR/CZK Kurse
// Alle Wechselkurse: NBP (Polnische Nationalbank) — kostenlos, kein Key
// CDN-Cache: Netlify cached diese URL 10 Min. — Lambda läuft max. 6x/Stunde

const CACHE_SECONDS = 600;

const DP_API_URL   = 'https://api.dyskontpaliwowy.pl/api/v1/station-prices';
const NBP_EUR_URL  = 'https://api.nbp.pl/api/exchangerates/rates/a/eur/last/1/?format=json';
const NBP_CZK_URL  = 'https://api.nbp.pl/api/exchangerates/rates/a/czk/last/1/?format=json';

async function fetchRates() {
  try {
    const [eurRes, czkRes] = await Promise.all([
      fetch(NBP_EUR_URL, { signal: AbortSignal.timeout(4000) }),
      fetch(NBP_CZK_URL, { signal: AbortSignal.timeout(4000) }),
    ]);
    const eurData = await eurRes.json(); // PLN pro EUR
    const czkData = await czkRes.json(); // PLN pro CZK

    const plnRate = eurData?.rates?.[0]?.mid; // z.B. 4.2589
    const czkPln  = czkData?.rates?.[0]?.mid; // z.B. 0.1685

    if (!plnRate || !czkPln) throw new Error('NBP: Kurs fehlt');

    // EUR/CZK = PLN/EUR ÷ PLN/CZK  → z.B. 4.2589 / 0.1685 = 25.27 CZK pro EUR
    const czkRate = +(plnRate / czkPln).toFixed(4);

    return { plnRate: +plnRate.toFixed(4), czkRate };
  } catch (err) {
    console.warn('NBP Fallback:', err.message);
    return { plnRate: 4.25, czkRate: 25.20 }; // Fallback
  }
}

exports.handler = async () => {
  const DP_KEY = process.env.DP_API_KEY;
  if (!DP_KEY) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ status: 'no_key', stations: [] }),
    };
  }

  let dpData, rates;
  try {
    [dpData, rates] = await Promise.all([
      fetch(DP_API_URL, {
        headers: { 'Accept': 'application/json', 'X-API-Key': DP_KEY },
        signal: AbortSignal.timeout(8000),
      }).then(async res => {
        if (res.status === 401) throw Object.assign(new Error('Ungültiger API-Key'), { status: 401 });
        if (!res.ok) throw new Error(`DP API ${res.status}`);
        return res.json();
      }),
      fetchRates(),
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

  const { plnRate, czkRate } = rates;

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

  console.log(`✅ DP: ${stations.length} Stationen · PLN: ${plnRate} · CZK: ${czkRate}`);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, s-maxage=${CACHE_SECONDS}, max-age=120, stale-while-revalidate=60`,
      'Netlify-CDN-Cache-Control': `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`,
    },
    body: JSON.stringify({
      status:         'success',
      data_timestamp: dpData.data_timestamp,
      pln_eur_rate:   plnRate,
      czk_eur_rate:   czkRate,   // NEU: CZK-Kurs für Frontend
      count:          stations.length,
      stations,
    }),
  };
};
