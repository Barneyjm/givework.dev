#!/usr/bin/env node
// Build an .srt from a spec's narration and the beat timings the render emitted.
//
//   node make_captions.mjs <slug> [out.srt]
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
const out = process.argv[3] ?? `${slug}.srt`;

const spec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, `${slug}.json`), 'utf8'));
const starts = JSON.parse(fs.readFileSync(path.join(NARR_DIR, 'starts.json'), 'utf8'));
const durations = JSON.parse(fs.readFileSync(path.join(NARR_DIR, 'durations.json'), 'utf8'));

const stamp = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
};

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
    const parts = wrapCue(sentence);
    const each = span / parts.length;
    for (const part of parts) {
      cues.push({ start: t, end: t + each - 0.05, text: part });
      t += each;
    }
  }
}

const srt = cues
  .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`)
  .join('\n');
fs.writeFileSync(out, srt);
console.log(`${out}  ${cues.length} cues, ${stamp(cues.at(-1)?.end ?? 0)} long`);
