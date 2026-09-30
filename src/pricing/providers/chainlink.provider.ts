/**
 * ChainlinkProvider — EVM on-chain price oracle adapter (issue #424).
 *
 * Queries Chainlink Data Feeds via the AggregatorV3Interface JSON-RPC
 * `latestRoundData()` call, which is read-only and free.
 *
 * Reference: https://docs.chain.link/data-feeds/price-feeds
 *
 * Implementation:
 *   Rather than bundling a full Ethers.js/viem dependency for a single
 *   `eth_call`, this provider hand-crafts the minimal `eth_call` JSON-RPC
 *   payload.  The ABI for `latestRoundData()` is stable and has a single
 *   4-byte selector: `0xfeaf968c`.
 *
 *   Response ABI: (uint80 roundId, int256 answer, uint256 startedAt,
 *                  uint256 updatedAt, uint80 answeredInRound)
 *   — all packed as 32-byte words.  `answer` is already denominated in
 *   USD with `decimals()` precision (typically 8 for USD feeds).
 */

import { Logger } from "@nestjs/common";
import { HttpEgressService, EgressPurpose } from "../../common/http-egress";
import {
  PriceFeedProvider,
  PriceFeedQuote,
  PRICE_FEED_SCALE,
} from "../price-feed.provider";

/** ABI selector for `latestRoundData()` */
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";

/** ABI selector for `decimals()` */
const DECIMALS_SELECTOR = "0x313ce567";

/**
 * Well-known Chainlink USD price feed contract addresses.
 * Key: symbol, value: { [chainId]: address }.
 * Addresses are checksummed but eth_call accepts lowercase.
 */
export const CHAINLINK_FEEDS: Record<string, Record<number, string>> = {
  ETH: {
    1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",   // Ethereum mainnet ETH/USD
    8453: "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70", // Base ETH/USD
  },
  BTC: {
    1: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",   // Ethereum mainnet BTC/USD
  },
  USDC: {
    1: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",   // Ethereum mainnet USDC/USD
  },
  USDT: {
    1: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",   // Ethereum mainnet USDT/USD
  },
  MATIC: {
    137: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0", // Polygon MATIC/USD
  },
  LINK: {
    1: "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c",   // Ethereum mainnet LINK/USD
  },
  WETH: {
    1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",   // Same as ETH
    8453: "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70",
  },
  WBTC: {
    1: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",   // Same as BTC
  },
};

/** JSON-RPC response shape. */
interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: { code: number; message: string };
}

/**
 * Price-feed provider that queries Chainlink Data Feed contracts directly
 * via JSON-RPC eth_call — no third-party SDK required.
 *
 * Supports: ETH/WETH, BTC/WBTC, USDC, USDT, MATIC, LINK.
 * Returns prices in {@link PRICE_FEED_SCALE} (1e18) bigint fixed-point.
 */
export class ChainlinkProvider implements PriceFeedProvider {
  readonly name = "chainlink";

  readonly supportedSymbols: ReadonlySet<string> = new Set(
    Object.keys(CHAINLINK_FEEDS),
  );

  private readonly logger = new Logger(ChainlinkProvider.name);
  private readonly cache = new Map<string, { quote: PriceFeedQuote; cachedAtMs: number }>();
  /** Cache of feed decimals to avoid an extra RPC round-trip per call. */
  private readonly decimalsCache = new Map<string, number>();

  constructor(
    private readonly http: HttpEgressService,
    /** EVM JSON-RPC endpoint URL (Ethereum mainnet by default). */
    private readonly rpcUrl: string,
    /** Chain ID — used to pick the right feed address. */
    private readonly chainId: number = 1,
  ) {}

