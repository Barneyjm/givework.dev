import { describe, it, expect } from 'vitest';
import {
  StubExecutor,
  ClaudeCliExecutor,
  getExecutor,
  usageToCents,
  type ExecTask,
} from '../src/executor.js';

const task: ExecTask = {
  task_id: 't1',
  title: 'Summarize',
  model: 'claude-sonnet-4-6',
  max_cost_cents: 200,
  spec: { prompt: 'summarize this', output_schema: { summary: 'string' }, acceptance: 'a summary' },
};

describe('usageToCents', () => {
  it('meters input+output tokens into rounded-up cents per model pricing', () => {
    // sonnet: $3/$15 per 1M → 0.0003 / 0.0015 cents per token
    expect(usageToCents('claude-sonnet-4-6', { input_tokens: 100_000, output_tokens: 5_000 })).toBe(38); // 30 + 7.5
    // opus: $5/$25
    expect(usageToCents('claude-opus-4-8', { input_tokens: 100_000, output_tokens: 5_000 })).toBe(63); // 50 + 12.5
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
    const run = cliReply({ result: '{"summary":"done"}', total_cost_usd: 0.0123, usage: { output_tokens: 50 }, duration_ms: 900 });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.result).toEqual({ summary: 'done' });
    expect(r.actual_cost_cents).toBe(2); // ceil(0.0123 * 100)
    expect((r.raw_usage as any).total_cost_usd).toBe(0.0123);
  });

  it('passes -p/--output-format json/--model + a --json-schema built from output_schema, prompt on stdin', async () => {
    let seenArgs: string[] = [];
    let seenInput = '';
    const run = async (args: string[], input: string) => {
      seenArgs = args;
      seenInput = input;
      return JSON.stringify({ result: '{}', total_cost_usd: 0 });
    };
    await new ClaudeCliExecutor({ run }).execute(task);
    expect(seenArgs.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--model', 'claude-sonnet-4-6']);
    const i = seenArgs.indexOf('--json-schema');
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(seenArgs[i + 1])).toEqual({
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    });
    expect(seenInput).toContain('summarize this'); // the task prompt reached the CLI
  });

  it('tolerates a markdown ```json fence in the CLI result (the real claude -p wart)', async () => {
    const run = cliReply({ result: '```json\n{"response":"pong"}\n```', total_cost_usd: 0 });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.result).toEqual({ response: 'pong' });
  });

  it('omits --json-schema when the task has no output_schema', async () => {
    let seenArgs: string[] = [];
    const run = async (args: string[]) => {
      seenArgs = args;
      return JSON.stringify({ result: '{}', total_cost_usd: 0 });
    };
    await new ClaudeCliExecutor({ run }).execute({ ...task, spec: { prompt: 'x' } });
    expect(seenArgs).not.toContain('--json-schema');
  });

  it('falls back to token metering when total_cost_usd is absent', async () => {
    const run = cliReply({ result: '{}', usage: { input_tokens: 100_000, output_tokens: 5_000 } });
    const r = await new ClaudeCliExecutor({ run }).execute(task);
    expect(r.actual_cost_cents).toBe(38); // same as the API metering path
  });

  it('throws on an error result (no fabricated output)', async () => {
    const run = cliReply({ is_error: true, result: 'usage limit reached' });
    await expect(new ClaudeCliExecutor({ run }).execute(task)).rejects.toThrow('usage limit reached');
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

  it('getExecutor defaults to the stub', () => {
    const prev = process.env.EXECUTOR;
    delete process.env.EXECUTOR;
    expect(getExecutor()).toBeInstanceOf(StubExecutor);
    expect(getExecutor.length).toBe(0);
    if (prev !== undefined) process.env.EXECUTOR = prev;
  });
});
