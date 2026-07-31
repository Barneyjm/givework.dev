# Givework explainer videos — authoring kit

Every conjecture on Givework can have a short (~90s) **diagram-first** explainer:
3Blue1Brown-style, where an animation carries the idea and text is only a caption.
Most problems don't have one yet. Making one is a volunteer task like any other —
this directory is everything you need to author one.

A finished video is assembled from **two files you write**:

| file | what it is |
|---|---|
| `<slug>.json` | the spec: on-screen copy + the narration script, one entry per beat |
| `sc_<slug>.py` | a Manim scene that draws the diagrams, timed to the narration |

We take it from there: narration is generated in a consistent cloned voice, the
scene is rendered at 1080p, a music bed and the standard call-to-action outro are
mixed in, a branded poster is made, and it ships to the conjecture's page.

## The spec (`<slug>.json`)

```json
{
  "slug": "collatz",
  "name": "The Collatz Conjecture",
  "subtitle": "The 3n+1 rule that always falls to one",
  "statement": "One plain sentence stating the conjecture.",
  "tex": "optional LaTeX, no $ delimiters",
  "background": ["2-4 short lines of history/context"],
  "why": ["2-3 lines: why it matters"],
  "impact": ["3-4 downstream impacts"],
  "narration": {
    "title": "spoken line for the title beat",
    "statement": "...", "background": "...", "why": "...", "impact": "..."
  }
}
```

Narration rules that matter:

- **Write for the ear.** Spell numbers and symbols the way they're said: "two to the
  seventy-first", "three-n-plus-one", not `2^71` / `3n+1`.
- **End every line with a period.** A trailing comma or dash makes the voice inflect
  upward like a question.
- **Avoid lone letters** ("a", "e") — they get read as schwa sounds. Rephrase.
- Aim ~15-30s per beat; the whole video lands around 90 seconds.
- Accuracy is non-negotiable. Every claim gets fact-checked before publishing.

## The scene (`sc_<slug>.py`)

Subclass `BeatScene` from [`viz.py`](./viz.py) and implement `build()`:

Beyond `viz.py`, two module libraries are importable the same way (the render
scripts put both this directory and `manim/` on `PYTHONPATH`):

- [`manim/modules.py`](./manim/modules.py) — information design: `Timeline`,
  `PortraitPlate`, `NumberExplorer`, `Descent`, `PaperDoc`, `QuoteCard`,
  `ProgressMeter`, `ChapterCard`, `Counter`. Composable mobjects with a
  `reveals()` generator; the caller owns pacing.
- [`manim/mathviz.py`](./manim/mathviz.py) — mathematics you can watch happen:
  `SieveGrid`, `DensityFlow`, `BrunStack`, `ParityField`, `AdmissibleWindow`,
  `RandomGraph`. Every module computes its content from real arithmetic at
  construction time, and a per-module `_selfcheck()` runs at import and raises
  loudly if the arithmetic disagrees with known values. `manim/gaugeflow.py`
  is the same idea for heat-flow numerics (spectral derivatives on the torus,
  numpy only — it imports standalone, no Manim needed).

Never hand-place data those modules can compute: the self-checks are the reason
an on-screen claim can be trusted to be true of the exact frames.

Import **manim first, `viz` second** — the order matters. `from manim import *`
defines its own `RED`, `BLUE`, `YELLOW` and `GREEN`, so importing it last silently
rebinds those names to Manim's stock palette (salmon `#FC6255`, sky `#58C4DD`) and
your video renders off-brand with no error. `BeatScene` now refuses to render if it
catches this, but get the order right and you'll never see it.

```python
from manim import *
from viz import BeatScene, INK, RED, BLUE, YELLOW, GREEN, eyebrow, caption, mathtex

class ConjectureVideo(BeatScene):
    def build(self):
        self.beat_title()
        self.beat_statement()
        self.beat_background()
        self.beat_why()
        self.beat_impact()
        # no close beat — the shared CTA outro is appended for you
```

Each beat you write must:

1. call `self.narrate("<beat id>")` **first** — this records when the beat starts so
   the narration audio can be lined up,
2. animate,
3. call `self.close_beat()` **last** — this holds until that beat's narration finishes.

Use `self.pace(fraction)` for waits in the middle so the animation stretches to fill
the beat rather than finishing early. Read the two reference scenes here —
`sc_collatz.py` (plots, number lines, icon rows) and
`sc_reconstruction.py` (graphs, and building a "deck" of derived sub-diagrams) —
and copy their idioms. Each ships with the spec it was built against.

### House style

- Palette from `viz.py` only: paper `#f4f1e6`, ink `#161310`, red `#e1342b`,
  blue `#21449c`, yellow `#f3c20a`, green `#1e7d46`. Bauhaus, flat, no gradients.
- The logo is the real asset: `viz.logo()` loads `assets/givework-logo.png`
  (a copy of `brand/givework-logo-512.png`). Never redraw the mark from
  primitives, and remember an `ImageMobject` must live in a `Group`, not a
  `VGroup`.
- **The diagram is the explanation.** If a beat is a bulleted list of text, redo it.
  Draw the actual object: the trajectory, the graph, the curve, the distribution.
