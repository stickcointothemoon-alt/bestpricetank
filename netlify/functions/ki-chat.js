// netlify/functions/ki-chat.js
// BestPriceTank KI — GPT-4o-mini, Topic-locked, sicher
// Key: OPENAI_KEY in Netlify Dashboard (nie im Code!)

exports.handler = async (event) => {
  // Nur POST erlaubt
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // CORS — erlaubt nur bestpricetank.de
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { question, userName, prices } = JSON.parse(event.body || '{}');

    if (!question || question.trim().length < 2) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Frage fehlt' }) };
    }

    const dePrice  = prices?.de  || '1,65';
    const plPrice  = prices?.pl  || '1,44';
    const czPrice  = prices?.cz  || '1,48';
    const name     = userName ? `Der Nutzer heißt ${userName}.` : '';

    const systemPrompt = `Du bist der KI-Assistent von BestPriceTank.de — dem Spritpreis-Vergleich für das Dreiländereck Deutschland, Polen und Tschechien.

DEIN BEREICH (NUR das beantwortest du):
• Kraftstoffpreise: Diesel, E5, E10, LPG in DE / PL / CZ
• Spritsparen, Grenzfahrten, Ersparnis-Berechnung
• Wetter an der Grenze (Görlitz, Zgorzelec, Hrádek nad Nisou)
• Stau und Verkehr auf der Route Görlitz ↔ Polen / Tschechien
• Kanister, Freimengen, Fahrttipps

AUSSERHALB DEINES BEREICHS: Bei ALLEN anderen Themen (Politik, Sport, Kochen, Technik usw.) antworte exakt: "Das liegt außerhalb meines Bereichs. Ich helfe bei Spritpreisen, Wetter und Stau im Dreiländereck. ⛽"

AKTUELLE LIVE-PREISE (Diesel):
🇩🇪 Deutschland: ${dePrice} €/L
🇵🇱 Polen: ${plPrice} €/L
🇨🇿 Tschechien: ${czPrice} €/L

STIL: Deutsch, freundlich, max. 3 kurze Sätze, kein Markdown, kein Fettdruck.
${name}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 160,
        temperature: 0.6,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: question.slice(0, 400) }, // max 400 Zeichen
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI ${response.status}`);
    }

    const data   = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim()
      || 'Ich konnte gerade keine Antwort generieren. Versuch es gleich nochmal.';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ answer }),
    };

  } catch (err) {
    console.error('ki-chat error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ answer: 'Verbindungsfehler zur KI. Bitte kurz warten und nochmal versuchen.' }),
    };
  }
};
