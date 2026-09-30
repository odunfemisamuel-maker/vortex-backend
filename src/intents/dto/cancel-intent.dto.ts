import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsValidAddress } from "../../common/validators/is-valid-address.validator";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

export class CancelIntentDto {
  @ApiProperty({ description: "User Stellar address requesting the cancel", maxLength: 56 })
  @IsValidAddress({ chain: "stellar", message: "user must be a valid Stellar address (56-char G…)" })
  user!: string;

  @ApiPropertyOptional({ description: "Base64 Ed25519 signature of 'cancel:<intentId>'" })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature?: string;
}
