/**
 * Canonical brand names out of free text.
 *
 * Neither source of brands is a reference table: OpenStreetMap holds whatever a
 * contributor typed — `Total`, `TotalEnergies`, `Total Access`, `AVIA`, `Élan`,
 * `Total/Rubis` — and the prix-carburants reuse mixes real networks with
 * placeholders like `communale`. Left alone, one network would answer to half a
 * dozen keys and none of them would group.
 *
 * So every brand the SDK exposes goes through {@link sanitizeBrand}, which
 * cleans the string up, drops what is not a brand at all, and folds the known
 * French networks — sub-banners included — onto one spelling each.
 */

import { toLookupKey } from './text.js';

/**
 * Networks the SDK knows, and the spellings that reach it.
 *
 * Sub-banners fold into their network: `Total Access` and `Esso Express` are
 * TotalEnergies and Esso, `Super U` / `Station U` / `Hyper U` are all Système U.
 * That is the point of the table — a brand filter nobody can spell twice is
 * worth nothing — but it does mean the discount banners are not distinguishable
 * from the flagship ones once sanitized.
 *
 * The table only needs the roots: a value is also matched on its leading words,
 * so `Total Excellium` finds `total` without an entry of its own.
 */
const NETWORKS: readonly (readonly [canonical: string, aliases: readonly string[]])[] = [
  [
    'TotalEnergies',
    [
      'total',
      'totalenergies',
      'total energies',
      'total access',
      'totalenergies access',
      'total contact',
      'total relais',
      'elf',
      // Total's own retail subsidiary, which is how some stations are operated.
      'argedis',
    ],
  ],
  ['Esso', ['esso', 'esso express']],
  ['Shell', ['shell', 'shell express']],
  ['BP', ['bp', 'bp express']],
  ['Avia', ['avia', 'avia xpress', 'aviaxpress']],
  ['Eni', ['eni', 'agip']],
  ['AS24', ['as24', 'as 24']],
  ['Carrefour', ['carrefour', 'carrefour market', 'carrefour contact', 'carrefour express']],
  ['E.Leclerc', ['e leclerc', 'leclerc']],
  [
    'Intermarché',
    [
      'intermarche',
      'intermarche contact',
      'intermarche super',
      'ecomarche',
      // The group behind Intermarché, as the `operator` tag spells it.
      'groupement des mousquetaires',
      'les mousquetaires',
      'mousquetaires',
    ],
  ],
  ['Système U', ['systeme u', 'super u', 'hyper u', 'u express', 'station u', 'la station u', 'u']],
  ['Auchan', ['auchan', 'atac', 'simply market']],
  ['Casino', ['casino', 'geant', 'geant casino', 'super casino', 'petit casino']],
  ['Cora', ['cora']],
  ['Match', ['match', 'supermarche match', 'supermarches match']],
  ['Colruyt', ['colruyt']],
  ['Netto', ['netto']],
  ['Dyneff', ['dyneff']],
  ['Vito', ['vito']],
  ['Elan', ['elan']],
  ['Gulf', ['gulf']],
  ['Q8', ['q8']],
  ['Rubis', ['rubis']],
  ['Spar', ['spar', 'supermarche spar', 'supermarches spar']],
  ['Monoprix', ['monoprix']],
  ['Roady', ['roady']],
  ['Oil France', ['oil france']],
  ['Coccinelle', ['coccinelle', 'coccimarket']],
  ['Bi1', ['bi1']],
];

/** Every canonical name the table can produce, for docs and CLI help. */
export const KNOWN_BRANDS: readonly string[] = NETWORKS.map(([canonical]) => canonical);

const CANONICAL_BY_ALIAS: ReadonlyMap<string, string> = new Map(
  NETWORKS.flatMap(([canonical, aliases]) => [
    [toLookupKey(canonical), canonical] as const,
    ...aliases.map((alias) => [alias, canonical] as const),
  ]),
);

/**
 * Values that occupy a brand field without naming a brand. Both sources carry
 * them: OSM contributors describe the pump, and the prix-carburants reuse marks
 * unbranded stations `communale` or `indépendant`.
 */
