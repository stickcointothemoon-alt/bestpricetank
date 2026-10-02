#!/usr/bin/env node
// scripts/live-pruefen.js
//
// Prueft, ob die LIVE-Seite frische Preise ausliefert.
//
// Warum es das gibt: Vom 22.09. bis 02.10.2026 hat Netlify jeden Build
// sauber durchgefuehrt, aber keinen davon veroeffentlicht ("Auto publishing"
// war abgeschaltet). Der Preisverlauf wuchs im Repository auf 24 Punkte,
// live blieben es 4, und die Seiten trugen zehn Tage lang dieselben Preise
// unter der Ueberschrift "heute". Alle GitHub-Laeufe waren gruen, weil sie
// nur pruefen, ob der Build ANGESTOSSEN wurde - nicht, ob er ankommt.
//
// Dieses Skript schaut deshalb von aussen auf die fertige Seite, so wie
// ein Besucher oder Google sie sieht. Zwei Pruefungen:
//
//   1. Alter: Der neueste Punkt in /data/history.json darf hoechstens
//      MAX_ALTER_STD Stunden alt sein.
//   2. Gleichstand: Hat das Repository einen neueren Punkt als die Live-
//      Seite, und ist der schon aelter als VEROEFFENTLICHT_NACH_STD, dann
//      wurde gebaut, aber nicht veroeffentlicht - genau der Fehler von oben.
//   3. Quellen (seit 02.10.2026): /data/live.json fuehrt je Quelle die Zeit
//      ihrer letzten erfolgreichen Lieferung. Polen und Deutschland duerfen
//      hoechstens MAX_ALTER_STD alt sein. NBP und ČSÚ werden nur berichtet:
//      die NBP veroeffentlicht nur werktags, die ČSÚ nur woechentlich.
//
// Endet mit Code 1, wenn etwas nicht stimmt. Dann wird der GitHub-Lauf rot,
// und GitHub schickt eine Mail.
//
// Aufruf: node scripts/live-pruefen.js
// Umgebung: BPT_BASIS (Standard https://bestpricetank.de)
//           BPT_REPO_DATEI (nur zum Testen)

const fs = require('fs');
const path = require('path');

const BASIS = process.env.BPT_BASIS || 'https://bestpricetank.de';
// BPT_REPO_DATEI nur zum Testen; im Workflow gilt der Standard.
const REPO_DATEI = process.env.BPT_REPO_DATEI || path.join(__dirname, '..', 'data', 'history.json');

// Der Verlauf bekommt zwei Punkte am Tag. GitHub startet geplante Laeufe
// aber oft Stunden zu spaet (05:10 UTC geplant, tatsaechlich meist gegen
// 10-11 UTC), so dass zwischen zwei Punkten bis zu rund 15 Stunden liegen.
// Faellt ein Lauf aus, weil eine Preisquelle klemmt (verlauf.js schreibt
// dann bewusst keinen Punkt), werden es rund 25 Stunden. 30 Stunden lassen
// einen solchen Ausfall zu und schlagen beim zweiten an.
const MAX_ALTER_STD = 30;

// Der Build nach einem neuen Punkt dauert rund zehn Sekunden. Drei Stunden
// sind reichlich Puffer, bevor "nicht veroeffentlicht" als Fehler gilt.
const VEROEFFENTLICHT_NACH_STD = 3;

const STD = 60 * 60 * 1000;

function neuester(liste) {
  const zeiten = (Array.isArray(liste) ? liste : [])
    .map((e) => Date.parse(e && e.ts))
    .filter((t) => isFinite(t));
  return zeiten.length ? Math.max(...zeiten) : null;
}

const zeit = (t) => new Date(t).toLocaleString('de-DE', {
  timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
}) + ' Uhr';

function bericht(zeilen) {
  const text = zeilen.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); } catch {}
  }
}

