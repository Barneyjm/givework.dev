#!/usr/bin/env node
// Ink-dip profile of a video: node inkdips.mjs <video> [step_seconds]
//
// Samples ink coverage (anything not close to the paper background) through the
// whole run and reports the median, the render gate's relative floor
// (median * 0.25, same rule as render_check.mjs), and every stretch that falls
// below it. Where render_check.mjs judges each beat at its settled midpoint,
// this watches the transitions BETWEEN beats — the place "the frame went to
// nothing for a second and a half" hides from a midpoint sampler.
//
// Acceptance signature for a finished share cut: the ONLY sub-floor stretches
// are the two hard joins — the poster lead-in giving way to the opening beat,
// and the main piece handing over to the CTA outro. Anything else is a hole in
// a beat (a teardown that landed before its replacement) and goes back to the
// scene. Run it on the FINAL share file, after bolt_cta.sh.
import { execFileSync } from 'node:child_process';

const PAPER = [244, 241, 230];
const video = process.argv[2];
if (!video) {
  console.error('usage: inkdips.mjs <video> [step_seconds]');
  process.exit(2);
}
const step = Number(process.argv[3] || 0.5);
const W = 96;
const H = 54;
const total = W * H;

const raw = execFileSync(
  'ffmpeg',
  [
    '-hide_banner', '-nostdin', '-i', video,
    '-vf', `fps=${1 / step},scale=${W}:${H}:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ],
  { encoding: 'buffer', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] },
);
const n = Math.floor(raw.length / (total * 3));
const prof = [];
for (let k = 0; k < n; k++) {
  let ink = 0;
  const b = k * total * 3;
  for (let i = 0; i < total; i++) {
    const r = raw[b + i * 3];
    const g = raw[b + i * 3 + 1];
    const bl = raw[b + i * 3 + 2];
    const paper =
      Math.abs(r - PAPER[0]) <= 26 && Math.abs(g - PAPER[1]) <= 26 && Math.abs(bl - PAPER[2]) <= 26;
    if (!paper) ink++;
  }
  prof.push({ t: k * step, ink: ink / total });
}

const sorted = prof.map((p) => p.ink).sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const floor = med * 0.25;
// A sample fails the gate when ink < median*0.25 AND ink < 5% (absolute cap,
// so a dense video's dips aren't flagged while still visibly composed).
const bad = prof.filter((p) => p.ink < floor && p.ink < 0.05);
// group consecutive samples into runs
const runs = [];
for (const p of bad) {
  const last = runs[runs.length - 1];
  if (last && p.t - last.end <= step * 1.5) {
    last.end = p.t;
    last.min = Math.min(last.min, p.ink);
  } else {
    runs.push({ start: p.t, end: p.t, min: p.ink });
  }
}
const worst = prof.reduce((a, p) => (p.ink < a.ink ? p : a));
console.log(
  `${video.split('/').pop()} median=${(med * 100).toFixed(1)}% floor=${(floor * 100).toFixed(2)}% min=${(worst.ink * 100).toFixed(2)}%@${worst.t}s`,
);
if (!runs.length) console.log('  no sub-floor stretches');
for (const r of runs) {
  console.log(
    `  DIP ${r.start.toFixed(1)}-${(r.end + step).toFixed(1)}s (${(r.end + step - r.start).toFixed(1)}s) min ${(r.min * 100).toFixed(2)}%`,
  );
}
