import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
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
const SUPPORT_CHAT_ID = String(process.env.SUPPORT_CHAT_ID || '').trim();
const SUPPORT_OPERATOR_USERNAMES = String(process.env.SUPPORT_OPERATOR_USERNAMES || 'flash_royalevich').split(',').map(v => v.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);

if (!GEMINI_API_KEY) {
  console.warn('[tarot-omen] WARNING: GEMINI_API_KEY is not set.');
}
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[tarot-omen] WARNING: TELEGRAM_BOT_TOKEN is not set. Telegram bot will not run.');
}
if (!TRIBUTE_API_KEY) {
  console.warn('[tarot-omen] WARNING: TRIBUTE_API_KEY is not set. Tribute payments will be unavailable.');
}
if (!SUPPORT_CHAT_ID) {
  console.warn('[tarot-omen] WARNING: SUPPORT_CHAT_ID is not set. Support requests will not be forwarded to the support forum.');
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

// Determine the user's grammatical gender only when the Telegram first name
// gives us a reasonably clear signal. Pseudonyms/ambiguous names stay neutral.
const FEMALE_FIRST_NAMES = new Set([
  'анна','алла','алёна','алена','александра','алина','альбина','амина','анастасия','ангелина','арина',
  'валентина','валерия','варвара','вера','вероника','виктория','галина','дарья','диана','евгения','екатерина',
  'елена','елизавета','жанна','зоя','инна','ирина','карина','каролина','кира','кристина','ксения','лариса',
  'лидия','лилия','любовь','людмила','маргарита','марина','мария','марта','милана','мирослава','надежда',
  'наталья','нина','ольга','оксана','полина','раиса','регина','светлана','софия','софья','таисия','тамара',
  'татьяна','ульяна','юлия','юлия','яна','элина','эмма','диана','мелания','алиcа','алиса'
]);
const MALE_FIRST_NAMES = new Set([
  'александр','алексей','альберт','амир','андрей','антон','аркадий','арсений','артём','артем','артур','богдан',
  'борис','вадим','валентин','валерий','василий','виктор','виталий','влад','владимир','владислав','вячеслав',
  'геннадий','георгий','глеб','григорий','даниил','данил','денис','дмитрий','евгений','егор','илья','иван',
  'игорь','кирилл','константин','леонид','максим','марк','матвей','михаил','никита','николай','олег','павел',
  'пётр','петр','платон','роман','руслан','сергей','семён','семен','станислав','степан','тимофей','тимур',
  'фёдор','федор','юрий','ярослав','арсен','эмиль','эдуард','эрнест','эрнест','александр'
]);

function normalizeFirstName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я-]/gi, '');
}

function inferUserGender(firstName) {
  const normalized = normalizeFirstName(firstName);
  if (!normalized) return 'unknown';
  if (FEMALE_FIRST_NAMES.has(normalized)) return 'female';
  if (MALE_FIRST_NAMES.has(normalized)) return 'male';
  return 'unknown';
}

function userGenderGuidance(firstName) {
  const gender = inferUserGender(firstName);
  if (gender === 'female') {
    return 'По доступному имени пользователя род явно женский. Обращайся к пользователю в женском грамматическом роде, когда это естественно.';
  }
  if (gender === 'male') {
    return 'По доступному имени пользователя род явно мужской. Обращайся к пользователю в мужском грамматическом роде, когда это естественно.';
  }
  return 'РЕЖИМ ОБРАЩЕНИЯ: НЕЙТРАЛЬНЫЙ. Род пользователя НЕ определён и НЕ должен угадываться по имени, контексту или содержанию разговора. Категорически избегай форм мужского и женского рода по отношению к пользователю, если предложение можно перестроить: например, «тебе пришлось», «ты сейчас в ситуации», «у тебя появилось ощущение». Не используй «ты сделал/сделала», «ты понял/поняла», «ты оказался/оказалась», «ты сам/сама», «тебе привычен/привычна» и подобные пары. Если грамматически без рода абсолютно невозможно обойтись, используй мужской род как запасной вариант. Это правило касается ТОЛЬКО пользователя; Омен всегда говорит о себе в женском роде.';
}


const ADMIN_TEST_USERNAME = 'flash_royalevich';

function isAdminTestUser(telegramUser) {
  const username = String(telegramUser?.username || '').trim().replace(/^@/, '').toLowerCase();
  return username === ADMIN_TEST_USERNAME;
}

function ensureAdminTestEntitlement(session) {
  if (!session || hasPaidEntitlements(session)) return;
  activatePaidPackage(session, 'reading');
}

function capText(text, maxLen) {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
  const cut = lastBreak > maxLen * 0.6 ? lastBreak + 1 : maxLen;
  return text.slice(0, cut).trim() + '…';
}


const SYSTEM_PROMPT = `You are the reading voice of Tarot Omen, a Tarot mini app.

Speak naturally to one person. Omen is a woman and always speaks about herself in the feminine grammatical gender in Russian and other languages where grammatical gender applies. Use feminine first-person forms when referring to Omen herself (for example: «я заметила», «я почувствовала», «я бы сказала», «я подумала»). Never use masculine forms for Omen. The user's grammatical gender is supplied separately in the user message as an explicit instruction. Treat it as authoritative. If it says female, feminine forms for the user are allowed; if it says male, masculine forms are allowed. If it says neutral/unknown, do NOT choose a gender from context or from the name yourself: rewrite sentences to avoid gendered forms, and use masculine only when a gendered form is absolutely unavoidable. This user-gender rule is completely separate from Omen's own feminine gender.

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
- Length: about 4 short paragraphs for three cards. For the Celtic Cross, write a substantially deeper reading: about 10-12 substantial paragraphs, usually 5000-6500 characters, with enough detail to justify the deeper 10-card format.
- For the Celtic Cross, explicitly explain and connect ALL 10 positions to the user's question. Give meaningful attention to every card, explain what that card shows specifically in its position and orientation, then connect it with the other cards. Do not compress several positions into one sentence and do not treat the 10 cards as a generic list of meanings.
- The Celtic Cross is sold as a deeper investigation of the question, so its interpretation must feel materially deeper than a three-card reading: examine the underlying cause, past influences, conscious aim, near future, the user's inner position, external factors, hopes/fears and the outcome, and then provide an integrated synthesis of the whole spread. Do not pad with repetition just to reach the length; add depth by making concrete connections between positions and cards.
- Keep the interpretation flowing and personal rather than turning it into a dry catalogue.
- Whenever you mention a card by name, use its exact card name as provided in the spread data, without changing its wording or case.

Return ONLY valid JSON with exactly one string field:
{"interpretation":"..."}`;

async function createGeminiThinkingStatus(chatId) {
  if (!chatId) return null;
  try {
    const messageIds = await telegramSendMessage(chatId, '🤔 думаю…', true);
    return messageIds?.[0] || null;
  } catch (err) {
    console.warn('[tarot-omen] Could not send Gemini thinking status:', err?.message || err);
    return null;
  }
}

async function updateGeminiThinkingStatus(chatId, messageId, text) {
  if (!chatId || !messageId) return;
  try {
    await telegramEditMessageTextWithRetry(chatId, messageId, text, [], 3);
  } catch (err) {
    console.warn('[tarot-omen] Could not update Gemini thinking status:', err?.message || err);
  }
}

async function removeGeminiThinkingStatus(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await telegramDeleteMessage(chatId, messageId);
  } catch (err) {
    console.warn('[tarot-omen] Could not remove Gemini thinking status:', err?.message || err);
  }
}

