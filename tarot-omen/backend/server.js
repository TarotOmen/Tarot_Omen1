import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  '';

if (!GEMINI_API_KEY) {
  console.warn('[tarot-omen] WARNING: GEMINI_API_KEY is not set.');
}

if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[tarot-omen] WARNING: TELEGRAM_BOT_TOKEN is not set.');
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

const SYSTEM_PROMPT = `You are the reading voice of Tarot Omen, a thoughtful and immersive Tarot reader.

You receive: a user's question and three ALREADY-DRAWN Tarot cards. Each card has a
position, name, orientation (upright or reversed), and keywords. The cards were
chosen randomly before you were called. YOU NEVER CHOOSE, REPLACE, OR INVENT CARDS.

Your task is to give a DEEP, PERSONAL reading of this exact spread in relation to
the exact question. Do not give a generic encyclopedia-style description of Tarot.

Reading rules:
- Interpret each card through its exact position and orientation.
- Explain what each card contributes to the situation, but weave the cards into
  one connected story rather than writing three disconnected definitions.
- Pay close attention to the wording and emotional meaning of the user's actual
  question.
- Explain tensions, repetitions, contrasts, and progression between the three cards.
- Distinguish what seems to be the underlying situation, what is influencing it,
  and what direction the spread points toward.
- End with a practical, grounded takeaway: what the person can reflect on, notice,
  or do next. Do not give absolute predictions.
- Use reflective language such as "the cards suggest", "the spread points to",
  "this can indicate". Never claim supernatural certainty.
- If the question concerns health: never diagnose and never claim the person is or
  is not healthy. Keep it reflective and gently recommend a qualified professional
  when appropriate.
- If the question concerns money or finance: never promise a financial result.
  Discuss patterns, choices, risks and factors worth attention.
- Reply in the same language as the user's question.
- Make the reading substantial: 7–10 well-developed paragraphs, approximately
  800–1100 words when the language allows it. Do not rush to the conclusion.
- You may use short section labels such as "Общий смысл расклада", the card
  positions, "Связь карт" and "Что взять из расклада", but do not use bullet lists.
- Do not mention that you are an AI, an API, a prompt, a model, or that the cards
  were supplied by software.`;

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

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userMessage }]
            }
          ],
          generationConfig: {
            maxOutputTokens: 3000
          }
        }),
        signal: controller.signal
      }
    );

    const raw = await response.text();
    let responseData;

    try {
      responseData = JSON.parse(raw);
    } catch {
      throw new Error(`Gemini returned invalid JSON (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const message = responseData?.error?.message || `Gemini API HTTP ${response.status}`;
      throw new Error(message);
    }

    const interpretation = responseData?.candidates?.[0]?.content?.parts
      ?.filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();

    if (!interpretation) {
      const reason = responseData?.candidates?.[0]?.finishReason;
      throw new Error(
        reason
          ? `Gemini returned no text (finishReason: ${reason}).`
          : 'Gemini returned an empty interpretation.'
      );
    }

    return interpretation;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Gemini request timed out after 60 seconds.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}


app.post('/api/interpret', async (req, res) => {
  try {
    const body = req.body || {};
    const question = typeof body.question === 'string'
      ? body.question.trim()
      : String(body.question || '').trim();

    const cards = body.cards;
    const interpretation = await generateInterpretation(question, cards);

    res.json({ interpretation });
  } catch (err) {
    console.error('[tarot-omen] /api/interpret failed:', err);
    res.status(502).json({
      error: err?.message || 'Something went wrong generating the reading.'
    });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ===== TAROT DECK FOR TELEGRAM =====

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


// ===== TELEGRAM BOT =====

async function telegramRequest(method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );

  const raw = await response.text();
  let data = null;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram ${method} returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${data?.description || raw || `HTTP ${response.status}`}`
    );
  }

  return data;
}

async function telegramSendMessage(chatId, text) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: String(text)
  });
}

function tarotImageCode(name) {
  const major = {
    "Шут":"ar00","Маг":"ar01","Верховная Жрица":"ar02","Императрица":"ar03",
    "Император":"ar04","Иерофант":"ar05","Влюблённые":"ar06","Колесница":"ar07",
    "Сила":"ar08","Отшельник":"ar09","Колесо Фортуны":"ar10","Справедливость":"ar11",
    "Повешенный":"ar12","Смерть":"ar13","Умеренность":"ar14","Дьявол":"ar15",
    "Башня":"ar16","Звезда":"ar17","Луна":"ar18","Солнце":"ar19","Суд":"ar20","Мир":"ar21"
  };

  if (major[name]) return major[name];

  const suitMap = {
    "Жезлов":"wa", "Кубков":"cu", "Мечей":"sw", "Пентаклей":"pe"
  };

  const rankMap = {
    "Туз":"ac", "Паж":"pa", "Рыцарь":"kn", "Королева":"qu", "Король":"ki",
    "Двойка":"02", "Тройка":"03", "Четвёрка":"04", "Пятёрка":"05",
    "Шестёрка":"06", "Семёрка":"07", "Восьмёрка":"08", "Девятка":"09", "Десятка":"10"
  };

  for (const [rank, rankCode] of Object.entries(rankMap)) {
    for (const [suit, suitCode] of Object.entries(suitMap)) {
      if (name === `${rank} ${suit}`) return `${suitCode}${rankCode}`;
    }
  }

  return null;
}

