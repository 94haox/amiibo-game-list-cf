// Queue consumers. Two queues are wired:
//   - amiibo-jobs:     per-amiibo scraping + matching, writes PartialResult.
//   - amiibo-finalize: triggered once by the coordinator DO when the run
//                      counter hits the expected total.

import type {
  MessageBatch,
  ExecutionContext,
  Message,
} from "@cloudflare/workers-types";

import type { Env, FinalizeMessage, JobMessage } from "../worker-configuration";

import { buildAmiiboContext, buildAmiiboUrl, cleanedName } from "./amiibo.js";
import { incrementCoordinator } from "./coordinator.js";
import { finalizeRun } from "./finalize.js";
import { NotFoundError, fetchTextWithRetry } from "./fetch-retry.js";
import { log } from "./log.js";
import { parseAmiiboPage } from "./parser.js";
import {
  datasetsFromPersisted,
  datasetsR2Key,
  putPartial,
} from "./state.js";
import type { BaseDatasets } from "./datasets.js";
import type { PersistedDatasets } from "./state.js";

// Per-isolate dataset cache. Workers keep globals across invocations within
// the same isolate, so consecutive batches reuse the heavy parse without
// re-downloading from R2.
const datasetsCache = new Map<string, BaseDatasets>();

async function loadDatasetsForRun(env: Env, runId: string): Promise<BaseDatasets> {
  const hit = datasetsCache.get(runId);
  if (hit) return hit;
  const obj = await env.OUTPUT_BUCKET.get(datasetsR2Key(runId));
  if (!obj) throw new Error(`datasets missing in R2 for run ${runId}`);
  const persisted = (await obj.json()) as PersistedDatasets;
  const ds = datasetsFromPersisted(persisted);
  datasetsCache.set(runId, ds);
  return ds;
}

async function processAmiibo(env: Env, msg: JobMessage, ds: BaseDatasets): Promise<void> {
  const raw = ds.amiibo.amiibos[msg.amiiboId];
  if (!raw) {
    log.warn(`Amiibo ${msg.amiiboId} missing from DB — skipping`);
    await putPartial(env, msg.runId, {
      amiiboId: msg.amiiboId,
      games: { games3DS: [], gamesWiiU: [], gamesSwitch: [], gamesSwitch2: [] },
      missing: [],
    });
    return;
  }
  const ctx = buildAmiiboContext(ds.amiibo, msg.amiiboId, raw);
  const cleanName = cleanedName(ctx.originalName);

  let url: string;
  try {
    url = await buildAmiiboUrl(ctx);
  } catch (err) {
    log.error(`URL build failed for ${cleanName}: ${(err as Error).message}`);
    throw err;
  }

  let html: string;
  try {
    html = await fetchTextWithRetry(url);
  } catch (err) {
    if (err instanceof NotFoundError) {
      log.warn(`404 amiibo.life for ${cleanName} (${ctx.originalName}) — empty games`);
      await putPartial(env, msg.runId, {
        amiiboId: msg.amiiboId,
        games: { games3DS: [], gamesWiiU: [], gamesSwitch: [], gamesSwitch2: [] },
        missing: [],
      });
      return;
    }
    throw err;
  }

  const parsed = parseAmiiboPage(html, { amiiboName: cleanName, datasets: ds });
  await putPartial(env, msg.runId, {
    amiiboId: msg.amiiboId,
    games: parsed.games,
    missing: parsed.missing,
  });
}

export async function handleAmiiboBatch(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  // Group by runId so a mixed batch only loads each dataset once.
  const byRun = new Map<string, Message<JobMessage>[]>();
  for (const msg of batch.messages) {
    const list = byRun.get(msg.body.runId) ?? [];
    list.push(msg);
    byRun.set(msg.body.runId, list);
  }

  for (const [runId, msgs] of byRun) {
    let ds: BaseDatasets;
    try {
      ds = await loadDatasetsForRun(env, runId);
    } catch (err) {
      log.error(`Failed to load datasets for run ${runId}: ${(err as Error).message}`);
      // Retry the whole group later.
      for (const m of msgs) m.retry({ delaySeconds: 30 });
      continue;
    }

    let processed = 0;
    for (const m of msgs) {
      try {
        await processAmiibo(env, m.body, ds);
        m.ack();
        processed++;
      } catch (err) {
        log.error(`Job ${m.body.amiiboId} failed: ${(err as Error).message}`);
        m.retry({ delaySeconds: 60 });
      }
    }
    if (processed > 0) {
      try {
        await incrementCoordinator(env, runId, processed);
      } catch (err) {
        log.error(`Coordinator increment failed for ${runId}: ${(err as Error).message}`);
      }
    }
  }
}

export async function handleFinalizeBatch(
  batch: MessageBatch<FinalizeMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await finalizeRun(env, ctx, msg.body.runId);
      msg.ack();
    } catch (err) {
      log.error(`Finalize ${msg.body.runId} failed: ${(err as Error).message}`);
      msg.retry({ delaySeconds: 120 });
    }
  }
}
