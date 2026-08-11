/**
 * Development CLI: a way to poke every code path of the SDK by hand against the
 * live feed. Not part of the published package — it builds through
 * `tsdown.cli.config.ts` into the git-ignored `dist-cli/`, which the tarball
 * never sees.
 *
 *   npm run cli -- ask
 *   npm run cli -- nearby 48.1173 -1.6778 3000 --fuel gazole --open-now
 *   npm run cli -- stats gazole --department 35
 *   npm run cli -- find --city rennes --fuel e85 --sort price --limit 5
 *   npm run cli -- sync --cache .cache/stations.json
 */

/* eslint-disable no-console */

import { createInterface } from 'node:readline/promises';

import { createFileCache } from './cache.js';
import {
  createStyle,
  formatElapsed,
  formatFooter,
  formatMatches,
  shouldUseColour,
  type Style,
} from './cli-format.js';
import {
  centreOf,
  defaultAnswers,
  parsePlace,
  promptForAnswers,
  type Answers,
} from './cli-prompts.js';
import { FuelPricesError } from './errors.js';
import { FuelPricesClient, type FuelPricesOptions } from './fuel-prices.js';
import { FUEL_TYPES, type FuelType, type StationMatch, type StationQuery } from './types.js';

const USAGE = `fuel-prices — development CLI

Usage
  cli <command> [options]

Commands
  ask                       Interactive prompts, Enter accepts every default
  find                      Search with any combination of the options below
  nearby <lat> <lon> <m>    Stations within a radius, nearest first
  city <name>               Stations of a city
  cp <code>                 Stations of a postal code
  dept <code>               Stations of a département
  station <id>              One station, in full
  stats <fuel>              Price distribution of a fuel (accepts the filters)
  sync                      Load, then run an incremental sync and report both
  info                      Cache size, last sync, national medians

Filters (find, nearby, city, cp, dept, stats)
  --near <lat,lon>          Centre of a radius search
  --radius <metres>         Radius, with --near
  --city <name>             City, accent- and case-insensitive
  --cp <code>               Postal code
  --department <code>       Département INSEE code
  --fuel <a,b>              Fuels the station must sell
  --max-price <eur>         Price ceiling, needs exactly one --fuel
  --kind <road|highway>
  --open-now                Only stations the feed reports as open right now
  --open-at <iso>           Same, at a given instant
  --max-price-age <age>     Drop stale quotes: 90m, 12h, 7d, or plain ms
  --sort <distance|price|updatedAt>
  --limit <n>

Other
  --defaults                With "ask", take every default without prompting
  --cache <file>            Persist the snapshot, and hydrate from it
  --json                    Machine-readable output
  --no-color                Never colour, whatever the terminal says
  --help
`;

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    index += 1;
  }

  return { command: positionals.shift() ?? 'help', positionals, flags };
}

function text(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function number(flags: ParsedArgs['flags'], name: string): number | undefined {
  const raw = text(flags, name);
  if (raw === undefined) return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw fail(`--${name} expects a number, got "${raw}".`);
  return parsed;
}

function fuels(flags: ParsedArgs['flags']): FuelType[] | undefined {
  const raw = text(flags, 'fuel');
  if (raw === undefined) return undefined;

  return raw.split(',').map((candidate) => {
    const fuel = candidate.trim().toLowerCase();
    if (!(FUEL_TYPES as readonly string[]).includes(fuel)) {
      throw fail(`Unknown fuel "${candidate}". Pick from ${FUEL_TYPES.join(', ')}.`);
    }
    return fuel as FuelType;
  });
}

const DURATION_UNITS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** `7d`, `12h`, `90m`, `30s`, or a bare number already in milliseconds. */
function duration(raw: string, label: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd])?$/.exec(raw.trim());
  const amount = Number(match?.[1]);
  if (match === null || !Number.isFinite(amount)) {
    throw fail(`${label} expects a duration like 7d, 12h, 90m or a number of ms, got "${raw}".`);
  }

  const unit = match[2];
  return unit === undefined ? amount : amount * (DURATION_UNITS[unit] ?? 1);
}

