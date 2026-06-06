import type { Context, Next } from 'hono';
import { type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { OpError } from './operations.js';

// Stateless auth: HS256 JWTs signed with JWT_SECRET. No token table — identity
// and role travel in the token. STAGE 3: token refresh / rotation / revocation
// lists and nonprofit-scoped tokens.

export type Role = 'dev' | 'admin';

export interface Principal {
  dev_id?: string; // present for role 'dev' (the JWT `sub`)
  role: Role;
}

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) {
    throw new Error('JWT_SECRET is not set — required to sign/verify tokens');
  }
  return new TextEncoder().encode(s);
}

const DAY = 60 * 60 * 24;

/** Mint a dev token whose `sub` is the dev id. */
export function signDevToken(devId: string, expDays = 90): Promise<string> {
  return new SignJWT({ role: 'dev' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(devId)
    .setIssuedAt()
    .setExpirationTime(`${expDays * DAY}s`)
    .sign(secret());
}

/** Mint an admin token (no subject; role only). */
export function signAdminToken(expDays = 365): Promise<string> {
  return new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expDays * DAY}s`)
    .sign(secret());
}

/** Verify a token and project it onto a Principal. Throws on invalid/expired. */
export async function verifyToken(token: string): Promise<Principal> {
  const { payload } = await jwtVerify<JWTPayload & { role?: Role }>(token, secret());
  const role = payload.role;
  if (role !== 'dev' && role !== 'admin') {
    throw new OpError(401, 'bad_token', 'Token missing a valid role');
  }
  if (role === 'dev' && !payload.sub) {
    throw new OpError(401, 'bad_token', 'Dev token missing subject');
  }
  return { role, dev_id: payload.sub };
}

function bearer(c: Context): string {
  const header = c.req.header('authorization') ?? '';
  // Tolerate any whitespace (multiple spaces / tabs) between scheme and token.
  const match = header.match(/^Bearer[ \t]+(\S.*)$/i);
  if (!match) {
    throw new OpError(401, 'unauthorized', 'Missing or malformed Bearer token');
  }
  return match[1].trim();
}

async function authenticate(c: Context): Promise<Principal> {
  let principal: Principal;
  try {
    principal = await verifyToken(bearer(c));
  } catch (err) {
    if (err instanceof OpError) throw err;
    // jose throws on bad signature / expiry — surface as a clean 401.
    throw new OpError(401, 'unauthorized', 'Invalid or expired token');
  }
  c.set('principal', principal);
  return principal;
}

/** Middleware: require any authenticated dev (role 'dev'). */
export async function requireDev(c: Context, next: Next) {
  const p = await authenticate(c);
  if (p.role !== 'dev') {
    throw new OpError(403, 'forbidden', 'Requires a dev token');
  }
  await next();
}

/** Middleware: require an admin token (role 'admin'). */
export async function requireAdmin(c: Context, next: Next) {
  const p = await authenticate(c);
  if (p.role !== 'admin') {
    throw new OpError(403, 'forbidden', 'Requires an admin token');
  }
  await next();
}
