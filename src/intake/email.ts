import PostalMime from 'postal-mime';
import { createMimeMessage } from 'mimetext';
import { receiveIntake, findApprovedNonprofitForSender } from './operations.js';

/** The address inbound intake arrives at — also the From on onboarding replies. */
const INTAKE_ADDRESS = 'intake@givework.dev';

// Inbound email → intake. This is the production front door for nonprofit
// requests: Cloudflare Email Routing delivers mail for intake@givework.dev to
// the Worker's email() handler (see src/worker.ts), which calls into here.
//
// Why this shape is safe:
//  - The Worker is the only caller; there is no public, unauthenticated HTTP
//    intake endpoint to spoof. Nothing inbound ever touches a volunteer machine.
//  - The `From` header is trivially forgeable, so we do NOT trust it on its own.
//    Email Routing does not drop unauthenticated mail — it *delivers* it and
//    annotates an Authentication-Results header with its SPF/DKIM/DMARC verdict.
//    We require dmarc=pass (which authenticates the From-header domain) before
//    matching the sender against the allowlist of verified nonprofits. Without
//    that gate, anyone could spoof `From: x@<partner-domain>` and impersonate a
//    partnered org. Strangers and unauthenticated mail are rejected before the
//    decomposer (and its token spend) is ever reached.
//  - Even an allowlisted request only produces a *draft*; a human reviews and
//    publishes before anything runs. Raw email never auto-executes.

export interface ParsedEmail {
  from: string | null;
  subject: string | null;
  text: string | null;
  attachments: { uri: string; filename?: string; content_type?: string }[];
  /**
   * The top-most Authentication-Results header from the raw message. Cloudflare
   * prepends its SPF/DKIM/DMARC verdict here on receipt, so the first occurrence
   * is the trusted one. Read from the raw because message.headers (the Worker's
   * Headers view) does not reliably surface the verdict Cloudflare added.
   */
  authResults: string | null;
  /** Original Message-ID, used to thread the onboarding auto-reply (In-Reply-To). */
  messageId: string | null;
}

/** Strip tags from an HTML body as a last resort when there's no text/plain part. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Parse a raw RFC822 message into the fields intake needs. */
export async function parseInboundEmail(
  raw: ArrayBuffer | Uint8Array | string,
): Promise<ParsedEmail> {
  const email = await PostalMime.parse(raw);
  const text = email.text?.trim() || (email.html ? htmlToText(email.html) : '') || null;
  // Store attachment metadata only — never the bytes. Hosting/redaction of
  // attachment content is a later stage; the decomposer only uses the count.
  const attachments = (email.attachments ?? []).map((a) => ({
    uri: `inline:${a.filename ?? a.mimeType ?? 'attachment'}`,
    filename: a.filename ?? undefined,
    content_type: a.mimeType ?? undefined,
  }));
  // First (top-most) Authentication-Results = the one Cloudflare prepended. keys
  // are lowercased by postal-mime, so an exact compare is fine.
  const authResults =
    email.headers?.find((h) => h.key === 'authentication-results')?.value ?? null;
  return {
    from: email.from?.address?.toLowerCase() ?? null,
    subject: email.subject ?? null,
    text,
    attachments,
    authResults,
    messageId: email.messageId ?? null,
  };
}

export type RejectReason = 'no_sender' | 'unauthenticated' | 'sender_not_approved' | 'empty_body';

export type IngestResult =
  | { accepted: true; intake_id: string; nonprofit_id: string }
  | {
      accepted: false;
      reason: RejectReason;
      /**
       * Threading context for a friendly onboarding reply. Populated only for
       * `sender_not_approved` — the one rejected case where the sender is
       * DMARC-authenticated, so it's safe to email them back (no backscatter).
       */
      reply?: { subject: string | null; inReplyTo: string | null };
    };

