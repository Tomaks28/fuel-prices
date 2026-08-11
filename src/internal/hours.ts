/**
 * Opening hours, which the feed ships as a stringified JSON blob per station.
 *
 * Shape, as measured over the 9 807 stations: 8 453 carry the field, always with
 * all seven days. A day is either flagged closed (`@ferme`), or carries one
 * range, or two (split lunchtime), or none at all — and "none at all" is the
 * most common case by far, which is why {@link isOpenAt} answers with three
 * states rather than a boolean.
 */

import type { OpeningDay, OpeningHours, OpeningRange, Station, Weekday } from '../types.js';

interface RawHoursDay {
  '@id'?: unknown;
  '@nom'?: unknown;
  '@ferme'?: unknown;
  horaire?: unknown;
}

interface RawHours {
  '@automate-24-24'?: unknown;
  jour?: unknown;
}

interface RawRange {
  '@ouverture'?: unknown;
  '@fermeture'?: unknown;
}

const MINUTES_PER_DAY = 24 * 60;

/** `Intl` gives the only correct answer for "what time is it in France". */
const PARIS_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAYS: Readonly<Record<string, Weekday>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Parses the stringified blob. Returns `null` for anything unusable. */
export function parseOpeningHours(raw: string | null): OpeningHours | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const hours = parsed as RawHours;
  const rawDays = Array.isArray(hours.jour)
    ? (hours.jour as unknown[])
    : typeof hours.jour === 'object' && hours.jour !== null
      ? [hours.jour]
      : [];

  const days: OpeningDay[] = [];
  for (const [index, rawDay] of rawDays.entries()) {
    const day = toDay(rawDay, index);
    if (day !== null) days.push(day);
  }

  const automat24h = hours['@automate-24-24'] === '1';
  if (days.length === 0 && !automat24h) return null;

  return { automat24h, days };
}

/**
 * Whether the station is open at `when`, or `null` when the feed does not say.
 *
 * Timestamps are evaluated in `Europe/Paris`, since that is what the opening
 * hours are expressed in — a UTC reading would be an hour or two off.
 */
export function isOpenAt(station: Station, when: Date): boolean | null {
  const hours = station.openingHours;
  if (hours === null) return null;
  // An unattended pump answers for every hour of the week.
  if (hours.automat24h) return true;
  if (Number.isNaN(when.getTime())) return null;

  const local = toParisTime(when);
  if (local === null) return null;

  const day = hours.days.find((candidate) => candidate.weekday === local.weekday);
  if (day === undefined) return null;
  if (day.closed) return false;
  if (day.ranges.length === 0) return null;

  return day.ranges.some((range) => covers(range, local.minutes));
}

function covers(range: OpeningRange, minutes: number): boolean {
  const opens = toMinutes(range.opensAt);
  const closes = toMinutes(range.closesAt);
  if (opens === null || closes === null) return false;

  // 1 479 days come as `00.00-00.00`, which the feed means as "all day"; a
  // zero-length window would read as "never open", which it plainly is not.
  if (opens === closes) return true;
  if (closes > opens) return minutes >= opens && minutes < closes;
  // 36 ranges run past midnight, e.g. 22.00-06.00.
  return minutes >= opens || minutes < closes;
}

function toDay(rawDay: unknown, index: number): OpeningDay | null {
  if (typeof rawDay !== 'object' || rawDay === null) return null;

  const day = rawDay as RawHoursDay;
  const weekday = toWeekday(day['@id'], index);
  if (weekday === null) return null;

  // 5 839 days carry both a closed flag and a placeholder range; the flag wins.
  const closed = day['@ferme'] === '1';
  const ranges = closed ? [] : toRanges(day.horaire);

  return { weekday, closed, ranges };
}

function toRanges(raw: unknown): OpeningRange[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null ? [raw] : [];

  const ranges: OpeningRange[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    const range = entry as RawRange;
    const opensAt = toClock(range['@ouverture']);
    const closesAt = toClock(range['@fermeture']);
    if (opensAt !== null && closesAt !== null) ranges.push({ opensAt, closesAt });
  }
  return ranges;
}

function toWeekday(id: unknown, index: number): Weekday | null {
  const parsed = typeof id === 'string' ? Number.parseInt(id, 10) : NaN;
  const candidate = Number.isInteger(parsed) ? parsed : index + 1;

  return candidate >= 1 && candidate <= 7 ? (candidate as Weekday) : null;
}

/** `"08.30"` as the feed writes it, to `"08:30"`. */
function toClock(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const match = /^(\d{1,2})[.:](\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function toMinutes(clock: string): number | null {
  const [hour, minute] = clock.split(':');
  if (hour === undefined || minute === undefined) return null;

  const total = Number(hour) * 60 + Number(minute);
  return Number.isFinite(total) && total >= 0 && total <= MINUTES_PER_DAY ? total : null;
}

function toParisTime(when: Date): { weekday: Weekday; minutes: number } | null {
  let weekday: Weekday | undefined;
  let hour: number | undefined;
  let minute: number | undefined;

  for (const part of PARIS_TIME.formatToParts(when)) {
    if (part.type === 'weekday') weekday = WEEKDAYS[part.value];
    if (part.type === 'hour') hour = Number(part.value);
    if (part.type === 'minute') minute = Number(part.value);
  }

  if (weekday === undefined || hour === undefined || minute === undefined) return null;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  return { weekday, minutes: (hour % 24) * 60 + minute };
}
