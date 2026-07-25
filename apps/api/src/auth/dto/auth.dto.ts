import { ApiProperty } from '@nestjs/swagger';
import { AuthProvider } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class EmailRegisterDto {
  @ApiProperty()
  @IsString()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  username!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  password!: string;
}

export class EmailLoginDto {
  @ApiProperty()
  @IsString()
  email!: string;

  @ApiProperty()
  @IsString()
  password!: string;

  /** Long-lived access token (30d) for trusted "stay connected" sessions (admin console). */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}

export class SocialLoginDto {
  @ApiProperty({ enum: AuthProvider })
  @IsEnum(AuthProvider)
  provider!: AuthProvider;

  @ApiProperty({ required: false, description: 'ID token (Google) or access token (Facebook)' })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiProperty({ required: false, description: 'OAuth authorization code (for code exchange flow)' })
  @IsOptional()
  @IsString()
  authorizationCode?: string;

  @ApiProperty({ required: false, description: 'Redirect URI used for the OAuth flow' })
  @IsOptional()
  @IsString()
  redirectUri?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  nonce?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  username?: string;
}

export class AppleFullNameDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  namePrefix?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  givenName?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  middleName?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  familyName?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  nameSuffix?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  nickname?: string | null;
}

export class AppleLoginDto {
  @ApiProperty({ description: 'Native Apple identity token returned by iOS' })
  @IsString()
  identityToken!: string;

  @ApiProperty({ description: 'Native Apple authorization code returned by iOS' })
  @IsString()
  authorizationCode!: string;

  @ApiProperty({ description: 'Server-issued nonce used for the Apple request' })
  @IsString()
  nonce!: string;

  @ApiProperty({ description: 'Server-issued state value echoed by Apple' })
  @IsString()
  state!: string;

  @ApiProperty({ required: false, type: AppleFullNameDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AppleFullNameDto)
  fullName?: AppleFullNameDto | null;

  @ApiProperty({ required: false, description: 'First-use email from the native credential; not trusted as identity proof' })
  @IsOptional()
  @IsString()
  email?: string | null;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  oldPassword!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  newPassword!: string;
}

export class ForgotPasswordDto {
  @ApiProperty()
  @IsString()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  token!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
