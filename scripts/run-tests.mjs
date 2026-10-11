import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';

const entryPoints = readdirSync('tests')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `tests/${name}`);

rmSync('tmp/tests', { recursive: true, force: true });

await build({
  entryPoints,
  outdir: 'tmp/tests',
  bundle: true,
  platform: 'node',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
});

const testFiles = readdirSync('tmp/tests')
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => `tmp/tests/${name}`);

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);
