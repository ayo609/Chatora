// Chatora AI server (Render). Calls OpenAI.
// Render > your service > Environment:
//   OPENAI_API_KEY   = sk-... (your OpenAI key)
//   OPENAI_MODEL     = gpt-4o-mini (or gpt-4o)
//   ALLOWED_ORIGIN   = https://your-site.com
//
// Render > Settings > Node Version must be 20 or 22 (needed for global fetch)

import express from 'express';
import cors from 'cors';

const app = express();

// Trust Render's proxy so req.ip returns the real user IP
app.set('trust proxy', 1);

const KEY    = process.env.OPENAI_API_KEY;
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

// CORS
app.use(cors({ 
  origin: ORIGINS.length ? ORIGINS : true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '1mb' }));

// ---------- Health checks ----------
app.get('/',      (_req, res) => res.send('Chatora AI is awake'));
app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL }));

// ---------- Rate limit: 30 requests / minute / IP ----------
const hits = new Map();
app.use('/api', (req, res, next) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 30) return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
  arr.push(now); hits.set(ip, arr);
  next();
});

// ---------- System prompts ----------
const SYSTEM_CHAT =
  'You are Chatora AI, a friendly, concise assistant inside a chat app. ' +
  'Reply in the same language the user writes in. Keep answers short unless asked for detail.';

const SYSTEM_SUMMARY =
  'You summarize group chats and DMs into 3–5 short bullet points. ' +
  'Only include decisions, action items, key facts and deadlines. ' +
  'Do not invent information. Reply in the same language as the conversation.';

const SYSTEM_TRANSLATE =
  'You are a translator. Translate the user\'s message into the target language. ' +
  'Reply with ONLY the translation — no explanations, no quotes, no prefixes.';

// ---------- Core helper: call OpenAI ----------
async function callOpenAI({ system, messages, maxTokens = 800 }) {
  const url = 'https://api.openai.com/v1/chat/completions';

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      ...messages
    ],
    max_tokens: maxTokens,
    temperature: 0.7
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KEY}`
      },
      body: JSON.stringify(body),
      signal: ctl.signal
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('OpenAI error', r.status, data?.error?.message);
      throw new Error(data?.error?.message || 'OpenAI request failed');
    }

    const reply = data.choices?.[0]?.message?.content?.trim();
    return reply || 'Sorry, I could not come up with an answer to that.';
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Convert chat messages to OpenAI format ----------
function toOpenAIMessages(msgs) {
  const out = [];
  for (const m of msgs.slice(-20)) {
    const text = String(m?.content ?? '').trim().slice(0, 6000);
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + text;
    else out.push({ role, content: text });
  }
  // OpenAI doesn't require starting with 'user' but it's cleaner if we do
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ---------- POST /api/chat ----------
app.post('/api/chat', async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server.' });

    let msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!msgs.length && req.body?.message) msgs = [{ role: 'user', content: req.body.message }];

    const oaMsgs = toOpenAIMessages(msgs);
    if (!oaMsgs.length) return res.status(400).json({ error: 'No message to answer.' });

    const reply = await callOpenAI({ system: SYSTEM_CHAT, messages: oaMsgs });
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'OpenAI took too long.' : (err.message || 'Server error.') });
  }
});

// ---------- POST /api/summarize  (for the "Summarize chat" button) ----------
app.post('/api/summarize', async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server.' });

    const transcript = String(req.body?.transcript || '').trim().slice(0, 12000);
    if (transcript.length < 20) return res.status(400).json({ error: 'Chat is too short to summarize.' });

    const reply = await callOpenAI({
      system: SYSTEM_SUMMARY,
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 400
    });
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'OpenAI took too long.' : (err.message || 'Server error.') });
  }
});

// ---------- POST /api/translate  (for "Translate to X") ----------
app.post('/api/translate', async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server.' });

    const text   = String(req.body?.text || '').trim().slice(0, 4000);
    const target = String(req.body?.target || 'English').trim().slice(0, 60);
    if (!text) return res.status(400).json({ error: 'No text to translate.' });

    const reply = await callOpenAI({
      system: SYSTEM_TRANSLATE,
      messages: [{ role: 'user', content: `Target language: ${target}\n\nMessage: ${text}` }],
      maxTokens: 800
    });
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'OpenAI took too long.' : (err.message || 'Server error.') });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chatora AI listening on ${PORT}`));
