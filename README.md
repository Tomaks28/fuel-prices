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
| `getStationsByBrand(brand)`     | Stations of a network — needs a [brand source]      |
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
| `brand`                              | One network or a list, ORed; needs a [brand source]  |
| `fuel`                               | One fuel, or a list the station must sell all of     |
| `maxPrice`                           | Price ceiling; needs exactly one `fuel`              |
| `kind`                               | `road` or `highway`                                  |
| `openAt`                             | Stations the feed reports as open at that instant    |
| `sort`                               | `distance`, `price` or `updatedAt`                   |
| `limit`                              | Caps the result set                                  |

Criteria are ANDed — `brand` excepted, since a station has only one — an empty
query returns everything, and each match carries `distanceMeters` when the query
had a centre. The whole thing runs against the in-memory snapshot — no request
once it is warm. Contradictory queries throw `invalid_argument` **before** the
dataset is loaded, so a typo costs nothing.

### Brands

The official feed publishes prices per station and says nothing about the network
selling them: there is no brand, enseigne or marque column in the dataset. So the
brand is grafted on from elsewhere, and `Station.brand` is `null` until you say
where from.

```ts
const fuelPrices = new FuelPricesClient({
  brands: true, // OpenStreetMap, through Overpass
  cache: createFileCache('.cache/fuel-prices.json'),
});

const totals = await fuelPrices.findStations({ brand: 'total', city: 'rennes' });
console.log(totals[0]?.station.brand); // 'TotalEnergies'
```

[brand source]: #brands

Two sources ship, and they are not interchangeable:

| Source                   | Matches on | Cost of the whole dataset | Caveat                                      |
| ------------------------ | ---------- | ------------------------- | ------------------------------------------- |
| `overpassBrands()`       | Proximity  | ~15 queries, seconds each | Can capture a garage pump next door         |
| `prixCarburantsBrands()` | Station id | One request per station   | Third-party reuse, capped at 500 by default |

`overpassBrands()` reads `amenity=fuel` out of OpenStreetMap, which carries a
`brand` tag on ~87 % of French fuel POIs, and keeps what it downloaded for the
process. It knows coordinates rather than station ids, so it takes the nearest
node within `maxDistanceMeters` (150 by default) — the feed and OSM place the same
station a few tens of metres apart, and raising the tolerance buys coverage at the
price of false positives.

Measured on the live services: **7 416 of 9 807 stations branded (76 %) in ~193 s**,
dataset download included, 152 distinct brands. The gap is stations OSM has not
tagged, not mismatches — the counts per network come out just under the official
ones, never above.

The query is tiled at 2° and issued two tiles at a time, because all of France in
one go gets a 504: the interpreter abandons the query on its own 180 s budget
first. The main instance is the default and, in measurements, the fastest; if it
keeps timing out, a mirror is one option away:

```ts
const fuelPrices = new FuelPricesClient({
  brands: {
    sources: [overpassBrands({ endpoint: 'https://overpass.kumi.systems/api/interpreter' })],
    onError: (error) => logger.warn(error),
  },
});
```

`prixCarburantsBrands()` reads the [2àZ reuse][2aaz] of this same official data,
completed with the enseignes shown on prix-carburants.gouv.fr. It is keyed on the
dataset's own station id, so it needs no tolerance and cannot mismatch — a sample
of 12 stations came back branded 12 times, already canonical. But `/station/{id}`
answers one station per request and the list endpoints are capped at 20 records a
page, so `maxRequests` (500) is what stops a `load()` from turning into ~9 800
calls. Which is why it reads best behind the bulk one:

```ts
const fuelPrices = new FuelPricesClient({
  // Overpass brands everything in a handful of queries; the reuse then spends
  // its request budget on what is left.
  brands: { sources: [overpassBrands(), prixCarburantsBrands({ maxRequests: 1_000 })] },
});
```

Sources are tried in order and each one only sees the stations the previous ones
could not name. `SyncResult.branded` reports how far they got — a source that
failed, or one that hit its ceiling, shows up as a count below `total` rather than
as an error, since brands never fail a sync. Pass `onError` to hear about it.

**Sanitizing.** Neither source is a reference table: OSM holds whatever a
contributor typed and the reuse mixes networks with placeholders. So every value
goes through `sanitizeBrand`, which drops what is not a brand (`yes`, `communale`,
`Station service`, `24/24`), trims the decoration (`Station AVIA XPRESS`,
`B2M SARL`, `"Avia"`), and folds the known French networks onto one spelling each:

| Reaching the SDK                                                                     | Stored as       |
| ------------------------------------------------------------------------------------ | --------------- |
| `Total`, `TOTAL`, `Total Access`, `Total Acces`, `Total Excellium`, `Elf`, `Argedis` | `TotalEnergies` |
| `Super U`, `Station U`, `Hyper U`, `U Express`, `U`, `Super U;Station U`             | `Système U`     |
| `Carrefour Market`, `Carrefour Contact`, `Carrefour Express`                         | `Carrefour`     |
| `E. Leclerc`, `Leclerc`                                                              | `E.Leclerc`     |
| `Esso Express`                                                                       | `Esso`          |
| `Groupement des Mousquetaires`, `Ecomarché`                                          | `Intermarché`   |
| `Agip`                                                                               | `Eni`           |

The table only holds the roots: a value is matched whole, then on its leading
words, which is how `Total Excellium` and a typo like `Total Acces` land on
TotalEnergies without an entry each. On the sample of 2 583 raw OSM values, that
came to 99 brands with 6 dropped as non-brands.

`KNOWN_BRANDS` lists what the table can produce; a network it has never heard of
is kept as it came, cleaned. Note that this folds the discount banners into their
network: once sanitized, a Total Access is not distinguishable from a flagship
TotalEnergies. Filtering is spelling-insensitive either way — `brand: 'total'`,
`'TOTAL'` and `'Total Access'` all select the same stations.

**When lookups happen.** On a full `load()` or `refresh()`, for the stations that
have no brand yet; a resolved brand is then carried across syncs and persisted
with the snapshot, so a cache hit starts already branded and costs no request.
That also means hydrating from cache does _not_ retry the stations a source could
not name — `refresh()` is what goes back for those.

**Your own source.** `BrandSource` is one method, and whatever it returns is
sanitized like the rest:

```ts
const fromOurCrm: BrandSource = {
  name: 'CRM',
  resolve: async (stations) => new Map(stations.map((s) => [s.id, lookUp(s.id)])),
};
```

One thing brands cannot give you: the premium grades. `Excellium`, `Ultimate` and
`V-Power` are not fuels in the dataset — the six legal categories are all that is
declared, so a premium diesel is reported under `gazole` whatever the sign says.

[2aaz]: https://www.data.gouv.fr/reuses/api-prix-carburants

### Stale prices

Prices are self-reported, and how often depends heavily on the fuel:

| Fuel   | Stations | Median age | Older than 7 days | Older than 30 days | Oldest |
| ------ | -------- | ---------- | ----------------- | ------------------ | ------ |
| gazole | 9 545    | 0 d        | 9.5 %             | 0.3 %              | 132 d  |
| e10    | 7 319    | 0 d        | 7.8 %             | 0.4 %              | 371 d  |
| sp98   | 7 347    | 0 d        | 12.5 %            | 0.8 %              | 157 d  |
| sp95   | 2 985    | 3 d        | 24.2 %            | 3.3 %              | 378 d  |
| e85    | 3 905    | 3 d        | 31.6 %            | 4.4 %              | 614 d  |
| gplc   | 1 489    | 0 d        | 33.3 %            | **22.0 %**         | 340 d  |

`maxPriceAge` filters them out:

```ts
const fresh = await fuelPrices.findStations({
  near: { latitude: 48.1173, longitude: -1.6778 },
  radiusMeters: 30_000,
  fuel: 'gplc',
  maxPriceAge: 7 * 24 * 60 * 60 * 1000,
});
// 16 GPLc stations in that radius, 8 of them quoted within the week
```

It measures the age of the **fuels the query names**, and falls back to the
station's freshest price only when it names none. That distinction matters: a
station quoting gazole hourly can be sitting on an E85 price from six months ago,
and a station-level filter would wrongly keep 7.8 % of fuel prices for that
reason. A price the feed left undated can never be shown to be fresh, so it drops
out too.

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

Entries carry a `CACHE_VERSION`, bumped whenever `Station` changes shape — it went
to 2 when stations gained `brand`. A snapshot from an older version is simply a
miss: the next `load()` re-reads the dataset and writes it back in the new shape.

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
  brands: { sources: [overpassBrands()], onError: (error) => logger.warn(error) },
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

The quickest way in is the interactive mode: every question carries a default,
so pressing Enter through it searches **20 km around Paris**.

```sh
npm run cli -- ask            # prompts, Enter accepts each default
npm run cli -- ask --defaults # skip the prompts entirely
```

