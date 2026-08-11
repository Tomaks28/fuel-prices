/**
 * Shape of the upstream dataset, kept in one place so the rest of the SDK never
 * spells out an Opendatasoft field name.
 *
 * Dataset: `prix-des-carburants-en-france-flux-instantane-v2`
 * (Explore API v2.1 — public open data, no credentials).
 */

import { FUEL_TYPES, type FuelType } from '../types.js';

/** Per-fuel columns, e.g. `gazole_prix` / `sp95_maj` / `e10_rupture_type`. */
type RawFuelColumns = {
  [F in FuelType as `${F}_prix`]: number | null;
} & {
  [F in FuelType as `${F}_maj`]: string | null;
} & {
  [F in FuelType as `${F}_rupture_debut`]: string | null;
} & {
  [F in FuelType as `${F}_rupture_type`]: string | null;
};

interface RawStationColumns {
  id: number | string | null;
  adresse: string | null;
  ville: string | null;
  cp: string | null;
  /** `R` for a road station, `A` for a motorway one. */
  pop: string | null;
  geom: { lon: number; lat: number } | null;
  departement: string | null;
  code_departement: string | null;
  region: string | null;
  code_region: string | null;
  /** `Oui` / `Non`. */
  horaires_automate_24_24: string | null;
  /** Weekly schedule, as a stringified JSON blob. */
  horaires: string | null;
  services_service: string[] | null;
}

/** One record of the dataset, restricted to the fields {@link STATION_SELECT} asks for. */
export type RawStationRecord = RawStationColumns & RawFuelColumns;

/**
 * Fields the SDK reads. Asking for them explicitly trims the payload by half:
 * the raw dataset also carries `prix`, `rupture` and `services` as stringified
 * JSON duplicating the flattened columns below. `horaires` is the exception —
 * nothing else carries the weekly schedule, so it is read and parsed.
 */
export const STATION_SELECT: string = [
  'id',
  'adresse',
  'ville',
  'cp',
  'pop',
  'geom',
  'departement',
  'code_departement',
  'region',
  'code_region',
  'horaires_automate_24_24',
  'horaires',
  'services_service',
  ...FUEL_TYPES.flatMap((fuel) => [
    `${fuel}_prix`,
    `${fuel}_maj`,
    `${fuel}_rupture_debut`,
    `${fuel}_rupture_type`,
  ]),
].join(',');

/**
 * ODSQL predicate matching every station whose price changed after `since`.
 *
 * The dataset has no record-level modification date, only one `_maj` timestamp
 * per fuel, so "modified" is the union over the six of them.
 */
export function updatedSinceWhere(since: Date): string {
  const literal = `date'${since.toISOString()}'`;
  return FUEL_TYPES.map((fuel) => `${fuel}_maj > ${literal}`).join(' or ');
}
