// JSON serialization for the final output using tabs for indentation.

import type { AmiiboKeyValue } from "./types.js";

export function serializeAmiibos(value: AmiiboKeyValue): string {
  return JSON.stringify(value, null, "\t");
}
