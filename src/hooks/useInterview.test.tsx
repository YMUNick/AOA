// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiResult, Settings, SpeechState } from '../types';
import { DEFAULT_SETTINGS } from '../lib/session';
import { useInterview } from './useInterview';
import type { TabAudioCapture } from '../lib/tabAudio';

type SpeechCallbacks = {
  onFinal: (id: string, text: string) => void;
  onInterim: (text: string) => void;
  onState: (state: SpeechState) => void;
  onError: (message: string) => void;
  onUnconfirmed?: (id: string, text: string) => void;
};
const services = vi.hoisted(() => ({
  answer: vi.fn(), translate: vi.fn(),
  speech: [] as { callbacks: SpeechCallbacks; input?: TabAudioCapture; start: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }[],
}));
vi.mock('../lib/ai', () => ({ generateAnswer: services.answer, translateCloud: services.translate }));
vi.mock('../lib/speech', () => ({ SpeechController: class {
  static isSupported() { return true; }
  start = vi.fn(); pause = vi.fn(); stop = vi.fn();
  finish = vi.fn().mockResolvedValue(undefined);
  constructor(public callbacks: SpeechCallbacks, public input?: TabAudioCapture) { services.speech.push(this); }
} }));

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS, translationMode: 'cloud', apiKey: 'test-only-key', ...overrides,
});
const confirmed: AiResult = { text: '已翻譯', usage: { inputTokens: 100, outputTokens: 50 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  services.speech.length = 0;
  services.answer.mockReset().mockResolvedValue({ text: 'Suggested answer', usage: { inputTokens: 100, outputTokens: 50 } });
  services.translate.mockReset().mockResolvedValue(confirmed);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function capture() {
  let callbacks: { onBuffer: (ms: number) => void; onEnded: (message: string) => void };
  const input = {
    track: { kind: 'audio', readyState: 'live' } as MediaStreamTrack,
    setRecognitionActive: vi.fn(),
    setCallbacks: vi.fn((next: typeof callbacks) => { callbacks = next; }),
    finish: vi.fn().mockResolvedValue(true), close: vi.fn(),
  };
  return { input, buffer: (ms: number) => callbacks.onBuffer(ms), end: (message: string) => callbacks.onEnded(message) };
}

describe('meeting tab audio lifecycle', () => {
  it('never falls back to microphone without a selected tab capture, including resume', async () => {
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ audioSource: 'tab' }), false, null));
    expect(services.speech).toHaveLength(0);
    expect(result.current.error).toContain('分頁');
    act(() => result.current.resume());
    expect(services.speech).toHaveLength(0);
  });

  it('drains captured audio and accepts its trailing final before ending and closing the capture', async () => {
    const source = capture(), drained = deferred<boolean>(), speechFinished = deferred<void>();
    source.input.finish.mockReturnValue(drained.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ audioSource: 'tab', translationMode: 'off' }), false, null, source.input));
    const speech = services.speech[0]; speech.finish.mockReturnValue(speechFinished.promise);
    expect(speech.input).toBe(source.input);
    act(() => source.buffer(1200)); expect(result.current.bufferMs).toBe(1200);
    let finished!: Promise<void>;
    act(() => { finished = result.current.stop(); });
    expect(source.input.finish).toHaveBeenCalledTimes(1);
    expect(speech.finish).not.toHaveBeenCalled();
    expect(result.current.finishing).toBe(true); expect(result.current.ended).toBe(false);
    await act(async () => { drained.resolve(true); });
    expect(speech.finish).toHaveBeenCalledWith('stopped');
    act(() => speech.callbacks.onFinal('tail', 'The complete final sentence.'));
    expect(result.current.segments[0].english).toBe('The complete final sentence.');
    await act(async () => { speechFinished.resolve(); await finished; });
    expect(result.current.ended).toBe(true); expect(result.current.finishing).toBe(false);
    expect(source.input.close).toHaveBeenCalledTimes(1);
    act(() => speech.callbacks.onFinal('late', 'Ignore after the end.'));
    expect(result.current.segments).toHaveLength(1);
  });

  it('resumes with a newly chosen capture without resetting captions, selected text, or spent budget', async () => {
    const first = capture(), next = capture();
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ audioSource: 'tab' }), false, null, first.input));
    await act(async () => { services.speech[0].callbacks.onFinal('first', 'A saved question.'); });
    act(() => result.current.select('A saved question.', 'first'));
    const usage = { ...result.current.usage };
    await act(async () => { await result.current.pause(); });
    expect(first.input.close).toHaveBeenCalledTimes(1);
    act(() => result.current.resume(next.input));
    expect(services.speech).toHaveLength(2); expect(services.speech[1].input).toBe(next.input);
    expect(result.current.selected).toBe('A saved question.'); expect(result.current.usage).toEqual(usage);
    act(() => services.speech[0].callbacks.onFinal('stale', 'Stale input.'));
    await act(async () => { services.speech[1].callbacks.onFinal('second', 'Next question.'); });
    expect(result.current.segments.map(row => row.english)).toEqual(['A saved question.', 'Next question.']);
  });

  it('retains uncertain recognition as labelled text, including intentional repeated phrases', async () => {
    const source = capture(); const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ audioSource: 'tab' }), false, null, source.input));
    await act(async () => {
      services.speech[0].callbacks.onUnconfirmed?.('uncertain', 'Yes, yes.');
      services.speech[0].callbacks.onFinal('confirmed', 'Yes, yes.');
    });
    expect(result.current.segments).toHaveLength(2);
    expect(result.current.segments[0]).toMatchObject({ english: 'Yes, yes.', chinese: '已翻譯', recognitionState: 'unconfirmed' });
    expect(result.current.segments[1].recognitionState).toBeUndefined();
  });

  it('drains browser-ended input into a resumable pause and surfaces a bounded-buffer loss warning', async () => {
    const source = capture(); source.input.finish.mockResolvedValue(false);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ audioSource: 'tab', translationMode: 'off' }), false, null, source.input));
    await act(async () => { source.end('分頁分享已停止。'); });
    expect(result.current.speechState).toBe('paused'); expect(result.current.ended).toBe(false);
    expect(source.input.close).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toContain('未處理');
    expect(result.current.notice).toContain('分頁分享已停止');
  });

  it('drains an end notification replayed during callback attachment through the new captured-track recognizer', async () => {
    const source = capture(), drained = deferred<boolean>(); source.input.finish.mockReturnValue(drained.promise);
    source.input.setCallbacks.mockImplementation(callbacks => { callbacks.onBuffer(850); callbacks.onEnded('分頁已停止分享。'); });
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ audioSource: 'tab', translationMode: 'off' }), false, null, source.input));
    const speech = services.speech[0];
    expect(speech.start).toHaveBeenCalledTimes(1); expect(speech.input).toBe(source.input);
    expect(result.current.bufferMs).toBe(850); expect(result.current.finishing).toBe(true);
    act(() => speech.callbacks.onFinal('early-tail', 'Queued before sharing stopped.'));
    await act(async () => { drained.resolve(true); });
    expect(speech.finish).toHaveBeenCalledWith('paused');
    expect(result.current.speechState).toBe('paused');
    expect(result.current.segments[0].english).toBe('Queued before sharing stopped.');
  });

  it('closes capture on fatal recognition failure and unmount, without retaining a hidden queue', () => {
    const source = capture(); const { result, unmount } = renderHook(useInterview);
    act(() => result.current.start(settings({ audioSource: 'tab' }), false, null, source.input));
    act(() => services.speech[0].callbacks.onState('error'));
    expect(source.input.close).toHaveBeenCalledTimes(1);
    const next = capture(); act(() => result.current.resume(next.input));
    unmount(); expect(next.input.close).toHaveBeenCalledTimes(1);
  });

  it('does not let an old draining stop terminate a replacement session', async () => {
    const source = capture(), drained = deferred<boolean>(); source.input.finish.mockReturnValue(drained.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ audioSource: 'tab', translationMode: 'off' }), false, null, source.input));
    act(() => { void result.current.stop(); });
    act(() => result.current.start(settings({ translationMode: 'off' }), false, null));
    await act(async () => { drained.resolve(true); });
    expect(result.current.ended).toBe(false); expect(result.current.finishing).toBe(false);
    expect(result.current.sessionSettings?.audioSource).toBe('microphone');
    expect(services.speech[1].finish).not.toHaveBeenCalled();
  });
});

