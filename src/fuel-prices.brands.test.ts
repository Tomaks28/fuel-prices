/** What the client does with a {@link BrandSource}: when it asks, and what it keeps. */

import { afterEach, describe, expect, it } from '@jest/globals';

import { CACHE_VERSION, type CacheEntry, type CacheStore } from './cache.js';
import { FuelPricesClient, resetFuelPricesClient } from './fuel-prices.js';
import { FuelPricesError } from './errors.js';
import { rawRecord, stubFetch } from './test-helpers.js';

import type { BrandSource } from './brands.js';
import type { RawStationRecord } from './internal/dataset.js';
import type { Station } from './types.js';

const FEED: RawStationRecord[] = [
  rawRecord(1, { ville: 'Rennes', cp: '35000', geom: { lat: 48.1173, lon: -1.6778 } }),
  rawRecord(2, { ville: 'Rennes', cp: '35000', geom: { lat: 48.12, lon: -1.68 } }),
  rawRecord(3, { ville: 'Saint-Malo', cp: '35400' }),
];

/** A source answering from a table, recording what it was asked. */
function tableSource(table: Readonly<Record<string, string>>): BrandSource & {
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    name: 'table',
    calls,
    resolve: (stations) => {
      calls.push(stations.map((station) => station.id));
      const found = new Map<string, string>();
      for (const station of stations) {
        const brand = table[station.id];
        if (brand !== undefined) found.set(station.id, brand);
      }
      return Promise.resolve(found);
    },
  };
}

function inMemoryCache(entry: CacheEntry | null): CacheStore & { entry: CacheEntry | null } {
  const store = {
    entry,
    read: () => Promise.resolve(store.entry),
    write: (next: CacheEntry) => {
      store.entry = next;
      return Promise.resolve();
    },
  };
  return store;
}

afterEach(() => {
  resetFuelPricesClient();
});

describe('without a brand source', () => {
  it('leaves every station unbranded, which is what the feed publishes', async () => {
    const client = new FuelPricesClient({ fetch: stubFetch(() => FEED).fetch });

    const stations = await client.getStations();

    expect(stations.every((station) => station.brand === null)).toBe(true);
    expect(client.lastResult?.branded).toBe(0);
  });

  it('matches nothing when asked to filter on a brand anyway', async () => {
    const client = new FuelPricesClient({ fetch: stubFetch(() => FEED).fetch });

    await expect(client.findStations({ brand: 'total' })).resolves.toEqual([]);
    await expect(client.getStationsByBrand('total')).resolves.toEqual([]);
  });
});

describe('with a brand source', () => {
  it('brands the stations it can name on the initial load', async () => {
    const source = tableSource({ '1': 'Total Access', '3': 'Super U' });
    const client = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
    });

    const result = await client.load();

    expect((await client.getStation('1'))?.brand).toBe('TotalEnergies');
    expect((await client.getStation('3'))?.brand).toBe('Système U');
    expect((await client.getStation('2'))?.brand).toBeNull();
    expect(result.branded).toBe(2);
  });

  it('asks about every station once, and only the unbranded ones after that', async () => {
    const source = tableSource({ '1': 'Total' });
    const client = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
    });

    await client.load();
    await client.sync();

    expect(source.calls[0]).toEqual(['1', '2', '3']);
    // Station 1 keeps the brand of the first pass rather than being asked twice:
    // prices move hourly, brands do not.
    expect(source.calls[1]).toEqual(['2', '3']);
  });

  it('keeps a resolved brand across a full refresh', async () => {
    const source = tableSource({ '1': 'Avia' });
    const client = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
    });

    await client.load();
    const refreshed = await client.refresh();

    expect((await client.getStation('1'))?.brand).toBe('Avia');
    expect(refreshed.branded).toBe(1);
  });

  it('reports a source that failed without failing the sync', async () => {
    const errors: FuelPricesError[] = [];
    const client = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: {
        sources: [
          {
            name: 'Overpass',
            resolve: () => Promise.reject(new FuelPricesError('boom', { code: 'http' })),
          },
        ],
        onError: (error) => errors.push(error),
      },
    });

    const result = await client.load();

    expect(result.total).toBe(3);
    expect(result.branded).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Overpass');
  });

  it('does not ask at all when every station already has a brand', async () => {
    const source = tableSource({ '1': 'Total', '2': 'Total', '3': 'Total' });
    const client = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
    });

    await client.load();
    await client.sync();

    expect(source.calls).toHaveLength(1);
  });
});

