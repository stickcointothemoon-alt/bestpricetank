// netlify/functions/de-prices.js
// Proxy für Tankerkönig – Key bleibt serverseitig, Antworten werden 5 Min. gecacht.
// Der Key kommt aus der Netlify-Umgebungsvariable TK_KEY (Site settings → Environment variables).

exports.handler = async (event) => {
  const TK_KEY = process.env.TK_KEY;
  if (!TK_KEY) {
    return json(500, { ok: false, message: 'TK_KEY nicht konfiguriert' });
  }

  // Parameter vom Frontend übernehmen, mit sicheren Grenzen
  const q = event.queryStringParameters || {};
  let lat = parseFloat(q.lat);
  let lng = parseFloat(q.lng);
  let rad = parseFloat(q.rad);

  if (!isFinite(lat) || !isFinite(lng)) { lat = 51.1534; lng = 14.9853; } // Fallback: Görlitz
  if (!isFinite(rad) || rad <= 0) rad = 15;
  rad = Math.min(rad, 25);

  // Koordinaten runden (~1 km Raster) → gleiche URL für nahe Nutzer → CDN-Cache greift
  lat = Math.round(lat * 100) / 100;
  lng = Math.round(lng * 100) / 100;

  const url =
    'https://creativecommons.tankerkoenig.de/json/list.php' +
    `?lat=${lat}&lng=${lng}&rad=${rad}&sort=dist&type=all&apikey=${TK_KEY}`;

  try {
    const res = await fetch(url);
    const body = await res.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch (parseErr) {
      // Tankerkoenig lieferte kein JSON (Sperrseite, Wartung, Rate-Limit o. ae.)
      console.error('TK-Antwort kein JSON:', res.status, body.slice(0, 400));
      return json(502, {
        ok: false,
        message: `Tankerkoenig antwortete mit HTTP ${res.status}, aber kein JSON`,
        upstreamStatus: res.status,
        upstreamSnippet: body.slice(0, 400),
      });
    }

    if (!data.ok) {
      // Fehler von Tankerkönig NICHT cachen, aber sauber weiterreichen
      return json(502, { ok: false, message: data.message || 'Tankerkönig-Fehler' });
    }

    // Erfolg: 5 Minuten im Netlify-CDN cachen.
    // Alle Besucher in dieser Zeit bekommen die gespeicherte Antwort –
    // Tankerkönig sieht max. ~1 Anfrage pro 5 Min. und Standort-Raster.
    return json(200, data, { 'Cache-Control': 'public, max-age=60, s-maxage=300' });
  } catch (e) {
    return json(502, { ok: false, message: 'Abruf fehlgeschlagen: ' + e.message });
  }
};

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      extraHeaders || {}
    ),
    body: JSON.stringify(body),
  };
}
