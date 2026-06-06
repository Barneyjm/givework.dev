// Thin REST client for the Givework control plane. Mirrors the error mapping the
// runner uses (run-loop.ts HttpBackend): the API returns { error, message } with a
// 4xx/5xx for OpErrors, which we surface as a thrown ApiError(code, message).

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface RequestOpts {
  method?: string;
  path: string;
  token?: string;
  body?: unknown;
}

export async function apiRequest<T>(baseUrl: string, opts: RequestOpts): Promise<T> {
  const { method = 'GET', path, token, body } = opts;
  const res = await fetch(baseUrl.replace(/\/$/, '') + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(`http_${res.status}`, text.slice(0, 300), res.status);
    }
  }
  if (!res.ok) {
    throw new ApiError(
      payload?.error ?? `http_${res.status}`,
      payload?.message ?? text,
      res.status,
    );
  }
  // A 2xx with an empty body parses to null; hand callers {} so property access
  // doesn't throw.
  return (payload ?? {}) as T;
}
