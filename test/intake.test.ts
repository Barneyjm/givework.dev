import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, createDev, setBudget, setVerified } from './helpers.js';
import { pool, closePool } from '../src/db.js';
import { receiveIntake, publishIntake, getIntake, listIntake } from '../src/intake/operations.js';
import { StubDecomposer, LocalLLMDecomposer, CliDecomposer, extractTasks } from '../src/intake/decompose.js';
import { checkoutTask } from '../src/operations.js';

afterAll(closePool);
beforeEach(resetDb);

describe('receive', () => {
  it('creates a provisional nonprofit, stores the request, and auto-drafts tasks', async () => {
    const r = await receiveIntake({
      from_email: 'director@shelter.org',
      subject: 'Need help',
      body: 'Please categorize 50 client intake forms by primary need.',
    });

    expect(r.status).toBe('decomposed');
    expect(r.proposed.length).toBeGreaterThan(0);
    // 50 forms / 10 per task = 5 tasks.
    expect(r.proposed.length).toBe(5);
    // Inbound defaults to sensitive.
    expect(r.proposed.every((t) => t.sensitivity === 'sensitive')).toBe(true);

    const np = await pool.query(`SELECT verified FROM nonprofits WHERE id = $1`, [r.nonprofit_id]);
    expect(np.rows[0].verified).toBe(false); // provisional

    const full = await getIntake(r.intake_id);
    expect(full.triaged_by).toBe('stub'); // default decomposer; honestly recorded
    expect(full.from_email).toBe('director@shelter.org');
  });

  it('reuses the same provisional nonprofit for repeat emails from one sender', async () => {
    const a = await receiveIntake({ from_email: 'x@org.org', body: 'first ask' });
    const b = await receiveIntake({ from_email: 'x@org.org', body: 'second ask' });
    expect(a.nonprofit_id).toBe(b.nonprofit_id);
  });

  it('maps a bad caller-supplied nonprofit_id to a clean 400, not a 500', async () => {
    // The admin manual path can pass nonprofit_id directly; a stale/typo'd value
    // must surface as bad_input rather than an unhandled FK/UUID error.
    await expect(
      receiveIntake({ from_email: 'x@org.org', body: 'hi', nonprofit_id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_nonprofit_id' });
    await expect(
      receiveIntake({
        from_email: 'x@org.org',
        body: 'hi',
        nonprofit_id: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_nonprofit_id' });
  });
});

describe('publish', () => {
  it('turns proposed tasks into real, open, checkout-able tasks linked to the intake', async () => {
    const r = await receiveIntake({
      from_email: 'ops@np.org',
      body: 'Summarize our annual report into a one-page brief.',
    });
    const pub = await publishIntake(r.intake_id, undefined, 'admin');
    expect(pub.status).toBe('published');
    expect(pub.task_ids.length).toBe(r.proposed.length);

    const t = await pool.query(
      `SELECT status, intake_request_id, authored_by, sensitivity FROM tasks WHERE id = $1`,
      [pub.task_ids[0]],
    );
    expect(t.rows[0].status).toBe('open');
    expect(t.rows[0].intake_request_id).toBe(r.intake_id);
    expect(t.rows[0].authored_by).toBe('admin');

    // End-to-end: a funded dev can check the published task out through the ledger
    // core. Intake-decomposed tasks default to sensitivity='sensitive' (intake
    // often carries personal data), so the dev must be verified to claim it.
    const dev = await createDev('alice');
    await setBudget(dev, 5000);
    await setVerified(dev);
    const co = await checkoutTask(dev, pub.task_ids[0]);
    expect(co.task_id).toBe(pub.task_ids[0]);
  });

  it('publishing twice is a 409', async () => {
    const r = await receiveIntake({ from_email: 'a@b.org', body: 'do a thing' });
    await publishIntake(r.intake_id, undefined, 'admin');
    await expect(publishIntake(r.intake_id, undefined, 'admin')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('lists requests by status', async () => {
    await receiveIntake({ from_email: 'a@b.org', body: 'one' });
    const open = await listIntake('decomposed');
    expect(open.length).toBe(1);
    expect(Number(open[0].proposed_count)).toBeGreaterThan(0);
  });
});

describe('StubDecomposer sizing', () => {
  const d = new StubDecomposer();

  it('splits a quantity into batches of 10 and reports triagedBy stub', async () => {
    const { tasks, triagedBy } = await d.decompose({ from_email: 'x', body: 'tag 23 emails', attachment_count: 0 });
    expect(tasks.length).toBe(3); // 10 + 10 + 3
    expect(tasks[2].spec.unit_count).toBe(3);
    expect(triagedBy).toBe('stub');
  });

  it('makes a single task when there is no quantity', async () => {
    const { tasks } = await d.decompose({ from_email: 'x', body: 'write a thank-you note', attachment_count: 0 });
    expect(tasks.length).toBe(1);
    expect(tasks[0].spec.unit_count).toBe(1);
  });

  it('caps the number of tasks for huge quantities', async () => {
    const { tasks } = await d.decompose({ from_email: 'x', body: 'process 100000 records', attachment_count: 0 });
    expect(tasks.length).toBeLessThanOrEqual(20);
  });
});

describe('LocalLLMDecomposer', () => {
  const input = { from_email: 'x@y.org', body: 'summarize a report', attachment_count: 0 };
  // Build a fake OpenAI-compatible response whose message.content is `json`.
  const reply = (json: string): any => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: json } }] }),
  });

  it('parses a well-formed model response and enforces every invariant', async () => {
    const fetchFn = (async () =>
      reply(
        JSON.stringify({
          tasks: [
            // deliberately messy: max < est, bad model, bad sensitivity, float cents
            { title: 'T', spec: { prompt: 'do it', unit_count: 3.7 }, est_cost_cents: 200.5, max_cost_cents: 50, model: 'gpt-4', sensitivity: 'spicy' },
          ],
        }),
      )) as unknown as typeof fetch;

    const { tasks, triagedBy } = await new LocalLLMDecomposer({ fetchFn }).decompose(input);
    expect(tasks).toHaveLength(1);
    expect(triagedBy).toBe('local'); // genuine model success
    const t = tasks[0];
    expect(t.max_cost_cents).toBeGreaterThanOrEqual(t.est_cost_cents); // clamped
    expect(t.est_cost_cents).toBe(201); // rounded int
    expect(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']).toContain(t.model);
    expect(t.sensitivity).toBe('sensitive'); // invalid -> safe default
    expect(t.spec.unit_count).toBe(4); // rounded int
  });

  it('falls back to the stub when the endpoint is unreachable (reports stub, not local)', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { tasks, triagedBy } = await new LocalLLMDecomposer({ fetchFn }).decompose(input);
    expect(tasks.length).toBeGreaterThan(0); // stub still produced a task
    expect(triagedBy).toBe('stub'); // honest: no model actually ran
  });

  it('falls back when the model returns no usable tasks', async () => {
    const fetchFn = (async () => reply(JSON.stringify({ tasks: [] }))) as unknown as typeof fetch;
    const { tasks, triagedBy } = await new LocalLLMDecomposer({ fetchFn }).decompose(input);
    expect(tasks.length).toBeGreaterThan(0);
    expect(triagedBy).toBe('stub');
  });
});

describe('extractTasks (tolerant JSON extraction)', () => {
  const one = [{ title: 'T', spec: { prompt: 'do it', unit_count: 1 }, est_cost_cents: 50, max_cost_cents: 75, model: 'x', sensitivity: 'public' }];
  it('reads a bare array, {tasks:[…]}, fenced JSON, and the claude -p wrapper', () => {
    expect(extractTasks(JSON.stringify(one))).toHaveLength(1);
    expect(extractTasks(JSON.stringify({ tasks: one }))).toHaveLength(1);
    expect(extractTasks('Here you go:\n```json\n' + JSON.stringify({ tasks: one }) + '\n```\nthanks')).toHaveLength(1);
    // claude -p --output-format json: real content nested in `.result`.
    expect(extractTasks(JSON.stringify({ type: 'result', result: JSON.stringify({ tasks: one }) }))).toHaveLength(1);
  });
  it('tolerates raw control chars inside strings (common in local-model output)', () => {
    // A literal newline inside a string value — invalid JSON until escaped.
    const dirty = '{"tasks":[{"title":"T","spec":{"prompt":"line one\nline two"}}]}';
    const out = extractTasks(dirty) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].spec.prompt).toBe('line one\nline two');
  });
  it('throws when there is no JSON', () => {
    expect(() => extractTasks('the model said no')).toThrow();
  });
});

