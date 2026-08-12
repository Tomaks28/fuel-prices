import { describe, expect, it } from '@jest/globals';

import { jsonResponse, recordingFetch } from '../test-helpers.js';

import { buildQuery, toBrandPoints, OverpassClient } from './overpass.js';

const BOX = { south: 48.0, west: -2.0, north: 49.0, east: -1.0 };

/** An Overpass answer, shaped the way the interpreter returns one. */
function elements(...items: unknown[]): unknown {
  return { version: 0.6, generator: 'Overpass API', elements: items };
}

describe('the query it builds', () => {
  it('asks for fuel stations of every element type, tags only', () => {
    const query = buildQuery([BOX]);

    // `nwr` rather than `node`: plenty of French stations are mapped as an area.
    expect(query).toContain('nwr["amenity"="fuel"](48.000000,-2.000000,49.000000,-1.000000);');
    expect(query).toContain('[out:json]');
    expect(query).toContain('out tags center qt;');
  });

  it('unions several boxes into one query rather than one each', () => {
    const query = buildQuery([BOX, { south: -21, west: 55, north: -20, east: 56 }]);

    expect(query.match(/nwr/gu)).toHaveLength(2);
    expect(query.match(/out:json/gu)).toHaveLength(1);
  });

  it('carries a server-side timeout, since the query takes minutes', () => {
    expect(buildQuery([BOX])).toContain('[timeout:180]');
  });
});

