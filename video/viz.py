"""Shared Givework video kit for bespoke, diagram-first conjecture explainers.

Every scene subclasses BeatScene and drives its own diagrams. BeatScene handles
the narration-timing contract (reads NARR_DIR/durations.json, emits starts.json
for external muxing) and the Bauhaus house style, so individual scenes only
worry about their visuals. No per-video close beat: the modular CTA outro
(cta_outro.mp4) is bolted on downstream as the single closer.

    SPEC_PATH=/manim/<slug>.json NARR_DIR=/manim/narration_<slug> \
      manim -qh --disable_caching scenes/<slug>.py ConjectureVideo
"""

import json
import os
import sys

from manim import *

try:  # public helper; guarded so a manim reshuffle can't break the import
    from manim.animation.animation import prepare_animation
except Exception:  # pragma: no cover
    prepare_animation = None

PAPER = "#f4f1e6"
INK = "#161310"
RED = "#e1342b"
BLUE = "#21449c"
YELLOW = "#f3c20a"
GREEN = "#1e7d46"
config.background_color = PAPER

TITLE_KW = dict(font="sans-serif", weight=BOLD, color=INK)
BODY_KW = dict(font="sans-serif", color=INK)
MONO_KW = dict(font="monospace", color=INK)

FRAME_W = 12.5


_LOGO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "assets", "givework-logo.png")


def logo(size=1.4):
    """The real Givework mark, loaded from assets/givework-logo.png.

    Never redraw the logo from primitives — always this asset. Returns an
    ImageMobject sized to `size` units square. NOTE: an ImageMobject cannot
    live in a VGroup; callers that group it must use Group.
    """
    img = ImageMobject(_LOGO_PATH)
    img.height = size
    return img


# A beat used to open on nothing but this label -- 0.4% ink on blank paper for
# several seconds, which is what "dead air" looked like on screen. The label is
# now set as a proper Bauhaus section band: reversed out of a solid ink bar that
# runs the content width, with a brand block closing it off. It lands in the
# beat's first half-second and stays for the whole beat, so the sparsest moment
# of any beat still reads as a composed frame rather than an empty one.
BAND_H = 0.36
_BAND = True  # BeatScene.construct() sets this from the scene's SECTION_BAND


def eyebrow(txt, plain=False):
    """The beat's section label. Banded by default; `plain` for inline use."""
    if plain or not _BAND:
        return Text(txt, **MONO_KW).scale(0.34).set_opacity(0.7)
    w = FRAME_W
    label = Text(txt, font="monospace", color=PAPER).scale(0.34)
    accent_w = BAND_H * 0.62
    room = w - accent_w - 1.05
    if label.width > room:
        label.scale(room / label.width)
    h = max(BAND_H, label.height + 0.22)
    band = Rectangle(width=w, height=h, color=INK, fill_color=INK,
                     fill_opacity=1, stroke_width=0)
    label.move_to(band.get_left() + RIGHT * (label.width / 2 + 0.36))
    accent = Rectangle(width=accent_w, height=h - 0.16, color=YELLOW, fill_color=YELLOW,
                       fill_opacity=1, stroke_width=0)
    accent.move_to(band.get_right() + LEFT * (accent_w / 2 + 0.26))
    return VGroup(band, label, accent)


def caption(txt, scale=0.5, color=INK, weight=NORMAL, max_w=FRAME_W):
    t = Text(txt, font="sans-serif", color=color, weight=weight).scale(scale)
    if t.width > max_w:
        t.scale(max_w / t.width)
    return t


def fit_width(m, max_w=FRAME_W):
    if m.width > max_w:
        m.scale(max_w / m.width)
    return m


def mathtex(tex, color=INK, scale=0.9, max_w=11.0):
    try:
        m = MathTex(tex, color=color).scale(scale)
        return fit_width(m, max_w)
    except Exception:
        return None


