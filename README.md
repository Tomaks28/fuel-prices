# @tomaks28/fuel-prices

TypeScript SDK returning fuel prices of French gas stations, backed by the official open data
feed published on [data.economie.gouv.fr][dataset] (~9 800 stations, no API key required).

## Install

```sh
npm install @tomaks28/fuel-prices
```

Requires Node.js >= 18 (uses the global `fetch`). Ships both ESM and CJS builds with type
declarations.

## Usage

The SDK keeps one in-memory snapshot of the dataset behind a shared client, so a process reads
the ~9 800 stations once and then serves lookups locally.

```ts
import { getFuelPricesClient } from '@tomaks28/fuel-prices';

const fuelPrices = getFuelPricesClient(); // shared instance, created on first call

// Initial load — idempotent, and implied by every getter below.
await fuelPrices.load();

const stations = await fuelPrices.getStationsByCity('saint-malo');
console.log(stations[0]?.prices.gazole); // { fuel: 'gazole', price: 2.11, updatedAt: '…Z' }

// Later on: fetch only the prices that moved since the last sync.
const delta = await fuelPrices.sync();
console.log(delta.updated, 'stations updated', delta.stations);
```

`getFuelPricesClient()` and `FuelPricesClient.getInstance()` return the same instance; options
only apply to the call that creates it. `new FuelPricesClient(options)` gives an isolated
instance (per-tenant caches, tests), and `resetFuelPricesClient()` drops the shared one.

### Reading the cache

Every getter awaits the initial load, so calling `load()` yourself is optional.

| Method                          | Returns                                             |
| ------------------------------- | --------------------------------------------------- |
| `getStations()`                 | Every cached station                                |
| `getStation(id)`                | One station by dataset id                           |
| `getStationsByCity(city)`       | Case-, accent- and separator-insensitive city match |
| `getStationsByPostalCode(code)` | Stations of a postal code                           |
| `getStationsByDepartment(code)` | Stations of a département (INSEE code)              |
| `getStationsByFuel(fuel)`       | Stations selling that fuel, cheapest first          |
| `getStationsNearby(point, m)`   | Stations within a radius in metres, nearest first   |
| `getStationsUpdatedSince(date)` | Cached stations whose price moved after `date`      |
| `findStations(query)`           | Every criterion below at once                       |
| `getPriceStats(fuel, query?)`   | Price distribution over the matching stations       |
| `isOpenAt(station, date)`       | `true`, `false`, or `null` when the feed is silent  |

City names are not INSEE-coded upstream, so homonyms share a bucket — filter on `postalCode`
when that matters. Lookups are served from indexes rebuilt on demand after a sync.

### Composable search

The getters above answer one question each. `findStations` answers the ones that
cross them — "the cheapest E85 within 10 km, open right now":

```ts
const [cheapest] = await fuelPrices.findStations({
  near: { latitude: 48.1173, longitude: -1.6778 },
  radiusMeters: 10_000,
  fuel: 'e85',
  openAt: new Date(),
  sort: 'price',
  limit: 1,
});

console.log(cheapest?.station.city, cheapest?.station.prices.e85?.price, cheapest?.distanceMeters);
```

| Criterion                            | Effect                                               |
| ------------------------------------ | ---------------------------------------------------- |
| `near` + `radiusMeters`              | Radius search, inclusive; both are required together |
| `city` / `postalCode` / `department` | Place filters, city matching as above                |
| `fuel`                               | One fuel, or a list the station must sell all of     |
| `maxPrice`                           | Price ceiling; needs exactly one `fuel`              |
| `kind`                               | `road` or `highway`                                  |
| `openAt`                             | Stations the feed reports as open at that instant    |
| `sort`                               | `distance`, `price` or `updatedAt`                   |
| `limit`                              | Caps the result set                                  |

Criteria are ANDed, an empty query returns everything, and each match carries
`distanceMeters` when the query had a centre. The whole thing runs against the
in-memory snapshot — no request once it is warm. Contradictory queries throw
`invalid_argument` **before** the dataset is loaded, so a typo costs nothing.

### Price statistics

A single price means little: gazole spans 1.244 to 2.800 nationally. `getPriceStats`
puts one in context, over the whole country or over whatever the same query narrows
it to.

```ts
const national = await fuelPrices.getPriceStats('gazole');
const local = await fuelPrices.getPriceStats('gazole', { department: '35' });
// { fuel: 'gazole', count: 145, min: 2.049, median: 2.105, mean: 2.135, max: 2.453, updatedAt }
```

It returns `null` — not a row of zeroes — when nothing in the set sells that fuel.

### Opening hours

`station.openingHours` holds the weekly schedule the station publishes, and
`isOpenAt` reads it in `Europe/Paris`, which is what the hours are expressed in.

