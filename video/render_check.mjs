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
  minInk: 0.004, // a beat that draws essentially nothing, in absolute terms
  // …but "empty" is really relative. A fixed floor can't tell a deliberately
  // sparse style from a beat that failed to draw: a five-minute video shipped
  // with a closing beat at ~0.5% ink while its healthy beats sat at 15-25%, and
  // 0.5% clears any floor low enough to permit a minimal style. So also compare
  // each beat against the median of THIS video's beats.
  minInkRatioOfMedian: 0.25,
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
  // Mono fold-down: phones and laptop speakers sum L+R. Narration pasted
  // out-of-phase across channels cancels there while sounding fine in headphones.
  // NOTE the baseline: EBU R128 sums channel energies, so a perfectly correlated
  // stereo pair ALREADY measures ~3 LU quieter once folded to mono. Only a drop
  // materially beyond that indicates real cancellation.
  maxMonoDropLu: 7, // stereo->mono loss beyond this is phase cancellation
  maxLra: 20, // LU; wider than this jumps between whisper and shout
  maxDcOffset: 0.02, // wasted headroom, and clicks at edits
  maxChannelImbalance: 6, // dB between L and R
  // Photosensitivity: rapid large luminance swings. Broadcast QC (Harding)
  // rejects >3 flashes/second; this is a safety property, not a taste one.
  maxFlashesPerSec: 3,
  flashLumaDelta: 20, // 0-255 mean-luma jump that counts as a flash
  // A held diagram is the FORMAT, not a fault: every beat draws in a few seconds
  // then holds while ~20s of narration explains it, so these videos are static
  // most of the time by design. What is actually broken is a held frame with
  // nothing being said over it — that is a beat that ran dry or a render that
  // died. So freezes are only reported when they overlap silence.
  maxFreezeSeconds: 8,
  maxSilentFreezeSeconds: 4,
  // Broadcast keeps text inside a title-safe box (~10%); the 2.5% edge test only
  // catches content actually falling off. This is the softer legibility rule.
  titleSafe: 0.1,
  maxTitleSafeInk: 0.22,
  // Narration cut mid-word at the tail — the render ended before the voice did.
  tailWindow: 0.45, // seconds examined at the very end
  maxTailLevelDb: -34, // still this loud at the cut => speech was truncated

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
  let tsInk = 0;
  let tsTotal = 0;
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
    const tx = Math.round(W * LIMITS.titleSafe);
    const ty = Math.round(H * LIMITS.titleSafe);
    const outsideTitleSafe = x < tx || x >= W - tx || y < ty || y >= H - ty;
    if (outsideTitleSafe) {
      tsTotal++;
      if (isInk) tsInk++;
    }
  }
  return {
    t: Number(t.toFixed(2)),
    ink: ink / total,
    off_palette: ink ? off / ink : 0,
    edge_ink: edgeTotal ? edgeInk / edgeTotal : 0,
    title_safe_ink: tsTotal ? tsInk / tsTotal : 0,
  };
}

