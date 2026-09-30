/**
 * CexAggregatorProvider — CoinGecko / aggregator REST API adapter (issue #424).
 *
 * Uses the CoinGecko public API (no API key required for the free tier) as the
 * off-chain price aggregator source.  With an API key (`COINGECKO_API_KEY`)
 * the provider upgrades to the Pro endpoint for higher rate limits.
 *
 * Supports all symbols for which a CoinGecko ID mapping is registered.
 * New symbols can be added by extending `COINGECKO_IDS`.
 *
 * Rate-limit strategy:
 *   Free tier: 30 req/min.  The provider batches all symbol lookups into a
 *   single `/simple/price` call and caches the result for `maxAgeMs`.
 *   If a per-symbol call is requested and the batch cache is fresh, the result
 *   is served from cache without an extra network call.
 */

import { Logger } from "@nestjs/common";
import { HttpEgressService, EgressPurpose } from "../../common/http-egress";
import {
  PriceFeedProvider,
  PriceFeedQuote,
  PRICE_FEED_SCALE,
} from "../price-feed.provider";

// ---------------------------------------------------------------------------
// CoinGecko asset ID map
// ---------------------------------------------------------------------------

/**
 * Map from token symbol to CoinGecko `id` parameter.
 * Extend this map to support additional tokens.
 */
export const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  WBTC: "wrapped-bitcoin",
  ETH: "ethereum",
  WETH: "weth",
  XLM: "stellar",
  USDC: "usd-coin",
  USDT: "tether",
  MATIC: "matic-network",
  LINK: "chainlink",
  SOL: "solana",
  AVAX: "avalanche-2",
  OP: "optimism",
  ARB: "arbitrum",
};

// ---------------------------------------------------------------------------
// CoinGecko API types
// ---------------------------------------------------------------------------

/** Shape of `/simple/price?ids=...&vs_currencies=usd&include_last_updated_at=true`. */
type CoinGeckoPriceResponse = Record<
  string,
  { usd?: number; usd_24h_vol?: number; last_updated_at?: number }
>;

// ---------------------------------------------------------------------------
// Stablecoin de-peg detection
// ---------------------------------------------------------------------------

/**
 * Symbols considered stablecoins pegged to USD at 1.00.
 * Deviation beyond `DEPEG_THRESHOLD_BPS` triggers a warning.
 */
const STABLECOINS = new Set(["USDC", "USDT", "DAI", "BUSD", "TUSD"]);
const DEPEG_THRESHOLD_BPS = 100n; // 1% — alert on anything beyond 1 cent off peg

/**
 * Price-feed provider that queries the CoinGecko simple price API.
 *
 * Supports: all symbols listed in {@link COINGECKO_IDS}.
 * Returns prices in {@link PRICE_FEED_SCALE} (1e18) bigint fixed-point.
 */
export class CexAggregatorProvider implements PriceFeedProvider {
  readonly name = "coingecko";

  /** Accept all symbols — the ID map acts as the actual filter. */
  readonly supportedSymbols: "*" = "*";

  private readonly logger = new Logger(CexAggregatorProvider.name);

  /** Batch price cache: symbol → { quote, cachedAtMs }. */
  private readonly cache = new Map<string, { quote: PriceFeedQuote; cachedAtMs: number }>();
  /** In-flight batch fetch promise to avoid duplicate concurrent requests. */
  private batchInFlight: Promise<void> | null = null;
  private lastBatchAtMs = 0;

  constructor(
    private readonly http: HttpEgressService,
    private readonly apiBase = "https://api.coingecko.com/api/v3",
    /** Optional CoinGecko API key for Pro tier. */
    private readonly apiKey?: string,
  ) {}

  async getPrice(symbol: string, maxAgeMs: number): Promise<PriceFeedQuote> {
    const upper = symbol.toUpperCase();
    const coinId = COINGECKO_IDS[upper];
    if (!coinId) {
      throw new Error(`CexAggregatorProvider: no CoinGecko ID for symbol "${symbol}"`);
    }

    const now = Date.now();
    const cached = this.cache.get(upper);
    if (cached && now - cached.cachedAtMs < maxAgeMs) {
      return cached.quote;
    }

    // Trigger a batch refresh (deduped by in-flight promise)
    await this.refreshBatch(maxAgeMs, now);

    const fresh = this.cache.get(upper);
    if (fresh) return fresh.quote;

    throw new Error(
      `CexAggregatorProvider: price for "${symbol}" not available after batch refresh`,
    );
  }

