require('dotenv').config({ quiet: true });
const { Api } = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const { writeFileSync } = require('node:fs');
const { configuration } = require('../index');

(async () => {
  const config = configuration();
  const api = new Api(config.token);
  const me = await api.getMe();
  if (!me.is_bot) throw new Error('Not a bot');
  const models = await new Groq({ apiKey: config.apiKey }).models.list();
  if (!models.data.some(model => model.id === 'openai/gpt-oss-120b' && model.active !== false)) throw new Error('Model unavailable');
  if (process.argv.includes('--snapshot')) {
    writeFileSync('.webhook-before.json', JSON.stringify(await api.getWebhookInfo()), { mode: 0o600 });
  }
  console.log('Telegram identity and Groq model access verified');
})().catch(() => { console.error('API preflight failed: check TELEGRAM_TOKEN and GROQ_API_KEY'); process.exitCode = 1; });
