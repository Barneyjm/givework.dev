import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getExecutor } from './executor.js';

// The dev runner — a volunteer's local loop: find an affordable open task, check
// it out, do the work on their own credit, submit the result, repeat.
//
// Two transports (see Backend below):
//   • HTTP   — talks to the deployed platform's REST API with just a dev token.
//              This is the production path: the volunteer needs GIVEWORK_API_URL
//              + GIVEWORK_TOKEN and never sees the database.
//   • MCP    — spawns src/mcp.ts over stdio, co-located with the DB. Local dev
//              only (it needs DATABASE_URL, which volunteers must never have).
// HTTP is selected automatically when GIVEWORK_API_URL (or --url) is set.

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
interface SubmitResult {
  spent_applied: number;
}
interface SubmitArgs {
  task_id: string;
  result: unknown;
  actual_cost_cents: number;
  raw_usage: unknown;
}

/** A tool/op error surfaced by the platform (e.g. task_not_open, insufficient_budget, no_budget). */
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

// The runner is transport-agnostic: it drives a Backend that exposes the five
// dev operations. Both transports normalize platform errors to ToolError(code),
// so the loop's race/budget handling is identical regardless of transport.
interface ApiVersion {
  service: string;
  commit: string;
  ref: string;
  deployed_at: string | null;
}

interface Backend {
  readonly kind: string;
  /** Control-plane build info, if the transport exposes it (HTTP only). */
  version?(): Promise<ApiVersion>;
  getBudget(): Promise<Budget>;
  listOpenTasks(args: { max_cost_cents?: number; limit?: number; sensitivity?: string }): Promise<OpenTask[]>;
  checkout(taskId: string): Promise<CheckoutResult>;
  submit(args: SubmitArgs): Promise<SubmitResult>;
  release(taskId: string): Promise<void>;
  close(): Promise<void>;
}

/** Production transport: the platform's REST API, authenticated with a dev token. */
class HttpBackend implements Backend {
  readonly kind = 'http';
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    // A crashed server or an intermediary (e.g. a 502 HTML page) returns
    // non-JSON; don't let JSON.parse throw a raw SyntaxError and kill the runner.
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ToolError(`http_${res.status}`, text.slice(0, 300));
      }
    }
    // The REST API returns { error, message } with a 4xx for OpErrors; mirror
    // that into ToolError(code) so the loop sees the same codes as over MCP.
    if (!res.ok) {
      throw new ToolError(payload?.error ?? `http_${res.status}`, payload?.message ?? text);
    }
    return payload as T;
  }

  version() {
    return this.req<ApiVersion>('GET', '/version');
  }
  getBudget() {
    return this.req<Budget>('GET', '/budget');
  }
  listOpenTasks(args: { max_cost_cents?: number; limit?: number; sensitivity?: string }) {
    const qs = new URLSearchParams();
    if (args.max_cost_cents != null) qs.set('max_cost_cents', String(args.max_cost_cents));
    if (args.limit != null) qs.set('limit', String(args.limit));
    if (args.sensitivity) qs.set('sensitivity', args.sensitivity);
    const q = qs.toString();
    return this.req<OpenTask[]>('GET', '/tasks/open' + (q ? `?${q}` : ''));
  }
  checkout(taskId: string) {
    return this.req<CheckoutResult>('POST', '/checkout', { task_id: taskId });
  }
  submit(args: SubmitArgs) {
    return this.req<SubmitResult>('POST', '/submit', args);
  }
  async release(taskId: string) {
    await this.req('POST', '/release', { task_id: taskId });
  }
  async close() {}
}

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
      console.log(`Control plane: ${v.commit.slice(0, 8)} (${v.ref})${v.deployed_at ? `, deployed ${v.deployed_at}` : ''}`);
    } catch {
      console.log('Control plane: version unknown (API predates /version).');
    }
    return backend;
  }
  console.log('Using local MCP backend (no GIVEWORK_API_URL set).');
  return McpBackend.connect();
}

// The actual inference is delegated to an Executor (src/executor.ts): the
// StubExecutor by default, or a real Claude call on the volunteer's own credit
// with EXECUTOR=claude. The runner just orchestrates checkout → execute → submit.
const executor = getExecutor();

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

  let done = 0;
  // Tasks whose execution failed this run — don't re-check-out a task we just
  // released after a failure, or we'd hot-loop on it forever.
  const failed = new Set<string>();
  let consecutiveFailures = 0;
  // Consistent execution failure means a config/auth problem (bad or missing
  // credential), not a transient task issue — bail instead of firehosing.
  const MAX_CONSECUTIVE_FAILURES = 3;

  try {
    while (done < maxTasks) {
      let budget: Budget;
      try {
        budget = await backend.getBudget();
      } catch (err) {
        if (err instanceof ToolError && err.code === 'no_budget') {
          console.log('No budget for the current period. Stopping.');
          break;
        }
        throw err;
      }
      if (budget.available_cents <= 0) {
        console.log(`Budget exhausted (available ${budget.available_cents}¢). Stopping.`);
        break;
      }

      const open = await backend.listOpenTasks({
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

      // Take the oldest affordable task we haven't already failed on this run.
      const pick = open.find((t) => !failed.has(t.id));
      if (!pick) {
        console.log('No new affordable tasks to attempt. Done.');
        break;
      }
      let checkout: CheckoutResult;
      try {
        checkout = await backend.checkout(pick.id);
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

      // Run the work. If execution fails (e.g. the real Claude call errors), do
      // NOT submit — release the task so another volunteer can pick it up.
      // Submitting fabricated output would corrupt the ledger and the deliverable.
      let exec;
      try {
        exec = await executor.execute(checkout);
      } catch (err) {
        console.error(`  ✗ execution failed for ${checkout.task_id.slice(0, 8)}: ${(err as Error).message} — releasing`);
        await backend.release(checkout.task_id).catch(() => {});
        failed.add(checkout.task_id);
        consecutiveFailures++;
        if (hasFlag('--stop-on-error') || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `Aborting after ${consecutiveFailures} consecutive execution failure(s) — likely a config/credential problem, not a task issue.`,
          );
          break;
        }
        continue;
      }
      consecutiveFailures = 0;

      const submit = await backend.submit({
        task_id: checkout.task_id,
        result: exec.result,
        actual_cost_cents: exec.actual_cost_cents,
        raw_usage: exec.raw_usage,
      });
      console.log(`✔ submitted ${checkout.task_id.slice(0, 8)} — spent ${submit.spent_applied}¢`);
      done++;
    }
  } finally {
    const b = await backend.getBudget().catch(() => null);
    if (b) {
      console.log(
        `\nDone. Completed ${done} task(s). Budget: spent ${b.spent_cents}¢, available ${b.available_cents}¢ of ${b.budget_cents}¢.`,
      );
    }
    await backend.close();
  }
}

main().catch((err) => {
  console.error('Runner failed:', err.message ?? err);
  process.exit(1);
});
