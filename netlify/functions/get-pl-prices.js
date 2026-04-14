// Weiterleitung zu fetch-pl-prices
// Beide Functions geben die gleichen Preise zurück
exports.handler = async () => ({
  statusCode: 200,
  headers: { 
    'Content-Type': 'application/json', 
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600'
  },
  body: JSON.stringify({
    timestamp: new Date().toISOString(),
    source: ['static_11042026'],
    updated: '11.04.2026',
    zgorzelec_i:  { e5: 6.12, diesel: 7.58, lpg: 3.89, adblue: 4.19 },
    zgorzelec_ii: { e5: 6.12, diesel: 7.58, lpg: 3.94, adblue: 4.19 },
    hradek:       { e5: 39,99, diesel: 40,99, lpg: 19.80 },
    regional_pl:  { e5: 6.14, diesel: 7.60, lpg: 3.89 },
    regional_cz:  { e5: 39,99, diesel: 40,99, lpg: 19.80 },
  }),
});
