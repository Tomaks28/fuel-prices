import { describe, expect, it } from '@jest/globals';

import { overpassBrands, prixCarburantsBrands, resolveBrands, type BrandSource } from './brands.js';
import { FuelPricesError } from './errors.js';
import { toStation } from './internal/normalize.js';
import { jsonResponse, rawRecord, recordingFetch } from './test-helpers.js';

import type { Station } from './types.js';

/** A station of the dataset, at the coordinates the fixture carries. */
function station(id: number | string, latitude = 48.65797, longitude = -1.97092): Station {
  const built = toStation(rawRecord(id, { geom: { lon: longitude, lat: latitude } }));
  if (built === null) throw new Error('the fixture should build');
  return built;
}

/** An Overpass answer with one branded node per entry. */
function overpassAnswer(
  ...nodes: { lat: number; lon: number; brand?: string; operator?: string }[]
): Response {
  return jsonResponse({
    elements: nodes.map(({ lat, lon, ...tags }) => ({ type: 'node', lat, lon, tags })),
  });
}

describe('the Overpass source', () => {
  it('brands a station from the node sitting on it', async () => {
    const source = overpassBrands({
      fetch: () => Promise.resolve(overpassAnswer({ lat: 48.658, lon: -1.9709, brand: 'Total' })),
    });

    const brands = await source.resolve([station(1)]);

    expect(brands.get('1')).toBe('TotalEnergies');
  });

  it('leaves a station alone when the closest node is too far', async () => {
    const source = overpassBrands({
      maxDistanceMeters: 50,
      fetch: () => Promise.resolve(overpassAnswer({ lat: 48.66, lon: -1.9709, brand: 'Total' })),
    });

    expect(await source.resolve([station(1)])).toEqual(new Map());
  });

  it('asks once and serves later calls from what it downloaded', async () => {
    const stub = recordingFetch(() => overpassAnswer({ lat: 48.658, lon: -1.9709, brand: 'Avia' }));
    const source = overpassBrands({ fetch: stub.fetch });

    await source.resolve([station(1)]);
    await source.resolve([station(2)]);
    await source.resolve([station(3)]);

    // An incremental sync must not re-download the country every five minutes.
    expect(stub.calls).toBe(1);
  });

  it('goes back for a region it has never covered', async () => {
    const stub = recordingFetch(() => overpassAnswer({ lat: -20.88, lon: 55.45, brand: 'Total' }));
    const source = overpassBrands({ fetch: stub.fetch });

    await source.resolve([station(1)]);
    // La Réunion: another tile entirely, and nothing downloaded covers it.
    const brands = await source.resolve([station(2, -20.88, 55.45)]);

    expect(stub.calls).toBe(2);
    expect(brands.get('2')).toBe('TotalEnergies');
  });

  it('queries the areas it was pinned to instead of deriving them', async () => {
    const stub = recordingFetch(() =>
      overpassAnswer({ lat: 48.658, lon: -1.9709, brand: 'Total' }),
    );
    const source = overpassBrands({
      fetch: stub.fetch,
      areas: [{ south: 48, west: -3, north: 49, east: -1 }],
    });

    await source.resolve([station(1)]);
    await source.resolve([station(2, -20.88, 55.45)]);

    expect(stub.calls).toBe(1);
    expect(String(stub.urls[0])).toContain('interpreter');
  });

  it('costs nothing when no station has coordinates', async () => {
    const stub = recordingFetch(() => overpassAnswer());
    const source = overpassBrands({ fetch: stub.fetch });
    const unlocated = toStation(rawRecord(1, { geom: null }));
    if (unlocated === null) throw new Error('the fixture should build');

    expect(await source.resolve([unlocated])).toEqual(new Map());
    expect(stub.calls).toBe(0);
  });
});

