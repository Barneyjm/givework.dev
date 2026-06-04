import Anthropic from '@anthropic-ai/sdk';
import {
  type Executor,
  type ExecTask,
  type ExecResult,
  type Usage,
  PRICING,
  DEFAULT_MODEL,
  centsPerToken,
  pricingFor,
  coerceResult,
  usageToCents,
} from './executor.js';

// Reference Anthropic SDK executor (EXECUTOR=claude-api). This is the ONLY module
// that imports @anthropic-ai/sdk — kept separate from executor.ts so the runner
// and the published CLI (which use the `claude -p` path) never pull the SDK into
// their bundle. getExecutor() in executor.ts lazy-imports this on demand.

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

    const result = coerceResult(text);

    const usage: Usage = message.usage ?? {};
    return {
      result,
      actual_cost_cents: usageToCents(model, usage),
      raw_usage: { model, ...usage },
    };
  }
}
