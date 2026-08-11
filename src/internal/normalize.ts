/** Raw dataset records → the {@link Station} shape consumers see. */

import {
  FUEL_TYPES,
  type FuelOutage,
  type FuelPrice,
  type FuelType,
  type Station,
} from '../types.js';

import type { RawStationRecord } from './dataset.js';

/**
 * Returns `null` for records the SDK cannot key on (no `id`), which would
 * otherwise collide in the cache.
 */
export function toStation(record: RawStationRecord): Station | null {
  const id = record.id === null ? '' : String(record.id).trim();
  if (!id) return null;

  const prices: Partial<Record<FuelType, FuelPrice>> = {};
  const outages: Partial<Record<FuelType, FuelOutage>> = {};
  let updatedAt: string | null = null;

  for (const fuel of FUEL_TYPES) {
    const price = record[`${fuel}_prix`];
    if (typeof price === 'number' && Number.isFinite(price)) {
      const priceUpdatedAt = toIsoUtc(record[`${fuel}_maj`]);
      prices[fuel] = { fuel, price, updatedAt: priceUpdatedAt };
      if (priceUpdatedAt !== null && (updatedAt === null || priceUpdatedAt > updatedAt)) {
        updatedAt = priceUpdatedAt;
      }
      // A priced fuel is on sale: the `rupture_*` columns keep the history of
      // past outages, so reporting one here would contradict the price.
      continue;
    }

    const kind = toOutageKind(record[`${fuel}_rupture_type`]);
    const since = toIsoUtc(record[`${fuel}_rupture_debut`]);
    if (kind !== null || since !== null) {
      outages[fuel] = { fuel, kind: kind ?? 'unknown', since };
    }
  }

  return {
    id,
    address: record.adresse?.trim() ?? '',
    city: record.ville?.trim() ?? '',
    postalCode: record.cp?.trim() ?? '',
    department: toArea(record.code_departement, record.departement),
    region: toArea(record.code_region, record.region),
    location: toGeoPoint(record.geom),
    kind: record.pop === 'A' ? 'highway' : 'road',
    open24h: record.horaires_automate_24_24 === 'Oui',
    services: record.services_service ?? [],
    prices,
    outages,
    updatedAt,
  };
}

/** Compares two versions of the same station on the data the SDK exposes. */
export function hasChanged(previous: Station, next: Station): boolean {
  if (previous.updatedAt !== next.updatedAt) return true;

  return FUEL_TYPES.some((fuel) => {
    const before = previous.prices[fuel];
    const after = next.prices[fuel];
    return before?.price !== after?.price || before?.updatedAt !== after?.updatedAt;
  });
}

/** The feed sends `2026-07-29T12:19:55+00:00`; normalise to a `Z` instant. */
function toIsoUtc(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function toOutageKind(value: string | null): FuelOutage['kind'] | null {
  if (value === 'temporaire') return 'temporary';
  if (value === 'definitive') return 'definitive';
  return null;
}

function toArea(code: string | null, name: string | null): Station['department'] {
  if (!code && !name) return null;
  return { code: code ?? '', name: name ?? '' };
}

function toGeoPoint(geom: RawStationRecord['geom']): Station['location'] {
  if (!geom || !Number.isFinite(geom.lat) || !Number.isFinite(geom.lon)) return null;
  return { latitude: geom.lat, longitude: geom.lon };
}
