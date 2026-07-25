// Worker-only: render a branded 1200x630 share card for a contributor, so a
// shared /contributors/<handle> link previews as a Givework-framed card (avatar
// + wordmark + stats) instead of a bare GitHub avatar. Uses resvg-wasm to
// rasterize a hand-built Bauhaus SVG. This module imports .wasm and .ttf assets
// that only the Cloudflare bundler understands, so it is imported *lazily* from
// worker.ts and never from app.ts/the Node server (which would choke on them).
import { initWasm, Resvg } from '@resvg/resvg-wasm';
// Bundled by wrangler: .wasm -> WebAssembly.Module, .ttf -> ArrayBuffer (see
// the `rules` in wrangler.toml).
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { getContributorProfile } from '../operations.js';
import monoBold from './fonts/SpaceMono-Bold.ttf';
import monoRegular from './fonts/SpaceMono-Regular.ttf';

// Bauhaus palette (matches the site design system).
const PAPER = '#f4f1e6';
const INK = '#161310';
const RED = '#e1342b';
const BLUE = '#21449c';
const YELLOW = '#f3c20a';

// initWasm must run exactly once per isolate; memoize the promise.
let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) wasmReady = initWasm(resvgWasm as WebAssembly.Module);
  return wasmReady;
}

const fontBuffers = [
  new Uint8Array(monoRegular as ArrayBuffer),
  new Uint8Array(monoBold as ArrayBuffer),
];

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// btoa needs a binary string; chunk to avoid blowing the argument limit on a
// full avatar (~tens of KB).
function toDataUri(buf: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

// Fetch the volunteer's GitHub avatar as a data URI so it embeds in the SVG
// (resvg has no network). Returns null on any failure -> the card falls back to
// a colored initial disc.
async function fetchAvatar(handle: string): Promise<string | null> {
  try {
    const res = await fetch(`https://github.com/${encodeURIComponent(handle)}.png?size=280`, {
      cf: { cacheTtl: 86400, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') || 'image/png';
    if (!mime.startsWith('image/')) return null;
    return toDataUri(await res.arrayBuffer(), mime);
  } catch {
    return null;
  }
}

// The favicon trio glyph, scaled to a 44px box, positioned at (x,y).
function trioGlyph(x: number, y: number): string {
  return (
    `<g transform="translate(${x},${y}) scale(1.1)">` +
    `<rect width="40" height="40" fill="${INK}"/>` +
    `<circle cx="11" cy="13" r="7" fill="${RED}"/>` +
    `<rect x="21" y="6" width="13" height="13" fill="${BLUE}"/>` +
    `<polygon points="7,34 19,21 31,34" fill="${YELLOW}"/>` +
    `</g>`
  );
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Space Mono is monospace: ~0.6em per glyph. Pick a size that keeps the handle
// on one line within the available width.
function handleSize(handle: string): number {
  const label = `@${handle}`;
  for (const size of [72, 60, 50, 42, 36]) {
    if (label.length * size * 0.6 <= 690) return size;
  }
  return 32;
}

function buildSvg(
  handle: string,
  avatar: string | null,
  stats: { contributions: number; conjectures: number; computeCents: number },
): string {
  const cx = 250;
  const cy = 330;
  const r = 150;
  const hSize = handleSize(handle);
  const textX = 460;
  const initial = esc((handle[0] || '?').toUpperCase());

  const avatarNode = avatar
    ? `<image href="${avatar}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#clip)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BLUE}"/>` +
      `<text x="${cx}" y="${cy + 52}" font-family="Space Mono" font-weight="700" font-size="150" fill="${PAPER}" text-anchor="middle">${initial}</text>`;

  return (
    `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><clipPath id="clip"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>` +
    // paper background
    `<rect width="1200" height="630" fill="${PAPER}"/>` +
    // brand row, top-left
    trioGlyph(80, 60) +
    `<text x="140" y="94" font-family="Space Mono" font-weight="700" font-size="34" letter-spacing="2" fill="${INK}">GIVEWORK</text>` +
    // Bauhaus accent behind the avatar (offset yellow disc) + ink ring
    `<circle cx="${cx + 18}" cy="${cy + 18}" r="${r}" fill="${YELLOW}"/>` +
    avatarNode +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK}" stroke-width="8"/>` +
    // handle
    `<text x="${textX}" y="278" font-family="Space Mono" font-weight="700" font-size="${hSize}" fill="${INK}">@${esc(handle)}</text>` +
    // red rule
    `<rect x="${textX}" y="308" width="140" height="10" fill="${RED}"/>` +
    // stats
    `<text x="${textX}" y="392" font-family="Space Mono" font-weight="700" font-size="46" fill="${INK}">${stats.contributions} contribution${stats.contributions === 1 ? '' : 's'}</text>` +
    `<text x="${textX}" y="446" font-family="Space Mono" font-weight="400" font-size="32" fill="${INK}">across ${stats.conjectures} conjecture${stats.conjectures === 1 ? '' : 's'}</text>` +
    `<text x="${textX}" y="492" font-family="Space Mono" font-weight="400" font-size="32" fill="${INK}">${dollars(stats.computeCents)} of compute donated</text>` +
    // bottom ink strip
    `<rect x="0" y="560" width="1200" height="70" fill="${INK}"/>` +
    `<text x="80" y="604" font-family="Space Mono" font-weight="400" font-size="22" letter-spacing="1" fill="${PAPER}">OPEN MATHEMATICS · POWERED BY VOLUNTEERS</text>` +
    `<text x="1120" y="604" font-family="Space Mono" font-weight="700" font-size="22" fill="${YELLOW}" text-anchor="end">givework.dev</text>` +
    `</svg>`
  );
}

/**
 * Handle GET /og/contributor/<handle>.png. Returns a rasterized branded card,
 * or null if the path doesn't match (so worker.ts falls through to the app).
 * A missing profile still renders (zeroed stats) so the crawler always gets an
 * image; only a malformed handle 404s.
 */
export async function handleOgContributor(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/og\/contributor\/([\w-]{1,39})\.png$/);
  if (!m) return null;
  const handle = m[1];

  const [profile, avatar] = await Promise.all([
    getContributorProfile(handle).catch(() => null),
    fetchAvatar(handle),
  ]);
  const stats = {
    contributions: profile?.totals.contributions ?? 0,
    conjectures: profile?.totals.conjectures ?? 0,
    computeCents: profile?.totals.compute_cents ?? 0,
  };

  await ensureWasm();
  const svg = buildSvg(handle, avatar, stats);
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: 'Space Mono' },
  })
    .render()
    .asPng();

  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // Long edge cache; the stats move slowly and a stale card is harmless.
      'cache-control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
