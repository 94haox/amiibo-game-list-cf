import assert from "node:assert/strict";
import test from "node:test";

import { serializeAmiibos } from "../src/serialize.js";
import type { AmiiboKeyValue } from "../src/types.js";

test("serializer uses tab indentation without mutating usage text", () => {
  const value: AmiiboKeyValue = {
    amiibos: {
      "0x0000000000000000": {
        games3DS: [],
        gamesWiiU: [],
        gamesSwitch2: [],
        gamesSwitch: [
          {
            gameName: "Example",
            gameID: [],
            amiiboUsage: [{ Usage: "Keep  intentional spacing", write: false }],
          },
        ],
      },
    },
  };

  const serialized = serializeAmiibos(value);

  assert.match(serialized, /\n\t"amiibos"/);
  assert.equal(
    JSON.parse(serialized).amiibos["0x0000000000000000"].gamesSwitch[0].amiiboUsage[0].Usage,
    "Keep  intentional spacing",
  );
});
