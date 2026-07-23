# Pivot — Givework for public-good problem solving (bootstrapping on open math)

> Status: **proposal / design**. Nothing here is built yet. This document plans a
> pivot of Givework from "agentic volunteering for nonprofits" to a generic
> **give-your-agent-to-public-good-problems** platform — bootstrapped on open
> mathematics (proving, disproving, formalizing, and computationally extending
> conjectures).

Same domain (`givework.dev`), same core mechanic ("give work"), same crown-jewel
budget accounting. Two things change: *what the work is aimed at* (now a generic,
kind-tagged target — a conjecture today) and *how a chunk of work accumulates and
gets judged correct*.

---

## The shape of the bet: bootstrap now, generalize later

Open math conjectures are **phase one**, chosen deliberately because they are the
easiest possible cold-start:

1. **Now — open math.** Cheap, endlessly decomposable, zero PII, and often
   *machine-verifiable*. The ideal content to attract the first wave of
   contributors and prove the loop works.
2. **Next — open science.** The same generic target holds public-grant research
   questions, reproducibility checks, dataset analyses. Still public, still
   low-legal-surface.
3. **At critical mass — back to the original idea.** Re-enable a vetting layer for
   vetted organizations / nonprofits, once there's a contributor base and the
   resources to handle the trust surface responsibly.

So the domain model must be **generic from day one**, with a `kind` discriminator,
and the nonprofit trust/vetting machinery is **deferred and dormant — not
deleted.** We keep the hooks and turn the gate off; phase three turns it back on.

---

## Why this bootstrap (the honest reasons)

**1. It fits the machinery we already built.** Givework is a metered pool of
donated `claude -p` capacity, decomposed into right-sized tasks, executed by
volunteers, accounted for to the cent. Open math is *made* of right-sized,
independently-executable units: verify a range, search for a counterexample,
formalize a lemma, bash a case.

**2. It parks the legal surface until we can afford it.** Nearly every piece of
defensive machinery in the current codebase exists to handle *nonprofit data and
trust*. During the math (and open-science) phase there's nothing to protect, so
we disable it:

| Current mechanism | Why it exists today | Fate during bootstrap |
| --- | --- | --- |
| DMARC gate + verified-org allowlist (`src/intake/email.ts`, `findApprovedNonprofitForSender`) | Inbound mail carries third-party PII; sender must be a vetted org | **Dormant.** Problem statements are public; open submission + review-before-publish. |
| `sensitivity` enum defaulting to `sensitive`; verified-dev trust gate in `checkoutTask` | Intake "routinely carries PII"; non-public work must not reach an unvetted dev | **Repurposed** into a correctness axis (see below); trust gate kept but off. |
| EIN / charity verification, provisional-org creation | Charitable relationships | **Deferred to phase three.** |
| Delivering an operational work-product an org relies on | Liability if AI output is wrong and acted on | **N/A during bootstrap** — a wrong attempt just fails verification; nobody acts on unverified math. |

The vetting code stays in the tree, feature-flagged off, so phase three is a
re-activation, not a rebuild.

**3. Verification gets dramatically stronger.** In the nonprofit model, "done"
meant a human subjectively accepted a deliverable. In math it can mean *the
counterexample evaluates*, *the Lean proof compiles*, *K independent runs agree on
the range*. Objective, automatable — the single biggest structural upgrade.

### The one caveat we state plainly

An LLM agent is **not** going to prove the Riemann Hypothesis, and we won't imply
it might. The realistic value is *distributed chipping-away plus verification*:
computational bound extension (then replicated), counterexample search (tractable
— how Euler's and Pólya's conjectures died), Lean formalization of existing
proofs, and case-bashing. Occasionally that settles a *small* open problem or
finds a counterexample. Mostly it's honest, cumulative, verifiable work.

---

## Concept mapping

The loop is unchanged in spirit: `propose → decompose → review → publish →
checkout → claude -p → contribute → verify`. Only the nouns, the continuation
semantics, and the final step change.

