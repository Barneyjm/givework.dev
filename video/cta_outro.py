"""Modular call-to-action outro, rendered once and bolted onto the end of any
conjecture video (bolt_cta.sh). Single narration beat "cta" (reused across all
videos), timed from NARR_DIR/durations.json; emits starts.json for muxing.

    SPEC_PATH unused. NARR_DIR=/manim/narration_cta \
      manim -qh --disable_caching cta_outro.py CTAOutro
"""

import json
import os

from manim import *

NARR_DIR = os.environ.get("NARR_DIR", "/manim/narration_cta")

PAPER = "#f4f1e6"
INK = "#161310"
RED = "#e1342b"
BLUE = "#21449c"
YELLOW = "#f3c20a"
config.background_color = PAPER

TITLE_KW = dict(font="sans-serif", weight=BOLD, color=INK)
BODY_KW = dict(font="sans-serif", color=INK)
MONO_KW = dict(font="monospace", color=INK)


def logo(size=1.5):
    u = size / 32.0

    def p(sx, sy):
        return np.array([(sx - 16) * u, (16 - sy) * u, 0.0])

    bg = Square(side_length=size, color=INK, fill_opacity=1, stroke_width=0)
    circ = Circle(radius=6 * u, color=RED, fill_opacity=1, stroke_width=0).move_to(p(9, 10))
    sq = Square(side_length=12 * u, color=BLUE, fill_opacity=1, stroke_width=0).move_to(p(23, 10))
    tri = Polygon(p(6, 28), p(16, 16), p(26, 28), color=YELLOW, fill_opacity=1, stroke_width=0)
    return VGroup(bg, circ, sq, tri)


class CTAOutro(Scene):
    def construct(self):
        dpath = os.path.join(NARR_DIR, "durations.json")
        self.narr = json.load(open(dpath)) if os.path.exists(dpath) else {}
        self._narr_finish = 0.0
        self._starts = []

        # timing
        if "cta" in self.narr:
            self._starts.append({"name": "cta", "start": 0.0})
            self._narr_finish = self.narr["cta"]

        g = logo(1.5).to_edge(UP, buff=1.3)
        head = Text("Help chip away at this conjecture.", **TITLE_KW).scale(0.82)
        if head.width > 12.0:
            head.scale(12.0 / head.width)
        prompt = Text("Get started now at", **BODY_KW).scale(0.5).set_opacity(0.85)

        # givework.dev as a bold button-like wordmark
        url = Text("givework.dev", font="monospace", weight=BOLD, color=PAPER).scale(0.62)
        pill = RoundedRectangle(corner_radius=0.16, width=url.width + 0.9, height=url.height + 0.55,
                                color=INK, fill_opacity=1, stroke_width=0)
        button = VGroup(pill, url)
        arrow = Text("↗", **TITLE_KW).scale(0.6).set_color(RED).next_to(button, RIGHT, buff=0.25)
        btn = VGroup(button, arrow)

        block = VGroup(head, prompt, btn).arrange(DOWN, buff=0.55).next_to(g, DOWN, buff=0.8)

        self.play(FadeIn(g, shift=DOWN * 0.2), run_time=0.6)
        self.play(Write(head), run_time=1.0)
        self.play(FadeIn(prompt, shift=UP * 0.15), run_time=0.4)
        self.play(GrowFromCenter(button), FadeIn(arrow, shift=RIGHT * 0.2), run_time=0.6)
        self.play(Indicate(button, color=YELLOW, scale_factor=1.06), run_time=0.6)

        # hold until the narration finishes (+ a small tail so it doesn't clip)
        now = float(getattr(self.renderer, "time", 0.0) or 0.0)
        self.wait(max(0.8, self._narr_finish - now + 0.5))

        if self.narr:
            with open(os.path.join(NARR_DIR, "starts.json"), "w") as f:
                json.dump(self._starts, f)
