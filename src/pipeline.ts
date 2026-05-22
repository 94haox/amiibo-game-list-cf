// Shared generation pipeline.
//
// Three layers, used by the Worker scheduled handler, the batch sub-Worker,
// and the Node CLI:
//
//   - processOneAmiibo: per-amiibo fetch + parse + match
//   - runPool / orchestration helpers
//   - runFullGeneration: the in-process all-in-one driver used by the CLI
//
// The Worker scheduled handler doesn't call runFullGeneration directly —
// it caches datasets to R2 and dispatches batches through a service binding
// to the batch sub-Worker (see src/batch-worker.ts) so each batch gets its
// own subrequest budget.

import { buildAmiiboContext, buildAmiiboUrl, cleanedName } from "./amiibo.js";
import { loadAllDatasets, loadWiiUDataset, type BaseDatasets } from "./datasets.js";
import { NotFoundError, fetchTextWithRetry } from "./fetch-retry.js";
import { hexCompare, normalizeHex } from "./hex.js";
import { log } from "./log.js";
import { parseAmiiboPage } from "./parser.js";
import { serializeAmiibos } from "./serialize.js";
import type { AmiiboDatabaseRaw, AmiiboKeyValue, DSRelease, Games } from "./types.js";

// ---------------------------------------------------------------------------
// Per-amiibo processing
// ---------------------------------------------------------------------------

const emptyGames = (): Games => ({
  games3DS: [],
  gamesWiiU: [],
  gamesSwitch: [],
  gamesSwitch2: [],
});

export async function processOneAmiibo(
  datasets: BaseDatasets,
  amiiboId: string,
  raw: { name: string },
): Promise<{ games: Games; missing: string[] }> {
  const ctx = buildAmiiboContext(datasets.amiibo, amiiboId, raw);
  const cleaned = cleanedName(ctx.originalName);
  const url = await buildAmiiboUrl(ctx);
  try {
    const html = await fetchTextWithRetry(url);
    return parseAmiiboPage(html, { amiiboName: cleaned, datasets });
  } catch (err) {
    if (err instanceof NotFoundError) {
      log.warn(`404 amiibo.life for ${cleaned} (${ctx.originalName})`);
      return { games: emptyGames(), missing: [] };
    }
    throw err;
  }
}

export async function runPool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const loop = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => loop(),
  );
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Compact dataset cache — for R2-mediated transfer to the batch sub-Worker
// ---------------------------------------------------------------------------

export interface CompactDatasets {
  amiibo: AmiiboDatabaseRaw;
  /** Map.entries() output — re-Map on the consuming side. */
  switchIndex: Array<[string, string[]]>;
  ds: DSRelease[];
  // wiiu and the switch2 supplement are bundled into the Worker JS so they
  // don't need to be cached separately.
}

export async function buildCompactDatasets(): Promise<CompactDatasets> {
  const datasets = await loadAllDatasets();
  return {
    amiibo: datasets.amiibo,
    switchIndex: Array.from(datasets.switchIndex.entries()),
    ds: datasets.ds,
  };
}

export function rehydrateDatasets(compact: CompactDatasets): BaseDatasets {
  const switchIndex = new Map(compact.switchIndex);
  return {
    amiibo: compact.amiibo,
    switchIndex,
    switch2Index: switchIndex,
    wiiu: loadWiiUDataset(),
    ds: compact.ds,
  };
}

// ---------------------------------------------------------------------------
// Final output assembly
// ---------------------------------------------------------------------------

export interface SerializedOutput {
  body: string;
  bytes: number;
}

export function assembleFinalOutput(exportMap: Record<string, Games>): SerializedOutput {
  const sortedKeys = Object.keys(exportMap).sort(hexCompare);
  const ordered: Record<string, Games> = {};
  for (const k of sortedKeys) {
    const entry = exportMap[k];
    if (entry !== undefined) ordered[k] = entry;
  }
  const payload: AmiiboKeyValue = { amiibos: ordered };
  const body = serializeAmiibos(payload);
  return { body, bytes: body.length };
}

// ---------------------------------------------------------------------------
// In-process all-in-one driver (used by the Node CLI / GitHub Actions)
// ---------------------------------------------------------------------------

export interface RunResult extends SerializedOutput {
  missing: string[];
  totalAmiibo: number;
}

export interface RunOptions {
  concurrency?: number;
  /** Stop after the first N amiibo — meant for smoke tests, not production. */
  limit?: number | null;
  onProgress?: (done: number, total: number, name: string) => void;
}

export async function runFullGeneration(options: RunOptions = {}): Promise<RunResult> {
  const concurrency = options.concurrency ?? 8;

  log.info("Loading datasets…");
  const datasets = await loadAllDatasets();
  log.info(
    `Loaded amiibo=${Object.keys(datasets.amiibo.amiibos).length} switch=${datasets.switchIndex.size} 3ds=${datasets.ds.length} wiiu=${datasets.wiiu.length}`,
  );

  let entries = Object.entries(datasets.amiibo.amiibos);
  if (options.limit != null) entries = entries.slice(0, options.limit);
  const total = entries.length;
  log.info(`Processing ${total} amiibo (concurrency=${concurrency})…`);

  const exportMap: Record<string, Games> = {};
  const missing = new Set<string>();
  let done = 0;

  await runPool(
    entries,
    async ([id, raw]) => {
      const result = await processOneAmiibo(datasets, id, raw);
      exportMap[normalizeHex(id)] = result.games;
      for (const m of result.missing) missing.add(m);
      done++;
      options.onProgress?.(done, total, raw.name);
    },
    concurrency,
  );

  const out = assembleFinalOutput(exportMap);
  const missingList = [...missing].sort();
  if (missingList.length > 0) {
    log.warn(`${missingList.length} games missing titleids`);
  }

  return {
    body: out.body,
    bytes: out.bytes,
    missing: missingList,
    totalAmiibo: total,
  };
}
