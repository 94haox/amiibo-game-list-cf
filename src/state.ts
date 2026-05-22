// KV/R2 keying helpers. Centralised so the cron, queue consumer and finalize
// stage agree on naming.

import type { Env, JobMessage } from "../worker-configuration";
import type { BaseDatasets } from "./datasets.js";
import type { PartialResult, RunState } from "./types.js";

export function runStateKey(runId: string): string {
  return `run:${runId}:state`;
}

export function partialKey(runId: string, amiiboId: string): string {
  return `run:${runId}:result:${amiiboId.toLowerCase()}`;
}

export function partialPrefix(runId: string): string {
  return `run:${runId}:result:`;
}

export function datasetsR2Key(runId: string): string {
  return `runs/${runId}/datasets.json`;
}

export function finalOutputR2Key(): string {
  return "games_info.json";
}

export function missingOutputR2Key(): string {
  return "missing_games.json";
}

export function metadataR2Key(): string {
  return "latest.json";
}

export interface PersistedDatasets {
  amiibo: BaseDatasets["amiibo"];
  switchIndex: Record<string, string[]>;
  wiiu: BaseDatasets["wiiu"];
  ds: BaseDatasets["ds"];
}

export function datasetsToPersisted(data: BaseDatasets): PersistedDatasets {
  return {
    amiibo: data.amiibo,
    switchIndex: Object.fromEntries(data.switchIndex),
    wiiu: data.wiiu,
    ds: data.ds,
  };
}

export function datasetsFromPersisted(p: PersistedDatasets): BaseDatasets {
  const idx = new Map(Object.entries(p.switchIndex));
  return {
    amiibo: p.amiibo,
    switchIndex: idx,
    switch2Index: idx, // share — see datasets.ts comment for rationale
    wiiu: p.wiiu,
    ds: p.ds,
  };
}

export async function putRunState(env: Env, state: RunState): Promise<void> {
  await env.PARTIALS.put(runStateKey(state.runId), JSON.stringify(state), {
    expirationTtl: 60 * 60 * 24 * 3, // 3 days
  });
}

export async function getRunState(env: Env, runId: string): Promise<RunState | null> {
  return env.PARTIALS.get<RunState>(runStateKey(runId), "json");
}

export async function putPartial(env: Env, runId: string, partial: PartialResult): Promise<void> {
  await env.PARTIALS.put(partialKey(runId, partial.amiiboId), JSON.stringify(partial), {
    expirationTtl: 60 * 60 * 24 * 3,
  });
}

export async function* listPartials(env: Env, runId: string): AsyncIterable<PartialResult> {
  const prefix = partialPrefix(runId);
  let cursor: string | undefined;
  do {
    const list = await env.PARTIALS.list({ prefix, cursor });
    for (const key of list.keys) {
      const value = await env.PARTIALS.get<PartialResult>(key.name, "json");
      if (value) yield value;
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

export async function deletePartials(env: Env, runId: string): Promise<void> {
  const prefix = partialPrefix(runId);
  let cursor: string | undefined;
  do {
    const list = await env.PARTIALS.list({ prefix, cursor });
    await Promise.all(list.keys.map((k) => env.PARTIALS.delete(k.name)));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

export async function enqueueAmiiboBatch(env: Env, msgs: JobMessage[]): Promise<void> {
  if (msgs.length === 0) return;
  await env.JOBS_QUEUE.sendBatch(msgs.map((m) => ({ body: m })));
}
