// Worker entry. Two handlers:
//   - scheduled: cron — runs the full generation pipeline inline.
//   - fetch:     HTTP routes — serves the generated artefacts from R2 and
//                exposes a guarded /trigger for manual runs.

import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";

import type { Env } from "../worker-configuration";

import { log, setLevel } from "./log.js";
import {
  FINAL_OUTPUT_KEY,
  METADATA_KEY,
  MISSING_OUTPUT_KEY,
  runScheduledTrigger,
} from "./scheduled.js";

async function serveR2(env: Env, key: string, contentType: string): Promise<Response> {
  const obj = await env.OUTPUT_BUCKET.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=300");
  if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
  return new Response(obj.body, { headers });
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    setLevel("info");
    try {
      const stats = await runScheduledTrigger(env, ctx);
      log.info(`Cron finished: amiibo=${stats.totalAmiibo} missing=${stats.missingCount} bytes=${stats.bytes}`);
    } catch (err) {
      log.error(`Scheduled run failed: ${(err as Error).message}`);
      throw err;
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setLevel("info");
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/games_info.json") {
      return serveR2(env, FINAL_OUTPUT_KEY, "application/json; charset=utf-8");
    }
    if (url.pathname === "/missing_games.json") {
      return serveR2(env, MISSING_OUTPUT_KEY, "application/json; charset=utf-8");
    }
    if (url.pathname === "/latest.json") {
      return serveR2(env, METADATA_KEY, "application/json; charset=utf-8");
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/trigger") {
      // Guarded manual trigger — useful for backfills or one-off runs.
      const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!env.INTERNAL_TRIGGER_KEY || provided !== env.INTERNAL_TRIGGER_KEY) {
        return new Response("unauthorized", { status: 401 });
      }
      // Run in the background — cron-like semantics, immediate response.
      ctx.waitUntil(
        runScheduledTrigger(env, ctx).catch((err) => {
          log.error(`/trigger run failed: ${(err as Error).message}`);
        }),
      );
      return Response.json({ status: "started" }, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  },
};