function point(raw: string, label: string): { latitude: number; longitude: number } {
  const [latitude, longitude] = raw.split(',').map(Number);
  if (latitude === undefined || longitude === undefined) {
    throw fail(`${label} expects "lat,lon", got "${raw}".`);
  }
  return { latitude, longitude };
}

/** Turns the flags into a {@link StationQuery}; the SDK validates the rest. */
function toQuery(args: ParsedArgs): StationQuery {
  const { flags } = args;
  const near = text(flags, 'near');
  const openAt = text(flags, 'open-at');
  const fuelList = fuels(flags);

  // Built loosely, then handed to the SDK, which is the one that validates it.
  const query: Record<string, unknown> = {};
  if (near !== undefined) query.near = point(near, '--near');
  if (flags.has('radius')) query.radiusMeters = number(flags, 'radius');
  if (text(flags, 'city') !== undefined) query.city = text(flags, 'city');
  if (text(flags, 'cp') !== undefined) query.postalCode = text(flags, 'cp');
  if (text(flags, 'department') !== undefined) query.department = text(flags, 'department');
  if (fuelList !== undefined) query.fuel = fuelList;
  if (flags.has('max-price')) query.maxPrice = number(flags, 'max-price');
  if (text(flags, 'kind') !== undefined) query.kind = text(flags, 'kind');
  if (flags.get('open-now') === true) query.openAt = new Date();
  if (openAt !== undefined) query.openAt = new Date(openAt);
  const maxPriceAge = text(flags, 'max-price-age');
  if (maxPriceAge !== undefined) query.maxPriceAge = duration(maxPriceAge, '--max-price-age');
  if (text(flags, 'sort') !== undefined) query.sort = text(flags, 'sort');
  if (flags.has('limit')) query.limit = number(flags, 'limit');

  return query;
}

function clientOptions(args: ParsedArgs): FuelPricesOptions {
  const cachePath = text(args.flags, 'cache');
  return cachePath === undefined ? {} : cacheOptions(cachePath);
}

function cacheOptions(cachePath: string): FuelPricesOptions {
  return {
    cache: createFileCache(cachePath),
    onCacheError: (error) => console.error(`cache: ${error.message}`),
  };
}

interface PrintContext {
  style: Style;
  asJson: boolean;
  /** Fuel the results are sorted on, if any: its column is highlighted. */
  highlight: FuelType | undefined;
  elapsedMs: () => number;
}

/**
 * `stdout.columns` is undefined when the output is piped, where `COLUMNS` often
 * still is not — and `Number(undefined)` is NaN, which `??` would happily keep.
 */
function terminalWidth(): number {
  const fromEnv = Number(process.env.COLUMNS);
  return process.stdout.columns ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100);
}

/** The fuel worth highlighting: the sort key, or the only one asked for. */
function highlightOf(query: StationQuery): FuelType | undefined {
  const fuels = query.fuel === undefined ? [] : [query.fuel].flat();
  if (query.sort === 'price') return fuels[0];
  return fuels.length === 1 ? fuels[0] : undefined;
}

function fail(message: string): FuelPricesError {
  return new FuelPricesError(message, { code: 'invalid_argument' });
}

function printMatches(
  matches: StationMatch[],
  client: FuelPricesClient,
  context: PrintContext,
): void {
  if (context.asJson) {
    console.log(JSON.stringify(matches, null, 2));
    return;
  }

  const now = new Date();
  const lines = formatMatches(matches, {
    style: context.style,
    width: terminalWidth(),
    isOpen: (match) => client.isOpenAt(match.station, now),
    ...(context.highlight === undefined ? {} : { highlight: context.highlight }),
    now: now.getTime(),
  });

  for (const line of lines) console.log(line);
  if (matches.length > 0) {
    console.log(formatFooter(matches.length, client.size, context.elapsedMs(), context.style));
  }
}

