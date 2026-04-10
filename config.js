// ══════════════════════════════════════════════
// Netlify Function – API Keys sicher bereitstellen
// Keys kommen aus Netlify Environment Variables
// Nie im HTML Code sichtbar!
// ══════════════════════════════════════════════

exports.handler = async () => {
  // ⚠️ In Netlify Dashboard eintragen:
  // Site Settings → Environment Variables
  //   TK_API_KEY = dein Tankerkönig Key
  //   ER_API_KEY = dein ExchangeRate Key
  
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/javascript',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
    // Keys werden als JS-Variablen geliefert
    body: `
      window.TK_API_KEY = '${process.env.TK_API_KEY || ''}';
      window.ER_API_KEY = '${process.env.ER_API_KEY || ''}';
    `,
  };
};
