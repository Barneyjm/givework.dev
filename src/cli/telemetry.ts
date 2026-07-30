import { createHash, randomUUID } from 'node:crypto';
import { platform, release } from 'node:os';
import { apiUrl, loadConfig, saveConfig } from './config.js';

// CLI telemetry — deliberately the smallest thing that answers the questions the
// control plane cannot answer for itself.
//
// WHAT THIS IS FOR
//
// The server already sees everything that reaches it: /checkout and /submit are
// captured server-side (src/posthog.ts), attributed to the dev. Sending
// those again from here would double-count them, so we don't. What the server
// can never see is the part of the funnel that fails BEFORE an HTTP call:
// somebody runs `givework start`, has no `claude` on PATH, and walks away. That
// volunteer is invisible in every server-side metric, and they are exactly the
// one worth knowing about.
//
// So: local command outcomes only.
//
// PRIVACY RULES — this ships to volunteers' own machines, which makes it a
// different proposition from server-side analytics. All four are load-bearing:
//
//  1. Opt-out is honoured before anything else happens. GIVEWORK_TELEMETRY=0
//     and the cross-tool DO_NOT_TRACK=1 standard both disable it completely.
//  2. Disclosed on first use. The first command a volunteer runs prints a short
//     notice saying what is collected and how to turn it off, once, and records
//     the acknowledgement in ~/.givework/config.json.
//  3. No content, ever. Command NAME and outcome; never arguments, file paths,
//     hostnames, task text, prompts, model output, or error messages — only a
//     short error CODE. The allowlist below is the whole payload.
//  4. It cannot slow down or break a command. Fire-and-forget with a hard
//     timeout, every failure swallowed. `flush` is best-effort.

const TELEMETRY_NOTICE = `givework collects anonymous CLI usage (command name, success/failure,
duration, version, OS) to find where setup breaks. No arguments, paths, or task
content are ever sent. Opt out any time with GIVEWORK_TELEMETRY=0.`;

/** Env-var kill switches, checked before any other work. */
function optedOut(): boolean {
  const flag = process.env.GIVEWORK_TELEMETRY;
  if (flag === '0' || flag === 'false' || flag === 'off') return true;
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt === '1' || dnt === 'true') return true;
  return false;
}

/** Whether CLI telemetry would send anything — surfaced by `givework status`. */
export function telemetryEnabled(): boolean {
  return !optedOut();
}

/**
 * A stable random id for this install, minted on first use and kept in the
 * config file. Not derived from anything about the machine or the user — it is
 * just a random UUID, so it identifies a series of events as coming from one
 * install and nothing more. Once the volunteer logs in we prefer the HASH of
 * their dev id (see distinctId), which is what joins CLI events to the
 * server-side and browser events for the same person.
 */
let _anonId: string | undefined;

function anonymousId(): string {
  // Memoised per process: two captures racing (the command event and an
  // execution-failure event) would otherwise both read the file before either
  // wrote, mint two ids, and split one install across two users.
  if (_anonId) return _anonId;
  const existing = loadConfig().telemetryId;
  if (existing) {
    _anonId = existing;
    return existing;
  }
  const id = randomUUID();
  _anonId = id;
  try {
    saveConfig({ telemetryId: id });
  } catch {
    /* unwritable config (read-only home, CI) — use the id for this process only */
  }
  return id;
}

/**
 * The same distinct-id scheme as the control plane (src/posthog.ts hashDevId):
 * first 16 hex chars of SHA-256(dev id). Sync here because node:crypto is
 * available — the output is byte-identical to the server's Web Crypto version,
 * which is what lets a CLI event and a /checkout event join to one person.
 */
function hashDevIdSync(devId: string): string {
  return createHash('sha256').update(devId).digest('hex').slice(0, 16);
}

