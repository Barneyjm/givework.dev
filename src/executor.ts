import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
   * yields a terminal one-shot submit. 'decomposition' is the "this task is too
   * big for its budget — here is the split" deliverable (see SYSTEM_PROMPT); the
   * stub executor leaves all of these unset.
   */
  outcome?: 'progress' | 'dead_end' | 'candidate_solution' | 'decomposition';
  summary?: string;
  artifact_uri?: string;
  artifact?: unknown;
  state_update?: unknown;
  /**
   * True when this result was salvaged from a run the timeout killed: the
   * volunteer's tokens were genuinely burned, so whatever accumulated is
   * submitted as a progress contribution instead of vanishing. The run loop
   * uses this to message honestly and to tune its abort heuristics — a salvaged
   * timeout is not a config/credential failure.
   */
  timed_out?: boolean;
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
Do the task rigorously and respond with ONLY a single JSON object matching the requested output shape — no preamble, no markdown fences, no commentary. If no shape is given, return {"output": <your result as a string>}.

BUDGET HONESTY — decomposition as a deliverable. Each task has a hard cost cap and a bounded time window. If, once you understand the task, it plainly cannot fit its budget or window, do NOT grind at it until the clock kills the run — that burns the donation and records nothing. The CORRECT deliverable for an oversized task is a decomposition proposal. Add a "decomposition" key to your JSON object:
  "decomposition": {
    "reason": "<why this task exceeds its budget, in one or two sentences>",
    "subtasks": [
      {"title": "<short title>", "prompt": "<complete, self-contained prompt for the agent that will work it>",
       "kind": "computational|counterexample_search|formalization|lemma|exploration",
       "effort": "low|medium|high", "est_cost_cents": <int>, "max_cost_cents": <int>}
    ]
  }
