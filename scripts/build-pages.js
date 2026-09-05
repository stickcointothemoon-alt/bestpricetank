#!/usr/bin/env node
// scripts/build-pages.js
//
// Schreibt die Live-Preise beim Deploy in die statischen Seiten.
//
// Warum das nötig ist: Die Unterseiten sind reines HTML ohne JavaScript-Abruf.
// Sie trugen deshalb monatelang Aprilpreise unter Überschriften mit "heute".
// Google liest ausserdem Title und Meta-Description aus dem ausgelieferten
// HTML - was JavaScript spaeter daraus macht, zaehlt dort nicht.
//
// Ablauf:
//   1. Preise bei den Quellen holen (dieselben wie die Netlify Functions).
//   2. Gelingt das, wird data/live.json geschrieben und verwendet.
//      Gelingt es nicht, wird das zuletzt geschriebene data/live.json
//      verwendet und die Seiten weisen dessen Datum aus.
//   3. Platzhalter {{...}} in allen HTML-Dateien ersetzen.
//   4. Bleibt ein Platzhalter uebrig, bricht der Build ab - lieber kein
//      Deploy als eine Seite mit sichtbaren {{Platzhaltern}}.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, 'data', 'live.json');
const UA = { 'User-Agent': 'BestPriceTank-Build/1.0 (+https://bestpricetank.de)' };

