import { readFileSync } from 'node:fs';
import { closePool, pool } from '../src/db.js';
import { ingestInboundEmail, parseInboundEmail } from '../src/intake/email.js';

// Drive the inbound-email intake locally, end to end, against your DATABASE_URL
// (point it at the podman test DB, never prod). This runs the SAME code path the
// Cloudflare email() handler uses — parse → DMARC gate → allowlist → receiveIntake
// — so you can see accept/reject decisions without any email infrastructure.
//
//   # reject (sender not on the allowlist):
//   npm run intake-email -- email.eml
//
//   # seed a verified nonprofit for the sender, then accept (DMARC pass by default):
//   npm run intake-email -- email.eml --seed director@helpful.org
//
//   # simulate a failing DMARC verdict (the spoof case) — expect 'unauthenticated':
//   npm run intake-email -- email.eml --seed director@helpful.org --dmarc fail
//
// Pass a path to a raw RFC822 (.eml) file, or pipe one on stdin. The decomposer
// defaults to the StubDecomposer (no model, no token spend) unless DECOMPOSER=local.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readRaw(): string {
  const file = process.argv
    .slice(2)
    .find((a) => !a.startsWith('--') && !/^(pass|fail|none)$/.test(a));
  if (file) return readFileSync(file, 'utf8');
  // No file given — read the whole of stdin.
  return readFileSync(0, 'utf8');
}

// This script WRITES (seeds nonprofits, inserts intake_requests), so refuse to
// run against anything that isn't obviously a local DB — same guard as the test
// suite, so a stray .env pointing at prod Neon can't be polluted. Override with
// INTAKE_LOCAL_ALLOW_REMOTE=1 if you really mean it.
function assertLocalDb() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error(
      'DATABASE_URL is not set. Point it at your local DB, e.g.\n' +
        "  export DATABASE_URL='postgres://postgres:postgres@localhost:5433/givework'",
    );
    process.exit(1);
  }
  const looksLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url);
  if (!looksLocal && process.env.INTAKE_LOCAL_ALLOW_REMOTE !== '1') {
    console.error(
      `Refusing to run against a non-local database (${url.replace(/:[^:@]*@/, ':***@')}). ` +
        'This script writes rows. Use the local podman DB, or set INTAKE_LOCAL_ALLOW_REMOTE=1.',
    );
    process.exit(1);
  }
}

async function main() {
  assertLocalDb();
  const raw = readRaw();
  if (!raw.trim()) {
    console.error('No email provided. Pass a .eml path or pipe a raw message on stdin.');
    process.exit(1);
  }

  // Cloudflare adds Authentication-Results in production; locally we synthesize a
  // verdict so you can exercise both the pass and spoof paths.
  const verdict = (arg('--dmarc') ?? 'pass').toLowerCase();
  const authResults = `localhost; spf=${verdict}; dkim=${verdict}; dmarc=${verdict}`;

  const parsed = await parseInboundEmail(raw);
  console.log('parsed:', {
    from: parsed.from,
    subject: parsed.subject,
    text: parsed.text?.slice(0, 120) ?? null,
    attachments: parsed.attachments.length,
  });

  // Optional convenience: upsert a verified (allowlisted) nonprofit so an
  // otherwise-unknown sender is accepted. Keyed on the contact address you pass.
  const seed = arg('--seed');
  if (seed) {
    await pool.query(
      `INSERT INTO nonprofits (name, contact_email, verified)
       VALUES ($1, $2, true)
       ON CONFLICT DO NOTHING`,
      [`Local Test (${seed})`, seed.toLowerCase()],
    );
    console.log(`seeded verified nonprofit for ${seed}`);
  }

  const result = await ingestInboundEmail(raw, { authResults });
  console.log('dmarc:', verdict, '→ result:', result);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
