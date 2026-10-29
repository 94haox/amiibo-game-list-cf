// Parses current and legacy amiibo.life game cards into a Games record.

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
    const featureName = li.querySelector(".feature-link-name");
    return {
      Usage: featureName ? htmlDecode(featureName.innerText).trim() : directTextOf(li),
      write: li.querySelector(".type-read-write") !== null || em?.innerText.trim() === "(Read+Write)",
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
  const root = parse(html);
  const games = emptyGames();
  const missing: string[] = [];

  const panel = root.querySelector(".games.panel");
  if (!panel) {
    throw new Error(`Unrecognized amiibo.life page for ${options.amiiboName}: missing games panel`);
  }

  const cards = root.querySelectorAll(".games.panel > a, .games.panel > .game-card");
  if (cards.length === 0) {
    if (
      Number(panel.querySelector("strong")?.innerText) > 0 ||
      panel.querySelector('.game-card, .features, a[href^="/games/"]')
    ) {
      throw new Error(`Unrecognized amiibo.life game layout for ${options.amiiboName}`);
    }
    return { games, missing };
  }

  for (const card of cards) {
    const nameNode = card.querySelector(".name");
    const nameLink = nameNode?.querySelector("a");
    const platformNode = card.querySelector(".system") ?? nameNode?.querySelector("span");
    let gameName = normalizeGameName(nameLink ? htmlDecode(nameLink.innerText) : directTextOf(nameNode));

    if (!gameName || !platformNode?.innerText.trim()) {
      throw new Error(`Unrecognized amiibo.life game card for ${options.amiiboName}: missing name or platform`);
    }

    if (options.amiiboName === "Shadow Mewtwo") {
      gameName = "Pokkén Tournament";
    }

    const sanitized = sanitizeGameName(gameName);
    const platform = platformNode?.innerText.trim().toLowerCase();

    const usages = parseUsages(card);
    if (usages.length === 0 || usages.some((usage) => !usage.Usage)) {
      throw new Error(`Unrecognized amiibo.life usage for ${options.amiiboName} in ${gameName}`);
    }

    const baseGame: Game = {
      gameName,
      gameID: [],
      amiiboUsage: usages,
    };

    switch (platform) {
      case "switch": {
        const result = resolveSwitch(sanitized, gameName, options.datasets);
        if (result.missing) missing.push(`${gameName} (Switch)`);
        games.gamesSwitch.push({ ...baseGame, gameID: result.ids });
        break;
      }
      case "switch 2": {
        const result = resolveSwitch2(sanitized, gameName, options.datasets);
        if (result.missing) missing.push(`${gameName} (Switch2)`);
        games.gamesSwitch2.push({ ...baseGame, gameID: result.ids });
        break;
      }
      case "wii u": {
        const result = resolveWiiU(gameName, options.datasets);
        if (result.missing) missing.push(`${gameName} (Wii U)`);
        games.gamesWiiU.push({ ...baseGame, gameID: result.ids });
        break;
      }
      case "3ds": {
        const result = resolve3DS(gameName, options.datasets);
        if (result.missing) missing.push(`${gameName} (3DS)`);
        games.games3DS.push({ ...baseGame, gameID: result.ids });
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
