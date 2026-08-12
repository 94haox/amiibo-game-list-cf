import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIncrementalPlan,
  runGenerationWithDatasets,
  type AmiiboProcessor,
} from "../src/pipeline.js";
import type { AmiiboDatabaseRaw, AmiiboKeyValue, Games } from "../src/types.js";

const emptyGames = (): Games => ({
  games3DS: [],
  gamesWiiU: [],
  gamesSwitch: [],
  gamesSwitch2: [],
});

function database(entries: Record<string, { name: string }>): AmiiboDatabaseRaw {
  return {
    amiibo_series: {
      "0x000": "Super Mario",
      "0x001": "The Legend Of Zelda",
    },
    amiibos: entries,
    characters: {
      "0x0000": "Mario",
      "0x0001": "Link",
    },
    game_series: {},
    types: {
      "0x00": "Figure",
      "0x01": "Card",
    },
  };
}

function datasets(amiibo: AmiiboDatabaseRaw) {
  return {
    amiibo,
    switchIndex: new Map(),
    switch2Index: new Map(),
    wiiu: [],
    ds: [],
  };
}

test("incremental plan reuses unchanged previous entries and processes changed ones", () => {
  const unchangedId = "0x0000000000000000";
  const changedId = "0x0001000000000000";
  const previousAmiibo = database({
    [unchangedId]: { name: "Mario" },
    [changedId]: { name: "Link" },
  });
  const currentAmiibo = database({
    [unchangedId]: { name: "Mario" },
    [changedId]: { name: "Link (Tears of the Kingdom)" },
  });
  const previousGames: AmiiboKeyValue = {
    amiibos: {
      [unchangedId]: emptyGames(),
      [changedId]: emptyGames(),
    },
  };

  const plan = buildIncrementalPlan(datasets(currentAmiibo), {
    previousAmiibo,
    previousGames,
  });

  assert.deepEqual(plan.reusedIds, [unchangedId]);
  assert.deepEqual(plan.processIds, [changedId]);
  assert.equal(plan.forceFullReason, null);
});

test("incremental generation merges reused previous games with processed changes", async () => {
  const reusedId = "0x0000000000000000";
  const newId = "0x0001000000000000";
  const previousAmiibo = database({
    [reusedId]: { name: "Mario" },
  });
  const currentAmiibo = database({
    [reusedId]: { name: "Mario" },
    [newId]: { name: "Link" },
  });
  const reusedGames: Games = {
    ...emptyGames(),
    gamesSwitch: [{ gameName: "Mario Kart 8 Deluxe", gameID: ["0100152000022000"], amiiboUsage: [] }],
  };
  const processedGames: Games = {
    ...emptyGames(),
    gamesSwitch: [{ gameName: "The Legend of Zelda", gameID: ["01007EF00011E000"], amiiboUsage: [] }],
  };
  const previousGames: AmiiboKeyValue = {
    amiibos: {
      [reusedId]: reusedGames,
    },
  };
  const processedIds: string[] = [];
  const processor: AmiiboProcessor = async (_datasets, amiiboId) => {
    processedIds.push(amiiboId);
    return { games: processedGames, missing: [] };
  };

  const result = await runGenerationWithDatasets(datasets(currentAmiibo), {
    concurrency: 2,
    previousAmiibo,
    previousGames,
    processor,
  });

  const parsed = JSON.parse(result.body) as AmiiboKeyValue;
  assert.deepEqual(processedIds, [newId]);
  assert.deepEqual(parsed.amiibos[reusedId], reusedGames);
  assert.deepEqual(parsed.amiibos[newId], processedGames);
  assert.equal(result.processedAmiibo, 1);
  assert.equal(result.reusedAmiibo, 1);
});
