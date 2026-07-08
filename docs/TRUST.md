# Trust, privacy & accountability

Two questions come up in every serious conversation about Givework:

1. **Are volunteers legally on the hook for the results their agents produce?**
2. **Doesn't this ship nonprofits' personal data (PII/PHI) to strangers' home machines?**

Short answers: **no, by structure**, and **no, by policy and by code**. This document
is the long answer. Every mechanism below is enforced in this repo — file pointers
included — not aspirational.

## How data and accountability actually flow

```
nonprofit email ─▶ intake (DMARC + allowlist)
                     │  PII redacted, PHI flagged   src/intake/screen.ts
                     ▼
                  decompose (sees redacted text only)
                     ▼
                  review gate ─▶ publish             PHI flag always blocks;
                     ▼                               humans review the exceptions,
                                                     fast-tracked partners skip the queue
                  task pool  ── trust gate ──▶ volunteer runner
                     │        (verified + signed agreement)
                     ▼
                  results ─▶ review ─▶ delivered to the nonprofit
                                       (redactions restored here, and only here)
```

The platform sits between the nonprofit and the volunteer at every step. Neither
party ever has a direct relationship with the other — that intermediation is the
core of both answers.

## 1. Volunteer accountability

A volunteer donates **compute** — the spare capacity of their own Claude
subscription — the way a Folding@home donor donates CPU cycles. They do not
render services to the nonprofit:

- **No relationship.** Volunteers never communicate with nonprofits, are not
  named to them, and take tasks from an open pool the platform curates. The
  platform decomposes the ask, publishes the task, reviews the result, and
  delivers it.
- **Review before delivery.** Results reach a nonprofit only after platform
  acceptance (`src/review.ts`). Submissions from unverified volunteers always
  wait for manual review; verified volunteers' results are auto-accepted
  (`src/app.ts`, the `/submit` route) but are still delivered by the platform,
  as drafts, under the platform's terms — never as the volunteer's work product.
- **Outputs are AS-IS drafts.** The [nonprofit terms](NONPROFIT_TERMS.md) state
  that outputs are AI-generated drafts the nonprofit must review before use, and
  that Givework does not accept requests calling for regulated professional
  advice (legal, medical, financial).
- **The paper matches the structure.** The [volunteer agreement](VOLUNTEER_AGREEMENT.md)
  says explicitly: donation of compute, no professional services, no warranty by
  the volunteer, platform handles delivery and review.

What the platform (not the codebase) still owes this story: a legal entity so
organizational risk lands on the org, counsel review of both documents, and —
at scale — insurance. Tracked outside this repo.

## 2. PII and PHI on volunteer machines

Split the two — the right answers are different.

### PHI: we don't accept it

No amount of engineering makes health data safe to route to volunteers — each
recipient would become a HIPAA business associate needing a BAA. So the answer
is policy, enforced at intake:

- The [nonprofit terms](NONPROFIT_TERMS.md) prohibit sending PHI.
- Every inbound request is screened for health-context language
  (`screenForPHI`, `src/intake/screen.ts`); a hit sets `phi_flagged` on the
  request and **blocks publishing** until an admin has reviewed it and either
  rejects it or explicitly acknowledges a false positive
  (`publishIntake`, `src/intake/operations.ts`).

### PII: minimize what ships, gate who receives it

- **Redaction at the front door.** Before the decomposer ever sees a request,
  structured PII (emails, phone numbers, SSNs, card numbers) is replaced with
  stable tokens (`redactPII`, `src/intake/screen.ts`). Task specs are drafted
  from the redacted text, so tokens — not values — are what a volunteer's agent
  receives. A second sweep at publish time catches anything an admin edit or an
  off-Worker draft reintroduced. The token→value map lives only on the control
  plane and is re-applied exactly once: when results are delivered back to the
  data owner (`getRequestResults`).
- **Sensitive by default, humans review the exceptions.** Inbound intake
  defaults to `sensitivity='sensitive'` (`src/intake/decompose.ts`). Requests
  wait for human review unless an admin has marked the org `auto_publish` — a
  per-partner fast track for established organizations (migration 008), so the
  agents do the routine work and people review what's new or flagged. The
  automated screens run on every request either way, and a PHI flag stops the
  fast track cold.
- **The trust gate.** Non-public tasks can only be checked out by a volunteer
  who is both **verified** (a real, aged GitHub identity — `src/oauth.ts`) and
  **signed onto the current volunteer agreement** (`src/agreement.ts`). Both are
  read from the database at checkout time (`checkoutTask`,
  `src/operations.ts`), so revoking either takes effect immediately. Untrusted
  volunteers can't even see non-public tasks in listings.
- **Attachments are never stored.** Inbound attachment bytes are dropped at the
  email edge; only metadata is kept (`src/intake/email.ts`).
- **Volunteers aren't anonymous.** Every account is GitHub-identity-bound, and
  the agreement they sign commits them to use task data only for the task, not
  retain it, and report any incident.

### The honest caveat

The runner streams task → `claude -p` → submit and persists nothing itself. The
Claude CLI does keep a local session transcript — so the executor deletes it the
moment a run finishes, success or failure (`cleanupSessionArtifacts`,
`src/executor.ts`; opt out with `GIVEWORK_KEEP_TRANSCRIPTS=1` for debugging).
That cleanup is best-effort on hardware we don't control, so "nothing ever
touches a volunteer's disk" would still be an overclaim and we don't make it.
The guarantee is about **what** ships (redacted, minimized, screened) and
**who** receives it (verified, agreement-bound volunteers) — not a clean-room
claim about volunteer hardware. The long-term answer for the highest-sensitivity tier is
platform-controlled ephemeral execution environments instead of volunteer
machines; until then, that tier of data simply shouldn't be sent to Givework,
and the nonprofit terms say so.

## Status of the legal documents

[`VOLUNTEER_AGREEMENT.md`](VOLUNTEER_AGREEMENT.md) and
[`NONPROFIT_TERMS.md`](NONPROFIT_TERMS.md) are working drafts pending review by
counsel. The enforcement code is live regardless — the gates don't wait for the
paper to be perfect.
