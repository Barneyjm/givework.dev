"""Data-driven conjecture explainer template. Reads a spec (SPEC_PATH) and
renders a consistent, narration-driven video in the Givework Bauhaus style —
title, statement, background, why-it-matters, downstream-impact, close.

This is the FALLBACK scene: any spec without a bespoke `sc_<slug>.py` renders
through here, so it has to hold the house pacing contract on its own. It gets
that by subclassing viz.BeatScene rather than reimplementing it — the deferred
teardown (nothing is removed into an empty frame), the reveal spreading, the
banded section label and the palette guard all come from there.

    SPEC_PATH=spec.json manim -qh conjecture_video.py ConjectureVideo

The spec schema (see agents' StructuredOutput):
  {
    "slug", "name", "subtitle",
    "statement": "one plain sentence", "tex": "optional LaTeX (no $)",
    "background": ["line", ...],          # 2-4 short lines of history/context
    "why": ["line", ...],                 # 2-3 lines: why it matters
    "impact": ["bullet", ...],            # 3-4 downstream-field impacts
    "narration": { "<beatid>": "spoken line", ... }  # keys below
  }
Beat ids for narration: title, statement, background, why, impact, close.
"""

import textwrap

# manim FIRST, viz SECOND -- `from manim import *` rebinds RED/BLUE/YELLOW/GREEN
# to the stock palette, so ours have to win the name race. BeatScene asserts it.
from manim import *
from viz import (
    BeatScene, PAPER, INK, RED, BLUE, YELLOW, GREEN,
    TITLE_KW, BODY_KW, MONO_KW, FRAME_W, eyebrow, fit_width, logo, mathtex,
)


def wrapped(text, width=42, scale=0.6, color=INK, weight=NORMAL):
    """A wrapped paragraph as one Text mobject, scaled to fit the frame width."""
    body = "\n".join(textwrap.wrap(text, width=width)) or text
    t = Text(body, font="sans-serif", color=color, weight=weight, line_spacing=0.9).scale(scale)
    if t.width > FRAME_W:
        t.scale(FRAME_W / t.width)
    return t


def fit_height(group, top_buff, bottom_buff=0.6):
    """Scale a group down so it fits between top_buff and the frame bottom."""
    usable = config.frame_height - top_buff - bottom_buff
    if group.height > usable:
        group.scale(usable / group.height)
    return group


