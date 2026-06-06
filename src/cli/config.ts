import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Persisted CLI config at ~/.givework/config.json. Holds the API base URL plus
// the dev and (optionally) admin tokens. Env vars override the file so CI / ad-hoc
// use needs no login: GIVEWORK_API_URL, GIVEWORK_TOKEN, GIVEWORK_ADMIN_TOKEN.

export const DEFAULT_API_URL = 'https://api.givework.dev';

export interface Config {
  apiUrl?: string;
  token?: string;
  adminToken?: string;
}

function configDir(): string {
  return join(homedir(), '.givework');
}
function configPath(): string {
  return join(configDir(), 'config.json');
}

function readFile(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as Config;
  } catch {
    return {};
  }
}

/** Merge the on-disk config with env overrides. */
export function loadConfig(): Config {
  const file = readFile();
  return {
    apiUrl: process.env.GIVEWORK_API_URL ?? file.apiUrl ?? DEFAULT_API_URL,
    token: process.env.GIVEWORK_TOKEN ?? file.token,
    adminToken: process.env.GIVEWORK_ADMIN_TOKEN ?? file.adminToken,
  };
}

/** Merge updates into the on-disk config (does not touch env). 0600 — it holds secrets. */
export function saveConfig(update: Config): void {
  mkdirSync(configDir(), { recursive: true });
  const merged = { ...readFile(), ...update };
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // ensure perms even if the file pre-existed
  } catch {
    /* best-effort */
  }
}

export function apiUrl(): string {
  return loadConfig().apiUrl ?? DEFAULT_API_URL;
}

/** The dev token, or exit with a hint to run `givework login`. */
export function requireToken(): string {
  const t = loadConfig().token;
  if (!t) {
    console.error('Not logged in. Run:  givework login');
    process.exit(1);
  }
  return t;
}

/** The admin token, or exit with a hint to run `givework admin login`. */
export function requireAdminToken(): string {
  const t = loadConfig().adminToken;
  if (!t) {
    console.error(
      'No admin token. Run:  givework admin login   (paste a token from `npm run mint-token -- --admin`)',
    );
    process.exit(1);
  }
  return t;
}

export const CONFIG_PATH = configPath();
