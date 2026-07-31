"""Real-mathematics animation modules for Givework explainer videos.

Where modules.py is information design (timelines, cards, meters), these are
mathematics you can watch happen: every module computes its content from real
arithmetic at construction time — a sieve actually runs, a series is actually
summed, Ω(n) is actually factored. Nothing is hand-placed; the math generates
the picture, and a per-module _selfcheck() runs at import and raises loudly if
the arithmetic ever disagrees with known values.

Import order is load-bearing (viz.py's palette guard enforces it in scenes):

    from manim import *          # FIRST — or manim's stock palette wins
    from viz import BeatScene, ...
    from mathviz import SieveGrid, DensityFlow, ...

Shared contract (same as modules.py)
------------------------------------
* ``reveals()`` yields lists of animations, one list per ``play()`` call; the
  caller owns run_time and pacing.
* Detail methods (``highlight_twins``, ``twin_overlay``, ``mask``, ``walk``,
  ``residue_inset`` …) return positioned mobjects for the caller to play;
  ``*_anim`` methods return an Animation.
* No module ever removes mobjects from the scene.
* Set MATHVIZ_SKIP_SELFCHECK=1 to skip the import-time checks (CI smoke only;
  never in production renders).
"""

import math
import os
from fractions import Fraction

from manim import *  # noqa: F401,F403  -- must precede the viz import
from viz import (  # noqa: E402
    BLUE,
    FRAME_W,
    GREEN,
    INK,
    MONO_KW,
    PAPER,
    RED,
    YELLOW,
    caption,
)

__all__ = [
    "SieveGrid",
    "DensityFlow",
    "BrunStack",
    "ParityField",
    "AdmissibleWindow",
    "RandomGraph",
]

#: sieve-prime accent cycle (2 -> BLUE, 3 -> GREEN, 5 -> YELLOW, 7 -> RED, ...)
SIEVE_ACCENTS = [BLUE, GREEN, YELLOW, RED]

#: Hardy–Littlewood twin prime constant C2 and Brun's constant B2 (published).
HL_C2 = 0.6601618158
BRUN_B2 = 1.902160583


def _mono(txt, scale=0.3, color=INK, bold=False):
    kw = dict(MONO_KW)
    if bold:
        kw["weight"] = BOLD
    return Text(txt, **kw).scale(scale).set_color(color)


# --------------------------------------------------------------------------- #
# number theory (pure python; every module's picture is computed from these)
# --------------------------------------------------------------------------- #
def _prime_mask(n):
    """Boolean sieve of Eratosthenes, index 0..n."""
    s = [True] * (n + 1)
    s[0] = False
    if n >= 1:
        s[1] = False
    for i in range(2, int(n**0.5) + 1):
        if s[i]:
            s[i * i :: i] = [False] * len(s[i * i :: i])
    return s


def _primes_upto(n):
    m = _prime_mask(n)
    return [i for i in range(n + 1) if m[i]]


def _spf_sieve(n):
    """Smallest prime factor for 0..n (0 for 0 and 1)."""
    spf = [0] * (n + 1)
    for i in range(2, n + 1):
        if spf[i] == 0:
            for j in range(i, n + 1, i):
                if spf[j] == 0:
                    spf[j] = i
    return spf


def _omega_sieve(n):
    """Ω(k) — number of prime factors with multiplicity — for 0..n."""
    spf = _spf_sieve(n)
    om = [0] * (n + 1)
    for k in range(2, n + 1):
        om[k] = om[k // spf[k]] + 1
    return om


def _omega_trial(k):
    """Ω(k) by plain trial division — the independent cross-check."""
    c, d = 0, 2
    while d * d <= k:
        while k % d == 0:
            k //= d
            c += 1
        d += 1
    return c + (1 if k > 1 else 0)


def _twin_starts(n):
    """Primes p <= n with p+2 also prime (p+2 may exceed n)."""
    m = _prime_mask(n + 2)
    return [p for p in range(2, n + 1) if m[p] and m[p + 2]]


def _is_admissible(offsets):
    """True iff for every prime p <= len(offsets) some residue mod p is free.

    (For p > k a k-tuple can never cover all p residues, so only p <= k needs
    checking.)
    """
    for p in _primes_upto(len(offsets)):
        if len({o % p for o in offsets}) == p:
            return False
    return True


def _find_admissible_tuple(k, diameter, search_to=60_000):
    """Find an admissible k-tuple with diameter <= `diameter`, by real sieving.

    Scans windows [s, s+diameter] for integers free of the primes 2..13
    (a Schinzel-style sieve); a window rich enough to hold k survivors gives
    the tuple, which is then *verified* admissible for every prime <= k.
    For k=50, diameter=246 this finds one in the window starting at 37 —
    matching the Polymath 8b record H(50) = 246.
    """
    small = [2, 3, 5, 7, 11, 13]
    for s in range(1, search_to):
        surv = [x for x in range(s, s + diameter + 1) if all(x % p for p in small)]
        if len(surv) >= k:
            offs = [x - surv[0] for x in surv[:k]]
            if offs[-1] <= diameter and _is_admissible(offs):
                return offs
    raise ValueError(f"no admissible {k}-tuple of diameter <= {diameter} "
                     f"found below {search_to}")


# --------------------------------------------------------------------------- #
# 1. SieveGrid — the sieve of Eratosthenes, running live
# --------------------------------------------------------------------------- #
class SieveGrid(VGroup):
    """Integer grid on which the sieve actually runs, wave by wave.

        sg = SieveGrid(120, cols=10).move_to(DOWN * 0.2)
        for step in sg.reveals(): self.play(*step)   # grid, waves, emergence
        rings = sg.highlight_twins()
        self.play(*[Create(r) for r in rings])

    Construction computes the smallest-prime-factor sieve for 2..n; reveals()
    yields the grid, then for each sieve prime p (p <= sqrt(n)) an announce
    step and a left-to-right strike wave over the composites p first reaches,
    then one final step where every survivor turns into an ink chip — the
    primes emerging. ``highlight_twins()`` returns rings around each twin
    pair (one ring when the pair is adjacent in the grid). The sieve is
    self-checked against the known list of primes below 120.
    """

    def __init__(self, n=120, cols=10, width=11.0, height=5.2):
        super().__init__()
        self.n, self.cols = n, cols
        spf = _spf_sieve(n)
        self.primes = [k for k in range(2, n + 1) if spf[k] == k]
        self.sieve_primes = [p for p in self.primes if p * p <= n]
        self.twins = [(p, p + 2) for p in self.primes if p + 2 <= n and spf[p + 2] == p + 2]
        self._spf = spf

        rows = math.ceil((n - 1) / cols)
        cw, ch = width / cols, height / rows
        self._cells = {}
        self.grid = VGroup()
        for k in range(2, n + 1):
            i, j = divmod(k - 2, cols)
            bg = Rectangle(width=cw * 0.94, height=ch * 0.9, stroke_color=INK,
                           stroke_width=1, stroke_opacity=0.18,
                           fill_color=PAPER, fill_opacity=0)
            num = _mono(str(k), min(0.30, ch * 0.52))
            cell = VGroup(bg, num)
            cell.bg, cell.num = bg, num
            cell.move_to([(-width / 2) + (j + 0.5) * cw, (height / 2) - (i + 0.5) * ch, 0])
            self._cells[k] = cell
            self.grid.add(cell)
        self.add(self.grid)

    def cell(self, k):
        return self._cells[k]

    def _accent(self, p):
        return SIEVE_ACCENTS[self.sieve_primes.index(p) % len(SIEVE_ACCENTS)]

    def reveals(self):
        yield [LaggedStart(*[FadeIn(c, scale=0.9) for c in self.grid],
                           lag_ratio=0.006)]
        for p in self.sieve_primes:
            c = self._accent(p)
            pc = self._cells[p]
            # announce the prime: its cell becomes a solid chip in its color
            yield [pc.bg.animate.set_fill(c, opacity=1).set_stroke(opacity=0),
                   pc.num.animate.set_color(PAPER)]
            # the wave: strike every composite p reaches first (spf == p)
            struck = [m for m in range(p * p, self.n + 1, p) if self._spf[m] == p]
            wave = [
                AnimationGroup(
                    self._cells[m].bg.animate.set_fill(c, opacity=0.30),
                    self._cells[m].num.animate.set_opacity(0.35),
                )
                for m in struck
            ]
            yield [LaggedStart(*wave, lag_ratio=0.04)]
        # survivors emerge: every prime becomes an ink chip with a paper numeral
        emerge = [
            AnimationGroup(
                self._cells[q].bg.animate.set_fill(INK, opacity=1).set_stroke(opacity=0),
                self._cells[q].num.animate.set_color(PAPER).set_opacity(1),
            )
            for q in self.primes
        ]
        yield [LaggedStart(*emerge, lag_ratio=0.02)]

    def highlight_twins(self):
        """Rings (RED) around each twin pair; returns a VGroup of rings."""
        rings = VGroup()
        for p, q in self.twins:
            same_row = (p - 2) // self.cols == (q - 2) // self.cols
            if same_row and (q - 2) % self.cols == (p - 2) % self.cols + 2:
                rings.add(SurroundingRectangle(
                    VGroup(self._cells[p], self._cells[q]),
                    color=RED, stroke_width=3.5, buff=0.045, corner_radius=0.08))
            else:
                for x in (p, q):
                    rings.add(SurroundingRectangle(
                        self._cells[x], color=RED, stroke_width=3.5,
                        buff=0.045, corner_radius=0.08))
        return rings


def _selfcheck_sievegrid():
    known = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61,
             67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113]
    got = _primes_upto(120)
    if got != known:
        raise AssertionError(f"SieveGrid selfcheck: primes<=120 wrong: {got}")
    spf = _spf_sieve(120)
    twins = [(p, p + 2) for p in got if p + 2 <= 120 and spf[p + 2] == p + 2]
    known_twins = [(3, 5), (5, 7), (11, 13), (17, 19), (29, 31), (41, 43),
                   (59, 61), (71, 73), (101, 103), (107, 109)]
    if twins != known_twins:
        raise AssertionError(f"SieveGrid selfcheck: twins<=120 wrong: {twins}")


