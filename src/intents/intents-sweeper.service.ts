import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SlashingPipelineService } from "./slashing-pipeline.service";
import { MetricsService } from "../metrics/metrics.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { LeaderElectionService } from "../common/leader-election";
import { Intent } from "./intents.types";
import {
  CHAIN_FILL_WINDOW_DEFAULTS,
  DEFAULT_FILL_WINDOW_SECONDS,
} from "../config/configuration";

/**
 * Result shape returned by `sweep()` for observability and testing.
 */
export interface SweepResult {
  expiredCount: number;
  slashedCount: number;
  extendedDeadlines: number;
}

/**
 * Maximum number of optimistic-concurrency retries before the sweeper gives up
 * on a single intent and moves on (issue #405).
 */
const MAX_VERSION_RETRIES = 3;

/**
 * Background sweeper that expires overdue open intents and slashes accepted
 * intents whose fill window has elapsed.
 *
 * Partial-fill semantics (issue #427):
 *   For an intent with `allowPartialFill = true` that is still `accepted`
 *   past its deadline, only the *reserved-but-unfilled* tranche is slashed.
 *   Tranches that were already filled are left intact. An intent can only
 *   move to `slashed` when it is still fully in the `accepted` state (i.e.,
 *   no confirmed partial fills); a solver who has already partially filled
 *   an intent is not slashed for the portion they delivered.
 *
 * Emergency-pause semantics (issue #477):
 *   When the kill-switch covers `fill` on an intent's chain, the sweeper
 *   extends the intent's deadline rather than slashing. Once the pause is
 *   lifted the normal slashing logic resumes.
 */
@Injectable()
export class IntentsSweeperService {
  private readonly logger = new Logger(IntentsSweeperService.name);

  constructor(
    private readonly intentsService: IntentsService,
    private readonly gateway: IntentsGateway,
    private readonly solversService: SolversService,
    private readonly slashingPipeline: SlashingPipelineService,
    private readonly metrics: MetricsService,
    private readonly killSwitch: KillSwitchService,
    private readonly leaderElection: LeaderElectionService,
  ) {}

