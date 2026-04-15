exports.handler = async () => {
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/BZ%3DF?interval=1d&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await r.json();
    const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=900' // 15 min Cache
      },
      body: JSON.stringify({ price: price || 95.0 })
    };
  } catch(e) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ price: 95.0 })
    };
  }
};
