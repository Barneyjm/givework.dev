import { withTransaction, query, type Client } from '../db.js';
import { OpError } from '../operations.js';
import { decomposer, type ProposedTask } from './decompose.js';

// Intake pipeline operations, HTTP-free (same convention as src/operations.ts).
// receive -> decompose (auto) -> [admin review] -> publish -> normal tasks.

export interface ReceiveInput {
  from_email: string;
  subject?: string;
  body: string;
  attachments?: { uri: string; filename?: string; content_type?: string }[];
}

/**
 * Find-or-create a provisional (unverified) nonprofit for an inbound sender, so
 * repeated emails from one address map to one org. Promotion to verified +
 * EIN check is later (intake never trusts the sender's identity).
 */
async function findOrCreateProvisionalNonprofit(
  client: Client,
  fromEmail: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM nonprofits WHERE contact_email = $1 ORDER BY created_at ASC LIMIT 1`,
    [fromEmail],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await client.query<{ id: string }>(
    `INSERT INTO nonprofits (name, contact_email, verified)
     VALUES ($1, $2, false) RETURNING id`,
    [`Pending (${fromEmail})`, fromEmail],
  );
  return created.rows[0].id;
}

export async function receiveIntake(input: ReceiveInput) {
  if (!input.from_email || !input.body) {
    throw new OpError(400, 'bad_input', 'from_email and body are required');
  }
  return withTransaction(async (client) => {
    const nonprofitId = await findOrCreateProvisionalNonprofit(client, input.from_email);

    const ins = await client.query<{ id: string }>(
      `INSERT INTO intake_requests (from_email, subject, raw_body, nonprofit_id, status)
       VALUES ($1, $2, $3, $4, 'received') RETURNING id`,
      [input.from_email, input.subject ?? null, input.body, nonprofitId],
    );
    const intakeId = ins.rows[0].id;

    for (const a of input.attachments ?? []) {
      await client.query(
        `INSERT INTO intake_attachments (intake_request_id, uri, filename, content_type)
         VALUES ($1, $2, $3, $4)`,
        [intakeId, a.uri, a.filename ?? null, a.content_type ?? null],
      );
    }

    // Auto-draft a decomposition so the caller gets proposed tasks immediately.
    const proposed = await decomposer.decompose({
      from_email: input.from_email,
      subject: input.subject,
      body: input.body,
      attachment_count: input.attachments?.length ?? 0,
    });

    await client.query(
      `UPDATE intake_requests
          SET proposed = $2, status = 'decomposed', triaged_by = 'ai', updated_at = now()
        WHERE id = $1`,
      [intakeId, JSON.stringify(proposed)],
    );

    return { intake_id: intakeId, nonprofit_id: nonprofitId, status: 'decomposed', proposed };
  });
}

/** Re-run the decomposer on a request, replacing the draft. */
export async function redecompose(intakeId: string) {
  return withTransaction(async (client) => {
    const r = await client.query(
      `SELECT from_email, subject, raw_body, status FROM intake_requests WHERE id = $1 FOR UPDATE`,
      [intakeId],
    );
    const row = r.rows[0];
    if (!row) throw new OpError(404, 'intake_not_found', 'Unknown intake request');
    if (row.status === 'published') {
      throw new OpError(409, 'already_published', 'Cannot re-decompose a published request');
    }
    const { rows: att } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM intake_attachments WHERE intake_request_id = $1`,
      [intakeId],
    );
    const proposed = await decomposer.decompose({
      from_email: row.from_email,
      subject: row.subject ?? undefined,
      body: row.raw_body,
      attachment_count: Number(att[0].n),
    });
    await client.query(
      `UPDATE intake_requests SET proposed = $2, status = 'decomposed', updated_at = now() WHERE id = $1`,
      [intakeId, JSON.stringify(proposed)],
    );
    return { intake_id: intakeId, status: 'decomposed', proposed };
  });
}

/**
 * Publish a request: insert the proposed (or reviewer-edited) tasks as real,
 * open tasks linked back to the intake request. The reviewer is `authoredBy`.
 */
export async function publishIntake(
  intakeId: string,
  tasksOverride: ProposedTask[] | undefined,
  authoredBy: string,
) {
  return withTransaction(async (client) => {
    const r = await client.query<{
      status: string;
      nonprofit_id: string;
      proposed: ProposedTask[] | null;
    }>(
      `SELECT status, nonprofit_id, proposed FROM intake_requests WHERE id = $1 FOR UPDATE`,
      [intakeId],
    );
    const row = r.rows[0];
    if (!row) throw new OpError(404, 'intake_not_found', 'Unknown intake request');
    if (row.status === 'published') {
      throw new OpError(409, 'already_published', 'Request already published');
    }

    const tasks = tasksOverride ?? row.proposed ?? [];
    if (tasks.length === 0) {
      throw new OpError(400, 'nothing_to_publish', 'No proposed tasks to publish');
    }

    const created: string[] = [];
    for (const t of tasks) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO tasks
           (nonprofit_id, title, spec, est_cost_cents, max_cost_cents, model, sensitivity,
            intake_request_id, authored_by)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::data_sensitivity,'public'), $8, $9)
         RETURNING id`,
        [
          row.nonprofit_id,
          t.title,
          JSON.stringify(t.spec),
          t.est_cost_cents,
          t.max_cost_cents,
          t.model,
          t.sensitivity ?? null,
          intakeId,
          authoredBy,
        ],
      );
      created.push(ins.rows[0].id);
    }

    await client.query(
      `UPDATE intake_requests SET status = 'published', updated_at = now() WHERE id = $1`,
      [intakeId],
    );

    return { intake_id: intakeId, status: 'published', task_ids: created };
  });
}

export async function rejectIntake(intakeId: string) {
  return withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE intake_requests SET status = 'rejected', updated_at = now()
        WHERE id = $1 AND status <> 'published' RETURNING id`,
      [intakeId],
    );
    if (upd.rowCount === 0) {
      throw new OpError(409, 'cannot_reject', 'Unknown request, or already published');
    }
    return { intake_id: intakeId, status: 'rejected' };
  });
}

export async function listIntake(status?: string) {
  const params: unknown[] = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE status = $1`;
  }
  const { rows } = await query(
    `SELECT id, from_email, subject, status, nonprofit_id, triaged_by, created_at,
            jsonb_array_length(COALESCE(proposed, '[]'::jsonb)) AS proposed_count
       FROM intake_requests ${where}
      ORDER BY created_at DESC LIMIT 50`,
    params,
  );
  return rows;
}

export async function getIntake(intakeId: string) {
  const { rows } = await query(
    `SELECT * FROM intake_requests WHERE id = $1`,
    [intakeId],
  );
  if (!rows[0]) throw new OpError(404, 'intake_not_found', 'Unknown intake request');
  const { rows: attachments } = await query(
    `SELECT id, uri, filename, content_type FROM intake_attachments WHERE intake_request_id = $1`,
    [intakeId],
  );
  return { ...rows[0], attachments };
}
