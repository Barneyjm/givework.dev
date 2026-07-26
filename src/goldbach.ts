// The deterministic Goldbach range sweep — the arithmetic behind the onboarding
// task and behind its verification.
//
// A "sweep" takes a half-open range of integers and, for every even n in it,
// finds a decomposition n = p + q into two primes. The overwhelmingly likely
// outcome is that every single n decomposes and nothing anomalous turns up. That
// is the point, not a failure: a clean sweep is territory ruled out, and it is
// recorded permanently against the contributor's name. The only outcome that
// would settle the conjecture is an even n with NO decomposition at all, which
// this code would report as a counterexample and which the verification layer
// then treats as a disproof.
//
// The sweep is also the *verifier*: a submitted claim about a range is checked
// by re-running this function inside the control plane and comparing. That is
// what makes the onboarding task auto-verifying — nobody has to read it, so 200
// newcomers in a week cost zero human minutes.
//
// Performance matters because this runs in a Cloudflare Worker on every submit.
// A naive "trial-divide every candidate" sweep is ~10^8 operations per block; a
// segmented sieve is ~10^5. Memory is bounded by the block span, not by `hi`, so
// the cursor can march far out without the sieve growing.

/**
 * The largest prime we will try as the smaller summand. Every known even number
 * decomposes with a far smaller p — the record below 4·10^18 is 9781 — so this
 * is generous. If some n ever needed more, the sweep reports `exhausted: false`
 * for that n rather than claiming a counterexample it did not actually prove.
 */
const SMALL_PRIME_BOUND = 65_536;

/** Hard ceiling on the top of a sweep; beyond this the base sieve stops being cheap. */
export const MAX_SWEEP_VALUE = 1_000_000_000_000;

/** Hard ceiling on how wide one sweep may be, so a bogus claim can't hang a Worker. */
export const MAX_SWEEP_SPAN = 1_000_000;

/** Even numbers allocated to one onboarding sweep. Span is twice this. */
export const ONBOARDING_CANDIDATES = 40_000;

export interface GoldbachRange {
  /** First even integer in the sweep (inclusive). */
  start: number;
  /** One past the last integer in the sweep (exclusive); also the next block's start. */
  end: number;
  /** How many even integers the block covers. */
  candidates: number;
}

/**
 * The block a cursor points at. Ranges are allocated by advancing this cursor,
 * so blocks tile the number line without gaps or overlaps and two contributors
 * can never be handed the same ground.
 */
export function blockAt(cursor: number, candidates = ONBOARDING_CANDIDATES): GoldbachRange {
  const start = Math.max(4, cursor - (cursor % 2));
  return { start, end: start + candidates * 2, candidates };
}

export interface SweepFinding {
  /** The even number. */
  n: number;
  /** The smallest prime p such that n - p is also prime. */
  p: number;
}

export interface SweepResult {
  start: number;
  end: number;
  /** Even numbers actually examined. */
  checked: number;
  /**
   * Even numbers in the range with no two-prime decomposition — a disproof of
   * Goldbach if non-empty. Only ever populated when the search for that n was
   * exhaustive (see `exhaustive`), so this can never be a false alarm.
   */
  counterexamples: number[];
  /**
   * The largest "smallest prime summand" needed anywhere in the range, and the
   * first n that needed it. A genuinely computed statistic (it cannot be guessed
   * from the statement), which is what lets the verifier tell a runner that did
   * the work from one that only claimed to.
   */
  max_min_prime: number;
  max_min_prime_at: number;
  /**
   * True when every n in the range was decided by an exhaustive search. False
   * means some n needed a summand beyond SMALL_PRIME_BOUND and was left
   * undecided — the sweep is then inconclusive rather than wrong.
   */
  exhaustive: boolean;
}

export class SweepError extends Error {}

/** Primes up to and including `n`, via a plain sieve. */
function primesUpTo(n: number): number[] {
  const composite = new Uint8Array(n + 1);
  const out: number[] = [];
  for (let i = 2; i <= n; i++) {
    if (composite[i]) continue;
    out.push(i);
    if (i * i <= n) {
      for (let m = i * i; m <= n; m += i) composite[m] = 1;
    }
  }
  return out;
}

/**
 * Sweep every even n with `start <= n < end`, finding the smallest prime p for
 * which n - p is prime. Pure and deterministic: the same range always yields the
 * same result, which is exactly what makes it usable as a verifier.
 *
 * Throws SweepError for a range that is malformed or wider than we are willing
 * to check inline; callers turn that into an 'inconclusive' verdict rather than
 * a rejection, because an unverifiable claim is not a false claim.
 */
export function sweepGoldbach(start: number, end: number): SweepResult {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new SweepError('range bounds must be integers');
  }
  if (start < 4) throw new SweepError('Goldbach ranges start at 4');
  if (end <= start) throw new SweepError('range end must be greater than range start');
  if (end > MAX_SWEEP_VALUE) throw new SweepError(`range end exceeds ${MAX_SWEEP_VALUE}`);
  if (end - start > MAX_SWEEP_SPAN) throw new SweepError(`range wider than ${MAX_SWEEP_SPAN}`);

  // Base primes: enough to sieve the segment (up to sqrt(end)) AND enough to
  // serve as candidate summands (up to SMALL_PRIME_BOUND).
  const baseLimit = Math.max(SMALL_PRIME_BOUND, Math.floor(Math.sqrt(end)) + 1);
  const basePrimes = primesUpTo(baseLimit);
  const smallPrimes = basePrimes.filter((p) => p <= SMALL_PRIME_BOUND);

  // Segment covers [segLo, end): the sweep range, extended downward far enough
  // that n - p always lands inside it for every candidate summand p.
  const segLo = Math.max(2, start - SMALL_PRIME_BOUND);
  const composite = new Uint8Array(end - segLo);
  for (const p of basePrimes) {
    if (p * p >= end) break;
    // First multiple of p at or above segLo, by integer arithmetic — segLo can be
    // ~10^12, where Math.ceil(segLo / p) * p is not reliably exact.
    const rem = segLo % p;
    let m = Math.max(p * p, rem === 0 ? segLo : segLo + (p - rem));
    for (; m < end; m += p) composite[m - segLo] = 1;
  }
  // Only ever asked about values inside the segment: candidate summands come from
  // smallPrimes (already known prime) and n - p is >= segLo by construction.
  const isPrime = (v: number) => v >= 2 && !composite[v - segLo];

  const firstEven = start % 2 === 0 ? start : start + 1;
  const counterexamples: number[] = [];
  let checked = 0;
  let maxMinPrime = 0;
  let maxMinPrimeAt = 0;
  let exhaustive = true;

  for (let n = firstEven; n < end; n += 2) {
    checked++;
    let found = 0;
    for (const p of smallPrimes) {
      if (p > n / 2) break;
      if (isPrime(n - p)) {
        found = p;
        break;
      }
    }
    if (found) {
      if (found > maxMinPrime) {
        maxMinPrime = found;
        maxMinPrimeAt = n;
      }
      continue;
    }
    // No decomposition with p <= SMALL_PRIME_BOUND. If the search covered every
    // p <= n/2 it was exhaustive and this really is a counterexample; otherwise
    // we simply did not look far enough and must not claim one.
    if (n / 2 <= SMALL_PRIME_BOUND) counterexamples.push(n);
    else exhaustive = false;
  }

  return {
    start,
    end,
    checked,
    counterexamples,
    max_min_prime: maxMinPrime,
    max_min_prime_at: maxMinPrimeAt,
    exhaustive,
  };
}
