const fs = require('fs');
const path = require('path');

exports.handler = async () => {
  try {
    const filePath = path.join(process.cwd(), 'data', 'prices.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data),
    };
  } catch(e) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        source: ['fallback'],
        zgorzelec_i:  { e5: 6.17, diesel: 7.66, lpg: 3.89, adblue: 4.19 },
        regional_pl:  { e5: 6.17, diesel: 7.66, lpg: 3.89 },
        regional_cz:  { e5: 41.20, diesel: 43.50, lpg: 19.80 },
      }),
    };
  }
};
