import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { VOLUNTEER_AGREEMENT_VERSION } from '../src/agreement.js';
import { closePool, pool } from '../src/db.js';
import {
  getIntake,
  getRequestResults,
  publishIntake,
  receiveIntake,
  uploadDraft,
} from '../src/intake/operations.js';
import { redactPII, restoreRedactions, screenForPHI } from '../src/intake/screen.js';
import { acceptVolunteerAgreement, isDevTrusted, listOpenTasks } from '../src/operations.js';
import { createDev, resetDb, setVerified } from './helpers.js';

afterAll(closePool);

// ---------------------------------------------------------------------------
// screen.ts — pure unit tests, no DB
// ---------------------------------------------------------------------------

describe('redactPII', () => {
  it('tokenizes emails, SSNs, cards, and phones — and restores them', () => {
    const text =
      'Contact maria.lopez@familyaid.org or (555) 123-4567. ' +
      'SSN 123-45-6789, card 4111 1111 1111 1111.';
    const { text: redacted, entities } = redactPII(text);

    expect(redacted).not.toContain('maria.lopez@familyaid.org');
    expect(redacted).not.toContain('123-45-6789');
    expect(redacted).not.toContain('4111 1111 1111 1111');
    expect(redacted).not.toContain('(555) 123-4567');
    expect(redacted).toContain('[EMAIL_1]');
    expect(redacted).toContain('[SSN_1]');
    expect(redacted).toContain('[CARD_1]');
    expect(redacted).toContain('[PHONE_1]');

    expect(restoreRedactions(redacted, entities)).toBe(text);
  });

  it('gives the same value the same token, and numbers distinct values', () => {
    const { text, entities } = redactPII('a@x.org wrote to b@x.org, then a@x.org again');
    expect(text).toBe('[EMAIL_1] wrote to [EMAIL_2], then [EMAIL_1] again');
    expect(entities).toHaveLength(2);
  });

  it('continues numbering when seeded with an existing map', () => {
    const first = redactPII('reach a@x.org');
    const second = redactPII('cc b@x.org and a@x.org', first.entities);
    expect(second.text).toBe('cc [EMAIL_2] and [EMAIL_1]');
    expect(second.entities).toHaveLength(2);
  });

  it('is idempotent over already-redacted text', () => {
    const first = redactPII('mail a@x.org at 555-123-4567');
    const again = redactPII(first.text, first.entities);
    expect(again.text).toBe(first.text);
    expect(again.entities).toEqual(first.entities);
  });

  it('leaves non-PII digit runs alone (no bare-number false positives)', () => {
    const text = 'Invoice 4111111111 covers 50 forms; order id 1234567890123456789.';
    // 4111111111 has no separators (not a phone) and 12345…89 fails Luhn.
    expect(redactPII(text).text).toBe(text);
  });

  it('restores values inside serialized JSON without breaking syntax', () => {
    const { text, entities } = redactPII('email a@x.org');
    const result = { note: `wrote to ${text.slice('email '.length)}` };
    const restored = JSON.parse(restoreRedactions(JSON.stringify(result), entities));
    expect(restored.note).toBe('wrote to a@x.org');
  });
});

