/**
 * PricingModule — wires the multi-source price oracle (issue #424).
 *
 * Providers registered:
 *   1. ReflectorProvider   — Stellar on-chain TWAP oracle
 *   2. ChainlinkProvider   — EVM on-chain Data Feeds
 *   3. CexAggregatorProvider — CoinGecko public REST API
 *
 * All three are injected into AggregatorService via PRICE_FEED_PROVIDERS.
 * In environments where an RPC URL is not configured the provider is still
 * registered but will fail on every call, so the aggregator's fail-closed
 * logic applies (≥ 2 healthy sources required).
 */

import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TokensModule } from "../tokens/tokens.module";
import { AggregatorService } from "./aggregator.service";
import { PRICE_FEED_PROVIDERS } from "../tokens/price-feed.provider";
import { ReflectorProvider } from "./providers/reflector.provider";
import { ChainlinkProvider } from "./providers/chainlink.provider";
import { CexAggregatorProvider } from "./providers/cex-aggregator.provider";
import { HttpEgressService } from "../common/http-egress";
import { AppConfig } from "../config/configuration";

/** Shared egress config for oracle HTTP calls. */
const ORACLE_EGRESS_CONFIG = {
  timeoutMs: 8_000,
  maxRedirects: 2,
  maxBodySizeBytes: 512_000,
  blockPrivateRanges: true,
};

@Module({
  imports: [TokensModule],
  providers: [
    // ── Provider array ─────────────────────────────────────────────────────
    {
      provide: PRICE_FEED_PROVIDERS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const http = new HttpEgressService(ORACLE_EGRESS_CONFIG);

        // Reflector (Stellar TWAP oracle)
        const reflectorBase =
          (process.env.REFLECTOR_API_URL as string | undefined) ??
          "https://data.reflector.network/api";
        const reflector = new ReflectorProvider(http, reflectorBase);

        // Chainlink (EVM on-chain data feeds)
        const evmRpcUrl =
          (process.env.ORACLE_EVM_RPC_URL as string | undefined) ??
          (process.env.EVM_RPC_URLS as string | undefined)?.split(",")[0] ??
          "";
        const chainId = parseInt(
          process.env.ORACLE_EVM_CHAIN_ID ?? "1",
          10,
        );
        const chainlink = new ChainlinkProvider(http, evmRpcUrl, chainId);

        // CoinGecko REST aggregator
        const cgApiKey = process.env.COINGECKO_API_KEY ?? undefined;
        const cgBase = process.env.COINGECKO_API_URL ?? undefined;
        const coingecko = new CexAggregatorProvider(http, cgBase, cgApiKey);

        return [reflector, chainlink, coingecko];
      },
    },

    // ── Aggregator service ─────────────────────────────────────────────────
    AggregatorService,
  ],
  exports: [AggregatorService],
})
export class PricingModule {}
