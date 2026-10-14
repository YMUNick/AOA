import type { Provider, Usage } from '../types';

// Integer units of $0.0000001 avoid rounding through a budget boundary.
const UNITS_PER_DOLLAR = 10_000_000;
const PRICES = { openai: { input: 1, output: 5 }, gemini: { input: 3, output: 25 } } as const;

function nonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative safe integer.`);
}

function costUnits(provider: Provider, usage: Usage): number {
  const price = PRICES[provider];
  if (!price) throw new RangeError('Unsupported provider.');
  nonnegativeInteger(usage.inputTokens, 'Input tokens');
  nonnegativeInteger(usage.outputTokens, 'Output tokens');
  const cost = usage.inputTokens * price.input + usage.outputTokens * price.output;
  nonnegativeInteger(cost, 'Cost');
  return cost;
}

export function estimateCost(provider: Provider, usage: Usage): number {
  return costUnits(provider, usage) / UNITS_PER_DOLLAR;
}

/** One hour: 1,500 input / 500 output tokens per answer, with a 20% margin. */
export function estimateHourlyCost(provider: Provider, answers: number, cloudTranslation: boolean): { low: number; high: number } {
  nonnegativeInteger(answers, 'Answer count');
  const answerUsage = { inputTokens: answers * 1_500, outputTokens: answers * 500 };
  const low = costUnits(provider, {
    inputTokens: answerUsage.inputTokens + (cloudTranslation ? 60_000 : 0),
    outputTokens: answerUsage.outputTokens + (cloudTranslation ? 18_000 : 0),
  });
  const high = costUnits(provider, {
    inputTokens: answerUsage.inputTokens + (cloudTranslation ? 156_000 : 0),
    outputTokens: answerUsage.outputTokens + (cloudTranslation ? 30_000 : 0),
  });
  return { low: low * 1.2 / UNITS_PER_DOLLAR, high: high * 1.2 / UNITS_PER_DOLLAR };
}

interface Reservation { cost: number; status: 'pending' | 'unconfirmed' | 'settled' | 'released'; }

/** A session safeguard; provider-side billing can still exceed an inaccurate reservation. */
export class BudgetLedger {
  private readonly limit: number;
  private readonly provider: Provider;
  private readonly requests = new Map<string, Reservation>();
  private spent = 0;
  private reserved = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(limitUsd: number, provider: Provider) {
    if (!Number.isFinite(limitUsd) || limitUsd < 0) throw new RangeError('Budget must be finite and nonnegative.');
    this.limit = Math.floor(limitUsd * UNITS_PER_DOLLAR);
    nonnegativeInteger(this.limit, 'Budget');
    costUnits(provider, { inputTokens: 0, outputTokens: 0 });
    this.provider = provider;
  }

  reserve(id: string, usage: Usage): boolean {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('A request ID is required.');
    const cost = costUnits(this.provider, usage);
    if (this.requests.has(id) || cost > this.limit - this.spent - this.reserved) return false;
    this.requests.set(id, { cost, status: 'pending' });
    this.reserved += cost;
    return true;
  }

  settle(id: string, usage?: Usage): void {
    const actual = usage ? costUnits(this.provider, usage) : undefined;
    const request = this.requests.get(id);
    if (!request || request.status === 'settled' || request.status === 'released') return;
    if (actual === undefined || usage?.estimated) {
      request.status = 'unconfirmed';
      return;
    }
    const nextSpent = this.spent + actual;
    const nextInput = this.inputTokens + usage!.inputTokens;
    const nextOutput = this.outputTokens + usage!.outputTokens;
    nonnegativeInteger(nextSpent, 'Accumulated cost');
    nonnegativeInteger(nextInput, 'Accumulated input tokens');
    nonnegativeInteger(nextOutput, 'Accumulated output tokens');
    this.reserved -= request.cost;
    this.spent = nextSpent;
    this.inputTokens = nextInput;
    this.outputTokens = nextOutput;
    request.status = 'settled';
  }

  /** Only call when it is known that no provider request was made. */
  release(id: string): void {
    const request = this.requests.get(id);
    if (!request || request.status === 'settled' || request.status === 'released') return;
    if (request.status === 'unconfirmed') throw new Error('Cannot release a request with unconfirmed usage.');
    this.reserved -= request.cost;
    request.status = 'released';
  }

  get snapshot(): { spent: number; reserved: number; inputTokens: number; outputTokens: number; unconfirmed: number } {
    return {
      spent: this.spent / UNITS_PER_DOLLAR,
      reserved: this.reserved / UNITS_PER_DOLLAR,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      unconfirmed: [...this.requests.values()].filter(request => request.status === 'unconfirmed').length,
    };
  }
}