describe('CliDecomposer', () => {
  const input = { from_email: 'x@y.org', body: 'summarize a report', attachment_count: 0 };
  const goodTask = { title: 'Summarize', spec: { prompt: 'summarize the report', unit_count: 1 }, est_cost_cents: 50, max_cost_cents: 75, model: 'claude-sonnet-4-6', sensitivity: 'sensitive' };

  it('runs the CLI, parses fenced output, and reports triagedBy local', async () => {
    const run = async () => '```json\n' + JSON.stringify({ tasks: [goodTask] }) + '\n```';
    const { tasks, triagedBy } = await new CliDecomposer({ run }).decompose(input);
    expect(tasks).toHaveLength(1);
    expect(triagedBy).toBe('local');
    expect(tasks[0].spec.prompt).toContain('summarize');
  });

  it('passes the prompt on stdin to the configured cmd/args', async () => {
    let seen: { cmd: string; args: string[]; input: string } | null = null;
    const run = async (cmd: string, args: string[], inp: string) => {
      seen = { cmd, args, input: inp };
      return JSON.stringify({ tasks: [goodTask] });
    };
    await new CliDecomposer({ cmd: 'ollama', args: ['run', 'm'], run }).decompose(input);
    expect(seen!.cmd).toBe('ollama');
    expect(seen!.args).toEqual(['run', 'm']);
    expect(seen!.input).toContain('summarize a report'); // the request body reached the model
  });

  it('falls back to the stub when the CLI errors or returns junk', async () => {
    const boom = async () => { throw new Error('command not found: ollama'); };
    expect((await new CliDecomposer({ run: boom }).decompose(input)).triagedBy).toBe('stub');
    const junk = async () => 'I could not do that';
    const r = await new CliDecomposer({ run: junk }).decompose(input);
    expect(r.triagedBy).toBe('stub');
    expect(r.tasks.length).toBeGreaterThan(0);
  });
});
