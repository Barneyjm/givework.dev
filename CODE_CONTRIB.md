# Code contributions — design

How volunteers' agents contribute *code* (verification harnesses, search
programs, reducers) that other agents can later execute — the
"folding@home, driven by code" layer. Companion repo:
[Barneyjm/givework-contrib](https://github.com/Barneyjm/givework-contrib).

## Principles

1. **Forced open source.** All contributed code lands in the public contrib
   repo (Apache-2.0, DCO). No zip files, no opaque blobs in conversations.
2. **Review is the trust gate.** Code in an open PR is never executed by the
   platform or another volunteer's runner. A maintainer merge (plus CI in a
   throwaway VM) is what promotes code to runnable.
3. **Pinned SHAs only.** Tasks reference merged code as `<repo>@<sha>:<path>`.
   Content addressing means code cited by a result can never change after
   the fact; a fix is a new SHA.
4. **The volunteer's own identity.** Devs authenticate to Givework with
   GitHub OAuth; their runner opens contrib PRs with the same `gh` login, so
   the ledger dev and the PR author are the same person, and the DCO
   sign-off is theirs.

## Flow (wired today)

1. A task's spec asks for code and instructs the agent to return
   `{"code_contribution": {"title", "description", "files": [{"path",
   "content"}]}}` alongside its normal result fields.
2. The runner detects `code_contribution` in the executor's result and — using
   the volunteer's local `git` + `gh` auth — clones the contrib repo, writes
   the files, commits with DCO sign-off, pushes a branch (direct if the
   volunteer has rights, otherwise via automatic fork), and opens a PR
   (src/code-contrib.ts).
3. The submit then carries `artifact_uri = <PR URL>`, so the contribution on
   the public feed links to reviewable code. If the PR fails to open, the
   submit still happens with the code inline in `result` — work is never
   lost, and the PR can be opened by hand later.
4. Human review of the task ≈ review of the PR: accept the task when the PR
   merges.

## Work units (wired — phase 2)

- **Execute-a-work-unit**: a task whose spec carries
  `code = {repo, sha (full 40-hex), entrypoint, input}` is dispatched to the
  work-unit executor (src/workunit.ts) regardless of the configured LLM
  executor. The runner fetches exactly that SHA from exactly the allowlisted
  repo (`GIVEWORK_CONTRIB_REPO`), runs the entrypoint in podman —
  `--network=none`, memory/pids caps, read-only checkout — feeds `input` on
  stdin, and parses stdout JSON as the result. No podman → no execution,
  ever; the task is released. Scripts can steer the loop by including
  `outcome` / `summary` / `state_update` in their output, so chunked search
  over `state.cursor` works exactly like today's resumable tasks. A
  `replication` verification re-runs the same SHA on the same chunk and
  compares output.
- **Two clocks, two rules.** LLM time (an agent *writing* code) burns the
  volunteer's Claude credit — keep `EXECUTOR_TIMEOUT_MS` tight (default
  180s). CPU time (a merged harness *running*) is nearly free and may
  legitimately take hours — `WORKUNIT_TIMEOUT_MS` defaults to 6h.
  actual_cost_cents is 0 for work units: the donation is CPU, not tokens.
- **Lease heartbeat**: while any execution runs, the run-loop renews the
  10-minute checkout lock every 5 minutes (`POST /heartbeat` /
  `heartbeat_task`), so a live 30-hour job keeps its claim and a crashed
  machine's silence returns the work to the pool via expire(). Prefer
  chunking (30 × 1h units) over one 30-hour unit so partial progress
  survives crashes.
- **Runtime dispatch**: after checkout, `WorkUnitExecutor.resolveRuntime`
  reads the `manifest.json` sitting next to the entrypoint and picks the
  matching sandbox image + invocation from a small in-repo registry
  (`python3-stdlib`, `c11-gcc`, `lean4`) — an unreadable/unrecognized
  manifest falls back to `python3-stdlib`, so every contribution merged
  before a runtime existed keeps behaving exactly as it always did. All
  images are pinned by digest, and all run inside the identical podman flags
  (`--network=none`, capped memory/cpus/pids, read-only source mount) — the
  sandbox, not the language, is what makes a runtime safe to add.
- **Proof checking (`lean4`)**: the runtime that makes `verify_via:
  proof_checker` live. A formalization chunk pins a merged `.lean` file;
  the sandbox runs `lean <entrypoint>` (Lean 4.10.0, core prelude only — no
  mathlib in v1) and the exit code is the verdict: 0 records a
  `proof_checker: passed` verification and auto-accepts the chunk (the
  TARGET does not flip — resolving a conjecture stays an admin act); nonzero
  — or a `declaration uses 'sorry'` warning, which lean "passes" with exit 0
  — records `failed`, returns the task to the pool, and preserves the full
  compiler output as a `compiler_output` artifact that checkout hydrates
  into the next agent's prompt (same channel as a salvaged invalid
  decomposition). A timed-out check is salvaged as a progress contribution,
  never silently released. Unlike the JSON-driver runtimes, the lean4
  container's stdout is compiler diagnostics, not a result object — the
  executor interprets it. **v2 (mathlib)**: needs a purpose-built,
  digest-pinned image with a pinned mathlib checkout and its `.olean` cache
  baked in at image build time (`lake exe cache get` with network on, then
  `--network=none` at run time), and `lake build` instead of single-file
  `lean` — the image is multi-GB, which is why v1 ships without it. The
  upstream image is linux/amd64 only; arm64 hosts run it under podman's
  emulation (the canary checks in ~2 s emulated).

## Next phases — not yet wired
- **Repo-backed checkers**: `targets.checker` gains `repo:<path>@<sha>`
  entries, so machine verification stops being limited to the built-ins in
  src/verify.ts. Promotion to checker status is an explicit admin act after
  merge.

## Constraints

Deterministic, no network, ≤ 20 files / ≤ 200 KB per file per contribution
(enforced in extractCodeContribution). Three accepted runtimes: Python 3
stdlib only; a single C11 file (stdlib-only, no external libs) compiled
with `cc -O2 -std=c11`; or a single Lean 4 file (core prelude only, no
mathlib) checked with `lean`. Loosened via pinned-by-digest base images,
never via "trust me" — see givework-contrib's README (and
contrib-templates/lean/ here) for the manifest-level contract.
