import { API_CONFIG } from '../utils/constants';
import { WizperResponse, WizperError } from '../types/transcript';
import {
  GroqHttpError,
  abortError,
  decideRetry,
  isAbortError,
  parseRetryAfterMs,
  retryableForStatus,
  waitForRetry,
} from './groqRetry';

export interface GroqConfig {
  /** Session-only key. Leave empty when the server holds GROQ_P7_KEY. */
  apiKey?: string;
  language?: string; // ISO-639-1, e.g. 'en'
  prompt?: string;
  model?: 'whisper-large-v3-turbo' | 'whisper-large-v3';
  temperature?: number;
  enableTimestamps?: boolean; // if true, request verbose_json
  timestampGranularities?: Array<'segment' | 'word'>;
  task?: 'transcribe' | 'translate'; // translate => English via translations endpoint
  /** Test override for retry backoff. Production callers should omit this. */
  retryWaitMs?: number;
}

const PROXY_BASE = '/api/stt';
const MIN_AUDIO_BYTES = 200 * 1024;

export class GroqSTT {
  private config: GroqConfig;

  constructor(config: GroqConfig) {
    this.config = {
      model: 'whisper-large-v3-turbo',
      temperature: 0,
      enableTimestamps: true,
      timestampGranularities: ['segment'],
      task: 'transcribe',
      ...config,
      apiKey: config.apiKey?.trim() || undefined,
    };
  }

  async transcribe(audioBlob: Blob, signal?: AbortSignal): Promise<WizperResponse> {
    this.assertAudioBlob(audioBlob);

    // Skip tiny aggregates (< ~200KB) to avoid frequent 400s; Groq minimum billed is 10s
    if (audioBlob.size < MIN_AUDIO_BYTES) {
      return { text: '', segments: [], duration: 0 };
    }

    return this.withBoundedRetries(() => this.requestAudio(audioBlob, signal), signal);
  }

  async transcribeFromUrl(audioUrl: string, signal?: AbortSignal): Promise<WizperResponse> {
    const form = new FormData();
    form.append('url', audioUrl);
    this.appendModelFields(form);
    return this.withBoundedRetries(() => this.postForm(form, signal), signal);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${PROXY_BASE}/status`, { method: 'GET' });
      if (!res.ok) return false;
      const data = await res.json() as { configured?: boolean };
      return Boolean(data.configured);
    } catch {
      return false;
    }
  }

  updateConfig(newConfig: Partial<GroqConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig,
      apiKey: newConfig.apiKey === undefined
        ? this.config.apiKey
        : (newConfig.apiKey.trim() || undefined),
    };
  }

  private async withBoundedRetries(
    send: () => Promise<WizperResponse>,
    signal?: AbortSignal,
  ): Promise<WizperResponse> {
    let lastError: unknown;
    const maxAttempts = API_CONFIG.MAX_RETRIES + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw abortError();
      try {
        return await send();
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw abortError();
        lastError = error;
        const decision = decideRetry(error, attempt, API_CONFIG.MAX_RETRIES);
        if (!decision.retry) throw this.createError(error);
        const delayMs = this.config.retryWaitMs ?? decision.delayMs;
        await waitForRetry(delayMs, signal);
      }
    }

    throw this.createError(lastError);
  }

  private async requestAudio(audioBlob: Blob, signal?: AbortSignal): Promise<WizperResponse> {
    const normalizedBlob = new Blob([audioBlob], { type: 'audio/webm' });
    const filename = `chunk-${Date.now()}.webm`;
    const file = new File([normalizedBlob], filename, { type: 'audio/webm' });

    const form = new FormData();
    form.append('file', file);
    this.appendModelFields(form);
    return this.postForm(form, signal);
  }

  private appendModelFields(form: FormData): void {
    form.append('model', this.config.model!);

    if (this.config.enableTimestamps) {
      form.append('response_format', 'verbose_json');
      const granularities = this.config.timestampGranularities ?? ['segment'];
      for (const g of granularities) form.append('timestamp_granularities[]', g);
    } else {
      form.append('response_format', 'json');
    }

    if (this.config.language) form.append('language', this.config.language);
    if (typeof this.config.temperature === 'number') form.append('temperature', String(this.config.temperature));
    if (this.config.prompt) form.append('prompt', this.config.prompt);
  }

  private async postForm(form: FormData, signal?: AbortSignal): Promise<WizperResponse> {
    const endpoint = this.config.task === 'translate' ? 'translations' : 'transcriptions';
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['X-Groq-Session-Key'] = this.config.apiKey;
    }

    let res: Response;
    try {
      res = await fetch(`${PROXY_BASE}/${endpoint}`, {
        method: 'POST',
        headers,
        body: form,
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw abortError();
      throw error;
    }

    if (!res.ok) {
      const detail = await readErrorDetail(res);
      throw new GroqHttpError(
        `Groq STT request failed (${res.status}): ${detail || res.statusText}`,
        {
          status: res.status,
          retryable: retryableForStatus(res.status),
          retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
        },
      );
    }

    const data = await res.json();
    return this.parseGroqResponse(data);
  }

  private assertAudioBlob(audioBlob: Blob): void {
    if (!audioBlob || audioBlob.size === 0) {
      throw new GroqHttpError('Audio blob is empty.', { retryable: false });
    }
    if (audioBlob.size > API_CONFIG.MAX_FILE_SIZE) {
      throw new GroqHttpError(
        `File size exceeds maximum limit of ${API_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`,
        { retryable: false },
      );
    }
  }

  private parseGroqResponse(data: Record<string, unknown>): WizperResponse {
    const rawSegments = Array.isArray(data.segments) ? data.segments : undefined;
    const segments = rawSegments
      ? rawSegments.map((segment) => {
          const s = segment as Record<string, unknown>;
          return {
            text: String(s.text || '').trim(),
            start: typeof s.start === 'number' ? s.start : 0,
            end: typeof s.end === 'number' ? s.end : 0,
            confidence: 0.9,
          };
        })
      : undefined;

    const duration = segments && segments.length > 0 ? segments[segments.length - 1].end : undefined;

    return {
      text: String(data.text || '').trim(),
      segments,
      language: (typeof data.language === 'string' ? data.language : undefined) || this.config.language,
      duration,
    };
  }

  private createError(error: unknown): WizperError {
    let message = 'Unknown error';
    let statusCode: number | undefined;

    if (error instanceof GroqHttpError) {
      message = error.message;
      statusCode = error.status;
    } else if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error && typeof error === 'object') {
      const e = error as { error?: { message?: string; code?: number } };
      if (e.error?.message) message = e.error.message;
      if (e.error?.code) statusCode = Number(e.error.code);
    }

    return { error: 'TRANSCRIPTION_FAILED', message, statusCode };
  }
}

async function readErrorDetail(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      const body = await res.json() as { error?: { message?: string } | string };
      if (body?.error && typeof body.error === 'object' && body.error.message) return body.error.message;
      if (typeof body?.error === 'string') return body.error;
      return JSON.stringify(body);
    }
    return await res.text();
  } catch {
    return '';
  }
}
