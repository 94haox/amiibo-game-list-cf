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

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000 + 1000;
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now()) + 1000;
}

export async function fetchTextWithRetry(
  url: string,
  options: FetchRetryOptions = {},
): Promise<string> {
  const attempts = options.attempts ?? 5;
  const cap = options.maxBackoffMs ?? 60_000;

  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, withDefaultHeaders(options.init));

      if (response.status === 404) {
        // Consume body so the runtime doesn't warn about leaked streams.
        await response.body?.cancel();
        throw new NotFoundError(url);
      }

      if (response.ok) {
        return await response.text();
      }

      if (response.status === 429) {
        const delay = parseRetryAfter(response.headers.get("retry-after")) ?? backoffMs(i, cap);
        log.warn(`(${i + 1}/${attempts}) HTTP 429 on ${url}; retrying in ${Math.round(delay / 1000)}s`);
        await response.body?.cancel();
        if (i === attempts - 1) throw new Error(`HTTP 429 after ${attempts} attempts: ${url}`);
        await sleep(delay);
        continue;
      }

      if (response.status >= 500) {
        log.warn(`(${i + 1}/${attempts}) HTTP ${response.status} on ${url}`);
        await response.body?.cancel();
        if (i === attempts - 1) throw new Error(`HTTP ${response.status} after ${attempts} attempts: ${url}`);
        await sleep(backoffMs(i, cap));
        continue;
      }

      // Other 4xx are not retried — surface the failure.
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText} on ${url}: ${body.slice(0, 200)}`);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      const lastAttempt = i === attempts - 1;
      log.warn(`(${i + 1}/${attempts}) fetch error on ${url}: ${(err as Error).message}`);
      if (lastAttempt) throw err;
      await sleep(backoffMs(i, cap));
    }
  }

  throw new Error(`fetchTextWithRetry exhausted retries for ${url}`);
}

export async function fetchJsonWithRetry<T>(url: string, options?: FetchRetryOptions): Promise<T> {
  const text = await fetchTextWithRetry(url, options);
  return JSON.parse(text) as T;
}

export async function fetchBytesWithRetry(url: string, options: FetchRetryOptions = {}): Promise<Uint8Array> {
  const attempts = options.attempts ?? 5;
  const cap = options.maxBackoffMs ?? 60_000;

  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, withDefaultHeaders(options.init));
      if (response.status === 404) {
        await response.body?.cancel();
        throw new NotFoundError(url);
      }
      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer());
      }
      const lastAttempt = i === attempts - 1;
      log.warn(`(${i + 1}/${attempts}) HTTP ${response.status} on ${url}`);
      await response.body?.cancel();
      if (lastAttempt) throw new Error(`HTTP ${response.status} on ${url}`);
      await sleep(backoffMs(i, cap));
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      if (i === attempts - 1) throw err;
      log.warn(`(${i + 1}/${attempts}) fetch error on ${url}: ${(err as Error).message}`);
      await sleep(backoffMs(i, cap));
    }
  }

  throw new Error(`fetchBytesWithRetry exhausted retries for ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