describe('interview translation lifecycle', () => {
  it.each([
    { mode: 'off' as const, message: '中文未啟用', nextMode: 'local' as const },
    { mode: 'local' as const, message: '中文翻譯目前無法使用', nextMode: 'cloud' as const },
  ])('explains unavailable Chinese in $mode mode without paid fallback and clears it in a ready new session', async ({ mode, message, nextMode }) => {
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ translationMode: mode }), false, null));
    expect(result.current.notice).toContain(message);
    expect(result.current.notice).toContain('新訪談');
    expect(result.current.sessionSettings?.translationMode).toBe(mode);
    await act(async () => { result.current.addManual('Keep my English caption.'); });
    await act(async () => { result.current.retryTranslation(result.current.segments[0]); });
    expect(result.current.segments[0].english).toBe('Keep my English caption.');
    expect(result.current.segments[0].chinese).toBe('');
    expect(services.translate).not.toHaveBeenCalled();
    expect(services.answer).not.toHaveBeenCalled();
    expect(result.current.usage).toMatchObject({ spent: 0, reserved: 0, unconfirmed: 0 });

    const local = { translate: vi.fn().mockResolvedValue('已就緒'), destroy: vi.fn() };
    act(() => result.current.start(settings({ translationMode: nextMode }), false, nextMode === 'local' ? local : null));
    expect(result.current.notice).toBe('');
    expect(services.translate).not.toHaveBeenCalled();
  });

  it('makes no paid or microphone calls in demo even with cloud settings, manual text, and retries', async () => {
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings(), true, null));
    await act(async () => { result.current.addManual('A new demo question.'); });
    await act(async () => { result.current.retryTranslation(result.current.segments[0]); await result.current.ask(); });
    expect(services.translate).not.toHaveBeenCalled();
    expect(services.answer).not.toHaveBeenCalled();
    expect(services.speech).toHaveLength(0);
    expect(result.current.notice).toContain('示範內容');
    expect(result.current.usage).toEqual({ spent: 0, reserved: 0, inputTokens: 0, outputTokens: 0, unconfirmed: 0 });
    expect(result.current.segments.at(-1)?.translationState).toBe('off');
  });

  it('marks cloud work unconfirmed after finalization and never starts its queued successors', async () => {
    const pending = deferred<AiResult>();
    services.translate.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings(), false, null));
    await act(async () => { result.current.addManual('First question.'); result.current.addManual('Second question.'); });
    await act(async () => { await result.current.stop(); });
    expect(result.current.notice).toContain('訪談已結束');
    expect(result.current.usage.unconfirmed).toBe(1);
    expect(result.current.usage.reserved).toBeGreaterThan(0);
    await act(async () => { pending.resolve(confirmed); });
    expect(services.translate).toHaveBeenCalledTimes(1);
    expect(result.current.segments.every(row => row.chinese === '' && row.translationState !== 'pending')).toBe(true);
    expect(result.current.usage).toMatchObject({ spent: 0.000035, reserved: 0, unconfirmed: 0 });
  });

  it('discards local translations that finish after stop and does not run their queued successors', async () => {
    const pending = deferred<string>();
    const local = { translate: vi.fn().mockReturnValueOnce(pending.promise), destroy: vi.fn() };
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ translationMode: 'local' }), false, local));
    await act(async () => { result.current.addManual('First.'); result.current.addManual('Second.'); });
    await act(async () => { await result.current.stop(); });
    await act(async () => { pending.resolve('遲來的翻譯'); });
    expect(local.translate).toHaveBeenCalledTimes(1);
    expect(result.current.segments.every(row => !row.chinese && row.translationState !== 'pending')).toBe(true);
    expect(services.translate).not.toHaveBeenCalled();
  });

  it('does not start paid translation for text added after the session has finalized', async () => {
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings(), false, null));
    await act(async () => { await result.current.stop(); result.current.addManual('Queued question.'); });
    expect(services.translate).not.toHaveBeenCalled();
    expect(result.current.usage.reserved).toBe(0);
    expect(result.current.segments[0].translationState).not.toBe('pending');
  });

  it('deduplicates a retried row while it is queued or already translating', async () => {
    const pending = deferred<AiResult>();
    services.translate.mockRejectedValueOnce(new Error('Temporary failure')).mockReturnValue(pending.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings(), false, null));
    await act(async () => { result.current.addManual('Try again.'); });
    const failed = result.current.segments[0];
    expect(failed.translationState).toBe('error');
    await act(async () => { result.current.retryTranslation(failed); result.current.retryTranslation(failed); });
    await act(async () => { result.current.retryTranslation(failed); pending.resolve(confirmed); });
    expect(services.translate).toHaveBeenCalledTimes(2);
    expect(result.current.segments[0].chinese).toBe('已翻譯');
  });

  it.each([
    { connectionMode: 'personal' as const, apiKey: ' ', sessionToken: 'stale-token' },
    { connectionMode: 'gateway' as const, apiKey: 'irrelevant-key', sessionToken: '' },
  ])('checks credentials for the selected $connectionMode mode before reserving', async config => {
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings(config), false, null));
    await act(async () => { result.current.addManual('Hello.'); });
    expect(services.translate).not.toHaveBeenCalled();
    expect(result.current.usage.reserved).toBe(0);
    expect(result.current.usage.unconfirmed).toBe(0);
    expect(result.current.segments[0].translationState).toBe('error');
  });

  it('splits long speech into bounded word-preserving segments with stable IDs', async () => {
    const text = Array.from({ length: 420 }, (_, i) => `word${i}`).join(' ');
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings(), false, null));
    await act(async () => { services.speech[0].callbacks.onFinal('speech-final', text); services.speech[0].callbacks.onFinal('speech-final', text); });
    expect(result.current.segments.length).toBeGreaterThan(1);
    expect(result.current.segments.every(row => row.english.length <= 1500)).toBe(true);
    expect(result.current.segments.map(row => row.english).join(' ')).toBe(text);
    expect(new Set(result.current.segments.map(row => row.id)).size).toBe(result.current.segments.length);
    expect(services.translate).toHaveBeenCalledTimes(result.current.segments.length);
    expect(services.translate.mock.calls.every(call => call[1].length <= 1600)).toBe(true);
  });

  it('reserves for JSON escaping before sending a cloud translation', async () => {
    services.translate.mockReturnValue(deferred<AiResult>().promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ budgetUsd: 0.0005 }), false, null));
    await act(async () => { result.current.addManual('\u0000'.repeat(500)); });
    expect(services.translate).not.toHaveBeenCalled();
    expect(result.current.usage.reserved).toBe(0);
    expect(result.current.segments[0].translationState).toBe('error');
  });

  it('keeps pause resumable while allowing already queued translations to finish', async () => {
    const pending = deferred<AiResult>();
    services.translate.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings(), false, null));
    await act(async () => { result.current.addManual('Hello.'); });
    await act(async () => { await result.current.pause(); });
    await act(async () => { pending.resolve(confirmed); });
    expect(result.current.ended).toBe(false);
    expect(result.current.speechState).toBe('paused');
    expect(result.current.segments[0].chinese).toBe('已翻譯');
    act(() => result.current.resume());
    expect(services.speech[0].start).toHaveBeenCalledTimes(2);
  });
});

