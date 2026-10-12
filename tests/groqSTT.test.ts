import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_CONFIG } from '../src/utils/constants.ts';
import { GroqSTT } from '../src/services/groqSTT.ts';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function audioBlob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'audio/webm' });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('posts to the local proxy and does not send a bearer token', async () => {
  let url = '';
  let authorization: string | null = null;
  let sessionKey: string | null = null;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    const headers = new Headers(init?.headers);
    authorization = headers.get('authorization');
    sessionKey = headers.get('x-groq-session-key');
    return jsonResponse(200, { text: 'hello', segments: [{ text: 'hello', start: 0, end: 1 }] });
  };

  const stt = new GroqSTT({ apiKey: 'session-only-key', retryWaitMs: 0 });
  const result = await stt.transcribe(audioBlob(200 * 1024));
  assert.equal(result.text, 'hello');
  assert.equal(url, '/api/stt/transcriptions');
  assert.equal(authorization, null);
  assert.equal(sessionKey, 'session-only-key');
});

test('omits the session header when the server holds the key', async () => {
  let sessionKey: string | null = 'present';
  globalThis.fetch = async (_input, init) => {
    sessionKey = new Headers(init?.headers).get('x-groq-session-key');
    return jsonResponse(200, { text: 'ok' });
  };

  const stt = new GroqSTT({ retryWaitMs: 0 });
  await stt.transcribe(audioBlob(200 * 1024));
  assert.equal(sessionKey, null);
});

test('does not retry 400 responses', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls > 1) throw new Error(`runaway retries: ${calls}`);
    return jsonResponse(400, { error: { message: 'bad audio' } });
  };

  const stt = new GroqSTT({ retryWaitMs: 0 });
  await assert.rejects(
    () => stt.transcribe(audioBlob(200 * 1024)),
    (error: { message?: string; statusCode?: number }) => {
      assert.match(error.message || '', /400/);
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('stops 429 and 500 retries after the configured budget', async () => {
  for (const status of [429, 500]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls > API_CONFIG.MAX_RETRIES + 1) throw new Error(`runaway retries: ${calls}`);
      return jsonResponse(status, { error: { message: 'again' } }, status === 429 ? { 'retry-after': '120' } : {});
    };

    const stt = new GroqSTT({ retryWaitMs: 0 });
    await assert.rejects(() => stt.transcribe(audioBlob(200 * 1024)));
    assert.equal(calls, API_CONFIG.MAX_RETRIES + 1, `status ${status}`);
  }
});

test('a later transcription gets a fresh retry budget', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(400, { error: { message: 'bad audio' } });
  };

  const stt = new GroqSTT({ retryWaitMs: 0 });
  await assert.rejects(() => stt.transcribe(audioBlob(200 * 1024)));
  await assert.rejects(() => stt.transcribe(audioBlob(200 * 1024)));
  assert.equal(calls, 2);
});

test('abort stops the in-flight request before another attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = (_input, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };

  const stt = new GroqSTT({ retryWaitMs: 0 });
  const pending = stt.transcribe(audioBlob(200 * 1024), controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('empty and oversized audio fail once without a request', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(200, { text: 'nope' });
  };

  const stt = new GroqSTT({ retryWaitMs: 0 });
  await assert.rejects(() => stt.transcribe(audioBlob(0)), /empty/);
  await assert.rejects(
    () => stt.transcribe(audioBlob(API_CONFIG.MAX_FILE_SIZE + 1)),
    /maximum limit/,
  );
  assert.equal(calls, 0);
});

test('tiny aggregates are ignored without calling the proxy', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(200, { text: 'nope' });
  };

  const stt = new GroqSTT({ retryWaitMs: 0 });
  const result = await stt.transcribe(audioBlob(1024));
  assert.equal(result.text, '');
  assert.equal(calls, 0);
});