  // ---------------------------------------------------------------------------
  // Batch fetch
  // ---------------------------------------------------------------------------

  private async refreshBatch(maxAgeMs: number, now: number): Promise<void> {
    // Deduplicate concurrent callers
    if (this.batchInFlight) {
      return this.batchInFlight;
    }

    // Don't hammer the API if the batch is still fresh
    if (now - this.lastBatchAtMs < maxAgeMs / 2) {
      return;
    }

    this.batchInFlight = this.doFetchBatch(now).finally(() => {
      this.batchInFlight = null;
    });

    return this.batchInFlight;
  }

  private async doFetchBatch(now: number): Promise<void> {
    const ids = Object.values(COINGECKO_IDS).join(",");
    const params = new URLSearchParams({
      ids,
      vs_currencies: "usd",
      include_last_updated_at: "true",
    });

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["x-cg-pro-api-key"] = this.apiKey;
    }

    const url = `${this.apiBase}/simple/price?${params.toString()}`;

    let response;
    try {
      response = await this.http.fetch(url, {
        method: "GET",
        headers,
        purpose: EgressPurpose.ORACLE,
      });
    } catch (err) {
      throw new Error(
        `CexAggregatorProvider: HTTP fetch failed: ${(err as Error).message}`,
      );
    }

    if (response.statusCode === 429) {
      throw new Error("CexAggregatorProvider: rate-limited by CoinGecko (429)");
    }
    if (response.statusCode !== 200) {
      throw new Error(`CexAggregatorProvider: HTTP ${response.statusCode}`);
    }

    let parsed: CoinGeckoPriceResponse;
    try {
      parsed = JSON.parse(response.body) as CoinGeckoPriceResponse;
    } catch {
      throw new Error("CexAggregatorProvider: invalid JSON from CoinGecko");
    }

    // Populate cache for each known symbol
    for (const [symbol, coinId] of Object.entries(COINGECKO_IDS)) {
      const entry = parsed[coinId];
      if (!entry?.usd || !Number.isFinite(entry.usd) || entry.usd <= 0) {
        this.logger.warn(`[coingecko] missing/invalid price for ${symbol} (id=${coinId})`);
        continue;
      }

      const priceScaled = floatToScale(entry.usd);

      // Stablecoin de-peg detection
      if (STABLECOINS.has(symbol)) {
        const oneUsd = PRICE_FEED_SCALE;
        const diff = priceScaled > oneUsd ? priceScaled - oneUsd : oneUsd - priceScaled;
        const depegBps = (diff * 10_000n) / oneUsd;
        if (depegBps > DEPEG_THRESHOLD_BPS) {
          this.logger.error(
            `[coingecko] DEPEG ALERT: ${symbol} is ${depegBps} bps from peg (price=${entry.usd})`,
          );
        }
      }

      const fetchedAtMs = entry.last_updated_at
        ? entry.last_updated_at * 1000
        : now;

      const quote: PriceFeedQuote = {
        symbol,
        priceScaled,
        fetchedAtMs,
        source: this.name,
        metadata: { coinId, rawUsd: entry.usd },
      };

      this.cache.set(symbol, { quote, cachedAtMs: now });
    }

    this.lastBatchAtMs = now;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a plain float USD price to {@link PRICE_FEED_SCALE} bigint (1e18).
 * Uses a 12-digit fixed string to avoid IEEE-754 drift.
 */
function floatToScale(price: number): bigint {
  const str = price.toFixed(12);
  const [whole, frac = ""] = str.split(".");
  const fracPadded = frac.padEnd(12, "0").slice(0, 12);
  const at12 = BigInt(whole) * 1_000_000_000_000n + BigInt(fracPadded);
  return at12 * 1_000_000n;
}
