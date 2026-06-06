import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { verifyToken } from './auth.js';
import {
  checkoutTask,
  getBudget,
  listOpenTasks,
  OpError,
  releaseTask,
  submitResult,
} from './operations.js';

// MCP wrapper around the HTTP-free operations core. This is the rail the dev
// runner rides: it authenticates as one dev (GIVEWORK_TOKEN) and every tool acts
// as that dev. In-process / stdio — co-located with the DB (DATABASE_URL).
// STAGE 3: a remote transport so the runner can live on the dev's own machine.

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

/** Run an op, projecting OpError into a structured (non-throwing) tool error. */
async function run(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof OpError) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: err.code, message: err.message }),
          },
        ],
      };
    }
    throw err;
  }
}

async function main() {
  const token = process.env.GIVEWORK_TOKEN;
  if (!token) {
    console.error('GIVEWORK_TOKEN is not set — the MCP server needs a dev token to act as.');
    process.exit(1);
  }
  const principal = await verifyToken(token);
  if (principal.role !== 'dev' || !principal.dev_id) {
    console.error('GIVEWORK_TOKEN must be a dev token.');
    process.exit(1);
  }
  const devId = principal.dev_id;

  const server = new McpServer({ name: 'givework', version: '0.2.0' });

  server.registerTool(
    'list_open_tasks',
    {
      description: 'List open tasks you could pick up, oldest first.',
      inputSchema: {
        max_cost_cents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only tasks whose hard cap is <= this many cents.'),
        sensitivity: z.enum(['public', 'internal', 'sensitive']).optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    (args) =>
      run(() =>
        listOpenTasks({
          maxCostCents: args.max_cost_cents,
          sensitivity: args.sensitivity,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    'get_budget',
    {
      description: 'Your current-period budget: budget / reserved / spent / available cents.',
      inputSchema: {},
    },
    () => run(() => getBudget(devId).then((b) => b ?? { error: 'no_budget' })),
  );

  server.registerTool(
    'checkout_task',
    {
      description:
        'Claim an open task for 10 minutes and reserve its hard cap against your budget.',
      inputSchema: { task_id: z.string().uuid() },
    },
    (args) => run(() => checkoutTask(devId, args.task_id)),
  );

  server.registerTool(
    'submit_result',
    {
      description:
        'Submit a result for a task locked to you; moves the reservation to actual spend.',
      inputSchema: {
        task_id: z.string().uuid(),
        result: z.any().describe('The task output (any JSON).'),
        actual_cost_cents: z.number().int().nonnegative(),
        raw_usage: z.any().optional().describe('Provider token usage, stored on the ledger row.'),
      },
    },
    (args) =>
      run(() =>
        submitResult(
          devId,
          args.task_id,
          args.result ?? null,
          args.actual_cost_cents,
          args.raw_usage ?? null,
        ),
      ),
  );

  server.registerTool(
    'release_task',
    {
      description:
        'Abandon a task locked to you, returning it to the pool and freeing the reservation.',
      inputSchema: { task_id: z.string().uuid() },
    },
    (args) => run(() => releaseTask(devId, args.task_id)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`givework MCP server ready (acting as dev ${devId})`);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err.message);
  process.exit(1);
});
