import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node18',
  // Keeps ESM on `.js` (the package is `"type": "module"`) and CJS on `.cjs`,
  // matching the `exports` map in package.json.
  fixedExtension: false,
  dts: true,
  // Maps embed `sourcesContent`, so they resolve for consumers without
  // shipping `src/` in the tarball.
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Keeps the exported VERSION constant in sync with the manifest.
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
});
