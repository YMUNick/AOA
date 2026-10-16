// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiResult } from '../types';
import { DEFAULT_SETTINGS } from '../lib/session';
import { useInterview } from './useInterview';

const cloud = vi.hoisted(() => ({ answer: vi.fn(), translate: vi.fn() }));
vi.mock('../lib/ai', () => ({ generateAnswer: cloud.answer, translateCloud: cloud.translate }));

type Result = { isFinal: boolean; length: number; 0: { transcript: string; confidence: number } };
type ResultEvent = { resultIndex: number; results: Result[] };

// The actual hook and SpeechController run together; only external browser/services are simulated.
class SimulatedRecognition {
  static instances: SimulatedRecognition[] = [];
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: ResultEvent) => void) | null = null;
  results: Result[] = [];
  constructor() { SimulatedRecognition.instances.push(this); }
  start() { this.onstart?.(); }
  abort() { this.onend?.(); }
  stop() { this.onend?.(); }
  sentence(text: string) {
    const index = this.results.length;
    this.results.push({ isFinal: false, length: 1, 0: { transcript: text.slice(0, 8), confidence: 0.5 } });
    this.onresult?.({ resultIndex: index, results: this.results });
    this.results[index] = { isFinal: false, length: 1, 0: { transcript: text, confidence: 0.8 } };
    this.onresult?.({ resultIndex: index, results: this.results });
    this.results[index] = { isFinal: true, length: 1, 0: { transcript: text, confidence: 0.9 } };
    this.onresult?.({ resultIndex: index, results: this.results });
    this.onresult?.({ resultIndex: index, results: this.results });
  }
}
const active = () => SimulatedRecognition.instances.at(-1)!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  SimulatedRecognition.instances = [];
  vi.stubGlobal('SpeechRecognition', SimulatedRecognition);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
  cloud.answer.mockReset(); cloud.translate.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('accelerated one-hour interview simulation (no real microphone or paid calls)', () => {
  it('drains 580 local translations, retries three failures, and excludes a two-minute pause from elapsed time', async () => {
    const failedOnce = new Set(['Question 105.', 'Question 305.', 'Question 505.']);
    const local = { destroy: vi.fn(), translate: vi.fn(async (text: string) => {
      if (failedOnce.delete(text)) throw new Error('Simulated local failure');
      return `繁中：${text}`;
    }) };
    const { result } = renderHook(useInterview);
    act(() => result.current.start({ ...DEFAULT_SETTINGS, apiKey: 'unused-test-only-key', translationMode: 'local' }, false, local));
    const expected: string[] = [];
    for (let minute = 0; minute < 60; minute++) {
      if (minute === 20) await act(async () => { await result.current.pause(); });
      if (minute === 22) act(() => result.current.resume());
      if (minute === 20 || minute === 21) {
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(result.current.elapsed).toBe(1200);
        continue;
      }
      for (let slot = 0; slot < 10; slot++) {
        const number = minute * 10 + slot;
        const text = `Question ${number}.`;
        expected.push(text);
        await act(async () => { active().sentence(text); });
        if (number === 0) act(() => result.current.select(text, result.current.segments[0].id));
        const last = result.current.segments.at(-1)!;
        if (last.translationState === 'error') {
          await act(async () => { result.current.retryTranslation(last); result.current.retryTranslation(last); });
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      }
    }
    expect(Date.now()).toBe(3_600_000);
    expect(result.current.elapsed).toBe(3480);
    expect(result.current.segments.map(row => row.english)).toEqual(expected);
    expect(result.current.segments).toHaveLength(580);
    expect(new Set(result.current.segments.map(row => row.id)).size).toBe(580);
    expect(result.current.segments.every(row => row.translationState === 'done' && row.chinese === `繁中：${row.english}`)).toBe(true);
    expect(local.translate).toHaveBeenCalledTimes(583);
    expect(result.current.selected).toBe('Question 0.');
    expect(result.current.interim).toBe('');
    expect(result.current.usage).toEqual({ spent: 0, reserved: 0, inputTokens: 0, outputTokens: 0, unconfirmed: 0 });
    expect(cloud.translate).not.toHaveBeenCalled();
    expect(cloud.answer).not.toHaveBeenCalled();
    await act(async () => { await result.current.stop(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.elapsed).toBe(3480);
    expect(vi.getTimerCount()).toBe(0);
  }, 20_000);

  it('keeps a full hour on the session clock across six recovered network interruptions', async () => {
    const { result } = renderHook(useInterview);
    act(() => result.current.start({ ...DEFAULT_SETTINGS, translationMode: 'off' }, false, null));
    for (let minute = 0; minute < 60; minute++) {
      if (minute % 10 === 5) {
        act(() => active().onerror?.({ error: 'network' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        act(() => active().sentence(`Recovered at minute ${minute}.`));
        await act(async () => { await vi.advanceTimersByTimeAsync(59_500); });
      } else {
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      }
    }
    expect(Date.now()).toBe(3_600_000);
    expect(result.current.elapsed).toBe(3600);
    expect(result.current.segments).toHaveLength(6);
    expect(result.current.speechState).toBe('listening');
    expect(cloud.translate).not.toHaveBeenCalled();
    expect(cloud.answer).not.toHaveBeenCalled();
    await act(async () => { await result.current.stop(); });
  }, 20_000);

  it('retains partial seconds across repeated pauses and a recovered connection', async () => {
    const { result } = renderHook(useInterview);
    act(() => result.current.start({ ...DEFAULT_SETTINGS, translationMode: 'off' }, false, null));
    await act(async () => { await vi.advanceTimersByTimeAsync(1250); });
    await act(async () => { await result.current.pause(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5750); });
    expect(result.current.elapsed).toBe(1);
    act(() => result.current.resume());
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    await act(async () => { await result.current.pause(); });
    expect(result.current.elapsed).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    act(() => { result.current.resume(); active().onerror?.({ error: 'network' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => active().sentence('Recovered after a pause.'));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await act(async () => { await result.current.stop(); });
    expect(Date.now()).toBe(9000);
    expect(result.current.elapsed).toBe(3); // 1.25 + 0.75 + 1 seconds active, 6 seconds paused.
  });

  it('catches up from monotonic time when interval callbacks are throttled', async () => {
    const { result } = renderHook(useInterview);
    act(() => result.current.start({ ...DEFAULT_SETTINGS, translationMode: 'off' }, false, null));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.elapsed).toBe(1);
    // Emulate a delayed callback: an hour passes on the monotonic clock, not 3,600 callbacks.
    vi.spyOn(performance, 'now').mockReturnValue(3_600_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.elapsed).toBe(3600);
    act(() => active().sentence('Caption after the delayed callback.'));
    expect(result.current.segments[0].time).toBe(3600);
    await act(async () => { await result.current.stop(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.elapsed).toBe(3600);
  });

  it('isolates delayed work when stopping and replacing a session after one simulated hour', async () => {
    const lateTranslation = deferred<string>();
    const lateAnswer = deferred<AiResult>();
    const local = { translate: vi.fn(async (text: string) => `繁中：${text}`), destroy: vi.fn() };
    const { result } = renderHook(useInterview);
    act(() => result.current.start({ ...DEFAULT_SETTINGS, apiKey: 'test-only-key', translationMode: 'local' }, false, local));
    for (let minute = 0; minute < 60; minute++) {
      await act(async () => {
        for (let item = 0; item < 10; item++) active().sentence(`Old ${minute * 10 + item}.`);
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(result.current.segments).toHaveLength(600);
    expect(result.current.segments.every(row => row.translationState === 'done')).toBe(true);
    local.translate.mockImplementationOnce(() => lateTranslation.promise);
    await act(async () => { active().sentence('Delayed old translation.'); active().sentence('Queued old translation.'); });
    act(() => result.current.select('Old selected question.'));
    cloud.answer.mockReturnValueOnce(lateAnswer.promise);
    await act(async () => { void result.current.ask(); });
    const oldNative = active();
    const staleResult = oldNative.onresult;
    const staleEnd = oldNative.onend;
    await act(async () => { await result.current.stop(); });
    expect(result.current.usage.unconfirmed).toBe(1);
    const freshLocal = { translate: vi.fn(async () => '新的翻譯'), destroy: vi.fn() };
    act(() => result.current.start({ ...DEFAULT_SETTINGS, translationMode: 'local' }, false, freshLocal));
    await act(async () => {
      active().sentence('Fresh session.');
      staleResult?.({ resultIndex: oldNative.results.length, results: [...oldNative.results,
        { isFinal: true, length: 1, 0: { transcript: 'Late old microphone event.', confidence: 1 } }] });
      staleEnd?.();
      lateTranslation.resolve('舊的翻譯');
      lateAnswer.resolve({ text: 'Old answer.', usage: { inputTokens: 100, outputTokens: 50 } });
    });
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.segments[0]).toMatchObject({ english: 'Fresh session.', chinese: '新的翻譯', translationState: 'done', time: 0 });
    expect(result.current.answer).toBe('');
    expect(result.current.elapsed).toBe(0);
    expect(result.current.usage).toEqual({ spent: 0, reserved: 0, inputTokens: 0, outputTokens: 0, unconfirmed: 0 });
    expect(local.translate).toHaveBeenCalledTimes(601);
    expect(freshLocal.translate).toHaveBeenCalledTimes(1);
    expect(cloud.translate).not.toHaveBeenCalled();
    expect(cloud.answer).toHaveBeenCalledTimes(1); // Explicit user action; service itself is mocked.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.elapsed).toBe(1);
    await act(async () => { await result.current.stop(); });
  }, 20_000);
});
