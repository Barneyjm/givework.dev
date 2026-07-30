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
   * than restarting from the static spec input; LLM executors inject it into the
   * model prompt as the continuation section (buildContinuationSection).
   */
  target_state?: unknown;
  /**
   * Recent contributions to this task at checkout, newest first — what has
   * already been tried (progress, dead ends, salvaged timeouts). Injected into
   * the model prompt alongside `target_state` so a re-picked task continues the
   * accumulated work instead of restarting from the static spec.
   */
  prior_contributions?: PriorContribution[];
}

/** The per-contribution summary a checkout hydrates (see operations.checkoutTask). */
export interface PriorContribution {
  id?: number;
  outcome: string;
  summary: string | null;
  artifact_uri?: string | null;
  /**
   * Inline artifact, present only when the control plane decided the next
   * agent needs the full thing — today that is a salvaged invalid
   * decomposition ({proposed_decomposition, validation_errors}), preserved so
   * the proposal can be corrected and resubmitted instead of re-derived.
   */
  artifact?: unknown;
  cost_cents?: number;
  created_at?: string;
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
  /**
   * True when this result was salvaged from a run that crashed (nonzero exit),
   * reported is_error, or returned an empty result — but had burned real tokens
   * and left recoverable output (PROGRESS.md, streamed partials, or metered
   * usage). Same honesty contract as timed_out: flagged, estimated where the
   * CLI never reported a cost, and messaged truthfully by the run loop.
   */
  crashed?: boolean;
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
 * How the model's deliverable was obtained. Recorded in the contribution's raw
 * metadata (raw_usage.parse_mode) so a mis-parse — the production incident
 * where a decomposition got submitted as a terminal candidate_solution because
 * the real JSON was buried in prose — is diagnosable from the ledger
 * afterwards, not just from a lost stdout.
 *
 *   'structured_output' — the CLI enforced RESULT_JSON_SCHEMA natively and
 *                         handed back a pre-parsed object (the primary layer).
 *   the rest            — rungs of the text-extraction ladder (the fallback
 *                         layer for older CLIs); see coerceResultDetailed.
 */
export type ParseMode = 'structured_output' | 'strict' | 'last_object' | 'fenced' | 'raw_text';

export interface CoercedResult {
  value: unknown;
  parse_mode: ParseMode;
}

/**
 * Keys that mark an object as a plausible result envelope (the shape the
 * SYSTEM_PROMPT asks for). Used to rank brace-scan candidates: a model often
 * narrates an earlier placeholder object ("the final answer will look like
 * {...}") before emitting the real one, and the real one is the LAST object
 * that both parses and carries envelope keys.
 */
const ENVELOPE_KEYS = ['output', 'outcome', 'summary', 'decomposition', 'state_update'] as const;

function looksLikeEnvelope(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    ENVELOPE_KEYS.some((k) => k in (v as Record<string, unknown>))
  );
}

/**
 * From the `{` at `start`, return the index of its matching `}` — tracking
 * nesting depth and ignoring braces inside JSON strings (with escape handling),
 * so `{"note": "a } in a string"}` scans correctly. No regex: a regex cannot
 * balance braces. Returns -1 if unterminated.
 */
function matchingBrace(s: string, start: number): number {
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
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Cap on brace candidates examined, so pathological output can't stall a runner. */
const MAX_BRACE_CANDIDATES = 512;

/**
 * Every top-level balanced-brace span in `s` that parses as JSON, in order of
 * appearance. A span that balances but does not parse (a narrated placeholder
 * with literal `...` values) is stepped INTO rather than skipped, so a real
 * object nested after it is still found.
 */
function collectObjectCandidates(s: string): { value: unknown; envelope: boolean }[] {
  const out: { value: unknown; envelope: boolean }[] = [];
  let attempts = 0;
  let i = s.indexOf('{');
  while (i !== -1 && attempts++ < MAX_BRACE_CANDIDATES) {
    const end = matchingBrace(s, i);
    if (end !== -1) {
      try {
        const value = JSON.parse(s.slice(i, end + 1));
        out.push({ value, envelope: looksLikeEnvelope(value) });
        i = s.indexOf('{', end + 1); // parsed whole — later objects only, not its innards
        continue;
      } catch {
        // balanced but not JSON — look inside and beyond it
      }
    }
    i = s.indexOf('{', i + 1);
  }
  return out;
}

/**
 * The candidate that wins: the LAST envelope-looking object (later beats
 * earlier, and a real result envelope beats a stray non-envelope object that
 * happens to follow it — e.g. a trailing `{"note": …}`); if nothing looks like
 * an envelope, the last object that parsed at all. `undefined` when there are
 * no candidates — JSON.parse can never yield undefined, so it is unambiguous.
 */
function pickCandidate(cands: { value: unknown; envelope: boolean }[]): unknown {
  for (let i = cands.length - 1; i >= 0; i--) {
    if (cands[i].envelope) return cands[i].value;
  }
  return cands.length > 0 ? cands[cands.length - 1].value : undefined;
}

/**
 * Parse a model's text into structured output, recording WHICH rung of the
 * ladder matched. Models wrap the final JSON in explanatory prose, narrate
 * placeholder objects before the real one, and fence things at random — a
 * production run's correct decomposition was mis-routed as a terminal
 * candidate_solution because the old parser gave up on exactly that shape.
 *
 * The ladder:
 *   1. strict      — the whole trimmed output is JSON (or is one fenced JSON
 *                    block, the historical tolerance → 'fenced').
 *   2. last_object — the last complete top-level JSON object in the output,
 *                    scanned with a string-aware brace matcher; envelope-looking
 *                    candidates (output/outcome/summary/decomposition/
 *                    state_update keys) beat non-envelope ones, later beats
 *                    earlier.
 *   3. fenced      — the same search inside ```json fenced blocks, last first.
 *   4. raw_text    — keep the prose under `output`. NEVER throws: unparseable
 *                    output is still real burned donation and is kept + charged.
 */
export function coerceResultDetailed(text: string): CoercedResult {
  const t = text.trim();
  try {
    return { value: JSON.parse(t), parse_mode: 'strict' };
  } catch {
    // fall through
  }
  const stripped = stripCodeFence(t);
  if (stripped !== t) {
    try {
      return { value: JSON.parse(stripped), parse_mode: 'fenced' };
    } catch {
      // fall through
    }
  }
  const whole = pickCandidate(collectObjectCandidates(t));
  if (whole !== undefined) return { value: whole, parse_mode: 'last_object' };
  const fences = [...t.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i][1].trim();
    try {
      return { value: JSON.parse(body), parse_mode: 'fenced' };
    } catch {
      // not directly JSON — scan inside the fence too
    }
    const inner = pickCandidate(collectObjectCandidates(body));
    if (inner !== undefined) return { value: inner, parse_mode: 'fenced' };
  }
  return { value: { output: t }, parse_mode: 'raw_text' };
}

