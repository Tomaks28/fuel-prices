import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  target: 'node18',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Keeps the exported VERSION constant in sync with the manifest.
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
});
