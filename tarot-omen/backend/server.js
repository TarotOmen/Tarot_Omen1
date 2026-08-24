import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!GEMINI_API_KEY) {
  console.warn(
    '[tarot-omen] WARNING: GEMINI_API_KEY is not set.'
  );
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

app.post('/api/interpret', async (req, res) => {
  try {

    const body = req.body || {};
const question = typeof body.question === 'string'
  ? body.question.trim()
  : String(body.question || '').trim();

const cards = body.cards;

if (!question || question.length > 400) {
  return res.status(400).json({ error: 'Invalid question.' });
}
    if (!Array.isArray(cards) || cards.length !== 3) {
      return res.status(400).json({ error: 'Exactly three cards are required.' });
    }
    for (const c of cards) {
      if (
        typeof c?.position !== 'string' ||
        typeof c?.name !== 'string' ||
        (c.orientation !== 'upright' && c.orientation !== 'reversed') ||
        typeof c?.keywords !== 'string'
      ) {
        return res.status(400).json({ error: 'Malformed card data.' });
      }
    }

    const cardBlock = cards
      .map(
        (c, i) =>
          `Card ${i + 1} — ${c.position}\nName: ${c.name}\nOrientation: ${c.orientation}\nKeywords: ${c.keywords}`
      )
      .join('\n\n');

    const userMessage = `User's question:\n"${question.trim()}"\n\nDrawn spread:\n\n${cardBlock}`;

    const response = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: SYSTEM_PROMPT
          }
        ]
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: userMessage
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 3000
      }
    })
  }
);

const responseData = await response.json();

if (!response.ok) {
  console.error('[tarot-omen] Gemini API error:', responseData);

  return res.status(502).json({
    error: responseData?.error?.message || 'Gemini API request failed.'
  });
}

const interpretation = responseData?.candidates?.[0]?.content?.parts
  ?.filter((part) => typeof part.text === 'string')
  .map((part) => part.text)
  .join('\n')
  .trim();

    if (!interpretation) {
      return res.status(502).json({ error: 'The reading came back empty. Please try again.' });
    }

    res.json({ interpretation });
  } catch (err) {
    console.error('[tarot-omen] /api/interpret failed:', err);
    res.status(500).json({ error: 'Something went wrong generating the reading.' });
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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function telegramSendMessage(chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${await response.text()}`);
  }
}

async function telegramSendShuffleGif(chatId) {
  const gifPath = new URL('./shuffle.gif', import.meta.url);
  const gif = await readFile(gifPath);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('animation', new Blob([gif], { type: 'image/gif' }), 'shuffle.gif');
  form.append('caption', '🔮 Перемешиваю карты...');

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAnimation`,
    { method: 'POST', body: form }
  );

  if (!response.ok) {
    throw new Error(`Telegram sendAnimation failed: ${await response.text()}`);
  }

  return (await response.json()).result;
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
    const imageUrl = code
      ? `https://petaloverflow.github.io/tarot-api/cards/${code}.jpg`
      : null;

    if (!imageUrl) {
      throw new Error(`No image mapping for Tarot card: ${card.name}`);
    }

    const orientation = card.orientation === 'reversed' ? 'перевёрнутая' : 'прямая';

    return {
      type: 'photo',
      media: imageUrl,
      caption: `${index + 1}. ${card.name}\n${orientation}\n${card.position}`
    };
  });

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, media })
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram sendMediaGroup failed: ${await response.text()}`);
  }
}

async function telegramGetUpdates(offset = 0) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    if (data.error_code === 409) {
      throw new Error(
        "Telegram 409 Conflict: another bot instance is already polling getUpdates."
      );
    }

    throw new Error(data.description || "Telegram getUpdates failed");
  }

  return data;
}

async function runTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return;
  }

  let offset = 0;

  console.log("Telegram bot starting...");

  while (true) {
    try {
      const data = await telegramGetUpdates(offset);

      if (!data.ok) {
        console.error("Telegram error:", data);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        const message = update.message;

        if (!message || !message.text) continue;

        const chatId = message.chat.id;
        const text = String(message.text || "").trim();

        if (text === "/start") {
          await telegramSendMessage(
            chatId,
            "Привет! Напиши свой вопрос для расклада."
          );
          continue;
        }

        try {
          const cards = drawThreeCards();

          // Show the question immediately so the user has a visible starting point.
          await telegramSendMessage(chatId, `🔮 Ваш вопрос:\n\n${text}`);

          // Keep the animation on screen while Gemini is generating the reading.
          await telegramSendShuffleGif(chatId);

          const interpretation = await fetch(
            `http://127.0.0.1:${PORT}/api/interpret`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                question: text,
                cards
              })
            }
          );

          const result = await interpretation.json();

          if (!interpretation.ok) {
            throw new Error(result.error || "Interpretation failed");
          }

          const answer =
            result.interpretation ||
            result.text ||
            result.answer ||
            JSON.stringify(result);

          // Reveal the exact three cards that Gemini interpreted.
          await telegramSendCards(chatId, cards);

          // Then place the interpretation immediately after the cards.
          await telegramSendMessage(chatId, `🔮 Интерпретация\n\n${answer}`);

        } catch (err) {
          console.error("Telegram interpretation error:", err);

          await telegramSendMessage(
            chatId,
            "Не удалось получить интерпретацию. Попробуй ещё раз."
          );
        }
      }

    } catch (err) {
      console.error("Telegram polling error:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runTelegramBot();
app.listen(PORT, () => {
  console.log(`[tarot-omen] backend listening on port ${PORT}`);
});
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!GEMINI_API_KEY) {
  console.warn(
    '[tarot-omen] WARNING: GEMINI_API_KEY is not set.'
  );
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

app.post('/api/interpret', async (req, res) => {
  try {

    const body = req.body || {};
const question = typeof body.question === 'string'
  ? body.question.trim()
  : String(body.question || '').trim();

const cards = body.cards;

if (!question || question.length > 400) {
  return res.status(400).json({ error: 'Invalid question.' });
}
    if (!Array.isArray(cards) || cards.length !== 3) {
      return res.status(400).json({ error: 'Exactly three cards are required.' });
    }
    for (const c of cards) {
      if (
        typeof c?.position !== 'string' ||
        typeof c?.name !== 'string' ||
        (c.orientation !== 'upright' && c.orientation !== 'reversed') ||
        typeof c?.keywords !== 'string'
      ) {
        return res.status(400).json({ error: 'Malformed card data.' });
      }
    }

    const cardBlock = cards
      .map(
        (c, i) =>
          `Card ${i + 1} — ${c.position}\nName: ${c.name}\nOrientation: ${c.orientation}\nKeywords: ${c.keywords}`
      )
      .join('\n\n');

    const userMessage = `User's question:\n"${question.trim()}"\n\nDrawn spread:\n\n${cardBlock}`;

    const response = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: SYSTEM_PROMPT
          }
        ]
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: userMessage
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 3000
      }
    })
  }
);

