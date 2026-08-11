/**
 * Persistence for the in-memory snapshot.
 *
 * The point is not to save the ~2 MB download: it is that a snapshot persisted
 * with its `syncedAt` lets a restarted process hydrate from disk and then ask
 * for the delta, turning a 10-20 s cold start into a few hundred records.
 */

import { FuelPricesError } from './errors.js';

import type * as NodeFs from 'node:fs/promises';
import type { Station } from './types.js';

/** What a {@link CacheStore} round-trips. Plain JSON, by construction. */
export interface CacheEntry {
  /** Layout of this entry. Bumped whenever `Station` changes shape. */
  readonly version: number;
  /** Dataset the snapshot came from; a mismatch invalidates the entry. */
  readonly dataset: string;
  /** ISO-8601 UTC instant the snapshot was synced at. */
  readonly syncedAt: string;
  readonly stations: readonly Station[];
}

/**
 * Somewhere to keep the snapshot between runs.
 *
 * `read` must resolve to `null` rather than throw when it has nothing usable —
 * a cache miss is normal, and so is a truncated or foreign file.
 */
export interface CacheStore {
  read(): Promise<CacheEntry | null>;
  write(entry: CacheEntry): Promise<void>;
  clear?(): Promise<void>;
}

/** Current {@link CacheEntry.version}. */
export const CACHE_VERSION = 1;

export interface FileCacheOptions {
  /**
   * Create the parent directory when it is missing. Defaults to `true`, so
   * pointing at `.cache/fuel-prices.json` works out of the box.
   */
  mkdir?: boolean;
}

/**
 * A {@link CacheStore} backed by a JSON file.
 *
 * Writes go to a sibling temporary file and are renamed into place, so a process
 * killed mid-write leaves the previous snapshot intact rather than a half file.
 * `node:fs` is imported on first use, which keeps the module graph of the SDK
 * free of filesystem imports for anyone bundling it elsewhere.
 */
export function createFileCache(path: string, options: FileCacheOptions = {}): CacheStore {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new FuelPricesError('A file cache needs a non-empty path.', { code: 'invalid_argument' });
  }
  const mkdir = options.mkdir ?? true;

  return {
    async read(): Promise<CacheEntry | null> {
      const fs = await fsPromises();

      let raw: string;
      try {
        raw = await fs.readFile(path, 'utf8');
      } catch {
        // Missing, unreadable, a directory — all of them are just a miss.
        return null;
      }

      try {
        return toCacheEntry(JSON.parse(raw));
      } catch {
        return null;
      }
    },

    async write(entry: CacheEntry): Promise<void> {
      const fs = await fsPromises();
      const nodePath = await import('node:path');

      if (mkdir) {
        await fs.mkdir(nodePath.dirname(path), { recursive: true });
      }

      const temporary = `${path}.${String(process.pid)}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(entry), 'utf8');
        await fs.rename(temporary, path);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw new FuelPricesError(`Could not write the cache file at ${path}.`, {
          code: 'cache',
          cause: error,
        });
      }
    },

    async clear(): Promise<void> {
      const fs = await fsPromises();
      await fs.rm(path, { force: true });
    },
  };
}

/** Rejects anything that is not an entry this version of the SDK wrote. */
export function toCacheEntry(value: unknown): CacheEntry | null {
  if (typeof value !== 'object' || value === null) return null;

  const entry = value as Partial<CacheEntry>;
  if (entry.version !== CACHE_VERSION) return null;
  if (typeof entry.dataset !== 'string' || typeof entry.syncedAt !== 'string') return null;
  if (Number.isNaN(Date.parse(entry.syncedAt))) return null;
  if (!Array.isArray(entry.stations)) return null;
  // Spot-check the payload rather than validate 9 800 records field by field.
  const stations = entry.stations as unknown[];
  if (stations.some((station) => typeof (station as Station | undefined)?.id !== 'string')) {
    return null;
  }

  return {
    version: entry.version,
    dataset: entry.dataset,
    syncedAt: entry.syncedAt,
    stations: entry.stations,
  };
}

/** `import type` is erased, so the SDK carries no static `node:fs` dependency. */
async function fsPromises(): Promise<typeof NodeFs> {
  try {
    return await import('node:fs/promises');
  } catch (error) {
    throw new FuelPricesError(
      'The file cache needs `node:fs`, which this runtime does not provide.',
      { code: 'unsupported', cause: error },
    );
  }
}
