// String sanitization helpers shared across matchers and URL builders.

const COPYRIGHT_RE = /[®™]/g;
const NON_ALNUM_3DS_RE = /[^a-zA-Z0-9 -]/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/** Equivalent of System.Net.WebUtility.HtmlDecode for the entities titledb uses. */
export function htmlDecode(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (_match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(code)) return _match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? _match;
  });
}

/** Strip ®/™ and normalize the curly apostrophe; used when building titledb keys. */
export function normalizeTitleKey(name: string): string {
  return htmlDecode(name).replace(COPYRIGHT_RE, "").replace(/’/g, "'").toLowerCase();
}

/** 3DS comparison strips everything except letters, digits, spaces and hyphens. */
export function strip3DS(name: string): string {
  return htmlDecode(name).toLowerCase().replace(NON_ALNUM_3DS_RE, "");
}
