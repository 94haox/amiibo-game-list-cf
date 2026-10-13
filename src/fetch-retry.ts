// Port of Program.GetAmiilifeStringAsync — fetch with retry/backoff and a
// hard 404 throw so callers can record the page as missing instead of
// retrying forever.

import { log } from "./log.js";

// amiibo.life is behind Cloudflare's bot management; requests without a
// browser-like User-Agent get bounced to a JS challenge page. We send a
// realistic UA on every outgoing fetch.
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function withDefaultHeaders(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers ?? undefined);
  for (const [k, v] of Object.entries(DEFAULT_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return { ...(init ?? {}), headers };
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(public readonly url: string) {
    super(`404 Not Found: ${url}`);
    this.name = "NotFoundError";
  }
}

export interface FetchRetryOptions {
  attempts?: number;
  init?: RequestInit;
  /** Cap exponential backoff in milliseconds. Default 60s. */
  maxBackoffMs?: number;
}

function backoffMs(attempt: number, cap: number): number {
  // Mirror the C# default: 2^attempt * 1s + 1s, capped.
  const ms = Math.pow(2, attempt) * 1000 + 1000;
  return Math.min(ms, cap);
}

function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header?.trim()) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 + 1000 : null;
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now) + 1000;
}

interface FetchClientOptions {
  /** Enable CLI-only scheduling and a bounded, per-run text cache for amiibo.life. */
  amiiboLifeIntervalMs?: number;
}

interface FetchRuntime {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export function createFetchClient(options: FetchClientOptions = {}, runtime: Partial<FetchRuntime> = {}) {
  const fetchImpl = runtime.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = runtime.random ?? Math.random;
  const interval = options.amiiboLifeIntervalMs;
  if (interval !== undefined && (!Number.isSafeInteger(interval) || interval < 1)) {
    throw new Error("amiibo.life request interval must be a positive integer");
  }
  let queue = Promise.resolve();
  let nextStart = 0;
  let cooldownUntil = 0;
  let rateLimitFailures = 0;
  const pending = new Map<string, Promise<string>>();
  const cache = new Map<string, string>();
  let cacheBytes = 0;
  const cacheLimit = 32 * 1024 * 1024;
  const managed = (url: string) => interval !== undefined && new URL(url).origin === "https://amiibo.life";

  async function waitForTurn(): Promise<void> {
    const turn = queue.then(async () => {
      // Recheck after sleeping: another in-flight request may extend the cooldown.
      while (now() < Math.max(nextStart, cooldownUntil)) {
        await sleep(Math.max(nextStart, cooldownUntil) - now());
      }
      nextStart = now() + interval!;
    });
    queue = turn.catch(() => {});
    await turn;
  }

  function remember(url: string, text: string): void {
    const bytes = text.length * 2;
    if (bytes > cacheLimit) return;
    while (cacheBytes + bytes > cacheLimit) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.length * 2;
      cache.delete(oldest);
    }
    cache.set(url, text);
    cacheBytes += bytes;
  }

  async function request<T>(url: string, options: FetchRetryOptions, read: (response: Response) => Promise<T>): Promise<T> {
    const attempts = options.attempts ?? 5;
    const cap = options.maxBackoffMs ?? 60_000;
    const paced = managed(url);
    for (let i = 0; i < attempts; i++) {
      if (paced) await waitForTurn();
      let response: Response;
      try {
        response = await fetchImpl(url, withDefaultHeaders(options.init));
        if (response.ok) {
          const result = await read(response);
          if (paced) rateLimitFailures = 0;
          return result;
        }
      } catch (error) {
        if (i === attempts - 1) throw error;
        log.warn(`(${i + 1}/${attempts}) fetch error on ${url}: ${(error as Error).message}`);
        await sleep(backoffMs(i, cap));
        continue;
      }

      // HTTP errors stay outside the transport catch so terminal failures cannot be retried twice.
      await response.body?.cancel();
      if (response.status === 404) throw new NotFoundError(url);
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`HTTP ${response.status} ${response.statusText} on ${url}`);
      }
      if (response.status === 429) {
        const fallback = paced
          ? Math.min(60_000 * 2 ** rateLimitFailures++, 15 * 60_000)
          : backoffMs(i, cap);
        const delay = (parseRetryAfter(response.headers.get("retry-after"), now()) ?? fallback)
          + (paced ? Math.floor(random() * 1000) : 0);
        // Publish the cooldown even on the last attempt so queued requests also observe it.
        if (paced) cooldownUntil = Math.max(cooldownUntil, now() + delay);
        if (i === attempts - 1) throw new Error(`HTTP 429 after ${attempts} attempts: ${url}`);
        log.warn(`(${i + 1}/${attempts}) HTTP 429 on ${url}; ${paced ? "amiibo.life paused" : "retrying"} for ${Math.round(delay / 1000)}s`);
        if (!paced) await sleep(delay);
      } else {
        if (i === attempts - 1) throw new Error(`HTTP ${response.status} after ${attempts} attempts: ${url}`);
        log.warn(`(${i + 1}/${attempts}) HTTP ${response.status} on ${url}`);
        await sleep(backoffMs(i, cap));
      }
    }
    throw new Error(`Exhausted retries for ${url}`);
  }

  function text(url: string, options: FetchRetryOptions = {}): Promise<string> {
    // Only default GETs share responses; custom headers, bodies and signals keep their own semantics.
    if (!managed(url) || options.init !== undefined) return request(url, options, (response) => response.text());
    const cached = cache.get(url);
    if (cached !== undefined) {
      cache.delete(url);
      cache.set(url, cached);
      return Promise.resolve(cached);
    }
    const active = pending.get(url);
    if (active) return active;
    const result = request(url, options, (response) => response.text())
      .then((body) => { remember(url, body); return body; })
      .finally(() => { pending.delete(url); });
    pending.set(url, result);
    return result;
  }

  return {
    text,
    bytes: (url: string, options: FetchRetryOptions = {}) => request(url, options,
      async (response) => new Uint8Array(await response.arrayBuffer())),
  };
}

// Worker entry points keep their existing scheduling; each CLI invocation creates its own client.
let client = createFetchClient();

export function configureAmiiboLifeRequests(intervalMs: number): void {
  client = createFetchClient({ amiiboLifeIntervalMs: intervalMs });
}

export function fetchTextWithRetry(url: string, options?: FetchRetryOptions): Promise<string> {
  return client.text(url, options);
}

export async function fetchJsonWithRetry<T>(url: string, options?: FetchRetryOptions): Promise<T> {
  return JSON.parse(await fetchTextWithRetry(url, options)) as T;
}

export function fetchBytesWithRetry(url: string, options?: FetchRetryOptions): Promise<Uint8Array> {
  return client.bytes(url, options);
}
