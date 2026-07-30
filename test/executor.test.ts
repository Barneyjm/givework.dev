import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildContinuationSection,
  ClaudeCliExecutor,
  CONTINUATION_MAX_CHARS,
  coerceResult,
  type ExecTask,
  ExecTimeoutError,
  getExecutor,
  modelForEffort,
  type PriorContribution,
  parseStreamCapture,
  StubExecutor,
  usageToCents,
} from '../src/executor.js';

const task: ExecTask = {
  task_id: 't1',
  title: 'Summarize',
  model: 'claude-sonnet-4-6',
  max_cost_cents: 200,
  spec: { prompt: 'summarize this', output_schema: { summary: 'string' }, acceptance: 'a summary' },
};

describe('coerceResult', () => {
  it('parses bare JSON and single-fenced JSON', () => {
    expect(coerceResult('{"a": 1}')).toEqual({ a: 1 });
    expect(coerceResult('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('digs JSON out of surrounding prose (the shape a real run produced)', () => {
    const prose =
      'I could not write files in this sandbox, so here is the contribution.\n\n' +
      '```json\n{"code_contribution": {"title": "x"}, "summary": "s"}\n```\n\nGood luck!';
    expect(coerceResult(prose)).toEqual({ code_contribution: { title: 'x' }, summary: 's' });
  });

  it('tries later fences when an earlier one is not JSON', () => {
    const s = '```python\nprint(1)\n```\nresult:\n```json\n{"ok": true}\n```';
    expect(coerceResult(s)).toEqual({ ok: true });
  });

  it('falls back to a brace span, then to raw output', () => {
    expect(coerceResult('the answer is {"n": 7} indeed')).toEqual({ n: 7 });
    expect(coerceResult('no json here')).toEqual({ output: 'no json here' });
  });
});

describe('usageToCents', () => {
  it('meters input+output tokens into rounded-up cents per model pricing', () => {
    // sonnet: $3/$15 per 1M → 0.0003 / 0.0015 cents per token
    expect(usageToCents('claude-sonnet-4-6', { input_tokens: 100_000, output_tokens: 5_000 })).toBe(
      38,
    ); // 30 + 7.5
    // opus: $5/$25
    expect(usageToCents('claude-opus-4-8', { input_tokens: 100_000, output_tokens: 5_000 })).toBe(
      63,
    ); // 50 + 12.5
  });

  it('bills cache reads at ~0.1x input and writes at ~1.25x input', () => {
    // 100k cache-read on sonnet: 100000 * 0.0003 * 0.1 = 3
    expect(usageToCents('claude-sonnet-4-6', { cache_read_input_tokens: 100_000 })).toBe(3);
    // 100k cache-write: 100000 * 0.0003 * 1.25 = 37.5 → 38
    expect(usageToCents('claude-sonnet-4-6', { cache_creation_input_tokens: 100_000 })).toBe(38);
  });

  it('falls back to default-model pricing for an unknown model', () => {
    expect(usageToCents('gpt-4', { input_tokens: 100_000 })).toBe(
      usageToCents('claude-sonnet-4-6', { input_tokens: 100_000 }),
    );
  });
});

describe('ClaudeCliExecutor', () => {
  // Inject a fake `claude -p` runner — no subprocess, no real credit spent.
  const cliReply = (obj: any) => async () => JSON.stringify(obj);

  it('parses the CLI JSON result and takes cost from total_cost_usd', async () => {
    const run = cliReply({
      result: '{"summary":"done"}',
      total_cost_usd: 0.0123,
      usage: { output_tokens: 50 },
      duration_ms: 900,
    });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.result).toEqual({ summary: 'done' });
    expect(r.actual_cost_cents).toBe(2); // ceil(0.0123 * 100)
    expect((r.raw_usage as any).total_cost_usd).toBe(0.0123);
  });

  it('maps the effort tier to a model, and lets the volunteer override it', async () => {
    const seen: string[] = [];
    const run = async (args: string[]) => {
      seen.push(args[args.indexOf('--model') + 1]);
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    const exec = new ClaudeCliExecutor({ run });
    await exec.execute({ ...task, effort: 'high' });
    await exec.execute({ ...task, effort: 'medium' });
    await exec.execute({ ...task, effort: 'low' });
    expect(seen).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']);

    // a volunteer whose plan lacks Opus (or who'd rather not spend it) remaps the tier
    expect(modelForEffort('high', { GIVEWORK_MODEL_HIGH: 'claude-sonnet-4-6' })).toBe(
      'claude-sonnet-4-6',
    );
    // blank/absent overrides fall through to the default table
    expect(modelForEffort('high', { GIVEWORK_MODEL_HIGH: '  ' })).toBe('claude-opus-4-8');
    expect(modelForEffort(undefined, {})).toBe('claude-sonnet-4-6'); // unset -> medium
  });

  it('still honours a legacy task that named a real model', async () => {
    const seen: string[] = [];
    const run = async (args: string[]) => {
      seen.push(args[args.indexOf('--model') + 1]);
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    const exec = new ClaudeCliExecutor({ run });
    await exec.execute({ ...task, model: 'claude-opus-4-8' }); // no effort set
    await exec.execute({ ...task, model: 'by-effort' }); // sentinel -> default tier
    expect(seen).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
  });

  it('honours a task-advertised timeout, but only to raise it and only up to the cap', async () => {
    const seen: number[] = [];
    const run = async (_a: string[], _i: string, timeoutMs: number) => {
      seen.push(timeoutMs);
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    const exec = new ClaudeCliExecutor({ run, timeoutMs: 180_000 });

    // no hint -> the runner's own default
    await exec.execute(task);
    // a long job (authoring a Manim scene) raises it
    await exec.execute({ ...task, spec: { ...task.spec, suggested_timeout_ms: 1_500_000 } });
    // a task cannot LOWER the runner's limit
    await exec.execute({ ...task, spec: { ...task.spec, suggested_timeout_ms: 1_000 } });
    // nor exceed the 30-minute ceiling, however absurd the hint
    await exec.execute({ ...task, spec: { ...task.spec, suggested_timeout_ms: 999_999_999 } });
    // garbage is ignored
    await exec.execute({ ...task, spec: { ...task.spec, suggested_timeout_ms: 'soon' } });

    expect(seen).toEqual([180_000, 1_500_000, 180_000, 1_800_000, 180_000]);
  });

  it('passes -p/stream-json/--model, prompt+shape on stdin, and never --json-schema', async () => {
    let seenArgs: string[] = [];
    let seenInput = '';
    let seenOpts: { cwd?: string } | undefined;
    const run = async (args: string[], input: string, _t: number, opts?: { cwd?: string }) => {
      seenArgs = args;
      seenInput = input;
      seenOpts = opts;
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    await new ClaudeCliExecutor({ run }).execute(task);
    // stream-json (not the buffered json format) so a timed-out run leaves
    // salvageable events on stdout instead of nothing; --allowedTools grants
    // Write/Edit on PROGRESS.md ONLY (the progress-file salvage protocol).
    expect(seenArgs).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--allowedTools',
      'Write(PROGRESS.md),Edit(PROGRESS.md)',
      '--model',
      'claude-sonnet-4-6',
    ]);
    // --json-schema makes claude -p bill but return an empty result; we steer via
    // the prompt instead, so the flag must never be sent.
    expect(seenArgs).not.toContain('--json-schema');
    expect(seenInput).toContain('summarize this'); // the task prompt reached the CLI
    expect(seenInput).toContain('Output shape'); // the shape is conveyed in-prompt
    // The progress-file protocol states the REAL deadline (default 180s -> 3 min)
    // and where to record findings as the run goes.
    expect(seenInput).toContain('killed after ~3 minute(s)');
    expect(seenInput).toContain('PROGRESS.md');
    // …and each run gets its own working directory for that file.
    expect(seenOpts?.cwd).toBeTruthy();
  });

  it('tolerates a markdown ```json fence in the CLI result (the real claude -p wart)', async () => {
    const run = cliReply({ result: '```json\n{"response":"pong"}\n```', total_cost_usd: 0 });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.result).toEqual({ response: 'pong' });
  });

  it('salvages an empty result that still BILLED — the spend is booked, flagged, never vanishes', async () => {
    // The CLI ran and charged 12¢ but handed back a blank deliverable (the
    // --json-schema failure shape). Throwing here would release the task with
    // the 12¢ recorded nowhere; instead it becomes a flagged crash-salvage
    // progress contribution carrying the CLI's own (real, not estimated) cost.
    const run = cliReply({ result: '', total_cost_usd: 0.12 });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.crashed).toBe(true);
    expect(r.outcome).toBe('progress');
    expect(r.actual_cost_cents).toBe(12);
    expect(r.raw_usage).toMatchObject({
      crashed: true,
      estimated: false,
      estimator: 'cli_total_cost_usd',
    });
    expect((r.result as any).reason).toContain('empty result');
  });

  it('throws on an empty result that burned nothing — clean release, no fabricated record', async () => {
    const run = cliReply({ result: '' });
    await expect(new ClaudeCliExecutor({ run }).execute(task)).rejects.toThrow('empty result');
  });

  it('falls back to token metering when total_cost_usd is absent', async () => {
    const run = cliReply({ result: '{}', usage: { input_tokens: 100_000, output_tokens: 5_000 } });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.actual_cost_cents).toBe(38); // same as the API metering path
  });

  it('throws on an error result (no fabricated output)', async () => {
    const run = cliReply({ is_error: true, result: 'usage limit reached' });
    await expect(new ClaudeCliExecutor({ run }).execute(task)).rejects.toThrow(
      'usage limit reached',
    );
  });

  it('throws on unparseable CLI output (no result event)', async () => {
    const run = async () => 'not json at all';
    await expect(new ClaudeCliExecutor({ run }).execute(task)).rejects.toThrow('no result event');
  });

  it('parses a real stream-json transcript, taking the final result event', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'thinking…' }], usage: { output_tokens: 10 } },
      }),
      JSON.stringify({
        type: 'result',
        result: '{"summary":"done"}',
        total_cost_usd: 0.02,
        usage: { output_tokens: 50 },
        duration_ms: 900,
      }),
    ].join('\n');
    const r = await new ClaudeCliExecutor({ run: async () => lines }).execute(task);
    expect(r.result).toEqual({ summary: 'done' });
    expect(r.actual_cost_cents).toBe(2);
    expect(r.timed_out).toBeUndefined();
  });

  it('tags a decomposition deliverable so the runner submits it as one', async () => {
    const body = {
      summary: 'too big; here is the split',
      decomposition: {
        reason: 'cap is 200¢, the sweep needs ~50x that',
        subtasks: [{ title: 'a', prompt: 'p', max_cost_cents: 50 }],
      },
    };
    const run = cliReply({ result: JSON.stringify(body), total_cost_usd: 0.01 });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.outcome).toBe('decomposition');
    expect((r.result as any).decomposition.subtasks).toHaveLength(1);

    // a stray `decomposition` key with no subtasks must NOT hijack the submit
    const plain = cliReply({
      result: JSON.stringify({ summary: 'ok', decomposition: { note: 'n/a' } }),
      total_cost_usd: 0.01,
    });
    const r2 = await new ClaudeCliExecutor({ run: plain }).execute(task);
    expect(r2.outcome).toBeUndefined();
  });
});

