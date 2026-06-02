import { describe, it, expect } from 'vitest';
import {
  StubExecutor,
  ClaudeExecutor,
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

/** Fake OpenAI-shaped... no — fake Anthropic messages client. */
function fakeClient(text: string, usage: any) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (body: any) => {
          calls.push(body);
          return { content: [{ type: 'text', text }], usage };
        },
      },
    },
  };
}

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

describe('ClaudeExecutor', () => {
  it('parses JSON output and meters cost from usage', async () => {
    const f = fakeClient('{"summary":"done"}', { input_tokens: 100_000, output_tokens: 5_000 });
    const r = await new ClaudeExecutor({ client: f.client }).execute(task);
    expect(r.result).toEqual({ summary: 'done' });
    expect(r.actual_cost_cents).toBe(38);
    expect((r.raw_usage as any).model).toBe('claude-sonnet-4-6');
  });

  it('keeps raw text when the model does not return clean JSON', async () => {
    const f = fakeClient('here is your summary', { input_tokens: 10, output_tokens: 10 });
    const r = await new ClaudeExecutor({ client: f.client }).execute(task);
    expect(r.result).toEqual({ output: 'here is your summary' });
  });

  it('caches the system prompt and bounds max_tokens by the cap', async () => {
    const f = fakeClient('{}', { input_tokens: 1, output_tokens: 1 });
    await new ClaudeExecutor({ client: f.client }).execute({ ...task, max_cost_cents: 200 });
    const body = f.calls[0];
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    // 200¢ at sonnet output rate (0.0015¢/tok) = 133k tokens, clamped to the 4096 ceiling.
    expect(body.max_tokens).toBe(4096);
  });

  it('clamps an unknown model to the default', async () => {
    const f = fakeClient('{}', { input_tokens: 1, output_tokens: 1 });
    await new ClaudeExecutor({ client: f.client }).execute({ ...task, model: 'gpt-4' });
    expect(f.calls[0].model).toBe('claude-sonnet-4-6');
  });

  it('propagates errors (no silent stub fallback — caller must release the task)', async () => {
    const client = {
      messages: { create: async () => { throw new Error('401 no credit'); } },
    };
    await expect(new ClaudeExecutor({ client }).execute(task)).rejects.toThrow('401 no credit');
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
