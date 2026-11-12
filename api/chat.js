// Vercel serverless function: /api/chat  (the AI behind "Chatora AI").
// Put this file at  api/chat.js  in the root of your Vercel project (next to chat.html), then add one setting:
//   Vercel > your project > Settings > Environment Variables > GEMINI_API_KEY = your Gemini key  (then Redeploy)
// Optional: GEMINI_MODEL (default gemini-2.5-flash).
// It never sleeps like the free Render server, and it only answers people who are signed in to Chatora.

const WEB_API_KEY = 'AIzaSyDLVQaV9gmlNFDkQLtTytl71F_aJk15xXg';   // your Firebase web key (public, safe to keep here)
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SYSTEM = 'You are Chatora AI, a friendly and concise assistant inside a chat app. Reply in the same language the user writes in. Keep answers short unless asked for detail.';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only. The AI function is installed correctly.' });
  try {
    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel (Settings > Environment Variables), or you have not redeployed yet.' });

    // 1. only signed-in Chatora users may use it (protects your Gemini quota)
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    const who = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
    });
    if (!who.ok) return res.status(401).json({ error: 'Please sign in again.' });

    // 2. turn the chat history into Gemini's format
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    let msgs = Array.isArray(body && body.messages) ? body.messages : [];
    if (!msgs.length && body && body.message) msgs = [{ role: 'user', content: body.message }];
    const contents = [];
    for (const m of msgs.slice(-20)) {
      const text = String((m && m.content) ?? '').trim().slice(0, 6000);
      if (!text) continue;
      const role = m.role === 'assistant' ? 'model' : 'user', last = contents[contents.length - 1];
      if (last && last.role === role) last.parts[0].text += '\n' + text; else contents.push({ role, parts: [{ text }] });
    }
    while (contents.length && contents[0].role !== 'user') contents.shift();
    if (!contents.length) return res.status(400).json({ error: 'No message to answer.' });

    // 3. ask Gemini (thinking off = fast replies)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM }] }, contents,
      generationConfig: { maxOutputTokens: 800, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } }
    };
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    const call = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(payload), signal: ctl.signal });
    let r = await call();
    if (r.status === 400) { delete payload.generationConfig.thinkingConfig; r = await call(); }
    clearTimeout(timer);
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: (data && data.error && data.error.message) || 'Gemini request failed.' });
    const reply = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('').trim();
    return res.status(200).json({ reply: reply || 'Sorry, I could not come up with an answer to that.' });
  } catch (err) {
    return res.status(500).json({ error: err && err.name === 'AbortError' ? 'Gemini took too long.' : 'Server error.' });
  }
};