# --------------------------------------------------------------------------- #
# 2. DensityFlow — prediction meeting reality on the number line
# --------------------------------------------------------------------------- #
class DensityFlow(VGroup):
    """Primes as ticks; their running density drawing itself; 1/ln x joining it.

        df = DensityFlow(500).move_to(DOWN * 0.2)
        for step in df.reveals(): self.play(*step)
        tw = df.twin_overlay()
        for step in df.twin_reveals(): self.play(*step)

    Everything is computed: the ticks are the actual primes <= up_to, the BLUE
    curve is π(x)/x evaluated from the sieve, the dashed RED curve is 1/ln x.
    ``twin_overlay()`` adds the same pair for twin primes: GREEN data curve
    (twin starts per x) against the dashed Hardy–Littlewood prediction
    2·C2/ln²x with C2 = 0.66016… . Self-checked against π(100)=25,
    π(500)=95, and the eight twin starts below 100.
    """

    def __init__(self, up_to=500, width=11.0, height=4.4, y_max=0.55):
        super().__init__()
        self.up_to = up_to
        self._w, self._h, self._ymax = width, height, y_max
        self.primes = _primes_upto(up_to)
        self.twin_starts = _twin_starts(up_to)

        # frame: baseline + y axis + sparse labels
        self.baseline = Line([-width / 2, -height / 2, 0], [width / 2, -height / 2, 0],
                             color=INK, stroke_width=3)
        self.yaxis = Line([-width / 2, -height / 2, 0], [-width / 2, height / 2, 0],
                          color=INK, stroke_width=3)
        labels = VGroup()
        for xv in range(100, up_to + 1, 100):
            t = _mono(str(xv), 0.24).set_opacity(0.7)
            t.move_to(self._pt(xv, 0) + DOWN * 0.32)
            labels.add(t)
        for yv in (0.2, 0.4):
            t = _mono(f"{yv:.1f}", 0.22).set_opacity(0.7)
            t.move_to(self._pt(2, yv) + LEFT * 0.38)
            tick = Line(ORIGIN, RIGHT * 0.12, color=INK, stroke_width=2.5)
            tick.move_to(self._pt(2, yv), LEFT)
            labels.add(t, tick)
        self.frame_labels = labels

        # the primes, as physical ticks on the line
        self.ticks = VGroup(*[
            Line(self._pt(p, 0), self._pt(p, 0) + UP * 0.16, color=INK,
                 stroke_width=1.6).set_opacity(0.55)
            for p in self.primes
        ])

        # reality: running density π(x)/x, drawn from the data
        self.density = self._curve(lambda x: self._pi(x) / x, BLUE, 4)
        # color-coded legend pair in the open air above the curves' right half
        self.density_label = _mono("π(x)/x — actual density", 0.26, BLUE, bold=True)
        self.density_label.move_to(self._pt(up_to * 0.7, 0.29))

        # prediction: 1/ln x
        self.prediction = DashedVMobject(self._curve(lambda x: 1 / math.log(x), RED, 3.5),
                                         num_dashes=90)
        self.prediction_label = _mono("1/ln x — the prediction", 0.26, RED, bold=True)
        self.prediction_label.next_to(self.density_label, DOWN, buff=0.14)

        self.add(self.baseline, self.yaxis, self.frame_labels, self.ticks,
                 self.density, self.density_label, self.prediction, self.prediction_label)
        self._twin = None

    # ---- coordinates & data ----
    def _pt(self, x, y):
        fx = (x - 2) / (self.up_to - 2)
        fy = min(1.0, y / self._ymax)
        return np.array([-self._w / 2 + fx * self._w,
                         -self._h / 2 + fy * self._h, 0.0])

    def _pi(self, x):
        import bisect
        return bisect.bisect_right(self.primes, x)

    def _pi2(self, x):
        import bisect
        return bisect.bisect_right(self.twin_starts, x)

    def _curve(self, f, color, sw, x_from=8):
        xs = [x_from + i * (self.up_to - x_from) / 220 for i in range(221)]
        pts = [self._pt(x, f(x)) for x in xs]
        return VMobject(color=color, stroke_width=sw).set_points_as_corners(pts)

    # ---- reveals ----
    def reveals(self):
        yield [Create(self.baseline), Create(self.yaxis), FadeIn(self.frame_labels)]
        yield [LaggedStart(*[Create(t) for t in self.ticks], lag_ratio=0.012)]
        yield [Create(self.density), FadeIn(self.density_label, shift=UP * 0.1)]
        yield [Create(self.prediction), FadeIn(self.prediction_label, shift=UP * 0.1)]

    def twin_overlay(self):
        """Build the twin mode: RED-ringed twin ticks, GREEN data curve, and
        the dashed Hardy–Littlewood 2·C2/ln²x prediction. Returns the Group;
        play it via twin_reveals().

        The overlay is built in the module's local frame, then shifted onto
        the module's CURRENT position — safe to call before or after move_to /
        to_edge / shift. The overlay is NOT added to the flow group, so tear
        it down (and any later shifts) alongside the flow yourself. Scaling
        the flow before calling this is not supported and raises."""
        ticks = VGroup(*[
            Line(self._pt(p, 0), self._pt(p, 0) + UP * 0.26, color=GREEN,
                 stroke_width=2.6)
            for p in self.twin_starts
        ])
        data = self._curve(lambda x: self._pi2(x) / x, GREEN, 4, x_from=25)
        # same legend treatment as the prime pair: data line, prediction under it
        dlabel = _mono("twins/x — actual", 0.26, GREEN, bold=True)
        dlabel.move_to(self._pt(self.up_to * 0.5, 0.145))
        hl = DashedVMobject(
            self._curve(lambda x: 2 * HL_C2 / math.log(x) ** 2, YELLOW, 5, x_from=25),
            num_dashes=80)
        hlabel = _mono("2·C₂/ln²x · C₂ = 0.66016… (Hardy–Littlewood)", 0.24, INK, bold=True)
        hlabel.next_to(dlabel, DOWN, buff=0.14)
        self._twin = VGroup(ticks, data, dlabel, hl, hlabel)
        self._twin.ticks, self._twin.data = ticks, data
        # Everything above was built via _pt() in construction-time (local)
        # coordinates. Re-seat onto wherever the module sits NOW: the baseline
        # started at local (-w/2, -h/2), so its current start gives the offset.
        if abs(self.baseline.get_length() - self._w) > 1e-3:
            raise AssertionError(
                "twin_overlay: DensityFlow was scaled after construction; "
                "build overlays before scaling the flow"
            )
        self._twin.shift(
            self.baseline.get_start() - np.array([-self._w / 2, -self._h / 2, 0.0])
        )
        return self._twin

    def twin_reveals(self):
        if self._twin is None:
            self.twin_overlay()
        t = self._twin
        yield [LaggedStart(*[Create(x) for x in t[0]], lag_ratio=0.03)]
        yield [Create(t[1]), FadeIn(t[2], shift=UP * 0.1)]
        yield [Create(t[3]), FadeIn(t[4], shift=UP * 0.1)]


