import { describe, expect, it } from '@jest/globals';

import { expectDefined, rawRecord } from '../test-helpers.js';
import type { Station } from '../types.js';

import { toStation } from './normalize.js';
import { toPriceStats } from './stats.js';

/** A station selling gazole at `price`, quoted at `maj`. */
function priced(id: number, price: number | null, maj = '2026-08-11T10:00:00+00:00'): Station {
  return expectDefined(
    toStation(rawRecord(id, { gazole_prix: price, gazole_maj: price === null ? null : maj })),
    'station',
  );
}

describe('toPriceStats', () => {
  it('describes the distribution of one fuel', () => {
    const stats = toPriceStats([priced(1, 1.8), priced(2, 2.0), priced(3, 2.2)], 'gazole');

    expect(stats).toEqual({
      fuel: 'gazole',
      count: 3,
      min: 1.8,
      max: 2.2,
      mean: 2,
      median: 2,
      updatedAt: '2026-08-11T10:00:00.000Z',
    });
  });

  it('averages the two middle values on an even count', () => {
    const stats = toPriceStats(
      [priced(1, 1.0), priced(2, 2.0), priced(3, 3.0), priced(4, 6.0)],
      'gazole',
    );

    expect(stats?.median).toBe(2.5);
    expect(stats?.mean).toBe(3);
  });

  it('is unmoved by the order it receives the stations in', () => {
    const ascending = toPriceStats([priced(1, 1.5), priced(2, 2.5), priced(3, 3.5)], 'gazole');
    const shuffled = toPriceStats([priced(2, 2.5), priced(3, 3.5), priced(1, 1.5)], 'gazole');

    expect(shuffled).toEqual(ascending);
  });

  it('counts only the stations selling that fuel', () => {
    const stats = toPriceStats([priced(1, 1.8), priced(2, null), priced(3, 2.2)], 'gazole');

    expect(stats?.count).toBe(2);
    expect(stats?.min).toBe(1.8);
  });

  it('reports the freshest quote of the set', () => {
    const stats = toPriceStats(
      [
        priced(1, 1.8, '2026-03-01T10:00:00+00:00'),
        priced(2, 2.2, '2026-08-11T12:00:00+00:00'),
        priced(3, 2.0, '2026-07-04T10:00:00+00:00'),
      ],
      'gazole',
    );

    expect(stats?.updatedAt).toBe('2026-08-11T12:00:00.000Z');
  });

  it('returns null rather than a row of zeroes when nothing sells the fuel', () => {
    expect(toPriceStats([priced(1, 1.8)], 'gplc')).toBeNull();
    expect(toPriceStats([], 'gazole')).toBeNull();
  });

  it('handles a single station', () => {
    expect(toPriceStats([priced(1, 1.999)], 'gazole')).toMatchObject({
      count: 1,
      min: 1.999,
      max: 1.999,
      mean: 1.999,
      median: 1.999,
    });
  });

  it('copes with a priced fuel whose timestamp the feed omitted', () => {
    const station = expectDefined(
      toStation(rawRecord(1, { gazole_prix: 1.8, gazole_maj: null })),
      'station',
    );

    expect(toPriceStats([station], 'gazole')).toMatchObject({ count: 1, updatedAt: null });
  });
});
