import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db.js';
import {
  checkoutTask,
  getTargetProgress,
  mergeStateUpdate,
  submitResult,
} from '../src/operations.js';
import { app } from '../src/server.js';
import { createDev, createTask, mintAdminToken, resetDb, setBudget } from './helpers.js';

// The working set stopped being a blob that every submit overwrote.
//
// Established facts are append-only rows; the mutable working set merges per
// key; removing a key is an explicit, attributable act; and "what's next" is
// derived from the task graph instead of being written down and going stale.

afterAll(closePool);

let adminTok: string;
beforeEach(async () => {
  await resetDb();
  adminTok = await mintAdminToken();
});

const req = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://test${path}`, init));

async function conjecture(slug: string) {
  const res = await req('/admin/targets', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: slug, slug, kind: 'conjecture' }),
  });
  return (await res.json()) as any;
}

async function work(targetId: string, dev: string, stateUpdate: unknown, summary = 'did a thing') {
  const task = await createTask(targetId, { max: 500 });
  await checkoutTask(dev, task);
  return submitResult(dev, task, { ok: true }, 5, null, {
    outcome: 'progress',
    summary,
    stateUpdate,
  });
}

describe('mergeStateUpdate (pure)', () => {
  it('merges per key instead of replacing the whole blob', () => {
    const out = mergeStateUpdate({ cursor: 100, best: 'a' }, { cursor: 200 });
    // The old behaviour dropped `best` entirely — any submit could destroy what
    // it did not happen to re-state.
    expect(out.state).toEqual({ cursor: 200, best: 'a' });
    expect(out.facts).toEqual([]);
  });

  it('routes facts out of the blob', () => {
    const out = mergeStateUpdate({ cursor: 1 }, { cursor: 2, facts: ['girth 6 closed'] });
    expect(out.facts).toEqual(['girth 6 closed']);
    expect(out.state).toEqual({ cursor: 2 }); // never stored in the blob
  });

  it('accepts facts as strings or {claim} objects, ignoring blanks', () => {
    const out = mergeStateUpdate({}, { facts: ['a', { claim: 'b' }, '', '   ', { claim: '' }, 7] });
    expect(out.facts).toEqual(['a', 'b']);
  });

  it('removes a key only when explicitly retracted', () => {
    const existing = { cursor: 1, attempt7_note: 'debris', timeout_salvage: { partial: 'x' } };
    // Omitting a key no longer deletes it...
    expect(mergeStateUpdate(existing, { cursor: 2 }).state).toHaveProperty('attempt7_note');
    // ...naming it does. This is what lets an agent clean up after a dead end
    // without an admin editing the field by hand.
    const cleaned = mergeStateUpdate(existing, {
      cursor: 2,
      $retract: ['attempt7_note', 'timeout_salvage'],
    });
    expect(cleaned.state).toEqual({ cursor: 2 });
    expect(cleaned.retracted).toEqual(['attempt7_note', 'timeout_salvage']);
  });

  it('never leaves the reserved keys in the stored blob', () => {
    const out = mergeStateUpdate({ facts: ['stale'], $retract: ['x'] }, { a: 1 });
    expect(out.state).toEqual({ a: 1 });
  });

  it('replaces wholesale for a non-object update, as before', () => {
    expect(mergeStateUpdate({ a: 1 }, 42).state).toBe(42);
    expect(mergeStateUpdate({ a: 1 }, [1, 2]).state).toEqual([1, 2]);
    expect(mergeStateUpdate({ a: 1 }, null).state).toBeNull();
  });

  it('tolerates a non-object existing state', () => {
    expect(mergeStateUpdate(null, { a: 1 }).state).toEqual({ a: 1 });
    expect(mergeStateUpdate('legacy', { a: 1 }).state).toEqual({ a: 1 });
  });
});

describe('facts survive submits that used to clobber them', () => {
  it('accumulates across agents and is never overwritten by a later working set', async () => {
    const conj = await conjecture('facts');
    const a = await createDev('agent-a');
    const b = await createDev('agent-b');
    await setBudget(a, 100_000);
    await setBudget(b, 100_000);

    await work(conj.id, a, { cursor: 100, facts: ['searched to 100'] });
    // Agent B knows nothing about A's state and writes only its own key — the
    // exact submit that used to destroy everything before it.
    await work(conj.id, b, { note: 'unrelated', facts: ['girth 6 closed'] });

    const p = (await getTargetProgress('facts'))!;
    expect(p.facts.map((f) => f.claim)).toEqual(['searched to 100', 'girth 6 closed']);
    expect(p.state).toEqual({ cursor: 100, note: 'unrelated' }); // merged, not replaced
    // Each fact is attributable to the contribution that established it.
    expect(p.facts.every((f) => typeof f.established_by === 'number')).toBe(true);
  });

  it('is idempotent — a repeated claim does not stack duplicate rows', async () => {
    const conj = await conjecture('dedupe');
    const dev = await createDev('repeater');
    await setBudget(dev, 100_000);
    await work(conj.id, dev, { facts: ['n verified to 10^6'] });
    await work(conj.id, dev, { facts: ['n verified to 10^6'] });
    const p = (await getTargetProgress('dedupe'))!;
    expect(p.facts).toHaveLength(1);
  });

  it('is not truncated away when the working set grows past the blob cap', async () => {
    const conj = await conjecture('bigstate');
    const dev = await createDev('bloater');
    await setBudget(dev, 100_000);
    await work(conj.id, dev, { facts: ['this must survive'] });
    // A working set well past MAX_STATE_BYTES (64 KB), alongside a small key.
    await work(conj.id, dev, { blob: 'x'.repeat(80 * 1024), cursor: 42 });
    const p = (await getTargetProgress('bigstate'))!;
    // The oversized key was dropped by name; the small one and the fact both
    // survive — the fact because it was never in the blob at all.
    expect((p.state as any)._dropped).toEqual(['blob']);
    expect((p.state as any).cursor).toBe(42);
    expect(p.facts.map((f) => f.claim)).toEqual(['this must survive']);
  });
});

describe('next steps are derived, so they cannot go stale', () => {
  it('lists claimable work and counts what is in flight or expired', async () => {
    const conj = await conjecture('derived');
    const dev = await createDev('derive-dev');
    await setBudget(dev, 100_000);
    await createTask(conj.id, { max: 40 });
    await createTask(conj.id, { max: 15 });

    const p = (await getTargetProgress('derived'))!;
    expect(p.next_steps.claimable).toHaveLength(2);
    // Cheapest first: the smallest next step is the easiest to pick up.
    expect(p.next_steps.claimable[0].max_cost_cents).toBe(15);
    expect(p.next_steps.stalled).toBe(false);
    expect(p.next_steps.awaiting_verification).toBe(0);
  });

  it('reports stalled when there is no claimable work and nothing in flight', async () => {
    await conjecture('stalled');
    const p = (await getTargetProgress('stalled'))!;
    expect(p.next_steps.claimable).toEqual([]);
    expect(p.next_steps.stalled).toBe(true);
  });

  it('drops a task from claimable the moment it is claimed — no field to update', async () => {
    const conj = await conjecture('live');
    const dev = await createDev('live-dev');
    await setBudget(dev, 100_000);
    const task = await createTask(conj.id, { max: 40 });
    expect((await getTargetProgress('live'))!.next_steps.claimable).toHaveLength(1);
    await checkoutTask(dev, task);
    const after = (await getTargetProgress('live'))!.next_steps;
    expect(after.claimable).toEqual([]);
    expect(after.stalled).toBe(false); // in flight, not stalled
  });
});