/**
 * Parse a model's text into structured output: tolerate prose and markdown
 * fences, and if nothing parses, keep the raw text under `output` rather than
 * fail. Value-only convenience over coerceResultDetailed.
 */
export function coerceResult(text: string): unknown {
  return coerceResultDetailed(text).value;
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
// Continuation context — the platform's core promise made real on the model
// path. checkoutTask hands back the target's compacted state and the recent
// contributions on this task; if that handoff never reaches the model, every
// attempt restarts from scratch and "resumable" is a lie. This builder turns
// the checkout payload into a clearly-framed prompt section, size-capped so a
// long history can't blow the context window.
// ---------------------------------------------------------------------------

/** Total cap on the injected continuation section. */
export const CONTINUATION_MAX_CHARS = 12_000;
/** Cap on the serialized target state within that budget. */
const CONTINUATION_STATE_MAX_CHARS = 6_000;
/** Cap on any single prior-attempt summary line. */
const CONTINUATION_PRIOR_MAX_CHARS = 700;
/**
 * Cap on a prior's hydrated inline artifact (a salvaged invalid decomposition:
 * the full proposal + validation errors). Sized so state (6k) + one artifact-
 * bearing prior always fit inside CONTINUATION_MAX_CHARS — the salvage must
 * never be the thing the size cap silently drops.
 */
const CONTINUATION_PRIOR_ARTIFACT_MAX_CHARS = 3_000;
/** Head-room kept back so the "[history truncated …]" note always fits the cap. */
const TRUNCATION_NOTE_RESERVE_CHARS = 80;

/** True when the compacted state actually says something (checkout defaults to `{}`). */
function stateHasContent(state: unknown): boolean {
  if (state == null) return false;
  if (typeof state === 'string') return state.trim().length > 0;
  if (Array.isArray(state)) return state.length > 0;
  if (typeof state === 'object') return Object.keys(state as object).length > 0;
  return true;
}

/**
 * Render the accumulated frontier as a prompt section, or '' when there is
 * nothing accumulated (a first attempt stays a clean prompt). Priors arrive
 * newest first from checkout and are kept in that order, so when the size cap
 * bites it is the OLDEST attempts that fall off — with an explicit note, never
 * silently. State that itself exceeds its budget is truncated with a note too:
 * a next agent must never mistake a clipped frontier for the whole frontier.
 *
 * When a prior carries a hydrated artifact (today: a salvaged invalid
 * decomposition, i.e. #87's "fix exactly those errors and resubmit" path) and
 * `maxCostCents` is known, the section also states the computed decomposition
 * limits — the correction context must be self-sufficient, not send the next
 * agent guessing at the cap it just breached.
 */
export function buildContinuationSection(
  state: unknown,
  priors: PriorContribution[] = [],
  maxCostCents?: number,
): string {
  const hasState = stateHasContent(state);
  const hasPriors = priors.length > 0;
  if (!hasState && !hasPriors) return '';

  const parts: string[] = [
    'CONTINUATION — you are CONTINUING accumulated work on this problem, not starting it. ' +
      'Read the state and prior attempts below FIRST and advance from the frontier they ' +
      'record; do not redo work they already cover.',
  ];

  if (hasState) {
    let json: string;
    try {
      json = typeof state === 'string' ? state : JSON.stringify(state);
    } catch {
      json = String(state);
    }
    if (json.length > CONTINUATION_STATE_MAX_CHARS) {
      json = `${json.slice(0, CONTINUATION_STATE_MAX_CHARS)}\n[state truncated at ${CONTINUATION_STATE_MAX_CHARS} chars — the full working set is larger than shown]`;
    }
    parts.push(`Current state (compacted from prior contributions):\n${json}`);
  }

  if (hasPriors) {
    // A preserved artifact means a prior proposal awaits correction (it failed
    // validation, or a peer review rejected it); put the computed limits next
    // to the feedback so the resubmit can be priced right without
    // rediscovering the caps. Pushed BEFORE the priors budget below is
    // computed, so the section's size cap still holds.
    if (maxCostCents !== undefined && priors.some((p) => p.artifact != null)) {
      parts.push(
        `A prior decomposition proposal below was not accepted (validation errors or a peer review's rejection). When correcting and resubmitting it:\n${decompositionLimitsSection(maxCostCents)}`,
      );
    }
    const header = 'Recent attempts on this task (newest first):';
    let used = parts.join('\n\n').length + header.length + 4;
    const lines: string[] = [];
    let kept = 0;
    for (const p of priors) {
      const when = p.created_at ? ` at ${p.created_at}` : '';
      let line = `- [${p.outcome}]${when}: ${p.summary?.trim() || '(no summary recorded)'}`;
      if (line.length > CONTINUATION_PRIOR_MAX_CHARS) {
        line = `${line.slice(0, CONTINUATION_PRIOR_MAX_CHARS)}…`;
      }
      // A hydrated inline artifact is the full thing the next agent must see —
      // today a salvaged invalid decomposition, i.e. the proposal to fix and
      // resubmit. Rendered under its own cap, after the summary line's.
      if (p.artifact != null) {
        let json: string;
        try {
          json = typeof p.artifact === 'string' ? p.artifact : JSON.stringify(p.artifact);
        } catch {
          json = String(p.artifact);
        }
        if (json.length > CONTINUATION_PRIOR_ARTIFACT_MAX_CHARS) {
          json = `${json.slice(0, CONTINUATION_PRIOR_ARTIFACT_MAX_CHARS)}…[artifact truncated]`;
        }
        const reviewRejected =
          typeof p.artifact === 'object' &&
          (p.artifact as { review_rejected?: unknown }).review_rejected === true;
        line += reviewRejected
          ? `\n  Preserved artifact from this attempt (a peer reviewer REJECTED the previous ` +
            `decomposition proposal for the reasons recorded here — address them and resubmit ` +
            `an improved proposal, or take a different approach entirely):\n  ${json}`
          : `\n  Preserved artifact from this attempt (if it is a decomposition proposal with ` +
            `validation_errors, fix exactly those errors and resubmit the corrected proposal):\n  ${json}`;
      }
      // Reserve room for the truncation note so appending it can never push
      // the section past the cap (the pre-note budget must leave it space).
      if (used + line.length + 1 > CONTINUATION_MAX_CHARS - TRUNCATION_NOTE_RESERVE_CHARS) break;
      lines.push(line);
      used += line.length + 1;
      kept++;
    }
    const omitted = priors.length - kept;
    if (omitted > 0) {
      lines.push(`[history truncated — ${omitted} older attempt(s) omitted to fit the size cap]`);
    }
    parts.push([header, ...lines].join('\n'));
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// StubExecutor — no model. Reports ~80% of the cap as "spent".
// ---------------------------------------------------------------------------

export class StubExecutor implements Executor {
  async execute(task: ExecTask): Promise<ExecResult> {
    const prompt = task.spec?.prompt ?? task.title;
    console.log(`     … would call Claude here (model ${task.model}) on: "${prompt}"`);
    const actual = Math.round(task.max_cost_cents * 0.8);
    // Echo the continuation section exactly as the production executor would
    // frame it, so tests can assert the checkout handoff reached the executor.
    const continuation = buildContinuationSection(
      task.target_state,
      task.prior_contributions,
      task.max_cost_cents,
    );
    return {
      result: {
        stub: true,
        summary: `Stubbed completion for "${task.title}".`,
        echoed_prompt: prompt,
        ...(continuation ? { echoed_continuation: continuation } : {}),
      },
      actual_cost_cents: actual,
      raw_usage: { stub: true, model: task.model, simulated_cost_cents: actual },
    };
  }
}

// ---------------------------------------------------------------------------
// Decomposition limits — the CONCRETE numbers, injected per task.
//
// validateDecomposition (src/operations.ts) enforces hard caps on every
// proposal, but agents only ever saw them stated symbolically ("at most TWICE
// this task's own cap") — and in production they kept pricing subtasks above
// the ceiling and discovering the rule by failing validation, a full paid run
// wasted per discovery. So the prompt now states the computed numbers for the
// task at hand. The constants are mirrored from src/operations.ts on purpose:
// the execution plane must not import operations.ts (it pulls pg — see
// run-loop.ts's no-server-imports rule); a test asserts the mirrors stay equal
// to the real validation constants.
// ---------------------------------------------------------------------------

/** Mirror of operations.DECOMPOSITION_CAP_MULTIPLE — per-subtask cap is this × the parent's. */
export const DECOMPOSITION_CAP_MULTIPLE = 2;
/** Mirror of operations.MAX_DECOMPOSITION_SUBTASKS — model-executed subtasks per proposal. */
export const MAX_DECOMPOSITION_SUBTASKS = 12;
/** Mirror of operations.MAX_DECOMPOSITION_CHUNKS — pinned-code sandbox chunks per proposal. */
export const MAX_DECOMPOSITION_CHUNKS = 64;

/**
 * The decomposition rules validateDecomposition actually enforces, rendered
 * with the computed numbers for ONE task (never symbolically — "at most 160"
 * for an 80¢ task, not "at most 2x the cap"). Injected wherever the prompt
 * offers the decomposition deliverable, so an agent never has to discover a
 * limit by burning a run on a rejected proposal.
 */
export function decompositionLimitsSection(maxCostCents: number): string {
  const perSubtaskCap = DECOMPOSITION_CAP_MULTIPLE * maxCostCents;
  return (
    `DECOMPOSITION LIMITS for THIS task — validation enforces these exactly; a proposal that breaks one is rejected:\n` +
    `- each subtask's max_cost_cents must be at most ${perSubtaskCap} (${DECOMPOSITION_CAP_MULTIPLE}x this task's ${maxCostCents}¢ cap); every cost is a positive integer in cents, and est_cost_cents must be <= max_cost_cents;\n` +
    `- at most ${MAX_DECOMPOSITION_SUBTASKS} model-executed subtasks per proposal; only pinned-code sandbox chunks may fan wider, up to ${MAX_DECOMPOSITION_CHUNKS} chunks per proposal, and all chunks must pin the same repo+sha+entrypoint;\n` +
    `- a decomposition-review task can never itself be decomposed.\n` +
    `If the work costs more than the cap allows per chunk, split into more, smaller chunks.`
  );
}

// System prompt for the executor that calls a model (ClaudeCliExecutor).
const SYSTEM_PROMPT = `You are a task executor for Givework, where developers donate AI compute to open mathematics.
You are given one concrete task — an attack on an open problem — with a prompt, an expected output shape, and acceptance criteria.
Do the task rigorously and respond with ONLY a single JSON object matching the requested output shape — no preamble, no markdown fences, no commentary. If no shape is given, return {"output": <your result as a string>}.

EXECUTION REALITY — you cannot run code. This run has no shell, no interpreter, and no sandbox; the only tool you have is writing the PROGRESS.md file described below. Reasoning, analysis, proof work, and mathematics you can and should do directly. But if the deliverable requires EXECUTING code (running a search, a simulation, a numerical sweep), do not pretend to run it and never present imagined program output as computed fact — the correct deliverable is a decomposition (below): one subtask that WRITES a small, reviewable program (a code contribution that gets human-reviewed, merged, and pinned by commit SHA), then sandboxed chunk subtasks that actually execute it on donated CPU.

BUDGET HONESTY — decomposition as a deliverable. Each task has a hard cost cap and a bounded time window. If, once you understand the task, it plainly cannot fit its budget or window, do NOT grind at it until the clock kills the run — that burns the donation and records nothing. The CORRECT deliverable for an oversized task is a decomposition proposal. Add a "decomposition" key to your JSON object:
  "decomposition": {
    "reason": "<why this task exceeds its budget, in one or two sentences>",
    "subtasks": [
      {"title": "<short title>", "prompt": "<complete, self-contained prompt for the agent that will work it>",
       "kind": "computational|counterexample_search|formalization|lemma|exploration",
       "effort": "low|medium|high", "est_cost_cents": <int>, "max_cost_cents": <int>}
    ]
  }
Rules: at most 12 subtasks that will invoke a model; every cost is integer cents; each subtask's max_cost_cents is at most TWICE this task's own cap — the DECOMPOSITION LIMITS section below restates these with the concrete numbers computed for THIS task; obey those numbers. Sandbox CHUNK subtasks — those additionally carrying "code": {"repo", "sha" (full 40-hex commit), "entrypoint", "input"} pinning one ALREADY-MERGED program that every chunk shares (only "input" varies per slice) — run on donated CPU, not tokens, and may fan wider: up to 64 chunks per proposal. Where the work is a large mechanical search (the Lander–Parkin pattern that disproved Euler's sum-of-powers conjecture), prefer the two-phase shape: ONE subtask that writes a small, reviewable search program (a code contribution that gets human-reviewed, merged, and pinned by commit SHA), then — in a later decomposition, once that SHA exists — the cheap sandboxed chunk subtasks that each run the pinned program over one slice of the search space. A good plan IS a successful contribution: another volunteer's agent reviews it, and if approved the subtasks are published as real tasks. Grinding to timeout is the failure mode; the plan is success.`;

/**
 * JSON Schema for the contribution envelope — the contract SYSTEM_PROMPT asks
 * for, expressed formally. Passed to `claude -p --json-schema` on CLIs new
 * enough to honor it, so the final output is schema-constrained at the source
 * and arrives pre-parsed in the result event's `structured_output` field:
 * prose wrappers, markdown fences, and narrated placeholder objects (the
 * production mis-route) become structurally impossible.
 *
 * Deliberately permissive: NOTHING is required at the top level (a
 * partial-but-honest result — just a summary, say — must still validate) and
 * additionalProperties stays true so each task's own spec.output_schema keys
 * ride alongside the envelope. No `format:` annotations — the CLI treats them
 * as advisory-only, so they'd add noise without enforcement.
 */
export const RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    output: {
      type: 'string',
      description: 'The main result, when the task gave no output shape of its own',
    },
    summary: { type: 'string', description: 'Short handoff note shown on the public feed' },
    outcome: {
      type: 'string',
      enum: ['progress', 'dead_end', 'candidate_solution', 'decomposition'],
    },
    state_update: {
      type: 'object',
      description: "Replacement for the target's compacted working set",
    },
    artifact_uri: { type: 'string' },
    decomposition: {
      type: 'object',
      description: 'The task-exceeds-budget deliverable (see BUDGET HONESTY in the system prompt)',
      properties: {
        reason: { type: 'string' },
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              prompt: { type: 'string' },
              kind: {
                type: 'string',
                enum: [
                  'computational',
                  'counterexample_search',
                  'formalization',
                  'lemma',
                  'exploration',
                ],
              },
              effort: { type: 'string', enum: ['low', 'medium', 'high'] },
              est_cost_cents: { type: 'integer' },
              max_cost_cents: { type: 'integer' },
              code: {
                type: 'object',
                properties: {
                  repo: { type: 'string' },
                  sha: { type: 'string' },
                  entrypoint: { type: 'string' },
                  input: {},
                },
                required: ['repo', 'sha', 'entrypoint'],
              },
            },
            required: ['title', 'prompt'],
          },
        },
      },
      required: ['reason', 'subtasks'],
    },
  },
  additionalProperties: true,
} as const;

