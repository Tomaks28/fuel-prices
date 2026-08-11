import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { CACHE_VERSION, createFileCache, toCacheEntry, type CacheEntry } from './cache.js';
import { expectDefined, rawRecord } from './test-helpers.js';
import { toStation } from './internal/normalize.js';

const DATASET = 'prix-des-carburants-en-france-flux-instantane-v2';

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    version: CACHE_VERSION,
    dataset: DATASET,
    syncedAt: '2026-08-11T12:00:00.000Z',
    stations: [expectDefined(toStation(rawRecord(1)), 'station')],
    ...overrides,
  };
}

describe('toCacheEntry', () => {
  it('accepts an entry this version wrote', () => {
    expect(toCacheEntry(JSON.parse(JSON.stringify(entry())))).toEqual(entry());
  });

  it.each([
    ['a scalar', '"nope"'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a foreign version', JSON.stringify(entry({ version: 99 }))],
    ['a missing dataset', '{"version":1,"syncedAt":"2026-08-11T12:00:00.000Z","stations":[]}'],
    ['an unparsable date', JSON.stringify(entry({ syncedAt: 'whenever' }))],
    [
      'stations that are not a list',
      '{"version":1,"dataset":"x","syncedAt":"2026-08-11","stations":{}}',
    ],
    [
      'a station without an id',
      '{"version":1,"dataset":"x","syncedAt":"2026-08-11T12:00:00.000Z","stations":[{}]}',
    ],
  ])('rejects %s', (_label, raw) => {
    expect(toCacheEntry(JSON.parse(raw))).toBeNull();
  });
});

describe('createFileCache', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fuel-prices-cache-'));
    path = join(directory, 'snapshot.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a path it cannot use', () => {
    expect(() => createFileCache('')).toThrow(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
    expect(() => createFileCache('   ')).toThrow(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
  });

  it('round-trips a snapshot', async () => {
    const cache = createFileCache(path);
    await cache.write(entry());

    expect(await cache.read()).toEqual(entry());
  });

  it('reads back a station with everything the SDK exposes', async () => {
    const station = expectDefined(
      toStation(
        rawRecord(1, {
          horaires: JSON.stringify({
            '@automate-24-24': '',
            jour: [
              {
                '@id': '1',
                '@ferme': '',
                horaire: { '@ouverture': '08.00', '@fermeture': '19.00' },
              },
            ],
          }),
        }),
      ),
      'station',
    );
    const cache = createFileCache(path);
    await cache.write(entry({ stations: [station] }));

    const restored = await cache.read();
    expect(restored?.stations[0]).toEqual(station);
  });

  it('answers a miss rather than throwing when the file is absent', async () => {
    expect(await createFileCache(path).read()).toBeNull();
  });

  it('answers a miss on a truncated or foreign file', async () => {
    const cache = createFileCache(path);

    await writeFile(path, '{"version":1,"stations":[', 'utf8');
    expect(await cache.read()).toBeNull();

    await writeFile(path, JSON.stringify({ hello: 'world' }), 'utf8');
    expect(await cache.read()).toBeNull();
  });

  it('creates the parent directory it was pointed at', async () => {
    const nested = join(directory, 'deep', 'deeper', 'snapshot.json');
    const cache = createFileCache(nested);

    await cache.write(entry());
    expect(await cache.read()).toEqual(entry());
  });

  it('fails loudly when told not to create the directory', async () => {
    const nested = join(directory, 'missing', 'snapshot.json');

    await expect(createFileCache(nested, { mkdir: false }).write(entry())).rejects.toMatchObject({
      name: 'FuelPricesError',
      code: 'cache',
    });
  });

  it('leaves no temporary file behind', async () => {
    const cache = createFileCache(path);
    await cache.write(entry());

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual(['snapshot.json']);
  });

  it('overwrites a previous snapshot in place', async () => {
    const cache = createFileCache(path);
    await cache.write(entry());
    await cache.write(entry({ syncedAt: '2026-08-11T18:00:00.000Z', stations: [] }));

    const restored = await cache.read();
    expect(restored?.syncedAt).toBe('2026-08-11T18:00:00.000Z');
    expect(restored?.stations).toEqual([]);
    // A rename, not an append: the file holds one document.
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: CACHE_VERSION,
      dataset: DATASET,
      syncedAt: '2026-08-11T18:00:00.000Z',
      stations: [],
    });
  });

  it('clears the file, and is fine when there is nothing to clear', async () => {
    const cache = createFileCache(path);
    await cache.write(entry());

    await cache.clear?.();
    expect(await cache.read()).toBeNull();
    await expect(cache.clear?.()).resolves.toBeUndefined();
  });
});
