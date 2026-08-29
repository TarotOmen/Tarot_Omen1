import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OMEN_VOICE_ID = process.env.OMEN_VOICE_ID;
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
if (!ELEVENLABS_API_KEY) {
  console.warn('[tarot-omen] WARNING: ELEVENLABS_API_KEY is not set. Voice messages will be skipped.');
}
if (!OMEN_VOICE_ID) {
  console.warn('[tarot-omen] WARNING: OMEN_VOICE_ID is not set. Voice messages will be skipped.');
}

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(cors({ origin: ALLOWED_ORIGIN }));

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

const MAX_INTERPRETATION_CHARS = 3000;

function capText(text, maxLen) {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
  const cut = lastBreak > maxLen * 0.6 ? lastBreak + 1 : maxLen;
  return text.slice(0, cut).trim() + '…';
}

// ===== OMEN DIALOGUE STATE =====
// The current MVP keeps the active conversation in memory. A persistent store can be
// added later when payments/accounts are connected.
const OMEN_FREE_DIALOGUE_MESSAGES = 3;
const omenSessions = new Map();

function createOmenSession() {
  return {
    hasFreeReading: false,
    initialQuestion: '',
    initialCards: null,
    initialInterpretation: '',
    dialogueMessagesUsed: 0,
    conversation: [],
    pendingPaidReading: false
  };
}

function getOmenSession(chatId) {
  if (!omenSessions.has(chatId)) {
    omenSessions.set(chatId, createOmenSession());
  }
  return omenSessions.get(chatId);
}

const SYSTEM_PROMPT = `You are the reading voice of Tarot Omen, a Tarot mini app.

You receive: a user's question, and three already-drawn Tarot cards (each with its
position, name, and orientation — upright or reversed). The cards were chosen by a
random generator before you were called. You never choose or invent cards.

Produce TWO versions of the SAME interpretation:

1) "interpretation": the full text reading.
- Write one unified, personal interpretation of the spread AS IT RELATES TO THE
  QUESTION — not a generic listing of card meanings.
- Read each card in light of its position (The Situation / What Influences It /
  Where It May Lead) and its orientation.
- Weave the three cards into one coherent narrative, noting how they interact.
- Be specific to the question's actual topic and phrasing.
- Keep language reflective and open. Never claim certainty about the future.
- If the question concerns health: never diagnose. Offer only reflective
  interpretation and gently recommend a qualified professional when appropriate.
- If the question concerns money or finance: never promise a financial outcome.
- Reply in the same language the user's question is written in.
- Length: about 4 short paragraphs. No headers, no bullet lists, no card-by-card
  labels — a flowing reading.

2) "voice_interpretation": a SHORT spoken version of the same reading for Omen's
  voice message.
- It must communicate the most important insight from the full interpretation,
  not introduce a different meaning.
- 2 to 4 natural spoken sentences, roughly 180-450 characters when possible.
- Sound like Omen is personally speaking to one person, not reading an article.
- Calm, intimate, confident and slightly mysterious, but natural.
- Use natural pauses and conversational phrasing.
- Do not say "I will explain", "in the full interpretation", "the cards below",
  or anything that refers to the text itself.
- Do not list all three cards mechanically. Choose the most important thread
  or insight from their interaction.
- Do not give direct instructions or tell the user what they must do.
- Reply in the same language as the user's question.

Return ONLY valid JSON with exactly these two string fields:
{"interpretation":"...","voice_interpretation":"..."}`;

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: {
      maxOutputTokens: 3000,
      responseMimeType: 'application/json'
    }
  };

  let response;
  let raw;

  try {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );

      raw = await response.text();

      if (
        response.ok ||
        ![429, 500, 502, 503, 504].includes(response.status) ||
        attempt === MAX_ATTEMPTS
      ) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
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

  const generatedText = responseData?.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();

  if (!generatedText) {
    const reason = responseData?.candidates?.[0]?.finishReason;
    throw new Error(
      reason
        ? `Gemini returned no text (finishReason: ${reason}).`
        : 'Gemini returned an empty interpretation.'
    );
  }

  let result;
  try {
    result = JSON.parse(generatedText);
  } catch {
    console.error('[tarot-omen] Gemini returned non-JSON interpretation:', generatedText);
    throw new Error('Gemini returned an invalid interpretation format.');
  }

  const interpretation = capText(
    typeof result?.interpretation === 'string' ? result.interpretation.trim() : '',
    MAX_INTERPRETATION_CHARS
  );
  const voiceInterpretation =
    typeof result?.voice_interpretation === 'string'
      ? result.voice_interpretation.trim()
      : '';

  if (!interpretation) {
    throw new Error('Gemini returned an empty interpretation.');
  }

  if (!voiceInterpretation) {
    throw new Error('Gemini returned an empty voice interpretation.');
  }

  return { interpretation, voiceInterpretation };
}

