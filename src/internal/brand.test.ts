/**
 * Every value quoted here was read off the live sources: `brand` and `operator`
 * tags of `amenity=fuel` in France, and the `Brand.name` of the prix-carburants
 * reuse. The messy ones are not hypothetical.
 */

import { describe, expect, it } from '@jest/globals';

import { KNOWN_BRANDS, sanitizeBrand, toBrandKey } from './brand.js';

describe('the networks it folds', () => {
  it.each([
    ['Total', 'TotalEnergies'],
    ['TotalEnergies', 'TotalEnergies'],
    ['TOTAL', 'TotalEnergies'],
    ['total access', 'TotalEnergies'],
    ['Total Access', 'TotalEnergies'],
    ['TotalEnergies Access', 'TotalEnergies'],
    ['Total Contact', 'TotalEnergies'],
    ['Elf', 'TotalEnergies'],
    ['Argedis', 'TotalEnergies'],
    ['Esso', 'Esso'],
    ['Esso Express', 'Esso'],
    ['Super U', 'Système U'],
    ['Système U', 'Système U'],
    ['SYSTEME U', 'Système U'],
    ['Station U', 'Système U'],
    ['La Station U', 'Système U'],
    ['Hyper U', 'Système U'],
    ['U Express', 'Système U'],
    ['E.Leclerc', 'E.Leclerc'],
    ['E. Leclerc', 'E.Leclerc'],
    ['Leclerc', 'E.Leclerc'],
    ['Carrefour Market', 'Carrefour'],
    ['Carrefour Contact', 'Carrefour'],
    ['Carrefour Express', 'Carrefour'],
    ['Intermarché', 'Intermarché'],
    ['INTERMARCHE', 'Intermarché'],
    ['Intermarché Contact', 'Intermarché'],
    ['Ecomarché', 'Intermarché'],
    ['Agip', 'Eni'],
    ['ENI', 'Eni'],
    ['AVIA', 'Avia'],
    ['AVIA XPress', 'Avia'],
    ['Élan', 'Elan'],
    ['AS 24', 'AS24'],
    ['Simply Market', 'Auchan'],
    ['Géant Casino', 'Casino'],
    ['Supermarché Match', 'Match'],
  ])('reads %p as %p', (raw, expected) => {
    expect(sanitizeBrand(raw)).toBe(expected);
  });

  it.each([
    ['Total Excellium', 'TotalEnergies'],
    ['Total Acces', 'TotalEnergies'],
    ['Total Energies', 'TotalEnergies'],
    ['Groupement des Mousquetaires', 'Intermarché'],
    ['Les Mousquetaires', 'Intermarché'],
    ['AviaXpress', 'Avia'],
    ['Super U;Station U', 'Système U'],
    ['Carrefour Market Plus', 'Carrefour'],
    ['Avia Relais du Pont', 'Avia'],
  ])('matches %p on its leading words, giving %p', (raw, expected) => {
    // The suffixes are endless — a grade, a banner, a place — so the table holds
    // the roots and the match drops words off the end.
    expect(sanitizeBrand(raw)).toBe(expected);
  });

  it('does not mistake a longer word for a network of the same start', () => {
    // `Utile` starts with the `U` of Système U, and is a different chain.
    expect(sanitizeBrand('Utile')).toBe('Utile');
    expect(sanitizeBrand('Bpifrance')).toBe('Bpifrance');
  });

  it('folds the single letter OSM spells Système U with', () => {
    // 23 stations in one sample region: too many to drop as too short.
    expect(sanitizeBrand('U')).toBe('Système U');
  });

  it('keeps a brand the table has never heard of', () => {
    // Foreign networks reach us through the border of a bounding box.
    expect(sanitizeBrand('Repsol')).toBe('Repsol');
    expect(sanitizeBrand('Galp')).toBe('Galp');
    expect(sanitizeBrand('Karrgreen')).toBe('Karrgreen');
  });

  it('exposes the canonical names, TotalEnergies included', () => {
    expect(KNOWN_BRANDS).toContain('TotalEnergies');
    expect(KNOWN_BRANDS).toContain('Système U');
    expect(new Set(KNOWN_BRANDS).size).toBe(KNOWN_BRANDS.length);
  });
});

describe('the noise it strips', () => {
  it.each([
    ['  Avia  ', 'Avia'],
    [' Total ', 'TotalEnergies'],
    ['Station AVIA XPRESS', 'Avia'],
    ['Station-service Total', 'TotalEnergies'],
    ['Garage Dupont', 'Dupont'],
    ['"Avia"', 'Avia'],
    ['Dyneff.', 'Dyneff'],
    ['B2M SARL', 'B2M'],
    ['Rallasa S.L.', 'Rallasa S.L'],
    ['Armorine SAS', 'Armorine'],
    ['SARL FONTENERGIE', 'FONTENERGIE'],
  ])('reads %p as %p', (raw, expected) => {
    expect(sanitizeBrand(raw)).toBe(expected);
  });

  it('takes the first known network of a shared forecourt', () => {
    expect(sanitizeBrand('Total/Rubis')).toBe('TotalEnergies');
    expect(sanitizeBrand('Rubis / Total')).toBe('Rubis');
    expect(sanitizeBrand('Avia + Elan')).toBe('Avia');
  });

  it('is idempotent, so a value may pass through twice', () => {
    for (const raw of ['Total Access', 'Station U', '  Repsol ', 'Élan']) {
      const once = sanitizeBrand(raw);
      expect(sanitizeBrand(once)).toBe(once);
    }
  });
});

describe('what it refuses to call a brand', () => {
  it.each([
    'yes',
    'no',
    'unknown',
    'inconnu',
    'communale',
    'Communale',
    'Independent',
    'indépendant',
    'autre',
    'station',
    'Station service',
    'essence',
    'carburants',
    'pompe',
    'automate',
    'garage',
    'supermarché',
    'relais',
    'privé',
  ])('drops %p', (raw) => {
    expect(sanitizeBrand(raw)).toBeNull();
  });

  it.each([
    ['a value with no letter at all', '24/24'],
    ['a single character', 'X'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a sentence rather than a name', 'Station de la commune ouverte du lundi au samedi matin'],
  ])('drops %s', (_label, raw) => {
    expect(sanitizeBrand(raw)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{ name: 'Total' }], [['Total']]])(
    'drops the non-string %p',
    (raw) => {
      expect(sanitizeBrand(raw)).toBeNull();
    },
  );
});

describe('the lookup key', () => {
  it('sends every spelling of a network to the same bucket', () => {
    const key = toBrandKey('TotalEnergies');

    expect(toBrandKey('total')).toBe(key);
    expect(toBrandKey('TOTAL')).toBe(key);
    expect(toBrandKey('Total Access')).toBe(key);
    expect(toBrandKey(' elf ')).toBe(key);
  });

  it('keeps a value it cannot canonicalise, so a filter on it still works', () => {
    expect(toBrandKey('Repsol')).toBe('repsol');
    expect(toBrandKey('unknown')).toBe('unknown');
  });
});
