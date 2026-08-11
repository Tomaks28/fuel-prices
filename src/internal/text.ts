/**
 * Lookup key for a place name: case-, accent- and separator-insensitive, so
 * `SAINT-MALO`, `Saint Malo` and `saint-malo` all hit the same bucket.
 */
export function toLookupKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
