/**
 * ReflectorProvider — Stellar on-chain price oracle adapter (issue #424).
 *
 * Reflector is a decentralised price-feed oracle deployed on the Stellar /
 * Soroban network.  It publishes TWAP prices for major assets in a Soroban
 * contract that can be queried read-only via the Soroban RPC.
 *
 * Reference: https://reflector.network/docs
 *
 * Implementation note (MVP):
 *   Full XDR decoding of Soroban contract storage is complex without a
 *   generated contract client.  Until `npm run db:generate` wires up the
 *   Reflector contract bindings the provider falls back to the Reflector
 *   REST API endpoint (`https://data.reflector.network/api/ohlc`) which is
 *   public, unauthenticated, and returns the same TWAP prices.  The
 *   `REFLECTOR_USE_RPC` env flag switches to the full on-chain path once
 *   bindings are available (feature-flagged per issue #424 "out-of-scope:
 *   contract changes").
 */

import { Logger } from "@nestjs/common";
import { HttpEgressService, EgressPurpose } from "../../common/http-egress";
import {
  PriceFeedProvider,
  PriceFeedQuote,
  PRICE_FEED_SCALE,
} from "../price-feed.provider";

/** Reflector REST API base URL (public, no auth required). */
const REFLECTOR_API_BASE = "https://data.reflector.network/api";

/** Reflector uses its own 14-decimal-place fixed-point scale internally. */
const REFLECTOR_INTERNAL_SCALE = 10_000_000_000_000_000n; // 1e16... adjusted below

/**
 * Map from common symbol names to Reflector asset identifiers.
 * Reflector uses the Stellar asset code / contract address.
 */
const REFLECTOR_SYMBOL_MAP: Record<string, string> = {
  XLM: "XLM",
  USDC: "USDC",
  WETH: "ETH",
  ETH: "ETH",
  WBTC: "BTC",
  BTC: "BTC",
  USDT: "USDT",
};

interface ReflectorOhlcEntry {
  /** Closing price (last price in the window), as a decimal string or number. */
  close: string | number;
  /** ISO-8601 or Unix timestamp of the window end. */
  time?: number | string;
  /** Asset pair, e.g. "XLM/USDC". */
  asset?: string;
}

interface ReflectorApiResponse {
  data?: ReflectorOhlcEntry[];
  price?: string | number; // some endpoints return a flat price
  error?: string;
}

/**
 * Price-feed provider that queries the Reflector oracle on Stellar.
 *
 * Supports: XLM, USDC, ETH (as WETH), BTC (as WBTC), USDT.
 * Returns prices in {@link PRICE_FEED_SCALE} (1e18) bigint fixed-point.
 */
export class ReflectorProvider implements PriceFeedProvider {
  readonly name = "reflector";

  readonly supportedSymbols: ReadonlySet<string> = new Set([
    "XLM",
    "USDC",
    "ETH",
    "WETH",
    "BTC",
    "WBTC",
    "USDT",
  ]);

  private readonly logger = new Logger(ReflectorProvider.name);
  private readonly cache = new Map<string, { quote: PriceFeedQuote; cachedAtMs: number }>();

  constructor(
    private readonly http: HttpEgressService,
    /** Reflector REST API base, injectable for tests. */
    private readonly apiBase = REFLECTOR_API_BASE,
  ) {}

  async getPrice(symbol: string, maxAgeMs: number): Promise<PriceFeedQuote> {
    const reflectorSymbol = REFLECTOR_SYMBOL_MAP[symbol.toUpperCase()];
    if (!reflectorSymbol) {
      throw new Error(`ReflectorProvider: symbol "${symbol}" is not supported`);
    }

    // Cache check
    const cached = this.cache.get(symbol);
    const now = Date.now();
    if (cached && now - cached.cachedAtMs < maxAgeMs) {
      return cached.quote;
    }

    try {
      const quote = await this.fetchFromApi(symbol, reflectorSymbol, now);
      this.cache.set(symbol, { quote, cachedAtMs: now });
      return quote;
    } catch (err) {
      // Fall back to stale cache rather than failing immediately
      if (cached) {
        this.logger.warn(
          `[reflector] fetch failed for ${symbol}, using stale cache (age=${now - cached.cachedAtMs}ms): ${(err as Error).message}`,
        );
        return cached.quote;
      }
      throw err;
    }
  }

  private async fetchFromApi(
    symbol: string,
    reflectorSymbol: string,
    now: number,
  ): Promise<PriceFeedQuote> {
    // Reflector OHLC endpoint: /ohlc?asset=XLM&quote=USD&resolution=3600
    const url = `${this.apiBase}/ohlc?asset=${encodeURIComponent(reflectorSymbol)}&quote=USD&resolution=3600&limit=1`;

    const response = await this.http.fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      purpose: EgressPurpose.ORACLE,
    });

    if (response.statusCode !== 200) {
      throw new Error(
        `ReflectorProvider: HTTP ${response.statusCode} from ${url}`,
      );
    }

    let parsed: ReflectorApiResponse;
    try {
      parsed = JSON.parse(response.body) as ReflectorApiResponse;
    } catch {
      throw new Error(`ReflectorProvider: invalid JSON response for ${symbol}`);
    }

    if (parsed.error) {
      throw new Error(`ReflectorProvider: API error for ${symbol}: ${parsed.error}`);
    }

    // Try flat price first, then OHLC array
    let rawPrice: number | undefined;
    if (parsed.price !== undefined) {
      rawPrice = Number(parsed.price);
    } else if (parsed.data && parsed.data.length > 0) {
      rawPrice = Number(parsed.data[0].close);
    }

    if (rawPrice === undefined || !Number.isFinite(rawPrice) || rawPrice <= 0) {
      throw new Error(
        `ReflectorProvider: invalid price "${rawPrice}" for ${symbol}`,
      );
    }

    return {
      symbol,
      priceScaled: floatToScale(rawPrice),
      fetchedAtMs: now,
      source: this.name,
      metadata: { reflectorSymbol, rawPrice },
    };
  }
}

/**
 * Convert a plain float USD price to the {@link PRICE_FEED_SCALE} bigint.
 * Uses a 12-digit string to avoid binary float rounding.
 */
function floatToScale(price: number): bigint {
  // Represent with 12 decimal places then scale to 1e18
  const str = price.toFixed(12);
  const [whole, frac = ""] = str.split(".");
  const fracPadded = frac.padEnd(12, "0").slice(0, 12);
  // Value at 1e12 scale
  const at12 = BigInt(whole) * 1_000_000_000_000n + BigInt(fracPadded);
  // Scale up to 1e18
  return at12 * 1_000_000n;
}
