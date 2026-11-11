/** HTTP клиент към API-то. Сървърът е източникът на истина – клиентът изпраща само намерения за действия. */
const TOKEN_KEY = 'gce_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* частен режим – сесията живее само в паметта */
  }
  memToken = t;
}

let memToken: string | null = getToken();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

function idemKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: { idempotent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = memToken ?? getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Идемпотентен ключ: повторно натискане/мрежов повтор не създава двойно плащане.
  if (opts.idempotent) headers['idempotency-key'] = idemKey();
  const res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const get = <T = unknown>(p: string) => api<T>('GET', p);
export const post = <T = unknown>(p: string, b?: unknown, idempotent = false) => api<T>('POST', p, b ?? {}, { idempotent });
export const patch = <T = unknown>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const del = <T = unknown>(p: string) => api<T>('DELETE', p);
