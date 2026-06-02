import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The dev runner — Stage 3. A volunteer's local loop: connect to the givework
// MCP server (which acts as this dev via GIVEWORK_TOKEN), find an affordable
// open task, check it out, do the work, submit the result, repeat.
//
// In production the MCP server is remote (the platform) and the runner connects
// over the network. Here it spawns the local stdio server next to the DB.
// STAGE 4: remote MCP transport.

interface OpenTask {
  id: string;
  title: string;
  max_cost_cents: number;
  model: string;
}
interface CheckoutResult {
  task_id: string;
  spec: any;
  title: string;
  model: string;
  max_cost_cents: number;
}
interface Budget {
  budget_cents: number;
  reserved_cents: number;
  spent_cents: number;
  available_cents: number;
}

/** A tool error surfaced by the MCP server (e.g. 409 task_not_open, 402 insufficient_budget). */
class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const hasFlag = (name: string) => process.argv.includes(name);

/**
 * Do the actual inference for a task. STAGE 4: replace this stub with a real
 * Anthropic Agent SDK call against the dev's own credit — read task.spec, run
 * the agent, and return what it produced plus the metered cost. Everything
 * around it (checkout, budget, submit, ledger) already works.
 */
function executeTask(task: CheckoutResult): {
  result: unknown;
  actual_cost_cents: number;
  raw_usage: unknown;
} {
  const prompt = task.spec?.prompt ?? task.title;
  console.log(`     … would call Claude here (model ${task.model}) on: "${prompt}"`);

  // Pretend the run used ~80% of the reserved cap.
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

async function main() {
  const token = process.env.GIVEWORK_TOKEN;
  if (!token) {
    console.error('GIVEWORK_TOKEN is not set — the runner needs a dev token.');
    process.exit(1);
  }

  const maxTasks = flag('--max') ? Number(flag('--max')) : hasFlag('--once') ? 1 : Infinity;
  const watch = hasFlag('--watch');
  const intervalMs = (flag('--interval') ? Number(flag('--interval')) : 15) * 1000;

  // Spawn the MCP server as a child over stdio, acting as this dev.
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp.ts'],
    env: process.env as Record<string, string>,
  });
  const client = new Client({ name: 'givework-runner', version: '0.3.0' });
  await client.connect(transport);

  /** Call a tool, parse its JSON payload, and raise ToolError on a tool-level error. */
  async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as any)?.[0]?.text ?? 'null';
    const payload = JSON.parse(text);
    if (res.isError) {
      throw new ToolError(payload.error ?? 'tool_error', payload.message ?? text);
    }
    return payload as T;
  }

  let done = 0;
  try {
    while (done < maxTasks) {
      const budget = await call<Budget>('get_budget');
      if (budget.available_cents <= 0) {
        console.log(`Budget exhausted (available ${budget.available_cents}¢). Stopping.`);
        break;
      }

      const open = await call<OpenTask[]>('list_open_tasks', {
        max_cost_cents: budget.available_cents,
        limit: 5,
      });

      if (open.length === 0) {
        if (watch) {
          console.log(`No affordable open tasks. Waiting ${intervalMs / 1000}s…`);
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        console.log('No affordable open tasks. Done.');
        break;
      }

      // Take the oldest affordable task.
      const pick = open[0];
      let checkout: CheckoutResult;
      try {
        checkout = await call<CheckoutResult>('checkout_task', { task_id: pick.id });
      } catch (err) {
        if (err instanceof ToolError && err.code === 'task_not_open') {
          // Lost the race — someone else grabbed it. Refresh and retry.
          console.log(`  ${pick.id.slice(0, 8)} taken by another runner, retrying…`);
          continue;
        }
        if (err instanceof ToolError && err.code === 'insufficient_budget') {
          console.log('  Not enough budget for the cheapest task. Stopping.');
          break;
        }
        throw err;
      }

      console.log(`▶ checked out ${checkout.task_id.slice(0, 8)} — "${checkout.title}" (cap ${checkout.max_cost_cents}¢)`);

      const { result, actual_cost_cents, raw_usage } = executeTask(checkout);

      const submit = await call('submit_result', {
        task_id: checkout.task_id,
        result,
        actual_cost_cents,
        raw_usage,
      });
      console.log(`✔ submitted ${checkout.task_id.slice(0, 8)} — spent ${submit.spent_applied}¢`);
      done++;
    }
  } finally {
    const b = await call<Budget>('get_budget').catch(() => null);
    if (b) {
      console.log(
        `\nDone. Completed ${done} task(s). Budget: spent ${b.spent_cents}¢, available ${b.available_cents}¢ of ${b.budget_cents}¢.`,
      );
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error('Runner failed:', err.message ?? err);
  process.exit(1);
});