class ConjectureVideo(BeatScene):
    """The generic text explainer.

    Nothing moves in this scene except the copy arriving, so a beat that puts all
    of its text up in the first two seconds has nothing left to do for the other
    twenty-five. `beat_list` therefore reveals one line per `play()` and lets
    BeatScene's AUTO_SPREAD walk them across the narration, and the gaps are
    allowed to run a little longer than the diagram scenes' default: there is no
    diagram here to carry the interval, so a longer walk is the only thing that
    keeps the beat arriving.
    """

    SPREAD_CAP = 3.2

    def rule(self, width=FRAME_W, h=0.16):
        """A section band with the label taken out.

        The title beat is the one beat with neither a section label nor a
        diagram, so in a template whose other beats are walls of text it is the
        sparsest frame in the video by a wide margin: it measured 4.7% ink
        against a 16.6% median, a whisker above the gate's relative floor of
        4.15% and under the 5% below which that floor even applies. Banding the
        body beats is what raised the median, so the title card has to be
        anchored too. This is the same Bauhaus rule the section labels are set
        on; it carries no words, it is furniture, not copy. (The close beat
        needs no such help — logo plus two lines lands at 5.7%, clear of the
        floor and above the 5% cutoff.)
        """
        bar = Rectangle(width=width, height=h, color=INK, fill_color=INK,
                        fill_opacity=1, stroke_width=0)
        accent = Rectangle(width=h * 3.2, height=h, color=YELLOW, fill_color=YELLOW,
                           fill_opacity=1, stroke_width=0)
        accent.move_to(bar.get_right() + LEFT * (h * 3.2 / 2))
        return VGroup(bar, accent)

    def build(self):
        self.beat_title()
        self.beat_statement()
        self.beat_list("background", "BACKGROUND", self.spec.get("background", []))
        self.beat_list("why", "WHY IT MATTERS", self.spec.get("why", []))
        self.beat_list("impact", "DOWNSTREAM IMPACT", self.spec.get("impact", []), bullets=True)
        self.beat_close()

    # beats ---------------------------------------------------------------
    def beat_title(self):
        self.narrate("title")
        title = fit_width(Text(self.spec["name"], **TITLE_KW).scale(0.95))
        sub = fit_width(Text(self.spec.get("subtitle", ""), **BODY_KW).scale(0.5).set_opacity(0.8))
        g = VGroup(title, sub).arrange(DOWN, buff=0.35)
        bar = self.rule().next_to(g, DOWN, buff=0.7)
        g.add(bar)
        # The rule is drawn WITH the title, not after it. The video opens on
        # blank paper, so how fast the first beat reaches a composed frame is
        # the whole of the opening: title-then-subtitle-then-rule spent 1.5s
        # under the floor climbing out of nothing, and running the rule
        # underneath the write halves that.
        self.play(Write(title), GrowFromEdge(bar, LEFT), run_time=1.1)
        if self.spec.get("subtitle"):
            self.play(FadeIn(sub, shift=UP * 0.2), run_time=0.6)
        self.close_beat(0.8)
        # Held back by BeatScene.play() and dissolved under the next beat's
        # section band, so the title never tears down into an empty frame.
        self.play(FadeOut(g), run_time=0.6)

    def beat_statement(self):
        self.narrate("statement")
        head = eyebrow("THE CONJECTURE").to_edge(UP, buff=0.55)
        parts = [wrapped(self.spec["statement"], width=44, scale=0.62)]
        tex = mathtex(self.spec["tex"], scale=0.95, max_w=10) if self.spec.get("tex") else None
        if tex is not None:
            parts.append(tex)
        block = VGroup(*parts).arrange(DOWN, buff=0.7)
        fit_height(block, top_buff=2.0)
        block.next_to(head, DOWN, buff=0.9)
        self.play(FadeIn(head), run_time=0.4)
        # Write the sentence at the pace of the sentence, not in a flat 1.1s.
        self.play(Write(parts[0]), run_time=min(3.0, self.pace(0.16, 1.1)))
        for p in parts[1:]:
            self.play(Write(p), run_time=1.0)
        self.close_beat(0.8)
        self.play(FadeOut(VGroup(head, block)), run_time=0.6)

    def beat_list(self, beat_id, heading, lines, bullets=False):
        if not lines:
            return
        self.narrate(beat_id)
        head = eyebrow(heading).to_edge(UP, buff=0.55)
        items = VGroup()
        for ln in lines:
            prefix = "•  " if bullets else ""
            items.add(wrapped(prefix + ln, width=52, scale=0.58))
        items.arrange(DOWN, aligned_edge=LEFT, buff=0.55)
        fit_height(items, top_buff=2.2)
        items.next_to(head, DOWN, buff=0.9)
        self.play(FadeIn(head), run_time=0.4)
        # One play per line. The band and the first line land together so the
        # beat is composed within a second (SPREAD_AFTER=2 exempts them); every
        # later line is a reveal AUTO_SPREAD can push out across the narration.
        for it in items:
            self.play(FadeIn(it, shift=RIGHT * 0.3), run_time=0.6)
        self.close_beat(0.8)
        self.play(FadeOut(VGroup(head, items)), run_time=0.6)

    def beat_close(self):
        self.narrate("close")
        g = logo(1.4).to_edge(UP, buff=1.4)
        line = fit_width(Text("Verifiable math, chipped away in the open.", **TITLE_KW).scale(0.7))
        url = fit_width(Text("givework.dev/conjectures/" + self.spec["slug"], **MONO_KW)
                        .scale(0.42).set_color(RED))
        block = VGroup(line, url).arrange(DOWN, buff=0.5).next_to(g, DOWN, buff=0.7)
        # The mark and the line arrive together. Landing the logo on its own
        # first left ~1.3s of a 1.4-unit square alone on the page (1.9% ink,
        # under the gate's floor) once the previous beat had finished dissolving
        # underneath it — the last dead-air window in the template.
        self.play(FadeIn(g, shift=DOWN * 0.2), Write(line), run_time=1.2)
        self.play(FadeIn(url, shift=UP * 0.2), run_time=0.6)
        self.close_beat(1.2)
