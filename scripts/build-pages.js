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
// Echtes Minuszeichen, nicht der Bindestrich.
const minus = (v) => eur2(v).replace(/^-/, '\u2212');

// Eine Spanne "von bis". Zwei Sonderfaelle, beide schon aufgetreten:
//   - Beide Enden runden auf denselben Wert (kurze Strecken): dann nur
//     eine Zahl, nicht "0,86-0,86".
//   - Ein Ende ist negativ (Fahrt teurer als die Ersparnis): dann "bis"
//     statt Gedankenstrich, sonst steht da "\u22125,51\u2013\u22123,05" und niemand
//     erkennt noch, was Trennzeichen und was Vorzeichen ist.
function spanne(a, b, f = minus) {
  const x = f(a), y = f(b);
  if (x === y) return x;
  return (a < 0 || b < 0) ? `${x} bis ${y}` : `${x}\u2013${y}`;
}

// Annahme fuer die Fahrtkosten, auf den Seiten offengelegt.
const VERBRAUCH_MIN = 6;   // Liter Diesel je 100 km
const VERBRAUCH_MAX = 8;

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
  // effectiveDate: der Tag, fuer den die NBP den Kurs festgesetzt hat.
  // Das ist das Datum, das zaehlt - nicht der Zeitpunkt unseres Abrufs.
  // Am Wochenende und an Feiertagen veroeffentlicht die NBP nichts, dann
  // bleibt der letzte Werktagskurs gueltig.
  const datum = e?.rates?.[0]?.effectiveDate || null;
  return { pln: +pln.toFixed(4), czk: +(pln / czkPln).toFixed(4), datum };
}

// ── Deutschland: Tankerkönig ─────────────────────────────────────────
// Bevorzugt ueber die eigene Function de-prices, weil die einen
// Zwischenspeicher in Netlify Blobs und eine Wiederholung hat.
// Tankerkoenig drosselt Direktabrufe aus dem Rechenzentrum mit HTTP 503 -
// der Build lief deshalb regelmaessig in den Rueckfall.
function auswerten(stationen) {
  const offen = stationen.filter((s) => s.isOpen);
  if (!offen.length) throw new Error('keine geoeffnete Station');
  const min = (f) => Math.min(...offen.map((s) => s[f]).filter((v) => v > 0.3 && v < 5));
  return { diesel: min('diesel'), e5: min('e5'), e10: min('e10'), count: offen.length };
}

// Vollstaendige Stationsliste als Notvorrat fuer de-prices ablegen.
// Netlify Blobs steht nicht auf jeder Seite zur Verfuegung; diese Datei
// liegt statisch im Deploy und ist damit immer erreichbar.
function notvorratSchreiben(stationen) {
  try {
    fs.mkdirSync(path.dirname(LIVE), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'data', 'de-stations.json'),
      JSON.stringify({ ok: true, fetchedAt: new Date().toISOString(), stations: stationen }, null, 2));
  } catch (e) { console.warn('   · Notvorrat nicht schreibbar:', e.message); }
}

// Bis zum 02.10.2026 galt jede Antwort von de-prices als frisch - auch
// eine aus dem Zwischenspeicher (bis 12 Stunden alt) oder aus dem
// Notvorrat. Der Build stempelte ihr dann die aktuelle Uhrzeit auf. Jetzt
// traegt ein gespeicherter Stand seine eigene Abrufzeit (__zeit), und es
// wird zuerst noch Tankerkoenig direkt versucht.
async function de() {
  const basis = process.env.URL || 'https://bestpricetank.de';
  let gespeichert = null;
  try {
    const d = await getJson(`${basis}/.netlify/functions/de-prices?lat=51.15&lng=14.99`);
    if (d.ok && Array.isArray(d.stations)) {
      if (!d.stale) {
        notvorratSchreiben(d.stations);
        return auswerten(d.stations);
      }
      console.log(`   · de-prices lieferte nur den Stand von vor ${d.ageMinutes} Min. (${d.quelle || '?'})`);
      if (d.fetchedAt && isFinite(Date.parse(d.fetchedAt))) {
        gespeichert = { ...auswerten(d.stations), __zeit: d.fetchedAt, __status: 'zwischengespeichert' };
      }
    } else {
      throw new Error(d.message || 'unerwartete Antwort');
    }
  } catch (e) {
    console.warn(`   · de-prices nicht nutzbar (${e.message}), versuche Tankerkönig direkt`);
  }
  try {
    return await deDirekt();
  } catch (e) {
    if (gespeichert) {
      console.warn(`   · Tankerkönig direkt: ${e.message} - nehme den gespeicherten Stand`);
      return gespeichert;
    }
    throw e;
  }
}

