#!/usr/bin/env node
// scripts/pruefen.js
//
// Prueft die Ortsseiten auf Behauptungen, die wir nicht belegen koennen.
//
// Warum es das gibt: Auf diesen Seiten haben sich ueber Monate Zahlen und
// Namen angesammelt, die irgendwann einmal jemand eingetippt hat und die
// seitdem niemand mehr angefasst hat - "40 ct sparen", "bundesweit (ADAC)",
// "8 bis 12 Euro Fahrtkosten", "Lotos Slubice". Einzeln faellt so etwas
// nicht auf. Zusammen sind es Dutzende.
//
// Das Skript findet sie nicht alle. Es findet die Muster, die bisher
// aufgetreten sind - und faengt damit wenigstens die Wiederholungstaeter.
//
// Aufruf:  node scripts/pruefen.js          (Kurzfassung)
//          node scripts/pruefen.js --alles  (jeder Fund einzeln)
//
// Endet mit Code 1, wenn ein SCHWER-Befund dabei ist.

const fs = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const ALLES = process.argv.includes('--alles');

// ── Was wir ueber die Wirklichkeit wissen ───────────────────────────
//
// Marken, die es an polnischen Zapfsaeulen nicht mehr gibt. Eine Station
// mag dort stehen - unter diesem Namen findet sie aber niemand mehr.
const TOTE_MARKEN = {
  'Lotos':   'Orlen hat die Marke im Januar 2023 abgewickelt; 417 Stationen gingen an MOL.',
  'Bliska':  'Discountmarke von Orlen, wurde bis 2018 auf Orlen umgestellt.',
  'Statoil': 'In Polen seit 2016 Circle K.',
  'CPN':     'Vorgaenger von Orlen, seit den 1990ern verschwunden.',
  'Neste':   'Polnisches Tankstellennetz 2014 an Shell verkauft.',
};

// Quellen, die wir nennen duerfen, weil wir sie wirklich abrufen.
const ECHTE_QUELLEN = ['Tankerkönig', 'MTS-K', 'Dyskont Paliwowy', 'Citronex',
                       'Polnische Nationalbank', 'NBP', 'ČSÚ', 'Tschechisches Statistikamt',
                       'OpenStreetMap', 'Open-Meteo', 'OpenChargeMap', 'Autobahn GmbH'];
const ERFUNDENE_QUELLEN = ['ADAC', 'ExchangeRate-API', 'Statista', 'clever-tanken',
                           'benzinpreis.de', 'mehr-tanken'];

// Der Benchmark ist eine gemessene Dyskont-Paliwowy-Station. Ein Aufschlag
// von 0,000 sagt: "diese Station kostet genau so viel wie der Discounter".
// Bei einer DP-Station stimmt das per Definition. Bei einer Markentankstelle
// ist es eine Behauptung ohne Grundlage - und weil build-pages.js den
// kleinsten Aufschlag der Seite fuer die Ersparnis-Ueberschrift nimmt,
// haengt daran gleich die groesste Zahl der Seite.
const BENCHMARK_MARKEN = ['Dyskont Paliwowy', 'Polen, Grenzgebiet'];

const befunde = [];
const melde = (schwere, datei, was, zeile, rat) =>
  befunde.push({ schwere, datei, was, zeile, rat });

const zeileVon = (text, index) => text.slice(0, index).split('\n').length;
// Script, Style und Kommentare unsichtbar machen, ohne die Datei zu
// verkuerzen: sonst zeigt der Bericht Zeilennummern an, die es in der
// Datei gar nicht gibt, und man sucht sich dumm.
//
// Ausgenommen: application/ld+json. Das ist kein Code, das liest Google
// und zeigt es in den Suchergebnissen an. Beim ersten Lauf hat der Pruefer
// genau deshalb die Bliska-FAQ im JSON-LD uebersehen - sie stand in einem
// <script>-Block und war damit fuer ihn unsichtbar.
const maskieren = (h) =>
  h.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
            (t, attr) => (attr && /ld\+json/i.test(attr)) ? t : t.replace(/[^\n]/g, ' '));

