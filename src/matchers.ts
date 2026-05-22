// Per-platform title-id resolution. Mirrors the per-case logic in
// Program.ParseAmiibo's switch statement, including the hardcoded fallback
// tables.

import { htmlDecode, normalizeTitleKey, strip3DS } from "./text.js";
import type { BaseDatasets } from "./datasets.js";
import type { DSRelease, WiiUGame } from "./types.js";

export type Platform = "switch" | "switch2" | "wiiu" | "3ds";

export interface MatchResult {
  ids: string[];
  /** Set to true if we fell back to no ids (caller should record as missing). */
  missing: boolean;
}

/** Apply the `sanatizedGameName` per-name overrides that the original `Game.gameName` setter does. */
export function sanitizeGameName(rawName: string): string {
  switch (rawName) {
    case "The Legend of Zelda: Skyward Sword HD":
      return "The Legend of Zelda: Skyward Sword HD";
    case "Mario + Rabbids: Kingdom Battle":
      return "Mario + Rabbids Kingdom Battle";
    case "Shovel Knight":
      return "Shovel Knight: Treasure Trove";
    case "Little Nightmares: Complete Edition":
      return "Little Nightmares Complete Edition";
    default:
      return rawName;
  }
}

const SWITCH_FALLBACKS: Record<string, string[]> = {
  "Cyber Shadow": ["0100C1F0141AA000"],
  "Jikkyou Powerful Pro Baseball": ["0100E9C00BF28000"],
  "Shovel Knight Pocket Dungeon": ["01006B00126EC000"],
  "Shovel Knight Showdown": ["0100B380022AE000"],
  "Super Kirby Clash": ["01003FB00C5A8000"],
  "The Legend of Zelda: Echoes of Wisdom": ["01008CF01BAAC000"],
  "The Legend of Zelda: Skyward Sword HD": ["01002DA013484000"],
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale": ["01003C101454A000"],
};

const SWITCH2_FALLBACKS: Record<string, string[]> = {
  "Donkey Kong Bananza": ["70010000096809"],
  "Kirby Air Riders": ["70010000103775"],
};

const WIIU_FALLBACKS: Record<string, string[]> = {
  "Shovel Knight Showdown": [
    "000500001016E100",
    "0005000010178F00",
    "0005000E1016E100",
    "0005000E10178F00",
    "0005000E101D9300",
  ],
};

const DS_FALLBACKS: Record<string, string[]> = {
  "Style Savvy: Styling Star": ["00040000001C2500"],
  "Metroid Prime: Blast Ball": ["0004000000175300"],
  "Mini Mario & Friends amiibo Challenge": ["000400000016C300", "000400000016C200"],
  "Team Kirby Clash Deluxe": ["00040000001AB900", "00040000001AB800"],
  "Kirby's Extra Epic Yarn": ["00040000001D1F00"],
  "Kirby's Blowout Blast": ["0004000000196F00"],
  "BYE-BYE BOXBOY!": ["00040000001B5400", "00040000001B5300"],
  "Azure Striker Gunvolt 2": ["00040000001A6E00"],
  "niconico app": ["0005000010116400"],
};

function dedupeSort(ids: string[]): string[] {
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

export function resolveSwitch(sanitized: string, original: string, db: BaseDatasets): MatchResult {
  const ids = db.switchIndex.get(sanitized.toLowerCase()) ?? [];
  if (ids.length > 0) return { ids: dedupeSort(ids), missing: false };
  const fb = SWITCH_FALLBACKS[sanitized];
  if (fb) return { ids: dedupeSort(fb), missing: false };
  return { ids: [], missing: true };
}

export function resolveSwitch2(sanitized: string, original: string, db: BaseDatasets): MatchResult {
  const ids = db.switch2Index.get(sanitized.toLowerCase()) ?? [];
  if (ids.length > 0) return { ids: dedupeSort(ids), missing: false };
  const fb = SWITCH2_FALLBACKS[sanitized];
  if (fb) return { ids: dedupeSort(fb), missing: false };
  return { ids: [], missing: true };
}

export function resolveWiiU(gameName: string, db: BaseDatasets): MatchResult {
  const needleLower = gameName.toLowerCase();
  const match = db.wiiu.find((g: WiiUGame) =>
    g.Name.some((n) => n.toLowerCase().includes(needleLower)),
  );
  const rawIds = match?.Ids;
  if (rawIds && rawIds.length > 0) {
    // Wii U ids in the bundle look like "0005000010110700 [EUR]"; take the
    // first 16 chars to drop the region suffix.
    const ids = rawIds.map((s) => s.slice(0, 16));
    return { ids: dedupeSort(ids), missing: false };
  }
  const fb = WIIU_FALLBACKS[gameName];
  if (fb) return { ids: dedupeSort(fb), missing: false };
  return { ids: [], missing: true };
}

export function resolve3DS(gameName: string, db: BaseDatasets): MatchResult {
  const needle = strip3DS(gameName);
  const matches: DSRelease[] = db.ds.filter((g) => strip3DS(htmlDecode(g.name)).includes(needle));
  if (matches.length === 0) {
    const fb = DS_FALLBACKS[gameName];
    if (fb) return { ids: dedupeSort(fb), missing: false };
    return { ids: [], missing: true };
  }
  const ids = matches.map((m) => m.titleid.slice(0, 16));
  return { ids: dedupeSort(ids), missing: false };
}
