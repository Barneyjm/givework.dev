// PostHog forwarding — the funnel mirrored to product analytics, OFF the money path.
//
// The Postgres funnel log (src/funnel.ts) stays the system of record: it rides the
// operation's own transaction and can be re-aggregated forever. This module only
// MIRRORS those events to PostHog so they can be explored without SQL. Because it
// is a mirror, it inherits the funnel's prime directive and adds two of its own:
//
//  1. Never load-bearing. Hard no-op when the POSTHOG_PROJECT_TOKEN /
//     POSTHOG_API_HOST bindings are absent (local dev, tests, forks). capturePosthog
//     never throws — a fetch failure is logged and dropped.
//  2. Never on the hot path. Callers fire-and-forget AFTER the operation's
//     transaction has committed: via ctx.waitUntil on the deployed Worker (so the
//     runtime keeps the isolate alive past the response), or a floating promise on
//     the Node dev server. Nothing here is ever awaited by a handler and nothing
//     here ever runs inside a DB transaction.
//  3. No PII, ever. distinct_id is a truncated SHA-256 of the dev id — never the
//     raw id, never an email or GitHub handle. Properties carry only slugs, task
//     kinds, outcomes and integer cents; no statement text, artifacts or results.
//
// The bindings are Worker secrets (set via `wrangler secret put`, never committed).
// nodejs_compat mirrors them onto process.env too, so we read the binding first and
// fall back to process.env — the same value on the Worker, and the .env escape
// hatch for a Node dev server pointed at a scratch PostHog project.

export interface PosthogEnv {
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_API_HOST?: string;
}

/** How long we give PostHog before abandoning the capture. Generous for a
 * background task, tiny compared to a Worker's waitUntil allowance. */
export const POSTHOG_TIMEOUT_MS = 3000;

/** Resolve the two bindings (binding first, process.env fallback), or null when
 * either is missing — the "analytics is off" signal every entry point obeys. */
function resolveConfig(env: unknown): { token: string; host: string } | null {
  const e = (env ?? {}) as PosthogEnv;
  const token = e.POSTHOG_PROJECT_TOKEN ?? process.env.POSTHOG_PROJECT_TOKEN;
  const host = e.POSTHOG_API_HOST ?? process.env.POSTHOG_API_HOST;
  if (!token || !host) return null;
  return { token, host: host.replace(/\/+$/, '') };
}

/**
 * distinct_id for a dev: first 16 hex chars of SHA-256(dev id). Stable (the same
 * dev is the same person across events) but never reversible to the raw id, which
 * therefore never leaves our infrastructure. Web Crypto — available on both the
 * Worker runtime and Node >= 20.
 */
export async function hashDevId(devId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(devId));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * POST one event to `${POSTHOG_API_HOST}/capture/`. No-ops without both bindings;
 * resolves (never rejects) on any failure — timeout, network error, non-2xx — with
 * a console.error so a misconfigured token is visible in the Worker logs.
 * `fetchImpl` is injectable for tests; defaults to the runtime's fetch.
 */
export async function capturePosthog(
  env: unknown,
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const cfg = resolveConfig(env);
  if (!cfg) return;
  try {
    const res = await fetchImpl(`${cfg.host}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: cfg.token,
        event,
        distinct_id: distinctId,
        properties,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`posthog: capture ${event} -> HTTP ${res.status}`);
  } catch (err) {
    // Deliberately swallowed — analytics must never break (or slow) the action
    // it describes. Same contract as src/funnel.ts recordEvent.
    console.error(`posthog: capture ${event} failed`, err);
  }
}

/** The slice of a Hono context this module needs — kept structural so posthog.ts
 * never imports Hono and plain test doubles satisfy it. */
interface CaptureContext {
  env?: unknown;
  /** Hono's getter THROWS on the Node server (no ExecutionContext) — see below. */
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Fire-and-forget a funnel event from an HTTP handler, after the operation
 * succeeded. Synchronous by design — it adds zero latency to the response:
 *
 *  - Deployed Worker: the capture promise is handed to ctx.waitUntil, so the
 *    runtime finishes it after the response is returned.
 *  - Node dev server: accessing c.executionCtx throws (Hono has none to give),
 *    so the promise simply floats — fine on Node, where the process outlives
 *    the request.
 *
 * Unconfigured (no bindings) is a hard no-op before any work — not even the
 * dev-id hash is computed.
 */
export function captureFunnelEvent(
  c: CaptureContext,
  event: string,
  devId: string,
  properties: Record<string, unknown> = {},
  fetchImpl?: typeof fetch,
): void {
  if (!resolveConfig(c.env)) return;
  const capture = (async () => {
    await capturePosthog(c.env, event, await hashDevId(devId), properties, fetchImpl);
  })().catch(() => {
    // capturePosthog already swallows; this guards the hash step so the floating
    // promise can never become an unhandled rejection.
  });
  try {
    c.executionCtx?.waitUntil(capture);
  } catch {
    // Node: no ExecutionContext — the promise floats (see contract above).
  }
}