describe('interview answer lifecycle', () => {
  it('accepts credentials during the same interview without resetting its transcript or budget', async () => {
    const pending = deferred<AiResult>();
    services.answer.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ apiKey: '', translationMode: 'off' }), false, null));
    act(() => result.current.addManual('Keep this interview question.'));
    const caption = result.current.segments[0];
    act(() => result.current.select(caption.english, caption.id));
    await act(async () => { await result.current.ask(); });
    expect(services.answer).not.toHaveBeenCalled();
    expect(result.current.answerError).toContain('本次設定');

    act(() => result.current.updateConnection({ apiKey: 'test-new-key', sessionToken: '', accessCode: '' }));
    await act(async () => { void result.current.ask(); });
    expect(services.answer).toHaveBeenCalledTimes(1);
    expect(services.answer.mock.calls[0][0].apiKey).toBe('test-new-key');
    expect(result.current.segments).toEqual([caption]);
    const reserved = result.current.usage.reserved;
    expect(reserved).toBeGreaterThan(0);

    const credentialsWithUnrelatedSettings = {
      apiKey: 'test-refreshed-key', sessionToken: 'new-token', accessCode: 'new-code',
      provider: 'gemini' as const, connectionMode: 'gateway' as const, budgetUsd: 20,
    };
    act(() => result.current.updateConnection(credentialsWithUnrelatedSettings));
    expect(result.current.sessionSettings).toMatchObject({
      apiKey: 'test-refreshed-key', sessionToken: 'new-token', accessCode: 'new-code',
      provider: 'openai', connectionMode: 'personal', budgetUsd: 0.5,
    });
    expect(result.current.usage.reserved).toBe(reserved);
    expect(result.current.selected).toBe(caption.english);
    expect(services.speech).toHaveLength(1);
    await act(async () => { pending.resolve(confirmed); });
    expect(result.current.answer).toBe('已翻譯');
    expect(result.current.usage).toMatchObject({ spent: 0.000035, reserved: 0, unconfirmed: 0 });
  });

  it('allows an explicit answer after the session ends and keeps the question snapshot stable', async () => {
    const pending = deferred<AiResult>();
    services.answer.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ translationMode: 'off' }), false, null));
    await act(async () => { result.current.select('Original question.'); await result.current.stop(); });
    await act(async () => { void result.current.ask(); });
    act(() => result.current.select('New selection.'));
    await act(async () => { pending.resolve({ text: 'Original answer.', usage: { inputTokens: 100, outputTokens: 50 } }); });
    expect(services.answer).toHaveBeenCalledTimes(1);
    expect(services.answer.mock.calls[0][1].question).toBe('Original question.');
    expect(result.current.answerQuestion).toBe('Original question.');
    expect(result.current.selected).toBe('New selection.');
    expect(result.current.answer).toBe('Original answer.');
  });

  it('ignores a previous session answer without changing the new session budget', async () => {
    const pending = deferred<AiResult>();
    services.answer.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ translationMode: 'off' }), false, null));
    act(() => result.current.select('Old question.'));
    await act(async () => { void result.current.ask(); });
    act(() => result.current.start(settings({ translationMode: 'off' }), false, null));
    await act(async () => { pending.resolve(confirmed); });
    expect(result.current.answer).toBe('');
    expect(result.current.answerBusy).toBe(false);
    expect(result.current.usage).toEqual({ spent: 0, reserved: 0, inputTokens: 0, outputTokens: 0, unconfirmed: 0 });
  });

  it('cancels immediately, retains unknown usage, and ignores a late canceled answer', async () => {
    const pending = deferred<AiResult>();
    services.answer.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ translationMode: 'off' }), false, null));
    act(() => result.current.select('Question.'));
    await act(async () => { void result.current.ask(); });
    act(() => result.current.cancelAnswer());
    expect(result.current.answerBusy).toBe(false);
    expect(result.current.usage.unconfirmed).toBe(1);
    expect(result.current.usage.reserved).toBeGreaterThan(0);
    await act(async () => { pending.resolve(confirmed); });
    expect(result.current.answer).toBe('');
    expect(result.current.usage).toMatchObject({ spent: 0.000035, reserved: 0, unconfirmed: 0 });
  });

  it('can request a fresh answer after stop without an older completion clearing it', async () => {
    const first = deferred<AiResult>();
    const second = deferred<AiResult>();
    services.answer.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(useInterview);
    act(() => result.current.start(settings({ translationMode: 'off' }), false, null));
    act(() => result.current.select('First question.'));
    await act(async () => { void result.current.ask(); });
    await act(async () => { await result.current.stop(); result.current.select('Second question.'); });
    await act(async () => { void result.current.ask(); });
    expect(services.answer).toHaveBeenCalledTimes(2);
    await act(async () => { first.resolve(confirmed); });
    expect(result.current.answerBusy).toBe(true);
    expect(result.current.answer).toBe('');
    await act(async () => { second.resolve({ text: 'Second answer.', usage: { inputTokens: 100, outputTokens: 50 } }); });
    expect(result.current.answer).toBe('Second answer.');
    expect(result.current.answerBusy).toBe(false);
  });
});
