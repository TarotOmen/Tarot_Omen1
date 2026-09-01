import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createHmac, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const TRIBUTE_API_KEY = process.env.TRIBUTE_API_KEY;
const TRIBUTE_API_URL = process.env.TRIBUTE_API_URL || 'https://tribute.tg/api/v1';
const TELEGRAM_WEBHOOK_URL =
  process.env.TELEGRAM_WEBHOOK_URL || 'https://tarot-omen1.onrender.com/telegram-webhook';

if (!GEMINI_API_KEY) {
  console.warn('[tarot-omen] WARNING: GEMINI_API_KEY is not set.');
}
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[tarot-omen] WARNING: TELEGRAM_BOT_TOKEN is not set. Telegram bot will not run.');
}
if (!TRIBUTE_API_KEY) {
  console.warn('[tarot-omen] WARNING: TRIBUTE_API_KEY is not set. Tribute payments will be unavailable.');
}

const app = express();
app.use(express.json({
  limit: '50kb',
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
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


const SYSTEM_PROMPT = `You are the reading voice of Tarot Omen, a Tarot mini app.

Speak naturally to one person. You may use the user's Telegram first name when it feels natural, but never infer or mention gender. Prefer gender-neutral wording.

You receive: a user's question and an already-drawn Tarot spread. The cards were chosen by a random generator before you were called. You never choose or invent cards.

For a three-card spread:
- Read the cards by the positions Situation / What Influences It / Where It May Lead.

For a Celtic Cross:
- Read all 10 cards by their exact positions: Situation / Challenge / Foundation / Recent Past / Conscious Aim / Near Future / Self / External Environment / Hopes and Fears / Outcome.

For every spread:
- Write one unified, personal interpretation AS IT RELATES TO THE QUESTION — not a generic listing of card meanings.
- Read each card in light of its position and orientation.
- Weave the cards into one coherent narrative, noting how they interact.
- Be specific to the question's actual topic and phrasing.
- Keep language reflective and open. Never claim certainty about the future.
- If the question concerns health: never diagnose. Offer only reflective interpretation and gently recommend a qualified professional when appropriate.
- If the question concerns money or finance: never promise a financial outcome.
- Reply in the same language the user's question is written in.
- Length: about 4 short paragraphs for three cards; about 7 short paragraphs for the Celtic Cross.
- For the Celtic Cross, explicitly connect the interpretation to the meaning of each position and name the position when it helps clarity. Do not treat the 10 cards as a generic list of meanings.
- Keep the interpretation flowing and personal rather than turning it into a dry catalogue.
- Whenever you mention a card by name, use its exact card name as provided in the spread data, without changing its wording or case.

Return ONLY valid JSON with exactly one string field:
{"interpretation":"..."}`;

async function generateInterpretation(question, cards, userName = '', spreadType = 'three', conversationContext = '') {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  if (typeof question !== 'string' || !question.trim() || question.trim().length > 400) {
    throw new Error('Invalid question.');
  }
  const requiredCards = spreadType === 'celtic' ? 10 : 3;
  if (!Array.isArray(cards) || cards.length !== requiredCards) {
    throw new Error(`${requiredCards} cards are required for this spread.`);
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

  const spreadLabel = spreadType === 'celtic' ? 'Celtic Cross (10 cards)' : 'Three-card reading (3 cards)';
  const contextBlock = spreadType === 'celtic' && conversationContext
    ? `\n\nPrevious conversation context from the same story:\n${conversationContext}`
    : '';
  const userMessage = `Telegram first name: ${userName || '(not available)'}\nNever infer gender. Use the name only if natural.\n\nSpread type: ${spreadLabel}\n\nUser's question:\n"${question.trim()}"${contextBlock}\n\nDrawn spread:\n\n${cardBlock}`;

  let response;
  let raw;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: {
              maxOutputTokens: spreadType === 'celtic' ? 4500 : 3000,
              responseMimeType: 'application/json'
            }
          }),
          signal: controller.signal
        }
      );
      raw = await response.text();
      if (
        response.ok ||
        ![429, 500, 502, 503, 504].includes(response.status) ||
        attempt === 3
      ) {
        break;
      }
      await sleep(attempt * 1500);
    } catch (err) {
      if (attempt === 3) {
        if (err?.name === 'AbortError') throw new Error('Gemini request timed out after 60 seconds.');
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  let responseData;
  try {
    responseData = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned invalid JSON (HTTP ${response?.status || 'unknown'}).`);
  }

  if (!response?.ok) {
    console.error('[tarot-omen] Gemini API error:', responseData);
    throw new Error(responseData?.error?.message || `Gemini API HTTP ${response?.status}`);
  }

  const generatedText = responseData?.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();

  if (!generatedText) {
    const reason = responseData?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Gemini returned no text (finishReason: ${reason}).` : 'Gemini returned an empty interpretation.');
  }

  let result;
  try {
    result = JSON.parse(generatedText);
  } catch {
    const cleaned = generatedText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      result = JSON.parse(cleaned);
    } catch {
      console.error('[tarot-omen] Gemini returned non-JSON interpretation:', generatedText);
      throw new Error('Gemini returned an invalid interpretation format.');
    }
  }

  const maxChars = spreadType === 'celtic' ? 7000 : MAX_INTERPRETATION_CHARS;
  const interpretation = capText(
    typeof result?.interpretation === 'string' ? result.interpretation.trim() : '',
    maxChars
  );

  if (!interpretation) throw new Error('Gemini returned an empty interpretation.');
  return { interpretation };
}

async function generateFollowupQuestion({ userName, originalQuestion, cards, interpretation }) {
  const cardBlock = cards.map((c, i) =>
    `Card ${i + 1} — ${c.position}: ${c.name} (${c.orientation})`
  ).join('\n');

  const prompt = `You are Omen, a thoughtful Tarot reader. The user has just received a Tarot reading.
Write ONE short, natural question in the same language as the user's original question.
The question must be specifically connected to the actual question, the cards and the interpretation.
Its purpose is to make the user want to continue the conversation and tell Omen something meaningful.
Do not mention payment, limits, credits or products.
Do not sound like a survey or a sales funnel.
Do not ask a generic question such as "Что ты чувствуешь?" unless it is clearly made specific by the context.
Return ONLY the question, with no quotation marks and no extra text.

Telegram first name: ${userName || '(not available)'}
Original question: ${originalQuestion}
Cards:\n${cardBlock}
Interpretation:\n${interpretation}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 180 }
        }),
        signal: controller.signal
      }
    );
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`Gemini follow-up returned invalid JSON (HTTP ${response.status}).`); }
    if (!response.ok) throw new Error(data?.error?.message || `Gemini API HTTP ${response.status}`);
    const question = data?.candidates?.[0]?.content?.parts
      ?.filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    if (!question) throw new Error('Gemini returned an empty follow-up question.');
    return question.replace(/^['"«]+|['"»]+$/g, '').trim();
  } finally {
    clearTimeout(timeout);
  }
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


const CELTIC_POSITIONS = [
  { name: 'Ситуация', meaning: 'что происходит с тобой сейчас и в каком состоянии находится вопрос' },
  { name: 'Что пересекает ситуацию', meaning: 'главный фактор, препятствие или влияние, которое вмешивается в ситуацию' },
  { name: 'Основание ситуации', meaning: 'глубинная причина, фундамент или то, на чём всё держится' },
  { name: 'Недавнее прошлое', meaning: 'события недавнего прошлого, которые привели к нынешней ситуации' },
  { name: 'Сознательная цель', meaning: 'чего ты сознательно хочешь, к чему стремишься или что держишь в фокусе' },
  { name: 'Ближайшее будущее', meaning: 'тенденция ближайшего развития ситуации' },
  { name: 'Сам человек', meaning: 'твоя внутренняя позиция, состояние и способ воспринимать происходящее' },
  { name: 'Внешнее окружение', meaning: 'люди, обстоятельства и внешние факторы, влияющие на ситуацию' },
  { name: 'Надежды и опасения', meaning: 'чего ты надеешься получить и чего одновременно опасаешься' },
  { name: 'Итог', meaning: 'к чему ведёт текущая совокупность факторов и какова вероятная тенденция' }
];

function drawCelticCrossCards() {
  const shuffled = [...TAROT_DECK].sort(() => Math.random() - 0.5);

  return shuffled.slice(0, 10).map((card, index) => ({
    position: CELTIC_POSITIONS[index].name,
    positionMeaning: CELTIC_POSITIONS[index].meaning,
    name: card.name,
    orientation: Math.random() < 0.5 ? 'upright' : 'reversed',
    keywords: card.keywords
  }));
}

function formatCelticCardMap(cards) {
  return [
    '🃏 Значение позиций Кельтского креста:',
    '',
    ...cards.map((card, index) => {
      const orientation = card.orientation === 'reversed' ? 'перевёрнутая' : 'прямая';
      const position = CELTIC_POSITIONS[index] || { name: card.position, meaning: card.positionMeaning || '' };
      return `${index + 1}. ${position.name} — ${card.name} (${orientation})\n${position.meaning}`;
    })
  ].join('\n');
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

// Three-card spread layout. Positions are calculated from the actual table
// dimensions in buildReadingImage() so rotated cards cannot be clipped at the
// left/right edges when the source card ratio or table size changes.
const CARD_ANGLES = [-7, 0, 7];
const CARD_HEIGHT_FRACTION = 0.64;

async function makeCardLayer(card, angle, targetHeight) {
  const input = await readFile(await cardPathFor(card));
  const totalRotation =
    angle + (card.orientation === 'reversed' ? 180 : 0);

  const cardRotated = await sharp(input)
    .resize({ height: targetHeight, fit: 'contain' })
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

  const tableMeta = await sharp(TABLE_PATH).metadata();
  const tableWidth = Number(tableMeta.width || 1536);
  const tableHeight = Number(tableMeta.height || 1024);
  const targetCardHeight = Math.round(tableHeight * CARD_HEIGHT_FRACTION);

  const layers = await Promise.all(
    cards.map((card, index) => makeCardLayer(card, CARD_ANGLES[index], targetCardHeight))
  );

  const composites = [];
  const centerXs = [0.20, 0.50, 0.80].map((fraction) => Math.round(tableWidth * fraction));
  const centerY = Math.round(tableHeight * 0.52);

  // Back cards first, center card last so the overlap is deterministic.
  const order = [0, 2, 1];

  for (const index of order) {
    const { cardRotated, shadow } = layers[index];
    const cardMeta = await sharp(cardRotated).metadata();
    const shadowMeta = await sharp(shadow).metadata();
    const centerX = centerXs[index];

    composites.push({
      input: shadow,
      left: Math.round(centerX - shadowMeta.width / 2 + 10),
      top: Math.round(centerY - shadowMeta.height / 2 + 10)
    });

    composites.push({
      input: cardRotated,
      left: Math.round(centerX - cardMeta.width / 2),
      top: Math.round(centerY - cardMeta.height / 2)
    });
  }

  return sharp(TABLE_PATH)
    .ensureAlpha()
    .modulate({ brightness: 1.35, saturation: 1.05 })
    .composite(composites)
    .png()
    .toBuffer();
}



const CELTIC_CARD_HEIGHT_FRACTION = 0.23;

async function buildCelticCrossImage(cards) {
  if (!Array.isArray(cards) || cards.length !== 10) {
    throw new Error('Exactly ten cards are required to build the Celtic Cross image.');
  }

  const tableMeta = await sharp(TABLE_PATH).metadata();
  const tableWidth = Number(tableMeta.width || 1536);
  const tableHeight = Number(tableMeta.height || 1024);
  const targetCardHeight = Math.round(tableHeight * CELTIC_CARD_HEIGHT_FRACTION);

  const layers = await Promise.all(
    cards.map((card, index) => makeCardLayer(card, index === 1 ? 0 : 0, targetCardHeight))
  );

  // Classic Celtic Cross: a six-card cross on the left and four-card staff on the right.
  const positions = [
    [0.32, 0.50, 0], // 1 Situation
    [0.32, 0.50, 90], // 2 Challenge / crossing card
    [0.32, 0.75, 0], // 3 Foundation
    [0.12, 0.50, 0], // 4 Recent past
    [0.32, 0.25, 0], // 5 Conscious aim
    [0.52, 0.50, 0], // 6 Near future
    [0.78, 0.80, 0], // 7 Self
    [0.78, 0.60, 0], // 8 Environment
    [0.78, 0.40, 0], // 9 Hopes / fears
    [0.78, 0.20, 0]  // 10 Outcome
  ];

  const composites = [];
  for (let index = 0; index < cards.length; index += 1) {
    const angle = positions[index][2];
    let cardBuffer = layers[index].cardRotated;
    let shadowBuffer = layers[index].shadow;

    // Card 2 crosses card 1 horizontally.
    if (index === 1) {
      const input = await readFile(await cardPathFor(cards[index]));
      cardBuffer = await sharp(input)
        .resize({ height: targetCardHeight, fit: 'contain' })
        .rotate(90 + (cards[index].orientation === 'reversed' ? 180 : 0), { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      const meta = await sharp(cardBuffer).metadata();
      const shadowSvg = Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><rect x="8" y="8" width="${Math.max(1, meta.width-16)}" height="${Math.max(1, meta.height-16)}" rx="10" fill="black" fill-opacity="0.32"/></svg>`);
      shadowBuffer = await sharp({ create: { width: meta.width, height: meta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: shadowSvg, blend: 'over' }])
        .blur(12)
        .png()
        .toBuffer();
    }

    const cardMeta = await sharp(cardBuffer).metadata();
    const shadowMeta = await sharp(shadowBuffer).metadata();
    const centerX = Math.round(tableWidth * positions[index][0]);
    const centerY = Math.round(tableHeight * positions[index][1]);

    composites.push({
      input: shadowBuffer,
      left: Math.round(centerX - shadowMeta.width / 2 + 8),
      top: Math.round(centerY - shadowMeta.height / 2 + 8)
    });
    composites.push({
      input: cardBuffer,
      left: Math.round(centerX - cardMeta.width / 2),
      top: Math.round(centerY - cardMeta.height / 2)
    });
  }

  return sharp(TABLE_PATH)
    .ensureAlpha()
    .modulate({ brightness: 1.35, saturation: 1.05 })
    .composite(composites)
    .png()
    .toBuffer();
}
// ===== CONVERSATION SESSIONS =====
// Persistent storage lives in Render PostgreSQL when DATABASE_URL is configured.
// The in-memory Map remains a fast runtime cache, while PostgreSQL is the source
// of truth so Render deploys/restarts do not erase user state.
const sessions = new Map();
const DATABASE_URL = process.env.DATABASE_URL || '';

