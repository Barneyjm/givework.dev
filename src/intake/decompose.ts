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

import { jsonrepair } from 'jsonrepair';

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

/** Which engine actually produced the tasks — recorded as the intake's `triaged_by`. */
export type TriagedBy = 'stub' | 'local';

export interface DecomposeResult {
  /**
   * The engine that produced these tasks. `local` only when the LLM genuinely
   * succeeded; a local-model failure falls back to the stub and reports `stub`,
   * so the record never overstates that a model was involved.
   */
  triagedBy: TriagedBy;
  tasks: ProposedTask[];
}

export interface Decomposer {
  decompose(input: IntakeInput): Promise<DecomposeResult>;
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
  async decompose(input: IntakeInput): Promise<DecomposeResult> {
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
      return { triagedBy: 'stub', tasks };
    }

    // No quantity — one task for the whole ask.
    const { est, max } = priceFor(1);
    return {
      triagedBy: 'stub',
      tasks: [
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
      ],
    };
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
export function normalizeTask(raw: any): ProposedTask {
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
      acceptance: String(spec.acceptance ?? 'The request is fulfilled per the description.').slice(
        0,
        1000,
      ),
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

// JSON Schema for the decomposer output — the structured-output PRIMITIVE. Passed
// to the model so it's constrained at decode time to our exact shape (no field
// drift, no free-form text to repair). Works with Ollama and any OpenAI-compatible
// server via response_format:json_schema. No framework needed.
const DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'spec', 'est_cost_cents', 'max_cost_cents', 'model', 'sensitivity'],
        properties: {
          title: { type: 'string' },
          spec: {
            type: 'object',
            additionalProperties: false,
            required: ['prompt'],
            properties: {
              prompt: { type: 'string' },
              input_refs: { type: 'array', items: { type: 'string' } },
              output_schema: { type: 'object', additionalProperties: { type: 'string' } },
              acceptance: { type: 'string' },
              unit_count: { type: 'integer' },
            },
          },
          est_cost_cents: { type: 'integer' },
          max_cost_cents: { type: 'integer' },
          model: { type: 'string', enum: ALLOWED_MODELS },
          sensitivity: { type: 'string', enum: [...SENSITIVITIES] },
        },
      },
    },
  },
} as const;

type FetchFn = typeof fetch;

/** The user-message half of the decomposer prompt (the request itself). */
function userMessage(input: IntakeInput): string {
  return (
    `From: ${input.from_email}\n` +
    (input.subject ? `Subject: ${input.subject}\n` : '') +
    `Attachments: ${input.attachment_count}\n\n` +
    input.body
  );
}

/**
 * Pull the proposed-task list out of a model's raw text output. Tolerant of the
 * shapes different runners produce: a bare JSON array or `{tasks:[…]}`, a
 * ```json fenced block, leading/trailing prose, and the `claude -p --output-format
 * json` wrapper (`{result:"…json…"}`). Local models also emit *almost*-JSON —
 * unescaped control chars, trailing/missing commas, truncation — so on a strict
 * parse failure we run jsonrepair (built for LLM output) before giving up.
 * Throws only if no JSON region is found at all.
 */
