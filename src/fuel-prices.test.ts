import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { FuelPricesClient, getFuelPricesClient, resetFuelPricesClient } from './fuel-prices.js';
import {
  expectDefined,
  jsonResponse,
  rawRecord,
  recordingFetch,
  stubFetch,
  type RecordingFetch,
} from './test-helpers.js';

import type { RawStationRecord } from './internal/dataset.js';

/** A client whose feed the test can rewrite between syncs. */
function scenario(initial: RawStationRecord[]): {
  client: FuelPricesClient;
  stub: RecordingFetch;
  feed: (records: RawStationRecord[]) => void;
} {
  let records = initial;
  const stub = stubFetch(() => records);

  return {
    client: new FuelPricesClient({ fetch: stub.fetch, retries: 0 }),
    stub,
    feed: (next) => {
      records = next;
    },
  };
}

const SAINT_MALO = rawRecord(1);
const SAINT_MALO_2 = rawRecord(2);
const RENNES = rawRecord(3, { ville: 'Rennes', cp: '35000' });

afterEach(() => {
  resetFuelPricesClient();
  jest.useRealTimers();
});

describe('the shared instance', () => {
  it('hands the same object to both accessors', () => {
    const fromFunction = getFuelPricesClient();

    expect(FuelPricesClient.getInstance()).toBe(fromFunction);
    expect(getFuelPricesClient()).toBe(fromFunction);
  });

  it('only applies the options of the call that creates it', () => {
    const first = getFuelPricesClient({ timeoutMs: 1 });

    expect(
      getFuelPricesClient({
        fetch: () => {
          throw new Error('never used');
        },
      }),
    ).toBe(first);
  });

  it('is replaced after a reset, cache included', async () => {
    const stub = stubFetch(() => [SAINT_MALO]);
    const first = getFuelPricesClient({ fetch: stub.fetch });
    await first.load();
    expect(first.size).toBe(1);

    resetFuelPricesClient();
    const second = getFuelPricesClient({ fetch: stub.fetch });

    expect(second).not.toBe(first);
    expect(second.loaded).toBe(false);
    expect(second.size).toBe(0);
  });

  it('lets an isolated instance keep its own cache', async () => {
    const shared = getFuelPricesClient({ fetch: stubFetch(() => [SAINT_MALO]).fetch });
    const isolated = new FuelPricesClient({ fetch: stubFetch(() => [SAINT_MALO, RENNES]).fetch });

    await Promise.all([shared.load(), isolated.load()]);

    expect(shared.size).toBe(1);
    expect(isolated.size).toBe(2);
  });
});

describe('load', () => {
  it('reads the whole dataset and reports it as a full sync', async () => {
    const { client, stub } = scenario([SAINT_MALO, SAINT_MALO_2, RENNES]);

    const result = await client.load();

    expect(result).toMatchObject({
      mode: 'full',
      since: null,
      fetched: 3,
      added: 3,
      updated: 0,
      unchanged: 0,
      removed: 0,
      total: 3,
    });
    expect(result.stations).toHaveLength(3);
    expect(stub.lastParams().has('where')).toBe(false);
    expect(expectDefined(stub.lastParams().get('select'), 'select')).toContain('gplc_rupture_type');
  });

  it('does nothing on a second call', async () => {
    const { client, stub } = scenario([SAINT_MALO]);

    const first = await client.load();
    const second = await client.load();

    expect(second).toBe(first);
    expect(stub.calls).toBe(1);
  });

  it('issues a single request for concurrent callers', async () => {
    const { client, stub } = scenario([SAINT_MALO]);

    await Promise.all([
      client.load(),
      client.load(),
      client.getStations(),
      client.getStationsByCity('saint-malo'),
      client.getStation('1'),
    ]);

    expect(stub.calls).toBe(1);
  });

  it('is implied by every getter', async () => {
    const { client, stub } = scenario([SAINT_MALO]);

    expect(await client.getStations()).toHaveLength(1);
    expect(stub.calls).toBe(1);
  });

  it('exposes when it last synced, and nothing before that', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const { client } = scenario([SAINT_MALO]);

    expect(client.lastSyncedAt).toBeNull();
    expect(client.lastResult).toBeNull();
    expect(client.loaded).toBe(false);

    await client.load();

    expect(client.lastSyncedAt).toEqual(new Date('2026-08-11T12:00:00.000Z'));
    expect(client.loaded).toBe(true);
  });

  it('hands out a copy of its sync date, so a caller cannot rewrite it', async () => {
    const { client } = scenario([SAINT_MALO]);
    await client.load();

    const date = expectDefined(client.lastSyncedAt, 'lastSyncedAt');
    date.setFullYear(1999);

    expect(client.lastSyncedAt?.getFullYear()).not.toBe(1999);
  });

  it('skips a record the SDK cannot key on', async () => {
    const { client } = scenario([SAINT_MALO, rawRecord('', { id: null })]);

    const result = await client.load();

    expect(result.fetched).toBe(1);
    expect(client.size).toBe(1);
  });
});

