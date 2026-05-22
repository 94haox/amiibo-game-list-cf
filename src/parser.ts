// Parses an amiibo.life amiibo page into a Games record. Replicates the
// XPath logic in Program.ParseAmiibo using node-html-parser's CSS selectors.

import { parse, type HTMLElement } from "node-html-parser";

import {
  resolve3DS,
  resolveSwitch,
  resolveSwitch2,
  resolveWiiU,
  sanitizeGameName,
} from "./matchers.js";
import { htmlDecode } from "./text.js";
import type { BaseDatasets } from "./datasets.js";
import type { AmiiboUsage, Game, Games } from "./types.js";

export interface ParsedAmiibo {
  games: Games;
  missing: string[]; // strings like "Game Name (Platform)" appended on miss
}

function emptyGames(): Games {
  return { games3DS: [], gamesWiiU: [], gamesSwitch: [], gamesSwitch2: [] };
}

function normalizeGameName(raw: string): string {
  return raw
    .trim()
    .replace(/^Poochy & /, "")
    .trim()
    .replace("Ace Combat Assault Horizon Legacy +", "Ace Combat Assault Horizon Legacy+")
    .replace("Power Pros", "Jikkyou Powerful Pro Baseball");
}

function parseUsages(node: HTMLElement): AmiiboUsage[] {
  const items = node.querySelectorAll(".features li");
  const usages: AmiiboUsage[] = items.map((li) => {
    const em = li.querySelector("em");
    // GetDirectInnerText: text content excluding child element text.
    const direct = li.childNodes
      .filter((n) => n.nodeType === 3 /* TEXT_NODE */)
      .map((n) => n.rawText)
      .join("")
      .trim();
    return {
      Usage: htmlDecode(direct),
      write: em?.innerText.trim() === "(Read+Write)",
    };
  });
  usages.sort((a, b) => a.Usage.localeCompare(b.Usage, undefined, { sensitivity: "base" }));
  return usages;
}

function directTextOf(el: HTMLElement | null): string {
  if (!el) return "";
  const direct = el.childNodes
    .filter((n) => n.nodeType === 3 /* TEXT_NODE */ && n.rawText.trim().length > 0)
    .map((n) => n.rawText)
    .join("")
    .trim();
  return htmlDecode(direct);
}

export function parseAmiiboPage(
  html: string,
  options: { amiiboName: string; datasets: BaseDatasets },
): ParsedAmiibo {
  const root = parse(htmlDecode(html));
  const games = emptyGames();
  const missing: string[] = [];

  const anchors = root.querySelectorAll(".games.panel > a");
  if (anchors.length === 0) {
    return { games, missing };
  }

  for (const anchor of anchors) {
    const nameNode = anchor.querySelector(".name");
    const platformNode = nameNode?.querySelector("span");
    let gameName = normalizeGameName(directTextOf(nameNode));

    if (options.amiiboName === "Shadow Mewtwo") {
      gameName = "Pokkén Tournament";
    }

    const sanitized = sanitizeGameName(gameName);
    const platform = platformNode?.innerText.trim().toLowerCase();

    const usages = parseUsages(anchor);

    const baseGame: Game = {
      gameName,
      gameID: [],
      amiiboUsage: usages,
    };

    switch (platform) {
      case "switch": {
        const result = resolveSwitch(sanitized, gameName, options.datasets);
        if (result.missing) missing.push(`${gameName} (Switch)`);
        else games.gamesSwitch.push({ ...baseGame, gameID: result.ids });
        break;
      }
      case "switch 2": {
        const result = resolveSwitch2(sanitized, gameName, options.datasets);
        if (result.missing) missing.push(`${gameName} (Switch2)`);
        else games.gamesSwitch2.push({ ...baseGame, gameID: result.ids });
        break;
      }
      case "wii u": {
        const result = resolveWiiU(gameName, options.datasets);
        if (result.missing) missing.push(`${gameName} (Wii U)`);
        else games.gamesWiiU.push({ ...baseGame, gameID: result.ids });
        break;
      }
      case "3ds": {
        const result = resolve3DS(gameName, options.datasets);
        if (result.missing) missing.push(`${gameName} (3DS)`);
        else games.games3DS.push({ ...baseGame, gameID: result.ids });
        break;
      }
      default:
        break;
    }
  }

  const byName = (a: Game, b: Game) =>
    a.gameName.localeCompare(b.gameName, undefined, { sensitivity: "base" });
  games.gamesSwitch.sort(byName);
  games.gamesSwitch2.sort(byName);
  games.gamesWiiU.sort(byName);
  games.games3DS.sort(byName);

  return { games, missing };
}