let dbPool = null;
let dbReady = false;

async function initDatabase() {
  if (!DATABASE_URL) {
    console.warn('[tarot-omen] DATABASE_URL is not set. Sessions will remain in memory only.');
    return;
  }

  const { Pool } = pg;
  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS telegram_sessions (
      chat_id TEXT PRIMARY KEY,
      session JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS processed_payment_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await dbPool.query('SELECT chat_id, session FROM telegram_sessions');

  for (const row of result.rows) {
    try {
      const session = row.session && typeof row.session === 'object'
        ? row.session
        : JSON.parse(row.session);
      session.newTopicInfoPromise = null;
      sessions.set(Number(row.chat_id), session);
    } catch (err) {
      console.error('[tarot-omen] Failed to restore session:', row.chat_id, err);
    }
  }

  const events = await dbPool.query(
    'SELECT event_id, event_type FROM processed_payment_events'
  );

  for (const row of events.rows) {
    if (row.event_type === 'stars') processedPaymentCharges.add(row.event_id);
    if (row.event_type === 'tribute') processedTributePurchases.add(row.event_id);
  }

  dbReady = true;
  console.log(`[tarot-omen] PostgreSQL ready. Restored ${result.rowCount} sessions and ${events.rowCount} processed payment events.`);
}

function serializableSession(session) {
  if (!session) return null;
  const copy = { ...session };
  delete copy.newTopicInfoPromise;
  return copy;
}

async function saveSession(chatId, session = sessions.get(chatId)) {
  if (!dbReady || !dbPool || !chatId || !session) return;

  try {
    await dbPool.query(
      `INSERT INTO telegram_sessions (chat_id, session, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (chat_id)
       DO UPDATE SET session = EXCLUDED.session, updated_at = NOW()`,
      [String(chatId), JSON.stringify(serializableSession(session))]
    );
  } catch (err) {
    console.error('[tarot-omen] Failed to save session:', chatId, err);
  }
}

async function loadSession(chatId) {
  if (!chatId || !dbReady || !dbPool) return sessions.get(chatId) || null;
  if (sessions.has(chatId)) return sessions.get(chatId);

  try {
    const result = await dbPool.query(
      'SELECT session FROM telegram_sessions WHERE chat_id = $1',
      [String(chatId)]
    );

    if (!result.rowCount) return null;

    const session = result.rows[0].session;
    session.newTopicInfoPromise = null;
    sessions.set(chatId, session);
    return session;
  } catch (err) {
    console.error('[tarot-omen] Failed to load session:', chatId, err);
    return sessions.get(chatId) || null;
  }
}

async function savePaymentEvent(eventId, eventType) {
  if (!eventId || !dbReady || !dbPool) return;

  try {
    await dbPool.query(
      `INSERT INTO processed_payment_events (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [String(eventId), String(eventType)]
    );
  } catch (err) {
    console.error('[tarot-omen] Failed to save processed payment event:', eventId, err);
  }
}

// Current product prices. Paid reading packages never expire by time; only usage reduces
// their remaining entitlements.
const PAID_READING_STARS = 90;
const CELTIC_CROSS_STARS = 140;

const TRIBUTE_READING_RUB = 100;
const TRIBUTE_CELTIC_RUB = 150;

const FREE_CONVERSATION_LIMIT = 3;
const PAID_CONVERSATION_LIMIT = 3;
const ORDINARY_READINGS_PER_PACKAGE = 5; // 3 paid + 2 gifted, all are ordinary 3-card readings.
const CELTIC_CROSSES_PER_PACKAGE = 1;
const CELTIC_GIFT_ORDINARY_READINGS_PER_PACKAGE = 2;
const FREE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const PAID_CONTINUATION_DEFAULT = false;
const processedPaymentCharges = new Set();
const processedTributePurchases = new Set();

if (!Number.isInteger(PAID_READING_STARS) || PAID_READING_STARS < 1) {
  throw new Error('PAID_READING_STARS must be a positive integer.');
}
if (!Number.isInteger(CELTIC_CROSS_STARS) || CELTIC_CROSS_STARS < 1) {
  throw new Error('CELTIC_CROSS_STARS must be a positive integer.');
}

const CONVERSATION_SYSTEM_PROMPT = `You are Omen, the same Tarot reader who has just completed a Tarot reading.
You are now having a short, personal conversation about that reading.

Rules:
- Understand the original question, all cards in the completed spread, the original interpretation, the conversation history and the latest user message.
- Answer the latest message directly. Do not generate a new Tarot reading in this stage.
- Be natural, perceptive and warm, like a thoughtful human Tarot reader who is genuinely talking with one person. Do not rush to the conclusion. Usually write 3-5 substantive short paragraphs, with enough detail to explain the thought, connect it to the user's situation and make the conversation feel alive. The explanation should feel conversational rather than like a compact AI answer.
- Never invent facts about the user's life.
- Never claim certainty about the future.
- Never assume or mention gender. Use the Telegram first name only when it sounds natural.
- If the user reveals a genuinely new layer that would benefit from another spread, set reading_offer to true and formulate one specific reading_question for that new layer. This is only a signal for the server; NEVER sell, charge, or end the conversation yourself. Do not mention payment, credits, limits or sales inside reply or next_message.
- If there is no genuinely new layer, continue the conversation naturally around the EXISTING reading.
- A new user question does NOT automatically mean a new Tarot spread. Never generate or imply a new spread in this stage.
- During this conversation stage, answer the user's latest message directly using the existing reading and history.
- When the current free conversation window is ending, NEVER write a phrase like "На этом я бы остановился", "завершим", "на этом закончим" or any equivalent solely because the limit has been reached. The conversation should end naturally, or transition to a specific new reading only when the user's context genuinely creates one.
- If reading_offer=true, the reading_question must describe the new layer that emerged from the user's words, not simply repeat the original question.
- Return ONLY valid JSON with exactly these five fields:
{"reply":"...","next_message":"...","next_message_type":"question","reading_offer":false,"reading_question":""}

Rules for next_message:
- After EVERY reply, provide either ONE short context-specific question OR ONE short concluding thought. Never leave the reply hanging without one of these. The question/conclusion is separate from the main explanation and does not replace it.
- next_message_type must be exactly "question" or "conclusion".
- Use "question" when there is a natural, meaningful thing the user can answer that deepens the conversation.
- Use "conclusion" when the user's latest message closes the current thought, or when another question would feel forced. The conclusion should feel complete, not like a sales message.
- The next_message is sent as a SEPARATE Telegram message.
- Never mention payment, credits, limits or sales in next_message.
- Do not ask a generic question. Connect it to the actual conversation and the reading.
- Do not repeat the same question or simply rephrase the user's last message.
- Keep the conversation naturally focused on the current reading. Ask no more than one new question per reply.
- The user has up to three conversational turns after a completed reading. Use those turns to deepen the existing reading, clarify what matters, and respond to what the user actually says. If the user already understands the point or closes the thought, use a conclusion earlier instead of forcing another question.
- Do not compress a meaningful explanation just to be brief. Prefer a fuller, human-sounding explanation when the user's message gives you enough material for it.`;

async function generateConversationResponse({ userName, originalQuestion, cards, interpretation, history, latestMessage, conversationUsed = 0, conversationLimit = FREE_CONVERSATION_LIMIT, spreadType = 'three' }) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured on the server.');

  const cardBlock = cards.map((c, i) =>
    `Card ${i + 1} — ${c.position}\nName: ${c.name}\nOrientation: ${c.orientation}\nKeywords: ${c.keywords}`
  ).join('\n\n');
  const spreadLabel = spreadType === 'celtic' ? 'Celtic Cross (10 cards)' : 'three-card reading (3 cards)';

  const historyBlock = history.length
    ? history.map((item) => `${item.role === 'user' ? 'User' : 'Omen'}: ${item.text}`).join('\n')
    : '(no previous conversation messages)';

  const remainingMessages = Math.max(0, conversationLimit - conversationUsed);
  const userMessage = `Telegram first name: ${userName || '(not available)'}\n\nSpread type: ${spreadLabel}\n\nOriginal question:\n"${originalQuestion}"\n\nCards from the completed reading:\n${cardBlock}\n\nOriginal interpretation:\n${interpretation}\n\nConversation so far:\n${historyBlock}\n\nLatest user message:\n"${latestMessage}"\n\nConversation allowance: this reply is message ${conversationUsed + 1} of ${conversationLimit}; ${remainingMessages} message(s) remain before the current free conversation window ends. Do not mention this allowance to the user. If a genuinely new layer/question has emerged, prefer setting reading_offer=true so the next spread can become the natural continuation. If no new layer has emerged, do not invent one just to sell a spread.`;

  let lastError;
  let response = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: CONVERSATION_SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: { maxOutputTokens: 1700, responseMimeType: 'application/json' }
          }),
          signal: controller.signal
        }
      );
      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Gemini conversation returned invalid JSON (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        throw new Error(data?.error?.message || `Gemini API HTTP ${response.status}`);
      }
      const generated = data?.candidates?.[0]?.content?.parts
        ?.filter((part) => typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
        .trim();
      if (!generated) {
        throw new Error(`Gemini conversation returned no text (finishReason: ${data?.candidates?.[0]?.finishReason || 'unknown'}).`);
      }
      let result;
      try {
        result = JSON.parse(generated);
      } catch {
        const cleaned = generated.replace(/^```json\\s*/i, '').replace(/^```\\s*/i, '').replace(/\\s*```$/i, '').trim();
        result = JSON.parse(cleaned);
      }
      const reply = capText(typeof result?.reply === 'string' ? result.reply.trim() : '', 3000);
      const nextMessage = capText(
        typeof result?.next_message === 'string' ? result.next_message.trim() : '',
        500
      );
      const nextMessageType = result?.next_message_type === 'conclusion' ? 'conclusion' : 'question';
      const readingOffer = result?.reading_offer === true;
      const readingQuestion = capText(
        typeof result?.reading_question === 'string' ? result.reading_question.trim() : '',
        500
      );

      if (!reply) throw new Error('Gemini returned an empty conversation reply.');
      if (!nextMessage) throw new Error('Gemini returned no next conversation message.');
      if (readingOffer && !readingQuestion) {
        throw new Error('Gemini marked a reading offer without a reading question.');
      }

      return { reply, nextMessage, nextMessageType, readingOffer, readingQuestion };
    } catch (err) {
      lastError = err?.name === 'AbortError'
        ? new Error('Gemini conversation request timed out after 60 seconds.')
        : err;
      const transient = /high demand|429|503|502|500|temporar/i.test(lastError?.message || '');
      console.error(`[tarot-omen] Conversation attempt ${attempt} failed${transient ? ' (transient Gemini load)' : ''}:`, lastError);
      if (attempt < 3) {
        const retryAfter = Number(response?.headers?.get?.('retry-after') || 0);
        const delay = retryAfter > 0
          ? Math.min(retryAfter * 1000, 10000)
          : attempt * 1800;
        await sleep(delay);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Gemini conversation failed.');
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

function escapeTelegramHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildCardNamePatterns(name) {
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const majorVariants = {
    'Шут': ['Шут', 'Шута', 'Шуту', 'Шутом', 'Шуте'],
    'Маг': ['Маг', 'Мага', 'Магу', 'Магом', 'Маге'],
    'Верховная Жрица': ['Верховная Жрица', 'Верховной Жрицы', 'Верховную Жрицу', 'Верховной Жрицей', 'Верховной Жрице'],
    'Императрица': ['Императрица', 'Императрицы', 'Императрицу', 'Императрицей', 'Императрице'],
    'Император': ['Император', 'Императора', 'Императору', 'Императором', 'Императоре'],
    'Иерофант': ['Иерофант', 'Иерофанта', 'Иерофанту', 'Иерофантом', 'Иерофанте'],
    'Влюблённые': ['Влюблённые', 'Влюблённых', 'Влюблённым', 'Влюблёнными', 'Влюблённых'],
    'Колесница': ['Колесница', 'Колесницы', 'Колесницу', 'Колесницей', 'Колеснице'],
    'Сила': ['Сила', 'Силы', 'Силу', 'Силой', 'Силе'],
    'Отшельник': ['Отшельник', 'Отшельника', 'Отшельнику', 'Отшельником', 'Отшельнике'],
    'Колесо Фортуны': ['Колесо Фортуны', 'Колеса Фортуны', 'Колесу Фортуны', 'Колесом Фортуны', 'Колесе Фортуны'],
    'Справедливость': ['Справедливость', 'Справедливости', 'Справедливость', 'Справедливостью', 'Справедливости'],
    'Повешенный': ['Повешенный', 'Повешенного', 'Повешенному', 'Повешенным', 'Повешенном'],
    'Смерть': ['Смерть', 'Смерти', 'Смерть', 'Смертью', 'Смерти'],
    'Умеренность': ['Умеренность', 'Умеренности', 'Умеренность', 'Умеренностью', 'Умеренности'],
    'Дьявол': ['Дьявол', 'Дьявола', 'Дьяволу', 'Дьяволом', 'Дьяволе'],
    'Башня': ['Башня', 'Башни', 'Башню', 'Башней', 'Башне'],
    'Звезда': ['Звезда', 'Звезды', 'Звезду', 'Звездой', 'Звезде'],
    'Луна': ['Луна', 'Луны', 'Луну', 'Луной', 'Луне'],
    'Солнце': ['Солнце', 'Солнца', 'Солнцу', 'Солнцем', 'Солнце'],
    'Суд': ['Суд', 'Суда', 'Суду', 'Судом', 'Суде'],
    'Мир': ['Мир', 'Мира', 'Миру', 'Миром', 'Мире']
  };

  const rankVariants = {
    'Туз': ['Туз', 'Туза', 'Тузу', 'Тузом', 'Тузе'],
    'Двойка': ['Двойка', 'Двойки', 'Двойку', 'Двойкой', 'Двойке'],
    'Тройка': ['Тройка', 'Тройки', 'Тройку', 'Тройкой', 'Тройке'],
    'Четвёрка': ['Четвёрка', 'Четвёрки', 'Четвёрку', 'Четвёркой', 'Четвёрке', 'Четверка', 'Четверки', 'Четверку', 'Четверкой', 'Четверке'],
    'Пятёрка': ['Пятёрка', 'Пятёрки', 'Пятёрку', 'Пятёркой', 'Пятёрке', 'Пятерка', 'Пятерки', 'Пятерку', 'Пятеркой', 'Пятерке'],
    'Шестёрка': ['Шестёрка', 'Шестёрки', 'Шестёрку', 'Шестёркой', 'Шестёрке', 'Шестерка', 'Шестерки', 'Шестерку', 'Шестеркой', 'Шестерке'],
    'Семёрка': ['Семёрка', 'Семёрки', 'Семёрку', 'Семёркой', 'Семёрке', 'Семерка', 'Семерки', 'Семерку', 'Семеркой', 'Семерке'],
    'Восьмёрка': ['Восьмёрка', 'Восьмёрки', 'Восьмёрку', 'Восьмёркой', 'Восьмёрке', 'Восьмерка', 'Восьмерки', 'Восьмерку', 'Восьмеркой', 'Восьмерке'],
    'Девятка': ['Девятка', 'Девятки', 'Девятку', 'Девяткой', 'Девятке'],
    'Десятка': ['Десятка', 'Десятки', 'Десятку', 'Десяткой', 'Десятке'],
    'Паж': ['Паж', 'Пажа', 'Пажу', 'Пажом', 'Пажем', 'Паже'],
    'Рыцарь': ['Рыцарь', 'Рыцаря', 'Рыцарю', 'Рыцарем', 'Рыцаре'],
    'Королева': ['Королева', 'Королевы', 'Королеву', 'Королевой', 'Королеве'],
    'Король': ['Король', 'Короля', 'Королю', 'Королём', 'Королем', 'Короле']
  };

  const suitVariants = {
    'Жезлов': ['Жезлы', 'Жезлов', 'Жезлам', 'Жезлами', 'Жезлах'],
    'Кубков': ['Кубки', 'Кубков', 'Кубкам', 'Кубками', 'Кубках'],
    'Мечей': ['Мечи', 'Мечей', 'Мечам', 'Мечами', 'Мечах'],
    'Пентаклей': ['Пентакли', 'Пентаклей', 'Пентаклям', 'Пентаклями', 'Пентаклях']
  };

  if (majorVariants[name]) {
    return majorVariants[name].map(escapeRegex).sort((a, b) => b.length - a.length);
  }

  const parts = String(name).split(' ');
  if (parts.length === 2 && rankVariants[parts[0]] && suitVariants[parts[1]]) {
    const variants = [];
    for (const rank of rankVariants[parts[0]]) {
      for (const suit of suitVariants[parts[1]]) {
        variants.push(`${escapeRegex(rank)}\\s+${escapeRegex(suit)}`);
      }
    }
    return variants.sort((a, b) => b.length - a.length);
  }

  return [escapeRegex(name)];
}

function formatCardNamesHtml(text, cards = []) {
  let formatted = escapeTelegramHtml(text);
  const names = [...new Set((Array.isArray(cards) ? cards : [])
    .map((card) => String(card?.name || '').trim())
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length);

  for (const name of names) {
    const patterns = buildCardNamePatterns(name);
    if (!patterns.length) continue;
    const pattern = patterns.join('|');
    formatted = formatted.replace(
      new RegExp(`(?<![\\w>])(${pattern})(?![\\w<])`, 'giu'),
      '<b><i>$1</i></b>'
    );
  }

  return formatted;
}

async function telegramSendCardText(chatId, text, cards) {
  const formatted = formatCardNamesHtml(text, cards);
  const chunks = splitForTelegram(formatted);
  // Splitting formatted HTML can cut a tag in half, so send shorter raw chunks
  // with formatting applied independently whenever a split is required.
  if (chunks.length <= 1) {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatted,
        parse_mode: 'HTML'
      })
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage (card formatting) failed: ${await response.text()}`);
    }
    return;
  }

  // For long interpretations, split the original text first, then format each
  // chunk. This prevents malformed HTML when Telegram's message limit is hit.
  for (const part of splitForTelegram(String(text ?? ''))) {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatCardNamesHtml(part, cards),
        parse_mode: 'HTML'
      })
    });
    if (!response.ok) {
      throw new Error(`Telegram sendMessage (card formatting) failed: ${await response.text()}`);
    }
  }
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

