/**
 * Interactive question flow of the development CLI.
 *
 * The questions are asked through an injected {@link Ask}, so the whole flow is
 * exercised by tests with a scripted answerer and no terminal in sight; only
 * `cli.ts` binds it to `node:readline`.
 */

import { createStyle, type Style } from './cli-format.js';
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
export async function promptForAnswers(
  ask: Ask,
  style: Style = createStyle(false),
): Promise<Answers> {
  const answers = defaultAnswers();
  const prompt: Prompter = { ask, style };

  answers.place = await askText(prompt, 'Where? "lat,lon" or a city name', answers.place);
  answers.radiusMeters = await askNumber(prompt, 'Radius in metres', answers.radiusMeters);
  answers.fuels = await askFuels(prompt, 'Fuel(s), comma separated', 'any');
  answers.openNow = await askYesNo(prompt, 'Only stations open right now?', answers.openNow);
  answers.maxPriceAge = await askAge(prompt, 'Ignore quotes older than', answers.maxPriceAge);
  answers.sort = await askSort(prompt, 'Sort by', answers.sort);
  answers.limit = await askNumber(prompt, 'How many results', answers.limit);
  answers.cachePath = await askCache(prompt, 'Cache file', answers.cachePath);

  return answers;
}

/** What a question needs: somewhere to ask, and how to paint. */
interface Prompter {
  ask: Ask;
  style: Style;
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

/**
 * Assembles one question: the hint dim, the default cyan between brackets, so
 * the eye lands on what pressing Enter would choose.
 *
 * Built from parts on purpose — painting the finished string with a regex ate
 * the `(s)` of "Fuel(s)" and then matched inside its own escape sequences.
 */
async function askText(
  prompt: Prompter,
  question: string,
  fallback: string,
  hint?: string,
): Promise<string> {
  const { style } = prompt;
  const painted = hint === undefined ? question : `${question} ${style.dim(`(${hint})`)}`;
  const answer = (await prompt.ask(`${painted} [${style.cyan(fallback)}]: `)).trim();

  return answer === '' ? fallback : answer;
}

async function askNumber(prompt: Prompter, question: string, fallback: number): Promise<number> {
  const answer = await askText(prompt, question, String(fallback));

  const parsed = Number(answer);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw invalid(`Expected a positive number, got "${answer}".`);
  }
  return parsed;
}

async function askYesNo(prompt: Prompter, question: string, fallback: boolean): Promise<boolean> {
  const answer = (await askText(prompt, question, fallback ? 'y' : 'n')).toLowerCase();
  if (['y', 'yes', 'o', 'oui', 'true'].includes(answer)) return true;
  if (['n', 'no', 'non', 'false'].includes(answer)) return false;

  throw invalid(`Expected yes or no, got "${answer}".`);
}

async function askFuels(prompt: Prompter, question: string, fallback: string): Promise<FuelType[]> {
  return parseFuels(await askText(prompt, question, fallback, FUEL_TYPES.join(', ')));
}

async function askAge(
  prompt: Prompter,
  question: string,
  fallback: number | undefined,
): Promise<number | undefined> {
  const label = fallback === undefined ? 'none' : `${String(fallback / 86_400_000)}d`;
  return parseAge(await askText(prompt, question, label, '7d, 12h, 90m, or none'));
}

async function askSort(
  prompt: Prompter,
  question: string,
  fallback: StationSort,
): Promise<StationSort> {
  const answer = await askText(prompt, question, fallback, SORTS.join(', '));
  if (!(SORTS as readonly string[]).includes(answer)) {
    throw invalid(`Expected one of ${SORTS.join(', ')}, got "${answer}".`);
  }
  return answer as StationSort;
}

async function askCache(
  prompt: Prompter,
  question: string,
  fallback: string | undefined,
): Promise<string | undefined> {
  const answer = await askText(prompt, question, fallback ?? 'none', '"none" to disable');
  return isNone(answer) ? undefined : answer;
}

function isNone(raw: string): boolean {
  return ['none', 'no', 'off', '-'].includes(raw.trim().toLowerCase());
}

function invalid(message: string): FuelPricesError {
  return new FuelPricesError(message, { code: 'invalid_argument' });
}
