// Netlify Function – liest prices.json aus dem Repo
const path = require('path');
const fs = require('fs');

exports.handler = async () => {
  let data;
  
  try {
    // Verschiedene Pfade probieren
    const paths = [
      path.join(process.cwd(), 'data', 'prices.json'),
      path.join(__dirname, '..', '..', 'data', 'prices.json'),
      path.join(__dirname, '..', '..', '..', 'data', 'prices.json'),
      '/var/task/data/prices.json',
    ];
    
    for (const p of paths) {
      console.log('Versuche:', p);
      if (fs.existsSync(p)) {
        data = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log('✅ Gefunden:', p);
        break;
      }
    }
    
    if (!data) throw new Error('prices.json nicht gefunden');
    
  } catch(e) {
    console.log('Fehler:', e.message, '→ Fallback');
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
