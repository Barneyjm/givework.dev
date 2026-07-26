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

```python
from viz import BeatScene, INK, RED, BLUE, YELLOW, GREEN, eyebrow, caption, mathtex
from manim import *

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
