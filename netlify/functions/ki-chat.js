// netlify/functions/ki-chat.js
// BestPriceTank KI — GPT-4o-mini, 4 Sprachen, Persönlichkeit, Live-Kontext

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

    const dePrice = prices?.de || '–';
    const plPrice = prices?.pl || '–';
    const czPrice = prices?.cz || '–';
    const grenz   = prices?.grenz   || '';
    const wetter  = prices?.wetter  || '';
    const stau    = prices?.stau    || '';

    const langMap = {
      de: {
        instruction: 'Antworte immer auf DEUTSCH.',
        outOfScope: 'Sprit, Wetter, Stau — dafür bin ich da! Frag mich was dazu 🚗⛽'
      },
      pl: {
        instruction: 'Odpowiadaj zawsze po POLSKU.',
        outOfScope: 'Paliwo, pogoda, korki — do tego jestem! Zapytaj mnie o to 🚗⛽'
      },
      cz: {
        instruction: 'Odpovídej vždy ČESKY.',
        outOfScope: 'Palivo, počasí, doprava — to je moje téma! Zeptej se mě 🚗⛽'
      },
      en: {
        instruction: 'Always respond in ENGLISH.',
        outOfScope: 'Fuel, weather, traffic — that\'s my thing! Ask me about that 🚗⛽'
      },
    };
    const lc = langMap[lang] || langMap.de;
    const nameCtx = userName ? `\nNutzer: ${userName}. Bei natürlicher Gelegenheit mit Namen ansprechen.` : '';

    const systemPrompt = `Du bist der smarte Sprit-Assistent von BestPriceTank.de — die beste Adresse für günstiges Tanken im Dreiländereck Deutschland, Polen, Tschechien.

${lc.instruction}

PERSÖNLICHKEIT:
- Kennst die Region wie kein anderer: Görlitz, Zgorzelec, Hrádek, Neiße-Brücke, Citronex.
- Direkt, nützlich, keine leeren Phrasen. Wie ein gut informierter Freund.
- Konkrete Empfehlungen mit echten Zahlen aus den Live-Daten.
- Emojis sparsam (max. 1-2). Max. 3 Sätze. Kurz = gut.

NUR DIESE THEMEN:
- Aktuelle Spritpreise DE/PL/CZ + klare Empfehlungen
- Grenzfahrt: lohnt es sich, mit echten Zahlen
- Wetter + Straßenverhältnisse an der Grenze
- Baustellen/Stau auf A4, A15, B115
- Kanister-Regeln (max. 60L in Kanistern erlaubt)
- E-Auto vs. Verbrenner

BEI ALLEM ANDEREN: "${lc.outOfScope}"

LIVE-DATEN JETZT:
🇩🇪 DE Diesel: ${dePrice} €/L
🇵🇱 PL Diesel: ${plPrice} €/L
🇨🇿 CZ Diesel: ${czPrice} €/L
${grenz ? `\nGrenzrechner: ${grenz}` : ''}${wetter ? `\nWetter: ${wetter}` : ''}${stau ? `\nVerkehr: ${stau}` : ''}${nameCtx}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        temperature: 0.75,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: question.slice(0, 500) },
        ],
      }),
    });

    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const data   = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || lc.outOfScope;

    return { statusCode: 200, headers, body: JSON.stringify({ answer }) };

  } catch (err) {
    console.error('ki-chat error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ answer: 'Kurze Verbindungspause — versuch es gleich nochmal.' }),
    };
  }
};
