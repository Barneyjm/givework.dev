"""Reusable animation modules for Givework explainer videos.

Composable pieces that scenes assemble instead of hand-writing every diagram.
Each module is a positionable mobject (VGroup — or Group when it may contain
an ImageMobject, which cannot live in a VGroup). Build it, place it with
move_to / to_edge / next_to, then reveal it at the caller's pace.

Import order is load-bearing (viz.py's palette guard enforces it in scenes):

    from manim import *          # FIRST — or manim's stock palette wins
    from viz import BeatScene, ...
    from modules import Timeline, Descent, ...

Shared contract
---------------
* ``reveals()`` yields lists of animations, one list per ``play()`` call, in
  the order the module should assemble::

      m = Descent(BOUNDS, goal=(2, "the conjecture"))
      m.move_to(DOWN * 0.4)
      for step in m.reveals():
          self.play(*step)          # caller owns run_time / pacing

* Methods that add detail later (``Timeline.span``, ``NumberExplorer.hit``,
  ``PaperDoc.circle_line`` …) return positioned mobjects; the caller plays
  FadeIn/Create on them. Methods named ``*_anim`` return an Animation.
* No module ever removes mobjects from the scene. Teardown stays with the
  caller, so BeatScene's dissolve-under-the-next-beat contract holds and no
  module can strand the frame at near-zero ink.
"""

import math
import os

from manim import *  # noqa: F401,F403  -- must precede the viz import
from viz import (  # noqa: E402
    BLUE,
    BODY_KW,
    FRAME_W,
    GREEN,
    INK,
    MONO_KW,
    PAPER,
    RED,
    TITLE_KW,
    YELLOW,
    caption,
    fit_width,
)

__all__ = [
    "Timeline",
    "PortraitPlate",
    "NumberExplorer",
    "Descent",
    "PaperDoc",
    "QuoteCard",
    "ProgressMeter",
    "ChapterCard",
    "Counter",
    "ACCENTS",
]

#: per-item cycling used by Timeline / NumberExplorer / Descent defaults
ACCENTS = [RED, BLUE, GREEN, YELLOW]


def _mono(txt, scale=0.3, color=INK, bold=False):
    kw = dict(MONO_KW)
    if bold:
        kw["weight"] = BOLD
    return Text(txt, **kw).scale(scale).set_color(color)


def _wrap_lines(text, scale, max_w, **text_kw):
    """Greedy word-wrap into Text lines no wider than max_w (measured)."""
    out = []
    for para in text.split("\n"):
        words, cur = para.split(), ""
        while words:
            trial = (cur + " " + words[0]).strip()
            if cur and Text(trial, **text_kw).scale(scale).width > max_w:
                out.append(cur)
                cur = ""
            else:
                cur = trial
                words.pop(0)
        if cur:
            out.append(cur)
    return [Text(line, **text_kw).scale(scale) for line in out]


