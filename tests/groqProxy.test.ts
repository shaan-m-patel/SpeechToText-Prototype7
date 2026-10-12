import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { createGroqProxy } from '../server/groqProxy.ts';

const SERVER_KEY = 'server-canary-groq-key';
const SESSION_KEY = 'session-canary-groq-key';

interface CapturedRequest {
  url: string;
  authorization: string | null;
  bodyLength: number;
}

function startProxy(options: {
  serverKey?: string;
  maxBodyBytes?: number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  onUpstream?: (request: CapturedRequest, init: RequestInit) => void;
}) {
  const captured: CapturedRequest[] = [];
  const fetchImpl = options.fetchImpl ?? (async (input: string, init: RequestInit) => {
    const body = init.body;
    const bodyLength = body instanceof Uint8Array ? body.byteLength : 0;
    const authorization = new Headers(init.headers).get('authorization');
    captured.push({ url: input, authorization, bodyLength });
    options.onUpstream?.({ url: input, authorization, bodyLength }, init);
    return new Response(JSON.stringify({ text: 'proxied' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const proxy = createGroqProxy({
    getServerKey: () => options.serverKey ?? '',
    fetchImpl,
    maxBodyBytes: options.maxBodyBytes,
  });
  const server = http.createServer((req, res) => {
    proxy(req, res, () => {
      res.statusCode = 404;
      res.end('next');
    });
  });

  return new Promise<{ baseUrl: string; captured: CapturedRequest[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        captured,
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done());
        }),
      });
    });
  });
}

const closers: Array<() => Promise<void>> = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
});

test('status reports configuration without returning the key', async () => {
  const proxy = await startProxy({ serverKey: SERVER_KEY });
  closers.push(proxy.close);

  const response = await fetch(`${proxy.baseUrl}/api/stt/status`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(body, '{"configured":true}');
  assert.equal(body.includes(SERVER_KEY), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('status is false when the server has no key', async () => {
  const proxy = await startProxy({});
  closers.push(proxy.close);
  const response = await fetch(`${proxy.baseUrl}/api/stt/status`);
  assert.equal(await response.text(), '{"configured":false}');
});

test('forwards audio with the server key and ignores a browser session key', async () => {
  const proxy = await startProxy({ serverKey: SERVER_KEY });
  closers.push(proxy.close);

  const form = new FormData();
  form.append('model', 'whisper-large-v3-turbo');
  form.append('file', new File([new Uint8Array(32)], 'clip.webm', { type: 'audio/webm' }));
  const response = await fetch(`${proxy.baseUrl}/api/stt/transcriptions`, {
    method: 'POST',
    headers: { 'X-Groq-Session-Key': SESSION_KEY },
    body: form,
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(body.includes(SERVER_KEY), false);
  assert.equal(body.includes(SESSION_KEY), false);
  assert.equal(proxy.captured.length, 1);
  assert.equal(proxy.captured[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(proxy.captured[0].authorization, `Bearer ${SERVER_KEY}`);
  assert.ok(proxy.captured[0].bodyLength > 0);
});

test('uses a session key only when the server has none', async () => {
  const proxy = await startProxy({});
  closers.push(proxy.close);

  const form = new FormData();
  form.append('file', new File([new Uint8Array(8)], 'clip.webm', { type: 'audio/webm' }));
  const response = await fetch(`${proxy.baseUrl}/api/stt/transcriptions`, {
    method: 'POST',
    headers: { 'X-Groq-Session-Key': SESSION_KEY },
    body: form,
  });

  assert.equal(response.status, 200);
  assert.equal(proxy.captured[0].authorization, `Bearer ${SESSION_KEY}`);
  assert.equal((await response.text()).includes(SESSION_KEY), false);
});

test('rejects transcription when no key is available', async () => {
  const proxy = await startProxy({});
  closers.push(proxy.close);
  const response = await fetch(`${proxy.baseUrl}/api/stt/transcriptions`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: 'unused',
  });
  assert.equal(response.status, 401);
  assert.equal(proxy.captured.length, 0);
});

test('rejects an oversized upload before calling Groq', async () => {
  const proxy = await startProxy({ serverKey: SERVER_KEY, maxBodyBytes: 16 });
  closers.push(proxy.close);
  const response = await fetch(`${proxy.baseUrl}/api/stt/transcriptions`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: 'this body is definitely larger than sixteen bytes',
  });
  assert.equal(response.status, 413);
  assert.equal(proxy.captured.length, 0);
});

test('aborts the upstream request when the browser disconnects', async () => {
  let upstreamAborted = false;
  const proxy = await startProxy({
    serverKey: SERVER_KEY,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        upstreamAborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  closers.push(proxy.close);

  const controller = new AbortController();
  const pending = fetch(`${proxy.baseUrl}/api/stt/transcriptions`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: 'audio-bytes',
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await assert.rejects(pending);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(upstreamAborted, true);
});
