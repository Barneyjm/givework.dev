import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { findApprovedNonprofitForSender } from '../src/intake/operations.js';
import { app } from '../src/server.js';
import { pool, closePool } from '../src/db.js';
import {
  resetDb,
  createVerifiedNonprofit,
  createNonprofit,
  createTask,
  mintAdminToken,
} from './helpers.js';

afterAll(closePool);

let adminTok: string;
beforeEach(async () => {
  await resetDb();
  adminTok = await mintAdminToken();
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
function req(path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://test${path}`, init));
}
async function addIdentifier(nonprofitId: string, kind: string, value: string) {
  await pool.query(
    `INSERT INTO nonprofit_identifiers (nonprofit_id, kind, value) VALUES ($1, $2, $3)`,
    [nonprofitId, kind, value],
  );
}

describe('findApprovedNonprofitForSender with identifiers', () => {
  it('authorizes an admin-added email beyond the contact_email', async () => {
    const id = await createVerifiedNonprofit('director@helpful.org');
    await addIdentifier(id, 'email', 'grants@helpful.org');
    expect(await findApprovedNonprofitForSender('grants@helpful.org')).toBe(id);
  });

  it('authorizes an admin-added domain (incl. a second, unrelated domain)', async () => {
    const id = await createVerifiedNonprofit('director@helpful.org');
    await addIdentifier(id, 'domain', 'helpful-foundation.org');
    expect(await findApprovedNonprofitForSender('anyone@helpful-foundation.org')).toBe(id);
  });

  it('a deny entry blocks an address its own domain would otherwise allow', async () => {
    const id = await createVerifiedNonprofit('director@helpful.org'); // domain helpful.org allowed
    expect(await findApprovedNonprofitForSender('intern@helpful.org')).toBe(id);
    await addIdentifier(id, 'email_deny', 'intern@helpful.org');
    expect(await findApprovedNonprofitForSender('intern@helpful.org')).toBeNull();
    // The director (and other staff) still pass.
    expect(await findApprovedNonprofitForSender('director@helpful.org')).toBe(id);
  });

  it('a domain_deny blocks a whole added domain', async () => {
    const id = await createVerifiedNonprofit('director@helpful.org');
    await addIdentifier(id, 'domain', 'partner.org');
    expect(await findApprovedNonprofitForSender('x@partner.org')).toBe(id);
    await addIdentifier(id, 'domain_deny', 'partner.org');
    expect(await findApprovedNonprofitForSender('x@partner.org')).toBeNull();
  });

  it("one org's deny does NOT suppress a sender another org legitimately allows", async () => {
    // Org A blocks shared.org for itself; Org B authorizes it as its own domain.
    const orgA = await createVerifiedNonprofit('a@orga.org', 'Org A');
    await addIdentifier(orgA, 'domain_deny', 'shared.org');
    const orgB = await createVerifiedNonprofit('b@shared.org', 'Org B');
    // B's sender must still resolve to B — A's deny is scoped to A only.
    expect(await findApprovedNonprofitForSender('team@shared.org')).toBe(orgB);
  });
});

describe('admin nonprofit management', () => {
  it('adds and removes identifiers, with validation and duplicate protection', async () => {
    const id = await createVerifiedNonprofit('director@helpful.org');

    const add = await req(`/admin/nonprofits/${id}/identifiers`, {
      method: 'POST',
      headers: bearer(adminTok),
      body: JSON.stringify({ kind: 'domain', value: '@Helpful-Foundation.ORG' }), // normalized
    });
    expect(add.status).toBe(200);
    const created: any = await add.json();
    expect(created.value).toBe('helpful-foundation.org'); // lowercased, @ stripped

    // Bad kind / shape are rejected.
    const badKind = await req(`/admin/nonprofits/${id}/identifiers`, {
      method: 'POST', headers: bearer(adminTok), body: JSON.stringify({ kind: 'nope', value: 'x' }),
    });
    expect(badKind.status).toBe(400);
    const emailNoAt = await req(`/admin/nonprofits/${id}/identifiers`, {
      method: 'POST', headers: bearer(adminTok), body: JSON.stringify({ kind: 'email', value: 'helpful.org' }),
    });
    expect(emailNoAt.status).toBe(400);

    // Duplicate (same kind+value) -> 409.
    const dup = await req(`/admin/nonprofits/${id}/identifiers`, {
      method: 'POST', headers: bearer(adminTok), body: JSON.stringify({ kind: 'domain', value: 'helpful-foundation.org' }),
    });
    expect(dup.status).toBe(409);

    // Remove it.
    const del = await req(`/admin/nonprofits/${id}/identifiers/${created.id}`, {
      method: 'DELETE', headers: bearer(adminTok),
    });
    expect(del.status).toBe(200);
    const gone = await req(`/admin/nonprofits/${id}/identifiers/${created.id}`, {
      method: 'DELETE', headers: bearer(adminTok),
    });
    expect(gone.status).toBe(404);
  });

  it('lets two orgs deny the same value (per-org) but keeps allow domains globally unique', async () => {
    const orgA = await createVerifiedNonprofit('a@orga.org', 'Org A');
    const orgB = await createVerifiedNonprofit('b@orgb.org', 'Org B');
    const deny = (id: string) =>
      req(`/admin/nonprofits/${id}/identifiers`, {
        method: 'POST', headers: bearer(adminTok), body: JSON.stringify({ kind: 'domain_deny', value: 'spammer.com' }),
      });
    // Deny is org-scoped, so both orgs can block the same domain.
    expect((await deny(orgA)).status).toBe(200);
    expect((await deny(orgB)).status).toBe(200);
    // But the same org can't list the identical deny twice.
    expect((await deny(orgA)).status).toBe(409);

    // Allow domains stay globally unique — a second org can't claim orgA's.
    const allow = (id: string) =>
      req(`/admin/nonprofits/${id}/identifiers`, {
        method: 'POST', headers: bearer(adminTok), body: JSON.stringify({ kind: 'domain', value: 'shared-claim.org' }),
      });
    expect((await allow(orgA)).status).toBe(200);
    expect((await allow(orgB)).status).toBe(409);
  });

  it('overrides fields: verify and list a nonprofit', async () => {
    const id = await createNonprofit('Hope House'); // starts unverified, unlisted
    const res = await req(`/admin/nonprofits/${id}`, {
      method: 'POST', headers: bearer(adminTok), body: JSON.stringify({ verified: true, listed: true }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ verified: true, listed: true });

    // Partial update keeps untouched fields (verified stays true).
    const res2 = await req(`/admin/nonprofits/${id}`, {
      method: 'POST', headers: bearer(adminTok), body: JSON.stringify({ name: 'Hope House Inc' }),
    });
    const body2: any = await res2.json();
    expect(body2).toMatchObject({ name: 'Hope House Inc', verified: true, listed: true });
  });

  it('requires an admin token', async () => {
    const id = await createNonprofit();
    const res = await req(`/admin/nonprofits/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listed: true }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /transparency (public)', () => {
  it('lists only opt-in orgs with their task counts, and is unauthenticated', async () => {
    const shown = await createVerifiedNonprofit('a@shown.org', 'Shown Org');
    const hidden = await createVerifiedNonprofit('b@hidden.org', 'Hidden Org');
    await pool.query(`UPDATE nonprofits SET listed = true WHERE id = $1`, [shown]);

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
    await createVerifiedNonprofit('a@x.org'); // verified but not listed
    const res = await app.fetch(new Request('http://test/transparency'));
    const body: any = await res.json();
    expect(body).toEqual({ totals: { orgs: 0, tasks_total: 0, tasks_accepted: 0 }, orgs: [] });
  });
});
