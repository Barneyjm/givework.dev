import { createMimeMessage } from 'mimetext';

// Outbound transactional email via the Cloudflare Email Sending binding
// (SEND_EMAIL in wrangler.toml). Centralizes MIME building + sending so every
// notification shares one path: a branded HTML part, a plain-text alternative,
// and an optional attachment (e.g. results.csv). Under Node (dev/tests) there is
// no binding, so sendEmail no-ops and reports false.

/** The shape of the Cloudflare `send_email` binding we depend on. */
export interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}

/** The address all Givework notifications are sent from (on the onboarded domain). */
export const FROM_ADDRESS = 'hello@givework.dev';

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: string; // raw text content; base64-encoded for transport here
}

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string; // plain text; also rendered into the branded HTML part
  inReplyTo?: string | null;
  attachment?: EmailAttachment;
}

const C = { paper: '#f4f1e6', ink: '#161310', red: '#e1342b', blue: '#21449c', yellow: '#f3c20a' };

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Render the plain-text body into branded HTML. The text is hard-wrapped for
 * plain-text readers, so we REFLOW it here: blank lines split paragraphs, and
 * within a paragraph the hard wraps collapse to spaces — except before a bullet
 * or a link, where the break is intentional. This avoids the "jumpy" mid-sentence
 * wraps that leak through if every newline becomes a <br>.
 */
function bodyToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => {
      const html = esc(para)
        .replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${C.blue};">$1</a>`)
        // Keep a break only before bullets / links; collapse other wraps to spaces.
        .replace(/\n(\s*(?:[•\-*]|<a\b))/g, '<br>$1')
        .replace(/\n+/g, ' ');
      return `<p style="margin:0 0 16px;">${html}</p>`;
    })
    .join('');
}

/** Wrap body HTML in the Givework brand shell (header wordmark + Bauhaus + footer). */
export function brandedHtml(bodyText: string): string {
  return `<!doctype html><html><body style="margin:0;background:${C.paper};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:3px solid ${C.ink};">
<tr><td style="padding:20px 24px;border-bottom:3px solid ${C.ink};">
<span style="display:inline-block;width:16px;height:16px;background:${C.red};border-radius:50%;vertical-align:middle;"></span>
<span style="display:inline-block;width:16px;height:16px;background:${C.blue};vertical-align:middle;margin-left:2px;"></span>
<span style="display:inline-block;width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:16px solid ${C.yellow};vertical-align:middle;margin-left:2px;"></span>
<span style="font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:20px;letter-spacing:1px;color:${C.ink};margin-left:10px;vertical-align:middle;">GIVEWORK</span>
</td></tr>
<tr><td style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${C.ink};">
${bodyToHtml(bodyText)}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #ddd;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#5c574e;">
Givework — free for nonprofits, powered by volunteers.<br>
<a href="https://givework.dev" style="color:${C.blue};">givework.dev</a> &nbsp;·&nbsp; you're receiving this because you emailed intake@givework.dev. Questions? Reply or write hello@givework.dev.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/** UTF-8 → base64, portable across Node (Buffer) and Workers (btoa + TextEncoder). */
function toBase64(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // eslint-disable-next-line no-undef
  return btoa(bin);
}

/** Build the raw RFC822 for an outbound email: branded HTML + text + attachment. */
export function buildMime(email: OutboundEmail): string {
  const msg = createMimeMessage();
  msg.setSender({ name: 'Givework', addr: FROM_ADDRESS });
  msg.setRecipient(email.to);
  msg.setSubject(email.subject);
  if (email.inReplyTo) {
    msg.setHeader('In-Reply-To', email.inReplyTo);
    msg.setHeader('References', email.inReplyTo);
  }
  // multipart/alternative: text first (fallback), then branded HTML.
  msg.addMessage({ contentType: 'text/plain', data: email.body });
  msg.addMessage({ contentType: 'text/html', data: brandedHtml(email.body) });
  if (email.attachment) {
    msg.addAttachment({
      filename: email.attachment.filename,
      contentType: email.attachment.contentType,
      data: toBase64(email.attachment.content),
    });
  }
  return msg.asRaw();
}

/**
 * Send an email through the Cloudflare binding. Returns true if handed off to
 * Cloudflare, false if there's no binding (Node/tests) — callers treat false as
 * "not sent" without failing the surrounding operation. Throws only on a real
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