const CONVERSATION_SYSTEM_PROMPT = `You are Omen, a Tarot reader and thoughtful conversational guide.

The user has already received a free three-card Tarot reading. Your task now is to continue a natural conversation about THAT reading and the user's situation.

Rules:
- Use the original question, the drawn cards, the original interpretation, and the conversation history.
- Do not draw cards, invent cards, or pretend a new reading has happened.
- Do not repeat the full original reading. Refer to it naturally when useful.
- Be attentive to what the user actually says. The goal is to understand the real issue behind the original question.
- Ask a useful, natural follow-up question when it helps uncover a meaningful new layer.
- Do not force a sale and do not mention credits, prices, payment, subscriptions, limits, monetization, or being an AI.
- A new Tarot reading should be suggested ONLY when the conversation has uncovered a genuinely new question or layer that would benefit from looking at the cards.
- If the user's message is simply a closing/thank-you, respond naturally and do not suggest another reading.
- If the user is discussing health, never diagnose; keep the Tarot interpretation reflective and recommend a qualified professional when appropriate.
- If the user is discussing money or finance, never promise a financial outcome.
- Reply in the same language as the user.
- Keep the response concise: normally 2-4 short paragraphs.

Return ONLY valid JSON with exactly these two fields:
{"reply":"...","offer_new_reading":false}

Set offer_new_reading=true only when there is a specific new question worth exploring with a fresh Tarot spread. Otherwise set it to false.`;