def _selfcheck_densityflow():
    pr = _primes_upto(1000)
    if len([p for p in pr if p <= 100]) != 25 or len([p for p in pr if p <= 500]) != 95:
        raise AssertionError("DensityFlow selfcheck: π(100) or π(500) wrong")
    if len(pr) != 168:
        raise AssertionError("DensityFlow selfcheck: π(1000) != 168")
    tw = _twin_starts(100)
    if tw != [3, 5, 11, 17, 29, 41, 59, 71]:
        raise AssertionError(f"DensityFlow selfcheck: twin starts <=100 wrong: {tw}")


# --------------------------------------------------------------------------- #
# 3. BrunStack — convergence vs divergence, as physical height
# --------------------------------------------------------------------------- #
class BrunStack(VGroup):
    """Two reciprocal sums stacking as bars: all primes vs twin primes.

        bs = BrunStack(1000).move_to(DOWN * 0.2)
        for step in bs.reveals(): self.play(*step)

    Left stack: one bar of height 1/p per prime p <= up_to — it grinds past
    the drawn horizontal lines (Euler: Σ1/p diverges). Right stack: one bar
    per twin pair of height 1/p + 1/(p+2) — it visibly flattens under the
    dashed ceiling B₂ ≈ 1.902160 (Brun, 1919). Every bar height is the
    actual term; the first five twin terms are verified exactly with
    Fractions and the totals against Mertens' theorem.
    """

    def __init__(self, up_to=1000, width=11.0, height=5.2):
        super().__init__()
        self.up_to = up_to
        primes = _primes_upto(up_to)
        twins = [(p, p + 2) for p in _twin_starts(up_to)]
        self.prime_total = sum(1 / p for p in primes)
        self.twin_total = sum(1 / p + 1 / q for p, q in twins)

        top_val = 2.4  # value axis: 0 .. 2.4, so both stacks and B2 fit
        self._vh = height / top_val
        y0 = -height / 2
        bar_w = 1.7
        lx, rx = -2.9, 2.9

        self.baseline = Line([-width / 2, y0, 0], [width / 2, y0, 0],
                             color=INK, stroke_width=3)
        self.gridlines = VGroup()
        for v in (0.5, 1.0, 1.5, 2.0):
            gl = DashedLine([-width / 2, y0 + v * self._vh, 0],
                            [width / 2, y0 + v * self._vh, 0],
                            color=INK, stroke_width=2, dash_length=0.12).set_opacity(0.3)
            lbl = _mono(f"{v:.1f}", 0.22).set_opacity(0.6)
            lbl.next_to(gl, LEFT, buff=0.12)
            self.gridlines.add(VGroup(gl, lbl))

        def stack(x, terms, color):
            bars, y = VGroup(), y0
            for i, t in enumerate(terms):
                h = t * self._vh
                r = Rectangle(width=bar_w, height=max(h, 1e-4), stroke_width=0,
                              fill_color=color, fill_opacity=0.9 if i % 2 == 0 else 0.6)
                r.move_to([x, y + h / 2, 0])
                bars.add(r)
                y += h
            return bars

        self.prime_bars = stack(lx, [1 / p for p in primes], BLUE)
        self.twin_bars = stack(rx, [1 / p + 1 / q for p, q in twins], RED)

        self.prime_head = VGroup(
            caption("all primes", 0.34, weight=BOLD),
            _mono("1/2 + 1/3 + 1/5 + 1/7 + …", 0.24).set_opacity(0.8),
        ).arrange(DOWN, buff=0.08).next_to([lx, y0, 0], DOWN, buff=0.3)
        self.twin_head = VGroup(
            caption("twin primes", 0.34, weight=BOLD),
            _mono("1/3 + 1/5 + 1/5 + 1/7 + 1/11 + …", 0.24).set_opacity(0.8),
        ).arrange(DOWN, buff=0.08).next_to([rx, y0, 0], DOWN, buff=0.3)

        self.prime_total_lbl = _mono(f"{self.prime_total:.3f} — and still climbing",
                                     0.26, BLUE, bold=True)
        self.prime_total_lbl.next_to(self.prime_bars, UP, buff=0.16)
        self.twin_total_lbl = _mono(f"{self.twin_total:.3f} — nearly done",
                                    0.26, RED, bold=True)
        self.twin_total_lbl.next_to(self.twin_bars, UP, buff=0.16)

        by = y0 + BRUN_B2 * self._vh
        self.brun_line = DashedLine([rx - 2.6, by, 0], [width / 2, by, 0],
                                    color=GREEN, stroke_width=4, dash_length=0.14)
        self.brun_lbl = _mono("B₂ ≈ 1.902160 — Brun, 1919: the twin sum CONVERGES",
                              0.24, GREEN, bold=True)
        self.brun_lbl.next_to(self.brun_line, UP, buff=0.24).align_to(self.brun_line, RIGHT)

        self.diverge_lbl = _mono("passes every line ever drawn (Euler, 1737)",
                                 0.24, BLUE, bold=True)
        self.diverge_lbl.next_to(self.prime_bars, UP, buff=0.55)

        self.add(self.baseline, self.gridlines, self.prime_bars, self.twin_bars,
                 self.prime_head, self.twin_head, self.prime_total_lbl,
                 self.twin_total_lbl, self.brun_line, self.brun_lbl, self.diverge_lbl)

    def reveals(self):
        yield [Create(self.baseline), FadeIn(self.gridlines),
               FadeIn(self.prime_head), FadeIn(self.twin_head)]
        yield [LaggedStart(*[GrowFromEdge(b, DOWN) for b in self.prime_bars],
                           lag_ratio=0.012)]
        yield [FadeIn(self.prime_total_lbl, shift=UP * 0.1),
               FadeIn(self.diverge_lbl, shift=UP * 0.1)]
        yield [LaggedStart(*[GrowFromEdge(b, DOWN) for b in self.twin_bars],
                           lag_ratio=0.03)]
        yield [FadeIn(self.twin_total_lbl, shift=UP * 0.1)]
        yield [Create(self.brun_line), FadeIn(self.brun_lbl, shift=UP * 0.1)]


