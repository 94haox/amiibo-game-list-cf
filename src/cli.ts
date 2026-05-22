// Standalone Node entry point. Reuses the same modules as the Worker but
// drives them sequentially (with a small concurrency pool) and writes the
// result to disk — meant for CI verification and local sanity checks.
//
// Usage:
//   tsx src/cli.ts [--output games_info.json] [--concurrency 8] [--limit N]
//                  [--missing missing_games.json]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

import { buildAmiiboContext, buildAmiiboUrl, cleanedName } from "./amiibo.js";
import { loadAllDatasets } from "./datasets.js";
import { NotFoundError, fetchTextWithRetry } from "./fetch-retry.js";
import { hexCompare, normalizeHex } from "./hex.js";
import { log, setLevel, type Level } from "./log.js";
import { parseAmiiboPage } from "./parser.js";
import { serializeAmiibos } from "./serialize.js";
import type { AmiiboKeyValue, Games } from "./types.js";

interface CliOptions {
  output: string;
  missing: string;
  concurrency: number;
  limit: number | null;
  logLevel: Level;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    output: "games_info.json",
    missing: "missing_games.json",
    concurrency: 8,
    limit: null,
    logLevel: "info",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i++;
      return value;
    };
    switch (arg) {
      case "-o":
      case "--output":
        opts.output = next();
        break;
      case "--missing":
        opts.missing = next();
        break;
      case "-p":
      case "--concurrency":
        opts.concurrency = Number(next());
        if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
          throw new Error(`Invalid concurrency: ${opts.concurrency}`);
        }
        break;
      case "--limit":
        opts.limit = Number(next());
        if (!Number.isInteger(opts.limit) || opts.limit < 1) {
          throw new Error(`Invalid limit: ${opts.limit}`);
        }
        break;
      case "-l":
      case "--log":
        opts.logLevel = next() as Level;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown arg: ${arg}`);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: tsx src/cli.ts [options]

  -o, --output <path>       output JSON path (default: games_info.json)
      --missing <path>      missing games JSON path (default: missing_games.json)
  -p, --concurrency <n>     parallel fetchers (default: 8)
      --limit <n>           process only first N amiibo (for smoke tests)
  -l, --log <level>         verbose|info|warn|error (default: info)
  -h, --help                show this help
`);
}

async function processOne(
  datasets: Awaited<ReturnType<typeof loadAllDatasets>>,
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
      return {
        games: { games3DS: [], gamesWiiU: [], gamesSwitch: [], gamesSwitch2: [] },
        missing: [],
      };
    }
    throw err;
  }
}

async function runPool<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
  onDone?: (index: number, total: number, item: T) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let completed = 0;
  const total = items.length;

  async function loop(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index]!;
      results[index] = await worker(item);
      completed++;
      onDone?.(completed, total, item);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => loop());
  await Promise.all(workers);
  return results;
}

async function writeOutput(path: string, body: string): Promise<void> {
  const dir = dirname(path);
  if (dir && dir !== ".") await mkdir(dir, { recursive: true });
  await writeFile(path, body);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  setLevel(opts.logLevel);

  log.info("Loading datasets…");
  const datasets = await loadAllDatasets();
  log.info(`Loaded amiibo=${Object.keys(datasets.amiibo.amiibos).length} switch=${datasets.switchIndex.size} 3ds=${datasets.ds.length} wiiu=${datasets.wiiu.length}`);

  let entries = Object.entries(datasets.amiibo.amiibos);
  if (opts.limit !== null) entries = entries.slice(0, opts.limit);

  log.info(`Processing ${entries.length} amiibo (concurrency=${opts.concurrency})…`);

  const allMissing = new Set<string>();
  const exportMap: Record<string, Games> = {};

  await runPool(
    entries,
    async ([id, raw]) => {
      const result = await processOne(datasets, id, raw);
      exportMap[normalizeHex(id)] = result.games;
      for (const m of result.missing) allMissing.add(m);
      return result;
    },
    opts.concurrency,
    (done, total, [, raw]) => {
      log.verbose(`${String(done).padStart(3, "0")}/${total} ${raw.name}`);
      if (done % 50 === 0 || done === total) {
        log.info(`Progress: ${done}/${total}`);
      }
    },
  );

  const sortedKeys = Object.keys(exportMap).sort(hexCompare);
  const ordered: Record<string, Games> = {};
  for (const k of sortedKeys) {
    const entry = exportMap[k];
    if (entry !== undefined) ordered[k] = entry;
  }
  const payload: AmiiboKeyValue = { amiibos: ordered };

  await writeOutput(opts.output, serializeAmiibos(payload));
  log.info(`Wrote ${opts.output}`);

  const missingSorted = [...allMissing].sort();
  await writeOutput(opts.missing, JSON.stringify(missingSorted, null, 2));
  if (missingSorted.length > 0) {
    log.warn(`${missingSorted.length} games missing titleids — see ${opts.missing}`);
  }

  // Exit code mirrors the C# original: 0 if clean, 1 if some titleids missing.
  process.exit(missingSorted.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
