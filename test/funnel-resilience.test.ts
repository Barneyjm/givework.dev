import { beforeAll, describe, expect, it, vi } from 'vitest';

// The load-bearing property of the funnel: an event that cannot be recorded must
// never break the action it describes. A missing analytics row is a reporting
// gap; a failed checkout is a lost donation.
//
// This is proved by breaking the real thing rather than by mocking away the
// swallow we are trying to test — but the breakage is scoped to THIS FILE'S
// module registry, not to the shared database. Every statement that names
// funnel_events is rewritten to name a table that does not exist, so Postgres
// raises a genuine 42P01 on the real code path, inside the real transaction the
// money operations run in. If any money operation is coupled to analytics — or
// if the funnel write is not savepoint-guarded, so its error poisons the
// caller's transaction — it fails here.
//
// Deliberately NOT done by renaming funnel_events in the database: a Ctrl-C, a
// worker crash or a hook timeout between the rename and the restore would leave
// the shared podman Postgres without the table, and since resetDb() truncates
// it, every later `npm test` would die in its first beforeEach with an error
// that points nowhere near this file.
vi.mock('../src/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db.js')>();
  // The savepoint is named funnel_evt precisely so this rewrite cannot touch it.
  const breakIt = (text: string) => text.replace(/\bfunnel_events\b/g, 'funnel_events_gone');
  const sabotage = (client: { query: (t: any, p?: any) => any }) => ({
    query: (text: any, params?: any) =>
      typeof text === 'string' ? client.query(breakIt(text), params) : client.query(text, params),
  });
  return {
    ...actual,
    query: (text: string, params?: unknown[]) => actual.query(breakIt(text), params),
    withTransaction: <T>(fn: (c: any) => Promise<T>) =>
      actual.withTransaction((client) => fn(sabotage(client))),
  };
});

const { pool, query } = await import('../src/db.js');
const { checkoutTask, getBudget, mintOnboardingTask, setOwnBudget, submitResult } = await import(
  '../src/operations.js'
);
const { createDev, createOnboardingTarget, createTarget, createTask, getTaskRow, resetDb } =
  await import('./helpers.js');

async function funnelRowCount(): Promise<number> {
  // Straight through the unmocked pool — the table itself is untouched.
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM funnel_events`);
  return rows[0].n;
}

describe('a funnel write that fails never breaks the action', () => {
  beforeAll(async () => {
    await resetDb();
    await createOnboardingTarget(4);
  });

  it('confirms the funnel really is broken for this file', async () => {
    await expect(query(`SELECT 1 FROM funnel_events`)).rejects.toThrow(/funnel_events_gone/);
    // …and only for this file: the real table is still there, still empty.
    expect(await funnelRowCount()).toBe(0);
  });

  it('still sets a budget', async () => {
    const dev = await createDev('budget-anyway');
    const b = await setOwnBudget(dev, 500);
    expect(b.budget_cents).toBe(500);
  });

  it('still mints an onboarding task', async () => {
    const dev = await createDev('mint-anyway');
    await setOwnBudget(dev, 500);
    const t = await mintOnboardingTask(dev);
    expect(t.task_id).toBeTruthy();
    expect(t.candidates).toBeGreaterThan(0);
  });

  it('still checks out, submits, books the spend, and writes the ledger', async () => {
    const dev = await createDev('submit-anyway');
    await setOwnBudget(dev, 500);
    const target = await createTarget();
    const task = await createTask(target, { max: 100 });

    await checkoutTask(dev, task);
    expect((await getBudget(dev))?.reserved_cents).toBe(100);
    expect((await getTaskRow(task)).status).toBe('locked');

    const r = await submitResult(dev, task, { ok: true }, 42, null);
    expect(r.spent_applied).toBe(42);
    const budget = await getBudget(dev);
    expect(budget?.spent_cents).toBe(42);
    expect(budget?.reserved_cents).toBe(0);

    // The ledger — the record that actually matters — is complete.
    const { rows } = await pool.query(
      `SELECT event_type FROM ledger WHERE dev_id = $1 ORDER BY id`,
      [dev],
    );
    expect(rows.map((x) => x.event_type)).toEqual(['checkout', 'submit']);
  });

  it('recorded nothing at all — the writes really did fail', async () => {
    // Every operation above emits at least one event; not one of them landed,
    // and every operation still succeeded.
    expect(await funnelRowCount()).toBe(0);
  });
});