def _selfcheck_brunstack():
    # first five twin pairs, summed exactly
    exact = sum((Fraction(1, p) + Fraction(1, p + 2)
                 for p in [3, 5, 11, 17, 29]), Fraction(0))
    approx = sum(1 / p + 1 / (p + 2) for p in [3, 5, 11, 17, 29])
    if abs(float(exact) - approx) > 1e-12:
        raise AssertionError("BrunStack selfcheck: float vs Fraction mismatch")
    # 8/15 + 12/35 + 24/143 + 36/323 + 60/899, computed by hand
    if abs(float(exact) - 1.2222185755185958) > 1e-9:
        raise AssertionError(f"BrunStack selfcheck: first-5-pair sum {float(exact)}")
    # totals to 1000 against Mertens' theorem / hand-summed bracket
    pt = sum(1 / p for p in _primes_upto(1000))
    mertens = math.log(math.log(1000)) + 0.2614972128
    if abs(pt - mertens) > 0.05:
        raise AssertionError(f"BrunStack selfcheck: Σ1/p(<=1000)={pt} vs Mertens {mertens}")
    tt = sum(1 / p + 1 / (p + 2) for p in _twin_starts(1000))
    if not (1.44 < tt < 1.56 < BRUN_B2):
        raise AssertionError(f"BrunStack selfcheck: twin partial {tt} out of range")


# --------------------------------------------------------------------------- #
# 4. ParityField — the parity of Ω(n), too finely interleaved to sieve apart
# --------------------------------------------------------------------------- #
class ParityField(VGroup):
    """Integers 1..n as squares colored by the parity of Ω(n), computed live.

        pf = ParityField(360, cols=36).move_to(UP * 0.6)
        self.play(*pf.reveal())
        frames, tally = pf.mask(4, 1)     # any arithmetic-progression mask
        self.play(Create(frames)); self.play(FadeIn(tally))
        w = pf.walk()                      # the Liouville random-ish walk
        w.next_to(pf, DOWN, buff=0.5); self.play(Create(w))

    BLUE = even Ω (a "product of an even number of prime bricks"), RED = odd.
    ``mask(mod, residue)`` outlines the cells in one residue class and returns
    a computed tally — always close to 50/50, which is the parity obstruction:
    no sieve-shaped mask separates the colors. ``walk()`` returns the running
    sum of λ(n)=(-1)^Ω(n), drawn from the data, hugging zero. Ω is
    cross-checked against independent trial division for every n.
    """

    def __init__(self, n=360, cols=36, width=11.0):
        super().__init__()
        self.n, self.cols = n, cols
        self.omega = _omega_sieve(n)
        self.lam = [0] + [(-1) ** self.omega[k] for k in range(1, n + 1)]
        rows = math.ceil(n / cols)
        s = width / cols
        self._cells = {}
        self.field = VGroup()
        for k in range(1, n + 1):
            i, j = divmod(k - 1, cols)
            c = BLUE if self.omega[k] % 2 == 0 else RED
            sq = Square(side_length=s * 0.86, stroke_width=0,
                        fill_color=c, fill_opacity=0.9)
            sq.move_to([(-width / 2) + (j + 0.5) * s, (rows * s / 2) - (i + 0.5) * s, 0])
            self._cells[k] = sq
            self.field.add(sq)
        self.add(self.field)
        self._s, self._rows, self._w = s, rows, width

    def reveal(self):
        return [LaggedStart(*[FadeIn(c, scale=0.6) for c in self.field],
                            lag_ratio=0.004)]

    def reveals(self):
        yield self.reveal()

    def legend(self):
        def chip(color, txt):
            return VGroup(Square(0.22, stroke_width=0, fill_color=color, fill_opacity=0.9),
                          _mono(txt, 0.26)).arrange(RIGHT, buff=0.14)
        g = VGroup(chip(BLUE, "Ω(n) even"), chip(RED, "Ω(n) odd")).arrange(RIGHT, buff=0.7)
        return g

    def sample_row(self, upto=10):
        """Magnified 1..upto with n, its factorization, and Ω — the rule that
        generates the colors, shown before the field itself."""
        def factor_str(k):
            if k == 1:
                return "1"
            out, spf = [], _spf_sieve(k)
            while k > 1:
                out.append(str(spf[k]))
                k //= spf[k]
            return "·".join(out)
        row = VGroup()
        for k in range(1, upto + 1):
            c = BLUE if self.omega[k] % 2 == 0 else RED
            card = VGroup(
                _mono(str(k), 0.34, bold=True),
                _mono(factor_str(k), 0.2).set_opacity(0.75),
                Square(0.2, stroke_width=0, fill_color=c, fill_opacity=0.9),
            ).arrange(DOWN, buff=0.1)
            row.add(card)
        row.arrange(RIGHT, buff=0.42, aligned_edge=UP)
        return row

    def mask(self, mod, residue, color=YELLOW):
        """Outline the cells ≡ residue (mod `mod`) and tally colors inside.

        Returns (frames, tally): frames go around masked cells; the tally is
        a computed even/odd count — the two bars come out nearly equal for
        every arithmetic progression, which is the point.
        """
        ks = [k for k in range(1, self.n + 1) if k % mod == residue]
        frames = VGroup(*[
            SurroundingRectangle(self._cells[k], color=color, stroke_width=2.6,
                                 buff=0.02)
            for k in ks
        ])
        even = sum(1 for k in ks if self.omega[k] % 2 == 0)
        odd = len(ks) - even
        unit = 2.6 / max(even, odd, 1)
        rows = VGroup()
        for cnt, col, txt in ((even, BLUE, "even"), (odd, RED, "odd")):
            bar = Rectangle(width=max(unit * cnt, 1e-3), height=0.3, stroke_width=0,
                            fill_color=col, fill_opacity=0.9)
            lbl = _mono(f"{txt} · {cnt}", 0.24, col, bold=True)
            rows.add(VGroup(bar, lbl).arrange(RIGHT, buff=0.18, aligned_edge=DOWN))
        rows.arrange(DOWN, buff=0.16, aligned_edge=LEFT)
        head = _mono(f"inside the mask n ≡ {residue} (mod {mod}):", 0.24).set_opacity(0.8)
        tally = VGroup(head, rows).arrange(DOWN, buff=0.16, aligned_edge=LEFT)
        return frames, tally

    def walk(self, width=None, height=1.7):
        """The running sum L(m) = λ(1)+…+λ(m), as a drawn walk hugging zero."""
        width = width or self._w
        L, run = [], 0
        for k in range(1, self.n + 1):
            run += self.lam[k]
            L.append(run)
        amp = max(2, max(abs(v) for v in L))
        pts = [np.array([-width / 2 + (k / self.n) * width,
                         (L[k - 1] / amp) * (height / 2), 0.0])
               for k in range(1, self.n + 1)]
        zero = Line([-width / 2, 0, 0], [width / 2, 0, 0], color=INK,
                    stroke_width=2).set_opacity(0.35)
        curve = VMobject(color=GREEN, stroke_width=3.5).set_points_as_corners(
            [np.array([-width / 2, 0, 0])] + pts)
        lbl = _mono("L(n) = Σ λ(k) — the two colors cancel almost exactly",
                    0.22, GREEN, bold=True)
        lbl.next_to(zero, UP, buff=0.3).align_to(zero, LEFT).shift(RIGHT * 0.15)
        g = VGroup(zero, curve, lbl)
        g.zero, g.curve, g.lbl = zero, curve, lbl
        return g


