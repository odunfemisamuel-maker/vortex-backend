import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsValidAddress } from "../../common/validators/is-valid-address.validator";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

/**
 * Body sent by a solver when claiming a fill.
 *
 * For partial-fill intents (allowPartialFill = true) the solver may supply a
 * `fillAmount` that is less than `minDstAmount` as long as it is ≥
 * `minFillAmount` and ≤ `remainingAmount`.
 */
export class FillIntentDto {
  @ApiProperty({ description: "Solver Stellar address filling the intent", maxLength: 56 })
  @IsValidAddress({ chain: "stellar", message: "solver must be a valid Stellar address (56-char G…)" })
  solver!: string;

  @ApiProperty({ description: "Amount delivered, in dst token smallest units" })
  @IsString()
  @Matches(/^\d+$/, { message: "fillAmount must be a decimal integer string" })
  fillAmount!: string;

  @ApiProperty({ description: "On-chain transaction hash confirming the fill" })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  txHash!: string;

  @ApiPropertyOptional({ description: "Base64 Ed25519 signature of 'fill:<intentId>:<solver>'" })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature?: string;
}