class BeatScene(Scene):
    """Base for diagram-first conjecture videos. Subclasses implement build().

    Pacing contract
    ---------------
    A beat is a narration clip. The scene reveals its diagram in a handful of
    `play()` calls and then `close_beat()` parks until the voice finishes. Two
    faults fall out of that if nothing else is done, and both were shipping:

    * **The hole.** Beat N tears its composition down, then beat N+1 builds a
      new one from an empty frame -- and inside a beat, one flourish is faded
      out before the next is drawn. Either way the frame goes to nothing, and
      the next thing to arrive is a header on blank paper. So `play()` holds
      back any play that *only removes* things and replays it underneath
      whatever comes next: a dissolve, longer across a beat boundary than
      within one. Nothing is ever removed into an empty frame.
    * **The pooled tail.** Reveals are sized with `pace()`, but scenes clamp
      those with `min(2.5, ...)`, so a beat assembles in ~6s however long its
      narration is and every second the voice gained pooled into one motionless
      hold at the end. `AUTO_SPREAD` pushes later reveals back by a fraction of
      the narration still to come, so a beat keeps arriving instead of freezing.
      The gap is always a fraction of what is *left* and is bounded by a
      per-beat budget, so it can never overrun the voice.

      It deliberately does NOT touch a beat's opening. Measured: spreading from
      the first reveal made the video worse, not better -- delaying the reveals
      just means a barer frame for longer, and collatz's background beat sat at
      0.4% ink for fourteen seconds. A beat has to reach a composed frame fast
      and *then* keep adding to it, so the gaps only start once the beat has put
      its header and first element up.
    """

    #: spread the later reveals of a beat across its narration.
    AUTO_SPREAD = True
    #: reveals before this many plays into the beat are never delayed -- that is
    #: the beat getting its composition on screen.
    SPREAD_AFTER = 2
    #: fraction of the beat's remaining narration to wait before a reveal.
    SPREAD_FRAC = 0.14
    SPREAD_CAP = 2.5
    #: only delay reveals that take real time; quick follow-ons (a label on the
    #: bar that just appeared) must stay glued to what they annotate.
    SPREAD_MIN_RT = 0.5
    #: never spend more than this share of a beat on inserted gaps.
    SPREAD_BUDGET = 0.45
    #: seconds the outgoing composition takes to dissolve under the new beat.
    DISSOLVE = 1.6
    #: shorter, for a flourish giving way to the next one inside a beat.
    DISSOLVE_MID = 0.8
    #: draw section labels as Bauhaus bands (how-it-works opts out).
    SECTION_BAND = True

    def _assert_brand_palette(self):
        """Refuse to render if the scene's RED/BLUE/YELLOW/GREEN aren't ours.

        `from manim import *` defines its own RED, BLUE, YELLOW and GREEN. If a
        scene does that import AFTER `from viz import ...`, the wildcard silently
        rebinds those four names to Manim's stock palette -- salmon #FC6255 and
        sky #58C4DD instead of our #e1342b and #21449c. Nothing errors; the video
        just renders off-brand, and only the logo (drawn inside this module, so
        immune) stays correct. That shipped 22 videos before anyone noticed.

        Import manim FIRST and viz second, so ours win the name race.
        """
        mod = sys.modules.get(type(self).__module__)
        if mod is None:
            return
        wrong = {
            name: getattr(mod, name)
            for name, ours in (("RED", RED), ("BLUE", BLUE), ("YELLOW", YELLOW), ("GREEN", GREEN))
            if hasattr(mod, name) and str(getattr(mod, name)).lower() != ours.lower()
        }
        if wrong:
            got = ", ".join(f"{k}={v}" for k, v in sorted(wrong.items()))
            raise RuntimeError(
                f"{type(self).__module__} is not using the Givework palette ({got}).\n"
                "`from manim import *` has shadowed it. Put the manim import FIRST:\n"
                "    from manim import *\n"
                "    from viz import BeatScene, PAPER, INK, RED, BLUE, YELLOW, GREEN, ..."
            )

    def construct(self):
        global _BAND
        self._assert_brand_palette()
        _BAND = bool(self.SECTION_BAND)
        spec_path = os.environ.get("SPEC_PATH", "/manim/spec.json")
        narr_dir = os.environ.get("NARR_DIR", "/manim/narration")
        self.spec = json.load(open(spec_path))
        dpath = os.path.join(narr_dir, "durations.json")
        self.narr = json.load(open(dpath)) if os.path.exists(dpath) else {}
        self._narr_dir = narr_dir
        self._narr_finish = 0.0
        self._starts = []
        self._beat_no = 0  # bumped by narrate(); scopes the deferred teardown
        self._teardown_beat = None
        self._deferred = []  # fades riding the next reveal instead of a hole
        self._deferred_boundary = False
        self._beat_plays = 0
        self._spread_used = 0.0
        self._beat_len = 0.0

        self.build()

        # A teardown held back by the last beat still has to happen.
        if self._deferred:
            pending, self._deferred = self._deferred, []
            for a in pending:
                a.run_time = 0.6
            super().play(*pending)

        if self.narr:
            with open(os.path.join(narr_dir, "starts.json"), "w") as f:
                json.dump(self._starts, f)

    # --- override this ---
    def build(self):
        raise NotImplementedError

    # --- narration timing ---
    def narrate(self, name):
        self._beat_no += 1
        self._beat_plays = 0
        self._spread_used = 0.0
        if name in self.narr:
            now = float(getattr(self.renderer, "time", 0.0) or 0.0)
            self._starts.append({"name": name, "start": round(now, 3)})
            self._narr_finish = now + self.narr[name]
            self._beat_len = float(self.narr[name])
        else:
            self._narr_finish = 0.0
            self._beat_len = 0.0

    def now(self):
        return float(getattr(self.renderer, "time", 0.0) or 0.0)

    def close_beat(self, min_tail=0.6):
        """Wait until the current beat's narration finishes (+ a small tail)."""
        now = getattr(self.renderer, "time", None)
        if now is not None and self._narr_finish:
            self.wait(max(min_tail, self._narr_finish - now + 0.35))
        else:
            self.wait(min_tail)
        # Whatever the scene fades out next is this beat's teardown: hold it
        # back so it dissolves under the next beat instead of leaving a hole.
        self._teardown_beat = self._beat_no

    def pace(self, frac, floor=0.4):
        """A wait sized to a fraction of the beat's remaining narration."""
        remaining = max(0.0, self._narr_finish - self.now())
        return max(floor, remaining * frac)

    def hold_until(self, frac):
        """Park the picture until `frac` of the current beat has elapsed."""
        if not self._starts or not self._narr_finish:
            self.wait(0.3)
            return
        start = self._starts[-1]["start"]
        dt = start + (self._narr_finish - start) * frac - self.now()
        if dt > 0.06:
            self.wait(dt)

    # --- pacing plumbing (see the class docstring) ---
    def _prepare(self, args):
        out = []
        for a in args:
            out.append(prepare_animation(a) if prepare_animation is not None else a)
        return out

    @staticmethod
    def _is_removal(anim):
        try:
            return bool(anim.is_remover())
        except Exception:
            return bool(getattr(anim, "remover", False))

    @staticmethod
    def _family_ids(anim):
        m = getattr(anim, "mobject", None)
        if m is None:
            return set()
        try:
            return {id(x) for x in m.get_family()}
        except Exception:
            return {id(m)}

    def _spread_gap(self, run_time):
        """Seconds to wait before a reveal so the beat fills its narration."""
        if not self.AUTO_SPREAD or not self._narr_finish:
            return 0.0
        if self._beat_plays < self.SPREAD_AFTER:
            return 0.0  # the beat is still assembling its composition
        if run_time < self.SPREAD_MIN_RT:
            return 0.0  # a follow-on; keep it glued to what it annotates
        remaining = self._narr_finish - self.now() - run_time
        if remaining < 6.0:
            return 0.0
        budget = self.SPREAD_BUDGET * self._beat_len - self._spread_used
        gap = min(self.SPREAD_CAP, remaining * self.SPREAD_FRAC, budget)
        return gap if gap > 0.3 else 0.0

    def play(self, *args, **kwargs):
        anims = self._prepare(args)
        # Scene.wait() is implemented as play(Wait(...)), so every wait -- the
        # scene's own holds, close_beat(), and the gaps this method inserts --
        # re-enters here. Waits are not reveals: pass them straight through, or
        # a gap recursively schedules another gap.
        if anims and all(isinstance(a, Wait) for a in anims):
            return super().play(*anims, **kwargs)

        # Nothing is ever removed into an empty frame. A play that only takes
        # things away is held back and replayed *underneath* whatever replaces
        # it -- across a beat boundary (the teardown) and within a beat (a
        # flourish clearing the stage for the next one), which is where the
        # "header alone on blank paper" frames came from.
        if anims and all(self._is_removal(a) for a in anims):
            self._deferred.extend(anims)
            if self._teardown_beat == self._beat_no:
                self._deferred_boundary = True
            return

        run_time = kwargs.pop("run_time", None)
        if run_time is not None:
            for a in anims:
                a.run_time = run_time
        rt = max([getattr(a, "run_time", 1.0) for a in anims] or [1.0])

        gap = self._spread_gap(rt)
        if gap:
            self._spread_used += gap
            self.wait(gap)

        if self._deferred:
            pending, self._deferred = self._deferred, []
            boundary, self._deferred_boundary = self._deferred_boundary, False
            # A mobject this play touches again cannot still be dissolving --
            # fade-out-then-fade-the-same-thing-back-in has to stay sequential.
            touched = set()
            for a in anims:
                touched.update(self._family_ids(a))
            clash = [p for p in pending if self._family_ids(p) & touched]
            rest = [p for p in pending if not (self._family_ids(p) & touched)]
            if clash:
                for a in clash:
                    a.run_time = 0.4
                super().play(*clash)
            dissolve = self.DISSOLVE if boundary else self.DISSOLVE_MID
            for a in rest:
                a.run_time = max(rt, dissolve)
            anims = anims + rest
        self._beat_plays += 1
        super().play(*anims, **kwargs)

    # --- shared beats ---
    def beat_title(self, extra_build=None):
        """Title + subtitle. extra_build(self) may add a diagram flourish."""
        self.narrate("title")
        title = fit_width(Text(self.spec["name"], **TITLE_KW).scale(0.9), 12.0)
        sub = fit_width(Text(self.spec.get("subtitle", ""), **BODY_KW).scale(0.5).set_opacity(0.8), 11.0)
        g = VGroup(title, sub).arrange(DOWN, buff=0.35)
        if extra_build is not None:
            g.shift(UP * 1.3)
        self.play(Write(title), run_time=1.0)
        if self.spec.get("subtitle"):
            self.play(FadeIn(sub, shift=UP * 0.2), run_time=0.5)
        extra = extra_build(self) if extra_build is not None else None
        self.close_beat(0.6)
        outs = [FadeOut(g)]
        if extra is not None:
            outs.append(FadeOut(extra))
        self.play(*outs, run_time=0.6)

    def beat_close_cta_placeholder(self):
        # Intentionally empty: CTA is bolted on downstream.
        pass
