import { createMimeMessage } from 'mimetext';

// Outbound transactional email via the Cloudflare Email Sending binding
// (SEND_EMAIL in wrangler.toml). Centralizes MIME building + sending so the
// intake confirmation and completion notifications share one path. Under Node
// (local dev, tests) there is no binding, so sendEmail no-ops and reports false.

/** The shape of the Cloudflare `send_email` binding we depend on. */
export interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}

/** The address all Givework notifications are sent from (on the onboarded domain). */
export const FROM_ADDRESS = 'hello@givework.dev';

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  /** Original Message-ID, to thread the reply (In-Reply-To / References). */
  inReplyTo?: string | null;
}

/** Build the raw RFC822 for an outbound plain-text email. Pure / unit-testable. */
export function buildMime(email: OutboundEmail): string {
  const msg = createMimeMessage();
  msg.setSender({ name: 'Givework', addr: FROM_ADDRESS });
  msg.setRecipient(email.to);
  msg.setSubject(email.subject);
  if (email.inReplyTo) {
    msg.setHeader('In-Reply-To', email.inReplyTo);
    msg.setHeader('References', email.inReplyTo);
  }
  msg.addMessage({ contentType: 'text/plain', data: email.body });
  return msg.asRaw();
}

/**
 * Send an email through the Cloudflare binding. Returns true if handed off to
 * Cloudflare, false if there's no binding (Node/tests) — callers treat a false
 * as "not sent" without failing the surrounding operation. Throws only on a real
 * send error, which callers catch (the email is never load-bearing).
 */
export async function sendEmail(
  binding: SendEmailBinding | undefined,
  email: OutboundEmail,
): Promise<boolean> {
  if (!binding) {
    console.warn(`SEND_EMAIL binding absent — skipping email to ${email.to.split('@')[1] ?? '?'}`);
    return false;
  }
  const raw = buildMime(email);
  // @ts-ignore - 'cloudflare:email' is a Workers-runtime built-in module
  const { EmailMessage } = await import('cloudflare:email');
  await binding.send(new EmailMessage(FROM_ADDRESS, email.to, raw));
  return true;
}
