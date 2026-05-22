// Standalone Node entry point — exercises the same pipeline used by the
// Worker, with a CLI for output paths and concurrency. Used by GitHub
// Actions and for local smoke tests.
//
// Usage:
//   tsx src/cli.ts [--output games_info.json] [--concurrency 8] [--limit N]
//                  [--missing missing_games.json]

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

import { log, setLevel, type Level } from "./log.js";
import { runFullGeneration } from "./pipeline.js";

interface CliOptions {
  output: string;
  missing: string;
  input: string | null;
  concurrency: number;
  limit: number | null;
  allowMissing: boolean;
  logLevel: Level;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    output: "games_info.json",
    missing: "missing_games.json",
    input: null,
    concurrency: 8,
    limit: null,
    allowMissing: false,
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
      case "-i":
      case "--input":
        opts.input = next();
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
      case "--allow-missing":
        opts.allowMissing = true;
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
  -i, --input <path>        read amiibo.json from a local file instead of
                            fetching from N3evin/AmiiboAPI
  -p, --concurrency <n>     parallel fetchers (default: 8)
      --limit <n>           process only first N amiibo (for smoke tests)
      --allow-missing       exit 0 even if some titleids couldn't be matched
                            (default: exit 1 to surface gaps)
  -l, --log <level>         verbose|info|warn|error (default: info)
  -h, --help                show this help
`);
}

async function writeOutput(path: string, body: string): Promise<void> {
  const dir = dirname(path);
  if (dir && dir !== ".") await mkdir(dir, { recursive: true });
  await writeFile(path, body);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  setLevel(opts.logLevel);

  const result = await runFullGeneration({
    concurrency: opts.concurrency,
    limit: opts.limit,
    amiiboDatabasePath: opts.input,
    onProgress: (done, total, name) => {
      log.verbose(`${String(done).padStart(3, "0")}/${total} ${name}`);
      if (done % 50 === 0 || done === total) {
        log.info(`Progress: ${done}/${total}`);
      }
    },
  });

  await writeOutput(opts.output, result.body);
  log.info(`Wrote ${opts.output}`);

  await writeOutput(opts.missing, JSON.stringify(result.missing, null, 2));
  if (result.missing.length > 0) {
    log.warn(`${result.missing.length} games missing titleids — see ${opts.missing}`);
  }

  // Exit code mirrors the original C# behaviour: 0 if clean, 1 if some
  // titleids couldn't be matched (still a successful run otherwise). With
  // --allow-missing the caller treats partial matches as a clean exit too.
  const exitCode = result.missing.length === 0 || opts.allowMissing ? 0 : 1;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
