// Loaders for the upstream datasets the generator depends on.

import { XMLParser } from "fast-xml-parser";

import { amiiboSeries, buildAmiiboContext } from "./amiibo.js";
import { fetchBytesWithRetry, fetchJsonWithRetry, fetchTextWithRetry } from "./fetch-retry.js";
import { normalizeHex } from "./hex.js";
import { log } from "./log.js";
import { normalizeTitleKey } from "./text.js";
import type { AmiiboDatabaseRaw, BlawarEntry, DSRelease, WiiUGame } from "./types.js";
import wiiuDataset from "./resources/wiiu.json";
import switch2Supplement from "./resources/switch2.json";

interface Switch2SupplementEntry {
  id: string;
  name: string;
  source?: string;
  comment?: string;
}

export const AMIIBO_DB_URL =
  "https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json";
export const TITLEDB_URL =
  "https://raw.githubusercontent.com/blawar/titledb/master/US.en.json";
export const DSDB_URL = "http://3dsdb.com/xml.php";
export const AMIIBO_LIFE_FIGURES_URL = "https://amiibo.life/figures.json";

export interface BaseDatasets {
  amiibo: AmiiboDatabaseRaw;
  amiiboLifeUrls: Map<string, string>; // key: normalized amiibo id -> canonical detail URL
  switchIndex: Map<string, string[]>;  // key: normalized name -> list of title ids
  switch2Index: Map<string, string[]>; // same shape, Switch 2 titles
  wiiu: WiiUGame[];
  ds: DSRelease[];
}

export interface AmiiboLifeFigure {
  name?: unknown;
  series_name?: unknown;
  url?: unknown;
}

interface IndexedAmiiboLifeFigure {
  url: string;
  fullName: string;
  withoutSplatoon: string;
  withoutParentheses: string;
  beforeAnd: string;
}

/** Build a lowercase-name -> ids lookup map, mirroring the C# Lookup<string, string>. */
function buildTitleIndex(raw: Record<string, BlawarEntry>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const entry of Object.values(raw)) {
    if (!entry || !entry.id || !entry.name) continue;
    const key = normalizeTitleKey(entry.name);
    const bucket = index.get(key);
    if (bucket) bucket.push(entry.id);
    else index.set(key, [entry.id]);
  }
  return index;
}