const NOT_A_BRAND: ReadonlySet<string> = new Set([
  'yes',
  'no',
  'none',
  'null',
  'undefined',
  'unknown',
  'inconnu',
  'inconnue',
  'n a',
  'na',
  'other',
  'autre',
  'divers',
  'independant',
  'independante',
  'independants',
  'independent',
  'independents',
  'communal',
  'communale',
  'municipal',
  'municipale',
  'prive',
  'privee',
  'private',
  'public',
  'station',
  'station service',
  'stations service',
  'essence',
  'carburant',
  'carburants',
  'fuel',
  'gas',
  'gas station',
  'petrol',
  'pompe',
  'pompe a essence',
  'self',
  'self service',
  'automate',
  'garage',
  'supermarche',
  'hypermarche',
  'aire',
  'relais',
  'cooperative',
  'agricole',
]);

/** Prefixes that describe the place rather than name the brand. */
const NOISE_PREFIX = /^(?:station(?:[ -]service)?|garage)\s+(?=\S)/iu;

/** French company forms, which wrap operator names far more often than brands. */
const COMPANY_FORMS = 'sarl|sas|sasu|sa|snc|eurl|sci|sca|gie|scop|cuma';
const COMPANY_SUFFIX = new RegExp(`[\\s,]+(?:${COMPANY_FORMS})\\.?$`, 'iu');
const COMPANY_PREFIX = new RegExp(`^(?:${COMPANY_FORMS})\\.?\\s+(?=\\S)`, 'iu');

/** Longest brand the SDK accepts; past that it is a sentence, not a name. */
const MAX_LENGTH = 40;

/**
 * One canonical brand, or `null` when `raw` holds no brand at all.
 *
 * Idempotent: a name that already came out of here comes out unchanged, so it
 * is safe to run over values a source has already cleaned.
 */
export function sanitizeBrand(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  // `Total/Rubis` and `Avia + Elan` are two brands in one field. The first that
  // resolves to a known network wins; the whole value is not one brand anyway.
  const parts = raw.split(/[/+]|(?:\s+&\s+)/u);
  const cleaned: string[] = [];

  for (const part of parts) {
    const collapsed = collapse(part);
    // Matched before the rules below, so single-letter networks survive them:
    // `U` is how OSM spells a good share of the Système U stations.
    const known = network(collapsed);
    if (known !== null) return known;

    const candidate = strip(collapsed);
    if (candidate === null) continue;

    const canonical = network(candidate);
    if (canonical !== null) return canonical;
    cleaned.push(candidate);
  }

  // Nothing known: keep the first usable spelling rather than drop a brand the
  // table has never heard of (Repsol, Galp and every local network).
  return cleaned[0] ?? null;
}

/**
 * The network `value` names, matched whole and then on its leading words.
 *
 * `Total Excellium`, `Carrefour Market Plus` and `Avia Relais du Pont` are one
 * network with something appended, and the something is endless — a fuel grade, a
 * banner, a place. Dropping words off the end finds the network without the table
 * having to have foreseen the rest.
 */
function network(value: string): string | null {
  const words = toLookupKey(value).split(' ').filter(Boolean);

  for (let length = words.length; length > 0; length -= 1) {
    const canonical = CANONICAL_BY_ALIAS.get(words.slice(0, length).join(' '));
    if (canonical !== undefined) return canonical;
  }
  return null;
}

/**
 * Lookup key of a brand, so `total`, `TOTAL` and `TotalEnergies` all reach the
 * same bucket — the brand counterpart of the city keys.
 */
export function toBrandKey(brand: string): string {
  return toLookupKey(sanitizeBrand(brand) ?? brand);
}

/** Whitespace, control characters and wrapping punctuation only. */
function collapse(raw: string): string {
  return (
    raw
      // Control characters and non-breaking spaces both reach us from OSM.
      .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/^["'«»([]+|["'«»)\]]+$/gu, '')
      .trim()
  );
}

/** Trims the decoration off one collapsed candidate, or rejects it outright. */
function strip(collapsed: string): string | null {
  // Checked before the prefixes come off, so `Station service` is rejected whole
  // rather than trimmed down to a `service` nobody recognises.
  if (NOT_A_BRAND.has(toLookupKey(collapsed))) return null;

  const text = collapsed
    .replace(/[\s.,;:—-]+$/u, '')
    .replace(COMPANY_SUFFIX, '')
    .replace(COMPANY_PREFIX, '')
    .replace(NOISE_PREFIX, '')
    .trim();

  if (text.length < 2 || text.length > MAX_LENGTH) return null;
  // A brand needs a letter: `24/24`, `2` and `-----` are not names.
  if (!/\p{L}/u.test(text)) return null;
  if (NOT_A_BRAND.has(toLookupKey(text))) return null;

  return text;
}
