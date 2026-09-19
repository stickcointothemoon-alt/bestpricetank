#!/usr/bin/env node
// scripts/verlauf.js
//
// Schreibt den Preisverlauf fort: data/history.json.
//
// Warum es das gibt: Die Grafik "Preisentwicklung" im Frontend hat ihren
// Verlauf bis September 2026 im localStorage des jeweiligen Geraets gefuehrt
// und fehlende Punkte durch erfundene Startwerte ersetzt (seedPriceHistory).
// Damit sah jeder Besucher eine Kurve, die es nie gegeben hat, und waehrend
// des zweiwoechigen Ausfalls von Dyskont Paliwowy wurden die im Quelltext
// hinterlegten 1,450 EUR viermal taeglich als gemessener Preis weggeschrieben.
//
// Jetzt: EIN gemeinsamer Verlauf auf dem Server, nur aus gemessenen Werten.
//
// Grundsatz: Lieber kein Punkt als ein erfundener. Faellt eine Quelle aus,
// bricht das Skript ohne Eintrag ab. Eine Luecke in der Kurve ist ehrlich,
// ein geschaetzter Wert darin waere es nicht.
//
// Aufruf: node scripts/verlauf.js
// Umgebung: BPT_BASIS (Standard https://bestpricetank.de)

const fs = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const DATEI   = path.join(ROOT, 'data', 'history.json');
const BASIS   = process.env.BPT_BASIS || process.env.URL || 'https://bestpricetank.de';
const UA      = { 'User-Agent': 'BestPriceTank-Verlauf/1.0 (+https://bestpricetank.de)' };

// Bezugspunkt fuer "die naechstgelegene Station": Goerlitz.
const GOERLITZ = { lat: 51.1534, lng: 14.9853 };

// Plausibilitaetsgrenzen in EUR/L. Alles ausserhalb ist keine Preisangabe,
// sondern ein Rueckfallwert oder ein Lesefehler.
const MIN_EUR = 1.20;
const MAX_EUR = 4.00;

// Zwei Laeufe am Tag; alles darunter gilt als derselbe Zeitpunkt und
// ersetzt den vorhandenen Eintrag, statt einen zweiten anzulegen.
const MIN_ABSTAND_MS = 4 * 60 * 60 * 1000;
const MAX_EINTRAEGE  = 800;   // gut ein Jahr bei zwei Laeufen taeglich

const km = (a, b) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

const gueltig = (v) => typeof v === 'number' && isFinite(v) && v >= MIN_EUR && v <= MAX_EUR;
const drei    = (v) => Math.round(v * 1000) / 1000;