async function telegramSendMessageWithRetry(chatId, text, attempts = 3, returnMessageIds = false) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await telegramSendMessage(chatId, text, returnMessageIds);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(attempt * 700);
    }
  }
  throw lastError || new Error('Telegram message delivery failed.');
}

async function telegramSendInlineKeyboard(chatId, text, buttons) {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: buttons }
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage with keyboard failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data?.result || null;
}

async function telegramSendInlineKeyboardWithRetry(chatId, text, buttons, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await telegramSendInlineKeyboard(chatId, text, buttons);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(attempt * 700);
    }
  }
  throw lastError || new Error('Telegram keyboard delivery failed.');
}

async function telegramEditInlineKeyboard(chatId, messageId, buttons) {
  const response = await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons }
    })
  });
  if (!response.ok) {
    throw new Error(`Telegram editMessageReplyMarkup failed: ${await response.text()}`);
  }
}

async function telegramEditInlineKeyboardWithRetry(chatId, messageId, buttons, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await telegramEditInlineKeyboard(chatId, messageId, buttons);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(attempt * 700);
    }
  }
  throw lastError || new Error('Telegram keyboard edit failed.');
}

async function telegramEditMessageText(chatId, messageId, text, buttons = []) {
  const response = await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: buttons }
    })
  });
  if (!response.ok) {
    throw new Error(`Telegram editMessageText failed: ${await response.text()}`);
  }
}

