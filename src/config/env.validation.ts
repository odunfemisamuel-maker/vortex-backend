import * as Joi from "joi";

/**
 * Joi-based environment validation schema.
 *
 * Every variable the application reads from `process.env` must appear here
 * so configuration errors are caught at startup rather than at runtime.
 *
 * Partial-fill additions (issue #427): none — partial fill is opt-in per intent
 * and requires no new env variables.
 */
export const envValidationSchema = Joi.object({
  // ── Runtime environment ───────────────────────────────────────────────────
  NODE_ENV: Joi.string()
    .valid("development", "test", "staging", "production")
    .default("development"),

  PORT: Joi.number().integer().min(1).max(65535).default(4000),

  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: Joi.string().default("postgresql://vortex:vortex@localhost:5432/vortex?schema=public"),

  // ── Intents store ─────────────────────────────────────────────────────────
  INTENTS_STORE: Joi.string().valid("memory", "postgres", "dual").default("memory"),
  /** Deprecated alias for INTENTS_STORE=postgres */
  INTENTS_PERSISTENCE: Joi.string().valid("memory", "prisma").optional(),

  SOLVERS_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),

  // ── Stellar / Soroban ─────────────────────────────────────────────────────
  SOROBAN_RPC_URL: Joi.string()
    .uri()
    .default("https://soroban-testnet.stellar.org"),

  STELLAR_NETWORK: Joi.string().valid("testnet", "mainnet").default("testnet"),

  STELLAR_HORIZON_URL: Joi.string().uri().optional(),

  SETTLEMENT_CONTRACT_ID: Joi.string().optional().default(""),

  SOLVER_REGISTRY_CONTRACT_ID: Joi.string().optional().default(""),

  SOROBAN_FEE_PERCENTILE: Joi.string()
    .valid("p50", "p75", "p90", "p95", "p99")
    .default("p50"),

  /**
   * Stellar secret seed used to sign on-chain writes.
   * Outside production: defaults to empty string (on-chain writes are
   *   no-ops / dry-run).
   * In production: must be a well-formed 56-char Stellar secret starting with 'S'.
   */
  SOROBAN_SIGNING_KEY: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string()
      .pattern(/^S[A-Z2-7]{55}$/)
      .required(),
    otherwise: Joi.string()
      .allow("")
      .pattern(/^$|^S[A-Z2-7]{55}$/)
      .default(""),
  }),

  /**
   * When true, on-chain writes are simulated but not submitted.
   * Required in production (must be explicitly set).
   */
  ONCHAIN_DRY_RUN: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.boolean().required(),
    otherwise: Joi.boolean().default(true),
  }),

  ONCHAIN_INTENTS_ENABLED: Joi.boolean().default(false),

  // ── CORS ──────────────────────────────────────────────────────────────────
  CORS_ORIGIN: Joi.string().default("*"),

  // ── WebSocket ─────────────────────────────────────────────────────────────
  WS_MAX_CONNECTIONS: Joi.number().integer().min(1).max(100_000).default(1000),

  // ── Kill-switch / operator ────────────────────────────────────────────────
  KILLSWITCH_OPERATOR_TOKEN: Joi.when("NODE_ENV", {
    is: "production",
    then: Joi.string().min(1).required(),
    otherwise: Joi.string().allow("").default(""),
  }),

  KILLSWITCH_POLL_MS: Joi.number().integer().min(100).max(5000).default(2000),

  KILLSWITCH_PERSISTENCE: Joi.string().valid("memory", "prisma").default("memory"),

  KILLSWITCH_REDIS_URL: Joi.string().allow("").default(""),

  // ── Oracle / pricing ──────────────────────────────────────────────────────
  MAX_USER_SLIPPAGE_BPS: Joi.number().integer().min(0).max(10_000).default(100),
  MAX_PREMIUM_BPS: Joi.number().integer().min(0).max(10_000).default(50),
  ORACLE_FAIL_OPEN_MAX_USD: Joi.number().min(0).default(100),
  ORACLE_MAX_STALENESS_MS: Joi.number().integer().min(0).default(60_000),

  // ── EVM deposit verification ──────────────────────────────────────────────
  EVM_DEPOSIT_VERIFICATION_ENABLED: Joi.boolean().default(false),
  EVM_RPC_URLS: Joi.string().allow("").default(""),
  EVM_ESCROW_ADDRESSES: Joi.string().allow("").default(""),

  // ── Observability ────────────────────────────────────────────────────────
  LOG_LEVEL: Joi.string()
    .valid("debug", "verbose", "log", "warn", "error", "fatal")
    .default("debug"),

  SENTRY_DSN: Joi.string().allow("").default(""),

  METRICS_TOKEN: Joi.string().allow("").default(""),

  // ── Leader election ───────────────────────────────────────────────────────
  LEADER_ELECTION_ENABLED: Joi.boolean().default(false),
  LEADER_ELECTION_HEARTBEAT_MS: Joi.number().integer().min(100).default(5000),

  // ── Intent retention ──────────────────────────────────────────────────────
  INTENT_RETENTION_DAYS: Joi.number().integer().min(1).default(30),

  // ── Secrets provider ─────────────────────────────────────────────────────
  SECRETS_PROVIDER: Joi.string().valid("env", "aws-sm").default("env"),
  AWS_REGION: Joi.string().allow("").default(""),
  AWS_SECRET_ARN_SIGNING_KEY: Joi.string().allow("").default(""),

  // ── Multi-source price oracle (issue #424) ────────────────────────────────
  // CoinGecko REST API key (optional; free tier works without one).
  COINGECKO_API_KEY: Joi.string().allow("").default(""),
  // Override the CoinGecko API base URL (e.g. for Pro tier or a test stub).
  COINGECKO_API_URL: Joi.string().uri().optional(),
  // EVM JSON-RPC endpoint used by ChainlinkProvider.
  ORACLE_EVM_RPC_URL: Joi.string().uri().optional().allow(""),
  // Chain ID for ChainlinkProvider (default: 1 = Ethereum mainnet).
  ORACLE_EVM_CHAIN_ID: Joi.number().integer().min(1).default(1),
  // Override the Reflector REST API base URL (default: https://data.reflector.network/api).
  REFLECTOR_API_URL: Joi.string().uri().optional(),
  // Max deviation in bps between any source and the median before rejection.
  ORACLE_MAX_SOURCE_DEVIATION_BPS: Joi.number().integer().min(1).max(10_000).default(200),
  // Minimum number of healthy sources required (fail-closed threshold).
  ORACLE_MIN_HEALTHY_SOURCES: Joi.number().integer().min(1).max(10).default(2),
})
  .unknown(true) // allow extra env vars (e.g., npm_ prefixes, CI vars)
  .options({ convert: true });
