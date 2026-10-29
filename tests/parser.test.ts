import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const linkedGameCards = readFileSync(
  new URL("./fixtures/amiibo-life-linked-game-cards.html", import.meta.url),
  "utf8",
);

test("parser reads captured linked game cards across all four platforms", () => {
  const result = parseAmiiboPage(linkedGameCards, {
    amiiboName: "Mineru's Construct / Mario",
    datasets: {
      ...datasets,
      switchIndex: new Map([["the legend of zelda: link's awakening", ["01006BB00C6F0000"]]]),
      wiiu: [{ Name: ["Mario Party 10"], Ids: ["0005000010162F00 [USA]"] }],
    },
  });

  assert.deepEqual(result.games, {
    games3DS: [{
      gameName: "Style Savvy: Styling Star",
      gameID: ["00040000001C2500"],
      amiiboUsage: [{ Usage: "Unlock a Legend of Zelda pattern", write: false }],
    }],
    gamesWiiU: [{
      gameName: "Mario Party 10",
      gameID: ["0005000010162F00"],
      amiiboUsage: [
        { Usage: "Customize game board in amiibo Party", write: false },
        { Usage: "Use as game piece in amiibo Party", write: true },
      ],
    }],
    gamesSwitch: [{
      gameName: "The Legend of Zelda: Link's Awakening",
      gameID: ["01006BB00C6F0000"],
      amiiboUsage: [
        { Usage: "Save your Chamber Dungeon to the amiibo to share with friends", write: true },
        { Usage: "Unlock one of five amiibo-exclusive Chamber Dungeon chambers", write: false },
      ],
    }],
    gamesSwitch2: [{
      gameName: "Animal Crossing: New Horizons – Nintendo Switch 2 Edition",
      gameID: [],
      amiiboUsage: [{
        Usage: "Invite amiibo-exclusive villager Mineru / Unlock Legend of Zelda-themed items in shopping catalog",
        write: false,
      }],
    }],
  });
  assert.deepEqual(result.missing, ["Animal Crossing: New Horizons – Nintendo Switch 2 Edition (Switch2)"]);
});

test("parser decodes text entities after parsing linked cards", () => {
  const result = parseAmiiboPage(`
    <div class="games panel">
      <div class="game-card">
        <span class="system">Switch</span>
        <p class="name"><a>Mario &amp; Luigi &lt;Bonus&gt;</a></p>
        <ul class="features">
          <li><a><span class="feature-link-name">Unlock &lt;bonus&gt; &amp; equipment</span></a></li>
        </ul>
      </div>
    </div>
  `, { amiiboName: "Mario", datasets });

  assert.equal(result.games.gamesSwitch[0]?.gameName, "Mario & Luigi <Bonus>");
  assert.deepEqual(result.games.gamesSwitch[0]?.amiiboUsage, [
    { Usage: "Unlock <bonus> & equipment", write: false },
  ]);
});

test("parser rejects challenge pages and unrecognized game layouts", () => {
  for (const html of [
    "<html><title>Just a moment...</title></html>",
    '<div class="games panel"><p>Use in <strong>1</strong> games total.</p></div>',
    '<div class="games panel"><section><a href="/games/example">Example Game</a></section></div>',
  ]) {
    assert.throws(
      () => parseAmiiboPage(html, { amiiboName: "Mario", datasets }),
      /Unrecognized amiibo\.life.*Mario/,
    );
  }
});

test("parser permits a games panel without compatible games", () => {
  const result = parseAmiiboPage(`
    <div class="games panel">
      <p>This amiibo has no non-generic features in any games.</p>
    </div>
  `, { amiiboName: "Generic Amiibo", datasets });

  assert.deepEqual(result, {
    games: { games3DS: [], gamesWiiU: [], gamesSwitch: [], gamesSwitch2: [] },
    missing: [],
  });
});

test("parser rejects game cards with missing metadata or usage text", () => {
  const card = `
    <div class="game-card">
      <span class="system">Switch</span>
      <p class="name"><a>Example Game</a></p>
      <ul class="features">
        <li><a><span class="feature-link-name">Unlock a costume</span></a></li>
      </ul>
    </div>
  `;

  for (const broken of [
    card.replace('<span class="system">Switch</span>', ""),
    card.replace('<p class="name"><a>Example Game</a></p>', ""),
    card.replace("Unlock a costume", ""),
    card.replace(/<ul class="features">[\s\S]*?<\/ul>/, ""),
    card.replace('<span class="feature-link-name">Unlock a costume</span>', '<span class="type-read-write">Read+Write</span>'),
  ]) {
    assert.throws(
      () => parseAmiiboPage(`<div class="games panel">${broken}</div>`, { amiiboName: "Mario", datasets }),
      /Unrecognized amiibo\.life.*Mario/,
    );
  }
});

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
