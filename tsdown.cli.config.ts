import { defineConfig } from 'tsdown';

/**
 * Build of the development CLI, deliberately separate from `tsdown.config.ts`.
 *
 * Adding it as a second entry of the library build made the bundler split the
 * shared code into a chunk that `files` would not have shipped — a published
 * package whose `index.js` imports a file that is not in the tarball. Its own
 * config and its own output directory keep the library build byte-for-byte what
 * it was, and `dist-cli/` is git-ignored and never published.
 */
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  dts: false,
  sourcemap: true,
  outDir: 'dist-cli',
  clean: true,
});
