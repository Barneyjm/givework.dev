import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db.js';
import { findApprovedTargetForSender } from '../src/intake/operations.js';
import { app } from '../src/server.js';
import {
  createTarget,
  createTask,
  createVerifiedTarget,
  mintAdminToken,
  resetDb,
} from './helpers.js';

afterAll(closePool);

let adminTok: string;
beforeEach(async () => {
  await resetDb();
  adminTok = await mintAdminToken();
});

const bearer = (t: string) => ({
  authorization: `Bearer ${t}`,
  'content-type': 'application/json',
});
function req(path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://test${path}`, init));
}
async function addIdentifier(targetId: string, kind: string, value: string) {
  await pool.query(`INSERT INTO target_identifiers (target_id, kind, value) VALUES ($1, $2, $3)`, [
    targetId,
    kind,
    value,
  ]);
}

describe('findApprovedTargetForSender with identifiers', () => {
  it('authorizes an admin-added email beyond the contact_email', async () => {
    const id = await createVerifiedTarget('director@helpful.org');
    await addIdentifier(id, 'email', 'grants@helpful.org');
    expect(await findApprovedTargetForSender('grants@helpful.org')).toBe(id);
  });

  it('authorizes an admin-added domain (incl. a second, unrelated domain)', async () => {
    const id = await createVerifiedTarget('director@helpful.org');
    await addIdentifier(id, 'domain', 'helpful-foundation.org');
    expect(await findApprovedTargetForSender('anyone@helpful-foundation.org')).toBe(id);
  });

  it('a deny entry blocks an address its own domain would otherwise allow', async () => {
    const id = await createVerifiedTarget('director@helpful.org'); // domain helpful.org allowed
    expect(await findApprovedTargetForSender('intern@helpful.org')).toBe(id);
    await addIdentifier(id, 'email_deny', 'intern@helpful.org');
    expect(await findApprovedTargetForSender('intern@helpful.org')).toBeNull();
    // The director (and other staff) still pass.
    expect(await findApprovedTargetForSender('director@helpful.org')).toBe(id);
  });

  it('a domain_deny blocks a whole added domain', async () => {
    const id = await createVerifiedTarget('director@helpful.org');
    await addIdentifier(id, 'domain', 'partner.org');
    expect(await findApprovedTargetForSender('x@partner.org')).toBe(id);
    await addIdentifier(id, 'domain_deny', 'partner.org');
    expect(await findApprovedTargetForSender('x@partner.org')).toBeNull();
  });

  it("one org's deny does NOT suppress a sender another org legitimately allows", async () => {
    // Org A blocks shared.org for itself; Org B authorizes it as its own domain.
    const orgA = await createVerifiedTarget('a@orga.org', 'Org A');
    await addIdentifier(orgA, 'domain_deny', 'shared.org');
    const orgB = await createVerifiedTarget('b@shared.org', 'Org B');
    // B's sender must still resolve to B — A's deny is scoped to A only.
    expect(await findApprovedTargetForSender('team@shared.org')).toBe(orgB);
  });
});

