require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const express = require('express');
const systemPrompt = require('./systemPrompt');

const token = process.env.TELEGRAM_TOKEN;
const webhookUrl = process.env.WEBHOOK_URL;
const safeToken = token.replace(/:/g, '_');

// Бот работает через webhook, без polling
const bot = new TelegramBot(token);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();
app.use(express.json());

// Храним историю диалога отдельно для каждого чата
const sessions = {};
const sessionTimestamps = {};

// Раз в час удаляем сессии, неактивные больше 2 часов
setInterval(() => {
  const now = Date.now();
  for (const chatId in sessionTimestamps) {
    if (now - sessionTimestamps[chatId] > 2 * 60 * 60 * 1000) {
      delete sessions[chatId];
      delete sessionTimestamps[chatId];
    }
  }
}, 60 * 60 * 1000);

async function askBot(chatId, userText) {
  if (!sessions[chatId]) sessions[chatId] = [];
  sessionTimestamps[chatId] = Date.now();
  sessions[chatId].push({ role: 'user', content: userText });

  const trimmedHistory = sessions[chatId].slice(-10);

  const completion = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      ...trimmedHistory
    ],
    max_tokens: 1500
  });

  let reply = completion.choices[0].message.content;
  reply = reply.replace(/<br\s*\/?>/gi, '\n');
  reply = reply.replace(/\*\*/g, '');

  sessions[chatId].push({ role: 'assistant', content: reply });
  return reply;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  if (text === '/new') {
    sessions[chatId] = [];
    bot.sendMessage(chatId, 'Ξεκινάμε νέα συνεδρία. Τι θέλεις να κάνουμε;');
    return;
  }

  try {
    bot.sendChatAction(chatId, 'typing');
    const reply = await askBot(chatId, text);
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Κάτι πήγε στραβά, δοκίμασε ξανά σε λίγο.');
  }
});

// Telegram присылает сообщения именно на этот адрес (двоеточие из токена заменено на _)
app.post(`/bot${safeToken}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Веб-сервер запущен на порту', PORT);

  try {
    await bot.setWebHook(`${webhookUrl}/bot${safeToken}`);
    console.log('Webhook успешно установлен:', `${webhookUrl}/bot${safeToken}`);
  } catch (err) {
    console.error('Ошибка установки webhook:', err.message);
  }
});