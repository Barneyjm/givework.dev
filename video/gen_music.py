"""Upbeat-but-calm original bed for the explainer: a bright I–V–vi–IV
progression (C–G–Am–F) with a soft plucked arpeggio for forward motion, a warm
pad underneath, and a light bass. Fully original — no licensing.

    python3 gen_music.py <seconds> <out.wav>
"""
import sys

import numpy as np
import soundfile as sf

SR = 48000
BPM = 96.0
BEAT = 60.0 / BPM          # 0.625s
BAR = 4 * BEAT             # 2.5s, one chord per bar
EIGHTH = BEAT / 2


def _t(dur):
    return np.linspace(0, dur, int(SR * dur), endpoint=False)


def pad_note(freq, dur):
    """Soft sustained pad tone with slow tremolo."""
    t = _t(dur)
    trem = 1.0 + 0.05 * np.sin(2 * np.pi * 0.2 * t + freq)
    y = np.sin(2 * np.pi * freq * t) + 0.28 * np.sin(2 * np.pi * 2 * freq * t)
    # gentle attack/release so bars blend
    env = np.ones_like(t)
    a = int(SR * 0.15)
    env[:a] = np.linspace(0, 1, a)
    env[-a:] = np.linspace(1, 0, a)
    return (y * trem * env).astype(np.float32)


def pluck(freq, dur=EIGHTH * 1.6):
    """A soft, rounded pluck. Mostly fundamental with only a whisper of 2nd
    harmonic — the earlier bright 2nd/3rd partials poked through the voice.

    The envelope has to reach zero at BOTH ends. `exp(-t*6)` alone starts at
    full amplitude on sample zero and is cut off while still at ~5%, so every
    note began and ended on a step discontinuity. A step is broadband: each one
    is a click, and at eighth notes this lays a few clicks per second across the
    whole video. Measured, it pushed the bed's spectral flatness above 2 kHz to
    0.40 (noise-like) against 0.011 for the voice — audible as constant static.
    """
    t = _t(dur)
    env = np.exp(-t * 6.0)
    a = max(1, int(SR * 0.008))   # 8ms attack, enough to kill the onset click
    env[:a] *= np.linspace(0.0, 1.0, a)
    r = max(1, int(SR * 0.020))   # 20ms release, so it lands on silence
    env[-r:] *= np.linspace(1.0, 0.0, r)
    y = np.sin(2 * np.pi * freq * t) + 0.18 * np.sin(2 * np.pi * 2 * freq * t)
    return (y * env).astype(np.float32)


def place(buf, clip, start_sample, gain=1.0):
    if start_sample >= buf.size:
        return
    end = start_sample + clip.size
    if end > buf.size:
        clip = clip[: buf.size - start_sample]
        end = buf.size
    buf[start_sample:end] += clip * gain


def render(total, detune=0.0):
    n = int(SR * total)
    buf = np.zeros(n, dtype=np.float32)

    def d(f):
        return f * (2 ** (detune / 1200.0))

    # C – G – Am – F  (triads + root), and an ascending arp pattern per bar.
    prog = [
        dict(pad=[261.63, 329.63, 392.00], bass=130.81, arp=[261.63, 329.63, 392.00, 523.25]),  # C
        dict(pad=[246.94, 293.66, 392.00], bass=98.00, arp=[246.94, 293.66, 392.00, 493.88]),   # G
        dict(pad=[261.63, 329.63, 440.00], bass=110.00, arp=[329.63, 440.00, 523.25, 659.25]),  # Am
        dict(pad=[261.63, 349.23, 440.00], bass=174.61, arp=[349.23, 440.00, 523.25, 698.46]),  # F
    ]

    bar = 0
    while bar * BAR < total:
        ch = prog[bar % 4]
        bs = int(bar * BAR * SR)
        # pad chord for the bar
        pad = np.zeros(int(SR * BAR), dtype=np.float32)
        for f in ch["pad"]:
            pad += pad_note(d(f), BAR)
        place(buf, pad / len(ch["pad"]), bs, gain=0.55)
        # soft bass on beats 1 and 3
        for b in (0, 2):
            place(buf, pad_note(d(ch["bass"]), BEAT), bs + int(b * BEAT * SR), gain=0.35)
        # arpeggio: 8 eighth-notes cycling the arp tones (gives the upbeat motion).
        # Softer than the pad now so the motion is felt, not pokey.
        for i in range(8):
            f = ch["arp"][i % len(ch["arp"])]
            place(buf, pluck(d(f)), bs + int(i * EIGHTH * SR), gain=0.34)
        bar += 1
    return buf


def main():
    total = float(sys.argv[1]) if len(sys.argv) > 1 else 80.0
    out = sys.argv[2] if len(sys.argv) > 2 else "music.wav"
    left, right = render(total, -4.0), render(total, +4.0)
    stereo = np.stack([left, right], axis=1)
    stereo /= (np.max(np.abs(stereo)) + 1e-9)
    stereo *= 0.85
    n = stereo.shape[0]
    fin, fout = int(SR * 2.0), int(SR * 3.5)
    env = np.ones(n, dtype=np.float32)
    env[:fin] = np.linspace(0, 1, fin)
    env[-fout:] = np.linspace(1, 0, fout)
    stereo *= env[:, None]
    sf.write(out, stereo.astype(np.float32), SR)
    print(f"wrote {out}: {total:.1f}s upbeat bed @ {BPM:.0f} BPM")


if __name__ == "__main__":
    main()
