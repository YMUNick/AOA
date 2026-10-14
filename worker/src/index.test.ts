import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { AccountBudget } from './index';
import type { Env, Store } from './index';

// Models the external durable storage, including rollback and transaction serialization.
class MemoryStorage implements Store {
  values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  transaction<T>(body: (tx: Store) => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => { const snapshot = structuredClone(this.values); try { return await body(this); } catch (error) { this.values = snapshot; throw error; } });
    this.tail = next.catch(() => undefined); return next;
  }
}
const origin = 'https://ymunick.github.io';
function setup(budget = '2') {
  const storage = new MemoryStorage();
  const env = { OPENAI_API_KEY: 'provider-secret-test', ACCESS_CODE: 'private-access-test-12345', SESSION_SECRET: 'session-secret-at-least-32-characters-long', ALLOWED_ORIGIN: origin, ACCOUNT_DAILY_BUDGET_USD: budget } as Env;
  let object = new AccountBudget({ storage }, env);
  env.BUDGET = { idFromName: () => 'owner', get: () => ({ fetch: request => object.fetch(request) }) };
  const send = (path: string, body?: unknown, token?: string, requestOrigin = origin) => worker.fetch(new Request(`https://gateway.example${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const login = async () => { const response = await send('/session', { accessCode: env.ACCESS_CODE }); expect(response.status).toBe(200); return (await response.json() as { token: string }).token; };
  return { storage, env, send, login, restart: () => { object = new AccountBudget({ storage }, env); } };
}
const payload = () => ({ requestId: crypto.randomUUID(), question: 'What motivates you?', context: '', profile: '', style: 'concise' });
const successBody = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'An answer' }] }], usage: { input_tokens: 100, output_tokens: 200 } };
function upstream(body: unknown = successBody, status = 200) { return vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status }))); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('private gateway authentication', () => {
  it('publishes capabilities without making a paid call', async () => {
    upstream(); const app = setup();
    const result = await app.send('/capabilities');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', streaming: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a signed bearer token even with a permitted Origin', async () => {
    upstream(); const app = setup();
    expect((await app.send('/answer', payload())).status).toBe(401);
    expect((await app.send('/usage', undefined, 'forged.token')).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects incorrect access codes and limits repeated authentication attempts', async () => {
    const app = setup();
    for (let i = 0; i < 5; i++) expect((await app.send('/session', { accessCode: 'incorrect' })).status).toBe(401);
    app.restart();
    expect((await app.send('/session', { accessCode: app.env.ACCESS_CODE })).status).toBe(429);
  });
  it('expires and rejects tampered tokens', async () => {
    const app = setup(); const token = await app.login();
    expect((await app.send('/usage', undefined, token)).status).toBe(200);
    expect((await app.send('/usage', undefined, `${token.slice(0, -3)}bad`)).status).toBe(401);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 3_601_000);
    expect((await app.send('/usage', undefined, token)).status).toBe(401);
  });
  it('rejects an unapproved browser Origin and gives exact-origin preflight headers', async () => {
    const app = setup();
    expect((await app.send('/capabilities', undefined, undefined, 'https://evil.example')).status).toBe(403);
    const preflight = await worker.fetch(new Request('https://gateway.example/answer', { method: 'OPTIONS', headers: { Origin: origin } }), app.env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

describe('durable paid request accounting', () => {
  it('unauthenticated cancellation cannot stop work or create a pre-cancel tombstone', async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const app = setup(); const token = await app.login(); const request = payload();
    const pending = app.send('/answer', request, token);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect((await app.send('/cancel', { requestId: request.requestId })).status).toBe(401);
    expect((await app.send('/cancel', { requestId: request.requestId }, 'forged.token')).status).toBe(401);
    expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(false);
    release(Response.json(successBody)); expect((await pending).status).toBe(200);
    const next = payload();
    expect((await app.send('/cancel', { requestId: next.requestId })).status).toBe(401);
    upstream(); expect((await app.send('/answer', next, token)).status).toBe(200);
  });
  it('late cancellation leaves an already settled charge unchanged', async () => {
    upstream(); const app = setup(); const token = await app.login(); const request = payload();
    expect((await app.send('/answer', request, token)).status).toBe(200);
    expect((await app.send('/cancel', { requestId: request.requestId }, token)).status).toBe(202);
    expect(await (await app.send('/usage', undefined, token)).json()).toMatchObject({ spentUsd: 0.00011, reservedUsd: 0, unconfirmedRequests: 0 });
  });
  it('explicitly cancels an in-flight upstream and keeps the unknown reservation', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const app = setup(); const token = await app.login(); const request = payload();
    const pending = app.send('/answer', request, token);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect((await app.send('/cancel', { requestId: request.requestId }, token)).status).toBe(202);
    expect((await pending).status).toBe(504);
    expect((await app.send('/answer', request, token)).status).toBe(409);
    expect((await (await app.send('/usage', undefined, token)).json() as { reservedUsd: number }).reservedUsd).toBeGreaterThan(0);
  });
  it('persists a cancellation arriving before its paid request to prevent a race', async () => {
    upstream(); const app = setup(); const token = await app.login(); const request = payload();
    expect((await app.send('/cancel', { requestId: request.requestId }, token)).status).toBe(202);
    app.restart();
    expect((await app.send('/answer', request, token)).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expose upstream credential failure as an expired gateway session', async () => {
    upstream({}, 401); const app = setup(); const token = await app.login();
    expect((await app.send('/answer', payload(), token)).status).toBe(502);
  });
  it('settles real usage and retains it through new sessions and restarts', async () => {
    upstream(); const app = setup(); const token = await app.login();
    const result = await app.send('/answer', payload(), token);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ text: 'An answer', usage: { inputTokens: 100, outputTokens: 200 } });
    app.restart(); const nextToken = await app.login();
    const usage = await (await app.send('/usage', undefined, nextToken)).json();
    expect(usage).toMatchObject({ spentUsd: 0.00011, reservedUsd: 0, requests: 1 });
  });
  it('never executes a duplicate request id again, including after a restart', async () => {
    upstream(); const app = setup(); const token = await app.login(); const request = payload();
    expect((await app.send('/answer', request, token)).status).toBe(200);
    app.restart();
    expect((await app.send('/answer', request, token)).status).toBe(409);
    expect((await app.send('/answer', { ...request, question: 'Different question' }, token)).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('atomically rejects concurrent reservations that exceed the account budget', async () => {
    const app = setup('0.0015'); const token = await app.login();
    let release!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const big = { ...payload(), question: 'x'.repeat(1000), context: 'x'.repeat(1600), profile: 'x'.repeat(1800) };
    const first = app.send('/answer', big, token);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect((await app.send('/answer', { ...big, requestId: crypto.randomUUID() }, token)).status).toBe(402);
    release(Response.json(successBody)); await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a reservation when upstream usage is missing', async () => {
    upstream({ ...successBody, usage: undefined }); const app = setup(); const token = await app.login();
    expect((await app.send('/answer', payload(), token)).status).toBe(200);
    app.restart();
    const data = await (await app.send('/usage', undefined, token)).json() as { reservedUsd: number; spentUsd: number; unconfirmedRequests: number };
    expect(data.reservedUsd).toBeGreaterThan(0);
    expect(data.spentUsd).toBe(0);
    expect(data.unconfirmedRequests).toBe(1);
  });
  it('retains reservation on failed upstream and does not reveal its error body', async () => {
    upstream({ error: 'provider-secret-test and private transcript' }, 500); const app = setup(); const token = await app.login(); const request = payload();
    const result = await app.send('/answer', request, token);
    expect(result.status).toBe(502);
    expect(await result.text()).not.toMatch(/provider-secret|private transcript/);
    expect((await app.send('/answer', request, token)).status).toBe(409);
    const data = await (await app.send('/usage', undefined, token)).json() as { reservedUsd: number };
    expect(data.reservedUsd).toBeGreaterThan(0);
  });
  it('rejects invalid input before reserving or forwarding to a provider', async () => {
    upstream(); const app = setup(); const token = await app.login();
    for (const input of [{ ...payload(), question: 'x'.repeat(1001) }, { ...payload(), requestId: 'bad' }, { ...payload(), style: 'unlimited' }, { ...payload(), model: 'expensive-model' }]) expect((await app.send('/answer', input, token)).status).toBe(400);
    expect((await app.send('/translate', { requestId: crypto.randomUUID(), text: 'x'.repeat(1601) }, token)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(await (await app.send('/usage', undefined, token)).json()).toMatchObject({ spentUsd: 0, reservedUsd: 0, requests: 0 });
  });
  it('forwards only to its fixed upstream with a bounded output and no sensitive storage', async () => {
    upstream(); const app = setup(); const token = await app.login();
    await app.send('/answer', { ...payload(), question: 'PRIVATE QUESTION', profile: 'PRIVATE RESUME' }, token);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init!.redirect).toBe('manual');
    expect(JSON.parse(init!.body as string)).toMatchObject({ store: false, max_output_tokens: 800 });
    expect(JSON.stringify([...app.storage.values])).not.toMatch(/PRIVATE|provider-secret|private-access/);
  });
});
