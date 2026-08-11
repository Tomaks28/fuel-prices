/** `findStations`, `getPriceStats` and the cache option of the client. */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { CACHE_VERSION, type CacheEntry, type CacheStore } from './cache.js';
import { FuelPricesClient, resetFuelPricesClient } from './fuel-prices.js';
import { toStation } from './internal/normalize.js';
import { expectDefined, rawRecord, stubFetch } from './test-helpers.js';

import type { RawStationRecord } from './internal/dataset.js';
import type { StationQuery } from './types.js';

const DATASET = 'prix-des-carburants-en-france-flux-instantane-v2';
const MONDAY_9AM = new Date('2026-08-10T07:00:00.000Z');

/** Open Monday 08:00-19:00 only. */
const MONDAY_ONLY = JSON.stringify({
  '@automate-24-24': '',
  jour: [{ '@id': '1', '@ferme': '', horaire: { '@ouverture': '08.00', '@fermeture': '19.00' } }],
});

/** Rennes, place de la République, and points at known distances from it. */
const CENTER = { latitude: 48.1173, longitude: -1.6778 };

const FEED: RawStationRecord[] = [
  // 0 m, road, gazole 2.10 + e85 0.80, open Mondays.
  rawRecord(1, {
    ville: 'Rennes',
    cp: '35000',
    code_departement: '35',
    geom: { lat: 48.1173, lon: -1.6778 },
    gazole_prix: 2.1,
    e85_prix: 0.8,
    e85_maj: '2026-08-11T10:00:00+00:00',
    horaires: MONDAY_ONLY,
  }),
  // ~1.1 km, motorway, gazole 1.95, no schedule at all.
  rawRecord(2, {
    ville: 'Rennes',
    cp: '35000',
    code_departement: '35',
    geom: { lat: 48.1273, lon: -1.6778 },
    pop: 'A',
    gazole_prix: 1.95,
  }),
  // ~2.2 km, road, gazole 2.4, closed Mondays.
  rawRecord(3, {
    ville: 'Rennes',
    cp: '35700',
    code_departement: '35',
    geom: { lat: 48.1373, lon: -1.6778 },
    gazole_prix: 2.4,
    horaires: JSON.stringify({ '@automate-24-24': '', jour: [{ '@id': '1', '@ferme': '1' }] }),
  }),
  // Far away, other département, gazole 1.5, 24/7 automat.
  rawRecord(4, {
    ville: 'Brest',
    cp: '29200',
    code_departement: '29',
    departement: 'Finistère',
    geom: { lat: 48.3904, lon: -4.4861 },
    gazole_prix: 1.5,
    horaires: JSON.stringify({ '@automate-24-24': '1', jour: [] }),
  }),
  // No coordinates, so a radius search can never match it; keeps the factory's
  // default gazole at 1.90.
  rawRecord(5, { ville: 'Nulle part', cp: '00000', code_departement: '35', geom: null }),
];

function client(feed: RawStationRecord[] = FEED): FuelPricesClient {
  return new FuelPricesClient({ fetch: stubFetch(() => feed).fetch, retries: 0 });
}

/** Collects the ids a query matched, in the order it returned them. */
async function ids(query?: StationQuery): Promise<string[]> {
  const matches = await client().findStations(query);
  return matches.map((match) => match.station.id);
}

afterEach(() => {
  resetFuelPricesClient();
  jest.useRealTimers();
});

