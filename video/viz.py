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

from manim import *

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


def logo(size=1.4):
    u = size / 32.0

    def p(sx, sy):
        return np.array([(sx - 16) * u, (16 - sy) * u, 0.0])

    bg = Square(side_length=size, color=INK, fill_opacity=1, stroke_width=0)
    circ = Circle(radius=6 * u, color=RED, fill_opacity=1, stroke_width=0).move_to(p(9, 10))
    sq = Square(side_length=12 * u, color=BLUE, fill_opacity=1, stroke_width=0).move_to(p(23, 10))
    tri = Polygon(p(6, 28), p(16, 16), p(26, 28), color=YELLOW, fill_opacity=1, stroke_width=0)
    return VGroup(bg, circ, sq, tri)


def eyebrow(txt):
    return Text(txt, **MONO_KW).scale(0.34).set_opacity(0.7)


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
    """Base for diagram-first conjecture videos. Subclasses implement build()."""

    def construct(self):
        spec_path = os.environ.get("SPEC_PATH", "/manim/spec.json")
        narr_dir = os.environ.get("NARR_DIR", "/manim/narration")
        self.spec = json.load(open(spec_path))
        dpath = os.path.join(narr_dir, "durations.json")
        self.narr = json.load(open(dpath)) if os.path.exists(dpath) else {}
        self._narr_dir = narr_dir
        self._narr_finish = 0.0
        self._starts = []

        self.build()

        if self.narr:
            with open(os.path.join(narr_dir, "starts.json"), "w") as f:
                json.dump(self._starts, f)

    # --- override this ---
    def build(self):
        raise NotImplementedError

    # --- narration timing ---
    def narrate(self, name):
        if name in self.narr:
            now = float(getattr(self.renderer, "time", 0.0) or 0.0)
            self._starts.append({"name": name, "start": round(now, 3)})
            self._narr_finish = now + self.narr[name]
        else:
            self._narr_finish = 0.0

    def now(self):
        return float(getattr(self.renderer, "time", 0.0) or 0.0)

    def close_beat(self, min_tail=0.6):
        """Wait until the current beat's narration finishes (+ a small tail)."""
        now = getattr(self.renderer, "time", None)
        if now is not None and self._narr_finish:
            self.wait(max(min_tail, self._narr_finish - now + 0.35))
        else:
            self.wait(min_tail)

    def pace(self, frac, floor=0.4):
        """A wait sized to a fraction of the beat's remaining narration."""
        remaining = max(0.0, self._narr_finish - self.now())
        return max(floor, remaining * frac)

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