/** Binds the question flow to the terminal. */
async function askInteractively(style: Style): Promise<Answers> {
  if (!process.stdin.isTTY) {
    throw fail('`ask` needs a terminal. Use `find` with flags when piping, or pass --defaults.');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptForAnswers((question) => rl.question(question), style);
  } finally {
    rl.close();
  }
}

/** Ctrl+C and Ctrl+D reach us as an AbortError; they mean "cancelled", not "crashed". */
function isCancellation(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'ExitPromptError')
  );
}

/**
 * Runs the query the answers describe. A city name is resolved against the
 * dataset itself — the centre of its stations — rather than a built-in gazetteer.
 */
async function runAnswers(
  answers: Answers,
  client: FuelPricesClient,
  context: PrintContext,
): Promise<number> {
  let near = parsePlace(answers.place);

  if (near === null) {
    const inCity = await client.findStations({ city: answers.place });
    const located = inCity.map((match) => match.station.location).filter((point) => point !== null);

    near = centreOf(located);
    if (near === null) {
      console.error(`No station found in "${answers.place}", so it cannot be used as a centre.`);
      return 1;
    }
    console.log(
      context.style.dim(
        `${answers.place}: ${String(inCity.length)} stations, centred on ` +
          `${near.latitude.toFixed(4)},${near.longitude.toFixed(4)}`,
      ),
    );
  }

  const query: StationQuery = {
    near,
    radiusMeters: answers.radiusMeters,
    ...(answers.fuels.length === 0 ? {} : { fuel: answers.fuels }),
    ...(answers.openNow ? { openAt: new Date() } : {}),
    ...(answers.maxPriceAge === undefined ? {} : { maxPriceAge: answers.maxPriceAge }),
    sort: answers.sort,
    limit: answers.limit,
  };

  printMatches(await client.findStations(query), client, {
    ...context,
    highlight: highlightOf(query),
  });
  return 0;
}

/**
 * Loads the dataset out loud. A cold read is a server-side export that has been
 * measured anywhere between 13 s and 73 s, which is far too long to spend in
 * silence; a cached one is instant and worth confirming too.
 */
async function reportLoad(
  client: FuelPricesClient,
  style: Style,
  cachePath: string | undefined,
): Promise<void> {
  const started = Date.now();
  console.log(
    style.dim(
      cachePath === undefined
        ? '\nReading the whole dataset (no cache; this can take a minute)…'
        : `\nReading the dataset (cache: ${cachePath})…`,
    ),
  );

  const result = await client.load();
  const elapsed = formatElapsed(Date.now() - started);
  const source =
    result.mode === 'cache' ? 'from the cache' : 'downloaded, and cached for next time';

  console.log(style.dim(`${String(client.size)} stations ${source} in ${elapsed}\n`));
}

