/** Great-circle geometry, the only spatial maths the SDK needs. */

import { FuelPricesError } from '../errors.js';

import type { GeoPoint } from '../types.js';

/** IUGG mean Earth radius, in metres. */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Haversine distance between two points, in metres.
 *
 * A spherical Earth is off by up to ~0.5 % against the WGS 84 ellipsoid, which
 * is well under the precision of the coordinates the feed publishes — and the
 * error is monotonic, so it never reorders two stations.
 */
export function distanceMeters(from: GeoPoint, to: GeoPoint): number {
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);
  const deltaLat = toLat - fromLat;
  const deltaLon = toRadians(to.longitude - from.longitude);

  const chord =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;

  // `asin` of the clamped root, rather than `atan2`: it stays accurate for the
  // short distances this SDK actually compares.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(chord)));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Rejects a point that is not a coordinate on Earth. */
export function assertGeoPoint(point: GeoPoint, label: string): void {
  assertFinite(point.latitude, `${label}.latitude`);
  assertFinite(point.longitude, `${label}.longitude`);

  if (point.latitude < -90 || point.latitude > 90) {
    throw invalid(`${label}.latitude must be between -90 and 90, got ${String(point.latitude)}.`);
  }
  if (point.longitude < -180 || point.longitude > 180) {
    throw invalid(
      `${label}.longitude must be between -180 and 180, got ${String(point.longitude)}.`,
    );
  }
}

/** Rejects a radius that cannot bound a search. */
export function assertRadius(radiusMeters: number, label: string): void {
  assertFinite(radiusMeters, label);

  if (radiusMeters < 0) {
    throw invalid(`${label} must not be negative, got ${String(radiusMeters)}.`);
  }
}

function assertFinite(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${label} must be a finite number, got ${String(value)}.`);
  }
}

function invalid(message: string): FuelPricesError {
  return new FuelPricesError(message, { code: 'invalid_argument' });
}
