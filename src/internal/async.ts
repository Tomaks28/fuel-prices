/** The one concurrency primitive the SDK needs. */

/**
 * Runs `task` over every item, at most `limit` at a time, and returns the
 * results in the order of `items`.
 *
 * Used by the brand source that has to issue one request per station: firing
 * thousands at once earns a 429 from a service that is doing us a favour, and
 * firing them one by one would take minutes.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.trunc(limit), items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      // A shared cursor rather than a slice per worker: the tasks are requests
      // and they do not all take the same time, so a worker that draws a fast
      // batch keeps going instead of idling.
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await task(items[index] as T, index);
      }
    }),
  );

  return results;
}