describe('findStations', () => {
  it('returns the whole cache for an empty query', async () => {
    expect(await ids({})).toEqual(['1', '2', '3', '4', '5']);
    expect(await ids()).toHaveLength(5);
  });

  it('reports a distance only when the query has a centre', async () => {
    const [withCentre] = await client().findStations({ near: CENTER, radiusMeters: 100 });
    const [without] = await client().findStations({ city: 'Rennes' });

    expect(withCentre?.distanceMeters).toBe(0);
    expect(without?.distanceMeters).toBeNull();
  });

  it('filters on a radius, nearest first by default', async () => {
    expect(await ids({ near: CENTER, radiusMeters: 3_000 })).toEqual(['1', '2', '3']);
    expect(await ids({ near: CENTER, radiusMeters: 1_500 })).toEqual(['1', '2']);
  });

  it('filters on place', async () => {
    expect(await ids({ city: 'rennes' })).toEqual(['1', '2', '3']);
    expect(await ids({ postalCode: '35000' })).toEqual(['1', '2']);
    expect(await ids({ department: '29' })).toEqual(['4']);
  });

  it('filters on the station kind', async () => {
    expect(await ids({ kind: 'highway' })).toEqual(['2']);
    expect(await ids({ kind: 'road' })).toEqual(['1', '3', '4', '5']);
  });

  it('filters on a fuel being sold', async () => {
    expect(await ids({ fuel: 'e85' })).toEqual(['1']);
    expect(await ids({ fuel: 'gplc' })).toEqual([]);
  });

  it('requires every fuel of a list', async () => {
    expect(await ids({ fuel: ['gazole', 'e85'] })).toEqual(['1']);
    expect(await ids({ fuel: ['gazole'] })).toEqual(['1', '2', '3', '4', '5']);
  });

  it('filters on a price ceiling', async () => {
    expect(await ids({ fuel: 'gazole', maxPrice: 2 })).toEqual(['2', '4', '5']);
    expect(await ids({ fuel: 'gazole', maxPrice: 1.4 })).toEqual([]);
  });

  it('filters on being open, and excludes what the feed cannot vouch for', async () => {
    // 1 opens Mondays, 4 is a 24/7 automat; 2 has no schedule, 3 is closed.
    expect(await ids({ openAt: MONDAY_9AM })).toEqual(['1', '4']);
    // Sunday: only the automat.
    expect(await ids({ openAt: new Date('2026-08-16T10:00:00.000Z') })).toEqual(['4']);
  });

  it('ANDs the criteria together', async () => {
    expect(
      await ids({
        near: CENTER,
        radiusMeters: 3_000,
        fuel: 'gazole',
        maxPrice: 2.2,
        kind: 'road',
        openAt: MONDAY_9AM,
      }),
    ).toEqual(['1']);
  });

  it('answers the question the one-dimensional getters cannot', async () => {
    // "The cheapest gazole within 3 km, open right now."
    const [cheapest] = await client().findStations({
      near: CENTER,
      radiusMeters: 3_000,
      fuel: 'gazole',
      openAt: MONDAY_9AM,
      sort: 'price',
      limit: 1,
    });

    expect(cheapest?.station.id).toBe('1');
    expect(cheapest?.distanceMeters).toBe(0);
  });

  it('sorts by price, distance or freshness on request', async () => {
    // 1.50, 1.90, 1.95, 2.10, 2.40
    expect(await ids({ fuel: 'gazole', sort: 'price' })).toEqual(['4', '5', '2', '1', '3']);
    expect(await ids({ near: CENTER, radiusMeters: 500_000, sort: 'distance' })).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);

    expect(await ids({ fuel: 'gazole', sort: 'updatedAt' })).toHaveLength(5);
  });

  it('caps the result set', async () => {
    expect(await ids({ near: CENTER, radiusMeters: 3_000, limit: 2 })).toEqual(['1', '2']);
    expect(await ids({ limit: 0 })).toEqual([]);
  });

  it('leaves an unlocated station out of a radius search but not out of the rest', async () => {
    expect(await ids({ near: CENTER, radiusMeters: 20_000_000 })).not.toContain('5');
    expect(await ids({ department: '35' })).toContain('5');
  });

  it.each([
    ['a centre without a radius', { near: CENTER }],
    ['a radius without a centre', { radiusMeters: 1_000 }],
    ['a point off the globe', { near: { latitude: 91, longitude: 0 }, radiusMeters: 10 }],
    ['a negative radius', { near: CENTER, radiusMeters: -1 }],
    ['a price ceiling without a fuel', { maxPrice: 2 }],
    ['a price ceiling with two fuels', { fuel: ['gazole', 'e85'] as const, maxPrice: 2 }],
    ['a negative price ceiling', { fuel: 'gazole' as const, maxPrice: -1 }],
    ['sorting by distance with no centre', { sort: 'distance' as const }],
    ['sorting by price with no fuel', { sort: 'price' as const }],
    ['a fractional limit', { limit: 1.5 }],
    ['a negative limit', { limit: -1 }],
    ['an unreadable openAt', { openAt: new Date('nonsense') }],
  ])('rejects %s', async (_label, query) => {
    await expect(client().findStations(query)).rejects.toMatchObject({
      name: 'FuelPricesError',
      code: 'invalid_argument',
    });
  });

  it('validates before it loads, so a bad query costs no request', async () => {
    const stub = stubFetch(() => FEED);
    const guarded = new FuelPricesClient({ fetch: stub.fetch });

    await expect(guarded.findStations({ near: CENTER })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    expect(stub.calls).toBe(0);
  });

  it('loads the dataset on first use', async () => {
    const stub = stubFetch(() => FEED);
    const cold = new FuelPricesClient({ fetch: stub.fetch });

    expect(await cold.findStations({ city: 'Rennes' })).toHaveLength(3);
    expect(stub.calls).toBe(1);
  });
});

