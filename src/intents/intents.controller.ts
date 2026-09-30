import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { v4 as uuidv4 } from "uuid";
import { IntentsService, MAX_OPEN_INTENTS_PER_USER } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { CreateIntentDto } from "./dto/create-intent.dto";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { FillIntentDto } from "./dto/fill-intent.dto";
import { CancelIntentDto } from "./dto/cancel-intent.dto";
import { ListIntentsDto } from "./dto/list-intents.dto";
import { Intent, IntentFill, SupportedChain } from "./intents.types";

/**
 * IntentsController — REST endpoints for intent lifecycle management.
 *
 * Partial-fill support (issue #427):
 *  - CreateIntentDto now accepts `allowPartialFill` and `minFillAmount`.
 *  - POST /:id/fill returns `fillProgress` and `remainingAmount` for partial-fill intents.
 *  - GET /:id/fills returns all per-tranche fill records for an intent.
 *  - A partial fill emits `intent_partially_filled` via the gateway.
 *  - When all remaining amount is filled the intent transitions to `filled` normally.
 */
@ApiTags("intents")
@Controller("api/v1/intents")
export class IntentsController {
  private readonly logger = new Logger(IntentsController.name);

  constructor(
    private readonly intentsService: IntentsService,
    private readonly gateway: IntentsGateway,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /api/v1/intents — create
  // ---------------------------------------------------------------------------

  @Post()
  @ApiOperation({ summary: "Create a new swap intent" })
  @ApiBody({ type: CreateIntentDto })
  @ApiResponse({ status: 201, description: "Intent created" })
  @ApiResponse({ status: 400, description: "Validation error" })
  @ApiResponse({ status: 409, description: "Per-user open intent cap reached" })
  async create(@Body() dto: CreateIntentDto): Promise<Intent> {
    // Validate partial-fill constraints
    if (dto.allowPartialFill) {
      if (!dto.minFillAmount) {
        throw new BadRequestException(
          "minFillAmount is required when allowPartialFill is true",
        );
      }
      if (BigInt(dto.minFillAmount) <= 0n) {
        throw new BadRequestException("minFillAmount must be greater than zero");
      }
      if (BigInt(dto.minFillAmount) > BigInt(dto.minDstAmount)) {
        throw new BadRequestException(
          "minFillAmount must not exceed minDstAmount",
        );
      }
    }

    // Enforce per-user open intent cap (issue #473)
    const openCount = await this.intentsService.countOpenByUser(dto.user);
    if (openCount >= MAX_OPEN_INTENTS_PER_USER) {
      throw new ConflictException(
        `Intent cap reached: user already has ${MAX_OPEN_INTENTS_PER_USER} open intents`,
      );
    }

    const intent = await this.intentsService.create({
      user: dto.user,
      srcChain: dto.srcChain as SupportedChain,
      srcToken: {
        address: dto.srcTokenAddress,
        symbol: dto.srcTokenSymbol,
        name: dto.srcTokenSymbol,
        decimals: dto.srcTokenDecimals,
        chain: dto.srcChain as SupportedChain,
        priceUSD: dto.srcTokenPriceUSD,
      },
      srcAmount: dto.srcAmount,
      dstToken: {
        contract: dto.dstTokenContract,
        symbol: dto.dstTokenSymbol,
        decimals: dto.dstTokenDecimals,
        priceUSD: dto.dstTokenPriceUSD,
      },
      minDstAmount: dto.minDstAmount,
      deadline: dto.deadline,
      allowPartialFill: dto.allowPartialFill ?? false,
      minFillAmount: dto.minFillAmount,
      filledAmount: "0",
      remainingAmount: dto.minDstAmount,
    });

    this.gateway.broadcast({
      type: "intent_created",
      intentId: intent.intentId,
      intent,
      timestamp: Math.floor(Date.now() / 1000),
      srcChain: intent.srcChain,
    });

    this.intentsService.appendAuditEntry(
      intent.intentId,
      "open",
      dto.user,
      "Intent created",
      { allowPartialFill: intent.allowPartialFill, minFillAmount: intent.minFillAmount },
    );

    return intent;
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/intents — list
  // ---------------------------------------------------------------------------

  @Get()
  @ApiOperation({ summary: "List intents with optional filters" })
  @ApiQuery({ name: "state", required: false })
  @ApiQuery({ name: "user", required: false })
  @ApiQuery({ name: "chain", required: false })
  @ApiQuery({ name: "partialFill", required: false, type: Boolean })
  async list(@Query() query: ListIntentsDto): Promise<{ intents: Intent[]; count: number }> {
    let intents: Intent[];

    if (query.state) {
      intents = await this.intentsService.getByState(query.state);
    } else if (query.user) {
      intents = await this.intentsService.getByUser(query.user);
    } else {
      intents = await this.intentsService.getAll();
    }

    if (query.chain) {
      intents = intents.filter((i) => i.srcChain === query.chain);
    }

    if (query.partialFill !== undefined) {
      const wantPartial = String(query.partialFill) === "true";
      intents = intents.filter((i) => (i.allowPartialFill ?? false) === wantPartial);
    }

    return { intents: intents.map(enrichIntent), count: intents.length };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/intents/open — solver view
  // ---------------------------------------------------------------------------

  @Get("open")
  @ApiOperation({ summary: "All open intents (solver view)" })
  async getOpen(): Promise<{ intents: Intent[]; count: number }> {
    const intents = await this.intentsService.getByState("open");
    return { intents: intents.map(enrichIntent), count: intents.length };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/intents/user/:addr
  // ---------------------------------------------------------------------------

  @Get("user/:addr")
  @ApiOperation({ summary: "All intents for a given user address" })
  @ApiParam({ name: "addr", description: "User Stellar / EVM address" })
  async getByUser(@Param("addr") addr: string): Promise<{ intents: Intent[]; count: number }> {
    const intents = await this.intentsService.getByUser(addr);
    return { intents: intents.map(enrichIntent), count: intents.length };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/intents/:id
  // ---------------------------------------------------------------------------

  @Get(":id")
  @ApiOperation({ summary: "Get a single intent by ID" })
  @ApiParam({ name: "id", description: "Intent UUID" })
  @ApiResponse({ status: 404, description: "Intent not found" })
  async getOne(@Param("id") id: string): Promise<Intent> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException(`Intent ${id} not found`);
    return enrichIntent(intent);
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/intents/:id/fills — per-tranche fill records
  // ---------------------------------------------------------------------------

  @Get(":id/fills")
  @ApiOperation({ summary: "Get per-tranche fill records for a partial-fill intent" })
  @ApiParam({ name: "id", description: "Intent UUID" })
  @ApiResponse({ status: 200, description: "List of fill records" })
  @ApiResponse({ status: 404, description: "Intent not found" })
  async getFills(
    @Param("id") id: string,
  ): Promise<{ fills: IntentFill[]; fillProgress: number; remainingAmount: string }> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException(`Intent ${id} not found`);

    const fills = intent.fills ?? [];
    const fillProgress = computeFillProgress(intent);
    const remainingAmount = computeRemainingAmount(intent);

    return { fills, fillProgress, remainingAmount };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/intents/:id/accept
  // ---------------------------------------------------------------------------

  @Post(":id/accept")
  @ApiOperation({ summary: "Solver accepts an open intent" })
  @ApiParam({ name: "id", description: "Intent UUID" })
  @ApiBody({ type: AcceptIntentDto })
  @ApiResponse({ status: 201, description: "Intent accepted" })
  @ApiResponse({ status: 404, description: "Intent not found" })
  @ApiResponse({ status: 409, description: "Intent not in accepting state" })
  async accept(
    @Param("id") id: string,
    @Body() dto: AcceptIntentDto,
  ): Promise<Intent> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException(`Intent ${id} not found`);

    const accepted = await this.intentsService.acceptIfOpen(id, dto.solver);
    if (!accepted) {
      throw new ConflictException(
        `Intent ${id} is not available for acceptance (state=${intent.state})`,
      );
    }

    this.gateway.broadcast({
      type: "intent_accepted",
      intentId: id,
      solver: dto.solver,
      timestamp: Math.floor(Date.now() / 1000),
      srcChain: accepted.srcChain,
    });

    this.intentsService.appendAuditEntry(
      id,
      "accepted",
      dto.solver,
      "Solver accepted intent",
      { solver: dto.solver },
    );

    return enrichIntent(accepted);
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/intents/:id/fill
  // ---------------------------------------------------------------------------

  @Post(":id/fill")
  @ApiOperation({
    summary: "Solver fills an accepted intent (supports partial fills)",
  })
  @ApiParam({ name: "id", description: "Intent UUID" })
  @ApiBody({ type: FillIntentDto })
  @ApiResponse({ status: 201, description: "Intent filled (or partially filled)" })
  @ApiResponse({ status: 400, description: "Fill amount below minimum" })
  @ApiResponse({ status: 403, description: "Wrong solver" })
  @ApiResponse({ status: 404, description: "Intent not found" })
  @ApiResponse({ status: 409, description: "Intent not in fillable state" })
  async fill(@Param("id") id: string, @Body() dto: FillIntentDto): Promise<Intent> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException(`Intent ${id} not found`);

    // Guard: only the assigned solver may fill
    if (intent.solver && intent.solver !== dto.solver) {
      throw new ForbiddenException(
        `Intent ${id} is assigned to a different solver`,
      );
    }

    if (intent.state !== "accepted") {
      throw new ConflictException(
        `Intent ${id} is not in the 'accepted' state (state=${intent.state})`,
      );
    }

    const fillAmountBig = BigInt(dto.fillAmount);

    // ── Partial-fill branch ──────────────────────────────────────────────────
    if (intent.allowPartialFill) {
      return this.handlePartialFill(intent, dto, fillAmountBig);
    }

    // ── Full-fill branch ─────────────────────────────────────────────────────
    const minDst = BigInt(intent.minDstAmount);
    if (fillAmountBig < minDst) {
      throw new BadRequestException({
        error: "Fill amount below minimum",
        fillAmount: dto.fillAmount,
        minDstAmount: intent.minDstAmount,
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const updated = await this.intentsService.fillIfAccepted(
      id,
      dto.solver,
      { fillAmount: dto.fillAmount, txHash: dto.txHash, filledAt: now },
      now,
    );

    if (!updated) {
      throw new ConflictException(
        `Intent ${id} fill failed: deadline may have elapsed or concurrent fill won`,
      );
    }

    this.gateway.broadcast({
      type: "intent_filled",
      intentId: id,
      solver: dto.solver,
      fillAmount: dto.fillAmount,
      txHash: dto.txHash,
      timestamp: now,
      srcChain: updated.srcChain,
    });

    this.intentsService.appendAuditEntry(
      id,
      "filled",
      dto.solver,
      "Intent fully filled",
      { fillAmount: dto.fillAmount, txHash: dto.txHash },
    );

    return enrichIntent(updated);
  }

  /**
   * Handle a fill for a partial-fill intent.
   *
   * Rules (issue #427):
   *  1. fillAmount >= minFillAmount (per-tranche floor)
   *  2. fillAmount <= remainingAmount (cannot overshoot)
   *  3. A new IntentFill record is appended
   *  4. filledAmount is updated; remainingAmount decremented
   *  5. If remainingAmount reaches 0, the intent transitions to `filled`
   *  6. Otherwise the intent stays `accepted` and a `intent_partially_filled`
   *     event is broadcast
   */
  private async handlePartialFill(
    intent: Intent,
    dto: FillIntentDto,
    fillAmountBig: bigint,
  ): Promise<Intent> {
    const id = intent.intentId;
    const now = Math.floor(Date.now() / 1000);

    const minFill = BigInt(intent.minFillAmount ?? intent.minDstAmount);
    if (fillAmountBig < minFill) {
      throw new BadRequestException({
        error: "Fill amount below minimum",
        fillAmount: dto.fillAmount,
        minDstAmount: intent.minDstAmount,
        minFillAmount: intent.minFillAmount,
      });
    }

    const remaining = BigInt(intent.remainingAmount ?? intent.minDstAmount);
    if (fillAmountBig > remaining) {
      throw new UnprocessableEntityException({
        error: "Fill amount exceeds remaining",
        fillAmount: dto.fillAmount,
        remainingAmount: intent.remainingAmount ?? intent.minDstAmount,
      });
    }

    // Build the new fill record
    const fillRecord: IntentFill = {
      fillId: uuidv4(),
      intentId: id,
      solver: dto.solver,
      fillAmount: dto.fillAmount,
      reservedAmount: dto.fillAmount, // reservation = fill delivered
      txHash: dto.txHash,
      filledAt: now,
    };

    const currentFilled = BigInt(intent.filledAmount ?? "0");
    const newFilled = currentFilled + fillAmountBig;
    const minDst = BigInt(intent.minDstAmount);
    const newRemaining = minDst - newFilled;
    const isFullyFilled = newRemaining <= 0n;

    const existingFills = intent.fills ?? [];
    const updatedFills = [...existingFills, fillRecord];

    if (isFullyFilled) {
      // Transition to fully filled
      const updated = await this.intentsService.fillIfAccepted(
        id,
        dto.solver,
        {
          fillAmount: newFilled.toString(),
          txHash: dto.txHash,
          filledAt: now,
          filledAmount: newFilled.toString(),
          remainingAmount: "0",
          fills: updatedFills,
        },
        now,
      );

      if (!updated) {
        throw new ConflictException(
          `Intent ${id} fill failed: deadline may have elapsed or concurrent fill won`,
        );
      }

      this.gateway.broadcast({
        type: "intent_filled",
        intentId: id,
        solver: dto.solver,
        fillAmount: newFilled.toString(),
        txHash: dto.txHash,
        timestamp: now,
        srcChain: updated.srcChain,
      });

      this.intentsService.appendAuditEntry(
        id,
        "filled",
        dto.solver,
        "Intent fully filled (final partial fill)",
        { fillAmount: dto.fillAmount, txHash: dto.txHash, totalFilled: newFilled.toString() },
      );

      return enrichIntent(updated);
    }

    // Still partially filled — update accounting but keep state as `accepted`
    const updated = await this.intentsService.update(id, {
      filledAmount: newFilled.toString(),
      remainingAmount: newRemaining.toString(),
      fills: updatedFills,
    });

    if (!updated) {
      throw new ConflictException(`Intent ${id} not found during partial fill update`);
    }

    const fillProgress = computeFillProgress(updated);

    this.gateway.broadcast({
      type: "intent_partially_filled",
      intentId: id,
      solver: dto.solver,
      fill: fillRecord,
      fillProgress,
      remainingAmount: newRemaining.toString(),
      timestamp: now,
      srcChain: updated.srcChain,
    });

    this.intentsService.appendAuditEntry(
      id,
      "accepted", // state unchanged — partial fill, not a transition
      dto.solver,
      "Partial fill recorded",
      {
        fillId: fillRecord.fillId,
        fillAmount: dto.fillAmount,
        txHash: dto.txHash,
        fillProgress,
        remainingAmount: newRemaining.toString(),
      },
    );

    return enrichIntent(updated);
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/intents/:id/cancel
  // ---------------------------------------------------------------------------

  @Post(":id/cancel")
  @ApiOperation({ summary: "User cancels an open intent" })
  @ApiParam({ name: "id", description: "Intent UUID" })
  @ApiBody({ type: CancelIntentDto })
  @ApiResponse({ status: 201, description: "Intent cancelled" })
  @ApiResponse({ status: 403, description: "Wrong user" })
  @ApiResponse({ status: 404, description: "Intent not found" })
  @ApiResponse({ status: 409, description: "Intent not in cancellable state" })
  async cancel(
    @Param("id") id: string,
    @Body() dto: CancelIntentDto,
  ): Promise<Intent> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException(`Intent ${id} not found`);

    if (intent.user !== dto.user) {
      throw new ForbiddenException("Only the intent owner may cancel");
    }

    const cancelled = await this.intentsService.cancelIfOpen(id);
    if (!cancelled) {
      throw new ConflictException(
        `Intent ${id} cannot be cancelled (state=${intent.state})`,
      );
    }

    this.gateway.broadcast({
      type: "intent_cancelled",
      intentId: id,
      timestamp: Math.floor(Date.now() / 1000),
      srcChain: cancelled.srcChain,
    });

    this.intentsService.appendAuditEntry(
      id,
      "cancelled",
      dto.user,
      "User cancelled intent",
    );

    return enrichIntent(cancelled);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute fill progress as a 0–1 float.
 */
function computeFillProgress(intent: Intent): number {
  if (!intent.allowPartialFill) {
    return intent.state === "filled" ? 1 : 0;
  }
  const filled = BigInt(intent.filledAmount ?? "0");
  const min = BigInt(intent.minDstAmount);
  if (min === 0n) return 1;
  const progress = Number(filled * 10_000n / min) / 10_000;
  return Math.min(1, progress);
}

/**
 * Compute remaining amount clamped to ≥ 0.
 */
function computeRemainingAmount(intent: Intent): string {
  if (!intent.allowPartialFill) {
    return intent.state === "filled" ? "0" : intent.minDstAmount;
  }
  const filled = BigInt(intent.filledAmount ?? "0");
  const min = BigInt(intent.minDstAmount);
  const remaining = min - filled;
  return remaining > 0n ? remaining.toString() : "0";
}

/**
 * Attach derived read-only fields to an intent before returning it.
 */
function enrichIntent(intent: Intent): Intent {
  const fillProgress = computeFillProgress(intent);
  const remainingAmount = computeRemainingAmount(intent);

  return {
    ...intent,
    fillProgress,
    remainingAmount: intent.allowPartialFill ? remainingAmount : undefined,
    filledAmount: intent.allowPartialFill ? (intent.filledAmount ?? "0") : undefined,
  };
}