  /**
   * Run the sweep loop every 30 seconds.
   *
   * Only executes on the elected leader replica in multi-instance deployments
   * (LEADER_ELECTION_ENABLED=true). In single-replica or dev environments
   * `isLeader()` always returns true.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<SweepResult> {
    if (!this.leaderElection.isLeader()) {
      return { expiredCount: 0, slashedCount: 0, extendedDeadlines: 0 };
    }

    const start = Date.now();
    const now = Math.floor(Date.now() / 1000);

    let expiredCount = 0;
    let slashedCount = 0;
    let extendedDeadlines = 0;

    // ── 1. Expire overdue open intents ──────────────────────────────────────
    const openIntents = await this.intentsService.getByState("open");
    for (const intent of openIntents) {
      if (intent.deadline > now) continue;

      const expired = await this.intentsService.expireIfOpen(intent.intentId);
      if (expired) {
        expiredCount += 1;
        this.gateway.broadcast({
          type: "intent_expired",
          intentId: intent.intentId,
          timestamp: now,
          srcChain: intent.srcChain,
        });
        this.intentsService.appendAuditEntry(
          intent.intentId,
          "expired",
          "sweeper",
          "Fill deadline elapsed with no accept",
        );
        this.logger.debug(`[sweep] expired intent ${intent.intentId}`);
      }
    }

    // ── 2. Slash or extend overdue accepted intents ─────────────────────────
    const acceptedIntents = await this.intentsService.getByState("accepted");
    for (const intent of acceptedIntents) {
      if (intent.deadline > now) continue;

      // Check kill-switch: if fill is paused for this chain/token, extend
      // the deadline instead of slashing (issue #477).
      const ksResult = this.killSwitch.evaluateTarget({
        scope: "chain",
        chain: intent.srcChain,
        token: (intent.srcToken as { address?: string }).address ?? null,
        operation: "fill",
      });

      if (ksResult.paused) {
        const fillWindow =
          CHAIN_FILL_WINDOW_DEFAULTS[intent.srcChain] ?? DEFAULT_FILL_WINDOW_SECONDS;
        const extended = await this.intentsService.extendDeadlineIfAccepted(
          intent.intentId,
          now + fillWindow,
        );
        if (extended) {
          extendedDeadlines += 1;
          this.logger.warn(
            `[sweep] extended deadline for intent ${intent.intentId} due to fill pause on ${intent.srcChain}`,
          );
        }
        continue;
      }

      // Attempt to slash with optimistic concurrency (issue #405).
      await this.attemptSlash(intent, now);
      const fresh = await this.intentsService.get(intent.intentId);
      if (fresh?.state === "slashed") {
        slashedCount += 1;
      }
    }

    const durationMs = Date.now() - start;
    this.metrics.recordSweep(expiredCount, durationMs);

    this.logger.log(
      `[sweep] done in ${durationMs}ms: expired=${expiredCount} slashed=${slashedCount} extended=${extendedDeadlines}`,
    );

    return { expiredCount, slashedCount, extendedDeadlines };
  }

  /**
   * Attempt to slash a single overdue accepted intent, retrying up to
   * MAX_VERSION_RETRIES times under contention (issue #405).
   *
   * Partial-fill note (issue #427): if the intent already has confirmed fills
   * (filledAmount > 0), only the *reserved-but-unfilled* tranche is relevant
   * for the slash — the intent's state is still `accepted` because the final
   * fill hasn't landed, so `slashIfAccepted` still applies. The solver is only
   * penalised for the portion they committed to (reservedAmount) but did not
   * deliver.
   */
  private async attemptSlash(intent: Intent, now: number): Promise<void> {
    const { intentId, solver, srcChain } = intent;

    if (!solver) {
      // Corrupt record — slash defensively without a solver penalty.
      this.logger.warn(
        `[sweep] accepted intent ${intentId} has no solver — slashing without penalising`,
      );
      await this.intentsService.slashIfAccepted(intentId, {
        slashedAt: now,
        slashReason: "No solver recorded on accepted intent",
      });
      return;
    }

    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
      const slashed = await this.intentsService.slashIfAccepted(intentId, {
        slashedAt: now,
        slashReason: `Fill deadline elapsed (solver=${solver})`,
      });

      if (slashed) {
        // Successfully slashed — record solver penalty.
        try {
          await this.solversService.recordFailedFill(solver, intentId);
        } catch (err) {
          this.logger.error(
            `[sweep] failed to record fillsFailed for solver ${solver}: ${(err as Error).message}`,
          );
        }

        this.gateway.broadcast({
          type: "intent_slashed",
          intentId,
          solver,
          reason: slashed.slashReason,
          timestamp: now,
          srcChain,
        });

        this.intentsService.appendAuditEntry(
          intentId,
          "slashed",
          "sweeper",
          `Fill deadline elapsed`,
          { solver },
        );

        // Notify the slashing pipeline (issue #397 — on-chain slash saga).
        try {
          await this.slashingPipeline.detect({
            intentId,
            solverAddress: solver,
            fillDeadline: intent.deadline,
            detectedAt: now,
          });
        } catch (err) {
          this.logger.error(
            `[sweep] slashing pipeline error for intent ${intentId}: ${(err as Error).message}`,
          );
        }

        this.logger.warn(`[sweep] slashed intent ${intentId} (solver=${solver})`);
        return;
      }

      // Conditional write lost — the intent was concurrently modified.
      // Re-read and decide whether to retry or bail.
      const fresh = await this.intentsService.get(intentId);
      if (!fresh || fresh.state !== "accepted") {
        // Intent was concurrently filled, cancelled, or already slashed.
        this.logger.debug(
          `[sweep] intent ${intentId} moved to state=${fresh?.state ?? "deleted"} before slash (attempt ${attempt + 1})`,
        );
        return;
      }

      this.logger.debug(
        `[sweep] slash retry ${attempt + 1}/${MAX_VERSION_RETRIES} for intent ${intentId}`,
      );
    }

    this.logger.warn(
      `[sweep] gave up slashing intent ${intentId} after ${MAX_VERSION_RETRIES} retries (sustained contention)`,
    );
  }
}
