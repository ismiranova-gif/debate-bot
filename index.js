require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const systemPrompt = require('./systemPrompt');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: {
      timeout: 5
    }
  }
});
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Храним историю диалога отдельно для каждого чата
const sessions = {};

async function askBot(chatId, userText) {
  if (!sessions[chatId]) sessions[chatId] = [];
  sessions[chatId].push({ role: 'user', content: userText });

  // Ограничиваем историю последними 10 сообщениями, чтобы не тратить лимит зря
  const trimmedHistory = sessions[chatId].slice(-10);

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      ...trimmedHistory
    ],
    max_tokens: 800
  });

  const reply = completion.choices[0].message.content;
  sessions[chatId].push({ role: 'assistant', content: reply });
  return reply;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  // Команда для сброса сессии — начать новую тему
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

bot.on('polling_error', (err) => {
  console.log('Проблема с соединением, пробуем снова...', err.code);
});

console.log('Бот запущен и слушает сообщения...');

const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(process.env.PORT || 3000, () => {
  console.log('Веб-сервер для Render запущен');
});