async function generateInterpretation(question, cards, userName = '', spreadType = 'three', conversationContext = '', chatId = null) {
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
  const userMessage = `Telegram first name: ${userName || '(not available)'}\nUser gender guidance: ${userGenderGuidance(userName)}\nUse the Telegram name only when natural.\n\nSpread type: ${spreadLabel}\n\nUser's question:\n"${question.trim()}"${contextBlock}\n\nDrawn spread:\n\n${cardBlock}`;

  let response;
  let raw;
  let thinkingMessageId = null;
  let attempt = 1;
  let thinkingShown = false;

  // Show an explicit status immediately. Gemini can legitimately take a long
  // time to recover from transient load; the user must not be left wondering
  // whether the paid spread was actually started.
  if (chatId) {
    thinkingMessageId = await createGeminiThinkingStatus(chatId);
    thinkingShown = Boolean(thinkingMessageId);
  }

  while (true) {
    if (attempt === 3 && thinkingMessageId) {
      await updateGeminiThinkingStatus(chatId, thinkingMessageId, '🤔 мне нужно еще немного подумать…');
    }
    if (attempt === 6 && thinkingMessageId) {
      await updateGeminiThinkingStatus(chatId, thinkingMessageId, '🤔 Я все еще думаю над ответом 😏');
    }

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

      const transient = [429, 500, 502, 503, 504].includes(response.status);
      if (response.ok) {
        let validationData;
        let validationGenerated;
        let validationOk = true;
        try {
          validationData = JSON.parse(raw);
          validationGenerated = validationData?.candidates?.[0]?.content?.parts
            ?.filter((part) => typeof part.text === 'string')
            .map((part) => part.text)
            .join('')
            .trim();
          if (!validationGenerated) validationOk = false;
          else {
            try {
              JSON.parse(validationGenerated);
            } catch {
              const cleanedValidation = validationGenerated
                .replace(/^```json\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/\s*```$/i, '')
                .trim();
              JSON.parse(cleanedValidation);
            }
          }
        } catch {
          validationOk = false;
        }

        if (validationOk) break;

        if (!thinkingShown) {
          thinkingMessageId = await createGeminiThinkingStatus(chatId);
          thinkingShown = Boolean(thinkingMessageId);
        }
        const delay = Math.min(1800 * Math.pow(2, Math.min(attempt - 1, 5)), 60000);
        console.warn(`[tarot-omen] Gemini interpretation attempt ${attempt} returned unusable output; retrying in ${Math.round(delay / 1000)}s.`);
        attempt += 1;
        await sleep(delay);
        continue;
      }
      if (!transient) {
        if (thinkingMessageId) await removeGeminiThinkingStatus(chatId, thinkingMessageId);
        break;
      }

      if (!thinkingShown) {
        thinkingMessageId = await createGeminiThinkingStatus(chatId);
        thinkingShown = Boolean(thinkingMessageId);
      }

      const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
      const delay = retryAfter > 0
        ? Math.min(retryAfter * 1000, 60000)
        : Math.min(1800 * Math.pow(2, Math.min(attempt - 1, 5)), 60000);
      console.warn(`[tarot-omen] Gemini interpretation attempt ${attempt} failed (transient ${response.status}); retrying in ${Math.round(delay / 1000)}s.`);
      attempt += 1;
      await sleep(delay);
    } catch (err) {
      const transientError = err?.name === 'AbortError' || /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|high demand|temporar/i.test(err?.message || '');
      if (!transientError) {
        if (thinkingMessageId) await removeGeminiThinkingStatus(chatId, thinkingMessageId);
        throw err;
      }

      if (!thinkingShown) {
        thinkingMessageId = await createGeminiThinkingStatus(chatId);
        thinkingShown = Boolean(thinkingMessageId);
      }

      const delay = Math.min(1800 * Math.pow(2, Math.min(attempt - 1, 5)), 60000);
      console.warn(`[tarot-omen] Gemini interpretation attempt ${attempt} failed (transient); retrying in ${Math.round(delay / 1000)}s:`, err?.message || err);
      attempt += 1;
      await sleep(delay);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (thinkingMessageId) await removeGeminiThinkingStatus(chatId, thinkingMessageId);

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

Omen is a woman and, when referring to herself, always uses feminine grammatical forms.
User gender guidance: ${userGenderGuidance(userName)}
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

    const result = await generateInterpretation(question, body.cards, '', 'three', '', null);
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
    '🃏 Как карты читаются в этом Кельтском кресте:',
    '',
    ...cards.map((card, index) => {
      const orientation = card.orientation === 'reversed' ? 'перевёрнутая' : 'прямая';
      const position = CELTIC_POSITIONS[index] || { name: card.position, meaning: card.positionMeaning || '' };
      return `${index + 1}. ${position.name} — ${card.name} (${orientation})\nВ этой позиции карта показывает: ${position.meaning}`;
    })
  ].join('\n\n');
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
const freeReadingNotificationTimers = new Map();
const FREE_READING_NOTIFICATION_TEXT = 'Прошло 72 часа - вам доступен бесплатный расклад «3карты»';
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

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('reading', 'celtic')),
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      target_chat_id TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    )
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      code TEXT NOT NULL REFERENCES promo_codes(code) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (code, chat_id)
    )
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS support_threads (
      support_chat_id TEXT NOT NULL,
      thread_id BIGINT NOT NULL,
      user_chat_id TEXT NOT NULL UNIQUE,
      user_name TEXT,
      username TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (support_chat_id, thread_id)
    )
  `);

  const result = await dbPool.query('SELECT chat_id, session FROM telegram_sessions');

  for (const row of result.rows) {
    try {
      const session = row.session && typeof row.session === 'object'
        ? row.session
        : JSON.parse(row.session);
      session.newTopicInfoPromise = null;
      ensureWorkflowFields(session);
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
  if (!chatId || !session) return false;

  scheduleFreeReadingNotification(chatId, session);

  if (!dbReady || !dbPool) return true;

  try {
    await dbPool.query(
      `INSERT INTO telegram_sessions (chat_id, session, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (chat_id)
       DO UPDATE SET session = EXCLUDED.session, updated_at = NOW()`,
      [String(chatId), JSON.stringify(serializableSession(session))]
    );
    return true;
  } catch (err) {
    console.error('[tarot-omen] Failed to save session:', chatId, err);
    return false;
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
    ensureWorkflowFields(session);
    sessions.set(chatId, session);
    return session;
  } catch (err) {
    console.error('[tarot-omen] Failed to load session:', chatId, err);
    return sessions.get(chatId) || null;
  }
}


function clearFreeReadingNotificationTimer(chatId) {
  const entry = freeReadingNotificationTimers.get(chatId);
  if (entry?.timer) clearTimeout(entry.timer);
  freeReadingNotificationTimers.delete(chatId);
}

function resetFreeReadingCycle(chatId, session) {
  if (!session) return;
  session.freeReadingAvailable = false;
  session.freeCooldownAvailableAt = 0;
  session.freeCooldownNotificationSentAt = 0;

  if (chatId) {
    clearFreeReadingNotificationTimer(chatId);
    return;
  }

  // Package activation does not always pass chatId. Clear a timer that belongs
  // to this exact session so a previously scheduled free notification cannot fire.
  for (const [timerChatId, entry] of freeReadingNotificationTimers.entries()) {
    if (sessions.get(timerChatId) === session) {
      if (entry?.timer) clearTimeout(entry.timer);
      freeReadingNotificationTimers.delete(timerChatId);
    }
  }
}

function armFreeReadingCooldown(chatId, session) {
  if (!session) return;

  // A free 72-hour cycle only starts when there are no paid entitlements left.
  // Paid readings therefore suppress and reset any pending free cycle.
  if (hasPaidEntitlements(session)) {
    resetFreeReadingCycle(chatId, session);
    return;
  }

  session.freeReadingAvailable = false;
  session.freeCooldownAvailableAt = Date.now() + FREE_COOLDOWN_MS;
  session.freeCooldownNotificationSentAt = 0;
  scheduleFreeReadingNotification(chatId, session);
}

function isFreeReadingAvailable(chatId, session) {
  if (!session || hasPaidEntitlements(session)) {
    if (session && hasPaidEntitlements(session)) resetFreeReadingCycle(chatId, session);
    return false;
  }

  if (session.freeReadingAvailable === true) return true;

  const availableAt = Number(session.freeCooldownAvailableAt || 0);
  return !!availableAt && Date.now() >= availableAt;
}

function scheduleFreeReadingNotification(chatId, session = sessions.get(chatId)) {
  if (!chatId) return;

  if (!session?.reading || hasPaidEntitlements(session)) {
    clearFreeReadingNotificationTimer(chatId);
    return;
  }

  const availableAt = Number(session?.freeCooldownAvailableAt || 0);
  if (!availableAt || session.freeReadingAvailable === true) {
    clearFreeReadingNotificationTimer(chatId);
    return;
  }

  // Do not recreate the same timer on every Telegram update/session save.
  const existing = freeReadingNotificationTimers.get(chatId);
  if (existing?.availableAt === availableAt) return;

  clearFreeReadingNotificationTimer(chatId);

  // This cooldown has already been notified.
  if (Number(session.freeCooldownNotificationSentAt || 0) === availableAt) return;

  const delay = Math.max(0, availableAt - Date.now());
  const timer = setTimeout(async () => {
    freeReadingNotificationTimers.delete(chatId);

    const currentSession = sessions.get(chatId);
    const currentAvailableAt = Number(currentSession?.freeCooldownAvailableAt || 0);

    // The cooldown may have been reset by a purchase/new reading while this timer was waiting.
    if (!currentSession?.reading || hasPaidEntitlements(currentSession) ||
        currentAvailableAt !== availableAt || Date.now() < currentAvailableAt) {
      if (currentSession) scheduleFreeReadingNotification(chatId, currentSession);
      return;
    }

    if (currentSession.freeReadingAvailable === true ||
        Number(currentSession.freeCooldownNotificationSentAt || 0) === currentAvailableAt) return;

    try {
      await telegramSendMessageWithRetry(chatId, FREE_READING_NOTIFICATION_TEXT, 3);
      currentSession.freeReadingAvailable = true;
      currentSession.freeCooldownNotificationSentAt = currentAvailableAt;
      await saveSession(chatId, currentSession);
      console.log(`[tarot-omen] Sent 72-hour free-reading notification to ${chatId}.`);
    } catch (err) {
      console.error('[tarot-omen] Failed to send 72-hour free-reading notification:', chatId, err);
      // Retry later if Telegram was temporarily unavailable. Do not mark the
      // notification as sent until Telegram confirms delivery.
      const retrySession = sessions.get(chatId);
      if (retrySession && Number(retrySession.freeCooldownAvailableAt || 0) === availableAt &&
          !hasPaidEntitlements(retrySession) && retrySession.freeReadingAvailable !== true) {
        const retryTimer = setTimeout(() => {
          scheduleFreeReadingNotification(chatId, retrySession);
        }, 15 * 60 * 1000);
        freeReadingNotificationTimers.set(chatId, { timer: retryTimer, availableAt });
      }
    }
  }, delay);

  freeReadingNotificationTimers.set(chatId, { timer, availableAt });
}

function scheduleAllFreeReadingNotifications() {
  for (const [chatId, session] of sessions.entries()) {
    scheduleFreeReadingNotification(chatId, session);
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
const supportReplyTargets = new Map();

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
- Omen is a woman. Always speak about yourself in the feminine grammatical gender in Russian and other languages where grammatical gender applies. For example: «я заметила», «я почувствовала», «я бы сказала», «я подумала». Never use masculine forms when referring to Omen herself.
- Use the supplied user gender guidance as authoritative. If it says female, address the user in feminine grammatical forms when natural; if male, use masculine forms. If it says neutral/unknown, do not infer a gender from context, name, topic or wording; avoid gendered forms, with masculine only as an unavoidable fallback. This is independent of Omen's feminine self-reference.
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

async function generateConversationResponse({ userName, originalQuestion, cards, interpretation, history, latestMessage, conversationUsed = 0, conversationLimit = FREE_CONVERSATION_LIMIT, spreadType = 'three', chatId = null }) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured on the server.');

  const cardBlock = cards.map((c, i) =>
    `Card ${i + 1} — ${c.position}\nName: ${c.name}\nOrientation: ${c.orientation}\nKeywords: ${c.keywords}`
  ).join('\n\n');
  const spreadLabel = spreadType === 'celtic' ? 'Celtic Cross (10 cards)' : 'three-card reading (3 cards)';

  const historyBlock = history.length
    ? history.map((item) => `${item.role === 'user' ? 'User' : 'Omen'}: ${item.text}`).join('\n')
    : '(no previous conversation messages)';

  const remainingMessages = Math.max(0, conversationLimit - conversationUsed);
  const userMessage = `Telegram first name: ${userName || '(not available)'}\nUser gender guidance: ${userGenderGuidance(userName)}\n\nSpread type: ${spreadLabel}\n\nOriginal question:\n"${originalQuestion}"\n\nCards from the completed reading:\n${cardBlock}\n\nOriginal interpretation:\n${interpretation}\n\nConversation so far:\n${historyBlock}\n\nLatest user message:\n"${latestMessage}"\n\nConversation allowance: this reply is message ${conversationUsed + 1} of ${conversationLimit}; ${remainingMessages} message(s) remain before the current free conversation window ends. Do not mention this allowance to the user. If a genuinely new layer/question has emerged, prefer setting reading_offer=true so the next spread can become the natural continuation. If no new layer has emerged, do not invent one just to sell a spread.`;

  let lastError;
  let response = null;
  let thinkingMessageId = null;
  let attempt = 1;
  let thinkingShown = false;

  while (true) {
    if (attempt === 3 && thinkingMessageId) {
      await updateGeminiThinkingStatus(chatId, thinkingMessageId, '🤔 мне нужно еще немного подумать…');
    }
    if (attempt === 6 && thinkingMessageId) {
      await updateGeminiThinkingStatus(chatId, thinkingMessageId, '🤔 Я все еще думаю над ответом 😏');
    }

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
        const transientStatus = [429, 500, 502, 503, 504].includes(response.status);
        if (!transientStatus) throw new Error(data?.error?.message || `Gemini API HTTP ${response.status}`);

        if (!thinkingShown) {
          thinkingMessageId = await createGeminiThinkingStatus(chatId);
          thinkingShown = Boolean(thinkingMessageId);
        }
        const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
        const delay = retryAfter > 0
          ? Math.min(retryAfter * 1000, 60000)
          : Math.min(1800 * Math.pow(2, Math.min(attempt - 1, 5)), 60000);
        console.warn(`[tarot-omen] Conversation attempt ${attempt} failed (transient Gemini load, HTTP ${response.status}); retrying in ${Math.round(delay / 1000)}s.`);
        attempt += 1;
        await sleep(delay);
        continue;
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
        const cleaned = generated.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
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

      if (thinkingMessageId) await removeGeminiThinkingStatus(chatId, thinkingMessageId);
      return { reply, nextMessage, nextMessageType, readingOffer, readingQuestion };
    } catch (err) {
      lastError = err?.name === 'AbortError'
        ? new Error('Gemini conversation request timed out after 60 seconds.')
        : err;
      const transient = /high demand|429|503|502|500|504|temporar|timed out|fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(lastError?.message || '');
      console.error(`[tarot-omen] Conversation attempt ${attempt} failed${transient ? ' (transient Gemini load)' : ''}:`, lastError);
      if (!transient) {
        if (thinkingMessageId) await removeGeminiThinkingStatus(chatId, thinkingMessageId);
        throw lastError;
      }

      if (!thinkingShown) {
        thinkingMessageId = await createGeminiThinkingStatus(chatId);
        thinkingShown = Boolean(thinkingMessageId);
      }
      const delay = Math.min(1800 * Math.pow(2, Math.min(attempt - 1, 5)), 60000);
      attempt += 1;
      await sleep(delay);
    } finally {
      clearTimeout(timeout);
    }
  }
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

async function telegramSendForceReply(chatId, text) {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { force_reply: true, input_field_placeholder: 'Напиши сообщение' }
    })
  });
  if (!response.ok) throw new Error(`Telegram sendMessage with force reply failed: ${await response.text()}`);
  const data = await response.json();
  return data?.result || null;
}

function isSupportOperator(user) {
  const username = String(user?.username || '').replace(/^@/, '').toLowerCase();
  return SUPPORT_OPERATOR_USERNAMES.includes(username);
}

async function telegramCreateForumTopic(chatId, name) {
  const response = await fetch(`${TELEGRAM_API}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, name: String(name || 'Поддержка').slice(0, 128) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok || !data?.result?.message_thread_id) {
    throw new Error(data?.description || `Telegram createForumTopic failed (HTTP ${response.status}).`);
  }
  return data.result.message_thread_id;
}

