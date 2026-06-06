import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getExecutor } from './executor.js';
import {
  type Backend,
  type Budget,
  type CheckoutResult,
  HttpBackend,
  type OpenTask,
  runLoop,
  type SubmitArgs,
  type SubmitResult,
  ToolError,
} from './run-loop.js';

// The dev runner — a volunteer's local loop. The transport-agnostic core (the
// Backend interface, the HTTP transport, and the work loop) lives in
// src/run-loop.ts and is shared with the bundled CLI. This file adds the things
// the CLI does NOT want: the local-dev MCP backend (which needs the DB) and the
// transport-selection / flag-parsing entrypoint.
//
// Two transports:
//   • HTTP — the deployed REST API with just a dev token (production path).
//   • MCP  — spawns src/mcp.ts over stdio, co-located with the DB (local dev only;
//            it needs DATABASE_URL, which volunteers must never have).
// HTTP is selected automatically when GIVEWORK_API_URL (or --url) is set.

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const hasFlag = (name: string) => process.argv.includes(name);

/** Local-dev transport: the MCP server over stdio, co-located with the database. */
class McpBackend implements Backend {
  readonly kind = 'mcp';
  private constructor(private readonly client: Client) {}

  static async connect(): Promise<McpBackend> {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp.ts'],
      env: process.env as Record<string, string>,
    });
    const client = new Client({ name: 'givework-runner', version: '0.4.0' });
    await client.connect(transport);
    return new McpBackend(client);
  }

  /** Call a tool, parse its JSON payload, and raise ToolError on a tool-level error. */
  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = (res.content as any)?.[0]?.text ?? 'null';
    const payload = JSON.parse(text);
    if (res.isError) {
      throw new ToolError(payload.error ?? 'tool_error', payload.message ?? text);
    }
    return payload as T;
  }

  async getBudget() {
    // The MCP tool returns { error: 'no_budget' } as a non-error payload; the
    // HTTP API returns a 404. Normalize to a ToolError so the loop is uniform.
    const b = await this.call<Budget & { error?: string }>('get_budget');
    if (b?.error === 'no_budget') throw new ToolError('no_budget', 'No budget for current period');
    return b;
  }
  listOpenTasks(args: { max_cost_cents?: number; limit?: number; sensitivity?: string }) {
    return this.call<OpenTask[]>('list_open_tasks', args);
  }
  checkout(taskId: string) {
    return this.call<CheckoutResult>('checkout_task', { task_id: taskId });
  }
  submit(args: SubmitArgs) {
    return this.call<SubmitResult>('submit_result', args as unknown as Record<string, unknown>);
  }
  async release(taskId: string) {
    await this.call('release_task', { task_id: taskId });
  }
  async close() {
    await this.client.close();
  }
}

/** Pick a transport: HTTP when an API URL is configured, otherwise local MCP. */
async function createBackend(token: string): Promise<Backend> {
  const apiUrl = flag('--url') ?? process.env.GIVEWORK_API_URL;
  if (apiUrl) {
    console.log(`Using HTTP backend → ${apiUrl}`);
    const backend = new HttpBackend(apiUrl, token);
    // Report which control-plane build we're talking to, so volunteers can see an
    // update landed. Best-effort: an old API without /version shouldn't block work.
    try {
      const v = await backend.version();
      console.log(
        `Control plane: ${v.commit.slice(0, 8)} (${v.ref})${v.deployed_at ? `, deployed ${v.deployed_at}` : ''}`,
      );
    } catch {
      console.log('Control plane: version unknown (API predates /version).');
    }
    return backend;
  }
  console.log('Using local MCP backend (no GIVEWORK_API_URL set).');
  return McpBackend.connect();
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

  const backend = await createBackend(token);
  try {
    await runLoop(backend, getExecutor(), {
      maxTasks,
      watch,
      intervalMs,
      stopOnError: hasFlag('--stop-on-error'),
    });
  } finally {
    await backend.close();
  }
}

main().catch((err) => {
  console.error('Runner failed:', err.message ?? err);
  process.exit(1);
});
