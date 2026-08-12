/**
 * Nearest-brand lookup over a cloud of points.
 *
 * A brand source that only knows coordinates — OpenStreetMap does not carry the
 * dataset's station ids — has to match by proximity, and doing it naively is
 * ~9 800 stations × ~12 000 nodes of haversine. So the points go into a grid of
 * cells slightly larger than the search radius, and a lookup only measures the
 * nine cells around the station.
 */

import { distanceMeters } from './geo.js';

import type { GeoPoint } from '../types.js';

/** One brand, somewhere. */
export interface BrandPoint {
  readonly location: GeoPoint;
  /** Already sanitized by the source that built it. */
  readonly brand: string;
}

/** A latitude/longitude window, as the brand sources query them. */
export interface BoundingBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/**
 * Cell size, in degrees. 0.02° is ~2.2 km of latitude and ~1.4 km of longitude
 * in France — comfortably above any sane match radius, so nine cells always
 * cover the search area.
 */
const CELL_DEGREES = 0.02;

export class BrandIndex {
  readonly #cells = new Map<string, BrandPoint[]>();

  constructor(points: Iterable<BrandPoint>) {
    for (const point of points) {
      const key = cellKey(point.location.latitude, point.location.longitude);
      const cell = this.#cells.get(key);
      if (cell === undefined) this.#cells.set(key, [point]);
      else cell.push(point);
    }
  }

  /** The brand of the closest point within `radiusMeters`, or `null`. */
  nearest(location: GeoPoint, radiusMeters: number): string | null {
    let best: BrandPoint | undefined;
    let bestDistance = radiusMeters;

    const latitudeCell = Math.floor(location.latitude / CELL_DEGREES);
    const longitudeCell = Math.floor(location.longitude / CELL_DEGREES);

    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const cell = this.#cells.get(
          `${String(latitudeCell + dLat)}:${String(longitudeCell + dLon)}`,
        );
        if (cell === undefined) continue;

        for (const point of cell) {
          const distance = distanceMeters(location, point.location);
          // `<=` would let a later point of the same distance win, which makes
          // the result depend on the order the source returned its nodes in.
          if (distance < bestDistance) {
            best = point;
            bestDistance = distance;
          }
        }
      }
    }

    return best?.brand ?? null;
  }
}

/**
 * Side of a coverage tile, in degrees. See {@link coveringBoxes}.
 *
 * 2° rather than something continental, because the size of a tile is the size
 * of a query: France in one box is a query Overpass abandons after its 180 s
 * budget, and ~30 tiles of it are answered in seconds each.
 */
export const TILE_DEGREES = 2;

/** Which coverage tile a point falls in, so a source can tell what it holds. */
export function tileKey(point: GeoPoint, tileDegrees = TILE_DEGREES): string {
  const latitudeTile = Math.floor(point.latitude / tileDegrees);
  const longitudeTile = Math.floor(point.longitude / tileDegrees);
  return `${String(latitudeTile)}:${String(longitudeTile)}`;
}

function cellKey(latitude: number, longitude: number): string {
  const latitudeCell = Math.floor(latitude / CELL_DEGREES);
  const longitudeCell = Math.floor(longitude / CELL_DEGREES);
  return `${String(latitudeCell)}:${String(longitudeCell)}`;
}

/**
 * Boxes covering `points`, one per populated tile of a coarse grid.
 *
 * A single box around every French station would span from Guadeloupe to
 * Mayotte, i.e. a third of the planet — and even the mainland alone is more than
 * Overpass will chew through in one go. Tiling the stations and shrinking each
 * tile to the box its own points occupy is what turns "one query that times out"
 * into "a handful that do not": ~30 boxes for the whole country, none of them
 * over an area nobody sells fuel in.
 *
 * The grid is fixed rather than fitted, so a tile boundary can split a city.
 * That costs a box, not a station: the boxes are padded and the lookup that uses
 * them measures real distances.
 */
export function coveringBoxes(
  points: readonly GeoPoint[],
  paddingMeters: number,
  tileDegrees = TILE_DEGREES,
): BoundingBox[] {
  const tiles = new Map<string, { south: number; west: number; north: number; east: number }>();

  for (const point of points) {
    const key = tileKey(point, tileDegrees);
    const tile = tiles.get(key);

    if (tile === undefined) {
      tiles.set(key, {
        south: point.latitude,
        west: point.longitude,
        north: point.latitude,
        east: point.longitude,
      });
      continue;
    }
    tile.south = Math.min(tile.south, point.latitude);
    tile.west = Math.min(tile.west, point.longitude);
    tile.north = Math.max(tile.north, point.latitude);
    tile.east = Math.max(tile.east, point.longitude);
  }

  // Latitude is the safe conversion; a degree of longitude is shorter than that
  // everywhere but the equator, so padding by the same amount over-covers.
  const padding = paddingMeters / 111_320;

  return (
    [...tiles.values()]
      .map((tile) => ({
        south: clampLatitude(tile.south - padding),
        west: clampLongitude(tile.west - padding),
        north: clampLatitude(tile.north + padding),
        east: clampLongitude(tile.east + padding),
      }))
      // Sorted so the same stations always produce the same query, which keeps
      // upstream caches — and test assertions — useful.
      .sort((a, b) => a.south - b.south || a.west - b.west)
  );
}

function clampLatitude(value: number): number {
  return Math.min(90, Math.max(-90, value));
}

function clampLongitude(value: number): number {
  return Math.min(180, Math.max(-180, value));
}
