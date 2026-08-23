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

    const clientKey = req.ip || 'unknown';
    if (rateLimited(clientKey)) {
      return res.status(429).json({ error: 'Too many readings requested. Please wait a few minutes.' });
    }

    const { question, cards } = req.body || {};

    if (typeof question !== 'string' || question.trim().length === 0 || question.length > 400) {
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

app.listen(PORT, () => {
  console.log(`[tarot-omen] backend listening on port ${PORT}`);
});