function distinctId(): string {
  const cfg = loadConfig();
  // The dev token's subject is the dev id. HASH it exactly like the server-side
  // mirror does, so CLI events and server events for the same volunteer resolve
  // to the same PostHog person — and the raw dev id never appears in analytics.
  // Decoding the JWT payload is enough — we are not verifying it, just reading
  // our own stored token to label our own events.
  if (cfg.token) {
    try {
      const [, payload] = cfg.token.split('.');
      const sub = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub;
      if (typeof sub === 'string' && sub) return hashDevIdSync(sub);
    } catch {
      /* malformed token — fall through to the anonymous id */
    }
  }
  return anonymousId();
}

/** Print the disclosure once per install, then remember that we did. */
function discloseOnce(): void {
  if (loadConfig().telemetryNoticeShown) return;
  console.error(`\n${TELEMETRY_NOTICE}\n`);
  try {
    saveConfig({ telemetryNoticeShown: true });
  } catch {
    /* unwritable config — the notice reappears next run, which is the safe way to fail */
  }
}

interface RemoteConfig {
  token: string;
  host: string;
}

let _config: RemoteConfig | null | undefined;

/**
 * Ask the control plane for the PostHog ingest config. The CLI cannot be built
 * with it baked in: `npx github:Barneyjm/givework.dev` compiles from source on
 * the volunteer's machine, where no token exists. Cached in the config file so
 * this is one extra request a day, not one per command.
 */
async function remoteConfig(): Promise<RemoteConfig | null> {
  if (_config !== undefined) return _config;

  const cfg = loadConfig();
  const DAY = 24 * 60 * 60 * 1000;
  if (cfg.telemetryConfig && cfg.telemetryConfigAt && Date.now() - cfg.telemetryConfigAt < DAY) {
    _config = cfg.telemetryConfig.token ? cfg.telemetryConfig : null;
    return _config;
  }

  try {
    const res = await fetch(`${apiUrl().replace(/\/$/, '')}/analytics-config.json`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      _config = null;
      return null;
    }
    const body = (await res.json()) as RemoteConfig;
    try {
      saveConfig({ telemetryConfig: body, telemetryConfigAt: Date.now() });
    } catch {
      /* unwritable config — we just re-fetch next run */
    }
    _config = body.token ? body : null;
  } catch {
    // Offline, or the control plane is down. Telemetry is the first thing to go.
    _config = null;
  }
  return _config;
}

/** Everything a CLI event is allowed to carry, beyond the per-event properties. */
function baseProperties(): Record<string, unknown> {
  return {
    cli_version: process.env.GIVEWORK_BUILD_SHA ?? 'dev',
    node_version: process.version,
    os: platform(),
    os_release: release(),
    ci: Boolean(process.env.CI),
    $process_person_profile: false,
  };
}

const inflight: Promise<unknown>[] = [];

/**
 * Capture one CLI event. Returns immediately; the POST is tracked in `inflight`
 * so `flushTelemetry` can give it a brief chance to land before the process
 * exits. Never throws.
 */
export function captureCliEvent(event: string, properties: Record<string, unknown> = {}): void {
  if (optedOut()) return;
  discloseOnce();

  const sent = (async () => {
    try {
      const cfg = await remoteConfig();
      if (!cfg) return;
      await fetch(`${cfg.host.replace(/\/$/, '')}/i/v0/e/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: cfg.token,
          event,
          distinct_id: distinctId(),
          properties: { ...baseProperties(), ...properties },
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Swallowed on purpose. A volunteer donating compute on a flaky
      // connection must never see an analytics error, let alone a failed run.
    }
  })();

  inflight.push(sent);
}

/**
 * Give in-flight captures a moment to land before the CLI exits. Bounded, so a
 * hanging request delays exit by at most `ms`.
 */
export async function flushTelemetry(ms = 2000): Promise<void> {
  if (!inflight.length) return;
  await Promise.race([
    Promise.allSettled(inflight.splice(0)),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

/** Map an unknown thrown value to a short, content-free code. */
export function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code.slice(0, 64);
  }
  return 'unknown';
}
