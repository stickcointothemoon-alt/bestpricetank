// netlify/functions/ocm-stations.js 
// Open Charge Map API — kostenlos, kein Key nötig für Basis-Abfragen
// Docs: https://openchargemap.org/site/develop/api

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const { lat = 51.1534, lng = 14.9853, rad = 50 } = event.queryStringParameters || {};

  // Open Charge Map API — kostenlos ohne Key (rate-limited), mit Key besser
  const OCM_KEY = process.env.OCM_API_KEY || ''; // optional in Netlify Env
  const keyParam = OCM_KEY ? `&key=${OCM_KEY}` : '';

  const url = `https://api.openchargemap.io/v3/poi/?` +
    `output=json` +
    `&latitude=${lat}` +
    `&longitude=${lng}` +
    `&distance=${Math.min(+rad, 100)}` +
    `&distanceunit=KM` +
    `&maxresults=60` +
    `&countrycode=DE,PL,CZ` +
    `&statustype=50` +            // 50 = Operational only
    `&levelid=3` +                // Level 2 + DC Fast only (sinnvoll)
    `&compact=false` +
    `&verbose=false` +
    keyParam;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'BestPriceTank/1.0 (bestpricetank.de)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(9000),
    });

    if (!res.ok) {
      throw new Error(`OCM HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!Array.isArray(data)) {
      throw new Error('Ungültige OCM-Antwort');
    }

    // Nur relevante Felder zurückgeben (spart Bandbreite)
    const filtered = data
      .filter(s => s.AddressInfo?.Latitude && s.AddressInfo?.Longitude)
      .map(s => ({
        ID: s.ID,
        AddressInfo: {
          Title: s.AddressInfo.Title,
          Latitude: s.AddressInfo.Latitude,
          Longitude: s.AddressInfo.Longitude,
          CountryID: s.AddressInfo.CountryID,
        },
        OperatorInfo: {
          Title: s.OperatorInfo?.Title || 'Unbekannt',
        },
        StatusType: {
          Title: s.StatusType?.Title || 'Unbekannt',
        },
        NumberOfPoints: s.NumberOfPoints || 1,
        Connections: (s.Connections || []).map(c => ({
          ConnectionType: { Title: c.ConnectionType?.Title || '' },
          PowerKW: c.PowerKW || 0,
          Quantity: c.Quantity || 1,
        })),
      }));

    console.log(`✅ OCM: ${filtered.length} Ladesäulen geladen (lat:${lat}, rad:${rad}km)`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(filtered),
    };

  } catch (err) {
    console.error('OCM Fehler:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