# --------------------------------------------------------------------------- #
# 1. Timeline
# --------------------------------------------------------------------------- #
class Timeline(VGroup):
    """Horizontal year band with ticks and event cards, revealed one by one.

        tl = Timeline([(1849, "de Polignac", RED), (2013, "Zhang", GREEN)],
                      1840, 2020).move_to(UP * 0.4)
        for step in tl.reveals(): self.play(*step)

    Events are ``(year, title)`` or ``(year, title, color)``; colors default
    to the ACCENTS cycle. Cards alternate above/below the axis.
    ``span(y0, y1, label)`` returns a highlight band (the 1769->1966 move,
    generalised) for the caller to FadeIn.
    """

    def __init__(self, events, start_year, end_year, length=11.0):
        super().__init__()
        self._y0, self._y1 = float(start_year), float(end_year)
        self.axis = Line(LEFT * length / 2, RIGHT * length / 2, color=INK, stroke_width=4)
        self.end_marks = VGroup()
        for year, x in ((start_year, -length / 2), (end_year, length / 2)):
            cap_l = Line([x, -0.2, 0], [x, 0.2, 0], color=INK, stroke_width=5)
            lbl = _mono(str(year), 0.28).set_opacity(0.8).next_to(cap_l, DOWN, buff=0.2)
            self.end_marks.add(VGroup(cap_l, lbl))
        self.cards = VGroup()
        for i, ev in enumerate(events):
            year, title = ev[0], ev[1]
            color = ev[2] if len(ev) > 2 else ACCENTS[i % len(ACCENTS)]
            x = self._x_local(year, length)
            up = i % 2 == 0
            tick = Line([x, -0.12, 0], [x, 0.12, 0], color=color, stroke_width=6)
            card = VGroup(
                _mono(str(year), 0.3, color, bold=True),
                caption(title, 0.3, max_w=2.6),
            ).arrange(DOWN, buff=0.1)
            card.move_to([x, 0.95 if up else -0.95, 0])
            stem = Line([x, 0.18 if up else -0.18, 0], [x, 0.55 if up else -0.55, 0],
                        color=color, stroke_width=2).set_opacity(0.45)
            self.cards.add(VGroup(tick, stem, card))
        self.add(self.axis, self.end_marks, self.cards)

    def _x_local(self, year, length):
        f = (year - self._y0) / (self._y1 - self._y0)
        return -length / 2 + f * length

    def year_point(self, year):
        """Live scene point on the axis for a year (valid after positioning)."""
        f = (year - self._y0) / (self._y1 - self._y0)
        return self.axis.point_from_proportion(min(1.0, max(0.0, f)))

    def span(self, y0, y1, label=None, color=YELLOW):
        """Highlight band along the axis between two years, behind the ticks."""
        band = Line(self.year_point(y0), self.year_point(y1), color=color,
                    stroke_width=12).set_opacity(0.55).set_z_index(-1)
        grp = VGroup(band)
        if label:
            # below the below-axis cards (which sit at ~0.95), not on them
            lbl = caption(label, 0.3, weight=BOLD).next_to(band, DOWN, buff=1.45)
            grp.add(lbl)
        return grp

    def reveals(self):
        yield [Create(self.axis), FadeIn(self.end_marks)]
        for c in self.cards:
            up = c[2].get_center()[1] > self.axis.get_center()[1]
            yield [FadeIn(c[0]), Create(c[1]),
                   FadeIn(c[2], shift=(DOWN if up else UP) * 0.15)]


# --------------------------------------------------------------------------- #
# 2. PortraitPlate
# --------------------------------------------------------------------------- #
class PortraitPlate(Group):
    """Framed, ink-edged portrait with name and credit line (the Euler plate).

        pp = PortraitPlate("assets/euler_handmann_1753_plate.png",
                           "Leonhard Euler · 1769", "Handmann, 1753 · public domain")
        pp.move_to(LEFT * 4.6 + UP * 0.6)
        for step in pp.reveals(): self.play(*step)

    Group (not VGroup) because it may hold an ImageMobject. Pass
    ``image_path=None`` (or a missing path) for a flat silhouette placeholder.
    """

    def __init__(self, image_path, name, credit, height=2.9):
        super().__init__()
        if image_path and os.path.exists(image_path):
            self.image = ImageMobject(image_path)
            self.image.height = height
        else:  # flat placeholder in brand blue -- keeps layouts honest pre-art
            w = height * 0.78
            panel = Rectangle(width=w, height=height, color=BLUE, fill_color=BLUE,
                              fill_opacity=0.14, stroke_width=0)
            head = Circle(radius=height * 0.11, color=INK, fill_opacity=0.85,
                          stroke_width=0).move_to(panel.get_center() + UP * height * 0.14)
            torso = RoundedRectangle(corner_radius=height * 0.09, width=w * 0.52,
                                     height=height * 0.24, color=INK, fill_opacity=0.85,
                                     stroke_width=0).next_to(head, DOWN, buff=height * 0.03)
            hint = _mono("image placeholder", 0.18).set_opacity(0.5)
            hint.move_to(panel.get_bottom() + UP * 0.22)
            self.image = VGroup(panel, head, torso, hint)
        self.edge = SurroundingRectangle(self.image, color=INK, stroke_width=3, buff=0.0)
        self.name = caption(name, 0.32, weight=BOLD).next_to(self.image, DOWN, buff=0.26)
        self.credit = caption(credit, 0.22).set_opacity(0.7).next_to(self.name, DOWN, buff=0.12)
        self.add(self.image, self.edge, self.name, self.credit)

    def reveals(self):
        yield [FadeIn(self.image, shift=UP * 0.12), Create(self.edge)]
        yield [FadeIn(self.name, shift=UP * 0.1), FadeIn(self.credit)]


