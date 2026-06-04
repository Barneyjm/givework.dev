import { spawn } from 'node:child_process';

// Task execution — the actual donated work. The donation is each monthly
// subscriber's `claude -p` (Claude Code CLI) capacity — the credit Anthropic
// already includes with a subscription. There is deliberately NO Anthropic SDK
// and NO ANTHROPIC_API_KEY anywhere in this system: an API-key path would be paid
// usage, which is not the model. Execution is separate from intake decomposition
// (which runs free + local on the platform; see src/intake/decompose.ts).
//
// Swappable behind the Executor interface:
//   - StubExecutor      — no model, deterministic. Default + used in tests.
//   - ClaudeCliExecutor — PRODUCTION. Shells out to `claude -p --output-format json`
//     on the volunteer's logged-in Claude Code session. The CLI's own
//     `total_cost_usd` is the metered cost; no key, no API billing.
//
// Unlike the decomposer, execution NEVER silently falls back to a stub on
// failure: submitting fabricated output as if it were real work would corrupt
// the ledger and the nonprofit's deliverable. A real executor throws; the runner
// releases the task so another volunteer can pick it up.

export interface ExecTask {
  task_id: string;
  title: string;
  model: string;
  max_cost_cents: number;
  spec: {
    prompt?: string;
    output_schema?: Record<string, string>;
    acceptance?: string;
    [k: string]: unknown;
  };
}

export interface ExecResult {
  result: unknown;
  actual_cost_cents: number;
  raw_usage: unknown;
}

export interface Executor {
  execute(task: ExecTask): Promise<ExecResult>;
}

// USD per 1M tokens (from the Claude model catalog). Used to meter the donation
// into integer cents so the ledger reflects real spend.
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function pricingFor(model: string) {
  return PRICING[model] ?? PRICING[DEFAULT_MODEL];
}

/** Strip a surrounding ```json … ``` (or bare ```) fence, if present. */
function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : t;
}

/**
 * Parse a model's text into structured output: tolerate a markdown code fence,
 * and if it still isn't JSON, keep the raw text under `output` rather than fail.
 */
export function coerceResult(text: string): unknown {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return { output: text.trim() };
  }
}

/**
 * Turn a task's loose output_schema (key → type-ish string) into a real JSON
 * Schema for `claude -p --json-schema`, so the CLI returns guaranteed-shaped JSON.
 */
export function outputSchemaToJsonSchema(
  shape: Record<string, string> | undefined,
): Record<string, unknown> | null {
  if (!shape || Object.keys(shape).length === 0) return null;
  const properties: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(shape)) {
    const t = String(raw).toLowerCase();
    if (t.endsWith('[]') || t.startsWith('array')) properties[key] = { type: 'array' };
    else if (t.startsWith('object')) properties[key] = { type: 'object' };
    else if (t.startsWith('bool')) properties[key] = { type: 'boolean' };
    else if (t.startsWith('int') || t.startsWith('num') || t.startsWith('float'))
      properties[key] = { type: 'number' };
    else properties[key] = { type: 'string' };
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(shape),
    additionalProperties: false,
  };
}

/** cents per token for a $/1M-token rate. */
const centsPerToken = (per1M: number) => per1M / 10_000;

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Meter token usage into integer cents. Cache reads bill ~0.1x input, cache
 * writes ~1.25x input (Anthropic prompt-cache economics). Round up so the
 * platform never under-charges the donation.
 */
export function usageToCents(model: string, usage: Usage): number {
  const p = pricingFor(model);
  const inR = centsPerToken(p.in);
  const outR = centsPerToken(p.out);
  const cents =
    (usage.input_tokens ?? 0) * inR +
    (usage.output_tokens ?? 0) * outR +
    (usage.cache_read_input_tokens ?? 0) * inR * 0.1 +
    (usage.cache_creation_input_tokens ?? 0) * inR * 1.25;
  return Math.max(0, Math.ceil(cents));
}

// ---------------------------------------------------------------------------
// StubExecutor — no model. Reports ~80% of the cap as "spent".
// ---------------------------------------------------------------------------

