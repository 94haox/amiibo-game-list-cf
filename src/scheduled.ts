// Cron entry point. Runs the full generation in a single Worker invocation,
// writes the result to R2, optionally commits to GitHub, then leaves cleanup
// in the background via ctx.waitUntil.

import type { ExecutionContext } from "@cloudflare/workers-types";

import type { Env } from "../worker-configuration";

import { log, setLevel } from "./log.js";
import { commitToGitHub } from "./outputs/github.js";
import { runFullGeneration } from "./pipeline.js";

export const FINAL_OUTPUT_KEY = "games_info.json";
export const MISSING_OUTPUT_KEY = "missing_games.json";
export const METADATA_KEY = "latest.json";

export async function runScheduledTrigger(env: Env, ctx: ExecutionContext): Promise<{
  bytes: number;
  totalAmiibo: number;
  missingCount: number;
}> {
  setLevel("info");
  const startedAt = Date.now();
  const concurrency = Number(env.PARALLELISM) || 8;

  const result = await runFullGeneration({
    concurrency,
    onProgress: (done, total) => {
      if (done % 100 === 0 || done === total) log.info(`Progress: ${done}/${total}`);
    },
  });

  await env.OUTPUT_BUCKET.put(FINAL_OUTPUT_KEY, result.body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { generatedAt: new Date().toISOString() },
  });
  log.info(`Wrote ${FINAL_OUTPUT_KEY} to R2 (${result.bytes} bytes)`);

  await env.OUTPUT_BUCKET.put(MISSING_OUTPUT_KEY, JSON.stringify(result.missing, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  const finishedAt = new Date().toISOString();
  await env.OUTPUT_BUCKET.put(
    METADATA_KEY,
    JSON.stringify({
      totalAmiibo: result.totalAmiibo,
      missingCount: result.missing.length,
      bytes: result.bytes,
      durationMs: Date.now() - startedAt,
      finishedAt,
    }),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } },
  );

  // GitHub commit runs in the foreground so failures surface to the cron run.
  try {
    await commitToGitHub(env, result.body);
  } catch (err) {
    log.error(`GitHub commit failed: ${(err as Error).message}`);
  }

  return {
    bytes: result.bytes,
    totalAmiibo: result.totalAmiibo,
    missingCount: result.missing.length,
  };
}