# --------------------------------------------------------------------------- #
# 3. NumberExplorer
# --------------------------------------------------------------------------- #
class NumberExplorer(VGroup):
    """Number line with swept ranges, hit stars, exclusion bands, a frontier.

        ne = NumberExplorer((0, 160, 40)).move_to(UP * 1.4)
        self.play(*ne.reveal())
        self.play(Create(ne.sweep(2, 42, BLUE, "run one")[0]))

    Generalises the 2/42/82/122/144 search line. All detail methods return
    positioned mobjects for the caller to play; ``move_frontier_anim(x)``
    returns the animation that advances the frontier marker.
    """

    def __init__(self, x_range, length=11.0, tick_labels=True):
        super().__init__()
        lo, hi, step = x_range
        self.nl = NumberLine(x_range=[lo, hi, step], length=length,
                             include_numbers=False, color=INK, stroke_width=3)
        self.ticks = VGroup()
        if tick_labels:
            v = lo
            while v <= hi + 1e-9:
                t = _mono(f"{v:g}", 0.26)
                t.move_to(self.nl.number_to_point(v) + UP * 0.45)
                self.ticks.add(t)
                v += step
        self.add(self.nl, self.ticks)
        self._frontier = None
        self._frontier_x = None

    def n2p(self, v):
        return self.nl.number_to_point(v)

    def reveal(self):
        return [Create(self.nl), FadeIn(self.ticks)]

    def reveals(self):
        yield self.reveal()

    def sweep(self, lo, hi, color, owner=None):
        """Colored swept range with an optional owner label beneath it."""
        seg = Line(self.n2p(lo), self.n2p(hi), color=color, stroke_width=12)
        grp = VGroup(seg)
        if owner:
            lbl = _mono(owner, 0.24, color).next_to(seg, DOWN, buff=0.28)
            grp.add(lbl)
        return grp

    def hit(self, x, label=None, color=RED):
        """Star marker for a find (the 144 moment). Sits above the tick row."""
        star = Text("★", font="sans-serif", color=color).scale(0.42)
        star.move_to(self.n2p(x) + UP * 0.85)
        grp = VGroup(star)
        if label:
            grp.add(_mono(label, 0.24, color).next_to(star, UP, buff=0.1))
        return grp

    def exclude(self, lo, hi, label=None):
        """Shaded, dash-bordered band: this stretch is ruled out."""
        w = abs(self.n2p(hi)[0] - self.n2p(lo)[0])
        rect = Rectangle(width=w, height=0.56, color=INK, stroke_width=2.5,
                         fill_color=INK, fill_opacity=0.08)
        rect.move_to((self.n2p(lo) + self.n2p(hi)) / 2)
        border = DashedVMobject(rect, num_dashes=max(12, int(w * 6)))
        border.set_stroke(opacity=0.6)
        grp = VGroup(border)
        if label:
            lbl = _mono(label, 0.22).set_opacity(0.7)
            lbl.next_to(rect, DOWN, buff=0.24).align_to(rect, LEFT)
            grp.add(lbl)
        return grp

    def frontier(self, x, label="frontier", drop=0.0):
        """Movable marker: triangle under the line, label, optional tether."""
        tri = Triangle(color=INK, fill_opacity=1, stroke_width=0).scale(0.16)
        tri.move_to(self.n2p(x) + DOWN * 0.03, UP)
        lbl = _mono(label, 0.24).next_to(tri, DOWN, buff=0.36)  # under sweep owners
        grp = VGroup(tri, lbl)
        if drop > 0:
            tether = DashedLine(lbl.get_bottom() + DOWN * 0.12,
                                lbl.get_bottom() + DOWN * (0.12 + drop),
                                color=INK, stroke_width=3, dash_length=0.11).set_opacity(0.5)
            grp.add(tether)
        self._frontier, self._frontier_x = grp, x
        return grp

    def move_frontier_anim(self, x):
        """Animation sliding the frontier marker to a new value."""
        if self._frontier is None:
            raise ValueError("call frontier(x) before move_frontier_anim(x)")
        dx = self.n2p(x)[0] - self.n2p(self._frontier_x)[0]
        self._frontier_x = x
        return self._frontier.animate.shift(RIGHT * dx)


