require('dotenv').config({ quiet: true });
const { Api, InputFile } = require('node-telegram-bot-api');
const { readFileSync } = require('node:fs');
const { configuration } = require('../index');

(async () => {
  const config = configuration();
  const api = new Api(config.token);
  const previous = JSON.parse(readFileSync('.webhook-before.json', 'utf8'));
  if (!previous.url) {
    await api.deleteWebhook({ drop_pending_updates: false });
  } else {
    const options = { url: previous.url, allowed_updates: previous.allowed_updates || ['message'], drop_pending_updates: false };
    if (previous.has_custom_certificate) {
      if (previous.url !== config.webhookUrl) throw new Error('Previous certificate is unavailable');
      options.certificate = new InputFile(readFileSync(config.certificate), { filename: 'webhook.pem' });
      options.secret_token = config.secret;
    }
    await api.setWebhook(options);
  }
  console.log('Previous Telegram webhook restored');
})().catch(() => { console.error('Could not restore previous webhook; manual recovery required'); process.exitCode = 1; });
