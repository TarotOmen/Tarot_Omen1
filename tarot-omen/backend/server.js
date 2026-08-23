import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const PORT = process.env.PORT || 8787;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!ANTHROPIC_API_KEY) {
  console.warn(
    '[tarot-omen] WARNING: ANTHROPIC_API_KEY is not set. /api/interpret will return an error until it is configured.'
  );
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

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
    if (!anthropic) {
      return res.status(500).json({ error: 'Server is not configured with an API key yet.' });
    }

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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const interpretation = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
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

  return await response.json();
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
                text: text
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
