// Shared generation pipeline used by both the Worker scheduled handler and
// the standalone Node CLI. Loads datasets, fans per-amiibo scraping out
// through a promise pool, then assembles the sorted output payload.

import { buildAmiiboContext, buildAmiiboUrl, cleanedName } from "./amiibo.js";
import { loadAllDatasets, type BaseDatasets } from "./datasets.js";
import { NotFoundError, fetchTextWithRetry } from "./fetch-retry.js";
import { hexCompare, normalizeHex } from "./hex.js";
import { log } from "./log.js";
import { parseAmiiboPage } from "./parser.js";
import { serializeAmiibos } from "./serialize.js";
import type { AmiiboKeyValue, Games } from "./types.js";

export interface RunResult {
  /** JSON-serialized games_info.json (tab-indented, matching C# output). */
  body: string;
  /** Sorted list of "Game (Platform)" strings the matcher couldn't resolve. */
  missing: string[];
  /** Number of amiibo processed. */
  totalAmiibo: number;
  /** Total bytes of body. */
  bytes: number;
}

export interface RunOptions {
  concurrency?: number;
  /** Stop after the first N amiibo — meant for smoke tests, not production. */
  limit?: number | null;
  /** Called after each amiibo with the running counter. */
  onProgress?: (done: number, total: number, name: string) => void;
}

const emptyGames = (): Games => ({
  games3DS: [],
  gamesWiiU: [],
  gamesSwitch: [],
  gamesSwitch2: [],
});

async function processAmiibo(
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

async function runPool<T>(
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

/** Run the full generation pipeline in one pass and return the serialized
 *  payload. Used by both the scheduled Worker handler and the Node CLI. */
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
      const result = await processAmiibo(datasets, id, raw);
      exportMap[normalizeHex(id)] = result.games;
      for (const m of result.missing) missing.add(m);
      done++;
      options.onProgress?.(done, total, raw.name);
    },
    concurrency,
  );

  const sortedKeys = Object.keys(exportMap).sort(hexCompare);
  const ordered: Record<string, Games> = {};
  for (const k of sortedKeys) {
    const entry = exportMap[k];
    if (entry !== undefined) ordered[k] = entry;
  }
  const payload: AmiiboKeyValue = { amiibos: ordered };
  const body = serializeAmiibos(payload);
  const missingList = [...missing].sort();

  if (missingList.length > 0) {
    log.warn(`${missingList.length} games missing titleids`);
  }

  return {
    body,
    missing: missingList,
    totalAmiibo: total,
    bytes: body.length,
  };
}
