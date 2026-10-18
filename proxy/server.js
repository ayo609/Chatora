// Chatora AI server (Render). Calls Google Gemini. The API key lives ONLY in Render's environment variables.
//
// Render > your service > Environment:
//   GEMINI_API_KEY   = your Gemini key            (required)
//   GEMINI_MODEL     = gemini-2.5-flash           (optional, change if Google retires the model)
//   ALLOWED_ORIGIN   = https://your-site.com      (optional but recommended; comma-separate several)
import express from 'express';
import cors from 'cors';

const app = express();
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({ origin: ORIGINS.length ? ORIGINS : true }));
app.use(express.json({ limit: '1mb' }));

// Wake-up / health checks (the chat page and cron-job.org ping these)
app.get('/', (_req, res) => res.send('Chatora AI is awake'));
app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL }));

// Tiny per-IP rate limit so nobody can burn your Gemini quota (30 requests / minute)
const hits = new Map();
app.use('/api', (req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 30) return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
  arr.push(now); hits.set(ip, arr);
  next();
});

const SYSTEM = 'You are Chatora AI, a friendly and concise assistant inside a chat app. ' +
  'Reply in the same language the user writes in. Keep answers short unless asked for detail.';

app.post('/api/chat', async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });

    let msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!msgs.length && req.body?.message) msgs = [{ role: 'user', content: req.body.message }];

    // Convert to Gemini format and merge consecutive turns from the same role
    const contents = [];
    for (const m of msgs.slice(-20)) {
      const text = String(m?.content ?? '').trim().slice(0, 6000);
      if (!text) continue;
      const role = m.role === 'assistant' ? 'model' : 'user';
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts[0].text += '\n' + text;
      else contents.push({ role, parts: [{ text }] });
    }
    while (contents.length && contents[0].role !== 'user') contents.shift();
    if (!contents.length) return res.status(400).json({ error: 'No message to answer.' });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: { maxOutputTokens: 800, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } } // thinking off = fast replies
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    let r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body), signal: ctl.signal });
    // If the model doesn't accept thinkingConfig, retry once without it
    if (r.status === 400) {
      delete body.generationConfig.thinkingConfig;
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body), signal: ctl.signal });
    }
    clearTimeout(timer);
    const data = await r.json();
    if (!r.ok) {
      console.error('Gemini error', r.status, data?.error?.message);
      return res.status(502).json({ error: data?.error?.message || 'Gemini request failed.' });
    }
    const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    res.json({ reply: reply || 'Sorry, I could not come up with an answer to that.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'Gemini took too long.' : 'Server error.' });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Chatora AI listening'));