async function generateConversationReply(session, userMessage) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const history = session.conversation
    .slice(-8)
    .map((item) => `${item.role === 'user' ? 'User' : 'Omen'}: ${item.text}`)
    .join('\n');

  const cardsText = Array.isArray(session.initialCards)
    ? session.initialCards
        .map(
          (c, i) =>
            `Card ${i + 1} — ${c.position}; ${c.name}; ${c.orientation}; Keywords: ${c.keywords}`
        )
        .join('\n')
    : 'No cards available.';

  const userMessageForGemini = `Original user question:
${session.initialQuestion}

Original three-card spread:
${cardsText}

Original interpretation:
${session.initialInterpretation}

Conversation so far:
${history || '(none)'}

New user message:
${userMessage}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const payload = {
    systemInstruction: { parts: [{ text: CONVERSATION_SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userMessageForGemini }] }],
    generationConfig: {
      maxOutputTokens: 1200,
      responseMimeType: 'application/json'
    }
  };

  let response;
  let raw;

  try {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );

      raw = await response.text();

      if (
        response.ok ||
        ![429, 500, 502, 503, 504].includes(response.status) ||
        attempt === MAX_ATTEMPTS
      ) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Gemini conversation request timed out after 60 seconds.');
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
    console.error('[tarot-omen] Gemini conversation API error:', responseData);
    throw new Error(responseData?.error?.message || `Gemini API HTTP ${response.status}`);
  }

  const generatedText = responseData?.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();

  if (!generatedText) {
    throw new Error('Gemini returned an empty conversation response.');
  }

  let result;
  try {
    result = JSON.parse(generatedText);
  } catch {
    console.error('[tarot-omen] Gemini returned non-JSON conversation:', generatedText);
    throw new Error('Gemini returned an invalid conversation format.');
  }

  const reply =
    typeof result?.reply === 'string' ? capText(result.reply.trim(), 1800) : '';

  if (!reply) {
    throw new Error('Gemini returned an empty conversation reply.');
  }

  return {
    reply,
    offerNewReading: result?.offer_new_reading === true
  };
}

app.post('/api/interpret', async (req, res) => {
  try {
    const clientKey = req.ip || 'unknown';

    if (rateLimited(clientKey)) {
      return res.status(429).json({
        error: 'Too many readings requested. Please wait a few minutes.'
      });
    }

    const body = req.body || {};
    const question =
      typeof body.question === 'string'
        ? body.question.trim()
        : String(body.question || '').trim();

    const result = await generateInterpretation(question, body.cards);
    res.json(result);
  } catch (err) {
    console.error('[tarot-omen] /api/interpret failed:', err);

    const status = /invalid|required|malformed/i.test(err?.message || '')
      ? 400
      : 502;

    res.status(status).json({
      error: err?.message || 'Something went wrong generating the reading.'
    });
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
  const positions = [
    "Ситуация",
    "Что влияет на ситуацию",
    "К чему это может привести"
  ];

  return shuffled.slice(0, 3).map((card, index) => ({
    position: positions[index],
    name: card.name,
    orientation: Math.random() < 0.5 ? "upright" : "reversed",
    keywords: card.keywords
  }));
}

// ===== LOCAL VISUAL ASSETS =====

const ASSETS_DIR = path.join(__dirname, 'assets');
const CARDS_DIR = path.join(__dirname, 'cards');
const SHUFFLE_GIF_PATH = path.join(ASSETS_DIR, 'shuffle.gif');
const TABLE_PATH = path.join(ASSETS_DIR, 'table.png');
const ORACLE_IMAGE_PATH = path.join(ASSETS_DIR, 'omen.png');

function cardSlug(name) {
  const major = {
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

  if (major[name]) return major[name];

  const parts = name.split(' ');
  const suit = parts.pop();
  const rank = parts.join(' ');

  const suitMap = {
    "Жезлов": "wands",
    "Кубков": "cups",
    "Мечей": "swords",
    "Пентаклей": "pentacles"
  };

  const rankMap = {
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

  return `${rankMap[rank]}_of_${suitMap[suit]}`;
}

async function cardPathFor(card) {
  const slug = cardSlug(card.name);
  const candidates = [
    path.join(CARDS_DIR, `${slug}.png`),
    path.join(CARDS_DIR, `${slug}.jpg`),
    path.join(CARDS_DIR, `${slug}.jpeg`)
  ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {}
  }

  throw new Error(`Card image not found for "${card.name}" (${slug}).`);
}

// Approved layout: left card leans left, center stays straight, right card leans right.
const CARD_LAYOUT = [
  { centerX: 275, centerY: 510, angle: -7 },
  { centerX: 768, centerY: 500, angle: 0 },
  { centerX: 1260, centerY: 510, angle: 7 }
];

async function makeCardLayer(card, layout) {
  const input = await readFile(await cardPathFor(card));
  const totalRotation =
    layout.angle + (card.orientation === 'reversed' ? 180 : 0);

  const cardRotated = await sharp(input)
    .resize({ height: 760, fit: 'contain' })
    .rotate(totalRotation, {
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  const cardMeta = await sharp(cardRotated).metadata();

  const shadowSvg = Buffer.from(`
    <svg width="${cardMeta.width}" height="${cardMeta.height}">
      <rect
        x="8"
        y="8"
        width="${Math.max(1, cardMeta.width - 16)}"
        height="${Math.max(1, cardMeta.height - 16)}"
        rx="10"
        fill="black"
        fill-opacity="0.32"
      />
    </svg>
  `);

  const shadow = await sharp({
    create: {
      width: cardMeta.width,
      height: cardMeta.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: shadowSvg, blend: 'over' }])
    .blur(12)
    .png()
    .toBuffer();

  return { cardRotated, shadow };
}

async function buildReadingImage(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('Exactly three cards are required to build the spread image.');
  }

  await readFile(TABLE_PATH);

  const layers = await Promise.all(
    cards.map((card, index) => makeCardLayer(card, CARD_LAYOUT[index]))
  );

  const composites = [];

  // Back cards first, center card last so the overlap matches the approved image.
  const order = [0, 2, 1];

  for (const index of order) {
    const layout = CARD_LAYOUT[index];
    const { cardRotated, shadow } = layers[index];

    const cardMeta = await sharp(cardRotated).metadata();
    const shadowMeta = await sharp(shadow).metadata();

    composites.push({
      input: shadow,
      left: Math.round(layout.centerX - shadowMeta.width / 2 + 10),
      top: Math.round(layout.centerY - shadowMeta.height / 2 + 10)
    });

    composites.push({
      input: cardRotated,
      left: Math.round(layout.centerX - cardMeta.width / 2),
      top: Math.round(layout.centerY - cardMeta.height / 2)
    });
  }

  return sharp(TABLE_PATH)
    .ensureAlpha()
    .composite(composites)
    .png()
    .toBuffer();
}

// ===== TELEGRAM =====

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_CHUNK_SIZE = 3500;
const CARDS_CAPTION = 'Вот какие карты выпали и вот что я по ним вижу';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitForTelegram(text, maxLen = TELEGRAM_CHUNK_SIZE) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);

    if (end < text.length) {
      const window = text.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf(' ')
      );

      if (breakAt > maxLen * 0.5) {
        end = start + breakAt;
      }
    }

    const chunk = text.slice(start, end).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    start = end;
  }

  return chunks;
}

async function telegramSendMessage(chatId, text, returnMessageIds = false) {
  const messageIds = [];

  for (const part of splitForTelegram(text)) {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: part
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${await response.text()}`);
    }

    if (returnMessageIds) {
      const data = await response.json();
      if (data.ok && data.result?.message_id) {
        messageIds.push(data.result.message_id);
      }
    }
  }

  return returnMessageIds ? messageIds : undefined;
}

