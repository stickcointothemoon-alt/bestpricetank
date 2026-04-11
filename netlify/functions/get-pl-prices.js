// Gecachte PL Preise zurückgeben
// Fallback auf statische Werte wenn kein Cache

exports.handler = async () => {
  const fallback = {
    timestamp: new Date().toISOString(),
    source: ['fallback_static'],
    prices: {
      zgorzelec_i:  { e5: 6.17, diesel: 7.66, lpg: 3.89, adblue: 4.19 },
      zgorzelec_ii: { e5: 6.17, diesel: 7.66, lpg: 3.94, adblue: 4.19 },
      regional_avg: { e5: 6.17, diesel: 7.66, lpg: 3.89 },
    },
    note: 'Statische Fallback-Preise – tägl. Update läuft um 07:00 Uhr'
  };

  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('fuel-prices');
    const data = await store.get('pl-prices', { type: 'json' });
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
      body: JSON.stringify(data || fallback),
    };
  } catch(err) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
      body: JSON.stringify(fallback),
    };
  }
};
