// netlify/functions/ki-chat.js 
// Zapfi — Der Spritflüsterer · BestPriceTank.de

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Bad Request' }; }

  const { question, userName, lang = 'de', prices = {}, personality } = body;
  const isZapfi = personality === 'zapfi';

  // Sprache bestimmen
  const langMap = {
    de: 'Deutsch', pl: 'Polnisch', cz: 'Tschechisch', en: 'Englisch'
  };
  const responseLang = langMap[lang] || 'Deutsch';

  // Grenzübergänge Kontext
  const crossings = `
DE/PL Grenzübergänge (von Süd nach Nord):
- Sieniawka/Zittau (~30km von Görlitz): AB Tank, BP Sieniawka
- Zgorzelec/Görlitz (~3km): Dyskont Paliwowy (günstigste!), Shell, BP, Circle K, ORLEN, MOL
- Jędrzychowice/Ludwigsdorf A4 (~9km): Groil, Watis, Shell Pieńsk
- Ruszów/Hagenwerder (~30km): Jersak, Pieprzyk
- Przewóz/Forst-Zasieki (~37km): Pieprzyk, Apexim AB
- Łęknica/Bad Muskau (~45km): Apexim AB Łęknica 1+2
- Dąbrowa/Muskau (~54km): Pieprzyk Królów, MOL Strzeszowice
- Gubin/Guben (~90km): Shell, ORLEN, Horex, BP, Avia, Moya, Lotos
- Słubice/Frankfurt(Oder) (~136km): Shell, Avia, Aral, ORLEN, Amic, Total, BP, EkoTank
- Kostrzyn/Küstrin (~160km): ORLEN, BP
- Krajnik Dolny/Schwedt (~214km): Apexim AB
- Kołbaskowo/Stettin (~258km): BP`;

  // Empfehlung nach Startort
  const routeTip = `
Startort-Empfehlungen:
- Berlin → Słubice (A12/A2, Shell/ORLEN direkt am Übergang)
- Hamburg/Nord → Kołbaskowo/Stettin (A11/A6)
- Dresden/Leipzig → Zgorzelec oder Bogatynia (A4/A17)
- Görlitz/Region → Dyskont Paliwowy Zgorzelec (3km, günstigste DE/PL-Grenze)
- Zittau → Sieniawka (5min, BP oder AB Tank)
- Cottbus → Gubin (A15, kurze Strecke)`;

  const systemPrompt = isZapfi ? `
Du bist Zapfi, der freche aber kompetente Spritflüsterer von BestPriceTank.de.
Du kennst die komplette deutsche Westgrenze zu Polen — von Stettin bis Zittau.

PERSÖNLICHKEIT:
- Kurz, direkt, mit trockenem Humor
- Wie ein Kumpel der die Region kennt, kein roboterhafter Assistent
- Kleine Witze sind ok, aber du kommst immer auf den Punkt
- Keine langen Einleitungen, keine blabla — Antwort, Zahl, fertig
- Manchmal ein Emoji am Ende reicht

DEINE HAUPTAUFGABE:
- Sagen ob sich Polen lohnt (ja/nein + Zahl)
- Den besten Übergang je nach Startort nennen
- Grenzrechner-Ergebnisse direkt nennen
- Niemals raten oder erfinden — nur mit den gegebenen Live-Daten antworten
- Auf Fragen die nichts mit Tanken/Sprit/Grenze zu tun haben: kurz ablehnen mit Humor

RECHENFORMEL (immer anwenden wenn gefragt):
Brutto-Ersparnis = (DE-Preis - PL-Preis) × Liter
Fahrtkosten = (km×2 / 100) × Verbrauch(7L) × DE-Preis
Netto = Brutto - Fahrtkosten

ANTWORTE IMMER auf ${responseLang}.
Maximal 4-5 Zeilen. Kein Markdown-Overload. HTML <strong> und <br> sind ok.
${crossings}
${routeTip}
` : `
Du bist der KI-Assistent von BestPriceTank.de.
Du hilfst Nutzern dabei günstig zu tanken an der deutschen Grenze zu Polen und Tschechien.
Antworte auf ${responseLang}. Sei hilfreich, präzise und kurz.
${crossings}
`;

  const userMessage = `
Frage: ${question}
${userName ? `Nutzer: ${userName}` : ''}

Aktuelle Live-Daten:
- ${prices.fuel || 'Diesel'} DE (günstigste Station: ${prices.bestDeStation || 'DE'}): ${prices.de || '–'} €/L
- ${prices.fuel || 'Diesel'} PL (günstigste: ${prices.bestPlStation || 'PL'}): ${prices.pl || '–'} €/L  
- ${prices.fuel || 'Diesel'} CZ: ${prices.cz || '–'} €/L
- Wechselkurs: 1€ = ${prices.pln || '4,24'} PLN
- Wetter: ${prices.wetter || 'keine Daten'}
- Verkehr: ${prices.stau || 'A4+A15 frei'}
- Grenzrechner-Ergebnis (60L, 8km): ${prices.grenz || 'nicht berechnet'}
`;

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: isZapfi ? 0.85 : 0.7,
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
    return {
      statusCode: 500,
      body: JSON.stringify({ answer: isZapfi
        ? 'Kurzer Aussetzer meinerseits. Aber Polen lohnt sich heute trotzdem. ⛽'
        : 'Fehler beim KI-Service.' })
    };
  }
};
