import { query } from './db.js';

// Funnel instrumentation — the minimum needed to answer "what fraction of the
// people who sign up ever submit anything?", which today we cannot answer at all.
//
// Design rules, in order of importance:
//
//  1. Recording an event must NEVER break the action it describes. Every write
//     goes through recordEvent, which swallows its own failures. A missing
//     analytics row is a reporting gap; a failed checkout is a lost donation.
//  2. Append-only. Nothing updates or deletes these rows, so the log can be
//     re-aggregated later with a different definition of the funnel.
//  3. Separate from `ledger`. The ledger is money and is load-bearing for
//     accounting; mixing analytics into it would make an analytics bug an
//     accounting bug.
//  4. Cheap. One small INSERT per event, on the same connection pool. Events are
//     emitted after the transaction they describe has committed, so they never
//     hold a lock or extend a transaction.
//
// "First X" is not stored as its own event type: we record EVERY checkout and
// EVERY submit and derive first-vs-repeat by counting per dev. That keeps the
// writer dumb (no read-before-write, no races) and lets the report distinguish
// one-and-done from repeat usage without a schema change.

export type FunnelEvent =
  /** A dev row was created (self-serve GitHub sign-in, or an admin seed). */
  | 'dev_created'
  /** The dev set their own budget for a period. Recorded every time. */
  | 'budget_set'
  /** An onboarding task was minted for the dev (first-run flow). */
  | 'onboarding_minted'
  /** A task was checked out. Recorded every time; first vs repeat is derived. */
  | 'checkout'
  /** A contribution was submitted. Recorded every time. */
  | 'submit';

/**
 * Append one funnel event. Never throws and never rejects — a failure here is
 * logged and dropped so the caller's action (checkout, submit, budget change)
 * completes regardless.
 *
 * Awaited rather than fire-and-forget on purpose: on Cloudflare Workers a
 * floating promise is cancelled when the response is returned, so a
 * "non-blocking" write would simply not happen in production. The insert is a
 * single row on an already-open pool, and it can only ever add latency — never
 * an error — to the path it instruments.
 */
export async function recordEvent(
  devId: string | null,
  event: FunnelEvent,
  detail?: unknown,
): Promise<void> {
  try {
    await query(`INSERT INTO funnel_events (dev_id, event, detail) VALUES ($1, $2, $3)`, [
      devId,
      event,
      detail !== undefined ? JSON.stringify(detail) : null,
    ]);
  } catch (err) {
    // Deliberately swallowed. See the contract above.
    console.error(`funnel: failed to record ${event}`, err);
  }
}

export interface FunnelStage {
  /** The stage's key, in funnel order. */
  stage: string;
  /** Distinct devs that reached this stage. */
  devs: number;
  /** Share of devs that reached the PREVIOUS stage and also reached this one. */
  conversion_from_previous: number;
  /** Share of all signed-up devs that reached this stage. */
  conversion_from_signup: number;
}

export interface FunnelReport {
  /** Rows in `devs` — the ground truth, including devs that predate this log. */
  devs_total: number;
  /** Ordered funnel: signed_up -> set_budget -> minted_onboarding -> checked_out -> submitted -> submitted_again. */
  stages: FunnelStage[];
  counts: {
    signed_up: number;
    set_budget: number;
    minted_onboarding: number;
    checked_out: number;
    submitted: number;
    submitted_again: number;
    /** Total submit events (not distinct devs) — the raw volume of contributions. */
    submits_total: number;
    /** Devs whose only ever submit was a single one — the one-and-done cohort. */
    one_and_done: number;
  };
  /** Since when this log has data; null when nothing has been recorded yet. */
  first_event_at: string | null;
  last_event_at: string | null;
}

/** cents-free ratio, rounded to 4dp so the JSON stays readable. 0 when the base is 0. */
function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * The funnel as counts + conversion rates. Admin-only (it is aggregate product
 * analytics, not public transparency). One query does the per-dev rollup; the
 * stages are assembled in TypeScript so the ordering and the rate definitions
 * live somewhere readable.
 *
 * `signed_up` counts devs with a dev_created event, NOT rows in devs: devs that
 * predate this log would otherwise show up as a permanent phantom drop-off at
 * the top of the funnel. devs_total is reported separately so the gap is visible.
 */
export async function getFunnel(): Promise<FunnelReport> {
  const { rows } = await query<{
    signed_up: number;
    set_budget: number;
    minted_onboarding: number;
    checked_out: number;
    submitted: number;
    submitted_again: number;
    submits_total: number;
    devs_total: number;
    first_event_at: string | Date | null;
    last_event_at: string | Date | null;
  }>(
    `WITH per_dev AS (
       SELECT dev_id,
              count(*) FILTER (WHERE event = 'dev_created')       AS created,
              count(*) FILTER (WHERE event = 'budget_set')        AS budgets,
              count(*) FILTER (WHERE event = 'onboarding_minted') AS mints,
              count(*) FILTER (WHERE event = 'checkout')          AS checkouts,
              count(*) FILTER (WHERE event = 'submit')            AS submits
         FROM funnel_events
        WHERE dev_id IS NOT NULL
        GROUP BY dev_id
     )
     SELECT
       (SELECT count(*)::int FROM per_dev WHERE created   > 0) AS signed_up,
       (SELECT count(*)::int FROM per_dev WHERE budgets   > 0) AS set_budget,
       (SELECT count(*)::int FROM per_dev WHERE mints     > 0) AS minted_onboarding,
       (SELECT count(*)::int FROM per_dev WHERE checkouts > 0) AS checked_out,
       (SELECT count(*)::int FROM per_dev WHERE submits   > 0) AS submitted,
       (SELECT count(*)::int FROM per_dev WHERE submits  >= 2) AS submitted_again,
       (SELECT COALESCE(SUM(submits), 0)::int FROM per_dev)    AS submits_total,
       (SELECT count(*)::int FROM devs)                        AS devs_total,
       (SELECT min(created_at) FROM funnel_events)             AS first_event_at,
       (SELECT max(created_at) FROM funnel_events)             AS last_event_at`,
  );
  const r = rows[0];
  const ordered: [string, number][] = [
    ['signed_up', r.signed_up],
    ['set_budget', r.set_budget],
    ['minted_onboarding', r.minted_onboarding],
    ['checked_out', r.checked_out],
    ['submitted', r.submitted],
    ['submitted_again', r.submitted_again],
  ];
  const top = r.signed_up;
  const stages: FunnelStage[] = ordered.map(([stage, devs], i) => ({
    stage,
    devs,
    conversion_from_previous: i === 0 ? rate(devs, top) : rate(devs, ordered[i - 1][1]),
    conversion_from_signup: rate(devs, top),
  }));

  return {
    devs_total: r.devs_total,
    stages,
    counts: {
      signed_up: r.signed_up,
      set_budget: r.set_budget,
      minted_onboarding: r.minted_onboarding,
      checked_out: r.checked_out,
      submitted: r.submitted,
      submitted_again: r.submitted_again,
      submits_total: r.submits_total,
      one_and_done: r.submitted - r.submitted_again,
    },
    first_event_at: r.first_event_at ? new Date(r.first_event_at).toISOString() : null,
    last_event_at: r.last_event_at ? new Date(r.last_event_at).toISOString() : null,
  };
}