/**
 * Map one task-spec output_schema value — prose like
 * `'boolean — true publishes the proposed subtasks'` or plain `'string'` — to
 * the JSON Schema type its leading token names, or undefined when the prose
 * doesn't start with a recognizable type (then the key ships with a
 * description only: better unconstrained than wrongly constrained).
 */
function jsonTypeOfSpecField(desc: string): string | undefined {
  const m = desc.match(/^\s*(boolean|bool|string|integer|int|number|float|object|array)\b/i);
  if (!m) return undefined;
  const t = m[1].toLowerCase();
  return t === 'bool' ? 'boolean' : t === 'int' ? 'integer' : t === 'float' ? 'number' : t;
}

/**
 * The schema actually passed to `claude -p --json-schema`: the contribution
 * envelope, plus the TASK's own spec.output_schema keys as typed properties.
 *
 * Production bug this closes: review tasks declare
 * `output_schema: { approve: 'boolean — …' }`, but only the generic envelope
 * was enforced — so an agent returned `{"approve": "false"}` (a STRING) and
 * the publish gate's strict `approve === true` silently never fired: spend
 * booked, verdict lost. Typing the task's keys in the schema makes the CLI
 * enforce the task's contract at the source.
 *
 * Envelope keys always win a collision — `outcome`'s enum routes the submit
 * and must never be redefined by a task spec. Task keys are typed but never
 * `required`: a partial-but-honest result must still validate.
 */
