// The decomposition step: turn a plain-language intake request into proposed,
// right-sized, structured tasks. Swappable behind the `Decomposer` interface:
//   - StubDecomposer    — deterministic, no model, used by default + in tests.
//   - LocalLLMDecomposer — a real LLM running locally and FREE (Ollama / any
//     OpenAI-compatible endpoint), selected with DECOMPOSER=local.
//
// Decomposition runs on the *platform*, so it must be cheap — a small local
// model. Task *execution* is separate: it runs on the volunteer's donated Claude
// credit (see the runner's executeTask). So a task's `model` below is a Claude
// model the runner will use, even though a local model chose it.

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

// ---------------------------------------------------------------------------
// LocalLLMDecomposer — a real decomposition via a local, free model.
// ---------------------------------------------------------------------------

// Claude models the decomposer may assign for *execution* (on the volunteer's
// credit). Unknown values are clamped to the middle tier.
const ALLOWED_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
const DEFAULT_EXEC_MODEL = 'claude-sonnet-4-6';
const SENSITIVITIES = ['public', 'internal', 'sensitive'] as const;

const clampInt = (n: unknown, min: number, fallback: number): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= min ? v : fallback;
};

/**
 * Normalize one raw object from the model into a safe ProposedTask. The model is
 * advisory — we enforce every invariant ourselves so a sloppy response can never
 * produce an invalid task (max >= est > 0, valid enum, integer cents, etc.).
 */
function normalizeTask(raw: any): ProposedTask {
  const est = clampInt(raw?.est_cost_cents, 1, 100);
  const max = Math.max(clampInt(raw?.max_cost_cents, 1, Math.ceil(est * 1.5)), est);
  const sensitivity = SENSITIVITIES.includes(raw?.sensitivity) ? raw.sensitivity : 'sensitive';
  const model = ALLOWED_MODELS.includes(raw?.model) ? raw.model : DEFAULT_EXEC_MODEL;
  const spec = raw?.spec ?? raw ?? {};
  return {
    title: String(raw?.title ?? 'Intake task').slice(0, 80),
    spec: {
      prompt: String(spec.prompt ?? raw?.prompt ?? '').slice(0, 4000),
      input_refs: Array.isArray(spec.input_refs) ? spec.input_refs.map(String) : [],
      output_schema:
        spec.output_schema && typeof spec.output_schema === 'object'
          ? spec.output_schema
          : { result: 'string' },
      acceptance: String(spec.acceptance ?? 'The request is fulfilled per the description.').slice(0, 1000),
      unit_count: clampInt(spec.unit_count ?? raw?.unit_count, 1, 1),
    },
    est_cost_cents: est,
    max_cost_cents: max, // CHECK (max_cost_cents >= est_cost_cents) and (> 0) always hold
    model,
    sensitivity,
  };
}

const SYSTEM_PROMPT = `You are the intake decomposer for Givework, a platform where developers donate AI inference to nonprofits.
A nonprofit has emailed a plain-language request. Break it into one or more concrete, independently-executable tasks that a developer's AI agent can complete.

Rules:
- Keep each task small. If the request names a quantity (e.g. "50 invoices"), split into batches of about 10 units per task.
- Set "model" to the Claude model that fits the task's difficulty: "claude-haiku-4-5" (simple), "claude-sonnet-4-6" (moderate), or "claude-opus-4-8" (hard).
- Costs are integer cents. est_cost_cents is a rough estimate; max_cost_cents is a hard cap and must be >= est_cost_cents.
- "sensitivity" is one of "public", "internal", "sensitive". Default to "sensitive" — intake often contains personal data.
- Never address cost or model choice to the nonprofit; those are internal.

Respond with ONLY a JSON object of the form:
{"tasks":[{"title":"...","spec":{"prompt":"...","input_refs":[],"output_schema":{"...":"..."},"acceptance":"...","unit_count":1},"est_cost_cents":150,"max_cost_cents":250,"model":"claude-sonnet-4-6","sensitivity":"sensitive"}]}`;

type FetchFn = typeof fetch;

/**
 * Decompose via a local OpenAI-compatible chat endpoint (Ollama by default, but
 * any compatible server works via DECOMPOSER_BASE_URL). Free and local. Falls
 * back to the StubDecomposer on any failure — unreachable model, timeout, bad
 * JSON, or zero valid tasks — so intake never hard-fails.
 */
export class LocalLLMDecomposer implements Decomposer {
  private fallback = new StubDecomposer();

  constructor(
    private opts: {
      baseUrl?: string;
      model?: string;
      timeoutMs?: number;
      fetchFn?: FetchFn;
    } = {},
  ) {}

  async decompose(input: IntakeInput): Promise<ProposedTask[]> {
    const baseUrl = this.opts.baseUrl ?? process.env.DECOMPOSER_BASE_URL ?? 'http://localhost:11434/v1';
    const model = this.opts.model ?? process.env.DECOMPOSER_MODEL ?? 'glm-4.7-flash:latest';
    const doFetch = this.opts.fetchFn ?? fetch;
    const controller = new AbortController();
    // Generous default: a local model can take a minute+ warm, plus cold load.
    // STAGE 6: ack POST /intake immediately and decompose async/queued so a slow
    // local model doesn't block the request; admin polls for the draft.
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 120_000);

    try {
      const userMsg =
        `From: ${input.from_email}\n` +
        (input.subject ? `Subject: ${input.subject}\n` : '') +
        `Attachments: ${input.attachment_count}\n\n` +
        input.body;

      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`decomposer HTTP ${res.status}`);

      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('decomposer returned empty content');

      const parsed = JSON.parse(content);
      const rawTasks: any[] = Array.isArray(parsed) ? parsed : parsed?.tasks ?? [];
      const tasks = rawTasks.slice(0, MAX_TASKS).map(normalizeTask).filter((t) => t.spec.prompt.length > 0);

      if (tasks.length === 0) throw new Error('decomposer produced no usable tasks');
      return tasks;
    } catch (err) {
      console.error(`LocalLLMDecomposer fell back to stub: ${(err as Error).message}`);
      return this.fallback.decompose(input);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The decomposer the pipeline uses, chosen by env at call time:
 *   DECOMPOSER=local → LocalLLMDecomposer (Ollama/OpenAI-compatible, free)
 *   otherwise        → StubDecomposer (deterministic; default, used by tests)
 */
export function getDecomposer(): Decomposer {
  return process.env.DECOMPOSER === 'local' ? new LocalLLMDecomposer() : new StubDecomposer();
}