| Nonprofit Givework | Bootstrap Givework | Notes |
| --- | --- | --- |
| Nonprofit (beneficiary org) | **Target** (`kind`: `conjecture` \| `research_question` \| `org_request`) | Generic from day one; a conjecture today. |
| `intake_requests` | **Submissions** | Public proposals; promoted to a target on review. |
| `intake@` + DMARC + allowlist | Open submission + moderation | No sender vetting during bootstrap. |
| Decomposition → tasks | Decomposition → **attack tasks** | search / formalize / case / lemma. |
| Task = one-shot deliverable | **Task = long-lived, resumable goal** | The big model change — see below. |
| Task `result` (single JSONB) | **Contribution log** + compacted **working state** | Accumulates across many checkouts / volunteers. |
| `sensitivity` (PII trust axis) | **`task_kind`** + **`verification_method`** (correctness axis) | Trust gate kept, dormant. |
| Nonprofit accept / reject (subjective) | **Automated verification** (+ minimal human review) | The upgrade. |
| Budget ledger + `FOR UPDATE` invariant | **Identical** | Donated compute, metered in cents. |
| Transparency ("who we work with") | **Leaderboard** (targets, progress, contributors) | |
| Request status page (`/requests/:id`) | **Target progress page** (`/targets/:id`) | Public, engaging. |

---

## Accumulated work & continuation (the new core)

**The problem you flagged.** A $5 budget buys one bounded `claude -p` chunk — a
small piece of logic, a few cases, a partial lemma. Hard goals need *many* chunks,
contributed by *many* volunteers over time. So a task can no longer be one-shot:
it must persist everything contributed so far, so the next agent that picks it up
can **meaningfully continue** rather than start over.

This is the single biggest departure from the current design, and it touches the
task state machine, the executor contract, and checkout/submit.

### 1. A task becomes long-lived and resumable

Today: `open → locked → submitted → accepted/rejected` (terminal at submit).

Bootstrap: a task cycles until it's *solved*, not until one agent submits:

```
 open ──checkout──▶ locked ──contribute──▶ open (state grows) ──checkout──▶ …
                                     │
                                     └──(verification passes)──▶ resolved / disproven
```

`submit` is renamed in spirit to **contribute**: it books spend (budget mechanics
unchanged), appends the agent's chunk, updates the working state, and returns the
task to the pool — *unless* a completion/verification condition fires, which
closes it. This reuses the existing `release`/`expire` "return to pool" plumbing.

### 2. An append-only `contributions` log

One row per agent chunk — the durable record of *what has been tried*:

```sql
CREATE TABLE contributions (
  id           BIGSERIAL PRIMARY KEY,
  task_id      UUID REFERENCES tasks(id),
  dev_id       UUID REFERENCES devs(id),
  summary      TEXT NOT NULL,     -- human/agent handoff: what I did, what's next
  artifact_uri TEXT,              -- large output (code, Lean file) in blob storage
  artifact     JSONB,             -- small inline output (extended range, a lemma)
  outcome      TEXT NOT NULL,     -- 'progress' | 'dead_end' | 'candidate_solution'
  cost_cents   BIGINT NOT NULL,
  raw_usage    JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);
```

Recording **dead ends** is as valuable as recording progress — it stops the next
agent from re-burning budget on an approach already known to fail. Large artifacts
go to blob storage by `uri` (the intake-attachment `uri` pattern already exists);
only small deltas live inline.

### 3. A compacted **working state**, not the raw log