export class StubExecutor implements Executor {
  async execute(task: ExecTask): Promise<ExecResult> {
    const prompt = task.spec?.prompt ?? task.title;
    console.log(`     … would call Claude here (model ${task.model}) on: "${prompt}"`);
    const actual = Math.round(task.max_cost_cents * 0.8);
    return {
      result: { stub: true, summary: `Stubbed completion for "${task.title}".`, echoed_prompt: prompt },
      actual_cost_cents: actual,
      raw_usage: { stub: true, model: task.model, simulated_cost_cents: actual },
    };
  }
}

// System prompt for the executor that calls a model (ClaudeCliExecutor).
const SYSTEM_PROMPT = `You are a task executor for Givework, where developers donate AI inference to nonprofits.
You are given one concrete task with a prompt, an expected output shape, and acceptance criteria.
Do the task and respond with ONLY a single JSON object matching the requested output shape — no preamble, no markdown fences, no commentary. If no shape is given, return {"output": <your result as a string>}.`;

// ---------------------------------------------------------------------------
// ClaudeCliExecutor — the production path. Runs the task on the volunteer's
// `claude -p` (Claude Code CLI) subscriber credit. No API key; the CLI uses the
// machine's logged-in Claude session. `--output-format json` returns the result
// plus `total_cost_usd` — the honest, already-metered cost of the run.
// ---------------------------------------------------------------------------

/** Spawn `claude` with args, feed `input` on stdin, resolve stdout. Throws on non-zero exit / spawn error / timeout. */
function spawnClaude(args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude -p timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude (is the CLI installed and logged in?): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`));
    });
    // If claude fails to spawn or exits before reading stdin, writing here emits
    // EPIPE on the stream; without a listener Node crashes the whole runner. The
    // spawn failure itself is already surfaced via child.on('error') above.
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

type CliRunner = (args: string[], input: string) => Promise<string>;

export class ClaudeCliExecutor implements Executor {
  private run: CliRunner;
  private timeoutMs: number;

  constructor(opts: { run?: CliRunner; timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.run = opts.run ?? ((args, input) => spawnClaude(args, input, this.timeoutMs));
  }

  async execute(task: ExecTask): Promise<ExecResult> {
    const model = task.model || DEFAULT_MODEL;
    const prompt =
      `${SYSTEM_PROMPT}\n\n` +
      `Task: ${task.title}\n\n${task.spec?.prompt ?? ''}\n` +
      (task.spec?.output_schema
        ? `Output shape (JSON keys → type): ${JSON.stringify(task.spec.output_schema)}\n`
        : '') +
      (task.spec?.acceptance ? `Acceptance: ${task.spec.acceptance}\n` : '');

    // When the task declares an output shape, hand the CLI a JSON Schema so it
    // returns guaranteed-shaped JSON (no markdown fences, no parsing guesswork).
    // STAGE 8: cap usage so a task can't exceed its reserved budget.
    const args = ['-p', '--output-format', 'json', '--model', model];
    const schema = outputSchemaToJsonSchema(task.spec?.output_schema);
    if (schema) args.push('--json-schema', JSON.stringify(schema));

    const raw = await this.run(args, prompt);

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`claude -p returned non-JSON output: ${raw.slice(0, 200)}`);
    }
    if (data.is_error) {
      throw new Error(`claude -p reported an error: ${String(data.result ?? data.error ?? 'unknown')}`);
    }

    const result = coerceResult(String(data.result ?? ''));

    // Prefer the CLI's own cost figure; fall back to token metering if absent.
    const cents =
      typeof data.total_cost_usd === 'number'
        ? Math.ceil(data.total_cost_usd * 100)
        : usageToCents(model, data.usage ?? {});

    return {
      result,
      actual_cost_cents: cents,
      raw_usage: {
        model,
        total_cost_usd: data.total_cost_usd,
        usage: data.usage,
        duration_ms: data.duration_ms,
        num_turns: data.num_turns,
      },
    };
  }
}

/**
 * The executor the runner uses, chosen by env:
 *   EXECUTOR=claude → ClaudeCliExecutor (production — the volunteer's `claude -p` credit)
 *   otherwise       → StubExecutor (deterministic; default, used by tests)
 * There is intentionally no API-key/SDK option — donated capacity is `claude -p`.
 */
export function getExecutor(): Executor {
  if (process.env.EXECUTOR === 'claude') return new ClaudeCliExecutor();
  return new StubExecutor();
}
