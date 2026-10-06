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

for (const [label, platform] of [
  ["Switch", "gamesSwitch"],
  ["Switch 2", "gamesSwitch2"],
  ["Wii U", "gamesWiiU"],
  ["3DS", "games3DS"],
] as const) {
  test(`parser reads ${label} from the current game card system label`, () => {
    const result = parseAmiiboPage(`
      <div class="games panel">
        <a href="/games/example">
          <div class="game-card-details">
            <span class="system label">${label}</span>
            <p class="name">Example Game</p>
            <ul class="features">
              <li>Unlock a bonus costume <em>(Read+Write)</em></li>
            </ul>
          </div>
        </a>
      </div>
    `, { amiiboName: "Example Amiibo", datasets });

    assert.deepEqual(result.games[platform], [{
      gameName: "Example Game",
      gameID: [],
      amiiboUsage: [{ Usage: "Unlock a bonus costume", write: true }],
    }]);
  });
}