export function resultSchemaFor(outputSchema?: Record<string, string>): typeof RESULT_JSON_SCHEMA {
  if (!outputSchema || typeof outputSchema !== 'object') return RESULT_JSON_SCHEMA;
  const extra: Record<string, unknown> = {};
  for (const [key, desc] of Object.entries(outputSchema)) {
    if (key in RESULT_JSON_SCHEMA.properties || typeof desc !== 'string') continue;
    const type = jsonTypeOfSpecField(desc);
    extra[key] = type ? { type, description: desc } : { description: desc };
  }
  if (Object.keys(extra).length === 0) return RESULT_JSON_SCHEMA;
  return {
    ...RESULT_JSON_SCHEMA,
    properties: { ...RESULT_JSON_SCHEMA.properties, ...extra },
  } as typeof RESULT_JSON_SCHEMA;
}

/**
 * Light post-parse repair for the extraction-ladder path (older CLIs never get
 * --json-schema, so nothing enforced the task's types): a field the task's
 * output_schema declares BOOLEAN that came back as the string "true"/"false"
 * is coerced to the real boolean. Never a blind global coercion — only fields
 * the spec explicitly types boolean, only the two unambiguous strings. This is
 * exactly the `{"approve": "false"}` shape that silently defeated the strict
 * `approve === true` publish gate.
 */
