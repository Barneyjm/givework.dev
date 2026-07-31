# Lean 4 contributions — templates for `givework-contrib`

Ready-to-copy scaffolding for the `lean/` tree of the public contrib repo
([Barneyjm/givework-contrib](https://github.com/Barneyjm/givework-contrib)).
These files live HERE (the platform repo) only as templates: a maintainer
copies them into the contrib repo by hand — the platform never pushes there.

## What goes where in the contrib repo

```
lean/
  lean-toolchain          # the pinned toolchain every Lean source targets
  lakefile.toml           # v2 placeholder — v1 checks single files with `lean`
  canary/
    Canary.lean           # trivially-true example module (compiles green)
    manifest.json         # {"runtime": "lean4"} — the work-unit dispatch key
.github/workflows/
  lean-check.yml          # copy of workflows/lean-check.yml — CI on lean/ PRs
```

## The contract (v1)

- **One `.lean` file per checkable claim**, importing nothing beyond the core
  Lean 4 prelude. The checking sandbox runs the digest-pinned
  `leanprovercommunity/lean4` image (Lean **4.10.0**, `linux/amd64`) with
  `--network=none` — there is no `lake`, no package fetch, **no mathlib**.
- **`manifest.json` next to the entrypoint** declares
  `{"runtime": "lean4"}` so the work-unit executor dispatches to the Lean
  image instead of the default Python sandbox (same mechanism as `c11-gcc`).
- **Exit 0 is the verdict.** A SHA-pinned chunk task runs
  `lean <entrypoint>`; exit 0 records a `proof_checker: passed` verification
  and auto-accepts the chunk. A nonzero exit records `failed` with the
  compiler output preserved as correction context for the next attempt.
  A green file is a checked *step* — resolving a whole conjecture remains an
  explicit admin act.
- **`sorry` never verifies.** `lean` compiles a sorried declaration with
  exit 0 (warning only) — so the platform's runtime interpreter, and the CI
  workflow here, both treat the `declaration uses 'sorry'` warning as a
  failed check. An `axiom` declaration compiles silently green: rejecting
  smuggled axioms is PR review's job — treat any new `axiom` in a
  contribution as an automatic request for changes.

## v2 — mathlib (explicitly not in v1)

Real formalization work needs mathlib, and a mathlib toolchain image is
multiple GB plus a long first build. The v2 plan: a purpose-built image
layering a pinned mathlib checkout **with its `.olean` cache baked in**
(`lake exe cache get` at image build time, network on), published
digest-pinned so the sandbox still runs `--network=none`; execution then
becomes `lake build <module>` against `lakefile.toml` instead of single-file
`lean`. Until that image exists, mathlib-dependent steps should be stated as
explicit hypotheses in core-Lean files.
