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

const AMIIBO_LIFE_URL_OVERRIDES: Record<string, string> = {
  "Donkey Kong|Donkey Kong and Pauline": "https://amiibo.life/amiibo/donkey-kong/donkey-kong-pauline",
  "Kirby Air Riders|Kirby": "https://amiibo.life/amiibo/kirby-air-riders/kirby-warp-star",
  "Kirby Air Riders|Meta Knight": "https://amiibo.life/amiibo/kirby-air-riders/meta-knight-shadow-star",
  "Monster Hunter Stories|One-Eyed Rathalos and Rider (Female)": "https://amiibo.life/amiibo/monster-hunter-stories/one-eyed-rathalos-and-rider-girl",
  "Monster Hunter Stories|One-Eyed Rathalos and Rider (Male)": "https://amiibo.life/amiibo/monster-hunter-stories/one-eyed-rathalos-and-rider-boy",
  "Pragmata|Lelia": "https://amiibo.life/amiibo/pragmata/diana",
  "Shovel Knight|Shovel Knight (Gold Edition)": "https://amiibo.life/amiibo/shovel-knight/shovel-knight-gold-edition",
  "Splatoon|Callie (Alterna)": "https://amiibo.life/amiibo/splatoon/callie-alterna",
  "Splatoon|Inkling (Yellow)": "https://amiibo.life/amiibo/splatoon/inkling-yellow",
  "Splatoon|Inkling Boy (Neon Green)": "https://amiibo.life/amiibo/splatoon/inkling-boy-neon-green",
  "Splatoon|Inkling Boy (Purple)": "https://amiibo.life/amiibo/splatoon/inkling-boy-purple",
  "Splatoon|Inkling Girl (Lime Green)": "https://amiibo.life/amiibo/splatoon/inkling-girl-lime-green",
  "Splatoon|Inkling Girl (Neon Pink)": "https://amiibo.life/amiibo/splatoon/inkling-girl-neon-pink",
  "Splatoon|Inkling Squid (Neon Purple)": "https://amiibo.life/amiibo/splatoon/inkling-squid-neon-purple",
  "Splatoon|Inkling Squid (Orange)": "https://amiibo.life/amiibo/splatoon/inkling-squid-orange",
  "Splatoon|Marie (Alterna)": "https://amiibo.life/amiibo/splatoon/marie-alterna",
  "Splatoon|Marina (Side Order)": "https://amiibo.life/amiibo/splatoon/marina-side-order",
  "Splatoon|Octoling (Blue)": "https://amiibo.life/amiibo/splatoon/octoling-blue",
  "Splatoon|Pearl (Side Order)": "https://amiibo.life/amiibo/splatoon/pearl-side-order",
  "Street Fighter 6 Booster Pack|A.K.I.": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/a-k-i",
  "Street Fighter 6 Booster Pack|AKI": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/a-k-i",
  "Street Fighter 6 Booster Pack|Alex": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/alex",
  "Street Fighter 6 Booster Pack|Alex (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/alex-alt",
  "Street Fighter 6 Booster Pack|Blanka": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/blanka",
  "Street Fighter 6 Booster Pack|C. Viper": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/c-viper",
  "Street Fighter 6 Booster Pack|C. Viper (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/c-viper-alt",
  "Street Fighter 6 Booster Pack|C Viper": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/c-viper",
  "Street Fighter 6 Booster Pack|C Viper (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/c-viper-alt",
  "Street Fighter 6 Booster Pack|Cammy": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/cammy",
  "Street Fighter 6 Booster Pack|Chun-Li": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/chun-li",
  "Street Fighter 6 Booster Pack|Dee Jay": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/dee-jay",
  "Street Fighter 6 Booster Pack|Dhalsim": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/dhalsim",
  "Street Fighter 6 Booster Pack|E Honda": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/e-honda",
  "Street Fighter 6 Booster Pack|E. Honda": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/e-honda",
  "Street Fighter 6 Booster Pack|Ed": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ed",
  "Street Fighter 6 Booster Pack|ED": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ed",
  "Street Fighter 6 Booster Pack|Elena": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/elena",
  "Street Fighter 6 Booster Pack|Elena (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/elena-alt",
  "Street Fighter 6 Booster Pack|Guile": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/guile",
  "Street Fighter 6 Booster Pack|Ingrid": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ingrid",
  "Street Fighter 6 Booster Pack|Ingrid (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ingrid-alt",
  "Street Fighter 6 Booster Pack|JP": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/jp",
  "Street Fighter 6 Booster Pack|Juri": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/juri",
  "Street Fighter 6 Booster Pack|Ken": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ken",
  "Street Fighter 6 Booster Pack|Lily": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/lily",
  "Street Fighter 6 Booster Pack|M. Bison": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/m-bison",
  "Street Fighter 6 Booster Pack|M. Bison (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/m-bison-alt",
  "Street Fighter 6 Booster Pack|M Bison": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/m-bison",
  "Street Fighter 6 Booster Pack|M Bison (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/m-bison-alt",
  "Street Fighter 6 Booster Pack|Mai": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/mai",
  "Street Fighter 6 Booster Pack|Mai (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/mai-alt",
  "Street Fighter 6 Booster Pack|Manon": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/manon",
  "Street Fighter 6 Booster Pack|Marisa": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/marisa",
  "Street Fighter 6 Booster Pack|Rashid": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/rashid",
  "Street Fighter 6 Booster Pack|Ryu": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ryu",
  "Street Fighter 6 Booster Pack|Sagat": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/sagat",
  "Street Fighter 6 Booster Pack|Sagat (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/sagat-alt",
  "Street Fighter 6 Booster Pack|Terry": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/terry",
  "Street Fighter 6 Booster Pack|Terry (Alt)": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/terry-alt",
  "Street Fighter 6 Booster Pack|Zangief": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/zangief",
  "Street Fighter 6 Starter Set|A.K.I.": "https://amiibo.life/amiibo/street-fighter-6-starter-set/a-k-i",
  "Street Fighter 6 Starter Set|AKI": "https://amiibo.life/amiibo/street-fighter-6-starter-set/a-k-i",
  "Street Fighter 6 Starter Set|Akuma": "https://amiibo.life/amiibo/street-fighter-6-starter-set/akuma",
  "Street Fighter 6 Starter Set|Blanka": "https://amiibo.life/amiibo/street-fighter-6-starter-set/blanka",
  "Street Fighter 6 Starter Set|Cammy": "https://amiibo.life/amiibo/street-fighter-6-starter-set/cammy",
  "Street Fighter 6 Starter Set|Chun-Li": "https://amiibo.life/amiibo/street-fighter-6-starter-set/chun-li",
  "Street Fighter 6 Starter Set|Dee Jay": "https://amiibo.life/amiibo/street-fighter-6-starter-set/dee-jay",
  "Street Fighter 6 Starter Set|Dhalsim": "https://amiibo.life/amiibo/street-fighter-6-starter-set/dhalsim",
  "Street Fighter 6 Starter Set|E Honda": "https://amiibo.life/amiibo/street-fighter-6-starter-set/e-honda",
  "Street Fighter 6 Starter Set|E.Honda": "https://amiibo.life/amiibo/street-fighter-6-starter-set/e-honda",
  "Street Fighter 6 Starter Set|Ed": "https://amiibo.life/amiibo/street-fighter-6-starter-set/ed",
  "Street Fighter 6 Starter Set|ED": "https://amiibo.life/amiibo/street-fighter-6-starter-set/ed",
  "Street Fighter 6 Starter Set|Guile": "https://amiibo.life/amiibo/street-fighter-6-starter-set/guile",
  "Street Fighter 6 Starter Set|JP": "https://amiibo.life/amiibo/street-fighter-6-starter-set/jp",
  "Street Fighter 6 Starter Set|Juri": "https://amiibo.life/amiibo/street-fighter-6-starter-set/juri",
  "Street Fighter 6 Starter Set|Ken": "https://amiibo.life/amiibo/street-fighter-6-starter-set/ken",
  "Street Fighter 6 Starter Set|Lily": "https://amiibo.life/amiibo/street-fighter-6-starter-set/lily",
  "Street Fighter 6 Starter Set|Manon": "https://amiibo.life/amiibo/street-fighter-6-starter-set/manon",
  "Street Fighter 6 Starter Set|Marisa": "https://amiibo.life/amiibo/street-fighter-6-starter-set/marisa",
  "Street Fighter 6 Starter Set|Rashid": "https://amiibo.life/amiibo/street-fighter-6-starter-set/rashid",
  "Street Fighter 6 Starter Set|Ryu": "https://amiibo.life/amiibo/street-fighter-6-starter-set/ryu",
  "Street Fighter 6 Starter Set|Zangief": "https://amiibo.life/amiibo/street-fighter-6-starter-set/zangief",
  "Super Mario Bros 30th Anniversary|8-Bit Mario Classic Color": "https://amiibo.life/amiibo/super-mario-bros-30th-anniversary/mario-classic-colors",
  "Super Mario Bros 30th Anniversary|8-Bit Mario Modern Color": "https://amiibo.life/amiibo/super-mario-bros-30th-anniversary/mario-modern-colors",
  "Super Mario Bros 30th Anniversary|Mario Classic Colors": "https://amiibo.life/amiibo/super-mario-bros-30th-anniversary/mario-classic-colors",
  "Super Mario Bros 30th Anniversary|Mario Modern Colors": "https://amiibo.life/amiibo/super-mario-bros-30th-anniversary/mario-modern-colors",
  "Super Mario|Mario - Silver Editon": "https://amiibo.life/amiibo/super-mario/mario-silver-edition",
  "Super Mario|Mario - Silver Edition": "https://amiibo.life/amiibo/super-mario/mario-silver-edition",
  "Super Mario|Mario Silver Editon": "https://amiibo.life/amiibo/super-mario/mario-silver-edition",
  "Super Nintendo World|Gold Mario Power-Up Band": "https://amiibo.life/amiibo/super-nintendo-world/golden-power-up-band",
  "Super Nintendo World|Golden Power-Up Band": "https://amiibo.life/amiibo/super-nintendo-world/golden-power-up-band",
  "Super Smash Bros|Bayonetta (Player 2)": "https://amiibo.life/amiibo/super-smash-bros/bayonetta-player-2",
  "Super Smash Bros|Cloud (Player 2)": "https://amiibo.life/amiibo/super-smash-bros/cloud-player-2",
  "Super Smash Bros|Corrin (Player 2)": "https://amiibo.life/amiibo/super-smash-bros/corrin-player-2",
  "Super Smash Bros|Ganondorf": "https://amiibo.life/amiibo/super-smash-bros/ganondorf",
  "Super Smash Bros|Mega Man (Gold Edition)": "https://amiibo.life/amiibo/super-smash-bros/mega-man-gold-edition",
  "Super Smash Bros|Mega Man Gold Edition": "https://amiibo.life/amiibo/super-smash-bros/mega-man-gold-edition",
  "Super Smash Bros|Pokémon Trainer": "https://amiibo.life/amiibo/super-smash-bros/pokemon-trainer",
  "Super Smash Bros|R O B (Famicom)": "https://amiibo.life/amiibo/super-smash-bros/r-o-b-famicom",
  "Super Smash Bros|R O B (NES)": "https://amiibo.life/amiibo/super-smash-bros/r-o-b-nes",
  "Super Smash Bros|R.O.B (Famicom)": "https://amiibo.life/amiibo/super-smash-bros/r-o-b-famicom",
  "Super Smash Bros|R.O.B. (NES)": "https://amiibo.life/amiibo/super-smash-bros/r-o-b-nes",
  "The Legend Of Zelda|8- Bit Link": "https://amiibo.life/amiibo/the-legend-of-zelda/link-the-legend-of-zelda",
  "The Legend Of Zelda|8-Bit Link": "https://amiibo.life/amiibo/the-legend-of-zelda/link-the-legend-of-zelda",
  "The Legend Of Zelda|Ganondorf": "https://amiibo.life/amiibo/the-legend-of-zelda/ganondorf-tears-of-the-kingdom",
  "The Legend Of Zelda|Link": "https://amiibo.life/amiibo/the-legend-of-zelda/link-the-legend-of-zelda",
  "The Legend Of Zelda|Link (Archer)": "https://amiibo.life/amiibo/the-legend-of-zelda/link-archer",
  "The Legend Of Zelda|Link (Link)": "https://amiibo.life/amiibo/the-legend-of-zelda/link-the-legend-of-zelda",
  "The Legend Of Zelda|Link (Link's Awakening)": "https://amiibo.life/amiibo/the-legend-of-zelda/link-link-s-awakening",
  "The Legend Of Zelda|Link (Rider)": "https://amiibo.life/amiibo/the-legend-of-zelda/link-rider",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Asana Mutsuba": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/asana-mutsuba",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Gakuto Sogetsu": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/gakuto-sogetsu",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Gakuto Sōgetsu": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/gakuto-sogetsu",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Nail Saionji": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/nail-saionji",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Roa Kirishima": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/roa-kirishima",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Romin Kirishima": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/romin-kirishima",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Tatsuhisa Luke kamijo": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/tatsuhisa-luke-kamijo",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Tatsuhisa “Luke” Kamijō": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/tatsuhisa-luke-kamijo",
  "Yu-Gi-Oh! Rush Duel Saikyo Battle Royale|Yuga Oudou": "https://amiibo.life/amiibo/yu-gi-oh-rush-duel-saikyo-battle-royale/yuga-ohdo",
};

