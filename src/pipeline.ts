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

import {
  amiiboSeries,
  amiiboType,
  buildAmiiboContext,
  buildAmiiboUrl,
  characterName,
  cleanedName,
} from "./amiibo.js";
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
  processedAmiibo: number;
  reusedAmiibo: number;
  forceFullReason: string | null;
}

export interface RunOptions {
  concurrency?: number;
  /** Stop after the first N amiibo — meant for smoke tests, not production. */
  limit?: number | null;
  /** Local amiibo.json path; bypasses the N3evin/AmiiboAPI HTTP fetch. */
  amiiboDatabasePath?: string | null;
  /** Previous amiibo database used to decide which entries can be reused. */
  previousAmiibo?: AmiiboDatabaseRaw | null;
  /** Previous games_info.json output to reuse unchanged entries from. */
  previousGames?: AmiiboKeyValue | null;
  /** Enable reuse from previousAmiibo + previousGames when available. */
  incremental?: boolean;
  /** Ignore previous inputs and process all selected amiibo. */
  forceFull?: boolean;
  onProgress?: (done: number, total: number, name: string) => void;
}

export type AmiiboProcessor = typeof processOneAmiibo;

export interface IncrementalPlan {
  processIds: string[];
  reusedIds: string[];
  reusedGames: Record<string, Games>;
  forceFullReason: string | null;
}

interface GenerationWithDatasetsOptions extends Omit<RunOptions, "amiiboDatabasePath"> {
  processor?: AmiiboProcessor;
}

function amiiboFingerprint(
  database: AmiiboDatabaseRaw,
  id: string,
  raw: { name: string },
): string {
  const ctx = buildAmiiboContext(database, id, raw);
  return JSON.stringify({
    name: raw.name,
    series: amiiboSeries(ctx),
    character: characterName(ctx),
    type: amiiboType(ctx),
    release: "release" in raw ? raw.release : undefined,
  });
}

function previousGamesFor(
  previousGames: AmiiboKeyValue,
  id: string,
): Games | undefined {
  const normalized = normalizeHex(id);
  return previousGames.amiibos[normalized] ?? previousGames.amiibos[id];
}

export function buildIncrementalPlan(
  datasets: BaseDatasets,
  inputs: {
    previousAmiibo?: AmiiboDatabaseRaw | null;
    previousGames?: AmiiboKeyValue | null;
    forceFull?: boolean;
  } = {},
): IncrementalPlan {
  const currentIds = Object.keys(datasets.amiibo.amiibos);
  if (inputs.forceFull) {
    return {
      processIds: currentIds,
      reusedIds: [],
      reusedGames: {},
      forceFullReason: "forced",
    };
  }
  if (!inputs.previousAmiibo || !inputs.previousGames) {
    return {
      processIds: currentIds,
      reusedIds: [],
      reusedGames: {},
      forceFullReason: "missing previous amiibo or games_info",
    };
  }

  const processIds: string[] = [];
  const reusedIds: string[] = [];
  const reusedGames: Record<string, Games> = {};

  for (const [id, raw] of Object.entries(datasets.amiibo.amiibos)) {
    const normalized = normalizeHex(id);
    const previousRaw = inputs.previousAmiibo.amiibos[id] ?? inputs.previousAmiibo.amiibos[normalized];
    const previousGame = previousGamesFor(inputs.previousGames, id);
    if (!previousRaw || !previousGame) {
      processIds.push(id);
      continue;
    }
    const currentFingerprint = amiiboFingerprint(datasets.amiibo, id, raw);
    const previousFingerprint = amiiboFingerprint(inputs.previousAmiibo, id, previousRaw);
    if (currentFingerprint !== previousFingerprint) {
      processIds.push(id);
      continue;
    }
    reusedIds.push(normalized);
    reusedGames[normalized] = previousGame;
  }

  return {
    processIds,
    reusedIds,
    reusedGames,
    forceFullReason: null,
  };
}

export async function runGenerationWithDatasets(
  datasets: BaseDatasets,
  options: GenerationWithDatasetsOptions = {},
): Promise<RunResult> {
  const concurrency = options.concurrency ?? 8;
  const processor = options.processor ?? processOneAmiibo;
  const hasPrevious = Boolean(options.previousAmiibo && options.previousGames);
  const incremental = options.incremental ?? hasPrevious;
  const plan = incremental || options.forceFull
    ? buildIncrementalPlan(datasets, {
        previousAmiibo: options.previousAmiibo ?? null,
        previousGames: options.previousGames ?? null,
        forceFull: options.forceFull ?? false,
      })
    : {
        processIds: Object.keys(datasets.amiibo.amiibos),
        reusedIds: [],
        reusedGames: {},
        forceFullReason: null,
      };

  let selectedEntries = Object.entries(datasets.amiibo.amiibos);
  if (options.limit != null) selectedEntries = selectedEntries.slice(0, options.limit);
  const selectedIds = new Set(selectedEntries.map(([id]) => id));
  const processIds = plan.processIds.filter((id) => selectedIds.has(id));
  const total = selectedEntries.length;

  log.info(
    `Processing ${processIds.length}/${total} amiibo (reusing ${total - processIds.length}, concurrency=${concurrency})…`,
  );
  if (plan.forceFullReason) {
    log.info(`Incremental reuse disabled: ${plan.forceFullReason}`);
  }

  const exportMap: Record<string, Games> = {};
  for (const [id] of selectedEntries) {
    const normalized = normalizeHex(id);
    const reused = plan.reusedGames[normalized];
    if (reused) exportMap[normalized] = reused;
  }

  const missing = new Set<string>();
  let done = 0;

  await runPool(
    processIds,
    async (id) => {
      const raw = datasets.amiibo.amiibos[id];
      if (!raw) return;
      const result = await processor(datasets, id, raw);
      exportMap[normalizeHex(id)] = result.games;
      for (const m of result.missing) missing.add(m);
      done++;
      options.onProgress?.(done, processIds.length, raw.name);
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
    processedAmiibo: processIds.length,
    reusedAmiibo: total - processIds.length,
    forceFullReason: plan.forceFullReason,
  };
}

export async function runFullGeneration(options: RunOptions = {}): Promise<RunResult> {
  log.info("Loading datasets…");
  const datasets = await loadAllDatasets({
    amiiboDatabasePath: options.amiiboDatabasePath ?? null,
  });
  log.info(
    `Loaded amiibo=${Object.keys(datasets.amiibo.amiibos).length} switch=${datasets.switchIndex.size} 3ds=${datasets.ds.length} wiiu=${datasets.wiiu.length}`,
  );

  return runGenerationWithDatasets(datasets, options);
}
