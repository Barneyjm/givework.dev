#!/usr/bin/env node
// Automated quality gate for a contributed explainer video.
//
//   node render_check.mjs <video.mp4> [--starts narration_<slug>/starts.json] [--json]
//
// A volunteer's scene can render "successfully" and still be unshippable: a beat
// that draws nothing, text pushed off the frame, a palette that isn't ours, or an
// audio mix that clips or shrieks. Rendering is the cheap part to verify; this is
// the part that would otherwise need a human to sit and watch every submission.
//
// Frames are inspected where it matters — the middle of each narration beat, read
// from starts.json when available, so we look at settled compositions rather than
// mid-transition blurs. Everything is measured through ffmpeg (raw RGB for the
// frames, ebur128/astats/aspectralstats for the mix), so there are no image or
// DSP dependencies to install in a sandbox.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The house palette. Anything far from these is either a stray Manim default
// (bright white, pure red) or an off-brand colour a contributor picked.
const PALETTE = [
  [244, 241, 230], // paper
  [22, 19, 16], // ink
  [225, 52, 43], // red
  [33, 68, 156], // blue
  [243, 194, 10], // yellow
  [30, 125, 70], // green
];

const LIMITS = {
  // Ink = anything not close to the paper background.
  minInk: 0.004, // a beat that draws essentially nothing
  maxInk: 0.62, // a wall of text, or overlapping blobs
  maxOffPalette: 0.3, // share of ink far from any palette blend (advisory)
  maxEdgeInk: 0.05, // ink in the outer margin => content clipped or off-frame
  edgeMargin: 0.025, // outer 2.5% of each side
  // Audio, as an EBU R128 mix.
  lufsMin: -26,
  lufsMax: -9,
  truePeakMax: -0.5, // dBTP; above this a lossy re-encode can clip
  maxClippedRatio: 0.0002,
  maxSilenceShare: 0.35, // narration should be doing something most of the time
  minSpectralCentroid: 180, // Hz — a mix this dark is probably broken
  maxSpectralCentroid: 6200, // …this bright is harsh/hissy
  // Measured: a 3 kHz pure tone reads 0.007, a real narration+music mix reads
  // 0.086 — a 12x gap. Sit well below the healthy value so a sparse moment in a
  // legitimate mix can't trip it.
  minFlatness: 0.02,
};

const ff = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
    encoding: 'buffer',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
// ebur128/astats/silencedetect write their reports to STDERR, so both streams
// have to be read or every measurement comes back null.
const ffText = (args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
};
const probe = (args) =>
  execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' }).trim();

function near(px, py, pz, [r, g, b], tol) {
  return Math.abs(px - r) <= tol && Math.abs(py - g) <= tol && Math.abs(pz - b) <= tol;
}

/**
 * Distance from a pixel to the blend line between two colours.
 *
 * Antialiasing puts pixels *between* a shape's colour and the background — grey
 * between ink and paper, pink between red and paper — so testing proximity to the
 * palette entries alone rejects every soft edge in a perfectly good frame. What
 * is legitimate is anything close to a linear blend of paper and one palette
 * colour, which is exactly a point near that segment in RGB space.
 */
