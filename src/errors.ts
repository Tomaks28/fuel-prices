/** Machine-readable reason attached to every {@link FuelPricesError}. */
export type FuelPricesErrorCode =
  /** The API answered with a non-2xx status. `status` is set. */
  | 'http'
  /** The request never reached the API (DNS, TLS, offline, …). */
  | 'network'
  /** The request was aborted because it exceeded `timeoutMs`. */
  | 'timeout'
  /** The caller aborted the request through its own `AbortSignal`. */
  | 'aborted'
  /** The API answered 2xx with a body the SDK cannot make sense of. */
  | 'invalid_response'
  /** An argument handed to the SDK is unusable. */
  | 'invalid_argument'
  /** A {@link CacheStore} could not keep the snapshot. Never fatal to a sync. */
  | 'cache'
  /** The runtime lacks something the SDK needs, typically a global `fetch`. */
  | 'unsupported';

interface FuelPricesErrorOptions {
  code: FuelPricesErrorCode;
  /** HTTP status, when the failure came from a response. */
  status?: number | undefined;
  /** `error_code` reported by the Opendatasoft API, when it sent one. */
  apiCode?: string | undefined;
  /** `Retry-After` of the response, in ms, when it carried one. */
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

/** Every error thrown by this SDK is an instance of this class. */
export class FuelPricesError extends Error {
  override readonly name = 'FuelPricesError';

  readonly code: FuelPricesErrorCode;
  readonly status: number | undefined;
  readonly apiCode: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: FuelPricesErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.status = options.status;
    this.apiCode = options.apiCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}