export function coerceBooleanFields(result: unknown, outputSchema?: Record<string, string>) {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!outputSchema || typeof outputSchema !== 'object') return result;
  let out = result as Record<string, unknown>;
  for (const [key, desc] of Object.entries(outputSchema)) {
    if (typeof desc !== 'string' || jsonTypeOfSpecField(desc) !== 'boolean') continue;
    const v = out[key];
    if (typeof v !== 'string') continue;
    const s = v.trim().toLowerCase();
    if (s !== 'true' && s !== 'false') continue;
    if (out === result) out = { ...out }; // copy-on-write; untouched results pass through as-is
    out[key] = s === 'true';
  }
  return out;
}

/**
 * Earliest CLI version --json-schema is trusted on. Chosen deliberately: the
 * headless docs pin v2.1.205 as the release where an invalid schema fails
 * LOUDLY (`Error: --json-schema is not a valid JSON Schema` + diagnostic);
 * before it, invalid schemas were SILENTLY ignored and the run returned
 * unstructured text — i.e. below this version the flag's behavior is exactly
 * the kind of quiet misfire this system cannot afford on donated spend. This
 * repo's earlier attempt at the flag (see the NOTE in execute()) hit that era.
 */
export const MIN_JSON_SCHEMA_CLI_VERSION = '2.1.205';

/** True when `versionText` (e.g. "2.1.210 (Claude Code)") is at least `min` ("x.y.z"). */
export function cliVersionAtLeast(versionText: string, min: string): boolean {
  const m = versionText.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== b[i]) return v[i] > b[i];
  }
  return true;
}