  async getPrice(symbol: string, maxAgeMs: number): Promise<PriceFeedQuote> {
    const upper = symbol.toUpperCase();
    const feedsByChain = CHAINLINK_FEEDS[upper];
    if (!feedsByChain) {
      throw new Error(`ChainlinkProvider: no feed registered for symbol "${symbol}"`);
    }
    const feedAddress = feedsByChain[this.chainId];
    if (!feedAddress) {
      throw new Error(
        `ChainlinkProvider: no feed for "${symbol}" on chain ${this.chainId}`,
      );
    }

    // Cache check
    const cacheKey = `${upper}:${this.chainId}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.cachedAtMs < maxAgeMs) {
      return cached.quote;
    }

    try {
      const quote = await this.fetchFromChain(upper, feedAddress, cacheKey, now);
      this.cache.set(cacheKey, { quote, cachedAtMs: now });
      return quote;
    } catch (err) {
      if (cached) {
        this.logger.warn(
          `[chainlink] eth_call failed for ${symbol}, using stale cache: ${(err as Error).message}`,
        );
        return cached.quote;
      }
      throw err;
    }
  }

  private async fetchFromChain(
    symbol: string,
    feedAddress: string,
    _cacheKey: string,
    now: number,
  ): Promise<PriceFeedQuote> {
    // 1. Get decimals (cached after first call)
    const decimals = await this.getDecimals(feedAddress);

    // 2. Call latestRoundData()
    const roundDataHex = await this.ethCall(feedAddress, LATEST_ROUND_DATA_SELECTOR);

    // ABI decode (uint80, int256, uint256, uint256, uint80) — 5 × 32-byte words
    if (roundDataHex.length < 2 + 5 * 64) {
      throw new Error(
        `ChainlinkProvider: unexpected latestRoundData response length for ${symbol}`,
      );
    }

    const hex = roundDataHex.startsWith("0x") ? roundDataHex.slice(2) : roundDataHex;
    // answer is word index 1 (int256), updatedAt is word index 3 (uint256)
    const answerHex = hex.slice(64, 128);
    const updatedAtHex = hex.slice(192, 256);

    // int256: if sign bit set, it's negative (invalid price)
    const answerBig = BigInt("0x" + answerHex);
    if (answerBig >> 255n !== 0n) {
      throw new Error(`ChainlinkProvider: negative answer from feed for ${symbol}`);
    }
    if (answerBig === 0n) {
      throw new Error(`ChainlinkProvider: zero price from feed for ${symbol}`);
    }

    const updatedAtSec = BigInt("0x" + updatedAtHex);

    // Scale from feed decimals to PRICE_FEED_SCALE (1e18)
    const scale = PRICE_FEED_SCALE / 10n ** BigInt(decimals);
    const priceScaled = answerBig * scale;

    const quote: PriceFeedQuote = {
      symbol,
      priceScaled,
      fetchedAtMs: now,
      source: this.name,
      metadata: {
        feedAddress,
        chainId: this.chainId,
        decimals,
        updatedAtSec: updatedAtSec.toString(),
        rawAnswer: answerBig.toString(),
      },
    };

    // Staleness from the contract's own updatedAt (secondary guard)
    const contractAgeMs = (now / 1000 - Number(updatedAtSec)) * 1000;
    if (contractAgeMs > 3_600_000) {
      this.logger.warn(
        `[chainlink] feed for ${symbol} is ${Math.round(contractAgeMs / 60_000)} min stale on-chain`,
      );
    }

    return quote;
  }

  private async getDecimals(feedAddress: string): Promise<number> {
    const cached = this.decimalsCache.get(feedAddress);
    if (cached !== undefined) return cached;

    const hex = await this.ethCall(feedAddress, DECIMALS_SELECTOR);
    const decimals = Number(BigInt("0x" + (hex.startsWith("0x") ? hex.slice(2) : hex)));
    this.decimalsCache.set(feedAddress, decimals);
    return decimals;
  }

  private async ethCall(to: string, data: string): Promise<string> {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    });

    const response = await this.http.fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      purpose: EgressPurpose.RPC,
    });

    if (response.statusCode !== 200) {
      throw new Error(`ChainlinkProvider: JSON-RPC HTTP ${response.statusCode}`);
    }

    let rpc: JsonRpcResponse;
    try {
      rpc = JSON.parse(response.body) as JsonRpcResponse;
    } catch {
      throw new Error("ChainlinkProvider: invalid JSON-RPC response");
    }

    if (rpc.error) {
      throw new Error(`ChainlinkProvider: RPC error ${rpc.error.code}: ${rpc.error.message}`);
    }

    if (!rpc.result) {
      throw new Error("ChainlinkProvider: empty result from eth_call");
    }

    return rpc.result;
  }
}
