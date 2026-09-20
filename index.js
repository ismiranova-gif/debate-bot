require('dotenv').config({ quiet: true });
const { Api, InputFile } = require('node-telegram-bot-api');
const { createHash, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const Groq = require('groq-sdk');
const express = require('express');
const systemPrompt = require('./systemPrompt');

function configuration(env = process.env) {
  for (const name of ['TELEGRAM_TOKEN', 'GROQ_API_KEY', 'WEBHOOK_URL', 'WEBHOOK_CERTIFICATE']) {
    if (!env[name]?.trim()) throw new Error(`Missing configuration: ${name}`);
  }
  const url = new URL(env.WEBHOOK_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('WEBHOOK_URL must be an HTTPS origin');
  }
  return {
    token: env.TELEGRAM_TOKEN.trim(), apiKey: env.GROQ_API_KEY.trim(),
    webhookUrl: `${url.origin}/telegram`, certificate: env.WEBHOOK_CERTIFICATE,
    secret: createHash('sha256').update(`debate-bot-webhook:${env.TELEGRAM_TOKEN.trim()}`).digest('hex'),
    revision: env.REVISION || 'development',
  };
}

function createApplication(config, dependencies = {}) {
  const api = dependencies.api || new Api(config.token);
  const groq = dependencies.groq || new Groq({ apiKey: config.apiKey });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  const sessions = new Map();
  let ready = false;
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) {
      if (Date.now() - session.lastActive > 2 * 60 * 60 * 1000) sessions.delete(id);
    }
  }, 60 * 60 * 1000);
  cleanup.unref();

  async function handleMessage(msg) {
    if (!msg?.chat?.id || typeof msg.text !== 'string') return;
    const chat_id = msg.chat.id;
    try {
      if (msg.text === '/new') {
        sessions.delete(chat_id);
        await api.sendMessage({ chat_id, text: 'Ξεκινάμε νέα συνεδρία. Τι θέλεις να κάνουμε;' });
        return;
      }
      await api.sendChatAction({ chat_id, action: 'typing' });
      const session = sessions.get(chat_id) || { messages: [] };
      session.lastActive = Date.now();
      session.messages.push({ role: 'user', content: msg.text });
      session.messages = session.messages.slice(-10);
      sessions.set(chat_id, session);
      const result = await groq.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'system', content: systemPrompt }, ...session.messages],
        max_tokens: 1500,
      });
      const text = result.choices[0].message.content.replace(/<br\s*\/?>/gi, '\n').replace(/\*\*/g, '');
      session.messages.push({ role: 'assistant', content: text });
      await api.sendMessage({ chat_id, text });
    } catch {
      // SDK errors may contain request URLs and credentials. Never log raw errors.
      console.error('Message processing failed');
      try { await api.sendMessage({ chat_id, text: 'Κάτι πήγε στραβά, δοκίμασε ξανά σε λίγο.' }); }
      catch { console.error('Could not send error response'); }
    }
  }

  app.post('/telegram', (req, res) => {
    const received = Buffer.from(req.get('X-Telegram-Bot-Api-Secret-Token') || '');
    const expected = Buffer.from(config.secret);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return res.sendStatus(403);
    if (!ready) return res.sendStatus(503);
    if (!Number.isSafeInteger(req.body?.update_id)) return res.sendStatus(400);
    res.sendStatus(200);
    void handleMessage(req.body.message);
  });
  app.get('/', (req, res) => res.send('Bot is running'));
  app.get('/healthz', async (req, res) => {
    let webhookMatches = false;
    if (ready) {
      try {
        const info = await api.getWebhookInfo();
        webhookMatches = info.url === config.webhookUrl && info.has_custom_certificate === true;
      } catch { /* An unreachable API must not produce a successful health check. */ }
    }
    res.status(webhookMatches ? 200 : 503).json({ ready: webhookMatches, revision: config.revision });
  });

  async function registerWebhook() {
    const options = {
      url: config.webhookUrl, secret_token: config.secret,
      allowed_updates: ['message'], drop_pending_updates: false,
    };
    // Read the server-only certificate before touching Telegram. Legacy hosts
    // without this configuration cannot take over the production webhook.
    options.certificate = new InputFile(readFileSync(config.certificate), { filename: 'webhook.pem' });
    await api.setWebhook(options);
    const info = await api.getWebhookInfo();
    if (info.url !== config.webhookUrl || (config.certificate && !info.has_custom_certificate)) throw new Error('Webhook verification failed');
    ready = true;
    console.log('Webhook registered and verified');
  }
  return { app, registerWebhook, handleMessage, close: () => clearInterval(cleanup) };
}

async function main() {
  const runtime = createApplication(configuration());
  const server = runtime.app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try { await runtime.registerWebhook(); }
  catch {
    console.error('Webhook registration failed; stopping');
    server.close(); runtime.close(); process.exitCode = 1;
  }
  const stop = () => { runtime.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
if (require.main === module) main().catch(() => { console.error('Startup failed; check configuration'); process.exitCode = 1; });
module.exports = { configuration, createApplication };
