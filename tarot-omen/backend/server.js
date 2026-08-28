import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL =
  process.env.TELEGRAM_WEBHOOK_URL || 'https://tarot-omen1.onrender.com/telegram-webhook';

// Local visual assets, committed alongside server.js — no external URLs
// (external card-image URLs previously caused WEBPAGE_CURL_FAILED).
const SHUFFLE_GIF_PATH = path.join(__dirname, 'shuffle.gif');
const CARDS_DIR = path.join(__dirname, 'cards');

if (!GEMINI_API_KEY) {
  console.warn('[tarot-omen] WARNING: GEMINI_API_KEY is not set.');
}
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[tarot-omen] WARNING: TELEGRAM_BOT_TOKEN is not set. Telegram bot will not run.');
}

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Very small in-memory throttle: max 12 requests / 10 minutes per client key.
// Good enough for an MVP; replace with a real store if traffic grows.
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 12;

function rateLimited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > MAX_HITS;
}

// Hard cap on the interpretation text itself, independent of the model's token
// limit — this is what actually guarantees "~3000 characters" regardless of how
// many characters-per-token the model happens to produce.
const MAX_INTERPRETATION_CHARS = 3000;

function capText(text, maxLen) {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
  const cut = lastBreak > maxLen * 0.6 ? lastBreak + 1 : maxLen;
  return text.slice(0, cut).trim() + '…';
}

const SYSTEM_PROMPT = `You are the reading voice of Tarot Omen, a Tarot mini app.

You receive: a user's question, and three already-drawn Tarot cards (each with its
position, name, and orientation — upright or reversed). The cards were chosen by a
random generator before you were called. You never choose or invent cards.

Write one unified, personal interpretation of the spread AS IT RELATES TO THE
QUESTION — not a generic listing of card meanings. Specifically:
- Read each card in light of its position (The Situation / What Influences It /
  Where It May Lead) and its orientation.
- Weave the three cards into one coherent narrative, noting how they interact.
- Be specific to the question's actual topic and phrasing.
- Keep language reflective and open, e.g. "The cards suggest...", "This spread
  points to...", "Seen through this reading...". Never claim certainty about the
  future (avoid phrasing like "this will definitely happen").
- If the question concerns health: never diagnose, and never state that the
  person is or is not healthy. Offer only reflective interpretation, and if
  symptoms sound potentially serious, gently recommend seeing a qualified
  professional.
- If the question concerns money or finance: never promise a financial outcome
  (e.g. never say "you will definitely make money"). Offer reflective
  interpretation of the situation and factors worth attention instead.
- Reply in the same language the user's question is written in.
- Length: about 4 short paragraphs. No headers, no bullet lists, no card-by-card
  labels — a flowing reading.`;

// ===== AI INTERPRETATION (shared by /api/interpret and the Telegram bot) =====

async function generateInterpretation(question, cards) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  if (typeof question !== 'string' || !question.trim() || question.trim().length > 400) {
    throw new Error('Invalid question.');
  }
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('Exactly three cards are required.');
  }
  for (const c of cards) {
    if (
      typeof c?.position !== 'string' ||
      typeof c?.name !== 'string' ||
      (c.orientation !== 'upright' && c.orientation !== 'reversed') ||
      typeof c?.keywords !== 'string'
    ) {
      throw new Error('Malformed card data.');
    }
  }

  const cardBlock = cards
    .map(
      (c, i) =>
        `Card ${i + 1} — ${c.position}\nName: ${c.name}\nOrientation: ${c.orientation}\nKeywords: ${c.keywords}`
    )
    .join('\n\n');

  const userMessage = `User's question:\n"${question.trim()}"\n\nDrawn spread:\n\n${cardBlock}`;

  // Timeout guard so a stalled Gemini request can never hang the request forever
  // (adopted from server_lust.js — this is what prevents "no response at all").
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  let response;
  let raw;
  try {
    response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 3000 }
        }),
        signal: controller.signal
      }
    );
    raw = await response.text();
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Gemini request timed out after 60 seconds.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  let responseData;
  try {
    responseData = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    console.error('[tarot-omen] Gemini API error:', responseData);
    throw new Error(responseData?.error?.message || `Gemini API HTTP ${response.status}`);
  }

  const interpretation = responseData?.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();

  if (!interpretation) {
    const reason = responseData?.candidates?.[0]?.finishReason;
    throw new Error(
      reason ? `Gemini returned no text (finishReason: ${reason}).` : 'Gemini returned an empty interpretation.'
    );
  }

  return capText(interpretation, MAX_INTERPRETATION_CHARS);
}

