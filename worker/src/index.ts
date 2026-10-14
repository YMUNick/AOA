import { answerInput, boundedText, httpError, object, OPENAI_ENDPOINT, OPENAI_MODEL, openaiBody, parseOpenAI, PRICING_DATE, promptFor, PublicError, readJsonBounded } from './protocol';
import type { AiResult, Prompt, Usage } from './protocol';

export interface Store { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; transaction<T>(body: (tx: Store) => Promise<T>): Promise<T>; }
export interface Env { OPENAI_API_KEY: string; ACCESS_CODE: string; SESSION_SECRET: string; ALLOWED_ORIGIN: string; ACCOUNT_DAILY_BUDGET_USD?: string; BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }; }

interface Ledger { spentNano: number; reservedNano: number; requests: number; unconfirmedRequests: number; }
interface Reservation { day: string; reserveNano: number; status: 'pending' | 'settled' | 'unconfirmed' | 'cancelled'; cancelRequested?: boolean; }
interface Rate { minute: number; total: number; clients: Record<string, number>; }
const encoder = new TextEncoder();
const emptyLedger = (): Ledger => ({ spentNano: 0, reservedNano: 0, requests: 0, unconfirmedRequests: 0 });
const dayNow = () => new Date().toISOString().slice(0, 10);
const costNano = (usage: Usage) => usage.inputTokens * 100 + usage.outputTokens * 500;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(text: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}
async function key(secret: string) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function digest(text: string) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))); }
async function sameSecret(left: string, right: string) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]; return difference === 0;
}
async function issueToken(secret: string): Promise<string> {
  const issued = Math.floor(Date.now() / 1000);
  const payload = encode(encoder.encode(JSON.stringify({ sub: 'owner', aud: 'aoa', iat: issued, exp: issued + 3600, jti: crypto.randomUUID() })));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
async function authenticate(request: Request, secret: string): Promise<void> {
  const header = request.headers.get('Authorization') ?? '';
  try {
    if (!header.startsWith('Bearer ') || header.length > 2055) throw new Error();
    const parts = header.slice(7).split('.'); if (parts.length !== 2) throw new Error();
    const [payload, signature] = parts;
    if (!await crypto.subtle.verify('HMAC', await key(secret), decode(signature), encoder.encode(payload))) throw new Error();
    const token = object(JSON.parse(new TextDecoder().decode(decode(payload))));
    const now = Math.floor(Date.now() / 1000);
    if (token.sub !== 'owner' || token.aud !== 'aoa' || typeof token.iat !== 'number' || typeof token.exp !== 'number' || !Number.isSafeInteger(token.iat) || !Number.isSafeInteger(token.exp) || token.iat > now + 30 || token.exp <= now || token.exp - token.iat !== 3600) throw new Error();
  } catch { throw httpError(401); }
}
async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new PublicError('請使用 JSON 格式傳送內容。', 415);
  if (Number(request.headers.get('Content-Length')) > 24576) throw new PublicError('請求內容過長。', 413);
  try { return object(await readJsonBounded(new Response(request.body), 24576)); }
  catch { throw new PublicError('請求格式不正確或內容過長。', 400); }
}
function exactFields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(field => !allowed.includes(field))) throw new PublicError('請求包含不支援的欄位。');
}
function requestIdFrom(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new PublicError('請求識別碼格式不正確。');
  return value.toLowerCase();
}
function publicFailure(error: unknown): Response {
  const safe = error instanceof PublicError ? error : new PublicError('私人代理暫時無法使用，請稍後再試。', 503, 'unavailable');
  const response = json({ error: { code: safe.code, message: safe.message } }, safe.status);
  if (safe.status === 429) response.headers.set('Retry-After', '60');
  return response;
}

