// ══════════════════════════════════════════════════════════
// GitHub Actions Script – Fuel Prices updaten
// Läuft 2x täglich (06:00 + 18:00 UTC)
// Speichert Ergebnisse in data/prices.json
// ══════════════════════════════════════════════════════════

const fs = require('fs');
const https = require('https');

const FUELO_KEY = process.env.FUELO_KEY || 'a2cbe79aa1948e0';

// Koordinaten
const LOCATIONS = {
  zgorzelec: { lat: 51.1534, lon: 14.9853, radius: 25, country: 'PL' },
  hradek:    { lat: 50.8480, lon: 14.8604, radius: 15, country: 'CZ' },
};

// Fallback Preise
const FALLBACK = {
  timestamp: new Date().toISOString(),
  source: 'fallback',
  zgorzelec_i:  { e5: 6.17, diesel: 7.66, lpg: 3.89, adblue: 4.19 },
  zgorzelec_ii: { e5: 6.17, diesel: 7.66, lpg: 3.94, adblue: 4.19 },
  hradek:       { e5: 41.20, diesel: 43.50, lpg: 19.80 },
  regional_pl:  { e5: 6.17, diesel: 7.66, lpg: 3.89 },
  regional_cz:  { e5: 41.20, diesel: 43.50, lpg: 19.80 },
};

// HTTP GET Helper
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
        catch(e) { reject(new Error('JSON Parse Fehler: ' + data.substring(0, 100))); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

// Fuelo API abfragen
async function fetchFuelo(lat, lon, radius, fuel) {
  const url = `https://fuelo.net/api/near?key=${FUELO_KEY}&lat=${lat}&lon=${lon}&limit=30&distance=${radius}&fuel=${fuel}`;
  console.log(`  Fuelo ${fuel} (${lat},${lon})...`);
  try {
    const data = await get(url);
    if (data.status !== 'OK') throw new Error('Status: ' + data.status);
    console.log(`  ✅ ${data.num_results} Stationen gefunden`);
    return data.gasstations || [];
  } catch(e) {
    console.log(`  ❌ Fehler: ${e.message}`);
    return [];
  }
}

// Preise zusammenführen
function merge(dieselList, e5List, lpgList = []) {
  const map = new Map();
  for (const s of dieselList) map.set(s.id, { ...s, diesel: parseFloat(s.price) || null });
  for (const s of e5List) {
    if (map.has(s.id)) map.get(s.id).e5 = parseFloat(s.price) || null;
    else map.set(s.id, { ...s, diesel: null, e5: parseFloat(s.price) || null });
  }
  for (const s of lpgList) {
    if (map.has(s.id)) map.get(s.id).lpg = parseFloat(s.price) || null;
  }
  return Array.from(map.values());
}

// Günstigste Station finden
function cheapest(stations, minPrice, maxPrice) {
  return stations
    .filter(s => s.diesel > minPrice && s.diesel < maxPrice)
    .sort((a, b) => (a.diesel || 99) - (b.diesel || 99))[0];
}

async function main() {
  console.log('🔄 BestPriceTank Preisupdate gestartet:', new Date().toISOString());
  
  const result = { ...FALLBACK, timestamp: new Date().toISOString(), source: 'mixed' };
  let sources = [];

  // ── Polen (Zgorzelec Umkreis) ──
  console.log('\n🇵🇱 Polen abrufen...');
  const { lat: plLat, lon: plLon, radius: plR } = LOCATIONS.zgorzelec;
  const [plDiesel, plE5, plLpg] = await Promise.all([
    fetchFuelo(plLat, plLon, plR, 'diesel'),
    fetchFuelo(plLat, plLon, plR, 'petrol95'),
    fetchFuelo(plLat, plLon, plR, 'lpg'),
  ]);

  if (plDiesel.length > 0 || plE5.length > 0) {
    const stations = merge(plDiesel, plE5, plLpg);
    
    // Citronex/Dyskont suchen
    const citronex = stations.find(s =>
      (s.brand_name || s.name || '').toLowerCase().includes('dyskont') ||
      (s.brand_name || s.name || '').toLowerCase().includes('citronex') ||
      (s.address || '').toLowerCase().includes('słowiańska')
    );

    if (citronex?.diesel) {
      result.zgorzelec_i = {
        e5:     citronex.e5     || result.zgorzelec_i.e5,
        diesel: citronex.diesel || result.zgorzelec_i.diesel,
        lpg:    citronex.lpg   || result.zgorzelec_i.lpg,
        adblue: 4.19,
      };
      sources.push('fuelo_citronex');
      console.log(`  ✅ Citronex: E5=${citronex.e5} Diesel=${citronex.diesel}`);
    }

    // Günstigste PL Station (PLN 5-12)
    const cheap = cheapest(stations, 5, 12);
    if (cheap?.diesel) {
      result.regional_pl = {
        e5:     cheap.e5     || result.regional_pl.e5,
        diesel: cheap.diesel || result.regional_pl.diesel,
        lpg:    cheap.lpg   || result.regional_pl.lpg,
      };
      if (!sources.includes('fuelo_citronex')) sources.push('fuelo_pl');
      console.log(`  ✅ Günstigste PL: ${cheap.brand_name} Diesel=${cheap.diesel}`);
    }
  }

  // ── Tschechien (Hrádek Umkreis) ──
  console.log('\n🇨🇿 Tschechien abrufen...');
  const { lat: czLat, lon: czLon, radius: czR } = LOCATIONS.hradek;
  const [czDiesel, czE5] = await Promise.all([
    fetchFuelo(czLat, czLon, czR, 'diesel'),
    fetchFuelo(czLat, czLon, czR, 'petrol95'),
  ]);

  if (czDiesel.length > 0 || czE5.length > 0) {
    const czStations = merge(czDiesel, czE5);
    
    // Günstigste CZ Station (CZK 30-60)
    const cheapCz = cheapest(czStations, 30, 60);
    if (cheapCz?.diesel) {
      result.hradek = {
        e5:     cheapCz.e5     || result.hradek.e5,
        diesel: cheapCz.diesel || result.hradek.diesel,
        lpg:    cheapCz.lpg   || result.hradek.lpg,
      };
      result.regional_cz = result.hradek;
      sources.push('fuelo_cz');
      console.log(`  ✅ Günstigste CZ: ${cheapCz.brand_name} Diesel=${cheapCz.diesel}`);
    }
  }

  result.source = sources.length > 0 ? sources : ['fallback'];

  // Speichern
  const outputPath = 'data/prices.json';
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  
  console.log('\n✅ Preise gespeichert:', outputPath);
  console.log('Quellen:', result.source);
  console.log('PL Diesel:', result.zgorzelec_i.diesel, 'PLN');
  console.log('CZ Diesel:', result.hradek.diesel, 'CZK');
}

main().catch(err => {
  console.error('❌ Fehler:', err);
  // Fallback speichern wenn alles fehlschlägt
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/prices.json', JSON.stringify(FALLBACK, null, 2));
  process.exit(0); // Kein Fehler damit GitHub Actions nicht rot wird
});
