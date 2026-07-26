import { spawn } from 'node:child_process';
import { extractWorkUnit, WorkUnitExecutor } from './workunit.js';

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
// the ledger and the contribution record. A real executor throws; the runner
// releases the task so another volunteer can pick it up.

export type Effort = 'low' | 'medium' | 'high';

export interface ExecTask {
  task_id: string;
  title: string;
  /** Legacy: the concrete model a task named. Superseded by `effort`. */
  model: string;
  /** How much reasoning this task needs. The runner maps it to a real model. */
  effort?: Effort;
  max_cost_cents: number;
  spec: {
    prompt?: string;
    output_schema?: Record<string, string>;
    acceptance?: string;
    [k: string]: unknown;
  };
  /**
   * The target's compacted working set at checkout — the accumulated frontier a
   * resumable task hands to whoever picks it up next. Work units merge it into
   * the driver's stdin so a re-picked task advances from the live cursor rather
   * than restarting from the static spec input.
   */
  target_state?: unknown;
}

export interface ExecResult {
  result: unknown;
  actual_cost_cents: number;
  raw_usage: unknown;
  /**
   * Continuation fields (optional). An executor that chips at a long-lived task
   * sets these so the runner records progress and hands off state; omitting them
   * yields a terminal one-shot submit. Wired up when executors learn the task
   * kinds (later phase) — the stub executor leaves them unset.
   */
  outcome?: 'progress' | 'dead_end' | 'candidate_solution';
  summary?: string;
  artifact_uri?: string;
  artifact?: unknown;
  state_update?: unknown;
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

/**
 * Tier -> model, resolved on the volunteer's machine.
 *
 * This mapping deliberately lives here and not in the task: the control plane
 * has no idea which models a given volunteer's plan includes, and a task should
 * outlive any particular model name. A volunteer whose plan lacks Opus, or who
 * would rather spend Sonnet on everything, overrides it:
 *
 *   GIVEWORK_MODEL_HIGH=claude-sonnet-4-6 givework run --watch
 *
 * A different harness (codex, a local model) supplies its own table — the task
 * says "this needs careful reasoning" and each harness answers in its own terms.
 */
const EFFORT_MODELS: Record<Effort, string> = {
  low: 'claude-haiku-4-5',
  medium: 'claude-sonnet-4-6',
  high: 'claude-opus-4-8',
};

export function modelForEffort(
  effort: Effort | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const tier: Effort = effort ?? 'medium';
  const override = env[`GIVEWORK_MODEL_${tier.toUpperCase()}`];
  return override?.trim() ? override.trim() : EFFORT_MODELS[tier];
}

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
  const t = text.trim();
  try {
    return JSON.parse(stripCodeFence(t));
  } catch {
    // fall through to the prose-tolerant paths
  }
  // Models sometimes wrap the JSON in explanatory prose ("here is the
  // contribution: ```json ...```"). Try every fenced block, then the widest
  // brace-delimited span, before falling back to raw text under `output`.
  for (const m of t.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
    try {
      return JSON.parse(m[1].trim());
    } catch {
      // not this block — keep looking
    }
  }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch {
      // not parseable either — fall back to raw text
    }
  }
  return { output: t };
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
      result: {
        stub: true,
        summary: `Stubbed completion for "${task.title}".`,
        echoed_prompt: prompt,
      },
      actual_cost_cents: actual,
      raw_usage: { stub: true, model: task.model, simulated_cost_cents: actual },
    };
  }
}

// System prompt for the executor that calls a model (ClaudeCliExecutor).
const SYSTEM_PROMPT = `You are a task executor for Givework, where developers donate AI compute to open mathematics.
You are given one concrete task — an attack on an open problem — with a prompt, an expected output shape, and acceptance criteria.
Do the task rigorously and respond with ONLY a single JSON object matching the requested output shape — no preamble, no markdown fences, no commentary. If no shape is given, return {"output": <your result as a string>}.`;

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
      reject(
        new Error(`failed to spawn claude (is the CLI installed and logged in?): ${e.message}`),
      );
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

type CliRunner = (args: string[], input: string, timeoutMs: number) => Promise<string>;

/** Ceiling on a task-advertised timeout, so a bad spec can't hang a runner. */
const MAX_TASK_TIMEOUT_MS = 30 * 60_000;

export class ClaudeCliExecutor implements Executor {
  private run: CliRunner;
  private timeoutMs: number;

