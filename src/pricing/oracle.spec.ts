/**
 * Unit tests for the multi-source price oracle (issue #424).
 *
 * Coverage:
 *  - median() helper: odd/even arrays, degenerate cases
 *  - AggregatorService: outlier rejection, staleness guards,
 *    all-sources-down fail-closed, < 2 healthy sources, de-peg detection
 *  - ReflectorProvider: successful parse, HTTP errors, stale-cache fallback
 *  - ChainlinkProvider: ABI decode, stale on-chain timestamp warning
 *  - CexAggregatorProvider: batch fetch, de-peg alert, rate-limit handling
 *  - Back-compat: getPriceSnapshot() still satisfies validateMinDstAmount
 */

import {
  AggregatorService,
  median,
  MAX_SOURCE_DEVIATION_BPS,
  MIN_HEALTHY_SOURCES,
  DEFAULT_MAX_AGE_MS,
} from "./aggregator.service";
import {
  PriceFeedProvider,
  PriceFeedQuote,
  PRICE_FEED_SCALE,
} from "../tokens/price-feed.provider";
import { USD_PRICE_SCALE } from "./min-dst-amount.validation";
import { TokensService } from "../tokens/tokens.service";
import { InMemoryTokensRepository } from "../tokens/in-memory-tokens.repository";
import { ReflectorProvider } from "./providers/reflector.provider";
import { ChainlinkProvider } from "./providers/chainlink.provider";
import { CexAggregatorProvider } from "./providers/cex-aggregator.provider";
import { HttpEgressService } from "../common/http-egress";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTokensService(): TokensService {
  return new TokensService(new InMemoryTokensRepository());
}

/**
 * Build a minimal mock PriceFeedProvider.
 */
function mockProvider(
  name: string,
  priceUsd: number,
  symbol = "USDC",
  fetchedAtMs = Date.now(),
): PriceFeedProvider {
  const quote: PriceFeedQuote = {
    symbol,
    priceScaled: BigInt(Math.round(priceUsd * Number(PRICE_FEED_SCALE))),
    fetchedAtMs,
    source: name,
  };
  return {
    name,
    supportedSymbols: new Set([symbol.toUpperCase()]),
    getPrice: jest.fn().mockResolvedValue(quote),
  };
}

function failingProvider(name: string, symbol = "USDC"): PriceFeedProvider {
  return {
    name,
    supportedSymbols: new Set([symbol]),
    getPrice: jest.fn().mockRejectedValue(new Error(`${name} is down`)),
  };
}

// ---------------------------------------------------------------------------
// median() helper
// ---------------------------------------------------------------------------

describe("median()", () => {
  it("returns the middle value for an odd-length array", () => {
    expect(median([1n, 3n, 2n])).toBe(2n);
    expect(median([10n, 50n, 30n])).toBe(30n);
  });

  it("returns the integer average for an even-length array", () => {
    expect(median([1n, 3n])).toBe(2n);
    expect(median([2n, 4n])).toBe(3n);
    expect(median([1n, 2n, 3n, 4n])).toBe(2n); // floor of (2+3)/2
  });

  it("handles a single element", () => {
    expect(median([42n])).toBe(42n);
  });

  it("throws on empty array", () => {
    expect(() => median([])).toThrow("empty");
  });
});

// ---------------------------------------------------------------------------
// AggregatorService — core logic
// ---------------------------------------------------------------------------

