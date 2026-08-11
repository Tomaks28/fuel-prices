import { describe, expect, it } from '@jest/globals';

import { expectDefined, rawRecord } from '../test-helpers.js';
import type { Station } from '../types.js';

import { isOpenAt, parseOpeningHours } from './hours.js';
import { toStation } from './normalize.js';

/** The feed's own wire format: a stringified JSON blob. */
function hoursBlob(days: unknown[], automat = ''): string {
  return JSON.stringify({ '@automate-24-24': automat, jour: days });
}

function day(id: number, options: { closed?: boolean; ranges?: [string, string][] } = {}): unknown {
  const ranges = options.ranges ?? [];
  const horaire = ranges.map(([o, c]) => ({ '@ouverture': o, '@fermeture': c }));

  return {
    '@id': String(id),
    '@ferme': options.closed === true ? '1' : '',
    ...(horaire.length === 0 ? {} : { horaire: horaire.length === 1 ? horaire[0] : horaire }),
  };
}

function stationWith(raw: string | null): Station {
  return expectDefined(toStation(rawRecord(1, { horaires: raw })), 'station');
}

// Monday 2026-08-10 at 09:00 Paris (07:00 UTC in summer).
const MONDAY_9AM = new Date('2026-08-10T07:00:00.000Z');

describe('parseOpeningHours', () => {
  it('reads a plain weekly schedule', () => {
    const hours = parseOpeningHours(
      hoursBlob([day(1, { ranges: [['08.00', '19.30']] }), day(2, { closed: true }), day(3)]),
    );

    expect(hours).toEqual({
      automat24h: false,
      days: [
        { weekday: 1, closed: false, ranges: [{ opensAt: '08:00', closesAt: '19:30' }] },
        { weekday: 2, closed: true, ranges: [] },
        // Neither hours nor a closed flag: the feed says nothing.
        { weekday: 3, closed: false, ranges: [] },
      ],
    });
  });

  it('reads the split lunchtime shape, where the feed sends a list', () => {
    const hours = parseOpeningHours(
      hoursBlob([
        day(1, {
          ranges: [
            ['08.00', '12.00'],
            ['14.00', '19.00'],
          ],
        }),
      ]),
    );

    expect(hours?.days[0]?.ranges).toEqual([
      { opensAt: '08:00', closesAt: '12:00' },
      { opensAt: '14:00', closesAt: '19:00' },
    ]);
  });

  it('lets the closed flag win over the placeholder range beside it', () => {
    // 5 839 day entries upstream carry both, always as `01.00-01.00`.
    const hours = parseOpeningHours(
      hoursBlob([day(1, { closed: true, ranges: [['01.00', '01.00']] })]),
    );

    expect(hours?.days[0]).toEqual({ weekday: 1, closed: true, ranges: [] });
  });

  it('picks up the 24/7 automat flag', () => {
    expect(parseOpeningHours(hoursBlob([day(1)], '1'))?.automat24h).toBe(true);
    expect(parseOpeningHours(hoursBlob([day(1)], ''))?.automat24h).toBe(false);
  });

  it('accepts a single day sent as an object rather than a list', () => {
    const blob = JSON.stringify({ '@automate-24-24': '', jour: day(3, { closed: true }) });

    expect(parseOpeningHours(blob)?.days).toEqual([{ weekday: 3, closed: true, ranges: [] }]);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['unparsable JSON', '{oops'],
    ['a JSON scalar', '"nope"'],
    ['an object with no days', '{"@automate-24-24":""}'],
  ])('returns null for %s', (_label, raw) => {
    expect(parseOpeningHours(raw)).toBeNull();
  });

  it('keeps a 24/7 automat even when the day list is unusable', () => {
    expect(parseOpeningHours('{"@automate-24-24":"1"}')).toEqual({ automat24h: true, days: [] });
  });

  it('drops a day whose id is not a weekday, and times it cannot read', () => {
    const hours = parseOpeningHours(
      hoursBlob([
        { '@id': '9', '@ferme': '' },
        day(2, { ranges: [['8h30', '19.00']] }),
        day(3, { ranges: [['25.00', '26.00']] }),
      ]),
    );

    expect(hours?.days.map((d) => d.weekday)).toEqual([2, 3]);
    expect(hours?.days[0]?.ranges).toEqual([]);
    expect(hours?.days[1]?.ranges).toEqual([]);
  });

  it('falls back to the position when the id is missing', () => {
    const hours = parseOpeningHours(hoursBlob([{ '@ferme': '1' }, { '@ferme': '' }]));

    expect(hours?.days.map((d) => d.weekday)).toEqual([1, 2]);
  });
});

