import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechState } from '../types';
import { SpeechController } from './speech';

type Result = { isFinal: boolean; length: number; 0: { transcript: string; confidence: number } };
type ResultEvent = { resultIndex: number; results: Result[] };

// Only the browser/microphone boundary is faked; controller state and timers are real.
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onnomatch: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: ResultEvent) => void) | null = null;
  starts = 0;
  aborts = 0;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.starts += 1; }
  abort() { this.aborts += 1; this.onend?.(); }
  stop() { this.onend?.(); }
}

function result(transcript: string, isFinal = false): Result {
  return { isFinal, length: 1, 0: { transcript, confidence: 0.9 } };
}

function setup() {
  const final: { id: string; text: string }[] = [];
  const interim: string[] = [];
  const states: SpeechState[] = [];
  const errors: string[] = [];
  const controller = new SpeechController({
    onInterim: text => interim.push(text), onFinal: (id, text) => final.push({ id, text }),
    onState: state => states.push(state), onError: message => errors.push(message),
  });
  return { controller, final, interim, states, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SpeechController', () => {
  it('starts English continuous recognition once and exposes its permission state', () => {
    const { controller, states } = setup();
    controller.start();
    controller.start();
    const native = FakeRecognition.instances[0];
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(native.starts).toBe(1);
    expect([native.lang, native.continuous, native.interimResults]).toEqual(['en-US', true, true]);
    expect(states.at(-1)).toBe('requesting');
    native.onstart?.();
    expect(states.at(-1)).toBe('listening');
    controller.stop();
  });

  it.each([
    { platform: 'Android', userAgent: 'Chrome desktop-like UA', continuous: false },
    { platform: undefined, userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-N981B) Chrome/155.0.0.0 Mobile', continuous: false },
    { platform: '', userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/155.0.0.0', continuous: false },
    { platform: 'Windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/155.0.0.0', continuous: true },
    { platform: undefined, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/155.0.0.0', continuous: true },
  ])('chooses continuous=$continuous for platform $platform and UA $userAgent', ({ platform, userAgent, continuous }) => {
    vi.stubGlobal('navigator', { userAgent, userAgentData: platform === undefined ? undefined : { platform } });
    const { controller } = setup();
    controller.start();
    expect(FakeRecognition.instances[0].continuous).toBe(continuous);
    expect(FakeRecognition.instances[0].interimResults).toBe(true);
    controller.stop();
  });

  it('keeps Android interim phrases out of final captions and restarts after each utterance', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15)', userAgentData: { platform: 'Android' } });
    const { controller, final, interim, errors, states } = setup();
    controller.start();
    for (const question of ['How are you?', 'Who are you?', 'Tell me about yourself.']) {
      const native = FakeRecognition.instances.at(-1)!;
      expect(native.continuous).toBe(false);
      native.onstart?.();
      native.onresult?.({ resultIndex: 0, results: [result(question.slice(0, 3))] });
      native.onresult?.({ resultIndex: 0, results: [result(question.slice(0, 6))] });
      expect(final.some(item => item.text === question)).toBe(false);
      expect(interim.at(-1)).toBe(question.slice(0, 6).trim());
      native.onresult?.({ resultIndex: 0, results: [result(question, true)] });
      native.onresult?.({ resultIndex: 0, results: [result(question, true)] });
      expect(final.filter(item => item.text === question)).toHaveLength(1);
      const count = FakeRecognition.instances.length;
      native.onend?.();
      vi.advanceTimersByTime(500);
      expect(FakeRecognition.instances).toHaveLength(count + 1);
    }
    FakeRecognition.instances.at(-1)!.onstart?.();
    expect(final.map(item => item.text)).toEqual(['How are you?', 'Who are you?', 'Tell me about yourself.']);
    expect(new Set(final.map(item => item.id)).size).toBe(3);
    expect(states.at(-1)).toBe('listening');
    expect(errors).toEqual([]);
    controller.stop();
  });

  it('deduplicates final result indices but preserves repeated words in different results', () => {
    const { controller, final, interim } = setup();
    controller.start();
    const native = FakeRecognition.instances[0];
    native.onresult?.({ resultIndex: 0, results: [result(' Hello ', true), result('what')] });
    native.onresult?.({ resultIndex: 1, results: [result('Hello', true), result('what is')] });
    native.onresult?.({ resultIndex: 0, results: [result('Hello', true), result('Hello', true)] });
    expect(final.map(item => item.text)).toEqual(['Hello', 'Hello']);
    expect(new Set(final.map(item => item.id)).size).toBe(2);
    expect(interim).toContain('what is');
    expect(interim.at(-1)).toBe('');
    controller.stop();
  });

  it('keeps all interim results when only a later result changed', () => {
    const { controller, interim } = setup();
    controller.start();
    const native = FakeRecognition.instances[0];
    native.onresult?.({ resultIndex: 1, results: [result('tell me'), result('more')] });
    expect(interim.at(-1)).toBe('tell me more');
    controller.stop();
  });

  it('ignores late events after stopping, including a captured end callback', () => {
    const { controller, final, states } = setup();
    controller.start();
    const native = FakeRecognition.instances[0];
    const lateEnd = native.onend;
    const lateResult = native.onresult;
    controller.stop();
    lateResult?.({ resultIndex: 0, results: [result('stale', true)] });
    lateEnd?.();
    vi.runAllTimers();
    expect(final).toEqual([]);
    expect(states.at(-1)).toBe('stopped');
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(native.aborts).toBe(1);
  });

  it('invalidates old callbacks when a paused session resumes', () => {
    const { controller, final, states } = setup();
    controller.start();
    const stale = FakeRecognition.instances[0].onresult;
    controller.pause();
    expect(states.at(-1)).toBe('paused');
    controller.start();
    stale?.({ resultIndex: 0, results: [result('old', true)] });
    FakeRecognition.instances[1].onresult?.({ resultIndex: 0, results: [result('new', true)] });
    expect(final.map(item => item.text)).toEqual(['new']);
    controller.stop();
  });

  it.each(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'])('never retries fatal %s errors', (error) => {
    const { controller, states, errors } = setup();
    controller.start();
    const native = FakeRecognition.instances[0];
    const lateEnd = native.onend;
    native.onerror?.({ error });
    lateEnd?.();
    vi.runAllTimers();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(states.at(-1)).toBe('error');
    expect(errors).toHaveLength(1);
    expect(native.aborts).toBe(1);
  });

  it('limits repeated network failures even when each native start succeeds', () => {
    const { controller, states, errors } = setup();
    controller.start();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const native = FakeRecognition.instances.at(-1)!;
      native.onstart?.();
      native.onerror?.({ error: 'network' });
      vi.runAllTimers();
    }
    expect(FakeRecognition.instances.length).toBeLessThanOrEqual(4);
    expect(states.at(-1)).toBe('error');
    expect(errors.length).toBeGreaterThan(0);
    controller.stop();
  });

  it('preserves all three network retries after an Android utterance completes', () => {
    vi.stubGlobal('navigator', { userAgent: 'Android', userAgentData: { platform: 'Android' } });
    const { controller, states, errors } = setup();
    controller.start();
    const completed = FakeRecognition.instances[0];
    completed.onstart?.();
    completed.onresult?.({ resultIndex: 0, results: [result('A completed utterance.', true)] });
    completed.onend?.();
    vi.advanceTimersByTime(499);
    expect(FakeRecognition.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeRecognition.instances).toHaveLength(2);

    for (const delay of [500, 1_000, 2_000]) {
      const failed = FakeRecognition.instances.at(-1)!;
      failed.onstart?.();
      failed.onerror?.({ error: 'network' });
      const count = FakeRecognition.instances.length;
      vi.advanceTimersByTime(delay - 1);
      expect(FakeRecognition.instances).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(FakeRecognition.instances).toHaveLength(count + 1);
      expect(errors).toEqual([]);
    }
    FakeRecognition.instances.at(-1)!.onerror?.({ error: 'network' });
    vi.runAllTimers();
    expect(FakeRecognition.instances).toHaveLength(5);
    expect(states.at(-1)).toBe('error');
    expect(errors).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['pause', 'stop'] as const)('%s cancels the restart after a completed Android utterance', action => {
    vi.stubGlobal('navigator', { userAgent: 'Android' });
    const { controller, states } = setup();
    controller.start();
    const completed = FakeRecognition.instances[0];
    const staleEnd = completed.onend;
    completed.onresult?.({ resultIndex: 0, results: [result('Completed before pausing.', true)] });
    completed.onend?.();
    controller[action]();
    staleEnd?.();
    vi.runAllTimers();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(states.at(-1)).toBe(action === 'pause' ? 'paused' : 'stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still bounds Android endings with no final, nomatch, or error event', () => {
    vi.stubGlobal('navigator', { userAgent: 'Android' });
    const { controller, states, errors } = setup();
    controller.start();
    for (let attempt = 0; attempt < 4; attempt++) {
      FakeRecognition.instances.at(-1)!.onend?.();
      vi.runAllTimers();
    }
    expect(FakeRecognition.instances).toHaveLength(4);
    expect(states.at(-1)).toBe('error');
    expect(errors).toHaveLength(1);
  });

  it('keeps listening through prolonged silence without spending the network retry allowance', () => {
    const { controller, final, states, errors } = setup();
    controller.start();
    for (let pause = 0; pause < 8; pause += 1) {
      const native = FakeRecognition.instances.at(-1)!;
      native.onstart?.();
      native.onerror?.({ error: 'no-speech' });
      vi.runAllTimers();
    }
    const active = FakeRecognition.instances.at(-1)!;
    active.onstart?.();
    active.onresult?.({ resultIndex: 0, results: [result('Thank you for waiting.', true)] });
    expect(final.map(item => item.text)).toEqual(['Thank you for waiting.']);
    expect(states.at(-1)).toBe('listening');
    expect(errors).toEqual([]);
    controller.stop();
  });

  it('waits one second after repeated nomatch endings and accepts later speech without a manual restart', () => {
    const { controller, final, states, errors } = setup();
    controller.start();
    for (let attempt = 0; attempt < 8; attempt++) {
      const native = FakeRecognition.instances.at(-1)!;
      native.onstart?.();
      const staleEnd = native.onend;
      const instanceCount = FakeRecognition.instances.length;
      native.onnomatch?.();
      staleEnd?.(); // Android emits end after nomatch; it must not count or schedule twice.
      vi.advanceTimersByTime(999);
      expect(FakeRecognition.instances).toHaveLength(instanceCount);
      vi.advanceTimersByTime(1);
      expect(FakeRecognition.instances).toHaveLength(instanceCount + 1);
    }
    const current = FakeRecognition.instances.at(-1)!;
    current.onstart?.();
    current.onresult?.({ resultIndex: 0, results: [result('Now the words are recognized.', true)] });
    expect(final.map(item => item.text)).toEqual(['Now the words are recognized.']);
    expect(states.at(-1)).toBe('listening');
    expect(errors).toEqual([]);
    controller.stop();
  });

  it.each(['pause', 'stop'] as const)('%s cancels a nomatch retry and ignores the old nomatch/end callbacks', (action) => {
    const { controller, states, errors } = setup();
    controller.start();
    const native = FakeRecognition.instances[0];
    const staleNomatch = native.onnomatch;
    const staleEnd = native.onend;
    native.onnomatch?.();
    expect(states.at(-1)).toBe('reconnecting');
    controller[action]();
    staleNomatch?.(); staleEnd?.();
    vi.advanceTimersByTime(10_000);
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(states.at(-1)).toBe(action === 'pause' ? 'paused' : 'stopped');
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let nomatch reset or bypass the bounded network failure allowance', () => {
    const { controller, states, errors } = setup();
    controller.start();
    for (let failure = 0; failure < 4; failure++) {
      const quiet = FakeRecognition.instances.at(-1)!;
      const quietEnd = quiet.onend;
      quiet.onnomatch?.(); quietEnd?.();
      vi.advanceTimersByTime(1000);
      const failed = FakeRecognition.instances.at(-1)!;
      failed.onstart?.();
      const failedEnd = failed.onend;
      failed.onerror?.({ error: 'network' }); failedEnd?.();
      vi.runAllTimers();
    }
    expect(states.at(-1)).toBe('error');
    expect(errors).toHaveLength(1);
    expect(FakeRecognition.instances).toHaveLength(8); // Initial + four nomatch + three network retries.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending retry on pause and permits an explicit new start', () => {
    const { controller, states } = setup();
    controller.start();
    FakeRecognition.instances[0].onend?.();
    expect(states.at(-1)).toBe('reconnecting');
    controller.pause();
    vi.runAllTimers();
    expect(FakeRecognition.instances).toHaveLength(1);
    controller.start();
    expect(FakeRecognition.instances).toHaveLength(2);
    controller.stop();
  });

  it('makes a different final ID when automatic reconnect resets native result indices', () => {
    const { controller, final } = setup();
    controller.start();
    FakeRecognition.instances[0].onresult?.({ resultIndex: 0, results: [result('first', true)] });
    FakeRecognition.instances[0].onend?.();
    vi.runAllTimers();
    FakeRecognition.instances[1].onresult?.({ resultIndex: 0, results: [result('second', true)] });
    expect(final.map(item => item.text)).toEqual(['first', 'second']);
    expect(final[0].id).not.toBe(final[1].id);
    controller.stop();
  });

  it('handles unsupported browsers with a manual-input error state', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    expect(SpeechController.isSupported()).toBe(false);
    const { controller, states, errors } = setup();
    controller.start();
    expect(states.at(-1)).toBe('error');
    expect(errors).toHaveLength(1);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('uses the prefixed browser implementation when needed', () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    expect(SpeechController.isSupported()).toBe(true);
    const { controller } = setup();
    controller.start();
    expect(FakeRecognition.instances[0].lang).toBe('en-US');
    controller.stop();
  });
});
