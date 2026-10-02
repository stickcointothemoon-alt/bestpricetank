// netlify/functions/ki-chat.js
// Zapfi — Der Spritflüsterer · BestPriceTank.de · v3.0

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Bad Request' }; }

  const {
    question, userName, lang = 'de', prices = {}, personality,
    carProfile = null,   // { car, fuel, tank, consumption }
    priceAlert = null,   // { fuel, threshold, country }
    borderInfo = null,   // { crossings: [{name, waitMin}] }
    history = []         // letzte 3 Nachrichten für Kontext
  } = body;

  const isZapfi = personality === 'zapfi';
  const langMap = { de:'Deutsch', pl:'Polnisch', cz:'Tschechisch', en:'Englisch' };
  const responseLang = langMap[lang] || 'Deutsch';

  // ── GRENZÜBERGÄNGE ────────────────────────────────────────────
  const crossings = `
DE/PL Grenzübergänge (von Süd nach Nord):
- Sieniawka/Zittau (~30km): AB Tank, BP — kleiner Übergang
- Zgorzelec/Görlitz (~3km): Dyskont Paliwowy (günstigste!), Shell, BP, Circle K, ORLEN, MOL
- Jędrzychowice/Ludwigsdorf A4 (~9km): Groil, Watis, Shell — A4-Autobahn, häufig kontrolliert
- Ruszów/Hagenwerder (~30km): Jersak, Pieprzyk — ruhiger Übergang
- Przewóz/Forst-Zasieki (~37km): Pieprzyk, Apexim AB
- Łęknica/Bad Muskau (~45km): Apexim AB — touristisch, meist fließend
- Gubin/Guben (~90km): Shell, ORLEN, Horex, BP, Avia, Moya
- Słubice/Frankfurt(Oder) (~136km): Shell, Avia, Aral, ORLEN, Amic, Total, BP, EkoTank
- Kostrzyn/Küstrin (~160km): ORLEN, BP
- Krajnik Dolny/Schwedt (~214km): Apexim AB — sehr ruhig
- Kołbaskowo/Stettin (~258km): BP — A6`;

  // ── STARTORT EMPFEHLUNGEN ─────────────────────────────────────
  const routeTips = `
Startort-Empfehlungen:
- Berlin → Słubice/Frankfurt(Oder) (A12, ~90min)
- Hamburg → Kołbaskowo/Stettin (A11/A6)
- Dresden → Zgorzelec (A4/A17, 45min)
- Görlitz → Dyskont Paliwowy Zgorzelec (3km, 5min!)
- Zittau → Sieniawka (5min)
- Cottbus → Gubin (A15, 30min)
- Leipzig → Zgorzelec (A4, 2h) oder Słubice (A9/A2, 2.5h)
- Rostock → Kołbaskowo/Stettin (A20/A11)`;

  // ── GRENZKONTROLLEN ───────────────────────────────────────────
  // Stand 02.10.2026. Quelle: Polen hat seine Kontrollen an der Grenze zu
  // Deutschland am 01.10.2026 bis 30.03.2027 verlaengert, Deutschland seine
  // bis Mitte Maerz 2027. Fuer die deutsch-polnische Grenze gibt es KEINE
  // offiziellen Live-Wartezeiten (der polnische Grenzschutz veroeffentlicht
  // nur die EU-Aussengrenzen). Bis zu diesem Datum stand hier "seit Sept.
  // 2024", "10-30 Min" und "Sieniawka: kaum Kontrollen - BESTER TIPP".
  const borderControls = `
GRENZKONTROLLEN (Stand Oktober 2026):
- BEIDE Seiten kontrollieren vorübergehend: Deutschland (verlängert bis Mitte März 2027) und Polen (verlängert bis 30. März 2027).
- Kontrolliert wird vor allem an den großen Übergängen, z. B. A4 Ludwigsdorf/Jędrzychowice, A15 Forst/Olszyna, A12 Frankfurt (Oder)/Świecko, A11 Pomellen/Kołbaskowo. Stichprobenartig, nicht jedes Auto.
- An kleineren Übergängen (z. B. Görlitz Stadtbrücke, Zittau/Sieniawka) sind Kontrollen seltener, aber möglich. KEINE Garantie geben, nicht als "kontrollfrei" empfehlen.
- Ausweis oder Pass immer dabeihaben.
- Für die deutsch-polnische Grenze gibt es keine offiziellen Live-Wartezeiten. NENNE KEINE Wartezeiten aus dem Kopf. Verweise auf die Stau-Meldungen unten (Autobahn GmbH) oder auf Google Maps.
${borderInfo?.crossings?.length ? `\nAktuelle Meldungen:\n${borderInfo.crossings.map(c=>`- ${c.name}: ${c.waitMin > 0 ? c.waitMin+' Min' : 'frei'}`).join('\n')}` : ''}`;

  // ── AUTO-PROFIL ───────────────────────────────────────────────
  const tankL = carProfile?.tank || 60;
  const consL = carProfile?.consumption || 7;
  const carContext = carProfile?.car ? `
NUTZER-FAHRZEUG (immer damit rechnen!):
- Auto: ${carProfile.car}
- Kraftstoff: ${carProfile.fuel || 'Diesel'}
- Tankgröße: ${tankL}L
- Verbrauch: ${consL}L/100km
→ Alle Berechnungen mit diesen Werten, NICHT mit Standard-60L/7L!` : '';

  // ── PREISALARM ────────────────────────────────────────────────
  // Preise kommen als "2,089" (Komma) oder "–" an. parseFloat("2,089") ist
  // 2 und parseFloat("–") NaN - bis zum 02.10.2026 landete das so im Prompt.
  const zahl = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) && n > 0 ? n : null; };
  const currentAlertPrice = priceAlert?.country === 'pl' ? zahl(prices.pl) : zahl(prices.de);
  const alertContext = priceAlert ? `
PREISALARM DES NUTZERS:
- Ziel: ${priceAlert.fuel} in ${priceAlert.country === 'pl' ? 'Polen' : 'Deutschland'} unter ${priceAlert.threshold}€/L
- Aktuell: ${currentAlertPrice === null ? 'kein aktueller Preis verfügbar' : currentAlertPrice.toFixed(3).replace('.', ',') + '€/L'}
- Status: ${currentAlertPrice === null ? 'kann gerade nicht geprüft werden'
           : currentAlertPrice <= priceAlert.threshold ? '🔔 ALARM! Zielpreis erreicht — JETZT TANKEN!'
           : `Noch ${(currentAlertPrice - priceAlert.threshold).toFixed(3).replace('.', ',')}€ über Ziel`}` : '';

  // ── SYSTEM PROMPT ─────────────────────────────────────────────
  const systemPrompt = isZapfi ? `
Du bist Zapfi, der Spritflüsterer von BestPriceTank.de.
Die coolste Tank-KI an der DE/PL Grenze — von Menschen für Menschen gebaut.

PERSÖNLICHKEIT:
- Freundlich, direkt, manchmal frech — wie ein Kumpel der alles über Tanken weiß
- Du redest wie ein Mensch, kein Roboter-Ton
- Trockener Humor ist willkommen, du kommst aber immer zum Punkt
- Du kennst Görlitz, Zgorzelec, die ganze Grenze wie deine Westentasche
- Bei Fragen die nichts mit Tanken zu tun haben: kurze witzige Ablehnung, dann Redirect

ANTWORT-LÄNGE (wichtig!):
- Einfache Ja/Nein Fragen: 2-3 Zeilen + konkrete Zahl
- Routenfragen, Vergleiche, Strategie: 5-8 Zeilen, strukturiert mit <br>
- Grenzkontrollen: sachlich nach dem Abschnitt GRENZKONTROLLEN, keine Wartezeiten erfinden
- Preisalarm ausgelöst: kurz und klar — JETZT handeln!
- Kreative/lustige Fragen: locker, gerne etwas länger, Persönlichkeit zeigen
- Auto-Profil Fragen: immer mit den echten Nutzerwerten rechnen und erklären

KERNKOMPETENZEN:
1. Polen lohnt? → Netto-Ersparnis mit echten Preisen
2. Bester Übergang → konkret mit km, Tankstellen, Kontrollen-Status
3. Grenzkontrollen → ehrlich nach dem Abschnitt GRENZKONTROLLEN
4. Tanktaktik → wann, wo, wieviel
5. Fahrzeug-spezifisch → mit Nutzerwerten rechnen wenn vorhanden
6. Wetter + Stau → kombiniert mit Empfehlung
7. Preisalarm → status + Handlungsempfehlung

RECHENFORMEL:
Brutto = (DE-Preis - PL-Preis) × ${tankL}L
Fahrtkosten = (km×2 / 100) × ${consL} × DE-Preis
Netto = Brutto - Fahrtkosten

EHRLICHKEIT BEI DATEN (wichtig!):
- Steht bei einem Preis "–", hast du dafür KEINEN Preis. Sag das, nenne keine Zahl und keine Ersparnis.
- Steht beim Stand "letzter gemessener Stand", nenne die Uhrzeit bzw. das Datum dazu und sag nicht "jetzt" oder "live".
- Ist ein Stand "veraltet" oder "nicht verfügbar", rechne keine Ersparnis aus.
- Ist der Verkehr "unbekannt", sag das - behaupte nicht, die Strecke sei frei.

ANTWORTE IMMER auf ${responseLang}.
HTML <strong> und <br> sind erlaubt. Zahlen mit Komma: 1,439€

${crossings}
${routeTips}
${borderControls}
${carContext}
${alertContext}
` : `
Du bist der KI-Assistent von BestPriceTank.de.
Hilf Nutzern günstig zu tanken an der DE/PL/CZ Grenze.
Antworte auf ${responseLang}. Sei hilfreich, präzise und freundlich.
${crossings}
${borderControls}
`;

  // ── USER MESSAGE ──────────────────────────────────────────────
  const userMessage = `
${history.length > 0 ? `Letzter Gesprächskontext:\n${history.slice(-3).map(h=>`${h.role==='user'?'Nutzer':'Zapfi'}: ${h.content}`).join('\n')}\n` : ''}
Aktuelle Frage: ${question}
${userName ? `Nutzername: ${userName}` : ''}

PREISE (günstigste Station in der Nähe; "–" = kein Preis vorhanden):
- ${prices.fuel || 'Diesel'} Deutschland (${prices.bestDeStation || 'günstigste'}): ${prices.de || '–'} €/L · Stand: ${prices.stand_de || 'unbekannt'}
- ${prices.fuel || 'Diesel'} Polen (${prices.bestPlStation || 'günstigste'}): ${prices.pl || '–'} €/L · Stand: ${prices.stand_pl || 'unbekannt'}
- ${prices.fuel || 'Diesel'} Tschechien: ${prices.cz || '–'} €/L (Landesdurchschnitt plus Zuschlag, keine Stationsmessung)
- Wechselkurs: 1€ = ${prices.pln || 'unbekannt'} PLN
- Wetter: ${prices.wetter || 'nicht verfügbar'}
- Stau/Verkehr (Autobahn GmbH): ${prices.stau || 'unbekannt'}
- Grenzrechner (${tankL}L, 8km hin+zurück): ${prices.grenz || 'nicht berechnet'}
`;

  // ── OPENAI CALL ───────────────────────────────────────────────
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        temperature: isZapfi ? 0.88 : 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage }
        ]
      })
    });

    const data = await resp.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || '–';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer })
    };

  } catch (err) {
    console.error('Zapfi Fehler:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer: isZapfi
          ? 'Kurzer Schluckauf meinerseits. 😅<br>Die aktuellen Preise und den Grenzrechner findest du oben auf der Karte. ⛽'
          : 'Fehler beim KI-Service. Bitte erneut versuchen.'
      })
    };
  }
};