/**
 * Whether the message's From-header domain is DMARC-authenticated, per the
 * Authentication-Results header(s) Cloudflare adds. dmarc=pass means SPF or DKIM
 * passed *and* aligned with the From domain, i.e. From is not spoofed.
 *
 * `Headers.get('authentication-results')` joins EVERY Authentication-Results
 * header into one string — Cloudflare's trusted verdict PLUS any the sender
 * forged into their own message — in an order we can't rely on. So we don't
 * trust position: we require at least one dmarc verdict and demand that ALL of
 * them are `pass`. Cloudflare's real verdict is always in the set, so a forged
 * `dmarc=pass` can't help an attacker (their forged token can only sit alongside
 * Cloudflare's genuine `fail`/`none`, which makes this return false), and a
 * forged `fail` only rejects the attacker's own mail.
 */
export function dmarcPassed(authResults: string | null | undefined): boolean {
  if (!authResults) return false;
  // Match the standalone `dmarc=<result>` method, NOT a property like
  // `policy.dmarc=quarantine` (the published policy, which Cloudflare includes).
  // The negative lookbehind rejects a preceding word char or dot, so
  // `policy.dmarc=` and `arc.dmarc=` don't count as verdicts.
  const verdicts = [...authResults.matchAll(/(?<![\w.])dmarc=([a-z]+)/gi)].map((m) =>
    m[1].toLowerCase(),
  );
  return verdicts.length > 0 && verdicts.every((v) => v === 'pass');
}

export interface InboundEmailMeta {
  /** Cloudflare's Authentication-Results header value (message.headers.get(...)). */
  authResults?: string | null;
}

/**
 * Parse, authenticate, allowlist-check, and (if approved) hand an inbound email
 * to the intake pipeline. Returns a structured result rather than throwing for
 * the expected "rejected" cases, so the Worker handler can map them to a clean
 * SMTP reject. Genuine failures (DB down, decomposer crash) still throw.
 *
 * We only ever trust `from` once its domain is DMARC-authenticated, so a spoofed
 * `From: x@<partner-domain>` can't match. The verdict comes from the raw message
 * (Cloudflare's prepended Authentication-Results), preferring an explicit
 * meta.authResults (message.headers) when the caller supplies one.
 */
export async function ingestInboundEmail(
  raw: ArrayBuffer | Uint8Array | string,
  meta: InboundEmailMeta = {},
): Promise<IngestResult> {
  const parsed = await parseInboundEmail(raw);
  const authResults = meta.authResults ?? parsed.authResults;
  const passed = dmarcPassed(authResults);
  // Diagnostic (visible via `wrangler tail`): which source carried the verdict
  // and the decision. Logs auth metadata + sender domain only — never the body.
  console.log(
    'intake-email',
    JSON.stringify({
      from_domain: parsed.from?.split('@')[1] ?? null,
      header_ar: meta.authResults ? meta.authResults.slice(0, 200) : null,
      raw_ar: parsed.authResults ? parsed.authResults.slice(0, 200) : null,
      dmarc_pass: passed,
    }),
  );

  if (!parsed.from) return { accepted: false, reason: 'no_sender' };
  if (!passed) return { accepted: false, reason: 'unauthenticated' };

  const nonprofitId = await findApprovedNonprofitForSender(parsed.from);
  if (!nonprofitId) {
    return {
      accepted: false,
      reason: 'sender_not_approved',
      reply: { subject: parsed.subject, inReplyTo: parsed.messageId },
    };
  }

  if (!parsed.text) return { accepted: false, reason: 'empty_body' };

  const r = await receiveIntake({
    from_email: parsed.from,
    subject: parsed.subject ?? undefined,
    body: parsed.text,
    attachments: parsed.attachments,
    nonprofit_id: nonprofitId,
  });
  return { accepted: true, intake_id: r.intake_id, nonprofit_id: nonprofitId };
}

// Minimal shape of Cloudflare's ForwardableEmailMessage — typed locally to avoid
// pulling in @cloudflare/workers-types just for this one handler. `headers` is
// Cloudflare's view of the received headers, including the Authentication-Results
// it prepends; `from` is the authenticated envelope sender (unused for now — the
// allowlist trusts the DMARC-aligned From header instead).
interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  reply(message: unknown): Promise<void>;
}