(async () => {
  const jetzt = Date.now();
  const fehler = [];

  // Live-Stand. Der Zeitstempel in der Adresse umgeht jeden Zwischenspeicher.
  let live = null;
  try {
    const res = await fetch(`${BASIS}/data/history.json?pruefung=${jetzt}`, {
      headers: { 'User-Agent': 'BestPriceTank-Livepruefung/1.0 (+https://bestpricetank.de)',
                 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    live = neuester(await res.json());
    if (live === null) throw new Error('keine gueltigen Eintraege');
  } catch (e) {
    fehler.push(`Die Live-Seite liefert keinen lesbaren Preisverlauf (${e.message}).`);
  }

  // Stand im Repository (vom Checkout).
  let repo = null;
  try { repo = neuester(JSON.parse(fs.readFileSync(REPO_DATEI, 'utf8'))); } catch {}

  if (live !== null) {
    const alter = (jetzt - live) / STD;
    if (alter > MAX_ALTER_STD) {
      fehler.push(`Der neueste Preis auf der Live-Seite ist ${Math.round(alter)} Stunden alt `
                + `(${zeit(live)}). Erlaubt sind ${MAX_ALTER_STD} Stunden.`);
    }
    if (repo !== null && repo > live && (jetzt - repo) / STD > VEROEFFENTLICHT_NACH_STD) {
      fehler.push(`Im Repository steht ein neuerer Preis (${zeit(repo)}) als auf der `
                + `Live-Seite (${zeit(live)}). Netlify hat gebaut, aber nicht veroeffentlicht. `
                + `Pruefen: Netlify → Deploys → "Auto publishing" aktiv? Credits ausreichend?`);
    }
  }

  // Quellen einzeln, aus dem live.json des letzten Builds.
  const quellZeilen = [];
  try {
    const res = await fetch(`${BASIS}/data/live.json?pruefung=${jetzt}`, {
      headers: { 'User-Agent': 'BestPriceTank-Livepruefung/1.0 (+https://bestpricetank.de)',
                 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lj = await res.json();
    const z = lj.zeiten || {};
    // Ein live.json von vor dem 02.10.2026 kennt nur den gemeinsamen Stand.
    for (const [key, name] of [['pl', 'Polen (Dyskont Paliwowy)'], ['de', 'Deutschland (Tankerkönig)']]) {
      const t = Date.parse(z[key] || lj.stand);
      if (!isFinite(t)) { fehler.push(`${name}: kein Zeitstempel in /data/live.json.`); continue; }
      const alter = (jetzt - t) / STD;
      quellZeilen.push(`- ${name}: ${zeit(t)} (${Math.round(alter)} h)`);
      if (alter > MAX_ALTER_STD) {
        fehler.push(`${name}: Die Preise auf der Seite sind ${Math.round(alter)} Stunden alt `
                  + `(${zeit(t)}). Die Quelle war beim Bauen offenbar mehrfach nicht erreichbar.`);
      }
    }
    if (lj.kurse?.datum) quellZeilen.push(`- NBP-Kurs: ${lj.kurse.pln} zł/€ vom ${lj.kurse.datum}`);
    if (lj.cz?.week) quellZeilen.push(`- Tschechien (ČSÚ): ${lj.cz.week}`);
  } catch (e) {
    quellZeilen.push(`- /data/live.json nicht lesbar (${e.message})`);
  }

  const zeilen = ['## Live-Prüfung bestpricetank.de', ''];
  zeilen.push(`- Neuester Preis live: ${live !== null ? zeit(live) : '—'}`);
  zeilen.push(`- Neuester Preis im Repository: ${repo !== null ? zeit(repo) : '—'}`);
  zeilen.push('', '**Quellen im letzten Build:**', '', ...quellZeilen);
  zeilen.push('');
  if (fehler.length) {
    zeilen.push('### ❌ Die Live-Seite ist nicht aktuell', '');
    fehler.forEach((f) => zeilen.push(`- ${f}`));
    bericht(zeilen);
    fehler.forEach((f) => console.log(`::error::${f}`));
    process.exit(1);
  }
  zeilen.push('### ✅ Live-Seite ist aktuell');
  bericht(zeilen);
})();
