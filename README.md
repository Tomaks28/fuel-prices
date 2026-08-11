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
| `getStationsUpdatedSince(date)` | Cached stations whose price moved after `date`      |

City names are not INSEE-coded upstream, so homonyms share a bucket — filter on `postalCode`
when that matters. Lookups are served from indexes rebuilt on demand after a sync.

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

### Options and errors

```ts
const client = new FuelPricesClient({
  timeoutMs: 60_000, // per attempt
  retries: 2, // retried on 408/425/429/5xx and network failures, honouring Retry-After
  syncOverlapMs: 5 * 60 * 1000,
  fetch: myFetch, // stub or instrument the transport
  baseUrl,
  dataset, // point at another Opendatasoft portal
});
```

Everything throws `FuelPricesError`, carrying a `code` (`http`, `network`, `timeout`, `aborted`,
`invalid_response`, `invalid_argument`, `unsupported`) plus `status` / `apiCode` when the failure
came from the API. All network methods accept an `AbortSignal`.

Out of scope for now: opening hours (the raw `horaires` field is not parsed) and geographic
radius search.

## Development

The toolchain version is pinned in [`.nvmrc`](./.nvmrc) and CI reads it from there, so `nvm use`
is enough to match it. Node >= 24.15 is the real floor for contributors (tsdown and the
semantic-release plugins), even though the published package supports Node >= 18 — which the
`compat` CI job verifies on every run.

```sh
npm run check   # typecheck + lint + format check
npm run build   # dual ESM/CJS bundle into dist/
```

| Script              | Purpose                                            |
| ------------------- | -------------------------------------------------- |
| `build`             | Bundle ESM + CJS + `.d.ts` via tsdown              |
| `build:verify`      | Build, then gate on `publint` + `arethetypeswrong` |
| `typecheck`         | `tsc --noEmit` (strict, type-aware)                |
| `lint` / `lint:fix` | ESLint flat config, type-aware rules               |
| `format` / `:check` | Prettier                                           |
| `check`             | All of the above, in the order CI runs them        |

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

| Workflow       | Trigger                  | Does                                               |
| -------------- | ------------------------ | -------------------------------------------------- |
| `ci.yml`       | PRs, pushes to `main`    | `check`, `build:verify`, import on Node 18–24      |
| `release.yml`  | pushes to `main`         | semantic-release, npm publish with provenance      |
| `security.yml` | PRs, pushes, weekly cron | Trivy and Bearer, reported to GitHub code scanning |

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