// ===== /api/interpret — used by the Mini App frontend =====

app.post('/api/interpret', async (req, res) => {
  try {
    const clientKey = req.ip || 'unknown';
    if (rateLimited(clientKey)) {
      return res.status(429).json({ error: 'Too many readings requested. Please wait a few minutes.' });
    }

    const body = req.body || {};
    const question = typeof body.question === 'string' ? body.question.trim() : String(body.question || '').trim();
    const cards = body.cards;

    const interpretation = await generateInterpretation(question, cards);
    res.json({ interpretation });
  } catch (err) {
    console.error('[tarot-omen] /api/interpret failed:', err);
    const status = /invalid|required|malformed/i.test(err?.message || '') ? 400 : 502;
    res.status(status).json({ error: err?.message || 'Something went wrong generating the reading.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ===== TAROT DECK =====

const MAJOR_ARCANA = [
  ["Шут", "новое начало, свобода, риск"],
  ["Маг", "инициатива, воля, возможности"],
  ["Верховная Жрица", "интуиция, тайна, внутреннее знание"],
  ["Императрица", "рост, творчество, изобилие"],
  ["Император", "порядок, контроль, ответственность"],
  ["Иерофант", "традиции, обучение, убеждения"],
  ["Влюблённые", "выбор, отношения, ценности"],
  ["Колесница", "движение, решимость, победа"],
  ["Сила", "внутренняя сила, выдержка, самообладание"],
  ["Отшельник", "поиск, размышление, самостоятельность"],
  ["Колесо Фортуны", "перемены, цикл, поворот"],
  ["Справедливость", "баланс, последствия, решение"],
  ["Повешенный", "пауза, новый взгляд, отпускание"],
  ["Смерть", "завершение, трансформация, переход"],
  ["Умеренность", "гармония, баланс, постепенность"],
  ["Дьявол", "зависимость, искушение, привязанность"],
  ["Башня", "резкая перемена, разрушение, освобождение"],
  ["Звезда", "надежда, вдохновение, восстановление"],
  ["Луна", "неопределённость, страхи, подсознание"],
  ["Солнце", "ясность, энергия, успех"],
  ["Суд", "пробуждение, переоценка, решение"],
  ["Мир", "завершение, целостность, новый этап"]
];

const SUITS = [
  ["Жезлов", "действие, энергия, инициатива"],
  ["Кубков", "эмоции, отношения, чувства"],
  ["Мечей", "мысли, решения, конфликт"],
  ["Пентаклей", "материальное, работа, ресурсы"]
];

const RANKS = [
  ["Туз", "начало, потенциал, возможность"],
  ["Двойка", "выбор, баланс, взаимодействие"],
  ["Тройка", "рост, развитие, сотрудничество"],
  ["Четвёрка", "стабильность, структура, пауза"],
  ["Пятёрка", "напряжение, перемены, испытание"],
  ["Шестёрка", "движение, помощь, восстановление"],
  ["Семёрка", "проверка, стратегия, настойчивость"],
  ["Восьмёрка", "движение, дисциплина, процесс"],
  ["Девятка", "результат, зрелость, внутренний ресурс"],
  ["Десятка", "завершение, итог, ответственность"],
  ["Паж", "новость, обучение, любопытство"],
  ["Рыцарь", "движение, импульс, действие"],
  ["Королева", "зрелость, понимание, влияние"],
  ["Король", "контроль, мастерство, ответственность"]
];

const TAROT_DECK = [
  ...MAJOR_ARCANA.map(([name, keywords]) => ({ name, keywords })),
  ...SUITS.flatMap(([suit, suitKeywords]) =>
    RANKS.map(([rank, rankKeywords]) => ({
      name: `${rank} ${suit}`,
      keywords: `${rankKeywords}; ${suitKeywords}`
    }))
  )
];

function drawThreeCards() {
  const shuffled = [...TAROT_DECK].sort(() => Math.random() - 0.5);

  const positions = ["Ситуация", "Что влияет на ситуацию", "К чему это может привести"];

  return shuffled.slice(0, 3).map((card, index) => ({
    position: positions[index],
    name: card.name,
    orientation: Math.random() < 0.5 ? "upright" : "reversed",
    keywords: card.keywords
  }));
}

// Maps a card name to the short image code used for its local file
// (cards/<code>.jpg). Reused as-is from the earlier working version —
// same code scheme, just pointed at local files instead of an external URL.
function tarotImageCode(name) {
  const major = {
    "Шут": "ar00", "Маг": "ar01", "Верховная Жрица": "ar02", "Императрица": "ar03",
    "Император": "ar04", "Иерофант": "ar05", "Влюблённые": "ar06", "Колесница": "ar07",
    "Сила": "ar08", "Отшельник": "ar09", "Колесо Фортуны": "ar10", "Справедливость": "ar11",
    "Повешенный": "ar12", "Смерть": "ar13", "Умеренность": "ar14", "Дьявол": "ar15",
    "Башня": "ar16", "Звезда": "ar17", "Луна": "ar18", "Солнце": "ar19", "Суд": "ar20", "Мир": "ar21"
  };

  if (major[name]) return major[name];

  const suitMap = { "Жезлов": "wa", "Кубков": "cu", "Мечей": "sw", "Пентаклей": "pe" };
  const rankMap = {
    "Туз": "ac", "Паж": "pa", "Рыцарь": "kn", "Королева": "qu", "Король": "ki",
    "Двойка": "02", "Тройка": "03", "Четвёрка": "04", "Пятёрка": "05",
    "Шестёрка": "06", "Семёрка": "07", "Восьмёрка": "08", "Девятка": "09", "Десятка": "10"
  };

  for (const [rank, rankCode] of Object.entries(rankMap)) {
    for (const [suit, suitCode] of Object.entries(suitMap)) {
      if (name === `${rank} ${suit}`) return `${suitCode}${rankCode}`;
    }
  }

  return null;
}

// ===== TELEGRAM BOT (webhook mode — no polling, no getUpdates loop) =====
//
// Render restarts/redeploys can briefly run two instances of the process.
// Long-polling (getUpdates) breaks in that situation with a 409 Conflict,
// because Telegram only allows one active getUpdates consumer per bot.
// A webhook has no such problem: Telegram just POSTs each update to this
// URL, and only whichever instance is currently live receives it.

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_CHUNK_SIZE = 3500; // safety margin under the 4096 hard limit

function splitForTelegram(text, maxLen = TELEGRAM_CHUNK_SIZE) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
      if (breakAt > maxLen * 0.5) {
        end = start + breakAt;
      }
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

async function telegramSendMessage(chatId, text) {
  const parts = splitForTelegram(text);
  for (const part of parts) {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part })
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Telegram sendMessage failed: ${errBody}`);
    }
  }
}

// Sends shuffle.gif as a real Telegram animation (local file, multipart —
// never an external URL). If the file isn't present yet in the repo, this
// logs a warning and falls back to a plain text message instead of failing
// the whole flow, so the bot keeps working even before the asset is added.
async function telegramSendShuffleGif(chatId) {
  let gifBuffer;
  try {
    gifBuffer = await readFile(SHUFFLE_GIF_PATH);
  } catch {
    console.warn(`[tarot-omen] shuffle.gif not found at ${SHUFFLE_GIF_PATH}, sending text instead.`);
    await telegramSendMessage(chatId, '🔮 Перемешиваю карты...');
    return;
  }

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('animation', new Blob([gifBuffer], { type: 'image/gif' }), 'shuffle.gif');
  form.append('caption', '🔮 Перемешиваю карты...');

  const response = await fetch(`${TELEGRAM_API}/sendAnimation`, { method: 'POST', body: form });
  if (!response.ok) {
    console.warn(`[tarot-omen] sendAnimation failed: ${await response.text()}`);
    await telegramSendMessage(chatId, '🔮 Перемешиваю карты...');
    return null;
  }

  const data = await response.json();
  return data?.result?.message_id || null;
}

// Sends the three drawn cards as local photo files (never external URLs —
// that previously caused WEBPAGE_CURL_FAILED). If a local image is missing
// for any of the three cards, falls back to a plain text summary of the
// same three cards so the reading can still proceed.
async function telegramSendCardsLocal(chatId, cards) {
  try {
    const attachments = await Promise.all(
      cards.map(async (card, i) => {
        const code = tarotImageCode(card.name);
        if (!code) throw new Error(`No image code for card: ${card.name}`);
        const filePath = path.join(CARDS_DIR, `${code}.jpg`);
        const buffer = await readFile(filePath);
        const orientation = card.orientation === 'reversed' ? 'перевёрнутая' : 'прямая';
        return {
          fieldName: `card${i}`,
          buffer,
          caption: `${i + 1}. ${card.name}\n${orientation}\n${card.position}`
        };
      })
    );

    const media = attachments.map((a) => ({
      type: 'photo',
      media: `attach://${a.fieldName}`,
      caption: a.caption
    }));

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('media', JSON.stringify(media));
    for (const a of attachments) {
      form.append(a.fieldName, new Blob([a.buffer], { type: 'image/jpeg' }), `${a.fieldName}.jpg`);
    }

    const response = await fetch(`${TELEGRAM_API}/sendMediaGroup`, { method: 'POST', body: form });
    if (!response.ok) {
      throw new Error(`Telegram sendMediaGroup failed: ${await response.text()}`);
    }
  } catch (err) {
    console.warn('[tarot-omen] Falling back to text cards (no local images found):', err?.message || err);
    const summary = cards
      .map((c, i) => {
        const orientation = c.orientation === 'reversed' ? 'перевёрнутая' : 'прямая';
        return `${i + 1}. ${c.name} (${orientation}) — ${c.position}`;
      })
      .join('\n');
    await telegramSendMessage(chatId, `🃏 Выпавшие карты:\n\n${summary}`);
  }
}

