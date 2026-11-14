import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFirstMoviePhrases,
  isFirstMovieLocalTestRequest,
  validateFirstMoviePhraseRequest,
} from './firstmovie-phrases.mjs';

test('accepts only supported counts and bounded topics', () => {
  assert.deepEqual(validateFirstMoviePhraseRequest({ topic: 'саморазвитие', count: 10 }), {
    topic: 'саморазвитие', count: 10,
  });
  assert.throws(() => validateFirstMoviePhraseRequest({ topic: 'x', count: 10 }), { status: 400 });
  assert.throws(() => validateFirstMoviePhraseRequest({ topic: 'достаток', count: 7 }), { status: 400 });
});

test('local test endpoint requires a matching bearer token and loopback client', () => {
  const env = { NODE_ENV: 'development', FIRSTMOVIE_PHRASES_TEST_TOKEN: 'local-test-secret' };
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: 'Bearer local-test-secret' } };
  assert.equal(isFirstMovieLocalTestRequest(request, env), true);
  assert.equal(isFirstMovieLocalTestRequest({ ...request, socket: { remoteAddress: '203.0.113.7' } }, env), false);
  assert.equal(isFirstMovieLocalTestRequest({ ...request, headers: { authorization: 'Bearer wrong' } }, env), false);
  assert.equal(isFirstMovieLocalTestRequest(request, { ...env, NODE_ENV: 'production' }), false);
});

test('reports a clear server configuration error when Gemini key is absent', async () => {
  await assert.rejects(
    generateFirstMoviePhrases('саморазвитие', 5, { apiKey: '' }),
    { status: 503, message: 'Сервер Gemini не настроен: отсутствует GEMINI_API_KEY.' },
  );
});

test('parses the required number of phrases from Gemini JSON response', async () => {
  let captured;
  const phrases = await generateFirstMoviePhrases('саморазвитие', 5, {
    apiKey: 'test-only',
    fetchImpl: async (url, request) => {
      captured = { url, request };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ phrases: ['Фраза 1', 'Фраза 2', 'Фраза 3', 'Фраза 4', 'Фраза 5'] }) }] } }] }) };
    },
  });
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  assert.equal(captured.request.headers['x-goog-api-key'], 'test-only');
  assert.deepEqual(phrases, ['Фраза 1', 'Фраза 2', 'Фраза 3', 'Фраза 4', 'Фраза 5']);
});

