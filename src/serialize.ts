// JSON serialization for the final output. Matches the C# format:
// `Newtonsoft.Json.Formatting.Indented` with two-space → tab replacement.

import type { AmiiboKeyValue } from "./types.js";

export function serializeAmiibos(value: AmiiboKeyValue): string {
  // C#: JsonConvert.SerializeObject(..., Formatting.Indented).Replace("  ", "\t")
  // — a literal global replace, not an indent-aware substitution, so we
  // reproduce it byte-for-byte.
  return JSON.stringify(value, null, 2).replaceAll("  ", "\t");
}
