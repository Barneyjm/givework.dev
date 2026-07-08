// Intake screening: PII redaction + PHI heuristics. Pure functions, no DB.
//
// Why this exists: task specs are shipped to volunteer machines, so the less
// personal data that ever leaves the control plane, the better. Structured PII
// (emails, phones, SSNs, card numbers) is never load-bearing for a volunteer's
// work — the nonprofit owns the mapping — so we replace each value with a
// stable token before the decomposer sees the text, keep the token→value map
// on the control plane (intake_requests.redactions), and re-apply it only when
// results are delivered back to the data owner (see getRequestResults).
//
// PHI is different: no amount of redaction makes health data safe to route to
// volunteers (each would become a HIPAA business associate), so we don't try —
// we flag likely PHI at intake and block publishing until an admin has
// reviewed and explicitly acknowledged the flag. Both screens are heuristics,
// a floor under the human review step, not a replacement for it.

export type PIIKind = 'email' | 'phone' | 'ssn' | 'card';

export interface RedactionEntity {
  /** What ships in task specs, e.g. "[EMAIL_1]". */
  token: string;
  kind: PIIKind;
  /** The original text. Stays on the control plane, never in a task. */
  value: string;
}

export interface RedactionResult {
  text: string;
  entities: RedactionEntity[];
}

/** Luhn check — keeps the card pattern from eating arbitrary long digit runs. */
function luhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// High-precision patterns only: a false redaction corrupts a task, so each
// pattern requires real structure (separators, Luhn) rather than bare digit
// runs. Order matters — earlier patterns must not leave partial matches for
// later ones (email → ssn → card → phone).
const PATTERNS: { kind: PIIKind; re: RegExp; valid?: (m: string) => boolean }[] = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'card', re: /\b\d(?:[ -]?\d){12,18}\b/g, valid: luhn },
  // Phone requires a separator between groups so a plain 10-digit id (invoice
  // numbers, EINs) is never swallowed.
  { kind: 'phone', re: /(?:\+?1[ .-])?(?:\(\d{3}\)[ .]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b/g },
];

/**
 * Replace structured PII in `text` with stable tokens. Pass previously
 * collected `entities` to keep numbering and value→token mapping consistent
 * across multiple passes over related text (subject then body, or a later
 * publish-time sweep over task specs) — the same value always gets the same
 * token, and new values continue the sequence. Idempotent: tokens themselves
 * match no pattern, so re-screening already-redacted text is a no-op.
 */
export function redactPII(text: string, existing: RedactionEntity[] = []): RedactionResult {
  const entities = [...existing];
  const tokenByValue = new Map(entities.map((e) => [`${e.kind}:${e.value}`, e.token]));
  const counters = new Map<PIIKind, number>();
  for (const e of entities) {
    const n = Number(e.token.match(/_(\d+)\]$/)?.[1] ?? 0);
    counters.set(e.kind, Math.max(counters.get(e.kind) ?? 0, n));
  }

  let out = text;
  for (const { kind, re, valid } of PATTERNS) {
    out = out.replace(re, (m) => {
      if (valid && !valid(m)) return m;
      const key = `${kind}:${m}`;
      let token = tokenByValue.get(key);
      if (!token) {
        const n = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, n);
        token = `[${kind.toUpperCase()}_${n}]`;
        tokenByValue.set(key, token);
        entities.push({ token, kind, value: m });
      }
      return token;
    });
  }
  return { text: out, entities };
}

/**
 * Put original values back — used only when delivering results to the data
 * owner (the nonprofit). Safe to run over serialized JSON: every redacted kind
 * is plain ASCII with no quotes, backslashes, or control characters, so a
 * string-level substitution cannot break JSON syntax.
 */
export function restoreRedactions(text: string, entities: RedactionEntity[]): string {
  let out = text;
  for (const e of entities) out = out.split(e.token).join(e.value);
  return out;
}

// Health-context terms. Deliberately specific ("treatment plan", not
// "treatment") — the flag blocks publishing until reviewed, so every false
// positive costs an admin acknowledgement.
const PHI_TERMS: RegExp[] = [
  /\bpatients?\b/i,
  /\bdiagnos(?:is|es|ed|tic)\b/i,
  /\bmedical (?:record|history|chart)s?\b/i,
  /\bhealth (?:record|history|condition)s?\b/i,
  /\bmrn\b/i,
  /\bprescriptions?\b/i,
  /\bmedications?\b/i,
  /\btreatment plans?\b/i,
  /\btherap(?:y|ies|ist)\b/i,
  /\bmental health\b/i,
  /\bsubstance (?:ab)?use\b/i,
  /\bhiv\b/i,
  /\bimmunizations?\b/i,
  /\blab results?\b/i,
  /\bhealth insurance\b/i,
  /\bmedicaid\b/i,
  /\bmedicare\b/i,
  /\bicd-?1[01]\b/i,
  /\bphi\b/i,
  /\bhipaa\b/i,
  /\bclinical\b/i,
];

export interface PhiScreen {
  flagged: boolean;
  /** The matched terms, lowercased — stored so the reviewer sees why. */
  signals: string[];
}

/** Heuristic PHI screen over intake text. Flags for human review; never final. */
export function screenForPHI(text: string): PhiScreen {
  const signals: string[] = [];
  for (const re of PHI_TERMS) {
    const m = text.match(re);
    if (m) signals.push(m[0].toLowerCase());
  }
  return { flagged: signals.length > 0, signals };
}
