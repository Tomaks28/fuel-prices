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

/**
 * `value` without the leading and trailing characters `cut` contains.
 *
 * A loop rather than the obvious `/^[…]+|[…]+$/g`: a quantified class against an
 * anchor backtracks, and measurably so — the regex form takes 28 ms on 8 000
 * characters and quadruples every time that doubles, where this stays flat.
 */
export function trimChars(value: string, cut: string): string {
  let start = 0;
  let end = value.length;

  // `charAt` rather than indexing: both loops stay inside the string, and it
  // types as `string` where `value[i]` would be `string | undefined`.
  while (start < end && cut.includes(value.charAt(start))) start += 1;
  while (end > start && cut.includes(value.charAt(end - 1))) end -= 1;

  return value.slice(start, end);
}

/** `value` without its trailing `cut` characters, leading ones left alone. */
export function trimTrailing(value: string, cut: string): string {
  let end = value.length;
  while (end > 0 && cut.includes(value.charAt(end - 1))) end -= 1;

  return value.slice(0, end);
}
