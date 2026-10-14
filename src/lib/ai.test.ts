import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectGateway, generateAnswer, translateCloud } from './ai';
import type { Settings } from '../types';

const settings: Settings = { connectionMode: 'personal', provider: 'openai', apiKey: 'test-only-key', gatewayUrl: 'https://gateway.example', accessCode: 'private-code', sessionToken: 'session-token', translationMode: 'cloud', profile: '', budgetUsd: 1, expectedAnswers: 20, answerStyle: 'concise' };
const question = { question: 'Tell me about yourself.', context: '', profile: '', style: 'concise' as const };
const openai = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'English answer\n中文重點' }] }], usage: { input_tokens: 40, output_tokens: 120, output_tokens_details: { reasoning_tokens: 20 } } };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const respond = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('AI provider boundary', () => {
  it('caps billed output and does not double count OpenAI reasoning tokens', async () => {
    respond(openai);
    expect(await generateAnswer(settings, question)).toEqual({ text: 'English answer\n中文重點', usage: { inputTokens: 40, outputTokens: 120 } });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: 'gpt-6-luna', store: false, max_output_tokens: 800, reasoning: { effort: 'none' } });
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer test-only-key');
  });
  it('sends STAR and translation with distinct output caps', async () => {
    respond(openai);
    await generateAnswer(settings, { ...question, style: 'star' });
    await translateCloud(settings, 'Good morning');
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string).max_output_tokens)).toEqual([1000, 500]);
  });
  it('counts Gemini thoughts and hides thought summaries', async () => {
    respond({ status: 'completed', steps: [{ type: 'thought', summary: [{ type: 'text', text: 'private reasoning' }] }, { type: 'model_output', content: [{ type: 'text', text: 'Good answer' }] }], usage: { total_input_tokens: 30, total_output_tokens: 50, total_thought_tokens: 20 } });
    expect(await generateAnswer({ ...settings, provider: 'gemini' }, question)).toEqual({ text: 'Good answer', usage: { inputTokens: 30, outputTokens: 70 } });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(new Headers(init!.headers).get('x-goog-api-key')).toBe('test-only-key');
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: 'gemini-3.5-flash-lite', store: false, generation_config: { max_output_tokens: 800, thinking_level: 'minimal' } });
  });
  it.each([['question', 1001], ['context', 1601], ['profile', 1801]] as const)('rejects overlong %s before any network use', async (field, length) => {
    respond(openai);
    await expect(generateAnswer(settings, { ...question, [field]: 'x'.repeat(length) })).rejects.toThrow(/字元/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects empty input and cloud translation without explicit selection', async () => {
    respond(openai);
    await expect(generateAnswer(settings, { ...question, question: '  ' })).rejects.toThrow(/內容/);
    await expect(translateCloud({ ...settings, translationMode: 'local' }, 'Hello')).rejects.toThrow(/雲端/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500])('maps HTTP %d without exposing provider error bodies', async (status) => {
    respond({ error: { message: 'SECRET PROMPT OR KEY' } }, status);
    await expect(generateAnswer(settings, question)).rejects.toThrow(/驗證|權限|頻繁|服務/);
    await expect(generateAnswer(settings, question)).rejects.not.toThrow(/SECRET/);
  });
  it('rejects a malformed success body', async () => {
    respond({ output: 'not-an-array' });
    await expect(generateAnswer(settings, question)).rejects.toThrow(/回應/);
  });
  it('retains unknown usage rather than treating it as free', async () => {
    respond({ ...openai, usage: undefined });
    expect((await generateAnswer(settings, question)).usage).toBeUndefined();
  });
  it('aborts an in-flight fetch and reports cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const controller = new AbortController();
    const pending = generateAnswer(settings, question, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/取消/);
    expect((vi.mocked(fetch).mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
  });
  it('does not send an already-cancelled request', async () => {
    respond(openai);
    const controller = new AbortController(); controller.abort();
    await expect(generateAnswer(settings, question, controller.signal)).rejects.toThrow(/取消/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('aborts at its timeout instead of leaving the network request running', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const pending = generateAnswer(settings, question);
    const assertion = expect(pending).rejects.toThrow(/逾時/);
    await vi.advanceTimersByTimeAsync(45_000);
    await assertion;
  });
});

describe('gateway client', () => {
  it('notifies the authenticated cancellation endpoint when aborting a paid request', async () => {
    vi.stubGlobal('fetch', vi.fn((url, init) => String(url).endsWith('/cancel') ? Promise.resolve(Response.json({ cancelled: true }, { status: 202 })) : new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const controller = new AbortController();
    const pending = generateAnswer({ ...settings, connectionMode: 'gateway' }, question, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/取消/);
    const cancel = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/cancel'));
    expect(cancel).toBeDefined();
    expect(new Headers(cancel![1]!.headers).get('Authorization')).toBe('Bearer session-token');
    expect(JSON.parse(cancel![1]!.body as string).requestId).toBe(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).requestId);
  });
  it('refreshes an expired session once and preserves the same paid request id', async () => {
    const gatewaySettings = { ...settings, connectionMode: 'gateway' as const };
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const call = { url: String(url), body: JSON.parse(init.body), auth: new Headers(init.headers).get('Authorization') }; calls.push(call);
      if (call.url.endsWith('/session')) return Response.json({ token: 'refreshed-token' });
      if (call.auth === 'Bearer session-token') return Response.json({ error: 'expired' }, { status: 401 });
      return Response.json({ text: 'A good answer', usage: { inputTokens: 2, outputTokens: 3 } });
    }));
    expect((await generateAnswer(gatewaySettings, question)).text).toBe('A good answer');
    expect(calls.map(call => call.url)).toEqual(['https://gateway.example/answer', 'https://gateway.example/session', 'https://gateway.example/answer']);
    expect(calls[2].body.requestId).toBe(calls[0].body.requestId);
    await generateAnswer(gatewaySettings, question);
    expect(calls).toHaveLength(4);
    expect(calls[3].auth).toBe('Bearer refreshed-token');
  });
  it('does not loop when an expired session cannot be refreshed', async () => {
    respond({ error: 'invalid' }, 401);
    await expect(generateAnswer({ ...settings, connectionMode: 'gateway' }, question)).rejects.toThrow(/驗證|過期/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retries at most once if the refreshed session is also rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/session') ? Response.json({ token: 'also-rejected' }) : Response.json({}, { status: 401 })));
    await expect(generateAnswer({ ...settings, connectionMode: 'gateway' }, question)).rejects.toThrow(/驗證|過期/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('never attempts a gateway refresh for a personal provider authentication error', async () => {
    respond({}, 401);
    await expect(generateAnswer(settings, question)).rejects.toThrow(/驗證/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('exchanges the access code for a short-lived session without sending provider keys', async () => {
    respond({ token: 'signed-token' });
    expect(await connectGateway({ ...settings, connectionMode: 'gateway' })).toEqual({ token: 'signed-token' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://gateway.example/session');
    expect(JSON.parse(init!.body as string)).toEqual({ accessCode: 'private-code' });
    expect(JSON.stringify(init)).not.toContain('test-only-key');
  });
  it('requires HTTPS and rejects credentials, query strings and URL fragments', async () => {
    respond({ token: 'token' });
    for (const gatewayUrl of ['http://gateway.example', 'https://user:pass@gateway.example', 'https://gateway.example?key=bad', 'https://gateway.example/#key']) {
      await expect(connectGateway({ ...settings, gatewayUrl })).rejects.toThrow(/網址/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('authenticates paid requests and sends a fresh deduplication id', async () => {
    respond({ text: 'Answer', usage: { inputTokens: 2, outputTokens: 3 } });
    await generateAnswer({ ...settings, connectionMode: 'gateway' }, question);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://gateway.example/answer');
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer session-token');
    expect(JSON.parse(init!.body as string).requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(init)).not.toContain('test-only-key');
  });
  it('rejects malformed gateway responses and negative usage', async () => {
    respond({ token: 4 });
    await expect(connectGateway(settings)).rejects.toThrow(/回應/);
    respond({ text: 'Answer', usage: { inputTokens: -1, outputTokens: 2 } });
    expect((await generateAnswer({ ...settings, connectionMode: 'gateway' }, question)).usage).toBeUndefined();
  });
});
