import { describe, expect, it } from 'vitest';
import { PcmBuffer } from './pcmBuffer';

describe('bounded PCM buffer', () => {
  it('retains every frame through a recognition gap and drains in order across wraparound', () => {
    const buffer = new PcmBuffer(8);
    expect(buffer.push(Float32Array.from([1, 2, 3, 4, 5]))).toBe(true);
    const first = new Float32Array(3); buffer.read(first);
    expect([...first]).toEqual([1, 2, 3]);
    expect(buffer.push(Float32Array.from([6, 7, 8, 9, 10, 11]))).toBe(true);
    const rest = new Float32Array(10); buffer.read(rest);
    expect([...rest]).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 0, 0]);
    expect(buffer.available).toBe(0);
  });

  it('reports overflow without replacing earlier unprocessed speech', () => {
    const buffer = new PcmBuffer(4);
    buffer.push(Float32Array.from([1, 2, 3]));
    expect(buffer.push(Float32Array.from([4, 5, 6]))).toBe(false);
    expect(buffer.available).toBe(4);
    const output = new Float32Array(4); buffer.read(output);
    expect([...output]).toEqual([1, 2, 3, 4]);
  });

  it('does not retain source-array references and clears audio at disposal', () => {
    const buffer = new PcmBuffer(4), input = Float32Array.from([0.2, 0.4]);
    buffer.push(input); input.fill(1);
    const output = new Float32Array(1); buffer.read(output);
    expect(output[0]).toBeCloseTo(0.2);
    buffer.clear(); const empty = new Float32Array(4).fill(1); buffer.read(empty);
    expect([...empty]).toEqual([0, 0, 0, 0]);
  });

  it('handles many reconnect gaps within bounded capacity without sample loss or duplication', () => {
    const buffer = new PcmBuffer(960), input = Float32Array.from({ length: 120 }, (_, i) => i / 120);
    for (let gap = 0; gap < 100; gap++) {
      for (let block = 0; block < 8; block++) expect(buffer.push(input)).toBe(true);
      for (let block = 0; block < 8; block++) { const output = new Float32Array(120); buffer.read(output); expect(output).toEqual(input); }
      expect(buffer.available).toBe(0);
    }
  });
});
