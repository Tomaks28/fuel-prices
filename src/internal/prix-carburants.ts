/**
 * Brands out of the `prix-carburants` reuse published by 2àZ.
 *
 * It wraps the same official data this SDK reads, completed with the station
 * names and brands shown on prix-carburants.gouv.fr — and it keys them on the
 * dataset's own station id, so a brand from here needs no proximity guessing and
 * no tolerance to tune.
 *
 * What it costs: `/station/{id}` answers one station per request. The list
 * endpoints that would batch it are capped at 20 records a page and want an API
 * key, so branding the whole dataset from here is thousands of requests — hence
 * the ceiling in {@link PrixCarburantsClientOptions.maxRequests}.
 *
 * Docs: <https://swagger.2aaz.fr/?urls.primaryName=Fuel%20prices%20API%20(prix-carburants)>
 */

import { FuelPricesError } from '../errors.js';

import { JsonHttpClient, type HttpOptions } from './http.js';

export interface PrixCarburantsClientOptions extends HttpOptions {
  /** API root. Defaults to `https://api.prix-carburants.2aaz.fr`. */
  baseUrl?: string;
  /**
   * Key of a subscription, sent as `Authorization: Key …`. `/station/{id}` reads
   * fine without one; a key is what raises the rate limit.
   */
  apiKey?: string;
}

const DEFAULT_BASE_URL = 'https://api.prix-carburants.2aaz.fr';
const DEFAULT_TIMEOUT_MS = 30_000;

interface StationBody {
  Brand?: { name?: unknown } | null;
}

export class PrixCarburantsClient {
  readonly #http: JsonHttpClient;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;

  constructor(options: PrixCarburantsClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#http = new JsonHttpClient({
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.retries === undefined ? {} : { retries: options.retries }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      service: 'the prix-carburants API',
    });
  }

  /**
   * The brand of one station, raw — `null` when the API knows the station but
   * attaches no brand to it.
   *
   * A station the reuse has never heard of is a 404, which is not a failure
   * worth propagating: the dataset and the reuse do not refresh in lockstep.
   */
  async fetchBrand(id: string, signal?: AbortSignal): Promise<string | null> {
    let payload: unknown;
    try {
      payload = await this.#http.request({
        url: `${this.#baseUrl}/station/${encodeURIComponent(id)}`,
        ...(this.#apiKey === undefined
          ? {}
          : { headers: { authorization: `Key ${this.#apiKey}` } }),
        signal,
      });
    } catch (error) {
      if (error instanceof FuelPricesError && error.status === 404) return null;
      throw error;
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new FuelPricesError('Expected the prix-carburants API to return an object.', {
        code: 'invalid_response',
      });
    }

    const name = (payload as StationBody).Brand?.name;
    return typeof name === 'string' ? name : null;
  }
}
