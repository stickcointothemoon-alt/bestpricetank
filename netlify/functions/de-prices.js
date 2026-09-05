// netlify/functions/de-prices.js
// Proxy für Tankerkönig – Key bleibt serverseitig.
//
// Tankerkönig drosselt Anfragen aus Rechenzentren und antwortet dann mit
// HTTP 503 und einer HTML-Seite. Damit die Seite deswegen nicht ohne
// deutsche Preise dasteht, wird jede erfolgreiche Antwort gespeichert und
// bei einer Störung der letzte gute Stand mit Altersangabe ausgeliefert.
//
// Anfragen werden bewusst zusammengefasst:
//   · immer Radius 25 km (das Frontend filtert selbst auf den gewählten Radius)
//   · Koordinaten auf 2 Nachkommastellen (~1 km Raster)
// Dadurch teilen sich alle Besucher eines Ortes eine einzige Abfrage.

const UPSTREAM_RADIUS = 25;
const CDN_SECONDS = 600;   // Netlify-CDN hält die Antwort 10 Minuten
const MAX_STALE_MINUTES = 180;

async function getBlobStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore('de-prices');
  } catch (e) {
    console.warn('Blobs nicht verfügbar:', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  const TK_KEY = process.env.TK_KEY || process.env.TK_API_KEY;
  if (!TK_KEY) return json(500, { ok: false, message: 'TK_KEY nicht konfiguriert' });

  const q = event.queryStringParameters || {};
  let lat = parseFloat(q.lat);
  let lng = parseFloat(q.lng);
  if (!isFinite(lat) || !isFinite(lng)) { lat = 51.1534; lng = 14.9853; } // Görlitz

  lat = Math.round(lat * 100) / 100;
  lng = Math.round(lng * 100) / 100;

  const cacheKey = `tk-${lat}-${lng}`;
  const store = await getBlobStore();

  const url =
    'https://creativecommons.tankerkoenig.de/json/list.php' +
    `?lat=${lat}&lng=${lng}&rad=${UPSTREAM_RADIUS}&sort=dist&type=all&apikey=${TK_KEY}`;

  let failure;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      // Keine JSON-Antwort – fast immer die Drosselungsseite von Tankerkönig.
      console.error('TK-Antwort kein JSON:', res.status, body.slice(0, 200));
      failure = `Tankerkönig antwortete mit HTTP ${res.status} statt JSON`;
      data = null;
    }

    if (data && data.ok) {
      const payload = { ...data, fetchedAt: new Date().toISOString(), stale: false };
      if (store) {
        try { await store.setJSON(cacheKey, payload); }
        catch (e) { console.warn('Blob-Schreiben fehlgeschlagen:', e.message); }
      }
      return json(200, payload, {
        'Cache-Control': `public, max-age=60, s-maxage=${CDN_SECONDS}, stale-while-revalidate=1800`,
      });
    }

    if (data && !data.ok) failure = data.message || 'Tankerkönig-Fehler';
  } catch (e) {
    failure = 'Abruf fehlgeschlagen: ' + e.message;
  }

  // ── Störung: letzten guten Stand ausliefern, statt gar nichts ──────
  if (store) {
    try {
      const last = await store.get(cacheKey, { type: 'json' });
      if (last && Array.isArray(last.stations)) {
        const ageMinutes = Math.round((Date.now() - new Date(last.fetchedAt).getTime()) / 60000);
        if (ageMinutes <= MAX_STALE_MINUTES) {
          console.warn(`TK gestört (${failure}) – liefere Stand von vor ${ageMinutes} Min.`);
          return json(200, { ...last, stale: true, ageMinutes, upstreamMessage: failure }, {
            'Cache-Control': 'public, max-age=60, s-maxage=120',
          });
        }
      }
    } catch (e) {
      console.warn('Blob-Lesen fehlgeschlagen:', e.message);
    }
  }

  return json(502, { ok: false, message: failure || 'Tankerkönig nicht erreichbar' });
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
