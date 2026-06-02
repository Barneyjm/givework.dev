import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';

// Task execution — the actual donated work. This runs on the VOLUNTEER's own
// Anthropic credit (the donation), which is the whole point of the platform, and
// is deliberately separate from intake decomposition (which runs free + local on
// the platform; see src/intake/decompose.ts).
//
// Swappable behind the Executor interface:
//   - StubExecutor      — no model, deterministic. Default + used in tests.
//   - ClaudeCliExecutor — PRODUCTION. Shells out to `claude -p --output-format json`,
//     running on the volunteer's Claude Code CLI subscriber credit. There is NO
//     ANTHROPIC_API_KEY in this system — the donated capacity is each subscriber's
//     `claude -p` usage. The CLI's own `total_cost_usd` is the metered cost.
//   - ClaudeExecutor    — reference Anthropic SDK impl (EXECUTOR=claude-api). Useful
//     for unit-testing the parse/metering path; not the path we ship.
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

// ---------------------------------------------------------------------------
// ClaudeExecutor — a real Messages API call on the volunteer's credit.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a task executor for Givework, where developers donate AI inference to nonprofits.
You are given one concrete task with a prompt, an expected output shape, and acceptance criteria.
Do the task and respond with ONLY a single JSON object matching the requested output shape — no preamble, no markdown fences, no commentary. If no shape is given, return {"output": <your result as a string>}.`;

// Bound any single task's output so it can't blow its reserved cap; the ledger's
// submit-clamp is the backstop, but capping max_tokens avoids the overage entirely.
const OUTPUT_TOKEN_CEILING = 4096;

type MessagesClient = {
  messages: { create: (body: any) => Promise<any> };
};

export class ClaudeExecutor implements Executor {
  private client: MessagesClient;

  constructor(opts: { client?: MessagesClient } = {}) {
    // The SDK reads ANTHROPIC_API_KEY from the environment (the volunteer's key).
    this.client = opts.client ?? (new Anthropic() as unknown as MessagesClient);
  }

  async execute(task: ExecTask): Promise<ExecResult> {
    const model = PRICING[task.model] ? task.model : DEFAULT_MODEL;
    const p = pricingFor(model);

    // Cap output tokens by what the reservation can afford (then a hard ceiling).
    const affordableOut = Math.floor(task.max_cost_cents / centsPerToken(p.out));
    const maxTokens = Math.max(256, Math.min(OUTPUT_TOKEN_CEILING, affordableOut));

    const userContent =
      `Task: ${task.title}\n\n` +
      `${task.spec?.prompt ?? ''}\n\n` +
      (task.spec?.output_schema
        ? `Output shape (JSON keys → type): ${JSON.stringify(task.spec.output_schema)}\n`
        : '') +
      (task.spec?.acceptance ? `Acceptance: ${task.spec.acceptance}\n` : '');

    const message = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      // Cache the shared system prompt across the runner's task loop (prefix match).
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    });

    const text = (message.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim();

    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      // Model didn't return clean JSON — keep the raw text rather than failing.
      result = { output: text };
    }

    const usage: Usage = message.usage ?? {};
    return {
      result,
      actual_cost_cents: usageToCents(model, usage),
      raw_usage: { model, ...usage },
    };
  }
}

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

    // STAGE 8: pass --json-schema (built from output_schema) for guaranteed-shaped
    // output, and cap usage so a task can't exceed its reserved budget.
    const raw = await this.run(['-p', '--output-format', 'json', '--model', model], prompt);

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`claude -p returned non-JSON output: ${raw.slice(0, 200)}`);
    }
    if (data.is_error) {
      throw new Error(`claude -p reported an error: ${String(data.result ?? data.error ?? 'unknown')}`);
    }

    let result: unknown;
    try {
      result = JSON.parse(data.result);
    } catch {
      result = { output: data.result };
    }

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
 *   EXECUTOR=claude     → ClaudeCliExecutor (production — the volunteer's `claude -p` credit)
 *   EXECUTOR=claude-api → ClaudeExecutor (reference Anthropic SDK impl)
 *   otherwise           → StubExecutor (deterministic; default, used by tests)
 */
export function getExecutor(): Executor {
  if (process.env.EXECUTOR === 'claude') return new ClaudeCliExecutor();
  if (process.env.EXECUTOR === 'claude-api') return new ClaudeExecutor();
  return new StubExecutor();
}
