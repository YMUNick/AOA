// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { SpeechState } from './types';

type SpeechCallbacks = { onFinal: (id: string, text: string) => void; onInterim: (text: string) => void; onState: (state: SpeechState) => void; onError: (text: string) => void };
const services = vi.hoisted(() => ({
  availability: vi.fn(), prepare: vi.fn(), cloud: vi.fn(), answer: vi.fn(), connect: vi.fn(), tabAvailability: vi.fn(), pickTab: vi.fn(),
  speech: [] as { callbacks: SpeechCallbacks; capture?: unknown; start: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }[],
}));
vi.mock('./lib/translator', () => ({ getTranslationAvailability: services.availability, createLocalTranslator: services.prepare }));
vi.mock('./lib/ai', () => ({ translateCloud: services.cloud, generateAnswer: services.answer, connectGateway: services.connect }));
vi.mock('./lib/tabAudio', () => ({ getTabAudioAvailability: services.tabAvailability, requestTabAudio: services.pickTab }));
vi.mock('./lib/speech', () => ({ SpeechController: class {
  static isSupported() { return true; }
  start = vi.fn(); pause = vi.fn(); stop = vi.fn(); finish = vi.fn().mockResolvedValue(undefined);
  constructor(public callbacks: SpeechCallbacks, public capture?: unknown) { services.speech.push(this); }
} }));

beforeEach(() => {
  window.localStorage.clear();
  services.speech.length = 0;
  services.availability.mockReset().mockResolvedValue('unavailable');
  services.prepare.mockReset().mockRejectedValue(new Error('此裝置沒有可用的本機翻譯。'));
  services.tabAvailability.mockReset().mockReturnValue({ supported: true, reason: '' });
  services.pickTab.mockReset();
  services.cloud.mockReset().mockResolvedValue({ text: '你如何處理緊迫期限？', usage: { inputTokens: 20, outputTokens: 15 } });
  services.answer.mockReset(); services.connect.mockReset().mockResolvedValue({ token: 'test-session-token' });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const key = () => screen.getByLabelText(/OpenAI API 金鑰/) as HTMLInputElement;
const mode = () => screen.getByLabelText('翻譯方式') as HTMLSelectElement;
const source = () => screen.getByLabelText('收音來源') as HTMLSelectElement;
async function start() { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '開始聆聽' })); }); }
async function renderApp() {
  await act(async () => { render(<App/>); });
}
function setMode(value: string) { fireEvent.change(mode(), { target: { value } }); }

