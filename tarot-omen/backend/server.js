import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL =
  process.env.TELEGRAM_WEBHOOK_URL || 'https://tarot-omen1.onrender.com/telegram-webhook';

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


// ===== LOCAL VISUAL ASSETS =====

const ASSETS_DIR = path.join(process.cwd(), 'assets');
const CARDS_DIR = path.join(ASSETS_DIR, 'cards');
const TABLE_PATH = path.join(ASSETS_DIR, 'table', 'table.png');
const SHUFFLE_GIF_PATH = path.join(ASSETS_DIR, 'shuffle.gif');

const MAJOR_IMAGE_CODES = {
  "Шут": "the_fool",
  "Маг": "the_magician",
  "Верховная Жрица": "the_high_priestess",
  "Императрица": "the_empress",
  "Император": "the_emperor",
  "Иерофант": "the_hierophant",
  "Влюблённые": "the_lovers",
  "Колесница": "the_chariot",
  "Сила": "strength",
  "Отшельник": "the_hermit",
  "Колесо Фортуны": "wheel_of_fortune",
  "Справедливость": "justice",
  "Повешенный": "the_hanged_man",
  "Смерть": "death",
  "Умеренность": "temperance",
  "Дьявол": "the_devil",
  "Башня": "the_tower",
  "Звезда": "the_star",
  "Луна": "the_moon",
  "Солнце": "the_sun",
  "Суд": "judgement",
  "Мир": "the_world"
};

const RANK_IMAGE_CODES = {
  "Туз": "ace",
  "Двойка": "two",
  "Тройка": "three",
  "Четвёрка": "four",
  "Пятёрка": "five",
  "Шестёрка": "six",
  "Семёрка": "seven",
  "Восьмёрка": "eight",
  "Девятка": "nine",
  "Десятка": "ten",
  "Паж": "page",
  "Рыцарь": "knight",
  "Королева": "queen",
  "Король": "king"
};

const SUIT_IMAGE_CODES = {
  "Жезлов": "wands",
  "Кубков": "cups",
  "Мечей": "swords",
  "Пентаклей": "pentacles"
};

function cardImageSlug(name) {
  if (MAJOR_IMAGE_CODES[name]) return MAJOR_IMAGE_CODES[name];
  const parts = name.split(' ');
  const suit = parts.pop();
  const rank = parts.join(' ');
  const rankCode = RANK_IMAGE_CODES[rank];
  const suitCode = SUIT_IMAGE_CODES[suit];
  if (!rankCode || !suitCode) throw new Error(`Unknown card image mapping: ${name}`);
  return `${rankCode}_of_${suitCode}`;
}

async function resolveCardPath(name) {
  const slug = cardImageSlug(name);
  for (const ext of ['.png', '.jpg', '.jpeg']) {
    const candidate = path.join(CARDS_DIR, `${slug}${ext}`);
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error(`Card image not found: assets/cards/${slug}.png|jpg|jpeg`);
}

// Calibrated to the approved table composition (1536x1024).
const CARD_HEIGHT = 760;
const CARD_LAYOUT = [
  { centerX: 275, centerY: 510, angle: 7, z: 1 },
  { centerX: 768, centerY: 500, angle: 0, z: 3 },
  { centerX: 1260, centerY: 510, angle: -7, z: 2 }
];

async function makeCardComposite(card, layout) {
  const source = await fs.readFile(await resolveCardPath(card.name));
  const resized = await sharp(source)
    .resize({ height: CARD_HEIGHT, fit: 'contain' })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();

  // Soft shadow that follows the exact card rotation.
  const shadowSvg = Buffer.from(`
    <svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="10" y="10" width="${Math.max(1, meta.width - 20)}" height="${Math.max(1, meta.height - 20)}" rx="10" fill="#000" fill-opacity="0.38"/>
    </svg>
  `);

  const shadow = await sharp({
    create: { width: meta.width, height: meta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: shadowSvg }])
    .blur(14)
    .rotate(layout.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const rotatedCard = await sharp(resized)
    .rotate(layout.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const rotatedMeta = await sharp(rotatedCard).metadata();
  const shadowMeta = await sharp(shadow).metadata();

  return {
    card: rotatedCard,
    shadow,
    cardLeft: Math.round(layout.centerX - rotatedMeta.width / 2),
    cardTop: Math.round(layout.centerY - rotatedMeta.height / 2),
    shadowLeft: Math.round(layout.centerX - shadowMeta.width / 2 + 6),
    shadowTop: Math.round(layout.centerY - shadowMeta.height / 2 + 10),
  };
}

async function buildSpreadImage(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) throw new Error('Exactly three cards are required.');
  const layers = await Promise.all(cards.map((card, i) => makeCardComposite(card, CARD_LAYOUT[i])));
  const ordered = [0, 2, 1];
  const composites = [];

  for (const i of ordered) {
    const layer = layers[i];
    composites.push({ input: layer.shadow, left: layer.shadowLeft, top: layer.shadowTop });
    composites.push({ input: layer.card, left: layer.cardLeft, top: layer.cardTop });
  }

  return sharp(TABLE_PATH)
    .ensureAlpha()
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function telegramSendShuffleGif(chatId) {
  const gif = await fs.readFile(SHUFFLE_GIF_PATH);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('animation', new Blob([gif], { type: 'image/gif' }), 'shuffle.gif');

  const response = await fetch(`${TELEGRAM_API}/sendAnimation`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Telegram sendAnimation failed: ${await response.text()}`);
}

async function telegramSendSpreadImage(chatId, imageBuffer) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'tarot-spread.png');

  const response = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Telegram sendPhoto failed: ${await response.text()}`);
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
    const cards = drawThreeCards();

    await telegramSendShuffleGif(chatId);

    const interpretationPromise = generateInterpretation(text, cards);
    const spreadImagePromise = buildSpreadImage(cards);

    const [answer, spreadImage] = await Promise.all([interpretationPromise, spreadImagePromise]);

    await telegramSendSpreadImage(chatId, spreadImage);
    await telegramSendMessage(chatId, `Вот что рассказали мне карты\n\n${answer}`);
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
