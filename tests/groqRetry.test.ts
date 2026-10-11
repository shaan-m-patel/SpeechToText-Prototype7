import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroqHttpError, decideRetry, retryableForStatus } from '../src/services/groqRetry.ts';

test('other 4xx responses are not retried', () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const error = new GroqHttpError('no', { status, retryable: retryableForStatus(status) });
    assert.equal(decideRetry(error, 0, 3).retry, false, `status ${status}`);
  }
});

test('429 and 5xx are retried until the local attempt budget is spent', () => {
  const rateLimited = new GroqHttpError('slow down', { status: 429, retryable: true, retryAfterMs: 30_000 });
  assert.equal(decideRetry(rateLimited, 0, 3).retry, true);
  assert.equal(decideRetry(rateLimited, 2, 3).retry, true);
  assert.equal(decideRetry(rateLimited, 3, 3).retry, false);
  assert.ok(decideRetry(rateLimited, 0, 3).delayMs <= 2000);

  const unavailable = new GroqHttpError('down', { status: 503, retryable: true });
  assert.equal(decideRetry(unavailable, 0, 3).retry, true);
  assert.equal(decideRetry(unavailable, 3, 3).retry, false);
});

test('abort, validation errors, and network errors follow the retry policy', () => {
  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  assert.equal(decideRetry(aborted, 0, 3).retry, false);

  const validation = new GroqHttpError('too big', { retryable: false });
  assert.equal(decideRetry(validation, 0, 3).retry, false);

  assert.equal(decideRetry(new TypeError('network'), 0, 3).retry, true);
  assert.equal(decideRetry(new Error('not a transport failure'), 0, 3).retry, false);
});
