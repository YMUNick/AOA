// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { SpeechState } from './types';

type SpeechCallbacks = { onFinal: (id: string, text: string) => void; onInterim: (text: string) => void; onState: (state: SpeechState) => void; onError: (text: string) => void };
const services = vi.hoisted(() => ({
  availability: vi.fn(), prepare: vi.fn(), cloud: vi.fn(), answer: vi.fn(), connect: vi.fn(),
  speech: [] as { callbacks: SpeechCallbacks; start: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[],
}));
vi.mock('./lib/translator', () => ({ getTranslationAvailability: services.availability, createLocalTranslator: services.prepare }));
vi.mock('./lib/ai', () => ({ translateCloud: services.cloud, generateAnswer: services.answer, connectGateway: services.connect }));
vi.mock('./lib/speech', () => ({ SpeechController: class {
  static isSupported() { return true; }
  start = vi.fn(); pause = vi.fn(); stop = vi.fn();
  constructor(public callbacks: SpeechCallbacks) { services.speech.push(this); }
} }));

beforeEach(() => {
  services.speech.length = 0;
  services.availability.mockReset().mockResolvedValue('unavailable');
  services.prepare.mockReset().mockRejectedValue(new Error('此裝置沒有可用的本機翻譯。'));
  services.cloud.mockReset().mockResolvedValue({ text: '你如何處理緊迫期限？', usage: { inputTokens: 20, outputTokens: 15 } });
  services.answer.mockReset(); services.connect.mockReset().mockResolvedValue({ token: 'test-session-token' });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const key = () => screen.getByLabelText(/OpenAI API 金鑰/) as HTMLInputElement;
const mode = () => screen.getByLabelText('翻譯方式') as HTMLSelectElement;
async function start() { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '開始聆聽' })); }); }
async function renderApp() {
  await act(async () => { render(<App/>); });
}
function setMode(value: string) { fireEvent.change(mode(), { target: { value } }); }

describe('translation readiness before starting', () => {
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
    fireEvent.click(screen.getByRole('button', { name: '本次設定' }));
    expect(mode().disabled).toBe(true);
    expect(screen.getByText(/更改翻譯方式.*結束.*新訪談/)).toBeTruthy();
    fireEvent.change(key(), { target: { value: 'updated-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: '返回本次訪談' }));
    expect(screen.getByText('Keep this question.')).toBeTruthy();
    expect(services.speech).toHaveLength(1); expect(services.cloud).not.toHaveBeenCalled();
  });
});