- Captions are short and support the visual; they never replace it.
- Guard LaTeX through `viz.mathtex()` — it returns `None` instead of crashing if the
  expression fails to compile, so have a fallback.
- Keep the number of simultaneous mobjects modest; huge scenes exhaust the renderer.

## Rendering it yourself

The scene must render cleanly in the stock ManimCommunity image. From this directory:

```bash
podman run --rm \
  -e SPEC_PATH=/m/<slug>.json \
  -e NARR_DIR=/m/narration_<slug> \
  -v "$PWD":/m -w /m \
  docker.io/manimcommunity/manim:stable \
  manim -ql --disable_caching sc_<slug>.py ConjectureVideo
```

(`docker` works the same.) Without a `narration_<slug>/durations.json` the beats fall
back to short default holds — fine for checking that it *renders* and the diagrams
read. Extract a few frames with `ffmpeg -ss <t> -i <out>.mp4 -frames:v 1 f.png` and
actually look at them: no overlapping text, nothing off-screen, labels legible.

## Submitting

Attach both files to your contribution. It's accepted once:

1. it renders with no errors and every beat spans its narration,
2. the script passes a math fact-check,
3. a maintainer approves the look.

Then it's rendered at full quality, voiced, scored, and published to the conjecture's
page — credited to you.

## Getting the math right

