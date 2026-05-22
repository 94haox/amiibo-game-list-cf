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

The pipeline is split across two Workers connected by a service binding:

- **`amiibo-game-list`** (parent, `src/index.ts` + `src/scheduled.ts`):
  cron-triggered orchestrator. Loads + caches datasets, dispatches batches
  through the service binding, merges results, writes outputs to R2,
  optionally commits to GitHub. Spends ~15 subrequests per run.
- **`amiibo-game-list-batch`** (child, `src/batch-worker.ts`):
  service-binding-only Worker. Reads the cached datasets from R2 and
  processes ~200 amiibo per invocation. Each call to it counts as **one**
  subrequest from the parent's view, while the child gets its **own**
  1000-subrequest budget for the amiibo.life fetches inside.

```
                              ┌─────────────────────┐
   cron (weekly) ───────────► │  parent scheduled   │
                              │  (src/scheduled.ts) │
                              └──────────┬──────────┘
                                         │ 1. buildCompactDatasets()
                                         │ 2. R2 put runs/<id>/datasets.json
                                         │ 3. slice 932 amiibo → 5 batches of 200
                                         │ 4. Promise.all(BATCH.fetch × 5) ── 5 subrequests
                                         ▼
                            ┌─────────────────────────┐
                            │  BATCH service binding  │
                            └──────────┬──────────────┘
                                       │  (per-batch isolate, own subrequest budget)
                                       ▼
                            ┌──────────────────────┐
                            │ batch sub-Worker     │
                            │ (src/batch-worker.ts)│
                            │  · R2 get cache      │   1 subrequest
                            │  · pool: 200 amiibo  │ ~210 subrequests
                            │  · return results    │
                            └──────────┬───────────┘
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │ parent merge + sort  │
                            │  · R2 put games_info │
                            │  · R2 put missing    │
                            │  · R2 put latest     │
                            │  · GitHub commit*    │
                            └──────────────────────┘
```

`*` GitHub commit only fires when `ENABLE_GITHUB_COMMIT=true` and a
`GITHUB_TOKEN` secret is configured.

`src/cli.ts` calls `runFullGeneration` directly (in-process, no service
binding). This is the path GitHub Actions exercises — it shares
`processOneAmiibo`, the matchers, and the serializer with both Workers,
so a green CI run still tells you the parsing/matching layer is sound;
only the parent↔child plumbing is Worker-specific and is exercised the
first time you `wrangler deploy`.

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

# Secrets — set against the parent worker. The batch worker doesn't need any.
wrangler secret put GITHUB_TOKEN          # PAT with `contents:write` on the target repo
wrangler secret put INTERNAL_TRIGGER_KEY  # any random string used by POST /trigger

# Vars — edit wrangler.toml (parent) or override per environment
#   ENABLE_GITHUB_COMMIT=true     turn on the GitHub commit step
#   GITHUB_OWNER=N3evin           target repo owner
#   GITHUB_REPO=AmiiboAPI         target repo name
#   GITHUB_BRANCH=master          target branch
#   GITHUB_PATH=database/games_info.json   path inside the repo

npm install
npm run typecheck

# Order matters: deploy the child first so the parent's service binding
# can resolve it on first invocation. `npm run deploy` does both:
npm run deploy
#   ↳ wrangler deploy --config wrangler.batch.toml   # child first
#   ↳ wrangler deploy                                # parent
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
  peaks at ~2× the text size during parsing, so the parent Worker may bump
  up against the memory ceiling while building the compact dataset blob.
  If you see OOMs in production logs, the next step is to pre-compact
  titledb on a separate trigger and only persist the `name → ids` slice.
  The child worker is fine — it only sees the small compact blob.
- **Subrequest limit (1000/request)**: addressed by the parent/child split.
  Parent spends ~15 subrequests per run (3 upstream loads + 1 cache put +
  N service-binding calls + 3 output puts + cleanup + GitHub). Each child
  invocation spends ~210 (1 cache read + 200 amiibo fetches + retries).
  Both sit well below the 1000 cap.

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
| `Program.Main`               | `src/scheduled.ts` + `src/pipeline.ts` |
| `Parallel.ForEach`           | `src/batch-worker.ts` (service binding fan-out) |
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
