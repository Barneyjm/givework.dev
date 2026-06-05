// Turn a completed request's task outputs into something a nonprofit can use
// with zero work: a CSV when the data is tabular, otherwise clean JSON. Pure and
// runtime-agnostic so it's shared by the download endpoint and the email
// attachment, and unit-testable. Task results are arbitrary JSON, so this is
// best-effort: it never loses data (JSON fallback), and produces CSV only when
// every value is a flat primitive.

export interface TaskResult {
  title: string;
  result: unknown;
}

export interface ResultFile {
  filename: string;
  contentType: string;
  content: string;
}

type Primitive = string | number | boolean | null;
type Record_ = { [k: string]: Primitive };

/** A value is CSV-friendly if it's a primitive (or null/undefined → blank). */
function isPrimitive(v: unknown): v is Primitive {
  return v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Flatten task outputs into a list of records for CSV, or return null if the
 * shape isn't cleanly tabular. Each task's result may be an array, an object
 * with a `results` array, a plain object, or a scalar — all get a `task` column
 * for context. Returns null (→ caller uses JSON) if any value is nested.
 */
function collectRecords(results: TaskResult[]): Record_[] | null {
  const records: Record_[] = [];
  for (const r of results) {
    const val = r.result as any;
    const items: unknown[] = Array.isArray(val)
      ? val
      : val && typeof val === 'object' && Array.isArray(val.results)
        ? val.results
        : [val];
    for (const item of items) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rec: Record_ = { task: r.title };
        for (const [k, v] of Object.entries(item)) {
          if (!isPrimitive(v)) return null; // nested → not tabular
          rec[k] = v as Primitive;
        }
        records.push(rec);
      } else if (isPrimitive(item)) {
        records.push({ task: r.title, result: item });
      } else {
        return null; // array of arrays / other → not tabular
      }
    }
  }
  return records.length ? records : null;
}

/** Escape a CSV field per RFC 4180 (quote when it contains comma/quote/newline). */
function csvField(v: Primitive): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(records: Record_[]): string {
  // Header = union of keys, in first-seen order (task first).
  const keys: string[] = [];
  for (const rec of records) for (const k of Object.keys(rec)) if (!keys.includes(k)) keys.push(k);
  const lines = [keys.map(csvField).join(',')];
  for (const rec of records) lines.push(keys.map((k) => csvField(rec[k] ?? '')).join(','));
  return lines.join('\r\n');
}

/** Always-CSV: tabular when possible, else a two-column task/output table. */
export function resultsToCsv(results: TaskResult[]): string {
  const records =
    collectRecords(results) ??
    results.map((r) => ({
      task: r.title,
      result: typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? null),
    }));
  return toCsv(records);
}

/** Pretty JSON of the raw per-task results. */
export function resultsToJson(results: TaskResult[]): string {
  return JSON.stringify(results, null, 2);
}

/**
 * The single deliverable file for a request's results — CSV when tabular, else
 * JSON. Used as the email attachment. Always returns *something* (JSON never
 * fails), so delivery is never blocked.
 */
export function resultsToFile(results: TaskResult[]): ResultFile {
  const records = collectRecords(results);
  if (records) {
    return { filename: 'givework-results.csv', contentType: 'text/csv; charset=utf-8', content: toCsv(records) };
  }
  return {
    filename: 'givework-results.json',
    contentType: 'application/json; charset=utf-8',
    content: resultsToJson(results),
  };
}
