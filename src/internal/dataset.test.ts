import { describe, expect, it } from '@jest/globals';

import { FUEL_TYPES } from '../types.js';

import { STATION_SELECT, updatedSinceWhere } from './dataset.js';

describe('STATION_SELECT', () => {
  it('asks for the four columns of every fuel', () => {
    const fields = STATION_SELECT.split(',');

    for (const fuel of FUEL_TYPES) {
      expect(fields).toContain(`${fuel}_prix`);
      expect(fields).toContain(`${fuel}_maj`);
      expect(fields).toContain(`${fuel}_rupture_debut`);
      expect(fields).toContain(`${fuel}_rupture_type`);
    }
  });

  it('asks for the station identity and location columns', () => {
    expect(STATION_SELECT.split(',')).toEqual(
      expect.arrayContaining([
        'id',
        'adresse',
        'ville',
        'cp',
        'pop',
        'geom',
        'code_departement',
        'code_region',
        'services_service',
        'horaires_automate_24_24',
      ]),
    );
  });

  it('leaves out the stringified JSON columns the flat ones duplicate', () => {
    // Requesting them would double the payload for no added information.
    const fields = STATION_SELECT.split(',');
    expect(fields).not.toContain('prix');
    expect(fields).not.toContain('rupture');
    expect(fields).not.toContain('services');
    expect(fields).not.toContain('horaires');
  });

  it('lists every field exactly once', () => {
    const fields = STATION_SELECT.split(',');
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('updatedSinceWhere', () => {
  const since = new Date('2026-08-11T12:34:56.000Z');

  it('unions the per-fuel timestamps, since the dataset has no record-level one', () => {
    expect(updatedSinceWhere(since)).toBe(
      "gazole_maj > date'2026-08-11T12:34:56.000Z' or " +
        "sp95_maj > date'2026-08-11T12:34:56.000Z' or " +
        "sp98_maj > date'2026-08-11T12:34:56.000Z' or " +
        "e10_maj > date'2026-08-11T12:34:56.000Z' or " +
        "e85_maj > date'2026-08-11T12:34:56.000Z' or " +
        "gplc_maj > date'2026-08-11T12:34:56.000Z'",
    );
  });

  it('covers all six fuels', () => {
    expect(updatedSinceWhere(since).split(' or ')).toHaveLength(FUEL_TYPES.length);
  });

  it('expresses the bound in UTC whatever the input timezone', () => {
    const offset = new Date('2026-08-11T14:34:56.000+02:00');
    expect(updatedSinceWhere(offset)).toBe(updatedSinceWhere(since));
  });
});
