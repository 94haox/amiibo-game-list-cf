// Cron entry point. Loads upstream datasets, persists them to R2 keyed by
// runId, then fans the per-amiibo work out to the queue. The Durable Object
// coordinator owns the "all done" trigger that kicks off finalize.

import type { Env, JobMessage } from "../worker-configuration";

import { loadAllDatasets } from "./datasets.js";
import { initCoordinator } from "./coordinator.js";
import { log, setLevel } from "./log.js";
import { normalizeHex } from "./hex.js";
import { datasetsR2Key, datasetsToPersisted, enqueueAmiiboBatch, putRunState } from "./state.js";

export async function runScheduledTrigger(env: Env, ctx: ExecutionContext): Promise<string> {
  setLevel("info");
  const runId = newRunId();
  log.info(`Starting run ${runId}`);

  const datasets = await loadAllDatasets();
  const persisted = datasetsToPersisted(datasets);
  await env.OUTPUT_BUCKET.put(datasetsR2Key(runId), JSON.stringify(persisted), {
    httpMetadata: { contentType: "application/json" },
  });
  log.info(`Persisted datasets to R2 (${datasetsR2Key(runId)})`);

  const amiiboIds = Object.keys(datasets.amiibo.amiibos).map(normalizeHex);
  const total = amiiboIds.length;
  log.info(`Discovered ${total} amiibo entries`);

  await initCoordinator(env, runId, total);
  await putRunState(env, { runId, totalAmiibo: total, startedAt: new Date().toISOString() });

  // Send in chunks of 100 — sendBatch supports up to 100 messages per call.
  for (let i = 0; i < amiiboIds.length; i += 100) {
    const slice = amiiboIds.slice(i, i + 100);
    const msgs: JobMessage[] = slice.map((amiiboId) => ({ runId, amiiboId }));
    await enqueueAmiiboBatch(env, msgs);
  }
  log.info(`Enqueued ${total} amiibo jobs for run ${runId}`);
  return runId;
}

function newRunId(): string {
  const d = new Date();
  const iso = d.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14); // yyyymmddhhmmss
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}-${rand}`;
}
