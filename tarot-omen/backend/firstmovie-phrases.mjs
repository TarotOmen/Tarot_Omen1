import { timingSafeEqual } from 'node:crypto';

const MODEL = 'gemini-3.1-flash-lite';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const ALLOWED_COUNTS = new Set([5, 10, 20, 30]);
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isFirstMovieLocalTestRequest(req, env = process.env) {
  const token = String(env.FIRSTMOVIE_PHRASES_TEST_TOKEN || '');
  if (env.NODE_ENV === 'production') return false;
  const remoteAddress = String(req?.socket?.remoteAddress || req?.ip || '').replace(/^::ffff:/, '');
  const authorization = String(req?.get?.('authorization') || req?.headers?.authorization || '');
  const suppliedToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (!token || !LOCAL_ADDRESSES.has(remoteAddress) || !suppliedToken) return false;
  const expected = Buffer.from(token, 'utf8');
  const supplied = Buffer.from(suppliedToken, 'utf8');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function validateFirstMoviePhraseRequest(body) {
  const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
  const count = Number(body?.count);
  if (topic.length < 2 || topic.length > 160) {
    throw Object.assign(new Error('Введите тему длиной от 2 до 160 символов.'), { status: 400 });
  }
  if (!ALLOWED_COUNTS.has(count)) {
    throw Object.assign(new Error('Количество фраз должно быть 5, 10, 20 или 30.'), { status: 400 });
  }
  return { topic, count };
}

export async function generateFirstMoviePhrases(topic, count, options = {}) {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('Сервер Gemini не настроен: отсутствует GEMINI_API_KEY.'), { status: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `Ты пишешь короткие, оригинальные, естественные русскоязычные фразы для публикаций и коротких видео. По заданной теме создай ровно ${count} разных фраз. Не добавляй нумерацию, пояснения, заголовки или хэштеги. Верни только JSON-объект вида {"phrases":["...", "..."]}.` }],
        },
        contents: [{ role: 'user', parts: [{ text: `Тема: ${topic}` }] }],
        generationConfig: { maxOutputTokens: Math.min(4096, count * 90), responseMimeType: 'application/json' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(response.status === 429
        ? 'Gemini временно ограничил запросы. Попробуйте позже.'
        : 'Gemini не смог обработать запрос. Попробуйте изменить тему.');
      error.status = 502;
      throw error;
    }

    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts
      ?.filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    if (!text) throw Object.assign(new Error('Gemini вернул пустой ответ.'), { status: 502 });

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gi, ''));
    } catch {
      throw Object.assign(new Error('Gemini вернул ответ в неожиданном формате. Повторите запрос.'), { status: 502 });
    }
    const phrases = Array.isArray(parsed?.phrases)
      ? parsed.phrases.map((phrase) => String(phrase).trim()).filter(Boolean)
      : [];
    if (phrases.length !== count) {
      throw Object.assign(new Error('Gemini вернул неполный список фраз. Повторите запрос.'), { status: 502 });
    }
    return phrases;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Истекло время ожидания ответа Gemini. Попробуйте ещё раз.'), { status: 504 });
    }
    if (Number.isInteger(error?.status)) throw error;
    throw Object.assign(new Error('Не удалось связаться с Gemini. Проверьте подключение к интернету.'), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

