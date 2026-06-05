import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { receiveIntake, publishIntake, getRequestStatus } from '../src/intake/operations.js';
import { app } from '../src/server.js';
import { pool, closePool } from '../src/db.js';
import { resetDb } from './helpers.js';

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
    await pool.query(`UPDATE tasks SET status = 'accepted' WHERE intake_request_id = $1`, [r.intake_id]);
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
