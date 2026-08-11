/** Thin, retrying HTTP layer over the Opendatasoft Explore API v2.1. */

import { FuelPricesError } from '../errors.js';

import type { RawStationRecord } from './dataset.js';

/** Minimal `fetch` contract, so a stub can be injected in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DatasetClientOptions {
  /** Explore API root. Defaults to the data.economie.gouv.fr portal. */
  baseUrl?: string;
  /** Dataset identifier. Defaults to the instant fuel-price feed. */
  dataset?: string;
  /** Replacement for the global `fetch` (tests, proxies, instrumentation). */
  fetch?: FetchLike;
  /** Per-attempt timeout, in ms. Defaults to 60 000. */
  timeoutMs?: number;
  /** Extra attempts after a retryable failure. Defaults to 2. */
  retries?: number;
}

export interface DatasetQuery {
  /** Comma-separated field list. */
  select?: string;
  /** ODSQL `where` predicate. */
  where?: string;
  signal?: AbortSignal;
}

const DEFAULT_BASE_URL = 'https://data.economie.gouv.fr/api/explore/v2.1';
const DEFAULT_DATASET = 'prix-des-carburants-en-france-flux-instantane-v2';
// A full export is generated server-side and regularly takes 10-20 s.
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

interface ApiErrorBody {
  error_code?: unknown;
  message?: unknown;
}

export class DatasetClient {
  readonly #baseUrl: string;
  readonly #dataset: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retries: number;

  constructor(options: DatasetClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#dataset = options.dataset ?? DEFAULT_DATASET;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);

    const globalFetch = globalThis.fetch as FetchLike | undefined;
    const impl = options.fetch ?? globalFetch;
    if (!impl) {
      throw new FuelPricesError(
        'No global fetch available; upgrade to Node.js >= 18 or pass `fetch` in the options.',
        { code: 'unsupported' },
      );
    }
    this.#fetch = impl;
  }

  /**
   * Reads the whole result set of a query in a single request.
   *
   * The `records` endpoint caps `offset + limit` at 10 000 while the dataset
   * holds ~9 800 stations, so paginating it would sit one growth spurt away from
   * silently truncating. `exports/json` has no such cap.
   */
  async exportStations(query: DatasetQuery = {}): Promise<RawStationRecord[]> {
    const url = new URL(`${this.#baseUrl}/catalog/datasets/${this.#dataset}/exports/json`);
    if (query.select) url.searchParams.set('select', query.select);
    if (query.where) url.searchParams.set('where', query.where);
    url.searchParams.set('timezone', 'UTC');

    const payload = await this.#requestJson(url.toString(), query.signal);
    if (!Array.isArray(payload)) {
      throw new FuelPricesError('Expected the export endpoint to return a JSON array.', {
        code: 'invalid_response',
      });
    }
    return payload as RawStationRecord[];
  }

  async #requestJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    let lastError: FuelPricesError | undefined;

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      if (attempt > 0) {
        await sleep(retryDelayMs(attempt, lastError), signal);
      }

      let response: Response;
      try {
        response = await this.#fetchWithTimeout(url, signal);
      } catch (error) {
        lastError = asRequestError(error, signal);
        if (lastError.code === 'aborted') throw lastError;
        continue;
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch (error) {
          throw new FuelPricesError('The API returned a body that is not valid JSON.', {
            code: 'invalid_response',
            status: response.status,
            cause: error,
          });
        }
      }

      lastError = await asHttpError(response);
      if (!RETRYABLE_STATUSES.has(response.status)) throw lastError;
    }

    throw (
      lastError ??
      new FuelPricesError('The request failed for an unknown reason.', { code: 'network' })
    );
  }

  async #fetchWithTimeout(url: string, signal: AbortSignal | undefined): Promise<Response> {
    // Checked before dispatching: an already-aborted caller should cost zero
    // requests, rather than rely on `fetch` rejecting on its own.
    if (signal?.aborted) {
      throw new FuelPricesError('The request was aborted by the caller.', {
        code: 'aborted',
        cause: signal.reason,
      });
    }

    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      controller.abort(
        new FuelPricesError(`Request timed out after ${this.#timeoutMs} ms.`, {
          code: 'timeout',
        }),
      );
    }, this.#timeoutMs);

    try {
      return await this.#fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** `Retry-After` is honoured when present, otherwise exponential backoff. */
function retryDelayMs(attempt: number, lastError: FuelPricesError | undefined): number {
  const retryAfter = lastError?.retryAfterMs;
  if (retryAfter !== undefined) return Math.min(retryAfter, RETRY_MAX_DELAY_MS);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new FuelPricesError('The request was aborted by the caller.', { code: 'aborted' }));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Turns a rejected `fetch` into an SDK error, telling timeouts from aborts. */
function asRequestError(error: unknown, signal: AbortSignal | undefined): FuelPricesError {
  if (error instanceof FuelPricesError) return error;
  if (signal?.aborted) {
    return new FuelPricesError('The request was aborted by the caller.', {
      code: 'aborted',
      cause: error,
    });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new FuelPricesError(`Could not reach the fuel-price API: ${reason}`, {
    code: 'network',
    cause: error,
  });
}

async function asHttpError(response: Response): Promise<FuelPricesError> {
  const body = await readErrorBody(response);
  const detail = typeof body?.message === 'string' ? ` — ${body.message}` : '';
  const apiCode = typeof body?.error_code === 'string' ? body.error_code : undefined;

  return new FuelPricesError(
    `The fuel-price API answered ${String(response.status)} ${response.statusText}${detail}`,
    { code: 'http', status: response.status, apiCode, retryAfterMs: parseRetryAfter(response) },
  );
}

async function readErrorBody(response: Response): Promise<ApiErrorBody | undefined> {
  try {
    const parsed = await response.json();
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
