import { PostHog } from 'posthog-node';

let _client: PostHog | null = null;

function getClient(): PostHog | null {
  if (_client) return _client;
  const token = process.env.POSTHOG_PROJECT_TOKEN;
  const host = process.env.POSTHOG_API_HOST ?? 'https://us.i.posthog.com';
  if (!token) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        'POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, ' +
          'this causes events to be silently missed. ' +
          'This error stops appearing once POSTHOG_PROJECT_TOKEN is configured',
      );
    }
    return null;
  }
  // flushAt:1 + flushInterval:0 ensures events are sent immediately — critical
  // for short-lived serverless / edge function lifetimes (no background timer).
  _client = new PostHog(token, { host, flushAt: 1, flushInterval: 0 });
  return _client;
}

/** Capture a server-side PostHog event. Never throws — analytics must not break callers. */
export async function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    client.capture({ distinctId, event, properties: properties ?? {} });
    await client.flush();
  } catch {
    // Deliberately swallowed — analytics must never break the action it records.
  }
}