const AMIIBO_LIFE_URL_OVERRIDES_BY_ID: Record<string, string> = {
  "0x34c0000104a81d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/ryu",
  "0x34c0000104cb1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ryu",
  "0x34c1000104a91d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/ken",
  "0x34c1000104cc1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ken",
  "0x34c2000004aa1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/luke",
  "0x34c2000104ab1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/luke",
  "0x34c2000104cd1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/luke",
  "0x34c3000004ac1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/jamie",
  "0x34c3000104ad1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/jamie",
  "0x34c3000104ce1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/jamie",
  "0x34c4000004ae1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/kimberly",
  "0x34c4000104af1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/kimberly",
  "0x34c4000104cf1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/kimberly",
  "0x34c5000104b01d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/chun-li",
  "0x34c5000104d01d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/chun-li",
  "0x34c6000104b11d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/guile",
  "0x34c6000104d11d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/guile",
  "0x34c7000104b21d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/juri",
  "0x34c7000104d21d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/juri",
  "0x34c8000104b31d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/blanka",
  "0x34c8000104d31d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/blanka",
  "0x34c9000104b41d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/dhalsim",
  "0x34c9000104d41d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/dhalsim",
  "0x34ca000104b51d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/e-honda",
  "0x34ca000104d51d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/e-honda",
  "0x34cb000104b61d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/dee-jay",
  "0x34cb000104d61d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/dee-jay",
  "0x34cc000104b71d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/manon",
  "0x34cc000104d71d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/manon",
  "0x34cd000104b81d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/marisa",
  "0x34cd000104d81d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/marisa",
  "0x34ce000104b91d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/jp",
  "0x34ce000104d91d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/jp",
  "0x34cf000104ba1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/zangief",
  "0x34cf000104da1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/zangief",
  "0x34d0000104bb1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/lily",
  "0x34d0000104db1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/lily",
  "0x34d1000104bc1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/cammy",
  "0x34d1000104dc1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/cammy",
  "0x34d2000104bd1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/rashid",
  "0x34d2000104dd1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/rashid",
  "0x34d3000104be1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/a-k-i",
  "0x34d3000104de1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/a-k-i",
  "0x34d4000104bf1d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/ed",
  "0x34d4000104df1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ed",
  "0x34d5000104c01d02": "https://amiibo.life/amiibo/street-fighter-6-starter-set/akuma",
  "0x34d5000104e01d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/akuma",
  "0x34d6000104e11d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/m-bison",
  "0x34d6000104eb1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/m-bison-alt",
  "0x34d8000104e31d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/elena",
  "0x34d8000104ec1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/elena-alt",
  "0x34d9000104e41d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/sagat",
  "0x34d9000104ed1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/sagat-alt",
  "0x34da000104e51d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/c-viper",
  "0x34da000104ee1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/c-viper-alt",
  "0x34db000104e61d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/alex",
  "0x34db000104ef1d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/alex-alt",
  "0x34dc000104e71d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ingrid",
  "0x34dc000104f01d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/ingrid-alt",
  "0x3c80000104e81d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/terry",
  "0x3c80000104f11d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/terry-alt",
  "0x3c81000104f21d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/mai",
  "0x3c81000104f31d02": "https://amiibo.life/amiibo/street-fighter-6-booster-pack/mai-alt",
};

function overrideKeySeriesCandidates(series: string): string[] {
  return Array.from(new Set([series, series.replace(/\./g, "")]));
}

function amiiboLifeOverrideUrl(
  id: string,
  series: string,
  originalName: string,
  cleaned: string,
): string | null {
  const byId = AMIIBO_LIFE_URL_OVERRIDES_BY_ID[id];
  if (byId) return byId;

  for (const seriesKey of overrideKeySeriesCandidates(series)) {
    const byOriginal = AMIIBO_LIFE_URL_OVERRIDES[`${seriesKey}|${originalName}`];
    if (byOriginal) return byOriginal;

    const byCleaned = AMIIBO_LIFE_URL_OVERRIDES[`${seriesKey}|${cleaned}`];
    if (byCleaned) return byCleaned;
  }

  return null;
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
  const overrideUrl = amiiboLifeOverrideUrl(ctx.id, series, ctx.originalName, name);
  if (overrideUrl) return overrideUrl;

  if (type === "Card" && series === "Animal Crossing") {
    return resolveAnimalCrossingCardUrl(characterName(ctx));
  }

  let seriesSlug = series.toLowerCase().replace(/[!.]/g, "").replace(/[' ]/g, "-");

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
