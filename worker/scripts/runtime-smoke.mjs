import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// This test runs the deployed code in workerd with a real SQLite Durable Object.
// All outbound HTTP is intercepted. No provider credentials or paid calls exist.
const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
const compatibilityDate = config.match(/compatibility_date\s*=\s*"([^"]+)"/)[1];
const compatibilityFlags = JSON.parse(config.match(/compatibility_flags\s*=\s*(\[[^\]]*\])/)?.[1] ?? '[]');
const bundled = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], bundle: true, format: 'esm', write: false, platform: 'browser', target: 'es2022' });
let entered;
const enteredUpstream = new Promise(resolve => { entered = resolve; });
let aborted;
const abortedUpstream = new Promise(resolve => { aborted = resolve; });
let upstreamCalls = 0;
let mode = 'success';
const responseBody = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Runtime checked' }] }], usage: { input_tokens: 100, output_tokens: 200 } };
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: bundled.outputFiles[0].text, compatibilityDate, compatibilityFlags,
  cf: false, host: '127.0.0.1', port: 0,
  unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
  bindings: { OPENAI_API_KEY: 'test-only-provider-key', ACCESS_CODE: 'test-only-access-code', SESSION_SECRET: 'test-only-session-secret-more-than-32-characters', ALLOWED_ORIGIN: 'https://ymunick.github.io', ACCOUNT_DAILY_BUDGET_USD: '2' },
  durableObjects: { BUDGET: { className: 'AccountBudget', useSQLite: true } },
  outboundService: { node: (request, response) => {
    upstreamCalls++;
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'success') { response.end(JSON.stringify(responseBody)); return; }
    const fallback = setTimeout(() => response.end(JSON.stringify(responseBody)), 5000);
    response.once('close', () => {
      clearTimeout(fallback);
      if (!response.writableEnded) aborted();
    });
    entered();
  } },
}));
try {
  await mf.ready;
  const base = await mf.unsafeGetDirectURL();
  const post = (path, body, token, signal) => fetch(new URL(path, base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ymunick.github.io', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal });
  const login = await post('/session', { accessCode: 'test-only-access-code' });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const body = { requestId: crypto.randomUUID(), question: 'Why this job?', context: '', profile: '', style: 'concise' };
  const firstAnswer = await post('/answer', body, token);
  assert.equal(firstAnswer.status, 200, `upstream calls ${upstreamCalls}; response ${await firstAnswer.text()}`);
  assert.equal((await post('/answer', body, token)).status, 409);
  assert.equal(upstreamCalls, 1);
  const usage = await fetch(new URL('/usage', base), { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  assert.equal(usage.spentUsd, 0.00011);
  assert.equal(usage.reservedUsd, 0);
  mode = 'cancellation';
  const controller = new AbortController();
  const cancelledId = crypto.randomUUID();
  const pending = post('/answer', { ...body, requestId: cancelledId }, token, controller.signal).catch(error => error);
  await enteredUpstream;
  controller.abort();
  assert.equal((await post('/cancel', { requestId: cancelledId }, token)).status, 202);
  await pending;
  let deadline;
  try {
    await Promise.race([abortedUpstream, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Explicit cancellation did not reach the upstream request within 2 seconds')), 2000); })]);
  } finally { clearTimeout(deadline); }
  const afterCancel = await fetch(new URL('/usage', base), { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  assert.ok(afterCancel.reservedUsd > 0, 'Unconfirmed cancellation must retain its reservation');
  console.log('workerd smoke passed: signed session, SQLite accounting, duplicate prevention, explicit cancellation propagation');
} finally { await mf.dispose(); }