// Strip ANSI / terminal escape sequences — `ollama run` and similar CLIs emit
// color codes and spinners into stdout, which would otherwise poison the JSON.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC/CSI control bytes is the point — this strips ANSI escapes.
const ANSI_RE = /[\u001B\u009B](?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * From the opening bracket at `start`, return the index of its matching close,
 * tracking nesting depth and ignoring brackets inside strings. This beats a
 * whole-string lastIndexOf, which would swallow trailing prose containing a
 * stray `}`/`]` (e.g. `{…valid json…}\n\nNote: see {debug:true}`) into the
 * region and corrupt the parse. Returns -1 if unterminated.
 */
function matchingClose(s: string, start: number): number {
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

export function extractTasks(text: string): unknown[] {
  let s = text.replace(ANSI_RE, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in model output');
  const end = matchingClose(s, start);
  if (end === -1) throw new Error('unterminated JSON in model output');
  const region = s.slice(start, end + 1);
  let parsed: any;
  try {
    parsed = JSON.parse(region);
  } catch {
    parsed = JSON.parse(jsonrepair(region)); // repair common LLM JSON defects
  }
  // claude -p --output-format json wrapper: the real content is in `.result`.
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    typeof parsed.result === 'string' &&
    !parsed.tasks
  ) {
    return extractTasks(parsed.result);
  }
  if (Array.isArray(parsed)) return parsed;
  // Only treat .tasks as the list if it's actually an array — a model that
  // returns {tasks: "..."} or {tasks: {...}} would otherwise blow up
  // finalizeTasks' .slice()/.map(). Anything else → no tasks → stub fallback.
  return Array.isArray(parsed?.tasks) ? parsed.tasks : [];
}

/** Normalize + cap a raw task list, dropping empties. Shared by the model decomposers. */
function finalizeTasks(raw: unknown[]): ProposedTask[] {
  return raw
    .slice(0, MAX_TASKS)
    .map(normalizeTask)
    .filter((t) => t.spec.prompt.length > 0);
}

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

  async decompose(input: IntakeInput): Promise<DecomposeResult> {
    const baseUrl =
      this.opts.baseUrl ?? process.env.DECOMPOSER_BASE_URL ?? 'http://localhost:11434/v1';
    const model = this.opts.model ?? process.env.DECOMPOSER_MODEL ?? 'glm-4.7-flash:latest';
    const doFetch = this.opts.fetchFn ?? fetch;
    const controller = new AbortController();
    // Generous default: a local model can take a minute+ warm, plus cold load.
    // STAGE 6: ack POST /intake immediately and decompose async/queued so a slow
    // local model doesn't block the request; admin polls for the draft.
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.timeoutMs ?? Number(process.env.DECOMPOSER_TIMEOUT_MS ?? 240_000),
    );

    try {
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage(input) },
          ],
          temperature: 0.2,
          // Structured output: constrain the model to our exact schema at decode
          // time. The primitive that makes a local model reliable — no field drift.
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'draft', schema: DRAFT_JSON_SCHEMA },
          },
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`decomposer HTTP ${res.status}`);

      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('decomposer returned empty content');

      const tasks = finalizeTasks(extractTasks(content));
      if (tasks.length === 0) throw new Error('decomposer produced no usable tasks');
      return { triagedBy: 'local', tasks };
    } catch (err) {
      console.error(`LocalLLMDecomposer fell back to stub: ${(err as Error).message}`);
      // Fallback returns the stub's result, which honestly reports triagedBy: 'stub'.
      return this.fallback.decompose(input);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// CliDecomposer — any "-p style" CLI as the model (ollama, claude, …)
// ---------------------------------------------------------------------------

/** A CLI runner: spawn `cmd args…`, feed the prompt on stdin, resolve stdout. */
export type CliRun = (cmd: string, args: string[], input: string) => Promise<string>;

/** Default args for known CLIs; otherwise rely on DECOMPOSER_ARGS. `{model}` is substituted. */
function defaultCliArgs(cmd: string, model: string): string[] {
  const envArgs = process.env.DECOMPOSER_ARGS;
  // Substitute {model} anywhere in a token, so `--model={model}` works too.
  if (envArgs)
    return envArgs
      .split(/\s+/)
      .filter(Boolean)
      .map((a) => a.split('{model}').join(model));
  const base = cmd.split('/').pop();
  if (base === 'ollama') return ['run', model];
  if (base === 'claude') return ['-p'];
  return [];
}

/**
 * Decompose by shelling out to any CLI that takes a prompt on stdin and prints
 * the model's reply (Ollama by default; `claude -p`, llamafile, etc. all work).
 * The Node-only spawn helper is imported lazily so this module stays Worker-safe.
 * Like LocalLLMDecomposer, falls back to the stub on any failure.
 *
 *   DECOMPOSER=cli  DECOMPOSER_CMD=ollama  DECOMPOSER_MODEL=glm-4.7-flash:latest
 *   DECOMPOSER=cli  DECOMPOSER_CMD=claude  DECOMPOSER_ARGS="-p"
 */
export class CliDecomposer implements Decomposer {
  private fallback = new StubDecomposer();

  constructor(
    private opts: {
      cmd?: string;
      args?: string[];
      model?: string;
      timeoutMs?: number;
      run?: CliRun;
    } = {},
  ) {}

  async decompose(input: IntakeInput): Promise<DecomposeResult> {
    const cmd = this.opts.cmd ?? process.env.DECOMPOSER_CMD ?? 'ollama';
    const model = this.opts.model ?? process.env.DECOMPOSER_MODEL ?? 'glm-4.7-flash:latest';
    const args = this.opts.args ?? defaultCliArgs(cmd, model);
    const timeoutMs = this.opts.timeoutMs ?? Number(process.env.DECOMPOSER_TIMEOUT_MS ?? 240_000);
    const run =
      this.opts.run ??
      (async (c, a, inp) => (await import('../spawn.js')).spawnCli(c, a, inp, timeoutMs));

    // No system/user split on a CLI — one prompt, with an explicit JSON nudge.
    const prompt =
      `${SYSTEM_PROMPT}\n\n` +
      `Respond with ONLY a JSON object of the form {"tasks": [ … ]} and nothing else.\n\n` +
      userMessage(input);

    try {
      const out = await run(cmd, args, prompt);
      const tasks = finalizeTasks(extractTasks(out));
      if (tasks.length === 0) throw new Error('decomposer produced no usable tasks');
      return { triagedBy: 'local', tasks };
    } catch (err) {
      console.error(`CliDecomposer fell back to stub: ${(err as Error).message}`);
      return this.fallback.decompose(input);
    }
  }
}

/**
 * The decomposer the pipeline uses, chosen by env at call time:
 *   DECOMPOSER=cli   → CliDecomposer (any "-p style" CLI; ollama default)
 *   DECOMPOSER=local → LocalLLMDecomposer (OpenAI-compatible HTTP; ollama default)
 *   otherwise        → StubDecomposer (deterministic; default, used by tests)
 * Note: the model decomposers only run on Node (local control plane); the Worker
 * has neither a subprocess nor a reachable local endpoint, so it uses the stub.
 */
export function getDecomposer(): Decomposer {
  switch (process.env.DECOMPOSER) {
    case 'cli':
      return new CliDecomposer();
    case 'local':
      return new LocalLLMDecomposer();
    default:
      return new StubDecomposer();
  }
}