describe('isOpenAt', () => {
  it('answers null when the station publishes no schedule', () => {
    expect(isOpenAt(stationWith(null), MONDAY_9AM)).toBeNull();
  });

  it('answers true all week for an unattended 24/7 pump', () => {
    const station = stationWith(hoursBlob([day(1, { closed: true })], '1'));

    expect(isOpenAt(station, MONDAY_9AM)).toBe(true);
    expect(isOpenAt(station, new Date('2026-08-16T02:00:00.000Z'))).toBe(true);
  });

  it('answers on a day with hours', () => {
    const station = stationWith(hoursBlob([day(1, { ranges: [['08.00', '19.30']] })]));

    expect(isOpenAt(station, MONDAY_9AM)).toBe(true);
    expect(isOpenAt(station, new Date('2026-08-10T05:00:00.000Z'))).toBe(false); // 07:00 Paris
    expect(isOpenAt(station, new Date('2026-08-10T18:00:00.000Z'))).toBe(false); // 20:00 Paris
  });

  it('answers false on a day flagged closed', () => {
    expect(isOpenAt(stationWith(hoursBlob([day(1, { closed: true })])), MONDAY_9AM)).toBe(false);
  });

  it('answers null on a day the feed leaves blank', () => {
    expect(isOpenAt(stationWith(hoursBlob([day(1)])), MONDAY_9AM)).toBeNull();
  });

  it('answers null when no entry matches that weekday', () => {
    expect(isOpenAt(stationWith(hoursBlob([day(3, { closed: true })])), MONDAY_9AM)).toBeNull();
  });

  it('closes over lunch when the feed splits the day', () => {
    const station = stationWith(
      hoursBlob([
        day(1, {
          ranges: [
            ['08.00', '12.00'],
            ['14.00', '19.00'],
          ],
        }),
      ]),
    );

    expect(isOpenAt(station, new Date('2026-08-10T08:00:00.000Z'))).toBe(true); // 10:00
    expect(isOpenAt(station, new Date('2026-08-10T11:00:00.000Z'))).toBe(false); // 13:00
    expect(isOpenAt(station, new Date('2026-08-10T15:00:00.000Z'))).toBe(true); // 17:00
  });

  it('reads 00.00-00.00 as open all day, which is what the feed means', () => {
    const station = stationWith(hoursBlob([day(1, { ranges: [['00.00', '00.00']] })]));

    expect(isOpenAt(station, MONDAY_9AM)).toBe(true);
    expect(isOpenAt(station, new Date('2026-08-10T20:30:00.000Z'))).toBe(true); // 22:30 Paris
  });

  it('handles a range that runs past midnight', () => {
    const station = stationWith(hoursBlob([day(1, { ranges: [['22.00', '06.00']] })]));

    expect(isOpenAt(station, new Date('2026-08-10T21:00:00.000Z'))).toBe(true); // 23:00
    expect(isOpenAt(station, new Date('2026-08-10T02:00:00.000Z'))).toBe(true); // 04:00
    expect(isOpenAt(station, new Date('2026-08-10T10:00:00.000Z'))).toBe(false); // 12:00
  });

  it('is exclusive at closing time and inclusive at opening time', () => {
    const station = stationWith(hoursBlob([day(1, { ranges: [['08.00', '19.00']] })]));

    expect(isOpenAt(station, new Date('2026-08-10T06:00:00.000Z'))).toBe(true); // 08:00 sharp
    expect(isOpenAt(station, new Date('2026-08-10T17:00:00.000Z'))).toBe(false); // 19:00 sharp
  });

  it('reads the clock in Paris, not UTC', () => {
    const station = stationWith(hoursBlob([day(1, { ranges: [['08.00', '19.00']] })]));

    // 2026-08-10T06:30Z is 08:30 in Paris (CEST) — open — but would read as
    // closed on a naive UTC clock.
    expect(isOpenAt(station, new Date('2026-08-10T06:30:00.000Z'))).toBe(true);
    // And in winter, when Paris is UTC+1.
    const winter = stationWith(hoursBlob([day(1, { ranges: [['08.00', '19.00']] })]));
    expect(isOpenAt(winter, new Date('2026-01-05T07:30:00.000Z'))).toBe(true); // 08:30 CET
    expect(isOpenAt(winter, new Date('2026-01-05T06:30:00.000Z'))).toBe(false); // 07:30 CET
  });

  it('maps every weekday to the right entry', () => {
    const week = [1, 2, 3, 4, 5, 6, 7].map((id) =>
      day(id, id === 7 ? { closed: true } : { ranges: [['08.00', '19.00']] }),
    );
    const station = stationWith(hoursBlob(week));

    // 2026-08-10 is a Monday, so +6 days is the Sunday.
    expect(isOpenAt(station, new Date('2026-08-16T10:00:00.000Z'))).toBe(false);
    expect(isOpenAt(station, new Date('2026-08-15T10:00:00.000Z'))).toBe(true);
  });

  it('answers null for an invalid date rather than guessing', () => {
    const station = stationWith(hoursBlob([day(1, { ranges: [['08.00', '19.00']] })]));

    expect(isOpenAt(station, new Date('nonsense'))).toBeNull();
  });
});
