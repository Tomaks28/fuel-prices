# @tomaks28/fuel-prices

TypeScript SDK returning fuel prices of French gas stations, backed by the official open data
feed published on [data.economie.gouv.fr][dataset] (~9 800 stations, no API key required).

> **Status: scaffolding.** The build, type and lint toolchain is in place; the public API is not
> implemented yet. Nothing but `VERSION` is exported at this point.

## Install

```sh
npm install @tomaks28/fuel-prices
```

Requires Node.js >= 18 (uses the global `fetch`). Ships both ESM and CJS builds with type
declarations.

## Development

Contributing needs Node.js >= 22.18 (tsdown and semantic-release require it), even though the
published package itself supports Node >= 18.

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
re-exported as `VERSION`. Publishing requires an `NPM_TOKEN` repository secret with publish
rights — without it the release job fails instead of publishing.

## Continuous integration

| Workflow       | Trigger                  | Does                                               |
| -------------- | ------------------------ | -------------------------------------------------- |
| `ci.yml`       | PRs, pushes to `main`    | `check`, `build:verify`, import on Node 18–24      |
| `release.yml`  | pushes to `main`         | semantic-release, npm publish with provenance      |
| `security.yml` | PRs, pushes, weekly cron | Trivy and Bearer, reported to GitHub code scanning |

## Data source

Prices come from the _Prix des carburants en France (flux instantané)_ dataset. It is public
open data: no credentials, no quota published, best-effort freshness. This package is not
affiliated with the French administration.

## License

[MIT](./LICENSE)

[dataset]: https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/
[semrel]: https://semantic-release.gitbook.io/semantic-release/
[prov]: https://docs.npmjs.com/generating-provenance-statements
[cc]: https://www.conventionalcommits.org/en/v1.0.0/
