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

## Architecture

A single cron invocation can't realistically scrape ~700 amiibo pages within a
Worker's per-request budget, so the work is fanned out through two Cloudflare
Queues with a Durable Object as the run coordinator.

```
                              ┌─────────────────────┐
   cron (weekly) ───────────► │  scheduled handler  │
                              │  (src/scheduled.ts) │
                              └────────┬────────────┘
                                       │ 1. load 4 upstream datasets
                                       │ 2. persist them to R2 as
                                       │    runs/<runId>/datasets.json
                                       │ 3. init Durable Object counter
                                       │ 4. sendBatch(JobMessage[]) for
                                       │    every amiibo
                                       ▼
                            ┌──────────────────────┐
                            │  Queue amiibo-jobs   │
                            └──────────┬───────────┘
                                       │ batched delivery
                                       ▼
                            ┌──────────────────────┐
                            │ handleAmiiboBatch    │
                            │ (src/queue.ts)       │
                            │  · cache datasets    │
                            │    per isolate       │
                            │  · fetch amiibo.life │
                            │  · parse + match     │
                            │  · KV PARTIALS put   │
                            │  · DO increment      │
                            └──────────┬───────────┘
                                       │ when DO counter == total
                                       ▼
                            ┌──────────────────────┐
                            │ Queue amiibo-finalize│
                            └──────────┬───────────┘
                                       ▼
                            ┌──────────────────────┐
                            │ finalizeRun          │
                            │ (src/finalize.ts)    │
                            │  · merge partials    │
                            │  · sort by amiibo id │
                            │  · serialize JSON    │
                            │  · R2 put            │
                            │  · GitHub commit*    │
                            │  · cleanup KV/R2     │
                            └──────────────────────┘
```

`*` GitHub commit only fires when `ENABLE_GITHUB_COMMIT=true` and a
`GITHUB_TOKEN` secret is configured.

## HTTP routes

| Route                 | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `GET /`               | latest `games_info.json` from R2            |
| `GET /games_info.json`| same as above (explicit alias)              |
| `GET /missing_games.json` | list of `Game (Platform)` pairs that didn't match |
| `GET /latest.json`    | metadata for the last completed run         |
| `GET /healthz`        | liveness probe                              |
| `POST /trigger`       | manual run trigger (Bearer auth)            |

`/trigger` requires `Authorization: Bearer <INTERNAL_TRIGGER_KEY>` and is
intended for backfills or one-off runs. Leave the secret unset to disable.

## One-time setup

```bash
# Cloudflare resources
wrangler r2 bucket create amiibo-game-list
wrangler kv namespace create PARTIALS                  # paste the id into wrangler.toml
wrangler queues create amiibo-jobs
wrangler queues create amiibo-jobs-dlq
wrangler queues create amiibo-finalize

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
npm run dev   # wrangler dev — local Worker with miniflare-backed bindings
```

The `nodejs_compat` flag is required for `fast-xml-parser`'s buffer usage.

## Determinism

CI in the original .NET project runs the generator twice and diffs the output;
this port preserves the same stabilisation:

- amiibo ids sorted by 64-bit hex value before serialization (`hexCompare`)
- per-platform game lists sorted case-insensitively by `gameName`
- `amiiboUsage` sorted by `Usage`
- title-id lists deduped + sorted
- JSON output uses two-space indent → tab replacement, matching the C# byte layout

## Mapping to the original project

| Original (`AmiiboGameList/`) | This repo                  |
| ---------------------------- | -------------------------- |
| `Program.Main`               | `src/scheduled.ts`         |
| `Program.ParseAmiibo`        | `src/parser.ts`            |
| `Program.GetAmiilifeStringAsync` | `src/fetch-retry.ts`   |
| `DBAmiibo` (URL + name)      | `src/amiibo.ts`            |
| Per-platform `switch` arms   | `src/matchers.ts`          |
| `Hex`                        | `src/hex.ts`               |
| `Properties.Resources.WiiU`  | `src/resources/wiiu.json`  |
| `Debugger`                   | `src/log.ts`               |
| File output                  | `src/finalize.ts` + R2     |

## License

GPL-3.0-or-later, same as the upstream project.
