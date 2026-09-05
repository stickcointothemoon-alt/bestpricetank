// netlify/functions/cz-prices.js
// Tschechische Kraftstoffpreise vom Tschechischen Statistikamt (ČSÚ).
//
// Datensatz CENPHMT: "Průměrné spotřebitelské ceny pohonných hmot", wöchentlich,
// amtlich, kostenlos, kein Schlüssel. Enthält Motorová nafta, Natural 95 und LPG
// als Landesdurchschnitt in Kč/Liter. Eine Aufteilung nach Kraj gibt es nicht.
//
// Das ist ein Benchmark, kein Stationspreis — genau wie Dyskont Paliwowy für
// Polen. Die Zuschlaege je Station liegen im Frontend.

const CSV_URL = 'https://data.csu.gov.cz/opendata/sady/CENPHMT/distribuce/csv';
const REFRESH_HOURS = 6;      // Quelle aendert sich nur woechentlich
const CDN_SECONDS = 21600;    // 6 Stunden

const FUEL_MAP = {
  'Motorová nafta': 'diesel',
  'Benzin automobilový bezolovnatý Natural 95 oktanu': 'e5',
  'LPG': 'lpg',
};

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function getBlobStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore('cz-prices');
  } catch (e) {
    console.warn('Blobs nicht verfügbar:', e.message);
    return null;
  }
}

async function fetchFromCsu() {
  const res = await fetch(CSV_URL, {
    signal: AbortSignal.timeout(9000),
    headers: {
      'User-Agent': 'BestPriceTank/1.0 (+https://bestpricetank.de)',
      'Accept': 'text/csv',
    },
  });
  if (!res.ok) throw new Error(`ČSÚ antwortete mit HTTP ${res.status}`);
  const text = await res.text();

  // Nur Preiszeilen (die Datei enthaelt auch Indexzeilen in Prozent).
  const rows = text.split(/\r?\n/).slice(1)
    .filter(Boolean)
    .map(parseCsvLine)
    .filter(c => c.length >= 9 && c[0].startsWith('Průměrná cena') && FUEL_MAP[c[2]]);

  // Juengste Woche bestimmen (ISO-Wochen wie "2026-W36" sind lexikografisch sortierbar).
  const week = rows.reduce((max, c) => (c[7] > max ? c[7] : max), '');

  const final = {};
  for (const c of rows) {
    if (c[7] !== week) continue;
    const value = parseFloat(c[8]);
    if (isFinite(value)) final[FUEL_MAP[c[2]]] = value;
  }

  if (!final.diesel) throw new Error('Keine Dieselzeile im ČSÚ-Datensatz gefunden');

  return {
    ok: true,
    week,
    weekLabel: week.replace(/^(\d{4})-W(\d+)$/, 'KW $2/$1'),
    currency: 'CZK',
    source: 'ČSÚ – Průměrné spotřebitelské ceny pohonných hmot (Landesdurchschnitt)',
    sourceUrl: 'https://csu.gov.cz/produkty/setreni-prumernych-cen-vybranych-vyrobku-pohonne-hmoty-a-topne-oleje-casove-rady',
    prices: final,
    fetchedAt: new Date().toISOString(),
  };
}

exports.handler = async () => {
  const store = await getBlobStore();

  if (store) {
    try {
      const cached = await store.get('latest', { type: 'json' });
      if (cached) {
        const ageH = (Date.now() - new Date(cached.fetchedAt).getTime()) / 3600000;
        if (ageH < REFRESH_HOURS) return json(200, { ...cached, stale: false });
      }
    } catch (e) { console.warn('Blob-Lesen fehlgeschlagen:', e.message); }
  }

  try {
    const fresh = await fetchFromCsu();
    if (store) {
      try { await store.setJSON('latest', fresh); }
      catch (e) { console.warn('Blob-Schreiben fehlgeschlagen:', e.message); }
    }
    return json(200, { ...fresh, stale: false });
  } catch (e) {
    console.error('ČSÚ-Abruf fehlgeschlagen:', e.message);
    if (store) {
      try {
        const cached = await store.get('latest', { type: 'json' });
        if (cached) {
          const ageH = Math.round((Date.now() - new Date(cached.fetchedAt).getTime()) / 3600000);
          return json(200, { ...cached, stale: true, ageHours: ageH, upstreamMessage: e.message });
        }
      } catch (err) { console.warn('Blob-Lesen fehlgeschlagen:', err.message); }
    }
    return json(502, { ok: false, message: 'ČSÚ nicht erreichbar: ' + e.message });
  }
};

function json(statusCode, body, extra) {
  return {
    statusCode,
    headers: Object.assign(
      {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': `public, max-age=1800, s-maxage=${CDN_SECONDS}, stale-while-revalidate=86400`,
      },
      extra || {}
    ),
    body: JSON.stringify(body),
  };
}
