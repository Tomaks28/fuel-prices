import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { FuelPricesError } from '../errors.js';
import { jsonResponse, rawRecord, recordingFetch } from '../test-helpers.js';

import { DatasetClient, type FetchLike } from './http.js';

afterEach(() => {
  jest.useRealTimers();
});

/** Rejects with the abort reason, the way a real `fetch` does. */
const neverResolves: FetchLike = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const reason: unknown = init.signal?.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    });
  });

function errorBody(status: number, body: unknown, headers?: Record<string, string>): Response {
  return jsonResponse(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('the request it builds', () => {
  it('targets the export endpoint of the configured dataset', async () => {
    const stub = recordingFetch(() => jsonResponse([]));
    await new DatasetClient({ fetch: stub.fetch }).exportStations();

    expect(stub.lastUrl()).toContain(
      'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/' +
        'prix-des-carburants-en-france-flux-instantane-v2/exports/json',
    );
  });

  it('passes `select` and `where` through, and pins the timezone to UTC', async () => {
    const stub = recordingFetch(() => jsonResponse([]));
    await new DatasetClient({ fetch: stub.fetch }).exportStations({
      select: 'id,ville',
      where: "gazole_maj > date'2026-08-11T10:00:00.000Z'",
    });

    expect(stub.lastParams().get('select')).toBe('id,ville');
    expect(stub.lastParams().get('where')).toBe("gazole_maj > date'2026-08-11T10:00:00.000Z'");
    expect(stub.lastParams().get('timezone')).toBe('UTC');
  });

  it('omits the optional parameters rather than sending them empty', async () => {
    const stub = recordingFetch(() => jsonResponse([]));
    await new DatasetClient({ fetch: stub.fetch }).exportStations();

    expect(stub.lastParams().has('select')).toBe(false);
    expect(stub.lastParams().has('where')).toBe(false);
  });

  it('honours a custom portal and dataset, trailing slash or not', async () => {
    const stub = recordingFetch(() => jsonResponse([]));
    await new DatasetClient({
      fetch: stub.fetch,
      baseUrl: 'https://example.test/api/explore/v2.1/',
      dataset: 'other-dataset',
    }).exportStations();

    expect(stub.lastUrl()).toBe(
      'https://example.test/api/explore/v2.1/catalog/datasets/other-dataset/exports/json?timezone=UTC',
    );
  });

  it('asks for JSON', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const client = new DatasetClient({
      fetch: (_url, init) => {
        seen.push(init);
        return Promise.resolve(jsonResponse([]));
      },
    });
    await client.exportStations();

    expect(seen[0]).toMatchObject({ method: 'GET', headers: { accept: 'application/json' } });
  });
});

describe('the response it accepts', () => {
  it('returns the records of a successful export', async () => {
    const records = [rawRecord(1), rawRecord(2)];
    const client = new DatasetClient({ fetch: () => Promise.resolve(jsonResponse(records)) });

    await expect(client.exportStations()).resolves.toEqual(records);
  });

  it('rejects a payload that is not an array', async () => {
    const client = new DatasetClient({
      fetch: () => Promise.resolve(jsonResponse({ results: [] })),
    });

    await expect(client.exportStations()).rejects.toMatchObject({
      name: 'FuelPricesError',
      code: 'invalid_response',
    });
  });

  it('rejects a 200 that is not JSON at all', async () => {
    const client = new DatasetClient({
      fetch: () => Promise.resolve(new Response('<html>maintenance</html>', { status: 200 })),
    });

    await expect(client.exportStations()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('the errors it raises', () => {
  it('surfaces the status and the API message of a 4xx', async () => {
    const client = new DatasetClient({
      fetch: () =>
        Promise.resolve(
          errorBody(400, { error_code: 'ODSQLError', message: 'ODSQL query is malformed' }),
        ),
    });

    const error: unknown = await client.exportStations().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(FuelPricesError);
    expect(error).toMatchObject({ code: 'http', status: 400, apiCode: 'ODSQLError' });
    expect((error as FuelPricesError).message).toContain('ODSQL query is malformed');
  });

  it('still reports a 4xx whose body is not the documented shape', async () => {
    const client = new DatasetClient({
      fetch: () => Promise.resolve(new Response('nope', { status: 404, statusText: 'Not Found' })),
    });

    await expect(client.exportStations()).rejects.toMatchObject({
      code: 'http',
      status: 404,
      apiCode: undefined,
    });
  });

  it('reports a transport failure as a network error, keeping the cause', async () => {
    const cause = new TypeError('fetch failed');
    const client = new DatasetClient({ fetch: () => Promise.reject(cause), retries: 0 });

    const error: unknown = await client.exportStations().catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'network', cause });
    expect((error as FuelPricesError).message).toContain('fetch failed');
  });

  it('reports its own deadline as a timeout', async () => {
    jest.useFakeTimers();
    const client = new DatasetClient({ fetch: neverResolves, timeoutMs: 5_000, retries: 0 });

    const pending = client.exportStations().catch((reason: unknown) => reason);
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toMatchObject({ code: 'timeout' });
  });

  it("reports the caller's abort as an abort, and does not retry it", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = new DatasetClient({
      fetch: (url, init) => {
        calls += 1;
        return neverResolves(url, init);
      },
      retries: 3,
    });

    const pending = client.exportStations({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toBe(1);
  });

  it('rejects immediately on a signal that is already aborted', async () => {
    const client = new DatasetClient({ fetch: neverResolves });

    await expect(client.exportStations({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('explains itself when the runtime has no fetch', () => {
    const original = globalThis.fetch;
    Reflect.deleteProperty(globalThis, 'fetch');

    try {
      expect(() => new DatasetClient()).toThrow(expect.objectContaining({ code: 'unsupported' }));
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('the failures it retries', () => {
  it('retries a 429 and returns the retry', async () => {
    jest.useFakeTimers();
    const stub = recordingFetch((call) =>
      call === 1
        ? errorBody(429, { error_code: 'TooManyRequests', message: 'slow down' })
        : jsonResponse([rawRecord(1)]),
    );
    const client = new DatasetClient({ fetch: stub.fetch });

    const pending = client.exportStations();
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toHaveLength(1);
    expect(stub.calls).toBe(2);
  });

  it('waits out the Retry-After the API asked for', async () => {
    jest.useFakeTimers();
    const stub = recordingFetch((call) =>
      call === 1 ? errorBody(429, {}, { 'retry-after': '3' }) : jsonResponse([]),
    );
    const client = new DatasetClient({ fetch: stub.fetch });

    const pending = client.exportStations();
    await jest.advanceTimersByTimeAsync(2_900);
    expect(stub.calls).toBe(1);

    await jest.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual([]);
    expect(stub.calls).toBe(2);
  });

  it('reads a Retry-After given as an HTTP date', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const stub = recordingFetch((call) =>
      call === 1
        ? errorBody(503, {}, { 'retry-after': 'Tue, 11 Aug 2026 12:00:03 GMT' })
        : jsonResponse([]),
    );
    const client = new DatasetClient({ fetch: stub.fetch });

    const pending = client.exportStations();
    await jest.advanceTimersByTimeAsync(2_900);
    expect(stub.calls).toBe(1);

    await jest.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual([]);
  });

  it('falls back to its own backoff when Retry-After makes no sense', async () => {
    jest.useFakeTimers();
    const stub = recordingFetch((call) =>
      call === 1 ? errorBody(503, {}, { 'retry-after': 'soon' }) : jsonResponse([]),
    );

    const pending = new DatasetClient({ fetch: stub.fetch }).exportStations();
    await jest.advanceTimersByTimeAsync(499);
    expect(stub.calls).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([]);
  });

  it('caps the wait, however long the API asks for', async () => {
    jest.useFakeTimers();
    const stub = recordingFetch((call) =>
      call === 1 ? errorBody(429, {}, { 'retry-after': '3600' }) : jsonResponse([]),
    );

    const pending = new DatasetClient({ fetch: stub.fetch }).exportStations();
    await jest.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toEqual([]);
    expect(stub.calls).toBe(2);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('retries a %i', async (status) => {
    jest.useFakeTimers();
    const stub = recordingFetch((call) =>
      call === 1 ? errorBody(status, {}) : jsonResponse([rawRecord(1)]),
    );

    const pending = new DatasetClient({ fetch: stub.fetch }).exportStations();
    await jest.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toHaveLength(1);
    expect(stub.calls).toBe(2);
  });

  it.each([400, 401, 403, 404, 422])('does not retry a %i', async (status) => {
    const stub = recordingFetch(() => errorBody(status, {}));

    await expect(new DatasetClient({ fetch: stub.fetch }).exportStations()).rejects.toMatchObject({
      status,
    });
    expect(stub.calls).toBe(1);
  });

  it('retries a transport failure too', async () => {
    jest.useFakeTimers();
    const stub = recordingFetch((call) => {
      if (call === 1) throw new TypeError('socket hang up');
      return jsonResponse([]);
    });

    const pending = new DatasetClient({ fetch: stub.fetch }).exportStations();
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([]);
    expect(stub.calls).toBe(2);
  });

  it('gives up after `retries` extra attempts and raises the last failure', async () => {
    jest.useFakeTimers();
    const stub = recordingFetch(() => errorBody(503, { message: 'unavailable' }));

    const pending = new DatasetClient({ fetch: stub.fetch, retries: 2 })
      .exportStations()
      .catch((reason: unknown) => reason);
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toMatchObject({ code: 'http', status: 503 });
    expect(stub.calls).toBe(3);
  });

  it('backs off exponentially between attempts', async () => {
    jest.useFakeTimers();
    const stub = recordingFetch(() => errorBody(503, {}));

    const pending = new DatasetClient({ fetch: stub.fetch, retries: 2 })
      .exportStations()
      .catch(() => undefined);

    expect(stub.calls).toBe(1);
    await jest.advanceTimersByTimeAsync(499);
    expect(stub.calls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(stub.calls).toBe(2);
    await jest.advanceTimersByTimeAsync(999);
    expect(stub.calls).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(stub.calls).toBe(3);

    await pending;
  });

  it('makes a single attempt when retries are switched off', async () => {
    const stub = recordingFetch(() => errorBody(503, {}));

    await expect(
      new DatasetClient({ fetch: stub.fetch, retries: 0 }).exportStations(),
    ).rejects.toMatchObject({ status: 503 });
    expect(stub.calls).toBe(1);
  });

  it('stops waiting for the next attempt as soon as the caller aborts', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const stub = recordingFetch(() => errorBody(503, {}));

    const pending = new DatasetClient({ fetch: stub.fetch, retries: 5 })
      .exportStations({ signal: controller.signal })
      .catch((reason: unknown) => reason);

    await jest.advanceTimersByTimeAsync(1);
    expect(stub.calls).toBe(1);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ code: 'aborted' });
    expect(stub.calls).toBe(1);
  });
});