# --------------------------------------------------------------------------- #
# 4. Descent
# --------------------------------------------------------------------------- #
class Descent(VGroup):
    """Log-scaled falling staircase of bounds — the 70,000,000 -> 246 story.

        d = Descent([(70_000_000, "Yitang Zhang", "May 2013"),
                     (246, "Polymath 8b", "Apr 2014")], goal=(2, "the conjecture"))
        for step in d.reveals(): self.play(*step)

    ``steps`` is ``[(value, author, date), ...]`` in falling order; heights
    are log-scaled so each collapse reads at true magnitude. Each drop carries
    a "÷N" factor chip. ``goal=(value, label)`` draws the dashed target line
    and the still-open gap.
    """

    def __init__(self, steps, goal=None, width=11.0, height=5.2, colors=None):
        super().__init__()
        assert len(steps) >= 1
        colors = colors or ACCENTS
        vals = [float(s[0]) for s in steps]
        floor_v = float(goal[0]) if goal else min(vals)
        top_v = max(vals)
        lo_l, hi_l = math.log10(floor_v), math.log10(top_v)

        def y_of(v):
            f = (math.log10(float(v)) - lo_l) / (hi_l - lo_l)
            return -height / 2 + f * height

        # log-scaled heights, but tight steps (600 -> 246) get a readable
        # minimum drop, then everything is compressed back above the goal line.
        MIN_GAP = 1.05
        raw = [y_of(v) for v in vals]
        ys = [raw[0]]
        for r in raw[1:]:
            ys.append(min(r, ys[-1] - MIN_GAP))
        gy = y_of(floor_v)
        floor_y = gy + 1.1 if goal else -height / 2
        if len(ys) > 1 and ys[-1] < floor_y < ys[0]:
            k = (ys[0] - floor_y) / (ys[0] - ys[-1])
            ys = [ys[0] - (ys[0] - y) * k for y in ys]

        n = len(steps)
        pw = min(1.15, (width - 1.0) / (2 * n))  # platform half-width
        xs = ([0.0] if n == 1 else
              [(-width / 2 + pw + 0.1) + i * (width - 2 * pw - 0.2) / (n - 1) for i in range(n)])

        self.cards = VGroup()
        self.drops = VGroup()
        prev = None
        for i, ((val, author, date), x, y) in enumerate(zip(steps, xs, ys)):
            c = colors[i % len(colors)]
            plat = Line([x - pw, y, 0], [x + pw, y, 0], color=c, stroke_width=9)
            num = _mono(f"{val:,}" if isinstance(val, int) else str(val),
                        0.5 if i == 0 else 0.42, INK, bold=True)
            num.next_to(plat, UP, buff=0.14)
            meta = caption(f"{author} · {date}", 0.26, max_w=2 * pw + 0.9).set_opacity(0.8)
            meta.next_to(plat, DOWN, buff=0.16)
            card = VGroup(plat, num, meta)
            card.plat, card.num, card.meta = plat, num, meta
            self.cards.add(card)
            if prev is not None:
                px, py = prev
                h = Line([px + pw + 0.08, py, 0], [x, py, 0], color=INK,
                         stroke_width=3).set_opacity(0.6)
                v_end = num.get_top()[1] + 0.1
                v = Arrow([x, py, 0], [x, v_end, 0], color=INK, stroke_width=3.5,
                          buff=0, max_tip_length_to_length_ratio=0.12, tip_length=0.16)
                ratio = vals[i - 1] / vals[i]
                chip = _mono(f"÷{ratio:,.0f}" if ratio >= 10 else f"÷{ratio:.1f}",
                             0.3, c, bold=True)
                chip.next_to(v, RIGHT, buff=0.14).shift(UP * (v.height * 0.12))
                self.drops.add(VGroup(h, v, chip))
            prev = (x, y)

        self.goal = None
        if goal:
            gv, glabel = goal
            dash = DashedLine([-width / 2, gy, 0], [width / 2, gy, 0], color=YELLOW,
                              stroke_width=4, dash_length=0.14)
            glbl = VGroup(_mono(f"{gv:,}" if isinstance(gv, int) else str(gv),
                                0.4, INK, bold=True),
                          caption(glabel, 0.28).set_opacity(0.85)).arrange(RIGHT, buff=0.22)
            # left end of the dash: the staircase owns the right half
            glbl.next_to(dash, UP, buff=0.14).align_to(dash, LEFT).shift(RIGHT * 0.1)
            last_x = prev[0]
            gap_top = self.cards[-1].meta.get_bottom()[1] - 0.12
            gap = DashedLine([last_x, gap_top, 0], [last_x, gy + 0.08, 0],
                             color=RED, stroke_width=3.5, dash_length=0.1)
            gap_lbl = _mono("still open", 0.24, RED).next_to(gap, LEFT, buff=0.16)
            self.goal = VGroup(dash, glbl)
            self.gap = VGroup(gap, gap_lbl)
            self.add(self.goal, self.gap)
        self.add(self.cards, self.drops)

    def reveals(self):
        c0 = self.cards[0]
        yield [Create(c0.plat), FadeIn(c0.num, shift=DOWN * 0.2), FadeIn(c0.meta)]
        for card, drop in zip(self.cards[1:], self.drops):
            yield [Create(drop[0]), GrowArrow(drop[1]), FadeIn(drop[2], shift=DOWN * 0.15)]
            yield [Create(card.plat), FadeIn(card.num, shift=DOWN * 0.3),
                   FadeIn(card.meta)]
        if self.goal is not None:
            yield [Create(self.goal[0]), FadeIn(self.goal[1])]
            yield [Create(self.gap[0]), FadeIn(self.gap[1], shift=RIGHT * 0.1)]


