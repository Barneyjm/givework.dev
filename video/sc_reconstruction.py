"""Diagram-first explainer for the (Kelly-Ulam) Reconstruction Conjecture.

Centerpiece: a 5-vertex "house" graph G. Each vertex is peeled off in turn to
make a "card" (G minus that one vertex, kept in its original layout so the
card is visibly a sub-picture of G) and the five cards are laid out as a deck.
An arrow from the deck back to G dramatizes the claim: the deck alone
determines G. The n=2 counterexample (an edge vs. two isolated points, same
deck) motivates the n >= 3 hypothesis in `why`.

The deck is computed programmatically from EDGES (never hand-typed per card),
so every card drawn on screen is guaranteed to really be G minus one vertex.
"""

import numpy as np

from manim import *
from viz import (
    BeatScene, PAPER, INK, RED, BLUE, YELLOW, GREEN,
    TITLE_KW, BODY_KW, MONO_KW, eyebrow, caption, fit_width, mathtex,
)


# --- the house graph: 5 vertices, 6 edges -----------------------------------
FULL_V = ["1", "2", "3", "4", "5"]
POS = {
    "1": np.array([-1.3, -1.3, 0.0]),   # bottom-left
    "2": np.array([1.3, -1.3, 0.0]),    # bottom-right
    "3": np.array([1.3, 0.5, 0.0]),     # top-right
    "4": np.array([-1.3, 0.5, 0.0]),    # top-left
    "5": np.array([0.0, 1.7, 0.0]),     # roof apex
}
EDGES = [("1", "2"), ("2", "3"), ("3", "4"), ("4", "1"), ("4", "5"), ("5", "3")]

# The deck: computed, not hand-typed, so every card is provably G minus one vertex.
CARD_VERTS = {v: [u for u in FULL_V if u != v] for v in FULL_V}
CARD_EDGES = {v: [e for e in EDGES if v not in e] for v in FULL_V}


class Graph:
    """A drawable labeled graph: dots + straight edges, as a scalable VGroup."""

    def __init__(self, vertices, edges, pos, scale=1.0, shift=ORIGIN,
                 dot_r=0.12, stroke=5, color=INK, labels=False, label_scale=0.28):
        self.dots = {}
        self.edges = {}
        base = VGroup()
        for k in vertices:
            d = Dot(pos[k], radius=dot_r, color=color, z_index=3)
            self.dots[k] = d
            base.add(d)
        self.edge_group = VGroup()
        for a, b in edges:
            ln = Line(pos[a], pos[b], color=color, stroke_width=stroke, z_index=1)
            self.edges[frozenset((a, b))] = ln
            self.edge_group.add(ln)
        base.add(self.edge_group)
        self.labels = {}
        if labels:
            for k in vertices:
                out = pos[k] - np.mean([pos[u] for u in vertices], axis=0)
                nrm = out / (np.linalg.norm(out) + 1e-6)
                lbl = Text(k, **MONO_KW).scale(label_scale).move_to(pos[k] + nrm * 0.38)
                self.labels[k] = lbl
                base.add(lbl)
        self.group = base
        self.group.scale(scale).shift(shift)

    def edge(self, a, b):
        return self.edges[frozenset((a, b))]


def card_frame(width=1.9, height=2.0):
    return RoundedRectangle(corner_radius=0.12, width=width, height=height,
                            color=INK, stroke_width=3, fill_color=PAPER, fill_opacity=1)


