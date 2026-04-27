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
- Sieniawka/Zittau (~30km): AB Tank, BP — kleiner Übergang, kaum Kontrollen, Geheimtipp!
- Zgorzelec/Görlitz (~3km): Dyskont Paliwowy (günstigste!), Shell, BP, Circle K, ORLEN, MOL
- Jędrzychowice/Ludwigsdorf A4 (~9km): Groil, Watis, Shell — A4-Autobahn, häufig kontrolliert
- Ruszów/Hagenwerder (~30km): Jersak, Pieprzyk — ruhiger Übergang
- Przewóz/Forst-Zasieki (~37km): Pieprzyk, Apexim AB
- Łęknica/Bad Muskau (~45km): Apexim AB — touristisch, meist fließend
- Gubin/Guben (~90km): Shell, ORLEN, Horex, BP, Avia, Moya, Lotos — A15
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
- Zittau → Sieniawka (5min, kaum Kontrollen)
- Cottbus → Gubin (A15, 30min)
- Leipzig → Zgorzelec (A4, 2h) oder Słubice (A9/A2, 2.5h)
- Rostock → Kołbaskowo/Stettin (A20/A11)`;

  // ── GRENZKONTROLLEN ───────────────────────────────────────────
  const borderControls = `
AKTUELLE GRENZKONTROLLEN (seit Sept. 2024):
- Deutschland kontrolliert an ALLEN Schengen-Grenzen stationär
- Nicht jedes Auto wird kontrolliert — aber Ausweis/Pass immer dabei haben!
- A4 Ludwigsdorf/Jędrzychowice: AM HÄUFIGSTEN kontrolliert, 10-30 Min möglich
- A15 Forst/Gubin: manchmal, meist fließend
- Görlitz Stadtbrücke: selten kontrolliert — sehr empfehlenswert
- Sieniawka/Zittau: kaum Kontrollen — BESTER TIPP für entspanntes Tanken ohne Stress
- Wartezeiten live: autobahn.de oder Google Maps checken
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
  const currentAlertPrice = priceAlert?.country === 'pl' ? parseFloat(prices.pl) : parseFloat(prices.de);
  const alertContext = priceAlert ? `
PREISALARM DES NUTZERS:
- Ziel: ${priceAlert.fuel} in ${priceAlert.country === 'pl' ? 'Polen' : 'Deutschland'} unter ${priceAlert.threshold}€/L
- Aktuell: ${currentAlertPrice?.toFixed(3)}€/L
- Status: ${currentAlertPrice <= priceAlert.threshold ? '🔔 ALARM! Zielpreis erreicht — JETZT TANKEN!' : `Noch ${(currentAlertPrice - priceAlert.threshold).toFixed(3)}€ über Ziel`}` : '';

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
- Grenzkontrollen: immer vollständig + Geheimtipp nennen
- Preisalarm ausgelöst: kurz und klar — JETZT handeln!
- Kreative/lustige Fragen: locker, gerne etwas länger, Persönlichkeit zeigen
- Auto-Profil Fragen: immer mit den echten Nutzerwerten rechnen und erklären

KERNKOMPETENZEN:
1. Polen lohnt? → Netto-Ersparnis mit echten Preisen
2. Bester Übergang → konkret mit km, Tankstellen, Kontrollen-Status
3. Grenzkontrollen → ehrlich + Geheimtipp Sieniawka erwähnen
4. Tanktaktik → wann, wo, wieviel
5. Fahrzeug-spezifisch → mit Nutzerwerten rechnen wenn vorhanden
6. Wetter + Stau → kombiniert mit Empfehlung
7. Preisalarm → status + Handlungsempfehlung

RECHENFORMEL:
Brutto = (DE-Preis - PL-Preis) × ${tankL}L
Fahrtkosten = (km×2 / 100) × ${consL} × DE-Preis
Netto = Brutto - Fahrtkosten

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

LIVE-PREISE (jetzt aktuell):
- ${prices.fuel || 'Diesel'} Deutschland (${prices.bestDeStation || 'günstigste'}): ${prices.de || '–'} €/L
- ${prices.fuel || 'Diesel'} Polen (${prices.bestPlStation || 'günstigste'}): ${prices.pl || '–'} €/L
- ${prices.fuel || 'Diesel'} Tschechien: ${prices.cz || '–'} €/L
- Wechselkurs: 1€ = ${prices.pln || '4,24'} PLN
- Wetter: ${prices.wetter || 'nicht verfügbar'}
- Stau/Verkehr: ${prices.stau || 'A4+A15 keine Meldungen'}
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
          ? 'Kurzer Schluckauf meinerseits. 😅<br>Aber die gute Nachricht: Polen lohnt sich heute trotzdem. Einfach rüber! ⛽'
          : 'Fehler beim KI-Service. Bitte erneut versuchen.'
      })
    };
  }
};
