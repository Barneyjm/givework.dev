import PostalMime from 'postal-mime';
import { receiveIntake, findApprovedNonprofitForSender } from './operations.js';

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
  return {
    from: email.from?.address?.toLowerCase() ?? null,
    subject: email.subject ?? null,
    text,
    attachments,
  };
}

export type IngestResult =
  | { accepted: true; intake_id: string; nonprofit_id: string }
  | { accepted: false; reason: 'no_sender' | 'unauthenticated' | 'sender_not_approved' | 'empty_body' };

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
  const verdicts = [...authResults.matchAll(/dmarc=([a-z]+)/gi)].map((m) => m[1].toLowerCase());
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
 * The DMARC gate runs first — before even parsing — so unauthenticated mail
 * (the bulk of hostile inbound) is rejected without paying for a full MIME
 * parse, and we only ever trust `from` once its domain is authenticated, so a
 * spoofed `From: x@<partner-domain>` can't match.
 */
export async function ingestInboundEmail(
  raw: ArrayBuffer | Uint8Array | string,
  meta: InboundEmailMeta = {},
): Promise<IngestResult> {
  if (!dmarcPassed(meta.authResults)) return { accepted: false, reason: 'unauthenticated' };

  const parsed = await parseInboundEmail(raw);
  if (!parsed.from) return { accepted: false, reason: 'no_sender' };

  const nonprofitId = await findApprovedNonprofitForSender(parsed.from);
  if (!nonprofitId) return { accepted: false, reason: 'sender_not_approved' };

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
  if (!result.accepted) {
    message.setReject(REJECT_REASONS[result.reason]);
  }
}