You cannot dump the full history into the next $5 agent — *reading the context
itself costs budget*. So each target/task carries a materialized, deliberately
small **`state`** (JSONB): the current frontier (e.g. "verified no counterexample
below N = 2·10¹²"), the live sub-goals, the shortlist of dead ends, and a
"suggested next step." This is the board state an incoming agent reads first.

Keeping it small is its own concern:
- The cheap path: each contribution *is* the agent's updated handoff — it rewrites
  the compact state as part of finishing its chunk.
- The robust path: a periodic, cheap **librarian task** (`kind: exploration`, a
  small model) re-compacts the log into fresh state. Compaction is just another
  Givework task — same pool, same ledger.

This mirrors how Claude Code itself survives long context: summarize + keep the
recent slice + keep pointers to the rest.

### 4. Checkout hydrates context (budget-aware)

`checkoutTask` returns, alongside `spec`: the compacted `state`, the last _N_
contributions, and `artifact_uri` pointers to full prior work the agent can fetch
*if* its budget allows. The runner assembles these into the `claude -p` prompt.
The lock (`FOR UPDATE`, `lock_expires_at`) still guarantees **one agent per task
at a time**, so appends never race; parallelism comes from a target fanning out
into *multiple independent tasks* (different ranges, different lemmas), while a
single hard lemma is chipped sequentially.

### 5. Completion is verification-driven

A contribution with `outcome: candidate_solution` triggers `verify.ts`. On a
pass, the task closes and the target flips to `resolved` / `disproven`. On a fail,
the failed candidate is logged as a dead end and the task returns to the pool.

---

## What stays exactly as-is

The parts that make Givework *Givework*, none of which care what the work is
about. **Do not touch them.**

- **Budget accounting** — `dev_budgets`, the `reserved_cents + spent_cents <=
  budget_cents` DB `CHECK`, the `FOR UPDATE` serialization point, and the
  checkout/contribute/release/expire spend mechanics in `src/operations.ts`.
- **The `ledger`** and its insert-only audit trail; dev stats (`getDevStats`).
- **Two planes** — control plane on Cloudflare Workers + Neon; execution plane
  (runner + `claude -p`) on volunteer machines, never deployed. No
  `ANTHROPIC_API_KEY`, ever.
- **JWT auth** (`requireDev` / `requireAdmin`), identity-from-token.
- **The MCP rail** (`src/mcp.ts`) and the HTTP-free core convention.
- **The structured-output decomposition primitive** — keep the mechanism, swap
  the schema.
- **Review-before-publish** — no compute is spent until a task is published, which
  is exactly why open submission is safe without the allowlist.
- **The vetting machinery** — kept in-tree, feature-flagged **off**, for phase
  three.

---

## What changes, file by file

### Schema — new migration `007_generic_targets.sql`

Generic-shadow, not a hard rename, so the same tables host conjectures now and
research questions / vetted orgs later.

- **`nonprofits` → `targets`** (the generic beneficiary/goal). Add a `kind`
  discriminator and the goal fields; keep the vetting columns dormant:
  ```sql
  CREATE TYPE target_kind   AS ENUM ('conjecture','research_question','org_request');
  CREATE TYPE target_status AS ENUM ('open','partially_resolved','resolved','disproven','closed');
  ALTER TABLE nonprofits RENAME TO targets;
  ALTER TABLE targets
    ADD COLUMN kind             target_kind   NOT NULL DEFAULT 'conjecture',
    ADD COLUMN status           target_status NOT NULL DEFAULT 'open',
    ADD COLUMN statement_plain  TEXT,        -- plain-language statement
    ADD COLUMN statement_formal TEXT,        -- optional LaTeX / Lean signature
    ADD COLUMN source_ref       TEXT,        -- OEIS id, arXiv, "Erdős #N", DOI…
    ADD COLUMN state            JSONB NOT NULL DEFAULT '{}',  -- compacted working set
    ADD COLUMN resolved_by      BIGINT;      -- winning contribution id
  -- verified / contact_email / ein: kept, unused during bootstrap (phase-three vetting)
  ```
- **`tasks`** — correctness axis + resumability. `nonprofit_id` → `target_id`:
  ```sql
  CREATE TYPE task_kind AS ENUM
    ('computational','counterexample_search','formalization','lemma','exploration');
  CREATE TYPE verification_method AS ENUM
    ('auto_rerun','proof_checker','replication','human_review');
  ALTER TABLE tasks
    ADD COLUMN kind       task_kind           NOT NULL DEFAULT 'exploration',
    ADD COLUMN verify_via verification_method NOT NULL DEFAULT 'human_review';
  -- sensitivity kept but no longer the checkout gate during bootstrap
  ```
- **New `contributions`** — the append-only accumulation log (shape above).
- **New `verifications`** — the audit trail of the new last step:
  ```sql
  CREATE TABLE verifications (
    id         BIGSERIAL PRIMARY KEY,
    task_id    UUID REFERENCES tasks(id),
    method     verification_method NOT NULL,
    verdict    TEXT NOT NULL,     -- 'passed' | 'failed' | 'inconclusive'
    detail     JSONB,             -- checker stdout, witness, replica agreement
    verifier   TEXT,              -- 'platform' | a dev_id (replication)
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ```
- **`intake_requests` → `submissions`**; **`nonprofit_budgets` → `target_budgets`**
  (per-target compute cap, same `CHECK`). **`ledger`** unchanged bar the
  `nonprofit_id` → `target_id` rename.

### Core ops — `src/operations.ts`

- `submitResult` → **`contribute`**: same budget/ledger mechanics, but it appends
  a `contributions` row, updates `targets.state`, and returns the task to `open`
  instead of `submitted` (unless a candidate solution fires verification).
- `checkoutTask` → also hydrate `state` + recent contributions + artifact
  pointers into `CheckoutResult`.
- Trust gate in `checkoutTask` kept, gated behind a `VETTING_ENABLED` flag (off).

### Decomposition — `src/intake/decompose.ts`

Same three implementations behind the same interface; swap `SYSTEM_PROMPT` and
`DRAFT_JSON_SCHEMA` to emit math attack tasks tagged with `kind` + `verify_via`.
`StubDecomposer` stays hermetic: deterministically emit a standard attack plan
(a batch of `computational` range-sweeps mirroring today's quantity-batching, one
`counterexample_search`, one `formalization` stub). `normalizeTask` clamps the two
new enums exactly as it clamps `model` today.

### Verification — new `src/verify.ts` (the new heart)

Replaces subjective accept/reject. Per `verify_via`:
- **`auto_rerun`** (counterexample): re-evaluate the witness in a trusted platform
  sandbox; if it holds, flip the target to `disproven`.
- **`proof_checker`** (formalization): run the Lean/Coq file through the toolchain;
  compiler exit code is the verdict.
- **`replication`** (computational range): spawn K replica tasks for *other*
  volunteers; accept when K independent runs agree — pure reuse of the task pool.
- **`human_review`** (lemma / exploration): the existing admin path, now the rare
  exception.

Every attempt writes a `verifications` row; `acceptTask` stays as the terminal
transition + ledger write, called by `verify.ts` rather than by a human.

### Execution — `src/executor.ts`

Principle: **the platform verifies; it never trusts the volunteer's self-report
for an objective claim.** The `claude -p` agent does the creative work (writes the
search program, drafts the proof, reasons over cases) and returns the
*artifact*; the trusted sandbox in `verify.ts` re-runs it. `StubExecutor` stays
the deterministic test default. No API key, ever.

### Intake / public surface — `src/intake/*`, `src/server.ts`

- Disable (don't delete) the DMARC gate + allowlist; primary path is a web form /
  public `POST /submissions`, still gated by review-before-publish.
- `/transparency → /leaderboard`; `/requests/:id → /targets/:id` (public progress:
  statement, best verified frontier, open tasks, contribution history).

### Docs & brand

`README.md`, `CLAUDE.md`, `BUILD.md`, tagline — "lend your agent to open
mathematics." Logo and domain stay.

---

## Licensing & IP of findings

> Stub — the intended posture, **not legal advice**. Get counsel's read before launch.

Two sides that people conflate: the **outbound license** (what the world may do
with a finding) and the **inbound terms** (what a contributor grants on submit).
The mathematics itself is largely *unownable* — a theorem, a proof's logic, a
counterexample are facts and ideas, not copyrightable expression — so what we
actually license is the *code*, the *write-up*, and *data collections*.

| Artifact | License | Rationale |
| --- | --- | --- |
| **Code** — Lean/Coq proofs, search programs | **Apache-2.0** | Patent grant + liability disclaimer; matches this repo *and* Lean `mathlib`, so contributions are upstreamable. |
| **Data** — verified ranges, tables | **CC0** | Facts should be free; sidesteps EU database rights. |
| **Write-ups** — expositions, site content | **CC-BY-4.0** | Credit flows to contributors; arXiv/journal-friendly. |
| **The finding/fact itself** | *unownable — public domain by nature* | We claim nothing; that's both the shield and the ethos. |

- **Inbound:** a **DCO** (`Signed-off-by`), not copyright assignment — the
  contributor keeps their copyright, attests they have the right to submit, and
  agrees to the project license (a provenance chain if someone submits third-party
  work). A CLA is the heavier fallback if scale demands. Contributions must comply
  with Anthropic's terms for Claude output.
- **"Covers us" is mostly disclaimers, not the grant.** A prominent correctness
  disclaimer — *"produced by automated agents, machine-checked where possible, not
  peer-reviewed, may be wrong, no warranty"* — is the real shield against reliance
  on a bad result. Reserve the **Givework** trademark so forgeries can't pose as
  official findings (Apache-2.0 already grants no trademark rights).
- **"Worth contributing" is the priority ledger.** Permissive-open means the work
  can't be enclosed; the public, timestamped record of *who found what, when* is
  the real incentive — mathematicians contribute for credit, not license terms.
- **Open decisions:** DCO vs CLA (lean DCO — friction kills contribution); CC-BY
  vs CC-BY-SA for write-ups (lean CC-BY for reuse).

---

## Phased rollout

Each phase is independently shippable and leaves `main` green (`lint` +
`typecheck` + `test`). All the pivot's schema changes live in one migration,
`007_math_pivot.sql` (consolidated while this PR is still open — no need to
proliferate files that never shipped separately).

1. ✅ **Reframe (docs)** — this document + the licensing stub.
2. ✅ **Generic domain model** — `nonprofits → targets` with a `kind`
   discriminator; the correctness axis on tasks; vetting kept dormant.
3. ✅ **Resumable tasks + contributions** — the `contributions` log, `contribute`
   semantics, `state` hydration on checkout. (Librarian compaction still deferred;
   the cheap per-contribution path is in.)
4. ✅ **Decomposition** — math attack-plan schema + prompts; reworked `StubDecomposer`.
5. ✅ **Verification core** — `verify.ts` with `auto_rerun` + `human_review`, the
   `verifications` table, and the disproof status-flip.
6. ✅ **Admin local checker** (scoped) — instead of a hosted sandbox, an admin runs
   the real check on their own machine (compile the Lean proof, re-run the range,
   evaluate the witness) and posts an authoritative verdict via
   `POST /admin/tasks/:id/verify`. It records the task's actual method and flips
   the target on a pass (disproven for a counterexample, resolved for a proof, or
   an explicit `resolve` override). A hosted sandbox + automatic K-of-N replication
   remain future work.
7. ✅ **Public surface** — public `POST /submissions` (no allowlist/DMARC vetting),
   `GET /leaderboard`, `GET /conjectures/:slug`, and a `seed-conjectures` starter
   set. The email allowlist path is kept but dormant.

---

## Open decisions

- **Schema: generic-shadow (decided).** Keep one set of tables with a `kind`
  discriminator; conjecture today, research question next, vetted org later.
  Vetting columns/code stay dormant, re-activated in phase three.
- **State compaction owner** — recommended: each contribution rewrites the compact
  handoff state, with a periodic cheap librarian task as backstop. Worth settling
  before Phase 3.
- **Replication factor K** for computational ranges — start K = 2 (one
  independent confirmation), tune later.
- **Bounties** — a target could carry a compute bounty (or a real prize) on top of
  `target_budgets`; future extension, out of scope for the bootstrap.