/**
 * Read `claude --version` — a spawn that costs no tokens and bills nothing, so
 * gating on it can never double-spend a donation (unlike probing with a real
 * run). Returns null on any failure (CLI missing, hang, nonzero exit); null
 * means "assume no --json-schema support" and the extraction ladder carries.
 */
function probeClaudeCliVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 10_000);
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out.trim() : null);
    });
  });
}

/**
 * Does this ExecFailedError stderr look like the CLI rejecting the
 * --json-schema invocation itself (unknown flag on an old build, or a schema
 * the validator refused) rather than a mid-run crash? Used to decide the one
 * free retry without the flag.
 */
function isJsonSchemaFlagFailure(stderr: string): boolean {
  return (
    /json-schema/i.test(stderr) ||
    /unknown option|unknown argument|unrecognized option/i.test(stderr)
  );
}

/** The schema-validated deliverable from a result event, when --json-schema was honored. */
function structuredOutputOf(final: any): unknown {
  const s = final?.structured_output;
  return s !== null && typeof s === 'object' ? s : undefined;
}

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
 * A `claude -p` run that exited nonzero. Carries everything that reached stdout
 * before the crash — the CLI streams events as they happen, so a run that died
 * mid-way (OOM, CLI bug, network loss to Anthropic) may have burned real tokens
 * whose partial output is salvageable exactly like a timeout's.
 */
export class ExecFailedError extends Error {
  constructor(
    public readonly partialOutput: string,
    public readonly stderrOutput: string,
    public readonly exitCode: number | null,
    public readonly elapsedMs: number,
  ) {
    super(`claude -p exited ${exitCode}: ${stderrOutput.slice(0, 300)}`);
    this.name = 'ExecFailedError';
  }
}