describe('refresh', () => {
  it('re-reads the dataset even when the cache is warm', async () => {
    const { client, stub, feed } = scenario([SAINT_MALO]);
    await client.load();

    feed([rawRecord(1, { gazole_prix: 1.75 })]);
    const result = await client.refresh();

    expect(stub.calls).toBe(2);
    expect(result).toMatchObject({ mode: 'full', fetched: 1, added: 0, updated: 1, unchanged: 0 });
    expect((await client.getStation('1'))?.prices.gazole?.price).toBe(1.75);
  });

  it('drops the stations that vanished upstream', async () => {
    const { client, feed } = scenario([SAINT_MALO, SAINT_MALO_2, RENNES]);
    await client.load();

    feed([SAINT_MALO]);
    const result = await client.refresh();

    expect(result).toMatchObject({ mode: 'full', fetched: 1, removed: 2, total: 1 });
    expect(await client.getStationsByCity('rennes')).toEqual([]);
  });

  it('counts a station that came back unchanged', async () => {
    const { client } = scenario([SAINT_MALO, RENNES]);
    await client.load();

    expect(await client.refresh()).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 2,
      removed: 0,
    });
  });
});

describe('sync', () => {
  it('asks only for what changed since the last sync', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const { client, stub } = scenario([SAINT_MALO]);
    await client.load();

    jest.setSystemTime(new Date('2026-08-11T12:30:00.000Z'));
    const result = await client.sync();

    // The bound is anchored on the previous sync (12:00), not on now, minus the
    // default five-minute overlap.
    expect(result).toMatchObject({
      mode: 'incremental',
      since: '2026-08-11T11:55:00.000Z',
      syncedAt: '2026-08-11T12:30:00.000Z',
    });
    const where = expectDefined(stub.lastParams().get('where'), 'where');
    expect(where.split(' or ')).toHaveLength(6);
    expect(where).toContain("gazole_maj > date'2026-08-11T11:55:00.000Z'");
  });

  it('applies the configured overlap instead of the default', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const stub = stubFetch(() => [SAINT_MALO]);
    const client = new FuelPricesClient({ fetch: stub.fetch, syncOverlapMs: 0 });
    await client.load();

    expect(await client.sync()).toMatchObject({ since: '2026-08-11T12:00:00.000Z' });
  });

  it('falls back to a full read when nothing is cached yet', async () => {
    const { client, stub } = scenario([SAINT_MALO]);

    expect(await client.sync()).toMatchObject({ mode: 'full', added: 1 });
    expect(stub.lastParams().has('where')).toBe(false);
  });

  it('merges the delta into the cache and counts it', async () => {
    const { client, feed } = scenario([SAINT_MALO, SAINT_MALO_2]);
    await client.load();

    feed([
      rawRecord(1, { gazole_prix: 1.75, gazole_maj: '2026-08-11T12:00:00+00:00' }), // updated
      SAINT_MALO_2, // unchanged
      rawRecord(4, { ville: 'Dinard', cp: '35800' }), // new station
    ]);
    const result = await client.sync();

    expect(result).toMatchObject({
      mode: 'incremental',
      fetched: 3,
      added: 1,
      updated: 1,
      unchanged: 1,
      removed: 0,
      total: 3,
    });
    expect((await client.getStation('1'))?.prices.gazole?.price).toBe(1.75);
    expect(await client.getStationsByCity('dinard')).toHaveLength(1);
  });

  it('never removes anything, since the filter cannot report a deletion', async () => {
    const { client, feed } = scenario([SAINT_MALO, RENNES]);
    await client.load();

    feed([]);
    const result = await client.sync();

    expect(result).toMatchObject({ fetched: 0, removed: 0, total: 2 });
    expect(await client.getStationsByCity('rennes')).toHaveLength(1);
  });

  it('returns the delta itself, not the whole cache', async () => {
    const { client, feed } = scenario([SAINT_MALO, SAINT_MALO_2, RENNES]);
    await client.load();

    feed([RENNES]);
    const result = await client.sync();

    expect(result.stations.map((station) => station.id)).toEqual(['3']);
    expect(result.total).toBe(3);
  });

  it('honours an explicit bound, ignoring the last sync', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const { client, stub } = scenario([SAINT_MALO]);
    await client.load();

    await client.sync({ since: new Date('2026-01-01T00:00:00.000Z') });
    expect(stub.lastParams().get('where')).toContain("date'2026-01-01T00:00:00.000Z'");

    await client.sync({ since: '2026-02-02T00:00:00.000Z' });
    expect(stub.lastParams().get('where')).toContain("date'2026-02-02T00:00:00.000Z'");
  });

  it('rejects a bound it cannot read', async () => {
    const { client } = scenario([SAINT_MALO]);
    await client.load();

    await expect(client.sync({ since: 'last tuesday' })).rejects.toMatchObject({
      name: 'FuelPricesError',
      code: 'invalid_argument',
    });
  });

  it('serialises concurrent syncs', async () => {
    const { client, stub } = scenario([SAINT_MALO]);
    await client.load();

    const results = await Promise.all([client.sync(), client.sync(), client.sync()]);

    expect(stub.calls).toBe(4);
    expect(results.map((result) => result.mode)).toEqual([
      'incremental',
      'incremental',
      'incremental',
    ]);
  });
});