async function deDirekt() {
  const key = process.env.TK_KEY || process.env.TK_API_KEY;
  if (!key) throw new Error('TK_KEY nicht gesetzt');
  const d = await getJson(
    'https://creativecommons.tankerkoenig.de/json/list.php' +
    `?lat=51.15&lng=14.99&rad=25&sort=dist&type=all&apikey=${key}`,
    { Accept: 'application/json', Referer: 'https://bestpricetank.de/' }
  );
  if (!d.ok || !Array.isArray(d.stations)) throw new Error('Tankerkönig: unerwartete Antwort');
  notvorratSchreiben(d.stations);
  return auswerten(d.stations);
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

  // Sortenzuordnung. Pb95 ist in Polen seit dem 01.01.2024 E10,
  // Pb98 ist die E5-Sorte. Siehe auch netlify/functions/dp-prices.js.
  const SORTEN = { diesel: 'ON', e10: 'PB95', e5: 'PB98', lpg: 'LPG' };
  const plausibel = (v) => typeof v === 'number' && v > 0.5 && v < 20;

  const nah = d.stations
    .filter((s) => s.is_active && s.coordinates?.lat && s.prices?.ON > 3 && s.prices.ON < 15)
    .map((s) => {
      const preise = {};
      for (const [sorte, feld] of Object.entries(SORTEN)) {
        preise[sorte] = plausibel(s.prices[feld])
          ? { pln: s.prices[feld], eur: s.prices[feld] / plnRate }
          : null;
      }
      return {
        name: s.name, city: s.city, preise,
        onPln: s.prices.ON, pbPln: s.prices.PB95 > 3 ? s.prices.PB95 : null,
        entfernung: +km(GOERLITZ, { lat: s.coordinates.lat, lng: s.coordinates.lng }).toFixed(1),
      };
    })
    .filter((s) => s.entfernung <= UMKREIS_KM)
    .sort((a, b) => a.onPln - b.onPln);

  if (!nah.length) throw new Error(`DP: keine Station innerhalb ${UMKREIS_KM} km`);
  const on = nah.map((s) => s.onPln);
  const pb = nah.map((s) => s.pbPln).filter(Boolean);

  // Alle aktiven Stationen mit Koordinaten. Die Ortsseiten suchen sich
  // daraus ihre naechstgelegene gemessene Station - Slubice mit einem
  // Preis aus Zgorzelec zu bestuecken war Unsinn, das sind 138 km.
  const alle = d.stations
    .filter((x) => x.is_active && x.coordinates?.lat && x.prices?.ON > 3 && x.prices.ON < 15)
    .map((x) => {
      const preise = {};
      for (const [sorte, feld] of Object.entries(SORTEN)) {
        preise[sorte] = plausibel(x.prices[feld])
          ? { pln: x.prices[feld], eur: x.prices[feld] / plnRate } : null;
      }
      return { name: x.name, city: x.city, preise,
               lat: x.coordinates.lat, lng: x.coordinates.lng };
    });

  return {
    alle,
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
//
// Seit dem 02.10.2026 fuehrt live.json fuer JEDE Quelle ihre eigene Zeit
// (zeiten.de / .pl / .nbp / .cz): wann sie zuletzt wirklich geliefert hat.
// Vorher gab es nur einen gemeinsamen Stand, und der blieb stehen, sobald
// irgendeine Quelle klemmte - auch die woechentliche ČSÚ, die mit den
// Polen-Seiten gar nichts zu tun hat.
async function collect(vorher) {
  const quellen = {};
  const zeiten = {};
  const jetzt = new Date().toISOString();
  const hole = async (name, key, fn, rueckfall) => {
    try {
      const v = await fn();
      zeiten[key] = v.__zeit || jetzt;
      quellen[name] = v.__status || 'frisch';
      delete v.__zeit; delete v.__status;
      return v;
    } catch (e) {
      console.warn(`   ⚠ ${name}: ${e.message}`);
      if (!rueckfall) throw new Error(`${name} fehlgeschlagen und kein Rückfall vorhanden`);
      quellen[name] = 'aus dem letzten Stand';
      // Ein live.json von vor dem 02.10.2026 kennt nur den gemeinsamen
      // Stand. Der ist hoechstens so neu wie die Quelle - also vorsichtig.
      zeiten[key] = vorher?.zeiten?.[key] || vorher?.stand || null;
      return rueckfall;
    }
  };

  const r = await hole('Wechselkurse (NBP)', 'nbp', rates, vorher?.kurse);
  const [d, p, c] = await Promise.all([
    hole('Tankerkönig (DE)', 'de', () => de(), vorher?.de),
    hole('Dyskont Paliwowy (PL)', 'pl', () => pl(r.pln), vorher?.pl),
    hole('ČSÚ (CZ)', 'cz', () => cz(r.czk), vorher?.cz),
  ]);

  // Der Stand ist das Alter der PREISE, nicht der Zeitpunkt des Builds.
  //
  // Bisher stand hier unbedingt die aktuelle Uhrzeit. Faellt eine Quelle
  // aus, uebernimmt collect() die alten Werte aus data/live.json - und
  // stempelte ihnen dann die jetzige Uhrzeit auf. Am 20.09.2026 ist genau
  // das passiert: "Stand 20.09.2026, 14:44 Uhr" ueber Preisen vom 05.09.
  // Also: nur wenn wirklich alles frisch ist, ist es auch jetzt.
  //
  // Seit dem 02.10.2026: Der gemeinsame Stand ist die AELTERE der beiden
  // Zeiten, auf denen die Preisvergleiche beruhen - Polen und Deutschland.
  // ČSÚ (woechentlich) und NBP (Kursdatum, siehe KURS_DATUM) zaehlen nicht
  // hinein; sie werden mit ihrem eigenen Datum ausgewiesen.
  const aelter = (a, b) => (!a ? b : !b ? a : (Date.parse(a) < Date.parse(b) ? a : b));
  const stand = aelter(zeiten.pl, zeiten.de) || jetzt;
  if (stand !== jetzt) console.warn(`   \u26a0 Nicht alles frisch - Stand ${stand}`);
  return {
    stand,
    zeiten,
    quellen,
    kurse: r, de: d, pl: p, cz: c,
    ersparnisProLiter: d.diesel - p.diesel,
  };
}

// Datum und Uhrzeit in deutscher Zeit.
//
// Zwei Gruende fuer die Umstellung auf Europe/Berlin:
// Erstens lief die Datumsanzeige bisher ueber getDate() des Build-Servers,
// und der steht auf UTC - rund um Mitternacht stand also das falsche Datum
// auf den Seiten.
// Zweitens, und wichtiger: Deutscher Diesel schwankt im Tagesverlauf um 15
// bis 20 Cent. Am 20.09.2026 standen um 09:44 Uhr 2,329 EUR und um 12:16 Uhr
// 2,518 EUR - dazwischen liegen fast 19 Cent. Die Ortsseiten werden aber nur
// zweimal taeglich gebaut und frieren damit einen Messpunkt ein. Ohne
// Uhrzeit liest sich dieser Messpunkt wie ein Tageswert, und wer abends
// kommt, findet einen ganz anderen Preis vor. Mit Uhrzeit ist es das, was es
// ist: eine Momentaufnahme.
function zeitTeile(d) {
  try {
    const teile = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const hol = (t) => teile.find((p) => p.type === t)?.value;
    if (hol('day') && hol('hour')) {
      return { tag: hol('day'), monat: hol('month'), jahr: hol('year'),
               std: hol('hour'), min: hol('minute') };
    }
  } catch (e) {
    console.warn('   · Zeitzone nicht verfuegbar, nutze UTC:', e.message);
  }
  // Ohne Zeitzonendaten lieber UTC als eine erfundene Ortszeit.
  return { tag: String(d.getUTCDate()).padStart(2, '0'),
           monat: String(d.getUTCMonth() + 1).padStart(2, '0'),
           jahr: String(d.getUTCFullYear()),
           std: String(d.getUTCHours()).padStart(2, '0'),
           min: String(d.getUTCMinutes()).padStart(2, '0') };
}

// Ab wann ein Preis nicht mehr als "heute"/"live" gelten darf.
//
// Die Seiten werden zweimal taeglich gebaut. Faellt ein Abruf aus, ist der
// Stand rund 24 Stunden alt - das ist noch der gestrige Abend oder heutige
// Morgen. 30 Stunden lassen einen ausgefallenen Lauf zu; beim zweiten
// wechseln die Seiten auf "Stand TT.MM." und einen sichtbaren Hinweis.
const FRISCH_STD = 30;
// Die NBP veroeffentlicht nur an Werktagen. Ein Freitagskurs ist am Montag
// noch der gueltige; mit einem Feiertag dazu sind es 4 Tage.
const NBP_FRISCH_TAGE = 4;

function alterStd(iso, jetzt) {
  const t = Date.parse(iso);
  return isFinite(t) ? (jetzt - t) / 3600000 : Infinity;
}

function tokens(x) {
  const jetzt = Date.now();
  const zeiten = x.zeiten || {};
  const z = zeitTeile(new Date(x.stand));
  const dd = z.tag;
  const mm = z.monat;
  // Zeit je Quelle; ein live.json ohne zeiten faellt auf den Stand zurueck.
  const plIso = zeiten.pl || x.stand;
  const deIso = zeiten.de || x.stand;
  const zp = zeitTeile(new Date(plIso));
  const zd = zeitTeile(new Date(deIso));
  const plFrisch = alterStd(plIso, jetzt) <= FRISCH_STD;
  const deFrisch = alterStd(deIso, jetzt) <= FRISCH_STD;
  // NBP: nach dem Kursdatum, nicht nach der Abrufzeit.
  const kursDatum = x.kurse?.datum || null;
  const kursAlterTage = kursDatum ? (jetzt - Date.parse(kursDatum + 'T12:00:00Z')) / 86400000 : Infinity;
  const kursFrisch = kursAlterTage <= NBP_FRISCH_TAGE;
  const kursText = kursDatum
    ? `${kursDatum.slice(8, 10)}.${kursDatum.slice(5, 7)}.${kursDatum.slice(0, 4)}`
    : null;
  // Benzin nur vergleichen, wenn beide Seiten gemessen sind. DE E10 und
  // polnisches Pb95 sind beide 95 Oktan - das ist der saubere Vergleich,
  // nicht DE E5 gegen Pb95.
  const benzin = (x.de.e10 > 0 && x.pl.e10 > 0) ? x.de.e10 - x.pl.e10 : null;

  // Bezugsstation fuer den Antwortblock auf dieselpreis-polen.html und die
  // KI-Karte der Startseite: die guenstigste GEMESSENE Dyskont-Paliwowy-
  // Station bis 15 km von Goerlitz - in der Praxis eine der beiden in
  // Zgorzelec. Dieselbe Grenze nutzt die Startseite selbst (Umkreis 15 km),
  // damit der vorab eingesetzte Wert dem entspricht, was JavaScript danach
  // anzeigt. Nur wenn dort keine Station misst, die guenstigste im Umkreis.
  //
  // Bewusst KEIN Landesdurchschnitt: den haben wir nicht. Der Block sagt
  // das auch ausdruecklich.
  const stListe = Array.isArray(x.pl.stationen) ? x.pl.stationen : [];
  const nah = stListe.find((st) => st.entfernung <= 15 && isFinite(st.eur) && st.onPln > 0)
           || stListe.find((st) => isFinite(st.eur) && st.onPln > 0) || null;
  const nahDiff = nah ? x.de.diesel - nah.eur : null;
  const nahCent = nahDiff === null ? null : Math.round(nahDiff * 100);
  let vergleich = '\u2014';
  if (nahCent !== null && (!deFrisch || !plFrisch)) {
    // Einer der beiden Preise ist zu alt: keinen Unterschied behaupten.
    vergleich = 'Vergleich derzeit nicht möglich';
  } else if (nahCent !== null) {
    if (nahCent > 0) vergleich = `Polen ${nahCent} ct/L günstiger · bei 60 L rund ${eur2(nahDiff * 60)} €`;
    else if (nahCent < 0) vergleich = `Polen ${-nahCent} ct/L teurer`;
    else vergleich = 'kein nennenswerter Unterschied';
  }
  return {
    STAND: `${dd}.${mm}.${z.jahr}`,
    STAND_KURZ: `${dd}.${mm}.`,
    STAND_UHR: `${z.std}:${z.min}`,
    STAND_ISO: x.stand.slice(0, 10),
    KURS_PLN: loc(x.kurse.pln),
    KURS_CZK: loc(x.kurse.czk),
    DE_DIESEL: eur(x.de.diesel),
    DE_E10: eur(x.de.e10),
    DE_E5: eur(x.de.e5),
    PL_DIESEL: eur(x.pl.diesel),
    PL_DIESEL_PLN: loc(x.pl.dieselPln),
    PL_DIESEL_SPANNE: `${eur2(x.pl.diesel)}–${eur2(x.pl.dieselMax)}`,
    // Fehlt der polnische Benzinpreis, stand hier bis 20.09.2026 der
    // DIESELPREIS - unter der Ueberschrift "E10 (Pb95)". Ein stiller
    // Rueckfall auf die falsche Sorte ist schlimmer als eine Luecke.
    PL_E10: x.pl.e10 ? eur(x.pl.e10) : '\u2014',
    PL_E10_PLN: x.pl.e10Pln ? loc(x.pl.e10Pln) : '\u2014',
    ERSPARNIS_BENZIN_CENT: benzin === null ? '\u2014' : String(Math.round(benzin * 100)),
    ERSPARNIS_BENZIN_60L:  benzin === null ? '\u2014' : eur2(benzin * 60),
    PL_ANZAHL: String(x.pl.count),
    CZ_DIESEL: eur(x.cz.diesel),
    CZ_DIESEL_CZK: loc(x.cz.dieselCzk),
    CZ_WOCHE: x.cz.week,
    ERSPARNIS_LITER: eur2(x.ersparnisProLiter),
    ERSPARNIS_CENT: String(Math.round(x.ersparnisProLiter * 100)),
    ERSPARNIS_60L: eur2(x.ersparnisProLiter * 60),
    TABELLE_PL: tabelle(x.pl.stationen || []),
    PL_NAH_NAME: nah ? esc(nah.name) : '\u2014',
    PL_NAH_EUR: nah ? eur(nah.eur) : '\u2014',
    PL_NAH_PLN: nah ? loc(nah.onPln) : '\u2014',
    PL_NAH_VERGLEICH: vergleich,
    // Startwerte fuer die KI-Karte der Startseite, im selben Format, das
    // updateAICard() spaeter selbst schreibt. Ohne JavaScript - also fuer
    // Suchmaschinen und KI-Crawler - stand dort bisher nur ein Strich.
    // Nur frische Werte vorab einsetzen. Ist eine Seite zu alt, bleibt der
    // Strich stehen, bis JavaScript die aktuellen Preise geholt hat.
    AI_PREIS: (nah && plFrisch) ? `${eur(nah.eur)}€/L` : '\u2013',
    AI_SAVE: (nahDiff === null || !plFrisch || !deFrisch)
      ? '\u2013' : `${eur2(Math.max(0, nahDiff) * 60)} €`,

    // ── Zeit je Quelle (seit 02.10.2026) ──
    PL_STAND: `${zp.tag}.${zp.monat}.${zp.jahr}`,
    PL_STAND_UHR: `${zp.std}:${zp.min}`,
    DE_STAND: `${zd.tag}.${zd.monat}.${zd.jahr}`,
    DE_STAND_UHR: `${zd.std}:${zd.min}`,
    // Woerter, die nur bei frischen polnischen Daten stimmen.
    LIVE_LABEL: plFrisch ? 'Live' : `Stand ${zp.tag}.${zp.monat}.`,
    // "heute" steht dort vor einem Unterschied DE/PL - es braucht also
    // BEIDE Preise frisch. Sonst das Datum des aelteren.
    HEUTE: (plFrisch && deFrisch) ? 'heute' : `am ${dd}.${mm}.`,
    PL_NAH_LABEL: plFrisch ? 'Gemessener Dieselpreis' : 'Letzter verfügbarer Dieselpreis',
    // Eigene Zeile unter dem Stand-Kasten; im Kasten selbst bricht es auf
    // dem Handy in schmale Spalten.
    STAND_HINWEIS: plFrisch ? ''
      : '<div style="margin-top:10px;font-size:14px;font-weight:700;color:#b45309">'
        + 'Ältere Daten: Die polnische Preisquelle war zuletzt nicht erreichbar.</div>',
    // Deutsche Vergleichszeile im Antwortblock.
    DE_ZEILE: deFrisch
      ? `Günstigste Tankstelle Raum Görlitz: <b>${eur(x.de.diesel)} €/L</b>`
      : `Deutscher Vergleichspreis nicht aktuell (Stand ${zd.tag}.${zd.monat}., ${zd.std}:${zd.min} Uhr)`,
    // Kurs mit Datum. Ein alter Kurs wird als solcher benannt.
    KURS_ZEILE: kursText
      ? `Kurs 1 € = ${loc(x.kurse.pln)} zł (Polnische Nationalbank, ${kursText}${kursFrisch ? '' : ', älterer Kurs'})`
      : `Kurs 1 € = ${loc(x.kurse.pln)} zł (Polnische Nationalbank)`,
  };
}

// Erzeugt die Zeilen der Preistabelle aus echten Stationen.
// Jede Zeile traegt alle Sorten bei sich. Die Sortenknoepfe auf
// spritpreise-polen.html hatten bis zum 20.09.2026 nur einen Kommentar
// als Inhalt ("TODO: renderPrices(...) aus eurer API") - sie wurden
// eingefaerbt und sonst passierte nichts, egal was man anklickte.
// Ein Abruf zur Laufzeit braucht es dafuer nicht: die Preise stehen
// beim Bauen ohnehin schon alle zur Verfuegung.
function tabelle(st) {
  if (!st.length) return '<div class="prow"><div>Derzeit keine Preise abrufbar.</div><div></div><div></div></div>';
  return st.map((s, i) => {
    // Ein data/live.json aus der Zeit vor den Sorten kennt nur Diesel.
    // Dann wenigstens den, statt einer leeren Tabelle.
    const quelle = s.preise || { diesel: { eur: s.eur, pln: s.onPln } };
    const daten = {};
    for (const [sorte, v] of Object.entries(quelle)) {
      if (v && isFinite(v.eur) && isFinite(v.pln)) daten[sorte] = { eur: eur(v.eur), pln: loc(v.pln) };
    }
    const d0 = daten.diesel;
    return `<div class="prow" data-preise='${JSON.stringify(daten)}'>
        <div><div class="st-name">🇵🇱 ${esc(s.name)}${i === 0 ? ' <span class="st-badge">günstigste</span>' : ''}</div>
          <div class="st-meta">${esc(s.city || '')} · gemessener Stationspreis</div></div>
        <div class="price js-preis">${d0 ? d0.eur : '\u2013'} €<span class="pln">${d0 ? d0.pln + ' zł/L' : 'kein Preis gemeldet'}</span></div>
        <div class="price st-cell-3">${loc(s.entfernung, 1)} km</div>
      </div>`;
  }).join('\n      ');
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Der letzte gute Stand fuer den Fall, dass eine Quelle beim Bauen klemmt.
//
// data/live.json im Repository wird nie aktualisiert: Netlify schreibt die
// frische Fassung nur in den Build, nicht zurueck ins Repository. Dort lag
// am 02.10.2026 noch der Stand vom 05.09. Fiel eine Quelle aus, kamen
// vier Wochen alte Preise auf die Seite.
//
// Die veroeffentlichte Seite dagegen traegt immer den Stand des letzten
// erfolgreichen Builds. Also wird sie zuerst gefragt; die Datei im
// Repository bleibt nur der Rueckfall, wenn die Seite nicht erreichbar ist.
// Genommen wird der neuere der beiden.
async function vorherLaden() {
  let lokal = null, live = null;
  try { lokal = fs.existsSync(LIVE) ? JSON.parse(fs.readFileSync(LIVE, 'utf8')) : null; } catch {}
  try {
    const basis = process.env.URL || 'https://bestpricetank.de';
    const d = await getJson(`${basis}/data/live.json?build=${Date.now()}`);
    if (d && d.stand && d.de && d.pl && d.kurse) live = d;
  } catch (e) {
    console.warn(`   · Live-Stand nicht lesbar (${e.message}), nehme data/live.json`);
  }
  const zeit = (x) => (x && isFinite(Date.parse(x.stand)) ? Date.parse(x.stand) : -Infinity);
  const wahl = zeit(live) >= zeit(lokal) ? live : lokal;
  if (wahl) console.log(`   · Letzter guter Stand: ${wahl === live ? 'Live-Seite' : 'data/live.json'} vom ${wahl.stand}`);
  return wahl;
}

(async () => {
  const vorher = await vorherLaden();
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
  // BPT_DIST erlaubt einen anderen Ausgabeort - nuetzlich zum Pruefen in
  // Umgebungen, in denen der Projektordner nicht beschreibbar ist.
  const DIST = process.env.BPT_DIST || path.join(ROOT, 'dist');
  // Aufraeumen ist Kuer, nicht Pflicht: In manchen Umgebungen darf nicht
  // geloescht werden. Ueberschreiben genuegt.
  try { fs.rmSync(DIST, { recursive: true, force: true }); }
  catch (e) { console.warn('   · dist/ nicht loeschbar, wird ueberschrieben'); }
  fs.mkdirSync(DIST, { recursive: true });

  const UEBERSPRINGEN = new Set(['dist', 'node_modules', 'scripts', 'netlify']);
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (UEBERSPRINGEN.has(e.name) || e.name.startsWith('.')) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(DIST, e.name), { recursive: true, force: true });
  }

  let ersetzt = 0;
  const seiten = fs.readdirSync(DIST).filter((f) => f.endsWith('.html') || f === 'sitemap.xml');
  for (const f of seiten) {
    const ziel = path.join(DIST, f);
    // Welche gemessene Station ist die Grundlage DIESER Seite?
    //
    // Bis zum 20.09.2026 war es fuer jede Seite dieselbe: die guenstigste
    // im 60-km-Umkreis von Goerlitz. Auf der Slubice-Seite standen damit
    // Preise, die aus einer Station 138 km suedlich hochgerechnet waren,
    // und niemand konnte das der Seite ansehen.
    //
    // Jetzt nennt jede Ortsseite ihre Koordinaten, und der Build sucht die
    // naechste gemessene Dyskont-Paliwowy-Station dazu. Fuer Gubin ist das
    // Gubinek - direkt am Ort, wirklich gemessen. Fuer Slubice ist die
    // naechste weit weg; dann sagt die Seite das ueber ORT_BASIS_KM.
    let s = fs.readFileSync(ziel, 'utf8');

    const mOrt = s.match(/<meta\s+name="bpt-ort"\s+content="([\d.]+)\s*,\s*([\d.]+)"/i);
    let basis = null;
    if (mOrt && Array.isArray(data.pl.alle) && data.pl.alle.length) {
      const hier = { lat: parseFloat(mOrt[1]), lng: parseFloat(mOrt[2]) };
      basis = data.pl.alle
        .filter((st) => st.preise?.diesel)
        .map((st) => ({ st, km: km(hier, { lat: st.lat, lng: st.lng }) }))
        .sort((a, b) => a.km - b.km)[0] || null;
    }
    const basisEur = basis ? basis.st.preise.diesel.eur : data.pl.diesel;

    // Stationspreise auf den Ortsseiten: gemessene Basis plus dem im HTML
    // hinterlegten Aufschlag. Dasselbe Modell wie in der Anwendung.
    s = s.replace(/data-aufschlag="(-?[\d.]+)">\{\{PL_STATION\}\}/g, (m, off) => {
      const v = basisEur + parseFloat(off);
      ersetzt++;
      return `data-aufschlag="${off}">${eur(v)}`;
    });

    const aufschlaege = [...s.matchAll(/data-aufschlag="(-?[\d.]+)"/g)].map((m) => parseFloat(m[1]));
    const ortDiesel = aufschlaege.length ? basisEur + Math.min(...aufschlaege) : basisEur;
    const ortErsparnis = data.de.diesel - ortDiesel;
    const tSeite = {
      ...t,
      ORT_DIESEL: eur(ortDiesel),
      ORT_ERSPARNIS_CENT: String(Math.round(ortErsparnis * 100)),
      ORT_ERSPARNIS_60L: eur2(ortErsparnis * 60),
      // Als fertiger Satz, nicht als Einzelwerte: ohne data.pl.alle - also
      // wenn der Build auf ein altes live.json zurueckfaellt - kennen wir
      // die Entfernung nicht, und "? km von hier" gehoert auf keine Seite.
      ORT_BASIS_SATZ: basis
        ? `Gemessen wird <strong>${esc(basis.st.name)}</strong>`
          + (basis.st.city ? ` (${esc(basis.st.city)})` : '')
          + ` mit ${eur(basisEur)} €/L – das sind `
          + `${loc(basis.km, basis.km < 10 ? 1 : 0)} km von hier.`
        : `Gemessen wird die günstigste Dyskont-Paliwowy-Station im Grenzgebiet `
          + `mit ${eur(basisEur)} €/L.`,
    };

    // Fahrtkosten und Netto-Ersparnis.
    //
    // Auf der Cottbus-Seite stand bis zum 20.09.2026 "8 bis 12 Euro" fest
    // im Text. Das war zu einem Dieselpreis von rund 2,30 EUR gerechnet und
    // wandert mit jedem Preis, ohne dass es jemand merkt - derselbe Fehler
    // wie die "40 ct" auf den Ortsseiten. Also wird gerechnet.
    //
    // Bezugsgroesse ist der DEUTSCHE Literpreis fuer die ganze Strecke.
    // Genau genommen faehrt man die Rueckfahrt mit polnischem Sprit und
    // damit billiger; die Rechnung setzt die Kosten also eher zu hoch an.
    // Eine Ersparnis lieber zu klein als zu gross ausweisen.
    const mKm = s.match(/<meta\s+name="bpt-fahrt-km"\s+content="([\d.]+)"/i);
    const brauchtFahrt = /\{\{ORT_(FAHRT|VERBRAUCH|NETTO)[A-Z0-9_]*\}\}/.test(s);
    if (brauchtFahrt && !mKm) {
      console.error(`\u274c ${f} verwendet Fahrtkosten-Platzhalter, hat aber kein`
                  + ` <meta name="bpt-fahrt-km" content="..."> im Kopf.`);
      process.exit(1);
    }
    if (mKm) {
      const fkm  = parseFloat(mKm[1]);
      const lMin = (fkm / 100) * VERBRAUCH_MIN;
      const lMax = (fkm / 100) * VERBRAUCH_MAX;
      const kMin = lMin * data.de.diesel;
      const kMax = lMax * data.de.diesel;
      const brutto = ortErsparnis * 60;
      tSeite.ORT_FAHRT_KM     = loc(fkm, fkm % 1 ? 1 : 0);
      tSeite.ORT_VERBRAUCH    = `${VERBRAUCH_MIN} bis ${VERBRAUCH_MAX}`;
      tSeite.ORT_FAHRT_LITER  = spanne(lMin, lMax, (v) => loc(v, 1));
      tSeite.ORT_FAHRTKOSTEN  = spanne(kMin, kMax, eur2);
      tSeite.ORT_NETTO_60L    = spanne(brutto - kMax, brutto - kMin);
    }

    s = s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
      if (!(k in tSeite)) { console.error(`❌ Unbekannter Platzhalter ${m} in ${f}`); process.exit(1); }
      ersetzt++;
      return tSeite[k];
    });
    const rest = s.match(/\{\{[A-Z0-9_]+\}\}/g);
    if (rest) { console.error(`❌ Nicht ersetzt in ${f}: ${rest.join(', ')}`); process.exit(1); }
    fs.writeFileSync(ziel, s);
  }
  console.log(`✅ ${ersetzt} Werte in ${seiten.length} Seiten → dist/${frisch ? '' : '  (aus dem Rückfall)'}`);
})();
