/**
 * Terminal rendering for the development CLI.
 *
 * Everything here is pure: styling is resolved once into a {@link Style} object
 * that either wraps text in ANSI codes or hands it back untouched, so the same
 * code renders a colourful terminal and a clean pipe, and tests can assert on
 * either.
 */

import { FUEL_TYPES, type FuelType, type StationMatch } from './types.js';

/** One styling function per colour; identity when colour is off. */
export interface Style {
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  cyan: (text: string) => string;
}

const CODES = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
} as const;

const IDENTITY = (text: string): string => text;

/** A day, and the two thresholds at which a quote stops being trustworthy. */
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 7 * DAY_MS;
const VERY_STALE_MS = 30 * DAY_MS;

const MIN_PLACE_WIDTH = 16;
const PRICE_WIDTH = 6;
/** Fits `TotalEnergies`, the longest name the sanitizer produces. */
const BRAND_WIDTH = 13;
const NO_VALUE = '—';

export function createStyle(enabled: boolean): Style {
  if (!enabled) {
    return {
      bold: IDENTITY,
      dim: IDENTITY,
      red: IDENTITY,
      green: IDENTITY,
      yellow: IDENTITY,
      cyan: IDENTITY,
    };
  }

  const wrap =
    (code: string) =>
    (text: string): string =>
      `\u001b[${code}m${text}\u001b[0m`;

  return {
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    yellow: wrap(CODES.yellow),
    cyan: wrap(CODES.cyan),
  };
}

/**
 * Whether to colour at all: never when piped, and `NO_COLOR` wins over
 * everything, as <https://no-color.org> asks.
 */
export function shouldUseColour(
  env: NodeJS.ProcessEnv,
  isTty: boolean,
  disabled: boolean,
): boolean {
  if (disabled) return false;
  // https://no-color.org — any non-empty value means "do not colour".
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return isTty;
}

export interface TableOptions {
  style: Style;
  /** Terminal width to fit into. */
  width: number;
  /** Answers `null` when the feed does not say. */
  isOpen: (match: StationMatch) => boolean | null;
  /** Fuel the results are sorted on, highlighted in its column. */
  highlight?: FuelType | undefined;
  /**
   * Show the brand column even when nothing in the result set has one — which is
   * what tells a caller who asked for brands that the lookup came back empty,
   * rather than leaving them with a column that silently never appeared.
   *
   * Left unset, the column shows only when there is a brand to put in it.
   */
  brands?: boolean | undefined;
  /** Reference instant for the age column. */
  now?: number;
}

/** Renders the matches as one aligned row each. Returns the lines to print. */
export function formatMatches(matches: readonly StationMatch[], options: TableOptions): string[] {
  const { style } = options;
  if (matches.length === 0) return [style.yellow('No station matched.')];

  const fuels = fuelsPresent(matches, options.highlight);
  const cheapest = cheapestPerFuel(matches, fuels);
  const now = options.now ?? Date.now();

  const hasDistance = matches.some((match) => match.distanceMeters !== null);
  // Without a brand source the column would be dashes all the way down, so it
  // only exists once one is in play — asked for, or having produced something.
  const hasBrand = options.brands === true || matches.some((match) => match.station.brand !== null);
  const fixed =
    4 +
    (hasDistance ? 9 : 0) +
    (hasBrand ? BRAND_WIDTH + 1 : 0) +
    fuels.length * (PRICE_WIDTH + 1) +
    6 +
    9 +
    11;
  const placeWidth = Math.max(MIN_PLACE_WIDTH, options.width - fixed);

  const header = [
    pad('#', 3),
    ...(hasDistance ? [padStart('DIST', 8)] : []),
    ...(hasBrand ? [pad('BRAND', BRAND_WIDTH)] : []),
    pad('PLACE', placeWidth),
    ...fuels.map((fuel) => padStart(fuel.toUpperCase(), PRICE_WIDTH)),
    padStart('AGE', 5),
    pad('STATUS', 8),
    'ID',
  ].join(' ');

  const rows = matches.map((match, index) => {
    const { station } = match;
    const address = station.address === '' ? '' : ` · ${station.address}`;
    const place = `${station.city} ${station.postalCode}${address}`;

    return [
      style.dim(pad(`${String(index + 1)}.`, 3)),
      ...(hasDistance ? [padStart(formatDistance(match.distanceMeters), 8)] : []),
      ...(hasBrand ? [formatBrand(station.brand, style)] : []),
      pad(truncate(place, placeWidth), placeWidth),
      ...fuels.map((fuel) => formatPrice(match, fuel, cheapest.get(fuel), options)),
      formatAge(station.updatedAt, now, style),
      formatStatus(options.isOpen(match), style),
      style.dim(station.id),
    ].join(' ');
  });

  return [style.bold(header), ...rows];
}

