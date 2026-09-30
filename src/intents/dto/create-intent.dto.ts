import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SupportedChain } from "../intents.types";

/**
 * Request body for POST /api/v1/intents.
 *
 * Partial-fill fields (issue #427):
 *  - `allowPartialFill`  — opt-in flag; defaults to false.
 *  - `minFillAmount`     — minimum per-tranche fill; required when
 *                          `allowPartialFill` is true.
 */
export class CreateIntentDto {
  @ApiProperty({ description: "User's Stellar (or EVM) address", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  user!: string;

  @ApiProperty({
    enum: [
      "stellar",
      "ethereum",
      "base",
      "polygon",
      "arbitrum",
      "optimism",
      "avalanche",
    ],
    description: "Source chain identifier",
  })
  @IsEnum(["stellar", "ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"] as const)
  srcChain!: SupportedChain;

  @ApiProperty({ description: "Source token contract address / native identifier" })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  srcTokenAddress!: string;

  @ApiProperty({ description: "Source token symbol" })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  srcTokenSymbol!: string;

  @ApiProperty({ description: "Source token decimal places", minimum: 0, maximum: 18 })
  @IsInt()
  @Min(0)
  @Max(18)
  srcTokenDecimals!: number;

  @ApiProperty({ description: "Source amount in src token smallest units (decimal string)" })
  @IsString()
  @Matches(/^\d+$/, { message: "srcAmount must be a decimal integer string" })
  srcAmount!: string;

  @ApiProperty({ description: "Destination Stellar token contract (C…)" })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  dstTokenContract!: string;

  @ApiProperty({ description: "Destination token symbol" })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  dstTokenSymbol!: string;

  @ApiProperty({ description: "Destination token decimal places", minimum: 0, maximum: 18 })
  @IsInt()
  @Min(0)
  @Max(18)
  dstTokenDecimals!: number;

  @ApiProperty({
    description:
      "Minimum aggregate destination amount acceptable to the user " +
      "(dst token smallest units, decimal string)",
  })
  @IsString()
  @Matches(/^\d+$/, { message: "minDstAmount must be a decimal integer string" })
  minDstAmount!: string;

  @ApiPropertyOptional({ description: "Optional absolute deadline (Unix seconds)" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4102444800)
  deadline?: number;

  @ApiPropertyOptional({
    description: "Whether to allow multiple partial fills of this intent",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowPartialFill?: boolean;

  @ApiPropertyOptional({
    description:
      "Minimum acceptable per-tranche fill amount (dst token smallest units). " +
      "Required when allowPartialFill is true.",
  })
  @ValidateIf((o: CreateIntentDto) => o.allowPartialFill === true)
  @IsString()
  @Matches(/^\d+$/, { message: "minFillAmount must be a decimal integer string" })
  minFillAmount?: string;

  @ApiPropertyOptional({
    description:
      "User acknowledges high slippage vs oracle fair value. " +
      "Required when the requested minDstAmount deviates by more than MAX_USER_SLIPPAGE_BPS.",
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeHighSlippage?: boolean;

  @ApiPropertyOptional({
    description: "Optional source token USD price for exposure tracking",
  })
  @IsOptional()
  @IsNumber()
  srcTokenPriceUSD?: number;

  @ApiPropertyOptional({
    description: "Optional destination token USD price for exposure tracking",
  })
  @IsOptional()
  @IsNumber()
  dstTokenPriceUSD?: number;
}
