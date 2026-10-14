import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechState } from '../types';
import { SpeechController } from './speech';

type Result = { isFinal: boolean; length: number; 0: { transcript: string; confidence: number } };
type ResultEvent = { resultIndex: number; results: Result[] };

// Accelerated event simulation only: no audio, real microphone, or recognition service.
class SimulatedRecognition {
  static instances: SimulatedRecognition[] = [];
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: ResultEvent) => void) | null = null;
  results: Result[] = [];
  active = false;
  constructor() { SimulatedRecognition.instances.push(this); }
  start() { this.active = true; this.onstart?.(); }
  abort() { this.active = false; this.onend?.(); }
  emit(index: number, transcript: string, isFinal: boolean) {
    this.results[index] = { isFinal, length: 1, 0: { transcript, confidence: 0.9 } };
    this.onresult?.({ resultIndex: index, results: this.results });
  }
}
const active = () => SimulatedRecognition.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  SimulatedRecognition.instances = [];
  vi.stubGlobal('SpeechRecognition', SimulatedRecognition);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('accelerated one-hour speech simulation (not a real audio soak)', () => {
  it('preserves 684 finals through silence, reconnects, pause/resume, and stale callbacks', () => {
    const finals: { id: string; text: string }[] = [];
    const interim: string[] = [];
    const states: SpeechState[] = [];
    const errors: string[] = [];
    const controller = new SpeechController({
      onFinal: (id, text) => finals.push({ id, text }), onInterim: text => interim.push(text),
      onState: state => states.push(state), onError: message => errors.push(message),
    });
    controller.start();
    const expected: string[] = [];
    for (let step = 0; step < 720; step++) {
      const began = Date.now();
      const withinTenMinutes = step % 120;
      if (withinTenMinutes < 6) {
        // Six 30-second quiet periods: silence must never exhaust the failure allowance.
        active().onerror?.({ error: 'no-speech' });
        vi.advanceTimersByTime(1000);
      } else {
        if (withinTenMinutes === 30) {
          // Two consecutive failures, then real final speech resets the retry allowance.
          const previous = active();
          const staleResult = previous.onresult;
          const staleEnd = previous.onend;
          previous.onerror?.({ error: 'network' });
          vi.advanceTimersByTime(500);
          active().onerror?.({ error: 'network' });
          vi.advanceTimersByTime(1000);
          staleResult?.({ resultIndex: previous.results.length, results: [...previous.results,
            { isFinal: true, length: 1, 0: { transcript: 'stale network result', confidence: 1 } }] });
          staleEnd?.();
        } else if (withinTenMinutes === 60) {
          active().onend?.();
          vi.advanceTimersByTime(500);
        } else if (withinTenMinutes === 90) {
          const previous = active();
          const staleResult = previous.onresult;
          controller.pause();
          vi.advanceTimersByTime(2000);
          controller.start();
          staleResult?.({ resultIndex: previous.results.length, results: [...previous.results,
            { isFinal: true, length: 1, 0: { transcript: 'stale paused result', confidence: 1 } }] });
        }
        const native = active();
        const index = native.results.length;
        const text = `Interview sentence ${step}.`;
        expected.push(text);
        native.emit(index, `Draft ${step}`, false);
        vi.advanceTimersByTime(100);
        native.emit(index, `Draft ${step} expanded`, false);
        vi.advanceTimersByTime(100);
        native.emit(index, text, true);
        native.onresult?.({ resultIndex: 0, results: native.results });
      }
      expect(SimulatedRecognition.instances.filter(instance => instance.active)).toHaveLength(1);
      vi.advanceTimersByTime(5000 - (Date.now() - began));
    }
    expect(Date.now()).toBe(3_600_000);
    expect(finals).toHaveLength(684);
    expect(finals.map(item => item.text)).toEqual(expected);
    expect(new Set(finals.map(item => item.id)).size).toBe(684);
    expect(interim.filter(text => text.startsWith('Draft '))).toHaveLength(1368);
    expect(errors).toEqual([]);
    expect(states.filter(state => state === 'paused')).toHaveLength(6);
    expect(states.at(-1)).toBe('listening');

    const previous = active();
    const staleResult = previous.onresult;
    const staleEnd = previous.onend;
    const nativeCount = SimulatedRecognition.instances.length;
    controller.stop();
    staleResult?.({ resultIndex: previous.results.length, results: [...previous.results,
      { isFinal: true, length: 1, 0: { transcript: 'after stop', confidence: 1 } }] });
    staleEnd?.();
    vi.advanceTimersByTime(60_000);
    expect(finals).toHaveLength(684);
    expect(SimulatedRecognition.instances).toHaveLength(nativeCount);
    expect(SimulatedRecognition.instances.some(instance => instance.active)).toBe(false);
    expect(states.at(-1)).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });
});