describe('translation readiness before starting', () => {
  it('offers alternatives immediately when local translation is confirmed unavailable without changing mode or starting services', async () => {
    await renderApp();
    expect(screen.getByRole('button', { name: '改用雲端翻譯（計費）' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '只用英文字幕' })).toBeTruthy();
    expect(mode().value).toBe('local');
    expect(services.prepare).not.toHaveBeenCalled(); expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('keeps preparation available for a downloadable model and exposes alternatives after a temporary preparation failure', async () => {
    services.availability.mockResolvedValue('downloadable');
    await renderApp();
    expect(screen.queryByRole('button', { name: '改用雲端翻譯（計費）' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '準備翻譯' })); });
    expect(screen.getByRole('button', { name: '改用雲端翻譯（計費）' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '準備翻譯' })).toBeTruthy();
    expect(services.speech).toHaveLength(0);
  });
  it('stays in setup after local preparation fails even when a personal key is present', async () => {
    await renderApp(); fireEvent.change(key(), { target: { value: 'test-only-key' } });
    expect(mode().value).toBe('local');
    await start();
    expect(screen.getByRole('heading', { name: '開始前，先設定好' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/本機翻譯/);
    expect(screen.queryByRole('log')).toBeNull();
    expect(services.speech).toHaveLength(0);
    expect(services.cloud).not.toHaveBeenCalled();
    expect(services.answer).not.toHaveBeenCalled();
  });

  it('offers explicit cloud mode after a failed preparation, preserves the key, and waits for Start', async () => {
    await renderApp(); fireEvent.change(key(), { target: { value: 'test-only-key' } }); await start();
    fireEvent.click(screen.getByRole('button', { name: '改用雲端翻譯（計費）' }));
    expect(mode().value).toBe('cloud'); expect(key().value).toBe('test-only-key');
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
    await start();
    expect(services.speech).toHaveLength(1);
    expect(services.speech[0].start).toHaveBeenCalledTimes(1);
    expect(services.cloud).not.toHaveBeenCalled();
    await act(async () => { services.speech[0].callbacks.onFinal('question', 'How do you handle a tight deadline?'); });
    expect(await screen.findByText('你如何處理緊迫期限？')).toBeTruthy();
    expect(services.cloud).toHaveBeenCalledTimes(1);
    expect(services.cloud.mock.calls[0][0]).toMatchObject({ translationMode: 'cloud', apiKey: 'test-only-key' });
  });

  it('allows explicit English-only mode after failure without starting until requested', async () => {
    await renderApp(); fireEvent.change(key(), { target: { value: 'test-only-key' } }); await start();
    fireEvent.click(screen.getByRole('button', { name: '只用英文字幕' }));
    expect(mode().value).toBe('off'); expect(key().value).toBe('test-only-key');
    expect(services.speech).toHaveLength(0);
    await start(); expect(services.speech).toHaveLength(1);
    await act(async () => { services.speech[0].callbacks.onFinal('off', 'An English question.'); });
    expect(screen.getByText('An English question.')).toBeTruthy();
    expect(services.cloud).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'x'.repeat(1025)])('blocks cloud with a missing or invalid personal key before using the microphone', async apiKey => {
    await renderApp(); setMode('cloud'); fireEvent.change(key(), { target: { value: apiKey } }); await start();
    expect(screen.getByRole('alert').textContent).toMatch(/API 金鑰/);
    expect(screen.getByRole('heading', { name: '開始前，先設定好' })).toBeTruthy();
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('requires a connected gateway token rather than accepting a personal key in gateway mode', async () => {
    await renderApp(); fireEvent.change(key(), { target: { value: 'test-only-key' } }); setMode('cloud');
    fireEvent.change(screen.getByLabelText('連線方式'), { target: { value: 'gateway' } });
    fireEvent.change(screen.getByLabelText('代理服務位址'), { target: { value: 'https://api.example.com' } });
    await start();
    expect(screen.getByRole('alert').textContent).toMatch(/代理/);
    expect(services.speech).toHaveLength(0); expect(services.connect).not.toHaveBeenCalled();
  });

  it.each(['http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com?key=x', 'https://api.example.com#token'])('rejects unsafe gateway configuration at Start even with a returned token: %s', async gatewayUrl => {
    await renderApp(); setMode('cloud');
    fireEvent.change(screen.getByLabelText('連線方式'), { target: { value: 'gateway' } });
    fireEvent.change(screen.getByLabelText('代理服務位址'), { target: { value: gatewayUrl } });
    fireEvent.change(screen.getByLabelText('私人存取碼'), { target: { value: 'test-access' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '連線代理' })); });
    await start();
    expect(screen.getByRole('alert').textContent).toMatch(/HTTPS/);
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('starts cloud mode after a safe gateway connection', async () => {
    await renderApp(); setMode('cloud');
    fireEvent.change(screen.getByLabelText('連線方式'), { target: { value: 'gateway' } });
    fireEvent.change(screen.getByLabelText('代理服務位址'), { target: { value: 'https://api.example.com' } });
    fireEvent.change(screen.getByLabelText('私人存取碼'), { target: { value: 'test-access' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '連線代理' })); });
    await start(); expect(services.speech).toHaveLength(1); expect(screen.getByRole('log')).toBeTruthy();
  });

  it('clears the missing-connection start error after the user successfully connects the gateway', async () => {
    await renderApp(); setMode('cloud');
    fireEvent.change(screen.getByLabelText('連線方式'), { target: { value: 'gateway' } });
    fireEvent.change(screen.getByLabelText('代理服務位址'), { target: { value: 'https://api.example.com' } });
    fireEvent.change(screen.getByLabelText('私人存取碼'), { target: { value: 'test-access' } });
    await start(); expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '連線代理' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('starts local translation only after preparation succeeds', async () => {
    const translator = { translate: vi.fn().mockResolvedValue('本機中文'), destroy: vi.fn() };
    services.prepare.mockResolvedValue(translator);
    await renderApp(); await start(); expect(services.speech).toHaveLength(1);
    await act(async () => { services.speech[0].callbacks.onFinal('local', 'Local question.'); });
    expect(await screen.findByText('本機中文')).toBeTruthy(); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('starts demo without local preparation, microphone access, or paid calls', async () => {
    await renderApp();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /先試用示範/ })); });
    expect(screen.getByRole('log')).toBeTruthy();
    expect(services.prepare).not.toHaveBeenCalled(); expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('keeps active-session translation locked and explains how to change it without deleting records', async () => {
    await renderApp(); setMode('off'); await start();
    await act(async () => { services.speech[0].callbacks.onFinal('saved', 'Keep this question.'); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '本次設定' })); });
    expect(mode().disabled).toBe(true);
    expect(source().disabled).toBe(true);
    expect(screen.getByText(/更改翻譯方式.*結束.*新訪談/)).toBeTruthy();
    fireEvent.change(key(), { target: { value: 'updated-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: '返回本次訪談' }));
    expect(screen.getByText('Keep this question.')).toBeTruthy();
    expect(services.speech).toHaveLength(1); expect(services.cloud).not.toHaveBeenCalled();
  });
});

describe('non-secret setup preferences', () => {
  const storageKey = 'aoa.preferences.v1';
  it('restores the explicitly chosen cloud provider and translation mode on a fresh mount without restoring a key or starting services', async () => {
    await renderApp();
    fireEvent.change(key(), { target: { value: 'test-only-key' } });
    setMode('cloud');
    fireEvent.change(screen.getByLabelText('AI 服務'), { target: { value: 'gemini' } });
    cleanup(); await renderApp();
    expect(mode().value).toBe('cloud');
    expect((screen.getByLabelText('AI 服務') as HTMLSelectElement).value).toBe('gemini');
    expect((screen.getByLabelText(/Gemini API 金鑰/) as HTMLInputElement).value).toBe('');
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled(); expect(services.connect).not.toHaveBeenCalled();
  });

  it('saves only the four preferences even when all session fields are populated and restores gateway mode without credentials', async () => {
    await renderApp();
    fireEvent.change(key(), { target: { value: 'test-only-key' } });
    fireEvent.change(screen.getByLabelText('應徵職位、真實經歷與擅長的能力'), { target: { value: 'Private profile fixture' } });
    fireEvent.change(screen.getByLabelText(/本次預算上限/), { target: { value: '8' } });
    setMode('cloud');
    fireEvent.change(screen.getByLabelText('連線方式'), { target: { value: 'gateway' } });
    fireEvent.change(screen.getByLabelText('代理服務位址'), { target: { value: 'https://private.example.com' } });
    fireEvent.change(screen.getByLabelText('私人存取碼'), { target: { value: 'private-access-fixture' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '連線代理' })); });
    setMode('off');
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual({ version: 1, translationMode: 'off', provider: 'openai', connectionMode: 'gateway', audioSource: 'microphone' });
    expect(window.localStorage.length).toBe(1);
    cleanup(); await renderApp();
    expect(mode().value).toBe('off');
    expect((screen.getByLabelText('連線方式') as HTMLSelectElement).value).toBe('gateway');
    expect((screen.getByLabelText('代理服務位址') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('私人存取碼') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/本次預算上限/) as HTMLInputElement).value).toBe('0.5');
    expect((screen.getByLabelText('應徵職位、真實經歷與擅長的能力') as HTMLTextAreaElement).value).toBe('');
    setMode('cloud'); await start();
    expect(screen.getByRole('alert').textContent).toMatch(/代理/);
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('does not write storage on initial load or while typing credentials and profile', async () => {
    const save = vi.spyOn(Storage.prototype, 'setItem');
    await renderApp();
    fireEvent.change(key(), { target: { value: 'test-only-key' } });
    fireEvent.change(screen.getByLabelText('應徵職位、真實經歷與擅長的能力'), { target: { value: 'Private fixture' } });
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    'not json', 'null', '[]',
    JSON.stringify({ version: 2, translationMode: 'cloud', provider: 'gemini', connectionMode: 'personal' }),
    JSON.stringify({ version: 1, translationMode: 'automatic', provider: 'openai', connectionMode: 'personal' }),
    JSON.stringify({ version: 1, translationMode: 'cloud', provider: 'unknown', connectionMode: 'personal' }),
    JSON.stringify({ version: 1, translationMode: 'cloud', provider: 'openai', connectionMode: 'unknown' }),
    JSON.stringify({ version: 1, translationMode: 'cloud', provider: 'gemini' }),
    JSON.stringify({ version: 1, translationMode: 'cloud', provider: 'gemini', connectionMode: 'personal', audioSource: 'system' }),
    JSON.stringify({ version: 1, translationMode: 'cloud', provider: 'gemini', connectionMode: 'personal', audioSource: null }),
  ])('ignores malformed or unsupported stored preferences: %s', async stored => {
    window.localStorage.setItem(storageKey, stored);
    await renderApp();
    expect(mode().value).toBe('local');
    expect((screen.getByLabelText('AI 服務') as HTMLSelectElement).value).toBe('openai');
    expect((screen.getByLabelText('連線方式') as HTMLSelectElement).value).toBe('personal');
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('reconstructs allowed preferences without importing extra stored settings or credentials', async () => {
    window.localStorage.setItem(storageKey, JSON.stringify({ version: 1, translationMode: 'cloud', provider: 'gemini', connectionMode: 'gateway', apiKey: 'injected-key-fixture', gatewayUrl: 'https://injected.example.com', accessCode: 'injected-access', sessionToken: 'injected-token', profile: 'injected profile', budgetUsd: 19 }));
    await renderApp();
    expect(mode().value).toBe('cloud');
    expect((screen.getByLabelText('AI 服務') as HTMLSelectElement).value).toBe('openai');
    expect((screen.getByLabelText('代理服務位址') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('私人存取碼') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/本次預算上限/) as HTMLInputElement).value).toBe('0.5');
    await start(); expect(screen.getByRole('alert').textContent).toMatch(/代理/); expect(services.speech).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('連線方式'), { target: { value: 'personal' } });
    expect(key().value).toBe('');
  });

  it('continues to allow explicit choices when storage reads and writes are denied', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    await renderApp(); expect(mode().value).toBe('local');
    setMode('cloud'); expect(mode().value).toBe('cloud');
    fireEvent.change(key(), { target: { value: 'test-only-key' } });
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
    await start(); expect(screen.getByRole('log')).toBeTruthy(); expect(services.speech).toHaveLength(1);
  });

  it('does not replace a restored cloud choice when the asynchronous local availability check completes', async () => {
    let resolve!: (status: string) => void;
    services.availability.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    window.localStorage.setItem(storageKey, JSON.stringify({ version: 1, translationMode: 'cloud', provider: 'openai', connectionMode: 'personal' }));
    await renderApp(); expect(mode().value).toBe('cloud');
    await act(async () => { resolve('unavailable'); });
    expect(mode().value).toBe('cloud');
    expect(screen.queryByRole('button', { name: '改用雲端翻譯（計費）' })).toBeNull();
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled(); expect(services.prepare).not.toHaveBeenCalled();
  });

  it('restores older preferences without an audio source using the microphone default', async () => {
    window.localStorage.setItem(storageKey, JSON.stringify({ version: 1, translationMode: 'off', provider: 'gemini', connectionMode: 'personal' }));
    await renderApp();
    expect(mode().value).toBe('off'); expect(source().value).toBe('microphone');
    expect(services.speech).toHaveLength(0);
  });

  it('remembers an explicit tab source without persisting secrets or starting capture on reload', async () => {
    await renderApp();
    fireEvent.change(key(), { target: { value: 'test-key' } });
    fireEvent.change(source(), { target: { value: 'tab' } });
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual({ version: 1, translationMode: 'local', provider: 'openai', connectionMode: 'personal', audioSource: 'tab' });
    cleanup(); await renderApp();
    expect(source().value).toBe('tab'); expect(key().value).toBe('');
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
    expect(services.pickTab).not.toHaveBeenCalled();
  });
});

describe('explicit tab audio setup', () => {
  function capture() {
    return { track: Object.assign(new EventTarget(), { kind: 'audio', readyState: 'live' }) as MediaStreamTrack, setRecognitionActive: vi.fn(), setCallbacks: vi.fn(), finish: vi.fn().mockResolvedValue(true), close: vi.fn() };
  }
  function chooseTab() { fireEvent.change(source(), { target: { value: 'tab' } }); }
  const tabStart = () => screen.getByRole('button', { name: '選擇會議分頁並開始' });

  it('requests the picker in the Start gesture and starts with the selected capture only after it resolves', async () => {
    const input = capture();
    let resolve!: (value: ReturnType<typeof capture>) => void;
    services.pickTab.mockReturnValue(new Promise(done => { resolve = done; }));
    await renderApp(); chooseTab(); setMode('cloud'); fireEvent.change(key(), { target: { value: 'test-only-key' } });
    expect(services.pickTab).not.toHaveBeenCalled(); expect(services.cloud).not.toHaveBeenCalled();
    fireEvent.click(tabStart());
    expect(services.pickTab).toHaveBeenCalledTimes(1);
    expect(services.speech).toHaveLength(0); expect(screen.queryByRole('log')).toBeNull();
    await act(async () => { resolve(input); });
    expect(screen.getByRole('log')).toBeTruthy(); expect(services.speech).toHaveLength(1);
    expect(services.speech[0].capture).toBe(input); expect(services.speech[0].start).toHaveBeenCalledTimes(1);
    expect(input.close).not.toHaveBeenCalled(); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('runs cloud credential validation before opening the picker', async () => {
    await renderApp(); chooseTab(); setMode('cloud');
    await act(async () => { fireEvent.click(tabStart()); });
    expect(screen.getByRole('alert').textContent).toMatch(/API 金鑰/);
    expect(services.pickTab).not.toHaveBeenCalled(); expect(services.speech).toHaveLength(0);
  });

  it.each([
    new DOMException('Permission dismissed', 'NotAllowedError'),
    new DOMException('Selection cancelled', 'AbortError'),
    new Error('尚未分享分頁音訊。請重新選擇，並勾選「分享分頁音訊」。'),
  ])('keeps setup and the selected source after picker cancellation or missing audio: %s', async failure => {
    services.pickTab.mockRejectedValue(failure);
    await renderApp(); chooseTab(); setMode('off');
    await act(async () => { fireEvent.click(tabStart()); });
    expect(screen.getByRole('heading', { name: '開始前，先設定好' })).toBeTruthy(); expect(source().value).toBe('tab');
    expect(screen.getByRole('alert').textContent).toMatch(/取消|分享分頁音訊/);
    expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled(); expect(screen.queryByRole('log')).toBeNull();
    expect((tabStart() as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows unavailable support without changing a saved tab source or opening the picker', async () => {
    services.tabAvailability.mockReturnValue({ supported: false, reason: '會議分頁音訊需使用電腦版 Chrome；這台裝置可使用麥克風。' });
    window.localStorage.setItem('aoa.preferences.v1', JSON.stringify({ version: 1, audioSource: 'tab', translationMode: 'off', provider: 'openai', connectionMode: 'personal' }));
    await renderApp();
    expect(source().value).toBe('tab'); expect(screen.getByText(/這台裝置可使用麥克風/)).toBeTruthy();
    expect((tabStart() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tabStart());
    expect(services.pickTab).not.toHaveBeenCalled(); expect(services.speech).toHaveLength(0);
  });

  it('prepares local translation first and requires another explicit click to open the picker', async () => {
    services.prepare.mockResolvedValue({ translate: vi.fn(), destroy: vi.fn() });
    const input = capture(); services.pickTab.mockResolvedValue(input);
    await renderApp(); chooseTab();
    await act(async () => { fireEvent.click(tabStart()); });
    expect(services.prepare).toHaveBeenCalledTimes(1); expect(services.pickTab).not.toHaveBeenCalled(); expect(services.speech).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/再按|再次/);
    await act(async () => { fireEvent.click(tabStart()); });
    expect(services.pickTab).toHaveBeenCalledTimes(1); expect(screen.getByRole('log')).toBeTruthy();
    expect(services.speech[0].capture).toBe(input);
  });

  it('closes a late picker result after unmount without starting a session', async () => {
    const input = capture(); let resolve!: (value: ReturnType<typeof capture>) => void;
    services.pickTab.mockReturnValue(new Promise(done => { resolve = done; }));
    await renderApp(); chooseTab(); setMode('off'); fireEvent.click(tabStart());
    cleanup(); await act(async () => { resolve(input); });
    expect(input.close).toHaveBeenCalledTimes(1); expect(services.speech).toHaveLength(0); expect(services.cloud).not.toHaveBeenCalled();
  });

  it('closes a late picker result after leaving the pending start', async () => {
    const input = capture(); let resolve!: (value: ReturnType<typeof capture>) => void;
    services.pickTab.mockReturnValue(new Promise(done => { resolve = done; }));
    await renderApp(); chooseTab(); setMode('off'); fireEvent.click(tabStart());
    fireEvent.click(screen.getByRole('button', { name: '開始' }));
    await act(async () => { resolve(input); });
    expect(input.close).toHaveBeenCalledTimes(1); expect(screen.queryByRole('log')).toBeNull(); expect(services.speech).toHaveLength(0);
    expect((tabStart() as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses demo with a tab preference without opening the picker or starting recognition', async () => {
    await renderApp(); chooseTab();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /先試用示範/ })); });
    expect(screen.getByRole('log')).toBeTruthy(); expect(services.pickTab).not.toHaveBeenCalled(); expect(services.speech).toHaveLength(0);
  });
});