# --------------------------------------------------------------------------- #
# 5. PaperDoc
# --------------------------------------------------------------------------- #
class PaperDoc(VGroup):
    """Document card: sheet, title, head rule, byline chip, ruled body lines.

        pd = PaperDoc(["A COUNTEREXAMPLE TO EULER'S", "CONJECTURE"],
                      n_rule_lines=3, byline="LANDER & PARKIN · 1966")
        for step in pd.reveals(): self.play(*step)

    The two-sentence Lander-Parkin paper treatment, as one call.
    ``circle_line(i)`` returns the red annotation ellipse around body line i.
    """

    def __init__(self, title_lines, n_rule_lines=3, byline="", width=6.4):
        super().__init__()
        titles = VGroup(*[caption(t, 0.3, weight=BOLD, max_w=width - 0.8)
                          for t in title_lines]).arrange(DOWN, buff=0.12)
        head_rule = Line(LEFT * (width / 2 - 0.4), RIGHT * (width / 2 - 0.4),
                         color=INK, stroke_width=2.5).set_opacity(0.7)
        chip = None
        if byline:
            btxt = _mono(byline, 0.2).set_opacity(0.9)
            bbox = RoundedRectangle(corner_radius=0.08, width=btxt.width + 0.4,
                                    height=0.42, color=INK, stroke_width=2.5,
                                    fill_color=INK, fill_opacity=0.06)
            btxt.move_to(bbox.get_center())
            chip = VGroup(bbox, btxt)
        widths = [width - 1.0, width - 1.0, width - 2.2]
        self.rules = VGroup(*[
            Line(ORIGIN, RIGHT * widths[i % 3], color=INK, stroke_width=3.5).set_opacity(0.5)
            for i in range(n_rule_lines)
        ]).arrange(DOWN, buff=0.3, aligned_edge=LEFT)

        body = VGroup(titles, head_rule)
        if chip is not None:
            body.add(chip)
        body.add(self.rules)
        body.arrange(DOWN, buff=0.3)
        self.rules.align_to(head_rule, LEFT)
        self.sheet = Rectangle(width=width, height=body.height + 0.8, color=INK,
                               stroke_width=4, fill_color=PAPER, fill_opacity=1)
        body.move_to(self.sheet.get_center())
        self.titles, self.head_rule, self.byline_chip = titles, head_rule, chip
        self.add(self.sheet, body)

    def circle_line(self, index=0, color=RED):
        """Hand-drawn-feel annotation ring around body line `index`."""
        line = self.rules[index]
        return Ellipse(width=line.width + 0.7, height=0.66, color=color,
                       stroke_width=4).move_to(line.get_center())

    def reveals(self):
        yield [Create(self.sheet)]
        yield [FadeIn(self.titles, shift=UP * 0.08), Create(self.head_rule)]
        if self.byline_chip is not None:
            yield [FadeIn(self.byline_chip, shift=UP * 0.08)]
        yield [LaggedStart(*[Create(r) for r in self.rules], lag_ratio=0.3)]