async function telegramSendMessageInThread(chatId, threadId, text, buttons = []) {
  const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_thread_id: Number(threadId),
      text: String(text),
      ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {})
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram thread message failed (HTTP ${response.status}).`);
  }
  return data.result;
}

async function getOrCreateSupportThread(chatId, session) {
  if (!SUPPORT_CHAT_ID) return null;
  if (!dbReady || !dbPool) throw new Error('Support forum requires PostgreSQL.');

  const existing = await dbPool.query(
    `SELECT support_chat_id, thread_id, status FROM support_threads WHERE user_chat_id = $1`,
    [String(chatId)]
  );
  if (existing.rowCount && existing.rows[0].status === 'open') return Number(existing.rows[0].thread_id);

  const username = session?.telegramUsername ? `@${session.telegramUsername.replace(/^@/, '')}` : 'без username';
  const name = session?.userName || 'без имени';
  const topicName = `👤 ${String(session?.telegramUsername || session?.userName || chatId).replace(/^@/, '').slice(0, 110)}`;
  const threadId = await telegramCreateForumTopic(SUPPORT_CHAT_ID, topicName);

  await dbPool.query(
    `INSERT INTO support_threads (support_chat_id, thread_id, user_chat_id, user_name, username, status)\n     VALUES ($1, $2, $3, $4, $5, 'open')\n     ON CONFLICT (user_chat_id) DO UPDATE SET support_chat_id = EXCLUDED.support_chat_id, thread_id = EXCLUDED.thread_id, user_name = EXCLUDED.user_name, username = EXCLUDED.username, status = 'open', updated_at = NOW()`,
    [String(SUPPORT_CHAT_ID), Number(threadId), String(chatId), name, username]
  );

  await telegramSendMessageInThread(
    SUPPORT_CHAT_ID,
    threadId,
    [
      '🛟 НОВОЕ ОБРАЩЕНИЕ',
      '',
      `Пользователь: ${name}`,
      `Username: ${username}`,
      `Chat ID: ${chatId}`,
      '',
      'История обращения находится в этом топике.'
    ].join('\n'),
    [
      [{ text: '💬 Ответить', callback_data: `support:reply:${chatId}` }],
      [{ text: '🎟 Кельтский + 2 обычных', callback_data: `support:recovery:celtic:${chatId}` }],
      [{ text: '🎟 5 обычных', callback_data: `support:recovery:reading:${chatId}` }],
      [{ text: '✅ Закрыть обращение', callback_data: `support:close:${chatId}` }]
    ]
  );
  return Number(threadId);
}

async function sendSupportRequest(chatId, session, text) {
  if (!SUPPORT_CHAT_ID) {
    await telegramSendMessage(chatId, 'Техподдержка пока не подключена. Если тебе нужен восстановительный промокод, сообщи об этом администратору бота.');
    return false;
  }

  const threadId = await getOrCreateSupportThread(chatId, session);
  await telegramSendMessageInThread(SUPPORT_CHAT_ID, threadId, `👤 Пользователь:\n\n${text}`);
  if (dbReady && dbPool) await dbPool.query(`UPDATE support_threads SET status = 'open', updated_at = NOW() WHERE user_chat_id = $1`, [String(chatId)]);
  await telegramSendMessage(chatId, 'Сообщение передано в техподдержку. Ответ оператора придёт сюда. Пока обращение открыто, можешь отправлять сюда дополнительные сообщения.');
  return true;
}

async function forwardSupportUserMessage(chatId, text) {
  if (!SUPPORT_CHAT_ID || !dbReady || !dbPool) return false;
  const result = await dbPool.query(`SELECT thread_id, status FROM support_threads WHERE user_chat_id = $1`, [String(chatId)]);
  if (!result.rowCount || result.rows[0].status !== 'open') return false;
  await telegramSendMessageInThread(SUPPORT_CHAT_ID, Number(result.rows[0].thread_id), `👤 Пользователь:\n\n${text}`);
  await dbPool.query(`UPDATE support_threads SET updated_at = NOW() WHERE user_chat_id = $1`, [String(chatId)]);
  return true;
}

async function handlePromoInput(chatId, session, text) {
  const result = await redeemPromoCode(chatId, text);
  if (!result.ok) {
    const messages = {
      database: 'Не удалось проверить промокод из-за технической ошибки. Попробуй ещё раз позже.',
      invalid: 'Такого промокода нет. Проверь код и отправь его ещё раз.',
      expired: 'Срок действия этого промокода закончился.',
      already_used: 'Этот промокод уже был использован.',
      exhausted: 'Этот промокод уже использован.',
      not_for_user: 'Этот промокод предназначен для другого пользователя.'
    };
    await telegramSendMessage(chatId, messages[result.reason] || 'Не удалось применить промокод.');
    return false;
  }

  const previousSessionState = JSON.stringify(serializableSession(session));
  activatePaidPackage(session, result.kind);
  session.pendingPromoEntry = false;
  session.pendingSupport = false;
  session.pendingPaidTopicChoice = false;
  session.pendingPaidReadingKind = '';
  session.pendingReadingQuestion = '';

  const persisted = await saveSession(chatId, session);
  if (!persisted) {
    sessions.set(chatId, JSON.parse(previousSessionState));
    try { await restorePromoRedemption(result.code, chatId); }
    catch (restoreErr) { console.error('[tarot-omen] Failed to restore promo after session save failure:', restoreErr); }
    await telegramSendMessage(chatId, 'Не удалось сохранить восстановление. Промокод не списан — попробуй ещё раз.');
    return false;
  }

  await telegramSendMessage(
    chatId,
    result.kind === 'celtic'
      ? 'Промокод применён. Восстановлено: 1 Кельтский крест и 2 обычных расклада в подарок.'
      : 'Промокод применён. Восстановлено: 5 обычных раскладов (3 + 2 в подарок).'
  );
  await offerAvailablePaidReadings(chatId, session);
  return true;
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
      freeReadingAvailable: false,
      freeCooldownAvailableAt: Date.now()
    };
    sessions.set(telegramUserId, session);
  }
  ensureWorkflowFields(session);

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

  await telegramSendMessage(
    telegramUserId,
    kind === 'celtic'
      ? 'Оплата прошла. У тебя 1 Кельтский крест и 2 обычных расклада в подарок.'
      : 'Оплата прошла. У тебя 5 обычных раскладов: 3 входят в пакет и ещё 2 — в подарок.'
  );
  await offerAvailablePaidReadings(telegramUserId, session);
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
    [{ text: `🔮 Кельтский крест — 10 карт — ${TRIBUTE_CELTIC_RUB} ₽`, callback_data: 'choose:celtic:payment' }],
    ...buildSupportButtons()
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
      ...buildSupportButtons(),
      [{ text: '⬅️ Вернуться к выбору расклада', callback_data: 'choose:celtic:back' }]
    ]
  );
}

async function offerCelticBackOptions(chatId, session, messageId) {
  const paidReadingAvailable = Number(session?.paidReadingsRemaining || 0) > 0;
  const paidCelticAvailable = Number(session?.paidCelticRemaining || 0) > 0;
  const freeAvailable = !!session?.reading &&
    Date.now() >= Number(session?.freeCooldownAvailableAt || 0);

  if (!paidReadingAvailable && !paidCelticAvailable && !freeAvailable) {
    await offerPaymentMethods(chatId, messageId);
    return;
  }

  const buttons = [];
  if (paidReadingAvailable || freeAvailable) {
    buttons.push([{
      text: '▶️ Продолжить обычные расклады',
      callback_data: 'continue:ordinary'
    }]);
  }
  if (paidReadingAvailable || paidCelticAvailable || freeAvailable) {
    buttons.push([{
      text: '🆕 Начать новый расклад',
      callback_data: 'new:topic'
    }]);
  }
  buttons.push(...buildSupportButtons());
  buttons.push([{
    text: '⬅️ Вернуться к выбору расклада',
    callback_data: 'choose:celtic:back:selection'
  }]);

  await telegramEditMessageTextWithRetry(
    chatId,
    messageId,
    'Хорошо. Ты вернулся назад. Что хочешь сделать?',
    buttons
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

async function offerCelticPurchase(chatId, messageId) {
  const text = [
    '🔮 Кельтский крест — более глубокое исследование твоего вопроса.',
    '',
    'После покупки ты получишь 1 Кельтский крест из 10 карт и ещё 2 обычных расклада «3 карты» в подарок.',
    '',
    'Все купленные расклады суммируются и не сгорают — уже имеющиеся останутся у тебя, а новые добавятся к ним.'
  ].join('\n');

  const buttons = [
    [{ text: `⭐ Telegram Stars — ${CELTIC_CROSS_STARS}`, callback_data: 'pay:stars:celtic' }],
    [{ text: `💳 Карта / СБП — ${TRIBUTE_CELTIC_RUB} ₽`, callback_data: 'pay:tribute:celtic' }],
    ...buildSupportButtons(),
    [{ text: '⬅️ Назад к доступным раскладам', callback_data: 'buy:celtic:back' }]
  ];

  if (messageId) {
    await telegramEditMessageTextWithRetry(chatId, messageId, text, buttons);
  } else {
    await telegramSendInlineKeyboardWithRetry(chatId, text, buttons);
  }
}

async function offerAvailablePaidReadings(chatId, session, messageId = null) {
  ensureWorkflowFields(session);
  const buttons = [];
  const ordinary = Number(session.paidReadingsRemaining || 0);
  const celtic = Number(session.paidCelticRemaining || 0);

  if (ordinary > 0) {
    buttons.push([{
      text: `🃏 Использовать обычный расклад — осталось ${ordinary}`,
      callback_data: 'select:paid:reading'
    }]);
  }
  if (celtic > 0) {
    buttons.push([{
      text: `🔮 Использовать Кельтский крест — осталось ${celtic}`,
      callback_data: 'select:paid:celtic'
    }]);
  }

  if (!buttons.length) return;

  buttons.push([{ text: '💳 Купить ещё расклады', callback_data: 'payment:open' }]);
  buttons.push(...buildSupportButtons());

  const text = `${buildEntitlementSummary(session)}\n\nВыбери, какой расклад использовать:`;
  session.pendingGiftReading = false;
  session.pendingPaidTopicChoice = false;
  session.readingOfferShown = false;

  if (messageId) await telegramEditMessageTextWithRetry(chatId, messageId, text, buttons);
  else await telegramSendInlineKeyboardWithRetry(chatId, text, buttons);
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
  session.pendingPaidTopicChoice = false;
  session.pendingPromoEntry = false;
  session.pendingSupport = false;
  session.paidConversationUsed = 0;
  session.newTopicInfoMessageId = 0;
  session.newTopicInfoText = '';
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

  await showNewTopicInfo(
    chatId,
    session,
    'Для новой темы можно приобрести новый расклад или, если не спешишь, подождать 72 часа после последнего использованного расклада. Тогда снова будет доступен бесплатный расклад.'
  );
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

function ensureWorkflowFields(session) {
  if (!session) return session;
  if (typeof session.pendingPromoEntry !== 'boolean') session.pendingPromoEntry = false;
  if (typeof session.pendingSupport !== 'boolean') session.pendingSupport = false;
  if (typeof session.supportActive !== 'boolean') session.supportActive = false;
  if (typeof session.pendingSupportReplyTarget !== 'string') session.pendingSupportReplyTarget = '';
  if (typeof session.pendingPaidTopicChoice !== 'boolean') session.pendingPaidTopicChoice = false;
  if (typeof session.pendingPaidReadingKind !== 'string') session.pendingPaidReadingKind = '';
  return session;
}

function promoKindLabel(kind) {
  return kind === 'celtic'
    ? '1 Кельтский крест + 2 обычных расклада в подарок'
    : '5 обычных раскладов (3 + 2 в подарок)';
}

function generatePromoCodeValue() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let raw = '';
  for (const byte of bytes) raw += alphabet[byte % alphabet.length];
  return `OMEN-${raw.slice(0, 5)}-${raw.slice(5)}`;
}

async function createPromoCode(kind = 'reading', targetChatId = null, createdBy = 'support') {
  if (!dbReady || !dbPool) throw new Error('Promo codes require PostgreSQL.');
  const safeKind = kind === 'celtic' ? 'celtic' : 'reading';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generatePromoCodeValue();
    try {
      await dbPool.query(
        `INSERT INTO promo_codes (code, kind, max_uses, target_chat_id, created_by) VALUES ($1, $2, 1, $3, $4)`,
        [code, safeKind, targetChatId ? String(targetChatId) : null, String(createdBy || 'support')]
      );
      return code;
    } catch (err) {
      if (err?.code === '23505') continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique promo code.');
}

async function redeemPromoCode(chatId, rawCode) {
  if (!dbReady || !dbPool) return { ok: false, reason: 'database' };
  const code = String(rawCode || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^OMEN-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code)) return { ok: false, reason: 'invalid' };

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT code, kind, max_uses, used_count, target_chat_id, expires_at
         FROM promo_codes
        WHERE code = $1
        FOR UPDATE`,
      [code]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }

    const promo = result.rows[0];
    if (promo.expires_at && new Date(promo.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'expired' };
    }
    if (Number(promo.used_count) >= Number(promo.max_uses)) {
      const already = await client.query(
        'SELECT 1 FROM promo_redemptions WHERE code = $1 AND chat_id = $2',
        [code, String(chatId)]
      );
      await client.query('ROLLBACK');
      return { ok: false, reason: already.rowCount ? 'already_used' : 'exhausted' };
    }
    if (promo.target_chat_id && String(promo.target_chat_id) !== String(chatId)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_for_user' };
    }

    const redemption = await client.query(
      `INSERT INTO promo_redemptions (code, chat_id) VALUES ($1, $2)
       ON CONFLICT (code, chat_id) DO NOTHING RETURNING code`,
      [code, String(chatId)]
    );
    if (!redemption.rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_used' };
    }

    const update = await client.query(
      `UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1 RETURNING kind`,
      [code]
    );
    await client.query('COMMIT');
    return { ok: true, code, kind: update.rows[0].kind };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function restorePromoRedemption(code, chatId) {
  if (!dbReady || !dbPool || !code || !chatId) return false;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
      'DELETE FROM promo_redemptions WHERE code = $1 AND chat_id = $2 RETURNING code',
      [String(code), String(chatId)]
    );
    if (!deleted.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      'UPDATE promo_codes SET used_count = GREATEST(0, used_count - 1) WHERE code = $1',
      [String(code)]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

function buildEntitlementSummary(session) {
  const ordinary = Number(session?.paidReadingsRemaining || 0);
  const celtic = Number(session?.paidCelticRemaining || 0);
  const lines = ['Твои оплаченные расклады сохранены и не сгорают.'];
  if (ordinary > 0) lines.push(`Обычных раскладов: ${ordinary}.`);
  if (celtic > 0) lines.push(`Кельтских крестов: ${celtic}.`);
  return lines.join('\n');
}

async function offerPaidTopicChoice(chatId, session, messageId = null) {
  const kind = session?.pendingPaidReadingKind === 'celtic' ? 'celtic' : 'reading';
  session.pendingPaidReadingKind = kind;
  session.pendingPaidTopicChoice = true;
  session.pendingGiftReading = true;
  session.pendingReadingQuestion = session.pendingReadingQuestion || session.reading?.question || '';
  const label = kind === 'celtic' ? 'Кельтский крест' : 'обычный расклад «3 карты»';
  const text = `Ты выбрал ${label}. Теперь выбери, как его использовать:`;
  const buttons = [
    [{ text: '🆕 Начать новый расклад', callback_data: 'paidtopic:new' }],
    [{ text: '▶️ Продолжить расклад на эту же тему', callback_data: 'paidtopic:continue' }]
  ];
  if (messageId) await telegramEditMessageTextWithRetry(chatId, messageId, text, buttons);
  else await telegramSendInlineKeyboardWithRetry(chatId, text, buttons);
}

function buildSupportButtons() {
  return [
    [{ text: '🎟 Ввести промокод', callback_data: 'promo:enter' }],
    [{ text: '🛟 Связаться с техподдержкой', callback_data: 'support:contact' }]
  ];
}

function hasPaidEntitlements(session) {
  return (
    Number(session?.paidReadingsRemaining || 0) > 0 ||
    Number(session?.paidCelticRemaining || 0) > 0
  );
}

function activatePaidPackage(session, kind = 'reading') {
  const safeKind = kind === 'celtic' ? 'celtic' : 'reading';

  // A package purchase does not mean the new reading is completed yet.
  // Keep paidContinuation disabled until runPaidThreeCardReading/runPaidCelticReading
  // successfully finish, otherwise a user message arriving during a long Gemini
  // retry can be answered against the previous reading.
  session.paidContinuation = false;
  session.paidReadingActive = false;
  session.paidPackageKind = safeKind;
  session.paidConversationUsed = 0;
  session.freeConversationUsed = FREE_CONVERSATION_LIMIT;
  session.freeCooldownUsed = false;
  session.readingOfferShown = false;
  session.pendingGiftReading = false;
  session.pendingPaidReadingKind = '';
  session.pendingPaidTopicChoice = false;

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

  resetFreeReadingCycle(null, session);
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

  await telegramSendMessage(
    chatId,
    pending.kind === 'celtic'
      ? 'Оплата прошла. У тебя 1 Кельтский крест и 2 обычных расклада в подарок.'
      : 'Оплата прошла. У тебя 5 обычных раскладов: 3 входят в пакет и ещё 2 — в подарок.'
  );
  await offerAvailablePaidReadings(chatId, session);
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
  const previousReading = session.reading || null;
  const historyBlock = Array.isArray(session.history) && session.history.length
    ? session.history.slice(-12).map((item) => `${item.role === 'user' ? 'User' : 'Omen'}: ${item.text}`).join('\n')
    : '';
  const contextParts = [];
  if (previousReading) {
    contextParts.push(`Previous ${previousReading.spreadType === 'celtic' ? 'Celtic Cross' : 'three-card'} question: ${previousReading.question}\nPrevious interpretation: ${previousReading.interpretation}`);
  }
  if (historyBlock) contextParts.push(`Conversation after the three-card reading:\n${historyBlock}`);
  const conversationContext = contextParts.join('\n\n');

  try {
    const mixingMessageIds = await telegramSendMessage(chatId, 'Мешаю карты...', true);
    const shuffleMessageId = await telegramSendShuffleGif(chatId);
    const interpretationPromise = generateInterpretation(question, cards, userName, 'celtic', conversationContext, chatId);
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
    session.paidContinuation = true;
    session.paidCelticRemaining = Math.max(0, Number(session.paidCelticRemaining || 0) - 1);
    session.paidPackageKind = hasPaidEntitlements(session) ? 'mixed' : 'celtic';
    session.readingOfferShown = false;
    session.pendingReadingQuestion = '';
    session.pendingGiftReading = false;
    session.pendingPaidReadingKind = '';
    session.lastPaidReadingAt = Date.now();
    session.freeConversationUsed = FREE_CONVERSATION_LIMIT;
    session.freeCooldownUsed = false;
    armFreeReadingCooldown(chatId, session);
    session.pendingPayment = null;
    session.pendingTributePayment = null;
  } catch (err) {
    session.paidReadingActive = false;
    session.paidContinuation = false;
    session.readingOfferShown = false;
    console.error('[tarot-omen] Celtic reading error:', err);
    await telegramSendMessage(chatId, 'Я пока не смогла завершить Кельтский крест. Оплата сохранена за этой историей — попробуй запустить его ещё раз.');
  }
}

async function runPaidThreeCardReading(chatId, session, question) {
  const userName = session.userName || '';
  const cards = drawThreeCards();
  const previousReading = session.reading || null;
  const historyBlock = Array.isArray(session.history) && session.history.length
    ? session.history.slice(-12).map((item) => `${item.role === 'user' ? 'User' : 'Omen'}: ${item.text}`).join('\n')
    : '';
  const contextParts = [];
  if (previousReading) {
    contextParts.push(`Previous ${previousReading.spreadType === 'celtic' ? 'Celtic Cross' : 'three-card'} question: ${previousReading.question}\nPrevious interpretation: ${previousReading.interpretation}`);
  }
  if (historyBlock) contextParts.push(`Conversation history:\n${historyBlock}`);
  const conversationContext = contextParts.join('\n\n');

  try {
    const mixingMessageIds = await telegramSendMessage(chatId, 'Мешаю карты...', true);
    const shuffleMessageId = await telegramSendShuffleGif(chatId);
    const interpretationPromise = generateInterpretation(question, cards, userName, 'three', conversationContext, chatId);
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
    armFreeReadingCooldown(chatId, session);
  } catch (err) {
    session.paidReadingActive = false;
    session.paidContinuation = false;
    session.readingOfferShown = false;
    console.error('[tarot-omen] Paid reading error:', err);
    await telegramSendMessage(chatId, 'Я пока не смогла завершить этот расклад. Оплата сохранена за этой историей — попробуй запустить его ещё раз.');
  }
}

function buildStartPaymentButtons() {
  return [
    [{ text: `⭐ Обычный — ${PAID_READING_STARS} Stars`, callback_data: 'pay:stars:reading' }],
    [{ text: `💳 Обычный — ${TRIBUTE_READING_RUB} ₽`, callback_data: 'pay:tribute:reading' }],
    [{ text: `🔮 Кельтский крест — ${CELTIC_CROSS_STARS} Stars`, callback_data: 'pay:stars:celtic' }],
    [{ text: `💳 Кельтский крест — ${TRIBUTE_CELTIC_RUB} ₽`, callback_data: 'pay:tribute:celtic' }],
    ...buildSupportButtons()
  ];
}

async function sendStartMessage(chatId, session = null) {
  ensureWorkflowFields(session);

  const ordinary = Number(session?.paidReadingsRemaining || 0);
  const celtic = Number(session?.paidCelticRemaining || 0);
  const buttons = [];

  // /start is a menu entry point, not a state reset. Always expose both
  // payment methods for both products, even when the user has no reading yet.
  if (ordinary > 0) {
    buttons.push([{
      text: `🃏 Использовать обычный расклад — осталось ${ordinary}`,
      callback_data: 'select:paid:reading'
    }]);
  }
  if (celtic > 0) {
    buttons.push([{
      text: `🔮 Использовать Кельтский крест — осталось ${celtic}`,
      callback_data: 'select:paid:celtic'
    }]);
  }

  buttons.push(
    [{ text: `⭐ Обычный — ${PAID_READING_STARS} Stars`, callback_data: 'pay:stars:reading' }],
    [{ text: `💳 Обычный — ${TRIBUTE_READING_RUB} ₽`, callback_data: 'pay:tribute:reading' }],
    [{ text: `🔮 Кельтский крест — ${CELTIC_CROSS_STARS} Stars`, callback_data: 'pay:stars:celtic' }],
    [{ text: `💳 Кельтский крест — ${TRIBUTE_CELTIC_RUB} ₽`, callback_data: 'pay:tribute:celtic' }],
    ...buildSupportButtons()
  );

  const text = ordinary > 0 || celtic > 0
    ? `Задавай свой вопрос\n\n${buildEntitlementSummary(session)}\n\nВыбери расклад или способ оплаты:`
    : 'Задавай свой вопрос\n\nВыбери расклад и способ оплаты:';

  await telegramSendInlineKeyboardWithRetry(chatId, text, buttons);
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
    if (session && callback.from?.username) session.telegramUsername = String(callback.from.username).trim();
    try {
      if (callback.data === 'buy:celtic') {
        if (!session?.reading) {
          throw new Error('Сначала нужен основной расклад.');
        }
        await offerCelticPurchase(chatId, callback.message?.message_id);
      } else if (callback.data === 'buy:celtic:back') {
        if (!session?.reading) {
          throw new Error('Сначала нужен основной расклад.');
        }
        await offerCelticBackOptions(chatId, session, callback.message?.message_id);
      } else if (callback.data === 'choose:celtic:payment') {
        if (!session?.reading) {
          throw new Error('Сначала нужен основной расклад.');
        }
        await offerCelticPaymentMethods(chatId, callback.message?.message_id);
      } else if (callback.data === 'choose:celtic:back') {
        if (!session?.reading) {
          throw new Error('Сначала нужен основной расклад.');
        }
        await offerCelticBackOptions(chatId, session, callback.message?.message_id);
      } else if (callback.data === 'choose:celtic:back:selection') {
        if (!session?.reading) {
          throw new Error('Сначала нужен основной расклад.');
        }
        await offerPaymentMethods(chatId, callback.message?.message_id);
      } else if (callback.data === 'payment:open') {
        await offerPaymentMethods(chatId, callback.message?.message_id);
      } else if (callback.data === 'promo:enter') {
        if (!session) throw new Error('Сначала нужен расклад.');
        ensureWorkflowFields(session);
        session.pendingPromoEntry = true;
        session.pendingSupport = false;
        await telegramSendForceReply(chatId, '🎟 Отправь промокод одним сообщением. Например: OMEN-ABCDE-23456');
      } else if (callback.data === 'support:contact') {
        if (!session) throw new Error('Сначала открой бота командой /start.');
        ensureWorkflowFields(session);
        session.pendingSupport = true;
        session.supportActive = true;
        session.pendingPromoEntry = false;
        await telegramSendForceReply(chatId, '🛟 Напиши вопрос для техподдержки одним сообщением. Я передам его оператору.');
      } else if (callback.data.startsWith('support:reply:')) {
        if (!isSupportOperator(callback.from)) throw new Error('Недостаточно прав.');
        const targetChatId = callback.data.slice('support:reply:'.length);
        supportReplyTargets.set(String(callback.from?.id || chatId), targetChatId);
        await telegramSendMessageInThread(chatId, callback.message?.message_thread_id, `Напиши ответ пользователю ${targetChatId} следующим сообщением в этом топике.`);
      } else if (callback.data.startsWith('support:recovery:')) {
        if (!isSupportOperator(callback.from)) throw new Error('Недостаточно прав.');
        const parts = callback.data.split(':');
        const kind = parts[2] === 'celtic' ? 'celtic' : 'reading';
        const targetChatId = parts.slice(3).join(':');
        const code = await createPromoCode(kind, targetChatId, callback.from?.username || 'support');
        await telegramSendMessage(targetChatId, `🎟 Для восстановления доступа тебе выдан промокод: ${code}\n\nОтправь его боту одним сообщением.`);
        await telegramSendMessageInThread(chatId, callback.message?.message_thread_id, `✅ Промокод создан и отправлен пользователю.\n\n${code}\n${promoKindLabel(kind)}`);
      } else if (callback.data.startsWith('support:close:')) {
        if (!isSupportOperator(callback.from)) throw new Error('Недостаточно прав.');
        const targetChatId = callback.data.slice('support:close:'.length);
        if (dbReady && dbPool) await dbPool.query(`UPDATE support_threads SET status = 'closed', updated_at = NOW() WHERE user_chat_id = $1`, [String(targetChatId)]);
        const targetSession = sessions.get(Number(targetChatId));
        if (targetSession) targetSession.supportActive = false;
        await telegramSendMessage(targetChatId, '🛟 Техподдержка закрыла обращение. Если понадобится помощь снова, нажми «Связаться с техподдержкой».');
        await telegramSendMessageInThread(chatId, callback.message?.message_thread_id, '✅ Обращение закрыто.');
      } else if (callback.data === 'continue:ordinary') {
        if (!session?.reading) {
          throw new Error('Сначала нужен основной расклад.');
        }
        const paidReadingAvailable = Number(session.paidReadingsRemaining || 0) > 0;
        const freeAvailable = isFreeReadingAvailable(chatId, session);

        if (paidReadingAvailable) {
          session.pendingPaidReadingKind = 'reading';
          await offerPaidTopicChoice(chatId, session, callback.message?.message_id);
        } else if (freeAvailable) {
          const continuationQuestion = session.pendingReadingQuestion ||
            session.reading?.question ||
            'Посмотреть следующий слой этой истории';
          const cards = drawThreeCards();
          await deleteCallbackMessage(callback);
          await telegramSendMessage(chatId, 'Мешаю карты...', true);
          await telegramSendShuffleGif(chatId);

          const interpretationPromise = generateInterpretation(
            continuationQuestion, cards, session.userName || '', 'three', '', chatId
          );
          const spreadImage = await buildReadingImage(cards);
          await telegramSendSpreadImage(chatId, spreadImage);
          await telegramSendMessage(chatId, CARDS_CAPTION);
          await sleep(1200);
          const result = await interpretationPromise;
          await telegramSendCardText(chatId, result.interpretation, cards);

          try {
            const followup = await generateFollowupQuestion({
              userName: session.userName || '',
              originalQuestion: continuationQuestion,
              cards,
              interpretation: result.interpretation
            });
            await telegramSendCardText(chatId, followup, cards);
          } catch (followupErr) {
            console.error('[tarot-omen] Celtic-back free follow-up generation failed:', followupErr);
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
          armFreeReadingCooldown(chatId, session);
        } else {
          throw new Error('Для продолжения пока нет доступного обычного расклада.');
        }
      } else if (callback.data === 'pay:stars:reading' || callback.data === 'pay:tribute:reading' ||
                 callback.data === 'pay:stars:celtic' || callback.data === 'pay:tribute:celtic') {
        const isAdminPurchase = isAdminTestUser(callback.from);
        const purchaseKind = callback.data.includes(':celtic') ? 'celtic' : 'reading';
        if (isAdminPurchase) {
          if (!session?.reading) throw new Error('Сначала нужен основной расклад.');
          session.pendingPayment = null;
          session.pendingTributePayment = null;
          session.pendingGiftReading = false;
          session.pendingPaidReadingKind = '';
          session.pendingReadingQuestion = '';
          activatePaidPackage(session, purchaseKind);
          await deleteCallbackMessage(callback);
          await telegramSendMessage(
            chatId,
            purchaseKind === 'celtic'
              ? 'Тестовая оплата подтверждена. Получен 1 Кельтский крест и 2 обычных расклада в подарок.'
              : 'Тестовая оплата подтверждена. Получены 5 обычных раскладов.'
          );
          await offerAvailablePaidReadings(chatId, session);
        } else {
          const currency = callback.data.startsWith('pay:tribute:') ? 'RUB' : 'STARS';
          await createPaymentInvoice(chatId, session, purchaseKind, currency);
          await deleteCallbackMessage(callback);
        }
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
      } else if (callback.data === 'select:paid:reading') {
        if (session?.paidReadingsRemaining > 0) {
          session.pendingNewTopic = false;
          session.pendingNewTopicKind = '';
          await offerPaidTopicChoice(chatId, session, callback.message?.message_id);
        }
      } else if (callback.data === 'select:paid:celtic') {
        if (session?.paidCelticRemaining > 0) {
          session.pendingNewTopic = false;
          session.pendingNewTopicKind = '';
          session.pendingPaidReadingKind = 'celtic';
          await offerPaidTopicChoice(chatId, session, callback.message?.message_id);
        }
      } else if (callback.data === 'use:paid:reading') {
        if (session?.paidReadingsRemaining > 0) {
          session.pendingPaidReadingKind = 'reading';
          await offerPaidTopicChoice(chatId, session, callback.message?.message_id);
        }
      } else if (callback.data === 'use:paid:celtic') {
        if (session?.paidCelticRemaining > 0) {
          session.pendingPaidReadingKind = 'celtic';
          await offerPaidTopicChoice(chatId, session, callback.message?.message_id);
        }
      } else if (callback.data === 'paidtopic:continue') {
        const kind = session?.pendingPaidReadingKind;
        if (!session || !session.reading || !['reading', 'celtic'].includes(kind)) throw new Error('Сначала выбери доступный расклад.');
        if (kind === 'celtic' && Number(session.paidCelticRemaining || 0) <= 0) throw new Error('Кельтских крестов больше нет.');
        if (kind === 'reading' && Number(session.paidReadingsRemaining || 0) <= 0) throw new Error('Обычных раскладов больше нет.');
        session.pendingGiftReading = false;
        session.pendingPaidTopicChoice = false;
        session.pendingReadingQuestion = '';
        const question = session.reading.question || 'Посмотреть следующий слой этой истории';
        session.pendingPaidReadingKind = '';
        await deleteCallbackMessage(callback);
        await telegramSendMessage(chatId, kind === 'celtic' ? 'Продолжаем эту тему Кельтским крестом.' : 'Продолжаем эту тему обычным раскладом.');
        if (kind === 'celtic') await runPaidCelticReading(chatId, session, question);
        else await runPaidThreeCardReading(chatId, session, question);
      } else if (callback.data === 'paidtopic:new') {
        const kind = session?.pendingPaidReadingKind;
        if (!session || !['reading', 'celtic'].includes(kind)) throw new Error('Сначала выбери доступный расклад.');
        if (kind === 'celtic' && Number(session.paidCelticRemaining || 0) <= 0) throw new Error('Кельтских крестов больше нет.');
        if (kind === 'reading' && Number(session.paidReadingsRemaining || 0) <= 0) throw new Error('Обычных раскладов больше нет.');
        session.pendingGiftReading = false;
        session.pendingPaidTopicChoice = false;
        session.pendingNewTopic = true;
        session.pendingNewTopicKind = kind;
        session.pendingReadingQuestion = '';
        session.pendingPaidReadingKind = '';
        await showNewTopicInfo(
          chatId,
          session,
          kind === 'celtic'
            ? 'Хорошо. Напиши новый вопрос, и Кельтский крест будет сделан уже на эту тему, отдельно от предыдущей истории.'
            : 'Хорошо. Напиши новый вопрос, и следующий обычный расклад будет сделан уже на эту тему, отдельно от предыдущей истории.'
        );
      } else if (callback.data === 'new:topic') {
        // Keep the payment-choice message and its buttons visible. The new-topic
        // action is intentionally additive, so the user can still return to the
        // same payment choices without losing the explanation above them.
        await handleNewTopicRequest(chatId, session);
      } else if (callback.data === 'pay:reading' || callback.data === 'pay:celtic') {
        const kind = callback.data === 'pay:celtic' ? 'celtic' : 'reading';
        if (isAdminTestUser(callback.from)) {
          if (!session?.reading) throw new Error('Сначала нужен основной расклад.');
          session.pendingPayment = null;
          session.pendingTributePayment = null;
          activatePaidPackage(session, kind);
          await deleteCallbackMessage(callback);
          await telegramSendMessage(
            chatId,
            kind === 'celtic'
              ? 'Тестовая оплата подтверждена. Получен 1 Кельтский крест и 2 обычных расклада в подарок.'
              : 'Тестовая оплата подтверждена. Получены 5 обычных раскладов.'
          );
          await offerAvailablePaidReadings(chatId, session);
        } else {
          await createPaymentInvoice(chatId, session, kind, 'STARS');
          await deleteCallbackMessage(callback);
        }
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
  const telegramUsername = String(message.from?.username || '').trim();

  if (!text) return;

  // ===== SUPPORT FORUM OPERATOR MESSAGES =====
  if (SUPPORT_CHAT_ID && String(message.chat?.id) === String(SUPPORT_CHAT_ID)) {
    if (!isSupportOperator({ username: telegramUsername, id: message.from?.id })) return;
    const operatorKey = String(message.from?.id || '');
    if (supportReplyTargets.has(operatorKey)) {
      const targetChatId = supportReplyTargets.get(operatorKey);
      supportReplyTargets.delete(operatorKey);
      await telegramSendMessage(targetChatId, `🛟 Ответ техподдержки:\n\n${text}`);
      if (dbReady && dbPool && message.message_thread_id) {
        await telegramSendMessageInThread(SUPPORT_CHAT_ID, message.message_thread_id, `👩‍💻 Оператор:\n\n${text}`);
      }
      return;
    }
    if (dbReady && dbPool && message.message_thread_id) {
      const thread = await dbPool.query(`SELECT user_chat_id FROM support_threads WHERE support_chat_id = $1 AND thread_id = $2 AND status = 'open'`, [String(SUPPORT_CHAT_ID), Number(message.message_thread_id)]);
      if (thread.rowCount) {
        const targetChatId = thread.rows[0].user_chat_id;
        await telegramSendMessage(targetChatId, `🛟 Ответ техподдержки:\n\n${text}`);
      }
    }
    return;
  }

  if (text === '/promo' || /^\/promo\s+(celtic|reading)(?:\s+([1-9]\d*))?$/i.test(text)) {
    if (!isAdminTestUser({ username: telegramUsername })) {
      await telegramSendMessage(chatId, 'Неизвестная команда.');
      return;
    }
    if (!dbReady || !dbPool) {
      await telegramSendMessage(chatId, 'Промокоды требуют подключённого PostgreSQL.');
      return;
    }
    const match = text.match(/^\/promo\s+(celtic|reading)(?:\s+([1-9]\d*))?$/i);
    if (!match) {
      await telegramSendMessage(chatId, 'Формат: /promo celtic или /promo reading');
      return;
    }
    const kind = match[1].toLowerCase() === 'celtic' ? 'celtic' : 'reading';
    const count = Math.min(10, Number(match[2] || 1));
    const codes = [];
    for (let i = 0; i < count; i += 1) codes.push(await createPromoCode(kind, null, telegramUsername));
    await telegramSendMessage(chatId, `Создано промокодов: ${count}.\n\n${codes.join('\n')}\n\nСодержимое: ${promoKindLabel(kind)}.`);
    return;
  }

  if (text === '/start') {
    // /start must never reset the user's free entitlement. It only starts/returns
    // to the current Omen session.
    if (!sessions.has(chatId)) {
      sessions.set(chatId, {
        userName,
        telegramUsername,
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
        freeReadingAvailable: false,
        freeCooldownAvailableAt: 0
      });
    } else {
      sessions.get(chatId).userName = userName || sessions.get(chatId).userName || '';
      sessions.get(chatId).telegramUsername = telegramUsername || sessions.get(chatId).telegramUsername || '';
    }
    ensureWorkflowFields(sessions.get(chatId));
    if (sessions.has(chatId) && isAdminTestUser({ username: telegramUsername })) {
      ensureAdminTestEntitlement(sessions.get(chatId));
    }
    await sendStartMessage(chatId, sessions.get(chatId));
    return;
  }
  if (rateLimited(`tg:${chatId}`)) {
    await telegramSendMessage(chatId, 'Слишком много запросов подряд. Попробуй через пару минут.');
    return;
  }

  const session = sessions.get(chatId);
  if (session) {
    ensureWorkflowFields(session);
    session.telegramUsername = telegramUsername || session.telegramUsername || '';
    if (isAdminTestUser({ username: telegramUsername })) ensureAdminTestEntitlement(session);
  }

  // ===== SUPPORT OPERATOR REPLY =====
  // Support operators can answer the last selected user directly from the bot.
  if (isSupportOperator({ username: telegramUsername, id: message.from?.id }) && supportReplyTargets.has(String(message.from?.id || chatId))) {
    const targetChatId = supportReplyTargets.get(String(message.from?.id || chatId));
    supportReplyTargets.delete(String(message.from?.id || chatId));
    try {
      await telegramSendMessage(targetChatId, `🛟 Ответ техподдержки:\n\n${text}`);
      await telegramSendMessage(chatId, `Ответ отправлен пользователю ${targetChatId}.`);
    } catch (err) {
      console.error('[tarot-omen] Failed to send support reply:', err);
      await telegramSendMessage(chatId, `Не удалось отправить ответ пользователю ${targetChatId}.`);
    }
    return;
  }

  // ===== PROMO CODE =====
  // A recovery code can be entered after pressing the promo button, or directly
  // in the normal Telegram input field.
  if (session && (session.pendingPromoEntry || /^OMEN-[A-Z0-9]{5}-[A-Z0-9]{5}$/i.test(text))) {
    session.pendingPromoEntry = false;
    try {
      await handlePromoInput(chatId, session, text);
    } catch (err) {
      console.error('[tarot-omen] Promo redemption failed:', err);
      await telegramSendMessage(chatId, 'Не удалось проверить промокод из-за технической ошибки. Попробуй ещё раз.');
    }
    return;
  }

  // ===== SUPPORT REQUEST =====
  if (session?.pendingSupport) {
    session.pendingSupport = false;
    session.supportActive = true;
    try {
      await sendSupportRequest(chatId, session, text);
    } catch (err) {
      console.error('[tarot-omen] Support request failed:', err);
      await telegramSendMessage(chatId, 'Не удалось передать сообщение в техподдержку. Попробуй ещё раз.');
    }
    return;
  }

  // ===== ACTIVE SUPPORT CONVERSATION =====
  if (session?.supportActive) {
    try {
      if (await forwardSupportUserMessage(chatId, text)) return;
      session.supportActive = false;
    } catch (err) {
      console.error('[tarot-omen] Active support forwarding failed:', err);
      await telegramSendMessage(chatId, 'Не удалось передать сообщение в техподдержку. Попробуй ещё раз.');
      return;
    }
  }

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
        if (!isFreeReadingAvailable(chatId, session)) {
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

        const interpretationPromise = generateInterpretation(text, cards, userName, 'three', '', chatId);
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
        armFreeReadingCooldown(chatId, session);
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

  // Do not let an arbitrary text message fall through into the conversation
  // while the user is choosing whether the selected paid spread starts a new
  // topic or continues the current one. The choice is intentionally explicit.
  if (session?.pendingPaidTopicChoice) {
    await telegramSendMessage(chatId, 'Выбери один из двух вариантов кнопками: начать новый расклад или продолжить эту тему.');
    return;
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
  // A free three-card reading becomes available only after all paid entitlements
  // are exhausted and the 72-hour cooldown has completed. The free right does
  // not accumulate if it is left unused.
  if (session?.reading &&
      !session.pendingGiftReading &&
      isFreeReadingAvailable(chatId, session)) {
    try {
      const continuationQuestion = session.pendingReadingQuestion || text;
      const cards = drawThreeCards();
      await telegramSendMessage(chatId, 'Мешаю карты...', true);
      await telegramSendShuffleGif(chatId);

      const interpretationPromise = generateInterpretation(continuationQuestion, cards, userName, 'three', '', chatId);
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
      armFreeReadingCooldown(chatId, session);
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
        spreadType: session.reading.spreadType || 'three',
        chatId
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
        spreadType: session.reading.spreadType || 'three',
        chatId
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

    const interpretationPromise = generateInterpretation(text, cards, userName, 'three', '', chatId);
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

    const previousSession = sessions.get(chatId) || {};
    sessions.set(chatId, {
      ...previousSession,
      userName,
      telegramUsername: telegramUsername || previousSession.telegramUsername || '',
      reading: {
        question: text,
        cards,
        interpretation: result.interpretation,
        spreadType: 'three'
      },
      history: [],
      freeConversationUsed: 0,
      paidConversationUsed: 0,
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
      freeReadingAvailable: false,
      freeCooldownUsed: false,
      freeCooldownAvailableAt: 0,
      freeCooldownNotificationSentAt: 0
    });
    armFreeReadingCooldown(chatId, sessions.get(chatId));
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

const telegramChatUpdateQueues = new Map();

async function handleTelegramUpdate(update) {
  const chatId = getUpdateChatId(update);
  const previous = chatId ? (telegramChatUpdateQueues.get(chatId) || Promise.resolve()) : Promise.resolve();

  const current = previous
    .catch(() => {})
    .then(async () => {
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
    });

  if (chatId) {
    telegramChatUpdateQueues.set(chatId, current);
    current.finally(() => {
      if (telegramChatUpdateQueues.get(chatId) === current) {
        telegramChatUpdateQueues.delete(chatId);
      }
    }).catch(() => {});
  }

  await current;
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

  scheduleAllFreeReadingNotifications();

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
