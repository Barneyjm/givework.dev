import { describe, expect, it } from 'vitest';
import {
  ClaudeCliExecutor,
  coerceResult,
  type ExecTask,
  getExecutor,
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

  it('passes -p/--output-format json/--model, prompt+shape on stdin, and never --json-schema', async () => {
    let seenArgs: string[] = [];
    let seenInput = '';
    const run = async (args: string[], input: string) => {
      seenArgs = args;
      seenInput = input;
      return JSON.stringify({ result: '{"summary":"ok"}', total_cost_usd: 0 });
    };
    await new ClaudeCliExecutor({ run }).execute(task);
    expect(seenArgs).toEqual(['-p', '--output-format', 'json', '--model', 'claude-sonnet-4-6']);
    // --json-schema makes claude -p bill but return an empty result; we steer via
    // the prompt instead, so the flag must never be sent.
    expect(seenArgs).not.toContain('--json-schema');
    expect(seenInput).toContain('summarize this'); // the task prompt reached the CLI
    expect(seenInput).toContain('Output shape'); // the shape is conveyed in-prompt
  });

  it('tolerates a markdown ```json fence in the CLI result (the real claude -p wart)', async () => {
    const run = cliReply({ result: '```json\n{"response":"pong"}\n```', total_cost_usd: 0 });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.result).toEqual({ response: 'pong' });
  });

  it('throws on an empty result (release, do not submit a blank deliverable)', async () => {
    const run = cliReply({ result: '', total_cost_usd: 0.12 });
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

  it('throws on non-JSON CLI output', async () => {
    const run = async () => 'not json at all';
    await expect(new ClaudeCliExecutor({ run }).execute(task)).rejects.toThrow('non-JSON');
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