```
Where? "lat,lon" or a city name [Paris]:
Radius in metres [20000]:
Fuel(s), comma separated (gazole, sp95, sp98, e10, e85, gplc) [any]:
Show the enseignes? (the feed has none — a lookup, minutes on a cold cache) [n]:
Only stations open right now? [n]:
Ignore quotes older than [7d]:
Sort by (distance, price, updatedAt) [distance]:
How many results [10]:
Cache file ("none" to disable) [.cache/fuel-prices.json]:
```

Results come back as an aligned table, one row per station, with a column only
for the fuels somebody in the result set actually sells:

```
#       DIST PLACE                                   GAZOLE   SP95   SP98    E10   GPLC   AGE STATUS   ID
1.    2.9 km Vernouillet 28500 · C C PLEIN SUD        2.046      —  1.955  1.876      —    9h open     28500001
2.    1.0 km Dreux 28100 · Rue Bautzen                2.047      —  1.955  1.878      —   15h open     28100002
3.    1.4 km Dreux 28100 · Rue des Bas Buissons       2.059      —  1.959  1.879  0.971   13h open     28100003
```

In a terminal it is coloured: the cheapest quote of each column green, the sorted
column bold, open green and closed red, and a quote older than a week yellow —
red past a month. Colour is off when the output is piped, `NO_COLOR` is honoured,
and `--no-color` overrides everything.

Saying yes to the enseignes adds one question — which ones to keep, `any` to keep
them all — and switches the lookup on for that run. It is the only question that
costs requests the prices have not already paid for, hence the default and the
warning.

Answer the first question with a city name and it is resolved against the dataset
itself — the centre of that city's stations — rather than a built-in gazetteer.
`ask` refuses to run without a terminal, so piping into it fails fast instead of
hanging; use `find` with flags there.

Or drive it with flags:

```sh
npm run cli -- --help
npm run cli -- nearby 48.1173 -1.6778 3000 --fuel gazole --sort price --limit 3
npm run cli -- find --city rennes --fuel e85 --open-now --cache .cache/stations.json
npm run cli -- stats gazole --department 35
npm run cli -- find --fuel gplc --max-price-age 7d --near 48.11,-1.67 --radius 30000
npm run cli -- sync --cache .cache/stations.json
npm run cli -- info
```

Every command takes the `findStations` filters, plus `--cache <file>` to exercise
persistence and `--json` for raw output. Pass `--cache` twice in a row to feel the
difference the snapshot makes.

Brands are behind `--brands`, and `--brand` implies it — filtering on a network you
never went and fetched would just match nothing. Answering the `Enseigne(s)`
question of `ask` does the same. A `BRAND` column then appears:

```sh
npm run cli -- find --city rennes --brand total --cache .cache/stations.json
npm run cli -- find --brands --brand-source both --near 48.11,-1.67 --radius 5000
npm run cli -- find --brands --overpass https://overpass.kumi.systems/api/interpreter --city brest
```

```
#       DIST BRAND         PLACE            GAZOLE   SP95   SP98    E10    E85   AGE STATUS   ID
1.    1.7 km Système U     Rennes 35200 · …  2.059      —  1.990  1.885      —    5d unknown  35200008
2.    2.0 km TotalEnergies Rennes 35000 · …  2.196      —      —      —      —   15h open     35000025
3.    2.5 km TotalEnergies Rennes 35000 · …  2.137      —  1.990  1.939  0.840    0h open     35000023
```

The column stays once brands are asked for, even if the lookup came back empty: a
source that failed reads as a column of dashes rather than as a column that
silently never appeared. The first run pays for the lookups and writes them to
`--cache`; the next ones read them off the snapshot in milliseconds.

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

Brands do not come from there, because the dataset has no brand column: they are optional, off by
default, and read from [OpenStreetMap][osm] through a public Overpass instance (ODbL — attribution
and share-alike apply to what you redistribute) or from the [2àZ reuse][2aaz-src] of the official
data. Both are free services run by other people; the tiling, the request ceiling and the
`user-agent` this SDK sends are there to keep it a well-behaved caller, and the snapshot cache is
what stops it asking twice.

[osm]: https://www.openstreetmap.org/copyright
[2aaz-src]: https://api.prix-carburants.2aaz.fr

## License

[MIT](./LICENSE)

[dataset]: https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/
[semrel]: https://semantic-release.gitbook.io/semantic-release/
[prov]: https://docs.npmjs.com/generating-provenance-statements
[cc]: https://www.conventionalcommits.org/en/v1.0.0/
