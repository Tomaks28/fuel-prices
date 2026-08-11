/**
 * Interactive question flow of the development CLI.
 *
 * The questions are asked through an injected {@link Ask}, so the whole flow is
 * exercised by tests with a scripted answerer and no terminal in sight; only
 * `cli.ts` binds it to `node:readline`.
 */

import { FuelPricesError } from './errors.js';
import { FUEL_TYPES, type FuelType, type GeoPoint, type StationSort } from './types.js';

/** Asks one question and resolves to the raw answer, empty meaning "default". */
export type Ask = (question: string) => Promise<string>;

/** Centre of Paris, the default search area. */
export const PARIS: GeoPoint = { latitude: 48.8566, longitude: 2.3522 };

export const PROMPT_DEFAULTS = {
  place: 'Paris',
  radiusMeters: 20_000,
  fuels: [] as readonly FuelType[],
  openNow: false,
  maxPriceAge: 7 * 24 * 60 * 60 * 1000,
  sort: 'distance' as StationSort,
  limit: 10,
  cachePath: '.cache/fuel-prices.json',
} as const;

export interface Answers {
  /** Either `lat,lon` or a city name, resolved once the dataset is loaded. */
  place: string;
  radiusMeters: number;
  fuels: FuelType[];
  openNow: boolean;
  maxPriceAge: number | undefined;
  sort: StationSort;
  limit: number;
  cachePath: string | undefined;
}

const SORTS: readonly StationSort[] = ['distance', 'price', 'updatedAt'];

/** Every default, for `--defaults` and as the fallback of each question. */
export function defaultAnswers(): Answers {
  return {
    place: PROMPT_DEFAULTS.place,
    radiusMeters: PROMPT_DEFAULTS.radiusMeters,
    fuels: [...PROMPT_DEFAULTS.fuels],
    openNow: PROMPT_DEFAULTS.openNow,
    maxPriceAge: PROMPT_DEFAULTS.maxPriceAge,
    sort: PROMPT_DEFAULTS.sort,
    limit: PROMPT_DEFAULTS.limit,
    cachePath: PROMPT_DEFAULTS.cachePath,
  };
}

/**
 * Walks the questions in order. An empty answer keeps the default, so pressing
 * Enter through the whole flow searches 20 km around Paris.
 */
export async function promptForAnswers(ask: Ask): Promise<Answers> {
  const answers = defaultAnswers();

  answers.place = await askText(ask, 'Where? "lat,lon" or a city name', answers.place);
  answers.radiusMeters = await askNumber(ask, 'Radius in metres', answers.radiusMeters);
  answers.fuels = await askFuels(ask, 'Fuel(s), comma separated', 'any');
  answers.openNow = await askYesNo(ask, 'Only stations open right now?', answers.openNow);
  answers.maxPriceAge = await askAge(ask, 'Ignore quotes older than', answers.maxPriceAge);
  answers.sort = await askSort(ask, 'Sort by', answers.sort);
  answers.limit = await askNumber(ask, 'How many results', answers.limit);
  answers.cachePath = await askCache(ask, 'Cache file ("none" to disable)', answers.cachePath);

  return answers;
}

/** `"48.85,2.35"` as a point, or `null` when it reads as a city name. */
export function parsePlace(raw: string): GeoPoint | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (match === null) return null;

  return { latitude: Number(match[1]), longitude: Number(match[2]) };
}

/** `7d`, `12h`, `90m`, `30s`, a bare number of ms, or `none`. */
export function parseAge(raw: string): number | undefined {
  if (isNone(raw)) return undefined;

  const match = /^\s*(\d+(?:\.\d+)?)\s*([smhd])?\s*$/i.exec(raw);
  const amount = Number(match?.[1]);
  if (match === null || !Number.isFinite(amount)) {
    throw invalid(
      `Expected a duration like 7d, 12h, 90m, a number of ms, or "none". Got "${raw}".`,
    );
  }

  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const unit = match[2]?.toLowerCase();
  return unit === undefined ? amount : amount * (units[unit] ?? 1);
}

export function parseFuels(raw: string): FuelType[] {
  if (isNone(raw) || raw.trim() === '' || raw.trim().toLowerCase() === 'any') return [];

  return raw.split(',').map((candidate) => {
    const fuel = candidate.trim().toLowerCase();
    if (!(FUEL_TYPES as readonly string[]).includes(fuel)) {
      throw invalid(`Unknown fuel "${candidate.trim()}". Pick from ${FUEL_TYPES.join(', ')}.`);
    }
    return fuel as FuelType;
  });
}

/** The mean position of a set of located stations, for a city-name answer. */
export function centreOf(points: readonly GeoPoint[]): GeoPoint | null {
  if (points.length === 0) return null;

  const total = points.reduce(
    (sum, point) => ({
      latitude: sum.latitude + point.latitude,
      longitude: sum.longitude + point.longitude,
    }),
    { latitude: 0, longitude: 0 },
  );

  return {
    latitude: total.latitude / points.length,
    longitude: total.longitude / points.length,
  };
}

async function askText(ask: Ask, question: string, fallback: string): Promise<string> {
  const answer = (await ask(`${question} [${fallback}]: `)).trim();
  return answer === '' ? fallback : answer;
}

async function askNumber(ask: Ask, question: string, fallback: number): Promise<number> {
  const answer = await askText(ask, question, String(fallback));

  const parsed = Number(answer);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw invalid(`Expected a positive number, got "${answer}".`);
  }
  return parsed;
}

async function askYesNo(ask: Ask, question: string, fallback: boolean): Promise<boolean> {
  const answer = (await askText(ask, question, fallback ? 'y' : 'n')).toLowerCase();
  if (['y', 'yes', 'o', 'oui', 'true'].includes(answer)) return true;
  if (['n', 'no', 'non', 'false'].includes(answer)) return false;

  throw invalid(`Expected yes or no, got "${answer}".`);
}

async function askFuels(ask: Ask, question: string, fallback: string): Promise<FuelType[]> {
  return parseFuels(await askText(ask, `${question} (${FUEL_TYPES.join(', ')})`, fallback));
}

async function askAge(
  ask: Ask,
  question: string,
  fallback: number | undefined,
): Promise<number | undefined> {
  const label = fallback === undefined ? 'none' : `${String(fallback / 86_400_000)}d`;
  return parseAge(await askText(ask, question, label));
}

async function askSort(ask: Ask, question: string, fallback: StationSort): Promise<StationSort> {
  const answer = await askText(ask, `${question} (${SORTS.join(', ')})`, fallback);
  if (!(SORTS as readonly string[]).includes(answer)) {
    throw invalid(`Expected one of ${SORTS.join(', ')}, got "${answer}".`);
  }
  return answer as StationSort;
}

async function askCache(
  ask: Ask,
  question: string,
  fallback: string | undefined,
): Promise<string | undefined> {
  const answer = await askText(ask, question, fallback ?? 'none');
  return isNone(answer) ? undefined : answer;
}

function isNone(raw: string): boolean {
  return ['none', 'no', 'off', '-'].includes(raw.trim().toLowerCase());
}

function invalid(message: string): FuelPricesError {
  return new FuelPricesError(message, { code: 'invalid_argument' });
}
