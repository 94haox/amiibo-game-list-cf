import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createFetchClient, NotFoundError } from "../src/fetch-retry.js";

const base = "https://amiibo.life";

class Clock {
  time = Date.parse("2026-10-13T00:00:00Z");
  start = this.time;
  timers: Array<{ at: number; resolve: () => void }> = [];
  now = () => this.time;
  sleep = (ms: number) => new Promise<void>((resolve) => {
    this.timers.push({ at: this.time + ms, resolve });
  });

  async run<T>(work: Promise<T>): Promise<T> {
    let finished = false;
    void work.then(() => { finished = true; }, () => { finished = true; });
    for (let i = 0; i < 1000; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (finished) return work;
      assert.ok(this.timers.length, "Work stalled without a timer");
      this.time = Math.min(...this.timers.map((timer) => timer.at));
      const ready = this.timers.filter((timer) => timer.at <= this.time);
      this.timers = this.timers.filter((timer) => timer.at > this.time);
      for (const timer of ready) timer.resolve();
    }
    throw new Error("Virtual timer limit exceeded");
  }
}

function setup(handler: (url: string, attempt: number) => Response | Promise<Response>, paced = true) {
  const clock = new Clock();
  const calls: Array<{ url: string; time: number }> = [];
  const attempts = new Map<string, number>();
  const client = createFetchClient(paced ? { amiiboLifeIntervalMs: 2000 } : {}, {
    now: clock.now, sleep: clock.sleep, random: () => 0,
    fetch: (async (input) => {
      const url = String(input);
      calls.push({ url, time: clock.time - clock.start });
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return handler(url, attempt);
    }) as typeof fetch,
  });
  return { client, clock, calls };
}

const ok = () => new Response("page");
const limited = (retryAfter?: string) => new Response("limited", {
  status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
});

test("directory, search, detail and byte requests share one host queue", async () => {
  const { client, clock, calls } = setup(ok);
  await clock.run(Promise.all([
    client.text(`${base}/figures.json`), client.text(`${base}/search?q=Isabelle`),
    client.text(`${base}/amiibo/isabelle`), client.bytes(`${base}/image`),
    client.text("https://example.com/dataset"),
  ]));
  assert.deepEqual(calls.filter((call) => call.url.startsWith(base)).map((call) => call.time), [0, 2000, 4000, 6000]);
  assert.equal(calls.find((call) => call.url.includes("example.com"))?.time, 0);
});

test("429 pauses queued requests and the retry resumes through the paced queue", async () => {
  const { client, clock, calls } = setup((url, attempt) => url.endsWith("first") && attempt === 1 ? limited() : ok());
  await clock.run(Promise.all([client.text(`${base}/first`), client.text(`${base}/second`)]));
  assert.deepEqual(calls, [
    { url: `${base}/first`, time: 0 },
    { url: `${base}/second`, time: 60_000 },
    { url: `${base}/first`, time: 62_000 },
  ]);
});

test("429 honors numeric and HTTP-date Retry-After including values above the fallback cap", async () => {
  for (const header of ["1200", new Date(Date.parse("2026-10-13T00:20:00Z")).toUTCString()]) {
    const { client, clock, calls } = setup((_url, attempt) => attempt === 1 ? limited(header) : ok());
    await clock.run(client.text(`${base}/retry`));
    assert.deepEqual(calls.map((call) => call.time), [0, 1_201_000]);
  }
});

test("waiting requests recheck a cooldown extended by an in-flight 429", async () => {
  const state = setup(async (url, attempt) => {
    if (attempt > 1) return ok();
    if (url.endsWith("slow")) {
      await state.clock.sleep(10_000);
      return limited("120");
    }
    if (url.endsWith("fast")) return limited("60");
    return ok();
  });
  await state.clock.run(Promise.all([
    state.client.text(`${base}/slow`), state.client.text(`${base}/fast`), state.client.text(`${base}/queued`),
  ]));
  assert.deepEqual(state.calls.slice(0, 2).map((call) => call.time), [0, 2000]);
  assert.ok(state.calls.slice(2).every((call) => call.time >= 131_000));
  for (let i = 3; i < state.calls.length; i++) {
    assert.ok(state.calls[i]!.time - state.calls[i - 1]!.time >= 2000);
  }
});

test("repeated 429 uses longer backoff and exhausted retries still cool down the host", async () => {
  const { client, clock, calls } = setup((url) => url.endsWith("limited") ? limited("invalid") : ok());
  await clock.run(assert.rejects(client.text(`${base}/limited`), /HTTP 429 after 5 attempts/));
  assert.deepEqual(calls.map((call) => call.time), [0, 60_000, 180_000, 420_000, 900_000]);
  await clock.run(client.text(`${base}/next`));
  assert.equal(calls.at(-1)?.time, 1_800_000);
});

test("same-run GETs share in-flight work and successful text while failures remain retryable", async () => {
  const { client, clock, calls } = setup((_url, attempt) => attempt === 1 ? new Response("missing", { status: 404 }) : ok());
  const url = `${base}/search?q=Isabelle`;
  const first = client.text(url);
  assert.equal(client.text(url), first);
  await clock.run(assert.rejects(first, NotFoundError));
  assert.equal(await clock.run(client.text(url)), "page");
  assert.equal(await client.text(url), "page");
  assert.equal(calls.length, 2);
  await clock.run(client.text(url, { init: { headers: { "x-test": "custom" } } }));
  assert.equal(calls.length, 3);
  const fresh = setup(ok);
  await fresh.clock.run(fresh.client.text(url));
  assert.equal(fresh.calls.length, 1);
});

test("successful cache has a bounded size and leaves room for later pages", async () => {
  const large = "x".repeat(9 * 1024 * 1024);
  const { client, clock, calls } = setup(() => new Response(large));
  await clock.run(client.text(`${base}/first`));
  await clock.run(client.text(`${base}/second`));
  await clock.run(client.text(`${base}/first`));
  assert.equal(calls.length, 3);
});

test("403 and 404 fail immediately; transport and 5xx failures retain bounded retries", async () => {
  for (const status of [403, 404]) {
    for (const format of ["text", "bytes"] as const) {
      const { client, clock, calls } = setup(() => new Response("error", { status }));
      await clock.run(assert.rejects(client[format](`${base}/failure`), new RegExp(String(status))));
      assert.equal(calls.length, 1);
    }
  }
  for (const transport of [false, true]) {
    const { client, clock, calls } = setup((_url, attempt) => {
      if (attempt === 3) return ok();
      if (transport) throw new Error("network down");
      return new Response("error", { status: 503 });
    });
    assert.equal(await clock.run(client.text(`${base}/failure`)), "page");
    assert.deepEqual(calls.map((call) => call.time), [0, 2000, 5000]);
  }
});

test("worker defaults keep requests independent and successful responses uncached", async () => {
  const { client, clock, calls } = setup(ok, false);
  await clock.run(Promise.all([client.text(`${base}/same`), client.text(`${base}/same`)]));
  assert.deepEqual(calls.map((call) => call.time), [0, 0]);
});

test("CLI validates pacing before making requests", () => {
  for (const value of ["0", "-1", "NaN", "1.5"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--request-interval-ms", value], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Invalid request interval/);
  }
});