describe('brands and the cache', () => {
  it('persists them, so the next process starts already branded', async () => {
    const cache = inMemoryCache(null);
    const source = tableSource({ '1': 'Esso Express' });

    const first = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
      cache,
    });
    await first.load();

    const second = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
      cache,
    });
    const hydrated = await second.load();

    expect(hydrated.mode).toBe('cache');
    expect((await second.getStation('1'))?.brand).toBe('Esso');
    // Served from the snapshot: hydrating costs no request, not even for the
    // stations the source could not name last time.
    expect(source.calls).toHaveLength(1);
  });

  it('leaves the stations a source could not name to `refresh`', async () => {
    const cache = inMemoryCache(null);
    const source = tableSource({ '1': 'Esso' });

    const first = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
      cache,
    });
    await first.load();

    const second = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
      cache,
    });
    await second.load();
    expect(source.calls).toHaveLength(1);

    // Which is where a station mapped since the last run gets picked up.
    await second.refresh();
    expect(source.calls[1]).toEqual(['2', '3']);
  });

  it('brands a snapshot written before the option was switched on', async () => {
    const unbranded = new FuelPricesClient({ fetch: stubFetch(() => FEED).fetch });
    const cache = inMemoryCache(null);

    const seeded = new FuelPricesClient({ fetch: stubFetch(() => FEED).fetch, cache });
    await seeded.load();
    expect(cache.entry?.stations.every((station) => station.brand === null)).toBe(true);
    await unbranded.load();

    const branded = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [tableSource({ '2': 'BP' })] },
      cache,
    });
    const result = await branded.load();

    expect(result.mode).toBe('cache');
    expect((await branded.getStation('2'))?.brand).toBe('BP');
    // And written back, so the run after this one costs nothing either.
    expect(cache.entry?.stations.find((station) => station.id === '2')?.brand).toBe('BP');
  });

  it('trusts a snapshot that carries brands, and asks nobody', async () => {
    const stations: Station[] = [
      { ...(await brandedStation('1', 'Cora')) },
      { ...(await brandedStation('2', null)) },
    ];
    const cache = inMemoryCache({
      version: CACHE_VERSION,
      dataset: 'prix-des-carburants-en-france-flux-instantane-v2',
      syncedAt: new Date().toISOString(),
      stations,
    });
    const source = tableSource({});

    const client = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: { sources: [source] },
      cache,
    });
    await client.load();

    expect((await client.getStation('1'))?.brand).toBe('Cora');
    expect((await client.getStation('2'))?.brand).toBeNull();
    expect(source.calls).toEqual([]);
  });
});

describe('looking stations up by brand', () => {
  async function branded(): Promise<FuelPricesClient> {
    const client = new FuelPricesClient({
      fetch: stubFetch(() => FEED).fetch,
      brands: {
        sources: [tableSource({ '1': 'Total Access', '2': 'TotalEnergies', '3': 'Système U' })],
      },
    });
    await client.load();
    return client;
  }

  it('groups every spelling of a network together', async () => {
    const client = await branded();

    // A Total Access and a TotalEnergies are the same network once sanitized.
    expect((await client.getStationsByBrand('total')).map((station) => station.id)).toEqual([
      '1',
      '2',
    ]);
    expect((await client.getStationsByBrand('TOTAL')).map((station) => station.id)).toEqual([
      '1',
      '2',
    ]);
  });

  it('filters a query on one brand', async () => {
    const client = await branded();

    const matches = await client.findStations({ brand: 'Total Access' });

    expect(matches.map((match) => match.station.id)).toEqual(['1', '2']);
  });

  it('ORs several brands, unlike the fuels which AND', async () => {
    const client = await branded();

    const matches = await client.findStations({ brand: ['total', 'super u'] });

    expect(matches.map((match) => match.station.id)).toEqual(['1', '2', '3']);
  });

  it('combines with the other criteria', async () => {
    const client = await branded();

    const matches = await client.findStations({ brand: 'total', city: 'rennes' });

    expect(matches.map((match) => match.station.id)).toEqual(['1', '2']);
  });

  it('answers nothing for a network nobody sells', async () => {
    const client = await branded();

    expect(await client.getStationsByBrand('Repsol')).toEqual([]);
    expect(await client.findStations({ brand: 'Repsol' })).toEqual([]);
  });
});

/** One station of the feed, branded by hand, to seed a cache with. */
async function brandedStation(id: string, brand: string | null): Promise<Station> {
  const client = new FuelPricesClient({
    fetch: stubFetch(() => [rawRecord(id)]).fetch,
  });
  const [station] = await client.getStations();
  if (station === undefined) throw new Error('the fixture should build');
  return { ...station, brand };
}
