/**
 * NestJS `ConfigModule` configuration factory.
 *
 * Maps the validated environment (produced by `envValidationSchema`) into the
 * strongly-typed `AppConfig` object read by services via `ConfigService<AppConfig, true>`.
 *
 * Chain-specific deadline and fill-window defaults are also exported here so
 * any service that needs them can import them directly without going through
 * ConfigService.
 */

// ---------------------------------------------------------------------------
// Chain-specific timing defaults
// ---------------------------------------------------------------------------

/** Absolute deadline seconds by chain (from intent creation time). */
export const CHAIN_DEADLINE_DEFAULTS: Record<string, number> = {
  stellar: 900,     // 15 min — fast L1
  ethereum: 3600,   // 60 min — mainnet finality
  base: 1800,       // 30 min
  polygon: 1800,    // 30 min
  arbitrum: 1800,   // 30 min
  optimism: 1800,   // 30 min
  avalanche: 1800,  // 30 min
};

/** Fill window seconds by chain (the per-solver deadline extension on accept). */
export const CHAIN_FILL_WINDOW_DEFAULTS: Record<string, number> = {
  stellar: 300,     // 5 min
  ethereum: 1800,   // 30 min
  base: 900,        // 15 min
  polygon: 900,     // 15 min
  arbitrum: 900,    // 15 min
  optimism: 900,    // 15 min
  avalanche: 900,   // 15 min
};

/** Fallback when a chain is not in CHAIN_DEADLINE_DEFAULTS. */
export const DEFAULT_DEADLINE_SECONDS = 1800;

/** Fallback when a chain is not in CHAIN_FILL_WINDOW_DEFAULTS. */
export const DEFAULT_FILL_WINDOW_SECONDS = 600;

// ---------------------------------------------------------------------------
// AppConfig shape
// ---------------------------------------------------------------------------

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  intentsPersistence: string;
  solversPersistence: string;
  onchainIntentsEnabled: boolean;
  onchainDryRun: boolean;
  corsOrigin: string;
  wsMaxConnections: number;
  logLevel: string;
  sentryDsn: string;
  leaderElectionEnabled: boolean;
  leaderElectionHeartbeatMs: number;
  intentRetentionDays: number;
  maxUserSlippageBps: number;
  maxPremiumBps: number;
  oracleFailOpenMaxUsd: number;
  oracleMaxStalenessMs: number;
  evmDepositVerificationEnabled: boolean;
  stellar: {
    rpcUrl: string;
    network: string;
    horizonUrl: string;
    settlementContractId: string;
    solverRegistryContractId: string;
    feePercentile: string;
    signingKey: string;
    maxFeeStroops: number;
    channelPoolSize: number;
  };
}

// ---------------------------------------------------------------------------
// Configuration factory
// ---------------------------------------------------------------------------

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "4000", 10),
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://vortex:vortex@localhost:5432/vortex?schema=public",
  intentsPersistence: process.env.INTENTS_STORE ?? process.env.INTENTS_PERSISTENCE ?? "memory",
  solversPersistence: process.env.SOLVERS_PERSISTENCE ?? "memory",
  onchainIntentsEnabled: process.env.ONCHAIN_INTENTS_ENABLED === "true",
  onchainDryRun: process.env.ONCHAIN_DRY_RUN !== "false",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  wsMaxConnections: parseInt(process.env.WS_MAX_CONNECTIONS ?? "1000", 10),
  logLevel: process.env.LOG_LEVEL ?? "debug",
  sentryDsn: process.env.SENTRY_DSN ?? "",
  leaderElectionEnabled: process.env.LEADER_ELECTION_ENABLED === "true",
  leaderElectionHeartbeatMs: parseInt(process.env.LEADER_ELECTION_HEARTBEAT_MS ?? "5000", 10),
  intentRetentionDays: parseInt(process.env.INTENT_RETENTION_DAYS ?? "30", 10),
  maxUserSlippageBps: parseInt(process.env.MAX_USER_SLIPPAGE_BPS ?? "100", 10),
  maxPremiumBps: parseInt(process.env.MAX_PREMIUM_BPS ?? "50", 10),
  oracleFailOpenMaxUsd: parseFloat(process.env.ORACLE_FAIL_OPEN_MAX_USD ?? "100"),
  oracleMaxStalenessMs: parseInt(process.env.ORACLE_MAX_STALENESS_MS ?? "60000", 10),
  evmDepositVerificationEnabled: process.env.EVM_DEPOSIT_VERIFICATION_ENABLED === "true",
  stellar: {
    rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    network: process.env.STELLAR_NETWORK ?? "testnet",
    horizonUrl: process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    settlementContractId: process.env.SETTLEMENT_CONTRACT_ID ?? "",
    solverRegistryContractId: process.env.SOLVER_REGISTRY_CONTRACT_ID ?? "",
    feePercentile: process.env.SOROBAN_FEE_PERCENTILE ?? "p50",
    signingKey: process.env.SOROBAN_SIGNING_KEY ?? "",
    maxFeeStroops: parseInt(process.env.SOROBAN_MAX_FEE_STROOPS ?? "1000000", 10),
    channelPoolSize: parseInt(process.env.CHANNEL_POOL_SIZE ?? "8", 10),
  },
});
