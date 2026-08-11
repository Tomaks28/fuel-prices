/** Price distribution over a set of stations. */

import type { FuelType, PriceStats, Station } from '../types.js';

/**
 * Returns `null` when no station in `stations` sells `fuel`, rather than a row
 * of zeroes a caller could mistake for a real quote.
 */
export function toPriceStats(stations: Iterable<Station>, fuel: FuelType): PriceStats | null {
  const prices: number[] = [];
  let total = 0;
  let updatedAt: string | null = null;

  for (const station of stations) {
    const price = station.prices[fuel];
    if (price === undefined) continue;

    prices.push(price.price);
    total += price.price;
    if (price.updatedAt !== null && (updatedAt === null || price.updatedAt > updatedAt)) {
      updatedAt = price.updatedAt;
    }
  }

  if (prices.length === 0) return null;
  prices.sort((a, b) => a - b);

  return {
    fuel,
    count: prices.length,
    min: prices[0] ?? 0,
    max: prices[prices.length - 1] ?? 0,
    mean: total / prices.length,
    median: median(prices),
    updatedAt,
  };
}

/** Mean of the two middle values on an even count, as usual. */
function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