const eur = (v) => v.toFixed(3).replace('.', ',');
const eur2 = (v) => v.toFixed(2).replace('.', ',');
const loc = (v, d = 2) => v.toFixed(d).replace('.', ',');

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(12000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${url} → HTTP ${res.status}, kein JSON`); }
}

// ── Wechselkurse: Polnische Nationalbank ─────────────────────────────
async function rates() {
  const [e, c] = await Promise.all([
    getJson('https://api.nbp.pl/api/exchangerates/rates/a/eur/last/1/?format=json'),
    getJson('https://api.nbp.pl/api/exchangerates/rates/a/czk/last/1/?format=json'),
  ]);
  const pln = e?.rates?.[0]?.mid, czkPln = c?.rates?.[0]?.mid;
  if (!pln || !czkPln) throw new Error('NBP: Kurs fehlt');
  return { pln: +pln.toFixed(4), czk: +(pln / czkPln).toFixed(4) };
}

// ── Deutschland: Tankerkönig ─────────────────────────────────────────
async function de() {
  const key = process.env.TK_KEY || process.env.TK_API_KEY;
  if (!key) throw new Error('TK_KEY nicht gesetzt');
  const d = await getJson(
    'https://creativecommons.tankerkoenig.de/json/list.php' +
    `?lat=51.15&lng=14.99&rad=25&sort=dist&type=all&apikey=${key}`,
    { Accept: 'application/json', Referer: 'https://bestpricetank.de/' }
  );
  if (!d.ok || !Array.isArray(d.stations)) throw new Error('Tankerkönig: unerwartete Antwort');
  const open = d.stations.filter((s) => s.isOpen);
  const min = (f) => Math.min(...open.map((s) => s[f]).filter((v) => v > 0.3 && v < 5));
  return { diesel: min('diesel'), e5: min('e5'), e10: min('e10'), count: open.length };
}

// ── Polen: Dyskont Paliwowy ──────────────────────────────────────────
// Nur Stationen im Grenzumkreis. Die landesweit guenstigste liegt teils
// ueber 250 km entfernt - fuer eine Grenzfahrt ist ihr Preis wertlos.
const GOERLITZ = { lat: 51.1534, lng: 14.9853 };
const UMKREIS_KM = 60;

function km(a, b) {
  const R = 6371, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function pl(plnRate) {
  const key = process.env.DP_API_KEY;
  if (!key) throw new Error('DP_API_KEY nicht gesetzt');
  const d = await getJson('https://api.dyskontpaliwowy.pl/api/v1/station-prices', { 'X-API-Key': key });
  if (d.status !== 'success' || !Array.isArray(d.stations)) throw new Error('DP: unerwartete Antwort');

  const nah = d.stations
    .filter((s) => s.is_active && s.coordinates?.lat && s.prices?.ON > 3 && s.prices.ON < 15)
    .map((s) => ({
      name: s.name, city: s.city,
      onPln: s.prices.ON, pbPln: s.prices.PB95 > 3 ? s.prices.PB95 : null,
      entfernung: +km(GOERLITZ, { lat: s.coordinates.lat, lng: s.coordinates.lng }).toFixed(1),
    }))
    .filter((s) => s.entfernung <= UMKREIS_KM)
    .sort((a, b) => a.onPln - b.onPln);

  if (!nah.length) throw new Error(`DP: keine Station innerhalb ${UMKREIS_KM} km`);
  const on = nah.map((s) => s.onPln);
  const pb = nah.map((s) => s.pbPln).filter(Boolean);

  return {
    dieselPln: Math.min(...on), dieselPlnMax: Math.max(...on),
    e10Pln: pb.length ? Math.min(...pb) : null,
    diesel: Math.min(...on) / plnRate,
    dieselMax: Math.max(...on) / plnRate,
    e10: pb.length ? Math.min(...pb) / plnRate : null,
    count: nah.length,
    stationen: nah.slice(0, 5).map((s) => ({ ...s, eur: s.onPln / plnRate })),
  };
}

// ── Tschechien: ČSÚ-Wochendurchschnitt ───────────────────────────────
async function cz(czkRate) {
  const res = await fetch('https://data.csu.gov.cz/opendata/sady/CENPHMT/distribuce/csv',
    { headers: { ...UA, Accept: 'text/csv' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`ČSÚ → HTTP ${res.status}`);
  const rows = (await res.text()).split(/\r?\n/).slice(1).filter(Boolean)
    .map((l) => l.split(',').map((x) => x.replace(/^"|"$/g, '')))
    .filter((c) => c.length >= 9 && c[0].startsWith('Průměrná cena'));
  const week = rows.reduce((m, c) => (c[7] > m ? c[7] : m), '');
  const pick = (name) => {
    const r = rows.find((c) => c[7] === week && c[2] === name);
    return r ? parseFloat(r[8]) : null;
  };
  const dieselCzk = pick('Motorová nafta');
  if (!dieselCzk) throw new Error('ČSÚ: keine Dieselzeile');
  return { dieselCzk, diesel: dieselCzk / czkRate, week: week.replace(/^(\d{4})-W(\d+)$/, 'KW $2/$1') };
}

// Jede Quelle einzeln. Klemmt eine, werden die anderen trotzdem
// aktualisiert und nur der fehlende Teil kommt aus dem letzten Stand.
async function collect(vorher) {
  const quellen = {};
  const hole = async (name, fn, rueckfall) => {
    try {
      const v = await fn();
      quellen[name] = 'frisch';
      return v;
    } catch (e) {
      console.warn(`   ⚠ ${name}: ${e.message}`);
      if (!rueckfall) throw new Error(`${name} fehlgeschlagen und kein Rückfall vorhanden`);
      quellen[name] = 'aus dem letzten Stand';
      return rueckfall;
    }
  };

  const r = await hole('Wechselkurse (NBP)', rates, vorher?.kurse);
  const [d, p, c] = await Promise.all([
    hole('Tankerkönig (DE)', () => de(), vorher?.de),
    hole('Dyskont Paliwowy (PL)', () => pl(r.pln), vorher?.pl),
    hole('ČSÚ (CZ)', () => cz(r.czk), vorher?.cz),
  ]);

  return {
    stand: new Date().toISOString(),
    quellen,
    kurse: r, de: d, pl: p, cz: c,
    ersparnisProLiter: d.diesel - p.diesel,
  };
}

function tokens(x) {
  const stand = new Date(x.stand);
  const dd = String(stand.getDate()).padStart(2, '0');
  const mm = String(stand.getMonth() + 1).padStart(2, '0');
  return {
    STAND: `${dd}.${mm}.${stand.getFullYear()}`,
    STAND_KURZ: `${dd}.${mm}.`,
    STAND_ISO: x.stand.slice(0, 10),
    KURS_PLN: loc(x.kurse.pln),
    KURS_CZK: loc(x.kurse.czk),
    DE_DIESEL: eur(x.de.diesel),
    DE_E10: eur(x.de.e10),
    DE_E5: eur(x.de.e5),
    PL_DIESEL: eur(x.pl.diesel),
    PL_DIESEL_PLN: loc(x.pl.dieselPln),
    PL_DIESEL_SPANNE: `${eur2(x.pl.diesel)}–${eur2(x.pl.dieselMax)}`,
    PL_E10: x.pl.e10 ? eur(x.pl.e10) : eur(x.pl.diesel),
    PL_E10_PLN: x.pl.e10Pln ? loc(x.pl.e10Pln) : loc(x.pl.dieselPln),
    PL_ANZAHL: String(x.pl.count),
    CZ_DIESEL: eur(x.cz.diesel),
    CZ_DIESEL_CZK: loc(x.cz.dieselCzk),
    CZ_WOCHE: x.cz.week,
    ERSPARNIS_LITER: eur2(x.ersparnisProLiter),
    ERSPARNIS_CENT: String(Math.round(x.ersparnisProLiter * 100)),
    ERSPARNIS_60L: eur2(x.ersparnisProLiter * 60),
    TABELLE_PL: tabelle(x.pl.stationen || []),
  };
}

// Erzeugt die Zeilen der Preistabelle aus echten Stationen.
function tabelle(st) {
  if (!st.length) return '<div class="prow"><div>Derzeit keine Preise abrufbar.</div><div></div><div></div></div>';
  return st.map((s, i) => `<div class="prow">
        <div><div class="st-name">🇵🇱 ${esc(s.name)}${i === 0 ? ' <span class="st-badge">günstigste</span>' : ''}</div>
          <div class="st-meta">${esc(s.city || '')} · gemessener Stationspreis</div></div>
        <div class="price">${eur(s.eur)} €<span class="pln">${loc(s.onPln)} zł/L</span></div>
        <div class="price st-cell-3">${loc(s.entfernung, 1)} km</div>
      </div>`).join('\n      ');
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  const vorher = fs.existsSync(LIVE) ? JSON.parse(fs.readFileSync(LIVE, 'utf8')) : null;
  let data, frisch = true;
  try {
    data = await collect(vorher);
    fs.mkdirSync(path.dirname(LIVE), { recursive: true });
    fs.writeFileSync(LIVE, JSON.stringify(data, null, 2));
    const q = Object.entries(data.quellen).map(([k, v]) => `${k}: ${v}`).join(' · ');
    console.log('✅ Quellen — ' + q);
    frisch = Object.values(data.quellen).every((v) => v === 'frisch');
  } catch (e) {
    frisch = false;
    console.warn('⚠ Abruf fehlgeschlagen:', e.message);
    if (!vorher) {
      console.error('❌ Und kein data/live.json als Rückfall vorhanden. Build abgebrochen.');
      process.exit(1);
    }
    data = vorher;
    console.warn(`⚠ Verwende durchgehend den Stand vom ${data.stand}`);
  }

  const t = tokens(data);
  console.log(`   DE ${t.DE_DIESEL} € · PL ${t.PL_DIESEL} € (${t.PL_DIESEL_PLN} zł) · CZ ${t.CZ_DIESEL} € (${t.CZ_DIESEL_CZK} Kč)`);
  console.log(`   Ersparnis ${t.ERSPARNIS_LITER} €/L · ${t.ERSPARNIS_60L} € auf 60 L · Kurs ${t.KURS_PLN}`);

  // Ausgabe in dist/. Die Quelldateien behalten ihre Platzhalter, sonst
  // gaebe es beim zweiten Build nichts mehr zu ersetzen.
  const DIST = path.join(ROOT, 'dist');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const UEBERSPRINGEN = new Set(['dist', 'node_modules', '.git', '.github', 'scripts', 'netlify']);
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (UEBERSPRINGEN.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(DIST, e.name), { recursive: true });
  }

  let ersetzt = 0;
  const seiten = fs.readdirSync(DIST).filter((f) => f.endsWith('.html'));
  for (const f of seiten) {
    const ziel = path.join(DIST, f);
    let s = fs.readFileSync(ziel, 'utf8');

    // Stationspreise auf den Ortsseiten: Benchmark plus dem im HTML
    // hinterlegten Aufschlag. Dasselbe Modell wie in der Anwendung.
    s = s.replace(/data-aufschlag="(-?[\d.]+)">\{\{PL_STATION\}\}/g, (m, off) => {
      const v = data.pl.diesel + parseFloat(off);
      ersetzt++;
      return `data-aufschlag="${off}">${eur(v)}`;
    });

    s = s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
      if (!(k in t)) { console.error(`❌ Unbekannter Platzhalter ${m} in ${f}`); process.exit(1); }
      ersetzt++;
      return t[k];
    });
    const rest = s.match(/\{\{[A-Z0-9_]+\}\}/g);
    if (rest) { console.error(`❌ Nicht ersetzt in ${f}: ${rest.join(', ')}`); process.exit(1); }
    fs.writeFileSync(ziel, s);
  }
  console.log(`✅ ${ersetzt} Werte in ${seiten.length} Seiten → dist/${frisch ? '' : '  (aus dem Rückfall)'}`);
})();