// Fetch-only Durable Object class. Its stable namespace id is the single private account,
// never a browser session. All accounting mutations use storage transactions.
export class AccountBudget {
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly state: { storage: Store }, private readonly env: Env) {}

  private budgetNano(): number {
    const value = Number(this.env.ACCOUNT_DAILY_BUDGET_USD ?? '2');
    if (!Number.isFinite(value) || value <= 0 || value > 100) throw new PublicError('代理的每日預算設定無效。', 503, 'configuration_error');
    return Math.floor(value * 1e9);
  }

  private async login(request: Request): Promise<Response> {
    const client = encode(await digest(`${this.env.SESSION_SECRET}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`));
    await this.state.storage.transaction(async tx => {
      const minute = Math.floor(Date.now() / 60000);
      let rate = await tx.get<Rate>('auth-rate');
      if (!rate || rate.minute !== minute) rate = { minute, total: 0, clients: {} };
      if (rate.total >= 30 || (rate.clients[client] ?? 0) >= 5) throw httpError(429);
      rate.total++; rate.clients[client] = (rate.clients[client] ?? 0) + 1;
      await tx.put('auth-rate', rate);
    });
    const body = await bodyJson(request); exactFields(body, ['accessCode']);
    const code = boundedText(body.accessCode, '存取碼', 256, true);
    if (!await sameSecret(code, this.env.ACCESS_CODE)) throw httpError(401);
    return json({ token: await issueToken(this.env.SESSION_SECRET), expiresIn: 3600 });
  }

  private async reserve(requestId: string, prompt: Prompt): Promise<Reservation> {
    // UTF-8 byte count is deliberately pessimistic for text tokenization. Include
    // extra framing allowance; no tools, images, previous turns or hidden histories.
    const inputUpperBound = encoder.encode(prompt.instructions + prompt.input).byteLength + 512;
    const reserveNano = costNano({ inputTokens: inputUpperBound, outputTokens: prompt.maxOutput });
    const day = dayNow();
    return this.state.storage.transaction(async tx => {
      if (await tx.get(`request:${requestId}`)) throw httpError(409);
      const ledger = await tx.get<Ledger>(`day:${day}`) ?? emptyLedger();
      if (ledger.spentNano + ledger.reservedNano + reserveNano > this.budgetNano()) throw httpError(402);
      const now = Date.now();
      const active = await tx.get<Record<string, number>>('active') ?? {};
      for (const [id, until] of Object.entries(active)) if (until <= now) delete active[id];
      if (Object.keys(active).length >= 2) throw httpError(429);
      const minute = Math.floor(now / 60000);
      let rate = await tx.get<{ minute: number; count: number }>('paid-rate');
      if (!rate || rate.minute !== minute) rate = { minute, count: 0 };
      if (rate.count >= 60 || ledger.requests >= 5000) throw httpError(429);
      const reservation: Reservation = { day, reserveNano, status: 'pending' };
      ledger.reservedNano += reserveNano; ledger.requests++; ledger.unconfirmedRequests++;
      active[requestId] = now + 60000; rate.count++;
      await tx.put(`request:${requestId}`, reservation);
      await tx.put(`day:${day}`, ledger); await tx.put('active', active); await tx.put('paid-rate', rate);
      return reservation;
    });
  }

  private async settle(requestId: string, reservation: Reservation, usage?: Usage): Promise<void> {
    await this.state.storage.transaction(async tx => {
      const existing = await tx.get<Reservation>(`request:${requestId}`);
      if (!existing || existing.status !== 'pending') return;
      const ledger = await tx.get<Ledger>(`day:${reservation.day}`) ?? emptyLedger();
      const active = await tx.get<Record<string, number>>('active') ?? {}; delete active[requestId];
      if (usage) {
        ledger.spentNano += costNano(usage); ledger.reservedNano -= reservation.reserveNano; ledger.unconfirmedRequests--;
      }
      await tx.put(`request:${requestId}`, { ...reservation, status: usage ? 'settled' : 'unconfirmed' });
      await tx.put(`day:${reservation.day}`, ledger); await tx.put('active', active);
    });
  }

  private async cancel(request: Request): Promise<Response> {
    const body = await bodyJson(request); exactFields(body, ['requestId']);
    const requestId = requestIdFrom(body.requestId);
    await this.state.storage.transaction(async tx => {
      const minute = Math.floor(Date.now() / 60000);
      let rate = await tx.get<{ minute: number; count: number }>('cancel-rate');
      if (!rate || rate.minute !== minute) rate = { minute, count: 0 };
      if (rate.count >= 120) throw httpError(429);
      rate.count++; await tx.put('cancel-rate', rate);
      const existing = await tx.get<Reservation>(`request:${requestId}`);
      // A cancellation can arrive before the original network request. Persist
      // a tombstone so that a late delivery can never start paid work.
      await tx.put(`request:${requestId}`, existing ? { ...existing, cancelRequested: true } : { day: dayNow(), reserveNano: 0, status: 'cancelled', cancelRequested: true });
    });
    this.controllers.get(requestId)?.abort();
    return json({ cancelled: true }, 202);
  }

  private async paid(request: Request, kind: 'answer' | 'translate'): Promise<Response> {
    const body = await bodyJson(request);
    exactFields(body, kind === 'answer' ? ['requestId', 'question', 'context', 'profile', 'style'] : ['requestId', 'text']);
    const requestId = requestIdFrom(body.requestId);
    const input = kind === 'answer' ? answerInput(body) : boundedText(body.text, '翻譯', 1600, true);
    const prompt = promptFor(kind, input);
    if (request.signal.aborted) throw new PublicError('請求已取消。', 499, 'cancelled');
    const reservation = await this.reserve(requestId, prompt);
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), 40000);
    let result: AiResult | undefined;
    try {
      if ((await this.state.storage.get<Reservation>(`request:${requestId}`))?.cancelRequested) controller.abort();
      const response = await fetch(OPENAI_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.env.OPENAI_API_KEY}` }, body: JSON.stringify(openaiBody(prompt)), signal: controller.signal, redirect: 'manual' });
      if (!response.ok) {
        await response.body?.cancel();
        // Reserve 401 for gateway authentication, so the browser never tries to
        // refresh its session in response to a provider's server-key failure.
        if (response.status === 401 || response.status === 403) throw new PublicError('代理的模型服務驗證失敗，請檢查伺服器金鑰與模型權限。', 502, 'upstream_auth_error');
        throw httpError(response.status);
      }
      result = parseOpenAI(await readJsonBounded(response));
      return json(result);
    } catch (error) {
      if (controller.signal.aborted) throw new PublicError('AI 服務逾時或請求已取消；未確認費用會繼續預留。', 504, 'timeout');
      if (error instanceof PublicError) throw error;
      throw new PublicError('無法連線到 AI 服務；未確認費用會繼續預留。', 502, 'upstream_error');
    } finally {
      clearTimeout(timeout); request.signal.removeEventListener('abort', abort);
      this.controllers.delete(requestId);
      await this.settle(requestId, reservation, result?.usage);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/session' && request.method === 'POST') return await this.login(request);
      await authenticate(request, this.env.SESSION_SECRET);
      if (path === '/cancel' && request.method === 'POST') return await this.cancel(request);
      if (path === '/usage' && request.method === 'GET') {
        const day = dayNow(); const ledger = await this.state.storage.get<Ledger>(`day:${day}`) ?? emptyLedger();
        return json({ day, resetTimeZone: 'UTC', spentUsd: ledger.spentNano / 1e9, reservedUsd: ledger.reservedNano / 1e9, budgetUsd: this.budgetNano() / 1e9, requests: ledger.requests, unconfirmedRequests: ledger.unconfirmedRequests });
      }
      if (request.method === 'POST' && (path === '/answer' || path === '/translate')) return await this.paid(request, path.slice(1) as 'answer' | 'translate');
      return json({ error: { code: 'not_found', message: '找不到此服務。' } }, 404);
    } catch (error) { return publicFailure(error); }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowed = env.ALLOWED_ORIGIN || 'https://ymunick.github.io';
    const origin = request.headers.get('Origin');
    if (origin && origin !== allowed) return publicFailure(httpError(403));
    let response: Response;
    try {
      const url = new URL(request.url);
      if (!['/session', '/capabilities', '/answer', '/translate', '/cancel', '/usage'].includes(url.pathname) || url.search) response = json({ error: { code: 'not_found', message: '找不到此服務。' } }, 404);
      else if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else if (request.method === 'GET' && url.pathname === '/capabilities') response = json({ provider: 'openai', model: OPENAI_MODEL, pricingDate: PRICING_DATE, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5, streaming: false, translation: true, auth: 'bearer', sessionLifetimeSeconds: 3600, maxOutputTokens: { concise: 800, star: 1000, translate: 500 } });
      else {
        if (!env.OPENAI_API_KEY || env.ACCESS_CODE?.length < 16 || env.SESSION_SECRET?.length < 32 || !env.ACCESS_CODE || !env.SESSION_SECRET) throw new PublicError('私人代理尚未完成秘密金鑰設定。', 503, 'configuration_error');
        response = await env.BUDGET.get(env.BUDGET.idFromName('private-owner-v1')).fetch(request);
      }
    } catch (error) { response = publicFailure(error); }
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', allowed); headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Max-Age', '600'); headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  },
};