export async function loadAmiiboDatabase(): Promise<AmiiboDatabaseRaw> {
  return fetchJsonWithRetry<AmiiboDatabaseRaw>(AMIIBO_DB_URL);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAmiiboName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSeriesName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bthe\b/g, "")
    .replace(/\s+series\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeSplatoonToken(value: string): string {
  return value
    .replace(/\bsplatoon\b/g, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function removeParentheticalText(value: string): string {
  return value.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

function nameBeforeAnd(value: string): string {
  return value.split(" and ", 1)[0]?.trim() ?? value;
}

function matchScore(name: string, candidate: IndexedAmiiboLifeFigure): number {
  if (name === candidate.fullName) return 100;
  if (removeSplatoonToken(name) === candidate.withoutSplatoon) return 95;
  if (removeParentheticalText(name) === candidate.withoutParentheses) return 85;
  if (nameBeforeAnd(name) === candidate.beforeAnd) return 70;
  return 0;
}

function canonicalAmiiboLifeUrl(value: string): string | null {
  if (value.startsWith("/amiibo/")) return `https://amiibo.life${value}`;
  if (value.startsWith("https://amiibo.life/amiibo/")) return value;
  return null;
}

/** Resolve canonical amiibo.life detail URLs from its structured catalogue.
 *  Matching is series-scoped where possible, and ambiguous fuzzy matches are
 *  deliberately ignored so the legacy URL builder can handle them safely.
 */
export function buildAmiiboLifeUrlIndex(
  database: AmiiboDatabaseRaw,
  figures: AmiiboLifeFigure[],
): Map<string, string> {
  const all: IndexedAmiiboLifeFigure[] = [];
  const bySeries = new Map<string, IndexedAmiiboLifeFigure[]>();

  for (const figure of figures) {
    const name = stringValue(figure.name);
    const rawUrl = stringValue(figure.url);
    const url = rawUrl ? canonicalAmiiboLifeUrl(rawUrl) : null;
    if (!name || !url) continue;

    const fullName = normalizeAmiiboName(name);
    const indexed: IndexedAmiiboLifeFigure = {
      url,
      fullName,
      withoutSplatoon: removeSplatoonToken(fullName),
      withoutParentheses: removeParentheticalText(fullName),
      beforeAnd: nameBeforeAnd(fullName),
    };
    all.push(indexed);

    const series = stringValue(figure.series_name);
    if (!series) continue;
    const seriesKey = normalizeSeriesName(series);
    const candidates = bySeries.get(seriesKey) ?? [];
    candidates.push(indexed);
    bySeries.set(seriesKey, candidates);
  }

  const urls = new Map<string, string>();
  for (const [id, raw] of Object.entries(database.amiibos)) {
    const ctx = buildAmiiboContext(database, id, raw);
    const seriesCandidates = bySeries.get(normalizeSeriesName(amiiboSeries(ctx))) ?? [];
    const candidates = seriesCandidates.length > 0 ? seriesCandidates : all;
    const name = normalizeAmiiboName(raw.name);
    let best: IndexedAmiiboLifeFigure | null = null;
    let bestScore = 0;
    let ambiguous = false;

    for (const candidate of candidates) {
      const score = matchScore(name, candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
        ambiguous = false;
      } else if (score > 0 && score === bestScore) {
        ambiguous = true;
      }
    }

    if (best && bestScore >= 70 && !ambiguous) {
      urls.set(normalizeHex(id), best.url);
    }
  }

  return urls;
}

async function loadAmiiboLifeFigures(): Promise<AmiiboLifeFigure[]> {
  try {
    const value = await fetchJsonWithRetry<unknown>(AMIIBO_LIFE_FIGURES_URL);
    return Array.isArray(value)
      ? value.filter((item): item is AmiiboLifeFigure => typeof item === "object" && item !== null)
      : [];
  } catch (error) {
    log.warn(`Failed to load amiibo.life figure catalogue: ${(error as Error).message}`);
    return [];
  }
}

/** Read amiibo.json from the local filesystem. Node-only — used by the CLI
 *  when the caller supplies their own pre-synced amiibo database (the same
 *  role as the original C# generator's `-i` flag).
 */
export async function loadAmiiboDatabaseFromFile(
  path: string,
): Promise<AmiiboDatabaseRaw> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as AmiiboDatabaseRaw;
}

/** Layer the local switch2 supplement on top of the index — only adding
 *  keys that titledb doesn't already cover, so upstream always wins.
 *
 *  blawar/titledb is archived (2024-02) and currently has zero `7001xxxx`
 *  Switch 2 entries, so for Switch 2 games we maintain a hand-curated
 *  src/resources/switch2.json. Replace this once any upstream titledb fork
 *  ships native Switch 2 coverage.
 */
function layerSwitch2Supplement(index: Map<string, string[]>): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (const entry of switch2Supplement as Switch2SupplementEntry[]) {
    if (!entry?.id || !entry?.name) continue;
    const key = normalizeTitleKey(entry.name);
    if (index.has(key)) {
      skipped++;
      continue;
    }
    index.set(key, [entry.id]);
    added++;
  }
  return { added, skipped };
}

export async function loadSwitchTitleDb(): Promise<{
  switchIndex: Map<string, string[]>;
  switch2Index: Map<string, string[]>;
}> {
  const text = await fetchTextWithRetry(TITLEDB_URL);
  // The titledb file is keyed by title id (hex). We parse once and re-bucket
  // for Switch vs Switch 2. blawar's file is a flat dict; the platform split
  // is determined by the amiibo.life HTML tag, not by the titledb.
  const raw = JSON.parse(text) as Record<string, BlawarEntry>;
  const switchIndex = buildTitleIndex(raw);
  // titledb has no 7001xxxx entries today; the supplement file fills the gap
  // for known Switch 2 amiibo-relevant games. titledb wins on collisions.
  const { added, skipped } = layerSwitch2Supplement(switchIndex);
  log.info(`Switch 2 supplement: added=${added} skipped=${skipped} (titledb wins on collision)`);
  // Switch 2 entries share the index — the amiibo.life HTML tag disambiguates.
  return { switchIndex, switch2Index: switchIndex };
}

export async function loadDSDatabase(): Promise<DSRelease[]> {
  // 3dsdb returns XML. Worker's fetch returns a stream — read bytes and parse.
  const bytes = await fetchBytesWithRetry(DSDB_URL);
  const xml = new TextDecoder("utf-8").decode(bytes);
  // textNodeName ensures empty <name/> elements coerce to "" instead of {}.
  const parser = new XMLParser({ ignoreAttributes: true, trimValues: true, parseTagValue: false });
  const parsed = parser.parse(xml) as { releases?: { release?: unknown } };
  const releases = parsed.releases?.release;
  if (!releases) return [];
  const list = Array.isArray(releases) ? releases : [releases];
  return list
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      name: typeof r.name === "string" ? r.name : "",
      titleid: typeof r.titleid === "string" ? r.titleid : "",
    }))
    .filter((r) => r.name && r.titleid);
}

export function loadWiiUDataset(): WiiUGame[] {
  // Bundled at build time from src/resources/wiiu.json.
  return wiiuDataset as WiiUGame[];
}

export interface LoadDatasetsOptions {
  /** If set, read amiibo.json from this local file instead of fetching the
   *  N3evin/AmiiboAPI upstream. Mirrors the original C# generator's `-i`
   *  flag — useful when a downstream pipeline (e.g. boon_hono) supplies its
   *  own pre-synced amiibo database. Node-only. */
  amiiboDatabasePath?: string | null;
}

export async function loadAllDatasets(
  options: LoadDatasetsOptions = {},
): Promise<BaseDatasets> {
  const amiiboLoader = options.amiiboDatabasePath
    ? loadAmiiboDatabaseFromFile(options.amiiboDatabasePath)
    : loadAmiiboDatabase();
  const [amiibo, switchIndices, ds, amiiboLifeFigures] = await Promise.all([
    amiiboLoader,
    loadSwitchTitleDb(),
    loadDSDatabase(),
    loadAmiiboLifeFigures(),
  ]);
  const amiiboLifeUrls = buildAmiiboLifeUrlIndex(amiibo, amiiboLifeFigures);
  log.info(
    `amiibo.life canonical URLs: matched=${amiiboLifeUrls.size}/${Object.keys(amiibo.amiibos).length}`,
  );
  return {
    amiibo,
    amiiboLifeUrls,
    switchIndex: switchIndices.switchIndex,
    switch2Index: switchIndices.switch2Index,
    wiiu: loadWiiUDataset(),
    ds,
  };
}