async function telegramSendOracle(chatId) {
  const imageBuffer = await readFile(ORACLE_IMAGE_PATH);

  const form = new FormData();
  form.append(
    'chat_id',
    String(chatId)
  );
  form.append(
    'photo',
    new Blob([imageBuffer], { type: 'image/png' }),
    'omen.png'
  );

  const response = await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    throw new Error(`Telegram sendPhoto (oracle) failed: ${await response.text()}`);
  }
}

async function telegramSendShuffleGif(chatId) {
  const gifBuffer = await readFile(SHUFFLE_GIF_PATH);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(
    'animation',
    new Blob([gifBuffer], { type: 'image/gif' }),
    'shuffle.gif'
  );

  const response = await fetch(`${TELEGRAM_API}/sendAnimation`, {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    throw new Error(`Telegram sendAnimation failed: ${await response.text()}`);
  }

  const data = await response.json();

  if (!data.ok || !data.result?.message_id) {
    throw new Error('Telegram sendAnimation returned no message_id.');
  }

  return data.result.message_id;
}

async function telegramDeleteMessage(chatId, messageId) {
  if (!messageId) return;

  const response = await fetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId
    })
  });

  if (!response.ok) {
    console.warn(
      `[tarot-omen] deleteMessage failed: ${await response.text()}`
    );
  }
}

async function telegramSendSpreadImage(chatId, imageBuffer) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(
    'photo',
    new Blob([imageBuffer], { type: 'image/png' }),
    'tarot-spread.png'
  );

  const response = await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    throw new Error(`Telegram sendPhoto (spread) failed: ${await response.text()}`);
  }
}