def _selfcheck_parityfield():
    om = _omega_sieve(900)
    for k in range(1, 901):
        if om[k] != _omega_trial(k):
            raise AssertionError(f"ParityField selfcheck: Ω({k}) sieve {om[k]} != trial")
    spot = {1: 0, 2: 1, 4: 2, 12: 3, 16: 4, 27: 3, 30: 3, 60: 4, 64: 6, 97: 1, 100: 4}
    for k, v in spot.items():
        if om[k] != v:
            raise AssertionError(f"ParityField selfcheck: Ω({k}) = {om[k]}, want {v}")
    lam = [(-1) ** om[k] for k in range(1, 901)]
    even = sum(1 for v in lam if v == 1)
    if not (0.45 < even / 900 < 0.55):
        raise AssertionError("ParityField selfcheck: parity split not near 50/50")
    L, run, worst = [], 0, 0
    for v in lam:
        run += v
        worst = max(worst, abs(run))
    if worst > 3 * math.sqrt(900):
        raise AssertionError(f"ParityField selfcheck: |L(n)| reached {worst}")


# --------------------------------------------------------------------------- #
# 5. AdmissibleWindow — the k-tuple comb and why mod small primes decides
# --------------------------------------------------------------------------- #
class AdmissibleWindow(VGroup):
    """An admissible 50-tooth comb of diameter 246, sliding along the line.

        aw = AdmissibleWindow().move_to(UP * 1.2)
        for step in aw.reveals(): self.play(*step)
        self.play(aw.slide_anim(40), run_time=2)
        inset = aw.residue_inset(3)
        inset.to_edge(DOWN, buff=0.6); self.play(FadeIn(inset))

    The tuple is FOUND, not typed: a Schinzel sieve scans windows of width
    246 for 50 integers clear of the primes 2..13, then verifies genuine
    admissibility for every prime <= 50 (it lands in the window starting at
    37, matching Polymath 8b's record H(50) = 246). ``slide_anim`` slides the
    comb; ``residue_inset(p)`` builds the small-prime story: a comb covering
    every residue class mod p is killed — one that leaves a class free may
    ride forever. Both example combs are checked mod p at build time.
    """

    def __init__(self, k=50, diameter=246, offsets=None, width=11.5):
        super().__init__()
        self.offsets = offsets or _find_admissible_tuple(k, diameter)
        if len(self.offsets) != k or not _is_admissible(self.offsets):
            raise AssertionError("AdmissibleWindow: tuple failed admissibility")
        self.k, self.diameter = k, self.offsets[-1] - self.offsets[0]
        span = diameter * 1.5  # slide room either side
        self._u = width / span
        self._x0 = -width / 2 + (span - diameter) / 2 * self._u

        self.line = Line([-width / 2, 0, 0], [width / 2, 0, 0], color=INK, stroke_width=3)
        marks = VGroup()
        for m in range(0, int(span) + 1, 50):
            x = -width / 2 + m * self._u
            marks.add(Line([x, -0.07, 0], [x, 0.07, 0], color=INK,
                           stroke_width=2).set_opacity(0.5))
        self.marks = marks

        tooth_h = 0.42
        spine_y = 0.14 + tooth_h
        teeth = VGroup(*[
            Line([self._ox(o), 0.14, 0], [self._ox(o), spine_y, 0],
                 color=BLUE, stroke_width=2.6)
            for o in self.offsets
        ])
        spine = Line([self._ox(self.offsets[0]), spine_y, 0],
                     [self._ox(self.offsets[-1]), spine_y, 0],
                     color=BLUE, stroke_width=4)
        self.comb = VGroup(spine, teeth)
        self.comb.spine, self.comb.teeth = spine, teeth

        by = -0.42
        b_l, b_r = self._ox(self.offsets[0]), self._ox(self.offsets[-1])
        self.brace = VGroup(
            Line([b_l, by, 0], [b_r, by, 0], color=INK, stroke_width=2.5),
            Line([b_l, by - 0.09, 0], [b_l, by + 0.09, 0], color=INK, stroke_width=2.5),
            Line([b_r, by - 0.09, 0], [b_r, by + 0.09, 0], color=INK, stroke_width=2.5),
        )
        self.brace_lbl = VGroup(
            _mono(f"diameter {self.diameter}", 0.3, INK, bold=True),
            _mono(f"k = {self.k} teeth · admissible (checked mod every prime ≤ {self.k})",
                  0.24).set_opacity(0.8),
        ).arrange(DOWN, buff=0.1).next_to(self.brace, DOWN, buff=0.18)

        # the brace and its labels measure the comb, so they slide with it
        self._rig = VGroup(self.comb, self.brace, self.brace_lbl)
        self.add(self.line, self.marks, self._rig)

    def _ox(self, o):
        return self._x0 + o * self._u

    def reveals(self):
        yield [Create(self.line), FadeIn(self.marks)]
        yield [Create(self.comb.spine),
               LaggedStart(*[Create(t) for t in self.comb.teeth], lag_ratio=0.02)]
        yield [Create(self.brace), FadeIn(self.brace_lbl, shift=UP * 0.1)]

    def slide_anim(self, d_ints):
        """Animation sliding the comb (and its measure) along the line."""
        return self._rig.animate.shift(RIGHT * d_ints * self._u)

    def residue_inset(self, p=3, killed=(0, 2, 4), ok=(0, 2, 6), width=10.6):
        """Why mod-p decides: stripes are residue classes mod p; the comb that
        hits all of them is killed, the one leaving a class free survives.
        Residue sets are computed and the claims verified at build time."""
        killed_res = sorted({o % p for o in killed})
        ok_res = sorted({o % p for o in ok})
        if len(killed_res) != p:
            raise AssertionError(f"residue_inset: {killed} does not cover all "
                                 f"residues mod {p}")
        if len(ok_res) >= p:
            raise AssertionError(f"residue_inset: {ok} is not admissible mod {p}")
        free = [r for r in range(p) if r not in ok_res]

        n_show = 15
        u = width / n_show
        shades = [0.16, 0.07, 0.24, 0.11, 0.19]

        def strip(offs, comb_color, verdict, verdict_color):
            cells = VGroup()
            for m in range(n_show):
                cell = Rectangle(width=u * 0.96, height=0.5, stroke_width=0,
                                 fill_color=INK, fill_opacity=shades[m % p % len(shades)])
                cell.move_to([-width / 2 + (m + 0.5) * u, 0, 0])
                num = _mono(str(m % p), 0.2).set_opacity(0.55).move_to(cell)
                cells.add(VGroup(cell, num))
            teeth = VGroup(*[
                Line([-width / 2 + (o + 0.5) * u, 0.32, 0],
                     [-width / 2 + (o + 0.5) * u, 0.66, 0],
                     color=comb_color, stroke_width=4)
                for o in offs
            ])
            spine = Line(teeth[0].get_end(), teeth[-1].get_end(),
                         color=comb_color, stroke_width=4)
            lbl = VGroup(
                _mono("comb " + "·".join(str(o) for o in offs), 0.26, comb_color, bold=True),
                _mono(verdict, 0.24, verdict_color, bold=True),
            ).arrange(RIGHT, buff=0.4)
            lbl.next_to(cells, DOWN, buff=0.14).align_to(cells, LEFT)
            return VGroup(cells, teeth, spine, lbl)

        top = strip(killed, RED,
                    f"hits residues {{{','.join(map(str, killed_res))}}} mod {p} "
                    f"— every slot: one tooth is ALWAYS divisible by {p}. killed.",
                    RED)
        bottom = strip(ok, GREEN,
                       f"hits {{{','.join(map(str, ok_res))}}} — class "
                       f"{free[0]} stays free: can ride forever. admissible.",
                       GREEN)
        head = _mono(f"the integers, striped by n mod {p}", 0.26).set_opacity(0.8)
        g = VGroup(head, top, bottom).arrange(DOWN, buff=0.42, aligned_edge=LEFT)
        g.head, g.killed_strip, g.ok_strip = head, top, bottom
        return g


