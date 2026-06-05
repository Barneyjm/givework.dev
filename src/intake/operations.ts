import { withTransaction, query, type Client } from '../db.js';
import { OpError } from '../operations.js';
import { getDecomposer, normalizeTask, type ProposedTask } from './decompose.js';

// Intake pipeline operations, HTTP-free (same convention as src/operations.ts).
// receive -> decompose (auto) -> [admin review] -> publish -> normal tasks.

export interface ReceiveInput {
  from_email: string;
  subject?: string;
  body: string;
  attachments?: { uri: string; filename?: string; content_type?: string }[];
  /**
   * When set, attach the request to this existing nonprofit instead of
   * find-or-creating a provisional one. The inbound-email path passes the
   * pre-approved nonprofit it matched the sender to (see
   * findApprovedNonprofitForSender), so allowlisted mail lands on the real org.
   */
  nonprofit_id?: string;
}

// Consumer mailbox providers: a verified nonprofit whose contact is e.g.
// jane@gmail.com must NOT authorize the entire gmail.com domain. For these we
// fall back to exact-address matching only. Org domains authorize by domain.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
]);

/**
 * The allowlist gate for inbound email. Returns the id of a verified nonprofit
 * that authorizes this sender, else null. A sender is authorized by ANY allow
 * identifier — the legacy contact_email, an admin-added `email`, or a matching
 * `domain` (consumer-mailbox domains match by exact address only) — UNLESS the
 * address or its domain is explicitly denied (`email_deny` / `domain_deny`),
 * which overrides every allow. Intake never trusts an unrecognised sender; the
 * email handler rejects when this returns null, so spam and strangers never
 * reach the decomposer.
 */
export async function findApprovedNonprofitForSender(
  email: string,
): Promise<string | null> {
  const addr = email.trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  const domain = addr.slice(at + 1);
  const domainForMatch = FREE_EMAIL_DOMAINS.has(domain) ? null : domain;
  const { rows } = await query<{ id: string }>(
    `SELECT n.id
       FROM nonprofits n
      WHERE n.verified = true
        -- A deny on the exact address or its domain blocks the sender outright.
        AND NOT EXISTS (
          SELECT 1 FROM nonprofit_identifiers d
           WHERE (d.kind = 'email_deny' AND lower(d.value) = $1)
              OR (d.kind = 'domain_deny' AND $2::text IS NOT NULL AND lower(d.value) = $2)
        )
        AND (
          -- legacy single contact_email (exact, or its org domain)
          lower(n.contact_email) = $1
          OR ($2::text IS NOT NULL AND lower(split_part(n.contact_email, '@', 2)) = $2)
          -- admin-added identifiers for this org
          OR EXISTS (
            SELECT 1 FROM nonprofit_identifiers i
             WHERE i.nonprofit_id = n.id
               AND ( (i.kind = 'email' AND lower(i.value) = $1)
                  OR (i.kind = 'domain' AND $2::text IS NOT NULL AND lower(i.value) = $2) )
          )
        )
      -- Prefer an exact-address match over a domain match for determinism.
      ORDER BY (
          lower(n.contact_email) = $1
          OR EXISTS (SELECT 1 FROM nonprofit_identifiers i
                      WHERE i.nonprofit_id = n.id AND i.kind = 'email' AND lower(i.value) = $1)
        ) DESC, n.created_at ASC
      LIMIT 1`,
    [addr, domainForMatch],
  );
  return rows[0]?.id ?? null;
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

  // Txn 1: persist the inbound request (status 'received'). Kept short — no model
  // call inside an open transaction. A caller-supplied nonprofit_id (the admin
  // manual path) that isn't a real UUID / known org would trip a foreign-key
  // (23503) or invalid-text (22P02) error on INSERT; map those to a clean 400
  // rather than a 500, the same way setOwnBudget maps its CHECK violation.
  let intakeId: string;
  let nonprofitId: string;
  try {
    ({ intakeId, nonprofitId } = await withTransaction(async (client) => {
      const nonprofitId =
        input.nonprofit_id ?? (await findOrCreateProvisionalNonprofit(client, input.from_email));
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
      return { intakeId, nonprofitId };
    }));
  } catch (err: any) {
    if (err?.code === '23503' || err?.code === '22P02') {
      throw new OpError(400, 'bad_nonprofit_id', 'nonprofit_id does not reference a known nonprofit');
    }
    throw err;
  }

  // Decompose OUTSIDE any transaction — a real local model can take seconds, and
  // we must not hold DB locks/connection while it runs.
  const proposed = await getDecomposer().decompose({
    from_email: input.from_email,
    subject: input.subject,
    body: input.body,
    attachment_count: input.attachments?.length ?? 0,
  });

  await query(
    `UPDATE intake_requests
        SET proposed = $2, status = 'decomposed', triaged_by = 'ai', updated_at = now()
      WHERE id = $1 AND status = 'received'`,
    [intakeId, JSON.stringify(proposed)],
  );

  return { intake_id: intakeId, nonprofit_id: nonprofitId, status: 'decomposed', proposed };
}

/** Re-run the decomposer on a request, replacing the draft. */
export async function redecompose(intakeId: string) {
  const r = await query<{ from_email: string; subject: string | null; raw_body: string; status: string }>(
    `SELECT from_email, subject, raw_body, status FROM intake_requests WHERE id = $1`,
    [intakeId],
  );
  const row = r.rows[0];
  if (!row) throw new OpError(404, 'intake_not_found', 'Unknown intake request');
  if (row.status === 'published') {
    throw new OpError(409, 'already_published', 'Cannot re-decompose a published request');
  }
  const att = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM intake_attachments WHERE intake_request_id = $1`,
    [intakeId],
  );

  // Model call outside any transaction.
  const proposed = await getDecomposer().decompose({
    from_email: row.from_email,
    subject: row.subject ?? undefined,
    body: row.raw_body,
    attachment_count: Number(att.rows[0].n),
  });

  // Guard on status so we don't clobber a request that got published mid-call.
  const upd = await query(
    `UPDATE intake_requests SET proposed = $2, status = 'decomposed', updated_at = now()
      WHERE id = $1 AND status <> 'published' RETURNING id`,
    [intakeId, JSON.stringify(proposed)],
  );
  if (upd.rowCount === 0) {
    throw new OpError(409, 'already_published', 'Request was published during decomposition');
  }
  return { intake_id: intakeId, status: 'decomposed', proposed };
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
  // tasksOverride comes from the admin /publish body; a non-array (object or
  // string) would make the `for (const t of tasks)` below throw a 500 or iterate
  // string characters. Reject it cleanly.
  if (tasksOverride !== undefined && !Array.isArray(tasksOverride)) {
    throw new OpError(400, 'bad_input', 'tasks must be an array');
  }
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

    // Normalize every task through the same path the decomposer uses, so an
    // admin-supplied override with missing/invalid fields can't reach the INSERT
    // and trip a NOT NULL / CHECK violation (500). normalizeTask clamps cents,
    // whitelists model/sensitivity, and guarantees max >= est > 0.
    const tasks = (tasksOverride ?? row.proposed ?? []).map(normalizeTask);
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
