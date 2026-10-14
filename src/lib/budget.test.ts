import { describe, expect, it } from 'vitest';
import { BudgetLedger, estimateCost, estimateHourlyCost } from './budget';

describe('budget estimates', () => {
  it.each([
    ['openai', 0.6],
    ['gemini', 2.8],
  ] as const)('prices %s input and output separately', (provider, price) => {
    expect(estimateCost(provider, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(price);
  });

  it('uses the documented hourly assumptions and twenty percent margin', () => {
    expect(estimateHourlyCost('openai', 20, false)).toEqual({ low: 0.0096, high: 0.0096 });
    const cloud = estimateHourlyCost('openai', 20, true);
    expect(cloud.low).toBeCloseTo(0.0276);
    expect(cloud.high).toBeCloseTo(0.04632);
    expect(estimateHourlyCost('gemini', 0, false)).toEqual({ low: 0, high: 0 });
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects invalid token counts: %s', (value) => {
    expect(() => estimateCost('openai', { inputTokens: value, outputTokens: 0 })).toThrow();
    expect(() => estimateCost('openai', { inputTokens: 0, outputTokens: value })).toThrow();
  });
});

describe('BudgetLedger', () => {
  it('reserves synchronously so competing calls cannot jointly exceed the limit', async () => {
    const ledger = new BudgetLedger(0.01, 'openai');
    const accepted = await Promise.all(['a', 'b', 'c'].map(async id =>
      ledger.reserve(id, { inputTokens: 10_000, outputTokens: 10_000 }),
    ));
    expect(accepted).toEqual([true, false, false]);
    expect(ledger.snapshot.reserved).toBe(0.006);
  });

  it('settles confirmed usage once and frees only the unused reservation', () => {
    const ledger = new BudgetLedger(0.01, 'openai');
    expect(ledger.reserve('a', { inputTokens: 10_000, outputTokens: 10_000 })).toBe(true);
    ledger.settle('a', { inputTokens: 2_000, outputTokens: 1_000 });
    ledger.settle('a', { inputTokens: 2_000, outputTokens: 1_000 });
    expect(ledger.snapshot).toEqual({ spent: 0.0007, reserved: 0, inputTokens: 2_000, outputTokens: 1_000, unconfirmed: 0 });
    expect(ledger.reserve('a', { inputTokens: 1, outputTokens: 1 })).toBe(false);
  });

  it('keeps missing and estimated usage reserved until real usage arrives', () => {
    const ledger = new BudgetLedger(0.01, 'openai');
    ledger.reserve('a', { inputTokens: 10_000, outputTokens: 10_000 });
    ledger.settle('a');
    ledger.settle('a', { inputTokens: 100, outputTokens: 100, estimated: true });
    expect(ledger.snapshot).toEqual({ spent: 0, reserved: 0.006, inputTokens: 0, outputTokens: 0, unconfirmed: 1 });
    expect(ledger.reserve('b', { inputTokens: 10_000, outputTokens: 10_000 })).toBe(false);
    ledger.settle('a', { inputTokens: 2_000, outputTokens: 1_000 });
    expect(ledger.snapshot.unconfirmed).toBe(0);
    expect(ledger.snapshot.reserved).toBe(0);
  });

  it('releases a known unsubmitted call without making its ID reusable', () => {
    const ledger = new BudgetLedger(0.01, 'openai');
    ledger.reserve('a', { inputTokens: 10_000, outputTokens: 10_000 });
    ledger.release('a');
    ledger.release('a');
    expect(ledger.snapshot.reserved).toBe(0);
    expect(ledger.reserve('a', { inputTokens: 10_000, outputTokens: 10_000 })).toBe(false);
  });

  it('does not release a submitted request with an unknown outcome', () => {
    const ledger = new BudgetLedger(0.01, 'openai');
    ledger.reserve('a', { inputTokens: 10_000, outputTokens: 10_000 });
    ledger.settle('a');
    expect(() => ledger.release('a')).toThrow();
    expect(ledger.snapshot.reserved).toBe(0.006);
  });

  it('records unexpectedly high actual usage and blocks further paid requests', () => {
    const ledger = new BudgetLedger(0.001, 'openai');
    ledger.reserve('a', { inputTokens: 1_000, outputTokens: 100 });
    ledger.settle('a', { inputTokens: 10_000, outputTokens: 10_000 });
    expect(ledger.snapshot.spent).toBe(0.006);
    expect(ledger.reserve('b', { inputTokens: 1, outputTokens: 1 })).toBe(false);
  });

  it('handles a precise budget boundary without floating point overspend', () => {
    const ledger = new BudgetLedger(0.0000003, 'openai');
    expect(ledger.reserve('a', { inputTokens: 1, outputTokens: 0 })).toBe(true);
    expect(ledger.reserve('b', { inputTokens: 2, outputTokens: 0 })).toBe(true);
    expect(ledger.reserve('c', { inputTokens: 1, outputTokens: 0 })).toBe(false);
  });

  it.each([NaN, Infinity, -1])('rejects invalid budgets: %s', (value) => {
    expect(() => new BudgetLedger(value, 'openai')).toThrow();
  });

  it('validates before changing a reservation or settlement', () => {
    const ledger = new BudgetLedger(0.01, 'openai');
    expect(() => ledger.reserve('', { inputTokens: 1, outputTokens: 0 })).toThrow();
    expect(() => ledger.reserve('a', { inputTokens: -1, outputTokens: 0 })).toThrow();
    ledger.reserve('a', { inputTokens: 10_000, outputTokens: 10_000 });
    expect(() => ledger.settle('a', { inputTokens: Infinity, outputTokens: 0 })).toThrow();
    expect(ledger.snapshot.reserved).toBe(0.006);
  });
});
