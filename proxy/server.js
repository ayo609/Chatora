// Chatora server (Render): Gemini AI replies + push notifications.
// All secrets live ONLY in Render > Environment, never in the repo:
//   GEMINI_API_KEY            your Gemini key                                  (AI)
//   GEMINI_MODEL              optional, default gemini-2.5-flash
//   ALLOWED_ORIGIN            optional, your site(s), comma separated
//   FIREBASE_SERVICE_ACCOUNT  the whole service-account JSON on one line       (push)
//   APP_URL                   where chat.html lives, e.g. https://yoursite.com (push)
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const app = express();
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

let fb = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    fb = admin;
  }
} catch (e) { console.error('Firebase admin init failed:', e.message); }

app.use(cors({ origin: ORIGINS.length ? ORIGINS : true }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => res.send('Chatora server is awake'));
app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL, push: !!fb }));

// Small per-IP rate limit: 30 AI requests/minute, 200 notify requests/minute
const hits = new Map();
app.use('/api', (req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const limit = req.path === '/notify' ? 200 : 30, k = ip + req.path, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < 60000);
  if (arr.length >= limit) return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
  arr.push(now); hits.set(k, arr); next();
});

/* ---------------- AI chat (Gemini) ---------------- */
const SYSTEM = 'You are Chatora AI, a friendly and concise assistant inside a chat app. Reply in the same language the user writes in. Keep answers short unless asked for detail.';
app.post('/api/chat', async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });
    let msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!msgs.length && req.body?.message) msgs = [{ role: 'user', content: req.body.message }];
    const contents = [];
    for (const m of msgs.slice(-20)) {
      const text = String(m?.content ?? '').trim().slice(0, 6000); if (!text) continue;
      const role = m.role === 'assistant' ? 'model' : 'user', last = contents[contents.length - 1];
      if (last && last.role === role) last.parts[0].text += '\n' + text; else contents.push({ role, parts: [{ text }] });
    }
    while (contents.length && contents[0].role !== 'user') contents.shift();
    if (!contents.length) return res.status(400).json({ error: 'No message to answer.' });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const body = { systemInstruction: { parts: [{ text: SYSTEM }] }, contents, generationConfig: { maxOutputTokens: 800, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } } };
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
    const call = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body), signal: ctl.signal });
    let r = await call();
    if (r.status === 400) { delete body.generationConfig.thinkingConfig; r = await call(); }
    clearTimeout(timer);
    const data = await r.json();
    if (!r.ok) { console.error('Gemini error', r.status, data?.error?.message); return res.status(502).json({ error: data?.error?.message || 'Gemini request failed.' }); }
    const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    res.json({ reply: reply || 'Sorry, I could not come up with an answer to that.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.name === 'AbortError' ? 'Gemini took too long.' : 'Server error.' });
  }
});

/* ---------------- Push notifications (FCM) ---------------- */
// The chat page calls this after sending a message or starting a call.
// The server checks who is calling, finds the other members' devices, respects mute/block/preview settings, and sends the push.
app.post('/api/notify', async (req, res) => {
  if (!fb) return res.status(501).json({ error: 'Push is not configured on the server.' });
  try {
    const idToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const { uid } = await fb.auth().verifyIdToken(idToken);
    const { kind = 'message', chatId, type = 'text', text = '', callId = '', callType = 'voice' } = req.body || {};
    if (!chatId || typeof chatId !== 'string') return res.status(400).json({ error: 'chatId required' });
    const db = fb.firestore(), isDm = chatId.includes('_');
    let members, groupName = '';
    if (isDm) members = chatId.split('_');
    else { const c = await db.doc(`chats/${chatId}`).get(); if (!c.exists) return res.status(404).json({ error: 'No such chat' }); members = c.data().members || []; groupName = c.data().name || 'Group'; }
    if (!members.includes(uid)) return res.status(403).json({ error: 'Not a member of this chat' });
    const me = (await db.doc(`users/${uid}`).get()).data() || {}, sender = me.name || 'Someone';
    const labels = { image: '📷 Photo', voice: '🎙️ Voice message', contact: '👤 Contact', groupinvite: '📨 Group invite' };
    const preview = labels[type] ?? String(text).slice(0, 110);
    const out = [];
    for (const m of members.filter(x => x !== uid)) {
      const u = (await db.doc(`users/${m}`).get()).data() || {};
      if ((u.blocked || []).includes(uid)) continue;
      if (kind === 'message' && (u.muted || []).includes(chatId)) continue;
      const devs = await db.collection(`users/${m}/devices`).get();
      devs.forEach(d => {
        const token = d.data().token; if (!token) return;
        const call = kind === 'call';
        const body = call ? `Incoming ${callType === 'video' ? 'video' : 'voice'} call` : (u.notifPreview === false ? 'New message' : (isDm ? preview : `${sender}: ${preview}`));
        out.push({ ref: d.ref, msg: { token,
          data: { kind, title: call || isDm ? sender : groupName, body, chatId, callId: String(callId), tag: call ? `call-${callId}` : `chat-${chatId}`, url: `${APP_URL}/chat.html?chat=${encodeURIComponent(chatId)}`, icon: `${APP_URL}/chatora-logo.png` },
          webpush: { headers: { Urgency: 'high', TTL: call ? '30' : '86400' } }, android: { priority: 'high' } } });
      });
    }
    if (!out.length) return res.json({ sent: 0 });
    const result = await fb.messaging().sendEach(out.map(o => o.msg));
    let sent = 0;
    result.responses.forEach((r, i) => {
      if (r.success) sent++;
      else if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(r.error?.code || '')) out[i].ref.delete().catch(() => {});
    });
    res.json({ sent });
  } catch (err) {
    console.error('notify failed:', err.message);
    res.status(err.code === 'auth/argument-error' || /token/i.test(err.message) ? 401 : 500).json({ error: 'Could not send notification.' });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Chatora server listening'));