describe('ClaudeCliExecutor — timeout salvage', () => {
  const streamLines = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');

  it('salvages a killed run into a progress contribution with honest, estimated cost', async () => {
    const partial = streamLines([
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Checked n up to 10^6; no counterexample so far.' }],
          usage: { input_tokens: 2000, output_tokens: 300 },
        },
      },
    ]);
    const run = async () => {
      throw new ExecTimeoutError(partial, 240_000);
    };
    const r = await new ClaudeCliExecutor({ run }).execute({
      ...task,
      target_state: { frontier: 'n < 10^5 done' },
    });

    expect(r.outcome).toBe('progress');
    expect(r.timed_out).toBe(true);
    expect(r.summary).toContain('timed out after 4 minute(s)');
    // partial findings preserved for the next agent…
    expect((r.result as any).partial_output).toContain('no counterexample so far');
    // …and merged BESIDE the existing state, never clobbering it
    expect((r.state_update as any).frontier).toBe('n < 10^5 done');
    expect((r.state_update as any).timeout_salvage.partial).toContain('10^6');
    // cost metered from the streamed usage, flagged as an estimate
    expect(r.actual_cost_cents).toBe(
      usageToCents('claude-sonnet-4-6', {
        input_tokens: 2000,
        output_tokens: 300,
      }),
    );
    expect(r.raw_usage as any).toMatchObject({
      timed_out: true,
      estimated: true,
      estimator: 'streamed_usage',
      elapsed_ms: 240_000,
      model: 'claude-sonnet-4-6',
    });
  });

  it('captures in-flight text deltas when the message never completed', async () => {
    const partial = streamLines([
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The key lem' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ma is…' } },
      },
    ]);
    const run = async () => {
      throw new ExecTimeoutError(partial, 180_000);
    };
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect((r.result as any).partial_output).toBe('The key lemma is…');
    // no usage events arrived — falls back to the chars/4 heuristic, still >= 1¢
    expect((r.raw_usage as any).estimator).toBe('char_heuristic');
    expect(r.actual_cost_cents).toBeGreaterThanOrEqual(1);
  });

  it('still records the attempt honestly when NOTHING reached stdout', async () => {
    const run = async () => {
      throw new ExecTimeoutError('', 600_000);
    };
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.outcome).toBe('progress');
    expect(r.timed_out).toBe(true);
    expect(r.summary).toContain('No partial output could be captured');
    // no findings -> no state_update (never clobber the target's working set)
    expect(r.state_update).toBeUndefined();
    // the prompt was certainly processed — a killed run is never "free"
    expect(r.actual_cost_cents).toBeGreaterThanOrEqual(1);
  });

  it('prefers the agent-curated PROGRESS.md over the stream capture', async () => {
    // The run wrote BOTH a progress file and stream text before dying — the
    // file (written for exactly this moment) must win everywhere it matters.
    const partial = streamLines([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'stream noise' }],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
    ]);
    const run = async (_a: string[], _i: string, _t: number, opts?: { cwd?: string }) => {
      await writeFile(
        join(opts!.cwd!, 'PROGRESS.md'),
        '# Progress\nFrontier: n < 10^8 done.\nNext: residue 7 mod 9.',
      );
      throw new ExecTimeoutError(partial, 240_000);
    };
    const r = await new ClaudeCliExecutor({ run }).execute(task);

    expect(r.outcome).toBe('progress');
    expect(r.summary).toContain('PROGRESS.md was salvaged');
    expect((r.result as any).progress_file).toContain('residue 7 mod 9');
    expect((r.result as any).partial_output).toBe('stream noise'); // kept too, secondary
    expect((r.state_update as any).timeout_salvage.partial).toContain('n < 10^8 done');
    expect((r.state_update as any).timeout_salvage.source).toBe('progress_file');
    expect((r.raw_usage as any).salvage_source).toBe('progress_file');
  });

  it('falls back to the stream capture when no PROGRESS.md was written', async () => {
    const partial = streamLines([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'got partway' }], usage: { output_tokens: 3 } },
      },
    ]);
    const run = async () => {
      throw new ExecTimeoutError(partial, 240_000);
    };
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect((r.result as any).partial_output).toBe('got partway');
    expect((r.raw_usage as any).salvage_source).toBe('stream');
    expect((r.result as any).progress_file).toBeUndefined();
  });

  it('cleans up the per-run working directory on success and on timeout', async () => {
    let dir1 = '';
    const ok = async (_a: string[], _i: string, _t: number, opts?: { cwd?: string }) => {
      dir1 = opts!.cwd!;
      expect(existsSync(dir1)).toBe(true);
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    await new ClaudeCliExecutor({ run: ok }).execute(task);
    expect(existsSync(dir1)).toBe(false);

    let dir2 = '';
    const dies = async (_a: string[], _i: string, _t: number, opts?: { cwd?: string }) => {
      dir2 = opts!.cwd!;
      await writeFile(join(dir2, 'PROGRESS.md'), 'salvage me');
      throw new ExecTimeoutError('', 60_000);
    };
    const r = await new ClaudeCliExecutor({ run: dies }).execute(task);
    expect((r.result as any).progress_file).toBe('salvage me'); // read BEFORE cleanup
    expect(existsSync(dir2)).toBe(false);
  });

  it('a truncated final line (killed mid-write) does not break parsing', () => {
    const complete = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done part 1' }], usage: { output_tokens: 5 } },
    });
    const raw = `${complete}\n{"type":"stream_event","event":{"type":"content_block_del`;
    const cap = parseStreamCapture(raw);
    expect(cap.text).toBe('done part 1');
    expect(cap.usage.output_tokens).toBe(5);
    expect(cap.final).toBeNull();
  });
});