# --------------------------------------------------------------------------- #
# 6. QuoteCard
# --------------------------------------------------------------------------- #
class QuoteCard(VGroup):
    """Attributed pull-quote with an oversized quotation mark, auto-fitted.

        qc = QuoteCard("My mind is very peaceful.", "Yitang Zhang · 2013",
                       max_w=6.5).move_to(RIGHT * 2.8)
        for step in qc.reveals(): self.play(*step)
    """

    def __init__(self, text, attribution, max_w=8.5, scale=0.44, accent=YELLOW):
        super().__init__()
        self.lines = VGroup(*_wrap_lines(text, scale, max_w, **BODY_KW))
        self.lines.arrange(DOWN, buff=0.2, aligned_edge=LEFT)
        self.mark = Text("“", **TITLE_KW).scale(2.4).set_color(accent)
        self.mark.move_to(self.lines.get_corner(UL) + LEFT * 0.5 + UP * 0.05)
        self.rule = Line(ORIGIN, RIGHT * 1.1, color=accent, stroke_width=5)
        self.rule.next_to(self.lines, DOWN, buff=0.32).align_to(self.lines, LEFT)
        self.attr = _mono("— " + attribution, 0.28).set_opacity(0.8)
        self.attr.next_to(self.rule, RIGHT, buff=0.25)
        self.add(self.mark, self.lines, self.rule, self.attr)
        fit_width(self, FRAME_W)

    def reveals(self):
        yield [FadeIn(self.mark, scale=0.6)]
        yield [LaggedStart(*[FadeIn(l, shift=UP * 0.1) for l in self.lines],
                           lag_ratio=0.25)]
        yield [Create(self.rule), FadeIn(self.attr)]


# --------------------------------------------------------------------------- #
# 7. ProgressMeter
# --------------------------------------------------------------------------- #
class ProgressMeter(VGroup):
    """Labelled horizontal meter with an animatable fill.

        pm = ProgressMeter("budget", value=340, total=500, color=BLUE,
                           readout="$3.40 / $5.00")
        for step in pm.reveals(): self.play(*step)
        self.play(pm.fill_anim(0.92), run_time=1.4)

    Give either ``fraction=`` or ``value=``/``total=``. The default readout is
    "value / total" (or a percentage); pass ``readout=`` to override —
    "verified up to N" style.
    """

    def __init__(self, label, fraction=None, value=None, total=None,
                 width=7.5, height=0.66, color=BLUE, readout=None):
        super().__init__()
        if fraction is None:
            if value is None or total is None:
                raise ValueError("give fraction= or value= and total=")
            fraction = value / total
        self._frac = min(1.0, max(0.0, fraction))
        pad = 0.06
        self._inner_w = width - 2 * pad
        inner_h = height - 2 * pad
        self.frame = Rectangle(width=width, height=height, color=INK, stroke_width=4)
        self.track = Rectangle(width=self._inner_w, height=inner_h, stroke_width=0,
                               fill_color=INK, fill_opacity=0.08)
        self.track.move_to(self.frame.get_center())
        self.fill = Rectangle(width=max(1e-3, self._inner_w * self._frac), height=inner_h,
                              stroke_width=0, fill_color=color, fill_opacity=0.95)
        self.fill.move_to(self.track.get_left(), LEFT)
        self.label = caption(label, 0.32, weight=BOLD)
        self.label.next_to(self.frame, UP, buff=0.22).align_to(self.frame, LEFT)
        if readout is None:
            readout = (f"{value:,} / {total:,}" if value is not None
                       else f"{self._frac:.0%}")
        self.readout = _mono(readout, 0.26).set_opacity(0.85)
        self.readout.next_to(self.frame, UP, buff=0.22).align_to(self.frame, RIGHT)
        self.add(self.frame, self.track, self.fill, self.label, self.readout)

    def fill_anim(self, fraction):
        """Animation stretching the fill to a new fraction (left edge fixed)."""
        self._frac = min(1.0, max(0.0, fraction))
        return self.fill.animate.stretch_to_fit_width(
            max(1e-3, self._inner_w * self._frac), about_edge=LEFT)

    def reveals(self):
        yield [Create(self.frame), FadeIn(self.label), FadeIn(self.readout)]
        yield [FadeIn(self.track), GrowFromEdge(self.fill, LEFT)]


