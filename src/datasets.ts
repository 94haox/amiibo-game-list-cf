// Loaders for the four upstream datasets the generator depends on.

import { XMLParser } from "fast-xml-parser";

import { fetchBytesWithRetry, fetchJsonWithRetry, fetchTextWithRetry } from "./fetch-retry.js";
import { normalizeTitleKey } from "./text.js";
import type { AmiiboDatabaseRaw, BlawarEntry, DSRelease, WiiUGame } from "./types.js";
import wiiuDataset from "./resources/wiiu.json";

export const AMIIBO_DB_URL =
  "https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json";
export const TITLEDB_URL =
  "https://raw.githubusercontent.com/blawar/titledb/master/US.en.json";
export const DSDB_URL = "http://3dsdb.com/xml.php";

export interface BaseDatasets {
  amiibo: AmiiboDatabaseRaw;
  switchIndex: Map<string, string[]>;  // key: normalized name -> list of title ids
  switch2Index: Map<string, string[]>; // same shape, Switch 2 titles
  wiiu: WiiUGame[];
  ds: DSRelease[];
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

export async function loadSwitchTitleDb(): Promise<{
  switchIndex: Map<string, string[]>;
  switch2Index: Map<string, string[]>;
}> {
  const text = await fetchTextWithRetry(TITLEDB_URL);
  // The titledb file is keyed by title id (hex). We parse once and re-bucket
  // for Switch vs Switch 2. Today blawar's file is a flat dict; we treat each
  // entry uniformly because the C# code does the same — the platform split is
  // determined by the amiibo.life HTML tag, not by the titledb.
  const raw = JSON.parse(text) as Record<string, BlawarEntry>;
  const switchIndex = buildTitleIndex(raw);
  // Switch 2 entries live in the same file under newer ids; the C# port reuses
  // the whole file for both buckets and lets the page tag disambiguate.
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

export async function loadAllDatasets(): Promise<BaseDatasets> {
  const [amiibo, switchIndices, ds] = await Promise.all([
    loadAmiiboDatabase(),
    loadSwitchTitleDb(),
    loadDSDatabase(),
  ]);
  return {
    amiibo,
    switchIndex: switchIndices.switchIndex,
    switch2Index: switchIndices.switch2Index,
    wiiu: loadWiiUDataset(),
    ds,
  };
}
