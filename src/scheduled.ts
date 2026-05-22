// Parent cron entry. Loads + caches datasets to R2, dispatches per-batch
// work to the batch sub-Worker through a service binding (each call is one
// subrequest), then merges results and writes the final outputs.
//
// Subrequest accounting (per run):
//   parent:  3 upstream + 1 cache write + N service calls + 3 R2 outputs
//            + 1 cache delete + ~2 GitHub  ≈ 15 subrequests
//   child :  1 R2 read + ~200 amiibo fetches + retries  ≈ 220 subrequests
//
// Way under the 1000-per-invocation cap on both sides.

import type { ExecutionContext } from "@cloudflare/workers-types";

import type { Env } from "../worker-configuration";

import { log, setLevel } from "./log.js";
import { commitToGitHub } from "./outputs/github.js";
import { assembleFinalOutput, buildCompactDatasets } from "./pipeline.js";
import type { Games } from "./types.js";

export const FINAL_OUTPUT_KEY = "games_info.json";
export const MISSING_OUTPUT_KEY = "missing_games.json";
export const METADATA_KEY = "latest.json";

const BATCH_SIZE = 200;
const BATCH_CONCURRENCY = 8; // concurrency *within* each child invocation

interface BatchResponse {
  results: Record<string, Games>;
  missing: string[];
  processed: number;
  errors: string[];
}

function newRunId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

async function dispatchBatch(
  env: Env,
  cacheKey: string,
  amiiboIds: string[],
  batchIndex: number,
): Promise<BatchResponse> {
  const resp = await env.BATCH.fetch("https://batch.internal/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cacheKey, amiiboIds, concurrency: BATCH_CONCURRENCY }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`batch ${batchIndex} failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  const body = (await resp.json()) as BatchResponse;
  log.info(
    `batch ${batchIndex}: processed=${body.processed}/${amiiboIds.length} missing+=${body.missing.length} errors=${body.errors.length}`,
  );
  if (body.errors.length > 0) {
    for (const e of body.errors.slice(0, 5)) log.warn(`  batch ${batchIndex} err: ${e}`);
  }
  return body;
}

export async function runScheduledTrigger(env: Env, ctx: ExecutionContext): Promise<{
  bytes: number;
  totalAmiibo: number;
  missingCount: number;
  batches: number;
}> {
  setLevel("info");
  const startedAt = Date.now();
  const runId = newRunId();
  const cacheKey = `runs/${runId}/datasets.json`;

  // 1. Load + compact + persist datasets (parent does this once).
  log.info(`Run ${runId}: building compact datasets`);
  const compact = await buildCompactDatasets();
  await env.OUTPUT_BUCKET.put(cacheKey, JSON.stringify(compact), {
    httpMetadata: { contentType: "application/json" },
  });
  log.info(`Cached datasets to R2 (${cacheKey})`);

  // 2. Slice the amiibo list into batches.
  const amiiboIds = Object.keys(compact.amiibo.amiibos);
  const batches: string[][] = [];
  for (let i = 0; i < amiiboIds.length; i += BATCH_SIZE) {
    batches.push(amiiboIds.slice(i, i + BATCH_SIZE));
  }
  log.info(
    `Dispatching ${batches.length} batches of <=${BATCH_SIZE} (${amiiboIds.length} amiibo) to BATCH service binding`,
  );

  // 3. Fan out — all children run in parallel; parent spends 1 subrequest each.
  const batchResults = await Promise.all(
    batches.map((b, i) => dispatchBatch(env, cacheKey, b, i)),
  );

  // 4. Merge.
  const exportMap: Record<string, Games> = {};
  const missing = new Set<string>();
  for (const r of batchResults) {
    Object.assign(exportMap, r.results);
    for (const m of r.missing) missing.add(m);
  }
  const totalAmiibo = Object.keys(exportMap).length;
  log.info(`Merged ${totalAmiibo} amiibo from ${batches.length} batches; missing=${missing.size}`);

  // 5. Sort + serialize.
  const { body, bytes } = assembleFinalOutput(exportMap);

  // 6. Write outputs to R2.
  await env.OUTPUT_BUCKET.put(FINAL_OUTPUT_KEY, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { runId, generatedAt: new Date().toISOString() },
  });
  log.info(`Wrote ${FINAL_OUTPUT_KEY} to R2 (${bytes} bytes)`);

  const missingList = [...missing].sort();
  await env.OUTPUT_BUCKET.put(MISSING_OUTPUT_KEY, JSON.stringify(missingList, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  await env.OUTPUT_BUCKET.put(
    METADATA_KEY,
    JSON.stringify({
      runId,
      totalAmiibo,
      missingCount: missingList.length,
      bytes,
      batches: batches.length,
      durationMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
    }),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } },
  );

  // 7. GitHub commit.
  try {
    await commitToGitHub(env, body);
  } catch (err) {
    log.error(`GitHub commit failed: ${(err as Error).message}`);
  }

  // 8. Cleanup dataset cache in the background.
  ctx.waitUntil(
    env.OUTPUT_BUCKET.delete(cacheKey).then(
      () => log.info(`Cleaned up ${cacheKey}`),
      (err) => log.warn(`Cache cleanup failed: ${(err as Error).message}`),
    ),
  );

  return { bytes, totalAmiibo, missingCount: missingList.length, batches: batches.length };
}