describe('screenForPHI', () => {
  it('flags health-context language and records the signals', () => {
    const s = screenForPHI('Summarize 30 patient records including diagnosis and medications.');
    expect(s.flagged).toBe(true);
    expect(s.signals).toContain('patient');
  });

  it('does not flag ordinary nonprofit asks', () => {
    const s = screenForPHI('Please categorize 50 client intake forms by primary need.');
    expect(s.flagged).toBe(false);
    expect(s.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// intake pipeline — DB-backed
// ---------------------------------------------------------------------------

beforeEach(resetDb);

describe('intake screening', () => {
  it('redacts PII before the decomposer, storing the map on the request', async () => {
    const r = await receiveIntake({
      from_email: 'director@shelter.org',
      subject: 'Thank-you notes',
      body: 'Draft a thank-you note to donor jane.doe@gmail.com (phone 555-123-4567).',
    });

    // Task specs (what would ship to a volunteer) carry tokens, not values.
    const prompts = r.proposed.map((t) => t.spec.prompt).join('\n');
    expect(prompts).not.toContain('jane.doe@gmail.com');
    expect(prompts).not.toContain('555-123-4567');
    expect(prompts).toContain('[EMAIL_1]');
    expect(prompts).toContain('[PHONE_1]');

    // The map (and the raw body) stay on the control plane.
    const full = await getIntake(r.intake_id);
    expect(full.raw_body).toContain('jane.doe@gmail.com');
    expect(full.redactions.map((e: any) => e.value)).toEqual(
      expect.arrayContaining(['jane.doe@gmail.com', '555-123-4567']),
    );
    expect(full.phi_flagged).toBe(false);
  });

  it('flags likely PHI and blocks publish until acknowledged', async () => {
    const r = await receiveIntake({
      from_email: 'director@clinic.org',
      body: 'Summarize 30 patient intake forms, including diagnosis and medications.',
    });
    expect(r.phi_flagged).toBe(true);

    const full = await getIntake(r.intake_id);
    expect(full.phi_flagged).toBe(true);
    expect(full.phi_signals.length).toBeGreaterThan(0);

    await expect(publishIntake(r.intake_id, undefined, 'admin')).rejects.toMatchObject({
      status: 409,
      code: 'phi_flagged',
    });

    // Reviewed and explicitly acknowledged → publishes.
    const pub = await publishIntake(r.intake_id, undefined, 'admin', { acknowledgePhi: true });
    expect(pub.status).toBe('published');
  });

  it('sweeps residual PII out of admin-overridden tasks at publish time', async () => {
    const r = await receiveIntake({
      from_email: 'director@shelter.org',
      body: 'Help us write one grant summary.',
    });
    const pub = await publishIntake(
      r.intake_id,
      [
        {
          title: 'Summary for a@x.org',
          spec: {
            prompt: 'Write to a@x.org about the grant.',
            input_refs: [],
            output_schema: { result: 'string' },
            acceptance: 'Mentions a@x.org.',
            unit_count: 1,
          },
          est_cost_cents: 100,
          max_cost_cents: 150,
          model: 'claude-sonnet-4-6',
          sensitivity: 'sensitive',
        },
      ],
      'admin',
    );

    const { rows } = await pool.query(`SELECT title, spec FROM tasks WHERE id = $1`, [
      pub.task_ids[0],
    ]);
    expect(rows[0].title).not.toContain('a@x.org');
    expect(rows[0].spec.prompt).toContain('[EMAIL_1]');
    expect(rows[0].spec.acceptance).toContain('[EMAIL_1]');

    // The merged map was persisted for delivery-time restore.
    const full = await getIntake(r.intake_id);
    expect(full.redactions.map((e: any) => e.value)).toContain('a@x.org');
  });

  it('redacts off-Worker drafts on upload', async () => {
    const r = await receiveIntake({ from_email: 'x@org.org', body: 'one task please' });
    await uploadDraft(
      r.intake_id,
      [
        {
          title: 'Draft',
          spec: { prompt: 'Reply to donor a@x.org.', unit_count: 1 },
          est_cost_cents: 100,
          max_cost_cents: 150,
          model: 'claude-sonnet-4-6',
          sensitivity: 'sensitive',
        },
      ],
      'local',
    );
    const full = await getIntake(r.intake_id);
    expect(full.proposed[0].spec.prompt).toContain('[EMAIL_1]');
    expect(full.proposed[0].spec.prompt).not.toContain('a@x.org');
  });

  it('restores redacted values when delivering results to the nonprofit', async () => {
    const r = await receiveIntake({
      from_email: 'director@shelter.org',
      body: 'Draft one reply to donor jane.doe@gmail.com.',
    });
    const pub = await publishIntake(r.intake_id, undefined, 'admin');

    // A volunteer's result naturally echoes the token from the prompt.
    await pool.query(`UPDATE tasks SET result = $2, status = 'accepted' WHERE id = $1`, [
      pub.task_ids[0],
      JSON.stringify({ result: 'Dear [EMAIL_1], thank you!' }),
    ]);

    const results = await getRequestResults(r.intake_id);
    expect((results[0].result as any).result).toBe('Dear jane.doe@gmail.com, thank you!');
  });
});

// ---------------------------------------------------------------------------
// volunteer agreement — the second half of the trust gate
// ---------------------------------------------------------------------------

describe('volunteer agreement', () => {
  it('rejects a stale/wrong version echo', async () => {
    const dev = await createDev('signer');
    await expect(acceptVolunteerAgreement(dev, '1999-01-01')).rejects.toMatchObject({
      status: 409,
      code: 'agreement_version_mismatch',
    });
  });

  it('records acceptance and flips isDevTrusted (with verification)', async () => {
    const dev = await createDev('signer');
    await setVerified(dev, true, { agreement: false });
    expect(await isDevTrusted(dev)).toBe(false);

    await acceptVolunteerAgreement(dev, VOLUNTEER_AGREEMENT_VERSION);
    expect(await isDevTrusted(dev)).toBe(true);

    const { rows } = await pool.query(
      `SELECT agreement_version, agreement_signed_at FROM devs WHERE id = $1`,
      [dev],
    );
    expect(rows[0].agreement_version).toBe(VOLUNTEER_AGREEMENT_VERSION);
    expect(rows[0].agreement_signed_at).not.toBeNull();
  });

  it('pins a verified-but-unsigned dev to public listings', async () => {
    const dev = await createDev('unsigned');
    await setVerified(dev, true, { agreement: false });
    const r = await receiveIntake({ from_email: 'x@org.org', body: 'one sensitive task' });
    await publishIntake(r.intake_id, undefined, 'admin'); // intake defaults sensitive

    const pinned = await listOpenTasks({ devTrusted: await isDevTrusted(dev) });
    expect(pinned).toHaveLength(0);

    await acceptVolunteerAgreement(dev, VOLUNTEER_AGREEMENT_VERSION);
    const open = await listOpenTasks({ devTrusted: await isDevTrusted(dev) });
    expect(open).toHaveLength(1);
  });
});