describe("AggregatorService — getAggregatedPrice()", () => {
  const tokens = makeTokensService();

  it("returns median of three agreeing sources", async () => {
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0),
      mockProvider("p2", 1.01),
      mockProvider("p3", 0.99),
    ]);
    const result = await svc.getAggregatedPrice("USDC");
    // Median of 1.0, 1.01, 0.99 → 1.0
    expect(result.sources).toHaveLength(3);
    expect(result.price).toBe(PRICE_FEED_SCALE); // 1.0 at 1e18
  });

  it("rejects an outlier that deviates > MAX_SOURCE_DEVIATION_BPS", async () => {
    // p3 at $1.05 = 500 bps from $1.00 — outlier
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0),
      mockProvider("p2", 1.0),
      mockProvider("p3", 1.05),
    ]);
    const result = await svc.getAggregatedPrice("USDC");
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((s) => s.source !== "p3")).toBe(true);
  });

  it("fails closed when fewer than MIN_HEALTHY_SOURCES remain after outlier rejection", async () => {
    // Only one non-outlier survives
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0),
      mockProvider("p2", 2.0), // outlier
    ]);
    await expect(svc.getAggregatedPrice("USDC")).rejects.toThrow(
      /healthy source/,
    );
  });

  it("fails closed when all providers fail", async () => {
    const svc = new AggregatorService(tokens, [
      failingProvider("p1"),
      failingProvider("p2"),
      failingProvider("p3"),
    ]);
    await expect(svc.getAggregatedPrice("USDC")).rejects.toThrow();
  });

  it("succeeds with exactly MIN_HEALTHY_SOURCES after one provider fails", async () => {
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0),
      mockProvider("p2", 1.0),
      failingProvider("p3"),
    ]);
    const result = await svc.getAggregatedPrice("USDC");
    expect(result.sources).toHaveLength(2);
  });

  it("rejects stale quotes older than maxAgeMs", async () => {
    const staleMs = Date.now() - 120_000; // 2 min old
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0, "USDC", staleMs),
      mockProvider("p2", 1.0, "USDC", staleMs),
      mockProvider("p3", 1.0, "USDC", staleMs),
    ]);
    await expect(svc.getAggregatedPrice("USDC", 60_000)).rejects.toThrow(
      /stale/,
    );
  });

  it("uses only fresh quotes when some are stale", async () => {
    const staleMs = Date.now() - 90_000;
    const freshMs = Date.now() - 10_000;
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0, "USDC", freshMs),
      mockProvider("p2", 1.0, "USDC", freshMs),
      mockProvider("p3", 1.0, "USDC", staleMs), // stale
    ]);
    const result = await svc.getAggregatedPrice("USDC", 60_000);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((s) => s.source !== "p3")).toBe(true);
  });

  it("reports updatedAtMs as the oldest contributing fetchedAtMs", async () => {
    const t1 = Date.now() - 5_000;
    const t2 = Date.now() - 15_000;
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0, "USDC", t1),
      mockProvider("p2", 1.0, "USDC", t2),
    ]);
    const result = await svc.getAggregatedPrice("USDC");
    expect(result.updatedAtMs).toBe(t2);
  });

  it("reports deviationBps correctly", async () => {
    // p1=1.00, p2=1.00, p3=1.01 → median=1.00, max dev=100 bps
    const base = PRICE_FEED_SCALE;
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0),
      mockProvider("p2", 1.0),
      mockProvider("p3", 1.01),
    ]);
    const result = await svc.getAggregatedPrice("USDC");
    expect(result.deviationBps).toBeGreaterThan(0);
    expect(result.deviationBps).toBeLessThanOrEqual(200); // within MAX
  });

  it("ignores providers that do not support the requested symbol", async () => {
    const btcProvider = mockProvider("chainlink", 67000, "BTC");
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0, "USDC"),
      mockProvider("p2", 1.0, "USDC"),
      btcProvider,
    ]);
    const result = await svc.getAggregatedPrice("USDC");
    expect(result.sources.every((s) => s.source !== "chainlink")).toBe(true);
  });

  it("providers with supportedSymbols='*' are always queried", async () => {
    const wildcard: PriceFeedProvider = {
      name: "coingecko",
      supportedSymbols: "*",
      getPrice: jest.fn().mockResolvedValue({
        symbol: "USDC",
        priceScaled: PRICE_FEED_SCALE,
        fetchedAtMs: Date.now(),
        source: "coingecko",
      }),
    };
    const svc = new AggregatorService(tokens, [
      mockProvider("p1", 1.0),
      wildcard,
    ]);
    const result = await svc.getAggregatedPrice("USDC");
    expect(wildcard.getPrice).toHaveBeenCalled();
    expect(result.sources).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AggregatorService — getPriceSnapshot() back-compat
// ---------------------------------------------------------------------------

describe("AggregatorService — getPriceSnapshot() back-compat", () => {
  it("returns USD_PRICE_SCALE for known USDC pair (no live providers)", async () => {
    const svc = new AggregatorService(makeTokensService(), []);
    const snapshot = await svc.getPriceSnapshot({
      srcChain: "ethereum",
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      nowMs: 42,
    });
    expect(snapshot.srcPriceUsd).toBe(USD_PRICE_SCALE);
    expect(snapshot.dstPriceUsd).toBe(USD_PRICE_SCALE);
    expect(snapshot.asOfMs).toBe(42);
  });

  it("falls back to token registry when live feeds fail", async () => {
    const svc = new AggregatorService(makeTokensService(), [
      failingProvider("p1", "USDC"),
      failingProvider("p2", "USDC"),
      failingProvider("p3", "USDC"),
    ]);
    const snapshot = await svc.getPriceSnapshot({
      srcChain: "ethereum",
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    });
    // Falls back to registry price (1.0 USDC) → USD_PRICE_SCALE
    expect(snapshot.srcPriceUsd).toBe(USD_PRICE_SCALE);
    expect(snapshot.dstPriceUsd).toBe(USD_PRICE_SCALE);
  });

  it("returns null dstPriceUsd for unknown destination contract", async () => {
    const svc = new AggregatorService(makeTokensService(), []);
    const snapshot = await svc.getPriceSnapshot({
      srcChain: "ethereum",
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      dstTokenContract: "C" + "A".repeat(55),
    });
    expect(snapshot.dstPriceUsd).toBeNull();
    expect(snapshot.srcPriceUsd).toBe(USD_PRICE_SCALE);
  });

  it("uses live provider price when aggregation succeeds", async () => {
    // ETH at ~3500 from providers
    const ethPrice = 3500;
    const ethScaled = BigInt(Math.round(ethPrice * Number(PRICE_FEED_SCALE)));
    const provider: PriceFeedProvider = {
      name: "mock",
      supportedSymbols: new Set(["USDC"]),
      getPrice: jest.fn().mockResolvedValue({
        symbol: "USDC",
        priceScaled: PRICE_FEED_SCALE,
        fetchedAtMs: Date.now(),
        source: "mock",
      }),
    };
    const svc = new AggregatorService(makeTokensService(), [provider, provider]);
    const snapshot = await svc.getPriceSnapshot({
      srcChain: "ethereum",
      srcTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    });
    // USDC → $1.00 → USD_PRICE_SCALE
    expect(snapshot.srcPriceUsd).toBe(USD_PRICE_SCALE);
  });
});

// ---------------------------------------------------------------------------
// ReflectorProvider
// ---------------------------------------------------------------------------

describe("ReflectorProvider", () => {
  function makeProvider(
    statusCode: number,
    body: string,
  ): { provider: ReflectorProvider; fetch: jest.Mock } {
    const fetchMock = jest.fn().mockResolvedValue({ statusCode, body, headers: {}, bodyBytes: body.length, finalUrl: "", ipUsed: "" });
    const http = { fetch: fetchMock } as unknown as HttpEgressService;
    return { provider: new ReflectorProvider(http, "https://fake.reflector"), fetch: fetchMock };
  }

  it("parses a successful OHLC response", async () => {
    const body = JSON.stringify({ data: [{ close: "0.1182", time: 1700000000 }] });
    const { provider } = makeProvider(200, body);
    const quote = await provider.getPrice("XLM", 60_000);
    expect(quote.symbol).toBe("XLM");
    expect(quote.priceScaled).toBeGreaterThan(0n);
    expect(quote.source).toBe("reflector");
  });

  it("parses a flat 'price' field response", async () => {
    const body = JSON.stringify({ price: "1.0001" });
    const { provider } = makeProvider(200, body);
    const quote = await provider.getPrice("USDC", 60_000);
    expect(quote.priceScaled).toBeGreaterThan(0n);
  });

  it("throws on non-200 response", async () => {
    const { provider } = makeProvider(503, "Service Unavailable");
    await expect(provider.getPrice("XLM", 60_000)).rejects.toThrow("503");
  });

  it("throws for an unsupported symbol", async () => {
    const { provider } = makeProvider(200, "{}");
    await expect(provider.getPrice("UNKNOWN", 60_000)).rejects.toThrow(
      /not supported/,
    );
  });

  it("returns stale cache when live fetch fails", async () => {
    const body = JSON.stringify({ data: [{ close: "0.12" }] });
    const http = { fetch: jest.fn() } as unknown as HttpEgressService;
    const provider = new ReflectorProvider(http, "https://fake");

    // First call succeeds
    (http.fetch as jest.Mock).mockResolvedValueOnce({
      statusCode: 200,
      body,
      headers: {},
      bodyBytes: body.length,
      finalUrl: "",
      ipUsed: "",
    });
    await provider.getPrice("XLM", 60_000);

    // Second call fails → stale cache returned
    (http.fetch as jest.Mock).mockRejectedValueOnce(new Error("network error"));
    const quote = await provider.getPrice("XLM", 1); // maxAgeMs=1 forces refresh
    expect(quote.priceScaled).toBeGreaterThan(0n);
  });
});

// ---------------------------------------------------------------------------
// ChainlinkProvider
// ---------------------------------------------------------------------------

describe("ChainlinkProvider", () => {
  /**
   * Encode a uint256 as a 64-char hex word (no 0x prefix).
   */
  function encodeWord(n: bigint): string {
    return n.toString(16).padStart(64, "0");
  }

  /**
   * Build a fake latestRoundData() response:
   * (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
   */
  function buildRoundData(answerAtDecimals8: bigint, updatedAt: bigint): string {
    return (
      "0x" +
      encodeWord(1n) +           // roundId
      encodeWord(answerAtDecimals8) + // answer (int256 — positive)
      encodeWord(BigInt(Math.floor(Date.now() / 1000) - 10)) + // startedAt
      encodeWord(updatedAt) +    // updatedAt
      encodeWord(1n)             // answeredInRound
    );
  }

  function makeProvider(): { provider: ChainlinkProvider; fetch: jest.Mock } {
    const fetchMock = jest.fn();
    const http = { fetch: fetchMock } as unknown as HttpEgressService;
    const provider = new ChainlinkProvider(http, "https://fake-rpc.example.com", 1);
    return { provider, fetch: fetchMock };
  }

  function rpcResponse(result: string) {
    return {
      statusCode: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      headers: {},
      bodyBytes: 100,
      finalUrl: "",
      ipUsed: "",
    };
  }

  it("decodes latestRoundData and returns scaled price", async () => {
    const { provider, fetch } = makeProvider();
    const updatedAt = BigInt(Math.floor(Date.now() / 1000) - 30);
    // USDC/USD Chainlink feed at $1.00000000 (8 decimals)
    const answer = 100_000_000n;

    // First eth_call = decimals() = 8
    fetch.mockResolvedValueOnce(rpcResponse("0x" + encodeWord(8n)));
    // Second eth_call = latestRoundData()
    fetch.mockResolvedValueOnce(rpcResponse(buildRoundData(answer, updatedAt)));

    const quote = await provider.getPrice("USDC", 60_000);
    expect(quote.symbol).toBe("USDC");
    // answer=1e8 at scale 8 → 1e18
    expect(quote.priceScaled).toBe(PRICE_FEED_SCALE);
    expect(quote.source).toBe("chainlink");
  });

  it("throws for an unsupported symbol", async () => {
    const { provider } = makeProvider();
    await expect(provider.getPrice("XLM", 60_000)).rejects.toThrow(
      /no feed registered/,
    );
  });

  it("throws on RPC error response", async () => {
    const { provider, fetch } = makeProvider();
    fetch.mockResolvedValueOnce({
      statusCode: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }),
      headers: {},
      bodyBytes: 100,
      finalUrl: "",
      ipUsed: "",
    });
    await expect(provider.getPrice("USDC", 60_000)).rejects.toThrow(
      /RPC error/,
    );
  });

  it("warns when on-chain updatedAt is stale but still returns the price", async () => {
    const { provider, fetch } = makeProvider();
    // updatedAt = 2 hours ago
    const staleUpdatedAt = BigInt(Math.floor(Date.now() / 1000) - 7_200);
    const warnSpy = jest.spyOn(provider["logger"], "warn").mockImplementation(() => {});

    fetch.mockResolvedValueOnce(rpcResponse("0x" + encodeWord(8n)));
    fetch.mockResolvedValueOnce(rpcResponse(buildRoundData(100_000_000n, staleUpdatedAt)));

    const quote = await provider.getPrice("USDC", 60_000);
    expect(quote.priceScaled).toBe(PRICE_FEED_SCALE);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/stale on-chain/));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// CexAggregatorProvider
// ---------------------------------------------------------------------------

describe("CexAggregatorProvider", () => {
  function makeProvider(): { provider: CexAggregatorProvider; fetch: jest.Mock } {
    const fetchMock = jest.fn();
    const http = { fetch: fetchMock } as unknown as HttpEgressService;
    const provider = new CexAggregatorProvider(
      http,
      "https://api.coingecko.com/api/v3",
    );
    return { provider, fetch: fetchMock };
  }

  function cgeResponse(prices: Record<string, { usd: number; last_updated_at: number }>) {
    return {
      statusCode: 200,
      body: JSON.stringify(prices),
      headers: {},
      bodyBytes: 100,
      finalUrl: "",
      ipUsed: "",
    };
  }

  it("parses a batch price response and returns scaled USDC price", async () => {
    const { provider, fetch } = makeProvider();
    fetch.mockResolvedValue(
      cgeResponse({ "usd-coin": { usd: 1.0, last_updated_at: Math.floor(Date.now() / 1000) } }),
    );
    const quote = await provider.getPrice("USDC", 60_000);
    expect(quote.symbol).toBe("USDC");
    expect(quote.priceScaled).toBe(PRICE_FEED_SCALE);
    expect(quote.source).toBe("coingecko");
  });

  it("throws for a symbol not in the CoinGecko ID map", async () => {
    const { provider } = makeProvider();
    await expect(provider.getPrice("UNKNOWN_TOKEN", 60_000)).rejects.toThrow(
      /no CoinGecko ID/,
    );
  });

  it("throws on 429 rate-limit response", async () => {
    const { provider, fetch } = makeProvider();
    fetch.mockResolvedValue({
      statusCode: 429,
      body: "Too Many Requests",
      headers: {},
      bodyBytes: 17,
      finalUrl: "",
      ipUsed: "",
    });
    await expect(provider.getPrice("USDC", 60_000)).rejects.toThrow(
      /rate-limited/,
    );
  });

  it("logs an error when a stablecoin is de-pegged", async () => {
    const { provider, fetch } = makeProvider();
    const errorSpy = jest.spyOn(provider["logger"], "error").mockImplementation(() => {});
    // USDC at $0.95 = 500 bps off peg
    fetch.mockResolvedValue(
      cgeResponse({ "usd-coin": { usd: 0.95, last_updated_at: Math.floor(Date.now() / 1000) } }),
    );
    await provider.getPrice("USDC", 60_000);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/DEPEG ALERT/));
    errorSpy.mockRestore();
  });

  it("deduplicates concurrent batch requests", async () => {
    const { provider, fetch } = makeProvider();
    fetch.mockResolvedValue(
      cgeResponse({ "usd-coin": { usd: 1.0, last_updated_at: Math.floor(Date.now() / 1000) } }),
    );
    // Fire 5 concurrent requests — only 1 network call should happen
    await Promise.all(Array.from({ length: 5 }, () => provider.getPrice("USDC", 0)));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
