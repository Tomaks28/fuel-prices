/**
 * In-memory, self-refreshing view over the French fuel-price open data feed.
 *
 * The dataset is a single ~9 800-station snapshot with no pagination worth
 * speaking of, so the SDK holds it in memory and exposes two ways to keep it
 * current: a full {@link FuelPricesClient.refresh} and a much cheaper
 * {@link FuelPricesClient.sync} that only asks for prices changed since the
 * previous sync.
 */

import { CACHE_VERSION, type CacheEntry, type CacheStore } from './cache.js';
import { FuelPricesError } from './errors.js';
import { STATION_SELECT, updatedSinceWhere } from './internal/dataset.js';
import { assertGeoPoint, assertRadius, distanceMeters } from './internal/geo.js';
import { DatasetClient, type DatasetClientOptions } from './internal/http.js';
import { hasChanged, toStation } from './internal/normalize.js';
import { isOpenAt } from './internal/hours.js';
import { toPriceStats } from './internal/stats.js';
import { toLookupKey } from './internal/text.js';

import type {
  FuelType,
  GeoPoint,
  NearbyStation,
  PriceStats,
  Station,
  StationMatch,
  StationQuery,
  SyncResult,
} from './types.js';

export interface FuelPricesOptions extends DatasetClientOptions {
  /**
   * Safety margin subtracted from the last sync time when building the
   * incremental filter, in ms. Defaults to 5 minutes, which is the portal's own
   * cache window — without it, a station published a moment after our previous
   * request but stamped a moment before it would never be picked up.
   */
  syncOverlapMs?: number;
  /**
   * Where to persist the snapshot between runs. Hydrating from it costs no
   * request, and the persisted sync time lets the next {@link
   * FuelPricesClient.sync} ask for a delta instead of the whole dataset.
   */
  cache?: CacheStore;
  /**
   * How old a cached snapshot may be and still be used, in ms. Defaults to 24
   * hours; past that, {@link FuelPricesClient.load} ignores it and reads the
   * dataset in full.
   */
  cacheMaxAgeMs?: number;
  /**
   * Called when the cache could not be read or written. Cache failures never
   * fail a sync, so this is the only way to hear about them.
   */
  onCacheError?: (error: FuelPricesError) => void;
}

/** Options of a single {@link FuelPricesClient.sync} call. */
export interface SyncOptions {
  /** Overrides the lower bound, ignoring the last sync time. */
  since?: Date | string;
  signal?: AbortSignal;
}

const DEFAULT_SYNC_OVERLAP_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DATASET_KEY = 'prix-des-carburants-en-france-flux-instantane-v2';

export class FuelPricesClient {
  static #instance: FuelPricesClient | null = null;

  /**
   * Shared instance. `options` only apply to the call that actually creates it;
   * later calls return the existing instance untouched. Use the constructor
   * directly for an isolated instance.
   */
  static getInstance(options?: FuelPricesOptions): FuelPricesClient {
    FuelPricesClient.#instance ??= new FuelPricesClient(options);
    return FuelPricesClient.#instance;
  }

  /** Drops the shared instance, cache included. Mostly useful in tests. */
  static resetInstance(): void {
    FuelPricesClient.#instance = null;
  }

  readonly #api: DatasetClient;
  readonly #syncOverlapMs: number;
  readonly #stations = new Map<string, Station>();
  readonly #cache: CacheStore | undefined;
  readonly #cacheMaxAgeMs: number;
  readonly #datasetKey: string;
  readonly #onCacheError: ((error: FuelPricesError) => void) | undefined;

  #lastResult: SyncResult | null = null;
  #lastSyncedAt: Date | null = null;
  /** Serialises writes so two concurrent syncs cannot interleave their merges. */
  #queue: Promise<unknown> = Promise.resolve();
  #index: StationIndex | null = null;