async function elevenLabsTextToSpeech(text) {
  if (!ELEVENLABS_API_KEY || !OMEN_VOICE_ID) {
    return null;
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(OMEN_VOICE_ID)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_v3'
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs TTS failed: ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function telegramSendVoice(chatId, audioBuffer) {
  if (!audioBuffer) return;

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(
    'voice',
    new Blob([audioBuffer], { type: 'audio/mpeg' }),
    'omen.mp3'
  );

  const response = await fetch(`${TELEGRAM_API}/sendVoice`, {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    throw new Error(`Telegram sendVoice failed: ${await response.text()}`);
  }
}

async function handleTelegramUpdate(update) {
  const message = update?.message;

  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = String(message.text || '').trim();
  const session = getOmenSession(chatId);

  if (text === '/start') {
    omenSessions.set(chatId, createOmenSession());

    await telegramSendMessage(chatId, 'Задавай свой вопрос');
    return;
  }

  if (rateLimited(`tg:${chatId}`)) {
    await telegramSendMessage(
      chatId,
      'Слишком много запросов подряд. Попробуй через пару минут.'
    );
    return;
  }

  try {
    // ===== FIRST FREE READING =====
    if (!session.hasFreeReading) {
      // Cards are chosen once. The exact same cards are sent to Gemini and shown to the user.
      const cards = drawThreeCards();

      const mixingMessageIds = await telegramSendMessage(
        chatId,
        'Мешаю карты...',
        true
      );

      const shuffleMessageId = await telegramSendShuffleGif(chatId);

      const interpretationPromise = generateInterpretation(text, cards);
      const spreadImagePromise = buildReadingImage(cards);

      const spreadImage = await spreadImagePromise;

      await telegramSendSpreadImage(chatId, spreadImage);

      for (const messageId of mixingMessageIds || []) {
        await telegramDeleteMessage(chatId, messageId);
      }
      await telegramDeleteMessage(chatId, shuffleMessageId);

      await telegramSendMessage(chatId, CARDS_CAPTION);
      await sleep(2000);

      const result = await interpretationPromise;

      // The first free reading includes one voice message.
      try {
        const voiceBuffer = await elevenLabsTextToSpeech(result.voiceInterpretation);
        if (voiceBuffer) {
          await telegramSendVoice(chatId, voiceBuffer);
        }
      } catch (voiceErr) {
        console.error('[tarot-omen] Voice generation failed; continuing with text:', voiceErr);
      }

      await telegramSendMessage(chatId, result.interpretation);

      session.hasFreeReading = true;
      session.initialQuestion = text;
      session.initialCards = cards;
      session.initialInterpretation = result.interpretation;
      session.dialogueMessagesUsed = 0;
      session.conversation = [];
      session.pendingPaidReading = false;

      return;
    }

    // ===== FREE CONVERSATION AFTER THE FIRST READING =====
    // Free dialogue is text-only. Voice is intentionally not generated here.
    if (session.pendingPaidReading) {
      await telegramSendMessage(
        chatId,
        'Если хочешь продолжить, следующий расклад будет доступен в платном продолжении. Сейчас мы ещё не подключили оплату.'
      );
      return;
    }

    if (session.dialogueMessagesUsed >= OMEN_FREE_DIALOGUE_MESSAGES) {
      session.pendingPaidReading = true;
      await telegramSendMessage(
        chatId,
        'Я уже хорошо понимаю твою ситуацию. Если хочешь пойти дальше, можем посмотреть новый вопрос отдельным раскладом. Это будет платное продолжение.'
      );
      return;
    }

    session.dialogueMessagesUsed += 1;

    const conversationResult = await generateConversationReply(session, text);

    session.conversation.push({ role: 'user', text });
    session.conversation.push({ role: 'omen', text: conversationResult.reply });

    await telegramSendMessage(chatId, conversationResult.reply);

    if (conversationResult.offerNewReading) {
      session.pendingPaidReading = true;
      await telegramSendMessage(
        chatId,
        '🔮 Хочешь посмотреть это отдельным раскладом? Это будет платное продолжение.'
      );
    } else if (session.dialogueMessagesUsed >= OMEN_FREE_DIALOGUE_MESSAGES) {
      session.pendingPaidReading = true;
      await telegramSendMessage(
        chatId,
        'Если хочешь продолжить разбирать ситуацию, следующий шаг — отдельный расклад. Это будет платное продолжение.'
      );
    }
  } catch (err) {
    console.error('[tarot-omen] Telegram reading/conversation error:', err);

    try {
      await telegramSendMessage(
        chatId,
        'Не удалось получить ответ. Попробуй ещё раз.'
      );
    } catch (sendErr) {
      console.error(
        '[tarot-omen] Telegram: failed to send error message:',
        sendErr
      );
    }
  }
}

app.post('/telegram-webhook', (req, res) => {
  res.sendStatus(200);

  handleTelegramUpdate(req.body).catch((err) => {
    console.error('[tarot-omen] Telegram webhook handler error:', err);
  });
});

async function setupTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;

  try {
    const response = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: TELEGRAM_WEBHOOK_URL,
        drop_pending_updates: true
      })
    });

    const data = await response.json();

    if (!data.ok) {
      console.error('[tarot-omen] setWebhook failed:', data);
    } else {
      console.log(
        '[tarot-omen] Telegram webhook set to',
        TELEGRAM_WEBHOOK_URL
      );
    }
  } catch (err) {
    console.error('[tarot-omen] setWebhook error:', err);
  }
}

app.listen(PORT, () => {
  console.log(`[tarot-omen] backend listening on port ${PORT}`);
  setupTelegramWebhook();
});
