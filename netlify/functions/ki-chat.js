// netlify/functions/ki-chat.js
// BestPriceTank KI — GPT-4o-mini, 4 Sprachen, Topic-locked

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { question, userName, lang = 'de', prices } = JSON.parse(event.body || '{}');
    if (!question?.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Frage fehlt' }) };

    const dePrice = prices?.de || '1,65';
    const plPrice = prices?.pl || '1,44';
    const czPrice = prices?.cz || '1,48';
    const name = userName ? `Der Nutzer heißt ${userName}.` : '';

    // Language-specific instructions
    const langMap = {
      de: { instruction: 'Antworte immer auf DEUTSCH.', outOfScope: 'Das liegt außerhalb meines Bereichs. Ich helfe nur bei Spritpreisen, Wetter und Stau im Dreiländereck. ⛽' },
      pl: { instruction: 'Odpowiadaj zawsze po POLSKU.', outOfScope: 'To jest poza moim zakresem. Pomagam tylko w kwestiach cen paliw, pogody i korków w Trójstyku. ⛽' },
      cz: { instruction: 'Odpovídej vždy ČESKY.', outOfScope: 'To je mimo můj obor. Pomáhám pouze s cenami pohonných hmot, počasím a dopravními zácpami v Trojmezí. ⛽' },
      en: { instruction: 'Always respond in ENGLISH.', outOfScope: 'That is outside my area. I only help with fuel prices, weather, and traffic in the Three-Country Corner. ⛽' },
    };
    const lc = langMap[lang] || langMap.de;

    const systemPrompt = `You are the BestPriceTank AI assistant for the Three-Country Corner region of Germany, Poland and Czech Republic.

${lc.instruction}

ONLY answer questions about:
- Fuel prices (Diesel, E5, E10, LPG) in DE / PL / CZ
- Saving on fuel, border trips, savings calculations
- Weather at the border (Görlitz, Zgorzelec, Hrádek nad Nisou)
- Traffic and roadworks on the DE↔PL / DE↔CZ routes
- Canister rules, allowed fuel quantities
- E-car vs combustion engine comparison

For ALL other topics respond EXACTLY: "${lc.outOfScope}"

CURRENT LIVE PRICES (Diesel):
🇩🇪 Germany: ${dePrice} €/L
🇵🇱 Poland: ${plPrice} €/L
🇨🇿 Czech Republic: ${czPrice} €/L

STYLE: Friendly, max 3 short sentences, no markdown formatting.
${name}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 180,
        temperature: 0.65,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question.slice(0, 500) },
        ],
      }),
    });

    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || lc.outOfScope;

    return { statusCode: 200, headers, body: JSON.stringify({ answer }) };

  } catch (err) {
    console.error('ki-chat error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ answer: 'Verbindungsfehler. Bitte kurz warten.' }) };
  }
};
