/**
 * PriceFeedProvider — interface and shared types for the multi-source price
 * oracle (issue #424).
 *
 * All monetary values in this module are `bigint` fixed-point at
 * `PRICE_FEED_SCALE` (1 × 10^18) precision so every arithmetic path stays
 * outside IEEE-754 float territory.
 *
 * Design contract
 * ────────────────
 * • Providers MUST return a `PriceFeedQuote` on success.
 * • Providers MUST throw (or let the promise reject) when the feed is
 *   unreachable or returns a clearly invalid value.  The aggregator treats
 *   any rejection as "source down" and applies fail-closed logic.
 * • Providers MUST set `fetchedAtMs` to the wall-clock time at which the
 *   price was actually retrieved (not a cached timestamp from a prior call).
 * • Providers MAY cache internally but MUST honour the `maxAgeMs` hint
 *   passed by the caller: if the cached value is older than `maxAgeMs` the
 *   provider should attempt a refresh and only fall back to the stale cache
 *   when the network call also fails (in which case the returned
 *   `fetchedAtMs` is the *original* cache timestamp so the aggregator can
 *   apply its own staleness guard).
 */

// ---------------------------------------------------------------------------
// Scale constant
// ---------------------------------------------------------------------------

/**
 * All prices returned by providers use this fixed-point scale.
 *
 * `1 USD` is represented as `1_000_000_000_000_000_000n` (1e18).
 *
 * Using 1e18 matches the convention in Solidity/Chainlink so values from the
 * EVM oracle can be forwarded without a conversion step.  The aggregator
 * performs all deviationChecks and median computation at this scale and only
 * converts to the legacy `USD_PRICE_SCALE` (1e8) at the boundary with
 * `min-dst-amount.validation.ts`.
 */
export const PRICE_FEED_SCALE = 1_000_000_000_000_000_000n; // 1e18

// ---------------------------------------------------------------------------
// Quote type
// ---------------------------------------------------------------------------

/**
 * A single price observation returned by one provider for one token symbol.
 */
export interface PriceFeedQuote {
  /** Token symbol this quote is for (e.g. "USDC", "ETH", "XLM"). */
  symbol: string;
  /**
   * USD price in {@link PRICE_FEED_SCALE} fixed-point units.
   * Must be > 0.  Providers that receive a zero or negative value from their
   * upstream feed MUST throw rather than returning it.
   */
  priceScaled: bigint;
  /**
   * Wall-clock milliseconds at which the price was fetched from the upstream
   * source (not from an internal cache).
   */
  fetchedAtMs: number;
  /**
   * Human-readable source identifier for logging and deviation reporting.
   * Convention: `"reflector"`, `"chainlink"`, `"coingecko"`, etc.
   */
  source: string;
  /**
   * Optional extra metadata from the provider (e.g. Chainlink round ID,
   * Reflector sequence number).  Kept opaque so the aggregator does not
   * need to know provider internals.
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Aggregation result
// ---------------------------------------------------------------------------

/**
 * Result shape returned by `AggregatorService.getPrice()`.
 *
 * Acceptance criteria from issue #424:
 *   - `price`      the median USD price in {@link PRICE_FEED_SCALE}
 *   - `sources`    every healthy quote that contributed (outliers excluded)
 *   - `deviation`  max spread among healthy sources (bps)
 *   - `updatedAt`  oldest `fetchedAtMs` among contributing sources
 */
export interface AggregatedPrice {
  symbol: string;
  /** Median of all non-outlier source prices, in {@link PRICE_FEED_SCALE}. */
  price: bigint;
  /** Quotes from healthy sources that contributed to the median. */
  sources: PriceFeedQuote[];
  /**
   * Maximum deviation among contributing sources expressed in basis points
   * relative to the median.
   * `deviation = max(|source_i − median|) / median * 10_000`.
   */
  deviationBps: number;
  /**
   * Earliest `fetchedAtMs` across all contributing sources.
   * Callers should compare this against their `maxAgeMs` budget.
   */
  updatedAtMs: number;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Contract that every concrete price-feed adapter must satisfy.
 *
 * The aggregator discovers providers via the `PRICE_FEED_PROVIDERS` injection
 * token (an array).  Each provider is queried concurrently; slow providers
 * time out and are treated as down.
 */
export interface PriceFeedProvider {
  /**
   * Unique, stable name for this provider.
   * Used in logs, metrics, and `PriceFeedQuote.source`.
   */
  readonly name: string;

  /**
   * Supported token symbols.  The aggregator will only call `getPrice` for
   * symbols in this set.  Return `["*"]` to indicate "all symbols" (REST
   * aggregators such as CoinGecko).
   */
  readonly supportedSymbols: ReadonlySet<string> | "*";

  /**
   * Fetch the current USD price for `symbol`.
   *
   * @param symbol   Token symbol, e.g. `"USDC"`, `"ETH"`, `"XLM"`.
   * @param maxAgeMs Maximum acceptable age of a cached response (ms).
   *                 The provider SHOULD attempt a fresh fetch if its cached
   *                 value is older than this.
   * @throws         Any error means this source is treated as down.
   */
  getPrice(symbol: string, maxAgeMs: number): Promise<PriceFeedQuote>;
}

// ---------------------------------------------------------------------------
// Injection token
// ---------------------------------------------------------------------------

/**
 * NestJS injection token for the ordered list of {@link PriceFeedProvider}
 * instances.  Modules register providers like:
 *
 * ```ts
 * { provide: PRICE_FEED_PROVIDERS, useFactory: (...) => [...], multi: false }
 * ```
 */
export const PRICE_FEED_PROVIDERS = Symbol("PRICE_FEED_PROVIDERS");