const responseData = await response.json();

if (!response.ok) {
  console.error('[tarot-omen] Gemini API error:', responseData);

  return res.status(502).json({
    error: responseData?.error?.message || 'Gemini API request failed.'
  });
}

const interpretation = responseData?.candidates?.[0]?.content?.parts
  ?.filter((part) => typeof part.text === 'string')
  .map((part) => part.text)
  .join('\n')
  .trim();

    if (!interpretation) {
      return res.status(502).json({ error: 'The reading came back empty. Please try again.' });
    }

    res.json({ interpretation });
  } catch (err) {
    console.error('[tarot-omen] /api/interpret failed:', err);
    res.status(500).json({ error: 'Something went wrong generating the reading.' });
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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function telegramSendMessage(chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${await response.text()}`);
  }
}

async function telegramSendShuffleGif(chatId) {
  const gifPath = new URL('./shuffle.gif', import.meta.url);
  const gif = await readFile(gifPath);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('animation', new Blob([gif], { type: 'image/gif' }), 'shuffle.gif');
  form.append('caption', '🔮 Перемешиваю карты...');

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendAnimation`,
    { method: 'POST', body: form }
  );

  if (!response.ok) {
    throw new Error(`Telegram sendAnimation failed: ${await response.text()}`);
  }

  return (await response.json()).result;
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
    const imageUrl = code
      ? `https://petaloverflow.github.io/tarot-api/cards/${code}.jpg`
      : null;

    if (!imageUrl) {
      throw new Error(`No image mapping for Tarot card: ${card.name}`);
    }

    const orientation = card.orientation === 'reversed' ? 'перевёрнутая' : 'прямая';

    return {
      type: 'photo',
      media: imageUrl,
      caption: `${index + 1}. ${card.name}\n${orientation}\n${card.position}`
    };
  });

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, media })
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram sendMediaGroup failed: ${await response.text()}`);
  }
}

async function telegramGetUpdates(offset = 0) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    if (data.error_code === 409) {
      throw new Error(
        "Telegram 409 Conflict: another bot instance is already polling getUpdates."
      );
    }

    throw new Error(data.description || "Telegram getUpdates failed");
  }

  return data;
}

async function runTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return;
  }

  let offset = 0;

  console.log("Telegram bot starting...");

  while (true) {
    try {
      const data = await telegramGetUpdates(offset);

      if (!data.ok) {
        console.error("Telegram error:", data);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        const message = update.message;

        if (!message || !message.text) continue;

        const chatId = message.chat.id;
        const text = String(message.text || "").trim();

        if (text === "/start") {
          await telegramSendMessage(
            chatId,
            "Привет! Напиши свой вопрос для расклада."
          );
          continue;
        }

        try {
          const cards = drawThreeCards();

          // Show the question immediately so the user has a visible starting point.
          await telegramSendMessage(chatId, `🔮 Ваш вопрос:\n\n${text}`);

          // Keep the animation on screen while Gemini is generating the reading.
          await telegramSendShuffleGif(chatId);

          const interpretation = await fetch(
            `http://127.0.0.1:${PORT}/api/interpret`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                question: text,
                cards
              })
            }
          );

          const result = await interpretation.json();

          if (!interpretation.ok) {
            throw new Error(result.error || "Interpretation failed");
          }

          const answer =
            result.interpretation ||
            result.text ||
            result.answer ||
            JSON.stringify(result);

          // Reveal the exact three cards that Gemini interpreted.
          await telegramSendCards(chatId, cards);

          // Then place the interpretation immediately after the cards.
          await telegramSendMessage(chatId, `🔮 Интерпретация\n\n${answer}`);

        } catch (err) {
          console.error("Telegram interpretation error:", err);

          await telegramSendMessage(
            chatId,
            "Не удалось получить интерпретацию. Попробуй ещё раз."
          );
        }
      }

    } catch (err) {
      console.error("Telegram polling error:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runTelegramBot();
app.listen(PORT, () => {
  console.log(`[tarot-omen] backend listening on port ${PORT}`);
});
import 'dotenv/config';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!GEMINI_API_KEY) {
  console.warn(
    '[tarot-omen] WARNING: GEMINI_API_KEY is not set.'
  );
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

app.post('/api/interpret', async (req, res) => {
  try {

    const body = req.body || {};
const question = typeof body.question === 'string'
  ? body.question.trim()
  : String(body.question || '').trim();

const cards = body.cards;

if (!question || question.length > 400) {
  return res.status(400).json({ error: 'Invalid question.' });
}
    if (!Array.isArray(cards) || cards.length !== 3) {
      return res.status(400).json({ error: 'Exactly three cards are required.' });
    }
    for (const c of cards) {
      if (
        typeof c?.position !== 'string' ||
        typeof c?.name !== 'string' ||
        (c.orientation !== 'upright' && c.orientation !== 'reversed') ||
        typeof c?.keywords !== 'string'
      ) {
        return res.status(400).json({ error: 'Malformed card data.' });
      }
    }

    const cardBlock = cards
      .map(
        (c, i) =>
          `Card ${i + 1} — ${c.position}\nName: ${c.name}\nOrientation: ${c.orientation}\nKeywords: ${c.keywords}`
      )
      .join('\n\n');

    const userMessage = `User's question:\n"${question.trim()}"\n\nDrawn spread:\n\n${cardBlock}`;

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
        parts: [
          {
            text: SYSTEM_PROMPT
          }
        ]
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: userMessage
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 700
      }
    })
  }
);

