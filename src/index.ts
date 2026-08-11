/**
 * `@tomaks28/fuel-prices` — fuel prices of French gas stations.
 *
 * Public surface of the SDK. Everything consumers are allowed to rely on is
 * re-exported from here; anything else is an internal detail.
 */

export { VERSION } from './version.js';

export { FuelPricesError, type FuelPricesErrorCode } from './errors.js';

export {
  FuelPricesClient,
  getFuelPricesClient,
  resetFuelPricesClient,
  type FuelPricesOptions,
  type SyncOptions,
} from './fuel-prices.js';

export { FUEL_TYPES } from './types.js';

export type {
  AdministrativeArea,
  FuelOutage,
  FuelOutageMap,
  FuelPrice,
  FuelPriceMap,
  FuelType,
  GeoPoint,
  NearbyStation,
  Station,
  SyncResult,
} from './types.js';
