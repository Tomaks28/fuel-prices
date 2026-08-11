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

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A window the station is open, as `HH:MM` local French time. */
export interface OpeningRange {
  readonly opensAt: string;
  readonly closesAt: string;
}

/**
 * One day of the week.
 *
 * `closed: false` with no `ranges` means the feed says nothing about that day —
 * roughly half of them. Do not read it as "open".
 */
export interface OpeningDay {
  readonly weekday: Weekday;
  readonly closed: boolean;
  readonly ranges: readonly OpeningRange[];
}

/** Weekly schedule, as published by the station. */
export interface OpeningHours {
  /** Unattended pump available around the clock. */
  readonly automat24h: boolean;
  readonly days: readonly OpeningDay[];
}

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
  /** Weekly schedule, `null` for the ~14 % of stations that publish none. */
  readonly openingHours: OpeningHours | null;
  readonly prices: FuelPriceMap;
  readonly outages: FuelOutageMap;
  /** Most recent price timestamp across all fuels, ISO-8601 UTC. */
  readonly updatedAt: string | null;
}

/** A station found around a point, with how far it sits from it. */
export interface NearbyStation {
  readonly station: Station;
  /** Great-circle distance from the requested point, in metres, unrounded. */
  readonly distanceMeters: number;
}

/** Distribution of one fuel's price across a set of stations. */
export interface PriceStats {
  readonly fuel: FuelType;
  /** Stations selling that fuel in the set. Never 0 — `null` is returned instead. */
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  /** Most recent price timestamp in the set, ISO-8601 UTC. */
  readonly updatedAt: string | null;
}

/** How to order the results of a query. */
export type StationSort = 'distance' | 'price' | 'updatedAt';

/**
 * Criteria of a {@link Station} search. Every field is optional and they
 * combine as a logical AND; an empty query returns the whole cache.
 */
export interface StationQuery {
  /** Centre of a radius search. Requires `radiusMeters`. */
  readonly near?: GeoPoint;
  /** Radius in metres, inclusive. Requires `near`. */
  readonly radiusMeters?: number;
  /** Case-, accent- and separator-insensitive city match. */
  readonly city?: string;
  readonly postalCode?: string;
  /** Département INSEE code, e.g. `"35"` or `"2A"`. */
  readonly department?: string;
  /** Keeps stations selling every listed fuel. */
  readonly fuel?: FuelType | readonly FuelType[];
  /** Upper bound on the price of `fuel`. Requires a single `fuel`. */
  readonly maxPrice?: number;
  readonly kind?: 'road' | 'highway';
  /** Keeps stations the feed reports as open at that instant. */
  readonly openAt?: Date;
  /** `distance` requires `near`, `price` requires a single `fuel`. */
  readonly sort?: StationSort;
  readonly limit?: number;
}

/** A station matched by {@link StationQuery}. */
export interface StationMatch {
  readonly station: Station;
  /** Distance from `near`, in metres; `null` when the query had no centre. */
  readonly distanceMeters: number | null;
}

/** What a call to `load`, `refresh` or `sync` did. */
export interface SyncResult {
  /**
   * `full` re-read the whole dataset, `incremental` only the price updates, and
   * `cache` hydrated from a {@link CacheStore} without touching the network.
   */
  readonly mode: 'full' | 'incremental' | 'cache';
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
