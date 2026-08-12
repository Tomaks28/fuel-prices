import { describe, expect, it } from '@jest/globals';

import {
  createStyle,
  formatFooter,
  formatMatches,
  shouldUseColour,
  truncate,
  type TableOptions,
} from './cli-format.js';
import { toStation } from './internal/normalize.js';
import { expectDefined, rawRecord } from './test-helpers.js';

import type { RawStationRecord } from './internal/dataset.js';
import type { StationMatch } from './types.js';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const PLAIN = createStyle(false);

function match(overrides: Partial<RawStationRecord>, distanceMeters: number | null): StationMatch {
  return {
    station: expectDefined(toStation(rawRecord(1, overrides)), 'station'),
    distanceMeters,
  };
}

/** The same match, with the brand a source would have put on it. */
function branded_(base: StationMatch, brand: string): StationMatch {
  return { ...base, station: { ...base.station, brand } };
}

function options(overrides: Partial<TableOptions> = {}): TableOptions {
  return { style: PLAIN, width: 120, isOpen: () => null, now: NOW, ...overrides };
}

/** The rows without the header. */
function rows(matches: StationMatch[], overrides: Partial<TableOptions> = {}): string[] {
  return formatMatches(matches, options(overrides)).slice(1);
}

describe('createStyle', () => {
  it('wraps text in ANSI codes when enabled', () => {
    const style = createStyle(true);

    expect(style.green('ok')).toBe('\u001b[32mok\u001b[0m');
    expect(style.bold('ok')).toBe('\u001b[1mok\u001b[0m');
  });

  it('hands the text back untouched when disabled', () => {
    expect(PLAIN.green('ok')).toBe('ok');
    expect(PLAIN.bold(PLAIN.dim('ok'))).toBe('ok');
  });
});

describe('shouldUseColour', () => {
  it('colours an interactive terminal', () => {
    expect(shouldUseColour({}, true, false)).toBe(true);
  });

  it('stays plain when the output is piped', () => {
    expect(shouldUseColour({}, false, false)).toBe(false);
  });

  it('obeys --no-color above everything', () => {
    expect(shouldUseColour({ FORCE_COLOR: '1' }, true, true)).toBe(false);
  });

  it('obeys NO_COLOR, whatever its value', () => {
    expect(shouldUseColour({ NO_COLOR: '1' }, true, false)).toBe(false);
    expect(shouldUseColour({ NO_COLOR: 'anything' }, true, false)).toBe(false);
    // An empty value does not count, per no-color.org.
    expect(shouldUseColour({ NO_COLOR: '' }, true, false)).toBe(true);
  });

  it('lets FORCE_COLOR paint a pipe', () => {
    expect(shouldUseColour({ FORCE_COLOR: '1' }, false, false)).toBe(true);
    expect(shouldUseColour({ FORCE_COLOR: '0' }, false, false)).toBe(false);
  });
});

