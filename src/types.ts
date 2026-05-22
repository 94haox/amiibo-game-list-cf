// Shared types for the AmiiboGameList Cloudflare port.
//
// Mirrors the public shape of the C# generator's JSON output so consumers
// (AmiiboAPI) can swap implementations.

export interface AmiiboUsage {
  Usage: string;
  write: boolean;
}

export interface Game {
  gameName: string;
  gameID: string[];
  amiiboUsage: AmiiboUsage[];
}

export interface Games {
  games3DS: Game[];
  gamesWiiU: Game[];
  gamesSwitch: Game[];
  gamesSwitch2: Game[];
}

export interface AmiiboKeyValue {
  amiibos: Record<string, Games>;
}

// ---- AmiiboAPI database ----------------------------------------------------
// https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json

export interface AmiiboDatabaseRaw {
  amiibo_series: Record<string, string>;
  amiibos: Record<string, DBAmiiboRaw>;
  characters: Record<string, string>;
  game_series: Record<string, string>;
  types: Record<string, string>;
}

export interface DBAmiiboRaw {
  amiiboSeries?: string;
  character?: string;
  gameSeries?: string;
  head?: string;
  image?: string;
  name: string;
  release?: Record<string, string | null>;
  tail?: string;
  type?: string;
}

// ---- Switch / Switch2 titledb ---------------------------------------------
// https://raw.githubusercontent.com/blawar/titledb/master/US.en.json
// Each value is { id, name, ...platform-specific fields }.

export interface BlawarEntry {
  id: string;
  name?: string;
  isDemo?: boolean;
  region?: string;
}

// ---- 3DS XML (3dsdb.com) --------------------------------------------------

export interface DSRelease {
  name: string;
  titleid: string;
}

// ---- Wii U bundled JSON ---------------------------------------------------

export interface WiiUGame {
  Name: string[];
  Ids: string[];
}

// ---- Run state -------------------------------------------------------------

export interface RunState {
  runId: string;
  totalAmiibo: number;
  startedAt: string;
}

export interface PartialResult {
  amiiboId: string; // "0x..."
  games: Games;
  missing: string[];
}