async function telegramSendCards(chatId, cards) {
  const media = cards.map((card, index) => {
    const code = tarotImageCode(card.name);

    if (!code) {
      throw new Error(`No image mapping for Tarot card: ${card.name}`);
    }

    // Telegram was failing when it tried to fetch the external GitHub Pages URL
    // directly. The local proxy below makes the image come from our Render service.
    const imageUrl = `${PUBLIC_URL.replace(/\/$/, '')}/tarot-card/${code}.jpg`;
    const orientation =
      card.orientation === 'reversed' ? 'перевёрнутая' : 'прямая';

    return {
      type: 'photo',
      media: imageUrl,
      caption: `${index + 1}. ${card.name}\n${orientation}\n${card.position}`
    };
  });

  if (!PUBLIC_URL) {
    throw new Error('PUBLIC_URL is not configured; card images are unavailable.');
  }

  return telegramRequest('sendMediaGroup', {
    chat_id: chatId,
    media
  });
}

app.get('/tarot-card/:code.jpg', async (req, res) => {
  const code = String(req.params.code || '');

  if (!/^(ar(?:0[0-9]|1[0-9]|2[01])|(?:wa|cu|sw|pe)(?:ac|pa|kn|qu|ki|0[2-9]|10))$/.test(code)) {
    return res.status(400).send('Invalid card code.');
  }

  try {
    const sourceUrl = `https://petaloverflow.github.io/tarot-api/cards/${code}.jpg`;
    const response = await fetch(sourceUrl);

    if (!response.ok) {
      return res.status(502).send('Card image source unavailable.');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error('[tarot-omen] card proxy failed:', err);
    res.status(502).send('Card image unavailable.');
  }
});

async function processTelegramUpdate(update) {
  const message = update?.message;

  if (!message || !message.text) {
    return;
  }

  const chatId = message.chat.id;
  const text = String(message.text || '').trim();

  if (!text) {
    return;
  }

  if (text === '/start') {
    await telegramSendMessage(
      chatId,
      'Привет! Напиши свой вопрос для расклада.'
    );
    return;
  }

  const key = String(chatId);

  if (rateLimited(key)) {
    await telegramSendMessage(
      chatId,
      'Слишком много запросов подряд. Попробуй немного позже.'
    );
    return;
  }

  try {
    const cards = drawThreeCards();

    // First generate and send the reading. Card-image delivery must never
    // prevent the user from receiving the actual answer.
    const answer = await generateInterpretation(text, cards);

    await telegramSendMessage(
      chatId,
      `🔮 Интерпретация\n\n${answer}`
    );

    // Cards are supplementary. If Telegram cannot fetch an image, send the
    // card names/orientations instead of turning the whole request into an error.
    try {
      await telegramSendCards(chatId, cards);
    } catch (cardError) {
      console.warn(
        '[tarot-omen] Card images were not delivered:',
        cardError?.message || cardError
      );

      const cardText = cards
        .map((card, index) => {
          const orientation =
            card.orientation === 'reversed' ? 'перевёрнутая' : 'прямая';
          return `${index + 1}. ${card.name} — ${orientation}\n${card.position}`;
        })
        .join('\n\n');

      await telegramSendMessage(
        chatId,
        `Карты расклада:\n\n${cardText}`
      );
    }
  } catch (err) {
    console.error('[tarot-omen] Telegram interpretation error:', err);

    try {
      await telegramSendMessage(
        chatId,
        'Не удалось получить интерпретацию. Попробуй ещё раз.'
      );
    } catch (sendError) {
      console.error('[tarot-omen] Telegram error message failed:', sendError);
    }
  }
}

app.post('/telegram-webhook', (req, res) => {
  // Acknowledge Telegram immediately, then process the update.
  res.sendStatus(200);

  processTelegramUpdate(req.body).catch((err) => {
    console.error('[tarot-omen] Telegram update processing failed:', err);
  });
});

async function setupTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    return;
  }

  if (!PUBLIC_URL) {
    console.warn(
      '[tarot-omen] PUBLIC_URL/RENDER_EXTERNAL_URL is not set. Telegram webhook was not configured.'
    );
    return;
  }

  const webhookUrl = `${PUBLIC_URL.replace(/\/$/, '')}/telegram-webhook`;

  await telegramRequest('setWebhook', {
    url: webhookUrl,
    drop_pending_updates: true
  });

  console.log(`[tarot-omen] Telegram webhook set: ${webhookUrl}`);
  console.log('[tarot-omen] Telegram bot ready.');
}

app.listen(PORT, async () => {
  console.log(`[tarot-omen] backend listening on port ${PORT}`);

  try {
    await setupTelegram();
  } catch (err) {
    console.error('[tarot-omen] Telegram setup failed:', err);
  }
});
