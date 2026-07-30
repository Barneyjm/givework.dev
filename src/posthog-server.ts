import type { Context } from 'hono';
import { PostHog } from 'posthog-node';

// Server-side PostHog capture for the control plane.
//
// This sits alongside `src/funnel.ts`, it does not replace it. The funnel table
// is the durable, queryable-in-SQL record that the product's own reporting is
// built on; PostHog is the exploratory layer on top. If the two ever disagree,
// funnel_events is the source of truth — which is exactly why nothing here is
// allowed to affect the request it observes.
//
// Two rules, inherited from funnel.ts and equally load-bearing:
//
//  1. Capturing an event must NEVER break the action it describes. Every entry
//     point swallows its own failures, including client construction.
//  2. Free on the hot path. `captureServerEvent` is awaited by NOBODY on the
//     request path — callers hand it to `captureAfterResponse`, which parks it
//     on the Worker's `waitUntil` so the HTTP round-trip to PostHog happens
//     after the response has already gone out. A blocking flush on /checkout
//     and /submit would put a third-party network call in front of the money
//     operations, which is precisely what funnel.ts was designed to avoid.

let _client: PostHog | null = null;
let _warned = false;

function getClient(): PostHog | null {
  if (_client) return _client;
  const token = process.env.POSTHOG_PROJECT_TOKEN;
  const host = process.env.POSTHOG_API_HOST ?? 'https://us.i.posthog.com';
  if (!token) {
    // Once per process, not once per event: unconfigured is the normal state in
    // tests and local dev, and a per-capture warning buries real output.
    if (!_warned && process.env.NODE_ENV !== 'production' && !process.env.VITEST) {
      _warned = true;
      console.warn(
        'PostHog is not configured (POSTHOG_PROJECT_TOKEN is unset); server-side events ' +
          'are being dropped. This warning appears once per process.',
      );
    }
    return null;
  }
  // flushAt:1 + flushInterval:0 sends each event on capture with no background
  // timer — required on Workers, where a timer between requests does not run.
  _client = new PostHog(token, { host, flushAt: 1, flushInterval: 0 });
  return _client;
}

/**
 * Capture one server-side PostHog event.
 *
 * Never throws and never rejects, including if the PostHog client itself fails
 * to construct — a bad host or a malformed token must not turn a successful
 * checkout into a 500.
 */
export async function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;
    client.capture({ distinctId, event, properties: properties ?? {} });
    await client.flush();
  } catch {
    // Deliberately swallowed — analytics must never break the action it records.
  }
}

/**
 * Capture an event without making the caller wait for it.
 *
 * On Cloudflare Workers a promise left floating when the handler returns is
 * cancelled, so "fire and forget" would silently capture nothing in production;
 * `executionCtx.waitUntil` is what keeps it alive past the response. Under the
 * Node adapter there is no executionCtx (accessing it throws), and a floating
 * promise is safe because the process outlives the request — so we just let it
 * run.
 *
 * Either way the caller's response is not delayed by a round-trip to PostHog.
 */
export function captureAfterResponse(
  c: Context,
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  const pending = captureServerEvent(distinctId, event, properties);
  try {
    c.executionCtx.waitUntil(pending);
  } catch {
    // No executionCtx (Node adapter, or a test calling app.fetch directly).
    // captureServerEvent already cannot reject, so nothing to attach here.
  }
}
