import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

// Branded 1080x1920 backdrop for the vertical (9:16) cut of a conjecture video.
//
// The scenes are composed for 16:9 — every position, wrap width and font size is
// tuned to that frame — so re-rendering them vertically would wreck the layouts.
// Instead the landscape video is composited into the middle of this frame, with
// the branding and the conjecture's name in the space above and below it. That's
// also what short-form viewers expect: the caption band is where a thumb isn't.
//
//   node make_vertical_frame.mjs <slug> [out.png]
//
// Reads <slug>.json (this directory, or a path given by SPEC_DIR) for the name
// and subtitle. Emits a PNG for make_vertical.sh to overlay.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = process.env.SPEC_DIR ?? HERE;
const FONT_DIR = process.env.FONT_DIR ?? path.join(HERE, '..', 'src', 'og', 'fonts');
const WASM =
  process.env.RESVG_WASM ??
  path.join(HERE, '..', 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm');

const PAPER = '#f4f1e6';
const INK = '#161310';
const RED = '#e1342b';
const BLUE = '#21449c';
const YELLOW = '#f3c20a';

const W = 1080;
const H = 1920;
// The 16:9 video, full width. 1080 / (16/9) = 607.5 -> 608 (even).
const VIDEO_H = Math.round(W / (16 / 9));
// Deliberately ABOVE centre. Short-form platforms overlay their own chrome —
// caption, handle, action rail — across the bottom fifth, so the content sits
// high and the lower band is left to them rather than fought over.
const VIDEO_TOP = 560;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Greedy wrap for monospace (~0.6em advance). */
function wrap(text, size, maxW) {
  const per = Math.max(8, Math.floor(maxW / (size * 0.6)));
  const out = [];
  let cur = '';
  for (const word of String(text).split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > per && cur) {
      out.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

function fitTitle(title, maxW) {
  for (const size of [78, 68, 58, 50, 44]) {
    const lines = wrap(title, size, maxW);
    if (lines.length <= 3) return { size, lines };
  }
  return { size: 40, lines: wrap(title, 40, maxW).slice(0, 4) };
}

function trio(x, y, scale) {
  return (
    `<g transform="translate(${x},${y}) scale(${scale})">` +
    `<rect width="40" height="40" fill="${INK}"/>` +
    `<circle cx="11" cy="13" r="7" fill="${RED}"/>` +
    `<rect x="21" y="6" width="13" height="13" fill="${BLUE}"/>` +
    `<polygon points="7,34 19,21 31,34" fill="${YELLOW}"/></g>`
  );
}

export function buildFrameSvg({ title, subtitle, slugForUrl = '' }) {
  const marginX = 72;
  const maxW = W - marginX * 2;
  const { size: tSize, lines } = fitTitle(title, maxW);
  const lead = tSize * 1.14;

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${W}" height="${H}" fill="${PAPER}"/>`;

  // brand, top
  svg += trio(marginX, 96, 1.9);
  svg += `<text x="${marginX + 104}" y="153" font-family="Space Mono" font-weight="700" font-size="50" letter-spacing="3" fill="${INK}">GIVEWORK</text>`;

  // title above the video well
  const titleBottom = VIDEO_TOP - 60;
  const titleTop = titleBottom - lines.length * lead;
  svg += `<text x="${marginX}" y="${titleTop - 30}" font-family="Space Mono" font-weight="700" font-size="30" letter-spacing="5" fill="${RED}">OPEN MATHEMATICS</text>`;
  lines.forEach((l, i) => {
    svg += `<text x="${marginX}" y="${titleTop + lead * (i + 0.82)}" font-family="Space Mono" font-weight="700" font-size="${tSize}" fill="${INK}">${esc(l)}</text>`;
  });

  // ink well behind the video, so any rounding gap reads as intentional matting
  svg += `<rect x="0" y="${VIDEO_TOP - 4}" width="${W}" height="${VIDEO_H + 8}" fill="${INK}"/>`;

  // subtitle + call to action below
  let y = VIDEO_TOP + VIDEO_H + 92;
  if (subtitle) {
    svg += `<rect x="${marginX}" y="${y - 46}" width="132" height="9" fill="${RED}"/>`;
    wrap(subtitle, 38, maxW)
      .slice(0, 3)
      .forEach((l, i) => {
        svg += `<text x="${marginX}" y="${y + i * 52}" font-family="Space Mono" font-weight="400" font-size="38" fill="${INK}">${esc(l)}</text>`;
      });
    y += 3 * 52;
  }
  // The one thing a short-form viewer needs in order to act.
  svg += `<text x="${marginX}" y="${y + 26}" font-family="Space Mono" font-weight="700" font-size="34" fill="${BLUE}">givework.dev/conjectures/${esc(slugForUrl)}</text>`;

  // footer band
  svg += `<rect x="0" y="${H - 150}" width="${W}" height="150" fill="${INK}"/>`;
  svg += `<text x="${W / 2}" y="${H - 88}" font-family="Space Mono" font-weight="700" font-size="46" fill="${YELLOW}" text-anchor="middle">givework.dev</text>`;
  svg += `<text x="${W / 2}" y="${H - 42}" font-family="Space Mono" font-weight="400" font-size="27" letter-spacing="2" fill="${PAPER}" text-anchor="middle">CHIP AWAY AT THE UNSOLVED</text>`;
  svg += `</svg>`;
  return svg;
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('usage: node make_vertical_frame.mjs <slug> [out.png]');
    process.exit(1);
  }
  const out = process.argv[3] ?? path.join(process.cwd(), `vframe_${slug}.png`);
  const specPath = path.join(SPEC_DIR, `${slug}.json`);
  const spec = fs.existsSync(specPath) ? JSON.parse(fs.readFileSync(specPath, 'utf8')) : {};

  await initWasm(fs.readFileSync(WASM));
  const fontBuffers = ['SpaceMono-Regular.ttf', 'SpaceMono-Bold.ttf'].map(
    (f) => new Uint8Array(fs.readFileSync(path.join(FONT_DIR, f))),
  );
  const svg = buildFrameSvg({
    slugForUrl: slug,
    title: spec.name ?? slug,
    subtitle: (spec.subtitle ?? '').replace(/^./, (c) => c.toUpperCase()),
  });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: 'Space Mono' },
  })
    .render()
    .asPng();
  fs.writeFileSync(out, png);
  // Hand the geometry to the shell script so the overlay maths lives in one place.
  console.log(JSON.stringify({ frame: out, width: W, height: H, video_h: VIDEO_H, video_top: VIDEO_TOP }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
export { VIDEO_H, VIDEO_TOP, W, H };