async function telegramEditMessageTextWithRetry(chatId, messageId, text, buttons = [], attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await telegramEditMessageText(chatId, messageId, text, buttons);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(attempt * 700);
    }
  }
  throw lastError || new Error('Telegram message edit failed.');
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

function normalizeProductName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

function isCelticProductName(name) {
  const n = normalizeProductName(name);
  return n.includes('кельтск') && n.includes('крест');
}

function isReadingProductName(name) {
  const n = normalizeProductName(name);
  return (
    (n.includes('три') && n.includes('карт')) ||
    n.includes('обычн') ||
    n.includes('расклад')
  ) && !isCelticProductName(n);
}

let resolvedTributeProducts = {
  reading: null,
  celtic: null,
  loadedAt: 0
};

async function tributeGetProducts() {
  if (!TRIBUTE_API_KEY) throw new Error('TRIBUTE_API_KEY is not configured.');

  const response = await fetch(
    `${TRIBUTE_API_URL}/products?page=1&size=100&type=digital&desc=true`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Api-Key': TRIBUTE_API_KEY
      }
    }
  );

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Tribute products lookup returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    console.error('[tarot-omen] Tribute products lookup failed:', { status: response.status, data });
    throw new Error(data?.message || data?.error?.message || `Tribute API HTTP ${response.status}`);
  }

  return Array.isArray(data?.rows) ? data.rows : [];
}

function chooseTributeProduct(products, kind) {
  const approved = products.filter((p) =>
    String(p?.type || '').toLowerCase() === 'digital' &&
    String(p?.status || '').toLowerCase() === 'approved' &&
    Number.isSafeInteger(Number(p?.id))
  );

  const matcher = kind === 'celtic' ? isCelticProductName : isReadingProductName;
  const matches = approved.filter((p) => matcher(p?.name));

  if (!matches.length) {
    throw new Error(
      kind === 'celtic'
        ? 'Tribute digital product for Celtic Cross was not found.'
        : 'Tribute digital product for Three-card reading was not found.'
    );
  }

  if (matches.length > 1) {
    console.warn('[tarot-omen] Multiple Tribute products matched; using the newest by ID.', {
      kind,
      matches: matches.map((p) => ({ id: p.id, name: p.name, amount: p.amount, currency: p.currency }))
    });
  }

  return [...matches].sort((a, b) => Number(b.id) - Number(a.id))[0];
}

async function tributeResolveProducts(force = false) {
  if (!TRIBUTE_API_KEY) throw new Error('TRIBUTE_API_KEY is not configured.');

  const cacheTtlMs = 5 * 60 * 1000;
  if (!force && resolvedTributeProducts.loadedAt && Date.now() - resolvedTributeProducts.loadedAt < cacheTtlMs) {
    return resolvedTributeProducts;
  }

  const products = await tributeGetProducts();
  const reading = chooseTributeProduct(products, 'reading');
  const celtic = chooseTributeProduct(products, 'celtic');

  resolvedTributeProducts = { reading, celtic, loadedAt: Date.now() };
  console.log('[tarot-omen] Tribute products resolved:', {
    reading: { id: reading.id, name: reading.name, amount: reading.amount, currency: reading.currency },
    celtic: { id: celtic.id, name: celtic.name, amount: celtic.amount, currency: celtic.currency }
  });
  return resolvedTributeProducts;
}

async function tributeGetProductForKind(kind) {
  const resolved = await tributeResolveProducts();
  return kind === 'celtic' ? resolved.celtic : resolved.reading;
}

async function tributeGetProductById(productId) {
  if (!TRIBUTE_API_KEY) throw new Error('TRIBUTE_API_KEY is not configured.');
  const safeId = String(productId ?? '').trim();
  if (!/^\d+$/.test(safeId)) throw new Error('Invalid Tribute product ID.');

  const response = await fetch(`${TRIBUTE_API_URL}/products/${safeId}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Api-Key': TRIBUTE_API_KEY
    }
  });

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Tribute product lookup returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.error?.message || `Tribute API HTTP ${response.status}`);
  }

  return data;
}

async function tributeCreatePaymentLink(kind) {
  const product = await tributeGetProductForKind(kind);
  const paymentUrl = String(product?.webLink || product?.link || '').trim();
  const expectedAmount = (kind === 'celtic' ? TRIBUTE_CELTIC_RUB : TRIBUTE_READING_RUB) * 100;
  const actualAmount = Number(product?.amount);
  const actualCurrency = String(product?.currency || '').toUpperCase();

  if (!paymentUrl) {
    throw new Error(`Tribute product ${product?.id || '?'} has no payment link.`);
  }

  if (actualCurrency !== 'RUB' || actualAmount !== expectedAmount) {
    throw new Error(
      `Tribute product ${product?.id || '?'} price mismatch: expected ${expectedAmount} RUB minor units, got ${actualAmount} ${actualCurrency}.`
    );
  }

  return {
    productId: String(product.id),
    paymentUrl,
    amount: Number(product.amount),
    currency: String(product.currency || '').toUpperCase(),
    name: String(product.name || '').trim()
  };
}

function tributeSignatureMatches(req) {
  const signature = String(req.get('trbt-signature') || '').trim();
  if (!signature || !TRIBUTE_API_KEY || !req.rawBody) return false;

  const expected = createHmac('sha256', TRIBUTE_API_KEY)
    .update(req.rawBody)
    .digest('hex');

  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

async function handleTributeWebhook(body) {
  const eventName = String(body?.name || '').trim();
  if (eventName !== 'new_digital_product') {
    console.log('[tarot-omen] Tribute webhook ignored:', eventName || '(no event name)');
    return;
  }

  const payload = body?.payload || {};
  const telegramUserId = Number(payload.telegram_user_id);
  const productId = String(payload.product_id ?? '').trim();
  const purchaseId = String(payload.purchase_id ?? '').trim();

  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || !productId) {
    console.warn('[tarot-omen] Tribute webhook has invalid user/product data:', payload);
    return;
  }

  if (purchaseId && processedTributePurchases.has(purchaseId)) return;
  if (purchaseId) {
    processedTributePurchases.add(purchaseId);
    await savePaymentEvent(purchaseId, 'tribute');
  }

  let resolved;
  try {
    resolved = await tributeResolveProducts();
  } catch (err) {
    console.error('[tarot-omen] Tribute product resolution failed in webhook:', err);
    return;
  }

  const readingProductId = String(resolved.reading.id);
  const celticProductId = String(resolved.celtic.id);
  let kind = null;
  if (productId === celticProductId) kind = 'celtic';
  else if (productId === readingProductId) kind = 'reading';

  if (!kind) {
    console.warn('[tarot-omen] Tribute purchase ignored: unknown product id', {
      productId,
      readingProductId,
      celticProductId,
      purchaseId
    });
    return;
  }

  const amount = Number(payload.amount);
  const currency = String(payload.currency || '').toUpperCase();
  const expectedAmount = (kind === 'celtic' ? TRIBUTE_CELTIC_RUB : TRIBUTE_READING_RUB) * 100;
  if (!Number.isFinite(amount) || amount !== expectedAmount || currency !== 'RUB') {
    console.warn('[tarot-omen] Tribute purchase amount/currency mismatch.', {
      kind,
      productId,
      expectedAmount,
      amount,
      currency,
      purchaseId
    });
    return;
  }

  let session = sessions.get(telegramUserId);
  if (!session) {
    session = {
      userName: String(payload.telegram_username || '').trim(),
      reading: null,
      history: [],
      freeConversationUsed: FREE_CONVERSATION_LIMIT,
      paidConversationUsed: 0,
      paidReadingsRemaining: 0,
      paidCelticRemaining: 0,
      paidReadingActive: false,
      paidPackageKind: 'reading',
      pendingGiftReading: false,
      pendingPaidReadingKind: '',
      pendingNewTopic: false,
      pendingNewTopicKind: '',
      newTopicInfoMessageId: 0,
      newTopicInfoPromise: null,
      paidContinuation: false,
      readingOfferShown: false,
      pendingReadingQuestion: '',
      pendingPayment: null,
      pendingTributePayment: null,
      freeReadingUsed: true,
      freeCooldownAvailableAt: Date.now()
    };
    sessions.set(telegramUserId, session);
  }

  const pending = session.pendingTributePayment;
  if (pending && pending.productId !== productId) {
    console.warn('[tarot-omen] Tribute product does not match the currently pending product. Ignoring webhook.', {
      pending: pending.productId,
      received: productId,
      purchaseId
    });
    return;
  }

  if (pending && pending.expiresAt && Date.now() > pending.expiresAt) {
    console.warn('[tarot-omen] Tribute payment arrived after pending payment expiration; accepting by product match.', {
      productId,
      purchaseId
    });
  }

  const question = session.pendingReadingQuestion || session.reading?.question ||
    'Посмотреть следующий слой этой истории';

  session.pendingTributePayment = null;
  session.pendingPayment = null;
  activatePaidPackage(session, kind);

  if (kind === 'celtic') {
    await telegramSendMessage(telegramUserId, 'Оплата прошла. У тебя 1 Кельтский крест и 2 обычных расклада в подарок. Запускаю Кельтский крест — 10 карт и подробный разбор.');
    await runPaidCelticReading(telegramUserId, session, question);
    return;
  }

  await telegramSendMessage(telegramUserId, 'Оплата прошла. У тебя 5 обычных раскладов: 3 входят в пакет и ещё 2 — в подарок. Начинаем первый.');
  await runPaidThreeCardReading(telegramUserId, session, question);
}

async function telegramSendPaymentUrl(chatId, text, url) {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Перейти к оплате', url }],
          [{ text: '⬅️ Назад к выбору оплаты', callback_data: 'payment:back' }]
        ]
      }
    })
  });

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram payment URL message returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram payment URL message failed (HTTP ${response.status}).`);
  }
  return data.result;
}

function buildPaidContinuationText() {
  return [
    'Если захочешь продолжить эту историю сейчас, можно приобрести новые расклады:',
    '',
    '⭐️Обычный «3 карты»: 3 расклада + 2 в подарок; всего 5 раскладов',
    '',
    '🔮Расклад «Кельтский крест» из 10 карт: более глубокое исследование твоего вопроса. 1 «Кельтский крест» и + 2 обычных расклада «3 карты» в подарок.',
    '',
    '*Неиспользованные расклады не сгорают и остаются доступными без срока действия.',
    '',
    'Если не спешишь, через 72 часа снова будет доступен бесплатный расклад с продолжением этой истории, или сможешь задать новый вопрос.'
  ].join('\n');
}

