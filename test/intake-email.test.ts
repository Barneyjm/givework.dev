import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  parseInboundEmail,
  ingestInboundEmail,
  dmarcPassed,
  onboardingEmail,
  confirmationEmail,
  completionEmail,
  statusUrlFor,
} from '../src/intake/email.js';
import { buildMime, brandedHtml, FROM_ADDRESS } from '../src/mailer.js';
import { findApprovedNonprofitForSender } from '../src/intake/operations.js';
import { pool, closePool } from '../src/db.js';
import { resetDb, createVerifiedNonprofit } from './helpers.js';

afterAll(closePool);

beforeEach(resetDb);

/** Build a minimal raw RFC822 message (CRLF line endings, as on the wire). */
function rawEmail(opts: { from: string; subject?: string; body?: string; html?: string }): string {
  const lines = [
    `From: ${opts.from}`,
    `To: intake@givework.dev`,
    `Message-ID: <test-msg-id@local>`,
    opts.subject ? `Subject: ${opts.subject}` : 'Subject: (no subject)',
    `Content-Type: ${opts.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
    '',
    opts.html ?? opts.body ?? '',
  ];
  return lines.join('\r\n');
}

// A DMARC-pass Authentication-Results header, as Cloudflare would prepend it for
// a properly-authenticated sender. Threaded into ingest as the trusted verdict.
const PASS = { authResults: 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass' };

describe('parseInboundEmail', () => {
  it('extracts a lowercased from, subject, and text body', async () => {
    const p = await parseInboundEmail(
      rawEmail({ from: 'Jane Doe <Jane@Helpful.ORG>', subject: 'Need help', body: 'Categorize 50 forms.' }),
    );
    expect(p.from).toBe('jane@helpful.org');
    expect(p.subject).toBe('Need help');
    expect(p.text).toBe('Categorize 50 forms.');
  });

  it('falls back to stripped HTML when there is no text/plain part', async () => {
    const p = await parseInboundEmail(
      rawEmail({ from: 'x@helpful.org', html: '<p>Hello <b>there</b></p>' }),
    );
    expect(p.text).toContain('Hello');
    expect(p.text).toContain('there');
    expect(p.text).not.toContain('<');
  });
});

describe('findApprovedNonprofitForSender', () => {
  it('matches an exact verified contact_email', async () => {
    const id = await createVerifiedNonprofit('contact@helpful.org');
    expect(await findApprovedNonprofitForSender('contact@helpful.org')).toBe(id);
    expect(await findApprovedNonprofitForSender('CONTACT@Helpful.org')).toBe(id);
  });

  it('authorizes other senders at the same org domain', async () => {
    const id = await createVerifiedNonprofit('director@helpful.org');
    expect(await findApprovedNonprofitForSender('volunteer@helpful.org')).toBe(id);
  });

  it('does NOT authorize a whole consumer-mailbox domain', async () => {
    await createVerifiedNonprofit('jane@gmail.com');
    // Same provider, different person — must not be authorized by domain.
    expect(await findApprovedNonprofitForSender('attacker@gmail.com')).toBeNull();
    // The exact address still works.
    expect(await findApprovedNonprofitForSender('jane@gmail.com')).not.toBeNull();
  });

  it('returns null for an unverified nonprofit and for strangers', async () => {
    await pool.query(
      `INSERT INTO nonprofits (name, contact_email, verified) VALUES ('Pending', 'new@unknown.org', false)`,
    );
    expect(await findApprovedNonprofitForSender('new@unknown.org')).toBeNull();
    expect(await findApprovedNonprofitForSender('nobody@nowhere.org')).toBeNull();
  });
});

describe('dmarcPassed', () => {
  it('passes only on a dmarc=pass verdict', () => {
    expect(dmarcPassed('mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass')).toBe(true);
    expect(dmarcPassed('mx.cloudflare.net; spf=fail; dmarc=fail')).toBe(false);
    expect(dmarcPassed('mx.cloudflare.net; dmarc=none')).toBe(false);
    expect(dmarcPassed(null)).toBe(false);
    expect(dmarcPassed(undefined)).toBe(false);
  });

  it('requires EVERY verdict to pass, so a forged dmarc=pass cannot flip a real fail (no ordering bypass)', () => {
    // Headers.get() joins all Authentication-Results; we can't rely on order, so
    // any non-pass verdict (Cloudflare's genuine one) loses — in either position.
    expect(dmarcPassed('mx.cloudflare.net; dmarc=fail, evil.example; dmarc=pass')).toBe(false);
    expect(dmarcPassed('evil.example; dmarc=pass, mx.cloudflare.net; dmarc=fail')).toBe(false);
    // Multiple genuine passes (e.g. a benign upstream + Cloudflare) still pass.
    expect(dmarcPassed('upstream; dmarc=pass, mx.cloudflare.net; dmarc=pass')).toBe(true);
  });

  it('does not mistake the published policy (policy.dmarc=) for a verdict', () => {
    // Real Cloudflare header: dmarc=pass result + policy.dmarc=quarantine policy.
    const ar =
      'mx.cloudflare.net; dkim=pass header.d=southendsolutions.com header.s=google; ' +
      'dmarc=pass header.from=southendsolutions.com policy.dmarc=quarantine; spf=none';
    expect(dmarcPassed(ar)).toBe(true);
    // A real fail with a quarantine policy still fails (policy token ignored).
    expect(
      dmarcPassed('mx.cloudflare.net; dmarc=fail header.from=x.org policy.dmarc=reject'),
    ).toBe(false);
  });
});

describe('ingestInboundEmail', () => {
  it('accepts DMARC-authenticated mail from an allowlisted sender and links it', async () => {
    const npId = await createVerifiedNonprofit('intake@helpful.org', 'Helpful Org');
    const res = await ingestInboundEmail(
      rawEmail({ from: 'intake@helpful.org', subject: 'Cleanup', body: 'Please dedupe our donor list.' }),
      PASS,
    );

    expect(res.accepted).toBe(true);
    if (!res.accepted) return;
    expect(res.nonprofit_id).toBe(npId);
    // Carries threading context so the handler can send the confirmation reply.
    expect(res.reply).toEqual({ subject: 'Cleanup', inReplyTo: '<test-msg-id@local>' });

    const { rows } = await pool.query(
      `SELECT from_email, raw_body, nonprofit_id, status FROM intake_requests WHERE id = $1`,
      [res.intake_id],
    );
    expect(rows[0]).toMatchObject({
      from_email: 'intake@helpful.org',
      nonprofit_id: npId,
      status: 'decomposed', // ran through the (stub) decomposer
    });
    // No provisional nonprofit was created — the verified one was reused.
    const count = await pool.query(`SELECT count(*)::int AS n FROM nonprofits`);
    expect(count.rows[0].n).toBe(1);
  });

  it('rejects a spoofed From at a partner domain when DMARC fails (the core fix)', async () => {
    // Attacker knows the verified org's domain and forges the From header, but
    // sends from their own server so Cloudflare's DMARC verdict is fail.
    await createVerifiedNonprofit('director@helpful.org', 'Helpful Org');
    const res = await ingestInboundEmail(
      rawEmail({ from: 'anyone@helpful.org', body: 'wire the donations to me' }),
      { authResults: 'mx.cloudflare.net; spf=fail; dmarc=fail' },
    );
    expect(res).toEqual({ accepted: false, reason: 'unauthenticated' });
    const n = await pool.query(`SELECT count(*)::int AS n FROM intake_requests`);
    expect(n.rows[0].n).toBe(0); // never reaches the allowlist or the decomposer
  });

  it('rejects mail with no Authentication-Results at all', async () => {
    await createVerifiedNonprofit('intake@helpful.org');
    const res = await ingestInboundEmail(rawEmail({ from: 'intake@helpful.org', body: 'hi' }));
    expect(res).toEqual({ accepted: false, reason: 'unauthenticated' });
  });

  it('returns onboarding reply context for an authenticated non-partner (no bounce)', async () => {
    // DMARC passes for the sender's OWN domain, but it isn't a partner. This is
    // the case that gets a friendly onboarding auto-reply, so ingest hands back
    // the threading context rather than a bare reject.
    const res = await ingestInboundEmail(
      rawEmail({ from: 'hello@newcharity.org', subject: 'Can you help us?', body: 'We need data cleanup.' }),
      PASS,
    );
    expect(res).toMatchObject({
      accepted: false,
      reason: 'sender_not_approved',
      reply: { subject: 'Can you help us?', inReplyTo: '<test-msg-id@local>' },
    });

    const n = await pool.query(`SELECT count(*)::int AS n FROM intake_requests`);
    expect(n.rows[0].n).toBe(0); // nothing persisted, no decomposer spend
  });

  it('rejects an allowlisted sender with an empty body', async () => {
    await createVerifiedNonprofit('intake@helpful.org');
    const res = await ingestInboundEmail(rawEmail({ from: 'intake@helpful.org', body: '   ' }), PASS);
    expect(res).toMatchObject({ accepted: false, reason: 'empty_body' });
    const n = await pool.query(`SELECT count(*)::int AS n FROM intake_requests`);
    expect(n.rows[0].n).toBe(0);
  });
});

// Decode an RFC 2047 base64 encoded-word (mimetext encodes Subject/From-name).
const decodeWord = (s: string) =>
  s.replace(/=\?utf-8\?B\?([^?]+)\?=/gi, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));

describe('email content builders', () => {
  it('onboardingEmail: threaded reply subject + onboarding CTA', () => {
    const e = onboardingEmail({ to: 'hello@newcharity.org', subject: 'Can you help us?', inReplyTo: '<abc@mail>' });
    expect(e.to).toBe('hello@newcharity.org');
    expect(e.subject).toBe('Re: Can you help us?');
    expect(e.inReplyTo).toBe('<abc@mail>');
    expect(e.body).toContain('hello@givework.dev'); // CTA
  });

  it('onboardingEmail: default subject for blank/missing original; no stacked Re:', () => {
    for (const subject of [null, '   ']) {
      const e = onboardingEmail({ to: 'x@org.org', subject, inReplyTo: null });
      expect(e.subject).toBe('Getting started with Givework');
    }
    expect(onboardingEmail({ to: 'x@org.org', subject: 'Re: Hi', inReplyTo: null }).subject).toBe('Re: Hi');
  });

  it('confirmationEmail: status link in the body + threaded subject', () => {
    const url = statusUrlFor('abc-123');
    const e = confirmationEmail({ to: 'director@helpful.org', subject: 'Need help', inReplyTo: '<m@id>', statusUrl: url });
    expect(e.subject).toBe('Re: Need help');
    expect(e.inReplyTo).toBe('<m@id>');
    expect(e.body).toContain(url);
    expect(url).toBe('https://givework.dev/status?task_id=abc-123');
  });

  it('completionEmail: subject, status link, optional results attachment', () => {
    const url = statusUrlFor('xyz');
    const e = completionEmail({ to: 'director@helpful.org', statusUrl: url });
    expect(e.subject).toBe('Your Givework request is complete');
    expect(e.body).toContain('complete');
    expect(e.body).toContain(url);
    expect(e.inReplyTo).toBeUndefined();
    expect(e.attachment).toBeUndefined();

    const withFile = completionEmail({
      to: 'x@org.org',
      statusUrl: url,
      attachment: { filename: 'givework-results.csv', contentType: 'text/csv', content: 'task,summary\nA,done' },
    });
    expect(withFile.attachment?.filename).toBe('givework-results.csv');
  });
});

describe('buildMime (mailer)', () => {
  it('renders From/To/Subject, threading headers, the text body, and branded HTML', () => {
    const raw = buildMime({ to: 'a@b.org', subject: 'Hello', body: 'Body text', inReplyTo: '<m@id>' });
    expect(raw).toMatch(new RegExp(`From:.*${FROM_ADDRESS.replace('.', '\\.')}`));
    expect(raw).toMatch(/To:.*a@b\.org/);
    expect(decodeWord(raw)).toContain('Hello');
    expect(raw).toContain('In-Reply-To: <m@id>');
    expect(raw).toContain('References: <m@id>');
    expect(raw).toContain('Body text'); // plain-text part
    // Branded HTML alternative is present (decode the quoted-printable/encoded body).
    expect(raw).toMatch(/text\/html/);
    expect(raw).toMatch(/GIVEWORK|GIVEWORK/);
  });

  it('omits threading headers when there is no Message-ID', () => {
    const raw = buildMime({ to: 'a@b.org', subject: 'Hello', body: 'x' });
    expect(raw).not.toContain('In-Reply-To:');
    expect(raw).not.toContain('References:');
  });

  it('brandedHtml escapes quotes so a crafted URL cannot break out of href', () => {
    const html = brandedHtml('Visit https://evil.example/x"onmouseover="alert(1)');
    expect(html).toContain('&quot;'); // the quote was entity-escaped
    expect(html).not.toContain('"onmouseover="alert'); // no raw attribute breakout
  });

  it('includes an attachment when provided', () => {
    const raw = buildMime({
      to: 'a@b.org',
      subject: 'Done',
      body: 'see attached',
      attachment: { filename: 'givework-results.csv', contentType: 'text/csv', content: 'task,summary\nA,done' },
    });
    expect(raw).toContain('givework-results.csv');
    expect(raw).toMatch(/Content-Disposition:.*attachment/i);
  });
});