/** Beat midpoints from starts.json, else evenly spaced samples. */
function sampleTimes(duration, startsPath) {
  if (startsPath && fs.existsSync(startsPath)) {
    const starts = JSON.parse(fs.readFileSync(startsPath, 'utf8'));
    if (Array.isArray(starts) && starts.length) {
      return starts.map((s, i) => {
        const next = i + 1 < starts.length ? starts[i + 1].start : duration;
        return { name: s.name, t: s.start + (next - s.start) * 0.62, start: s.start, end: next };
      });
    }
  }
  const n = 8;
  return Array.from({ length: n }, (_, i) => ({
    name: `t${i + 1}`,
    t: (duration * (i + 0.5)) / n,
    start: (duration * i) / n,
    end: (duration * (i + 1)) / n,
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

  // Mono fold-down. Sum to one channel and re-measure: if the narration was
  // out of phase between L and R it largely cancels, and the loudness collapses.
  const monoTxt = ffText([
    '-i', video, '-filter_complex', 'pan=mono|c0=0.5*c0+0.5*c1,ebur128', '-f', 'null', '-',
  ]);
  const monoM = [...monoTxt.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  const monoLufs = monoM.length ? Number(monoM[monoM.length - 1][1]) : null;
  const monoDrop =
    integrated != null && monoLufs != null ? Number((integrated - monoLufs).toFixed(2)) : null;

  const dc = num('DC offset');
  // per-channel RMS, to catch narration sitting in one ear
  const rmsAll = [...st.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const imbalance = rmsAll.length >= 3 ? Math.abs(rmsAll[0] - rmsAll[1]) : 0;

  return {
    present: true,
    integrated_lufs: integrated,
    mono_lufs: monoLufs,
    mono_drop_lu: monoDrop,
    dc_offset: dc == null ? null : Math.abs(dc),
    channel_imbalance_db: Number(imbalance.toFixed(2)),
    true_peak_dbfs: truePeak,
    lra_lu: lra,
    clipped_ratio: flatCount && totalSamples ? flatCount / totalSamples : 0,
    silence_share: duration ? silence / duration : 0,
    spectral_centroid_hz: mean(centroidMatches),
    spectral_flatness: mean(flatnessMatches),
  };
}

/**
 * Mean luma per frame (2 fps is plenty for both purposes), used for two checks a
 * broadcast QC pass would insist on: rapid flashing, which is a photosensitivity
 * hazard, and long motionless stretches, which mean the render stalled.
 */
function lumaTimeline(video) {
  const txt = ffText([
    '-i', video, '-vf', 'fps=2,scale=32:18,signalstats,metadata=print:file=-',
    '-f', 'null', '-',
  ]);
  return [...txt.matchAll(/lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)/g)].map((m) =>
    Number(m[1]),
  );
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
  for (const { name, t, start: beatStart, end: beatEnd } of sampleTimes(duration, startsPath)) {
    let f = inspectFrame(video, t);
    // A blank sample is ambiguous: it might be a cross-fade, or the beat might
    // genuinely be empty. The first version of this rescued the whole beat as
    // soon as ANY nearby probe had ink — which let a five-minute video ship with
    // a nearly-blank closing beat (0.2% ink where healthy beats sit at 15-25%),
    // because one probe in the fade found something. So sample ACROSS the beat
    // and judge on the median: a transition is a dip, an empty beat is a floor.
    if (f && f.ink < LIMITS.minInk) {
      const span = Math.max(1.5, (beatEnd ?? t + 3) - (beatStart ?? t - 1));
      const probes = [];
      for (const frac of [0.15, 0.35, 0.55, 0.75, 0.95]) {
        const at = (beatStart ?? t) + span * frac;
        if (at <= 0.05 || at >= duration - 0.05) continue;
        const g = inspectFrame(video, at);
        if (g) probes.push(g);
      }
      if (probes.length) {
        const sorted = [...probes].sort((a, b) => a.ink - b.ink);
        const median = sorted[Math.floor(sorted.length / 2)];
        // Keep the median sample: it represents what the beat mostly looks like.
        f = median;
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
    if (f.title_safe_ink > LIMITS.maxTitleSafeInk && f.edge_ink <= LIMITS.maxEdgeInk) {
      warnings.push(
        `beat "${name}" at ${f.t}s puts ${(f.title_safe_ink * 100).toFixed(0)}% of its ink outside the title-safe area`,
      );
    }
    if (f.edge_ink > LIMITS.maxEdgeInk) {
      failures.push(
        `beat "${name}" at ${f.t}s has ink in the outer margin (${(f.edge_ink * 100).toFixed(0)}%) — content is clipped or off-frame`,
      );
    }
  }
  // Relative emptiness: a beat far below this video's own norm didn't draw.
  if (frames.length >= 4) {
    const inks = frames.map((f) => f.ink).sort((a, b) => a - b);
    const median = inks[Math.floor(inks.length / 2)];
    const floor = median * LIMITS.minInkRatioOfMedian;
    for (const f of frames) {
      if (f.ink < floor && f.ink < 0.05) {
        failures.push(
          `beat "${f.name}" at ${f.t}s draws ${(f.ink * 100).toFixed(1)}% ink against this ` +
            `video's median of ${(median * 100).toFixed(0)}% — it is nearly blank next to its own siblings`,
        );
      }
    }
  }

  // A scene that never changes is a still, not an explainer.
  const distinct = new Set(frames.map((f) => f.ink.toFixed(3)));
  if (frames.length > 2 && distinct.size === 1) {
    warnings.push('every sampled beat looks identical — the scene may not be animating');
  }

  // --- motion: flashing and freezes ---
  const luma = lumaTimeline(video);
  let flashes = 0;
  for (let i = 1; i < luma.length; i++) {
    if (Math.abs(luma[i] - luma[i - 1]) >= LIMITS.flashLumaDelta) flashes++;
  }
  // Mean luma is far too coarse for stillness — a caption fading in at one corner
  // barely moves it. freezedetect compares whole frames, which is the real question.
  const fz = ffText([
    '-i', video, '-vf', `freezedetect=n=-58dB:d=${LIMITS.maxFreezeSeconds}`, '-f', 'null', '-',
  ]);
  const freezes = [];
  {
    const starts = [...fz.matchAll(/freeze_start:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    const durs = [...fz.matchAll(/freeze_duration:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    for (let i = 0; i < Math.min(starts.length, durs.length); i++) {
      freezes.push({ start: starts[i], end: starts[i] + durs[i], dur: durs[i] });
    }
  }
  const longestFreeze = freezes.reduce((a, f) => Math.max(a, f.dur), 0);

  // Silence intervals, to intersect against the freezes.
  const silTxt = ffText(['-i', video, '-af', 'silencedetect=noise=-50dB:d=1.0', '-f', 'null', '-']);
  const silStarts = [...silTxt.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m) =>
    Number(m[1]),
  );
  const silEnds = [...silTxt.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map((m) =>
    Number(m[1]),
  );
  const silences = silStarts.map((st, i) => ({ start: st, end: silEnds[i] ?? duration }));
  // The real defect: a frame that holds while nothing is being said.
  let worstSilentFreeze = 0;
  for (const f of freezes) {
    for (const sl of silences) {
      const overlap = Math.min(f.end, sl.end) - Math.max(f.start, sl.start);
      if (overlap > worstSilentFreeze) worstSilentFreeze = overlap;
    }
  }
  const flashesPerSec = duration ? flashes / duration : 0;
  const motion = {
    samples: luma.length,
    flashes,
    flashes_per_sec: Number(flashesPerSec.toFixed(2)),
    longest_freeze_s: Number(longestFreeze.toFixed(1)),
    // Reported for context: these videos hold a diagram while narrating, so a
    // long freeze on its own is the format working, not a fault.
    silent_freeze_s: Number(worstSilentFreeze.toFixed(1)),
  };
  if (flashesPerSec > LIMITS.maxFlashesPerSec) {
    failures.push(
      `${motion.flashes_per_sec} large luminance changes per second — a photosensitivity hazard (limit ${LIMITS.maxFlashesPerSec}/s)`,
    );
  }
  if (worstSilentFreeze > LIMITS.maxSilentFreezeSeconds) {
    warnings.push(
      `${worstSilentFreeze.toFixed(1)}s where the picture is frozen AND nothing is said — a beat that ran dry`,
    );
  }

  // --- tail: did the render stop while the voice was still going? ---
  const tailStart = Math.max(0, duration - LIMITS.tailWindow);
  const tailTxt = ffText([
    '-ss', String(tailStart), '-i', video, '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-',
  ]);
  const tailRms = [...tailTxt.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g)].map((m) =>
    Number(m[1]),
  );
  const tailLevel = tailRms.length ? Math.max(...tailRms) : null;
  if (tailLevel != null && tailLevel > LIMITS.maxTailLevelDb) {
    warnings.push(
      `audio is still at ${tailLevel} dB in the final ${LIMITS.tailWindow}s — the narration may be cut off mid-word`,
    );
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
    // Digital silence makes the peak-count parse meaningless (and it reported
    // "100% clipped" on a silent file, which is simply untrue). A silent track is
    // already failed by the loudness gate; don't also assert something false.
    if (a.clipped_ratio > LIMITS.maxClippedRatio && (a.integrated_lufs ?? -99) > -50) {
      failures.push(`${(a.clipped_ratio * 100).toFixed(3)}% of samples are clipped`);
    }
    if (a.mono_drop_lu != null && a.mono_drop_lu > LIMITS.maxMonoDropLu) {
      failures.push(
        `folding to mono loses ${a.mono_drop_lu} LU (${a.integrated_lufs} -> ${a.mono_lufs}) — ` +
          `the mix cancels on phone speakers (about 3 LU is normal)`,
      );
    }
    if (a.dc_offset != null && a.dc_offset > LIMITS.maxDcOffset) {
      failures.push(`DC offset ${a.dc_offset} wastes headroom and clicks at edits`);
    }
    if (a.channel_imbalance_db > LIMITS.maxChannelImbalance) {
      warnings.push(`channels differ by ${a.channel_imbalance_db} dB — the mix leans to one ear`);
    }
    if (a.lra_lu != null && a.lra_lu > LIMITS.maxLra) {
      warnings.push(`loudness range ${a.lra_lu} LU — it jumps between whisper and shout`);
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
    motion,
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
          `mono -${audio.mono_drop_lu ?? 0} LU, ` +
          `silence ${(audio.silence_share * 100).toFixed(0)}%`,
      );
      console.log(
        `  motion: ${motion.flashes_per_sec}/s flashes, longest hold ${motion.longest_freeze_s}s ` +
          `(${motion.silent_freeze_s}s of it silent)`,
      );
    }
  }
  process.exit(failures.length ? 1 : 0);
}

main();