/** `10 station(s), out of 9 807 cached` and the like. */
export function formatFooter(
  shown: number,
  cached: number,
  elapsedMs: number,
  style: Style,
): string {
  const total = cached.toLocaleString('en-GB').replaceAll(',', ' ');
  return style.dim(`\n${String(shown)} of ${total} cached stations · ${formatElapsed(elapsedMs)}`);
}

function formatPrice(
  match: StationMatch,
  fuel: FuelType,
  cheapest: number | undefined,
  options: TableOptions,
): string {
  const price = match.station.prices[fuel];
  if (price === undefined) return options.style.dim(padStart(NO_VALUE, PRICE_WIDTH));

  const text = padStart(price.price.toFixed(3), PRICE_WIDTH);
  const isCheapest = cheapest !== undefined && price.price === cheapest;
  const highlighted = fuel === options.highlight;

  if (isCheapest && highlighted) return options.style.green(options.style.bold(text));
  if (isCheapest) return options.style.green(text);
  return highlighted ? options.style.bold(text) : text;
}

function formatBrand(brand: string | null, style: Style): string {
  if (brand === null) return style.dim(pad(NO_VALUE, BRAND_WIDTH));
  return style.cyan(pad(truncate(brand, BRAND_WIDTH), BRAND_WIDTH));
}

function formatDistance(meters: number | null): string {
  if (meters === null) return '';
  return meters < 1000 ? `${String(Math.round(meters))} m` : `${(meters / 1000).toFixed(1)} km`;
}

function formatAge(updatedAt: string | null, now: number, style: Style): string {
  if (updatedAt === null) return style.dim(padStart(NO_VALUE, 5));

  const age = now - Date.parse(updatedAt);
  const text = padStart(
    age < 2 * DAY_MS
      ? `${String(Math.round(age / 3_600_000))}h`
      : `${String(Math.round(age / DAY_MS))}d`,
    5,
  );

  if (age > VERY_STALE_MS) return style.red(text);
  if (age > STALE_MS) return style.yellow(text);
  return style.dim(text);
}

function formatStatus(open: boolean | null, style: Style): string {
  if (open === null) return style.dim(pad('unknown', 8));
  return open ? style.green(pad('open', 8)) : style.red(pad('closed', 8));
}

/** `47 ms` under a second, `13.3 s` over. */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Only the fuels somebody in the result set actually sells, sorted usefully. */
function fuelsPresent(
  matches: readonly StationMatch[],
  highlight: FuelType | undefined,
): FuelType[] {
  const present = FUEL_TYPES.filter((fuel) =>
    matches.some((match) => match.station.prices[fuel] !== undefined),
  );
  if (highlight === undefined || !present.includes(highlight)) return present;

  return [highlight, ...present.filter((fuel) => fuel !== highlight)];
}

function cheapestPerFuel(
  matches: readonly StationMatch[],
  fuels: readonly FuelType[],
): Map<FuelType, number> {
  const cheapest = new Map<FuelType, number>();

  for (const fuel of fuels) {
    for (const match of matches) {
      const price = match.station.prices[fuel]?.price;
      if (price === undefined) continue;

      const best = cheapest.get(fuel);
      if (best === undefined || price < best) cheapest.set(fuel, price);
    }
  }
  return cheapest;
}

export function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

function padStart(text: string, width: number): string {
  return text.padStart(width);
}
