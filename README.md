# amiibo-game-list-cf

Cloudflare Worker that regenerates [AmiiboAPI](https://github.com/N3evin/AmiiboAPI)'s
`games_info.json` on a cron schedule. Node.js/TypeScript port of
[`AmiiboGameListGenerator`](https://github.com/N3evin/AmiiboGameListGenerator).

The generator scrapes individual amiibo pages from `amiibo.life` and matches
the listed games against four upstream title-id databases:

- N3evin/AmiiboAPI `amiibo.json` (the canonical amiibo list)
- blawar/titledb `US.en.json` (Switch + Switch 2)
- 3dsdb.com (3DS)
- a bundled `WiiU.json` (the same blob that ships in the original .NET project)
- a bundled `switch2.json` supplement for the handful of Switch 2 games
  titledb hasn't indexed yet — titledb wins on collision

## Architecture

The scheduled handler runs the whole pipeline in one Worker invocation.
End-to-end takes ~2.5 minutes wall-clock for ~930 amiibo at concurrency 8 —
well inside a scheduled Worker's 15-minute wall-clock budget, with the
remainder being network I/O rather than CPU.

```
                              ┌─────────────────────┐
   cron (weekly) ───────────► │  scheduled handler  │
                              │  (src/scheduled.ts) │
                              └──────────┬──────────┘
                                         │
                                         ▼
                            ┌──────────────────────┐
                            │  runFullGeneration   │
                            │  (src/pipeline.ts)   │
                            │  · load 4 datasets   │
                            │  · promise pool      │
                            │    (8x concurrent)   │
                            │  · per-amiibo fetch  │
                            │    parse + match     │
                            │  · sort + serialize  │
                            └──────────┬───────────┘
                                       │
                ┌──────────────────────┼──────────────────────┐
                ▼                      ▼                      ▼
        ┌──────────────┐      ┌──────────────────┐    ┌────────────────┐
        │ R2 put       │      │ R2 put           │    │ GitHub commit  │
        │ games_info   │      │ missing_games    │    │ (optional)     │
        │ + latest     │      │                  │    │                │
        └──────────────┘      └──────────────────┘    └────────────────┘
```

GitHub commit only fires when `ENABLE_GITHUB_COMMIT=true` and a
`GITHUB_TOKEN` secret is configured.

The same `runFullGeneration` powers `src/cli.ts`, so GitHub Actions runs
exactly the code that will run on Cloudflare.

## HTTP routes

| Route                 | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `GET /`               | latest `games_info.json` from R2            |
| `GET /games_info.json`| same as above (explicit alias)              |
| `GET /missing_games.json` | list of `Game (Platform)` pairs that didn't match |
| `GET /latest.json`    | metadata for the last completed run         |
| `GET /healthz`        | liveness probe                              |
| `POST /trigger`       | manual run trigger (Bearer auth)            |

`/trigger` requires `Authorization: Bearer <INTERNAL_TRIGGER_KEY>` and runs
the generation in the background (`ctx.waitUntil`). Leave the secret unset to
disable.

## One-time setup

```bash
# Cloudflare resource — only the R2 bucket is required
wrangler r2 bucket create amiibo-game-list

# Secrets (only set what you need)
wrangler secret put GITHUB_TOKEN          # PAT with `contents:write` on the target repo
wrangler secret put INTERNAL_TRIGGER_KEY  # any random string used by POST /trigger

# Vars — set in wrangler.toml or override per environment
#   ENABLE_GITHUB_COMMIT=true     turn on the GitHub commit step
#   GITHUB_OWNER=N3evin           target repo owner
#   GITHUB_REPO=AmiiboAPI         target repo name
#   GITHUB_BRANCH=master          target branch
#   GITHUB_PATH=database/games_info.json   path inside the repo

npm install
npm run typecheck
npm run deploy
```

## Local development

```bash
npm install
npm run dev           # wrangler dev — local Worker with miniflare-backed R2
npm run generate      # Node CLI — runs the whole pipeline, writes to disk
npm run generate:smoke -- --limit 20   # quick 20-amiibo end-to-end check
```

The `nodejs_compat` flag is required for `fast-xml-parser`'s buffer usage.

## Known constraints

- **Worker memory (128 MB)**: blawar's `US.en.json` is ~85 MB. `JSON.parse`
  peaks at ~2× the text size during parsing, so the Worker may bump up
  against the memory ceiling. If you see OOMs in production logs, the next
  step is to pre-compact titledb (name + id only) into a cached R2 blob and
  load that instead.
- **Subrequest limit (1000/request)**: ~932 amiibo + 3 dataset fetches sits
  close to the limit. Retries are bounded; if a run starts failing with
  `1101` (subrequest cap), partitioning the work back across multiple
  invocations is the fix — `git log` has the previous Queue+Durable Object
  implementation if you need to bring it back.

## Determinism

CI in the original .NET project runs the generator twice and diffs the output;
this port preserves the same stabilisation:

- amiibo ids sorted by 64-bit hex value before serialization (`hexCompare`)
- per-platform game lists sorted case-insensitively by `gameName`
- `amiiboUsage` sorted by `Usage`
- title-id lists deduped + sorted
- JSON output uses two-space indent → tab replacement, matching the C# byte layout

## Mapping to the original project

| Original (`AmiiboGameList/`) | This repo                       |
| ---------------------------- | ------------------------------- |
| `Program.Main`               | `src/pipeline.ts`               |
| `Program.ParseAmiibo`        | `src/parser.ts`                 |
| `Program.GetAmiilifeStringAsync` | `src/fetch-retry.ts`        |
| `DBAmiibo` (URL + name)      | `src/amiibo.ts`                 |
| Per-platform `switch` arms   | `src/matchers.ts`               |
| `Hex`                        | `src/hex.ts`                    |
| `Properties.Resources.WiiU`  | `src/resources/wiiu.json`       |
| Switch 2 hardcoded patches   | `src/resources/switch2.json`    |
| `Debugger`                   | `src/log.ts`                    |
| File output                  | `src/scheduled.ts` + R2         |

## License

GPL-3.0-or-later, same as the upstream project.
