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

```sh
npm run check   # typecheck + lint + format check
npm run build   # dual ESM/CJS bundle into dist/
```

| Script              | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `build`             | Bundle ESM + CJS + `.d.ts` via tsup         |
| `typecheck`         | `tsc --noEmit` (strict, type-aware)         |
| `lint` / `lint:fix` | ESLint flat config, type-aware rules        |
| `format` / `:check` | Prettier                                    |
| `check`             | All of the above, in the order CI runs them |

## Data source

Prices come from the _Prix des carburants en France (flux instantané)_ dataset. It is public
open data: no credentials, no quota published, best-effort freshness. This package is not
affiliated with the French administration.

## License

[MIT](./LICENSE)

[dataset]: https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/