  constructor(options: FuelPricesOptions = {}) {
    this.#api = new DatasetClient(options);
    this.#syncOverlapMs = Math.max(0, options.syncOverlapMs ?? DEFAULT_SYNC_OVERLAP_MS);
    this.#cache = options.cache;
    this.#cacheMaxAgeMs = Math.max(0, options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
    this.#datasetKey = options.dataset ?? DEFAULT_DATASET_KEY;
    this.#onCacheError = options.onCacheError;
  }

  /** The cache holds a snapshot. */
  get loaded(): boolean {
    return this.#lastSyncedAt !== null;
  }

  /** Number of stations currently cached. */
  get size(): number {
    return this.#stations.size;
  }

  /** When the last successful sync was issued. */
  get lastSyncedAt(): Date | null {
    return this.#lastSyncedAt === null ? null : new Date(this.#lastSyncedAt);
  }

  /** What the last successful sync did. */
  get lastResult(): SyncResult | null {
    return this.#lastResult;
  }

  /**
   * Initial load: fetches the whole dataset once. Idempotent — concurrent calls
   * never fetch twice and later calls are a no-op, so it is safe to call it on
   * every code path that needs data.
   */
  async load(signal?: AbortSignal): Promise<SyncResult> {
    if (this.#lastResult !== null) return this.#lastResult;

    return this.#serialize(async () => {
      // Re-checked inside the queue: a load may have completed while we waited.
      if (this.#lastResult !== null) return this.#lastResult;

      const hydrated = await this.#hydrateFromCache();
      return hydrated ?? this.#fullSync(signal);
    });
  }

  /** Re-reads the whole dataset, whatever the cache holds. */
  async refresh(signal?: AbortSignal): Promise<SyncResult> {
    return this.#serialize(async () => this.#fullSync(signal));
  }

