import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Processor = { port: { onmessage(event: { data: unknown }): void; postMessage: ReturnType<typeof vi.fn> }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
let Constructor: new () => Processor;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('sampleRate', 16);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: () => {}, postMessage: vi.fn() }; });
  vi.stubGlobal('registerProcessor', (_: string, value: typeof Constructor) => { Constructor = value; });
  await import('./tabAudio.worklet');
});
afterEach(() => vi.unstubAllGlobals());
function process(processor: Processor, values: number[] | null, right?: number[]) {
  const output = new Float32Array(4);
  processor.process(values ? [[Float32Array.from(values), ...(right ? [Float32Array.from(right)] : [])]] : [[]], [[output]]);
  return [...output];
}
describe('tab audio render processor', () => {
  it('does not accumulate exact digital silence during closed-gate reconnects, but preserves tiny signals', () => {
    const p = new Constructor();
    for (let i = 0; i < 1000; i++) process(p, [0, 0, 0, 0]);
    expect(p.port.postMessage).toHaveBeenLastCalledWith({ type: 'status', bufferedMs: 0 });
    expect(p.port.postMessage.mock.calls.some(([data]) => data.type === 'overflow')).toBe(false);
    process(p, [0, 0, 1e-20, 0]);
    p.port.onmessage({ data: { type: 'gate', active: true } });
    const output = process(p, null); expect(output[2]).toBeGreaterThan(0);
  });
  it('detects silence per original channel, not from a cancelling stereo average', () => {
    const p = new Constructor();
    process(p, [1, 1, 1, 1], [-1, -1, -1, -1]);
    expect(p.port.postMessage).toHaveBeenLastCalledWith({ type: 'status', bufferedMs: 250 });
  });
  it('buffers while the recognizer is closed, drains in order, and rejects new input after finish', () => {
    const p = new Constructor();
    expect(process(p, [1, 2, 3, 4])).toEqual([0, 0, 0, 0]);
    expect(process(p, [5, 6, 7, 8])).toEqual([0, 0, 0, 0]);
    p.port.onmessage({ data: { type: 'gate', active: true } });
    expect(process(p, [9, 10, 11, 12])).toEqual([1, 2, 3, 4]);
    p.port.onmessage({ data: { type: 'finish' } });
    expect(process(p, [13, 14, 15, 16])).toEqual([5, 6, 7, 8]);
    expect(process(p, null)).toEqual([9, 10, 11, 12]);
    expect(p.port.postMessage).not.toHaveBeenCalledWith({ type: 'drained' });
    expect(process(p, null)).toEqual([0, 0, 0, 0]);
    expect(p.port.postMessage).toHaveBeenCalledWith({ type: 'drained' });
  });
  it('downmixes both tab channels without doubling output amplitude and clears on close', () => {
    const p = new Constructor(); p.port.onmessage({ data: { type: 'gate', active: true } });
    expect(process(p, [1, 0, 0.5, -1], [-1, 1, 0.5, -1])).toEqual([0, 0.5, 0.5, -1]);
    p.port.onmessage({ data: { type: 'close' } });
    const output = new Float32Array(4).fill(1);
    expect(p.process([[output]], [[output]])).toBe(false); expect([...output]).toEqual([0, 0, 0, 0]);
  });
  it('stops accepting at 30 seconds, signals overflow once, and preserves the oldest pending audio', () => {
    const p = new Constructor();
    for (let i = 1; i <= 121; i++) process(p, [i, i, i, i]);
    process(p, [999, 999, 999, 999]);
    expect(p.port.postMessage.mock.calls.filter(([data]) => data.type === 'overflow')).toHaveLength(1);
    p.port.onmessage({ data: { type: 'gate', active: true } });
    for (let i = 1; i <= 120; i++) expect(process(p, null)).toEqual([i, i, i, i]);
    expect(process(p, null)).toEqual([0, 0, 0, 0]);
  });
  it('can resume a full queue without a false overflow when the output quantum frees space', () => {
    const p = new Constructor();
    for (let i = 1; i <= 120; i++) process(p, [i, i, i, i]);
    p.port.onmessage({ data: { type: 'gate', active: true } });
    expect(process(p, [121, 121, 121, 121])).toEqual([1, 1, 1, 1]);
    expect(p.port.postMessage).not.toHaveBeenCalledWith({ type: 'overflow' });
    p.port.onmessage({ data: { type: 'finish' } });
    for (let i = 2; i <= 121; i++) expect(process(p, null)).toEqual([i, i, i, i]);
  });
});
