import { describe, expect, it } from '@jest/globals';

import { toLookupKey } from './text.js';

describe('toLookupKey', () => {
  it.each([
    ['Saint-Malo', 'saint malo'],
    ['SAINT MALO', 'saint malo'],
    ['saint-malo', 'saint malo'],
    ['  Saint   Malo  ', 'saint malo'],
    ['Montgenèvre', 'montgenevre'],
    ["L'Île-Rousse", 'l ile rousse'],
    ['Aix-en-Provence', 'aix en provence'],
    ['Paris 15e', 'paris 15e'],
  ])('folds %j to %j', (input, expected) => {
    expect(toLookupKey(input)).toBe(expected);
  });

  it('collapses every spelling of one city to a single key', () => {
    const keys = new Set(
      ['Saint-Malo', 'saint malo', 'SAINT_MALO', 'Saint--Malô'].map(toLookupKey),
    );
    expect(keys.size).toBe(1);
  });

  it('keeps distinct cities distinct', () => {
    expect(toLookupKey('Saint-Malo')).not.toBe(toLookupKey('Saint-Malo-de-Phily'));
  });

  it('returns an empty key for input that carries no letters', () => {
    expect(toLookupKey('  --  ')).toBe('');
  });
});
