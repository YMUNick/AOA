import type { AiResult, AnswerStyle, Settings } from '../types';
import { answerInput, boundedText, checkedOutput, GEMINI_ENDPOINT, GEMINI_MODEL, httpError, object, OPENAI_ENDPOINT, openaiBody, parseGemini, parseOpenAI, promptFor, PublicError, readJsonBounded, usageFrom } from '../../worker/src/protocol';
import type { AnswerRequest, Prompt } from '../../worker/src/protocol';

// Refreshed credentials live only as long as the in-memory settings snapshot.
const gatewaySessions = new WeakMap<Settings, { url: string; initialToken: string; token: string }>();

function gatewayBase(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new PublicError('代理網址須為完整 HTTPS 網址，且不可含帳密、查詢參數或片段。'); }
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new PublicError('請求已取消。', 499, 'cancelled');
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) { await response.body?.cancel(); throw httpError(response.status); }
    const data = await readJsonBounded(response);
    if (controller.signal.aborted) throw new Error('Aborted');
    return data;
  } catch (error) {
    if (timedOut) throw new PublicError('AI 連線逾時，已中止等待；費用可能仍需結算。', 504, 'timeout');
    if (signal?.aborted || controller.signal.aborted) throw new PublicError('請求已取消；已送出的用量可能仍會計費。', 499, 'cancelled');
    if (error instanceof PublicError) throw error;
    throw new PublicError('無法連線到 AI 服務，請檢查網路與瀏覽器連線限制。', 502, 'network_error');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function connectGateway(settings: Settings, signal?: AbortSignal): Promise<{token: string}> {
  const url = gatewayBase(settings.gatewayUrl);
  const accessCode = boundedText(settings.accessCode, '存取碼', 256, true);
  const data = object(await post(`${url}/session`, {}, { accessCode }, signal));
  if (typeof data.token !== 'string' || !data.token || data.token.length > 2048) throw new PublicError('代理驗證回應格式不正確。', 502, 'invalid_response');
  return { token: data.token };
}

async function notifyGatewayCancellation(url: string, token: string, requestId: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try { await post(`${url}/cancel`, { Authorization: `Bearer ${token}` }, { requestId }, controller.signal); }
  catch { /* Best effort: a disconnected browser cannot guarantee delivery. */ }
  finally { clearTimeout(timeout); }
}

async function generate(settings: Settings, kind: 'answer' | 'translate', input: AnswerRequest | string, prompt: Prompt, signal?: AbortSignal): Promise<AiResult> {
  if (settings.connectionMode === 'gateway') {
    const url = gatewayBase(settings.gatewayUrl);
    if (!settings.sessionToken || settings.sessionToken.length > 2048) throw new PublicError('請先測試私人代理連線。', 401, 'unauthorized');
    const payload = { requestId: crypto.randomUUID(), ...(kind === 'answer' ? input as AnswerRequest : { text: input }) };
    const cached = gatewaySessions.get(settings);
    let token = cached?.url === url && cached.initialToken === settings.sessionToken ? cached.token : settings.sessionToken;
    const cancel = () => { void notifyGatewayCancellation(url, token, payload.requestId); };
    signal?.addEventListener('abort', cancel, { once: true });
    let response: unknown;
    try {
      try { response = await post(`${url}/${kind}`, { Authorization: `Bearer ${token}` }, payload, signal); }
      catch (error) {
        // A gateway 401 is rejected before reservation. Reuse the same request id
        // for one retry, so even an unexpected late rejection cannot bill twice.
        if (!(error instanceof PublicError) || error.status !== 401) throw error;
        const latest = gatewaySessions.get(settings);
        token = latest?.url === url && latest.initialToken === settings.sessionToken && latest.token !== token
          ? latest.token : (await connectGateway(settings, signal)).token;
        gatewaySessions.set(settings, { url, initialToken: settings.sessionToken, token });
        response = await post(`${url}/${kind}`, { Authorization: `Bearer ${token}` }, payload, signal);
      }
    } catch (error) {
      if (error instanceof PublicError && error.code === 'timeout') cancel();
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
    const data = object(response);
    const usage = data.usage && typeof data.usage === 'object' ? data.usage as Record<string, unknown> : {};
    return checkedOutput(data.text, usageFrom(usage.inputTokens, usage.outputTokens));
  }
  const apiKey = boundedText(settings.apiKey, 'API 金鑰', 1024, true);
  if (settings.provider === 'openai') return parseOpenAI(await post(OPENAI_ENDPOINT, { Authorization: `Bearer ${apiKey}` }, openaiBody(prompt), signal));
  if (settings.provider === 'gemini') return parseGemini(await post(GEMINI_ENDPOINT, { 'x-goog-api-key': apiKey }, { model: GEMINI_MODEL, input: prompt.input, system_instruction: prompt.instructions, store: false, generation_config: { max_output_tokens: prompt.maxOutput, thinking_level: 'minimal' } }, signal));
  throw new PublicError('請選擇支援的模型服務。');
}

export async function generateAnswer(settings: Settings, request: { question: string; context: string; profile: string; style: AnswerStyle }, signal?: AbortSignal): Promise<AiResult> {
  const input = answerInput(request);
  return generate(settings, 'answer', input, promptFor('answer', input), signal);
}

export async function translateCloud(settings: Settings, text: string, signal?: AbortSignal): Promise<AiResult> {
  if (settings.translationMode !== 'cloud') throw new PublicError('請先明確啟用付費雲端翻譯。');
  const input = boundedText(text, '翻譯', 1600, true);
  return generate(settings, 'translate', input, promptFor('translate', input), signal);
}
