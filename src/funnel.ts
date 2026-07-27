import type { Client } from './db.js';
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
//  4. Free on the hot path. Analytics must not cost a database connection. On
//     Cloudflare Workers `query()` opens, connects and closes a NEW pg.Client per
//     call, so a standalone insert would double the connects on POST /checkout
//     and POST /submit — against a possibly-cold Neon compute, on the donation
//     path. So the money operations hand recordEvent the connection they already
//     hold and it writes on that, inside their transaction, guarded by a
//     SAVEPOINT (see below).
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

const INSERT_EVENT = `INSERT INTO funnel_events (dev_id, event, detail) VALUES ($1, $2, $3)`;

/**
 * Append one funnel event. Never throws and never rejects — a failure here is
 * logged and dropped so the caller's action (checkout, submit, budget change)
 * completes regardless.
 *
 * Awaited rather than fire-and-forget on purpose: on Cloudflare Workers a
 * floating promise is cancelled when the response is returned, so a
 * "non-blocking" write would simply not happen in production.
 *
 * Pass `client` when the caller already holds a connection — every money
 * operation does, inside its transaction. That is the difference between one
 * connect per checkout and two, which on Workers is a real per-request cost. The
 * insert then rides the caller's transaction, wrapped in a SAVEPOINT so a failed
 * analytics write (a missing table, a dropped column, an FK violation) rolls back
 * to the savepoint instead of poisoning the transaction that carries the money.
 * With no client it falls back to a standalone write, which is right for the
 * paths that have no transaction to join.
 */
export async function recordEvent(
  devId: string | null,
  event: FunnelEvent,
  detail?: unknown,
  client?: Client,
): Promise<void> {
  const params = [devId, event, detail !== undefined ? JSON.stringify(detail) : null];
  try {
    if (!client) {
      await query(INSERT_EVENT, params);
      return;
    }
    await client.query('SAVEPOINT funnel_evt');
    try {
      await client.query(INSERT_EVENT, params);
      await client.query('RELEASE SAVEPOINT funnel_evt');
    } catch (err) {
      // Postgres aborts the whole transaction on any error; rolling back to the
      // savepoint is what lets the caller's COMMIT still succeed.
      await client.query('ROLLBACK TO SAVEPOINT funnel_evt');
      throw err;
    }
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
  /**
   * Share of devs that reached the PREVIOUS stage and also reached this one.
   * `null` — never 0 — when the previous stage has nobody in it, because a ratio
   * with no denominator is undefined, not zero. Rendering it as 0% would report
   * "this stage converts nobody" for a stage that in fact converted everybody it
   * was given.
   */
  conversion_from_previous: number | null;
  /** Share of all signed-up devs that reached this stage; null when nobody is tracked as signed up. */
  conversion_from_signup: number | null;
}

export interface FunnelReport {
  /** Rows in `devs` — the ground truth, including devs that predate this log. */
  devs_total: number;
  /**
   * Devs that exist but never emitted `dev_created` — i.e. they predate this log.
   * While this is non-zero the signup baseline is incomplete, so the "of signups"
   * column is measured against a partial denominator (or, when every dev predates
   * the log, against none at all and the rates are null).
   */
  untracked_devs: number;
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

/**
 * Ratio rounded to 4dp so the JSON stays readable — or `null` when the base is
 * 0. Reporting an undefined ratio as 0 is not a rounding choice, it is a wrong
 * answer: devs who predate this log emit no dev_created, so `signed_up` is 0
 * while every later stage is non-zero, and a 0 there reads as "onboarding
 * converts nobody" when it converted everybody. Undefined is undefined; the
 * renderer shows it as "—".
 */
function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
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
    untracked_devs: Math.max(0, r.devs_total - r.signed_up),
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