function buildPaidContinuationButtons() {
  return [
    [{ text: `⭐ Обычный — ${PAID_READING_STARS} Stars`, callback_data: 'pay:stars:reading' }],
    [{ text: `💳 Обычный — ${TRIBUTE_READING_RUB} ₽`, callback_data: 'pay:tribute:reading' }],
    [{ text: `🔮 Кельтский крест — 10 карт — ${TRIBUTE_CELTIC_RUB} ₽`, callback_data: 'choose:celtic:payment' }]
  ];
}

async function offerPaidContinuation(chatId, session, readingQuestion = '', messageId = null) {
  const question = (readingQuestion || '').trim() ||
    'Посмотреть следующий слой этой истории отдельным раскладом';

  session.pendingReadingQuestion = question;
  session.readingOfferShown = true;
  session.pendingGiftReading = false;

  const text = buildPaidContinuationText();
  const buttons = buildPaidContinuationButtons();

  if (messageId) {
    await telegramEditMessageTextWithRetry(chatId, messageId, text, [
      [{ text: '🆕 Начать новый расклад', callback_data: 'new:topic' }]
    ]);
  } else {
    await telegramSendInlineKeyboardWithRetry(
      chatId,
      text,
      [[{ text: '🆕 Начать новый расклад', callback_data: 'new:topic' }]]
    );
  }

  await telegramSendInlineKeyboardWithRetry(
    chatId,
    'Выбери расклад и способ оплаты:',
    buttons
  );
}

async function offerCelticPaymentMethods(chatId, messageId) {
  await telegramEditMessageTextWithRetry(
    chatId,
    messageId,
    'Кельтский крест — 10 карт. Выбери способ оплаты:',
    [
      [{ text: `⭐ Telegram Stars — ${CELTIC_CROSS_STARS}`, callback_data: 'pay:stars:celtic' }],
      [{ text: `💳 Карта / СБП — ${TRIBUTE_CELTIC_RUB} ₽`, callback_data: 'pay:tribute:celtic' }],
      [{ text: '⬅️ Вернуться к выбору расклада', callback_data: 'choose:celtic:back' }]
    ]
  );
}

async function offerPaymentMethods(chatId, messageId) {
  const buttons = buildPaidContinuationButtons();
  const text = 'Выбери расклад и способ оплаты:';
  if (messageId) {
    await telegramEditMessageTextWithRetry(chatId, messageId, text, buttons);
  } else {
    await telegramSendInlineKeyboardWithRetry(chatId, text, buttons);
  }
}

async function offerAvailablePaidReadings(chatId, session) {
  const buttons = [];

  if (Number(session.paidReadingsRemaining || 0) > 0) {
    buttons.push([{
      text: `🃏 Использовать обычный расклад — осталось ${session.paidReadingsRemaining}`,
      callback_data: 'use:paid:reading'
    }]);
  }

  if (Number(session.paidCelticRemaining || 0) > 0) {
    buttons.push([{
      text: `🔮 Использовать Кельтский крест — осталось ${session.paidCelticRemaining}`,
      callback_data: 'use:paid:celtic'
    }]);
  }

  if (buttons.length) {
    buttons.push([{
      text: '🆕 Расклад на новую тему',
      callback_data: 'new:topic'
    }]);
  }

  if (!buttons.length) {
    session.pendingGiftReading = false;
    session.pendingPaidReadingKind = '';
    return;
  }

  session.pendingGiftReading = true;
  session.readingOfferShown = false;

  const ordinaryText = Number(session.paidReadingsRemaining || 0) > 0
    ? `Обычных раскладов осталось: ${session.paidReadingsRemaining}.`
    : '';
  const celticText = Number(session.paidCelticRemaining || 0) > 0
    ? `Кельтских крестов осталось: ${session.paidCelticRemaining}.`
    : '';

  await telegramSendInlineKeyboard(
    chatId,
    `У тебя остались оплаченные расклады. Они не сгорают и будут доступны, пока ты их не используешь.\n${ordinaryText}\n${celticText}`.trim(),
    buttons
  );
}

async function deleteCallbackMessage(callback) {
  const chatId = callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  if (chatId && messageId) {
    await telegramDeleteMessage(chatId, messageId);
  }
}

function clearReadingStoryForNewTopic(session) {
  session.reading = null;
  session.history = [];
  session.pendingReadingQuestion = '';
  session.readingOfferShown = false;
  session.pendingGiftReading = false;
  session.pendingPaidReadingKind = '';
  session.paidConversationUsed = 0;
  session.newTopicInfoMessageId = 0;
  session.newTopicInfoText = '';
  session.newTopicInfoUnavailableShown = false;
}

async function showNewTopicInfo(chatId, session, text) {
  // Keep exactly one logical info message for this session. Repeated presses
  // must not create or re-show duplicate copies of the same message.
  if (session.newTopicInfoPromise) {
    return session.newTopicInfoPromise;
  }

  if (
    Number(session?.newTopicInfoMessageId || 0) &&
    session?.newTopicInfoText === text
  ) {
    return;
  }

  session.newTopicInfoPromise = (async () => {
    const existingMessageId = Number(session?.newTopicInfoMessageId || 0);

    if (existingMessageId) {
      try {
        await telegramEditMessageTextWithRetry(chatId, existingMessageId, text, []);
        session.newTopicInfoText = text;
        return;
      } catch (err) {
        session.newTopicInfoMessageId = 0;
        session.newTopicInfoText = '';
      }
    }

    const messageIds = await telegramSendMessageWithRetry(chatId, text, 3, true);
    session.newTopicInfoMessageId = Number(messageIds?.[0] || 0);
    session.newTopicInfoText = text;
  })();

  try {
    return await session.newTopicInfoPromise;
  } finally {
    session.newTopicInfoPromise = null;
  }
}