function pruefeSeite(datei) {
  const voll = fs.readFileSync(path.join(ROOT, datei), 'utf8');
  const txt  = maskieren(voll);

  // ── 1. Tote Marken ────────────────────────────────────────────────
  for (const [marke, grund] of Object.entries(TOTE_MARKEN)) {
    const re = new RegExp(`\\b${marke}\\b`, 'g');
    let m;
    while ((m = re.exec(txt))) {
      melde('SCHWER', datei, `Marke "${marke}" existiert nicht mehr`, zeileVon(txt, m.index), grund);
    }
  }

  // ── 2. Erfundene Quellenangaben ───────────────────────────────────
  for (const q of ERFUNDENE_QUELLEN) {
    let i = txt.indexOf(q);
    while (i !== -1) {
      melde('SCHWER', datei, `Quelle "${q}" genannt, die wir nicht abrufen`, zeileVon(txt, i),
            'Nur nennen, was wirklich abgefragt wird: ' + ECHTE_QUELLEN.slice(0, 4).join(', ') + ' …');
      i = txt.indexOf(q, i + 1);
    }
  }

  // ── 3. Aufschlag 0,000 auf einer Markentankstelle ─────────────────
  const stationen = [...voll.matchAll(
    /<div class="st-name">([\s\S]*?)<\/div>[\s\S]{0,400}?data-aufschlag="(-?[\d.]+)"/g)];
  for (const m of stationen) {
    const name = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (parseFloat(m[2]) !== 0) continue;
    if (BENCHMARK_MARKEN.some((b) => name.includes(b))) continue;
    melde('SCHWER', datei, `"${name}" steht mit Aufschlag 0,000 auf dem Discounterpreis`,
          zeileVon(voll, m.index),
          'Eine Markentankstelle ist nicht so guenstig wie der Discounter. '
          + 'Daran haengt ueber ORT_ERSPARNIS_* auch die Ueberschrift der Seite.');
  }

  // ── 4. Feste Preis- und Ersparnisangaben ausserhalb der Platzhalter ─
  // Erst die Platzhalter wegnehmen, dann suchen - sonst meldet jede
  // korrekt gebaute Zeile einen Treffer.
  const ohneToken = txt.replace(/\{\{[A-Z0-9_]+\}\}/g, '\u0000');
  const geldMuster = [
    [/(\d+[.,]\d{2,3})\s*(?:€|EUR)(?!\s*\/\s*L?\s*<)/g, 'Eurobetrag'],
    [/(?<![\d,.])(\d{1,3})\s*(?:ct|Cent)\b/g,           'Centangabe'],
  ];
  for (const [re, art] of geldMuster) {
    let m;
    while ((m = re.exec(ohneToken))) {
      const um = ohneToken.slice(Math.max(0, m.index - 70), m.index + 70)
                          .replace(/\s+/g, ' ').replace(/\u0000/g, '{{…}}');
      // Gesetzliche und geographische Konstanten sind keine Preise.
      if (/20 Liter|Kanister|§|DSGVO|Oktan|E5|E10|Pb9/.test(um)) continue;
      melde('PRUEFEN', datei, `Feste ${art}: "${m[1]}"`, zeileVon(ohneToken, m.index),
            '… ' + um.trim() + ' …');
    }
  }

  // ── 5. Abzeichen auf einem geschaetzten Preis ──────────────────────
  const badges = [...voll.matchAll(/st-best-badge[^>]*>([^<]*)</g)];
  if (badges.length && /Schätzung/.test(voll)) {
    const echt = /data-aufschlag="0\.000"[\s\S]{0,200}?Dyskont Paliwowy/.test(voll)
              || BENCHMARK_MARKEN.some((b) => new RegExp(`${b}[\\s\\S]{0,300}?st-best-badge`).test(voll));
    if (!echt) {
      melde('PRUEFEN', datei, `Abzeichen "${badges[0][1].trim()}" auf einem geschätzten Preis`,
            zeileVon(voll, badges[0].index),
            'Die Rangfolge kommt aus den Aufschlaegen, nicht aus Messwerten.');
    }
  }

  // ── 6. Widerspruch: derselbe Wert zweimal verschieden beschrieben ──
  if (/Deutschland\s*Ø/.test(txt) && /günstigste/i.test(txt)) {
    melde('PRUEFEN', datei, 'Auf derselben Seite "Deutschland Ø" und "günstigste"',
          zeileVon(txt, txt.search(/Deutschland\s*Ø/)),
          'DE_DIESEL ist ein Minimum, kein Durchschnitt.');
  }
}

// ── Lauf ────────────────────────────────────────────────────────────
const seiten = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.html') && !f.startsWith('_'))
  .sort();

seiten.forEach(pruefeSeite);

const schwer  = befunde.filter((b) => b.schwere === 'SCHWER');
const pruefen = befunde.filter((b) => b.schwere === 'PRUEFEN');

function ausgeben(liste, titel) {
  if (!liste.length) return;
  console.log(`\n${titel} (${liste.length})`);
  console.log('─'.repeat(72));
  const proSeite = {};
  liste.forEach((b) => (proSeite[b.datei] = proSeite[b.datei] || []).push(b));
  for (const [datei, bs] of Object.entries(proSeite)) {
    console.log(`\n  ${datei}`);
    const zeigen = ALLES ? bs : bs.slice(0, 6);
    zeigen.forEach((b) => {
      console.log(`    Z.${String(b.zeile).padStart(4)}  ${b.was}`);
      if (b.rat) console.log(`             ${b.rat}`);
    });
    if (!ALLES && bs.length > 6) console.log(`    … und ${bs.length - 6} weitere (--alles)`);
  }
}

console.log(`Geprüft: ${seiten.length} Seiten`);
ausgeben(schwer,  '❌ SCHWER — falsche Angabe, gehört raus');
ausgeben(pruefen, '⚠  PRÜFEN — kann stimmen, ist aber nicht abgeleitet');

if (!befunde.length) console.log('\n✅ Nichts gefunden.');
else console.log(`\n${schwer.length} schwer · ${pruefen.length} zu prüfen`);

process.exit(schwer.length ? 1 : 0);