```ts
fuelPrices.isOpenAt(station, new Date()); // true | false | null
```

**`null` is not a "no".** Of the 9 807 stations, 1 354 publish no schedule at all,
and roughly half of the day entries in the rest carry neither hours nor a closed
flag. `null` means the feed does not say. `findStations({ openAt })` keeps only
the stations it can positively vouch for, so those drop out of the results.

Unattended 24/7 pumps (`openingHours.automat24h`) count as open at every hour.

### Searching around a point

```ts
const found = await fuelPrices.getStationsNearby({ latitude: 48.1173, longitude: -1.6778 }, 3000);

for (const { station, distanceMeters } of found) {
  console.log(Math.round(distanceMeters), station.city, station.prices.gazole?.price);
}
// 1105 Rennes 2.091
// 1923 Rennes 2.213 …
```

The radius is in **metres** and inclusive, results come back nearest first, and
`distanceMeters` is the unrounded great-circle (haversine) distance from the point you passed.
A spherical Earth is off by up to ~0.5 % against WGS 84 — well under the precision of the
coordinates the feed publishes, and monotonic, so it never reorders two stations. Stations the
dataset gave no coordinates for cannot match and are left out. The scan is linear over the
in-memory snapshot; no request is made once the cache is warm.

### Keeping it fresh

| Method      | Requests                                              | Cost                          |
| ----------- | ----------------------------------------------------- | ----------------------------- |
| `load()`    | Whole dataset, once (no-op if already loaded)         | ~2 MB, 10–20 s server-side    |
| `refresh()` | Whole dataset, unconditionally                        | same                          |
| `sync()`    | Only stations whose price changed since the last sync | usually a few hundred records |

`sync()` filters upstream on the per-fuel `_maj` timestamps, minus a 5-minute overlap
(`syncOverlapMs`) covering the portal's own cache window. It therefore catches price changes,
but not stations added to or removed from the dataset without one — run `refresh()` on a slower
cadence (daily is plenty) for those. Concurrent syncs are serialised, and a failed one leaves
the cache untouched.

Each call reports what it did:

```ts
const result = await fuelPrices.sync();
// { mode: 'incremental', since, syncedAt, fetched, added, updated, unchanged, removed, total, stations }
```

### Persisting between runs

A cold start reads ~2 MB and takes 10-20 s server-side. Point the client at a
`CacheStore` and a restarted process hydrates from disk instead, then asks only
for the delta:

```ts
import { createFileCache, FuelPricesClient } from '@tomaks28/fuel-prices';

const fuelPrices = new FuelPricesClient({
  cache: createFileCache('.cache/fuel-prices.json'),
  cacheMaxAgeMs: 24 * 60 * 60 * 1000, // older than this, the snapshot is ignored
  onCacheError: (error) => logger.warn(error),
});

await fuelPrices.load(); // { mode: 'cache' } on a hit — no request at all
await fuelPrices.sync(); // delta since the *persisted* sync time
```

Measured on the real feed: **13.3 s cold, 61 ms warm.** The snapshot file is
around 13 MB of JSON.

The file cache writes to a temporary sibling and renames it into place, so a
process killed mid-write leaves the previous snapshot intact. A missing,
truncated, foreign or out-of-date file is a cache miss, not an error. Writes that
fail never fail a sync — they surface through `onCacheError` and nowhere else, so
pass one if you care.

`CacheStore` is a two-method interface (`read`, `write`, plus an optional
`clear`), so Redis or a shared volume plugs in the same way; `createFileCache`
is just the implementation that ships. `node:fs` is imported dynamically, so the
SDK carries no static filesystem dependency.

### Options and errors

```ts
const client = new FuelPricesClient({
  timeoutMs: 60_000, // per attempt
  retries: 2, // retried on 408/425/429/5xx and network failures, honouring Retry-After
  syncOverlapMs: 5 * 60 * 1000,
  cache: createFileCache('.cache/fuel-prices.json'),
  cacheMaxAgeMs: 24 * 60 * 60 * 1000,
  onCacheError: (error) => logger.warn(error),
  fetch: myFetch, // stub or instrument the transport
  baseUrl,
  dataset, // point at another Opendatasoft portal
});
```

Everything throws `FuelPricesError`, carrying a `code` (`http`, `network`, `timeout`, `aborted`,
`invalid_response`, `invalid_argument`, `cache`, `unsupported`) plus `status` / `apiCode` when the
failure came from the API. All network methods accept an `AbortSignal`.

Out of scope: price history and trends. The portal publishes no such dataset —
`prix-carburants-quotidien` is a daily snapshot in long format, not an archive — so trends would
mean accumulating snapshots yourself.

## Development