describe('formatMatches', () => {
  it('says so plainly when nothing matched', () => {
    expect(formatMatches([], options())).toEqual(['No station matched.']);
  });

  it('heads the table with the columns it will print', () => {
    const [header] = formatMatches([match({}, 1200)], options());

    expect(header).toContain('DIST');
    expect(header).toContain('PLACE');
    expect(header).toContain('GAZOLE');
    expect(header).toContain('AGE');
    expect(header).toContain('STATUS');
  });

  it('only prints a column for a fuel somebody sells', () => {
    const [header] = formatMatches([match({}, null)], options());

    // The fixture sells gazole and nothing else.
    expect(header).toContain('GAZOLE');
    expect(header).not.toContain('GPLC');
    expect(header).not.toContain('E85');
  });

  it('drops the distance column when no match has one', () => {
    const [header] = formatMatches([match({}, null)], options());
    expect(header).not.toContain('DIST');
  });

  it('drops the brand column when no station is branded', () => {
    const [header] = formatMatches([match({}, null)], options());

    // Without a brand source that column would be dashes all the way down.
    expect(header).not.toContain('BRAND');
  });

  it('keeps the column when brands were asked for and none came back', () => {
    const [header, ...printed] = formatMatches([match({}, null)], options({ brands: true }));

    // A source that failed has to read as an empty column, not as a missing one.
    expect(header).toContain('BRAND');
    expect(printed[0]).toContain('—');
  });

  it('prints the brand of the stations that have one', () => {
    const branded = branded_(match({}, null), 'TotalEnergies');
    const [header, ...printed] = formatMatches([branded, match({ id: 2 }, null)], options());

    expect(header).toContain('BRAND');
    expect(printed[0]).toContain('TotalEnergies');
    expect(printed[1]).toContain('—');
  });

  it('truncates a brand rather than shifting the columns', () => {
    const branded = branded_(match({}, null), 'A network with a very long name');
    const printed = rows([branded]);

    expect(printed[0]).toContain('A network wi…');
    expect(printed[0]).not.toContain('very long');
  });

  it('puts the highlighted fuel in the first price column', () => {
    const header = expectDefined(
      formatMatches(
        [match({ e85_prix: 0.8, e85_maj: '2026-08-12T10:00:00+00:00' }, null)],
        options({ highlight: 'e85' }),
      )[0],
      'header',
    );

    expect(header.indexOf('E85')).toBeLessThan(header.indexOf('GAZOLE'));
  });

  it('numbers the rows in the order it was given', () => {
    const printed = rows([match({}, 100), match({ id: 2 }, 200), match({ id: 3 }, 300)]);

    expect(printed[0]).toMatch(/^1\./);
    expect(printed[2]).toMatch(/^3\./);
  });

  it('reads distances in metres below a kilometre and in kilometres above', () => {
    expect(rows([match({}, 940)])[0]).toContain('940 m');
    expect(rows([match({}, 2906)])[0]).toContain('2.9 km');
    expect(rows([match({}, 17_000)])[0]).toContain('17.0 km');
  });

  it('shows the place and the address, truncated to the width', () => {
    const wide = rows([match({}, null)], { width: 200 })[0];
    expect(wide).toContain('Saint-Malo 35400 · 55 Boulevard des Déportés');

    const narrow = rows([match({}, null)], { width: 60 })[0];
    expect(narrow).toContain('…');
    expect(narrow).not.toContain('Boulevard des Déportés');
  });

  it('marks a fuel the station does not sell', () => {
    const printed = rows([
      match({ gazole_prix: null, gazole_maj: null, e10_prix: 1.8, e10_maj: null }, null),
    ])[0];

    expect(printed).toContain('—');
  });

  it('prints prices to the centime, right-aligned so they compare by eye', () => {
    const printed = rows([
      match({ gazole_prix: 2.1 }, null),
      match({ id: 2, gazole_prix: 1.9 }, null),
    ]);

    expect(printed[0]).toContain(' 2.100');
    expect(printed[1]).toContain(' 1.900');
  });

  it('ages a quote in hours up to two days, then in days', () => {
    expect(rows([match({ gazole_maj: '2026-08-12T03:00:00+00:00' }, null)])[0]).toContain('9h');
    expect(rows([match({ gazole_maj: '2026-08-05T12:00:00+00:00' }, null)])[0]).toContain('7d');
  });

  it('reports the status the feed can vouch for', () => {
    expect(rows([match({}, null)], { isOpen: () => true })[0]).toContain('open');
    expect(rows([match({}, null)], { isOpen: () => false })[0]).toContain('closed');
    expect(rows([match({}, null)], { isOpen: () => null })[0]).toContain('unknown');
  });

  describe('colour', () => {
    const style = createStyle(true);

    it('paints the cheapest of each column green', () => {
      const printed = rows(
        [match({ gazole_prix: 2.1 }, null), match({ id: 2, gazole_prix: 1.9 }, null)],
        {
          style,
        },
      );

      expect(printed[1]).toContain('\u001b[32m 1.900\u001b[0m');
      expect(printed[0]).not.toContain('\u001b[32m 2.100');
    });

    it('bolds the highlighted column, and combines both on its cheapest', () => {
      const printed = rows(
        [match({ gazole_prix: 2.1 }, null), match({ id: 2, gazole_prix: 1.9 }, null)],
        { style, highlight: 'gazole' },
      );

      expect(printed[0]).toContain('\u001b[1m 2.100\u001b[0m');
      expect(printed[1]).toContain('\u001b[32m\u001b[1m 1.900');
    });

    it('warns in yellow past a week and in red past a month', () => {
      const week = rows([match({ gazole_maj: '2026-08-01T12:00:00+00:00' }, null)], { style })[0];
      const month = rows([match({ gazole_maj: '2026-05-01T12:00:00+00:00' }, null)], { style })[0];
      const fresh = rows([match({ gazole_maj: '2026-08-12T09:00:00+00:00' }, null)], { style })[0];

      expect(week).toContain('\u001b[33m');
      expect(month).toContain('\u001b[31m');
      expect(fresh).not.toContain('\u001b[33m');
    });

    it('greens an open station and reddens a closed one', () => {
      expect(rows([match({}, null)], { style, isOpen: () => true })[0]).toContain('\u001b[32mopen');
      expect(rows([match({}, null)], { style, isOpen: () => false })[0]).toContain(
        '\u001b[31mclosed',
      );
    });

    it('emits no escape at all when colour is off', () => {
      expect(rows([match({}, 1000)]).join('')).not.toContain('\u001b');
    });
  });
});

describe('formatFooter', () => {
  it('counts what was shown against what is cached', () => {
    expect(formatFooter(10, 9807, 47, PLAIN)).toContain('10 of 9 807 cached stations');
  });

  it('reads short runs in milliseconds and long ones in seconds', () => {
    expect(formatFooter(1, 1, 47, PLAIN)).toContain('47 ms');
    expect(formatFooter(1, 1, 72_997, PLAIN)).toContain('73.0 s');
  });
});

describe('truncate', () => {
  it('leaves text that fits alone', () => {
    expect(truncate('Dreux', 10)).toBe('Dreux');
  });

  it('marks what it cut', () => {
    expect(truncate('Saint-Lubin-des-Joncherets', 10)).toBe('Saint-Lub…');
    expect(truncate('Saint-Lubin-des-Joncherets', 10)).toHaveLength(10);
  });
});