def _selfcheck_admissiblewindow():
    offs = _find_admissible_tuple(50, 246)
    if len(offs) != 50 or offs[0] != 0 or offs[-1] - offs[0] > 246:
        raise AssertionError(f"AdmissibleWindow selfcheck: bad tuple {offs}")
    if not _is_admissible(offs):
        raise AssertionError("AdmissibleWindow selfcheck: tuple not admissible")
    if _is_admissible([0, 2, 4]):
        raise AssertionError("AdmissibleWindow selfcheck: (0,2,4) must be inadmissible")
    if not _is_admissible([0, 2, 6]):
        raise AssertionError("AdmissibleWindow selfcheck: (0,2,6) must be admissible")
    # the record itself: Polymath 8b, H(50) = 246
    if offs[-1] != 246:
        raise AssertionError(f"AdmissibleWindow selfcheck: expected diameter 246, "
                             f"got {offs[-1]}")


# --------------------------------------------------------------------------- #
# 6. RandomGraph — G(n, c/n), its giant component, and geodesic triangles
# --------------------------------------------------------------------------- #
def _gnp_edges(n, c, rng):
    """Sample the edge set of G(n, c/n): every pair kept with prob c/n."""
    p = c / n
    return [(i, j) for i in range(n) for j in range(i + 1, n) if rng.random() < p]


def _adjacency(n, edges):
    adj = [[] for _ in range(n)]
    for u, v in edges:
        adj[u].append(v)
        adj[v].append(u)
    return adj


def _components(n, adj):
    """Connected components by BFS, largest first."""
    seen, comps = [False] * n, []
    for s in range(n):
        if seen[s]:
            continue
        comp, queue = [s], [s]
        seen[s] = True
        while queue:
            u = queue.pop()
            for w in adj[u]:
                if not seen[w]:
                    seen[w] = True
                    comp.append(w)
                    queue.append(w)
        comps.append(comp)
    return sorted(comps, key=len, reverse=True)


def _bfs_dist(adj, src):
    """Distances from src (dict, only reached vertices)."""
    dist, frontier = {src: 0}, [src]
    while frontier:
        nxt = []
        for u in frontier:
            for w in adj[u]:
                if w not in dist:
                    dist[w] = dist[u] + 1
                    nxt.append(w)
        frontier = nxt
    return dist


def _multi_source_bfs(adj, sources):
    """(dist, src) from a vertex SET: dist to the set, and which source is nearest."""
    dist, src = {}, {}
    frontier = []
    for s in sources:
        dist[s], src[s] = 0, s
        frontier.append(s)
    while frontier:
        nxt = []
        for u in frontier:
            for w in adj[u]:
                if w not in dist:
                    dist[w] = dist[u] + 1
                    src[w] = src[u]
                    nxt.append(w)
        frontier = nxt
    return dist, src


def _path_to_set(adj, src, targets):
    """Shortest path (vertex list) from src to the NEAREST vertex of a set.

    This is the slimness measurement made walkable: the witness vertex's
    actual hop-by-hop route to the union of the other two sides. Returns
    [src] when src already sits in the set."""
    targets = set(targets)
    if src in targets:
        return [src]
    prev, frontier = {src: None}, [src]
    while frontier:
        nxt = []
        for u in frontier:
            for w in adj[u]:
                if w not in prev:
                    prev[w] = u
                    if w in targets:
                        path = [w]
                        while prev[path[-1]] is not None:
                            path.append(prev[path[-1]])
                        return path[::-1]
                    nxt.append(w)
        frontier = nxt
    raise ValueError("no path from src to the target set")


def _ball(adj, edges, v, radius):
    """(vertices, edges) of the radius-`radius` neighbourhood around v."""
    dist = _bfs_dist(adj, v)
    verts = [u for u, d in dist.items() if d <= radius]
    vs = set(verts)
    return verts, [(a, b) for a, b in edges if a in vs and b in vs]


def _uniform_geodesic(adj, s, t, rng):
    """One shortest s-t path, uniform over ALL shortest s-t paths.

    BFS from t gives layers; counting shortest paths to t by DP lets each step
    from u pick a predecessor-of-t neighbour v with probability proportional to
    the number of shortest v-t paths — which makes the whole walk uniform over
    the geodesics, exactly the sampling in the C4 statement.
    """
    dist = _bfs_dist(adj, t)
    if s not in dist:
        raise ValueError("s and t are in different components")
    order = sorted(dist, key=dist.get)
    npaths = {t: 1}
    for v in order[1:]:
        npaths[v] = sum(npaths[w] for w in adj[v] if dist[w] == dist[v] - 1)
    path, u = [s], s
    while u != t:
        cands = [w for w in adj[u] if dist[w] == dist[u] - 1]
        weights = [npaths[w] for w in cands]
        r = rng.random() * sum(weights)
        acc = 0
        for w, wt in zip(cands, weights):
            acc += wt
            if r < acc:
                u = w
                break
        else:  # float edge case
            u = cands[-1]
        path.append(u)
    return path


def _slim_of_triangle(adj, paths):
    """slim(Δ) for sides given as vertex lists — the EXACT Gromov slimness of
    the drawn triangle: the smallest δ such that every side lies in the
    graph-metric δ-neighbourhood of the union of the other two, computed by
    multi-source BFS from that union (never a Gromov-product shortcut).
    Returns (slim, witness, nearest, side): the vertex realising the max, the
    closest vertex on the other two sides, and which side the witness sits on."""
    best, witness, nearest, side = 0, paths[0][0], paths[0][0], 0
    for i in range(3):
        others = set(paths[(i + 1) % 3]) | set(paths[(i + 2) % 3])
        dist, src = _multi_source_bfs(adj, others)
        for v in paths[i]:
            d = dist.get(v)
            if d is None:
                raise AssertionError("triangle side left the component")
            if d > best:
                best, witness, nearest, side = d, v, src[v], i
    return best, witness, nearest, side


