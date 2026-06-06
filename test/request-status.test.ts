import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import {
  completedRequestForTask,
  getRequestResultsForToken,
  getRequestStatus,
  publishIntake,
  receiveIntake,
} from '../src/intake/operations.js';
import { app } from '../src/server.js';
import { createNonprofit, createTask, resetDb } from './helpers.js';

afterAll(closePool);
beforeEach(resetDb);

/** A request with a quantity → the stub makes several tasks on publish. */
async function newRequest() {
  return receiveIntake({
    from_email: 'director@shelter.org',
    subject: 'Need help',
    body: 'Please summarize 30 client intake forms.',
  });
}

describe('getRequestStatus stage mapping', () => {
  it('reports "received" before publish', async () => {
    const r = await newRequest();
    const s = await getRequestStatus(r.intake_id);
    expect(s?.stage).toBe('received');
    expect(s?.label).toBe('Received');
    expect(s?.org).toBeTruthy();
    expect(s?.progress).toEqual({ done: 0, total: 0 });
    // submitted_at is a normalized ISO string, not a Date.
    expect(typeof s?.submitted_at).toBe('string');
    expect(s?.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports "in_progress" with progress once published', async () => {
    const r = await newRequest();
    await publishIntake(r.intake_id, undefined, 'admin');
    const s = await getRequestStatus(r.intake_id);
    expect(s?.stage).toBe('in_progress');
    expect(s?.progress.total).toBeGreaterThan(0);
    expect(s?.progress.done).toBe(0);
    expect(s?.note).toContain('working on it');
  });

  it('reports "complete" when every task is accepted', async () => {
    const r = await newRequest();
    await publishIntake(r.intake_id, undefined, 'admin');
    await pool.query(`UPDATE tasks SET status = 'accepted' WHERE intake_request_id = $1`, [
      r.intake_id,
    ]);
    const s = await getRequestStatus(r.intake_id);
    expect(s?.stage).toBe('complete');
    expect(s?.progress.done).toBe(s?.progress.total);
  });

  it('reports "closed" for a rejected request', async () => {
    const r = await newRequest();
    await pool.query(`UPDATE intake_requests SET status = 'rejected' WHERE id = $1`, [r.intake_id]);
    const s = await getRequestStatus(r.intake_id);
    expect(s?.stage).toBe('closed');
  });

  it('returns null for an unknown id and a non-UUID token (no leak, no 500)', async () => {
    expect(await getRequestStatus('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await getRequestStatus('not-a-uuid')).toBeNull();
    expect(await getRequestStatus("'; DROP TABLE intake_requests; --")).toBeNull();
  });

  it('never exposes task content or internals', async () => {
    const r = await newRequest();
    await publishIntake(r.intake_id, undefined, 'admin');
    const s = await getRequestStatus(r.intake_id);
    const keys = Object.keys(s ?? {}).sort();
    expect(keys).toEqual(['label', 'note', 'org', 'progress', 'stage', 'submitted_at']);
  });
});

describe('GET /requests/:id', () => {
  it('returns the public status for a real id and 404 otherwise', async () => {
    const r = await newRequest();
    const ok = await app.fetch(new Request(`http://test/requests/${r.intake_id}`));
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body.stage).toBe('received');

    const missing = await app.fetch(
      new Request('http://test/requests/00000000-0000-0000-0000-000000000000'),
    );
    expect(missing.status).toBe(404);

    const junk = await app.fetch(new Request('http://test/requests/nope'));
    expect(junk.status).toBe(404);
  });
});

describe('completedRequestForTask (completion trigger)', () => {
  it('returns the notify target only once every task is accepted', async () => {
    const r = await newRequest();
    await publishIntake(r.intake_id, undefined, 'admin');
    const ids = (
      await pool.query(`SELECT id FROM tasks WHERE intake_request_id = $1 ORDER BY created_at`, [
        r.intake_id,
      ])
    ).rows.map((x) => x.id);

    // Accept all but the last → not complete yet.
    await pool.query(`UPDATE tasks SET status='accepted' WHERE id = ANY($1::uuid[])`, [
      ids.slice(0, -1),
    ]);
    expect(await completedRequestForTask(ids[0])).toBeNull();

    // Accept the last → completing acceptance returns the target.
    await pool.query(`UPDATE tasks SET status='accepted' WHERE id = $1`, [ids.at(-1)]);
    const target = await completedRequestForTask(ids.at(-1)!);
    expect(target).toMatchObject({ request_id: r.intake_id, from_email: 'director@shelter.org' });
    expect(target?.org).toBeTruthy();

    // Idempotent: a second call (e.g. a concurrent accept) claims nothing.
    expect(await completedRequestForTask(ids[0])).toBeNull();
  });

  it('is null for a task that has no intake request (admin-created)', async () => {
    const np = await createNonprofit();
    const taskId = await createTask(np, { max: 100 });
    await pool.query(`UPDATE tasks SET status='accepted' WHERE id = $1`, [taskId]);
    expect(await completedRequestForTask(taskId)).toBeNull();
  });
});

describe('results (token-gated, complete-only)', () => {
  async function completeWithResults() {
    const r = await newRequest();
    await publishIntake(r.intake_id, undefined, 'admin');
    // Give each task a result, then accept all → request complete.
    await pool.query(
      `UPDATE tasks SET status='accepted', result = jsonb_build_object('summary', 'done ' || title)
        WHERE intake_request_id = $1`,
      [r.intake_id],
    );
    return r.intake_id;
  }

  it('returns null while in progress and for unknown ids', async () => {
    const r = await newRequest();
    await publishIntake(r.intake_id, undefined, 'admin'); // tasks open, not accepted
    expect(await getRequestResultsForToken(r.intake_id)).toBeNull();
    expect(await getRequestResultsForToken('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await getRequestResultsForToken('not-a-uuid')).toBeNull();
  });

  it('returns the task outputs once complete', async () => {
    const id = await completeWithResults();
    const results = await getRequestResultsForToken(id);
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThan(0);
    expect(results![0]).toHaveProperty('title');
    expect((results![0].result as any).summary).toContain('done');
  });

  it('GET /requests/:id/results: 404 in progress, JSON + CSV download when complete', async () => {
    const open = await newRequest();
    await publishIntake(open.intake_id, undefined, 'admin');
    expect(
      (await app.fetch(new Request(`http://test/requests/${open.intake_id}/results`))).status,
    ).toBe(404);

    const id = await completeWithResults();
    const json = await app.fetch(new Request(`http://test/requests/${id}/results`));
    expect(json.status).toBe(200);
    expect(((await json.json()) as any).results.length).toBeGreaterThan(0);

    const csv = await app.fetch(new Request(`http://test/requests/${id}/results?download=csv`));
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(csv.headers.get('content-disposition')).toContain('attachment');
    expect(await csv.text()).toContain('task,summary');
  });
});
