const fs = require('fs');
const path = require('path');

exports.handler = async () => {
  let data;
  
  try {
    // Alle möglichen Pfade testen und loggen
    const base = process.cwd();
    console.log('CWD:', base);
    console.log('__dirname:', __dirname);
    
    // Verzeichnis auflisten
    try {
      const files = fs.readdirSync(base);
      console.log('Root Dateien:', files.join(', '));
    } catch(e) {}
    
    const paths = [
      path.join(base, 'data', 'prices.json'),
      path.join(__dirname, '..', '..', 'data', 'prices.json'),
      path.join(__dirname, '..', '..', '..', 'data', 'prices.json'),
      path.join(__dirname, 'data', 'prices.json'),
      '/var/task/data/prices.json',
      '/opt/build/repo/data/prices.json',
    ];
    
    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          data = JSON.parse(fs.readFileSync(p, 'utf8'));
          console.log('✅ Gefunden:', p);
          break;
        } else {
          console.log('❌ Nicht da:', p);
        }
      } catch(e) {}
    }
    
    if (!data) throw new Error('Nicht gefunden');
    
  } catch(e) {
    console.log('→ Statische Fallback Preise');
    data = {
      timestamp: new Date().toISOString(),
      source: ['static_11042026'],
      zgorzelec_i:  { e5: 6.17, diesel: 7.66, lpg: 3.89, adblue: 4.19 },
      zgorzelec_ii: { e5: 6.17, diesel: 7.66, lpg: 3.94, adblue: 4.19 },
      hradek:       { e5: 41.20, diesel: 43.50, lpg: 19.80 },
      regional_pl:  { e5: 6.17, diesel: 7.66, lpg: 3.89 },
      regional_cz:  { e5: 41.20, diesel: 43.50, lpg: 19.80 },
    };
  }

  return {
    statusCode: 200,
    headers: { 
      'Content-Type': 'application/json', 
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    },
    body: JSON.stringify(data),
  };
};
