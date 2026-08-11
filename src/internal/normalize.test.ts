import { describe, expect, it } from '@jest/globals';

import { expectDefined, rawRecord } from '../test-helpers.js';

import { hasChanged, toStation } from './normalize.js';

describe('toStation', () => {
  it('maps a record to the public station shape', () => {
    const station = expectDefined(toStation(rawRecord(35400007)), 'station');

    expect(station).toMatchObject({
      id: '35400007',
      address: '55 Boulevard des Déportés',
      city: 'Saint-Malo',
      postalCode: '35400',
      department: { code: '35', name: 'Ille-et-Vilaine' },
      region: { code: '53', name: 'Bretagne' },
      location: { latitude: 48.65797, longitude: -1.97092 },
      kind: 'road',
      open24h: true,
      services: ['Bar', 'Laverie'],
    });
  });

  it('stringifies the numeric dataset id, so it can key the cache', () => {
    expect(toStation(rawRecord(35400007))?.id).toBe('35400007');
    expect(toStation(rawRecord(' 35400007 '))?.id).toBe('35400007');
  });

  it('drops a record without a usable id rather than let it collide', () => {
    expect(toStation(rawRecord('', { id: null }))).toBeNull();
    expect(toStation(rawRecord('', { id: '   ' }))).toBeNull();
  });

  describe('prices', () => {
    it('exposes the fuels on sale, normalised to a UTC instant', () => {
      const station = expectDefined(toStation(rawRecord(1)), 'station');

      expect(station.prices.gazole).toEqual({
        fuel: 'gazole',
        price: 1.9,
        updatedAt: '2026-08-11T10:00:00.000Z',
      });
      expect(station.prices.sp95).toBeUndefined();
    });

    it('keeps a price whose timestamp the feed left out', () => {
      const station = expectDefined(toStation(rawRecord(1, { gazole_maj: null })), 'station');
      expect(station.prices.gazole).toEqual({ fuel: 'gazole', price: 1.9, updatedAt: null });
    });

    it('ignores an unparsable timestamp instead of propagating an Invalid Date', () => {
      const station = expectDefined(
        toStation(rawRecord(1, { gazole_maj: 'not-a-date' })),
        'station',
      );
      expect(station.prices.gazole?.updatedAt).toBeNull();
      expect(station.updatedAt).toBeNull();
    });

    it('reports the most recent price as the station timestamp', () => {
      const station = expectDefined(
        toStation(
          rawRecord(1, {
            sp98_prix: 2.1,
            sp98_maj: '2026-08-11T18:00:00+00:00',
            e10_prix: 1.8,
            e10_maj: '2026-08-09T06:00:00+00:00',
          }),
        ),
        'station',
      );
      expect(station.updatedAt).toBe('2026-08-11T18:00:00.000Z');
    });

    it('treats a non-finite price as no price at all', () => {
      const station = expectDefined(
        toStation(rawRecord(1, { gazole_prix: Number.NaN })),
        'station',
      );
      expect(station.prices.gazole).toBeUndefined();
    });

    it('keeps a free fuel, which is a price of zero', () => {
      const station = expectDefined(toStation(rawRecord(1, { gazole_prix: 0 })), 'station');
      expect(station.prices.gazole?.price).toBe(0);
    });
  });

  describe('outages', () => {
    it('translates the outage kind and start date', () => {
      const station = expectDefined(toStation(rawRecord(1)), 'station');

      expect(station.outages.sp95).toEqual({
        fuel: 'sp95',
        kind: 'definitive',
        since: '2020-01-01T00:00:00.000Z',
      });
    });

    it('maps a temporary outage', () => {
      const station = expectDefined(
        toStation(rawRecord(1, { gplc_rupture_type: 'temporaire', gplc_rupture_debut: null })),
        'station',
      );
      expect(station.outages.gplc).toEqual({ fuel: 'gplc', kind: 'temporary', since: null });
    });

    it('falls back to `unknown` when only a start date is reported', () => {
      const station = expectDefined(
        toStation(rawRecord(1, { e85_rupture_debut: '2019-05-05T00:00:00+00:00' })),
        'station',
      );
      expect(station.outages.e85).toEqual({
        fuel: 'e85',
        kind: 'unknown',
        since: '2019-05-05T00:00:00.000Z',
      });
    });

    it('stays silent on a fuel the station simply never sold', () => {
      expect(toStation(rawRecord(1))?.outages.sp98).toBeUndefined();
    });

    it('never contradicts a price: the rupture columns keep past history', () => {
      // Seen upstream on ~5 200 stations: a definitive SP95 outage alongside a
      // current SP95 price. The price wins.
      const station = expectDefined(
        toStation(rawRecord(1, { sp95_prix: 2.06, sp95_maj: '2026-08-11T10:00:00+00:00' })),
        'station',
      );

      expect(station.prices.sp95?.price).toBe(2.06);
      expect(station.outages.sp95).toBeUndefined();
    });
  });

  describe('station attributes', () => {
    it('reads a motorway station off the `pop` column', () => {
      expect(toStation(rawRecord(1, { pop: 'A' }))?.kind).toBe('highway');
      expect(toStation(rawRecord(1, { pop: 'R' }))?.kind).toBe('road');
      expect(toStation(rawRecord(1, { pop: null }))?.kind).toBe('road');
    });

    it('reads the 24/7 pump off the French yes/no column', () => {
      expect(toStation(rawRecord(1, { horaires_automate_24_24: 'Oui' }))?.open24h).toBe(true);
      expect(toStation(rawRecord(1, { horaires_automate_24_24: 'Non' }))?.open24h).toBe(false);
      expect(toStation(rawRecord(1, { horaires_automate_24_24: null }))?.open24h).toBe(false);
    });

    it('substitutes empty strings and empty lists for missing text', () => {
      const station = expectDefined(
        toStation(rawRecord(1, { adresse: null, ville: null, cp: null, services_service: null })),
        'station',
      );

      expect(station).toMatchObject({ address: '', city: '', postalCode: '', services: [] });
    });

    it('trims the text the feed pads', () => {
      const station = expectDefined(
        toStation(rawRecord(1, { ville: '  Saint-Malo ', cp: ' 35400 ' })),
        'station',
      );
      expect(station).toMatchObject({ city: 'Saint-Malo', postalCode: '35400' });
    });

    it('drops the location when the record has no usable geometry', () => {
      expect(toStation(rawRecord(1, { geom: null }))?.location).toBeNull();
      expect(toStation(rawRecord(1, { geom: { lon: Number.NaN, lat: 48 } }))?.location).toBeNull();
    });

    it('reports an area the feed only half-fills, and nulls one it omits', () => {
      expect(toStation(rawRecord(1, { departement: null }))?.department).toEqual({
        code: '35',
        name: '',
      });
      expect(
        toStation(rawRecord(1, { departement: null, code_departement: null }))?.department,
      ).toBeNull();
    });
  });
});

