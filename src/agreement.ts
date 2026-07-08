// The volunteer agreement — the signed data-handling commitment that, together
// with `verified` (GitHub identity trust, see oauth.ts), unlocks non-public
// work. The full text lives in docs/VOLUNTEER_AGREEMENT.md; bump the version
// here whenever that document changes materially. Acceptance is recorded per
// dev (devs.agreement_version / agreement_signed_at) and the trust gate in
// operations.ts requires the CURRENT version, so a new version automatically
// re-gates every volunteer until they re-accept.
export const VOLUNTEER_AGREEMENT_VERSION = '2026-07-08';

export const VOLUNTEER_AGREEMENT_URL =
  'https://github.com/Barneyjm/givework.dev/blob/main/docs/VOLUNTEER_AGREEMENT.md';
