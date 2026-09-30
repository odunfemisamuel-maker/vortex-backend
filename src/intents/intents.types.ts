/**
 * Core domain types for the Vortex intent system.
 *
 * Partial-fill support (issue #427): intents may now opt in to
 * `allowPartialFill`, which enables multiple solvers to each reserve and fill
 * a portion of `srcAmount`. The aggregate fill progress is exposed via
 * `fillProgress` (a value 0–1) rather than a new `IntentState` variant so the
 * public state contract (`open | accepted | filled | cancelled | expired |
 * slashed`) remains stable. A per-fill record lives in `IntentFill` and is
 * written to the `intent_fills` table.
 */

// ---------------------------------------------------------------------------
// Chain / token primitives
// ---------------------------------------------------------------------------

export type SupportedChain =
  | "stellar"
  | "ethereum"
  | "base"
  | "polygon"
  | "arbitrum"
  | "optimism"
  | "avalanche";

export interface SrcToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  /** USD price at creation time, used for exposure calculations. */
  priceUSD?: number;
}

export interface DstToken {
  contract: string;
  symbol: string;
  decimals: number;
  /** USD price at creation time. */
  priceUSD?: number;
}

// ---------------------------------------------------------------------------
// Intent state machine
// ---------------------------------------------------------------------------

/**
 * Public lifecycle states.  Do NOT add `partially_filled` here — partial-fill
 * progress is surfaced through `fillProgress` on the intent object so callers
 * continue to operate against a stable six-state machine.
 */
export type IntentState =
  | "open"
  | "accepted"
  | "filled"
  | "cancelled"
  | "expired"
  | "slashed";

// ---------------------------------------------------------------------------
// Per-tranche fill record (issue #427)
// ---------------------------------------------------------------------------

/**
 * A single fill record contributed by one solver for one tranche of a
 * partial-fill intent.  Multiple `IntentFill` rows may exist for a single
 * `intentId` when `allowPartialFill` is true.
 */
export interface IntentFill {
  /** UUID primary key. */
  fillId: string;
  intentId: string;
  /** Solver address that submitted this fill. */
  solver: string;
  /**
   * Amount filled in this tranche, denominated in the *destination* token's
   * smallest unit (string to avoid bigint precision loss over JSON).
   */
  fillAmount: string;
  /**
   * Amount of `srcAmount` that was *reserved* when the solver accepted.
   * `Σ reservedAmount ≤ srcAmount` is the invariant maintained by the service.
   */
  reservedAmount: string;
  /** On-chain transaction hash confirming this fill. */
  txHash: string;
  /** Unix epoch seconds when this fill was recorded. */
  filledAt: number;
}

// ---------------------------------------------------------------------------
// Intent record
// ---------------------------------------------------------------------------

/**
 * A swap intent, optionally supporting partial fills.
 *
 * New partial-fill fields (issue #427):
 *  - `allowPartialFill`  — opt-in flag; defaults to false.
 *  - `minFillAmount`     — minimum acceptable single-tranche fill, in dst token
 *                          smallest units.  Required when `allowPartialFill`.
 *  - `filledAmount`      — running sum of all confirmed fills (dst token units).
 *  - `remainingAmount`   — `minDstAmount − filledAmount`, clamped to ≥ 0.
 *  - `fillProgress`      — `filledAmount / minDstAmount` (0–1 float); exposed
 *                          in API responses as a read-only computed field.
 *  - `fills`             — in-memory list of per-tranche fill records.
 *
 * Optimistic concurrency:
 *  - `version`           — incremented on every write; checked by the
 *                          repository's conditional-update methods.
 */
export interface Intent {
  intentId: string;
  user: string;
  srcChain: SupportedChain;
  srcToken: SrcToken;
  /** Total source amount being swapped (src token smallest units). */
  srcAmount: string;
  dstToken: DstToken;
  /**
   * Minimum aggregate destination amount acceptable to the user.
   * For full-fill intents this is the single fill floor.
   * For partial-fill intents this is the sum of all fills required to mark
   * the intent as `filled`.
   */
  minDstAmount: string;
  /** Oracle-quoted fair value for `minDstAmount`, set at creation. */
  quotedDstAmount?: string;
  solver?: string;
  state: IntentState;
  createdAt: number;
  deadline: number;
  filledAt?: number;
  /** Total fill amount across all confirmed fills (dst token units). */
  fillAmount?: string;
  txHash?: string;
  slashedAt?: number;
  slashReason?: string;
  /** Governance-params version snapshot taken at creation. */
  paramsVersion?: number;
  /** Optimistic-concurrency counter. */
  version?: number;

  // ── Partial-fill fields (issue #427) ─────────────────────────────────────

  /** Whether this intent accepts multiple partial fills. Defaults to false. */
  allowPartialFill?: boolean;
  /**
   * Minimum amount per single fill, in dst token smallest units.
   * Enforced per-tranche; required when `allowPartialFill = true`.
   */
  minFillAmount?: string;
  /**
   * Running sum of all confirmed fills so far, in dst token smallest units.
   * Initialised to "0" on creation when `allowPartialFill = true`.
   */
  filledAmount?: string;
  /**
   * How much of `minDstAmount` is still unserviced.
   * Computed as `max(0, minDstAmount − filledAmount)`.
   */
  remainingAmount?: string;
  /**
   * 0–1 progress ratio: `filledAmount / minDstAmount`.
   * Exposed as a read-only field; not stored directly in the DB (derived).
   */
  fillProgress?: number;
  /**
   * In-memory cache of per-tranche fills for this intent.
   * Populated from the `intent_fills` table by the repository.
   */
  fills?: IntentFill[];
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export interface IntentAuditEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  toState: IntentState;
  /** Address or service that caused the transition. */
  actor: string;
  /** Human-readable reason for the transition. */
  reason: string;
  /** Arbitrary structured metadata. */
  metadata?: Record<string, unknown>;
}
