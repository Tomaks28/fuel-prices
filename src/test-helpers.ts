/**
 * Fixtures shared by the test suites. Not part of the published surface: the
 * bundler only follows `src/index.ts`, and the tarball only ships `dist/`.
 */

import type { RawStationRecord } from './internal/dataset.js';
import type { FetchLike } from './internal/http.js';

/**
 * A record shaped like the dataset returns it: gazole on sale, SP95 stopped for
 * good, the four other fuels simply absent.
 */
export function rawRecord(
  id: number | string,
  overrides: Partial<RawStationRecord> = {},
): RawStationRecord {
  return {
    id,
    adresse: '55 Boulevard des Déportés',
    ville: 'Saint-Malo',
    cp: '35400',
    pop: 'R',
    geom: { lon: -1.97092, lat: 48.65797 },
    departement: 'Ille-et-Vilaine',
    code_departement: '35',
    region: 'Bretagne',
    code_region: '53',
    horaires_automate_24_24: 'Oui',
    services_service: ['Bar', 'Laverie'],

    gazole_prix: 1.9,
    gazole_maj: '2026-08-11T10:00:00+00:00',
    gazole_rupture_debut: null,
    gazole_rupture_type: null,

    sp95_prix: null,
    sp95_maj: null,
    sp95_rupture_debut: '2020-01-01T00:00:00+00:00',
    sp95_rupture_type: 'definitive',

    sp98_prix: null,
    sp98_maj: null,
    sp98_rupture_debut: null,
    sp98_rupture_type: null,

    e10_prix: null,
    e10_maj: null,
    e10_rupture_debut: null,
    e10_rupture_type: null,

    e85_prix: null,
    e85_maj: null,
    e85_rupture_debut: null,
    e85_rupture_type: null,

    gplc_prix: null,
    gplc_maj: null,
    gplc_rupture_debut: null,
    gplc_rupture_type: null,

    ...overrides,
  };
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

export interface RecordingFetch {
  fetch: FetchLike;
  /** URLs requested so far, in order. */
  urls: string[];
  get calls(): number;
  /** The last requested URL, or `''` when nothing was requested. */
  lastUrl(): string;
  /** Search params of the last requested URL. */
  lastParams(): URLSearchParams;
}

/** A `fetch` stub that records its calls and replies with `handler`. */
export function recordingFetch(
  handler: (call: number, url: string) => Response | Promise<Response>,
): RecordingFetch {
  const urls: string[] = [];

  const recorder: RecordingFetch = {
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(handler(urls.length, url));
    },
    urls,
    get calls() {
      return urls.length;
    },
    lastUrl: () => urls[urls.length - 1] ?? '',
    lastParams: () => new URL(recorder.lastUrl()).searchParams,
  };
  return recorder;
}

/** Replies with `records` to every call. */
export function stubFetch(records: () => RawStationRecord[]): RecordingFetch {
  return recordingFetch(() => jsonResponse(records()));
}

/** Narrows away `undefined` so tests can assert on the value itself. */
export function expectDefined<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined.`);
  }
  return value;
}
