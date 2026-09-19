// netlify/functions/de-prices.js
// Proxy für Tankerkönig – Key bleibt serverseitig.
//
// Tankerkönig drosselt Abfragen aus Rechenzentren hart und antwortet dann
// mit HTTP 503 und einer HTML-Seite. Vier Maßnahmen dagegen:
//
//   1. Ein erkennbarer User-Agent. Ohne ihn wird die Anfrage als Bot-
//      Verkehr abgewiesen – das war die eigentliche Ursache.
//   2. Koordinaten werden auf ein 0,05°-Raster (~5 km) gerundet. Alle
//      Besucher eines Ortes landen damit auf derselben Abfrage, auch wenn
//      die Geokodierung leicht abweichende Werte liefert.
//   3. Immer Radius 25 km. Das Frontend filtert selbst auf den gewählten
//      Radius, also genügt eine Abfrage für alle Radius-Einstellungen.
//   4. Jede erfolgreiche Antwort wird gespeichert. Bei einer Störung wird
//      der letzte gute Stand mit Altersangabe ausgeliefert, statt gar nichts.
//   5. Netlify-CDN-Cache-Control mit "durable". OHNE diesen Header speichert
//      Netlify Function-Antworten UEBERHAUPT NICHT zwischen - ein normales
//      Cache-Control mit s-maxage reicht dafuer nicht. Genau daran lag es:
//      Jeder einzelne Seitenaufruf lief bis zu Tankerkoenig durch, bei rund
//      1300 Anfragen pro Stunde gegen ein Limit von 60. "durable" sorgt
//      zusaetzlich dafuer, dass sich alle Netlify-Knoten EINEN Speicher
//      teilen, statt jeder seinen eigenen zu fuellen.

const UPSTREAM_RADIUS = 25;
const CDN_SECONDS = 3600;   // 1 Stunde. MTS-K-Preise aendern sich einige Male am Tag.
const MAX_STALE_MINUTES = 720;
const ATTEMPTS = 1;   // Tankerkönig erlaubt 1 Abruf/Minute.
                      // Eine Wiederholung nach Sekunden verstößt garantiert dagegen
                      // und vertieft eine bestehende Drosselung nur.

// Wie lange eine Stoerungs-Antwort im CDN liegen bleibt.
//
// Das ist die entscheidende Zahl. Waehrend einer Stoerung fragt jeder
// Ort nach Ablauf dieser Zeit erneut bei Tankerkoenig an. Bei N Orten
// sind das N/(T/60) Anfragen pro Minute - erlaubt ist eine.
//
// Mit den frueheren 180 Sekunden reichten schon vier Orte (Goerlitz,
// Zittau, Zgorzelec, Slubice), um dauerhaft ueber dem Limit zu liegen:
// 4 / 3 min = 1,3 Anfragen pro Minute. Die Drosselung hielt sich damit
// selbst am Leben, und der letzte gute Stand blieb stundenlang stehen.
//
// 900 Sekunden tragen bis zu 15 verschiedene Orte, ohne das Limit zu
// reissen. Preis dafuer: Nach einer Stoerung kann es eine Viertelstunde
// dauern, bis frische Preise durchkommen. Das ist der bessere Handel -
// MTS-K-Preise aendern sich ohnehin nur einige Male am Tag, und die
// Seite weist den Stand offen aus.
const STOERUNG_CDN_SEKUNDEN = 900;
const FEHLER_CACHE_SEKUNDEN = 900;

// Zustand des Zwischenspeichers. Wird in der Antwort mitgeschickt, weil der
// Fehler sonst nur im Server-Log steht - und dort hat monatelang niemand
// hingesehen, waehrend der Speicher gar nicht existierte.
let speicherZustand = 'unbekannt';

async function getBlobStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('de-prices');
    speicherZustand = 'erreichbar';
    return store;
  } catch (e) {
    speicherZustand = 'nicht ladbar: ' + e.message;
    console.warn('Blobs nicht verfügbar:', e.message);
    return null;
  }
}

const snap = (v) => Math.round(v * 20) / 20;   // 0,05°-Raster

