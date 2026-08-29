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
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// LAVA.TOP card / bank payment integration. No npm package is required.
const LAVA_API_KEY = process.env.LAVA_API_KEY;
const LAVA_WEBHOOK_API_KEY = process.env.LAVA_WEBHOOK_API_KEY;
const LAVA_API_URL = process.env.LAVA_API_URL || 'https://gate.lava.top';
const LAVA_READING_OFFER_ID = process.env.LAVA_READING_OFFER_ID;
const LAVA_CELTIC_OFFER_ID = process.env.LAVA_CELTIC_OFFER_ID;
const LAVA_EMAIL_DOMAIN = process.env.LAVA_EMAIL_DOMAIN || 'omenbot.app';
const TELEGRAM_WEBHOOK_URL =
  process.env.TELEGRAM_WEBHOOK_URL || 'https://tarot-omen1.onrender.com/telegram-webhook';

if (!GEMINI_API_KEY) {
  console.warn('[tarot-omen] WARNING: GEMINI_API_KEY is not set.');
}
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[tarot-omen] WARNING: TELEGRAM_BOT_TOKEN is not set. Telegram bot will not run.');
}
if (!LAVA_API_KEY) {
  console.warn('[tarot-omen] WARNING: LAVA_API_KEY is not set. Card payments will be unavailable.');
}
if (!LAVA_WEBHOOK_API_KEY) {
  console.warn('[tarot-omen] WARNING: LAVA_WEBHOOK_API_KEY is not set. LAVA payment webhooks will be rejected.');
}
if (!LAVA_READING_OFFER_ID) {
  console.warn('[tarot-omen] WARNING: LAVA_READING_OFFER_ID is not set. Card payment links cannot be created.');
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
// MVP storage: in-memory. A Render restart clears sessions.
const sessions = new Map();
const PAID_READING_STARS = Number(process.env.PAID_READING_STARS || 49);
const CELTIC_CROSS_STARS = Number(process.env.CELTIC_CROSS_STARS || 89);

// LAVA.TOP has a minimum one-time price of 50 RUB / 5 USD / 5 EUR.
// Therefore the card price is 50 RUB (while Telegram Stars can remain 49).
const LAVA_READING_RUB = Number(process.env.LAVA_READING_RUB || 50);
const LAVA_READING_USD = Number(process.env.LAVA_READING_USD || 5);
const LAVA_CELTIC_RUB = Number(process.env.LAVA_CELTIC_RUB || 90);
const LAVA_CELTIC_USD = Number(process.env.LAVA_CELTIC_USD || 9);

const FREE_CONVERSATION_LIMIT = 3;
const PAID_CONVERSATION_LIMIT = 3;
const PAID_READINGS_PER_PACKAGE = 2;
const FREE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const PAID_CONTINUATION_DEFAULT = false;
const processedPaymentCharges = new Set();
const processedLavaPayments = new Set();
let resolvedLavaReadingOfferId = '';
let resolvedLavaCelticOfferId = '';

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
- Be natural, perceptive, warm and concise. Usually 1-3 short paragraphs.
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
- After EVERY reply, provide either a short context-specific question OR a short concluding thought. Never leave the reply hanging without one of these.
- next_message_type must be exactly "question" or "conclusion".
- Use "question" when there is a natural, meaningful thing the user can answer that deepens the conversation.
- Use "conclusion" when the user's latest message closes the current thought, or when another question would feel forced. The conclusion should feel complete, not like a sales message.
- The next_message is sent as a SEPARATE Telegram message.
- Never mention payment, credits, limits or sales in next_message.
- Do not ask a generic question. Connect it to the actual conversation and the reading.
- Do not repeat the same question or simply rephrase the user's last message.`;

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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
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
            systemInstruction: { parts: [{ text: CONVERSATION_SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: { maxOutputTokens: 1000, responseMimeType: 'application/json' }
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
      const reply = capText(typeof result?.reply === 'string' ? result.reply.trim() : '', 1800);
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

function lavaSyntheticEmail(chatId, kind) {
  const safeKind = kind === 'celtic' ? 'celtic' : 'reading';
  return `omen-${chatId}-${safeKind}@${LAVA_EMAIL_DOMAIN}`;
}

function extractChatIdFromLavaEmail(email) {
  const value = String(email || '').trim();
  const match = value.match(/^omen-(\d+)-(reading|celtic)@/i);
  return match ? Number(match[1]) : null;
}

function extractKindFromLavaEmail(email) {
  const value = String(email || '').trim();
  const match = value.match(/^omen-(\d+)-(reading|celtic)@/i);
  return match ? match[2].toLowerCase() : null;
}

function findFirstDeepValue(value, keys, depth = 0) {
  if (depth > 5 || value == null || typeof value !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] != null) {
      return value[key];
    }
  }
  for (const child of Object.values(value)) {
    const found = findFirstDeepValue(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}


async function resolveLavaOfferId(kind) {
  const cached = kind === 'celtic' ? resolvedLavaCelticOfferId : resolvedLavaReadingOfferId;
  if (cached) return cached;
  if (!LAVA_API_KEY) throw new Error('LAVA_API_KEY is not configured.');

  const response = await fetch(
    `${LAVA_API_URL}/api/v2/products?feedVisibility=ALL`,
    {
      headers: {
        Accept: 'application/json',
        'X-Api-Key': LAVA_API_KEY
      }
    }
  );

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`LAVA products lookup returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    console.error('[tarot-omen] LAVA products lookup failed:', {
      status: response.status,
      data
    });
    throw new Error(data?.message || data?.error?.message || `LAVA products HTTP ${response.status}`);
  }

  const target = kind === 'celtic' ? 'кельтский крест' : 'таро-расклад';
  const products = [];

  const walk = (value, depth = 0) => {
    if (depth > 6 || value == null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    const name = String(
      value.name ?? value.title ?? value.productName ?? value.contentName ?? ''
    ).trim().toLowerCase();

    const id = String(
      value.offerId ?? value.orderId ?? value.id ?? value.productId ?? ''
    ).trim();

    if (name && id) products.push({ name, id });
    for (const child of Object.values(value)) walk(child, depth + 1);
  };

  walk(data);

  const exact = products.find((item) => item.name === target);
  const partial = products.find((item) => item.name.includes(target));
  const resolved = exact?.id || partial?.id;

  if (!resolved) {
    console.error('[tarot-omen] LAVA target product not found:', {
      target,
      products: products.slice(0, 50)
    });
    throw new Error(`LAVA product "${target}" was not found.`);
  }

  if (kind === 'celtic') resolvedLavaCelticOfferId = resolved;
  else resolvedLavaReadingOfferId = resolved;

  console.log(`[tarot-omen] LAVA ${kind} offerId resolved from product feed.`);
  return resolved;
}

async function lavaCreateInvoice(chatId, session, kind, currency, paymentMethod = '') {
  if (!LAVA_API_KEY) {
    throw new Error('LAVA_API_KEY is not configured.');
  }

  let offerId = kind === 'celtic' ? LAVA_CELTIC_OFFER_ID : LAVA_READING_OFFER_ID;

  const normalizedCurrency = currency === 'USD' ? 'USD' : 'RUB';
  const amount = kind === 'celtic'
    ? (normalizedCurrency === 'USD' ? LAVA_CELTIC_USD : LAVA_CELTIC_RUB)
    : (normalizedCurrency === 'USD' ? LAVA_READING_USD : LAVA_READING_RUB);

  const email = lavaSyntheticEmail(chatId, kind);
  const payload = {
    email,
    offerId,
    currency: normalizedCurrency,
    amount
  };

  // Russian card payments keep Lava's default RUB provider (SMART_GLOCAL).
  // SBP is explicitly routed through PAY2ME using paymentMethod=SBP.
  if (normalizedCurrency === 'RUB' && paymentMethod === 'SBP') {
    payload.paymentProvider = 'PAY2ME';
    payload.paymentMethod = 'SBP';
  }

  const createInvoice = async (currentOfferId) => {
    const response = await fetch(`${LAVA_API_URL}/api/v3/invoice`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': LAVA_API_KEY
      },
      body: JSON.stringify({
        ...payload,
        offerId: currentOfferId
      })
    });

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error('[tarot-omen] LAVA returned non-JSON response:', {
        status: response.status,
        bodyPreview: raw.slice(0, 500)
      });
      throw new Error(`LAVA returned invalid JSON (HTTP ${response.status}).`);
    }

    return { response, data };
  };

  if (!offerId) {
    offerId = await resolveLavaOfferId(kind);
  }

  let result = await createInvoice(offerId);

  // If the dashboard UUID isn't the Public API offerId, resolve the actual
  // hidden API product and retry once.
  if (
    result.response.status === 404 &&
    /Product with offer id/i.test(
      String(result.data?.error || result.data?.message || result.data?.details?.error || '')
    )
  ) {
    const resolved = await resolveLavaOfferId(kind);
    if (resolved !== offerId) {
      offerId = resolved;
      result = await createInvoice(offerId);
    }
  }

  const response = result.response;
  const data = result.data;

  if (!response.ok) {
    console.error('[tarot-omen] LAVA invoice error:', {
      status: response.status,
      data,
      offerId
    });
    throw new Error(
      data?.message ||
      data?.error?.message ||
      data?.error ||
      `LAVA API HTTP ${response.status}`
    );
  }

  const paymentUrl = findFirstDeepValue(data, [
    'paymentUrl',
    'payment_url',
    'invoiceUrl',
    'invoice_url',
    'paymentLink',
    'payment_link',
    'payUrl',
    'pay_url',
    'url'
  ]);

  if (!paymentUrl) {
    console.error('[tarot-omen] LAVA invoice response without payment URL:', data);
    throw new Error('LAVA invoice was created but payment URL was not returned.');
  }

  session.pendingLavaPayment = {
    kind,
    currency: normalizedCurrency,
    amount,
    offerId,
    paymentMethod: normalizedCurrency === 'RUB' ? (paymentMethod || 'CARD') : '',
    paymentProvider: paymentMethod === 'SBP' ? 'PAY2ME' : '',
    email,
    createdAt: Date.now()
  };

  return paymentUrl;
}

async function telegramSendPaymentUrl(chatId, text, url) {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[{ text: '💳 Перейти к оплате', url }]]
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Telegram payment URL message failed: ${await response.text()}`);
  }
}

async function offerPaidContinuation(chatId, session, readingQuestion = '') {
  const question = (readingQuestion || '').trim() ||
    'Посмотреть следующий слой этой истории отдельным раскладом';

  session.pendingReadingQuestion = question;
  session.readingOfferShown = true;
  session.pendingGiftReading = false;

  await telegramSendInlineKeyboard(
    chatId,
    'Если хочешь продолжить эту историю сейчас, можно открыть следующий расклад. После оплаты ты получишь два расклада: один сейчас и ещё один — в подарок. Если не спешишь, можно подождать 72 часа — после этого снова будет доступен бесплатный расклад, и мы продолжим эту же историю.',
    [
      [{ text: `⭐ Telegram Stars — ${PAID_READING_STARS}`, callback_data: 'pay:stars:reading' }],
      [{ text: `💳 Карта — ${LAVA_READING_RUB} ₽`, callback_data: 'pay:lava:reading:RUB:CARD' }],
      [{ text: `🏦 СБП — ${LAVA_READING_RUB} ₽`, callback_data: 'pay:lava:reading:RUB:SBP' }],
      [{ text: `🌍 Зарубежная карта — $${LAVA_READING_USD}`, callback_data: 'pay:lava:reading:USD' }],
      [{ text: '🧪 Кельтский крест — тест бесплатно', callback_data: 'test:celtic:payment' }]
    ]
  );
}

async function offerGiftReading(chatId, session) {
  session.pendingGiftReading = true;
  session.readingOfferShown = false;

  await telegramSendInlineKeyboard(
    chatId,
    'В этом продолжении у тебя остался ещё один расклад в подарок. Можем использовать его сейчас или оставить на потом — он никуда не исчезнет.',
    [[{ text: '🔮 Использовать подарок', callback_data: 'gift:reading' }]]
  );
}

async function handleLavaWebhook(body) {
  const event = String(
    findFirstDeepValue(body, ['event', 'eventType', 'type']) || ''
  ).toLowerCase();
  const status = String(
    findFirstDeepValue(body, ['status', 'contractStatus']) || ''
  ).toLowerCase();

  const isSuccess =
    event === 'payment.success' ||
    event === 'payment_success' ||
    event === 'success' ||
    status === 'success';

  if (!isSuccess) return;

  const email = findFirstDeepValue(body, ['email', 'buyerEmail', 'customerEmail']);
  const chatId = extractChatIdFromLavaEmail(email);
  const kindFromEmail = extractKindFromLavaEmail(email);
  if (!chatId || !kindFromEmail) {
    console.warn('[tarot-omen] LAVA payment received but chat ID could not be extracted:', body);
    return;
  }

  const invoiceId = String(
    findFirstDeepValue(body, ['invoiceId', 'invoiceID', 'id', 'contractId']) ||
    `${email}:${findFirstDeepValue(body, ['amount']) || ''}:${findFirstDeepValue(body, ['createdAt']) || ''}`
  );
  if (processedLavaPayments.has(invoiceId)) return;
  processedLavaPayments.add(invoiceId);

  let session = sessions.get(chatId);
  if (!session) {
    session = {
      userName: '',
      reading: null,
      history: [],
      freeConversationUsed: FREE_CONVERSATION_LIMIT,
      paidConversationUsed: 0,
      paidReadingsRemaining: 0,
      paidReadingActive: false,
      paidPackageKind: 'reading',
      pendingGiftReading: false,
      paidContinuation: false,
      readingOfferShown: false,
      pendingReadingQuestion: '',
      pendingPayment: null,
      pendingLavaPayment: null,
      freeReadingUsed: true,
      freeCooldownAvailableAt: Date.now()
    };
    sessions.set(chatId, session);
  }

  const pending = session.pendingLavaPayment;
  if (pending && pending.kind !== kindFromEmail) {
    console.warn('[tarot-omen] LAVA payment kind mismatch. Ignoring webhook.');
    return;
  }

  const question = session.pendingReadingQuestion || session.reading?.question ||
    'Посмотреть следующий слой этой истории';

  session.pendingLavaPayment = null;
  activatePaidPackage(session, kindFromEmail);

  if (kindFromEmail === 'celtic') {
    await telegramSendMessage(chatId, 'Оплата прошла. Запускаю Кельтский крест — 10 карт и подробный разбор.');
    await runPaidCelticReading(chatId, session, question);
    return;
  }

  await telegramSendMessage(chatId, 'Оплата прошла. В пакет входят два расклада: один сейчас и ещё один — в подарок. Начинаем первый.');
  await runPaidThreeCardReading(chatId, session, question);
}

async function createPaymentInvoice(chatId, session, kind, currency = 'RUB', paymentMethod = '') {
  if (!session?.reading) {
    await telegramSendMessage(chatId, 'Сначала нужен расклад, с которого начнём эту историю.');
    return;
  }

  const safeKind = kind === 'celtic' ? 'celtic' : 'reading';
  const isCeltic = safeKind === 'celtic';
  const payload = `omen:${safeKind}:${chatId}:${Date.now()}`;
  session.pendingPayment = {
    payload,
    kind: safeKind,
    readingQuestion: session.pendingReadingQuestion || session.reading.question,
    stars: isCeltic ? CELTIC_CROSS_STARS : PAID_READING_STARS,
    createdAt: Date.now()
  };

  if (currency === 'STARS') {
    await telegramSendInvoice(chatId, {
      title: isCeltic ? 'Кельтский крест' : 'Продолжение расклада',
      description: isCeltic
        ? 'Кельтский крест: 10 карт, глубокая интерпретация и продолжение истории.'
        : 'Новый расклад с Omen и коротким продолжением разговора.',
      stars: session.pendingPayment.stars,
      payload
    });
    return;
  }

  const paymentUrl = await lavaCreateInvoice(chatId, session, safeKind, currency, paymentMethod);
  await telegramSendPaymentUrl(
    chatId,
    isCeltic
      ? currency === 'USD'
        ? 'Открыл оплату Кельтского креста зарубежной картой. После успешной оплаты Omen автоматически продолжит историю.'
        : paymentMethod === 'SBP'
          ? 'Открыл оплату Кельтского креста через СБП. После успешной оплаты Omen автоматически продолжит историю.'
          : 'Открыл оплату Кельтского креста банковской картой. После успешной оплаты Omen автоматически продолжит историю.'
      : currency === 'USD'
        ? 'Открыл оплату зарубежной картой. После успешной оплаты Omen автоматически продолжит историю.'
        : paymentMethod === 'SBP'
          ? 'Открыл оплату через СБП. После успешной оплаты Omen автоматически продолжит историю.'
          : 'Открыл оплату банковской картой. После успешной оплаты Omen автоматически продолжит историю.',
    paymentUrl
  );
}

function activatePaidPackage(session, kind = 'reading') {
  session.paidContinuation = true;
  session.paidPackageKind = kind;
  session.paidReadingsRemaining = kind === 'celtic' ? 0 : PAID_READINGS_PER_PACKAGE;
  session.paidConversationUsed = 0;
  session.freeConversationUsed = FREE_CONVERSATION_LIMIT;
  session.freeCooldownUsed = false;
  session.freeCooldownAvailableAt = 0;
  session.readingOfferShown = false;
  session.pendingGiftReading = false;
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
  if (chargeId) processedPaymentCharges.add(chargeId);

  const pending = session.pendingPayment;
  session.pendingPayment = null;
  session.pendingLavaPayment = null;
  activatePaidPackage(session, pending.kind || 'reading');

  if (pending.kind === 'celtic') {
    await telegramSendMessage(chatId, 'Оплата прошла. Запускаю Кельтский крест — 10 карт и подробный разбор.');
    await runPaidCelticReading(chatId, session, pending.readingQuestion || session.reading.question);
    return true;
  }

  await telegramSendMessage(chatId, 'Оплата прошла. В пакет входят два расклада: один сейчас и ещё один — в подарок. Начинаем первый.');
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

    await telegramSendMessage(chatId, formatCelticCardMap(cards));
    await sleep(1500);

    const result = await interpretationPromise;
    await telegramSendMessage(chatId, result.interpretation);

    let followup = '';
    try {
      followup = await generateFollowupQuestion({
        userName,
        originalQuestion: question,
        cards,
        interpretation: result.interpretation
      });
      await telegramSendMessage(chatId, followup);
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
    session.paidReadingsRemaining = 0;
    session.paidPackageKind = 'celtic';
    session.readingOfferShown = false;
    session.pendingReadingQuestion = '';
    session.lastPaidReadingAt = Date.now();
    session.freeConversationUsed = FREE_CONVERSATION_LIMIT;
    session.freeCooldownUsed = false;
    session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
    session.pendingPayment = null;
    session.pendingLavaPayment = null;
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

    await telegramSendMessage(chatId, result.interpretation);

    let followup = '';
    try {
      followup = await generateFollowupQuestion({
        userName,
        originalQuestion: question,
        cards,
        interpretation: result.interpretation
      });
      await telegramSendMessage(chatId, followup);
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
    session.readingOfferShown = false;
    session.pendingReadingQuestion = '';
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

async function runFreeTestCelticReading(chatId, session) {
  if (!session?.reading) {
    throw new Error('Сначала нужен основной расклад.');
  }

  const question =
    session.pendingReadingQuestion ||
    session.reading.question ||
    'Посмотреть эту историю глубже';

  const snapshot = {
    reading: session.reading,
    history: Array.isArray(session.history) ? [...session.history] : [],
    freeConversationUsed: session.freeConversationUsed,
    paidConversationUsed: session.paidConversationUsed,
    paidReadingsRemaining: session.paidReadingsRemaining,
    paidReadingActive: session.paidReadingActive,
    paidPackageKind: session.paidPackageKind,
    paidContinuation: session.paidContinuation,
    pendingGiftReading: session.pendingGiftReading,
    readingOfferShown: session.readingOfferShown,
    pendingReadingQuestion: session.pendingReadingQuestion,
    pendingPayment: session.pendingPayment,
    pendingLavaPayment: session.pendingLavaPayment,
    freeCooldownUsed: session.freeCooldownUsed,
    freeCooldownAvailableAt: session.freeCooldownAvailableAt,
    lastPaidReadingAt: session.lastPaidReadingAt
  };

  try {
    await telegramSendMessage(
      chatId,
      '🧪 Кельтский крест — тест бесплатно. Сейчас Omen посмотрит всю эту же историю глубже, сохранив контекст твоего вопроса и предыдущего разговора.'
    );
    await runPaidCelticReading(chatId, session, question, { test: true });
  } finally {
    Object.assign(session, snapshot);
  }
}

async function handleTelegramUpdate(update) {
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
      if (callback.data === 'test:celtic:payment') {
        await runFreeTestCelticReading(chatId, session);
      } else if (callback.data === 'test:celtic') {
        // Backward compatibility for an older test button; no longer exposed in /start.
        await runFreeTestCelticReading(chatId, session);
      } else if (callback.data === 'pay:stars:reading') {
        await createPaymentInvoice(chatId, session, 'reading', 'STARS');
      } else if (callback.data === 'pay:stars:celtic') {
        await createPaymentInvoice(chatId, session, 'celtic', 'STARS');
      } else if (callback.data === 'pay:lava:reading:RUB:CARD') {
        await createPaymentInvoice(chatId, session, 'reading', 'RUB', 'CARD');
      } else if (callback.data === 'pay:lava:reading:RUB:SBP') {
        await createPaymentInvoice(chatId, session, 'reading', 'RUB', 'SBP');
      } else if (callback.data === 'pay:lava:celtic:RUB:CARD') {
        await createPaymentInvoice(chatId, session, 'celtic', 'RUB', 'CARD');
      } else if (callback.data === 'pay:lava:celtic:RUB:SBP') {
        await createPaymentInvoice(chatId, session, 'celtic', 'RUB', 'SBP');
      } else if (callback.data === 'pay:lava:reading:RUB') {
        await createPaymentInvoice(chatId, session, 'reading', 'RUB', 'CARD');
      } else if (callback.data === 'pay:lava:reading:USD') {
        await createPaymentInvoice(chatId, session, 'reading', 'USD');
      } else if (callback.data === 'pay:lava:celtic:USD') {
        await createPaymentInvoice(chatId, session, 'celtic', 'USD');
      } else if (callback.data === 'gift:reading') {
        if (session?.pendingGiftReading && session?.paidReadingsRemaining > 0) {
          session.pendingGiftReading = false;
          session.pendingReadingQuestion = '';
          await telegramSendMessage(chatId, 'Тогда используем твой подарок. Посмотрим следующий слой этой истории.');
          await runPaidThreeCardReading(chatId, session, session.reading?.question || 'Посмотреть следующий слой этой истории');
        }
      } else if (callback.data === 'pay:reading' || callback.data === 'pay:celtic') {
        const kind = callback.data === 'pay:celtic' ? 'celtic' : 'reading';
        await createPaymentInvoice(chatId, session, kind, 'STARS');
      }
    } catch (err) {
      console.error('[tarot-omen] Payment button handling failed:', err);
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
        paidReadingActive: false,
        paidPackageKind: 'reading',
        pendingGiftReading: false,
        paidContinuation: false,
        readingOfferShown: false,
        pendingReadingQuestion: '',
        pendingPayment: null,
        pendingLavaPayment: null,
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

  // If Omen has already offered a specific next spread and the user confirms
  // in plain text (for example, "Хочу", "Давай", "Да"), go straight to
  // the payment invoice instead of spending another Gemini request on chat.
  const affirmative = /^(да|давай|хочу|конечно|погнали|согласен|согласна|сделаем|смотреть|посмотрим|давай посмотрим|хочу посмотреть|использовать|используем|бери подарок|давай подарок|yes|sure|ok|okay)$/i.test(text);
  if (session?.pendingGiftReading && session?.paidReadingsRemaining > 0 && affirmative) {
    session.pendingGiftReading = false;
    session.pendingReadingQuestion = '';
    await telegramSendMessage(chatId, 'Тогда используем твой подарок. Посмотрим следующий слой этой истории.');
    await runPaidThreeCardReading(chatId, session, session.reading?.question || 'Посмотреть следующий слой этой истории');
    return;
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
  // After the initial three-message conversation window is exhausted, the next
  // free entitlement arrives only after 72 hours. That entitlement is a NEW
  // three-card continuation reading, while keeping the same story/history.
  if (session?.reading &&
      session.freeConversationUsed >= FREE_CONVERSATION_LIMIT &&
      Number(session.paidReadingsRemaining || 0) === 0 &&
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
      await telegramSendMessage(chatId, result.interpretation);

      try {
        const followup = await generateFollowupQuestion({
          userName,
          originalQuestion: continuationQuestion,
          cards,
          interpretation: result.interpretation
        });
        await telegramSendMessage(chatId, followup);
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
      session.freeCooldownUsed = false;
      session.freeCooldownAvailableAt = 0;
      return;
    } catch (err) {
      console.error('[tarot-omen] Free 72-hour continuation reading failed:', err);
      await telegramSendMessage(chatId, 'Не удалось получить продолжение расклада. Попробуй ещё раз.');
      return;
    }
  }

  // ===== HARD GATE AFTER FREE CONVERSATION WINDOW =====
  // Once the three free conversation replies are used, NOTHING goes to Gemini
  // until the user either starts a paid continuation or reaches the 72-hour
  // entitlement above. This prevents the bot from turning into an unlimited chat.
  if (session?.reading &&
      session.freeConversationUsed >= FREE_CONVERSATION_LIMIT &&
      Number(session.paidReadingsRemaining || 0) === 0 &&
      !session.pendingGiftReading) {
    // This gate must remain active even after /start or a deleted Telegram chat:
    // the server-side session is intentionally preserved during the test run.
    // Every blocked user message gets one clear choice: pay now or wait 72h.
    const offerQuestion = session.pendingReadingQuestion || 'Посмотреть следующий слой этой истории отдельным раскладом';
    await offerPaidContinuation(chatId, session, offerQuestion);
    return;
  }

  // ===== PAID CONVERSATION AFTER A PAID READING =====
  if (session?.reading && session.paidContinuation === true && session.paidConversationUsed < PAID_CONVERSATION_LIMIT) {
    try {
      const result = await generateConversationResponse({
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

      session.paidConversationUsed += 1;
      if (result.readingOffer && result.readingQuestion) {
        session.pendingReadingQuestion = result.readingQuestion;
      }

      session.history.push({ role: 'user', text });
      session.history.push({ role: 'omen', text: result.reply });
      session.history.push({ role: 'omen', text: result.nextMessage });
      session.history = session.history.slice(-24);

      await telegramSendMessage(chatId, result.reply);
      await telegramSendMessage(chatId, result.nextMessage);

      if (session.paidConversationUsed >= PAID_CONVERSATION_LIMIT) {
        session.paidReadingActive = false;
        session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
        if (Number(session.paidReadingsRemaining || 0) > 0) {
          await offerGiftReading(chatId, session);
        } else {
          session.readingOfferShown = false;
          await offerPaidContinuation(
            chatId,
            session,
            session.pendingReadingQuestion || 'Посмотреть следующий слой этой истории отдельным раскладом'
          );
        }
      }
      return;
    } catch (err) {
      console.error('[tarot-omen] Paid conversation error:', err);
      await telegramSendMessage(chatId, 'Не смог сейчас продолжить мысль. Попробуй ещё раз.');
      return;
    }
  }

  // ===== FREE CONVERSATION AFTER A COMPLETED READING =====
  if (session?.reading && session.freeConversationUsed < FREE_CONVERSATION_LIMIT) {
    try {
      const result = await generateConversationResponse({
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

      session.freeConversationUsed += 1;
      if (result.readingOffer && result.readingQuestion) {
        // Remember the emerging new layer, but DO NOT show a payment wall yet.
        // The user must first receive the full short free conversation.
        session.pendingReadingQuestion = result.readingQuestion;
      }

      session.history.push({ role: 'user', text });
      session.history.push({ role: 'omen', text: result.reply });
      session.history.push({ role: 'omen', text: result.nextMessage });
      session.history = session.history.slice(-24);

      await telegramSendMessage(chatId, result.reply);

      if (session.freeConversationUsed >= FREE_CONVERSATION_LIMIT) {
        session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
        const offerQuestion = session.pendingReadingQuestion || 'Посмотреть следующий слой этой истории отдельным раскладом';
        await offerPaidContinuation(chatId, session, offerQuestion);
      } else {
        await telegramSendMessage(chatId, result.nextMessage);
      }
      return;
    } catch (err) {
      console.error('[tarot-omen] Telegram conversation error:', err);
      await telegramSendMessage(chatId, 'Не смог сейчас продолжить мысль. Попробуй ещё раз.');
      return;
    }
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

    await telegramSendMessage(chatId, result.interpretation);

    // Every completed spread gets a separate, context-aware question that invites
    // the user to continue the conversation. It is text-only and never goes to ElevenLabs.
    try {
      const followup = await generateFollowupQuestion({
        userName,
        originalQuestion: text,
        cards,
        interpretation: result.interpretation
      });
      await telegramSendMessage(chatId, followup);
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
      paidReadingActive: false,
      paidPackageKind: 'reading',
      pendingGiftReading: false,
      paidContinuation: PAID_CONTINUATION_DEFAULT,
      readingOfferShown: false,
      pendingReadingQuestion: '',
      pendingPayment: null,
      freeReadingUsed: true,
      freeCooldownUsed: false,
      freeCooldownAvailableAt: 0
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

app.post('/lava-webhook', (req, res) => {
  const providedKey = String(req.get('X-Api-Key') || '');
  if (!LAVA_WEBHOOK_API_KEY || providedKey !== LAVA_WEBHOOK_API_KEY) {
    return res.sendStatus(401);
  }

  // Acknowledge quickly. LAVA retries non-2xx responses, so all processing is
  // intentionally performed after the 200 response.
  res.sendStatus(200);

  handleLavaWebhook(req.body).catch((err) => {
    console.error('[tarot-omen] LAVA webhook handler error:', err);
  });
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