Rules: at most 12 subtasks that will invoke a model; every cost is integer cents; each subtask's max_cost_cents is at most TWICE this task's own cap. Sandbox CHUNK subtasks — those additionally carrying "code": {"repo", "sha" (full 40-hex commit), "entrypoint", "input"} pinning one ALREADY-MERGED program that every chunk shares (only "input" varies per slice) — run on donated CPU, not tokens, and may fan wider: up to 64 chunks per proposal. Where the work is a large mechanical search (the Lander–Parkin pattern that disproved Euler's sum-of-powers conjecture), prefer the two-phase shape: ONE subtask that writes a small, reviewable search program (a code contribution that gets human-reviewed, merged, and pinned by commit SHA), then — in a later decomposition, once that SHA exists — the cheap sandboxed chunk subtasks that each run the pinned program over one slice of the search space. A good plan IS a successful contribution: another volunteer's agent reviews it, and if approved the subtasks are published as real tasks. Grinding to timeout is the failure mode; the plan is success.`;

// ---------------------------------------------------------------------------
// ClaudeCliExecutor — the production path. Runs the task on the volunteer's
// `claude -p` (Claude Code CLI) subscriber credit. No API key; the CLI uses the
// machine's logged-in Claude session.
//
// Output format: `--output-format stream-json` (newline-delimited events), NOT
// the buffered `json` format. The buffered format prints its single JSON object
// only at process exit, so killing a timed-out run left literally nothing on
// stdout — the volunteer's tokens burned with zero record. The stream format
// emits each completed assistant message (and, with --include-partial-messages,
// the in-flight text deltas) as it happens, so at kill time stdout holds every
// event that had occurred; a clean run ends with a `result` event carrying the
// same fields (`result`, `total_cost_usd`, `usage`, …) the old format returned.
// ---------------------------------------------------------------------------

/**
 * A `claude -p` run the timeout killed. Carries whatever had reached stdout by
 * kill time so the caller can salvage partial work instead of losing the run.
 */
export class ExecTimeoutError extends Error {
  constructor(
    public readonly partialOutput: string,
    public readonly elapsedMs: number,
  ) {
    super(`claude -p timed out after ${Math.round(elapsedMs / 1000)}s`);
    this.name = 'ExecTimeoutError';
  }
}

/**
 * Spawn `claude` with args, feed `input` on stdin, resolve stdout. Throws on
 * non-zero exit / spawn error; a timeout kills the child and throws
 * ExecTimeoutError carrying the partial stdout (rejected from the 'close'
 * handler so anything the dying process flushed is still captured).
 */
function spawnClaude(
  args: string[],
  input: string,
  timeoutMs: number,
  opts: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });
    const started = Date.now();
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
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
      if (timedOut) reject(new ExecTimeoutError(out, Date.now() - started));
      else if (code === 0) resolve(out);
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

/** What we could reconstruct from a (possibly truncated) stream-json transcript. */
export interface StreamCapture {
  /** The final `result` event of a clean run (or a legacy single-object reply). */
  final: any | null;
  /** Text of every COMPLETED assistant message, in order. */
  text: string;
  /** Summed per-message token usage from assistant events (approximate). */
  usage: Usage;
  /** How many events parsed — 0 means nothing usable reached stdout. */
  events: number;
}

/**
 * Parse `claude -p --output-format stream-json` output — tolerantly, because on
 * a timeout the transcript is truncated mid-stream. Also accepts the legacy
 * single-JSON-object shape (`--output-format json`) so an older CLI, or a test
 * fake, still parses: a whole-string parse that yields an object with a
 * `result`/`is_error` field is treated as the final event directly.
 */
export function parseStreamCapture(raw: string): StreamCapture {
  const cap: StreamCapture = { final: null, text: '', usage: {}, events: 0 };
  const addUsage = (u: any) => {
    if (!u || typeof u !== 'object') return;
    for (const k of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ] as const) {
      if (typeof u[k] === 'number') cap.usage[k] = (cap.usage[k] ?? 0) + u[k];
    }
  };
  const trimmed = raw.trim();
  if (!trimmed) return cap;

  // Legacy / whole-object shape first (also covers a pretty-printed test fake).
  try {
    const whole = JSON.parse(trimmed);
    if (whole && typeof whole === 'object' && !Array.isArray(whole) && whole.type !== 'assistant') {
      if (whole.type === 'result' || 'result' in whole || 'is_error' in whole) {
        cap.final = whole;
        cap.events = 1;
        addUsage(whole.usage);
        return cap;
      }
    }
  } catch {
    // not a single object — fall through to line-by-line
  }

  let deltaText = ''; // in-flight message text, superseded when the message completes
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let ev: any;
    try {
      ev = JSON.parse(l);
    } catch {
      continue; // a truncated final line is expected on a killed run
    }
    cap.events++;
    if (ev?.type === 'assistant') {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            cap.text += (cap.text ? '\n' : '') + block.text;
          }
        }
      }
      addUsage(ev.message?.usage);
      deltaText = ''; // the completed message supersedes its own deltas
    } else if (
      ev?.type === 'stream_event' &&
      ev.event?.type === 'content_block_delta' &&
      ev.event.delta?.type === 'text_delta' &&
      typeof ev.event.delta.text === 'string'
    ) {
      deltaText += ev.event.delta.text;
    } else if (ev?.type === 'result') {
      cap.final = ev;
    }
  }
  // A killed run's last message never completed — its deltas are the freshest
  // (and often the only) partial findings, so keep them.
  if (deltaText) cap.text += (cap.text ? '\n' : '') + deltaText;
  return cap;
}

/** Rough chars→tokens estimate (≈4 chars/token) for runs that died before any usage event. */
const estTokens = (chars: number) => Math.ceil(chars / 4);

type CliRunner = (
  args: string[],
  input: string,
  timeoutMs: number,
  opts?: { cwd?: string },
) => Promise<string>;

/** Ceiling on a task-advertised timeout, so a bad spec can't hang a runner. */
const MAX_TASK_TIMEOUT_MS = 30 * 60_000;

/**
 * The agent-curated salvage file. Each execution gets a fresh working
 * directory; the prompt tells the agent its real time budget and to append
 * findings to PROGRESS.md AS IT GOES. On a timeout that file — the agent's own
 * account of where it got to — is the primary salvage; the stream capture is
 * the fallback. On success the file is ignored (the JSON contract stands).
 *
 * Tool permissions (verified end-to-end against the real CLI): `claude -p`
 * denies file tools by default (no interactive prompt to approve them), so the
 * invocation grants exactly `--allowedTools "Write(PROGRESS.md),Edit(PROGRESS.md)"`
 * — Write/Edit on that one relative path, resolved inside the per-run working
 * directory the child is spawned in. No Bash, no other paths, nothing else.
 */
export const PROGRESS_FILE = 'PROGRESS.md';
const PROGRESS_ALLOWED_TOOLS = `Write(${PROGRESS_FILE}),Edit(${PROGRESS_FILE})`;
/** Read cap for a salvaged PROGRESS.md — matches the server's state-size bound. */
const PROGRESS_FILE_MAX_CHARS = 64_000;

export class ClaudeCliExecutor implements Executor {
  private run: CliRunner;
  private timeoutMs: number;

  constructor(opts: { run?: CliRunner; timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    // The per-task override is consulted at call time so a long-running task
    // (authoring a whole Manim scene runs ~13 minutes) can widen the window
    // without every task paying for it.
    this.run = opts.run ?? ((args, input, timeoutMs, o) => spawnClaude(args, input, timeoutMs, o));
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
    const timeoutMs = this.timeoutFor(task);
    const budgetMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    const prompt =
      `${SYSTEM_PROMPT}\n\n` +
      `Task: ${task.title}\n\n${task.spec?.prompt ?? ''}\n` +
      (task.spec?.output_schema
        ? `Output shape (JSON keys → type): ${JSON.stringify(task.spec.output_schema)}\n`
        : '') +
      (task.spec?.acceptance ? `Acceptance: ${task.spec.acceptance}\n` : '') +
      // The progress-file protocol: the agent knows its real deadline and keeps
      // its own salvage current, so a killed run submits the agent's OWN account
      // of where it got to — better than anything we can scrape from the stream.
      `\nTIME BUDGET: this run is killed after ~${budgetMinutes} minute(s). As you work, ` +
      `append your findings to a file named ${PROGRESS_FILE} in the current working directory ` +
      `(you have permission to Write/Edit exactly that file): current frontier, partial ` +
      `results, dead ends ruled out, and the concrete next step. Keep it current — if the ` +
      `clock kills this run, ${PROGRESS_FILE} is salvaged and submitted as your progress ` +
      `contribution for the next agent to continue from. If you finish in time, reply with ` +
      `the JSON object as instructed; ${PROGRESS_FILE} is then ignored.\n`;

    // NOTE: we do NOT pass `--json-schema`. With that flag, `claude -p` runs and
    // bills but returns an empty `result` field (the structured output doesn't
    // come back where --output-format json puts the text), so we'd submit a blank
    // deliverable and still charge the donation. The system prompt + the output
    // shape in the prompt already steer the model to a JSON object, and
    // coerceResult parses it. STAGE 8: cap usage so a task can't exceed its cap.
    //
    // stream-json (with --verbose, which the CLI requires alongside it, and
    // --include-partial-messages for in-flight text) so a timed-out run leaves
    // salvageable output on stdout — see the header comment above.
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Narrow file grant for the progress-file protocol: Write/Edit on
      // PROGRESS.md only, inside the per-run working directory (the child's
      // cwd). Everything else stays denied, as -p denies by default.
      '--allowedTools',
      PROGRESS_ALLOWED_TOOLS,
      '--model',
      model,
    ];

    // Fresh working directory per run — where PROGRESS.md lives, and all the
    // agent can write. Removed after the run either way (on success the JSON
    // contract stands and the file is ignored).
    const workdir = await mkdtemp(join(tmpdir(), 'givework-run-'));
    let raw: string;
    try {
      raw = await this.run(args, prompt, timeoutMs, { cwd: workdir });
    } catch (err) {
      if (err instanceof ExecTimeoutError) {
        // The timeout killed the run. The tokens are already spent from the
        // volunteer's subscription — salvage what accumulated into a progress
        // contribution instead of letting the run vanish without a record.
        // The agent-curated PROGRESS.md is the primary salvage; the stream
        // capture inside salvageTimedOutRun is the fallback.
        const progressFile = await readFile(join(workdir, PROGRESS_FILE), 'utf8')
          .then((s) => s.slice(0, PROGRESS_FILE_MAX_CHARS))
          .catch(() => null);
        return salvageTimedOutRun(task, model, prompt, err, progressFile);
      }
      throw err;
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }

    const capture = parseStreamCapture(raw);
    const data: any = capture.final;
    if (!data) {
      throw new Error(`claude -p returned no result event: ${raw.slice(0, 200)}`);
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

    // The agent judged the task oversized and delivered a split instead of
    // grinding (see SYSTEM_PROMPT). Tag the outcome so the runner submits it as
    // a decomposition contribution; the control plane validates the proposal and
    // mints the peer-review task. Only the shape is checked here — a bare
    // `decomposition` key on an ordinary answer must not hijack the submit.
    const proposal = (result as { decomposition?: { subtasks?: unknown } })?.decomposition;
    const isDecomposition = Array.isArray(proposal?.subtasks) && proposal.subtasks.length > 0;

    return {
      result,
      summary,
      outcome: isDecomposition ? 'decomposition' : undefined,
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

/** How much salvaged partial text is kept inline (state stays small by design). */
const SALVAGE_STATE_CHARS = 4_000;
const SALVAGE_ARTIFACT_CHARS = 16_000;

/**
 * Build the progress contribution for a run the timeout killed. Honesty rules:
 *
 *  - The COST is an estimate and is labelled as one. A killed run never reports
 *    `total_cost_usd`, so we meter what we saw: summed usage from the streamed
 *    assistant events when any arrived, else a chars/4 token estimate over the
 *    prompt we sent plus whatever text came back (the prompt was certainly
 *    processed, so the floor is 1 cent — "free" would be a lie).
 *  - The STATE is merged, not replaced. state_update overwrites the target's
 *    compacted working set, and a timeout's fragments must never clobber the
 *    accumulated frontier — so the salvage rides in under a `timeout_salvage`
 *    key beside the existing state. If there is no partial text, or the current
 *    state isn't a mergeable object, no state_update is sent at all.
 *  - Whatever text was captured is preserved in full (bounded) as the
 *    contribution's inline result/artifact, so the next agent can continue
 *    rather than restart. If truly nothing was captured, the contribution still
 *    records the attempt — that a full window produced nothing is itself
 *    information the next agent (and the platform's estimates) should have.
 */
function salvageTimedOutRun(
  task: ExecTask,
  model: string,
  prompt: string,
  err: ExecTimeoutError,
  progressFile: string | null = null,
): ExecResult {
  const capture = parseStreamCapture(err.partialOutput);
  const text = capture.text.trim();
  const progress = progressFile?.trim() ?? '';
  // The agent's own account of where it got to beats anything scraped from the
  // stream — it was written for exactly this moment. Fallback order:
  // PROGRESS.md -> stream capture -> bare attempt record.
  const salvage = progress || text;
  const source = progress ? 'progress_file' : text ? 'stream' : 'none';
  const minutes = Math.max(1, Math.round(err.elapsedMs / 60_000));

  const sawUsage = Object.values(capture.usage).some((v) => (v ?? 0) > 0);
  const usage: Usage = sawUsage
    ? capture.usage
    : {
        input_tokens: estTokens(prompt.length),
        // The file was written by the run too — its chars were paid output.
        output_tokens: estTokens(text.length + progress.length),
      };
  const cents = Math.max(1, usageToCents(model, usage));

  const summary =
    `Attempted "${task.title}" but the run timed out after ${minutes} minute(s). ` +
    (source === 'progress_file'
      ? `The agent's own ${PROGRESS_FILE} was salvaged and is attached for the next agent to continue from.`
      : source === 'stream'
        ? 'Partial output was captured and is attached for the next agent to continue from.'
        : 'No partial output could be captured before the kill; a full window produced nothing visible — consider a smaller chunk or a decomposition.');

  // Merge-don't-clobber: only extend a plain-object state, never replace it.
  const prior = task.target_state;
  const mergeable = prior == null || (typeof prior === 'object' && !Array.isArray(prior));
  const state_update =
    salvage && mergeable
      ? {
          ...(prior as Record<string, unknown> | null | undefined),
          timeout_salvage: {
            task_id: task.task_id,
            elapsed_ms: err.elapsedMs,
            source,
            partial: salvage.slice(0, SALVAGE_STATE_CHARS),
          },
        }
      : undefined;

  return {
    result: {
      timed_out: true,
      ...(progress ? { progress_file: progress.slice(0, SALVAGE_ARTIFACT_CHARS) } : {}),
      ...(text ? { partial_output: text.slice(0, SALVAGE_ARTIFACT_CHARS) } : {}),
    },
    outcome: 'progress',
    timed_out: true,
    summary,
    state_update,
    actual_cost_cents: cents,
    raw_usage: {
      model,
      timed_out: true,
      elapsed_ms: err.elapsedMs,
      estimated: true,
      estimator: sawUsage ? 'streamed_usage' : 'char_heuristic',
      salvage_source: source,
      usage,
    },
  };
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
