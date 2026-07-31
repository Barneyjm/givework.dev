"""Diagram-first Collatz explainer. Centerpiece: the hailstone trajectory of 7
drawn on axes, rising in red on 3n+1 steps and falling in blue on n/2 steps,
crashing to 1. Then many hailstones converging to 1, the 2^71 verification wall
with the feared escape-to-infinity, and the undecidability/impact iconography.
"""

from manim import *
from viz import (
    BeatScene, PAPER, INK, RED, BLUE, YELLOW, GREEN,
    TITLE_KW, BODY_KW, MONO_KW, eyebrow, caption, fit_width, mathtex,
)


def collatz(n):
    seq = [n]
    while n != 1:
        n = n // 2 if n % 2 == 0 else 3 * n + 1
        seq.append(n)
    return seq


TRAJ = collatz(7)  # 7,22,11,34,17,52,...,1 (peak 52, 16 steps)


class ConjectureVideo(BeatScene):
    def build(self):
        self.beat_title(extra_build=self._title_flourish)
        self.beat_statement()
        self.beat_background()
        self.beat_why()
        self.beat_impact()

    # small bouncing polyline under the title
    def _title_flourish(self, _):
        axes = Axes(x_range=[0, 16, 16], y_range=[0, 56, 56], x_length=6.5, y_length=1.8,
                    tips=False, axis_config=dict(stroke_width=0)).shift(DOWN * 2.2)
        pts = [axes.c2p(i, v) for i, v in enumerate(TRAJ)]
        line = VGroup(*[Line(pts[i], pts[i + 1],
                             color=RED if TRAJ[i + 1] > TRAJ[i] else BLUE, stroke_width=4)
                        for i in range(len(pts) - 1)])
        self.play(Create(line), run_time=1.2)
        return line

    def _hailstone(self, seq, y_max, x_len=9.0, y_len=4.3, stroke=5, dot_r=0.06, faint=1.0):
        axes = Axes(x_range=[0, len(seq) - 1, max(1, (len(seq) - 1) // 4)],
                    y_range=[0, y_max, y_max], x_length=x_len, y_length=y_len, tips=False,
                    axis_config=dict(color=INK, stroke_width=3))
        pts = [axes.c2p(i, v) for i, v in enumerate(seq)]
        segs = VGroup(*[Line(pts[i], pts[i + 1],
                            color=(RED if seq[i + 1] > seq[i] else BLUE), stroke_width=stroke)
                        for i in range(len(pts) - 1)]).set_opacity(faint)
        dots = VGroup(*[Dot(p, radius=dot_r, color=INK) for p in pts]).set_opacity(faint)
        return axes, segs, dots, pts

    def beat_statement(self):
        self.narrate("statement")
        # rule chips
        even = VGroup(RoundedRectangle(corner_radius=0.12, width=3.5, height=0.9, color=BLUE,
                                       stroke_width=4, fill_opacity=0.08),
                      caption("even → n / 2", 0.5, color=BLUE, weight=BOLD))
        odd = VGroup(RoundedRectangle(corner_radius=0.12, width=3.5, height=0.9, color=RED,
                                      stroke_width=4, fill_opacity=0.08),
                     caption("odd → 3n + 1", 0.5, color=RED, weight=BOLD))
        chips = VGroup(even, odd).arrange(RIGHT, buff=0.7).to_edge(UP, buff=0.7)
        self.play(FadeIn(chips, shift=DOWN * 0.2), run_time=0.7)

        axes, segs, dots, pts = self._hailstone(TRAJ, 56)
        plot = VGroup(axes, segs, dots).shift(DOWN * 0.6)
        self.play(Create(axes), run_time=0.6)
        # trace the path segment by segment
        self.play(LaggedStart(*[Create(s) for s in segs], lag_ratio=0.55),
                  LaggedStart(*[GrowFromCenter(d) for d in dots], lag_ratio=0.55),
                  run_time=min(6.0, self.pace(0.6, 4.0)))
        peak_i = TRAJ.index(max(TRAJ))
        peak_lbl = Text("52", **MONO_KW).scale(0.42).next_to(dots[peak_i], UP, buff=0.12)
        one_lbl = Text("1", **MONO_KW).scale(0.5).set_color(GREEN).next_to(dots[-1], DOWN + RIGHT, buff=0.1)
        self.play(FadeIn(peak_lbl), run_time=0.3)
        self.play(FadeIn(one_lbl, scale=0.6), Flash(dots[-1], color=GREEN, line_length=0.2), run_time=0.6)
        self.close_beat(0.6)
        self.statement_group = VGroup(chips, plot, peak_lbl, one_lbl)
        self.play(chips.animate.set_opacity(0.0), FadeOut(peak_lbl), run_time=0.4)
        # keep the plot for background; drop the chips + labels
        self.play(FadeOut(chips), run_time=0.01)
        self._plot = VGroup(axes, segs, dots)
        self._one_lbl = one_lbl

    def beat_background(self):
        self.narrate("background")
        head = eyebrow("LOTHAR COLLATZ · 1937").to_edge(UP, buff=0.55)
        names = caption("3n+1 · hailstone · Syracuse problem", 0.44).next_to(head, DOWN, buff=0.25)
        # The header arrives WITH the dimming, not after it: pushing the plot
        # back to 28% first left the frame at 0.4% ink for a second and a half.
        self.play(self._plot.animate.set_opacity(0.28), FadeIn(head),
                  FadeIn(names, shift=UP * 0.15), run_time=0.7)

        # more hailstones converging to 1
        extras = VGroup()
        for start, ymax, col in [(9, 56, INK), (6, 56, INK), (11, 56, INK)]:
            ax, segs, dots, pts = self._hailstone(collatz(start), 56)
            g = VGroup(segs).set_opacity(0.0)
            g.move_to(self._plot.get_center())
            extras.add(g)
        self.play(LaggedStart(*[Create(g.set_opacity(0.33)) for g in extras], lag_ratio=0.4),
                  run_time=min(3.5, self.pace(0.35, 2.0)))
        quote = caption("“Mathematics is not yet ready for such problems.”  — Paul Erdős",
                        0.46, weight=BOLD).to_edge(DOWN, buff=0.7)
        self.play(FadeIn(quote, shift=UP * 0.2), run_time=0.6)
        self.close_beat(0.6)
        self.play(FadeOut(head), FadeOut(names), FadeOut(quote), FadeOut(extras),
                  FadeOut(self._plot), FadeOut(self._one_lbl), run_time=0.6)

    def beat_why(self):
        self.narrate("why")
        head = eyebrow("EASY TO STATE, IMPOSSIBLE TO PROVE").to_edge(UP, buff=0.55)
        self.play(FadeIn(head), run_time=0.4)

        # verification wall: a bar of checkmarks up to 2^71
        nl = NumberLine(x_range=[0, 10, 1], length=9, include_numbers=False, color=INK,
                        stroke_width=3).shift(UP * 0.6)
        marker = Triangle(color=GREEN, fill_opacity=1, stroke_width=0).scale(0.16).next_to(
            nl.number_to_point(0), UP, buff=0.08)
        lbl = caption("every number checked up to 2⁷¹  ( > a billion billion )  → all fall to 1",
                      0.44, color=GREEN).next_to(nl, DOWN, buff=0.4)
        self.play(Create(nl), FadeIn(marker), run_time=0.6)
        self.play(marker.animate.next_to(nl.number_to_point(10), UP, buff=0.08),
                  FadeIn(lbl, shift=UP * 0.15), run_time=min(2.5, self.pace(0.25, 1.5)))

        # but checking isn't proof: a feared escape to infinity
        warn = caption("but one number that escapes to infinity — or loops — would break it",
                       0.44, color=RED).next_to(lbl, DOWN, buff=0.5)
        esc = Arrow(nl.number_to_point(7) + DOWN * 0.1, nl.number_to_point(9) + UP * 2.4,
                    color=RED, stroke_width=6, buff=0)
        q = Text("?", **TITLE_KW).scale(0.7).set_color(RED).next_to(esc.get_end(), UP, buff=0.1)
        self.play(FadeIn(warn, shift=UP * 0.15), GrowArrow(esc), FadeIn(q), run_time=min(2.0, self.pace(0.35, 1.2)))

        tao = caption("Closest result — Terence Tao, 2019: almost all numbers fall to a tiny value.",
                      0.44, weight=BOLD).to_edge(DOWN, buff=0.6)
        self.play(FadeIn(tao, shift=UP * 0.15), run_time=0.6)
        self.close_beat(0.6)
        self.play(FadeOut(head), FadeOut(nl), FadeOut(marker), FadeOut(lbl), FadeOut(warn),
                  FadeOut(esc), FadeOut(q), FadeOut(tao), run_time=0.5)

    def _icon_row(self, icon, text):
        t = caption(text, 0.46, max_w=9.0)
        return VGroup(icon, t).arrange(RIGHT, buff=0.5)

    def beat_impact(self):
        self.narrate("impact")
        head = eyebrow("WHY IT MATTERS BEYOND THE PUZZLE").to_edge(UP, buff=0.6)
        self.play(FadeIn(head), run_time=0.4)

        # loop icon (halting)
        loop = VGroup(Arc(radius=0.34, start_angle=PI / 2, angle=1.6 * PI, color=INK, stroke_width=6),
                      Triangle(color=INK, fill_opacity=1, stroke_width=0).scale(0.09).rotate(-PI / 3)
                      .move_to([0.34, 0.22, 0]))
        # undecidable stamp
        stamp = VGroup(RoundedRectangle(corner_radius=0.08, width=0.9, height=0.5, color=RED, stroke_width=5),
                       Text("∄", font="sans-serif", weight=BOLD, color=RED).scale(0.5))
        # cpu / benchmark
        cpu = VGroup(Square(0.55, color=BLUE, stroke_width=5),
                     *[Line([0.35, y, 0], [0.5, y, 0], color=BLUE, stroke_width=4) for y in (-0.15, 0, 0.15)],
                     *[Line([-0.5, y, 0], [-0.35, y, 0], color=BLUE, stroke_width=4) for y in (-0.15, 0, 0.15)])

        rows = VGroup(
            self._icon_row(loop, "The classic hard case for proving software ever halts."),
            self._icon_row(stamp, "Conway: close cousins are formally undecidable — no algorithm can settle them."),
            self._icon_row(cpu, "A favorite benchmark for AI and computer-verified proof."),
        ).arrange(DOWN, aligned_edge=LEFT, buff=0.7).next_to(head, DOWN, buff=0.8)

        self.play(LaggedStart(*[FadeIn(r, shift=RIGHT * 0.3) for r in rows],
                              lag_ratio=0.5), run_time=min(3.5, self.pace(0.4, 2.0)))
        self.close_beat(0.6)
        self.play(FadeOut(head), FadeOut(rows), run_time=0.5)
