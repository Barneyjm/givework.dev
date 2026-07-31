"""Real numerics for the First Proof C3 explainer (abelian stand-in, G = U(1)).

Everything the C3 video paints is computed here, on a periodic grid over the
unit torus [0,1)^2, with spectral (FFT) derivatives:

* a connection is a pair of real fields (a1, a2) — the 1-form A = a1 dx + a2 dy;
* a gauge transformation by e^{i theta} shifts A by d(theta) and leaves the
  curvature f = curl(A) = d(A) untouched (checked to machine precision below);
* Yang–Mills gradient flow, in this abelian case, makes the curvature obey the
  heat equation on T^2 exactly: f(s) = e^{s Laplacian} f(0). The flow frames in
  the video are that equation solved spectrally, never keyframed by hand;
* the invariant-norm profile N(s) = s^{kappa/2} ( s^{1/2} ||f(s)||_inf
  + s ||grad f(s)||_inf ) is evaluated on a log grid in s, and the norm is its
  sup — the number the video's marker points at. (Abelian: DF = grad F.)

_selfcheck_gaugeflow() runs at import (skip with MATHVIZ_SKIP_SELFCHECK=1,
CI smoke only) and raises loudly if the arithmetic drifts:
  1. curvature of a smooth periodic 1-form has zero mean;
  2. gauge invariance: curl(A + d theta) == curl(A) to 1e-10;
  3. a heat step conserves the mean and never raises the L-inf norm;
  4. a single Fourier mode decays by exactly exp(-4 pi^2 |m|^2 s) (tol 1e-8);
  5. the norm profile is finite, positive, and attains its sup in the
     interior of the s-grid (the marker in the video sits on a real max).
"""

import os

import numpy as np

# --------------------------------------------------------------------------- #
# spectral machinery on the unit torus
# --------------------------------------------------------------------------- #
N_GRID = 96  # computation grid; display objects sample from this


def grid(n=N_GRID):
    x = np.arange(n) / n
    return np.meshgrid(x, x, indexing="xy")  # X varies along axis 1, Y along 0


def _wavenumbers(n):
    k = 2 * np.pi * np.fft.fftfreq(n, d=1.0 / n)  # 2*pi*m for integer m
    return np.meshgrid(k, k, indexing="xy")


def ddx(f):
    n = f.shape[0]
    kx, _ = _wavenumbers(n)
    return np.real(np.fft.ifft2(1j * kx * np.fft.fft2(f)))


def ddy(f):
    n = f.shape[0]
    _, ky = _wavenumbers(n)
    return np.real(np.fft.ifft2(1j * ky * np.fft.fft2(f)))


def curl(a1, a2):
    """Curvature of A = a1 dx + a2 dy: f = d(A) = (dx a2 - dy a1)."""
    return ddx(a2) - ddy(a1)


def grad_sup(f):
    """sup |grad f| over the grid (pointwise Euclidean norm)."""
    return float(np.max(np.hypot(ddx(f), ddy(f))))


def heat(f0, s):
    """e^{s Laplacian} f0 — the exact spectral heat solution on T^2."""
    if s <= 0:
        return f0.copy()
    n = f0.shape[0]
    kx, ky = _wavenumbers(n)
    return np.real(np.fft.ifft2(np.exp(-(kx**2 + ky**2) * s) * np.fft.fft2(f0)))


# --------------------------------------------------------------------------- #
# the fields the video shows (fixed, seeded, band-limited)
# --------------------------------------------------------------------------- #
def trig(n, modes):
    """Sum of cosine modes: [(mx, my, amp, phase), ...] on the n-grid."""
    X, Y = grid(n)
    f = np.zeros((n, n))
    for mx, my, amp, ph in modes:
        f += amp * np.cos(2 * np.pi * (mx * X + my * Y) + ph)
    return f


#: the tame connection A — beat 1's "field one"
A1_MODES = [(0, 1, 0.80, 0.0), (1, 1, 0.45, 1.1)]
A2_MODES = [(1, 0, 0.80, -np.pi / 2), (1, -1, 0.45, 0.4)]
#: the relabeling angle theta — its gradient makes "field two" look wild
#: (amplitudes tuned so |A + d theta| is ~3-4x |A|: field one's arrows stay
#: visible when both fields share one honest length scale)
TH_MODES = [(2, 1, 0.15, 0.0), (1, -2, 0.12, 2.0), (3, -1, 0.09, 0.7)]


def field_A(n=N_GRID):
    return trig(n, A1_MODES), trig(n, A2_MODES)


def theta(n=N_GRID):
    return trig(n, TH_MODES)


