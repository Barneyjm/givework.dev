// Feed-line synthesis. Pure string work, no Node built-ins — operations.ts runs
// in the Cloudflare Worker, so this cannot live next to the sandbox code in
// workunit.ts (which imports node:child_process and would drag it into the
// Worker bundle).
//
// Every contribution on the public feed needs a line a reader can act on. When
// whatever produced it supplied no summary of its own, we build one from the
// task title plus a few headline scalars, rather than writing a blank row.

const SUMMARY_MAX_CHARS = 200;
const SUMMARY_MAX_FIELDS = 4;
const SUMMARY_MAX_VALUE_CHARS = 40;
/** Envelope plumbing — never headline material for a human reading the feed. */
const SUMMARY_SKIP_KEYS = new Set(['summary', 'outcome', 'state_update', 'artifact_uri']);

/**
 * A readable feed line for a result whose producer gave no summary: the task
 * title plus up to a few headline scalar fields. Deterministic and generic —
 * shallow numeric/boolean/short-string values in the object's own key order,
 * skipping arrays, nested objects, and huge strings — so any output shape
 * produces something readable without the platform knowing its schema.
 */
export function synthesizeSummary(title: string, result: unknown): string {
  const fields: string[] = [];
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      if (fields.length >= SUMMARY_MAX_FIELDS) break;
      if (SUMMARY_SKIP_KEYS.has(key)) continue;
      if (typeof value === 'number' && Number.isFinite(value)) {
        fields.push(`${key}: ${value}`);
      } else if (typeof value === 'boolean') {
        fields.push(`${key}: ${value}`);
      } else if (typeof value === 'string') {
        const v = value.trim();
        if (v.length > 0 && v.length <= SUMMARY_MAX_VALUE_CHARS && !v.includes('\n')) {
          fields.push(`${key}: ${v}`);
        }
      }
      // arrays, nested objects, and huge strings are never headline material
    }
  }
  const s = fields.length > 0 ? `${title} — ${fields.join(', ')}` : title;
  return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS - 1)}…` : s;
}
