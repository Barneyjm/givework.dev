# Pivot — Givework for open mathematics

> Status: **proposal / design**. Nothing here is built yet. This document plans a
> pivot of Givework from "agentic volunteering for nonprofits" to **agentic
> volunteering for open mathematics**: developers lend their idle Claude Code
> agents to chip away at open conjectures — proving, disproving, formalizing, and
> computationally extending them.

Same domain (`givework.dev`), same core mechanic ("give work"), same crown-jewel
budget accounting. What changes is *what the work is aimed at* — and, crucially,
*how a result is judged correct*.

---

## Why pivot (the honest reasons)

**1. It's a better fit for the machinery we already built.** The whole point of
Givework is a metered pool of donated `claude -p` capacity, decomposed into
right-sized tasks, executed by volunteers, and accounted for to the cent. Open
math is *made* of right-sized, independently-executable units: verify a range,
search for a counterexample, formalize a lemma, bash a case. It decomposes
naturally, and — unlike a nonprofit deliverable — a math result can often be
**checked by a machine**.

**2. It removes most of the legal surface.** Nearly every piece of defensive
machinery in the current codebase exists to handle *nonprofit data and trust*:

| Current mechanism | Why it exists today | Fate after pivot |
| --- | --- | --- |
| DMARC gate + verified-nonprofit allowlist (`src/intake/email.ts`, `findApprovedNonprofitForSender`) | Inbound mail carries third-party PII; we must know the sender is a real, vetted org | **Removed.** Problem statements are public; no sender to vet. |
| `sensitivity` enum defaulting to `sensitive`; verified-dev trust gate in `checkoutTask` | Nonprofit intake "routinely carries PII"; non-public work must not reach an unvetted dev | **Removed / repurposed.** All work is public math. |
| EIN / charity verification, `nonprofit_budgets`, provisional-org creation | Representing charitable relationships; not draining the pool | Simplified — a per-conjecture compute cap, no charity semantics. |
| Delivering an operational work-product an org relies on | Liability if AI output is wrong and a nonprofit acts on it | **Gone.** A wrong proof attempt just fails verification; nobody acts on unverified math. |

What's left to worry about is ordinary open-source stuff (licensing of
contributed proofs — trivially Apache-2.0/MIT, same as this repo) plus light spam
moderation, which the existing *review-before-publish* step already covers.

**3. The verification story gets dramatically stronger.** In the nonprofit model,
"done" meant a human at the org subjectively accepted a deliverable. In math,
"done" can mean: *the counterexample evaluates*, *the Lean proof compiles*, *three
independent runs agree on the range*. Objective, automatable, and it's the single
biggest structural upgrade this pivot buys us.

### The one caveat we will state plainly

An LLM agent is **not** going to prove the Riemann Hypothesis. We will not imply
it might. The realistic, honest value proposition is *distributed chipping-away
plus verification*:

