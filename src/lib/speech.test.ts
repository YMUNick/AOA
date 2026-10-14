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