describe('hasChanged', () => {
  const base = expectDefined(toStation(rawRecord(1)), 'base');

  it('sees no change in an identical record', () => {
    expect(hasChanged(base, expectDefined(toStation(rawRecord(1)), 'same'))).toBe(false);
  });

  it('sees a new price', () => {
    const next = expectDefined(toStation(rawRecord(1, { gazole_prix: 1.75 })), 'next');
    expect(hasChanged(base, next)).toBe(true);
  });

  it('sees a re-quoted price at the same value', () => {
    const next = expectDefined(
      toStation(rawRecord(1, { gazole_maj: '2026-08-11T12:00:00+00:00' })),
      'next',
    );
    expect(hasChanged(base, next)).toBe(true);
  });

  it('sees a fuel appearing or disappearing', () => {
    const added = expectDefined(
      toStation(rawRecord(1, { e85_prix: 0.8, e85_maj: '2026-08-11T10:00:00+00:00' })),
      'added',
    );
    const removed = expectDefined(
      toStation(rawRecord(1, { gazole_prix: null, gazole_maj: null })),
      'removed',
    );

    expect(hasChanged(base, added)).toBe(true);
    expect(hasChanged(base, removed)).toBe(true);
  });

  it('ignores what the SDK does not expose as price data', () => {
    const next = expectDefined(toStation(rawRecord(1, { services_service: [] })), 'next');
    expect(hasChanged(base, next)).toBe(false);
  });
});