class ConjectureVideo(BeatScene):
    def build(self):
        self.beat_title(extra_build=self._title_flourish)
        self.beat_statement()
        self.beat_background()
        self.beat_why()
        self.beat_impact()

    # -- title: a vertex fades out, the remainder becomes a "card" ----------
    def _title_flourish(self, _):
        p = {"a": np.array([-0.7, -2.0, 0.0]), "b": np.array([0.7, -2.0, 0.0]),
             "c": np.array([0.0, -3.15, 0.0])}
        e = [("a", "b"), ("b", "c"), ("c", "a")]
        g = Graph(["a", "b", "c"], e, p, dot_r=0.11, stroke=4)
        self.play(LaggedStart(*[GrowFromCenter(d) for d in g.dots.values()], lag_ratio=0.15),
                  run_time=0.5)
        self.play(LaggedStart(*[Create(ln) for ln in g.edge_group], lag_ratio=0.2), run_time=0.5)
        incident = [g.edge("b", "c"), g.edge("c", "a")]
        self.play(FadeOut(g.dots["c"]), *[FadeOut(ln) for ln in incident],
                  run_time=0.4)
        remain = VGroup(g.dots["a"], g.dots["b"], g.edge("a", "b"))
        frame = card_frame(1.7, 1.1).move_to(remain.get_center())
        tag = Text("card", **MONO_KW).scale(0.26).set_opacity(0.7).next_to(frame, DOWN, buff=0.1)
        self.play(Create(frame), FadeIn(tag), run_time=0.4)
        return VGroup(remain, frame, tag)

    # -- statement: G, peeled into a deck of cards, then rebuilt -------------
    def beat_statement(self):
        self.narrate("statement")
        head = eyebrow("THE CONJECTURE").to_edge(UP, buff=0.5)
        cap = caption("Delete one vertex at a time — keep the deck of what's left.",
                      0.46, max_w=11.5).next_to(head, DOWN, buff=0.25)
        self.play(FadeIn(head), FadeIn(cap, shift=UP * 0.15), run_time=0.6)

        self.G = Graph(FULL_V, EDGES, POS, scale=0.85, shift=UP * 0.5, labels=True)
        gtag = Text("G", **MONO_KW).scale(0.4).set_color(BLUE).next_to(self.G.group, LEFT, buff=0.5)
        self.play(LaggedStart(*[GrowFromCenter(d) for d in self.G.dots.values()], lag_ratio=0.08),
                  run_time=0.6)
        self.play(LaggedStart(*[Create(ln) for ln in self.G.edge_group], lag_ratio=0.08),
                  run_time=0.7)
        self.play(LaggedStart(*[FadeIn(l) for l in self.G.labels.values()], lag_ratio=0.06),
                  FadeIn(gtag), run_time=0.5)

        # peel each vertex into a card, one by one
        slot_xs = np.linspace(-4.7, 4.7, 5)
        slot_y = -2.55
        self._deck = VGroup()
        for i, v in enumerate(FULL_V):
            dot = self.G.dots[v]
            incident = [self.G.edge(a, b) for (a, b) in EDGES if v in (a, b)]
            ring = Circle(radius=0.26, color=RED, stroke_width=5).move_to(dot.get_center())
            self.play(Create(ring), run_time=0.22)

            card_src = VGroup(*[self.G.dots[u].copy() for u in CARD_VERTS[v]],
                              *[self.G.edge(a, b).copy() for (a, b) in CARD_EDGES[v]])
            card_tgt = card_src.copy()
            card_tgt.scale(0.42)
            card_tgt.move_to(np.array([slot_xs[i], slot_y, 0.0]))
            frame = card_frame().move_to(np.array([slot_xs[i], slot_y, 0.0]))
            minus = Text(f"−{v}", **MONO_KW).scale(0.3).set_color(RED).next_to(
                frame, UP, buff=0.08)

            self.play(FadeOut(ring), dot.animate.set_opacity(0.15),
                      *[ln.animate.set_opacity(0.15) for ln in incident],
                      FadeIn(frame), Transform(card_src, card_tgt),
                      run_time=0.85)
            self.play(FadeIn(minus, shift=UP * 0.05), run_time=0.22)
            self.play(dot.animate.set_opacity(1), *[ln.animate.set_opacity(1) for ln in incident],
                      run_time=0.28)
            self._deck.add(VGroup(frame, card_src, minus))

        claim = caption("The deck alone determines G — uniquely (n ≥ 3).", 0.46,
                        weight=BOLD, max_w=11.5)
        claim.move_to(cap.get_center())
        arrow_x = (slot_xs[1] + slot_xs[2]) / 2.0  # between two cards, clear of any label
        arrow = Arrow(np.array([arrow_x, slot_y + 1.05, 0.0]), np.array([arrow_x, -0.75, 0.0]),
                     color=GREEN, stroke_width=8, buff=0.0)
        check = Text("✓", font="sans-serif", weight=BOLD, color=GREEN).scale(0.55).next_to(
            arrow, RIGHT, buff=0.15)
        self.play(FadeTransform(cap, claim), GrowArrow(arrow), FadeIn(check, scale=0.6),
                  Indicate(self.G.group, color=GREEN, scale_factor=1.05), run_time=1.1)
        self.wait(self.pace(0.3))
        self.close_beat(0.6)
        self.play(FadeOut(head), FadeOut(claim), FadeOut(arrow), FadeOut(check),
                  FadeOut(gtag), run_time=0.5)

    def beat_background(self):
        self.narrate("background")
        combo = VGroup(self.G.group, self._deck)
        self.play(combo.animate.scale(0.42).to_corner(DR, buff=0.35), run_time=0.6)
        head = eyebrow("1942 KELLY · c.1960 ULAM").to_edge(UP, buff=0.5)
        cap1 = caption("Paul Kelly posed it in his PhD thesis in 1942.", 0.46,
                       max_w=10.5).next_to(head, DOWN, buff=0.3)
        self.play(FadeIn(head), FadeIn(cap1, shift=UP * 0.15), run_time=0.6)
        self.wait(self.pace(0.18))
        cap2 = caption("Stanislaw Ulam spread it widely around 1960 — one of graph theory's famous open problems.",
                       0.44, max_w=11.0).move_to(cap1.get_center())
        self.play(FadeTransform(cap1, cap2), run_time=0.6)
        self.close_beat(0.6)
        self.play(FadeOut(head), FadeOut(cap2), FadeOut(combo), run_time=0.5)

    def _badge(self, label, ok):
        mark = Text("✓" if ok else "?", font="sans-serif", weight=BOLD,
                    color=GREEN if ok else RED).scale(0.5)
        box = Circle(radius=0.26, color=GREEN if ok else RED, stroke_width=4)
        txt = caption(label, 0.42, max_w=9.5)
        return VGroup(VGroup(box, mark), txt).arrange(RIGHT, buff=0.32)

    def beat_why(self):
        self.narrate("why")
        head = eyebrow("INFORMATION LOST? OR NOT?").to_edge(UP, buff=0.5)
        self.play(FadeIn(head), run_time=0.4)

        # the tension: one card, missing a vertex
        gL = Graph(FULL_V, EDGES, POS, scale=0.38, shift=LEFT * 3.3 + UP * 0.9)
        cardR = Graph(CARD_VERTS["1"], CARD_EDGES["1"], POS, scale=0.38, shift=RIGHT * 3.3 + UP * 0.9)
        frameR = card_frame(2.7, 2.4).move_to(cardR.group.get_center())
        self.play(LaggedStart(*[GrowFromCenter(d) for d in gL.dots.values()], lag_ratio=0.06),
                  LaggedStart(*[Create(ln) for ln in gL.edge_group], lag_ratio=0.06),
                  run_time=0.7)
        self.play(Create(frameR),
                  LaggedStart(*[GrowFromCenter(d) for d in cardR.dots.values()], lag_ratio=0.06),
                  LaggedStart(*[Create(ln) for ln in cardR.edge_group], lag_ratio=0.06),
                  run_time=0.7)
        arrow = Arrow(gL.group.get_right(), frameR.get_left(), color=RED, stroke_width=5, buff=0.2)
        qmark = Text("−1 vertex", **MONO_KW).scale(0.3).set_color(RED).next_to(arrow, UP, buff=0.1)
        tension = caption("Each card is missing one vertex — is the information gone?", 0.46,
                          max_w=11).to_edge(DOWN, buff=1.5)
        self.play(GrowArrow(arrow), FadeIn(qmark), FadeIn(tension, shift=UP * 0.15), run_time=0.7)
        self.wait(self.pace(0.14))
        self.play(FadeOut(gL.group), FadeOut(cardR.group), FadeOut(frameR), FadeOut(arrow),
                  FadeOut(qmark), FadeOut(tension), run_time=0.4)

        # the n=2 counterexample: same deck, different graphs
        posH = {"p": LEFT * 0.55, "q": RIGHT * 0.55}
        H1 = Graph(["p", "q"], [("p", "q")], posH, scale=0.85, shift=LEFT * 3.3 + DOWN * 0.2)
        H2 = Graph(["p", "q"], [], posH, scale=0.85, shift=RIGHT * 3.3 + DOWN * 0.2)
        lbl1 = caption("G: an edge", 0.4).next_to(H1.group, UP, buff=0.35)
        lbl2 = caption("H: no edge", 0.4).next_to(H2.group, UP, buff=0.35)
        self.play(FadeIn(H1.group), FadeIn(lbl1), FadeIn(H2.group), FadeIn(lbl2), run_time=0.6)

        def tiny_card(center):
            f = card_frame(0.7, 0.7).move_to(center)
            d = Dot(center, radius=0.08, color=INK)
            return VGroup(f, d)

        deck1 = VGroup(tiny_card(H1.group.get_center() + LEFT * 0.55 + DOWN * 1.3),
                       tiny_card(H1.group.get_center() + RIGHT * 0.55 + DOWN * 1.3))
        deck2 = VGroup(tiny_card(H2.group.get_center() + LEFT * 0.55 + DOWN * 1.3),
                       tiny_card(H2.group.get_center() + RIGHT * 0.55 + DOWN * 1.3))
        same = caption("identical decks", 0.4, color=RED, weight=BOLD).move_to(DOWN * 2.55)
        self.play(FadeIn(deck1), FadeIn(deck2), FadeIn(same, shift=UP * 0.1), run_time=0.6)
        eq_cap = caption("Same deck, two different graphs — reconstruction needs n ≥ 3.", 0.44,
                        color=RED, weight=BOLD).to_edge(DOWN, buff=0.4)
        self.play(FadeIn(eq_cap, shift=UP * 0.15), run_time=0.5)
        self.wait(self.pace(0.15))
        self.play(FadeOut(H1.group), FadeOut(H2.group), FadeOut(lbl1), FadeOut(lbl2),
                  FadeOut(deck1), FadeOut(deck2), FadeOut(same), FadeOut(eq_cap), run_time=0.4)

        badges = VGroup(
            self._badge("Proven for trees (Kelly, 1957)", True),
            self._badge("Settled for regular and disconnected graphs", True),
            self._badge("Checked by computer to 13 vertices — no counterexample", True),
            self._badge("The general case: still open", False),
        ).arrange(DOWN, aligned_edge=LEFT, buff=0.28).shift(DOWN * 0.3)
        self.play(LaggedStart(*[FadeIn(b, shift=RIGHT * 0.25) for b in badges], lag_ratio=0.3),
                  run_time=min(2.6, self.pace(0.4, 1.4)))
        self.close_beat(0.6)
        self.play(FadeOut(head), FadeOut(badges), run_time=0.5)

    def _icon_row(self, icon, text):
        t = caption(text, 0.44, max_w=8.6)
        return VGroup(icon, t).arrange(RIGHT, buff=0.45)

    def beat_impact(self):
        self.narrate("impact")
        head = eyebrow("A QUESTION ABOUT WHOLES AND PARTS").to_edge(UP, buff=0.55)
        tex = mathtex(self.spec.get("tex", ""), scale=0.5, max_w=10.5)
        if tex is not None:
            tex.next_to(head, DOWN, buff=0.35)
        self.play(FadeIn(head), *([FadeIn(tex, shift=UP * 0.15)] if tex is not None else []),
                  run_time=0.6)

        # icon 1: a small deck, readable properties
        deck_icon = VGroup(*[card_frame(0.5, 0.62).shift(RIGHT * 0.06 * i + UP * 0.05 * i)
                             for i in range(3)])
        check = Text("✓", font="sans-serif", weight=BOLD, color=GREEN).scale(0.3).move_to(
            deck_icon[-1].get_center())
        icon1 = VGroup(deck_icon, check)

        # icon 2: a directed edge, struck through
        dp = Dot(LEFT * 0.35, radius=0.06, color=INK)
        dq = Dot(RIGHT * 0.35, radius=0.06, color=INK)
        darrow = Arrow(dp.get_center(), dq.get_center(), buff=0.08, stroke_width=4,
                       color=INK, max_tip_length_to_length_ratio=0.35)
        xmark = Text("×", font="sans-serif", weight=BOLD, color=RED).scale(0.45).move_to(
            darrow.get_center() + UP * 0.28)
        icon2 = VGroup(dp, dq, darrow, xmark)

        # icon 3: overlapping scan arcs (tomography / imaging)
        icon3 = VGroup(*[Arc(radius=0.18 + 0.1 * i, start_angle=PI * 0.7, angle=PI * 0.9,
                             color=BLUE, stroke_width=4) for i in range(3)])

        rows = VGroup(
            self._icon_row(icon1, "Edge count, degree sequence, connectivity — all readable from the deck."),
            self._icon_row(icon2, "The directed-graph version is false: orientation can erase information."),
            self._icon_row(icon3, "Its theme echoes in tomography and imaging: rebuilding a whole from overlapping views."),
        ).arrange(DOWN, aligned_edge=LEFT, buff=0.55)
        rows.next_to(tex, DOWN, buff=0.55) if tex is not None else rows.next_to(head, DOWN, buff=0.9)

        self.play(LaggedStart(*[FadeIn(r, shift=RIGHT * 0.3) for r in rows], lag_ratio=0.4),
                  run_time=min(3.6, self.pace(0.45, 2.0)))
        self.close_beat(0.6)
        self.play(FadeOut(head), *([FadeOut(tex)] if tex is not None else []), FadeOut(rows),
                  run_time=0.5)