async function handleTelegramUpdate(update) {
  const message = update?.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = String(message.text || '').trim();

  if (text === '/start') {
    await telegramSendMessage(chatId, 'Привет! Напиши свой вопрос для расклада.');
    return;
  }

  if (rateLimited(`tg:${chatId}`)) {
    await telegramSendMessage(chatId, 'Слишком много запросов подряд. Попробуй через пару минут.');
    return;
  }

  try {
    // Cards are drawn exactly once here — this same array is what gets shown
    // to the user AND what gets sent to Gemini, so they can never diverge.
    const cards = drawThreeCards();

    // 1) Shuffle GIF first, immediately — before the (slow) Gemini call.
    const shuffleMessageId = await telegramSendShuffleGif(chatId);

    // 2) Generate the interpretation while the shuffle animation is visible.
    const answer = await generateInterpretation(text, cards);

    // 3) Reveal the cards first, with the requested intro text.
    await telegramSendMessage(chatId, 'Вот что рассказали мне карты');
    await telegramSendCardsLocal(chatId, cards);

    // 4) Remove the shuffle GIF after the cards have appeared.
    if (shuffleMessageId) {
      try {
        const deleteResponse = await fetch(`${TELEGRAM_API}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: shuffleMessageId })
        });
        if (!deleteResponse.ok) {
          console.warn(`[tarot-omen] deleteMessage failed: ${await deleteResponse.text()}`);
        }
      } catch (deleteErr) {
        console.warn('[tarot-omen] Failed to remove shuffle GIF:', deleteErr);
      }
    }

    // 5) Keep the cards visible for two seconds before sending the interpretation.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await telegramSendMessage(chatId, `🔮 Интерпретация\n\n${answer}`);
  } catch (err) {
    console.error('Telegram interpretation error:', err);
    try {
      await telegramSendMessage(chatId, 'Не удалось получить интерпретацию. Попробуй ещё раз.');
    } catch (sendErr) {
      console.error('Telegram: failed to even send the error message:', sendErr);
    }
  }
}

app.post('/telegram-webhook', (req, res) => {
  // Acknowledge immediately so Telegram doesn't time out and retry the same
  // update while we're still waiting on Gemini.
  res.sendStatus(200);
  handleTelegramUpdate(req.body).catch((err) => {
    console.error('Telegram webhook handler error:', err);
  });
});

async function setupTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const response = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: TELEGRAM_WEBHOOK_URL, drop_pending_updates: true })
    });
    const data = await response.json();
    if (!data.ok) {
      console.error('[tarot-omen] setWebhook failed:', data);
    } else {
      console.log('[tarot-omen] Telegram webhook set to', TELEGRAM_WEBHOOK_URL);
    }
  } catch (err) {
    console.error('[tarot-omen] setWebhook error:', err);
  }
}

app.listen(PORT, () => {
  console.log(`[tarot-omen] backend listening on port ${PORT}`);
  setupTelegramWebhook();
});
