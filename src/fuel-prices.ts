/**
 * In-memory, self-refreshing view over the French fuel-price open data feed.
 *
 * The dataset is a single ~9 800-station snapshot with no pagination worth
 * speaking of, so the SDK holds it in memory and exposes two ways to keep it
 * current: a full {@link FuelPricesClient.refresh} and a much cheaper
 * {@link FuelPricesClient.sync} that only asks for prices changed since the
 * previous sync.
 */

import { FuelPricesError } from './errors.js';
import { STATION_SELECT, updatedSinceWhere } from './internal/dataset.js';
import { assertGeoPoint, assertRadius, distanceMeters } from './internal/geo.js';
import { DatasetClient, type DatasetClientOptions } from './internal/http.js';
import { hasChanged, toStation } from './internal/normalize.js';
import { toLookupKey } from './internal/text.js';

import type { FuelType, GeoPoint, NearbyStation, Station, SyncResult } from './types.js';

export interface FuelPricesOptions extends DatasetClientOptions {
  /**
   * Safety margin subtracted from the last sync time when building the
   * incremental filter, in ms. Defaults to 5 minutes, which is the portal's own
   * cache window — without it, a station published a moment after our previous
   * request but stamped a moment before it would never be picked up.
   */
  syncOverlapMs?: number;
}

/** Options of a single {@link FuelPricesClient.sync} call. */
export interface SyncOptions {
  /** Overrides the lower bound, ignoring the last sync time. */
  since?: Date | string;
  signal?: AbortSignal;
}

const DEFAULT_SYNC_OVERLAP_MS = 5 * 60 * 1000;

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

  #lastResult: SyncResult | null = null;
  #lastSyncedAt: Date | null = null;
  /** Serialises writes so two concurrent syncs cannot interleave their merges. */
  #queue: Promise<unknown> = Promise.resolve();
  #index: StationIndex | null = null;

  constructor(options: FuelPricesOptions = {}) {
    this.#api = new DatasetClient(options);
    this.#syncOverlapMs = Math.max(0, options.syncOverlapMs ?? DEFAULT_SYNC_OVERLAP_MS);
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
      return this.#fullSync(signal);
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
