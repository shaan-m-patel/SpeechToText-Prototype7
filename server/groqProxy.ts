import type { IncomingMessage, ServerResponse } from 'node:http';

const GROQ_AUDIO_URL = 'https://api.groq.com/openai/v1/audio';
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024 + 64 * 1024;

export interface GroqProxyOptions {
  getServerKey: () => string;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  maxBodyBytes?: number;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

export function createGroqProxy(options: GroqProxyOptions): Middleware {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return (req, res, next) => {
    const pathname = (req.url || '').split('?')[0];
    if (!pathname.startsWith('/api/stt')) {
      next();
      return;
    }

    void handleProxyRequest(req, res, pathname, {
      getServerKey: options.getServerKey,
      fetchImpl,
      maxBodyBytes,
    }).catch((error: unknown) => {
      if (res.writableEnded) return;
      const statusCode = error instanceof PayloadTooLargeError ? 413 : 502;
      sendJson(res, statusCode, {
        error: statusCode === 413 ? 'Audio exceeds the 25MB limit' : 'Transcription proxy failed',
      });
    });
  };
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: Required<Pick<GroqProxyOptions, 'getServerKey' | 'fetchImpl' | 'maxBodyBytes'>>,
): Promise<void> {
  if (pathname === '/api/stt/status') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    sendJson(res, 200, { configured: Boolean(options.getServerKey()) });
    return;
  }

  const endpoint = pathname === '/api/stt/transcriptions'
    ? 'transcriptions'
    : pathname === '/api/stt/translations'
      ? 'translations'
      : null;

  if (!endpoint) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const serverKey = options.getServerKey();
  const sessionKey = serverKey ? '' : readSessionKey(req);
  const apiKey = serverKey || sessionKey;
  if (!apiKey) {
    sendJson(res, 401, { error: 'Groq API key is not configured' });
    return;
  }

  const contentType = headerValue(req.headers['content-type']);
  if (!contentType) {
    sendJson(res, 400, { error: 'Expected multipart form data' });
    return;
  }

  const upstream = new AbortController();
  const abortIfClientLeft = () => {
    if (!res.writableFinished) upstream.abort();
  };
  res.on('close', abortIfClientLeft);

  try {
    const body = await readBody(req, options.maxBodyBytes);
    if (upstream.signal.aborted) return;

    const groqResponse = await options.fetchImpl(`${GROQ_AUDIO_URL}/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(body),
      signal: upstream.signal,
    });

    if (upstream.signal.aborted || res.writableEnded) return;

    const responseType = groqResponse.headers.get('content-type');
    res.statusCode = groqResponse.status;
    res.setHeader('Cache-Control', 'no-store');
    if (responseType) res.setHeader('Content-Type', responseType);
    const payload = Buffer.from(await groqResponse.arrayBuffer());
    if (!res.writableFinished) res.end(payload);
  } catch (error) {
    if (upstream.signal.aborted || isAbortError(error)) {
      if (!res.writableFinished) {
        try { res.end(); } catch { /* the browser already disconnected */ }
      }
      return;
    }
    throw error;
  } finally {
    res.removeListener('close', abortIfClientLeft);
  }
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
    this.name = 'PayloadTooLargeError';
  }
}

function readSessionKey(req: IncomingMessage): string {
  const value = headerValue(req.headers['x-groq-session-key']);
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return '';
  return trimmed;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBodyBytes) {
      req.resume();
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError');
}

export function resolveGroqServerKey(fileEnv: Record<string, string>): string {
  return firstNonEmpty(
    process.env.GROQ_P7_KEY,
    fileEnv.GROQ_P7_KEY,
    process.env.VITE_GROQ_P7_KEY,
    fileEnv.VITE_GROQ_P7_KEY,
  );
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
