/**
 * Fuel-station brands out of OpenStreetMap, through an Overpass endpoint.
 *
 * Overpass is the only source that can brand the whole dataset in one request,
 * which is why it is here — but it is also a shared, unfunded service that
 * answers a France-wide query in minutes, so the query is built once, as narrow
 * as the stations allow, and asks for tags only.
 */

import { FuelPricesError } from '../errors.js';

import { sanitizeBrand } from './brand.js';
import { JsonHttpClient, type HttpOptions } from './http.js';

import type { BoundingBox, BrandPoint } from './brand-index.js';

export interface OverpassClientOptions extends HttpOptions {
  /**
   * Interpreter URL. Defaults to the main instance, which is also the busiest —
   * `https://overpass.kumi.systems/api/interpreter` is the mirror this was
   * developed against, and worth setting when the main one keeps timing out.
   */
  endpoint?: string;
  /**
   * Boxes per request. Defaults to 2.
   *
   * All of France in one query gets a 504 — the interpreter gives up on its own
   * budget first — while the two densest tiles of it, ~1 600 stations, come back
   * in ~20 s. Raising this trades requests for the risk of the former.
   */
  maxBoxesPerRequest?: number;
}

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
/**
 * Server-side budget, in seconds. The interpreter abandons the query past it and
 * answers 504, so it is also what the client deadline has to allow for: a tighter
 * one throws away work that was about to succeed.
 */
const QUERY_TIMEOUT_S = 180;
const DEFAULT_TIMEOUT_MS = (QUERY_TIMEOUT_S + 20) * 1000;
const DEFAULT_MAX_BOXES_PER_REQUEST = 2;

interface OverpassElement {
  lat?: unknown;
  lon?: unknown;
  center?: { lat?: unknown; lon?: unknown };
  tags?: { brand?: unknown; operator?: unknown };
}

export class OverpassClient {
  readonly #http: JsonHttpClient;
  readonly #endpoint: string;
  readonly #maxBoxesPerRequest: number;

  constructor(options: OverpassClientOptions = {}) {
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#maxBoxesPerRequest = Math.max(
      1,
      options.maxBoxesPerRequest ?? DEFAULT_MAX_BOXES_PER_REQUEST,
    );
    this.#http = new JsonHttpClient({
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.retries === undefined ? {} : { retries: options.retries }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      service: 'the Overpass API',
    });
  }

  /**
   * Every branded fuel station inside `boxes`.
   *
   * Issued as a handful of requests rather than one, and sequentially: the
   * interpreter runs one query per client at a time anyway, and a service this
   * one is free to use is not one to open ten sockets on.
   */
  async fetchBrandPoints(
    boxes: readonly BoundingBox[],
    signal?: AbortSignal,
  ): Promise<BrandPoint[]> {
    const points: BrandPoint[] = [];

    for (let index = 0; index < boxes.length; index += this.#maxBoxesPerRequest) {
      const batch = boxes.slice(index, index + this.#maxBoxesPerRequest);

      const payload = await this.#http.request({
        url: this.#endpoint,
        body: new URLSearchParams({ data: buildQuery(batch) }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal,
      });
      points.push(...toBrandPoints(payload));
    }

    return points;
  }
}

/**
 * One union over the boxes, asking for tags and a centre only. `nwr` covers the
 * three element types: a good share of French stations are mapped as an area
 * rather than a single node.
 */
export function buildQuery(boxes: readonly BoundingBox[]): string {
  const clauses = boxes
    .map(
      (box) =>
        `  nwr["amenity"="fuel"](${format(box.south)},${format(box.west)},` +
        `${format(box.north)},${format(box.east)});`,
    )
    .join('\n');

  return `[out:json][timeout:${String(QUERY_TIMEOUT_S)}];\n(\n${clauses}\n);\nout tags center qt;\n`;
}

/**
 * Brand points out of an Overpass answer.
 *
 * `brand` first, `operator` as a fallback — and nothing else. `name` holds the
 * station's own name far more often than a network (`Garage Bahezre`, `Café des
 * sports`), so reading it would invent brands rather than find them.
 */
export function toBrandPoints(payload: unknown): BrandPoint[] {
  if (typeof payload !== 'object' || payload === null) {
    throw invalidResponse('Expected the Overpass API to return an object.');
  }

  const { elements, remark } = payload as { elements?: unknown; remark?: unknown };
  // Overpass reports its own overload inside a 200, as a `remark`.
  if (typeof remark === 'string' && !Array.isArray(elements)) {
    throw invalidResponse(`The Overpass API refused the query: ${remark}`);
  }
  if (!Array.isArray(elements)) {
    throw invalidResponse('Expected the Overpass answer to carry an `elements` array.');
  }

  const points: BrandPoint[] = [];
  for (const element of elements as OverpassElement[]) {
    const latitude = toNumber(element.lat ?? element.center?.lat);
    const longitude = toNumber(element.lon ?? element.center?.lon);
    if (latitude === null || longitude === null) continue;

    const brand = sanitizeBrand(element.tags?.brand) ?? sanitizeBrand(element.tags?.operator);
    if (brand === null) continue;

    points.push({ location: { latitude, longitude }, brand });
  }
  return points;
}

/** Six decimals is ~10 cm; more only makes the query — and its cache key — longer. */
function format(degrees: number): string {
  return degrees.toFixed(6);
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function invalidResponse(message: string): FuelPricesError {
  return new FuelPricesError(message, { code: 'invalid_response' });
}