# --------------------------------------------------------------------------- #
# 8. ChapterCard
# --------------------------------------------------------------------------- #
class ChapterCard(VGroup):
    """Full-frame section transition for long-form: ink band, number, title.

        ch = ChapterCard(3, "The Descent")
        for step in ch.reveals(): self.play(*step)
        self.wait(0.8); self.play(FadeOut(ch))   # BeatScene dissolves it
                                                 # under the next content

    The closing FadeOut is intentionally left to the caller: BeatScene defers
    removal-only plays, so the card melts under the next beat's first reveal
    instead of leaving blank paper.
    """

    def __init__(self, number, title, accent=YELLOW):
        super().__init__()
        self.band = Rectangle(width=config.frame_width + 0.2, height=2.5, color=INK,
                              fill_color=INK, fill_opacity=1, stroke_width=0)
        self.number = Text(f"{int(number):02d}", font="monospace", weight=BOLD,
                           color=accent).scale(2.1)
        self.sep = Line(UP * 0.75, DOWN * 0.75, color=PAPER, stroke_width=3).set_opacity(0.35)
        kicker = Text("CHAPTER", font="monospace", color=PAPER).scale(0.3).set_opacity(0.7)
        ttl = fit_width(Text(title, font="sans-serif", weight=BOLD, color=PAPER).scale(0.85),
                        7.6)
        self.words = VGroup(kicker, ttl).arrange(DOWN, buff=0.18, aligned_edge=LEFT)
        row = VGroup(self.number, self.sep, self.words).arrange(RIGHT, buff=0.55)
        row.move_to(self.band.get_center())
        self.accent_sq = Square(0.5, color=accent, fill_opacity=1, stroke_width=0)
        self.accent_sq.move_to(self.band.get_right() + LEFT * 0.85)
        self.add(self.band, self.number, self.sep, self.words, self.accent_sq)

    def reveals(self):
        yield [GrowFromEdge(self.band, LEFT)]
        yield [FadeIn(self.number, shift=RIGHT * 0.25), FadeIn(self.sep),
               FadeIn(self.accent_sq, scale=0.6)]
        yield [FadeIn(self.words[0]), FadeIn(self.words[1], shift=UP * 0.1)]


