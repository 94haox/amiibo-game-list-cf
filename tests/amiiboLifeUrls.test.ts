import assert from "node:assert/strict";
import test from "node:test";

import { buildAmiiboContext, buildAmiiboUrl } from "../src/amiibo.js";
import { buildAmiiboLifeUrlIndex } from "../src/datasets.js";
import type { AmiiboDatabaseRaw } from "../src/types.js";

const database: AmiiboDatabaseRaw = {
  amiibo_series: {
    "0x04": "Splatoon",
    "0x1a": "Donkey Kong Bananza",
    "0x1e": "Kirby Air Riders",
  },
  amiibos: {
    "0x0807000004f70402": { name: "Shiver (Raiders)" },
    "0x1f02000004c71e03": { name: "King Dedede" },
    "0x00080100042f1a02": { name: "Donkey Kong and Pauline" },
  },
  characters: {},
  game_series: {},
  types: {},
};

test("canonical URL index resolves variant names and series aliases", () => {
  const urls = buildAmiiboLifeUrlIndex(database, [
    {
      name: "Shiver (Splatoon Raiders)",
      series_name: "Splatoon",
      url: "/amiibo/splatoon/shiver-splatoon-raiders",
    },
    {
      name: "King Dedede & Tank Star",
      series_name: "Kirby Air Riders",
      url: "/amiibo/kirby-air-riders/king-dedede-tank-star",
    },
    {
      name: "Donkey Kong & Pauline",
      series_name: "Donkey Kong",
      url: "/amiibo/donkey-kong/donkey-kong-pauline",
    },
  ]);

  assert.equal(
    urls.get("0x0807000004f70402"),
    "https://amiibo.life/amiibo/splatoon/shiver-splatoon-raiders",
  );
  assert.equal(
    urls.get("0x1f02000004c71e03"),
    "https://amiibo.life/amiibo/kirby-air-riders/king-dedede-tank-star",
  );
  assert.equal(
    urls.get("0x00080100042f1a02"),
    "https://amiibo.life/amiibo/donkey-kong/donkey-kong-pauline",
  );
});

test("canonical URL index ignores ambiguous fuzzy matches", () => {
  const ambiguousDatabase: AmiiboDatabaseRaw = {
    ...database,
    amiibo_series: {},
    amiibos: {
      "0x1f02000004c71e03": { name: "King Dedede" },
    },
  };
  const urls = buildAmiiboLifeUrlIndex(ambiguousDatabase, [
    {
      name: "King Dedede & Tank Star",
      series_name: "Kirby Air Riders",
      url: "/amiibo/kirby-air-riders/king-dedede-tank-star",
    },
    {
      name: "King Dedede & Other Star",
      series_name: "Future Series",
      url: "/amiibo/future/king-dedede-other-star",
    },
  ]);

  assert.equal(urls.has("0x1f02000004c71e03"), false);
});

test("verified URL overrides take precedence over catalogue URLs", async () => {
  const id = "0x0000000002380602";
  const overrideDatabase: AmiiboDatabaseRaw = {
    ...database,
    amiibo_series: { "0x06": "8 - Bit Mario" },
    amiibos: { [id]: { name: "8-Bit Mario Classic Color" } },
  };

  const url = await buildAmiiboUrl(
    buildAmiiboContext(overrideDatabase, id, overrideDatabase.amiibos[id]!),
    "https://amiibo.life/amiibo/8---bit-mario/mario-classic-colors",
  );

  assert.equal(
    url,
    "https://amiibo.life/amiibo/super-mario-bros-30th-anniversary/mario-classic-colors",
  );
});