function distToBlend(px, py, pz, from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len2 = dx * dx + dy * dy + dz * dz || 1;
  let t = ((px - from[0]) * dx + (py - from[1]) * dy + (pz - from[2]) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = from[0] + t * dx;
  const cy = from[1] + t * dy;
  const cz = from[2] + t * dz;
  return Math.hypot(px - cx, py - cy, pz - cz);
}

const BLEND_TOL = 46;
/** True if the pixel lies near a blend of any two palette colours. */
function onAnyBlendLine(r, g, b) {
  for (let i = 0; i < PALETTE.length; i++) {
    for (let j = i; j < PALETTE.length; j++) {
      if (distToBlend(r, g, b, PALETTE[i], PALETTE[j]) <= BLEND_TOL) return true;
    }
  }
  return false;
}

/** Decode one frame to small raw RGB and measure ink, palette drift and edge bleed. */
function inspectFrame(video, t) {
  const W = 96;
  const H = 54;
  const raw = ff([
    '-ss', String(t), '-i', video, '-frames:v', '1',
    '-vf', `scale=${W}:${H}:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  const total = W * H;
  if (raw.length < total * 3) return null;

  const mx = Math.max(1, Math.round(W * LIMITS.edgeMargin));
  const my = Math.max(1, Math.round(H * LIMITS.edgeMargin));
  let ink = 0;
  let off = 0;
  let edgeInk = 0;
  let edgeTotal = 0;
  for (let i = 0; i < total; i++) {
    const r = raw[i * 3];
    const g = raw[i * 3 + 1];
    const b = raw[i * 3 + 2];
    const x = i % W;
    const y = (i / W) | 0;
    const isInk = !near(r, g, b, PALETTE[0], 26); // not paper
    if (isInk) ink++;
    // off-palette: not within tolerance of ANY palette entry. Generous, because
    // antialiasing blends toward the background.
    // Legitimate pixels sit on a blend line between SOME PAIR of palette colours:
    // antialiasing blends toward whatever is behind, and Manim's fill_opacity
    // mixes a shape with the layer under it, not only with the background.
    if (isInk && !onAnyBlendLine(r, g, b)) off++;
    const onEdge = x < mx || x >= W - mx || y < my || y >= H - my;
    if (onEdge) {
      edgeTotal++;
      if (isInk) edgeInk++;
    }
  }
  return {
    t: Number(t.toFixed(2)),
    ink: ink / total,
    off_palette: ink ? off / ink : 0,
    edge_ink: edgeTotal ? edgeInk / edgeTotal : 0,
  };
}

/** Beat midpoints from starts.json, else evenly spaced samples. */
function sampleTimes(duration, startsPath) {
  if (startsPath && fs.existsSync(startsPath)) {
    const starts = JSON.parse(fs.readFileSync(startsPath, 'utf8'));
    if (Array.isArray(starts) && starts.length) {
      return starts.map((s, i) => {
        const next = i + 1 < starts.length ? starts[i + 1].start : duration;
        return { name: s.name, t: s.start + (next - s.start) * 0.62 };
      });
    }
  }
  const n = 8;
  return Array.from({ length: n }, (_, i) => ({
    name: `t${i + 1}`,
    t: (duration * (i + 0.5)) / n,
  }));
}

function analyseAudio(video, duration) {
  const hasAudio = probe([
    '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', video,
  ]);
  if (!hasAudio) return { present: false };

  const r128 = ffText(['-i', video, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
  const pick = (re) => {
    const m = [...r128.matchAll(re)];
    return m.length ? Number(m[m.length - 1][1]) : null;
  };
  const integrated = pick(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
  const truePeak = pick(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g);
  const lra = pick(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/g);

  const st = ffText([
    '-i', video,
    // ametadata=print is required: aspectralstats only *sets* frame metadata,
    // it doesn't report it, so without this the spectrum comes back empty.
    '-af',
    'astats=metadata=1:reset=0,aspectralstats=measure=centroid+flatness,ametadata=print:file=-',
    '-f', 'null', '-',
  ]);
  const num = (label) => {
    const m = [...st.matchAll(new RegExp(`${label}:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g'))];
    return m.length ? Number(m[m.length - 1][1]) : null;
  };
  const flatCount = num('Number of samples with absolute value >= 1') ?? num('Peak count');
  const totalSamples = num('Number of samples');
  const centroidMatches = [...st.matchAll(/centroid=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const flatnessMatches = [...st.matchAll(/flatness=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

  // Share of the run that is effectively silent.
  const sil = ffText([
    '-i', video, '-af', 'silencedetect=noise=-50dB:d=0.6', '-f', 'null', '-',
  ]);
  const silence = [...sil.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/g)].reduce(
    (s, m) => s + Number(m[1]),
    0,
  );

  return {
    present: true,
    integrated_lufs: integrated,
    true_peak_dbfs: truePeak,
    lra_lu: lra,
    clipped_ratio: flatCount && totalSamples ? flatCount / totalSamples : 0,
    silence_share: duration ? silence / duration : 0,
    spectral_centroid_hz: mean(centroidMatches),
    spectral_flatness: mean(flatnessMatches),
  };
}

function main() {
  const args = process.argv.slice(2);
  const video = args.find((a) => !a.startsWith('--'));
  if (!video) {
    console.error('usage: render_check.mjs <video.mp4> [--starts starts.json] [--json]');
    process.exit(2);
  }
  const startsPath = args.includes('--starts') ? args[args.indexOf('--starts') + 1] : null;
  const asJson = args.includes('--json');

  const duration = Number(
    probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', video]),
  );
  const size = probe([
    '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video,
  ]);

  const failures = [];
  const warnings = [];

  // --- frames ---
  const frames = [];
  for (const { name, t } of sampleTimes(duration, startsPath)) {
    let f = inspectFrame(video, t);
    // A single blank sample is more often a cross-fade than an empty beat, so
    // probe either side before calling it: a transition recovers, a genuinely
    // empty beat stays empty.
    if (f && f.ink < LIMITS.minInk) {
      for (const dt of [0.6, -0.6, 1.2]) {
        const alt = t + dt;
        if (alt <= 0.05 || alt >= duration - 0.05) continue;
        const g = inspectFrame(video, alt);
        if (g && g.ink >= LIMITS.minInk) {
          f = g;
          break;
        }
      }
    }
    if (!f) {
      failures.push(`beat "${name}": no frame could be decoded at ${t.toFixed(1)}s`);
      continue;
    }
    f.name = name;
    frames.push(f);
    if (f.ink < LIMITS.minInk) {
      failures.push(
        `beat "${name}" at ${f.t}s draws almost nothing (${(f.ink * 100).toFixed(2)}% ink) — an empty beat`,
      );
    } else if (f.ink > LIMITS.maxInk) {
      failures.push(
        `beat "${name}" at ${f.t}s is ${(f.ink * 100).toFixed(0)}% covered — overcrowded or overlapping`,
      );
    }
    // A warning, deliberately. Measured against the 23 shipped videos, several
    // good scenes drift 11-15% through opacity blends and hand-picked shades;
    // rejecting those would throw away perfectly shippable work. Surface it for a
    // maintainer's eye instead.
    if (f.off_palette > LIMITS.maxOffPalette) {
      warnings.push(
        `beat "${name}" at ${f.t}s: ${(f.off_palette * 100).toFixed(0)}% of its ink is off-palette`,
      );
    }
    if (f.edge_ink > LIMITS.maxEdgeInk) {
      failures.push(
        `beat "${name}" at ${f.t}s has ink in the outer margin (${(f.edge_ink * 100).toFixed(0)}%) — content is clipped or off-frame`,
      );
    }
  }
  // A scene that never changes is a still, not an explainer.
  const distinct = new Set(frames.map((f) => f.ink.toFixed(3)));
  if (frames.length > 2 && distinct.size === 1) {
    warnings.push('every sampled beat looks identical — the scene may not be animating');
  }

  // --- audio ---
  const audio = analyseAudio(video, duration);
  if (!audio.present) {
    warnings.push('no audio track (expected for a scene-only render, not for a final cut)');
  } else {
    const a = audio;
    if (a.integrated_lufs != null && (a.integrated_lufs < LIMITS.lufsMin || a.integrated_lufs > LIMITS.lufsMax)) {
      failures.push(
        `loudness ${a.integrated_lufs} LUFS is outside ${LIMITS.lufsMin}..${LIMITS.lufsMax} — too quiet to hear or too hot`,
      );
    }
    if (a.true_peak_dbfs != null && a.true_peak_dbfs > LIMITS.truePeakMax) {
      failures.push(`true peak ${a.true_peak_dbfs} dBFS risks clipping (limit ${LIMITS.truePeakMax})`);
    }
    if (a.clipped_ratio > LIMITS.maxClippedRatio) {
      failures.push(`${(a.clipped_ratio * 100).toFixed(3)}% of samples are clipped`);
    }
    if (a.silence_share > LIMITS.maxSilenceShare) {
      warnings.push(`${(a.silence_share * 100).toFixed(0)}% of the run is silent`);
    }
    if (a.spectral_centroid_hz != null) {
      if (a.spectral_centroid_hz > LIMITS.maxSpectralCentroid) {
        failures.push(
          `spectral centroid ${Math.round(a.spectral_centroid_hz)} Hz — the mix is harsh/hissy`,
        );
      } else if (a.spectral_centroid_hz < LIMITS.minSpectralCentroid) {
        warnings.push(`spectral centroid ${Math.round(a.spectral_centroid_hz)} Hz — the mix is very dark`);
      }
    }
    if (
      a.spectral_flatness != null &&
      a.spectral_flatness < LIMITS.minFlatness &&
      (a.integrated_lufs ?? -99) > -30
    ) {
      failures.push(
        `spectral flatness ${a.spectral_flatness} at ${a.integrated_lufs} LUFS — a loud pure tone (squeal/feedback)`,
      );
    }
  }

  const report = {
    video: path.basename(video),
    duration_s: Number(duration.toFixed(2)),
    resolution: size,
    verdict: failures.length ? 'fail' : 'pass',
    failures,
    warnings,
    frames,
    audio,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`${report.verdict.toUpperCase()}  ${report.video}  ${size}  ${report.duration_s}s`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    for (const w of warnings) console.log(`  ! ${w}`);
    if (audio.present) {
      console.log(
        `  audio: ${audio.integrated_lufs} LUFS, peak ${audio.true_peak_dbfs} dBFS, ` +
          `centroid ${Math.round(audio.spectral_centroid_hz ?? 0)} Hz, ` +
          `silence ${(audio.silence_share * 100).toFixed(0)}%`,
      );
    }
  }
  process.exit(failures.length ? 1 : 0);
}

main();
