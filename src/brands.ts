/**
 * Where the brand of a station comes from.
 *
 * The official feed carries none: it publishes the six legal fuel categories per
 * station and nothing about the network selling them. So the brand is grafted on
 * from elsewhere, and "elsewhere" is a choice with real trade-offs — hence a
 * {@link BrandSource} seam rather than one hard-wired provider.
 *
 * Two are shipped:
 *
 * - {@link overpassBrands} reads OpenStreetMap. One request brands the whole
 *   dataset, but OSM knows coordinates rather than station ids, so it matches by
 *   proximity and can mistake a neighbouring pump for the station.
 * - {@link prixCarburantsBrands} reads the 2àZ reuse of the same official data,
 *   completed with the enseignes shown on prix-carburants.gouv.fr. It matches on
 *   the station id — exactly, no tolerance — at one request per station.
 *
 * They compose: list them in order and each one only sees the stations the
 * previous ones could not brand.
 */

import { FuelPricesError } from './errors.js';
import { sanitizeBrand } from './internal/brand.js';
import {
  BrandIndex,
  coveringBoxes,
  tileKey,
  type BoundingBox,
  type BrandPoint,
} from './internal/brand-index.js';
import { mapWithConcurrency } from './internal/async.js';
import { OverpassClient, type OverpassClientOptions } from './internal/overpass.js';
import {
  PrixCarburantsClient,
  type PrixCarburantsClientOptions,
} from './internal/prix-carburants.js';

import type { GeoPoint, Station } from './types.js';

export type { BoundingBox } from './internal/brand-index.js';

/**
 * Something that can name the network of a station.
 *
 * Implement it to plug your own referential in — a CSV of your own, a paid
 * provider, a table in your database. Whatever it returns is sanitized by the
 * SDK before it reaches a {@link Station}, so it may return raw values.
 */