  constructor(opts: { run?: CliRunner; timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    // The per-task override is consulted at call time so a long-running task
    // (authoring a whole Manim scene runs ~13 minutes) can widen the window
    // without every task paying for it.
    this.run = opts.run ?? ((args, input, timeoutMs) => spawnClaude(args, input, timeoutMs));
  }

  /**
   * How long this task may take. A task can advertise `spec.suggested_timeout_ms`
   * — the platform's estimate of the work — which raises (never lowers) the
   * runner's own limit, and is capped so a bad spec can't hang a volunteer's
   * machine indefinitely.
   */
  private timeoutFor(task: ExecTask): number {
    const hint = Number(
      (task.spec as { suggested_timeout_ms?: unknown } | undefined)?.suggested_timeout_ms,
    );
    if (!Number.isFinite(hint) || hint <= 0) return this.timeoutMs;
    return Math.min(Math.max(hint, this.timeoutMs), MAX_TASK_TIMEOUT_MS);
  }

  async execute(task: ExecTask): Promise<ExecResult> {
    // Prefer the tier. Fall back to a legacy task that named a real model, then
    // to the default — so old rows keep working through the transition.
    const model = task.effort
      ? modelForEffort(task.effort)
      : task.model && task.model !== 'by-effort'
        ? task.model
        : DEFAULT_MODEL;
    const prompt =
      `${SYSTEM_PROMPT}\n\n` +
      `Task: ${task.title}\n\n${task.spec?.prompt ?? ''}\n` +
      (task.spec?.output_schema
        ? `Output shape (JSON keys → type): ${JSON.stringify(task.spec.output_schema)}\n`
        : '') +
      (task.spec?.acceptance ? `Acceptance: ${task.spec.acceptance}\n` : '');

    // NOTE: we do NOT pass `--json-schema`. With that flag, `claude -p` runs and
    // bills but returns an empty `result` field (the structured output doesn't
    // come back where --output-format json puts the text), so we'd submit a blank
    // deliverable and still charge the donation. The system prompt + the output
    // shape in the prompt already steer the model to a JSON object, and
    // coerceResult parses it. STAGE 8: cap usage so a task can't exceed its cap.
    const args = ['-p', '--output-format', 'json', '--model', model];

    const raw = await this.run(args, prompt, this.timeoutFor(task));

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`claude -p returned non-JSON output: ${raw.slice(0, 200)}`);
    }
    if (data.is_error) {
      throw new Error(
        `claude -p reported an error: ${String(data.result ?? data.error ?? 'unknown')}`,
      );
    }

    // An empty result means the run produced no work. Throw so the runner RELEASES
    // the task instead of submitting a blank deliverable (and charging for it).
    const resultText = String(data.result ?? '').trim();
    if (!resultText) {
      throw new Error(
        'claude -p returned an empty result — releasing rather than submitting blank output',
      );
    }
    const result = coerceResult(resultText);

    // Prefer the CLI's own cost figure; fall back to token metering if absent.
    const cents =
      typeof data.total_cost_usd === 'number'
        ? Math.ceil(data.total_cost_usd * 100)
        : usageToCents(model, data.usage ?? {});

    // If the model's JSON includes a `summary` string, forward it as the
    // contribution's handoff note — otherwise the public feed shows an entry
    // with no summary at all.
    const summary =
      typeof (result as { summary?: unknown })?.summary === 'string'
        ? ((result as { summary: string }).summary.slice(0, 500) as string)
        : undefined;

    return {
      result,
      summary,
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
/**
 * Routes each task to the right executor: a task whose spec carries `code`
 * is a CPU work unit (merged contrib code at a pinned SHA, run sandboxed —
 * see src/workunit.ts) regardless of which LLM executor is configured;
 * everything else goes to the inner LLM/stub executor.
 */
class DispatchingExecutor implements Executor {
  constructor(
    private readonly llm: Executor,
    private readonly workunit: Executor,
  ) {}
  execute(task: ExecTask): Promise<ExecResult> {
    const isWorkUnit = !!extractWorkUnit(task.spec);
    return isWorkUnit ? this.workunit.execute(task) : this.llm.execute(task);
  }
}

export function getExecutor(): Executor {
  let llm: Executor;
  if (process.env.EXECUTOR === 'claude') {
    // EXECUTOR_TIMEOUT_MS: how long one `claude -p` run may take before the
    // runner gives up and releases the task (default 180s). Volunteers raise it
    // for deep single-shot tasks on slower models.
    const timeoutMs = Number(process.env.EXECUTOR_TIMEOUT_MS);
    llm = new ClaudeCliExecutor(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {});
  } else {
    llm = new StubExecutor();
  }
  return new DispatchingExecutor(llm, new WorkUnitExecutor());
}
