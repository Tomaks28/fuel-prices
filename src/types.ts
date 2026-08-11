/** Fuels tracked by the dataset, keyed the way this SDK names them. */
export const FUEL_TYPES = ['gazole', 'sp95', 'sp98', 'e10', 'e85', 'gplc'] as const;

/** One of the six fuels sold in French stations. */
export type FuelType = (typeof FUEL_TYPES)[number];

/** Price of one fuel at one station, as last reported by that station. */
export interface FuelPrice {
  readonly fuel: FuelType;
  /** Price per litre, in EUR. */
  readonly price: number;
  /** ISO-8601 UTC timestamp of the price, `null` when the feed omits it. */
  readonly updatedAt: string | null;
}

/** Why a fuel the station normally sells is currently missing. */
export interface FuelOutage {
  readonly fuel: FuelType;
  /** `definitive` means the station stopped selling that fuel for good. */
  readonly kind: 'temporary' | 'definitive' | 'unknown';
  /** ISO-8601 UTC timestamp the outage started, `null` when unreported. */
  readonly since: string | null;
}

/** WGS 84 coordinates, in decimal degrees. */
export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/** An INSEE-coded area (département or région). */
export interface AdministrativeArea {
  readonly code: string;
  readonly name: string;
}

/** Prices indexed by fuel; a missing key means the station does not sell it. */
export type FuelPriceMap = Readonly<Partial<Record<FuelType, FuelPrice>>>;

/** Outages indexed by fuel; only fuels the station does not currently sell. */
export type FuelOutageMap = Readonly<Partial<Record<FuelType, FuelOutage>>>;

/** A gas station and its current prices, as exposed by this SDK. */
export interface Station {
  /** Dataset identifier, stable across syncs (the station's `id`). */
  readonly id: string;
  readonly address: string;
  readonly city: string;
  readonly postalCode: string;
  readonly department: AdministrativeArea | null;
  readonly region: AdministrativeArea | null;
  readonly location: GeoPoint | null;
  /** `highway` for a motorway service station, `road` for any other. */
  readonly kind: 'road' | 'highway';
  /** The station has an unattended pump available 24/7. */
  readonly open24h: boolean;
  /** Free-form service labels, as worded by the feed ("Station de lavage", …). */
  readonly services: readonly string[];
  readonly prices: FuelPriceMap;
  readonly outages: FuelOutageMap;
  /** Most recent price timestamp across all fuels, ISO-8601 UTC. */
  readonly updatedAt: string | null;
}

/** What a call to `load`, `refresh` or `sync` did. */
export interface SyncResult {
  /** `full` re-reads the whole dataset, `incremental` only the price updates. */
  readonly mode: 'full' | 'incremental';
  /** Lower bound used for an incremental sync, `null` for a full one. */
  readonly since: string | null;
  /** ISO-8601 UTC timestamp the request was issued at. */
  readonly syncedAt: string;
  /** Stations returned by the API. */
  readonly fetched: number;
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Stations dropped from the cache; always 0 for an incremental sync. */
  readonly removed: number;
  /** Cache size once the result was applied. */
  readonly total: number;
  /** The stations the API returned — i.e. the delta, for an incremental sync. */
  readonly stations: readonly Station[];
}
