---
name: conjecture-video
description: Produce a Givework conjecture explainer video in the house style — spec → VoxCPM narration → Manim scenes → static-gain mix → gates
---

# Conjecture explainer videos — the house discipline

This is the pipeline that produced the 25+ shipped films. The tools are all in
`video/`; read `video/README.md` for depth. Work in a scratch directory (`WORK`
env, default `$PWD`) — outputs never land in the repo.

## Purpose and house rules

- **The video explains the PROBLEM, never the platform.** One spoken invite
  line ("the problem is live at givework dot dev slash …") plus the shared CTA
  outro is the entire platform presence. The platform story lives on the
  problem's web page, not in the film.
- **Base-state-up pedagogy.** Start from something countable (six dots, one
  number, one coin flip) and grow it; never open on the general statement.
- **Every on-screen mathematical claim must be true of the exact frames
  shown.** If the caption says "slimness two", the drawn triangle measures two.
- **Computed, not hardcoded.** Data comes from real arithmetic at construction
  time — `video/manim/mathviz.py` and `video/manim/gaugeflow.py` run
  import-time self-checks that raise if the math drifts. Extend those modules
  rather than hand-placing numbers.
- **Label simplifications on screen.** An abelian stand-in, a toy case, a
  truncated range gets an explicit on-frame label (e.g. "abelian case, G =
  U(1)"). "Checked to 2⁷¹, still unproven" is the interesting truth; claiming
  more is the one thing we don't ship.
- Register: encouraging, not sober. "Unlikely but possible" is the pitch; dead
  ends are contributions.

## Spec

One JSON per film — copy the shape of `video/specs/firstproof-c4.json`:
on-screen copy + `narration` (one entry per beat) + optional `pronounce` map.
Scenes subclass `BeatScene` from `video/viz.py` (import manim FIRST, viz
second — the palette guard refuses to render otherwise).

## Narration (VoxCPM, cloned voice)

- Generator: `gen_spec_narration.py` in the VoxCPM checkout, run with its venv
  python (`$VOX_DIR/.venv/bin/python`, `VOX_DIR` defaulting to
  `~/Documents/code/VoxCPM`). `video/produce_video.sh` invokes it when
  `narration_<slug>/durations.json` is missing; it writes one wav per beat plus
  `durations.json`.
- **Write for the ear**: numbers as words ("two to the seventy-first"), and
  every line ends with a period — captions are cut from the same text, and a
  trailing comma or dash makes the voice inflect upward.
- **Pronounce maps are TTS-only.** Captions keep real orthography (the eye gets
  Stäckel); the map swaps in a respelling for the voice only. Respellings must
  be SOLID WORDS — "jee oh dessik", never "jee-oh-dess-ik". Hyphens cause
  inflection artifacts.
- **Accept-check every take.** Round-trip each generated wav through whisper
  and compare to the script: a dropped clause, a doubled word, or gibberish
  means regenerate that beat (the generator retries degenerate takes on fresh
  seeds; the whisper pass catches what amplitude heuristics miss). Also check
  each take's pause noise floor — a hissy take poisons the whole mix and is
  cheaper to regenerate than to notice at the gate.

## AUDIO IS STATIC-GAIN ONLY

Exactly two measured constant gains: voice to −16.5 LUFS integrated, bed to
20 LU under that (−36.5), plus `lowpass=f=3500` on the bed and a sidechain duck
under the voice. ONE continuous bed per assembled piece — never per-beat,
never per-act (per-segment beds restart at every join and make each seam
audible). **NO `loudnorm`. NO `alimiter`. Nothing adaptive.**

Why this is a rule and not a preference — it has been violated twice and both
times shipped:

1. A bed scaled by a guessed constant sat at speech level and read as static.
2. A `loudnorm` mix lifted the bed and TTS hiss in every inter-sentence pause
   — audible static precisely where the ear expects room tone. Measured pause
   floor −41.4 dBFS vs −44…−46 for every static-gain mix.

A dynamic normaliser cannot tell signal from floor, and between sentences the
floor IS the signal it normalises up. `video/render_check.mjs` fails any share
whose speech-pause floor is above −42.5 dBFS. The correct recipes are in
`video/produce_video.sh`, `video/assemble.sh`, `video/build_cta_outro.sh` —
use them, do not re-derive the ffmpeg filtergraph.

## Brand

Composite the real mark — `video/assets/givework-logo.png` via `viz.logo()`
(a copy of `brand/givework-logo-512.png`). NEVER redraw the logo from
primitives. `ImageMobject` cannot live in a `VGroup`; group it with `Group`.

## Render

- Preview first: `video/produce_video.sh <spec.json> l` → 480p15. **Extract
  frames and LOOK at them** (beat midpoints, transitions) before rendering
  1080p60 with quality `h`. Composition bugs cost minutes at 480p15 and hours
  at 1080p60.
- Run renders as inline, polled subprocesses. Detached watcher patterns have
  silently stalled twice; if you background a render, poll its output file
  size and log tail on an interval you own.
- Multi-act pieces: render each act, mux voice per act (no music), then
  `video/assemble.sh <out> <act1-voice> <act2-voice> …` lays ONE bed over the
  whole piece.
- Closer: `video/bolt_cta.sh <final> <slug>-share.mp4` bolts the shared CTA
  outro (built once by `video/build_cta_outro.sh`) and writes the poster.
- Duration sanity: assembled length = Σ segment durations + CTA. `ffprobe`
  everything; drift means concat ate a stream.

## Gates — on the FINAL share file, both mandatory

```bash
node video/render_check.mjs <slug>-share.mp4   # must PASS (frames, audio, motion, pause floor)
node video/inkdips.mjs <slug>-share.mp4        # ONLY the two boundary dips
```

`inkdips.mjs`'s acceptance signature: exactly two sub-floor stretches — the
poster lead-in join and the main→CTA join. Any other dip is a hole in a beat;
fix the scene, re-render, re-gate.

## Deliverables

- `<slug>-share.mp4` + `<slug>-poster.jpg` (first frame, `-q:v 3`;
  `bolt_cta.sh` writes both).
- R2 convention: `givework-media/<slug>.mp4` and
  `givework-media/<slug>-poster.jpg`.
- **NEVER upload without owner review.** Present the share file, the gate
  output, and a handful of extracted frames; wait for the explicit go.
