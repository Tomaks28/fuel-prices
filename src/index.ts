/**
 * `@tomaks28/fuel-prices` — fuel prices of French gas stations.
 *
 * Public surface of the SDK. Everything consumers are allowed to rely on is
 * re-exported from here; anything else is an internal detail.
 */

export { VERSION } from './version.js';

export { FuelPricesError, type FuelPricesErrorCode } from './errors.js';

export {
  CACHE_VERSION,
  createFileCache,
  type CacheEntry,
  type CacheStore,
  type FileCacheOptions,
} from './cache.js';

export {
  FuelPricesClient,
  getFuelPricesClient,
  resetFuelPricesClient,
  type BrandsOptions,
  type FuelPricesOptions,
  type SyncOptions,
} from './fuel-prices.js';

export {
  overpassBrands,
  prixCarburantsBrands,
  type BoundingBox,
  type BrandSource,
  type OverpassBrandsOptions,
  type PrixCarburantsBrandsOptions,
} from './brands.js';

export { KNOWN_BRANDS, sanitizeBrand } from './internal/brand.js';

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
  OpeningDay,
  OpeningHours,
  OpeningRange,
  PriceStats,
  Station,
  StationMatch,
  StationQuery,
  StationSort,
  SyncResult,
  Weekday,
} from './types.js';
