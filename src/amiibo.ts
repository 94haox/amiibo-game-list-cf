// Port of DBAmiibo — wraps a raw amiibo DB entry and computes derived fields
// (cleaned-up name, amiibo.life URL, character name, series, type).

import { parse } from "node-html-parser";

import { NotFoundError, fetchTextWithRetry } from "./fetch-retry.js";
import { log } from "./log.js";
import { amiiboSeriesKey, characterKey, normalizeHex, typeKey } from "./hex.js";
import type { AmiiboDatabaseRaw } from "./types.js";

export interface AmiiboContext {
  id: string; // normalized "0x..."
  originalName: string;
  database: AmiiboDatabaseRaw;
}

/** Replicates DBAmiibo.Name — strips punctuation/specials for URL building.
 *
 * `series` is optional but, when provided, lets us drop the " - SeriesName"
 * disambiguation suffix that some DB entries carry (e.g.
 * "Luigi - My Mario Wooden Blocks" → "Luigi"). amiibo.life's slug only uses
 * the character portion, so without this the URL would 404.
 */
export function cleanedName(originalName: string, series?: string): string {
  let input = originalName;
  if (series) {
    const suffix = ` - ${series}`;
    if (input.endsWith(suffix)) {
      input = input.slice(0, -suffix.length);
    }
  }
  let name = input;
  switch (input) {
    case "8-Bit Link":
      name = "Link The Legend of Zelda";
      break;
    case "8-Bit Mario Classic Color":
      name = "Mario Classic Colors";
      break;
    case "8-Bit Mario Modern Color":
      name = "Mario Modern Colors";
      break;
    case "Midna & Wolf Link":
      name = "Wolf Link";
      break;
    case "Toon Zelda - The Wind Waker":
      name = "Zelda The Wind Waker";
      break;
    case "Rosalina & Luma":
      name = "Rosalina";
      break;
    case "Zelda & Loftwing":
      name = "Zelda & Loftwing - Skyward Sword";
      break;
    case "Samus (Metroid Dread)":
      name = "Samus";
      break;
    case "E.M.M.I.":
      name = "E M M I";
      break;
    case "Tatsuhisa “Luke” Kamijō":
      name = "Tatsuhisa Luke kamijo";
      break;
    case "Gakuto Sōgetsu":
      name = "Gakuto Sogetsu";
      break;
    case "E.Honda":
      name = "E Honda";
      break;
    case "A.K.I":
      name = "A K I";
      break;
    case "Bandana Waddle Dee":
      name = "Bandana Waddle Dee Winged Star";
      break;
  }

  name = name.replace(/Slider/g, "");
  name = name.replace(/R\.O\.B\./g, "R O B");

  name = name.replace(/\./g, "");
  name = name.replace(/'/g, " ");
  name = name.replace(/"/g, "");

  name = name.replace(/ & /g, " ");
  name = name.replace(/ - /g, " ");

  return name.trim();
}

export function characterName(ctx: AmiiboContext): string {
  const key = characterKey(ctx.id);
  const raw = ctx.database.characters[key] ?? "";
  switch (raw) {
    case "Spork/Crackle":
      return "Spork";
    case "OHare":
      return "O'Hare";
    default:
      return raw;
  }
}

export function amiiboSeries(ctx: AmiiboContext): string {
  const key = amiiboSeriesKey(ctx.id);
  const raw = ctx.database.amiibo_series[key] ?? "";
  switch (raw) {
    case "8-bit Mario":
      return "Super Mario Bros 30th Anniversary";
    case "Legend Of Zelda":
      return "The Legend Of Zelda";
    case "Monster Hunter":
      return "Monster Hunter Stories";
    case "Monster Sunter Stories Rise":
      return "Monster Hunter Rise";
    case "Skylanders":
      return "Skylanders Superchargers";
    case "Super Mario Bros.":
      return "Super Mario";
    case "Xenoblade Chronicles 3":
      return "Xenoblade Chronicles";
    case "Yu-Gi-Oh!":
      return "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale";
    default:
      return raw;
  }
}

export function amiiboType(ctx: AmiiboContext): string {
  return ctx.database.types[typeKey(ctx.id)] ?? "";
}

function fallbackAnimalCrossingUrl(character: string): string {
  return `https://amiibo.life/amiibo/animal-crossing/${character.replace(/ /g, "-").toLowerCase()}`;
}

/** Look up an Animal Crossing card via amiibo.life's search page and pick the first card hit. */
async function resolveAnimalCrossingCardUrl(character: string): Promise<string> {
  const searchUrl = `https://amiibo.life/search?q=${encodeURIComponent(character)}`;
  let html: string;
  try {
    html = await fetchTextWithRetry(searchUrl);
  } catch (err) {
    if (err instanceof NotFoundError) {
      log.warn(`404 when searching for Animal Crossing card: ${character}`);
      return fallbackAnimalCrossingUrl(character);
    }
    throw err;
  }

  // amiibo.life renders a grid:
  //   <ul class="figures-cards small-block-grid-2 medium-block-grid-4 large-block-grid-4">
  //     <li><a href="/amiibo/.../slug">…</a></li>
  //     …
  //   </ul>
  // Scope to that ul and take the first card link.
  const root = parse(html);
  const list = root.querySelector(
    "ul.figures-cards.small-block-grid-2.medium-block-grid-4.large-block-grid-4",
  );
  if (list) {
    const anchors = list.querySelectorAll("li a[href]");
    for (const a of anchors) {
      const href = a.getAttribute("href") ?? "";
      if (href.includes("cards")) return `https://amiibo.life${href}`;
    }
  }
  return fallbackAnimalCrossingUrl(character);
}

/** Build the canonical amiibo.life URL for a given amiibo, mirroring the C# Lazy<string>. */
export async function buildAmiiboUrl(ctx: AmiiboContext): Promise<string> {
  const series = amiiboSeries(ctx);
  const type = amiiboType(ctx);
  const name = cleanedName(ctx.originalName, series);

  if (type === "Card" && series === "Animal Crossing") {
    return resolveAnimalCrossingCardUrl(characterName(ctx));
  }

  let seriesSlug = series.toLowerCase().replace(/[!.]/g, "").replace(/[' ]/g, "-");

  if (seriesSlug === "kirby-air-riders" && name.toLowerCase().includes("kirby")) {
    return "https://amiibo.life/amiibo/kirby-air-riders/kirby-warp-star";
  }

  switch (name.toLowerCase()) {
    case "super mario cereal":
      return "https://amiibo.life/amiibo/super-mario-cereal/super-mario-cereal";
    case "solaire of astora":
      return "https://amiibo.life/amiibo/dark-souls/solaire-of-astora";
  }

  if (seriesSlug === "street-fighter-6") {
    // The booster-pack series page on amiibo.life is a superset of the
    // starter-set: it includes Year 2 fighters (M. Bison, Mai, Terry, Sagat,
    // Elena, C. Viper, Alex, Ingrid) and "alt" variants. The C# generator
    // used "-starter-set" before those releases existed.
    seriesSlug = "street-fighter-6-booster-pack";
  }

  let url = `https://amiibo.life/amiibo/${seriesSlug}/${name.replace(/ /g, "-").toLowerCase()}`;

  // Faithfully reproduces the C# Insert+truncate trick for slugs ending in
  // "cat": insert "cat-" right after the trailing slash, then slice back to
  // the original length (dropping the final 4 chars of the new string).
  if (url.endsWith("cat")) {
    const slash = url.lastIndexOf("/");
    const inserted = `${url.slice(0, slash + 1)}cat-${url.slice(slash + 1)}`;
    url = inserted.slice(0, url.length);
  }

  return url;
}

export function buildAmiiboContext(database: AmiiboDatabaseRaw, id: string, raw: { name: string }): AmiiboContext {
  return {
    id: normalizeHex(id),
    originalName: raw.name,
    database,
  };
}