Verify every number you put on screen. The reference scenes compute their data rather
than hard-coding it (`sc_collatz.py` generates the real hailstone sequence;
`sc_reconstruction.py` derives each card from the graph's edge list) — do the same,
so the picture can't drift from the arithmetic. State honestly what is known versus
conjectured: "checked to 2⁷¹, still unproven" is the interesting truth, and claiming
more than that is the one thing we won't ship.

## Production: from approved scene to shipped share

Everything below is what "we take it from there" means. It is also a skill —
`.claude/skills/conjecture-video/SKILL.md` — so an agent session in this repo
can run the whole discipline. The 25+ shipped films were produced exactly this
way. Reference spec: [`specs/firstproof-c4.json`](./specs/firstproof-c4.json).

```
spec.json ──(VoxCPM)──> narration_<slug>/*.wav + durations.json
   │
   └─(produce_video.sh)─> render (Manim container) ─> mux at starts.json
                          ─> one continuous music bed ─> STATIC-GAIN mix
                          ─> poster + 1s lead ─> <slug>-final.mp4
   └─(assemble.sh)──────> same, for multi-act pieces from voice-muxed segments
   └─(bolt_cta.sh)──────> + cta_outro.mp4 (built once by build_cta_outro.sh)
                          = <slug>-share.mp4 + <slug>-poster.jpg
   └─(gates)────────────> render_check.mjs PASS + inkdips.mjs two-dips-only
```

All scripts take their paths from env (`WORK`, `VOX_DIR`, `VOX_PY`, `ENGINE`,
`MANIM_IMG`) with sane defaults; run them from a scratch working directory and
outputs land there, never here.

### The audio rule: static gain only

The mix applies exactly two measured, constant gains — voice to −16.5 LUFS
integrated, bed to 20 LU under that — plus a 3.5 kHz lowpass on the bed and a
sidechain duck while the voice speaks. **No `loudnorm`, no `alimiter`, nothing
adaptive.** This rule exists because it has been violated twice, and both times
the result *shipped*:

1. A bed generated hot and scaled by a guessed constant landed at speech level
   — reported as "static", because a bed you can't hear under the voice is
   just noise you turn up to follow the words.
2. A `loudnorm`-based mix lifted the bed and the TTS hiss in every pause
   between sentences — audible static exactly where the ear listens for room
   tone. Measured: −41.4 dBFS pause floor against −44…−46 for every
   static-gain mix.

A dynamic normaliser cannot know which part of the signal is wanted; between
sentences the "signal" is the noise floor, and it gets lifted. Measure once,
apply constant gain, and the pauses stay as quiet as the mix left them.
`render_check.mjs` now fails any share whose speech-pause floor is above
−42.5 dBFS.

One more assembly invariant: **one continuous music bed per assembled piece**
(`assemble.sh` generates it for the concatenated length). Mixing per act
restarts the bed at every join and makes each seam audible.

### Render discipline

- Preview at 480p15 (`produce_video.sh spec.json l`), then **extract frames and
  look at them** before paying for 1080p60. `ffmpeg -ss <t> -i … -frames:v 1`
  on each beat midpoint; check composition, wrap widths, label collisions.
- Run render subprocesses inline and poll them; detached watcher patterns have
  silently stalled multi-hour renders twice.
- Duration sanity before the gates: the assembled length must equal the sum of
  segment durations plus the CTA (`ffprobe` each; drift means a concat ate a
  stream).

### Gates (on the FINAL share file, after bolt_cta.sh)

```bash
node render_check.mjs <slug>-share.mp4            # must PASS
node inkdips.mjs <slug>-share.mp4                 # only the two boundary dips
```

`inkdips.mjs` watches the transitions render_check's midpoint sampling can't
see. The acceptance signature is exactly two sub-floor stretches: the poster
lead-in giving way to the opening beat, and the main piece handing over to the
CTA. Any other dip is a hole in a beat.

### Deliverables

`<slug>-share.mp4` + `<slug>-poster.jpg` (frame 1, `-q:v 3` — bolt_cta.sh
writes both). R2 layout: `givework-media/<slug>.mp4` and
`givework-media/<slug>-poster.jpg`. **Never upload without owner review.**

## Vertical cuts for short-form

`make_vertical.sh <slug>` reformats a finished 16:9 video into a 1080x1920 cut
for YouTube Shorts, Reels and TikTok:

```bash
cd video
SPEC_DIR=/path/to/specs ./make_vertical.sh collatz collatz-share.mp4
```

The landscape video is **composited into a branded frame**, not re-rendered — the
scenes are composed for 16:9, so every position and wrap width would break in a
vertical viewport. `make_vertical_frame.mjs` draws the backdrop (wordmark, the
conjecture's name, its subtitle, the page URL, and the footer) and prints the
geometry the shell script overlays against, so the layout maths lives in one
place.

The video sits **above centre on purpose**: short-form platforms overlay a
caption, a handle and an action rail across the bottom fifth, so that band is
left to them rather than fought over.

Reels caps at 90 seconds and most of these run 85-115s; the script warns rather
than trimming, since where to cut is an editorial call.

## Thumbnails and captions

Social platforms take **frame 1** as the thumbnail, and ours used to be a plain
grabbed title card with no branding on it. `set_first_frame.sh` puts the branded
poster there instead:

```bash
./set_first_frame.sh collatz-share.mp4 collatz-poster.jpg out.mp4 1.0
#                                                    trim the old 1s lead-in ^
```

For the vertical cut, `make_vertical_frame.mjs <slug> out.png --poster` renders a
9:16 thumbnail — the same frame with a play button in the well and deliberately
no second title, since the frame already carries it.

`make_captions.mjs <slug>` writes an `.srt` from the spec's narration and the beat
timings the render emitted:

```bash
SPEC_DIR=… NARR_DIR=… node make_captions.mjs collatz collatz.srt
# collatz.srt  35 cues, 00:01:45,210 long
```

Most short-form video is watched **muted**, so an uncaptioned explainer reaches far
fewer people than it should — and the words are already written down. Cues split at
sentence boundaries, are apportioned by length within each beat, and wrap to at
most two short lines so they read on a phone.
## Automated render check

Before a submitted video reaches a maintainer, `render_check.mjs` measures it:

```bash
node render_check.mjs <slug>-final.mp4 --starts narration_<slug>/starts.json
# PASS  collatz-share.mp4  1920,1080  111.43s
#   audio: -15.8 LUFS, peak -2.5 dBFS, centroid 2486 Hz, silence 2%
```

Frames are sampled at the **middle of each narration beat** (from `starts.json`),
so it judges settled compositions rather than mid-transition blurs. A blank sample
is re-probed either side before being reported, because a single empty frame is
usually a cross-fade — an actually empty beat stays empty.

**Rejects** (these fail the check):

| check | catches |
|---|---|
| ink coverage below 0.4% | a beat that draws nothing |
| ink coverage above 62% | a wall of text, or overlapping mobjects |
| ink in the outer 2.5% margin | content clipped or pushed off-frame |
| loudness outside −26..−9 LUFS | inaudible, or way too hot |
| true peak above −0.5 dBFS | clipping on re-encode |
| spectral centroid above 6.2 kHz | a harsh, hissy mix |
| spectral flatness below 0.02 while loud | a pure tone — squeal or feedback |

**Advises** (reported, not rejected): off-palette drift, mostly-silent runs, a very
dark mix, and a scene whose beats all look identical.

Palette drift is deliberately advisory. Measured against the 23 shipped videos,
several good scenes drift 11–15% through `fill_opacity` blends and hand-picked
shades; rejecting those would throw away shippable work, so it goes to a
maintainer's eye instead.

### Running it on a schedule

`verify_queue.sh` is the unattended version: it picks up every submitted task
whose `verify_via` is `render_check`, fetches the contributor's merged spec and
scene, renders, measures, and posts pass/fail with the full report attached as the
verification's detail.

```bash
GIVEWORK_ADMIN_TOKEN=… ./verify_queue.sh          # or --dry-run
# */30 * * * * cd <repo>/video && GIVEWORK_ADMIN_TOKEN=… ./verify_queue.sh
```

It runs here rather than in the platform because the control plane is a
Cloudflare Worker with no ffmpeg — the same arrangement `proof_checker` and
`replication` already use, where a maintainer's machine stands in for a sandbox.
A pass still leaves taste to a human; what it removes is having to watch every
submission to find the ones that are simply broken.

Thresholds were calibrated against real material rather than guessed — a 3 kHz
pure tone measures 0.007 spectral flatness against 0.086 for a genuine
narration-plus-music mix. The suite is verified both ways: **all 23 shipped videos
pass**, and five deliberately broken ones (empty, off-palette, clipping, squealing,
edge-clipped) are all caught.
