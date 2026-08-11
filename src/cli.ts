/**
 * Development CLI: a way to poke every code path of the SDK by hand against the
 * live feed. Not part of the published package — it builds through
 * `tsdown.cli.config.ts` into the git-ignored `dist-cli/`, which the tarball
 * never sees.
 *
 *   npm run cli -- nearby 48.1173 -1.6778 3000 --fuel gazole --open-now
 *   npm run cli -- stats gazole --department 35
 *   npm run cli -- find --city rennes --fuel e85 --sort price --limit 5
 *   npm run cli -- sync --cache .cache/stations.json
 */

/* eslint-disable no-console */

import { createFileCache } from './cache.js';
import { FuelPricesError } from './errors.js';
import { FuelPricesClient, type FuelPricesOptions } from './fuel-prices.js';
import { FUEL_TYPES, type FuelType, type StationMatch, type StationQuery } from './types.js';

const USAGE = `fuel-prices — development CLI

Usage
  cli <command> [options]

Commands
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
  --sort <distance|price|updatedAt>
  --limit <n>

Other
  --cache <file>            Persist the snapshot, and hydrate from it
  --json                    Machine-readable output
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
  if (text(flags, 'sort') !== undefined) query.sort = text(flags, 'sort');
  if (flags.has('limit')) query.limit = number(flags, 'limit');

  return query;
}

function clientOptions(args: ParsedArgs): FuelPricesOptions {
  const cachePath = text(args.flags, 'cache');
  if (cachePath === undefined) return {};

  return {
    cache: createFileCache(cachePath),
    onCacheError: (error) => console.error(`cache: ${error.message}`),
  };
}

function fail(message: string): FuelPricesError {
  return new FuelPricesError(message, { code: 'invalid_argument' });
}

function formatPrices(match: StationMatch): string {
  const prices = FUEL_TYPES.map((fuel) => {
    const price = match.station.prices[fuel];
    return price === undefined ? null : `${fuel}=${price.price.toFixed(3)}`;
  }).filter((entry) => entry !== null);

  return prices.length === 0 ? 'no price' : prices.join(' ');
}

function printMatches(matches: StationMatch[], client: FuelPricesClient, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(matches, null, 2));
    return;
  }

  if (matches.length === 0) {
    console.log('No station matched.');
    return;
  }

  const now = new Date();
  for (const match of matches) {
    const { station } = match;
    const distance =
      match.distanceMeters === null ? '' : `${String(Math.round(match.distanceMeters))} m  `;
    const open = client.isOpenAt(station, now);
    const openLabel = open === null ? 'hours unknown' : open ? 'open' : 'closed';

    console.log(
      `${distance}${station.city} ${station.postalCode} [${station.id}] ${station.kind}, ${openLabel}`,
    );
    console.log(`    ${formatPrices(match)}`);
    console.log(`    ${station.address}  (updated ${station.updatedAt ?? 'never'})`);
  }
  console.log(`\n${String(matches.length)} station(s), out of ${String(client.size)} cached.`);
}

async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const asJson = args.flags.get('json') === true;

  if (args.flags.get('help') === true || args.command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const client = new FuelPricesClient(clientOptions(args));
  const started = Date.now();

  switch (args.command) {
    case 'find': {
      printMatches(await client.findStations(toQuery(args)), client, asJson);
      break;
    }

    case 'nearby': {
      const [latitude, longitude, radius] = args.positionals;
      if (latitude === undefined || longitude === undefined || radius === undefined) {
        throw fail('nearby expects <lat> <lon> <metres>.');
      }
      const matches = await client.findStations({
        ...toQuery(args),
        near: { latitude: Number(latitude), longitude: Number(longitude) },
        radiusMeters: Number(radius),
      });
      printMatches(matches, client, asJson);
      break;
    }

    case 'city':
    case 'cp':
    case 'dept': {
      const value = args.positionals[0];
      if (value === undefined) throw fail(`${args.command} expects a value.`);

      const key =
        args.command === 'city' ? 'city' : args.command === 'cp' ? 'postalCode' : 'department';
      printMatches(await client.findStations({ ...toQuery(args), [key]: value }), client, asJson);
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

  if (!asJson) console.log(`(${String(Date.now() - started)} ms)`);
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
