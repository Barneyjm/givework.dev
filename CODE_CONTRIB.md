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

## Flow (next phases — not yet wired)

- **Execute-a-work-unit**: `task.spec.code = {repo, sha, entrypoint, input}`;
  the runner fetches exactly that SHA from the allowlisted repo and runs it
  sandboxed (podman: no network, CPU/mem/time caps, read-only FS). Work units
  chunk over `state.cursor` exactly like today's resumable tasks; a
  `replication` verification re-runs the same SHA on the same chunk and
  compares output.
- **Repo-backed checkers**: `targets.checker` gains `repo:<path>@<sha>`
  entries, so machine verification stops being limited to the built-ins in
  src/verify.ts. Promotion to checker status is an explicit admin act after
  merge.

## Constraints (v1)

Python 3 stdlib only, deterministic, no network, ≤ 20 files / ≤ 200 KB per
file per contribution (enforced in extractCodeContribution). Loosened later
via pinned base images, never via "trust me".