describe('the prix-carburants source', () => {
  it('brands each station by its own id', async () => {
    const source = prixCarburantsBrands({
      fetch: (url) =>
        Promise.resolve(
          jsonResponse({ Brand: { name: url.endsWith('/1') ? 'Total' : 'Esso Express' } }),
        ),
    });

    const brands = await source.resolve([station(1), station(2)]);

    expect(brands.get('1')).toBe('Total');
    expect(brands.get('2')).toBe('Esso Express');
  });

  it('stops at its request ceiling rather than spend one call per station', async () => {
    const stub = recordingFetch(() => jsonResponse({ Brand: { name: 'Total' } }));
    const source = prixCarburantsBrands({ fetch: stub.fetch, maxRequests: 2 });

    const brands = await source.resolve([station(1), station(2), station(3), station(4)]);

    expect(stub.calls).toBe(2);
    expect(brands.size).toBe(2);
  });

  it('covers the same stations on the next run, so a cache fills up', async () => {
    const first = recordingFetch(() => jsonResponse({ Brand: { name: 'Total' } }));
    const second = recordingFetch(() => jsonResponse({ Brand: { name: 'Total' } }));
    const stations = [station(3), station(1), station(2)];

    await prixCarburantsBrands({ fetch: first.fetch, maxRequests: 2 }).resolve(stations);
    await prixCarburantsBrands({ fetch: second.fetch, maxRequests: 2 }).resolve(
      [...stations].reverse(),
    );

    expect(second.urls).toEqual(first.urls);
  });

  it('swallows the odd failure rather than lose the whole batch', async () => {
    const source = prixCarburantsBrands({
      retries: 0,
      fetch: (url) =>
        url.endsWith('/2')
          ? Promise.resolve(jsonResponse({ code: 500 }, { status: 500 }))
          : Promise.resolve(jsonResponse({ Brand: { name: 'Total' } })),
    });

    const brands = await source.resolve([station(1), station(2), station(3)]);

    expect(brands.get('1')).toBe('Total');
    expect(brands.has('2')).toBe(false);
    expect(brands.get('3')).toBe('Total');
  });

  it('reports a service that is down, instead of calling every station unbranded', async () => {
    const source = prixCarburantsBrands({
      retries: 0,
      fetch: () => Promise.resolve(jsonResponse({ code: 500 }, { status: 500 })),
    });

    const stations = Array.from({ length: 60 }, (_unused, index) => station(index + 1));

    await expect(source.resolve(stations)).rejects.toMatchObject({ code: 'http', status: 500 });
  });

  it('honours a ceiling of zero, which is how it is switched off', async () => {
    const stub = recordingFetch(() => jsonResponse({ Brand: { name: 'Total' } }));
    const source = prixCarburantsBrands({ fetch: stub.fetch, maxRequests: 0 });

    expect(await source.resolve([station(1)])).toEqual(new Map());
    expect(stub.calls).toBe(0);
  });
});

/** A source with a scripted answer, to test how they compose. */
function fakeSource(
  name: string,
  answer: (stations: readonly Station[]) => ReadonlyMap<string, string> | Promise<never>,
): BrandSource & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    name,
    seen,
    resolve: async (stations) => {
      seen.push(stations.map((station_) => station_.id));
      return answer(stations);
    },
  };
}

describe('the way sources compose', () => {
  it('only shows a source what the previous ones could not name', async () => {
    const first = fakeSource('first', () => new Map([['1', 'Total']]));
    const second = fakeSource('second', () => new Map([['2', 'Esso']]));

    const brands = await resolveBrands([first, second], [station(1), station(2)]);

    expect(second.seen).toEqual([['2']]);
    expect(brands).toEqual(
      new Map([
        ['1', 'TotalEnergies'],
        ['2', 'Esso'],
      ]),
    );
  });

  it('stops early once every station has a brand', async () => {
    const first = fakeSource(
      'first',
      () =>
        new Map([
          ['1', 'Total'],
          ['2', 'Avia'],
        ]),
    );
    const second = fakeSource('second', () => new Map());

    await resolveBrands([first, second], [station(1), station(2)]);

    expect(second.seen).toEqual([]);
  });

  it('sanitizes whatever a source hands over, custom ones included', async () => {
    const source = fakeSource(
      'raw',
      () =>
        new Map([
          ['1', '  TOTAL access '],
          ['2', 'communale'],
        ]),
    );

    const brands = await resolveBrands([source], [station(1), station(2)]);

    expect(brands.get('1')).toBe('TotalEnergies');
    // Sanitizing is not the source's job, so a placeholder still gets dropped.
    expect(brands.has('2')).toBe(false);
  });

  it('keeps going when a source fails, and says which one it was', async () => {
    const errors: FuelPricesError[] = [];
    const broken = fakeSource('Overpass', () =>
      Promise.reject(new FuelPricesError('504', { code: 'http', status: 504 })),
    );
    const working = fakeSource('other', () => new Map([['1', 'Avia']]));

    const brands = await resolveBrands([broken, working], [station(1)], {
      onError: (error) => errors.push(error),
    });

    expect(brands.get('1')).toBe('Avia');
    expect(errors[0]?.message).toContain('Overpass');
    expect(errors[0]?.status).toBe(504);
  });

  it('lets an abort through: that one is the caller asking to stop', async () => {
    const aborted = fakeSource('aborted', () =>
      Promise.reject(new FuelPricesError('stop', { code: 'aborted' })),
    );
    const next = fakeSource('next', () => new Map([['1', 'Avia']]));

    await expect(resolveBrands([aborted, next], [station(1)])).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(next.seen).toEqual([]);
  });

  it('answers an empty map when there is no source at all', async () => {
    expect(await resolveBrands([], [station(1)])).toEqual(new Map());
  });
});