/**
 * Spawn `claude` with args, feed `input` on stdin, resolve stdout. A spawn
 * failure (CLI missing) throws a plain Error — nothing burned, clean release. A
 * nonzero exit throws ExecFailedError and a timeout ExecTimeoutError, BOTH
 * carrying the accumulated stdout (rejected from the 'close' handler so
 * anything the dying process flushed is still captured): by then tokens may be
 * spent, and discarding stdout would discard the only record of that work.
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
      else reject(new ExecFailedError(out, err, code, Date.now() - started));
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
      if (
        whole.type === 'result' ||
        'result' in whole ||
        'structured_output' in whole ||
        'is_error' in whole
      ) {
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
  private probeVersion: () => Promise<string | null>;
  /** Cached once per executor: whether this volunteer's CLI gets --json-schema. */
  private schemaSupport?: Promise<boolean>;

  constructor(
    opts: { run?: CliRunner; timeoutMs?: number; probeVersion?: () => Promise<string | null> } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    // The per-task override is consulted at call time so a long-running task
    // (authoring a whole Manim scene runs ~13 minutes) can widen the window
    // without every task paying for it.
    this.run = opts.run ?? ((args, input, timeoutMs, o) => spawnClaude(args, input, timeoutMs, o));
    // Deliberate default asymmetry: with the real spawn runner, probe the real
    // CLI's version (free — no tokens); with an injected fake runner (tests),
    // default to "unknown → unsupported" so unit tests behave identically on
    // every machine. A test that wants the structured path injects probeVersion.
    this.probeVersion = opts.probeVersion ?? (opts.run ? async () => null : probeClaudeCliVersion);
  }

  /**
   * Whether to pass --json-schema, decided ONCE per executor from a cheap
   * `claude --version` read — never from a paid trial run, so the gate itself
   * can never double-spend. Gated at MIN_JSON_SCHEMA_CLI_VERSION (see its
   * comment for why that version and not "whenever the flag exists").
   */
  private supportsJsonSchema(): Promise<boolean> {
    this.schemaSupport ??= this.probeVersion().then(
      (v) => (v ? cliVersionAtLeast(v, MIN_JSON_SCHEMA_CLI_VERSION) : false),
      () => false,
    );
    return this.schemaSupport;
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
    // The accumulated frontier from checkout. Without this the handoff dies at
    // the runner's doorstep and every attempt restarts from the static spec.
    const continuation = buildContinuationSection(
      task.target_state,
      task.prior_contributions,
      task.max_cost_cents,
    );
    const prompt =
      `${SYSTEM_PROMPT}\n\n` +
      // The concrete numbers for the rules above — computed, never symbolic,
      // so an agent can't price a subtask over the cap and only find out by
      // wasting the run on a rejected proposal.
      `${decompositionLimitsSection(task.max_cost_cents)}\n\n` +
      `Task: ${task.title}\n\n${task.spec?.prompt ?? ''}\n` +
      (task.spec?.output_schema
        ? `Output shape (JSON keys → type): ${JSON.stringify(task.spec.output_schema)}\n`
        : '') +
      (task.spec?.acceptance ? `Acceptance: ${task.spec.acceptance}\n` : '') +
      (continuation ? `\n${continuation}\n` : '') +
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

    // NOTE on --json-schema: an earlier integration observed the flag "bills
    // but returns an empty result" — that era predates v2.1.205 (when invalid
    // schemas were silently ignored) AND read the deliverable from `result`,
    // which IS empty under the flag: the schema-constrained object arrives in
    // the result event's `structured_output` field instead. So the flag is now
    // the PRIMARY layer — native enforcement makes prose-wrapped JSON (the
    // production mis-route) structurally impossible — but only on CLIs at
    // MIN_JSON_SCHEMA_CLI_VERSION or newer, decided by a free version probe.
    // Older CLIs get the same prompt-steered run as before, parsed by the
    // coerceResultDetailed extraction ladder. STAGE 8: cap usage so a task
    // can't exceed its cap.
    //
    // stream-json (with --verbose, which the CLI requires alongside it, and
    // --include-partial-messages for in-flight text) so a timed-out run leaves
    // salvageable output on stdout — see the header comment above. The flag
    // composes with stream-json; a killed run simply never gets its final
    // result event, and the salvage paths work identically in both modes.
    let useJsonSchema = await this.supportsJsonSchema();
    // Envelope + the task's own output_schema keys, typed — the task contract
    // (e.g. a review's `approve: boolean`) is enforced at the source, not
    // merely narrated in the prompt.
    const jsonSchema = resultSchemaFor(task.spec?.output_schema);
    const argsFor = (withSchema: boolean) => [
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
      ...(withSchema ? ['--json-schema', JSON.stringify(jsonSchema)] : []),
    ];

    // Fresh working directory per run — where PROGRESS.md lives, and all the
    // agent can write. Removed after the run either way (on success the JSON
    // contract stands and the file is ignored). The whole run + salvage
    // decision happens inside this try so PROGRESS.md is still readable on
    // every failure path, not just the timeout.
    const workdir = await mkdtemp(join(tmpdir(), 'givework-run-'));
    let raw: string | undefined;
    let resultText: string;
    let data: any;
    try {
      const readProgress = () =>
        readFile(join(workdir, PROGRESS_FILE), 'utf8')
          .then((s) => s.slice(0, PROGRESS_FILE_MAX_CHARS))
          .catch(() => null);
      while (raw === undefined) {
        try {
          raw = await this.run(argsFor(useJsonSchema), prompt, timeoutMs, { cwd: workdir });
        } catch (err) {
          if (err instanceof ExecTimeoutError) {
            // The timeout killed the run. The tokens are already spent from the
            // volunteer's subscription — salvage what accumulated into a progress
            // contribution instead of letting the run vanish without a record.
            // The agent-curated PROGRESS.md is the primary salvage; the stream
            // capture inside salvageTimedOutRun is the fallback. (Identical in
            // --json-schema mode: partial messages still streamed, only the
            // never-arrived final event would have carried structured_output.)
            return salvageTimedOutRun(task, model, prompt, err, await readProgress());
          }
          if (err instanceof ExecFailedError) {
            // The CLI died mid-run (nonzero exit). Tokens may already be burned;
            // salvage whatever reached stdout / PROGRESS.md exactly like a
            // timeout. Only a run that left truly nothing (the fast-fail shape of
            // a config/auth problem) still throws for a clean release.
            const salvaged = salvageCrashedRun(task, model, prompt, {
              reason: `claude -p exited ${err.exitCode}`,
              partialOutput: err.partialOutput,
              progressFile: await readProgress(),
              exitCode: err.exitCode,
              stderrTail: err.stderrOutput.slice(-2_000),
              elapsedMs: err.elapsedMs,
            });
            if (salvaged) return salvaged;
            if (useJsonSchema && isJsonSchemaFlagFailure(err.stderrOutput)) {
              // The version gate misjudged this CLI (or its validator refused
              // our schema). NOTHING was burned — salvage found no stdout, no
              // usage, no billed event — so ONE retry without the flag cannot
              // double-spend a donation. Pin support off for this executor so
              // later tasks skip the failing flag outright.
              this.schemaSupport = Promise.resolve(false);
              useJsonSchema = false;
              continue;
            }
            throw new Error(
              `claude -p exited ${err.exitCode} with nothing recoverable ` +
                `(no stdout, no ${PROGRESS_FILE} — no tokens appear to have been metered): ` +
                err.stderrOutput.slice(0, 300),
            );
          }
          throw err;
        }
      }

      const capture = parseStreamCapture(raw);
      data = capture.final;
      resultText = String(data?.result ?? '').trim();
      const failure = !data
        ? `claude -p returned no result event: ${raw.slice(0, 200)}`
        : data.is_error
          ? `claude -p reported an error: ${String(data.result ?? data.error ?? 'unknown')}`
          : !resultText && structuredOutputOf(data) === undefined
            ? 'claude -p returned an empty result'
            : null;
      if (failure) {
        // The run completed by the CLI's lights but delivered no usable work —
        // yet it BILLED (is_error/empty runs still carry total_cost_usd). The
        // burned spend and any partial output must not vanish: salvage them as
        // a flagged progress contribution. Only a truly empty run (no output,
        // no progress file, no metered usage) throws for a clean release.
        const salvaged = salvageCrashedRun(task, model, prompt, {
          reason: failure,
          partialOutput: raw,
          progressFile: await readProgress(),
          final: data ?? null,
        });
        if (salvaged) return salvaged;
        throw new Error(`${failure} — nothing recoverable to salvage; releasing the task`);
      }
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
    // Primary layer: the CLI enforced RESULT_JSON_SCHEMA and handed back a
    // pre-parsed object. Fallback layer: a supported CLI whose final event
    // nonetheless lacks structured_output — or an older CLI that never got the
    // flag — goes through the text-extraction ladder.
    const structured = structuredOutputOf(data);
    const { value: extracted, parse_mode }: CoercedResult =
      structured !== undefined
        ? { value: structured, parse_mode: 'structured_output' }
        : coerceResultDetailed(resultText);
    // Ladder path only: nothing enforced the task's declared types, so repair
    // the one unambiguous slip — string "true"/"false" in a schema-declared
    // boolean field. structured_output already came back schema-enforced.
    const result =
      parse_mode === 'structured_output'
        ? extracted
        : coerceBooleanFields(extracted, task.spec?.output_schema);

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
        // Which rung of the extraction ladder parsed the model's text — so a
        // mis-routed submit (the prose-buried-JSON incident) is diagnosable
        // from the recorded contribution.
        parse_mode,
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

/** What a crashed / errored / empty run left behind to salvage from. */
interface CrashedRunInfo {
  /** Human-readable cause: exit code, is_error text, or "empty result". */
  reason: string;
  /** Everything that reached stdout (stream-json, possibly truncated). */
  partialOutput: string;
  /** PROGRESS.md contents, if the agent wrote one. */
  progressFile: string | null;
  exitCode?: number | null;
  /** Tail of stderr — the crash's own account of itself. */
  stderrTail?: string;
  elapsedMs?: number;
  /** A final result event that WAS parsed (is_error / empty runs) — it carries the CLI's real cost. */
  final?: any | null;
}

/**
 * Build the progress contribution for a run that crashed (nonzero exit),
 * reported is_error, or returned an empty result — the F2 mirror of
 * salvageTimedOutRun, with the same honesty rules: flagged `crashed`, cost
 * taken from the CLI's own figure when a result event carried one (is_error
 * runs still bill) and estimated-and-labelled otherwise, state merged under
 * `crash_salvage` (never clobbering the accumulated frontier), and the exit
 * code + stderr tail preserved verbatim in the artifact so the next agent and
 * the platform can see exactly how the run died.
 *
 * Returns null when there is truly NOTHING recoverable — no salvage text, no
 * metered usage, no billed result event. That is the fast-fail shape of a
 * config/auth problem (spawn ok, immediate error, nothing burned), and the
 * right move is the caller's clean throw-and-release, not a fabricated record.
 */
function salvageCrashedRun(
  task: ExecTask,
  model: string,
  prompt: string,
  info: CrashedRunInfo,
): ExecResult | null {
  const capture = parseStreamCapture(info.partialOutput);
  const text = capture.text.trim();
  const progress = info.progressFile?.trim() ?? '';
  const salvage = progress || text;
  const source = progress ? 'progress_file' : text ? 'stream' : 'none';
  const sawUsage = Object.values(capture.usage).some((v) => (v ?? 0) > 0);
  const billed = typeof info.final?.total_cost_usd === 'number';
  if (!salvage && !sawUsage && !billed) return null;

  const usage: Usage = sawUsage
    ? capture.usage
    : {
        input_tokens: estTokens(prompt.length),
        output_tokens: estTokens(text.length + progress.length),
      };
  const cents = billed
    ? Math.max(1, Math.ceil(info.final.total_cost_usd * 100))
    : Math.max(1, usageToCents(model, usage));

  const summary =
    `Attempted "${task.title}" but the run failed (${info.reason}). ` +
    (source === 'progress_file'
      ? `The agent's own ${PROGRESS_FILE} was salvaged and is attached for the next agent to continue from.`
      : source === 'stream'
        ? 'Partial output was captured and is attached for the next agent to continue from.'
        : 'No partial output survived the failure; the burned spend is recorded so the donation is not lost.');

  // Merge-don't-clobber, exactly as the timeout salvage does.
  const prior = task.target_state;
  const mergeable = prior == null || (typeof prior === 'object' && !Array.isArray(prior));
  const state_update =
    salvage && mergeable
      ? {
          ...(prior as Record<string, unknown> | null | undefined),
          crash_salvage: {
            task_id: task.task_id,
            reason: info.reason,
            source,
            partial: salvage.slice(0, SALVAGE_STATE_CHARS),
          },
        }
      : undefined;

  return {
    result: {
      crashed: true,
      reason: info.reason,
      ...(info.exitCode !== undefined ? { exit_code: info.exitCode } : {}),
      ...(info.stderrTail ? { stderr_tail: info.stderrTail } : {}),
      ...(progress ? { progress_file: progress.slice(0, SALVAGE_ARTIFACT_CHARS) } : {}),
      ...(text ? { partial_output: text.slice(0, SALVAGE_ARTIFACT_CHARS) } : {}),
    },
    outcome: 'progress',
    crashed: true,
    summary,
    state_update,
    actual_cost_cents: cents,
    raw_usage: {
      model,
      crashed: true,
      reason: info.reason,
      ...(info.exitCode !== undefined ? { exit_code: info.exitCode } : {}),
      ...(info.stderrTail ? { stderr_tail: info.stderrTail } : {}),
      ...(info.elapsedMs !== undefined ? { elapsed_ms: info.elapsedMs } : {}),
      estimated: !billed,
      estimator: billed ? 'cli_total_cost_usd' : sawUsage ? 'streamed_usage' : 'char_heuristic',
      salvage_source: source,
      usage: billed ? (info.final?.usage ?? usage) : usage,
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