class RandomGraph(VGroup):
    """A real G(n, c/n) sample: scatter, edges arriving, the giant coloring in,
    then a geodesic triangle with its slimness actually measured.

        rg = RandomGraph(n=180, c=2.5, seed=11).move_to(DOWN * 0.3)
        for step in rg.reveals(): self.play(*step)   # nodes, edges, giant
        tri = rg.build_triangle()
        for step in rg.triangle_reveals(): self.play(*step)
        marker = rg.slim_marker()                     # dashed witness + label
        self.play(Create(marker))

    Everything is computed at construction from a seeded RNG: the edge set is
    a genuine Bernoulli(c/n) sample, components come from BFS, the layout is a
    deterministic spring embedding, the triangle's sides are drawn uniformly
    from the actual sets of shortest paths (path-count weighted, as in the C4
    statement), and slim(Δ) is measured by multi-source BFS. Nothing removes
    itself from the scene; teardown stays with the caller.
    """

    def __init__(self, n=180, c=2.5, seed=11, width=11.0, height=5.4,
                 layout_iters=60):
        super().__init__()
        self.n, self.c = n, c
        rng = self._rng = __import__("random").Random(seed)
        self.edges = _gnp_edges(n, c, rng)
        self.adj = _adjacency(n, self.edges)
        comps = _components(n, self.adj)
        self.giant = set(comps[0])
        if len(self.giant) < 0.5 * n:
            raise AssertionError(
                f"RandomGraph: giant holds only {len(self.giant)}/{n} vertices; "
                "supercritical c should give a dominant component")

        # deterministic Fruchterman–Reingold layout: pairwise repulsion k²/d,
        # attraction d²/k on edges, a mild pull to the centre so stray
        # components stay in frame, and a cooling step cap. No hard clamping —
        # that parks nodes on the box walls; the cloud is rescaled to fit at
        # the end instead.
        pos = [[rng.uniform(-1, 1), rng.uniform(-0.6, 0.6)] for _ in range(n)]
        k = math.sqrt(2.0 / n)
        for it in range(layout_iters):
            disp = [[0.0, 0.0] for _ in range(n)]
            for i in range(n):
                xi, yi = pos[i]
                for j in range(i + 1, n):
                    dx, dy = xi - pos[j][0], yi - pos[j][1]
                    d = math.sqrt(dx * dx + dy * dy) + 1e-6
                    f = k * k / d / d
                    disp[i][0] += dx * f
                    disp[i][1] += dy * f
                    disp[j][0] -= dx * f
                    disp[j][1] -= dy * f
            for u, v in self.edges:
                dx, dy = pos[u][0] - pos[v][0], pos[u][1] - pos[v][1]
                d = math.sqrt(dx * dx + dy * dy) + 1e-6
                f = d / k  # FR attraction d²/k, as a multiple of the unit vector
                disp[u][0] -= dx * f
                disp[u][1] -= dy * f
                disp[v][0] += dx * f
                disp[v][1] += dy * f
            temp = 0.14 * (1 - it / layout_iters) + 0.01
            for i in range(n):
                # gravity toward the centre, stronger for far-flung strays
                disp[i][0] -= pos[i][0] * 0.55
                disp[i][1] -= pos[i][1] * 0.55
                dx, dy = disp[i]
                d = math.sqrt(dx * dx + dy * dy) + 1e-9
                s = min(temp, d) / d
                pos[i][0] += dx * s
                pos[i][1] += dy * s
        # rescale the settled cloud to the requested box
        xs = [p[0] for p in pos]
        ys = [p[1] for p in pos]
        cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
        sx = (width / 2) / max(1e-6, (max(xs) - min(xs)) / 2)
        sy = (height / 2) / max(1e-6, (max(ys) - min(ys)) / 2)
        self._pos = {
            v: np.array([(pos[v][0] - cx) * sx, (pos[v][1] - cy) * sy, 0.0])
            for v in range(n)
        }

        self.dots = VGroup()
        self._dot = {}
        for v in range(n):
            d = Dot(self._pos[v], radius=0.045, color=INK).set_opacity(0.75)
            self._dot[v] = d
            self.dots.add(d)
        self.edge_lines = VGroup()
        self._giant_edges = []
        for u, v in self.edges:
            ln = Line(self._pos[u], self._pos[v], color=INK,
                      stroke_width=1.5).set_opacity(0.32)
            if u in self.giant and v in self.giant:
                self._giant_edges.append(ln)
            self.edge_lines.add(ln)
        self.add(self.edge_lines, self.dots)
        self._triangle = None

    def pos(self, v):
        return self._dot[v].get_center()

    def reveals(self):
        """Scatter, edges arriving, giant coloring in — one list per play()."""
        yield [LaggedStart(*[FadeIn(d, scale=0.4) for d in self.dots],
                           lag_ratio=0.008)]
        yield [LaggedStart(*[Create(e) for e in self.edge_lines], lag_ratio=0.006)]
        giant_on = [
            AnimationGroup(
                self._dot[v].animate.set_color(BLUE).set_opacity(1).scale(1.25))
            for v in sorted(self.giant)
        ]
        edges_on = [e.animate.set_color(BLUE).set_opacity(0.5)
                    for e in self._giant_edges]
        dim = [self._dot[v].animate.set_opacity(0.22)
               for v in range(self.n) if v not in self.giant]
        yield [LaggedStart(*giant_on, lag_ratio=0.006),
               AnimationGroup(*edges_on, *dim)]

    # ---- the geodesic triangle ----
    def build_triangle(self, spread_tries=48):
        """Pick three giant vertices spread far apart, join them by uniformly
        sampled shortest paths, measure slim(Δ). Returns the drawn triangle."""
        rng = self._rng
        giant = sorted(self.giant)
        best_triple, best_score = None, (-1, -1)
        for _ in range(spread_tries):
            trip = rng.sample(giant, 3)
            d0 = _bfs_dist(self.adj, trip[0])
            d1 = _bfs_dist(self.adj, trip[1])
            ds = (d0[trip[1]], d1[trip[2]], d0[trip[2]])
            score = (min(ds), sum(ds))
            if score > best_score:
                best_score, best_triple = score, trip
        x, y, z = best_triple
        self.corners = (x, y, z)
        self.paths = [
            _uniform_geodesic(self.adj, x, y, rng),
            _uniform_geodesic(self.adj, y, z, rng),
            _uniform_geodesic(self.adj, z, x, rng),
        ]
        self.slim, self._witness, self._nearest, self._side = _slim_of_triangle(
            self.adj, self.paths)
        others = (set(self.paths[(self._side + 1) % 3])
                  | set(self.paths[(self._side + 2) % 3]))
        self.witness_path = _path_to_set(self.adj, self._witness, others)
        if len(self.witness_path) - 1 != self.slim:
            raise AssertionError("RandomGraph: witness path length != slim(Δ)")

        side_colors = [RED, GREEN, YELLOW]
        self.side_lines = VGroup(*[
            VMobject(color=side_colors[i], stroke_width=6)
            .set_points_as_corners([self.pos(v) for v in self.paths[i]])
            for i in range(3)
        ])
        self.corner_marks = VGroup(*[
            VGroup(Dot(self.pos(v), radius=0.09, color=INK),
                   Circle(radius=0.17, color=INK, stroke_width=3.5)
                   .move_to(self.pos(v)))
            for v in (x, y, z)
        ])
        self._triangle = VGroup(self.side_lines, self.corner_marks)
        return self._triangle

    def triangle_reveals(self):
        if self._triangle is None:
            self.build_triangle()
        yield [LaggedStart(*[GrowFromCenter(m) for m in self.corner_marks],
                           lag_ratio=0.25)]
        yield [LaggedStart(*[Create(s) for s in self.side_lines], lag_ratio=0.45)]

    def exact_slim(self):
        """Recompute the exact Gromov slimness of the drawn triangle and check
        it against the value stored at build time. Small-example beats display
        THIS — never an approximation."""
        if self._triangle is None:
            self.build_triangle()
        s = _slim_of_triangle(self.adj, self.paths)[0]
        if s != self.slim:
            raise AssertionError(f"exact_slim: recomputed {s} != stored {self.slim}")
        return s

    def hop_marker(self, label_scale=0.34):
        """Slimness made countable: ring the witness vertex, trace its actual
        shortest route to the union of the other two sides hop by dashed hop,
        number each hop (digits on screen are fine), and stamp the measured
        slim(Δ). Returns a VGroup with .ring, .hops, .nums, .lbl."""
        if self._triangle is None:
            self.build_triangle()
        wp = self.witness_path
        ring = Circle(radius=0.16, color=RED, stroke_width=4).move_to(
            self.pos(self._witness))
        hops, nums = VGroup(), VGroup()
        for i, (u, v) in enumerate(zip(wp, wp[1:])):
            a, b = self.pos(u), self.pos(v)
            hops.add(DashedLine(a, b, color=RED, stroke_width=5, dash_length=0.08))
            d = b - a
            nrm = np.array([-d[1], d[0], 0.0])
            nl = np.linalg.norm(nrm)
            nrm = nrm / nl * 0.26 if nl > 1e-9 else np.array([0.0, 0.26, 0.0])
            t = _mono(str(i + 1), 0.3, RED, bold=True)
            back = Circle(radius=max(t.width, t.height) / 2 + 0.07, stroke_width=0,
                          fill_color=PAPER, fill_opacity=0.92)
            chip = VGroup(back, t).move_to((a + b) / 2 + nrm)
            nums.add(chip)
        txt = _mono(f"slim(Δ) = {self.slim}", label_scale, RED, bold=True)
        if len(wp) > 1:
            # sit OPPOSITE the hop numerals (they ride +normal) so the label
            # can never cover the count it is summarising
            mids = [(self.pos(u) + self.pos(v)) / 2 for u, v in zip(wp, wp[1:])]
            mid_all = sum(mids) / len(mids)
            d = self.pos(wp[-1]) - self.pos(wp[0])
            nrm = np.array([-d[1], d[0], 0.0])
            nl = np.linalg.norm(nrm)
            nrm = nrm / nl if nl > 1e-9 else np.array([0.0, 1.0, 0.0])
            txt.move_to(mid_all - nrm * 0.85)
        else:
            txt.next_to(self.pos(wp[0]), UP + RIGHT, buff=0.34)
        back = RoundedRectangle(
            corner_radius=0.08, width=txt.width + 0.32, height=txt.height + 0.22,
            stroke_width=0, fill_color=PAPER, fill_opacity=0.92).move_to(txt)
        lbl = VGroup(back, txt)
        g = VGroup(ring, hops, nums, lbl)
        g.ring, g.hops, g.nums, g.lbl = ring, hops, nums, lbl
        return g

    def ball(self, v, radius=2):
        """(vertices, edges) of the radius-`radius` neighbourhood around v."""
        return _ball(self.adj, self.edges, v, radius)

    def find_tree_ball(self, radius=2, lo=6, hi=12):
        """A giant-component vertex whose radius-`radius` ball is literally a
        tree (|E| = |V| − 1) with lo..hi vertices — the honest 'up close,
        almost a tree' witness. Deterministic: highest-degree such root wins,
        ties to the smallest vertex id."""
        best = None
        for v in sorted(self.giant):
            verts, edges = self.ball(v, radius)
            if lo <= len(verts) <= hi and len(edges) == len(verts) - 1:
                key = (len(self.adj[v]), -v)
                if best is None or key > best[0]:
                    best = (key, v)
        if best is None:
            raise AssertionError("find_tree_ball: no tree-like neighbourhood found")
        return best[1]

    def slim_marker(self):
        """Dashed witness segment (the vertex farthest from the other two
        sides, joined to its nearest vertex on them) + a measured label."""
        if self._triangle is None:
            self.build_triangle()
        a, b = self.pos(self._witness), self.pos(self._nearest)
        seg = DashedLine(a, b, color=RED, stroke_width=5, dash_length=0.1)
        ring = Circle(radius=0.14, color=RED, stroke_width=4).move_to(a)
        txt = _mono(f"slim(Δ) = {self.slim}", 0.34, RED, bold=True)
        txt.next_to((a + b) / 2, UP + RIGHT, buff=0.22)
        back = RoundedRectangle(
            corner_radius=0.08, width=txt.width + 0.32, height=txt.height + 0.22,
            stroke_width=0, fill_color=PAPER, fill_opacity=0.92).move_to(txt)
        lbl = VGroup(back, txt)  # paper-backed so it reads over the graph
        g = VGroup(seg, ring, lbl)
        g.seg, g.ring, g.lbl = seg, ring, lbl
        return g


