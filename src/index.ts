// Worker entry. Wires three handlers:
//   - scheduled: cron — bootstraps a run.
//   - queue:     two queues (amiibo-jobs, amiibo-finalize).
//   - fetch:     HTTP routes — serves the generated games_info.json from R2
//                and exposes a guarded /trigger for manual runs.

import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";

import type { Env, FinalizeMessage, JobMessage } from "../worker-configuration";

import { log, setLevel } from "./log.js";
import { runScheduledTrigger } from "./scheduled.js";
import { handleAmiiboBatch, handleFinalizeBatch } from "./queue.js";
import {
  finalOutputR2Key,
  metadataR2Key,
  missingOutputR2Key,
} from "./state.js";

export { RunCoordinator } from "./coordinator.js";

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
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    setLevel("info");
    try {
      const runId = await runScheduledTrigger(env, ctx);
      log.info(`Cron triggered run ${runId}`);
    } catch (err) {
      log.error(`Scheduled run failed: ${(err as Error).message}`);
      throw err;
    }
  },

  async queue(
    batch: MessageBatch<JobMessage | FinalizeMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    setLevel("info");
    if (batch.queue === "amiibo-jobs") {
      await handleAmiiboBatch(batch as MessageBatch<JobMessage>, env);
    } else if (batch.queue === "amiibo-finalize") {
      await handleFinalizeBatch(batch as MessageBatch<FinalizeMessage>, env, ctx);
    } else {
      log.warn(`Unknown queue: ${batch.queue}`);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setLevel("info");
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/games_info.json") {
      return serveR2(env, finalOutputR2Key(), "application/json; charset=utf-8");
    }
    if (url.pathname === "/missing_games.json") {
      return serveR2(env, missingOutputR2Key(), "application/json; charset=utf-8");
    }
    if (url.pathname === "/latest.json") {
      return serveR2(env, metadataR2Key(), "application/json; charset=utf-8");
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    if (url.pathname === "/trigger") {
      // Guarded manual trigger — useful for backfilling or one-off runs.
      const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!env.INTERNAL_TRIGGER_KEY || provided !== env.INTERNAL_TRIGGER_KEY) {
        return new Response("unauthorized", { status: 401 });
      }
      const runId = await runScheduledTrigger(env, ctx);
      return Response.json({ runId });
    }
    return new Response("not found", { status: 404 });
  },
};
