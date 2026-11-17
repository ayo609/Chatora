// Vercel serverless function: /api/translate  (message translator: Igbo, Yoruba, Hausa).
// Put it at  api/translate.js  next to api/chat.js. It uses the same GEMINI_API_KEY setting in Vercel.

const WEB_API_KEY = 'AIzaSyDLVQaV9gmlNFDkQLtTytl71F_aJk15xXg';   // your Firebase web key (public)
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const LANGS = {
  ig: 'Igbo (use standard Igbo orthography with correct diacritics where they matter)',
  yo: 'Yoruba (write with correct tone marks and under-dots, for example ẹ, ọ, ṣ, à, á)',
  ha: 'Hausa (use standard Hausa orthography, including the hooked letters ɓ, ɗ, ƙ and ƴ)'
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only. The translate function is installed correctly.' });
  try {
    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel, or you have not redeployed yet.' });
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    const who = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
    });
    if (!who.ok) return res.status(401).json({ error: 'Please sign in again.' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const text = String((body && body.text) || '').trim().slice(0, 3000);
    const target = LANGS[body && body.target];
    if (!text) return res.status(400).json({ error: 'No text to translate.' });
    if (!target) return res.status(400).json({ error: 'Choose Igbo (ig), Yoruba (yo) or Hausa (ha).' });

    const system = 'You are a careful professional translator. Translate the user\'s message into ' + target + '. ' +
      'Keep the meaning, tone, names, numbers, emojis and line breaks exactly. If a word has no good equivalent, keep it as it is. ' +
      'If the message is already in the target language, return it unchanged. ' +
      'Reply with ONLY the translation. No quotes, no notes, no explanations.';
    const payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { temperature: 0.15, maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } }
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    const call = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(payload), signal: ctl.signal });
    let r = await call();
    if (r.status === 400) { delete payload.generationConfig.thinkingConfig; r = await call(); }
    clearTimeout(timer);
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: (data && data.error && data.error.message) || 'Gemini request failed.' });
    const reply = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('').trim();
    if (!reply) return res.status(502).json({ error: 'No translation came back. Try again.' });
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err && err.name === 'AbortError' ? 'The translator took too long.' : 'Server error.' });
  }
};