def _selfcheck_randomgraph():
    import random as _random

    # (a) phase transition on a fixed seed: supercritical c=2 grows a giant
    # near the theoretical fraction (β solves β = 1 − e^{−cβ}; β(2) ≈ 0.797),
    # subcritical c=0.5 stays fragmented.
    n = 600
    adj = _adjacency(n, _gnp_edges(n, 2.0, _random.Random(5)))
    frac = len(_components(n, adj)[0]) / n
    if not (0.70 < frac < 0.90):
        raise AssertionError(f"RandomGraph selfcheck: giant fraction {frac} at c=2")
    adj_sub = _adjacency(n, _gnp_edges(n, 0.5, _random.Random(5)))
    if len(_components(n, adj_sub)[0]) > 0.1 * n:
        raise AssertionError("RandomGraph selfcheck: subcritical c=0.5 grew a giant")

    # (b) a sampled geodesic is a genuine shortest path
    giant = _components(n, adj)[0]
    s, t = giant[0], giant[len(giant) // 2]
    path = _uniform_geodesic(adj, s, t, _random.Random(9))
    if len(path) - 1 != _bfs_dist(adj, s)[t]:
        raise AssertionError("RandomGraph selfcheck: geodesic has wrong length")
    for u, v in zip(path, path[1:]):
        if v not in adj[u]:
            raise AssertionError("RandomGraph selfcheck: geodesic not a path")

    # (c) uniformity over shortest paths: the 4-cycle has exactly two
    # geodesics between opposite corners; both must appear about half the time
    c4 = [[1, 3], [0, 2], [1, 3], [0, 2]]
    r = _random.Random(3)
    via1 = sum(1 for _ in range(200) if _uniform_geodesic(c4, 0, 2, r)[1] == 1)
    if not (60 <= via1 <= 140):
        raise AssertionError(f"RandomGraph selfcheck: geodesic sampling biased ({via1}/200)")

    # (d) slimness ground truths: trees give slim 0; the 6-cycle triangle
    # on vertices 0,2,4 gives slim exactly 1
    star = [[1, 2, 3], [0], [0], [0]]
    sides = [[1, 0, 2], [2, 0, 3], [3, 0, 1]]
    if _slim_of_triangle(star, sides)[0] != 0:
        raise AssertionError("RandomGraph selfcheck: tree triangle not slim 0")
    c6 = [[1, 5], [0, 2], [1, 3], [2, 4], [3, 5], [4, 0]]
    hexs = [[0, 1, 2], [2, 3, 4], [4, 5, 0]]
    if _slim_of_triangle(c6, hexs)[0] != 1:
        raise AssertionError("RandomGraph selfcheck: C6 triangle slim != 1")

    # (e) the witness route IS the slimness: the 4-tuple names a side holding
    # the witness, and the walked path to the other two sides has exactly
    # slim hops — on the C6 triangle that is 1 hop, on the tree 0.
    sl, wit, near_, side = _slim_of_triangle(c6, hexs)
    if wit not in hexs[side]:
        raise AssertionError("RandomGraph selfcheck: witness not on its side")
    others = set(hexs[(side + 1) % 3]) | set(hexs[(side + 2) % 3])
    wp = _path_to_set(c6, wit, others)
    if len(wp) - 1 != sl or wp[-1] not in others:
        raise AssertionError(f"RandomGraph selfcheck: witness path {wp} != slim {sl}")
    if _path_to_set(star, 1, {2})[:] != [1, 0, 2]:
        raise AssertionError("RandomGraph selfcheck: star path 1->2 wrong")
    if len(_path_to_set(c6, 1, {4})) - 1 != 3:
        raise AssertionError("RandomGraph selfcheck: C6 path 1->{4} not 3 hops")
    if len(_path_to_set(c6, 1, {3, 5})) - 1 != 2:
        raise AssertionError("RandomGraph selfcheck: C6 path 1->{3,5} not 2 hops")
    if _path_to_set(c6, 2, {2, 4}) != [2]:
        raise AssertionError("RandomGraph selfcheck: path to own set not trivial")

    # (f) neighbourhood balls: on the star, radius 1 around the hub is the
    # whole tree; on the 6-cycle, radius 2 around 0 misses vertex 3 and the
    # ball is a path (a tree: |E| = |V| - 1).
    star_edges = [(0, 1), (0, 2), (0, 3)]
    bv, be = _ball(star, star_edges, 0, 1)
    if sorted(bv) != [0, 1, 2, 3] or len(be) != 3:
        raise AssertionError("RandomGraph selfcheck: star ball wrong")
    c6_edges = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 0)]
    bv, be = _ball(c6, c6_edges, 0, 2)
    if sorted(bv) != [0, 1, 2, 4, 5] or len(be) != len(bv) - 1:
        raise AssertionError("RandomGraph selfcheck: C6 radius-2 ball not a 4-edge path")


# --------------------------------------------------------------------------- #
# import-time verification — raise loudly before any frame is rendered
# --------------------------------------------------------------------------- #
if os.environ.get("MATHVIZ_SKIP_SELFCHECK") != "1":
    _selfcheck_sievegrid()
    _selfcheck_densityflow()
    _selfcheck_brunstack()
    _selfcheck_parityfield()
    _selfcheck_admissiblewindow()
    _selfcheck_randomgraph()
