import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES as CC_MAX_FILE_BYTES,
  MAX_FILES as CC_MAX_FILES,
  extractCodeContribution,
} from '../src/code-contrib.js';
import {
  buildContinuationSection,
  ClaudeCliExecutor,
  CONTINUATION_MAX_CHARS,
  cliVersionAtLeast,
  coerceBooleanFields,
  coerceResult,
  coerceResultDetailed,
  DECOMPOSITION_CAP_MULTIPLE,
  decompositionLimitsSection,
  ExecFailedError,
  type ExecTask,
  ExecTimeoutError,
  getExecutor,
  isReviewTask,
  MAX_DECOMPOSITION_CHUNKS,
  MAX_DECOMPOSITION_SUBTASKS,
  MIN_JSON_SCHEMA_CLI_VERSION,
  modelForEffort,
  type PriorContribution,
  parseStreamCapture,
  RESULT_JSON_SCHEMA,
  resultSchemaFor,
  reviewContextSection,
  StubExecutor,
  usageToCents,
} from '../src/executor.js';
import {
  DECOMPOSITION_CAP_MULTIPLE as OPS_CAP_MULTIPLE,
  MAX_DECOMPOSITION_CHUNKS as OPS_MAX_CHUNKS,
  MAX_DECOMPOSITION_SUBTASKS as OPS_MAX_SUBTASKS,
} from '../src/operations.js';

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

  it('records the extraction rung: strict / fenced / last_object / raw_text', () => {
    expect(coerceResultDetailed('{"a": 1}')).toEqual({ value: { a: 1 }, parse_mode: 'strict' });
    expect(coerceResultDetailed('```json\n{"a": 1}\n```')).toEqual({
      value: { a: 1 },
      parse_mode: 'fenced',
    });
    expect(coerceResultDetailed('the answer is {"n": 7} indeed')).toEqual({
      value: { n: 7 },
      parse_mode: 'last_object',
    });
    expect(coerceResultDetailed('no json here')).toEqual({
      value: { output: 'no json here' },
      parse_mode: 'raw_text',
    });
    // a fence whose body is a top-level ARRAY: invisible to the object scanner,
    // so the fenced rung is what catches it
    expect(coerceResultDetailed('results below:\n```json\n[1, 2, 3]\n```\ndone')).toEqual({
      value: [1, 2, 3],
      parse_mode: 'fenced',
    });
  });

  it('extracts the real final object from the production incident shape (prose + placeholder fence + final JSON + trailing notes)', () => {
    // The exact failure observed live: paragraphs of prose, then a fenced
    // PLACEHOLDER the model narrated (literal `...` values — does not parse),
    // then the REAL final envelope object, then trailing notes. The old parser
    // took first `{` → last `}` across all of it, failed, and submitted the
    // whole stdout as raw text — mis-routing a decomposition as a terminal
    // candidate_solution.
    const real = {
      output: 'This is a decomposition contribution — the task exceeds its budget.',
      summary: 'split into 3 subtasks',
      decomposition: {
        reason: 'needs ~50x the cap',
        subtasks: [{ title: 'a', prompt: 'p', max_cost_cents: 50 }],
      },
    };
    const stdout =
      'I analyzed the task carefully.\n\nThe budget plainly cannot cover the sweep, ' +
      'so the correct deliverable is a decomposition.\n\n' +
      'The final JSON will follow this shape:\n\n' +
      '```json\n{"output": ..., "summary": ..., "decomposition": {"reason": ..., "subtasks": [...]}}\n```\n\n' +
      'Here is the actual contribution:\n\n' +
      `${JSON.stringify(real)}\n\n` +
      'Note: subtask costs are integer cents as required.  \n';
    expect(coerceResultDetailed(stdout)).toEqual({ value: real, parse_mode: 'last_object' });
  });

  it('with multiple parseable objects, the last envelope-looking one wins', () => {
    // An earlier PARSEABLE placeholder (quoted "..." values) is still an
    // envelope — later beats earlier, so the real one wins…
    const s =
      'shape: {"output": "...", "summary": "..."}\n' +
      'real: {"output": "done", "summary": "the actual result"}\n' +
      'aside: {"note": "not an envelope"}';
    expect(coerceResultDetailed(s)).toEqual({
      value: { output: 'done', summary: 'the actual result' },
      parse_mode: 'last_object',
    });
    // …and with no envelope anywhere, the last parseable object wins
    expect(coerceResultDetailed('first {"a": 1} then {"b": 2}')).toEqual({
      value: { b: 2 },
      parse_mode: 'last_object',
    });
  });

  it('pathological braces inside strings do not break the scanner', () => {
    // braces and escaped quotes inside JSON strings must not derail matching
    const tricky = { summary: 'a } stray { brace', output: 'quote " and \\ and }{ done' };
    const s = `prose with an { unbalanced brace\n${JSON.stringify(tricky)}\ntrailing } brace`;
    expect(coerceResultDetailed(s)).toEqual({ value: tricky, parse_mode: 'last_object' });
    // a balanced-but-unparseable span is stepped INTO, not skipped: the real
    // object nested after junk inside the same braces is still found
    expect(coerceResult('{ junk before {"output": "inner"} junk after }')).toEqual({
      output: 'inner',
    });
    // brace soup with no JSON at all stays raw text and never throws
    expect(coerceResultDetailed('{{{{ not json }}}}')).toEqual({
      value: { output: '{{{{ not json }}}}' },
      parse_mode: 'raw_text',
    });
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

  it('passes -p/stream-json/--model, prompt+shape on stdin; no --json-schema on an unprobed CLI', async () => {
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
    // With an injected fake runner and no injected version probe, schema
    // support is unknown → the flag must NOT be sent (the fallback-ladder
    // path, and what every volunteer on an older CLI gets).
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

  it('routes a decomposition buried in prose (the production mis-route) and records parse_mode', async () => {
    // The live incident: a correct decomposition wrapped in prose + a narrated
    // placeholder fence was submitted as a terminal candidate_solution because
    // the parser fell back to raw text. It must route as a decomposition, and
    // raw_usage must say which extraction rung fired so mis-parses are
    // diagnosable from the recorded contribution.
    const body = {
      output: 'This is a decomposition contribution — the sweep exceeds the budget.',
      summary: 'split the sweep',
      decomposition: {
        reason: 'cap is 200¢, the sweep needs ~50x that',
        subtasks: [{ title: 'a', prompt: 'p', max_cost_cents: 50 }],
      },
    };
    const stdout =
      'Let me explain my reasoning first.\n\n' +
      'The final object will look like:\n```json\n{"output": ..., "decomposition": ...}\n```\n\n' +
      `${JSON.stringify(body)}\n\ntrailing note\n`;
    const run = cliReply({ result: stdout, total_cost_usd: 0.01 });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.outcome).toBe('decomposition');
    expect(r.result).toEqual(body);
    expect(r.summary).toBe('split the sweep');
    expect((r.raw_usage as any).parse_mode).toBe('last_object');

    // clean strict output records 'strict'; pure prose records 'raw_text' and
    // is still kept + charged (never thrown away)
    const strict = await new ClaudeCliExecutor({
      run: cliReply({ result: '{"summary":"ok"}', total_cost_usd: 0.01 }),
    }).execute(task);
    expect((strict.raw_usage as any).parse_mode).toBe('strict');
    const prose = await new ClaudeCliExecutor({
      run: cliReply({ result: 'I could not produce JSON, sorry.', total_cost_usd: 0.01 }),
    }).execute(task);
    expect((prose.raw_usage as any).parse_mode).toBe('raw_text');
    expect(prose.result).toEqual({ output: 'I could not produce JSON, sorry.' });
    expect(prose.actual_cost_cents).toBe(1);
  });
});

// PRIMARY layer for the prose-wrapped-JSON incident: on CLIs new enough to
// honor --json-schema, the deliverable is schema-constrained at the source and
// arrives pre-parsed in the result event's structured_output field. These
// tests pin the version gate (a FREE probe — never a paid trial run), the
// flag wiring, the structured happy path, and the graceful degradation to the
// extraction ladder.
describe('ClaudeCliExecutor — native --json-schema structured output', () => {
  const supported = async () => '2.1.210 (Claude Code)';
  const decompositionBody = {
    output: 'This is a decomposition contribution — the sweep exceeds the budget.',
    summary: 'split the sweep',
    decomposition: {
      reason: 'needs ~50x the cap',
      subtasks: [{ title: 'a', prompt: 'p', max_cost_cents: 50 }],
    },
  };

  it('gates on the CLI version: >= 2.1.205 sends the flag, older/unknown does not', async () => {
    // docs: before v2.1.205 an invalid schema was SILENTLY ignored — the flag
    // is only trustworthy from the version where it fails loudly
    expect(cliVersionAtLeast('2.1.205 (Claude Code)', MIN_JSON_SCHEMA_CLI_VERSION)).toBe(true);
    expect(cliVersionAtLeast('2.1.204 (Claude Code)', MIN_JSON_SCHEMA_CLI_VERSION)).toBe(false);
    expect(cliVersionAtLeast('2.2.0', MIN_JSON_SCHEMA_CLI_VERSION)).toBe(true);
    expect(cliVersionAtLeast('3.0.0', MIN_JSON_SCHEMA_CLI_VERSION)).toBe(true);
    expect(cliVersionAtLeast('1.9.999', MIN_JSON_SCHEMA_CLI_VERSION)).toBe(false);
    expect(cliVersionAtLeast('not a version', MIN_JSON_SCHEMA_CLI_VERSION)).toBe(false);

    const argsSeen: string[][] = [];
    const run = async (args: string[]) => {
      argsSeen.push(args);
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0.01 });
    };
    await new ClaudeCliExecutor({ run, probeVersion: supported }).execute(task);
    await new ClaudeCliExecutor({ run, probeVersion: async () => '2.1.204' }).execute(task);
    await new ClaudeCliExecutor({ run, probeVersion: async () => null }).execute(task);
    expect(argsSeen[0]).toContain('--json-schema');
    expect(argsSeen[1]).not.toContain('--json-schema');
    expect(argsSeen[2]).not.toContain('--json-schema'); // probe failed → assume unsupported
    // the schema sent is the contribution envelope, as parseable JSON
    const schema = JSON.parse(argsSeen[0][argsSeen[0].indexOf('--json-schema') + 1]);
    expect(schema).toEqual(RESULT_JSON_SCHEMA);
    expect(schema.properties.outcome.enum).toContain('decomposition');
    expect(schema.required).toBeUndefined(); // partial-but-honest results must validate
    expect(schema.additionalProperties).toBe(true); // task-specific output_schema keys ride along
  });

  it('probes the version ONCE per executor — a free version read, never a paid trial run', async () => {
    let probes = 0;
    const probeVersion = async () => {
      probes++;
      return '2.1.210 (Claude Code)';
    };
    let runs = 0;
    const run = async () => {
      runs++;
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0.01 });
    };
    const exec = new ClaudeCliExecutor({ run, probeVersion });
    await exec.execute(task);
    await exec.execute(task);
    await exec.execute(task);
    expect(probes).toBe(1); // cached — and it cost zero tokens to begin with
    expect(runs).toBe(3); // exactly one PAID run per task, never a probe-run
  });

  it('reads the deliverable from structured_output and routes a decomposition (result field empty)', async () => {
    // Under --json-schema the CLI's `result` field is empty — the historical
    // trap that got the flag removed. structured_output is the deliverable,
    // an empty `result` beside it must NOT trip the empty-result salvage.
    const run = async () =>
      JSON.stringify({
        result: '',
        structured_output: decompositionBody,
        total_cost_usd: 0.02,
        usage: { output_tokens: 40 },
      });
    const r = await new ClaudeCliExecutor({ run, probeVersion: supported }).execute(task);
    expect(r.crashed).toBeUndefined();
    expect(r.result).toEqual(decompositionBody);
    expect(r.outcome).toBe('decomposition');
    expect(r.summary).toBe('split the sweep');
    expect(r.actual_cost_cents).toBe(2);
    expect((r.raw_usage as any).parse_mode).toBe('structured_output');
  });

  it('falls back to the extraction ladder when a supported CLI returns no structured_output', async () => {
    const stdout = `prose first\n${JSON.stringify({ summary: 'embedded', output: 'ok' })}\nprose after`;
    const run = async () => JSON.stringify({ result: stdout, total_cost_usd: 0.01 });
    const r = await new ClaudeCliExecutor({ run, probeVersion: supported }).execute(task);
    expect(r.result).toEqual({ summary: 'embedded', output: 'ok' });
    expect((r.raw_usage as any).parse_mode).toBe('last_object');
  });

  it('retries ONCE without the flag when the CLI rejects it — only because nothing was burned', async () => {
    const argsSeen: string[][] = [];
    const run = async (args: string[]) => {
      argsSeen.push(args);
      if (args.includes('--json-schema')) {
        // old CLI: instant usage error — empty stdout, nothing metered, nothing billed
        throw new ExecFailedError('', "error: unknown option '--json-schema'", 2, 40);
      }
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0.01 });
    };
    const exec = new ClaudeCliExecutor({ run, probeVersion: supported });
    const r = await exec.execute(task);
    expect(r.result).toEqual({ summary: 'ok' });
    expect(r.crashed).toBeUndefined();
    expect(argsSeen).toHaveLength(2);
    expect(argsSeen[0]).toContain('--json-schema');
    expect(argsSeen[1]).not.toContain('--json-schema');
    // support is pinned OFF for this executor: the next task skips the failing
    // flag outright — one paid run, no retry dance
    await exec.execute(task);
    expect(argsSeen).toHaveLength(3);
    expect(argsSeen[2]).not.toContain('--json-schema');
  });

  it('does NOT retry when the failed schema run burned real tokens — that spend is salvaged instead', async () => {
    // If the run got far enough to stream usage, a retry would DOUBLE-SPEND:
    // the crash-salvage path books the burned donation and stops.
    const partial = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'partway through' }],
          usage: { input_tokens: 500, output_tokens: 60 },
        },
      }),
    ].join('\n');
    let runs = 0;
    const run = async () => {
      runs++;
      throw new ExecFailedError(partial, "error: unknown option '--json-schema'", 2, 900);
    };
    const r = await new ClaudeCliExecutor({ run, probeVersion: supported }).execute(task);
    expect(runs).toBe(1); // no second paid run
    expect(r.crashed).toBe(true);
    expect(r.outcome).toBe('progress');
    expect((r.result as any).partial_output).toContain('partway through');
  });

  it('salvages a timeout identically in schema mode — partials stream, the final event never came', async () => {
    const partial = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'checked n up to 10^6' }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      },
    });
    let sawSchemaFlag = false;
    const run = async (args: string[]) => {
      sawSchemaFlag = args.includes('--json-schema');
      throw new ExecTimeoutError(partial, 240_000);
    };
    const r = await new ClaudeCliExecutor({ run, probeVersion: supported }).execute(task);
    expect(sawSchemaFlag).toBe(true); // the killed run WAS a schema-mode run
    expect(r.timed_out).toBe(true);
    expect(r.outcome).toBe('progress');
    expect((r.result as any).partial_output).toContain('10^6');
    expect((r.raw_usage as any).estimator).toBe('streamed_usage');
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
    // …carried in a state_update that names ONLY this run's own key. Merging is
    // the server's job (mergeStateUpdate), so the existing frontier is safe
    // without the executor echoing it back — and echoing it back is precisely
    // how a stale key outlives the attempt that wrote it.
    expect((r.state_update as any).timeout_salvage.partial).toContain('10^6');
    expect(Object.keys(r.state_update as any)).toEqual(['timeout_salvage']);
    expect((r.state_update as any).frontier).toBeUndefined();
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

  it('salvaged-proposal artifact brings the computed limits along — the correction is self-sufficient', () => {
    // The #87 salvage path: a prior attempt's invalid decomposition survives
    // as an inline artifact with its validation errors. The next agent is told
    // to "fix exactly those errors" — so the limits it must fix them AGAINST
    // must be right there, computed for this task's cap.
    const salvaged: PriorContribution = {
      id: 9,
      outcome: 'progress',
      summary: 'Proposed a decomposition that failed validation (details preserved).',
      artifact: {
        proposed_decomposition: {
          reason: 'sweep too big',
          subtasks: [{ title: 'a', prompt: 'p', max_cost_cents: 300 }],
        },
        validation_errors: ["subtask 0: max_cost_cents 300 exceeds 2x the parent task's cap (160)"],
      },
      created_at: '2026-07-22T10:00:00Z',
    };
    const section = buildContinuationSection(null, [salvaged], 80);
    expect(section).toContain('fix exactly those errors and resubmit');
    expect(section).toContain('DECOMPOSITION LIMITS for THIS task');
    expect(section).toContain("must be at most 160 (2x this task's 80¢ cap)");
    expect(section.length).toBeLessThanOrEqual(CONTINUATION_MAX_CHARS);

    // No artifact → no limits noise in an ordinary continuation…
    const plain = buildContinuationSection(null, [{ ...salvaged, artifact: undefined }], 80);
    expect(plain).not.toContain('DECOMPOSITION LIMITS');
    // …and an unknown cap can't render made-up numbers.
    expect(buildContinuationSection(null, [salvaged])).not.toContain('DECOMPOSITION LIMITS');
  });

  it('a review_rejected artifact renders the address-and-resubmit instruction, with the limits', () => {
    // The peer-review rejection channel: the reviewer's reasons are appended
    // to the PARENT task as a zero-cost contribution (see operations.ts
    // recordReviewRejection), and the continuation must tell the next agent to
    // address the verdict — not to "fix validation errors" that don't exist.
    const rejected: PriorContribution = {
      id: 12,
      outcome: 'progress',
      summary: 'Peer review REJECTED the proposed decomposition: caps padded 10x',
      artifact: {
        review_rejected: true,
        reasons: 'caps padded 10x beyond the stated work',
        reviewed_contribution: 7,
      },
      created_at: '2026-07-23T00:00:00Z',
    };
    const section = buildContinuationSection(null, [rejected], 80);
    expect(section).toContain('peer reviewer REJECTED the previous decomposition proposal');
    expect(section).toContain('address them and resubmit');
    expect(section).toContain('caps padded 10x beyond the stated work');
    expect(section).toContain('DECOMPOSITION LIMITS for THIS task');
    expect(section).toContain("at most 160 (2x this task's 80¢ cap)");
    expect(section).not.toContain('fix exactly those errors'); // that instruction is validation-salvage's
  });

  it('limits + state + artifact-bearing prior still fit the continuation size cap', () => {
    const big = { frontier: 'y'.repeat(10_000) };
    const salvaged: PriorContribution = {
      id: 9,
      outcome: 'progress',
      summary: 's'.repeat(1_000),
      artifact: {
        proposed_decomposition: { subtasks: [] },
        validation_errors: ['e'.repeat(4_000)],
      },
    };
    const section = buildContinuationSection(big, [salvaged], 80);
    expect(section.length).toBeLessThanOrEqual(CONTINUATION_MAX_CHARS);
    expect(section).toContain('DECOMPOSITION LIMITS for THIS task');
    expect(section).toContain('Preserved artifact');
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

// code_contribution existed in code (code-contrib.ts → PR to the contrib repo)
// but the prompt never mentioned it — no agent could use the path, and the
// two-phase decomposition story had no phase 1. The prompt must document the
// field with the REAL extraction limits, and the envelope must permit it.
describe('code_contribution — documented in the prompt, permitted by the envelope', () => {
  it('the claude -p prompt documents code_contribution with the real extraction limits', async () => {
    let seenInput = '';
    const run = async (_a: string[], input: string) => {
      seenInput = input;
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    await new ClaudeCliExecutor({ run }).execute(task);
    expect(seenInput).toContain('CODE CONTRIBUTIONS');
    expect(seenInput).toContain('"code_contribution"');
    // the numbers are the ones extractCodeContribution actually enforces
    expect(seenInput).toContain(
      `at most ${CC_MAX_FILES} files, each at most ${CC_MAX_FILE_BYTES} bytes`,
    );
    expect(seenInput).toContain('no ".git" or ".github" segments');
    // the two-phase decomposition guidance wires phase 1 to the field…
    expect(seenInput).toContain('emit the program as a "code_contribution"');
    // …and pins execution to the sandbox, never a model subtask
    expect(seenInput).toContain('ONLY via code-pinned CHUNK subtasks');
    // proposers must know code shipped beside a decomposition reaches its
    // reviewer (v0.3.8: proposals were rejected for "missing" code that shipped)
    expect(seenInput).toContain('the reviewer of your proposal is shown the published PR URL');
  });

  it('a code_contribution result passes schema mode and round-trips to the extractor', async () => {
    const body = {
      summary: 'wrote the sweep program',
      code_contribution: {
        title: 'Goldbach sweep program',
        description: 'sieve + verify per slice',
        files: [{ path: 'sweeps/goldbach.py', content: 'print("hi")\n' }],
      },
    };
    const run = async () =>
      JSON.stringify({ result: '', structured_output: body, total_cost_usd: 0.01 });
    const r = await new ClaudeCliExecutor({
      run,
      probeVersion: async () => '2.1.210 (Claude Code)',
    }).execute(task);
    expect(r.result).toEqual(body);
    // the runner-side extractor accepts exactly what the schema shaped
    expect(extractCodeContribution(r.result)).toEqual(body.code_contribution);

    // the envelope names the field explicitly, with the file shape…
    const cc = (RESULT_JSON_SCHEMA.properties as any).code_contribution;
    expect(cc.required).toEqual(['title', 'files']);
    expect(cc.properties.files.items.required).toEqual(['path', 'content']);
    // …while the top level stays permissive (partial results must validate)
    expect((RESULT_JSON_SCHEMA as any).required).toBeUndefined();
  });
});

// The production silent-verdict-loss pattern: review tasks declare
// output_schema {approve: 'boolean — …'}, but only the generic envelope was
// enforced — a reviewer returned {"approve": "false"} (a STRING), and a string
// "true" would slip past the strict `approve === true` publish gate: reviewer
// spend booked, approval lost, subtasks never minted.
describe('task output_schema — enforced natively, repaired on the ladder', () => {
  const supported = async () => '2.1.210 (Claude Code)';
  const reviewSchema = {
    approve: 'boolean — true publishes the proposed subtasks; anything else publishes nothing',
    reasons: 'string — the concrete grounds for your verdict',
  };
  const reviewTask: ExecTask = {
    ...task,
    spec: {
      prompt: 'review this proposal',
      review_of: 41,
      deliverable: 'decomposition_review',
      output_schema: reviewSchema,
      acceptance: 'approve must be an explicit boolean',
    },
  };

  it('resultSchemaFor types the task keys alongside the envelope', () => {
    const schema = resultSchemaFor(reviewSchema);
    expect((schema.properties as any).approve).toEqual({
      type: 'boolean',
      description: reviewSchema.approve,
    });
    expect((schema.properties as any).reasons.type).toBe('string');
    // the envelope survives intact around the task keys
    expect(schema.properties.outcome.enum).toContain('decomposition');
    expect((schema as any).required).toBeUndefined(); // task keys never become required
    expect(schema.additionalProperties).toBe(true);
  });

  it('envelope keys win collisions, no schema means the exact envelope, loose prose stays untyped', () => {
    // `outcome` routes the submit — a task spec must not be able to redefine it
    const collided = resultSchemaFor({ outcome: 'boolean — hijack attempt' });
    expect(collided.properties.outcome.enum).toContain('decomposition');
    // no output_schema → the untouched envelope object
    expect(resultSchemaFor(undefined)).toBe(RESULT_JSON_SCHEMA);
    // a description that names no recognizable type constrains nothing
    const loose = resultSchemaFor({ verdict: 'your call, described in text' });
    expect((loose.properties as any).verdict).toEqual({
      description: 'your call, described in text',
    });
  });

  it('sends the merged schema to claude -p: a review run has approve typed boolean at the source', async () => {
    let argsSeen: string[] = [];
    const run = async (args: string[]) => {
      argsSeen = args;
      return JSON.stringify({
        result: '',
        structured_output: { approve: true, reasons: 'well-posed, economical' },
        total_cost_usd: 0.01,
      });
    };
    const r = await new ClaudeCliExecutor({ run, probeVersion: supported }).execute(reviewTask);
    const sent = JSON.parse(argsSeen[argsSeen.indexOf('--json-schema') + 1]);
    expect(sent.properties.approve.type).toBe('boolean');
    expect(sent.properties.reasons.type).toBe('string');
    expect(sent.properties.outcome.enum).toContain('decomposition'); // envelope intact
    expect((r.result as any).approve).toBe(true); // proper boolean flows through untouched
  });

  it('ladder path: "true"/"false" strings coerce to booleans ONLY where the schema says boolean', async () => {
    // Older CLI (no --json-schema): the exact production shape, approve as a string.
    const run = async () =>
      JSON.stringify({
        result: '{"approve":"false","reasons":"padded plan","note":"true"}',
        total_cost_usd: 0.01,
      });
    const r = await new ClaudeCliExecutor({ run }).execute({
      ...reviewTask,
      spec: { ...reviewTask.spec, output_schema: { ...reviewSchema, note: 'string — aside' } },
    });
    expect((r.result as any).approve).toBe(false); // declared boolean → coerced
    expect((r.result as any).reasons).toBe('padded plan');
    expect((r.result as any).note).toBe('true'); // declared string → left alone

    const yes = async () =>
      JSON.stringify({ result: '{"approve":" True ","reasons":"ok"}', total_cost_usd: 0.01 });
    const r2 = await new ClaudeCliExecutor({ run: yes }).execute(reviewTask);
    expect((r2.result as any).approve).toBe(true); // trims + case-folds, still unambiguous
  });

  it('absent output_schema → behavior unchanged, nothing is coerced', async () => {
    const run = async () =>
      JSON.stringify({ result: '{"approve":"false","summary":"s"}', total_cost_usd: 0.01 });
    const bare: ExecTask = { ...task, spec: { prompt: 'p' } };
    const r = await new ClaudeCliExecutor({ run }).execute(bare);
    expect((r.result as any).approve).toBe('false'); // stays a string — no blind coercion
  });

  it('coerceBooleanFields is surgical: only the two unambiguous strings, only declared fields', () => {
    expect(coerceBooleanFields({ approve: 'yes' }, reviewSchema)).toEqual({ approve: 'yes' });
    expect(coerceBooleanFields({ approve: true }, reviewSchema)).toEqual({ approve: true });
    expect(coerceBooleanFields('false', reviewSchema)).toBe('false'); // non-object passthrough
    expect(coerceBooleanFields(null, reviewSchema)).toBeNull();
    const untouched = { reasons: 'true' }; // declared string — same object back, not a copy
    expect(coerceBooleanFields(untouched, reviewSchema)).toBe(untouched);
  });
});

// The production wasted-spin pattern: agents priced subtasks over the 2x cap
// because the prompt only ever stated the rule symbolically — attempt 8
// proposed 160/200/300¢ subtasks against an 80¢ limit and discovered the rule
// by failing validation, a full paid run per discovery. The prompt must state
// the COMPUTED numbers for the task at hand.
describe('decomposition limits — computed numbers reach the prompt', () => {
  it('renders every validation-enforced limit with the concrete numbers', () => {
    const s = decompositionLimitsSection(80);
    expect(s).toContain(
      "each subtask's max_cost_cents must be at most 160 (2x this task's 80¢ cap)",
    );
    expect(s).toContain('est_cost_cents must be <= max_cost_cents');
    expect(s).toContain('at most 12 model-executed subtasks');
    expect(s).toContain('up to 64 chunks per proposal');
    expect(s).toContain('same repo+sha+entrypoint');
    expect(s).toContain('a decomposition-review task can never itself be decomposed');
    expect(s).toContain('split into more, smaller chunks');
  });

  it('mirrored constants stay equal to the real validation constants in operations.ts', () => {
    // executor.ts must not import operations.ts (execution plane, no pg), so
    // the caps are mirrored — this is the tripwire if validation ever changes.
    expect(DECOMPOSITION_CAP_MULTIPLE).toBe(OPS_CAP_MULTIPLE);
    expect(MAX_DECOMPOSITION_SUBTASKS).toBe(OPS_MAX_SUBTASKS);
    expect(MAX_DECOMPOSITION_CHUNKS).toBe(OPS_MAX_CHUNKS);
  });

  it('the claude -p prompt carries the computed caps for THIS task', async () => {
    let seenInput = '';
    const run = async (_a: string[], input: string) => {
      seenInput = input;
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    await new ClaudeCliExecutor({ run }).execute({ ...task, max_cost_cents: 80 });
    expect(seenInput).toContain('DECOMPOSITION LIMITS for THIS task');
    expect(seenInput).toContain("at most 160 (2x this task's 80¢ cap)");
    // the concrete section sits between the system prompt's rules and the task
    expect(seenInput.indexOf('DECOMPOSITION LIMITS')).toBeGreaterThan(seenInput.indexOf('Rules:'));
    expect(seenInput.indexOf('DECOMPOSITION LIMITS')).toBeLessThan(seenInput.indexOf('Task: '));
  });

  it('a different cap yields different computed numbers — nothing is hard-coded', async () => {
    let seenInput = '';
    const run = async (_a: string[], input: string) => {
      seenInput = input;
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    await new ClaudeCliExecutor({ run }).execute({ ...task, max_cost_cents: 250 });
    expect(seenInput).toContain("at most 500 (2x this task's 250¢ cap)");
  });
});

// The production mis-review pattern (observed on v0.3.5): a 15¢ REVIEW task
// rendered DECOMPOSITION LIMITS from its OWN cap ("at most 30¢") while judging
// a proposal whose parent was capped at 40¢ (legal per-subtask ceiling 80¢) —
// so perfectly legal 80¢ subtasks were rejected as "hard structural
// violations", and the bogus figure then hydrated into the proposer's
// continuation context, baiting systematic under-pricing. A review task's
// prompt must carry the REVIEWED task's numbers (baked into its spec at mint
// time) or, for legacy review tasks minted without them, no cap figures at all.
describe('review tasks — cap context comes from the reviewed task, never their own', () => {
  const capture = () => {
    const box = { input: '' };
    const run = async (_a: string[], input: string) => {
      box.input = input;
      return JSON.stringify({ result: '{"approve":true,"reasons":"ok"}', total_cost_usd: 0 });
    };
    return { box, run };
  };
  const reviewTask: ExecTask = {
    ...task,
    max_cost_cents: 15, // the incident's review-task cap — 2x would claim a 30¢ ceiling
    spec: {
      prompt: 'review this proposal',
      review_of: 41,
      deliverable: 'decomposition_review',
      reviewed_max_cost_cents: 40, // the incident's parent cap — real ceiling is 80¢
    },
  };

  it("the prompt states the REVIEWED task's numbers, not the review task's own", async () => {
    const { box, run } = capture();
    await new ClaudeCliExecutor({ run }).execute(reviewTask);
    expect(box.input).toContain('REVIEW CONTEXT');
    expect(box.input).toContain('reviewing a decomposition of a task capped at 40¢');
    expect(box.input).toContain('at most 80¢ (2x that 40¢ cap)');
    // the own-cap section and its wrong arithmetic must be absent
    expect(box.input).not.toContain('DECOMPOSITION LIMITS for THIS task');
    expect(box.input).not.toContain('at most 30');
    expect(box.input).not.toContain('15¢ cap');
  });

  it('legacy review task (minted before the cap was baked) renders NO cap figures at all', async () => {
    const { box, run } = capture();
    await new ClaudeCliExecutor({ run }).execute({
      ...reviewTask,
      spec: { prompt: 'review this proposal', review_of: 41 },
    });
    expect(box.input).not.toContain('DECOMPOSITION LIMITS for THIS task');
    expect(box.input).not.toContain('REVIEW CONTEXT');
    expect(box.input).not.toContain('max_cost_cents must be at most');
  });

  it("a review task's continuation never renders correction caps from its own budget", async () => {
    // The review-of-a-review salvage path books a prior WITH an artifact onto
    // the review task itself — the artifact-hydration channel that triggers
    // the correction-caps block in buildContinuationSection.
    const { box, run } = capture();
    await new ClaudeCliExecutor({ run }).execute({
      ...reviewTask,
      spec: { prompt: 'review this proposal', review_of: 41 },
      prior_contributions: [
        {
          outcome: 'progress',
          summary: 'salvaged',
          artifact: { proposed_decomposition: { subtasks: [] }, validation_errors: ['nope'] },
        },
      ],
    });
    expect(box.input).toContain('CONTINUATION');
    expect(box.input).not.toContain('DECOMPOSITION LIMITS for THIS task');
  });

  it('the StubExecutor echo honors the same guard', async () => {
    const r = await new StubExecutor().execute({
      ...reviewTask,
      spec: { prompt: 'review this proposal', review_of: 41 },
      prior_contributions: [
        {
          outcome: 'progress',
          summary: 'salvaged',
          artifact: { proposed_decomposition: { subtasks: [] }, validation_errors: ['nope'] },
        },
      ],
    });
    const echoed = (r.result as { echoed_continuation?: string }).echoed_continuation ?? '';
    expect(echoed).toContain('CONTINUATION');
    expect(echoed).not.toContain('DECOMPOSITION LIMITS for THIS task');
  });

  it('reviewContextSection: computed from the baked cap; anything unusable renders nothing', () => {
    const s = reviewContextSection({ review_of: 41, reviewed_max_cost_cents: 40 });
    expect(s).toContain('capped at 40¢');
    expect(s).toContain('at most 80¢ (2x that 40¢ cap)');
    expect(s).toContain('est_cost_cents must be <= max_cost_cents');
    expect(s).toContain('at most 12 model-executed subtasks');
    expect(s).toContain('up to 64 pinned-code sandbox chunks');
    // wrong-number-proofing: absent, zero, negative, fractional, or junk → ''
    expect(reviewContextSection({ review_of: 41 })).toBe('');
    expect(reviewContextSection({ review_of: 41, reviewed_max_cost_cents: 0 })).toBe('');
    expect(reviewContextSection({ review_of: 41, reviewed_max_cost_cents: -5 })).toBe('');
    expect(reviewContextSection({ review_of: 41, reviewed_max_cost_cents: 12.5 })).toBe('');
    expect(reviewContextSection({ review_of: 41, reviewed_max_cost_cents: 'forty' })).toBe('');
    expect(reviewContextSection(undefined)).toBe('');
  });

  it('reviewContextSection announces code shipped with the proposal (URL or inline-only)', () => {
    // The v0.3.8 incident: the reviewer rejected a code-shipping proposal as
    // "the actual proposal contains no code_contribution key". When the mint
    // baked code fields into the spec, the section must say the code is there.
    const withUrl = reviewContextSection({
      review_of: 41,
      reviewed_max_cost_cents: 40,
      code_published_at: 'https://github.com/x/contrib/pull/9',
      code_files: [{ path: 'sweeps/sieve.py', bytes: 128 }],
    });
    expect(withUrl).toContain('the proposal ships code');
    expect(withUrl).toContain('published at https://github.com/x/contrib/pull/9');
    expect(withUrl).toContain('listed in the task prompt below');
    expect(withUrl).toContain('INCLUDING that code');
    // The cap half still renders alongside, unchanged.
    expect(withUrl).toContain('capped at 40¢');

    // Publish failed → inline-only wording; a cap-less legacy spec still gets the note.
    const inlineOnly = reviewContextSection({
      review_of: 41,
      code_files: [{ path: 'sweeps/sieve.py', bytes: 128 }],
    });
    expect(inlineOnly).toContain('publish did not complete');
    expect(inlineOnly).not.toContain('capped at');

    // No code fields → exactly the old behaviour (nothing about code).
    expect(reviewContextSection({ review_of: 41, reviewed_max_cost_cents: 40 })).not.toContain(
      'ships code',
    );
  });

  it('isReviewTask keys on spec.review_of presence alone', () => {
    expect(isReviewTask({ review_of: 41 })).toBe(true);
    expect(isReviewTask({ review_of: 0 })).toBe(true); // any non-null id counts
    expect(isReviewTask({ prompt: 'p' })).toBe(false);
    expect(isReviewTask(undefined)).toBe(false);
  });

  it('non-review tasks still get their own computed DECOMPOSITION LIMITS (unchanged)', async () => {
    const { box, run } = capture();
    await new ClaudeCliExecutor({ run }).execute({ ...task, max_cost_cents: 80 });
    expect(box.input).toContain('DECOMPOSITION LIMITS for THIS task');
    expect(box.input).toContain("at most 160 (2x this task's 80¢ cap)");
    expect(box.input).not.toContain('REVIEW CONTEXT');
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
