import { describe, expect, it } from '@jest/globals';

import { mapWithConcurrency } from './async.js';

/** Resolves after `ticks` microtask turns, to interleave the workers. */
async function after<T>(ticks: number, value: T): Promise<T> {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
  return value;
}

describe('mapping with a concurrency limit', () => {
  it('keeps the order of the input, whatever order the tasks finish in', async () => {
    const results = await mapWithConcurrency([3, 1, 2], 3, (item) => after(item, item * 10));

    expect(results).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` at a time', async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_unused, index) => index),
      4,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await after(2, null);
        running -= 1;
      },
    );

    expect(peak).toBe(4);
  });

  it('keeps a free worker busy instead of waiting for a slow batch', async () => {
    const order: number[] = [];
    // Two workers, one very slow first item: the fast ones must not queue behind
    // it, which is what a slice-per-worker split would do.
    await mapWithConcurrency([20, 1, 1, 1], 2, async (ticks, index) => {
      await after(ticks, null);
      order.push(index);
    });

    expect(order).toEqual([1, 2, 3, 0]);
  });

  it('handles an empty list without spawning anything', async () => {
    await expect(
      mapWithConcurrency([], 4, () => Promise.reject(new Error('never'))),
    ).resolves.toEqual([]);
  });

  it('treats a nonsensical limit as one at a time', async () => {
    await expect(mapWithConcurrency([1, 2], 0, (item) => after(0, item))).resolves.toEqual([1, 2]);
  });

  it('propagates the first rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (item) =>
        item === 2 ? Promise.reject(new Error('boom')) : after(1, item),
      ),
    ).rejects.toThrow('boom');
  });
});