  /**
   * Incremental sync: asks the API only for stations whose price changed since
   * the previous sync (or since `options.since`) and merges them in. Falls back
   * to a full load when nothing is cached yet.
   *
   * The upstream filter is built on the per-fuel `_maj` timestamps, so this
   * catches price changes but not stations added to — or removed from — the
   * dataset without a price update. Call {@link refresh} periodically for those.
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const explicitSince = options.since === undefined ? null : toDate(options.since, 'since');

    return this.#serialize(async () => {
      const since = explicitSince ?? this.#incrementalSince();
      if (since === null) return this.#fullSync(options.signal);
      return this.#incrementalSync(since, options.signal);
    });
  }

  /** Every cached station, loading the dataset on first use. */
  async getStations(signal?: AbortSignal): Promise<Station[]> {
    await this.load(signal);
    return [...this.#stations.values()];
  }

  /** One station by dataset id. */
  async getStation(id: string, signal?: AbortSignal): Promise<Station | undefined> {
    await this.load(signal);
    return this.#stations.get(id.trim());
  }

  /**
   * Stations of a city. Matching ignores case, accents and separators, so
   * `"saint malo"` and `"Saint-Malo"` are equivalent. Beware homonyms: the feed
   * carries no INSEE code, so filter the result on `postalCode` when it matters.
   */
  async getStationsByCity(city: string, signal?: AbortSignal): Promise<Station[]> {
    await this.load(signal);
    return [...(this.#indexes().byCity.get(toLookupKey(city)) ?? [])];
  }

  /** Stations of a postal code (`"35000"`). */
  async getStationsByPostalCode(postalCode: string, signal?: AbortSignal): Promise<Station[]> {
    await this.load(signal);
    return [...(this.#indexes().byPostalCode.get(postalCode.trim()) ?? [])];
  }

  /** Stations of a département, by INSEE code (`"35"`, `"2A"`, `"974"`). */
  async getStationsByDepartment(code: string, signal?: AbortSignal): Promise<Station[]> {
    await this.load(signal);
    return [...(this.#indexes().byDepartment.get(code.trim().toUpperCase()) ?? [])];
  }

  /**
   * Stations within `radiusMeters` of a point, nearest first, each with its
   * distance from that point.
   *
   * Distances are great-circle (haversine) on a spherical Earth, which is off by
   * well under the precision the feed publishes. Stations the dataset gave no
   * coordinates for cannot match and are left out.
   */
  async getStationsNearby(
    center: GeoPoint,
    radiusMeters: number,
    signal?: AbortSignal,
  ): Promise<NearbyStation[]> {
    assertGeoPoint(center, 'center');
    assertRadius(radiusMeters, 'radiusMeters');
    await this.load(signal);

    const found: NearbyStation[] = [];
    for (const station of this.#stations.values()) {
      if (station.location === null) continue;

      const distance = distanceMeters(center, station.location);
      if (distance <= radiusMeters) found.push({ station, distanceMeters: distance });
    }

    return found.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }

  /** Stations selling `fuel`, cheapest first. */
  async getStationsByFuel(fuel: FuelType, signal?: AbortSignal): Promise<Station[]> {
    await this.load(signal);
    return [...this.#stations.values()]
      .filter((station) => station.prices[fuel] !== undefined)
      .sort((a, b) => (a.prices[fuel]?.price ?? 0) - (b.prices[fuel]?.price ?? 0));
  }

  /**
   * Every criterion of {@link StationQuery} at once, ANDed together — the one
   * lookup the single-purpose getters above cannot express by themselves
   * ("the cheapest E85 within 10 km, open right now").
   *
   * Runs entirely against the in-memory snapshot: no request once it is warm.
   */
  async findStations(query: StationQuery = {}, signal?: AbortSignal): Promise<StationMatch[]> {
    const criteria = compileQuery(query);
    await this.load(signal);

    const candidates =
      criteria.city !== undefined
        ? (this.#indexes().byCity.get(criteria.city) ?? [])
        : criteria.postalCode !== undefined
          ? (this.#indexes().byPostalCode.get(criteria.postalCode) ?? [])
          : criteria.department !== undefined
            ? (this.#indexes().byDepartment.get(criteria.department) ?? [])
            : this.#stations.values();

    const matches: StationMatch[] = [];
    for (const station of candidates) {
      const distance = matchDistance(station, criteria);
      if (distance === false) continue;
      if (!matchesRest(station, criteria)) continue;

      matches.push({ station, distanceMeters: distance });
    }

    sortMatches(matches, criteria);
    return criteria.limit === undefined ? matches : matches.slice(0, criteria.limit);
  }

  /**
   * Price distribution of one fuel, over the whole country or over whatever
   * {@link StationQuery} narrows it to. `null` when nothing matches.
   *
   * Prices vary far too much nationally (gazole spans 1.24 to 2.80) for a single
   * quote to mean anything on its own; this is what puts one in context.
   */
  async getPriceStats(
    fuel: FuelType,
    query: StationQuery = {},
    signal?: AbortSignal,
  ): Promise<PriceStats | null> {
    const matches = await this.findStations(query, signal);
    return toPriceStats(
      matches.map((match) => match.station),
      fuel,
    );
  }

  /**
   * Whether the station is open at `when`, evaluated in `Europe/Paris`.
   *
   * `null` means the feed does not say — which is the case for roughly half the
   * day entries it publishes, so do not read it as a "no".
   */
  isOpenAt(station: Station, when: Date): boolean | null {
    return isOpenAt(station, when);
  }

  /**
   * Cached stations whose price moved after `date` — the local counterpart of
   * {@link sync}, useful to re-read a delta the cache already holds.
   */
  async getStationsUpdatedSince(date: Date | string, signal?: AbortSignal): Promise<Station[]> {
    await this.load(signal);
    const threshold = toDate(date, 'date').toISOString();
    return [...this.#stations.values()].filter(
      (station) => station.updatedAt !== null && station.updatedAt > threshold,
    );
  }

  /**
   * Fills the cache from the store, if it holds a fresh enough snapshot of this
   * dataset. Returns `null` on a miss, so the caller falls back to the network.
   */
  async #hydrateFromCache(): Promise<SyncResult | null> {
    if (this.#cache === undefined) return null;

    let entry: CacheEntry | null;
    try {
      entry = await this.#cache.read();
    } catch (error) {
      this.#reportCacheError('read', error);
      return null;
    }

    if (entry?.dataset !== this.#datasetKey) return null;

    const syncedAt = new Date(entry.syncedAt);
    if (Date.now() - syncedAt.getTime() > this.#cacheMaxAgeMs) return null;

    this.#stations.clear();
    for (const station of entry.stations) this.#stations.set(station.id, station);
    this.#index = null;

    return this.#commit({
      mode: 'cache',
      since: null,
      syncedAt: syncedAt.toISOString(),
      fetched: 0,
      added: this.#stations.size,
      updated: 0,
      unchanged: 0,
      removed: 0,
      total: this.#stations.size,
      stations: [...this.#stations.values()],
    });
  }

  /** Cache writes never fail a sync; they are reported and dropped. */
  async #persistToCache(syncedAt: string): Promise<void> {
    if (this.#cache === undefined) return;

    try {
      await this.#cache.write({
        version: CACHE_VERSION,
        dataset: this.#datasetKey,
        syncedAt,
        stations: [...this.#stations.values()],
      });
    } catch (error) {
      this.#reportCacheError('write', error);
    }
  }

  #reportCacheError(operation: 'read' | 'write', error: unknown): void {
    if (this.#onCacheError === undefined) return;

    this.#onCacheError(
      error instanceof FuelPricesError
        ? error
        : new FuelPricesError(`The cache failed to ${operation} the snapshot.`, {
            code: 'cache',
            cause: error,
          }),
    );
  }

  #incrementalSince(): Date | null {
    if (this.#lastSyncedAt === null) return null;
    return new Date(this.#lastSyncedAt.getTime() - this.#syncOverlapMs);
  }

  async #fullSync(signal: AbortSignal | undefined): Promise<SyncResult> {
    const syncedAt = new Date();
    const stations = await this.#fetchStations(undefined, signal);

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    const next = new Map<string, Station>();

    for (const station of stations) {
      const previous = this.#stations.get(station.id);
      if (previous === undefined) added += 1;
      else if (hasChanged(previous, station)) updated += 1;
      else unchanged += 1;
      next.set(station.id, station);
    }

    const removed = [...this.#stations.keys()].filter((id) => !next.has(id)).length;

    this.#stations.clear();
    for (const [id, station] of next) this.#stations.set(id, station);
    this.#index = null;
    await this.#persistToCache(syncedAt.toISOString());

    return this.#commit({
      mode: 'full',
      since: null,
      syncedAt: syncedAt.toISOString(),
      fetched: stations.length,
      added,
      updated,
      unchanged,
      removed,
      total: this.#stations.size,
      stations,
    });
  }

  async #incrementalSync(since: Date, signal: AbortSignal | undefined): Promise<SyncResult> {
    const syncedAt = new Date();
    const stations = await this.#fetchStations(updatedSinceWhere(since), signal);

    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const station of stations) {
      const previous = this.#stations.get(station.id);
      if (previous === undefined) added += 1;
      else if (hasChanged(previous, station)) updated += 1;
      else unchanged += 1;
      this.#stations.set(station.id, station);
    }

    if (added > 0 || updated > 0) this.#index = null;
    if (added > 0 || updated > 0) await this.#persistToCache(syncedAt.toISOString());

    return this.#commit({
      mode: 'incremental',
      since: since.toISOString(),
      syncedAt: syncedAt.toISOString(),
      fetched: stations.length,
      added,
      updated,
      unchanged,
      removed: 0,
      total: this.#stations.size,
      stations,
    });
  }

  async #fetchStations(
    where: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Station[]> {
    const records = await this.#api.exportStations({
      select: STATION_SELECT,
      ...(where === undefined ? {} : { where }),
      ...(signal === undefined ? {} : { signal }),
    });

    const stations: Station[] = [];
    for (const record of records) {
      const station = toStation(record);
      if (station !== null) stations.push(station);
    }
    return stations;
  }

  #commit(result: SyncResult): SyncResult {
    this.#lastResult = result;
    this.#lastSyncedAt = new Date(result.syncedAt);
    return result;
  }

  #indexes(): StationIndex {
    this.#index ??= buildIndex(this.#stations.values());
    return this.#index;
  }

  /**
   * Runs `task` after every previously queued one. A rejection is contained: the
   * caller sees it, the queue keeps going.
   */
  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** Shared instance, created on first call. */
export function getFuelPricesClient(options?: FuelPricesOptions): FuelPricesClient {
  return FuelPricesClient.getInstance(options);
}

/** Drops the shared instance, cache included. */
export function resetFuelPricesClient(): void {
  FuelPricesClient.resetInstance();
}

/** A {@link StationQuery} checked once, then reused for every candidate. */
interface Criteria {
  near: GeoPoint | undefined;
  radiusMeters: number | undefined;
  city: string | undefined;
  postalCode: string | undefined;
  department: string | undefined;
  fuels: readonly FuelType[];
  maxPrice: number | undefined;
  kind: 'road' | 'highway' | undefined;
  openAt: Date | undefined;
  /** Absolute cut-off, precomputed so every candidate compares against the same one. */
  fresherThan: string | undefined;
  sort: StationQuery['sort'];
  limit: number | undefined;
}

/** Validates the query up front, so a bad one costs no request and no scan. */
function compileQuery(query: StationQuery): Criteria {
  const fuels = query.fuel === undefined ? [] : [query.fuel].flat();

  if ((query.near === undefined) !== (query.radiusMeters === undefined)) {
    throw invalidArgument('`near` and `radiusMeters` go together; pass both or neither.');
  }
  if (query.near !== undefined) assertGeoPoint(query.near, 'near');
  if (query.radiusMeters !== undefined) assertRadius(query.radiusMeters, 'radiusMeters');

  if (query.maxPrice !== undefined) {
    if (!Number.isFinite(query.maxPrice) || query.maxPrice < 0) {
      throw invalidArgument(
        `\`maxPrice\` must be a positive number, got ${String(query.maxPrice)}.`,
      );
    }
    if (fuels.length !== 1) {
      throw invalidArgument('`maxPrice` needs exactly one `fuel` to apply to.');
    }
  }
  if (query.sort === 'distance' && query.near === undefined) {
    throw invalidArgument('Sorting by distance needs a `near` point.');
  }
  if (query.sort === 'price' && fuels.length !== 1) {
    throw invalidArgument('Sorting by price needs exactly one `fuel`.');
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
    throw invalidArgument(`\`limit\` must be a non-negative integer, got ${String(query.limit)}.`);
  }
  if (query.openAt !== undefined && Number.isNaN(query.openAt.getTime())) {
    throw invalidArgument('`openAt` is not a valid date.');
  }
  if (
    query.maxPriceAge !== undefined &&
    (!Number.isFinite(query.maxPriceAge) || query.maxPriceAge < 0)
  ) {
    throw invalidArgument(
      `\`maxPriceAge\` must be a non-negative number of ms, got ${String(query.maxPriceAge)}.`,
    );
  }

  return {
    near: query.near,
    radiusMeters: query.radiusMeters,
    city: query.city === undefined ? undefined : toLookupKey(query.city),
    postalCode: query.postalCode?.trim(),
    department: query.department?.trim().toUpperCase(),
    fuels,
    maxPrice: query.maxPrice,
    kind: query.kind,
    openAt: query.openAt,
    fresherThan:
      query.maxPriceAge === undefined
        ? undefined
        : new Date(Date.now() - query.maxPriceAge).toISOString(),
    sort: query.sort,
    limit: query.limit,
  };
}

/** The distance to report, or `false` when the station falls outside the radius. */
function matchDistance(station: Station, criteria: Criteria): number | null | false {
  if (criteria.near === undefined || criteria.radiusMeters === undefined) return null;
  if (station.location === null) return false;

  const distance = distanceMeters(criteria.near, station.location);
  return distance <= criteria.radiusMeters ? distance : false;
}

function matchesRest(station: Station, criteria: Criteria): boolean {
  // Indexed criteria are re-checked: only one of them narrows the candidates.
  if (criteria.city !== undefined && toLookupKey(station.city) !== criteria.city) return false;
  if (criteria.postalCode !== undefined && station.postalCode !== criteria.postalCode) return false;
  if (criteria.department !== undefined) {
    if (station.department?.code.toUpperCase() !== criteria.department) return false;
  }
  if (criteria.kind !== undefined && station.kind !== criteria.kind) return false;

  for (const fuel of criteria.fuels) {
    const price = station.prices[fuel];
    if (price === undefined) return false;
    if (criteria.maxPrice !== undefined && price.price > criteria.maxPrice) return false;
    // Per fuel, not per station: a station quoting gazole hourly can be sitting
    // on an E85 price from six months ago, and 7.8 % of them are.
    if (criteria.fresherThan !== undefined && !isFresh(price.updatedAt, criteria.fresherThan)) {
      return false;
    }
  }

  if (criteria.fresherThan !== undefined && criteria.fuels.length === 0) {
    if (!isFresh(station.updatedAt, criteria.fresherThan)) return false;
  }

  // An unknown schedule is not a match: the SDK cannot claim the station is open.
  return criteria.openAt === undefined || isOpenAt(station, criteria.openAt) === true;
}

/** An undated price can never be shown to be fresh, so it is not. */
function isFresh(updatedAt: string | null, fresherThan: string): boolean {
  return updatedAt !== null && updatedAt >= fresherThan;
}

function sortMatches(matches: StationMatch[], criteria: Criteria): void {
  const fuel = criteria.fuels[0];

  if (criteria.sort === 'distance') {
    matches.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
    return;
  }
  if (criteria.sort === 'price' && fuel !== undefined) {
    matches.sort(
      (a, b) => (a.station.prices[fuel]?.price ?? 0) - (b.station.prices[fuel]?.price ?? 0),
    );
    return;
  }
  if (criteria.sort === 'updatedAt') {
    matches.sort((a, b) => (b.station.updatedAt ?? '').localeCompare(a.station.updatedAt ?? ''));
    return;
  }
  // No explicit order: a radius search still reads best nearest first.
  if (criteria.near !== undefined) {
    matches.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  }
}

function invalidArgument(message: string): FuelPricesError {
  return new FuelPricesError(message, { code: 'invalid_argument' });
}

interface StationIndex {
  byCity: Map<string, Station[]>;
  byPostalCode: Map<string, Station[]>;
  byDepartment: Map<string, Station[]>;
}

function buildIndex(stations: Iterable<Station>): StationIndex {
  const index: StationIndex = {
    byCity: new Map(),
    byPostalCode: new Map(),
    byDepartment: new Map(),
  };

  for (const station of stations) {
    if (station.city) push(index.byCity, toLookupKey(station.city), station);
    if (station.postalCode) push(index.byPostalCode, station.postalCode, station);
    if (station.department?.code) {
      push(index.byDepartment, station.department.code.toUpperCase(), station);
    }
  }
  return index;
}

function push(bucket: Map<string, Station[]>, key: string, station: Station): void {
  const existing = bucket.get(key);
  if (existing === undefined) bucket.set(key, [station]);
  else existing.push(station);
}

function toDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new FuelPricesError(`\`${label}\` is not a valid date: ${String(value)}`, {
      code: 'invalid_argument',
    });
  }
  return date;
}
