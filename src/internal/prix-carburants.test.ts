import { describe, expect, it } from '@jest/globals';

import { jsonResponse, recordingFetch } from '../test-helpers.js';

import { PrixCarburantsClient } from './prix-carburants.js';

/** The body the reuse answers `/station/{id}` with, trimmed to what we read. */
function stationBody(brand: string | null): unknown {
  return {
    id: 1000001,
    ...(brand === null ? {} : { Brand: { id: 28, name: brand, shortName: 'carrefourmarket' } }),
    type: 'R',
    name: 'Carrefour Market',
    Coordinates: { latitude: 46.201, longitude: 5.198 },
  };
}

describe('the brand it reads', () => {
  it('takes it off the station the id points at', async () => {
    const stub = recordingFetch(() => jsonResponse(stationBody('Carrefour Market')));
    const client = new PrixCarburantsClient({ fetch: stub.fetch });

    await expect(client.fetchBrand('1000001')).resolves.toBe('Carrefour Market');
    expect(stub.lastUrl()).toBe('https://api.prix-carburants.2aaz.fr/station/1000001');
  });

  it('returns the value raw, for the SDK to canonicalise', async () => {
    // `communale` is a real answer, and not a brand — but that is not this
    // layer's call to make.
    const client = new PrixCarburantsClient({
      fetch: () => Promise.resolve(jsonResponse(stationBody('communale'))),
    });

    await expect(client.fetchBrand('84570002')).resolves.toBe('communale');
  });

  it('answers null for a station the reuse attaches no brand to', async () => {
    const client = new PrixCarburantsClient({
      fetch: () => Promise.resolve(jsonResponse(stationBody(null))),
    });

    await expect(client.fetchBrand('1000001')).resolves.toBeNull();
  });

  it('treats an unknown station as unbranded, not as a failure', async () => {
    // The dataset and the reuse do not refresh in lockstep, so a brand-new
    // station is a 404 here for a while.
    const client = new PrixCarburantsClient({
      fetch: () =>
        Promise.resolve(
          jsonResponse({ code: 404, message: 'Station non trouvé' }, { status: 404 }),
        ),
    });

    await expect(client.fetchBrand('99999999')).resolves.toBeNull();
  });

  it('still fails on anything that is not a 404', async () => {
    const client = new PrixCarburantsClient({
      fetch: () => Promise.resolve(jsonResponse({ code: 500, message: 'Error' }, { status: 500 })),
      retries: 0,
    });

    await expect(client.fetchBrand('1000001')).rejects.toMatchObject({ code: 'http', status: 500 });
  });

  it('rejects a body that is not an object', async () => {
    const client = new PrixCarburantsClient({
      fetch: () => Promise.resolve(jsonResponse('nope')),
    });

    await expect(client.fetchBrand('1000001')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('escapes the id rather than pasting it into the path', async () => {
    const stub = recordingFetch(() => jsonResponse(stationBody(null)));

    await new PrixCarburantsClient({ fetch: stub.fetch }).fetchBrand('../brands');

    expect(stub.lastUrl()).toBe('https://api.prix-carburants.2aaz.fr/station/..%2Fbrands');
  });
});

describe('how it identifies itself', () => {
  it('sends a key when it has one, since that is what lifts the rate limit', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const client = new PrixCarburantsClient({
      apiKey: 'secret',
      fetch: (_url, init) => {
        seen.push(init);
        return Promise.resolve(jsonResponse(stationBody('Esso')));
      },
    });

    await client.fetchBrand('1000001');

    expect(seen[0]?.headers).toMatchObject({ authorization: 'Key secret' });
  });

  it('reads fine without one', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const client = new PrixCarburantsClient({
      fetch: (_url, init) => {
        seen.push(init);
        return Promise.resolve(jsonResponse(stationBody('Esso')));
      },
    });

    await client.fetchBrand('1000001');

    expect(seen[0]?.headers).not.toMatchObject({ authorization: expect.anything() });
  });

  it('honours a custom root, trailing slash or not', async () => {
    const stub = recordingFetch(() => jsonResponse(stationBody(null)));

    await new PrixCarburantsClient({
      fetch: stub.fetch,
      baseUrl: 'https://example.test/api/',
    }).fetchBrand('7');

    expect(stub.lastUrl()).toBe('https://example.test/api/station/7');
  });

  it('names the reuse in its errors', async () => {
    const client = new PrixCarburantsClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      retries: 0,
    });

    const error: unknown = await client.fetchBrand('1').catch((reason: unknown) => reason);

    expect((error as Error).message).toContain('the prix-carburants API');
  });
});