The toolchain version is pinned in [`.nvmrc`](./.nvmrc) and CI reads it from there, so `nvm use`
is enough to match it. Node >= 24.15 is the real floor for contributors (tsdown and the
semantic-release plugins), even though the published package supports Node >= 18 — which the
`compat` CI job verifies on every run.

```sh
npm run check   # typecheck + lint + format check + tests
npm run build   # dual ESM/CJS bundle into dist/
```

| Script               | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `build`              | Bundle ESM + CJS + `.d.ts` via tsdown              |
| `build:verify`       | Build, then gate on `publint` + `arethetypeswrong` |
| `typecheck`          | `tsc --noEmit` (strict, type-aware)                |
| `lint` / `lint:fix`  | ESLint flat config, type-aware rules               |
| `format` / `:check`  | Prettier                                           |
| `test` / `:coverage` | Jest suite, `lcov` report into `coverage/`         |
| `cli`                | Development CLI against the live feed              |
| `check`              | All of the above, in the order CI runs them        |

### Development CLI

A hand-driving harness for every code path, against the real feed. It is **not**
published: it builds through [`tsdown.cli.config.ts`](./tsdown.cli.config.ts) into
the git-ignored `dist-cli/`, and the tarball ships `dist/` only.

```sh
npm run cli -- --help
npm run cli -- nearby 48.1173 -1.6778 3000 --fuel gazole --sort price --limit 3
npm run cli -- find --city rennes --fuel e85 --open-now --cache .cache/stations.json
npm run cli -- stats gazole --department 35
npm run cli -- sync --cache .cache/stations.json
npm run cli -- info
```

Every command takes the `findStations` filters, plus `--cache <file>` to exercise
persistence and `--json` for raw output. Pass `--cache` twice in a row to feel the
difference the snapshot makes.

### Tests

Suites sit next to the code they cover (`src/**/*.test.ts`) and never touch the network: the
transport is injected through the `fetch` option, so a test rewrites the feed between two syncs
and asserts on what the client did with it. Fixtures live in
[`src/test-helpers.ts`](./src/test-helpers.ts).

Jest runs through ts-jest, which transpiles to CJS — the package is ESM and its sources use
`./foo.js` specifiers, which Jest cannot resolve natively without `--experimental-vm-modules`.
[`jest.config.js`](./jest.config.js) maps the extension back off; nothing else is affected.

## Releasing

Releases are automated with [semantic-release][semrel]: merging into `main` publishes to npm
with [provenance][prov], creates the GitHub release and updates `CHANGELOG.md`. The version is
derived from commit messages, which must follow [Conventional Commits][cc]:

| Commit prefix                     | Effect        |
| --------------------------------- | ------------- |
| `fix:`                            | patch release |
| `feat:`                           | minor release |
| `feat!:` / `BREAKING CHANGE:`     | major release |
| `chore:`, `docs:`, `ci:`, `test:` | no release    |

`package.json` keeps `version: 0.0.0`; the real version is written by CI at publish time and is
re-exported as `VERSION`.

Publishing is off until the `RELEASE_ENABLED` repository **variable** is set to `true`; until
then the release job runs the checks and skips the publish with a notice. Authentication is
either of:

- **Trusted publishing** (preferred, no stored credential): configure this repository and
  `release.yml` as a trusted publisher on npm. The workflow already grants `id-token: write`,
  and the npm plugin attempts the OIDC exchange before it ever looks for a token.
- **`NPM_TOKEN`** — an **Actions** secret (not a Dependabot secret; those are a separate store
  that workflows cannot read) holding a token with publish rights.

## Continuous integration

| Workflow       | Trigger                  | Does                                                           |
| -------------- | ------------------------ | -------------------------------------------------------------- |
| `ci.yml`       | PRs, pushes to `main`    | `check` (tests included), `build:verify`, import on Node 18–24 |
| `release.yml`  | pushes to `main`         | semantic-release, npm publish with provenance                  |
| `security.yml` | PRs, pushes, weekly cron | Trivy and Bearer, reported to GitHub code scanning             |
| `sonar.yml`    | PRs, pushes to `main`    | Jest coverage, then the SonarQube Cloud analysis               |

## Data source

Prices come from the _Prix des carburants en France (flux instantané)_ dataset, read through the
Opendatasoft Explore API v2.1. It is public open data: no credentials, best-effort freshness, and
an anonymous budget the portal reports as 50 000 requests/day (`X-RateLimit-*` headers) with a
5-minute response cache — which the sync strategy above stays well within. Prices and timestamps
are self-reported by the stations. This package is not affiliated with the French administration.

## License

[MIT](./LICENSE)

[dataset]: https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/
[semrel]: https://semantic-release.gitbook.io/semantic-release/
[prov]: https://docs.npmjs.com/generating-provenance-statements
[cc]: https://www.conventionalcommits.org/en/v1.0.0/