async function holen(pfad) {
  const res = await fetch(BASIS + pfad, { headers: UA, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pfad} → HTTP ${res.status}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${pfad} → HTTP ${res.status}, kein JSON`); }
}

// ── Deutschland: guenstigste gemessene Station im Umkreis ───────────────
async function deutschland() {
  const d = await holen('/.netlify/functions/de-prices?lat=51.15&lng=15.00');
  if (!d.ok || !Array.isArray(d.stations)) throw new Error('de-prices: unerwartete Antwort');
  if (d.stale) throw new Error(`de-prices liefert nur den Stand von vor ${d.ageMinutes} Min.`);

  const offen = d.stations.filter((s) => s.isOpen);
  const min = (feld) => {
    const werte = offen.map((s) => s[feld]).filter(gueltig);
    return werte.length ? Math.min(...werte) : null;
  };
  return { diesel: min('diesel'), e5: min('e5'), anzahl: offen.length, stand: d.fetchedAt };
}

// ── Polen: die guenstigste Dyskont-Paliwowy-Station IN DER NAEHE ────────
//
// Nicht die guenstigste im ganzen Land: Am 19.09.2026 war das Nowa Ruda,
// rund 120 km von Zgorzelec entfernt und 10 Groschen billiger - als
// Bezugsgroesse fuers Grenzgebiet die falsche Station.
//
// Aber auch nicht schlicht die naechste: In Zgorzelec stehen zwei
// DP-Stationen, die sich im Preis unterscheiden koennen (am 05.09.2026
// 8,54 und 8,64 PLN). Die guenstigere von beiden ist der Bezugspunkt,
// weil die Seite genau diesen Preis als erreichbar ausweist.
const NAH_KM = 25;

async function polen() {
  const d = await holen('/.netlify/functions/dp-prices');
  if (d.status !== 'success' || !Array.isArray(d.stations)) {
    throw new Error('dp-prices: ' + (d.message || 'unerwartete Antwort'));
  }
  const mitOrt = d.stations
    .filter((s) => gueltig(s.diesel) && isFinite(s.lat) && isFinite(s.lng))
    .map((s) => ({ s, entfernung: km(GOERLITZ, { lat: +s.lat, lng: +s.lng }) }));

  if (!mitOrt.length) throw new Error('dp-prices: keine brauchbare Station');
  const nah = mitOrt.filter((x) => x.entfernung <= NAH_KM);
  const { s, entfernung } = nah.length
    ? nah.sort((a, b) => a.s.diesel - b.s.diesel)[0]
    : mitOrt.sort((a, b) => a.entfernung - b.entfernung)[0];
  return {
    diesel: s.diesel,
    e5: gueltig(s.e5) ? s.e5 : null,
    station: s.name,
    entfernung: Math.round(entfernung * 10) / 10,
    pln: s.diesel_pln ?? s.dieselPln ?? null,
    kurs: d.pln_eur_rate ?? null,
    stand: d.data_timestamp,
  };
}

// ── Tschechien: Landesdurchschnitt, nur als Beiwerk ─────────────────────
async function tschechien() {
  try {
    const d = await holen('/.netlify/functions/cz-prices');
    const v = d.diesel ?? d.diesel_eur ?? null;
    return gueltig(v) ? v : null;
  } catch { return null; }
}

function lesen() {
  try {
    const roh = JSON.parse(fs.readFileSync(DATEI, 'utf8'));
    const liste = Array.isArray(roh) ? roh : roh.eintraege;
    return Array.isArray(liste) ? liste : [];
  } catch { return []; }
}

(async () => {
  let de, pl, cz;
  try {
    [de, pl] = await Promise.all([deutschland(), polen()]);
    cz = await tschechien();
  } catch (e) {
    console.error('✗ Kein Eintrag:', e.message);
    console.error('  Eine Luecke im Verlauf ist ehrlicher als ein geschaetzter Punkt.');
    process.exit(2);
  }

  if (!gueltig(de.diesel) || !gueltig(pl.diesel)) {
    console.error('✗ Kein Eintrag: Diesel fehlt oder liegt ausserhalb des plausiblen Bereichs',
                  `(DE ${de.diesel}, PL ${pl.diesel})`);
    process.exit(2);
  }
  // Polen guenstiger als Deutschland ist die Regel; das Gegenteil waere
  // bemerkenswert, ein Abstand von mehr als 60 Cent dagegen ein Fehler.
  if (de.diesel - pl.diesel > 0.60) {
    console.error(`✗ Kein Eintrag: Abstand DE/PL unglaubwuerdig gross `
                  + `(${de.diesel} vs ${pl.diesel}). Sieht nach einem Rueckfallwert aus.`);
    process.exit(2);
  }

  const eintrag = {
    ts: new Date().toISOString(),
    de_diesel: drei(de.diesel),
    de_e5: gueltig(de.e5) ? drei(de.e5) : null,
    pl_diesel: drei(pl.diesel),
    pl_e5: pl.e5 ? drei(pl.e5) : null,
    cz_diesel: cz ? drei(cz) : null,
    pl_station: pl.station,
    pl_km: pl.entfernung,
    de_anzahl: de.anzahl,
  };

  const verlauf = lesen();
  const letzter = verlauf[verlauf.length - 1];
  const abstand = letzter ? Date.parse(eintrag.ts) - Date.parse(letzter.ts) : Infinity;

  if (abstand < MIN_ABSTAND_MS) {
    verlauf[verlauf.length - 1] = eintrag;
    console.log(`↻ Letzten Eintrag ersetzt (nur ${Math.round(abstand / 60000)} Min. alt)`);
  } else {
    verlauf.push(eintrag);
    console.log('+ Neuer Eintrag');
  }

  const gekuerzt = verlauf.slice(-MAX_EINTRAEGE);
  fs.mkdirSync(path.dirname(DATEI), { recursive: true });
  fs.writeFileSync(DATEI, JSON.stringify(gekuerzt, null, 1) + '\n');

  console.log(`  DE ${eintrag.de_diesel} €/L  (günstigste von ${de.anzahl} Stationen)`);
  console.log(`  PL ${eintrag.pl_diesel} €/L  (${pl.station}, ${pl.entfernung} km)`);
  if (eintrag.cz_diesel) console.log(`  CZ ${eintrag.cz_diesel} €/L  (Landesdurchschnitt)`);
  console.log(`  Unterschied: ${drei(eintrag.de_diesel - eintrag.pl_diesel)} €/L`);
  console.log(`✅ ${gekuerzt.length} Einträge in data/history.json`);
})();