describe('when a request fails', () => {
  it('reports the failure and stays unloaded', async () => {
    const client = new FuelPricesClient({
      fetch: () => Promise.reject(new TypeError('offline')),
      retries: 0,
    });

    await expect(client.load()).rejects.toMatchObject({ code: 'network' });
    expect(client.loaded).toBe(false);
    expect(client.size).toBe(0);
    expect(client.lastResult).toBeNull();
  });

  it('can be retried after the failure', async () => {
    const stub = recordingFetch((call) => {
      if (call === 1) throw new TypeError('offline');
      return jsonResponse([SAINT_MALO]);
    });
    const client = new FuelPricesClient({ fetch: stub.fetch, retries: 0 });

    await expect(client.load()).rejects.toMatchObject({ code: 'network' });
    await expect(client.load()).resolves.toMatchObject({ mode: 'full', added: 1 });
  });

  it('leaves the cache and the queue intact when a sync fails', async () => {
    const stub = recordingFetch((call) => {
      if (call === 2) throw new TypeError('offline');
      return jsonResponse([SAINT_MALO]);
    });
    const client = new FuelPricesClient({ fetch: stub.fetch, retries: 0 });
    const loaded = await client.load();

    await expect(client.sync()).rejects.toMatchObject({ code: 'network' });

    expect(client.size).toBe(1);
    expect(client.lastResult).toBe(loaded);
    await expect(client.sync()).resolves.toMatchObject({ mode: 'incremental' });
  });

  it('forwards an abort signal to the transport', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = scenario([SAINT_MALO]);

    await expect(client.load(controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('the lookups it serves', () => {
  const feed = [
    SAINT_MALO,
    SAINT_MALO_2,
    RENNES,
    rawRecord(4, {
      ville: 'Montgenèvre',
      cp: '05100',
      code_departement: '05',
      departement: 'Hautes-Alpes',
      pop: 'A',
      e85_prix: 0.71,
      e85_maj: '2026-08-11T09:00:00+00:00',
    }),
    rawRecord(5, {
      ville: 'Ajaccio',
      cp: '20000',
      code_departement: '2a',
      departement: 'Corse-du-Sud',
      e85_prix: 0.99,
      e85_maj: '2026-08-11T09:00:00+00:00',
    }),
  ];
  let client: FuelPricesClient;

  beforeEach(() => {
    client = new FuelPricesClient({ fetch: stubFetch(() => feed).fetch });
  });

  it('returns every station', async () => {
    expect(await client.getStations()).toHaveLength(5);
  });

  it('hands out a fresh array each time, so a caller cannot corrupt the cache', async () => {
    const stations = await client.getStations();
    stations.length = 0;

    expect(await client.getStations()).toHaveLength(5);
  });

  it('finds a station by id, trimming the input', async () => {
    expect((await client.getStation('3'))?.city).toBe('Rennes');
    expect((await client.getStation(' 3 '))?.city).toBe('Rennes');
    expect(await client.getStation('404')).toBeUndefined();
  });

  it('finds a city whatever the case, accents and separators', async () => {
    for (const spelling of ['Saint-Malo', 'saint malo', 'SAINT-MALO', 'saint--malô']) {
      expect(await client.getStationsByCity(spelling)).toHaveLength(2);
    }
    expect(await client.getStationsByCity('Montgenevre')).toHaveLength(1);
  });

  it('returns nothing for a place that is not in the dataset', async () => {
    expect(await client.getStationsByCity('Bruxelles')).toEqual([]);
    expect(await client.getStationsByPostalCode('99999')).toEqual([]);
    expect(await client.getStationsByDepartment('99')).toEqual([]);
  });

  it('finds a postal code', async () => {
    expect(await client.getStationsByPostalCode('35000')).toHaveLength(1);
    expect(await client.getStationsByPostalCode(' 35400 ')).toHaveLength(2);
  });

  it('finds a département, including a Corsican code', async () => {
    expect(await client.getStationsByDepartment('35')).toHaveLength(3);
    expect(await client.getStationsByDepartment('2A')).toHaveLength(1);
    expect(await client.getStationsByDepartment('2a')).toHaveLength(1);
  });

  it('sorts the sellers of a fuel by price', async () => {
    const stations = await client.getStationsByFuel('e85');

    expect(stations.map((station) => station.prices.e85?.price)).toEqual([0.71, 0.99]);
  });

  it('leaves out the stations that do not sell the fuel', async () => {
    expect(await client.getStationsByFuel('gplc')).toEqual([]);
    expect(await client.getStationsByFuel('gazole')).toHaveLength(5);
  });

  it('filters the cache on the price date', async () => {
    const recent = await client.getStationsUpdatedSince('2026-08-11T09:30:00.000Z');

    expect(recent).toHaveLength(5);
    expect(await client.getStationsUpdatedSince('2026-08-11T23:00:00.000Z')).toEqual([]);
  });

  it('rejects a date it cannot read', async () => {
    await expect(client.getStationsUpdatedSince('whenever')).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });

  it('keeps its indexes in step with a merge', async () => {
    const records = [SAINT_MALO];
    const moving = new FuelPricesClient({ fetch: stubFetch(() => records).fetch });
    await moving.load();
    expect(await moving.getStationsByCity('dinard')).toEqual([]);

    records.push(rawRecord(9, { ville: 'Dinard', cp: '35800', code_departement: '35' }));
    await moving.sync();

    expect(await moving.getStationsByCity('dinard')).toHaveLength(1);
    expect(await moving.getStationsByPostalCode('35800')).toHaveLength(1);
    expect(await moving.getStationsByDepartment('35')).toHaveLength(2);
  });

  describe('around a point', () => {
    // Saint-Malo intra-muros, with the other stations at known distances from it.
    const CENTER = { latitude: 48.64878, longitude: -2.02585 };
    const nearby = new FuelPricesClient({
      fetch: stubFetch(() => [
        rawRecord(1, { ville: 'Saint-Malo', geom: { lat: 48.64878, lon: -2.02585 } }), // 0 m
        rawRecord(2, { ville: 'Dinard', geom: { lat: 48.63194, lon: -2.05611 } }), // ~2.9 km
        rawRecord(3, { ville: 'Rennes', geom: { lat: 48.1173, lon: -1.6778 } }), // ~66 km
        rawRecord(4, { ville: 'Nulle part', geom: null }), // no coordinates
      ]).fetch,
    });

    it('returns the stations inside the radius, nearest first', async () => {
      const found = await nearby.getStationsNearby(CENTER, 5_000);

      expect(found.map((hit) => hit.station.city)).toEqual(['Saint-Malo', 'Dinard']);
      expect(found[0]?.distanceMeters).toBe(0);
      expect(found[1]?.distanceMeters).toBeCloseTo(2906.848, 2);
    });

    it('widens with the radius', async () => {
      expect(await nearby.getStationsNearby(CENTER, 0)).toHaveLength(1);
      expect(await nearby.getStationsNearby(CENTER, 3_000)).toHaveLength(2);
      expect(await nearby.getStationsNearby(CENTER, 100_000)).toHaveLength(3);
    });

    it('treats the radius as inclusive', async () => {
      const exact = await nearby.getStationsNearby(CENTER, 2_906.849);
      expect(exact).toHaveLength(2);

      const justShort = await nearby.getStationsNearby(CENTER, 2_906.8);
      expect(justShort).toHaveLength(1);
    });

    it('leaves out a station the dataset never located', async () => {
      const found = await nearby.getStationsNearby(CENTER, 20_000_000);

      expect(found).toHaveLength(3);
      expect(found.map((hit) => hit.station.city)).not.toContain('Nulle part');
    });

    it('returns nothing around a point in the middle of nowhere', async () => {
      expect(await nearby.getStationsNearby({ latitude: 0, longitude: 0 }, 10_000)).toEqual([]);
    });

    it('hands back the cached station objects, prices included', async () => {
      const found = await nearby.getStationsNearby(CENTER, 1);

      expect(found[0]?.station).toBe(await nearby.getStation('1'));
      expect(found[0]?.station.prices.gazole?.price).toBe(1.9);
    });

    it('loads the dataset on first use, like every other getter', async () => {
      const stub = stubFetch(() => [rawRecord(1)]);
      const cold = new FuelPricesClient({ fetch: stub.fetch });

      expect(await cold.getStationsNearby(CENTER, 5_000)).toHaveLength(1);
      expect(stub.calls).toBe(1);
    });

    it('rejects a point that is not on Earth, before hitting the network', async () => {
      const stub = stubFetch(() => [rawRecord(1)]);
      const guarded = new FuelPricesClient({ fetch: stub.fetch });

      await expect(
        guarded.getStationsNearby({ latitude: 91, longitude: 0 }, 5_000),
      ).rejects.toMatchObject({ name: 'FuelPricesError', code: 'invalid_argument' });
      expect(stub.calls).toBe(0);
    });

    it('rejects a radius it cannot bound a search with', async () => {
      await expect(nearby.getStationsNearby(CENTER, -1)).rejects.toMatchObject({
        code: 'invalid_argument',
      });
      await expect(nearby.getStationsNearby(CENTER, Number.NaN)).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    });
  });

  it('skips a station the feed gave no city', async () => {
    const nameless = new FuelPricesClient({
      fetch: stubFetch(() => [rawRecord(1, { ville: null, cp: null, code_departement: null })])
        .fetch,
    });

    expect(await nameless.getStationsByCity('')).toEqual([]);
    expect(await nameless.getStations()).toHaveLength(1);
  });
});