exports.handler = async (event) => {
  const TK_KEY = process.env.TK_KEY || process.env.TK_API_KEY;
  if (!TK_KEY) return json(500, { ok: false, message: 'TK_KEY nicht konfiguriert' });

  const q = event.queryStringParameters || {};
  let lat = parseFloat(q.lat);
  let lng = parseFloat(q.lng);
  if (!isFinite(lat) || !isFinite(lng)) { lat = 51.1534; lng = 14.9853; } // Görlitz
  lat = snap(lat);
  lng = snap(lng);

  const cacheKey = `tk-${lat}-${lng}`;
  const store = await getBlobStore();

  const url =
    'https://creativecommons.tankerkoenig.de/json/list.php' +
    `?lat=${lat}&lng=${lng}&rad=${UPSTREAM_RADIUS}&sort=dist&type=all&apikey=${TK_KEY}`;

  let data = null;
  let failure;

  for (let attempt = 1; attempt <= ATTEMPTS && !data; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(7000),
        headers: {
          'User-Agent': 'BestPriceTank/1.0 (+https://bestpricetank.de)',
          'Accept': 'application/json',
          'Referer': 'https://bestpricetank.de/',
        },
      });
      const body = await res.text();
      try {
        data = JSON.parse(body);
      } catch {
        failure = `Tankerkönig antwortete mit HTTP ${res.status} statt JSON`;
        console.warn(`Versuch ${attempt}: ${failure} – ${body.slice(0, 120)}`);
      }
    } catch (e) {
      failure = 'Abruf fehlgeschlagen: ' + e.message;
      console.warn(`Versuch ${attempt}: ${failure}`);
    }
  }

  if (data && data.ok) {
    const payload = { ...data, fetchedAt: new Date().toISOString(), stale: false };
    if (store) {
      try { await store.setJSON(cacheKey, payload); speicherZustand = 'geschrieben'; }
      catch (e) {
        speicherZustand = 'Schreiben fehlgeschlagen: ' + e.message;
        console.warn('Blob-Schreiben fehlgeschlagen:', e.message);
      }
    }
    return json(200, { ...payload, quelle: 'live', speicher: speicherZustand }, {
      'Netlify-CDN-Cache-Control':
        `public, durable, s-maxage=${CDN_SECONDS}, stale-while-revalidate=86400`,
      'Cache-Control': 'public, max-age=120',
    });
  }
  if (data && !data.ok) failure = data.message || 'Tankerkönig-Fehler';

  // ── Störung: letzten guten Stand ausliefern, statt gar nichts ──────
  if (store) {
    try {
      const last = await store.get(cacheKey, { type: 'json' });
      if (last && Array.isArray(last.stations)) {
        const ageMinutes = Math.round((Date.now() - new Date(last.fetchedAt).getTime()) / 60000);
        if (ageMinutes <= MAX_STALE_MINUTES) {
          console.warn(`TK gestört (${failure}) – liefere Stand von vor ${ageMinutes} Min.`);
          return json(200, { ...last, stale: true, ageMinutes, upstreamMessage: failure,
                             quelle: 'speicher', speicher: speicherZustand }, {
            'Netlify-CDN-Cache-Control':
              `public, durable, s-maxage=${STOERUNG_CDN_SEKUNDEN}, stale-while-revalidate=86400`,
            'Cache-Control': 'public, max-age=60',
          });
        }
      }
    } catch (e) {
      speicherZustand = 'Lesen fehlgeschlagen: ' + e.message;
      console.warn('Blob-Lesen fehlgeschlagen:', e.message);
    }
  }

  // ── Letzter Ausweg: der beim Deploy abgelegte Notvorrat ───────────
  // Netlify Blobs ist nicht auf jeder Seite verfuegbar. data/de-stations.json
  // liegt statisch im Deploy und ist deshalb immer erreichbar.
  try {
    const basis = process.env.URL || 'https://bestpricetank.de';
    const res = await fetch(`${basis}/data/de-stations.json`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const vorrat = await res.json();
      if (Array.isArray(vorrat.stations) && vorrat.stations.length) {
        const ageMinutes = Math.round((Date.now() - new Date(vorrat.fetchedAt).getTime()) / 60000);
        console.warn(`TK gestört (${failure}) – liefere Notvorrat von vor ${ageMinutes} Min.`);
        return json(200, { ...vorrat, stale: true, ageMinutes, upstreamMessage: failure,
                           quelle: 'notvorrat', speicher: speicherZustand }, {
          'Netlify-CDN-Cache-Control':
            `public, durable, s-maxage=${STOERUNG_CDN_SEKUNDEN}, stale-while-revalidate=86400`,
          'Cache-Control': 'public, max-age=120',
        });
      }
    }
  } catch (e) {
    console.warn('Notvorrat nicht lesbar:', e.message);
  }

  // Auch den Fehlschlag zwischenspeichern. Sonst stoesst jeder Besucher
  // waehrend einer Stoerung einen neuen Abruf an - und die Drosselung
  // kann sich nie erholen.
  return json(502, { ok: false, message: failure || 'Tankerkönig nicht erreichbar',
                     quelle: 'nichts', speicher: speicherZustand }, {
    'Netlify-CDN-Cache-Control': `public, durable, s-maxage=${FEHLER_CACHE_SEKUNDEN}`,
    'Cache-Control': 'public, max-age=60',
  });
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