describe('getPriceStats', () => {
  it('describes a fuel nationally', async () => {
    const stats = await client().getPriceStats('gazole');

    expect(stats).toMatchObject({ fuel: 'gazole', count: 5, min: 1.5, max: 2.4 });
  });

  it('narrows to whatever the query narrows to', async () => {
    const rennes = await client().getPriceStats('gazole', { city: 'Rennes' });
    const nearby = await client().getPriceStats('gazole', { near: CENTER, radiusMeters: 1_500 });

    expect(rennes).toMatchObject({ count: 3, min: 1.95, max: 2.4 });
    expect(nearby).toMatchObject({ count: 2, min: 1.95, max: 2.1 });
  });

  it('puts one station in context', async () => {
    const stats = expectDefined(
      await client().getPriceStats('gazole', { city: 'Rennes' }),
      'stats',
    );
    const station = expectDefined(await client().getStation('3'), 'station');

    expect(station.prices.gazole?.price).toBeGreaterThan(stats.median);
  });

  it('returns null when nothing in the set sells it', async () => {
    expect(await client().getPriceStats('gplc')).toBeNull();
    expect(await client().getPriceStats('gazole', { city: 'Bruxelles' })).toBeNull();
  });

  it('rejects the same bad queries findStations does', async () => {
    await expect(client().getPriceStats('gazole', { sort: 'price' })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });
});

describe('isOpenAt', () => {
  it('answers for a station of the cache', async () => {
    const instance = client();
    const monday = expectDefined(await instance.getStation('1'), 'station');
    const closedOnMonday = expectDefined(await instance.getStation('3'), 'station');
    const noSchedule = expectDefined(await instance.getStation('2'), 'station');

    expect(instance.isOpenAt(monday, MONDAY_9AM)).toBe(true);
    expect(instance.isOpenAt(closedOnMonday, MONDAY_9AM)).toBe(false);
    expect(instance.isOpenAt(noSchedule, MONDAY_9AM)).toBeNull();
    // Station 1 publishes a Monday and nothing else, so a Sunday is unknown
    // rather than closed.
    expect(instance.isOpenAt(monday, new Date('2026-08-16T10:00:00.000Z'))).toBeNull();
  });
});

describe('the cache option', () => {
  /** An in-memory {@link CacheStore} that records what it was asked to do. */
  function memoryCache(initial: CacheEntry | null = null): CacheStore & {
    entry: CacheEntry | null;
    reads: number;
    writes: number;
  } {
    const store = {
      entry: initial,
      reads: 0,
      writes: 0,
      read: (): Promise<CacheEntry | null> => {
        store.reads += 1;
        return Promise.resolve(store.entry);
      },
      write: (entry: CacheEntry): Promise<void> => {
        store.writes += 1;
        store.entry = entry;
        return Promise.resolve();
      },
    };
    return store;
  }

  function snapshot(syncedAt: string, records = FEED): CacheEntry {
    const stations = records.map((record) => expectDefined(toStation(record), 'station'));
    return { version: CACHE_VERSION, dataset: DATASET, syncedAt, stations };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
  });

  it('writes the snapshot after a full load', async () => {
    const cache = memoryCache();
    const stub = stubFetch(() => FEED);
    await new FuelPricesClient({ fetch: stub.fetch, cache }).load();

    expect(cache.writes).toBe(1);
    expect(cache.entry).toMatchObject({
      version: CACHE_VERSION,
      dataset: DATASET,
      syncedAt: '2026-08-11T12:00:00.000Z',
    });
    expect(cache.entry?.stations).toHaveLength(5);
  });

  it('hydrates from the cache without a single request', async () => {
    const cache = memoryCache(snapshot('2026-08-11T11:00:00.000Z'));
    const stub = stubFetch(() => FEED);
    const instance = new FuelPricesClient({ fetch: stub.fetch, cache });

    const result = await instance.load();

    expect(stub.calls).toBe(0);
    expect(result).toMatchObject({
      mode: 'cache',
      syncedAt: '2026-08-11T11:00:00.000Z',
      total: 5,
      fetched: 0,
    });
    expect(instance.size).toBe(5);
    expect(await instance.findStations({ city: 'Rennes' })).toHaveLength(3);
  });

  it('turns the next sync into a delta anchored on the persisted time', async () => {
    const cache = memoryCache(snapshot('2026-08-11T11:00:00.000Z'));
    const stub = stubFetch(() => []);
    const instance = new FuelPricesClient({ fetch: stub.fetch, cache });

    await instance.load();
    const delta = await instance.sync();

    expect(delta.mode).toBe('incremental');
    // 11:00 persisted, minus the five-minute overlap.
    expect(delta.since).toBe('2026-08-11T10:55:00.000Z');
    expect(stub.lastParams().get('where')).toContain("date'2026-08-11T10:55:00.000Z'");
  });

  it('ignores a snapshot older than cacheMaxAgeMs', async () => {
    const cache = memoryCache(snapshot('2026-08-09T12:00:00.000Z')); // two days old
    const stub = stubFetch(() => FEED);

    const result = await new FuelPricesClient({ fetch: stub.fetch, cache }).load();

    expect(result.mode).toBe('full');
    expect(stub.calls).toBe(1);
  });

  it('honours a custom cacheMaxAgeMs', async () => {
    const cache = memoryCache(snapshot('2026-08-11T11:00:00.000Z')); // one hour old
    const stub = stubFetch(() => FEED);

    const result = await new FuelPricesClient({
      fetch: stub.fetch,
      cache,
      cacheMaxAgeMs: 60_000,
    }).load();

    expect(result.mode).toBe('full');
  });

  it('ignores a snapshot of another dataset', async () => {
    const cache = memoryCache({
      ...snapshot('2026-08-11T11:30:00.000Z'),
      dataset: 'something-else',
    });
    const stub = stubFetch(() => FEED);

    expect((await new FuelPricesClient({ fetch: stub.fetch, cache }).load()).mode).toBe('full');
  });

  it('falls back to the network when the cache throws on read', async () => {
    const errors: string[] = [];
    const cache: CacheStore = {
      read: () => Promise.reject(new Error('disk on fire')),
      write: () => Promise.resolve(),
    };
    const stub = stubFetch(() => FEED);

    const result = await new FuelPricesClient({
      fetch: stub.fetch,
      cache,
      onCacheError: (error) => errors.push(error.code),
    }).load();

    expect(result.mode).toBe('full');
    expect(errors).toEqual(['cache']);
  });

  it('does not fail a sync because the cache could not be written', async () => {
    const errors: string[] = [];
    const cache: CacheStore = {
      read: () => Promise.resolve(null),
      write: () => Promise.reject(new Error('no space left')),
    };
    const stub = stubFetch(() => FEED);
    const instance = new FuelPricesClient({
      fetch: stub.fetch,
      cache,
      onCacheError: (error) => errors.push(error.message),
    });

    await expect(instance.load()).resolves.toMatchObject({ mode: 'full', total: 5 });
    expect(errors).toHaveLength(1);
    expect(instance.size).toBe(5);
  });

  it('stays quiet about cache failures when no handler is given', async () => {
    const cache: CacheStore = {
      read: () => Promise.reject(new Error('nope')),
      write: () => Promise.reject(new Error('nope')),
    };

    await expect(
      new FuelPricesClient({ fetch: stubFetch(() => FEED).fetch, cache }).load(),
    ).resolves.toMatchObject({ mode: 'full' });
  });

  it('persists again after a delta that changed something', async () => {
    const cache = memoryCache(snapshot('2026-08-11T11:00:00.000Z'));
    let feed = FEED;
    const instance = new FuelPricesClient({ fetch: stubFetch(() => feed).fetch, cache });
    await instance.load();
    expect(cache.writes).toBe(0);

    feed = [rawRecord(1, { ville: 'Rennes', gazole_prix: 1.11 })];
    await instance.sync();

    expect(cache.writes).toBe(1);
    expect(cache.entry?.syncedAt).toBe('2026-08-11T12:00:00.000Z');
  });

  it('does not rewrite the cache for a delta that changed nothing', async () => {
    const cache = memoryCache(snapshot('2026-08-11T11:00:00.000Z'));
    const instance = new FuelPricesClient({ fetch: stubFetch(() => []).fetch, cache });

    await instance.load();
    await instance.sync();

    expect(cache.writes).toBe(0);
  });
});