async function handleNewTopicRequest(chatId, session) {
  if (!session) return;

  const paidReadingAvailable = Number(session.paidReadingsRemaining || 0) > 0;
  const paidCelticAvailable = Number(session.paidCelticRemaining || 0) > 0;
  const freeAvailable = !!session.reading &&
    Date.now() >= Number(session.freeCooldownAvailableAt || 0);

  if (paidReadingAvailable || paidCelticAvailable) {
    const preferredKind = paidReadingAvailable ? 'reading' : 'celtic';
    session.pendingNewTopic = true;
    session.pendingNewTopicKind = preferredKind;
    session.readingOfferShown = false;
    session.pendingReadingQuestion = '';
    session.pendingGiftReading = false;

    await showNewTopicInfo(
      chatId,
      session,
      preferredKind === 'celtic'
        ? 'Хорошо. Напиши новый вопрос, и Кельтский крест будет сделан уже на эту тему, отдельно от предыдущей истории.'
        : 'Хорошо. Напиши новый вопрос, и следующий расклад будет сделан уже на эту тему, отдельно от предыдущей истории.'
    );
    return;
  }

  if (freeAvailable) {
    session.pendingNewTopic = true;
    session.pendingNewTopicKind = 'free';
    session.readingOfferShown = false;
    session.pendingReadingQuestion = '';
    session.pendingGiftReading = false;

    await showNewTopicInfo(
      chatId,
      session,
      'Хорошо. Напиши новый вопрос, и бесплатный расклад будет сделан уже на новую тему, отдельно от предыдущей истории.'
    );
    return;
  }

  session.pendingNewTopic = false;
  session.pendingNewTopicKind = '';

  const unavailableText =
    'Для новой темы можно приобрести новый расклад или, если не спешишь, подождать 72 часа после последнего использованного расклада. Тогда снова будет доступен бесплатный расклад.';

  if (!session.newTopicInfoUnavailableShown) {
    await showNewTopicInfo(chatId, session, unavailableText);
    session.newTopicInfoUnavailableShown = true;
  }
}
async function telegramSendInvoice(chatId, { title, description, stars, payload }) {
  const amount = Number(stars);

  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error(`Invalid Telegram Stars amount: ${stars}`);
  }
  if (typeof payload !== 'string' || !payload || Buffer.byteLength(payload, 'utf8') > 128) {
    throw new Error('Invalid Telegram Stars invoice payload.');
  }

  const response = await fetch(`${TELEGRAM_API}/sendInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      title,
      description,
      payload,
      currency: 'XTR',
      prices: [{ label: title, amount }],
      reply_markup: {
        inline_keyboard: [
          [{ text: '⭐ Оплатить', pay: true }],
          [{ text: '⬅️ Назад к выбору оплаты', callback_data: 'payment:back' }]
        ]
      }
    })
  });

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram sendInvoice returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.description ||
      `Telegram sendInvoice failed (HTTP ${response.status}).`
    );
  }

  return data.result;
}

async function telegramAnswerPreCheckoutQuery(queryId, ok, errorMessage = '') {
  if (!queryId) throw new Error('Missing Telegram pre-checkout query id.');

  const body = {
    pre_checkout_query_id: queryId,
    ok: Boolean(ok)
  };

  if (!ok && errorMessage) {
    body.error_message = String(errorMessage).slice(0, 200);
  }

  const response = await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram answerPreCheckoutQuery returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.description ||
      `Telegram answerPreCheckoutQuery failed (HTTP ${response.status}).`
    );
  }

  return true;
}


async function createPaymentInvoice(chatId, session, kind, currency = 'STARS', paymentMethod = '') {
  if (!session?.reading) {
    await telegramSendMessage(chatId, 'Сначала нужен расклад, с которого начнём эту историю.');
    return;
  }

  const safeKind = kind === 'celtic' ? 'celtic' : 'reading';
  const isCeltic = safeKind === 'celtic';
  const readingQuestion = session.pendingReadingQuestion || session.reading.question;

  if (currency === 'STARS') {
    const payload = `omen:${safeKind}:${chatId}:${Date.now()}`;
    session.pendingPayment = {
      payload,
      kind: safeKind,
      readingQuestion,
      stars: isCeltic ? CELTIC_CROSS_STARS : PAID_READING_STARS,
      createdAt: Date.now()
    };
    session.pendingTributePayment = null;

    const invoiceMessage = await telegramSendInvoice(chatId, {
      title: isCeltic ? 'Кельтский крест' : 'Продолжение расклада',
      description: isCeltic
        ? 'Кельтский крест: 10 карт, глубокая интерпретация и продолжение истории.'
        : 'Новый расклад с Omen и коротким продолжением разговора.',
      stars: session.pendingPayment.stars,
      payload
    });
    session.pendingPayment.messageId = invoiceMessage?.message_id || null;
    return;
  }

  const tribute = await tributeCreatePaymentLink(safeKind);
  session.pendingPayment = null;
  session.pendingTributePayment = {
    productId: tribute.productId,
    kind: safeKind,
    readingQuestion,
    amount: tribute.amount,
    currency: tribute.currency,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000
  };

  const paymentMessage = await telegramSendPaymentUrl(
    chatId,
    isCeltic
      ? 'Открыл оплату Кельтского креста картой или через СБП. После успешной оплаты Omen автоматически продолжит историю.'
      : 'Открыл оплату банковской картой или через СБП. После успешной оплаты Omen автоматически продолжит историю.',
    tribute.paymentUrl
  );
  session.pendingTributePayment.messageId = paymentMessage?.message_id || null;
}

function hasPaidEntitlements(session) {
  return (
    Number(session?.paidReadingsRemaining || 0) > 0 ||
    Number(session?.paidCelticRemaining || 0) > 0
  );
}

function activatePaidPackage(session, kind = 'reading') {
  const safeKind = kind === 'celtic' ? 'celtic' : 'reading';

  session.paidContinuation = true;
  session.paidPackageKind = safeKind;
  session.paidConversationUsed = 0;
  session.freeConversationUsed = FREE_CONVERSATION_LIMIT;
  session.freeCooldownUsed = false;
  session.readingOfferShown = false;
  session.pendingGiftReading = false;
  session.pendingPaidReadingKind = '';

  if (safeKind === 'celtic') {
    // One Celtic Cross plus two ordinary three-card readings as gifts.
    session.paidCelticRemaining = Number(session.paidCelticRemaining || 0) + CELTIC_CROSSES_PER_PACKAGE;
    session.paidReadingsRemaining =
      Number(session.paidReadingsRemaining || 0) + CELTIC_GIFT_ORDINARY_READINGS_PER_PACKAGE;
  } else {
    // Five ordinary readings total: three included in the package + two gifts.
    session.paidReadingsRemaining =
      Number(session.paidReadingsRemaining || 0) + ORDINARY_READINGS_PER_PACKAGE;
  }

  session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
}

async function handleSuccessfulPayment(message) {
  const payment = message?.successful_payment;
  if (!payment) return false;

  const chatId = message.chat.id;
  const payload = String(payment.invoice_payload || '');
  const chargeId = String(payment.telegram_payment_charge_id || '');
  const session = sessions.get(chatId);

  if (!session?.pendingPayment || session.pendingPayment.payload !== payload) {
    await telegramSendMessage(chatId, 'Платёж получен, но я не смог сопоставить его с текущей историей. Напиши мне, и я помогу продолжить.');
    return true;
  }

  if (
    payment.currency !== 'XTR' ||
    payment.total_amount !== session.pendingPayment.stars
  ) {
    console.error('[tarot-omen] Successful payment amount/currency mismatch:', payment);
    await telegramSendMessage(chatId, 'Платёж получен, но его параметры не совпали с ожидаемым заказом. Напиши мне, и я проверю оплату.');
    return true;
  }

  if (chargeId && processedPaymentCharges.has(chargeId)) return true;
  if (chargeId) {
    processedPaymentCharges.add(chargeId);
    await savePaymentEvent(chargeId, 'stars');
  }

  const pending = session.pendingPayment;
  session.pendingPayment = null;
  session.pendingTributePayment = null;
  activatePaidPackage(session, pending.kind || 'reading');

  if (pending.kind === 'celtic') {
    await telegramSendMessage(chatId, 'Оплата прошла. Запускаю Кельтский крест — 10 карт и подробный разбор.');
    await runPaidCelticReading(chatId, session, pending.readingQuestion || session.reading.question);
    return true;
  }

  await telegramSendMessage(chatId, 'Оплата прошла. У тебя 5 обычных раскладов: 3 входят в пакет и ещё 2 — в подарок. Начинаем первый.');
  await runPaidThreeCardReading(chatId, session, pending.readingQuestion || session.reading.question);
  return true;
}

async function handlePreCheckoutQuery(query) {
  const payload = String(query?.invoice_payload || '');
  const chatId = query?.from?.id;
  const session = sessions.get(chatId);
  const pending = session?.pendingPayment;

  const valid =
    query?.currency === 'XTR' &&
    !!pending &&
    pending.payload === payload &&
    query.total_amount === pending.stars;

  if (!valid) {
    await telegramAnswerPreCheckoutQuery(
      query.id,
      false,
      'Не удалось подтвердить этот платёж. Попробуй открыть оплату ещё раз.'
    );
    return;
  }

  await telegramAnswerPreCheckoutQuery(query.id, true);
}

async function runPaidCelticReading(chatId, session, question, options = {}) {
  const userName = session.userName || '';
  const cards = drawCelticCrossCards();
  const previousReading = session.reading?.spreadType === 'three' ? session.reading : null;
  const historyBlock = Array.isArray(session.history) && session.history.length
    ? session.history.slice(-12).map((item) => `${item.role === 'user' ? 'User' : 'Omen'}: ${item.text}`).join('\n')
    : '';
  const contextParts = [];
  if (previousReading) {
    contextParts.push(`Original three-card question: ${previousReading.question}\nOriginal three-card interpretation: ${previousReading.interpretation}`);
  }
  if (historyBlock) contextParts.push(`Conversation after the three-card reading:\n${historyBlock}`);
  const conversationContext = contextParts.join('\n\n');

  try {
    const mixingMessageIds = await telegramSendMessage(chatId, 'Мешаю карты...', true);
    const shuffleMessageId = await telegramSendShuffleGif(chatId);
    const interpretationPromise = generateInterpretation(question, cards, userName, 'celtic', conversationContext);
    const spreadImage = await buildCelticCrossImage(cards);

    await telegramSendSpreadImage(chatId, spreadImage);
    for (const messageId of mixingMessageIds || []) await telegramDeleteMessage(chatId, messageId);
    await telegramDeleteMessage(chatId, shuffleMessageId);

    await telegramSendCardText(chatId, formatCelticCardMap(cards), cards);
    await sleep(1500);

    const result = await interpretationPromise;
    await telegramSendCardText(chatId, result.interpretation, cards);

    let followup = '';
    try {
      followup = await generateFollowupQuestion({
        userName,
        originalQuestion: question,
        cards,
        interpretation: result.interpretation
      });
      await telegramSendCardText(chatId, followup, cards);
    } catch (followupErr) {
      console.error('[tarot-omen] Celtic follow-up question generation failed:', followupErr);
    }

    session.reading = {
      question,
      cards,
      interpretation: result.interpretation,
      spreadType: 'celtic',
      isCelticTest: options.test === true
    };
    session.history = Array.isArray(session.history) ? session.history.slice(-24) : [];
    session.paidConversationUsed = 0;
    session.paidReadingActive = true;
    session.paidCelticRemaining = Math.max(0, Number(session.paidCelticRemaining || 0) - 1);
    session.paidPackageKind = hasPaidEntitlements(session) ? 'mixed' : 'celtic';
    session.readingOfferShown = false;
    session.pendingReadingQuestion = '';
    session.pendingGiftReading = false;
    session.pendingPaidReadingKind = '';
    session.lastPaidReadingAt = Date.now();
    session.freeConversationUsed = FREE_CONVERSATION_LIMIT;
    session.freeCooldownUsed = false;
    session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
    session.pendingPayment = null;
    session.pendingTributePayment = null;
  } catch (err) {
    console.error('[tarot-omen] Celtic reading error:', err);
    await telegramSendMessage(chatId, 'Не удалось получить Кельтский крест. Оплата сохранена за этой историей — попробуй ещё раз.');
  }
}

async function runPaidThreeCardReading(chatId, session, question) {
  const userName = session.userName || '';
  const cards = drawThreeCards();

  try {
    const mixingMessageIds = await telegramSendMessage(chatId, 'Мешаю карты...', true);
    const shuffleMessageId = await telegramSendShuffleGif(chatId);
    const interpretationPromise = generateInterpretation(question, cards, userName, 'three');
    const spreadImagePromise = buildReadingImage(cards);
    const spreadImage = await spreadImagePromise;

    await telegramSendSpreadImage(chatId, spreadImage);
    for (const messageId of mixingMessageIds || []) await telegramDeleteMessage(chatId, messageId);
    await telegramDeleteMessage(chatId, shuffleMessageId);

    await telegramSendMessage(chatId, CARDS_CAPTION);
    await sleep(1500);

    const result = await interpretationPromise;

    await telegramSendCardText(chatId, result.interpretation, cards);

    let followup = '';
    try {
      followup = await generateFollowupQuestion({
        userName,
        originalQuestion: question,
        cards,
        interpretation: result.interpretation
      });
      await telegramSendCardText(chatId, followup, cards);
    } catch (followupErr) {
      console.error('[tarot-omen] Paid follow-up question generation failed:', followupErr);
    }

    session.reading = {
      question,
      cards,
      interpretation: result.interpretation,
      spreadType: 'three'
    };
    // Keep the existing story history. A new paid spread continues the same
    // conversation instead of resetting Omen's context. Keep the buffer bounded.
    session.history = Array.isArray(session.history) ? session.history.slice(-24) : [];
    session.paidConversationUsed = 0;
    session.paidReadingsRemaining = Math.max(0, Number(session.paidReadingsRemaining || 0) - 1);
    session.paidReadingActive = true;
    session.paidContinuation = true;
    session.paidPackageKind = hasPaidEntitlements(session) ? 'mixed' : 'reading';
    session.readingOfferShown = false;
    session.pendingReadingQuestion = '';
    session.pendingGiftReading = false;
    session.pendingPaidReadingKind = '';
    session.lastPaidReadingAt = Date.now();
    session.freeCooldownUsed = false;
    session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
  } catch (err) {
    console.error('[tarot-omen] Paid reading error:', err);
    await telegramSendMessage(chatId, 'Не удалось получить этот расклад. Оплата сохранена за этой историей — попробуй ещё раз.');
  }
}

async function sendStartMessage(chatId) {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: 'Задавай свой вопрос' })
  });
  if (!response.ok) {
    throw new Error(`Telegram start message failed: ${await response.text()}`);
  }
}

async function processTelegramUpdate(update) {
  if (update?.pre_checkout_query) {
    try {
      await handlePreCheckoutQuery(update.pre_checkout_query);
    } catch (err) {
      console.error('[tarot-omen] Pre-checkout handling failed:', err);
      try {
        await telegramAnswerPreCheckoutQuery(update.pre_checkout_query.id, false, 'Не удалось подтвердить платёж.');
      } catch (answerErr) {
        console.error('[tarot-omen] Failed to answer pre-checkout query:', answerErr);
      }
    }
    return;
  }

  const callback = update?.callback_query;
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const session = sessions.get(chatId);
    try {
      if (callback.data === 'choose:celtic:payment') {
        if (!session?.reading) {
          throw new Error('Сначала нужен основной расклад.');
        }
        await offerCelticPaymentMethods(chatId, callback.message?.message_id);
      } else if (callback.data === 'choose:celtic:back') {
        if (!session?.reading) {
          throw new Error('Сначала нужен основной расклад.');
        }
        await offerPaymentMethods(chatId, callback.message?.message_id);
      } else if (callback.data === 'pay:stars:reading') {
        await createPaymentInvoice(chatId, session, 'reading', 'STARS');
        await deleteCallbackMessage(callback);
      } else if (callback.data === 'pay:stars:celtic') {
        await createPaymentInvoice(chatId, session, 'celtic', 'STARS');
        await deleteCallbackMessage(callback);
      } else if (callback.data === 'pay:tribute:reading') {
        await createPaymentInvoice(chatId, session, 'reading', 'RUB');
        await deleteCallbackMessage(callback);
      } else if (callback.data === 'pay:tribute:celtic') {
        await createPaymentInvoice(chatId, session, 'celtic', 'RUB');
        await deleteCallbackMessage(callback);
      } else if (callback.data === 'payment:back') {
        if (!session) throw new Error('Сначала нужен расклад.');
        if (session.pendingPayment?.messageId === callback.message?.message_id) {
          session.pendingPayment = null;
        }
        if (session.pendingTributePayment?.messageId === callback.message?.message_id) {
          session.pendingTributePayment = null;
        }
        await deleteCallbackMessage(callback);
        await offerPaymentMethods(chatId, null);
      } else if (callback.data === 'use:paid:reading') {
        if (session?.pendingGiftReading && session?.paidReadingsRemaining > 0) {
          session.pendingGiftReading = false;
          session.pendingPaidReadingKind = '';
          session.pendingReadingQuestion = '';
          await deleteCallbackMessage(callback);
          await telegramSendMessage(chatId, `Используем обычный расклад. Осталось после этого: ${Math.max(0, Number(session.paidReadingsRemaining || 0) - 1)}.`);
          await runPaidThreeCardReading(chatId, session, session.reading?.question || 'Посмотреть следующий слой этой истории');
        }
      } else if (callback.data === 'use:paid:celtic') {
        if (session?.pendingGiftReading && session?.paidCelticRemaining > 0) {
          session.pendingGiftReading = false;
          session.pendingPaidReadingKind = '';
          session.pendingReadingQuestion = '';
          await deleteCallbackMessage(callback);
          await telegramSendMessage(chatId, 'Используем Кельтский крест.');
          await runPaidCelticReading(chatId, session, session.reading?.question || 'Посмотреть следующий слой этой истории');
        }
      } else if (callback.data === 'new:topic') {
        // Keep the payment-choice message and its buttons visible. The new-topic
        // action is intentionally additive, so the user can still return to the
        // same payment choices without losing the explanation above them.
        await handleNewTopicRequest(chatId, session);
      } else if (callback.data === 'pay:reading' || callback.data === 'pay:celtic') {
        const kind = callback.data === 'pay:celtic' ? 'celtic' : 'reading';
        await createPaymentInvoice(chatId, session, kind, 'STARS');
        await deleteCallbackMessage(callback);
      }
    } catch (err) {
      console.error('[tarot-omen] Payment button handling failed:', {
        callback: callback.data,
        message: err?.message,
        stack: err?.stack
      });
      if (chatId) {
        if (/No reading is available|Сначала нужен расклад/.test(err?.message || '') || !session) {
          await telegramSendMessage(chatId, 'Эта кнопка относится к предыдущей сессии. Начни новый расклад, и я создам новую оплату.');
        } else {
          await telegramSendMessage(chatId, 'Не удалось открыть оплату. Попробуй ещё раз.');
        }
      }
    } finally {
      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callback.id })
      }).catch(() => {});
    }
    return;
  }

  const message = update?.message;
  if (!message) return;

  if (message.successful_payment) {
    try {
      await handleSuccessfulPayment(message);
    } catch (err) {
      console.error('[tarot-omen] Successful payment handling failed:', err);
      await telegramSendMessage(message.chat.id, 'Платёж прошёл, но возникла техническая ошибка при запуске расклада. Напиши ещё раз, чтобы продолжить.');
    }
    return;
  }

  // Text input only. Voice-to-text is intentionally not enabled because it would
  // require a separate speech-to-text service and consume paid API resources.
  if (!message.text) return;

  const chatId = message.chat.id;
  const text = String(message.text || '').trim();
  const userName = String(message.from?.first_name || '').trim();

  if (!text) return;

  if (text === '/start') {
    // /start must never reset the user's free entitlement. It only starts/returns
    // to the current Omen session.
    if (!sessions.has(chatId)) {
      sessions.set(chatId, {
        userName,
        reading: null,
        history: [],
        freeConversationUsed: 0,
        paidConversationUsed: 0,
        paidReadingsRemaining: 0,
        paidCelticRemaining: 0,
        paidReadingActive: false,
        paidPackageKind: 'reading',
        pendingGiftReading: false,
        pendingPaidReadingKind: '',
        paidContinuation: false,
        readingOfferShown: false,
        pendingReadingQuestion: '',
        pendingPayment: null,
        pendingTributePayment: null,
        freeReadingUsed: false,
        freeCooldownAvailableAt: 0
      });
    } else {
      sessions.get(chatId).userName = userName || sessions.get(chatId).userName || '';
    }
    await sendStartMessage(chatId);
    return;
  }
  if (rateLimited(`tg:${chatId}`)) {
    await telegramSendMessage(chatId, 'Слишком много запросов подряд. Попробуй через пару минут.');
    return;
  }

  const session = sessions.get(chatId);

  // ===== NEW TOPIC MODE =====
  // Entered only by the explicit 'new topic' button. Without it, the existing
  // reading/history continues exactly as before.
  if (session?.pendingNewTopic) {
    const requestedKind = session.pendingNewTopicKind ||
      (Number(session.paidReadingsRemaining || 0) > 0 ? 'reading' :
        Number(session.paidCelticRemaining || 0) > 0 ? 'celtic' : 'free');

    session.pendingNewTopic = false;
    session.pendingNewTopicKind = '';

    try {
      if (requestedKind === 'free') {
        if (Date.now() < Number(session.freeCooldownAvailableAt || 0)) {
          await showNewTopicInfo(
            chatId,
            session,
            'Для новой темы можно приобрести новый расклад или, если не спешишь, подождать 72 часа после последнего использованного расклада. Тогда снова будет доступен бесплатный расклад.'
          );
          return;
        }
      }

      // Clear the previous story only after a new-topic reading is actually available.
      clearReadingStoryForNewTopic(session);

      if (requestedKind === 'free') {
        const cards = drawThreeCards();
        await telegramSendMessage(chatId, 'Мешаю карты...', true);
        await telegramSendShuffleGif(chatId);

        const interpretationPromise = generateInterpretation(text, cards, userName, 'three');
        const spreadImage = await buildReadingImage(cards);
        await telegramSendSpreadImage(chatId, spreadImage);
        await telegramSendMessage(chatId, CARDS_CAPTION);
        await sleep(1200);
        const result = await interpretationPromise;
        await telegramSendCardText(chatId, result.interpretation, cards);

        try {
          const followup = await generateFollowupQuestion({
            userName,
            originalQuestion: text,
            cards,
            interpretation: result.interpretation
          });
          await telegramSendCardText(chatId, followup, cards);
        } catch (followupErr) {
          console.error('[tarot-omen] New-topic free follow-up question generation failed:', followupErr);
        }

        session.reading = {
          question: text,
          cards,
          interpretation: result.interpretation,
          spreadType: 'three'
        };
        session.history = Array.isArray(session.history) ? session.history.slice(-24) : [];
        session.freeConversationUsed = 0;
        session.paidConversationUsed = 0;
        session.paidReadingActive = false;
        session.paidContinuation = false;
        session.pendingReadingQuestion = '';
        session.readingOfferShown = false;
        session.pendingGiftReading = false;
        session.pendingPaidReadingKind = '';
        session.freeCooldownUsed = false;
        session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
        return;
      }

      if (requestedKind === 'celtic' && Number(session.paidCelticRemaining || 0) > 0) {
        await runPaidCelticReading(chatId, session, text);
        return;
      }
      if (Number(session.paidReadingsRemaining || 0) > 0) {
        await runPaidThreeCardReading(chatId, session, text);
        return;
      }
      await telegramSendMessage(chatId, 'Не удалось найти доступный расклад для новой темы.');
      return;
    } catch (err) {
      console.error('[tarot-omen] New topic reading failed:', err);
      await telegramSendMessage(chatId, 'Не удалось запустить расклад на новую тему. Попробуй ещё раз.');
      return;
    }
  }

  // If Omen has already offered a specific next spread and the user confirms
  // in plain text (for example, "Хочу", "Давай", "Да"), go straight to
  // the payment invoice instead of spending another Gemini request on chat.
  const affirmative = /^(да|давай|хочу|конечно|погнали|согласен|согласна|сделаем|смотреть|посмотрим|давай посмотрим|хочу посмотреть|использовать|используем|бери подарок|давай подарок|yes|sure|ok|okay)$/i.test(text);
  if (session?.pendingGiftReading && affirmative) {
    const preferredKind =
      session.pendingPaidReadingKind ||
      (Number(session.paidReadingsRemaining || 0) > 0 ? 'reading' : 'celtic');

    if (preferredKind === 'celtic' && Number(session.paidCelticRemaining || 0) > 0) {
      session.pendingGiftReading = false;
      session.pendingPaidReadingKind = '';
      session.pendingReadingQuestion = '';
      await telegramSendMessage(chatId, 'Используем Кельтский крест.');
      await runPaidCelticReading(chatId, session, session.reading?.question || 'Посмотреть следующий слой этой истории');
      return;
    }

    if (Number(session.paidReadingsRemaining || 0) > 0) {
      session.pendingGiftReading = false;
      session.pendingPaidReadingKind = '';
      session.pendingReadingQuestion = '';
      await telegramSendMessage(chatId, 'Используем обычный расклад.');
      await runPaidThreeCardReading(chatId, session, session.reading?.question || 'Посмотреть следующий слой этой истории');
      return;
    }
  }
  if (session?.readingOfferShown && session?.pendingReadingQuestion && !session?.pendingPayment && affirmative) {
    try {
      await createPaymentInvoice(chatId, session, 'reading', 'STARS');
    } catch (err) {
      console.error('[tarot-omen] Text confirmation payment handling failed:', err);
      await telegramSendMessage(chatId, 'Не удалось открыть оплату. Попробуй ещё раз.');
    }
    return;
  }

  // ===== FREE 72-HOUR CONTINUATION =====
  // A free three-card continuation becomes available 72 hours after each
  // completed reading (free or paid). Paid entitlements remain available
  // independently and never expire by time.
  if (session?.reading &&
      !session.pendingGiftReading &&
      Date.now() >= Number(session.freeCooldownAvailableAt || 0)) {
    try {
      const continuationQuestion = session.pendingReadingQuestion || text;
      const cards = drawThreeCards();
      await telegramSendMessage(chatId, 'Мешаю карты...', true);
      await telegramSendShuffleGif(chatId);

      const interpretationPromise = generateInterpretation(continuationQuestion, cards, userName, 'three');
      const spreadImage = await buildReadingImage(cards);
      await telegramSendSpreadImage(chatId, spreadImage);
      await telegramSendMessage(chatId, CARDS_CAPTION);
      await sleep(1200);
      const result = await interpretationPromise;

      // The 72-hour free continuation stays text-only. Voice is reserved for
      // the first free reading and paid readings.
      await telegramSendCardText(chatId, result.interpretation, cards);

      try {
        const followup = await generateFollowupQuestion({
          userName,
          originalQuestion: continuationQuestion,
          cards,
          interpretation: result.interpretation
        });
        await telegramSendCardText(chatId, followup, cards);
      } catch (followupErr) {
        console.error('[tarot-omen] 72h follow-up question generation failed:', followupErr);
      }

      session.reading = {
        question: continuationQuestion,
        cards,
        interpretation: result.interpretation,
        spreadType: 'three'
      };
      session.history = Array.isArray(session.history) ? session.history.slice(-24) : [];
      session.freeConversationUsed = 0;
      session.paidConversationUsed = 0;
      session.paidReadingActive = false;
      session.paidContinuation = false;
      session.pendingReadingQuestion = '';
      session.readingOfferShown = false;
      session.pendingGiftReading = false;
      session.pendingPaidReadingKind = '';
      session.freeCooldownUsed = false;
      session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
      return;
    } catch (err) {
      console.error('[tarot-omen] Free 72-hour continuation reading failed:', err);
      await telegramSendMessage(chatId, 'Не удалось получить продолжение расклада. Попробуй ещё раз.');
      return;
    }
  }

  // ===== GATE AFTER THE FREE CONVERSATION WINDOW =====
  // A completed paid reading has its own paid conversation window, handled above.
  // Once a free conversation window is exhausted, use an already purchased
  // reading if one exists. Otherwise show the paid continuation offer.
  if (session?.reading &&
      session.paidContinuation !== true &&
      session.freeConversationUsed >= FREE_CONVERSATION_LIMIT &&
      !session.pendingGiftReading) {
    if (hasPaidEntitlements(session)) {
      await offerAvailablePaidReadings(chatId, session);
    } else {
      const offerQuestion = session.pendingReadingQuestion ||
        'Посмотреть следующий слой этой истории отдельным раскладом';
      await offerPaidContinuation(chatId, session, offerQuestion);
    }
    return;
  }

  // ===== PAID CONVERSATION AFTER A PAID READING =====
  if (session?.reading && session.paidContinuation === true && session.paidConversationUsed < PAID_CONVERSATION_LIMIT) {
    let result;
    try {
      result = await generateConversationResponse({
        userName,
        originalQuestion: session.reading.question,
        cards: session.reading.cards,
        interpretation: session.reading.interpretation,
        history: session.history,
        latestMessage: text,
        conversationUsed: session.paidConversationUsed,
        conversationLimit: PAID_CONVERSATION_LIMIT,
        spreadType: session.reading.spreadType || 'three'
      });
    } catch (err) {
      console.error('[tarot-omen] Gemini paid conversation generation failed:', err);
      await telegramSendMessageWithRetry(chatId, 'Не смог сейчас продолжить мысль. Попробуй ещё раз.');
      return;
    }

    session.paidConversationUsed += 1;
    if (result.readingOffer && result.readingQuestion) {
      session.pendingReadingQuestion = result.readingQuestion;
    }

    session.history.push({ role: 'user', text });
    session.history.push({ role: 'omen', text: result.reply });
    session.history.push({ role: 'omen', text: result.nextMessage });
    session.history = session.history.slice(-24);

    try {
      await telegramSendCardText(chatId, result.reply, session.reading.cards);
    } catch (sendErr) {
      console.error('[tarot-omen] Telegram paid conversation reply delivery failed:', sendErr);
      return;
    }

    if (session.paidConversationUsed >= PAID_CONVERSATION_LIMIT) {
      session.paidReadingActive = false;
      session.paidContinuation = false;
      if (hasPaidEntitlements(session)) {
        try {
          await offerAvailablePaidReadings(chatId, session);
        } catch (offerErr) {
          console.error('[tarot-omen] Paid reading entitlement offer delivery failed:', offerErr);
        }
      } else {
        session.readingOfferShown = false;
        try {
          await offerPaidContinuation(
            chatId,
            session,
            session.pendingReadingQuestion || 'Посмотреть следующий слой этой истории отдельным раскладом'
          );
        } catch (offerErr) {
          console.error('[tarot-omen] Paid continuation offer delivery failed:', offerErr);
        }
      }
    } else {
      try {
        await telegramSendCardText(chatId, result.nextMessage, session.reading.cards);
      } catch (sendErr) {
        console.error('[tarot-omen] Telegram paid next-message delivery failed:', sendErr);
      }
    }
    return;
  }

  // ===== FREE CONVERSATION AFTER A COMPLETED READING =====
  if (session?.reading && session.freeConversationUsed < FREE_CONVERSATION_LIMIT) {
    let result;
    try {
      result = await generateConversationResponse({
        userName,
        originalQuestion: session.reading.question,
        cards: session.reading.cards,
        interpretation: session.reading.interpretation,
        history: session.history,
        latestMessage: text,
        conversationUsed: session.freeConversationUsed,
        conversationLimit: FREE_CONVERSATION_LIMIT,
        spreadType: session.reading.spreadType || 'three'
      });
    } catch (err) {
      console.error('[tarot-omen] Gemini conversation generation failed:', err);
      await telegramSendMessageWithRetry(chatId, 'Не смог сейчас продолжить мысль. Попробуй ещё раз.');
      return;
    }

    // The Gemini response is now complete before we mutate state or send Telegram messages.
    session.freeConversationUsed += 1;
    if (result.readingOffer && result.readingQuestion) {
      session.pendingReadingQuestion = result.readingQuestion;
    }

    session.history.push({ role: 'user', text });
    session.history.push({ role: 'omen', text: result.reply });
    session.history.push({ role: 'omen', text: result.nextMessage });
    session.history = session.history.slice(-24);

    // A Telegram delivery failure must never be reported as a Gemini failure after
    // the reply has already reached the user. Retry each message independently.
    try {
      await telegramSendCardText(chatId, result.reply, session.reading.cards);
    } catch (sendErr) {
      console.error('[tarot-omen] Telegram conversation reply delivery failed:', sendErr);
      return;
    }

    if (session.freeConversationUsed >= FREE_CONVERSATION_LIMIT) {
      try {
        if (hasPaidEntitlements(session)) {
          await offerAvailablePaidReadings(chatId, session);
        } else {
          const offerQuestion = session.pendingReadingQuestion || 'Посмотреть следующий слой этой истории отдельным раскладом';
          await offerPaidContinuation(chatId, session, offerQuestion);
        }
      } catch (offerErr) {
        console.error('[tarot-omen] Paid/available reading offer delivery failed:', offerErr);
        // Do not send the generic Gemini error: the conversation reply was already delivered.
      }
    } else {
      try {
        await telegramSendCardText(chatId, result.nextMessage, session.reading.cards);
      } catch (sendErr) {
        console.error('[tarot-omen] Telegram next-message delivery failed:', sendErr);
        // Do not send a misleading "Не смог сейчас продолжить мысль" after a successful reply.
      }
    }
    return;
  }

  try {
    // ===== NEW FREE THREE-CARD READING =====
    const cards = drawThreeCards();
    const mixingMessageIds = await telegramSendMessage(chatId, 'Мешаю карты...', true);
    const shuffleMessageId = await telegramSendShuffleGif(chatId);

    const interpretationPromise = generateInterpretation(text, cards, userName);
    const spreadImagePromise = buildReadingImage(cards);
    const spreadImage = await spreadImagePromise;

    await telegramSendSpreadImage(chatId, spreadImage);

    for (const messageId of mixingMessageIds || []) await telegramDeleteMessage(chatId, messageId);
    await telegramDeleteMessage(chatId, shuffleMessageId);

    await telegramSendMessage(chatId, CARDS_CAPTION);
    await sleep(2000);

    const result = await interpretationPromise;

    await telegramSendCardText(chatId, result.interpretation, cards);

    // Every completed spread gets a separate, context-aware question that invites
    // the user to continue the conversation. It is text-only and never goes to ElevenLabs.
    try {
      const followup = await generateFollowupQuestion({
        userName,
        originalQuestion: text,
        cards,
        interpretation: result.interpretation
      });
      await telegramSendCardText(chatId, followup, cards);
    } catch (followupErr) {
      console.error('[tarot-omen] Follow-up question generation failed:', followupErr);
    }

    sessions.set(chatId, {
      userName,
      reading: {
        question: text,
        cards,
        interpretation: result.interpretation,
        spreadType: 'three'
      },
      history: [],
      freeConversationUsed: 0,
      paidConversationUsed: 0,
      paidReadingsRemaining: 0,
      paidCelticRemaining: 0,
      paidReadingActive: false,
      paidPackageKind: 'reading',
      pendingGiftReading: false,
      pendingPaidReadingKind: '',
      pendingNewTopic: false,
      pendingNewTopicKind: '',
      newTopicInfoMessageId: 0,
      newTopicInfoPromise: null,
      paidContinuation: PAID_CONTINUATION_DEFAULT,
      readingOfferShown: false,
      pendingReadingQuestion: '',
      pendingPayment: null,
      freeReadingUsed: true,
      freeCooldownUsed: false,
      freeCooldownAvailableAt: Date.now() + FREE_COOLDOWN_MS
    });
  } catch (err) {
    console.error('[tarot-omen] Telegram reading error:', err);
    try {
      await telegramSendMessage(chatId, 'Не удалось получить расклад. Попробуй ещё раз.');
    } catch (sendErr) {
      console.error('[tarot-omen] Telegram: failed to send error message:', sendErr);
    }
  }
}

function getUpdateChatId(update) {
  if (update?.message?.chat?.id) return Number(update.message.chat.id);
  if (update?.callback_query?.message?.chat?.id) return Number(update.callback_query.message.chat.id);
  if (update?.pre_checkout_query?.from?.id) return Number(update.pre_checkout_query.from.id);
  return null;
}

async function handleTelegramUpdate(update) {
  const chatId = getUpdateChatId(update);

  if (chatId) {
    await loadSession(chatId);
  }

  try {
    await processTelegramUpdate(update);
  } finally {
    if (chatId) {
      await saveSession(chatId);
    }
  }
}

app.post('/tribute-webhook', (req, res) => {
  if (!tributeSignatureMatches(req)) {
    return res.status(401).json({ error: 'Invalid webhook signature.' });
  }

  res.status(200).json({ status: 'ok' });

  handleTributeWebhook(req.body)
    .then(async () => {
      const telegramUserId = Number(req.body?.payload?.telegram_user_id);
      if (Number.isSafeInteger(telegramUserId) && telegramUserId > 0) {
        await saveSession(telegramUserId);
      }
    })
    .catch((err) => {
      console.error('[tarot-omen] Tribute webhook handler error:', err);
    });
});

app.get('/tribute-webhook', (_req, res) => {
  res.status(200).json({ ok: true, webhook: 'tribute' });
});

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
        drop_pending_updates: false
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

async function startServer() {
  try {
    await initDatabase();
  } catch (err) {
    console.error('[tarot-omen] PostgreSQL initialization failed:', err);
    dbReady = false;
    if (dbPool) {
      try { await dbPool.end(); } catch {}
      dbPool = null;
    }
    if (DATABASE_URL) {
      console.error('[tarot-omen] DATABASE_URL is configured, so startup is stopped to prevent running without persistent storage.');
      process.exit(1);
    }
  }

  app.listen(PORT, () => {
    console.log(`[tarot-omen] backend listening on port ${PORT}`);
    setupTelegramWebhook();
    if (TRIBUTE_API_KEY) {
      tributeResolveProducts(true).catch((err) => {
        console.error('[tarot-omen] Tribute product auto-discovery failed at startup:', err);
      });
    }
  });
}

startServer().catch((err) => {
  console.error('[tarot-omen] Fatal startup error:', err);
  process.exit(1);
});