describe('the answer it reads', () => {
  it('takes the brand of a node', () => {
    const points = toBrandPoints(
      elements({ type: 'node', lat: 48.5, lon: -1.5, tags: { brand: 'Total' } }),
    );

    expect(points).toEqual([
      { location: { latitude: 48.5, longitude: -1.5 }, brand: 'TotalEnergies' },
    ]);
  });

  it('takes the centre of a way, which is how a forecourt is mapped', () => {
    const points = toBrandPoints(
      elements({ type: 'way', center: { lat: 48.5, lon: -1.5 }, tags: { brand: 'Avia' } }),
    );

    expect(points).toEqual([{ location: { latitude: 48.5, longitude: -1.5 }, brand: 'Avia' }]);
  });

  it('falls back to the operator when no brand is tagged', () => {
    const points = toBrandPoints(
      elements({ type: 'node', lat: 48.5, lon: -1.5, tags: { operator: 'Esso' } }),
    );

    expect(points[0]?.brand).toBe('Esso');
  });

  it('prefers the brand over the operator', () => {
    const points = toBrandPoints(
      elements({
        type: 'node',
        lat: 48.5,
        lon: -1.5,
        tags: { brand: 'Carrefour Market', operator: 'Groupement des Mousquetaires' },
      }),
    );

    expect(points[0]?.brand).toBe('Carrefour');
  });

  it('never reads `name`, which holds the station rather than the network', () => {
    // Live values: `Garage Bahezre`, `Café des sports`, `Relais d'Étiolles`.
    const points = toBrandPoints(
      elements({ type: 'node', lat: 48.5, lon: -1.5, tags: { name: 'Garage Bahezre' } }),
    );

    expect(points).toEqual([]);
  });

  it('drops what carries no usable brand at all', () => {
    const points = toBrandPoints(
      elements(
        { type: 'node', lat: 48.5, lon: -1.5, tags: { brand: 'yes' } },
        { type: 'node', lat: 48.5, lon: -1.5 },
        { type: 'node', lat: 48.5, lon: -1.5, tags: { brand: 'Total' } },
      ),
    );

    expect(points).toHaveLength(1);
  });

  it('drops an element with no position to match on', () => {
    expect(toBrandPoints(elements({ type: 'relation', tags: { brand: 'Total' } }))).toEqual([]);
    expect(
      toBrandPoints(elements({ type: 'node', lat: 'nope', lon: -1.5, tags: { brand: 'Total' } })),
    ).toEqual([]);
  });

  it('accepts an empty answer', () => {
    expect(toBrandPoints(elements())).toEqual([]);
  });

  it('reports the overload Overpass hides inside a 200', () => {
    expect(() => toBrandPoints({ remark: 'runtime error: Query timed out' })).toThrow(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });

  it.each([[null], ['<html>rate limited</html>'], [{ nope: true }], [[]]])(
    'rejects the unusable payload %p',
    (payload) => {
      expect(() => toBrandPoints(payload)).toThrow(
        expect.objectContaining({ code: 'invalid_response' }),
      );
    },
  );
});

describe('the request it sends', () => {
  it('posts the query as a form body, to the configured interpreter', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const client = new OverpassClient({
      endpoint: 'https://overpass.kumi.systems/api/interpreter',
      fetch: (url, init) => {
        seen.push(init);
        expect(url).toBe('https://overpass.kumi.systems/api/interpreter');
        return Promise.resolve(jsonResponse(elements()));
      },
    });

    await client.fetchBrandPoints([BOX]);

    const body = seen[0]?.body;

    expect(seen[0]?.method).toBe('POST');
    expect(typeof body).toBe('string');
    expect(body as string).toContain('data=');
    expect(body as string).toContain('amenity');
  });

  it('identifies itself, as the service asks callers to', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const client = new OverpassClient({
      fetch: (_url, init) => {
        seen.push(init);
        return Promise.resolve(jsonResponse(elements()));
      },
    });

    await client.fetchBrandPoints([BOX]);

    expect(seen[0]?.headers).toMatchObject({
      'user-agent': expect.stringContaining('fuel-prices') as unknown as string,
    });
  });

  it('splits the boxes over several requests, rather than one query France cannot finish', async () => {
    const stub = recordingFetch(() => jsonResponse(elements()));
    const client = new OverpassClient({ fetch: stub.fetch, maxBoxesPerRequest: 2 });
    const boxes = Array.from({ length: 5 }, (_unused, index) => ({
      south: 48 + index,
      west: -2,
      north: 49 + index,
      east: -1,
    }));

    await client.fetchBrandPoints(boxes);

    // 5 boxes, 2 at a time: the interpreter gets three queries it can finish.
    expect(stub.calls).toBe(3);
  });

  it('merges what every request brought back', async () => {
    const stub = recordingFetch((call) =>
      jsonResponse({
        elements: [
          {
            type: 'node',
            lat: 48 + call,
            lon: -1.5,
            tags: { brand: call === 1 ? 'Total' : 'Avia' },
          },
        ],
      }),
    );
    const client = new OverpassClient({ fetch: stub.fetch, maxBoxesPerRequest: 1 });

    const points = await client.fetchBrandPoints([BOX, { ...BOX, south: 49, north: 50 }]);

    expect(points.map((point) => point.brand)).toEqual(['TotalEnergies', 'Avia']);
  });

  it('costs nothing when there is nowhere to look', async () => {
    const stub = recordingFetch(() => jsonResponse(elements()));

    await expect(new OverpassClient({ fetch: stub.fetch }).fetchBrandPoints([])).resolves.toEqual(
      [],
    );
    expect(stub.calls).toBe(0);
  });

  it('surfaces the 504 the busiest instance answers a France-wide query with', async () => {
    const stub = recordingFetch(() => new Response('', { status: 504 }));
    const client = new OverpassClient({ fetch: stub.fetch, retries: 0 });

    await expect(client.fetchBrandPoints([BOX])).rejects.toMatchObject({
      code: 'http',
      status: 504,
    });
    expect(stub.calls).toBe(1);
  });

  it('names Overpass in its errors, not the fuel-price API', async () => {
    const client = new OverpassClient({
      fetch: () => Promise.reject(new TypeError('socket hang up')),
      retries: 0,
    });

    const error: unknown = await client.fetchBrandPoints([BOX]).catch((reason: unknown) => reason);

    expect((error as Error).message).toContain('the Overpass API');
  });
});
