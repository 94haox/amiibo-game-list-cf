// Merge per-amiibo partials into a single games_info.json, write it to R2,
// optionally commit to GitHub, then clean up KV.

import type { ExecutionContext } from "@cloudflare/workers-types";

import type { Env } from "../worker-configuration";

import { hexCompare, normalizeHex } from "./hex.js";
import { log } from "./log.js";
import { commitToGitHub } from "./outputs/github.js";
import { serializeAmiibos } from "./serialize.js";
import {
  datasetsR2Key,
  deletePartials,
  finalOutputR2Key,
  getRunState,
  listPartials,
  metadataR2Key,
  missingOutputR2Key,
} from "./state.js";
import type { AmiiboKeyValue } from "./types.js";

export async function finalizeRun(env: Env, ctx: ExecutionContext, runId: string): Promise<void> {
  const state = await getRunState(env, runId);
  if (!state) {
    log.warn(`Finalize requested for unknown runId ${runId}`);
    return;
  }
  log.info(`Finalizing run ${runId} (${state.totalAmiibo} amiibo)`);

  const sortedKeys: string[] = [];
  const amiibos: Record<string, AmiiboKeyValue["amiibos"][string]> = {};
  const missing = new Set<string>();

  for await (const partial of listPartials(env, runId)) {
    const id = normalizeHex(partial.amiiboId);
    amiibos[id] = partial.games;
    sortedKeys.push(id);
    for (const m of partial.missing) missing.add(m);
  }

  sortedKeys.sort(hexCompare);
  const ordered: Record<string, AmiiboKeyValue["amiibos"][string]> = {};
  for (const k of sortedKeys) {
    const entry = amiibos[k];
    if (entry !== undefined) ordered[k] = entry;
  }

  const payload: AmiiboKeyValue = { amiibos: ordered };
  const body = serializeAmiibos(payload);

  await env.OUTPUT_BUCKET.put(finalOutputR2Key(), body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { runId, generatedAt: new Date().toISOString() },
  });
  log.info(`Wrote ${finalOutputR2Key()} to R2 (${body.length} bytes)`);

  const missingList = [...missing].sort();
  await env.OUTPUT_BUCKET.put(missingOutputR2Key(), JSON.stringify(missingList, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { runId },
  });
  if (missingList.length > 0) {
    log.warn(`${missingList.length} games missing titleids — see ${missingOutputR2Key()}`);
  }

  await env.OUTPUT_BUCKET.put(
    metadataR2Key(),
    JSON.stringify({
      runId,
      totalAmiibo: state.totalAmiibo,
      missingCount: missingList.length,
      bytes: body.length,
      finishedAt: new Date().toISOString(),
    }),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } },
  );

  try {
    await commitToGitHub(env, body);
  } catch (err) {
    log.error(`GitHub commit failed: ${(err as Error).message}`);
  }

  // Cleanup KV partials and the intermediate R2 dataset blob in the
  // background — finalize itself is already done.
  ctx.waitUntil(
    (async () => {
      await deletePartials(env, runId);
      await env.OUTPUT_BUCKET.delete(datasetsR2Key(runId));
      log.info(`Cleanup done for run ${runId}`);
    })(),
  );
}