export interface BrandSource {
  /** Named in the error the SDK reports when this source fails. */
  readonly name: string;
  /**
   * Brands for `stations`, keyed by station id. Stations it cannot name are
   * simply absent from the map — an empty map is a valid answer, not a failure.
   *
   * Never called with an empty list.
   */
  resolve(stations: readonly Station[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>>;
}

export interface OverpassBrandsOptions extends OverpassClientOptions {
  /**
   * How far an OSM fuel node may sit from the station and still be it, in
   * metres. Defaults to 150.
   *
   * The two sources place the same station differently — the feed rounds, OSM
   * maps the forecourt — so a few tens of metres are normal. Raising this buys
   * coverage and pays for it in false positives: at 300 m, an urban station can
   * capture the garage pump across the street.
   */
  maxDistanceMeters?: number;
  /**
   * Query these boxes instead of deriving them from the stations. Useful to pin
   * one region, or to keep the query small in tests.
   *
   * Bear in mind what the derived ones avoid: a box over an area with no station
   * in it still costs the interpreter the time to search it.
   */
  areas?: readonly BoundingBox[];
}

const DEFAULT_MAX_DISTANCE_M = 150;

/**
 * Brands from OpenStreetMap, matched by proximity.
 *
 * The returned source keeps what it downloaded: the first call pays for the
 * query, later ones — an incremental sync, another client method — are served
 * from memory as long as they stay in the areas already covered.
 */
export function overpassBrands(options: OverpassBrandsOptions = {}): BrandSource {
  const client = new OverpassClient(options);
  const maxDistanceMeters = options.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE_M;
  const areas = options.areas;

  const points: BrandPoint[] = [];
  const covered = new Set<string>();
  let index: BrandIndex | null = null;

  /** Downloads whatever `locations` needs and that we do not already hold. */
  async function cover(locations: readonly GeoPoint[], signal?: AbortSignal): Promise<void> {
    if (areas !== undefined) {
      if (covered.size > 0) return;
      covered.add('explicit');
      points.push(...(await client.fetchBrandPoints(areas, signal)));
      index = null;
      return;
    }

    const missing = locations.filter((location) => !covered.has(tileKey(location)));
    if (missing.length === 0) return;

    // Padded by the match radius: a node just outside the stations' own box can
    // still be the closest one to a station sitting on its edge.
    const boxes = coveringBoxes(missing, maxDistanceMeters);
    points.push(...(await client.fetchBrandPoints(boxes, signal)));

    for (const location of missing) covered.add(tileKey(location));
    index = null;
  }

  return {
    name: 'OpenStreetMap (Overpass)',

    async resolve(stations, signal) {
      const located = stations.filter(
        (station): station is Station & { location: GeoPoint } => station.location !== null,
      );
      if (located.length === 0) return new Map();

      await cover(
        located.map((station) => station.location),
        signal,
      );
      index ??= new BrandIndex(points);

      const brands = new Map<string, string>();
      for (const station of located) {
        const brand = index.nearest(station.location, maxDistanceMeters);
        if (brand !== null) brands.set(station.id, brand);
      }
      return brands;
    },
  };
}

export interface PrixCarburantsBrandsOptions extends PrixCarburantsClientOptions {
  /** Requests in flight at once. Defaults to 4 — it is a small, free service. */
  concurrency?: number;
  /**
   * Ceiling on the requests one `resolve` may issue. Defaults to 500.
   *
   * This source spends one request per station, so branding ~9 800 of them means
   * ~9 800 requests. The ceiling is what stops a `load()` from turning into that
   * by accident: past it, the remaining stations simply keep no brand, and
   * `SyncResult.branded` tells you how far it got. Raise it deliberately, or put
   * this source behind {@link overpassBrands} so it only fills the gaps.
   */
  maxRequests?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_REQUESTS = 500;

/** Brands from the 2àZ prix-carburants reuse, matched on the station id. */
export function prixCarburantsBrands(options: PrixCarburantsBrandsOptions = {}): BrandSource {
  const client = new PrixCarburantsClient(options);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxRequests = Math.max(0, options.maxRequests ?? DEFAULT_MAX_REQUESTS);

  return {
    name: 'prix-carburants (2àZ)',

    async resolve(stations, signal) {
      // Sorted, so a run capped at `maxRequests` covers the same stations as the
      // last one and the cache fills up instead of churning.
      const ids = stations
        .map((station) => station.id)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, maxRequests);
      if (ids.length === 0) return new Map();

      // One 500 or one dropped connection should cost one station, not the whole
      // batch — but a service that is down should be reported rather than read
      // as "no station has a brand".
      const tolerated = Math.max(5, Math.trunc(ids.length / 10));
      let failures = 0;
      let lastError: unknown;

      const found = await mapWithConcurrency(ids, concurrency, async (id) => {
        try {
          return [id, await client.fetchBrand(id, signal)] as const;
        } catch (error) {
          if (isAbort(error)) throw error;
          failures += 1;
          lastError = error;
          return [id, null] as const;
        }
      });

      if (failures > tolerated) throw lastError;

      const brands = new Map<string, string>();
      for (const [id, brand] of found) {
        if (brand !== null) brands.set(id, brand);
      }
      return brands;
    },
  };
}

/**
 * Runs the sources in order and sanitizes what they return, so a station ends up
 * with the first canonical brand anybody could name it with.
 *
 * A source that throws is skipped, not fatal: brands are an enrichment, and the
 * prices they decorate are already in hand. The caller hears about it through
 * `onError`. An abort is the exception — that one is the caller's own doing.
 */
export async function resolveBrands(
  sources: readonly BrandSource[],
  stations: readonly Station[],
  options: {
    signal?: AbortSignal | undefined;
    onError?: ((error: FuelPricesError) => void) | undefined;
  } = {},
): Promise<ReadonlyMap<string, string>> {
  const resolved = new Map<string, string>();

  for (const source of sources) {
    const pending = stations.filter((station) => !resolved.has(station.id));
    if (pending.length === 0) break;

    let found: ReadonlyMap<string, string>;
    try {
      found = await source.resolve(pending, options.signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      options.onError?.(asBrandError(source, error));
      continue;
    }

    for (const [id, raw] of found) {
      // Sanitized here rather than in each source: a custom source gets the same
      // guarantee, and running it twice over a value changes nothing.
      const brand = sanitizeBrand(raw);
      if (brand !== null) resolved.set(id, brand);
    }
  }

  return resolved;
}

function isAbort(error: unknown): boolean {
  return error instanceof FuelPricesError && error.code === 'aborted';
}

function asBrandError(source: BrandSource, error: unknown): FuelPricesError {
  const reason = error instanceof Error ? error.message : String(error);
  return new FuelPricesError(`The brand source "${source.name}" failed: ${reason}`, {
    code: error instanceof FuelPricesError ? error.code : 'network',
    ...(error instanceof FuelPricesError && error.status !== undefined
      ? { status: error.status }
      : {}),
    cause: error,
  });
}
