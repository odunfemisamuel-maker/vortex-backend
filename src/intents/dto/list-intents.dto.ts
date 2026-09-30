import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IntentState, SupportedChain } from "../intents.types";

export class ListIntentsDto {
  @ApiPropertyOptional({ description: "Filter by intent state" })
  @IsOptional()
  @IsEnum(["open", "accepted", "filled", "cancelled", "expired", "slashed"] as const)
  state?: IntentState;

  @ApiPropertyOptional({ description: "Filter by user address" })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  user?: string;

  @ApiPropertyOptional({ description: "Filter by source chain" })
  @IsOptional()
  @IsEnum(["stellar", "ethereum", "base", "polygon", "arbitrum", "optimism", "avalanche"] as const)
  chain?: SupportedChain;

  @ApiPropertyOptional({ description: "Filter to only partial-fill intents", type: Boolean })
  @IsOptional()
  partialFill?: boolean;
}