- **Computational extension** — push a verified bound further (e.g. "no
  counterexample below N"), then have it independently replicated.
- **Counterexample search** — genuinely tractable, and many conjectures die this
  way (Euler's sum-of-powers, Pólya, …). Trivially verifiable.
- **Formalization** — port an existing informal proof into Lean/Coq; the checker
  is the judge.
- **Case bashing & exploration** — discharge finite sub-cases, surface patterns,
  generate sub-conjectures.

Occasionally that genuinely settles a *small* open problem or finds a
counterexample. Mostly it's honest, verifiable, cumulative work. That's the pitch.

---

## Concept mapping

The core loop is unchanged: `submit → decompose → review → publish → checkout →
claude -p → submit result → verify`. Only the nouns and the last step change.

| Nonprofit Givework | Math Givework | Notes |
| --- | --- | --- |
| Nonprofit (beneficiary) | **Conjecture** / open problem | The thing work is aimed at. |
| `intake@givework.dev` + DMARC + allowlist | **Public problem submission** + moderation queue | Anyone may propose; no sender vetting. |
| Decomposition → tasks | Decomposition → **attack tasks** | search / formalize / case / lemma. |
| Task `spec.prompt` | Task `spec` (goal, range, target lemma, formal context) | Same JSONB, richer shape. |
| `sensitivity` (public/internal/sensitive) | **`task_kind`** + **`verification_method`** | PII-trust axis replaced by a correctness axis. |
| Verified-dev trust gate | (mostly removed) optional reviewer trust for `human_review` tasks | |
| Volunteer runner + `claude -p` | **Same** | Agent writes code / proofs and reasons. |
| Result deliverable | **Proof artifact** / counterexample witness / verified range / Lean file | |
| Nonprofit accept / reject (subjective) | **Automated verification** (+ minimal human review) | The big upgrade. |
| Budget ledger + `FOR UPDATE` invariant | **Identical** | Donated compute, metered in cents. |
| Transparency ("who we work with") | **Leaderboard** (conjectures, progress, contributors) | |
| Request status page (`/requests/:id`) | **Conjecture progress page** | Public, engaging. |

---

## What stays exactly as-is

These are the parts that make Givework *Givework*, and none of them care what the
work is about. **Do not touch them.**

- **Budget accounting.** `dev_budgets`, the `reserved_cents + spent_cents <=
  budget_cents` DB `CHECK`, the `FOR UPDATE` serialization point, and the whole of
  `checkout / submit / release / expire` in `src/operations.ts`. Money is still
  integer cents of donated `claude -p` capacity.
- **The `ledger`** and its insert-only audit trail; dev stats (`getDevStats`).
- **Two planes.** Control plane on Cloudflare Workers + Neon; execution plane
  (runner + `claude -p`) on volunteer machines, never deployed. No
  `ANTHROPIC_API_KEY`, ever.
- **JWT auth** (`requireDev` / `requireAdmin`), identity-from-token.
- **The MCP rail** (`src/mcp.ts`) and the HTTP-free core convention
  (`operations.ts` wrapped by both `server.ts` and `mcp.ts`).
- **The structured-output decomposition primitive** — `response_format:
  json_schema` constraining the local model. We keep the mechanism; we swap the
  schema.
- **Review-before-publish.** No compute is spent until a task is published, so
  opening submissions to the public introduces no spend-spam hole. This is why
  dropping the allowlist is safe.

---

## What changes, file by file

### Schema — new migration `007_math_pivot.sql`

The project is young enough to rename rather than shadow. Additive columns where a
deployed row must survive; renames where the concept is simply gone.

- **`nonprofits` → `conjectures`.** Repurpose the beneficiary table:
  ```sql
  ALTER TABLE nonprofits RENAME TO conjectures;
  -- name stays (short handle, e.g. "Collatz")
  ALTER TABLE conjectures
    ADD COLUMN statement_plain  TEXT,        -- plain-language statement
    ADD COLUMN statement_formal TEXT,        -- optional LaTeX / Lean signature
    ADD COLUMN source_ref       TEXT,        -- OEIS id, arXiv, "Erdős #N", DOI…
    ADD COLUMN status           conjecture_status NOT NULL DEFAULT 'open',
    ADD COLUMN resolved_by_task_id UUID REFERENCES tasks(id);
  -- ein / contact_email / verified / listed drop out (charity + allowlist semantics)
  ```
  ```sql
  CREATE TYPE conjecture_status AS ENUM
    ('open','partially_resolved','resolved','disproven');
  ```
- **`tasks`.** Replace the PII-trust axis with a correctness axis:
  ```sql
  CREATE TYPE task_kind AS ENUM
    ('computational','counterexample_search','formalization','lemma','exploration');
  CREATE TYPE verification_method AS ENUM
    ('auto_rerun','proof_checker','replication','human_review');
  ALTER TABLE tasks
    ADD COLUMN kind        task_kind           NOT NULL DEFAULT 'exploration',
    ADD COLUMN verify_via  verification_method NOT NULL DEFAULT 'human_review';
  ALTER TABLE tasks DROP COLUMN sensitivity;   -- and drop data_sensitivity type
  ```
  `nonprofit_id` → `conjecture_id` (rename the FK). `model` (Claude tier) stays.
- **`nonprofit_budgets` → `conjecture_budgets`** — an optional per-conjecture
  compute cap so one problem can't drain the pool. Same shape, same `CHECK`.
- **`intake_requests` → `submissions`** — a proposed conjecture (or a request to
  open work on an existing one). `from_email` becomes optional; drop the
  allowlist coupling.
- **New `verifications` table** — the audit trail of the new last step:
  ```sql
  CREATE TABLE verifications (
    id           BIGSERIAL PRIMARY KEY,
    task_id      UUID REFERENCES tasks(id),
    method       verification_method NOT NULL,
    verdict      TEXT NOT NULL,        -- 'passed' | 'failed' | 'inconclusive'
    detail       JSONB,                -- checker stdout, witness, replica agreement
    verifier     TEXT,                 -- 'platform' | a dev_id (replication)
    created_at   TIMESTAMPTZ DEFAULT now()
  );
  ```
- **`ledger`** — unchanged except the `nonprofit_id` column follows the rename to
  `conjecture_id`.

### Decomposition — `src/intake/decompose.ts`

Same three implementations behind the same `Decomposer` interface; swap the
prompt and JSON schema. A `ProposedTask` gains `kind` and `verify_via` and its
`spec` carries math fields (`goal`, `range`, `target_lemma`, `formal_context`).

- **`StubDecomposer`** (default, hermetic, used by tests): given a conjecture,
  deterministically emit a small standard attack plan — e.g. a batch of
  `computational` range-sweep tasks (mirroring today's quantity-batching logic),
  one `counterexample_search`, and one `formalization` stub. No model needed;
  keeps the test suite hermetic exactly as it is now.
- **`LocalLLMDecomposer` / `CliDecomposer`**: new `SYSTEM_PROMPT` +
  `DRAFT_JSON_SCHEMA` that asks a small local model to produce math attack tasks
  with a `kind` and a `verify_via`. The structured-output primitive and the
  fallback-to-stub-on-any-failure guarantee are unchanged. `normalizeTask` clamps
  the two new enums the same way it clamps `model`/`sensitivity` today.

### Verification — new `src/verify.ts` (the new heart)

This replaces the subjective `acceptTask` / `rejectTask` with objective checks.
Called after `submitResult`; each `verify_via` has a strategy:

- **`auto_rerun`** (counterexample): re-evaluate the submitted witness in a
  trusted platform sandbox. Deterministic and cheap. **If it holds, flip the
  conjecture to `disproven`** and set `resolved_by_task_id` — the headline event.
- **`proof_checker`** (formalization): run the submitted Lean/Coq file through
  the toolchain (`lake build` / `lean --check`) in the sandbox. Compiler exit
  code is the verdict. Objective and unforgeable.
- **`replication`** (computational range): don't trust a single self-reported
  range. On submit, spawn K replica tasks over the same range for *other*
  volunteers; accept only when K independent runs agree. This reuses the existing
  task pool, concurrency, and ledger machinery wholesale — replication is just
  more tasks.
- **`human_review`** (lemma / exploration, natural-language): the one remaining
  subjective path — the existing admin accept/reject, now the exception rather
  than the rule.

`acceptTask` stays as the terminal state-transition + `ledger` write; `verify.ts`
decides *when* to call it. A `verifications` row is written for every attempt.

### Execution — `src/executor.ts`

Two changes, one principle: **the platform verifies; it never trusts the
volunteer's self-report for an objective claim.**

- The `claude -p` agent still does the *creative* work — writing the search
  program, drafting the Lean proof, reasoning about cases — and now returns the
  **program/proof artifact**, not just a numeric result.
- A separate, trusted **verification sandbox** (platform-side, in `verify.ts`)
  re-runs that artifact. In the nonprofit model we *had* to trust the deliverable;
  here we can check it, so we do. That's the trust-gate deletion made concrete.

`StubExecutor` stays the deterministic default for tests. No API key, no SDK — the
donation is still `claude -p` on the volunteer's own subscription.

### Intake surface — `src/intake/*`, `src/server.ts`

- **Delete** the DMARC gate and `findApprovedNonprofitForSender` allowlist. Email
  can remain *one* submission channel (`submit@givework.dev`) but no longer needs
  vetting; a simple web form / public `POST /submissions` is the primary path.
  Spend is still gated by review-before-publish, so this is safe.
- **`/transparency` → `/leaderboard`**: open conjectures with progress
  (verified ranges, tasks done), settled conjectures, and top contributors by
  donated compute (we already compute this in `getDevStats`).
- **`/requests/:id` → `/conjectures/:id`**: a public progress page — statement,
  current best verified bound, open tasks, contribution history. Great for
  engagement and completely safe to make public (it always was math).

### Docs & brand

`README.md`, `CLAUDE.md`, `BUILD.md`, and the tagline. "Agentic volunteering —
lend your agent to open mathematics." The logo and domain stay.

---

## Phased rollout

Each phase is independently shippable and leaves `main` green (`lint` +
`typecheck` + `test`).

1. **Reframe (docs only).** This document, README/CLAUDE tagline, no logic
   change. Makes the direction concrete and reviewable.
2. **Domain model.** Migration `007`, rename types/columns, update
   `operations.ts` field names (`nonprofit_id` → `conjecture_id`). Behaviour
   identical; tests updated for the renames. Ledger/invariant untouched.
3. **Decomposition.** New math schema + prompts in `decompose.ts`; rework the
   `StubDecomposer` attack-plan; update decomposer tests.
4. **Verification core.** `src/verify.ts` with `auto_rerun` +
   `human_review` first (they need no new toolchain), plus the `verifications`
   table and the conjecture-status flip on a verified disproof.
5. **Sandbox + `proof_checker` + `replication`.** The trusted execution sandbox,
   Lean/Coq checking, and K-of-N replication for computational ranges.
6. **Public surface.** Drop the allowlist/DMARC path, ship `/submissions`,
   `/leaderboard`, `/conjectures/:id`, and seed a starter set of well-known open
   problems (curated, with sources).

---

## Open decisions (worth a call before Phase 2)

- **Who curates conjectures?** Recommended: admins seed a curated starter set
  (famous, well-sourced open problems) and moderate public submissions — mirrors
  today's review-before-publish exactly, minus the allowlist.
- **Rename vs. shadow the schema.** Recommended: rename (the project is young; a
  clean model beats a compatibility layer). Additive-only is the fallback if a
  deployed dataset must survive.
- **Bounties.** A conjecture could carry a compute bounty (or a real prize).
  Natural future extension on top of `conjecture_budgets`; out of scope for the
  initial pivot.
- **How much to keep the money framing.** Recommended: keep it verbatim — the
  metered-donation invariant is the platform's whole reason to exist and is
  entirely orthogonal to the subject matter.
