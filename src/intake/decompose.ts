// The decomposition step: turn a plain-language intake request into proposed,
// right-sized, structured tasks. This is a swappable interface — a deterministic
// stub now, so the pipeline is testable without an API key.
//
// STAGE 5: a ClaudeDecomposer that calls the Anthropic SDK with structured output
// (tool use forcing this same ProposedTask[] schema) + prompt caching. It drops
// in here with no change to the operations/routes around it.

export interface ProposedTask {
  title: string;
  spec: {
    prompt: string;
    input_refs: string[];
    output_schema: Record<string, string>;
    acceptance: string;
    unit_count: number; // sizing hint — how many units this task covers
  };
  est_cost_cents: number;
  max_cost_cents: number;
  model: string;
  sensitivity: 'public' | 'internal' | 'sensitive';
}

export interface IntakeInput {
  from_email: string;
  subject?: string;
  body: string;
  attachment_count: number;
}

export interface Decomposer {
  decompose(input: IntakeInput): Promise<ProposedTask[]>;
}

const DEFAULT_MODEL = 'claude-opus-4-8';

// Sizing policy: keep each task small enough that a typical dev budget can
// finish it in one checkout (so we lean on intake sizing instead of runtime
// checkpointing). Batch large quantities into chunks of this many units.
const UNITS_PER_TASK = 10;
const MAX_TASKS = 20; // never explode a single email into an unbounded job

/** Roughly price a task by how many units it covers. Integer cents, never floats. */
function priceFor(units: number): { est: number; max: number } {
  const est = 50 + units * 25; // base + per-unit
  const max = Math.ceil(est * 1.5); // hard cap leaves headroom over the estimate
  return { est, max };
}

/** Pull the first "<number> <noun>" quantity out of the text, if any. */
function detectQuantity(text: string): { count: number; noun: string } | null {
  const m = text.match(/\b(\d{1,5})\s+([a-z][a-z-]{2,40}?)s?\b/i);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  return { count, noun: m[2].toLowerCase() };
}

/**
 * Deterministic, rules-based decomposer. Pure function of its input.
 * - A quantity ("categorize 50 invoices") is split into batches of UNITS_PER_TASK.
 * - Otherwise the whole request becomes a single task.
 * - Sensitivity defaults to `sensitive` — the safe default for inbound intake,
 *   which routinely carries PII. A reviewer can downgrade before publishing.
 */
export class StubDecomposer implements Decomposer {
  async decompose(input: IntakeInput): Promise<ProposedTask[]> {
    const ask = (input.subject ? `${input.subject}: ` : '') + input.body.trim();
    const qty = detectQuantity(input.body);

    if (qty && qty.count > UNITS_PER_TASK) {
      const batches = Math.min(Math.ceil(qty.count / UNITS_PER_TASK), MAX_TASKS);
      const tasks: ProposedTask[] = [];
      for (let i = 0; i < batches; i++) {
        const start = i * UNITS_PER_TASK + 1;
        const end = Math.min((i + 1) * UNITS_PER_TASK, qty.count);
        const units = end - start + 1;
        const { est, max } = priceFor(units);
        tasks.push({
          title: `${qty.noun} ${start}–${end} of ${qty.count}`,
          spec: {
            prompt: `From the request "${ask}", process ${qty.noun} ${start} through ${end}.`,
            input_refs: [],
            output_schema: { results: 'object[]' },
            acceptance: `Each of ${qty.noun} ${start}–${end} is addressed with a result.`,
            unit_count: units,
          },
          est_cost_cents: est,
          max_cost_cents: max,
          model: DEFAULT_MODEL,
          sensitivity: 'sensitive',
        });
      }
      return tasks;
    }

    // No quantity — one task for the whole ask.
    const { est, max } = priceFor(1);
    return [
      {
        title: input.subject?.slice(0, 80) || ask.slice(0, 80) || 'Intake request',
        spec: {
          prompt: ask,
          input_refs: [],
          output_schema: { result: 'string' },
          acceptance: 'The request is fulfilled per the description.',
          unit_count: 1,
        },
        est_cost_cents: est,
        max_cost_cents: max,
        model: DEFAULT_MODEL,
        sensitivity: 'sensitive',
      },
    ];
  }
}

/** The decomposer the pipeline uses. STAGE 5: swap for ClaudeDecomposer. */
export const decomposer: Decomposer = new StubDecomposer();
