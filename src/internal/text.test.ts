import { describe, expect, it } from '@jest/globals';

import { toLookupKey, trimChars, trimTrailing } from './text.js';

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

describe('trimChars', () => {
  it.each([
    ['"Avia"', '"\'', 'Avia'],
    ['«Total»', '«»', 'Total'],
    ['((Esso))', '()', 'Esso'],
    ['Avia', '"\'', 'Avia'],
    ['', '"', ''],
  ])('trims %j of %j', (value, cut, expected) => {
    expect(trimChars(value, cut)).toBe(expected);
  });

  it('leaves the middle alone', () => {
    expect(trimChars('a"b"c', '"')).toBe('a"b"c');
  });

  it('empties a value made only of what it cuts', () => {
    expect(trimChars('""""', '"')).toBe('');
  });
});

describe('trimTrailing', () => {
  it.each([
    ['Dyneff.', ' .', 'Dyneff'],
    ['Total —', ' —', 'Total'],
    ['https://example.test///', '/', 'https://example.test'],
    ['https://example.test', '/', 'https://example.test'],
  ])('trims the end of %j', (value, cut, expected) => {
    expect(trimTrailing(value, cut)).toBe(expected);
  });

  it('leaves the start alone, unlike trimChars', () => {
    expect(trimTrailing('...Total...', '.')).toBe('...Total');
    expect(trimChars('...Total...', '.')).toBe('Total');
  });

  it('stays linear where the regex form does not', () => {
    // `/[.]+$/` on this input takes ~28 ms and quadruples with the length; the
    // loop is what keeps a public sanitizer safe to hand any string to.
    const pathological = `${'.'.repeat(200_000)}x`;

    const started = performance.now();
    expect(trimTrailing(pathological, '.')).toBe(pathological);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