def field_A_wild(n=N_GRID):
    """A + d(theta): the same field as A, wearing a wild label."""
    a1, a2 = field_A(n)
    th = theta(n)
    return a1 + ddx(th), a2 + ddy(th)


ROUGH_SEED = 12


def rough_curvature(n=N_GRID, kmax=6, alpha=0.8, seed=ROUGH_SEED):
    """A rough, zero-mean random curvature: modes |m| <= kmax, amp ~ |m|^-alpha.

    Built by spectral synthesis with a fixed seed, normalised to max |f| = 1.
    This is beat 3's initial data.
    """
    rng = np.random.default_rng(seed)
    c = np.zeros((n, n), dtype=complex)
    ms = np.fft.fftfreq(n, d=1.0 / n).astype(int)
    for i, my in enumerate(ms):
        for j, mx in enumerate(ms):
            r = np.hypot(mx, my)
            if 0 < r <= kmax:
                c[i, j] = (rng.standard_normal() + 1j * rng.standard_normal()) / r**alpha
    f = np.real(np.fft.ifft2(c))
    f -= f.mean()
    return f / np.max(np.abs(f))


# --------------------------------------------------------------------------- #
# the invariant-norm profile (abelian stand-in: DF = grad F)
# --------------------------------------------------------------------------- #
KAPPA = 0.25  # a concrete kappa in (0, 1/2)


def norm_profile(f0, kappa=KAPPA, s_grid=None):
    """N(s) = s^{k/2} ( s^{1/2} ||f(s)||_inf + s ||grad f(s)||_inf ).

    Returns (s_grid, N values). The invariant norm of the stand-in is max(N).
    """
    if s_grid is None:
        s_grid = np.geomspace(1e-4, 1.0, 60)
    vals = []
    for s in s_grid:
        fs = heat(f0, s)
        vals.append(s ** (kappa / 2) * (np.sqrt(s) * float(np.max(np.abs(fs))) + s * grad_sup(fs)))
    return np.asarray(s_grid), np.asarray(vals)


def flow_frames(f0, s_values):
    """Heat-flow snapshots at the given s values (s=0 allowed)."""
    return [heat(f0, s) for s in s_values]


# --------------------------------------------------------------------------- #
# self-checks — run at import, raise loudly
# --------------------------------------------------------------------------- #
def _selfcheck_gaugeflow():
    n = N_GRID
    a1, a2 = field_A(n)
    f = curl(a1, a2)

    # 1. curvature of a periodic 1-form has zero mean
    assert abs(f.mean()) < 1e-12, f"curvature mean {f.mean()} != 0"
    assert np.max(np.abs(f)) > 0.5, "field A is degenerate"

    # 2. gauge invariance: curl(A + d theta) == curl(A)
    w1, w2 = field_A_wild(n)
    fw = curl(w1, w2)
    assert np.max(np.abs(fw - f)) < 1e-10, "curvature moved under a relabeling"
    # ...and the relabeling is genuinely wild in the connection itself
    assert np.max(np.hypot(w1, w2)) > 2.5 * np.max(np.hypot(a1, a2)), "theta too tame to teach"

    # 3. a heat step conserves the mean and never raises the L-inf norm
    g0 = rough_curvature(n)
    assert abs(g0.mean()) < 1e-12
    prev = float(np.max(np.abs(g0)))
    for s in (1e-4, 1e-3, 1e-2, 1e-1, 1.0):
        gs = heat(g0, s)
        assert abs(gs.mean() - g0.mean()) < 1e-12, f"heat step moved the mean at s={s}"
        cur = float(np.max(np.abs(gs)))
        assert cur <= prev + 1e-12, f"L-inf grew under heat at s={s}: {prev} -> {cur}"
        prev = cur

    # 4. single mode decays by exactly exp(-4 pi^2 |m|^2 s)
    single = trig(n, [(2, 1, 1.0, 0.3)])  # |m|^2 = 5
    for s in (1e-3, 1e-2, 1e-1):
        expect = np.exp(-4 * np.pi**2 * 5 * s) * single
        got = heat(single, s)
        assert np.max(np.abs(got - expect)) < 1e-8, f"single-mode decay off at s={s}"

    # 5. the norm profile is finite, positive, sup in the interior
    s_grid, prof = norm_profile(g0)
    assert np.all(np.isfinite(prof)) and prof.max() > 0
    i = int(np.argmax(prof))
    assert 0 < i < len(prof) - 1, f"norm sup sits on the s-grid edge (i={i})"


if not os.environ.get("MATHVIZ_SKIP_SELFCHECK"):
    _selfcheck_gaugeflow()