const ONBOARDING_TEXT = `Hi there,

Thanks for reaching out to Givework!

Givework connects nonprofits with developers who donate their AI agents to do
real work — summaries, data cleanup, categorization, drafting, and more. It's
free for nonprofits, and you never have to pick a model, write a prompt, or see
a bill.

This inbox (intake@givework.dev) only accepts requests from organizations we've
already partnered with, which is why your message didn't go through yet. To get
started, just reply to hello@givework.dev with:

  • your organization's name and what you do
  • the kind of work you're drowning in

We'll get you set up, and from then on you can email your needs here in plain
language and we'll turn them into tasks for our volunteers.

— The Givework team
https://givework.dev`;

/**
 * Build the raw MIME for the onboarding auto-reply. Pure (no Workers runtime),
 * so it's unit-testable; the handler wraps it in a cloudflare:email EmailMessage.
 * Threads the reply to the original via In-Reply-To/References when we have the
 * sender's Message-ID.
 */
export function buildOnboardingReply(opts: {
  to: string;
  subject: string | null;
  inReplyTo: string | null;
}): string {
  const msg = createMimeMessage();
  msg.setSender({ name: 'Givework', addr: INTAKE_ADDRESS });
  msg.setRecipient(opts.to);
  // Reply subject: prefix Re: but don't stack it (avoid "Re: Re: …").
  const subject = opts.subject
    ? /^re:/i.test(opts.subject.trim())
      ? opts.subject.trim()
      : `Re: ${opts.subject}`
    : 'Getting started with Givework';
  msg.setSubject(subject);
  if (opts.inReplyTo) {
    msg.setHeader('In-Reply-To', opts.inReplyTo);
    msg.setHeader('References', opts.inReplyTo);
  }
  msg.addMessage({ contentType: 'text/plain', data: ONBOARDING_TEXT });
  return msg.asRaw();
}

const REJECT_REASONS: Record<Exclude<IngestResult, { accepted: true }>['reason'], string> = {
  no_sender: 'Could not read a sender address.',
  unauthenticated:
    'Could not verify your sending domain (DMARC). Please email hello@givework.dev to get started.',
  sender_not_approved:
    'This address is for partnered nonprofits. To get started, email hello@givework.dev.',
  empty_body: 'The message had no readable text. Please describe your need in plain text.',
};

/**
 * Cloudflare Email Worker handler. Bound as `email` on the Worker's default
 * export. Reads the raw message + Cloudflare's Authentication-Results, runs it
 * through ingestInboundEmail, and rejects (a connection-time SMTP reject, not a
 * generated bounce) anything not accepted.
 */
export async function emailHandler(
  message: ForwardableEmailMessage,
): Promise<void> {
  let result: IngestResult;
  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const authResults = message.headers.get('authentication-results');
    result = await ingestInboundEmail(raw, { authResults });
  } catch (err) {
    console.error('intake email ingest failed', err);
    // Reject so the sender's server retries / surfaces the failure rather than
    // the request being silently dropped.
    message.setReject('Temporary error processing your message — please try again later.');
    return;
  }
  if (result.accepted) return;

  // An authenticated sender who just isn't a partner yet gets a friendly
  // onboarding auto-reply instead of a bounce. We only do this for
  // sender_not_approved — never for unauthenticated/spoofed mail, where replying
  // to a forged From would be backscatter. If the reply can't be sent, fall back
  // to the SMTP reject so the sender still gets *something*.
  if (result.reason === 'sender_not_approved') {
    try {
      // @ts-ignore - 'cloudflare:email' is a Workers-runtime built-in module
      const { EmailMessage } = await import('cloudflare:email');
      // Reply recipient is message.from (the envelope sender) — Cloudflare only
      // permits replying to the original sender, so we can't target the parsed
      // header From if they differ. For DMARC-aligned mail (which is the only
      // mail that reaches here) they share the authenticated domain anyway.
      const raw = buildOnboardingReply({
        to: message.from,
        subject: result.reply?.subject ?? null,
        inReplyTo: result.reply?.inReplyTo ?? null,
      });
      await message.reply(new EmailMessage(INTAKE_ADDRESS, message.from, raw));
      return;
    } catch (err) {
      console.error('onboarding reply failed', err);
    }
  }
  message.setReject(REJECT_REASONS[result.reason]);
}
