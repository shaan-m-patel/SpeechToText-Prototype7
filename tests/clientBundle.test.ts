import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('client source does not read a Groq key from the bundle environment', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const client = readFileSync('src/services/groqSTT.ts', 'utf8');
  const viteConfig = readFileSync('vite.config.ts', 'utf8');

  assert.doesNotMatch(app, /import\.meta\.env\.VITE_GROQ/);
  assert.doesNotMatch(client, /api\.groq\.com/);
  assert.doesNotMatch(client, /Authorization/);
  assert.doesNotMatch(viteConfig, /define\s*:/);
  assert.match(viteConfig, /envPrefix/);
});