// The platform's core promise on the model path: the accumulated frontier a
// checkout hands back (target_state + prior_contributions) must reach the
// model, or every attempt restarts from scratch. These tests pin the
// continuation section into the actual prompt sent to `claude -p`, and into
// the stub's echo so DB-backed suites can assert the same threading.
describe('continuation context — checkout state reaches the model prompt', () => {
  const priors: PriorContribution[] = [
    {
      id: 4,
      outcome: 'progress',
      summary: 'Attempt 3 timed out; salvaged PROGRESS.md attached.',
      created_at: '2026-07-22T10:00:00Z',
    },
    {
      id: 3,
      outcome: 'dead_end',
      summary: 'Direct induction on n fails at the residue-3 case.',
      created_at: '2026-07-21T09:00:00Z',
    },
  ];
  const state = {
    frontier: 'n < 10^7 ruled out',
    timeout_salvage: { source: 'progress_file', partial: 'Next: attack residue 3 mod 9 directly.' },
  };

  const capturePrompt = () => {
    const seen = { input: '' };
    const run = async (_a: string[], input: string) => {
      seen.input = input;
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    return { seen, run };
  };

  it('injects state + prior attempts into the claude -p prompt, clearly framed', async () => {
    const { seen, run } = capturePrompt();
    await new ClaudeCliExecutor({ run }).execute({
      ...task,
      target_state: state,
      prior_contributions: priors,
    });
    expect(seen.input).toContain('CONTINUATION — you are CONTINUING accumulated work');
    expect(seen.input).toContain('n < 10^7 ruled out'); // the compacted state
    expect(seen.input).toContain('Recent attempts on this task (newest first):');
    expect(seen.input).toContain('Attempt 3 timed out'); // newest prior
    expect(seen.input).toContain('residue-3 case'); // older prior
    // the continuation sits between the task spec and the time-budget protocol
    expect(seen.input.indexOf('CONTINUATION')).toBeGreaterThan(
      seen.input.indexOf('summarize this'),
    );
    expect(seen.input.indexOf('CONTINUATION')).toBeLessThan(seen.input.indexOf('TIME BUDGET'));
  });

  it('carries a prior timeout salvage (the PROGRESS.md content) into the next attempt', async () => {
    // What operations.checkoutTask hands back after a salvaged timeout: the
    // salvage merged into target_state, the attempt in prior_contributions.
    const { seen, run } = capturePrompt();
    await new ClaudeCliExecutor({ run }).execute({
      ...task,
      target_state: state,
      prior_contributions: [priors[0]],
    });
    expect(seen.input).toContain('attack residue 3 mod 9 directly'); // salvaged progress-file text
    expect(seen.input).toContain('timeout_salvage');
  });

  it('keeps a first attempt clean: empty state and no priors → no continuation section', async () => {
    const { seen, run } = capturePrompt();
    // checkoutTask defaults target_state to {} and priors to [] on a fresh task
    await new ClaudeCliExecutor({ run }).execute({
      ...task,
      target_state: {},
      prior_contributions: [],
    });
    expect(seen.input).not.toContain('CONTINUATION');
    expect(seen.input).not.toContain('Recent attempts');
  });

  it('caps an oversized history newest-first, with an explicit truncation note', () => {
    const many: PriorContribution[] = Array.from({ length: 20 }, (_, i) => ({
      id: 20 - i,
      outcome: 'progress',
      summary: `attempt ${20 - i}: ${'x'.repeat(600)}`,
      created_at: `2026-07-${String(20 - i).padStart(2, '0')}T00:00:00Z`,
    }));
    const section = buildContinuationSection(null, many);
    expect(section.length).toBeLessThanOrEqual(CONTINUATION_MAX_CHARS);
    expect(section).toContain('attempt 20:'); // newest kept…
    expect(section).not.toContain('attempt 1:'); // …oldest dropped
    expect(section).toMatch(/history truncated — \d+ older attempt\(s\) omitted/);
    // newest stays ahead of the ones that follow it
    expect(section.indexOf('attempt 20:')).toBeLessThan(section.indexOf('attempt 19:'));
  });

  it('truncates an oversized state with a note — a clipped frontier must say so', () => {
    const big = { frontier: 'y'.repeat(10_000) };
    const section = buildContinuationSection(big, []);
    expect(section).toContain('[state truncated at 6000 chars');
    expect(section.length).toBeLessThanOrEqual(CONTINUATION_MAX_CHARS);
  });

  it('builds nothing from genuinely empty inputs', () => {
    expect(buildContinuationSection(undefined, [])).toBe('');
    expect(buildContinuationSection(null, undefined)).toBe('');
    expect(buildContinuationSection({}, [])).toBe('');
    expect(buildContinuationSection('', [])).toBe('');
    expect(buildContinuationSection([], [])).toBe('');
  });

  it('stub executor echoes the continuation so DB suites can assert the threading', async () => {
    const r = await new StubExecutor().execute({
      ...task,
      target_state: state,
      prior_contributions: priors,
    });
    const echoed = (r.result as any).echoed_continuation as string;
    expect(echoed).toContain('CONTINUATION — you are CONTINUING accumulated work');
    expect(echoed).toContain('n < 10^7 ruled out');
    expect(echoed).toContain('Attempt 3 timed out');

    // first attempt: no echo at all, matching the clean prompt
    const clean = await new StubExecutor().execute({ ...task, target_state: {} });
    expect((clean.result as any).echoed_continuation).toBeUndefined();
  });

  it('SYSTEM_PROMPT tells the agent it cannot execute code (decompose instead)', async () => {
    const { seen, run } = capturePrompt();
    await new ClaudeCliExecutor({ run }).execute(task);
    // String-pinned like the other prompt tests: the agent must know its
    // execution reality — no shell, no interpreter, PROGRESS.md is the only
    // tool — so "run the simulation" tasks route to decomposition, not
    // grinding or fabricated output.
    expect(seen.input).toContain('EXECUTION REALITY — you cannot run code');
    expect(seen.input).toContain('no shell, no interpreter, and no sandbox');
    expect(seen.input).toContain('never present imagined program output as computed fact');
    expect(seen.input).toContain('the correct deliverable is a decomposition');
  });
});

describe('StubExecutor + factory', () => {
  it('stub reports ~80% of the cap', async () => {
    const r = await new StubExecutor().execute({ ...task, max_cost_cents: 500 });
    expect(r.actual_cost_cents).toBe(400);
  });

  it('getExecutor defaults to stub semantics and routes work units to the sandbox', async () => {
    const prev = process.env.EXECUTOR;
    delete process.env.EXECUTOR;
    const ex = getExecutor();
    // A plain task is handled by the stub…
    const res = await ex.execute(task);
    expect((res.result as { stub?: boolean }).stub).toBe(true);
    // …while a spec.code task goes to the work-unit path (which enforces the
    // repo allowlist before anything else).
    await expect(
      ex.execute({
        ...task,
        spec: { code: { repo: 'someone/else', sha: 'a'.repeat(40), entrypoint: 'x.py' } },
      }),
    ).rejects.toThrow(/not allowlisted/);
    if (prev !== undefined) process.env.EXECUTOR = prev;
  });
});
