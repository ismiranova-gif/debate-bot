const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Api, InputFile } = require('node-telegram-bot-api');
const { configuration, createApplication } = require('../index');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const env = { TELEGRAM_TOKEN: '12345:test-token', GROQ_API_KEY: 'test-key', WEBHOOK_URL: 'https://185.183.157.185', REVISION: 'test-revision' };

test('configuration rejects missing secrets and non-HTTPS URL', () => {
  assert.throws(() => configuration({}), /TELEGRAM_TOKEN/);
  assert.throws(() => configuration({ ...env, WEBHOOK_URL: 'http://example.com' }), /HTTPS/);
  assert.equal(configuration(env).webhookUrl, 'https://185.183.157.185/telegram');
  assert.equal(configuration(env).secret.length, 64);
});

test('webhook registers certificate, authenticates requests and reports readiness', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'debate-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const certificate = join(dir, 'cert.pem'); writeFileSync(certificate, 'public certificate fixture');
  const config = configuration({ ...env, WEBHOOK_CERTIFICATE: certificate });
  let registered;
  const sent = [];
  const api = {
    setWebhook: async options => { registered = options; },
    getWebhookInfo: async () => ({ url: config.webhookUrl, has_custom_certificate: true }),
    sendMessage: async params => sent.push(params), sendChatAction: async () => {},
  };
  const runtime = createApplication(config, { api, groq: {} }); t.after(runtime.close);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/healthz')).status, 503);
  await runtime.registerWebhook();
  assert(registered.certificate instanceof InputFile);
  assert.equal(registered.secret_token, config.secret);
  assert.equal(registered.drop_pending_updates, false);
  assert.deepEqual(await (await fetch(url + '/healthz')).json(), { ready: true, revision: 'test-revision' });
  const body = JSON.stringify({ update_id: 1, message: { chat: { id: 42 }, text: '/new' } });
  assert.equal((await fetch(url + '/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal(sent.length, 0);
  assert.equal((await fetch(url + '/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': config.secret }, body })).status, 200);
  assert.equal(sent[0].chat_id, 42);
});

test('registration failure leaves health unready', async t => {
  const runtime = createApplication(configuration(env), { api: { setWebhook: async () => { throw Error('failure'); } }, groq: {} });
  t.after(runtime.close);
  await assert.rejects(runtime.registerWebhook(), /failure/);
});

test('v2 API sends messages and multipart certificate using supported transport', async () => {
  const requests = [];
  const api = new Api(env.TELEGRAM_TOKEN, { fetch: async (url, options) => {
    requests.push({ url, options, body: await new Response(options.body).text() });
    return new Response(JSON.stringify({ ok: true, result: true }), { headers: { 'Content-Type': 'application/json' } });
  } });
  await api.sendMessage({ chat_id: 42, text: 'hello' });
  await api.setWebhook({ url: 'https://185.183.157.185/telegram', certificate: new InputFile(Buffer.from('cert'), { filename: 'webhook.pem' }) });
  assert.equal(requests.length, 2);
  assert.match(new Headers(requests[1].options.headers).get('content-type'), /^multipart\/form-data/);
  assert.match(requests[1].body, /filename="webhook.pem"/);
  assert.match(requests[1].body, /cert/);
});

test('Greek reply generation and /new retain bot behavior', async t => {
  const sent = [], prompts = [];
  const runtime = createApplication(configuration(env), {
    api: { sendChatAction: async () => {}, sendMessage: async p => sent.push(p) },
    groq: { chat: { completions: { create: async p => { prompts.push(p); return { choices: [{ message: { content: '**Γεια**<br>σου' } }] }; } } } },
  }); t.after(runtime.close);
  await runtime.handleMessage({ chat: { id: 42 }, text: 'hello' });
  assert.equal(sent[0].text, 'Γεια\nσου');
  assert.equal(prompts[0].model, 'openai/gpt-oss-120b');
  await runtime.handleMessage({ chat: { id: 42 }, text: '/new' });
  await runtime.handleMessage({ chat: { id: 42 }, text: 'new topic' });
  assert.equal(prompts[1].messages.length, 2);
});