const responseData = await response.json();

if (!response.ok) {
  console.error('[tarot-omen] Gemini API error:', responseData);

  return res.status(502).json({
    error: responseData?.error?.message || 'Gemini API request failed.'
  });
}

const interpretation = responseData?.candidates?.[0]?.content?.parts
  ?.filter((part) => typeof part.text === 'string')
  .map((part) => part.text)
  .join('\n')
  .trim();

    if (!interpretation) {
      return res.status(502).json({ error: 'The reading came back empty. Please try again.' });
    }

    res.json({ interpretation });
  } catch (err) {
    console.error('[tarot-omen] /api/interpret failed:', err);
    res.status(500).json({ error: 'Something went wrong generating the reading.' });
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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function telegramSendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

async function telegramGetUpdates(offset = 0) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    if (data.error_code === 409) {
      throw new Error(
        "Telegram 409 Conflict: another bot instance is already polling getUpdates."
      );
    }

    throw new Error(data.description || "Telegram getUpdates failed");
  }

  return data;
}

async function runTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return;
  }

  let offset = 0;

  console.log("Telegram bot starting...");

  while (true) {
    try {
      const data = await telegramGetUpdates(offset);

      if (!data.ok) {
        console.error("Telegram error:", data);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        const message = update.message;

        if (!message || !message.text) continue;

        const chatId = message.chat.id;
        const text = String(message.text || "").trim();

        if (text === "/start") {
          await telegramSendMessage(
            chatId,
            "Привет! Напиши свой вопрос для расклада."
          );
          continue;
        }

        try {
          const interpretation = await fetch(
            `http://127.0.0.1:${PORT}/api/interpret`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
  question: text,
  cards: drawThreeCards()
})
            }
          );

          const result = await interpretation.json();

          if (!interpretation.ok) {
            throw new Error(result.error || "Interpretation failed");
          }

          const answer =
            result.interpretation ||
            result.text ||
            result.answer ||
            JSON.stringify(result);

          await telegramSendMessage(chatId, answer);

        } catch (err) {
          console.error("Telegram interpretation error:", err);

          await telegramSendMessage(
            chatId,
            "Не удалось получить интерпретацию. Попробуй ещё раз."
          );
        }
      }

    } catch (err) {
      console.error("Telegram polling error:", err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runTelegramBot();
app.listen(PORT, () => {
  console.log(`[tarot-omen] backend listening on port ${PORT}`);
});
