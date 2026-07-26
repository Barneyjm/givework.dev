#!/usr/bin/env node
// Build caption files from a spec's narration and the beat timings the render
// emitted. Writes BOTH formats, because they serve different consumers:
//
//   <slug>.vtt  WebVTT — the only format a browser accepts in a <video><track>.
//   <slug>.srt  SubRip — what TikTok, Shorts and most editors ingest.
//
//   node make_captions.mjs <slug> [outDir]
//     SPEC_DIR   where <slug>.json lives (default: this directory)
//     NARR_DIR   where starts.json / durations.json live
//
// Most short-form video is watched muted, so an uncaptioned explainer reaches far
// fewer people than it should — and the words are already written down. Cues come
// from the narration text we recorded, timed by each beat's real start and
// duration, split at sentence boundaries and apportioned by length.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const slug = process.argv[2];
if (!slug) {
  console.error('usage: make_captions.mjs <slug> [out.srt]');
  process.exit(1);
}
const SPEC_DIR = process.env.SPEC_DIR ?? HERE;
const NARR_DIR = process.env.NARR_DIR ?? path.join(SPEC_DIR, `narration_${slug}`);
// Both files share a stem; pass a directory (or nothing) rather than a filename.
const outDir = process.argv[3] ?? '.';
const base = path.join(outDir, slug);
fs.mkdirSync(outDir, { recursive: true });

const spec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, `${slug}.json`), 'utf8'));
const starts = JSON.parse(fs.readFileSync(path.join(NARR_DIR, 'starts.json'), 'utf8'));
const durations = JSON.parse(fs.readFileSync(path.join(NARR_DIR, 'durations.json'), 'utf8'));

const stamp = (t, sep) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}${sep}${String(ms % 1000).padStart(3, '0')}`;
};
const MIN_CUE = 1.1; // a cue shorter than this reads as a flicker

// Two short lines read better than one long one on a phone.
function wrapCue(text, width = 42) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur ? `${cur} ${w}` : w).length > width && cur) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  // never more than two lines per cue: split into further cues instead
  const out = [];
  for (let i = 0; i < lines.length; i += 2) out.push(lines.slice(i, i + 2).join('\n'));
  return out;
}

const cues = [];
for (const beat of starts) {
  const text = spec.narration?.[beat.name];
  const dur = durations[beat.name];
  if (!text || !dur) continue;
  // Sentences, keeping their terminator.
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  const totalChars = sentences.reduce((n, s) => n + s.length, 0) || 1;
  let t = beat.start;
  for (const sentence of sentences) {
    // Speech time tracks character count closely enough for captions.
    const span = (sentence.length / totalChars) * dur;
    // Give each chunk time in proportion to ITS OWN length. Dividing a
    // sentence's span equally left an 84-character chunk on screen as briefly as
    // a 20-character one, which is what made cues read as unevenly rushed.
    const parts = wrapCue(sentence);
    const chars = parts.reduce((n, x) => n + x.replace(/\n/g, ' ').length, 0) || 1;
    for (const part of parts) {
      const share = (part.replace(/\n/g, ' ').length / chars) * span;
      cues.push({ start: t, end: t + share - 0.05, text: part });
      t += share;
    }
  }
}

// Merge away flicker-length cues instead of padding them. Padding would push the
// following cue later and drift out of sync with the voice; merging keeps every
// remaining cue anchored to the speech.
for (let i = cues.length - 2; i >= 0; i--) {
  const d = cues[i].end - cues[i].start;
  const joined = `${cues[i].text} ${cues[i + 1].text}`.replace(/\n/g, ' ');
  if (d < MIN_CUE && joined.length <= 84) {
    cues[i].end = cues[i + 1].end;
    cues[i].text = wrapCue(joined)[0] ?? joined;
    cues.splice(i + 1, 1);
  }
}

// A short cue is often the tail of a sentence ("way down to one."), so it has no
// following cue to absorb it — fold it back into the one it belongs with.
for (let i = cues.length - 1; i > 0; i--) {
  const d = cues[i].end - cues[i].start;
  const joined = `${cues[i - 1].text} ${cues[i].text}`.replace(/\n/g, ' ');
  if (d < MIN_CUE && joined.length <= 84) {
    cues[i - 1].end = cues[i].end;
    cues[i - 1].text = wrapCue(joined)[0] ?? joined;
    cues.splice(i, 1);
  }
}

// Clamp: a cue must not outlive the narration, nor overlap the next one.
const lastEnd = starts.length
  ? starts.at(-1).start + (durations[starts.at(-1).name] ?? 0)
  : Infinity;
for (let i = 0; i < cues.length; i++) {
  if (i + 1 < cues.length) cues[i].end = Math.min(cues[i].end, cues[i + 1].start - 0.02);
  cues[i].end = Math.min(cues[i].end, lastEnd);
  if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.4;
}

const body = (sep) =>
  cues.map((c, i) => `${i + 1}\n${stamp(c.start, sep)} --> ${stamp(c.end, sep)}\n${c.text}\n`).join('\n');
fs.writeFileSync(`${base}.srt`, body(','));
fs.writeFileSync(`${base}.vtt`, `WEBVTT\n\n${body('.')}`);

const brief = cues.filter((c) => c.end - c.start < MIN_CUE);
const speechChars = cues.reduce((n, c) => n + c.text.replace(/\n/g, ' ').length, 0);
const span = (cues.at(-1)?.end ?? 0) - (cues[0]?.start ?? 0);
console.log(
  `${base}.vtt + .srt — ${cues.length} cues, ${stamp(cues.at(-1)?.end ?? 0, '.')} long, ` +
    `${(speechChars / Math.max(span, 1)).toFixed(1)} chars/sec`,
);
if (brief.length) {
  // Not merged on purpose: joining these would exceed two lines, and the merge
  // keeps only the first wrapped chunk, so it would drop words. Short sentence
  // tails are readable in context; flag them rather than lose text.
  console.log(
    `  ${brief.length} cue(s) under ${MIN_CUE}s (sentence tails, left intact rather than merged lossily)`,
  );
}
// The narration itself runs ~19 chars/sec; captions cannot read slower than the
// voice without drifting out of sync. Shorter narration is the only real fix.