async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const asJson = args.flags.get('json') === true;
  const style = createStyle(
    !asJson &&
      shouldUseColour(
        process.env,
        process.stdout.isTTY === true,
        args.flags.get('no-color') === true,
      ),
  );

  if (args.flags.get('help') === true || args.command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const started = Date.now();
  const printContext: PrintContext = {
    style,
    asJson,
    highlight: undefined,
    elapsedMs: () => Date.now() - started,
  };

  // `ask` builds its own client: the cache file is one of the questions.
  if (args.command === 'ask') {
    const answers =
      args.flags.get('defaults') === true
        ? defaultAnswers()
        : await askInteractively(style).catch((error: unknown) => {
            if (!isCancellation(error)) throw error;
            console.log('\nCancelled.');
            return null;
          });
    if (answers === null) return 0;

    const interactive = new FuelPricesClient(
      answers.cachePath === undefined ? {} : cacheOptions(answers.cachePath),
    );
    if (!asJson) await reportLoad(interactive, style, answers.cachePath);

    return runAnswers(answers, interactive, printContext);
  }

  const client = new FuelPricesClient(clientOptions(args));

  switch (args.command) {
    case 'find': {
      const query = toQuery(args);
      printMatches(await client.findStations(query), client, {
        ...printContext,
        highlight: highlightOf(query),
      });
      break;
    }

    case 'nearby': {
      const [latitude, longitude, radius] = args.positionals;
      if (latitude === undefined || longitude === undefined || radius === undefined) {
        throw fail('nearby expects <lat> <lon> <metres>.');
      }
      const query: StationQuery = {
        ...toQuery(args),
        near: { latitude: Number(latitude), longitude: Number(longitude) },
        radiusMeters: Number(radius),
      };
      printMatches(await client.findStations(query), client, {
        ...printContext,
        highlight: highlightOf(query),
      });
      break;
    }

    case 'city':
    case 'cp':
    case 'dept': {
      const value = args.positionals[0];
      if (value === undefined) throw fail(`${args.command} expects a value.`);

      const key =
        args.command === 'city' ? 'city' : args.command === 'cp' ? 'postalCode' : 'department';
      const query: StationQuery = { ...toQuery(args), [key]: value };
      printMatches(await client.findStations(query), client, {
        ...printContext,
        highlight: highlightOf(query),
      });
      break;
    }

    case 'station': {
      const id = args.positionals[0];
      if (id === undefined) throw fail('station expects an id.');

      const station = await client.getStation(id);
      if (station === undefined) {
        console.error(`No station with id ${id}.`);
        return 1;
      }
      console.log(JSON.stringify(station, null, 2));
      break;
    }

    case 'stats': {
      const [fuel] = args.positionals;
      if (fuel === undefined || !(FUEL_TYPES as readonly string[]).includes(fuel)) {
        throw fail(`stats expects a fuel among ${FUEL_TYPES.join(', ')}.`);
      }

      const stats = await client.getPriceStats(fuel as FuelType, toQuery(args));
      if (stats === null) {
        console.log('No station sells that fuel in the requested set.');
        return 1;
      }
      console.log(
        asJson
          ? JSON.stringify(stats, null, 2)
          : `${stats.fuel}: n=${String(stats.count)} min=${stats.min.toFixed(3)} ` +
              `median=${stats.median.toFixed(3)} mean=${stats.mean.toFixed(3)} ` +
              `max=${stats.max.toFixed(3)} (freshest ${stats.updatedAt ?? 'never'})`,
      );
      break;
    }

    case 'sync': {
      const first = await client.load();
      console.log(`load: ${first.mode}, ${String(first.total)} stations`);

      const delta = await client.sync();
      console.log(
        `sync: ${delta.mode} since ${delta.since ?? 'n/a'} — ` +
          `${String(delta.fetched)} fetched, ${String(delta.added)} added, ` +
          `${String(delta.updated)} updated, ${String(delta.unchanged)} unchanged`,
      );
      break;
    }

    case 'info': {
      const result = await client.load();
      console.log(`mode: ${result.mode}`);
      console.log(`stations: ${String(client.size)}`);
      console.log(`last sync: ${client.lastSyncedAt?.toISOString() ?? 'never'}`);

      for (const fuel of FUEL_TYPES) {
        const stats = await client.getPriceStats(fuel);
        console.log(
          stats === null
            ? `  ${fuel}: not sold anywhere`
            : `  ${fuel}: n=${String(stats.count)} median=${stats.median.toFixed(3)}`,
        );
      }
      break;
    }

    default:
      console.error(`Unknown command "${args.command}".\n`);
      console.log(USAGE);
      return 1;
  }

  return 0;
}

// `.then` rather than top-level await, so the CJS build stays valid.
void run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      error instanceof FuelPricesError ? `${error.code}: ${error.message}` : String(error),
    );
    process.exitCode = 1;
  },
);
