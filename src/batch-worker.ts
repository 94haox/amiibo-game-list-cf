// Batch sub-Worker entry. The parent (amiibo-game-list) calls this via a
// service binding once per batch of ~200 amiibo. Each invocation runs in its
// own isolate with its own 1000-subrequest budget, so the parent only spends
// one subrequest per batch dispatch.
//
// Protocol — POST /process:
//   request body  { cacheKey: string, amiiboIds: string[], concurrency?: number }
//   response body { results: Record<amiiboId, Games>, missing: string[] }
//
// The cacheKey is an R2 object key under OUTPUT_BUCKET holding the compact
// dataset blob written by the parent in this run.

import type { R2Bucket } from "@cloudflare/workers-types";

import { normalizeHex } from "./hex.js";
import { log, setLevel } from "./log.js";
import {
  processOneAmiibo,
  rehydrateDatasets,
  runPool,
  type CompactDatasets,
} from "./pipeline.js";
import type { Games } from "./types.js";

export interface BatchEnv {
  OUTPUT_BUCKET: R2Bucket;
}

interface BatchRequest {
  cacheKey: string;
  amiiboIds: string[];
  concurrency?: number;
}

interface BatchResponse {
  results: Record<string, Games>;
  missing: string[];
  processed: number;
  errors: string[];
}

async function loadCachedDatasets(env: BatchEnv, cacheKey: string) {
  const obj = await env.OUTPUT_BUCKET.get(cacheKey);
  if (!obj) throw new Error(`dataset cache missing: ${cacheKey}`);
  const compact = (await obj.json()) as CompactDatasets;
  return rehydrateDatasets(compact);
}

async function handleProcess(request: Request, env: BatchEnv): Promise<Response> {
  const payload = (await request.json()) as BatchRequest;
  if (!payload?.cacheKey || !Array.isArray(payload.amiiboIds)) {
    return new Response("bad request", { status: 400 });
  }

  setLevel("info");
  const datasets = await loadCachedDatasets(env, payload.cacheKey);
  const concurrency = payload.concurrency ?? 8;

  const results: Record<string, Games> = {};
  const missing = new Set<string>();
  const errors: string[] = [];
  let processed = 0;

  await runPool(
    payload.amiiboIds,
    async (amiiboId) => {
      const raw = datasets.amiibo.amiibos[amiiboId];
      if (!raw) {
        errors.push(`amiibo not in DB: ${amiiboId}`);
        return;
      }
      try {
        const r = await processOneAmiibo(datasets, amiiboId, raw);
        results[normalizeHex(amiiboId)] = r.games;
        for (const m of r.missing) missing.add(m);
        processed++;
      } catch (err) {
        errors.push(`${amiiboId} (${raw.name}): ${(err as Error).message}`);
      }
    },
    concurrency,
  );

  const body: BatchResponse = {
    results,
    missing: [...missing],
    processed,
    errors,
  };
  log.info(`Batch done: processed=${processed}/${payload.amiiboIds.length} errors=${errors.length}`);
  return Response.json(body);
}

export default {
  async fetch(request: Request, env: BatchEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/process") {
      try {
        return await handleProcess(request, env);
      } catch (err) {
        log.error(`Batch failed: ${(err as Error).message}`);
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
