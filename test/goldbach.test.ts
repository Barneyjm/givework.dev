import { describe, expect, it } from 'vitest';
import {
  blockAt,
  MAX_SWEEP_SPAN,
  ONBOARDING_CANDIDATES,
  SweepError,
  sweepGoldbach,
} from '../src/goldbach.js';

// The arithmetic under the onboarding task. This is also the verifier, so a bug
// here would either reject honest work or accept fabricated work.

describe('sweepGoldbach', () => {
  it('finds a decomposition for every even number in a small range', () => {
    const r = sweepGoldbach(4, 100);
    expect(r.counterexamples).toEqual([]);
    expect(r.checked).toBe(48); // 4, 6, …, 98
    expect(r.exhaustive).toBe(true);
  });

  it('reproduces the known record: 63274 needs a smallest summand of 293', () => {
    // A025018/A025019: the largest minimal prime summand below 10^5 is 293, at
    // n = 63274. Matching a published value is the real check that the sieve,
    // the segment offsets and the search order are all right.
    const r = sweepGoldbach(4, 80_004);
    expect(r.max_min_prime).toBe(293);
    expect(r.max_min_prime_at).toBe(63274);
    expect(r.counterexamples).toEqual([]);
  });

  it('is exact far from the origin, where the segment is offset', () => {
    const r = sweepGoldbach(1_000_000_000, 1_000_080_000);
    expect(r.counterexamples).toEqual([]);
    expect(r.checked).toBe(40_000);
    expect(r.exhaustive).toBe(true);
    // Sanity: the summand found is genuinely small, as theory predicts.
    expect(r.max_min_prime).toBeGreaterThan(0);
    expect(r.max_min_prime).toBeLessThan(5_000);
  });

  it('is deterministic — the same range always yields the same answer', () => {
    const a = sweepGoldbach(500_000, 520_000);
    const b = sweepGoldbach(500_000, 520_000);
    expect(a).toEqual(b);
  });

  it('agrees with a naive independent implementation', () => {
    const isPrime = (n: number) => {
      if (n < 2) return false;
      for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
      return true;
    };
    let naiveMax = 0;
    for (let n = 10_000; n < 12_000; n += 2) {
      for (let p = 2; p <= n / 2; p++) {
        if (isPrime(p) && isPrime(n - p)) {
          if (p > naiveMax) naiveMax = p;
          break;
        }
      }
    }
    expect(sweepGoldbach(10_000, 12_000).max_min_prime).toBe(naiveMax);
  });

  it('refuses malformed or unreasonably wide ranges', () => {
    expect(() => sweepGoldbach(2, 100)).toThrow(SweepError);
    expect(() => sweepGoldbach(100, 100)).toThrow(SweepError);
    expect(() => sweepGoldbach(1.5, 100)).toThrow(SweepError);
    expect(() => sweepGoldbach(4, 4 + MAX_SWEEP_SPAN + 2)).toThrow(SweepError);
  });
});

describe('blockAt', () => {
  it('tiles the number line with no gaps and no overlap', () => {
    let cursor = 4;
    const seen: [number, number][] = [];
    for (let i = 0; i < 5; i++) {
      const b = blockAt(cursor);
      seen.push([b.start, b.end]);
      cursor = b.end;
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i][0]).toBe(seen[i - 1][1]); // start of one == end of the last
    }
    expect(seen[0][0]).toBe(4);
    expect(seen[0][1] - seen[0][0]).toBe(ONBOARDING_CANDIDATES * 2);
  });

  it('never starts below 4 and always starts even', () => {
    expect(blockAt(0).start).toBe(4);
    expect(blockAt(-100).start).toBe(4);
    expect(blockAt(1001).start % 2).toBe(0);
  });
});
