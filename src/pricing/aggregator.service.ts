/**
 * AggregatorService — multi-source price oracle with median aggregation
 * and staleness guards (issue #424).
 *
 * Design
 * ──────
 * 1. Fan out concurrent `getPrice(symbol, maxAgeMs)` calls to every registered
 *    provider that supports the requested symbol.
 * 2. Collect settled quotes; mark timed-out or rejected calls as "source down".
 * 3. Reject outliers: any source whose price deviates > MAX_SOURCE_DEVIATION_BPS
 *    from the initial median is excluded.
 * 4. Fail closed: fewer than MIN_HEALTHY_SOURCES healthy quotes → throw.
 * 5. Return median price, contributing sources, max deviation (bps), and
 *    the oldest `fetchedAtMs` among contributors.
 *
 * The result is also back-projected into the legacy `PriceSnapshot` shape
 * consumed by `validateMinDstAmount`, so no changes are needed in callers.
 */

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { TokensService } from "../tokens/tokens.service";
import { SupportedChain } from "../intents/intents.types";
import {
  PriceSnapshot,
  usdPriceToScale,
  USD_PRICE_SCALE,
} from "./min-dst-amount.validation";
import {
  PriceFeedProvider,
  PriceFeedQuote,
  AggregatedPrice,
  PRICE_FEED_SCALE,
  PRICE_FEED_PROVIDERS,
} from "../tokens/price-feed.provider";

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/**
 * Maximum allowed deviation of any single source from the computed median,
 * in basis points.  Sources beyond this are treated as outliers and excluded.
 * Default: 200 bps (2 %).
 */
export const MAX_SOURCE_DEVIATION_BPS = 200n;

/**
 * Minimum number of healthy (non-outlier) sources required to return a price.
 * Fewer → fail closed.
 */
export const MIN_HEALTHY_SOURCES = 2;

/**
 * Provider query timeout in ms.  Providers that take longer are treated as
 * down for this cycle; their result is not awaited further.
 */
const PROVIDER_TIMEOUT_MS = 5_000;

/**
 * Default maximum price age before a snapshot is considered stale.
 * Callers may override per-request.
 */