# --------------------------------------------------------------------------- #
# 9. Counter
# --------------------------------------------------------------------------- #
class Counter(VGroup):
    """Rolling number in the mono font with a fixed-width, jitter-free layout.

        c = Counter(70_000_000, scale=0.7, color=RED)
        self.play(FadeIn(c))
        self.play(c.count_to(246, geometric=True), run_time=2.5)

    Digits live in fixed slots right-aligned against an invisible spacer, so
    the number never wobbles horizontally as digits and commas change.
    ``geometric=True`` interpolates in log space — right for big descents.
    Punctuation ('.', ',') is seated on the digit baseline, so decimals read
    as "1.71", never "1·71". ``glitch_anim(slot, wrong_char)`` flickers one
    slot to a wrong character and back — the Pentium moment.

    Implementation note: one Text leaf per slot lives for the Counter's whole
    life and is morphed in place with ``become()``. Rebuilding glyphs (remove
    + re-add) mid-animation ghosts under the cairo renderer: the play's
    moving-mobject list is frozen at play start, so orphaned leaves keep
    getting drawn on top of their replacements for the rest of the play.
    """

    def __init__(self, value=0, formatter=None, scale=0.8, color=INK, slots=None):
        super().__init__()
        self._fmt = formatter or (lambda n: f"{round(n):,}")
        self._scale, self._color = scale, color
        self._cache = {}
        ref = Text("0", **MONO_KW).scale(scale)
        self._cw, self._ch = ref.width, ref.height
        self._ghost = Rectangle(width=self._cw, height=self._ch * 1.25,
                                stroke_width=0, fill_opacity=0)
        self._digits = VGroup()  # index 0 = RIGHTMOST slot
        self._slots = 0
        self.add(self._ghost, self._digits)
        self._ensure_slots(slots or len(self._fmt(value)))
        self._value = value
        self._shown = None
        self._layout(value)

    def _proto(self, ch):
        if ch not in self._cache:
            self._cache[ch] = Text(ch, **MONO_KW).scale(self._scale).set_color(self._color)
        return self._cache[ch].copy()

    def _slot_x(self, j):
        return self._ghost.get_right()[0] - (j + 0.5) * self._cw

    def _ensure_slots(self, n):
        if n <= self._slots:
            return
        self._ghost.stretch_to_fit_width(self._cw * n, about_edge=RIGHT)
        cy = self._ghost.get_center()[1]
        for j in range(self._slots, n):
            leaf = self._proto("0").set_opacity(0)
            leaf.move_to([self._slot_x(j), cy, 0])
            self._digits.add(leaf)
        self._slots = n

    def _seat(self, ch, j):
        """Positioned glyph for slot j (``None`` -> invisible placeholder).

        Punctuation ('.', ',') is dropped onto the digit baseline: centring it
        mid-slot renders a decimal point at mid-height, which reads as a
        multiplication dot ("1·71…") the moment a Counter shows a decimal.
        """
        target = self._proto(ch) if ch else self._proto("0").set_opacity(0)
        target.move_to([self._slot_x(j), self._ghost.get_center()[1], 0])
        if ch in (".", ","):
            target.shift(DOWN * (self._ch - target.height) / 2)
        return target

    def _layout(self, v):
        s = self._fmt(v)
        if s == self._shown:
            self._value = v
            return
        for j, leaf in enumerate(self._digits):
            ch = s[len(s) - 1 - j] if j < len(s) else None
            leaf.become(self._seat(ch, j))  # in place — never orphan a leaf mid-play
        self._value, self._shown = v, s

    def set_value(self, v):
        self._ensure_slots(len(self._fmt(v)))
        self._layout(v)
        return self

    def count_to(self, target, geometric=False, **kwargs):
        """Animation rolling from the current value to `target`."""
        start = self._value
        self._ensure_slots(max(len(self._fmt(start)), len(self._fmt(target))))
        if geometric and start > 0 and target > 0:
            la, lb = math.log(start), math.log(target)

            def value_at(a):
                return math.exp(la + (lb - la) * a)
        else:
            def value_at(a):
                return start + (target - start) * a

        def update(m, alpha):
            m._layout(target if alpha >= 1.0 else value_at(alpha))

        return UpdateFromAlphaFunc(self, update, **kwargs)

    def glitch_anim(self, slot_index, wrong_char, color=RED, flickers=3, **kwargs):
        """Animation flickering slot `slot_index` (0 = RIGHTMOST) to `wrong_char`.

        The slot alternates between the wrong glyph (in `color`) and its true
        glyph `flickers` times and always ends restored. The leaf is morphed
        in place with ``become()`` — the same no-orphan rule as ``_layout`` —
        using the Counter's own slot geometry, so callers never need a backing
        rect at recovered coordinates. Don't run it concurrently with
        ``count_to`` on the same Counter: both morph the same leaves.
        """
        if not 0 <= slot_index < self._slots:
            raise ValueError(f"glitch_anim: slot {slot_index} outside 0..{self._slots - 1}")
        s = self._shown if self._shown is not None else self._fmt(self._value)
        true_ch = s[len(s) - 1 - slot_index] if slot_index < len(s) else None
        true_glyph = self._seat(true_ch, slot_index)
        wrong_glyph = self._seat(wrong_char, slot_index).set_color(color)
        leaf = self._digits[slot_index]
        n = 2 * max(1, int(flickers))

        def update(m, alpha):
            wrong = alpha < 1.0 and int(alpha * n) % 2 == 0
            m.become((wrong_glyph if wrong else true_glyph).copy())

        return UpdateFromAlphaFunc(leaf, update, **kwargs)
