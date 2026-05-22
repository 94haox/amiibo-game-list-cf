// Hex helpers mirroring the original `Hex` class. The DB uses 16-char
// lowercase hex strings prefixed with `0x`. We just normalize and compare.

export function normalizeHex(value: string): string {
  const raw = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return `0x${raw.toLowerCase().padStart(16, "0")}`;
}

// 16 hex chars = 64-bit. JS bigints handle ordering safely.
export function hexCompare(a: string, b: string): number {
  const av = BigInt(normalizeHex(a));
  const bv = BigInt(normalizeHex(b));
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

// Derive the character/series/type lookup keys used by AmiiboAPI's DB.
// The DB stores them as "0xXXXX" / "0xXX" — slice the same way as the C#
// implementation.
//
// The amiibo ID layout (after normalizing): 0xHHHHCCCC TTTTVVVV SSPP
//   - characters[`0x${ID.substring(2, 4)}`]
//   - amiibo_series[`0x${ID.substring(14, 2)}`]
//   - types[`0x${ID.substring(8, 2)}`]
// where substring(start, length) is the C# convention.

export function characterKey(id: string): string {
  return `0x${normalizeHex(id).slice(2, 6).toLowerCase()}`;
}

export function amiiboSeriesKey(id: string): string {
  // C#: ID.Substring(14, 2). normalizeHex prefixes "0x" so the JS slice
  // start is the same number — Substring(14, 2) over an 18-char string
  // ("0x" + 16 hex) is indices 14..15.
  return `0x${normalizeHex(id).slice(14, 16).toLowerCase()}`;
}

export function typeKey(id: string): string {
  // C#: ID.Substring(8, 2)
  return `0x${normalizeHex(id).slice(8, 10).toLowerCase()}`;
}