describe('admin nonprofit management', () => {
  it('adds and removes identifiers, with validation and duplicate protection', async () => {
    const id = await createVerifiedTarget('director@helpful.org');

    const add = await req(`/admin/targets/${id}/identifiers`, {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ kind: 'domain', value: '@Helpful-Foundation.ORG' }), // normalized
    });
    expect(add.status).toBe(200);
    const created: any = await add.json();
    expect(created.value).toBe('helpful-foundation.org'); // lowercased, @ stripped

    // Bad kind / shape are rejected.
    const badKind = await req(`/admin/targets/${id}/identifiers`, {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ kind: 'nope', value: 'x' }),
    });
    expect(badKind.status).toBe(400);
    const emailNoAt = await req(`/admin/targets/${id}/identifiers`, {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ kind: 'email', value: 'helpful.org' }),
    });
    expect(emailNoAt.status).toBe(400);

    // Duplicate (same kind+value) -> 409.
    const dup = await req(`/admin/targets/${id}/identifiers`, {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ kind: 'domain', value: 'helpful-foundation.org' }),
    });
    expect(dup.status).toBe(409);

    // Remove it.
    const del = await req(`/admin/targets/${id}/identifiers/${created.id}`, {
      method: 'DELETE',
      headers: bearer(adminTok),
    });
    expect(del.status).toBe(200);
    const gone = await req(`/admin/targets/${id}/identifiers/${created.id}`, {
      method: 'DELETE',
      headers: bearer(adminTok),
    });
    expect(gone.status).toBe(404);
  });

  it('lets two orgs deny the same value (per-org) but keeps allow domains globally unique', async () => {
    const orgA = await createVerifiedTarget('a@orga.org', 'Org A');
    const orgB = await createVerifiedTarget('b@orgb.org', 'Org B');
    const deny = (id: string) =>
      req(`/admin/targets/${id}/identifiers`, {
        method: 'POST',
        headers: bearer(adminTok),
        body: JSON.stringify({ kind: 'domain_deny', value: 'spammer.com' }),
      });
    // Deny is org-scoped, so both orgs can block the same domain.
    expect((await deny(orgA)).status).toBe(200);
    expect((await deny(orgB)).status).toBe(200);
    // But the same org can't list the identical deny twice.
    expect((await deny(orgA)).status).toBe(409);

    // Allow domains stay globally unique — a second org can't claim orgA's.
    const allow = (id: string) =>
      req(`/admin/targets/${id}/identifiers`, {
        method: 'POST',
        headers: bearer(adminTok),
        body: JSON.stringify({ kind: 'domain', value: 'shared-claim.org' }),
      });
    expect((await allow(orgA)).status).toBe(200);
    expect((await allow(orgB)).status).toBe(409);
  });

  it('overrides fields: verify and list a nonprofit', async () => {
    const id = await createTarget('Hope House'); // starts unverified, unlisted
    const res = await req(`/admin/targets/${id}`, {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ verified: true, listed: true }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ verified: true, listed: true });

    // Partial update keeps untouched fields (verified stays true).
    const res2 = await req(`/admin/targets/${id}`, {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ name: 'Hope House Inc' }),
    });
    const body2: any = await res2.json();
    expect(body2).toMatchObject({ name: 'Hope House Inc', verified: true, listed: true });
  });

  it('requires an admin token', async () => {
    const id = await createTarget();
    const res = await req(`/admin/targets/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listed: true }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /transparency (public)', () => {
  it('lists only opt-in orgs with their task counts, and is unauthenticated', async () => {
    const shown = await createVerifiedTarget('a@shown.org', 'Shown Org');
    const hidden = await createVerifiedTarget('b@hidden.org', 'Hidden Org');
    await pool.query(`UPDATE targets SET listed = true WHERE id = $1`, [shown]);

    // Shown org: 3 tasks, exactly 2 accepted. Hidden org: 1 task (must not appear).
    const t1 = await createTask(shown, { max: 100 });
    const t2 = await createTask(shown, { max: 100 });
    await createTask(shown, { max: 100 }); // stays 'open'
    await createTask(hidden, { max: 100 });
    await pool.query(`UPDATE tasks SET status = 'accepted' WHERE id = ANY($1::uuid[])`, [[t1, t2]]);

    const res = await app.fetch(new Request('http://test/transparency'));
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.orgs).toHaveLength(1);
    expect(body.orgs[0]).toEqual({ name: 'Shown Org', tasks_total: 3, tasks_accepted: 2 });
    expect(body.totals).toEqual({ orgs: 1, tasks_total: 3, tasks_accepted: 2 });
  });

  it('returns empty rollup when no org has opted in', async () => {
    await createVerifiedTarget('a@x.org'); // verified but not listed
    const res = await app.fetch(new Request('http://test/transparency'));
    const body: any = await res.json();
    expect(body).toEqual({ totals: { orgs: 0, tasks_total: 0, tasks_accepted: 0 }, orgs: [] });
  });
});