export const DEFAULT_MAX_AGE_MS = 60_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);

  constructor(
    /** Legacy token registry — used as fallback when all feeds are down. */
    private readonly tokens: TokensService,
    /**
     * Ordered list of live price-feed providers.
     * Injected as an array via {@link PRICE_FEED_PROVIDERS}.
     * `@Optional()` so the service still compiles when only the in-memory
     * fallback is wired (test / dev environments).
     */
    @Optional()
    @Inject(PRICE_FEED_PROVIDERS)
    private readonly providers: PriceFeedProvider[] = [],
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch and aggregate the current USD price for `symbol` from all
   * registered providers.
   *
   * @param symbol    Token symbol, e.g. `"USDC"`, `"ETH"`, `"XLM"`.
   * @param maxAgeMs  Maximum acceptable age of any contributing quote (ms).
   *                  Defaults to {@link DEFAULT_MAX_AGE_MS}.
   * @throws          When fewer than {@link MIN_HEALTHY_SOURCES} healthy
   *                  quotes are available (fail closed).
   */
  async getAggregatedPrice(
    symbol: string,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  ): Promise<AggregatedPrice> {
    const upper = symbol.toUpperCase();
    const now = Date.now();

    // 1. Fan out to all relevant providers concurrently
    const quotes = await this.fanOut(upper, maxAgeMs);

    if (quotes.length === 0) {
      throw new Error(
        `AggregatorService: no providers available for symbol "${upper}"`,
      );
    }

    // 2. Staleness filter — discard quotes older than maxAgeMs
    const fresh = quotes.filter((q) => now - q.fetchedAtMs <= maxAgeMs);
    if (fresh.length === 0) {
      throw new Error(
        `AggregatorService: all quotes for "${upper}" are stale (maxAgeMs=${maxAgeMs})`,
      );
    }

    // 3. Compute initial median over all fresh quotes
    const initialMedian = median(fresh.map((q) => q.priceScaled));

    // 4. Outlier rejection
    const healthy = fresh.filter((q) => {
      const diff = q.priceScaled > initialMedian
        ? q.priceScaled - initialMedian
        : initialMedian - q.priceScaled;
      const devBps = initialMedian > 0n ? (diff * 10_000n) / initialMedian : 0n;
      if (devBps > MAX_SOURCE_DEVIATION_BPS) {
        this.logger.warn(
          `[aggregator] outlier rejected: ${q.source} reports ${q.priceScaled} ` +
            `(${devBps} bps from median ${initialMedian}) for ${upper}`,
        );
        return false;
      }
      return true;
    });

    // 5. Fail closed: fewer than MIN_HEALTHY_SOURCES
    if (healthy.length < MIN_HEALTHY_SOURCES) {
      throw new Error(
        `AggregatorService: only ${healthy.length} healthy source(s) for "${upper}" ` +
          `(minimum ${MIN_HEALTHY_SOURCES}); failing closed`,
      );
    }

    // 6. Final median over healthy sources
    const finalPrice = median(healthy.map((q) => q.priceScaled));

    // 7. Compute max deviation among healthy sources
    const deviationBps = computeMaxDeviationBps(healthy, finalPrice);

    // 8. updatedAt = oldest fetchedAtMs among contributors
    const updatedAtMs = Math.min(...healthy.map((q) => q.fetchedAtMs));

    return {
      symbol: upper,
      price: finalPrice,
      sources: healthy,
      deviationBps,
      updatedAtMs,
    };
  }

  /**
   * Back-compat: builds the `PriceSnapshot` shape consumed by
   * `validateMinDstAmount`.  Falls back to the token registry when all
   * live feeds are down (fail-open behaviour for small notionals).
   */
  async getPriceSnapshot(params: {
    srcChain: SupportedChain;
    srcTokenAddress: string;
    dstTokenContract: string;
    nowMs?: number;
  }): Promise<PriceSnapshot> {
    const nowMs = params.nowMs ?? Date.now();

    // Resolve token metadata from registry to get symbols
    const src = await this.tokens.resolveSrcToken(
      params.srcChain,
      params.srcTokenAddress,
    );
    const dst = await this.tokens.resolveDstToken(params.dstTokenContract);

    let srcPriceUsd: bigint | null = null;
    let dstPriceUsd: bigint | null = null;

    // Try live aggregation first, fall back to registry
    if (src && this.providers.length > 0) {
      try {
        const agg = await this.getAggregatedPrice(src.symbol, DEFAULT_MAX_AGE_MS);
        srcPriceUsd = scaleFeedToLegacy(agg.price);
      } catch (err) {
        this.logger.warn(
          `[aggregator] live feed failed for src token ${src.symbol}, falling back to registry: ${(err as Error).message}`,
        );
        srcPriceUsd = src.priceUSD ? usdPriceToScale(src.priceUSD) : null;
      }
    } else if (src) {
      srcPriceUsd = src.priceUSD ? usdPriceToScale(src.priceUSD) : null;
    }

    if (dst && this.providers.length > 0) {
      try {
        const agg = await this.getAggregatedPrice(dst.symbol, DEFAULT_MAX_AGE_MS);
        dstPriceUsd = scaleFeedToLegacy(agg.price);
      } catch (err) {
        this.logger.warn(
          `[aggregator] live feed failed for dst token ${dst.symbol}, falling back to registry: ${(err as Error).message}`,
        );
        dstPriceUsd = dst.priceUSD ? usdPriceToScale(dst.priceUSD) : null;
      }
    } else if (dst) {
      dstPriceUsd = dst.priceUSD ? usdPriceToScale(dst.priceUSD) : null;
    }

    return { srcPriceUsd, dstPriceUsd, asOfMs: nowMs };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Fan out `getPrice()` calls to all providers that support `symbol`,
   * with a per-provider timeout.  Returns only successful quotes.
   */
  private async fanOut(symbol: string, maxAgeMs: number): Promise<PriceFeedQuote[]> {
    const eligible = this.providers.filter((p) => {
      if (p.supportedSymbols === "*") return true;
      return (p.supportedSymbols as ReadonlySet<string>).has(symbol);
    });

    if (eligible.length === 0) {
      this.logger.debug(`[aggregator] no providers registered for "${symbol}"`);
      return [];
    }

    const results = await Promise.allSettled(
      eligible.map((p) =>
        Promise.race([
          p.getPrice(symbol, maxAgeMs),
          timeout(PROVIDER_TIMEOUT_MS, `provider "${p.name}" timed out`),
        ]),
      ),
    );

    const quotes: PriceFeedQuote[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        quotes.push(result.value);
      } else {
        this.logger.warn(
          `[aggregator] provider "${eligible[i].name}" failed for "${symbol}": ${result.reason as string}`,
        );
      }
    }
    return quotes;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Compute the median of a non-empty array of bigints. */
export function median(values: bigint[]): bigint {
  if (values.length === 0) throw new RangeError("median: empty array");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  // Even number: average of the two middle values (bigint safe)
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

/** Maximum deviation in bps of any healthy source from the final median. */
function computeMaxDeviationBps(sources: PriceFeedQuote[], medianPrice: bigint): number {
  if (medianPrice === 0n) return 0;
  let maxBps = 0n;
  for (const q of sources) {
    const diff = q.priceScaled > medianPrice
      ? q.priceScaled - medianPrice
      : medianPrice - q.priceScaled;
    const bps = (diff * 10_000n) / medianPrice;
    if (bps > maxBps) maxBps = bps;
  }
  return Number(maxBps);
}

/**
 * Convert from {@link PRICE_FEED_SCALE} (1e18) to the legacy
 * {@link USD_PRICE_SCALE} (1e8) used by `validateMinDstAmount`.
 */
function scaleFeedToLegacy(priceScaled: bigint): bigint {
  // 1e18 → 1e8: divide by 1e10
  return priceScaled / 10_000_000_000n;
}

/** Returns a promise that rejects after `ms` milliseconds. */
function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message)), ms),
  );
}
