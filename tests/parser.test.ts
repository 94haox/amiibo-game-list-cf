import assert from "node:assert/strict";
import test from "node:test";

import { parseAmiiboPage } from "../src/parser.js";
import type { BaseDatasets } from "../src/datasets.js";

const datasets: BaseDatasets = {
  amiibo: {
    amiibo_series: {},
    amiibos: {},
    characters: {},
    game_series: {},
    types: {},
  },
  amiiboLifeUrls: new Map(),
  switchIndex: new Map(),
  switch2Index: new Map(),
  wiiu: [],
  ds: [],
};

test("parser preserves usage when a title ID cannot be resolved", () => {
  const html = `
    <div class="games panel">
      <a>
        <div class="name">Future Game <span>Switch 2</span></div>
        <ul class="features">
          <li>Unlock a bonus costume <em>(Read+Write)</em></li>
        </ul>
      </a>
    </div>
  `;

  const result = parseAmiiboPage(html, {
    amiiboName: "Future Amiibo",
    datasets,
  });

  assert.deepEqual(result.missing, ["Future Game (Switch2)"]);
  assert.deepEqual(result.games.gamesSwitch2, [
    {
      gameName: "Future Game",
      gameID: [],
      amiiboUsage: [
        {
          Usage: "Unlock a bonus costume",
          write: true,
        },
      ],
    },
  ]);
});
