// GitHub Actions Script – updated beide Netlify Functions direkt!
const fs = require('fs');
const https = require('https');

const FUELO_KEY = process.env.FUELO_KEY || 'a2cbe79aa1948e0';

const FALLBACK = {
  zgorzelec_i:  { e5: 6.12, diesel: 7.58, lpg: 3.89, adblue: 4.19 },
  zgorzelec_ii: { e5: 6.12, diesel: 7.58, lpg: 3.94, adblue: 4.19 },
  hradek:       { e5: 39.99, diesel: 40.99, lpg: 19.80 },
  regional_pl:  { e5: 6.14, diesel: 7.60, lpg: 3.89 },
  regional_cz:  { e5: 39.99, diesel: 40.99, lpg: 19.80 },
};

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'BestPriceTank/1.0 (bestpricetank.de; github-actions)' },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse Fehler')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

async function fetchFuelo(lat, lon, radius, fuel) {
  const url = `https://fuelo.net/api/near?key=${FUELO_KEY}&lat=${lat}&lon=${lon}&limit=30&distance=${radius}&fuel=${fuel}`;
  try {
    const data = await get(url);
    if (data.status !== 'OK') return [];
    console.log(`✅ Fuelo ${fuel}: ${data.num_results} Stationen`);
    return data.gasstations || [];
  } catch(e) {
    console.log(`❌ Fuelo ${fuel}: ${e.message}`);
    return [];
  }
}

async function main() {
  console.log('🔄 Preisupdate:', new Date().toISOString());
  
  const prices = JSON.parse(JSON.stringify(FALLBACK));
  let sources = ['static'];
  const today = new Date().toLocaleDateString('de-DE');
  const ts = new Date().toISOString();

  // Polen abrufen
  const [plDiesel, plE5, plLpg] = await Promise.all([
    fetchFuelo(51.1534, 14.9853, 25, 'diesel'),
    fetchFuelo(51.1534, 14.9853, 25, 'petrol95'),
    fetchFuelo(51.1534, 14.9853, 25, 'lpg'),
  ]);

  if (plDiesel.length > 0) {
    const sorted = plDiesel
      .filter(s => s.price > 5 && s.price < 12)
      .sort((a, b) => a.price - b.price);
    
    if (sorted[0]) {
      prices.regional_pl.diesel = parseFloat(sorted[0].price);
      const e5match = plE5.find(s => s.id === sorted[0].id);
      if (e5match) prices.regional_pl.e5 = parseFloat(e5match.price);
      sources = ['fuelo_pl'];
      console.log('✅ PL günstigste:', sorted[0].brand_name, sorted[0].price);
    }

    const citronex = plDiesel.find(s =>
      (s.brand_name||'').toLowerCase().includes('dyskont') ||
      (s.brand_name||'').toLowerCase().includes('citronex') ||
      (s.address||'').toLowerCase().includes('słowiańska')
    );
    if (citronex?.price) {
      prices.zgorzelec_i.diesel = parseFloat(citronex.price);
      const e5c = plE5.find(s => s.id === citronex.id);
      if (e5c) prices.zgorzelec_i.e5 = parseFloat(e5c.price);
      sources = ['fuelo_citronex'];
      console.log('✅ Citronex:', citronex.price);
    }
  }

  // Tschechien abrufen
  const [czDiesel, czE5] = await Promise.all([
    fetchFuelo(50.8480, 14.8604, 15, 'diesel'),
    fetchFuelo(50.8480, 14.8604, 15, 'petrol95'),
  ]);

  if (czDiesel.length > 0) {
    const czSorted = czDiesel
      .filter(s => s.price > 30 && s.price < 60)
      .sort((a, b) => a.price - b.price);
    if (czSorted[0]) {
      prices.hradek.diesel = parseFloat(czSorted[0].price);
      prices.regional_cz.diesel = prices.hradek.diesel;
      const czE5m = czE5.find(s => s.id === czSorted[0].id);
      if (czE5m) {
        prices.hradek.e5 = parseFloat(czE5m.price);
        prices.regional_cz.e5 = prices.hradek.e5;
      }
      if (!sources.includes('fuelo_citronex')) sources.push('fuelo_cz');
      console.log('✅ CZ günstigste:', czSorted[0].brand_name, czSorted[0].price);
    }
  }

  // Function Code generieren
  const functionCode = `// Auto-generiert: ${ts}
// Nächstes Update: 06:00 oder 18:00 UTC
exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' },
  body: JSON.stringify({
    timestamp: "${ts}",
    source: ${JSON.stringify(sources)},
    updated: "${today}",
    zgorzelec_i:  ${JSON.stringify(prices.zgorzelec_i)},
    zgorzelec_ii: ${JSON.stringify(prices.zgorzelec_ii)},
    hradek:       ${JSON.stringify(prices.hradek)},
    regional_pl:  ${JSON.stringify(prices.regional_pl)},
    regional_cz:  ${JSON.stringify(prices.regional_cz)},
  }),
});
`;

  // Beide Functions updaten!
  fs.writeFileSync('netlify/functions/fetch-pl-prices.js', functionCode);
  fs.writeFileSync('netlify/functions/get-pl-prices.js', functionCode);
  
  // Auch prices.json updaten
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/prices.json', JSON.stringify({
    timestamp: ts,
    source: sources,
    updated: today,
    ...prices
  }, null, 2));

  console.log('✅ Alle Dateien updated!');
  console.log('Quellen:', sources);
  console.log('PL Diesel:', prices.zgorzelec_i.diesel, 'PLN');
  console.log('CZ Diesel:', prices.hradek.diesel, 'CZK');
}

main().catch(err => {
  console.error('❌ Fehler:', err.message);
  process.exit(0);
});
